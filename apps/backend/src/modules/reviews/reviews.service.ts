import { HttpStatus, Injectable } from '@nestjs/common';
import type { AuthenticatedUser } from '../../common/auth/authenticated-user.js';
import { ApiError } from '../../common/errors/api-error.js';
import { type Page, PageQueryDto, toPage } from '../../common/pagination/pagination.js';
import { PrismaService } from '../../database/prisma.service.js';
import { BookingStatus, type Prisma, ReviewStatus, Role, UserStatus, WorkerVerificationStatus } from '../../generated/prisma/client.js';
import { AuditService } from '../auth/audit.service.js';
import type { ClientMeta } from '../auth/auth.types.js';
import { lockBooking } from '../bookings/booking-support.js';

type Tx = Prisma.TransactionClient;

const conflict = (code: string, message: string, details?: Record<string, unknown>) => new ApiError(HttpStatus.CONFLICT, code, message, details ? { details } : {});
const notFound = (what = 'Review') => new ApiError(HttpStatus.NOT_FOUND, 'NOT_FOUND', `${what} not found`);

export const average = (sum: number, count: number): number | null => (count > 0 ? Math.round((sum / count) * 100) / 100 : null);

/**
 * Customer reviews of the worker who completed a booking.
 *
 * Policy (defaults chosen conservatively; none was approved by the business, see docs/ADMIN_DISPUTES_REVIEWS_REPORTS.md):
 *  - ONE review per booking, only by that booking's customer, only after it is COMPLETED, never by a worker about themself;
 *  - rating 1-5, optional comment up to 1000 characters;
 *  - reviews are NOT editable (a trigger forbids it). The customer can withdraw it (final);
 *  - an administrator can hide and later restore a review with a reason, never edit or create one; the history is append-only;
 *  - nothing is connected to payments or disputes.
 *
 * Worker rating = average of PUBLISHED reviews (HIDDEN and WITHDRAWN excluded), rounded to 2 decimals, null without reviews.
 * The cached count and sum on the worker profile are recomputed FROM the reviews table, under a lock on the profile row,
 * in the same transaction as every change; they are never incremented, so they cannot drift.
 */
