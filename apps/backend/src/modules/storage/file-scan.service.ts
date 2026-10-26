import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_CONFIG, type AppConfig } from '../../config/app.config.js';
import { PrismaService } from '../../database/prisma.service.js';
import type { FileScanSubject, Prisma } from '../../generated/prisma/client.js';
import { AuditService } from '../auth/audit.service.js';
import { DocumentStorage } from '../workers/storage/document-storage.js';
import { FileScanner } from './file-scanner.js';
import { StorageDeletionService } from './storage-deletion.service.js';

type Tx = Prisma.TransactionClient;

interface DueRow {
  id: string;
  storage_key: string;
  subject: FileScanSubject;
  subject_id: string;
  attempts: number;
}

interface Claimed {
  id: string;
  storageKey: string;
  subject: FileScanSubject;
  subjectId: string;
  /** Fencing token: only a run that still holds this attempt number may write the result. */
  attempts: number;
}

export interface ScanRunResult {
  claimed: number;
  clean: number;
  infected: number;
  retried: number;
  dead: number;
  stale: number;
}

/** 10 s, 20 s, 40 s ... capped at 10 minutes, +-20% jitter. */
export function scanBackoffMs(attempts: number, random: () => number = Math.random): number {
  const base = Math.min(10_000 * 2 ** Math.max(0, attempts - 1), 10 * 60_000);
  return Math.round(base * (0.8 + random() * 0.4));
}

/** Reduces anything thrown by a scanner or the storage adapter to a short code that is safe to store and log. */
export function scanErrorCode(err: unknown): string {
  const message = (err as Error | undefined)?.message ?? '';
  if (/^[A-Z][A-Z0-9_]{2,60}$/.test(message)) return message;
  const name = (err as Error | undefined)?.name ?? 'Error';
  return `SCANNER_${name.replace(/[^A-Za-z0-9]/g, '').toUpperCase()}`.slice(0, 60);
}

/**
 * Malware-scan lifecycle for confirmed uploads, decoupled from the request.
 *
 *  1. Confirmation (photo or worker document), in ONE transaction: the file becomes UPLOADED with scan status PENDING and a job row is queued.
 *     PENDING is never served. If no real scanner is configured nothing is queued and the file stays NOT_SCANNED (not clean).
 *  2. A job (`runOnce`) claims due jobs with FOR UPDATE SKIP LOCKED and a lease, scans the WHOLE object through the configured scanner, and
 *     applies the verdict with compare-and-set: the job must still be RUNNING with the same attempt number, and the file must still be PENDING.
 *     A duplicate run, a run whose lease expired, or a late result therefore cannot change a file's state.
 *  3. CLEAN: the file becomes CLEAN. INFECTED: the file is marked INFECTED (never served) and its object is queued for deletion (policy:
 *     the metadata row stays, as the record that the upload was rejected and, for booking photos, because a dispute may reference it).
 *  4. Anything else (scanner error, timeout, "not scanned", object unreadable) retries with exponential backoff, then after
 *     FILE_SCAN_MAX_ATTEMPTS the job is DEAD and the file is ERROR: still never served. A scanner outage therefore fails closed.
 * Nothing in this class ever marks a file CLEAN except a scanner's own CLEAN verdict.
 */
@Injectable()
export class FileScanService {
  private readonly logger = new Logger(FileScanService.name);
  private readonly maxAttempts: number;
  private readonly leaseMs: number;
  private readonly retentionDays: number;

  constructor(
    config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly storage: DocumentStorage,
    private readonly scanner: FileScanner,
    private readonly deletions: StorageDeletionService,
    private readonly audit: AuditService,
  ) {
    const cfg = config.getOrThrow<AppConfig>(APP_CONFIG).storage;
    this.maxAttempts = cfg.scan.maxAttempts;
    this.leaseMs = cfg.scan.leaseSeconds * 1000;
    this.retentionDays = cfg.deletionRetentionDays;
  }

  /** Queues a scan. Idempotent: one job per object, however often it is called. */
  async enqueue(tx: Tx, input: { storageKey: string; subject: FileScanSubject; subjectId: string }): Promise<void> {
    await tx.fileScanJob.createMany({ data: [input], skipDuplicates: true });
  }

