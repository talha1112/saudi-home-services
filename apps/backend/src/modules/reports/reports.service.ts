import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { badRequestWith } from '../../common/errors/api-error.js';
import { APP_CONFIG, type AppConfig } from '../../config/app.config.js';
import { PrismaService } from '../../database/prisma.service.js';
import { Role, UserStatus, WorkerVerificationStatus } from '../../generated/prisma/client.js';

export const MAX_RANGE_DAYS = 366;
const DAY_MS = 86_400_000;
const TIMEZONE = 'Asia/Riyadh';

export interface Range {
  from: Date;
  to: Date;
}

/** `from` is inclusive, `to` is exclusive. Default: the last 30 days. At most 366 days. */
export function resolveRange(fromIso?: string, toIso?: string, now: Date = new Date()): Range {
  const to = toIso ? new Date(toIso) : now;
  const from = fromIso ? new Date(fromIso) : new Date(to.getTime() - 30 * DAY_MS);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) throw badRequestWith('INVALID_RANGE', 'from and to must be valid ISO 8601 times', {});
  if (from.getTime() >= to.getTime()) throw badRequestWith('INVALID_RANGE', 'from must be before to', {});
  if (to.getTime() - from.getTime() > MAX_RANGE_DAYS * DAY_MS) throw badRequestWith('INVALID_RANGE', `The range may span at most ${MAX_RANGE_DAYS} days`, { maxDays: MAX_RANGE_DAYS });
  return { from, to };
}

const rangeInfo = (r: Range) => ({ from: r.from.toISOString(), to: r.to.toISOString(), fromInclusive: true, toExclusive: true, timezoneForBuckets: TIMEZONE });
const n = (v: bigint | number | null | undefined) => Number(v ?? 0);

/**
 * Operational and financial reporting for administrators. Everything is aggregated in PostgreSQL; nothing returns an
 * individual's personal data. Every response repeats its own `definitions` so a number is never read without its meaning.
 *
 * Money rules, repeated everywhere they matter:
 *  - amounts are integer halalas, grouped PER CURRENCY (different currencies are never added together);
 *  - a payment ATTEMPT is a request to collect, not proof of funds; "provider-reported captured" is what a verified provider
 *    event said, not a bank settlement;
 *  - a REQUESTED refund is a request, not money returned; only status SUCCEEDED means the provider confirmed it (none can exist yet);
 *  - ledger totals are the sums of the append-only entries as posted: not a bank balance, not recognised revenue, not VAT,
 *    commission or payout figures (those policies are not approved).
 * Simulated (mock) money is excluded unless includeSimulated=true.
 */
@Injectable()
export class ReportsService {
  private readonly staleMinutes: number;

  constructor(
    config: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    this.staleMinutes = config.getOrThrow<AppConfig>(APP_CONFIG).realtime.jobs.outboxStaleAfterMinutes;
  }

  // ---------------------------------------------------------------------------------------- bookings

