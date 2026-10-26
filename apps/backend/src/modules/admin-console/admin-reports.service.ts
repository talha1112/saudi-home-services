import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service.js';
import { Prisma, Role, UserStatus, WorkerVerificationStatus } from '../../generated/prisma/client.js';
import { resolveRange } from '../reports/reports.service.js';

export const METRICS = ['revenue', 'bookings', 'commissions', 'earnings', 'cancellations', 'refunds', 'disputes', 'offers', 'subscriptions', 'customers', 'workers', 'cities'] as const;
export type Metric = (typeof METRICS)[number];

type Kind = 'money' | 'count' | 'pct' | 'text';
interface Row {
  label: string;
  value: number | string | null;
  kind: Kind;
}

const RIYADH_OFFSET_MS = 3 * 3_600_000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const n = (v: number | bigint | null | undefined) => Number(v ?? 0);

/** Riyadh calendar months, oldest first, each as [start, end) instants. */
export function lastMonths(count: number, now: Date): Array<{ label: string; start: Date; end: Date }> {
  const local = new Date(now.getTime() + RIYADH_OFFSET_MS);
  const out: Array<{ label: string; start: Date; end: Date }> = [];
  for (let i = count - 1; i >= 0; i--) {
    const y = local.getUTCFullYear();
    const m = local.getUTCMonth() - i;
    const start = new Date(Date.UTC(y, m, 1) - RIYADH_OFFSET_MS);
    const end = new Date(Date.UTC(y, m + 1, 1) - RIYADH_OFFSET_MS);
    out.push({ label: MONTHS[((m % 12) + 12) % 12]!, start, end });
  }
  return out;
}

/** What each report chart counts per city and month: a SQL expression over the table named, and the date column that places it in a month. */
const SERIES: Record<Metric, { unit: 'halalas' | 'count'; from: string; at: string; value: string; where?: string; city: string } | null> = {
  revenue: { unit: 'halalas', from: 'bookings b', at: 'b.completed_at', value: 'coalesce(sum(b.total_amount_halalas), 0)', city: 'b.city_id' },
  bookings: { unit: 'count', from: 'bookings b', at: 'b.created_at', value: 'count(*)', city: 'b.city_id' },
  commissions: { unit: 'halalas', from: 'bookings b', at: 'b.completed_at', value: 'coalesce(sum(b.commission_amount_halalas), 0)', city: 'b.city_id' },
  earnings: { unit: 'halalas', from: 'bookings b', at: 'b.completed_at', value: 'coalesce(sum(b.worker_payout_halalas), 0)', city: 'b.city_id' },
  cancellations: { unit: 'count', from: 'bookings b', at: 'b.cancelled_at', value: 'count(*)', city: 'b.city_id' },
  refunds: { unit: 'halalas', from: 'payment_refunds r JOIN bookings b ON b.id = r.booking_id', at: 'r.created_at', value: 'coalesce(sum(r.amount_halalas), 0)', city: 'b.city_id' },
  disputes: { unit: 'count', from: 'disputes d JOIN bookings b ON b.id = d.booking_id', at: 'd.created_at', value: 'count(*)', city: 'b.city_id' },
  offers: { unit: 'count', from: 'offers o', at: 'o.created_at', value: 'count(*)', where: 'o.city_id IS NOT NULL', city: 'o.city_id' },
  subscriptions: null,
  customers: { unit: 'count', from: 'bookings b', at: 'b.created_at', value: 'count(DISTINCT b.customer_id)', city: 'b.city_id' },
  workers: { unit: 'count', from: 'bookings b', at: 'b.completed_at', value: 'count(*)', where: 'b.worker_profile_id IS NOT NULL', city: 'b.city_id' },
  cities: { unit: 'halalas', from: 'bookings b', at: 'b.completed_at', value: 'coalesce(sum(b.total_amount_halalas), 0)', city: 'b.city_id' },
};