@Injectable()
export class ReviewsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // ================================================================================== customer

  async submit(user: AuthenticatedUser, bookingId: string, dto: { rating: number; comment?: string }) {
    const first = await this.prisma.booking.findFirst({ where: { id: bookingId, customerId: user.id }, select: { workerProfileId: true } });
    if (!first) throw notFound('Booking'); // someone else's booking looks the same as a missing one
    if (!first.workerProfileId) throw conflict('NOT_REVIEWABLE', 'This booking has no worker to review');

    const comment = dto.comment?.trim() || null;
    try {
      const review = await this.prisma.$transaction(async (tx) => {
        await lockBooking(tx, bookingId);
        await this.lockWorker(tx, first.workerProfileId!);
        const booking = await tx.booking.findFirst({ where: { id: bookingId, customerId: user.id }, select: { id: true, status: true, workerProfileId: true, worker: { select: { userId: true } } } });
        if (!booking) throw notFound('Booking');
        if (booking.status !== BookingStatus.COMPLETED) throw conflict('NOT_REVIEWABLE', 'Only a completed booking can be reviewed', { status: booking.status });
        if (!booking.workerProfileId || booking.workerProfileId !== first.workerProfileId) throw conflict('NOT_REVIEWABLE', 'This booking has no worker to review');
        if (booking.worker?.userId === user.id) throw new ApiError(HttpStatus.FORBIDDEN, 'CANNOT_REVIEW_OWN_SERVICE', 'You cannot review your own service');
        if (await tx.review.count({ where: { bookingId } })) throw conflict('REVIEW_EXISTS', 'You have already reviewed this booking');

        const created = await tx.review.create({ data: { bookingId, customerId: user.id, workerProfileId: booking.workerProfileId, rating: dto.rating, comment } });
        await tx.reviewEvent.create({ data: { reviewId: created.id, action: 'SUBMITTED', toStatus: ReviewStatus.PUBLISHED, actorUserId: user.id, actorRole: Role.CUSTOMER } });
        await this.recompute(tx, booking.workerProfileId);
        return created;
      });
      return this.customerView(review);
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002') throw conflict('REVIEW_EXISTS', 'You have already reviewed this booking');
      throw err;
    }
  }

  async mine(user: AuthenticatedUser, bookingId: string) {
    const review = await this.prisma.review.findFirst({ where: { bookingId, customerId: user.id } });
    if (!review) throw notFound();
    return this.customerView(review);
  }

  /** The customer takes their review back. Final: the booking cannot be reviewed again. */
  async withdraw(user: AuthenticatedUser, bookingId: string) {
    const review = await this.prisma.review.findFirst({ where: { bookingId, customerId: user.id } });
    if (!review) throw notFound();
    const updated = await this.changeStatus(review.id, review.workerProfileId, { from: [ReviewStatus.PUBLISHED, ReviewStatus.HIDDEN], to: ReviewStatus.WITHDRAWN, action: 'WITHDRAWN', actorId: user.id, role: Role.CUSTOMER });
    return this.customerView(updated);
  }

  // ================================================================================== reading ratings

  /** Published reviews of an approved, active worker, without any customer identity. */
  async forWorker(workerProfileId: string, query: PageQueryDto) {
    const worker = await this.prisma.workerProfile.findFirst({
      where: { id: workerProfileId, verificationStatus: WorkerVerificationStatus.APPROVED, user: { status: UserStatus.ACTIVE } },
      select: { id: true },
    });
    if (!worker) throw notFound('Worker');
    return this.publishedFor(worker.id, query);
  }

  async receivedByMe(user: AuthenticatedUser, query: PageQueryDto) {
    const profile = await this.prisma.workerProfile.findUnique({ where: { userId: user.id }, select: { id: true } });
    if (!profile) throw notFound('Worker profile');
    return this.publishedFor(profile.id, query);
  }

  private async publishedFor(workerProfileId: string, query: PageQueryDto) {
    const where = { workerProfileId, status: ReviewStatus.PUBLISHED };
    const [profile, rows, total, groups] = await Promise.all([
      this.prisma.workerProfile.findUniqueOrThrow({ where: { id: workerProfileId }, select: { ratingCount: true, ratingSum: true } }),
      this.prisma.review.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: query.skip, take: query.limit, select: { id: true, rating: true, comment: true, createdAt: true } }),
      this.prisma.review.count({ where }),
      this.prisma.review.groupBy({ by: ['rating'], where, _count: { _all: true } }),
    ]);
    const distribution = Object.fromEntries([1, 2, 3, 4, 5].map((n) => [n, groups.find((g) => g.rating === n)?._count._all ?? 0]));
    return {
      summary: { count: profile.ratingCount, average: average(profile.ratingSum, profile.ratingCount), distribution },
      ...toPage(rows.map((r) => ({ id: r.id, rating: r.rating, comment: r.comment, createdAt: r.createdAt.toISOString() })), total, query),
    };
  }

  // ================================================================================== administrators

  async adminList(q: { status?: ReviewStatus; workerProfileId?: string; rating?: number; from?: string; to?: string; q?: string; cityId?: string; maxRating?: number } & PageQueryDto): Promise<Page<ReturnType<ReviewsService['adminView']>>> {
    const where: Prisma.ReviewWhereInput = {
      ...(q.status ? { status: q.status } : {}),
      ...(q.workerProfileId ? { workerProfileId: q.workerProfileId } : {}),
      ...(q.rating ? { rating: q.rating } : q.maxRating ? { rating: { lte: q.maxRating } } : {}),
      ...(q.cityId ? { booking: { cityId: q.cityId } } : {}),
      ...(q.from || q.to ? { createdAt: { ...(q.from ? { gte: new Date(q.from) } : {}), ...(q.to ? { lt: new Date(q.to) } : {}) } } : {}),
      ...(q.q
        ? {
            OR: [
              { comment: { contains: q.q, mode: 'insensitive' as const } },
              { customer: { fullName: { contains: q.q, mode: 'insensitive' as const } } },
              { worker: { user: { fullName: { contains: q.q, mode: 'insensitive' as const } } } },
              { booking: { reference: { startsWith: q.q.toUpperCase() } } },
            ],
          }
        : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.review.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: q.skip, take: q.limit, include: ADMIN_REVIEW_INCLUDE }),
      this.prisma.review.count({ where }),
    ]);
    return toPage(rows.map((r) => this.adminView(r)), total, q);
  }

  async adminGet(id: string) {
    const r = await this.prisma.review.findUnique({ where: { id }, include: { ...ADMIN_REVIEW_INCLUDE, events: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] } } });
    if (!r) throw notFound();
    return {
      ...this.adminView(r),
      history: r.events.map((e) => ({ action: e.action, fromStatus: e.fromStatus, toStatus: e.toStatus, actorUserId: e.actorUserId, actorRole: e.actorRole, reason: e.reason, createdAt: e.createdAt.toISOString() })),
    };
  }

  async moderate(admin: AuthenticatedUser, id: string, action: 'hide' | 'restore', reason: string, meta: ClientMeta) {
    const review = await this.prisma.review.findUnique({ where: { id }, select: { workerProfileId: true } });
    if (!review) throw notFound();
    const rule = action === 'hide' ? { from: [ReviewStatus.PUBLISHED], to: ReviewStatus.HIDDEN, action: 'HIDDEN' } : { from: [ReviewStatus.HIDDEN], to: ReviewStatus.PUBLISHED, action: 'RESTORED' };
    await this.changeStatus(id, review.workerProfileId, { ...rule, actorId: admin.id, role: Role.ADMIN, reason });
    await this.audit.record({
      action: `review.${action}`,
      actorUserId: admin.id,
      entityType: 'review',
      entityId: id,
      metadata: { beforeStatus: rule.from[0]!, afterStatus: rule.to, reason },
      ipAddress: meta.ip,
      userAgent: meta.userAgent,
    });
    return this.adminGet(id);
  }

  // ================================================================================== internals

  /** One status change plus the aggregate refresh, serialised per worker. */
  private async changeStatus(id: string, workerProfileId: string, t: { from: ReviewStatus[]; to: ReviewStatus; action: string; actorId: string; role: Role; reason?: string }) {
    return this.prisma.$transaction(async (tx) => {
      await this.lockWorker(tx, workerProfileId);
      const current = await tx.review.findUnique({ where: { id }, select: { status: true } });
      if (!current) throw notFound();
      if (!t.from.includes(current.status)) throw conflict('INVALID_STATE', `This review is ${current.status}; ${t.action.toLowerCase()} is not possible`, { status: current.status });
      const moved = await tx.review.updateMany({ where: { id, status: { in: t.from } }, data: { status: t.to } });
      if (moved.count !== 1) throw conflict('INVALID_STATE', 'The review was changed by someone else, please reload');
      await tx.reviewEvent.create({ data: { reviewId: id, action: t.action, fromStatus: current.status, toStatus: t.to, actorUserId: t.actorId, actorRole: t.role, reason: t.reason ?? null } });
      await this.recompute(tx, workerProfileId);
      return tx.review.findUniqueOrThrow({ where: { id } });
    });
  }

  /** Takes the worker profile row lock: every writer of one worker's reviews runs one after another. */
  private async lockWorker(tx: Tx, workerProfileId: string): Promise<void> {
    await tx.$queryRaw`SELECT id FROM worker_profiles WHERE id = ${workerProfileId}::uuid FOR UPDATE`;
  }

  /** Rebuilds the cached aggregate from the source rows (call only while holding lockWorker). */
  private async recompute(tx: Tx, workerProfileId: string): Promise<void> {
    await tx.$executeRaw`
      UPDATE worker_profiles w
      SET rating_count = r.c, rating_sum = r.s
      FROM (SELECT count(*)::int AS c, COALESCE(sum(rating), 0)::int AS s FROM reviews WHERE worker_profile_id = ${workerProfileId}::uuid AND status = 'PUBLISHED') r
      WHERE w.id = ${workerProfileId}::uuid`;
  }

  private customerView(r: { id: string; bookingId: string; rating: number; comment: string | null; status: ReviewStatus; createdAt: Date }) {
    // A customer is told "hidden", never why or by whom.
    return { id: r.id, bookingId: r.bookingId, rating: r.rating, comment: r.comment, status: r.status, createdAt: r.createdAt.toISOString() };
  }

  private adminView(r: { id: string; bookingId: string; customerId: string; workerProfileId: string; rating: number; comment: string | null; status: ReviewStatus; createdAt: Date; updatedAt: Date; booking?: { reference: string; service: { nameEn: string; nameAr: string } }; customer?: { fullName: string | null }; worker?: { user: { fullName: string | null } } }) {
    return {
      id: r.id, bookingId: r.bookingId, customerId: r.customerId, workerProfileId: r.workerProfileId, rating: r.rating, comment: r.comment, status: r.status,
      bookingReference: r.booking?.reference ?? null, serviceNameEn: r.booking?.service.nameEn ?? null, serviceNameAr: r.booking?.service.nameAr ?? null,
      customerName: r.customer?.fullName ?? null, workerName: r.worker?.user.fullName ?? null,
      createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString(),
    };
  }
}

const ADMIN_REVIEW_INCLUDE = {
  booking: { select: { reference: true, service: { select: { nameEn: true, nameAr: true } } } },
  customer: { select: { fullName: true } },
  worker: { select: { user: { select: { fullName: true } } } },
} as const;