  async bookings(range: Range, top = 20) {
    const where = { createdAt: { gte: range.from, lt: range.to } };
    const [byStatus, byService, byCity, cancellations, services, cities] = await Promise.all([
      this.prisma.booking.groupBy({ by: ['status'], where, _count: { _all: true } }),
      this.prisma.booking.groupBy({ by: ['serviceId'], where, _count: { _all: true }, orderBy: { _count: { serviceId: 'desc' } }, take: top }),
      this.prisma.booking.groupBy({ by: ['cityId'], where, _count: { _all: true }, orderBy: { _count: { cityId: 'desc' } }, take: top }),
      this.prisma.bookingCancellation.groupBy({ by: ['reason', 'cancelledByRole'], where: { cancelledAt: { gte: range.from, lt: range.to } }, _count: { _all: true } }),
      this.prisma.service.findMany({ select: { id: true, nameEn: true, nameAr: true } }),
      this.prisma.city.findMany({ select: { id: true, nameEn: true, nameAr: true } }),
    ]);
    const name = (list: Array<{ id: string; nameEn: string; nameAr: string }>, id: string) => list.find((x) => x.id === id);
    return {
      range: rangeInfo(range),
      createdByCurrentStatus: byStatus.map((r) => ({ status: r.status, count: r._count._all })),
      createdByService: byService.map((r) => ({ serviceId: r.serviceId, nameEn: name(services, r.serviceId)?.nameEn ?? null, nameAr: name(services, r.serviceId)?.nameAr ?? null, count: r._count._all })),
      createdByCity: byCity.map((r) => ({ cityId: r.cityId, nameEn: name(cities, r.cityId)?.nameEn ?? null, nameAr: name(cities, r.cityId)?.nameAr ?? null, count: r._count._all })),
      cancellations: {
        total: cancellations.reduce((a, r) => a + r._count._all, 0),
        byReasonAndActor: cancellations.map((r) => ({ reason: r.reason, cancelledByRole: r.cancelledByRole, count: r._count._all })),
      },
      definitions: {
        createdByCurrentStatus: 'Bookings CREATED in the range, grouped by the status they have NOW. Source: bookings.created_at, bookings.status.',
        createdByService: `Bookings created in the range per service (top ${top}). Source: bookings.service_id.`,
        createdByCity: `Bookings created in the range per city (top ${top}). Source: bookings.city_id.`,
        cancellations: 'Bookings cancelled in the range (by cancellation time, not creation time). Source: booking_cancellations.',
      },
    };
  }

  async bookingTrend(range: Range, interval: 'day' | 'week' | 'month') {
    const run = (column: 'created_at' | 'completed_at' | 'cancelled_at') =>
      this.prisma.$queryRawUnsafe<Array<{ bucket: string; c: number }>>(
        // to_char: the bucket is a wall-clock Riyadh date; handing it to the driver as a timestamp would shift it by the server's own zone.
        `SELECT to_char(date_trunc($1, ${column} AT TIME ZONE $2), 'YYYY-MM-DD') AS bucket, count(*)::int AS c FROM bookings WHERE ${column} >= $3 AND ${column} < $4 GROUP BY 1 ORDER BY 1`,
        interval,
        TIMEZONE,
        range.from,
        range.to,
      );
    const [created, completed, cancelled] = await Promise.all([run('created_at'), run('completed_at'), run('cancelled_at')]);
    const merged = new Map<string, { bucketStart: string; created: number; completed: number; cancelled: number }>();
    const put = (rows: Array<{ bucket: string; c: number }>, key: 'created' | 'completed' | 'cancelled') => {
      for (const r of rows) {
        const bucketStart = r.bucket; // the Riyadh calendar date the bucket starts on
        const row = merged.get(bucketStart) ?? { bucketStart, created: 0, completed: 0, cancelled: 0 };
        row[key] += r.c;
        merged.set(bucketStart, row);
      }
    };
    put(created, 'created');
    put(completed, 'completed');
    put(cancelled, 'cancelled');
    return {
      range: rangeInfo(range),
      interval,
      buckets: [...merged.values()].sort((a, b) => a.bucketStart.localeCompare(b.bucketStart)),
      definitions: {
        created: 'Bookings by creation time. Source: bookings.created_at.',
        completed: 'Bookings by completion time. Source: bookings.completed_at.',
        cancelled: 'Bookings by cancellation time. Source: bookings.cancelled_at.',
        buckets: `Calendar ${interval}s in ${TIMEZONE}; bucketStart is the local date the bucket begins on. Buckets without events are omitted.`,
      },
    };
  }

  // ---------------------------------------------------------------------------------------- quotes

  async quotes(range: Range) {
    const [byStatus, accepted] = await Promise.all([
      this.prisma.quote.groupBy({ by: ['status'], where: { createdAt: { gte: range.from, lt: range.to } }, _count: { _all: true } }),
      this.prisma.booking.count({ where: { acceptedAt: { gte: range.from, lt: range.to } } }),
    ]);
    return {
      range: rangeInfo(range),
      submitted: byStatus.reduce((a, r) => a + r._count._all, 0),
      submittedByCurrentStatus: byStatus.map((r) => ({ status: r.status, count: r._count._all })),
      acceptedInRange: accepted,
      definitions: {
        submitted: 'Quotes CREATED in the range (revisions do not create new quotes). Source: quotes.created_at.',
        submittedByCurrentStatus: 'The same quotes grouped by the status they have now.',
        acceptedInRange: 'Quotes accepted in the range, counted once per booking by acceptance time (a quote may have been submitted earlier). Source: bookings.accepted_at. Not a ratio: submitted and accepted cover different populations.',
      },
    };
  }

