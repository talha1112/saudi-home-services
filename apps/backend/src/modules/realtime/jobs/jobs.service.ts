import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ModuleRef } from '@nestjs/core';
import { type Job, Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { APP_CONFIG, type AppConfig, type RealtimeConfig } from '../../../config/app.config.js';
import { quitQuietly } from '../../../database/quit-quietly.js';
import { LocationService } from '../location/location.service.js';
import { NotificationDeliveryService } from '../../notifications/notification-delivery.service.js';
import { AbandonedUploadCleanupService } from '../../storage/abandoned-upload-cleanup.service.js';
import { FileScanService } from '../../storage/file-scan.service.js';
import { StorageDeletionService } from '../../storage/storage-deletion.service.js';
import { OutboxDispatcherService } from './outbox-dispatcher.service.js';

export const QUEUES = { outbox: 'realtime-outbox', maintenance: 'maintenance', notifications: 'notifications', scans: 'file-scans' } as const;

export type JobsState = 'disabled' | 'starting' | 'running' | 'degraded' | 'stopped';

const STARTUP_TIMEOUT_MS = 5000;
/** While degraded, starting is retried this often; once running, the repeatable jobs are re-asserted this often. */
const RECOVERY_INTERVAL_MS = 30_000;
const HOUR_MS = 3_600_000;
const FIVE_MIN_MS = 300_000;

/**
 * BullMQ wiring (Redis-backed queues). The work itself lives in plain services
 * (OutboxDispatcherService, LocationService.cleanupIneligible, NotificationSender) so it is testable
 * without Redis; this class only schedules and runs it.
 *
 * Queue state (waiting / delayed / failed jobs, the repeatable schedules) is EPHEMERAL: losing Redis
 * loses queued jobs but never business state. Everything that matters is rebuilt from PostgreSQL:
 * undelivered events are still in the outbox table and are picked up as soon as the repeatable
 * "dispatch" tick runs again; location data expires by itself.
 *
 * Repeatable jobs use BullMQ job schedulers with fixed ids, so restarting, or running several instances,
 * never multiplies them. A single timer retries a failed start and re-asserts the schedulers (so a Redis
 * restart without persistence heals itself within RECOVERY_INTERVAL_MS). Retention of finished jobs is
 * bounded (counts / ages below). If Redis is unreachable at start the API still serves requests; the state
 * becomes `degraded`, the problem is logged (once per distinct error) and the workers start when Redis returns.
 */
@Injectable()
export class JobsService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(JobsService.name);
  private readonly cfg: RealtimeConfig['jobs'];
  private readonly redisUrl: string;
  private readonly storagePollMs: number;
  private readonly scanPollMs: number;
  private readonly abandonedPollMs: number;
  private connections: Redis[] = [];
  private queues: Queue[] = [];
  private workers: Worker[] = [];
  private outboxQueue?: Queue;
  private maintenanceQueue?: Queue;
  private notificationQueue?: Queue;
  private scanQueue?: Queue;
  private recovery?: NodeJS.Timeout;
  private state: JobsState = 'disabled';
  private lastError?: string;

  constructor(
    config: ConfigService,
    private readonly moduleRef: ModuleRef,
  ) {
    const app = config.getOrThrow<AppConfig>(APP_CONFIG);
    this.cfg = app.realtime.jobs;
    this.redisUrl = app.redisUrl;
    this.storagePollMs = app.storage.deletionPollSeconds * 1000;
    this.scanPollMs = app.storage.scan.pollSeconds * 1000;
    this.abandonedPollMs = app.storage.abandonedUploads.pollMinutes * 60_000;
  }

  status(): { state: JobsState; lastError?: string } {
    return { state: this.state, ...(this.lastError ? { lastError: this.lastError } : {}) };
  }

  async onApplicationBootstrap(): Promise<void> {
    if (!this.cfg.enabled) return;
    await this.startOrRecover();
    this.recovery = setInterval(() => void this.startOrRecover(), RECOVERY_INTERVAL_MS);
    this.recovery.unref();
  }

  /** The step the recovery timer runs; public so operator tooling and tests can trigger it. */
  async startOrRecover(): Promise<void> {
    if (!this.cfg.enabled || this.state === 'stopped') return;
    try {
      if (this.workers.length === 0) {
        this.state = 'starting';
        await this.start();
      } else {
        await this.ensureSchedulers();
      }
    } catch (err) {
      await this.teardown();
      this.state = 'degraded';
      this.lastError = (err as Error).message;
      this.logger.error(`Background jobs are not running (${(err as Error).message}). The API keeps serving; jobs start when Redis is reachable`);
    }
  }

  /** (Re)creates the repeatable jobs. Same ids every time, so calling it again never multiplies them. */
  async ensureSchedulers(): Promise<void> {
    const outbox = this.outboxQueue;
    const maintenance = this.maintenanceQueue;
    if (!outbox || !maintenance) return;
    const keep = { removeOnComplete: { count: 20 }, removeOnFail: { count: 100 }, attempts: 1 };
    await outbox.upsertJobScheduler('outbox-dispatch', { every: this.cfg.outboxPollIntervalMs }, { name: 'dispatch', opts: keep });
    await outbox.upsertJobScheduler('outbox-report', { every: FIVE_MIN_MS }, { name: 'report', opts: keep });
    await outbox.upsertJobScheduler('outbox-purge', { every: HOUR_MS }, { name: 'purge', opts: keep });
    await maintenance.upsertJobScheduler('location-cleanup', { every: FIVE_MIN_MS }, { name: 'location-cleanup', opts: keep });
    await maintenance.upsertJobScheduler('storage-deletions', { every: this.storagePollMs }, { name: 'storage-deletions', opts: keep });
    await maintenance.upsertJobScheduler('storage-report', { every: FIVE_MIN_MS }, { name: 'storage-report', opts: keep });
    await maintenance.upsertJobScheduler('storage-purge', { every: HOUR_MS }, { name: 'storage-purge', opts: keep });
    await maintenance.upsertJobScheduler('abandoned-uploads', { every: this.abandonedPollMs }, { name: 'abandoned-uploads', opts: keep });
    await maintenance.upsertJobScheduler('file-scan-report', { every: FIVE_MIN_MS }, { name: 'file-scan-report', opts: keep });
    await maintenance.upsertJobScheduler('file-scan-purge', { every: HOUR_MS }, { name: 'file-scan-purge', opts: keep });
    // Scanning can take long, so it has a queue (and worker) of its own and never delays removals or housekeeping.
    const scans = this.scanQueue;
    if (scans) await scans.upsertJobScheduler('file-scans', { every: this.scanPollMs }, { name: 'file-scans', opts: keep });
    const notifications = this.notificationQueue;
    if (notifications) await notifications.upsertJobScheduler('notification-deliver', { every: 2000 }, { name: 'deliver', opts: keep });
  }

  private newConnection(): Redis {
    // BullMQ requires maxRetriesPerRequest: null on its connections (blocking commands).
    const connection = new Redis(this.redisUrl, { maxRetriesPerRequest: null, retryStrategy: (n) => Math.min(n * 500, 5000) });
    connection.on('error', (e: Error) => this.noteError(e.message));
    connection.on('ready', () => {
      if (this.state === 'degraded') this.logger.log('Redis is reachable again');
      this.lastError = undefined;
    });
    this.connections.push(connection);
    return connection;
  }

  private noteError(message: string): void {
    if (message !== this.lastError) {
      this.lastError = message;
      this.logger.warn(`Background jobs Redis problem: ${message}`);
    }
    if (this.state === 'running') this.state = 'degraded';
  }

  private async start(): Promise<void> {
    // Resolved lazily: the dispatcher itself depends on this class (as the notification queue).
    const dispatcher = this.moduleRef.get(OutboxDispatcherService, { strict: false });
    const location = this.moduleRef.get(LocationService, { strict: false });
    const deliveries = this.moduleRef.get(NotificationDeliveryService, { strict: false });
    const storageDeletions = this.moduleRef.get(StorageDeletionService, { strict: false });
    const fileScans = this.moduleRef.get(FileScanService, { strict: false });
    const abandoned = this.moduleRef.get(AbandonedUploadCleanupService, { strict: false });

    const prefix = `${this.cfg.queuePrefix}:bull`;
    const queueConnection = this.newConnection();
    const mkQueue = (name: string) => {
      const q = new Queue(name, { connection: queueConnection, prefix });
      q.on('error', (e) => this.noteError(e.message));
      this.queues.push(q);
      return q;
    };
    this.outboxQueue = mkQueue(QUEUES.outbox);
    this.maintenanceQueue = mkQueue(QUEUES.maintenance);
    this.notificationQueue = mkQueue(QUEUES.notifications);
    this.scanQueue = mkQueue(QUEUES.scans);

    // Fails fast (and loudly) when Redis cannot be reached at start.
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        Promise.all(this.queues.map((q) => q.waitUntilReady())),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('Redis did not answer within 5 seconds')), STARTUP_TIMEOUT_MS);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    await this.ensureSchedulers();

    const mkWorker = (name: string, processor: (job: Job) => Promise<unknown>, concurrency = 1) => {
      const w = new Worker(name, processor, { connection: this.newConnection(), prefix, concurrency });
      w.on('error', (e) => this.noteError(e.message));
      // Job failures are logged by name and attempt only, never with the job data.
      w.on('failed', (job, e) => this.logger.warn(`Job ${name}/${job?.name} failed (attempt ${job?.attemptsMade}): ${e.name}`));
      this.workers.push(w);
    };
    mkWorker(QUEUES.outbox, async (job) => {
      if (job.name === 'dispatch') return dispatcher.runOnce();
      if (job.name === 'report') return dispatcher.report();
      if (job.name === 'purge') return dispatcher.purge();
      throw new Error(`Unknown job ${job.name}`);
    });
    mkWorker(QUEUES.maintenance, async (job) => {
      if (job.name === 'location-cleanup') return location.cleanupIneligible();
      if (job.name === 'storage-deletions') return storageDeletions.runOnce();
      if (job.name === 'storage-report') return storageDeletions.report();
      if (job.name === 'storage-purge') return storageDeletions.purge();
      if (job.name === 'abandoned-uploads') return abandoned.runOnce();
      if (job.name === 'file-scan-report') return fileScans.report();
      if (job.name === 'file-scan-purge') return fileScans.purge();
      throw new Error(`Unknown job ${job.name}`);
    });
    mkWorker(QUEUES.scans, async (job) => {
      if (job.name === 'file-scans') return fileScans.runOnce();
      throw new Error(`Unknown job ${job.name}`);
    });
    mkWorker(QUEUES.notifications, async (job) => {
      if (job.name === 'deliver') return deliveries.runOnce();
      throw new Error(`Unknown job ${job.name}`);
    });

    this.state = 'running';
    this.lastError = undefined;
    this.logger.log('Background jobs started (outbox dispatch, notification delivery, storage removals, cleanup, reports)');
  }

  private async teardown(): Promise<void> {
    await Promise.allSettled(this.workers.map((w) => w.close(true)));
    await Promise.allSettled(this.queues.map((q) => q.close()));
    for (const c of this.connections) c.disconnect();
    this.workers = [];
    this.queues = [];
    this.connections = [];
    this.outboxQueue = this.maintenanceQueue = this.notificationQueue = this.scanQueue = undefined;
  }

  async onModuleDestroy(): Promise<void> {
    clearInterval(this.recovery);
    if (this.state === 'disabled') return;
    this.state = 'stopped';
    await Promise.allSettled(this.workers.map((w) => w.close()));
    await Promise.allSettled(this.queues.map((q) => q.close()));
    await Promise.all(this.connections.map((c) => quitQuietly(c)));
    this.workers = [];
    this.queues = [];
    this.connections = [];
  }
}
