import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_CONFIG, type AppConfig, type RealtimeConfig } from '../../../config/app.config.js';
import { PrismaService } from '../../../database/prisma.service.js';
import { type BookingEventPayload, BookingEventPublisher, isBookingEventPayload } from '../booking-event-publisher.js';
import { NotificationsService } from '../../notifications/notifications.service.js';

export interface DispatchResult {
  claimed: number;
  delivered: number;
  failed: number;
  dead: number;
}

interface PendingRow {
  id: string;
  booking_event_id: string;
  booking_id: string;
  payload: unknown;
  attempts: number;
}

const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS = 10 * 60_000;

/** Delay before attempt number `attempts + 1`: 1s, 2s, 4s ... capped at 10 minutes, with +-20% jitter. */
export function outboxBackoffMs(attempts: number, random: () => number = Math.random): number {
  const base = Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1), BACKOFF_MAX_MS);
  return Math.round(base * (0.8 + random() * 0.4));
}

/**
 * Delivers the transactional outbox after commit.
 *
 * Why it is safe to run twice, or from several instances at once:
 *  - rows are claimed with FOR UPDATE SKIP LOCKED inside one transaction, so two runs never take the
 *    same row at the same time;
 *  - a row is marked delivered in the same transaction that claimed it; if the process dies after
 *    emitting but before commit, the row is claimed again and re-emitted. Delivery is therefore
 *    AT LEAST ONCE and receivers de-duplicate on `eventId` (also part of every payload);
 *  - the only durable side effects of a delivery are the delivered/attempt columns of the same row and the
 *    notifications of that event, which are unique per (user, event) so a repeat creates nothing.
 * Failures back off exponentially and stop after OUTBOX_MAX_ATTEMPTS (the row is marked dead and
 * reported; it is never retried forever).
 */
@Injectable()
export class OutboxDispatcherService {
  private readonly logger = new Logger(OutboxDispatcherService.name);
  private readonly cfg: RealtimeConfig;

  constructor(
    config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly publisher: BookingEventPublisher,
    private readonly notifications: NotificationsService,
  ) {
    this.cfg = config.getOrThrow<AppConfig>(APP_CONFIG).realtime;
  }

  async runOnce(now: Date = new Date()): Promise<DispatchResult> {
    const result: DispatchResult = { claimed: 0, delivered: 0, failed: 0, dead: 0 };
    await this.prisma.$transaction(
      async (tx) => {
        const rows = await tx.$queryRaw<PendingRow[]>`
          SELECT id, booking_event_id, booking_id, payload, attempts
          FROM realtime_outbox_events
          WHERE dispatched_at IS NULL AND dead_at IS NULL AND next_attempt_at <= ${now}
          ORDER BY created_at, id
          LIMIT ${this.cfg.jobs.outboxBatchSize}
          FOR UPDATE SKIP LOCKED`;
        result.claimed = rows.length;

        for (const row of rows) {
          try {
            await this.deliver(row);
            await tx.realtimeOutboxEvent.update({ where: { id: row.id }, data: { dispatchedAt: new Date(), attempts: row.attempts + 1, lastError: null } });
            result.delivered += 1;
          } catch (err) {
            const attempts = row.attempts + 1;
            const dead = attempts >= this.cfg.jobs.outboxMaxAttempts;
            await tx.realtimeOutboxEvent.update({
              where: { id: row.id },
              data: {
                attempts,
                lastError: errorClass(err),
                ...(dead ? { deadAt: new Date() } : { nextAttemptAt: new Date(now.getTime() + outboxBackoffMs(attempts)) }),
              },
            });
            if (dead) {
              result.dead += 1;
              this.logger.error(`Outbox event ${row.id} gave up after ${attempts} attempts (${errorClass(err)})`);
            } else {
              result.failed += 1;
            }
          }
        }
      },
      { timeout: 30_000, maxWait: 5_000 },
    );
    return result;
  }

  private async deliver(row: PendingRow): Promise<void> {
    if (!isBookingEventPayload(row.payload)) throw new Error('OUTBOX_PAYLOAD_INVALID');
    const payload: BookingEventPayload = row.payload;

    // With realtime switched off by configuration there is nothing to emit, but the event still counts as handled.
    if (this.cfg.enabled) await this.publisher.publish(payload);
    // In-app notifications (and queued pushes) for the people this event concerns. Idempotent per event and recipient,
    // so an outbox retry after a partial failure creates nothing twice.
    await this.notifications.createFromBookingEvent(payload);
  }

  /** Counts for the stale report. */
  async report(now: Date = new Date()): Promise<{ pending: number; stale: number; dead: number; oldestPendingAgeSeconds: number | null }> {
    const staleBefore = new Date(now.getTime() - this.cfg.jobs.outboxStaleAfterMinutes * 60_000);
    const [pending, stale, dead, oldest] = await Promise.all([
      this.prisma.realtimeOutboxEvent.count({ where: { dispatchedAt: null, deadAt: null } }),
      this.prisma.realtimeOutboxEvent.count({ where: { dispatchedAt: null, deadAt: null, createdAt: { lt: staleBefore } } }),
      this.prisma.realtimeOutboxEvent.count({ where: { deadAt: { not: null } } }),
      this.prisma.realtimeOutboxEvent.findFirst({ where: { dispatchedAt: null, deadAt: null }, orderBy: { createdAt: 'asc' }, select: { createdAt: true } }),
    ]);
    if (stale > 0 || dead > 0) {
      this.logger.warn(`Realtime outbox needs attention: ${stale} stale, ${dead} dead, ${pending} pending`);
    }
    return { pending, stale, dead, oldestPendingAgeSeconds: oldest ? Math.round((now.getTime() - oldest.createdAt.getTime()) / 1000) : null };
  }

  /** Deletes finished (delivered or dead) rows older than the retention period. Pending rows are never touched. */
  async purge(now: Date = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - this.cfg.jobs.outboxRetentionDays * 86_400_000);
    const res = await this.prisma.realtimeOutboxEvent.deleteMany({
      where: { OR: [{ dispatchedAt: { lt: cutoff } }, { deadAt: { lt: cutoff } }] },
    });
    return res.count;
  }
}

/** Only an error CLASS (or an upper-case code we threw ourselves) is stored: never a message that could hold data. */
function errorClass(err: unknown): string {
  const message = (err as Error | undefined)?.message ?? '';
  if (/^[A-Z][A-Z0-9_]{2,60}$/.test(message)) return message;
  return ((err as Error | undefined)?.name ?? 'Error').slice(0, 60);
}
