import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service.js';
import { Prisma } from '../../generated/prisma/client.js';
import { PricingService } from '../pricing/pricing.service.js';
import { resolveRange } from '../reports/reports.service.js';
import type { CommissionsQueryDto } from './admin-console.dto.js';

interface Row {
  worker_id: string;
  full_name: string | null;
  full_name_ar: string | null;
  jobs: number;
  service: bigint;
  commission: bigint;
  payout: bigint;
  total: number;
}

/**
 * What the platform earns and what workers earn, from COMPLETED bookings in the window (the amounts stored on each booking when its quote
 * was accepted, so a later rate change never rewrites history). There is one commission rate at a time (the pricing setting), not plans.
 */
@Injectable()
export class AdminCommissionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly pricing: PricingService,
  ) {}

  async report(q: CommissionsQueryDto, now: Date = new Date()) {
    const range = resolveRange(q.from, q.to, now);
    const city = q.cityId ? { cityId: q.cityId } : {};
    const done = { completedAt: { gte: range.from, lt: range.to }, ...city } satisfies Prisma.BookingWhereInput;
    const [totals, awaiting, current] = await Promise.all([
      this.prisma.booking.aggregate({ where: done, _count: { _all: true }, _sum: { serviceAmountHalalas: true, vatAmountHalalas: true, totalAmountHalalas: true, commissionAmountHalalas: true, workerPayoutHalalas: true } }),
      this.prisma.booking.aggregate({ where: { status: { in: ['CONFIRMED', 'IN_PROGRESS'] }, ...city }, _count: { _all: true }, _sum: { commissionAmountHalalas: true, workerPayoutHalalas: true } }),
      this.pricing.currentDto(),
    ]);
    const n = (v: number | null | undefined) => v ?? 0;
    const service = n(totals._sum.serviceAmountHalalas);
    const commission = n(totals._sum.commissionAmountHalalas);
    return {
      range: { from: range.from.toISOString(), to: range.to.toISOString(), cityId: q.cityId ?? null },
      rule: { commissionRateBps: current.commissionRateBps, vatRateBps: current.vatRateBps, minServiceChargeHalalas: current.minServiceChargeHalalas, effectiveFrom: current.effectiveFrom, isProvisional: current.isProvisional },
      totals: {
        completedBookings: totals._count._all,
        serviceAmountHalalas: service,
        vatHalalas: n(totals._sum.vatAmountHalalas),
        totalHalalas: n(totals._sum.totalAmountHalalas),
        commissionHalalas: commission,
        workerEarningsHalalas: n(totals._sum.workerPayoutHalalas),
        effectiveRatePct: service > 0 ? Math.round((commission / service) * 1000) / 10 : null,
        awaitingCompletionBookings: awaiting._count._all,
        awaitingCompletionCommissionHalalas: n(awaiting._sum.commissionAmountHalalas),
        awaitingCompletionWorkerEarningsHalalas: n(awaiting._sum.workerPayoutHalalas),
      },
      definitions: {
        totals: 'COMPLETED bookings in the window. Service amount is before VAT; commission and worker earnings are the amounts stored on each booking when its quote was accepted.',
        awaitingCompletion: 'Bookings that are CONFIRMED or IN_PROGRESS now: the commission and worker earnings they will produce once completed.',
        payouts: 'The platform does not record payouts to workers yet, so these are earnings, not money sent.',
      },
    };
  }

  /** One row per worker with completed bookings in the window, biggest first. */
  async workers(q: CommissionsQueryDto, now: Date = new Date()) {
    const range = resolveRange(q.from, q.to, now);
    const like = q.q ? `%${q.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
    const rows = await this.prisma.$queryRaw<Row[]>`
      SELECT wp.id AS worker_id, u.full_name, u.full_name_ar, count(*)::int AS jobs,
        coalesce(sum(b.service_amount_halalas), 0)::bigint AS service,
        coalesce(sum(b.commission_amount_halalas), 0)::bigint AS commission,
        coalesce(sum(b.worker_payout_halalas), 0)::bigint AS payout,
        count(*) OVER ()::int AS total
      FROM bookings b
      JOIN worker_profiles wp ON wp.id = b.worker_profile_id
      JOIN users u ON u.id = wp.user_id
      WHERE b.completed_at >= ${range.from} AND b.completed_at < ${range.to}
        ${q.cityId ? Prisma.sql`AND b.city_id = ${q.cityId}::uuid` : Prisma.empty}
        ${like ? Prisma.sql`AND (u.full_name ILIKE ${like} OR u.full_name_ar ILIKE ${like})` : Prisma.empty}
      GROUP BY wp.id, u.full_name, u.full_name_ar
      ORDER BY sum(b.service_amount_halalas) DESC, wp.id
      LIMIT ${q.limit} OFFSET ${q.skip}`;
    const total = rows[0]?.total ?? 0;
    return {
      items: rows.map((r) => ({
        workerId: r.worker_id,
        fullName: r.full_name,
        fullNameAr: r.full_name_ar,
        completedJobs: r.jobs,
        serviceAmountHalalas: Number(r.service),
        commissionHalalas: Number(r.commission),
        workerEarningsHalalas: Number(r.payout),
      })),
      meta: { page: q.page, limit: q.limit, total, totalPages: Math.max(1, Math.ceil(total / q.limit)) },
    };
  }
}