/**
 * The reports screen: a six-month chart per city and a few headline figures for each report, and the city table. Everything is counted from
 * the database (the Riyadh calendar for months). Money is integer halalas; "completed" means COMPLETED bookings placed by completion time.
 */
@Injectable()
export class AdminReportsService {
  constructor(private readonly prisma: PrismaService) {}

  async series(metric: Metric, monthsCount: number, now: Date = new Date()) {
    const months = lastMonths(monthsCount, now);
    const cities = await this.prisma.city.findMany({ where: { isActive: true }, orderBy: [{ sortOrder: 'asc' }, { nameEn: 'asc' }], select: { id: true, nameEn: true, nameAr: true } });
    const def = SERIES[metric];
    const values: number[][] = months.map(() => cities.map(() => 0));
    if (def) {
      const sql = `SELECT ${def.city} AS city_id, ${def.value}::float AS v FROM ${def.from} WHERE ${def.at} >= $1 AND ${def.at} < $2 ${def.where ? `AND ${def.where}` : ''} GROUP BY ${def.city}`;
      const rows = await Promise.all(months.map((m) => this.prisma.$queryRawUnsafe<Array<{ city_id: string; v: number }>>(sql, m.start, m.end)));
      rows.forEach((perCity, mi) => {
        for (const r of perCity) {
          const ci = cities.findIndex((c) => c.id === r.city_id);
          if (ci >= 0) values[mi]![ci] = Number(r.v);
        }
      });
    }
    return { metric, unit: def?.unit ?? 'count', months: months.map((m) => m.label), cities, values, available: def !== null };
  }

