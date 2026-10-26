import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_CONFIG, type AppConfig } from '../../config/app.config.js';
import { NodeEnv } from '../../config/env.validation.js';
import { PrismaService } from '../../database/prisma.service.js';
import { WebhookEventStatus } from '../../generated/prisma/client.js';
import { OUTCOME, PaymentEventsService } from './payment-events.service.js';
import { PAYMENT_DEADLINE_ACTION, PaymentsAdminService } from './payments-admin.service.js';

const INTERVAL_MS = 5 * 60_000;
const BATCH = 200;
const ORPHAN_WINDOW_MS = 24 * 3_600_000;

export interface SweepResult {
  /** PAYMENT_PENDING bookings past `payment_due_at`. Only counted: see PAYMENT_DEADLINE_ACTION. */
  overdueBookings: number;
  /** Attempts open longer than PAYMENT_STALE_AFTER_MINUTES. Only counted: never marked successful. */
  staleAttempts: number;
  /** Earlier "unknown payment" events whose payment now exists and were processed. */
  reprocessedOrphans: number;
}

/**
 * Housekeeping for payments. It deliberately CHANGES NO BOOKING STATE:
 *
 *  - Overdue unpaid bookings are only detected and reported. What an overdue booking should become
 *    (cancelled, expired, reopened, quote fallback) and the deadline length are business decisions
 *    that have not been made, so the state-changing action is disabled (PAYMENT_DEADLINE_ACTION).
 *    The selection query is reusable: when the decision exists, the action is added here under
 *    lockBooking() with a re-check of `status = PAYMENT_PENDING AND confirmed_at IS NULL AND
 *    payment_due_at <= now()` and no open attempt.
 *  - Stale payment attempts are reported, never resolved: without a real provider there is nothing
 *    to ask. They stay open until a verified provider event arrives.
 *  - The only automatic change is retrying "unknown payment" events that arrived before our own
 *    database learned the provider reference (a delivery that overtook the initiation commit). That
 *    goes through the normal, verified, idempotent event path.
 *
 * Idempotent and safe to run concurrently or repeatedly; disabled in tests (call run() directly).
 */
@Injectable()
export class PaymentsMaintenanceService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(PaymentsMaintenanceService.name);
  private timer?: NodeJS.Timeout;
  private readonly enabled: boolean;

  constructor(
    config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly admin: PaymentsAdminService,
    private readonly events: PaymentEventsService,
  ) {
    this.enabled = config.getOrThrow<AppConfig>(APP_CONFIG).env !== NodeEnv.Test;
  }

  onApplicationBootstrap(): void {
    if (!this.enabled) return;
    this.timer = setInterval(() => void this.runSafely(), INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
  }

  private async runSafely(): Promise<void> {
    try {
      const r = await this.run();
      if (r.overdueBookings + r.staleAttempts > 0) {
        this.logger.warn(`Payments need attention: ${r.overdueBookings} overdue unpaid bookings (action: ${PAYMENT_DEADLINE_ACTION}), ${r.staleAttempts} stale payment attempts`);
      }
    } catch (err) {
      this.logger.warn(`Payments housekeeping failed: ${(err as Error).constructor.name}`);
    }
  }

  async run(now: Date = new Date()): Promise<SweepResult> {
    const [overdue, stale] = await Promise.all([this.admin.findOverduePendingBookings(now, BATCH), this.admin.findStaleAttempts(now, BATCH)]);
    return { overdueBookings: overdue.length, staleAttempts: stale.length, reprocessedOrphans: await this.reprocessResolvableOrphans(now) };
  }

  private async reprocessResolvableOrphans(now: Date): Promise<number> {
    const candidates = await this.prisma.paymentWebhookEvent.findMany({
      where: {
        status: WebhookEventStatus.IGNORED,
        outcome: OUTCOME.ORPHAN_UNKNOWN_PAYMENT,
        providerPaymentId: { not: null },
        receivedAt: { gte: new Date(now.getTime() - ORPHAN_WINDOW_MS) },
      },
      select: { id: true, provider: true, providerPaymentId: true },
      orderBy: { receivedAt: 'asc' },
      take: 50,
    });
    let done = 0;
    for (const c of candidates) {
      const known = await this.prisma.paymentAttempt.findFirst({ where: { provider: c.provider, providerPaymentId: c.providerPaymentId }, select: { id: true } });
      if (!known) continue;
      try {
        await this.events.retry(c.id);
        done++;
      } catch (err) {
        this.logger.warn(`Orphan event ${c.id} retry failed: ${(err as Error).constructor.name}`);
      }
    }
    return done;
  }
}
