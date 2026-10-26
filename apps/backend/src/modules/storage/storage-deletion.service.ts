import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_CONFIG, type AppConfig } from '../../config/app.config.js';
import { PrismaService } from '../../database/prisma.service.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { DocumentStorage } from '../workers/storage/document-storage.js';

type Tx = Prisma.TransactionClient;

interface DueRow {
  id: string;
  storage_key: string;
  attempts: number;
}

/** 5 s, 10 s, 20 s ... capped at 15 minutes, +-20% jitter. */
export function deletionBackoffMs(attempts: number, random: () => number = Math.random): number {
  const base = Math.min(5000 * 2 ** Math.max(0, attempts - 1), 15 * 60_000);
  return Math.round(base * (0.8 + random() * 0.4));
}

/**
 * Removal of stored objects, decoupled from the request that triggered it.
 *
 *  1. The caller deletes the metadata row and calls `enqueue(tx, key, reason)` in the SAME transaction,
 *     so the object is never orphaned silently and the row never disappears without a removal record.
 *  2. A job (`runOnce`) performs the provider call. Provider deletes must be idempotent ("already gone" is
 *     success), so running twice, or after a crash, is harmless.
 *  3. Provider outage: the row stays pending, retried with exponential backoff, parked as dead after
 *     STORAGE_DELETION_MAX_ATTEMPTS (reported, never retried forever).
 *  4. Safety: an object still referenced by a metadata row is NEVER deleted (the removal is closed as skipped).
 * Nothing is purged automatically beyond objects whose owners removed them; retention of verification
 * documents is a business/legal decision that does not exist yet.
 */
@Injectable()
export class StorageDeletionService {
  private readonly logger = new Logger(StorageDeletionService.name);
  private readonly maxAttempts: number;
  private readonly retentionDays: number;

  constructor(
    config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly storage: DocumentStorage,
  ) {
    const cfg = config.getOrThrow<AppConfig>(APP_CONFIG).storage;
    this.maxAttempts = cfg.deletionMaxAttempts;
    this.retentionDays = cfg.deletionRetentionDays;
  }

  /** Records that `storageKey` must be removed from storage. Idempotent. */
  async enqueue(tx: Tx, storageKey: string, reason: string): Promise<void> {
    await tx.storageDeletion.createMany({ data: [{ storageKey, reason }], skipDuplicates: true });
  }

  async runOnce(now: Date = new Date(), batch = 50): Promise<{ claimed: number; deleted: number; skipped: number; failed: number; dead: number }> {
    const result = { claimed: 0, deleted: 0, skipped: 0, failed: 0, dead: 0 };
    await this.prisma.$transaction(
      async (tx) => {
        const rows = await tx.$queryRaw<DueRow[]>`
          SELECT id, storage_key, attempts FROM storage_deletions
          WHERE completed_at IS NULL AND dead_at IS NULL AND next_attempt_at <= ${now}
          ORDER BY created_at, id LIMIT ${batch} FOR UPDATE SKIP LOCKED`;
        result.claimed = rows.length;
        for (const row of rows) {
          try {
            if (await this.stillReferenced(tx, row.storage_key)) {
              await tx.storageDeletion.update({ where: { id: row.id }, data: { completedAt: new Date(), lastError: 'STILL_REFERENCED' } });
              result.skipped += 1;
              continue;
            }
            await this.storage.delete(row.storage_key);
            await tx.storageDeletion.update({ where: { id: row.id }, data: { completedAt: new Date(), attempts: row.attempts + 1, lastError: null } });
            result.deleted += 1;
          } catch (err) {
            const attempts = row.attempts + 1;
            const dead = attempts >= this.maxAttempts;
            await tx.storageDeletion.update({
              where: { id: row.id },
              data: {
                attempts,
                lastError: errorClass(err),
                ...(dead ? { deadAt: new Date() } : { nextAttemptAt: new Date(now.getTime() + deletionBackoffMs(attempts)) }),
              },
            });
            if (dead) {
              result.dead += 1;
              this.logger.error(`Stored-object removal ${row.id} gave up after ${attempts} attempts (${errorClass(err)})`);
            } else result.failed += 1;
          }
        }
      },
      { timeout: 30_000, maxWait: 5_000 },
    );
    return result;
  }

  async report(): Promise<{ pending: number; dead: number }> {
    const [pending, dead] = await Promise.all([
      this.prisma.storageDeletion.count({ where: { completedAt: null, deadAt: null } }),
      this.prisma.storageDeletion.count({ where: { deadAt: { not: null } } }),
    ]);
    if (dead > 0) this.logger.warn(`Storage removals need attention: ${dead} dead, ${pending} pending`);
    return { pending, dead };
  }

  async purge(now: Date = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - this.retentionDays * 86_400_000);
    return (await this.prisma.storageDeletion.deleteMany({ where: { OR: [{ completedAt: { lt: cutoff } }, { deadAt: { lt: cutoff } }] } })).count;
  }

  private async stillReferenced(tx: Tx, storageKey: string): Promise<boolean> {
    const [photos, documents] = await Promise.all([
      // A row the malware scan marked INFECTED is the record of a rejected upload, not a reason to keep the object.
      tx.bookingPhoto.count({ where: { storageKey, scanStatus: { not: 'INFECTED' } } }),
      tx.workerVerificationDocument.count({ where: { storageKey, scanStatus: { not: 'INFECTED' } } }),
    ]);
    return photos + documents > 0;
  }
}

function errorClass(err: unknown): string {
  const message = (err as Error | undefined)?.message ?? '';
  if (/^[A-Z][A-Z0-9_]{2,60}$/.test(message)) return message;
  return ((err as Error | undefined)?.name ?? 'Error').slice(0, 60);
}
