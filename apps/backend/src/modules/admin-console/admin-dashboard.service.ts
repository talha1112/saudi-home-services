import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service.js';
import { type Prisma, Role, UserStatus, WorkerVerificationStatus } from '../../generated/prisma/client.js';
import { resolveRange } from '../reports/reports.service.js';
import type { ConsoleRangeQueryDto } from './admin-console.dto.js';

const TIMEZONE = 'Asia/Riyadh';
const OPEN_DISPUTE = ['OPEN', 'UNDER_REVIEW', 'AWAITING_INFO'] as const;
const sum = (v: number | null | undefined) => v ?? 0;

/**
 * The administrator's overview. Everything is counted from the database for the chosen window and city. Money is integer halalas in SAR
 * (the platform has one currency). Definitions are repeated in the response so a number is never read without its meaning.
 *
 *  - "completed value" is the total (incl. VAT) of bookings COMPLETED in the window; commission and worker earnings are the amounts stored
 *    on those bookings when the quote was accepted (the rate they were accepted at).
 *  - "awaiting completion" is the same for bookings that are CONFIRMED or IN_PROGRESS now (a snapshot, not limited by the window).
 *  - Customers and worker head-counts are snapshots; they follow the city only for workers (the cities they serve).
 */
@Injectable()
export class AdminDashboardService {
  constructor(private readonly prisma: PrismaService) {}