  // ---------------------------------------------------------------------------------------- workers

  async workers(range: Range) {
    const [byVerification, active, online, accounts, registrations] = await Promise.all([
      this.prisma.workerProfile.groupBy({ by: ['verificationStatus'], _count: { _all: true } }),
      this.prisma.workerProfile.count({ where: { verificationStatus: WorkerVerificationStatus.APPROVED, user: { status: UserStatus.ACTIVE } } }),
      this.prisma.workerProfile.count({ where: { verificationStatus: WorkerVerificationStatus.APPROVED, isOnline: true, user: { status: UserStatus.ACTIVE } } }),
      this.prisma.user.groupBy({ by: ['status'], where: { roles: { some: { role: { in: [Role.CUSTOMER, Role.WORKER] } } } }, _count: { _all: true } }),
      this.prisma.userRole.groupBy({ by: ['role'], where: { role: { in: [Role.CUSTOMER, Role.WORKER] }, user: { createdAt: { gte: range.from, lt: range.to } } }, _count: { _all: true } }),
    ]);
    return {
      range: rangeInfo(range),
      snapshotAt: new Date().toISOString(),
      workersByVerificationStatus: byVerification.map((r) => ({ status: r.verificationStatus, count: r._count._all })),
      activeWorkers: active,
      onlineWorkersNow: online,
      accountsByStatus: accounts.map((r) => ({ status: r.status, count: r._count._all })),
      registrationsInRange: registrations.map((r) => ({ role: r.role, count: r._count._all })),
      definitions: {
        workersByVerificationStatus: 'SNAPSHOT (now, ignores the range). Source: worker_profiles.verification_status.',
        activeWorkers: 'SNAPSHOT. Verification APPROVED and the account ACTIVE.',
        onlineWorkersNow: 'SNAPSHOT. Active workers who currently have the online flag set (a flag, not proof they are reachable).',
        accountsByStatus: 'SNAPSHOT. Customer and worker accounts by account status (a person holding both roles counts once).',
        registrationsInRange: 'Accounts created in the range, by role held (a person holding both roles counts in each). Source: users.created_at, user_roles.',
      },
    };
  }

  // ---------------------------------------------------------------------------------------- reviews & disputes

  async reviews(range: Range) {
    const where = { createdAt: { gte: range.from, lt: range.to } };
    const [byStatus, published] = await Promise.all([
      this.prisma.review.groupBy({ by: ['status'], where, _count: { _all: true } }),
      this.prisma.review.groupBy({ by: ['rating'], where: { ...where, status: 'PUBLISHED' }, _count: { _all: true } }),
    ]);
    const count = published.reduce((a, r) => a + r._count._all, 0);
    const sum = published.reduce((a, r) => a + r.rating * r._count._all, 0);
    return {
      range: rangeInfo(range),
      byCurrentStatus: byStatus.map((r) => ({ status: r.status, count: r._count._all })),
      published: {
        count,
        average: count ? Math.round((sum / count) * 100) / 100 : null,
        distribution: Object.fromEntries([1, 2, 3, 4, 5].map((s) => [s, published.find((p) => p.rating === s)?._count._all ?? 0])),
      },
      definitions: {
        byCurrentStatus: 'Reviews SUBMITTED in the range by their status now. Source: reviews.created_at, reviews.status.',
        published: 'Of those, the PUBLISHED ones (hidden and withdrawn reviews are excluded from the average and the distribution). Average rounded to 2 decimals.',
      },
    };
  }