  /** The four figures beside the chart. */
  async summary(metric: Metric, fromIso?: string, toIso?: string, now: Date = new Date()): Promise<{ range: { from: string; to: string }; rows: Row[]; note: string | null }> {
    const range = resolveRange(fromIso, toIso, now);
    const done = { completedAt: { gte: range.from, lt: range.to } };
    const created = { createdAt: { gte: range.from, lt: range.to } };
    const info = { range: { from: range.from.toISOString(), to: range.to.toISOString() } };
    const row = (label: string, value: number | string | null, kind: Kind): Row => ({ label, value, kind });
    const completed = () =>
      this.prisma.booking.aggregate({ where: done, _count: { _all: true }, _sum: { totalAmountHalalas: true, serviceAmountHalalas: true, vatAmountHalalas: true, commissionAmountHalalas: true, workerPayoutHalalas: true } });
    const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 1000) / 10 : null);

    switch (metric) {
      case 'revenue':
      case 'cities': {
        const c = await completed();
        const cnt = c._count._all;
        return { ...info, note: null, rows: [row('Gross revenue (incl. VAT)', n(c._sum.totalAmountHalalas), 'money'), row('Platform commission', n(c._sum.commissionAmountHalalas), 'money'), row('Avg. booking value', cnt ? Math.round(n(c._sum.totalAmountHalalas) / cnt) : null, 'money'), row('VAT in those bookings', n(c._sum.vatAmountHalalas), 'money')] };
      }
      case 'bookings': {
        const [createdCount, completedCount, cancelled, urgent, quoted, quotes] = await Promise.all([
          this.prisma.booking.count({ where: created }),
          this.prisma.booking.count({ where: done }),
          this.prisma.booking.count({ where: { cancelledAt: { gte: range.from, lt: range.to } } }),
          this.prisma.booking.count({ where: { ...created, isUrgent: true } }),
          this.prisma.quote.groupBy({ by: ['bookingId'], where: created }),
          this.prisma.quote.count({ where: created }),
        ]);
        return { ...info, note: null, rows: [row('Bookings created', createdCount, 'count'), row('Completed', completedCount, 'count'), row('Avg. quotes per request', quoted.length ? Math.round((quotes / quoted.length) * 10) / 10 : null, 'text'), row('As-soon-as-possible share', pct(urgent, createdCount), 'pct'), row('Cancelled', cancelled, 'count')].slice(0, 4) };
      }
      case 'commissions': {
        const [c, awaiting] = await Promise.all([completed(), this.prisma.booking.aggregate({ where: { status: { in: ['CONFIRMED', 'IN_PROGRESS'] } }, _sum: { commissionAmountHalalas: true } })]);
        return { ...info, note: null, rows: [row('Commission', n(c._sum.commissionAmountHalalas), 'money'), row('Effective rate', pct(n(c._sum.commissionAmountHalalas), n(c._sum.serviceAmountHalalas)), 'pct'), row('Service amount (ex. VAT)', n(c._sum.serviceAmountHalalas), 'money'), row('Still to come (confirmed jobs)', n(awaiting._sum.commissionAmountHalalas), 'money')] };
      }
      case 'earnings': {
        const [c, awaiting, active] = await Promise.all([
          completed(),
          this.prisma.booking.aggregate({ where: { status: { in: ['CONFIRMED', 'IN_PROGRESS'] } }, _sum: { workerPayoutHalalas: true } }),
          this.prisma.workerProfile.count({ where: { verificationStatus: WorkerVerificationStatus.APPROVED, user: { status: UserStatus.ACTIVE } } }),
        ]);
        return { ...info, note: 'Earnings are what workers earn on completed jobs; the platform does not record payouts yet.', rows: [row('Worker earnings', n(c._sum.workerPayoutHalalas), 'money'), row('Avg. per active worker', active ? Math.round(n(c._sum.workerPayoutHalalas) / active) : null, 'money'), row('Still to come (confirmed jobs)', n(awaiting._sum.workerPayoutHalalas), 'money'), row('Active workers', active, 'count')] };
      }
      case 'cancellations': {
        const [cancelled, createdCount, expired, byWho] = await Promise.all([
          this.prisma.booking.count({ where: { cancelledAt: { gte: range.from, lt: range.to } } }),
          this.prisma.booking.count({ where: created }),
          this.prisma.booking.count({ where: { status: 'EXPIRED', ...created } }),
          this.prisma.bookingCancellation.groupBy({ by: ['cancelledByRole'], where: { cancelledAt: { gte: range.from, lt: range.to } }, _count: { _all: true } }),
        ]);
        const by = (r: Role) => byWho.find((x) => x.cancelledByRole === r)?._count._all ?? 0;
        return { ...info, note: null, rows: [row('Cancelled bookings', cancelled, 'count'), row('Share of bookings created', pct(cancelled, createdCount), 'pct'), row('Cancelled by customers / workers', `${by(Role.CUSTOMER)} / ${by(Role.WORKER)}`, 'text'), row('Requests that expired', expired, 'count')] };
      }
      case 'refunds': {
        const [all, requested, succeeded] = await Promise.all([
          this.prisma.paymentRefund.aggregate({ where: created, _count: { _all: true }, _sum: { amountHalalas: true } }),
          this.prisma.paymentRefund.count({ where: { ...created, status: 'REQUESTED' } }),
          this.prisma.paymentRefund.count({ where: { ...created, status: 'SUCCEEDED' } }),
        ]);
        return { ...info, note: 'A refund is a request until the payment provider confirms it.', rows: [row('Refund requests', all._count._all, 'count'), row('Amount requested', n(all._sum.amountHalalas), 'money'), row('Still requested', requested, 'count'), row('Confirmed by the provider', succeeded, 'count')] };
      }
      case 'disputes': {
        const [opened, openNow, followups, reopened] = await Promise.all([
          this.prisma.dispute.count({ where: created }),
          this.prisma.dispute.count({ where: { status: { in: ['OPEN', 'UNDER_REVIEW', 'AWAITING_INFO'] } } }),
          this.prisma.dispute.count({ where: { ...created, financialFollowup: 'REQUESTED' } }),
          this.prisma.dispute.count({ where: { ...created, reopenCount: { gt: 0 } } }),
        ]);
        return { ...info, note: null, rows: [row('Disputes opened', opened, 'count'), row('Open now', openNow, 'count'), row('Refund follow-ups flagged', followups, 'count'), row('Reopened', reopened, 'count')] };
      }
      case 'offers': {
        const [made, live, scheduled, draft] = await Promise.all([
          this.prisma.offer.count({ where: created }),
          this.prisma.offer.count({ where: { status: 'PUBLISHED', startsAt: { lte: now }, endsAt: { gt: now } } }),
          this.prisma.offer.count({ where: { status: 'PUBLISHED', startsAt: { gt: now } } }),
          this.prisma.offer.count({ where: { status: 'DRAFT' } }),
        ]);
        return { ...info, note: 'Offers are announcements; the platform does not track discounts or redemptions.', rows: [row('Offers created', made, 'count'), row('Showing now', live, 'count'), row('Scheduled', scheduled, 'count'), row('Drafts', draft, 'count')] };
      }
      case 'subscriptions':
        return { ...info, note: 'Worker subscriptions are not part of the platform yet: every worker pays the one commission rate.', rows: [row('Active subscriptions', 0, 'count'), row('Monthly recurring revenue', 0, 'money'), row('Expired', 0, 'count'), row('Churn', null, 'pct')] };
      case 'customers': {
        const [customers, fresh, bookers, repeat] = await Promise.all([
          this.prisma.user.count({ where: { roles: { some: { role: Role.CUSTOMER } } } }),
          this.prisma.user.count({ where: { roles: { some: { role: Role.CUSTOMER } }, createdAt: { gte: range.from, lt: range.to } } }),
          this.prisma.booking.groupBy({ by: ['customerId'], where: created }),
          this.prisma.$queryRaw<Array<{ c: number }>>`SELECT count(*)::int AS c FROM (SELECT customer_id FROM bookings WHERE created_at >= ${range.from} AND created_at < ${range.to} GROUP BY customer_id HAVING count(*) >= 2) r`,
        ]);
        return { ...info, note: null, rows: [row('Customers (all)', customers, 'count'), row('New in range', fresh, 'count'), row('Booked in range', bookers.length, 'count'), row('Booked 2+ times in range', repeat[0]?.c ?? 0, 'count')] };
      }
      case 'workers': {
        const [active, online, pending, avg] = await Promise.all([
          this.prisma.workerProfile.count({ where: { verificationStatus: WorkerVerificationStatus.APPROVED, user: { status: UserStatus.ACTIVE } } }),
          this.prisma.workerProfile.count({ where: { verificationStatus: WorkerVerificationStatus.APPROVED, isOnline: true, user: { status: UserStatus.ACTIVE } } }),
          this.prisma.workerProfile.count({ where: { verificationStatus: { in: [WorkerVerificationStatus.SUBMITTED, WorkerVerificationStatus.UNDER_REVIEW] } } }),
          this.prisma.review.aggregate({ where: { status: 'PUBLISHED', ...created }, _avg: { rating: true } }),
        ]);
        return { ...info, note: null, rows: [row('Active workers', active, 'count'), row('Online now', online, 'count'), row('Waiting for verification', pending, 'count'), row('Avg. rating (range)', avg._avg.rating !== null ? Math.round(avg._avg.rating * 10) / 10 : null, 'text')] };
      }
    }
  }

  /** One row per active city for the window, and a total. */
  async cities(fromIso?: string, toIso?: string, now: Date = new Date()) {
    const range = resolveRange(fromIso, toIso, now);
    const [cities, created, completed, cancelled, refunds, disputes, ratings] = await Promise.all([
      this.prisma.city.findMany({ where: { isActive: true }, orderBy: [{ sortOrder: 'asc' }, { nameEn: 'asc' }], select: { id: true, nameEn: true, nameAr: true } }),
      this.prisma.booking.groupBy({ by: ['cityId'], where: { createdAt: { gte: range.from, lt: range.to } }, _count: { _all: true } }),
      this.prisma.booking.groupBy({ by: ['cityId'], where: { completedAt: { gte: range.from, lt: range.to } }, _count: { _all: true }, _sum: { totalAmountHalalas: true, commissionAmountHalalas: true, workerPayoutHalalas: true } }),
      this.prisma.booking.groupBy({ by: ['cityId'], where: { cancelledAt: { gte: range.from, lt: range.to } }, _count: { _all: true } }),
      this.prisma.$queryRaw<Array<{ city_id: string; amount: bigint }>>(Prisma.sql`SELECT b.city_id, coalesce(sum(r.amount_halalas), 0)::bigint AS amount FROM payment_refunds r JOIN bookings b ON b.id = r.booking_id WHERE r.created_at >= ${range.from} AND r.created_at < ${range.to} GROUP BY b.city_id`),
      this.prisma.$queryRaw<Array<{ city_id: string; c: number }>>(Prisma.sql`SELECT b.city_id, count(*)::int AS c FROM disputes d JOIN bookings b ON b.id = d.booking_id WHERE d.created_at >= ${range.from} AND d.created_at < ${range.to} GROUP BY b.city_id`),
      this.prisma.$queryRaw<Array<{ city_id: string; avg: number; n: number }>>(Prisma.sql`SELECT b.city_id, avg(r.rating)::float AS avg, count(*)::int AS n FROM reviews r JOIN bookings b ON b.id = r.booking_id WHERE r.status = 'PUBLISHED' AND r.created_at >= ${range.from} AND r.created_at < ${range.to} GROUP BY b.city_id`),
    ]);
    const items = cities.map((c) => {
      const cr = created.find((x) => x.cityId === c.id)?._count._all ?? 0;
      const done = completed.find((x) => x.cityId === c.id);
      const can = cancelled.find((x) => x.cityId === c.id)?._count._all ?? 0;
      const rating = ratings.find((x) => x.city_id === c.id);
      return {
        id: c.id, nameEn: c.nameEn, nameAr: c.nameAr,
        bookings: cr,
        revenueHalalas: n(done?._sum.totalAmountHalalas),
        commissionHalalas: n(done?._sum.commissionAmountHalalas),
        workerEarningsHalalas: n(done?._sum.workerPayoutHalalas),
        cancellations: can,
        cancellationPct: cr > 0 ? Math.round((can / cr) * 1000) / 10 : null,
        refundsHalalas: n(refunds.find((x) => x.city_id === c.id)?.amount),
        disputes: disputes.find((x) => x.city_id === c.id)?.c ?? 0,
        averageRating: rating ? Math.round(rating.avg * 10) / 10 : null,
        ratings: rating?.n ?? 0,
      };
    });
    const sum = (f: (i: (typeof items)[number]) => number) => items.reduce((a, i) => a + f(i), 0);
    const totalRatings = sum((i) => i.ratings);
    const totalBookings = sum((i) => i.bookings);
    const totalCancelled = sum((i) => i.cancellations);
    return {
      range: { from: range.from.toISOString(), to: range.to.toISOString() },
      items,
      total: {
        bookings: totalBookings, revenueHalalas: sum((i) => i.revenueHalalas), commissionHalalas: sum((i) => i.commissionHalalas), workerEarningsHalalas: sum((i) => i.workerEarningsHalalas),
        cancellations: totalCancelled, cancellationPct: totalBookings > 0 ? Math.round((totalCancelled / totalBookings) * 1000) / 10 : null,
        refundsHalalas: sum((i) => i.refundsHalalas), disputes: sum((i) => i.disputes),
        averageRating: totalRatings > 0 ? Math.round((items.reduce((a, i) => a + (i.averageRating ?? 0) * i.ratings, 0) / totalRatings) * 10) / 10 : null,
      },
    };
  }
}