  async dashboard(q: ConsoleRangeQueryDto, now: Date = new Date()) {
    const range = resolveRange(q.from, q.to, now);
    const city = q.cityId ? { cityId: q.cityId } : {};
    const inRange = (field: 'createdAt' | 'completedAt' | 'cancelledAt' | 'confirmedAt') => ({ [field]: { gte: range.from, lt: range.to }, ...city }) as Prisma.BookingWhereInput;
    const workerCity: Prisma.WorkerProfileWhereInput = q.cityId ? { serviceAreas: { some: { cityId: q.cityId } } } : {};

    const [
      created, byStatus, active, inProgress, completed, cancelled, confirmedValue, activeWorkers, onlineWorkers, pendingWorkers,
      openDisputes, disputesNeedingAction, customers, newCustomers, openSupport, services, cities, categories,
    ] = await Promise.all([
      this.prisma.booking.count({ where: inRange('createdAt') }),
      this.prisma.booking.groupBy({ by: ['status'], where: inRange('createdAt'), _count: { _all: true } }),
      this.prisma.booking.count({ where: { status: { in: ['CONFIRMED', 'IN_PROGRESS'] }, ...city } }),
      this.prisma.booking.count({ where: { status: 'IN_PROGRESS', ...city } }),
      this.prisma.booking.aggregate({ where: inRange('completedAt'), _count: { _all: true }, _sum: { totalAmountHalalas: true, serviceAmountHalalas: true, vatAmountHalalas: true, commissionAmountHalalas: true, workerPayoutHalalas: true } }),
      this.prisma.booking.count({ where: inRange('cancelledAt') }),
      this.prisma.booking.aggregate({ where: { status: { in: ['CONFIRMED', 'IN_PROGRESS'] }, ...city }, _count: { _all: true }, _sum: { totalAmountHalalas: true, workerPayoutHalalas: true } }),
      this.prisma.workerProfile.count({ where: { verificationStatus: WorkerVerificationStatus.APPROVED, user: { status: UserStatus.ACTIVE }, ...workerCity } }),
      this.prisma.workerProfile.count({ where: { verificationStatus: WorkerVerificationStatus.APPROVED, isOnline: true, user: { status: UserStatus.ACTIVE }, ...workerCity } }),
      this.prisma.workerProfile.count({ where: { verificationStatus: { in: [WorkerVerificationStatus.SUBMITTED, WorkerVerificationStatus.UNDER_REVIEW] }, ...workerCity } }),
      this.prisma.dispute.count({ where: { status: { in: [...OPEN_DISPUTE] }, ...(q.cityId ? { booking: { cityId: q.cityId } } : {}) } }),
      this.prisma.dispute.count({ where: { status: 'OPEN', ...(q.cityId ? { booking: { cityId: q.cityId } } : {}) } }),
      this.prisma.user.count({ where: { roles: { some: { role: Role.CUSTOMER } } } }),
      this.prisma.user.count({ where: { roles: { some: { role: Role.CUSTOMER } }, createdAt: { gte: range.from, lt: range.to } } }),
      this.prisma.supportThread.count({ where: { status: 'OPEN' } }),
      this.prisma.service.findMany({ select: { id: true, categoryId: true } }),
      this.prisma.city.findMany({ where: { isActive: true }, orderBy: [{ sortOrder: 'asc' }, { nameEn: 'asc' }], select: { id: true, nameEn: true, nameAr: true } }),
      this.prisma.serviceCategory.findMany({ orderBy: [{ sortOrder: 'asc' }, { nameEn: 'asc' }], select: { id: true, nameEn: true, nameAr: true, iconKey: true } }),
    ]);

    const [trend, byService, cityBookings, cityCompleted, cityWorkers, cityRatings, top, pending, disputes] = await Promise.all([
      this.trend(range, q.cityId),
      this.prisma.booking.groupBy({ by: ['serviceId'], where: inRange('createdAt'), _count: { _all: true } }),
      this.prisma.booking.groupBy({ by: ['cityId'], where: { createdAt: { gte: range.from, lt: range.to } }, _count: { _all: true } }),
      this.prisma.booking.groupBy({ by: ['cityId'], where: { completedAt: { gte: range.from, lt: range.to } }, _count: { _all: true }, _sum: { totalAmountHalalas: true } }),
      this.prisma.workerServiceArea.groupBy({ by: ['cityId'], where: { worker: { verificationStatus: WorkerVerificationStatus.APPROVED, user: { status: UserStatus.ACTIVE } } }, _count: { _all: true } }),
      this.prisma.$queryRaw<Array<{ city_id: string; avg: number | null; n: number }>>`
        SELECT b.city_id, avg(r.rating)::float AS avg, count(*)::int AS n
        FROM reviews r JOIN bookings b ON b.id = r.booking_id
        WHERE r.status = 'PUBLISHED' GROUP BY b.city_id`,
      this.prisma.booking.groupBy({
        by: ['workerProfileId'],
        where: { ...inRange('completedAt'), workerProfileId: { not: null } },
        _count: { _all: true },
        _sum: { workerPayoutHalalas: true },
        orderBy: [{ _count: { workerProfileId: 'desc' } }, { workerProfileId: 'asc' }],
        take: 5,
      }),
      this.prisma.workerProfile.findMany({
        where: { verificationStatus: { in: [WorkerVerificationStatus.SUBMITTED, WorkerVerificationStatus.UNDER_REVIEW] }, ...workerCity },
        orderBy: [{ verificationSubmittedAt: 'asc' }, { id: 'asc' }],
        take: 4,
        select: {
          id: true, verificationSubmittedAt: true,
          user: { select: { fullName: true, fullNameAr: true } },
          services: { select: { service: { select: { nameEn: true, nameAr: true } } }, take: 3 },
          serviceAreas: { select: { city: { select: { nameEn: true, nameAr: true } } }, take: 2 },
        },
      }),
      this.prisma.dispute.findMany({
        where: { status: { in: [...OPEN_DISPUTE] }, ...(q.cityId ? { booking: { cityId: q.cityId } } : {}) },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 4,
        select: { id: true, category: true, status: true, booking: { select: { reference: true, city: { select: { nameEn: true, nameAr: true } } } } },
      }),
    ]);

    const topProfiles = await this.prisma.workerProfile.findMany({
      where: { id: { in: top.map((t) => t.workerProfileId!).filter(Boolean) } },
      select: { id: true, ratingCount: true, ratingSum: true, user: { select: { fullName: true, fullNameAr: true } } },
    });
    const categoryOf = new Map(services.map((s) => [s.id, s.categoryId]));
    const perCategory = new Map<string, number>();
    for (const r of byService) perCategory.set(categoryOf.get(r.serviceId) ?? '', (perCategory.get(categoryOf.get(r.serviceId) ?? '') ?? 0) + r._count._all);
    const totalCreated = [...perCategory.values()].reduce((a, b) => a + b, 0);

    const completedCount = completed._count._all;
    const finished = completedCount + cancelled;
    const commission = sum(completed._sum.commissionAmountHalalas);
    const service = sum(completed._sum.serviceAmountHalalas);

    return {
      range: { from: range.from.toISOString(), to: range.to.toISOString(), cityId: q.cityId ?? null },
      kpis: {
        bookingsCreated: created,
        activeBookings: active,
        inProgress,
        completedBookings: completedCount,
        cancelledBookings: cancelled,
        completionRatePct: finished > 0 ? Math.round((completedCount / finished) * 1000) / 10 : null,
        completedValueHalalas: sum(completed._sum.totalAmountHalalas),
        serviceAmountHalalas: service,
        vatHalalas: sum(completed._sum.vatAmountHalalas),
        commissionHalalas: commission,
        effectiveCommissionPct: service > 0 ? Math.round((commission / service) * 1000) / 10 : null,
        workerEarningsHalalas: sum(completed._sum.workerPayoutHalalas),
        awaitingCompletionBookings: confirmedValue._count._all,
        awaitingCompletionValueHalalas: sum(confirmedValue._sum.totalAmountHalalas),
        awaitingCompletionWorkerEarningsHalalas: sum(confirmedValue._sum.workerPayoutHalalas),
        activeWorkers,
        onlineWorkers,
        pendingVerification: pendingWorkers,
        openDisputes,
        disputesNeedingAction,
        customers,
        newCustomers,
        openSupportThreads: openSupport,
      },
      bookingsByStatus: byStatus.map((r) => ({ status: r.status, count: r._count._all })),
      trend,
      categories: categories.map((c) => {
        const count = perCategory.get(c.id) ?? 0;
        return { id: c.id, nameEn: c.nameEn, nameAr: c.nameAr, iconKey: c.iconKey, bookings: count, sharePct: totalCreated > 0 ? Math.round((count / totalCreated) * 100) : 0 };
      }),
      cities: cities.map((c) => {
        const bookings = cityBookings.find((x) => x.cityId === c.id)?._count._all ?? 0;
        const done = cityCompleted.find((x) => x.cityId === c.id);
        const rating = cityRatings.find((x) => x.city_id === c.id);
        return {
          id: c.id, nameEn: c.nameEn, nameAr: c.nameAr,
          bookings,
          sharePct: created > 0 && !q.cityId ? Math.round((bookings / Math.max(1, cityBookings.reduce((a, x) => a + x._count._all, 0))) * 100) : null,
          completedValueHalalas: sum(done?._sum.totalAmountHalalas),
          workers: cityWorkers.find((x) => x.cityId === c.id)?._count._all ?? 0,
          averageRating: rating?.avg != null ? Math.round(rating.avg * 10) / 10 : null,
        };
      }),
      weekly: await this.weekly(range, q.cityId),
      topWorkers: top.map((t) => {
        const p = topProfiles.find((x) => x.id === t.workerProfileId);
        return {
          workerId: t.workerProfileId,
          fullName: p?.user.fullName ?? null,
          fullNameAr: p?.user.fullNameAr ?? null,
          completedJobs: t._count._all,
          earningsHalalas: sum(t._sum.workerPayoutHalalas),
          averageRating: p && p.ratingCount > 0 ? Math.round((p.ratingSum / p.ratingCount) * 10) / 10 : null,
        };
      }),
      pendingVerification: pending.map((w) => ({
        workerId: w.id,
        fullName: w.user.fullName,
        fullNameAr: w.user.fullNameAr,
        services: w.services.map((s) => ({ nameEn: s.service.nameEn, nameAr: s.service.nameAr })),
        cities: w.serviceAreas.map((a) => ({ nameEn: a.city.nameEn, nameAr: a.city.nameAr })),
        submittedAt: w.verificationSubmittedAt?.toISOString() ?? null,
      })),
      openDisputesList: disputes.map((d) => ({ id: d.id, category: d.category, status: d.status, bookingReference: d.booking.reference, cityNameEn: d.booking.city.nameEn, cityNameAr: d.booking.city.nameAr })),
      definitions: {
        window: 'Counts and money use the chosen date window (from inclusive, to exclusive) and city. Snapshots (active bookings, workers, customers, open disputes) show the situation now.',
        completedValue: 'Total (incl. VAT) of bookings COMPLETED in the window. Commission and worker earnings are the amounts stored on those bookings when the quote was accepted.',
        completionRate: 'Completed ÷ (completed + cancelled) in the window.',
        awaitingCompletion: 'Bookings that are CONFIRMED or IN_PROGRESS now.',
      },
    };
  }