  async disputes(range: Range) {
    const where = { createdAt: { gte: range.from, lt: range.to } };
    const [byStatus, byCategory, followups, reopened] = await Promise.all([
      this.prisma.dispute.groupBy({ by: ['status'], where, _count: { _all: true } }),
      this.prisma.dispute.groupBy({ by: ['category'], where, _count: { _all: true } }),
      this.prisma.dispute.count({ where: { ...where, financialFollowup: 'REQUESTED' } }),
      this.prisma.dispute.count({ where: { ...where, reopenCount: { gt: 0 } } }),
    ]);
    return {
      range: rangeInfo(range),
      opened: byStatus.reduce((a, r) => a + r._count._all, 0),
      byCurrentStatus: byStatus.map((r) => ({ status: r.status, count: r._count._all })),
      byCategory: byCategory.map((r) => ({ category: r.category, count: r._count._all })),
      financialFollowupRequested: followups,
      reopened,
      definitions: {
        opened: 'Disputes OPENED in the range. Source: disputes.created_at.',
        financialFollowupRequested: 'Disputes whose resolution flagged a money follow-up. This is a FLAG for a separate approved workflow: no refund or compensation was made because of it.',
        reopened: 'Of the disputes opened in the range, how many were reopened at least once.',
      },
    };
  }

  // ---------------------------------------------------------------------------------------- notifications & operations

  async notifications(range: Range) {
    const created = { createdAt: { gte: range.from, lt: range.to } };
    const [total, read, deliveries] = await Promise.all([
      this.prisma.notification.count({ where: created }),
      this.prisma.notification.count({ where: { ...created, readAt: { not: null } } }),
      this.prisma.notificationDelivery.groupBy({ by: ['channel', 'status'], where: created, _count: { _all: true } }),
    ]);
    return {
      range: rangeInfo(range),
      inApp: { created: total, readOfThose: read },
      externalDeliveries: deliveries.map((r) => ({ channel: r.channel, status: r.status, count: r._count._all })),
      definitions: {
        inApp: 'In-app notifications created in the range and how many of those have been read since. Source: notifications.',
        externalDeliveries: 'Push/SMS/e-mail delivery rows created in the range by outcome. SENT = the provider accepted the message (NOT proof it reached a device); DELIVERED is not recorded today; UNSUPPORTED = no provider configured. Source: notification_deliveries.',
      },
    };
  }

  async operations(now: Date = new Date()) {
    const staleBefore = new Date(now.getTime() - this.staleMinutes * 60_000);
    const [outboxPending, outboxStale, outboxDead, storagePending, storageDead, deliveriesQueued, deliveriesFailed, webhookFailed, reconciliation] = await Promise.all([
      this.prisma.realtimeOutboxEvent.count({ where: { dispatchedAt: null, deadAt: null } }),
      this.prisma.realtimeOutboxEvent.count({ where: { dispatchedAt: null, deadAt: null, createdAt: { lt: staleBefore } } }),
      this.prisma.realtimeOutboxEvent.count({ where: { deadAt: { not: null } } }),
      this.prisma.storageDeletion.count({ where: { completedAt: null, deadAt: null } }),
      this.prisma.storageDeletion.count({ where: { deadAt: { not: null } } }),
      this.prisma.notificationDelivery.count({ where: { status: 'QUEUED' } }),
      this.prisma.notificationDelivery.count({ where: { status: 'FAILED' } }),
      this.prisma.paymentWebhookEvent.count({ where: { status: 'FAILED' } }),
      this.prisma.paymentAttempt.count({ where: { status: 'CAPTURED_UNAPPLIED' } }),
    ]);
    return {
      snapshotAt: now.toISOString(),
      realtimeOutbox: { pending: outboxPending, staleOlderThanMinutes: this.staleMinutes, stale: outboxStale, dead: outboxDead },
      storageRemovals: { pending: storagePending, dead: storageDead },
      notificationDeliveries: { queued: deliveriesQueued, failed: deliveriesFailed },
      paymentWebhookEventsFailed: webhookFailed,
      paymentsAwaitingReconciliation: reconciliation,
      definitions: {
        all: 'SNAPSHOT of items needing attention, all time. dead = retries exhausted, parked and only logged until an operator acts. Sources: realtime_outbox_events, storage_deletions, notification_deliveries, payment_webhook_events, payment_attempts.',
      },
    };
  }

  // ---------------------------------------------------------------------------------------- money