  async runOnce(now: Date = new Date(), batch = 5): Promise<ScanRunResult> {
    const result: ScanRunResult = { claimed: 0, clean: 0, infected: 0, retried: 0, dead: 0, stale: 0 };
    const jobs = await this.claim(now, batch, result);
    result.claimed = jobs.length + result.dead;
    for (const job of jobs) {
      const outcome = await this.scanOne(job);
      if (outcome.kind === 'verdict') {
        const applied = await this.complete(job, outcome.verdict, now);
        if (applied === 'stale') result.stale += 1;
        else if (outcome.verdict === 'CLEAN') result.clean += 1;
        else result.infected += 1;
      } else {
        const applied = await this.fail(job, outcome.code, now);
        if (applied === 'stale') result.stale += 1;
        else if (applied === 'dead') result.dead += 1;
        else result.retried += 1;
      }
    }
    return result;
  }

  /** Claims due jobs: queued ones whose time has come, and running ones whose lease expired. Exhausted ones are parked instead. */
  private async claim(now: Date, batch: number, result: ScanRunResult): Promise<Claimed[]> {
    const claimed: Claimed[] = [];
    await this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<DueRow[]>`
        SELECT id, storage_key, subject, subject_id, attempts FROM file_scan_jobs
        WHERE (status = 'QUEUED' AND next_attempt_at <= ${now}) OR (status = 'RUNNING' AND locked_until <= ${now})
        ORDER BY next_attempt_at, id LIMIT ${batch} FOR UPDATE SKIP LOCKED`;
      for (const row of rows) {
        if (row.attempts >= this.maxAttempts) {
          // A run that never reported back (crash, hung scanner) used up the last attempt.
          await tx.fileScanJob.update({ where: { id: row.id }, data: { status: 'DEAD', lockedUntil: null, lastError: 'SCAN_LEASE_EXPIRED', completedAt: now } });
          await this.markFileError(tx, row.subject, row.storage_key);
          this.logger.error(`File scan ${row.id} gave up after ${row.attempts} attempts (SCAN_LEASE_EXPIRED)`);
          result.dead += 1;
          continue;
        }
        const attempts = row.attempts + 1;
        await tx.fileScanJob.update({ where: { id: row.id }, data: { status: 'RUNNING', attempts, lockedUntil: new Date(now.getTime() + this.leaseMs), startedAt: now } });
        claimed.push({ id: row.id, storageKey: row.storage_key, subject: row.subject, subjectId: row.subject_id, attempts });
      }
    });
    return claimed;
  }

  private async scanOne(job: Claimed): Promise<{ kind: 'verdict'; verdict: 'CLEAN' | 'INFECTED' } | { kind: 'failure'; code: string }> {
    // The scanner must answer before the lease runs out; otherwise another run may legitimately take over.
    const budgetMs = Math.max(5_000, this.leaseMs - 5_000);
    let timer: NodeJS.Timeout | undefined;
    try {
      const run = (async () => {
        const inspection = await this.storage.inspect(job.storageKey);
        if (inspection === null) return { kind: 'failure', code: 'OBJECT_MISSING' } as const;
        if (inspection === 'UNINSPECTABLE') return { kind: 'failure', code: 'OBJECT_UNREADABLE' } as const;
        const verdict = await this.scanner.scan({ storageKey: job.storageKey, head: inspection.head, sizeBytes: inspection.sizeBytes, open: () => this.storage.openReadStream(job.storageKey) });
        if (verdict === 'CLEAN' || verdict === 'INFECTED') return { kind: 'verdict', verdict } as const;
        return { kind: 'failure', code: verdict === 'ERROR' ? 'SCANNER_ERROR' : 'SCANNER_NOT_SCANNED' } as const; // never "clean"
      })();
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('SCAN_TIMEOUT')), budgetMs);
      });
      return await Promise.race([run, timeout]);
    } catch (err) {
      return { kind: 'failure', code: scanErrorCode(err) };
    } finally {
      clearTimeout(timer);
    }
  }

  private async complete(job: Claimed, verdict: 'CLEAN' | 'INFECTED', now: Date): Promise<'applied' | 'stale'> {
    let infectedChanged = false;
    const outcome = await this.prisma.$transaction(async (tx) => {
      const owned = await tx.fileScanJob.updateMany({
        where: { id: job.id, status: 'RUNNING', attempts: job.attempts },
        data: { status: 'DONE', verdict, scanner: this.scanner.name, completedAt: now, lockedUntil: null, lastError: null },
      });
      if (owned.count === 0) return 'stale' as const; // someone else owns the job now: discard this result
      const changed = await this.setFileVerdict(tx, job.subject, job.storageKey, verdict);
      if (verdict === 'INFECTED' && changed > 0) {
        await this.deletions.enqueue(tx, job.storageKey, 'infected');
        infectedChanged = true;
      }
      return 'applied' as const;
    });
    if (infectedChanged) {
      this.logger.warn(`File ${job.subject} ${job.subjectId} was rejected by the malware scan; its object is queued for removal`);
      await this.audit.record({ action: 'file.scan.infected', entityType: job.subject === 'BOOKING_PHOTO' ? 'booking_photo' : 'worker_verification_document', entityId: job.subjectId, metadata: { scanner: this.scanner.name } });
    }
    return outcome;
  }

  private async fail(job: Claimed, code: string, now: Date): Promise<'retry' | 'dead' | 'stale'> {
    const exhausted = job.attempts >= this.maxAttempts;
    const outcome = await this.prisma.$transaction(async (tx) => {
      const owned = await tx.fileScanJob.updateMany({
        where: { id: job.id, status: 'RUNNING', attempts: job.attempts },
        data: exhausted
          ? { status: 'DEAD', lockedUntil: null, lastError: code, completedAt: now }
          : { status: 'QUEUED', lockedUntil: null, lastError: code, nextAttemptAt: new Date(now.getTime() + scanBackoffMs(job.attempts)) },
      });
      if (owned.count === 0) return 'stale' as const;
      if (exhausted) await this.markFileError(tx, job.subject, job.storageKey);
      return exhausted ? ('dead' as const) : ('retry' as const);
    });
    if (outcome === 'dead') this.logger.error(`File scan ${job.id} gave up after ${job.attempts} attempts (${code})`);
    else if (outcome === 'retry') this.logger.warn(`File scan ${job.id} failed (${code}), attempt ${job.attempts} of ${this.maxAttempts}`);
    return outcome;
  }

  /** Compare-and-set: only a file that is still PENDING takes the verdict. */
  private async setFileVerdict(tx: Tx, subject: FileScanSubject, storageKey: string, verdict: 'CLEAN' | 'INFECTED' | 'ERROR'): Promise<number> {
    const where = { storageKey, scanStatus: 'PENDING' as const };
    const data = { scanStatus: verdict };
    const res = subject === 'BOOKING_PHOTO' ? await tx.bookingPhoto.updateMany({ where, data }) : await tx.workerVerificationDocument.updateMany({ where, data });
    return res.count;
  }

  private async markFileError(tx: Tx, subject: FileScanSubject, storageKey: string): Promise<void> {
    await this.setFileVerdict(tx, subject, storageKey, 'ERROR');
  }

  /**
   * Operator action for a file whose scan failed for good (ERROR / DEAD job): queue it again from the start. No HTTP route exists for this yet.
   * Returns false when there is nothing to requeue. Never touches a file that is CLEAN or INFECTED.
   */
  async requeueFailed(storageKey: string): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const job = await tx.fileScanJob.findUnique({ where: { storageKey } });
      if (!job || job.status !== 'DEAD') return false;
      const args = { where: { storageKey, scanStatus: 'ERROR' as const }, data: { scanStatus: 'PENDING' as const } };
      const moved = job.subject === 'BOOKING_PHOTO' ? await tx.bookingPhoto.updateMany(args) : await tx.workerVerificationDocument.updateMany(args);
      if (moved.count === 0) return false;
      await tx.fileScanJob.update({ where: { id: job.id }, data: { status: 'QUEUED', attempts: 0, nextAttemptAt: new Date(), lockedUntil: null, completedAt: null, lastError: null } });
      return true;
    });
  }

  async report(): Promise<{ pending: number; dead: number }> {
    const [pending, dead] = await Promise.all([
      this.prisma.fileScanJob.count({ where: { status: { in: ['QUEUED', 'RUNNING'] } } }),
      this.prisma.fileScanJob.count({ where: { status: 'DEAD' } }),
    ]);
    if (dead > 0) this.logger.warn(`File scans need attention: ${dead} failed for good (files stay unavailable), ${pending} pending`);
    return { pending, dead };
  }

  /** Finished (DONE) jobs are kept for the same retention as removals; failed ones are kept until an operator deals with them. */
  async purge(now: Date = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - this.retentionDays * 86_400_000);
    return (await this.prisma.fileScanJob.deleteMany({ where: { status: 'DONE', completedAt: { lt: cutoff } } })).count;
  }
}