  /** Completed value, commission and worker earnings per Riyadh week (Monday start) for the last six weeks that end inside the window. */
  private async weekly(range: { from: Date; to: Date }, cityId?: string) {
    const rows = await this.prisma.$queryRawUnsafe<Array<{ week: string; gross: bigint; commission: bigint; earnings: bigint }>>(
      `SELECT to_char(date_trunc('week', completed_at AT TIME ZONE $1), 'YYYY-MM-DD') AS week, coalesce(sum(total_amount_halalas), 0)::bigint AS gross, coalesce(sum(commission_amount_halalas), 0)::bigint AS commission, coalesce(sum(worker_payout_halalas), 0)::bigint AS earnings
       FROM bookings WHERE completed_at >= $2 AND completed_at < $3 ${cityId ? 'AND city_id = $4::uuid' : ''} GROUP BY 1 ORDER BY 1 DESC LIMIT 6`,
      ...(cityId ? [TIMEZONE, range.from, range.to, cityId] : [TIMEZONE, range.from, range.to]),
    );
    return rows.reverse().map((r) => ({ weekStart: r.week, grossHalalas: Number(r.gross), commissionHalalas: Number(r.commission), workerEarningsHalalas: Number(r.earnings) }));
  }

  /** Bookings created and completed per day (Riyadh calendar) inside the window. */
  private async trend(range: { from: Date; to: Date }, cityId?: string) {
    const run = (column: 'created_at' | 'completed_at') =>
      this.prisma.$queryRawUnsafe<Array<{ bucket: string; c: number }>>(
        `SELECT to_char(date_trunc('day', ${column} AT TIME ZONE $1), 'YYYY-MM-DD') AS bucket, count(*)::int AS c FROM bookings WHERE ${column} >= $2 AND ${column} < $3 ${cityId ? 'AND city_id = $4::uuid' : ''} GROUP BY 1 ORDER BY 1`,
        ...(cityId ? [TIMEZONE, range.from, range.to, cityId] : [TIMEZONE, range.from, range.to]),
      );
    const [created, completed] = await Promise.all([run('created_at'), run('completed_at')]);
    const days = new Map<string, { date: string; created: number; completed: number }>();
    for (const r of created) days.set(r.bucket, { date: r.bucket, created: r.c, completed: 0 });
    for (const r of completed) days.set(r.bucket, { ...(days.get(r.bucket) ?? { date: r.bucket, created: 0 }), completed: r.c });
    return [...days.values()].sort((a, b) => a.date.localeCompare(b.date));
  }
}