  async payments(range: Range, includeSimulated: boolean) {
    const sim = includeSimulated ? {} : { isSimulated: false };
    const created = { createdAt: { gte: range.from, lt: range.to } };
    const [attempts, applied, unappliedAll, refunds] = await Promise.all([
      this.prisma.paymentAttempt.groupBy({ by: ['status', 'currency'], where: { ...created, ...sim }, _count: { _all: true }, _sum: { amountHalalas: true } }),
      this.prisma.paymentAttempt.groupBy({ by: ['capturedCurrency'], where: { ...created, ...sim, status: 'SUCCEEDED' }, _count: { _all: true }, _sum: { capturedAmountHalalas: true } }),
      this.prisma.paymentAttempt.groupBy({ by: ['capturedCurrency'], where: { ...sim, status: 'CAPTURED_UNAPPLIED' }, _count: { _all: true }, _sum: { capturedAmountHalalas: true } }),
      this.prisma.paymentRefund.groupBy({ by: ['status', 'currency'], where: { ...created, ...(includeSimulated ? {} : { payment: { isSimulated: false } }) }, _count: { _all: true }, _sum: { amountHalalas: true } }),
    ]);
    return {
      range: rangeInfo(range),
      includeSimulated,
      paymentAttemptsByStatus: attempts.map((r) => ({ status: r.status, currency: r.currency, count: r._count._all, requestedToCollectHalalas: n(r._sum.amountHalalas) })),
      providerReportedCapturedAndApplied: applied.map((r) => ({ currency: r.capturedCurrency, count: r._count._all, capturedHalalas: n(r._sum.capturedAmountHalalas) })),
      capturedButUnappliedAllTime: unappliedAll.map((r) => ({ currency: r.capturedCurrency, count: r._count._all, capturedHalalas: n(r._sum.capturedAmountHalalas) })),
      refundRequestsByStatus: refunds.map((r) => ({ status: r.status, currency: r.currency, count: r._count._all, amountHalalas: n(r._sum.amountHalalas) })),
      refundsConfirmedByProvider: refunds.filter((r) => r.status === 'SUCCEEDED').map((r) => ({ currency: r.currency, count: r._count._all, amountHalalas: n(r._sum.amountHalalas) })),
      definitions: {
        paymentAttemptsByStatus: 'Payment attempts CREATED in the range by status now. requestedToCollectHalalas is what we asked the customer to pay; an attempt (even PROCESSING or INITIATED) is NOT proof of funds. Source: payment_attempts.',
        providerReportedCapturedAndApplied: 'Attempts in the range with status SUCCEEDED: what a verified provider event said it captured and that was applied to a booking. Not a settlement, payout or bank figure.',
        capturedButUnappliedAllTime: 'ALL-TIME open reconciliation items: money a provider says it captured that was NOT applied to a booking (cancelled booking, duplicate, wrong amount). Held for finance; nothing is refunded automatically.',
        refundRequestsByStatus: 'Refund requests CREATED in the range by status. REQUESTED means asked for, NO money has moved. Source: payment_refunds.',
        refundsConfirmedByProvider: 'Only status SUCCEEDED, i.e. confirmed by a provider. No provider can execute refunds yet, so this is expected to stay empty.',
        currencies: 'Amounts are integer halalas per ISO currency code; currencies are never summed together.',
      },
    };
  }

  async ledger(range: Range, includeSimulated: boolean) {
    const rows = await this.prisma.ledgerEntry.groupBy({
      by: ['entryType', 'currency'],
      where: { postedAt: { gte: range.from, lt: range.to }, ...(includeSimulated ? {} : { isSimulated: false }) },
      _count: { _all: true },
      _sum: { amountHalalas: true },
    });
    return {
      range: rangeInfo(range),
      includeSimulated,
      entriesByType: rows.map((r) => ({ entryType: r.entryType, currency: r.currency, count: r._count._all, sumHalalas: n(r._sum.amountHalalas) })),
      definitions: {
        entriesByType: 'Append-only ledger entries POSTED in the range, summed per entry type and currency exactly as stored (refund entries are stored negative). This is a record of what the system booked: NOT a bank balance, NOT recognised revenue, NOT VAT, commission or worker-payout figures. Commission, earnings and payout entry types are reserved and unused until the accounting policy is approved. Source: ledger_entries.',
      },
    };
  }
}
