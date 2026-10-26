import { Injectable } from '@nestjs/common';
import { type Page, toPage } from '../../common/pagination/pagination.js';
import { PrismaService } from '../../database/prisma.service.js';
import { Prisma, QuoteStatus } from '../../generated/prisma/client.js';
import { resolveRange } from '../reports/reports.service.js';
import type { QuotesQueryDto } from './admin-console.dto.js';

const contains = (q: string) => ({ contains: q, mode: 'insensitive' as const });

/**
 * Every quote on the platform, one row each. A quote that is still SUBMITTED but whose validity ran out is shown as EXPIRED (that is what
 * it is for the customer; the stored status only changes when a maintenance job runs). The money shown is the worker's price before VAT,
 * and what the worker nets after the commission stored on the quote.
 */
@Injectable()
export class AdminQuotesService {
  constructor(private readonly prisma: PrismaService) {}

  async list(q: QuotesQueryDto, now: Date = new Date()): Promise<Page<ReturnType<typeof view>>> {
    const where = this.where(q, now);
    const [rows, total] = await Promise.all([
      this.prisma.quote.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: q.skip, take: q.limit, include: INCLUDE }),
      this.prisma.quote.count({ where }),
    ]);
    return toPage(rows.map((r) => view(r, now)), total, q);
  }

  async summary(fromIso?: string, toIso?: string, cityId?: string, now: Date = new Date()) {
    const range = resolveRange(fromIso, toIso, now);
    const created = { createdAt: { gte: range.from, lt: range.to }, ...(cityId ? { booking: { cityId } } : {}) };
    const [byStatus, responses, requests, pendingNow, expiredSubmitted] = await Promise.all([
      this.prisma.quote.groupBy({ by: ['status'], where: created, _count: { _all: true } }),
      this.prisma.$queryRaw<Array<{ avg_minutes: number | null }>>`
        SELECT avg(extract(epoch FROM (q.created_at - b.created_at)) / 60)::float AS avg_minutes
        FROM (SELECT DISTINCT ON (booking_id) booking_id, created_at FROM quotes WHERE created_at >= ${range.from} AND created_at < ${range.to} ORDER BY booking_id, created_at ASC) q
        JOIN bookings b ON b.id = q.booking_id
        ${cityId ? Prisma.sql`WHERE b.city_id = ${cityId}::uuid` : Prisma.empty}`,
      this.prisma.quote.groupBy({ by: ['bookingId'], where: created }),
      this.prisma.quote.count({ where: { status: 'SUBMITTED', validUntil: { gt: now }, ...(cityId ? { booking: { cityId } } : {}) } }),
      this.prisma.quote.count({ where: { ...created, status: 'SUBMITTED', validUntil: { lte: now } } }),
    ]);
    const count = (s: QuoteStatus) => byStatus.find((r) => r.status === s)?._count._all ?? 0;
    const sent = byStatus.reduce((a, r) => a + r._count._all, 0);
    const accepted = count('ACCEPTED');
    return {
      range: { from: range.from.toISOString(), to: range.to.toISOString() },
      sent,
      pendingNow,
      accepted,
      rejected: count('REJECTED'),
      withdrawn: count('WITHDRAWN'),
      expired: count('EXPIRED') + expiredSubmitted,
      acceptanceRatePct: sent > 0 ? Math.round((accepted / sent) * 100) : null,
      requestsQuoted: requests.length,
      averageQuotesPerRequest: requests.length > 0 ? Math.round((sent / requests.length) * 10) / 10 : null,
      averageFirstResponseMinutes: responses[0]?.avg_minutes != null ? Math.round(responses[0].avg_minutes) : null,
      definitions: {
        sent: 'Quotes created in the window (a revision does not create a new quote).',
        pendingNow: 'Submitted quotes that are still valid right now (not limited by the window).',
        averageFirstResponseMinutes: 'For each request that got a quote in the window: minutes from the request to its first quote.',
      },
    };
  }

  private where(q: QuotesQueryDto, now: Date): Prisma.QuoteWhereInput {
    const and: Prisma.QuoteWhereInput[] = [];
    if (q.status === 'PENDING') and.push({ status: 'SUBMITTED', validUntil: { gt: now } });
    else if (q.status === 'EXPIRED') and.push({ OR: [{ status: 'EXPIRED' }, { status: 'SUBMITTED', validUntil: { lte: now } }] });
    else if (q.status === 'SUBMITTED') and.push({ status: 'SUBMITTED', validUntil: { gt: now } });
    else if (q.status) and.push({ status: q.status as QuoteStatus });
    if (q.workerId) and.push({ workerProfileId: q.workerId });
    if (q.cityId) and.push({ booking: { cityId: q.cityId } });
    if (q.from || q.to) and.push({ createdAt: { ...(q.from ? { gte: new Date(q.from) } : {}), ...(q.to ? { lt: new Date(q.to) } : {}) } });
    if (q.q) {
      and.push({
        OR: [
          { booking: { reference: { startsWith: q.q.toUpperCase() } } },
          { booking: { service: { OR: [{ nameEn: contains(q.q) }, { nameAr: contains(q.q) }] } } },
          { worker: { user: { OR: [{ fullName: contains(q.q) }, { fullNameAr: contains(q.q) }] } } },
        ],
      });
    }
    return and.length ? { AND: and } : {};
  }
}

const INCLUDE = {
  booking: { select: { id: true, reference: true, service: { select: { nameEn: true, nameAr: true } } } },
  worker: { select: { id: true, user: { select: { fullName: true, fullNameAr: true } } } },
} satisfies Prisma.QuoteInclude;

type Row = Prisma.QuoteGetPayload<{ include: typeof INCLUDE }>;

function view(r: Row, now: Date) {
  const expired = r.status === 'EXPIRED' || (r.status === 'SUBMITTED' && r.validUntil <= now);
  return {
    id: r.id,
    bookingId: r.booking.id,
    bookingReference: r.booking.reference,
    serviceNameEn: r.booking.service.nameEn,
    serviceNameAr: r.booking.service.nameAr,
    workerId: r.worker.id,
    workerName: r.worker.user.fullName,
    workerNameAr: r.worker.user.fullNameAr,
    status: expired ? 'EXPIRED' : r.status === 'SUBMITTED' ? 'PENDING' : r.status,
    version: r.version,
    priceHalalas: r.priceHalalas,
    totalHalalas: r.totalAmountHalalas,
    commissionHalalas: r.commissionAmountHalalas,
    workerPayoutHalalas: r.workerPayoutHalalas,
    sentAt: r.createdAt.toISOString(),
    validUntil: r.validUntil.toISOString(),
    proposedStartAt: r.proposedStartAt.toISOString(),
    message: r.message,
  };
}
