import { Injectable } from '@nestjs/common';
import { type Page, toPage } from '../../common/pagination/pagination.js';
import { PrismaService } from '../../database/prisma.service.js';
import { BookingStatus, Prisma, QuoteStatus } from '../../generated/prisma/client.js';
import { notFound } from './booking-support.js';
import { coversInstant } from '../workers/availability.js';
import { QuotesService, type WorkerContext } from './quotes.service.js';
import type {
  AdminBookingDetailDto,
  AdminListBookingsQueryDto,
  BookingDetailDto,
  BookingEventDto,
  BookingLocationDto,
  BookingPhotoDto,
  BookingSummaryDto,
  CustomerMoneyDto,
  ListBookingsQueryDto,
  ListMyQuotesQueryDto,
  ListQuotesQueryDto,
  ListRequestsQueryDto,
  QuoteForCustomerDto,
  QuoteForWorkerDto,
  WorkerBookingDto,
  WorkerMoneyDto,
  WorkerPublicSummaryDto,
  WorkerRequestDetailDto,
  WorkerRequestSummaryDto,
} from './dto/bookings.dto.js';

const PAID: BookingStatus[] = [BookingStatus.CONFIRMED, BookingStatus.IN_PROGRESS, BookingStatus.COMPLETED];

const SERVICE_SELECT = { select: { id: true, slug: true, nameEn: true, nameAr: true } } as const;
const CITY_SELECT = { select: { id: true, nameEn: true, nameAr: true } } as const;

const SUMMARY_INCLUDE = { service: SERVICE_SELECT } satisfies Prisma.BookingInclude;
const DETAIL_INCLUDE = {
  service: SERVICE_SELECT,
  city: CITY_SELECT,
  photos: { orderBy: { createdAt: 'asc' as const } },
  events: { orderBy: { createdAt: 'asc' as const } },
  cancellation: true,
  worker: { include: { user: { select: { fullName: true, fullNameAr: true, phone: true } } } },
} satisfies Prisma.BookingInclude;

type SummaryRow = Prisma.BookingGetPayload<{ include: typeof SUMMARY_INCLUDE }>;
type DetailRow = Prisma.BookingGetPayload<{ include: typeof DETAIL_INCLUDE }>;
type QuoteRow = Prisma.QuoteGetPayload<object>;

// ------------------------------------------------------------------ mappers

export function customerMoney(m: {
  currency?: string;
  serviceHalalas: number;
  vatHalalas: number;
  totalHalalas: number;
  vatRateBps: number;
}): CustomerMoneyDto {
  return {
    currency: m.currency ?? 'SAR',
    serviceHalalas: m.serviceHalalas,
    vatHalalas: m.vatHalalas,
    totalHalalas: m.totalHalalas,
    vatRateBps: m.vatRateBps,
  };
}

function quoteCustomerMoney(q: QuoteRow): CustomerMoneyDto {
  return customerMoney({ serviceHalalas: q.priceHalalas, vatHalalas: q.vatAmountHalalas, totalHalalas: q.totalAmountHalalas, vatRateBps: q.vatRateBps });
}

function quoteWorkerMoney(q: QuoteRow): WorkerMoneyDto {
  return {
    ...quoteCustomerMoney(q),
    commissionHalalas: q.commissionAmountHalalas,
    payoutHalalas: q.workerPayoutHalalas,
    commissionRateBps: q.commissionRateBps,
  };
}

/** The money snapshot stored on an accepted booking, or null before acceptance. */
function bookingCustomerMoney(b: SummaryRow): CustomerMoneyDto | null {
  if (b.serviceAmountHalalas === null || b.vatAmountHalalas === null || b.totalAmountHalalas === null || b.vatRateBps === null) return null;
  return customerMoney({
    currency: b.currency,
    serviceHalalas: b.serviceAmountHalalas,
    vatHalalas: b.vatAmountHalalas,
    totalHalalas: b.totalAmountHalalas,
    vatRateBps: b.vatRateBps,
  });
}

function bookingWorkerMoney(b: SummaryRow): WorkerMoneyDto | null {
  const base = bookingCustomerMoney(b);
  if (!base || b.commissionAmountHalalas === null || b.workerPayoutHalalas === null || b.commissionRateBps === null) return null;
  return { ...base, commissionHalalas: b.commissionAmountHalalas, payoutHalalas: b.workerPayoutHalalas, commissionRateBps: b.commissionRateBps };
}

export function toQuoteForWorker(q: QuoteRow & { booking: { reference: string } }, now: Date = new Date()): QuoteForWorkerDto {
  return {
    id: q.id,
    bookingId: q.bookingId,
    bookingReference: q.booking.reference,
    status: q.status,
    version: q.version,
    money: quoteWorkerMoney(q),
    proposedStartAt: q.proposedStartAt.toISOString(),
    proposedEndAt: q.proposedEndAt.toISOString(),
    estimatedDurationMinutes: q.estimatedDurationMinutes,
    message: q.message,
    validUntil: q.validUntil.toISOString(),
    isExpired: q.status === QuoteStatus.SUBMITTED && q.validUntil.getTime() <= now.getTime(),
    createdAt: q.createdAt.toISOString(),
  };
}

const toMethod = (m: string | null): 'ONLINE' | 'CASH' | null => (m === 'ONLINE' || m === 'CASH' ? m : null);

const photoDto = (p: { id: string; status: BookingPhotoDto['status']; fileName: string; mimeType: string; sizeBytes: number; scanStatus: BookingPhotoDto['scanStatus'] }): BookingPhotoDto => ({
  id: p.id,
  status: p.status,
  scanStatus: p.scanStatus,
  fileName: p.fileName,
  mimeType: p.mimeType,
  sizeBytes: p.sizeBytes,
});

function eventDto(e: DetailRow['events'][number]): BookingEventDto {
  return {
    type: e.type,
    fromStatus: e.fromStatus,
    toStatus: e.toStatus,
    actorRole: e.actorRole,
    amountHalalas: e.amountHalalas,
    note: e.note,
    createdAt: e.createdAt.toISOString(),
  };
}

const serviceDto = (s: SummaryRow['service']) => ({ id: s.id, slug: s.slug, nameEn: s.nameEn, nameAr: s.nameAr });

function statusFilter(statuses: BookingStatus[] | undefined) {
  return statuses && statuses.length > 0 ? { status: { in: statuses } } : {};
}

function createdRange(q: { createdFrom?: string; createdTo?: string }) {
  if (!q.createdFrom && !q.createdTo) return {};
  return { createdAt: { ...(q.createdFrom ? { gte: new Date(q.createdFrom) } : {}), ...(q.createdTo ? { lt: new Date(q.createdTo) } : {}) } };
}

function bookingOrder(sort: ListBookingsQueryDto['sort']): Prisma.BookingOrderByWithRelationInput[] {
  if (sort === 'oldest') return [{ createdAt: 'asc' }, { id: 'asc' }];
  if (sort === 'soonest') return [{ preferredStartAt: 'asc' }, { id: 'asc' }];
  return [{ createdAt: 'desc' }, { id: 'desc' }];
}

/** Read models for customers, workers and administrators. Every query is scoped to its caller. */
@Injectable()
export class BookingsQueryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly quotes: QuotesService,
  ) {}

  // ===================================================================== customer

  async listMine(customerId: string, q: ListBookingsQueryDto): Promise<Page<BookingSummaryDto>> {
    const where: Prisma.BookingWhereInput = {
      customerId,
      ...statusFilter(q.status),
      ...(q.serviceId ? { serviceId: q.serviceId } : {}),
      ...(q.cityId ? { cityId: q.cityId } : {}),
      ...createdRange(q),
    };
    return this.summaries(where, q);
  }

  async detailForCustomer(customerId: string, id: string): Promise<BookingDetailDto> {
    const booking = await this.prisma.booking.findFirst({ where: { id, customerId }, include: DETAIL_INCLUDE });
    if (!booking) throw notFound('Booking'); // someone else's booking looks exactly like a missing one
    return this.toDetail(booking, true);
  }

  /** Quote comparison: price, availability, message and a public worker summary per quote. */
  async quotesForCustomer(customerId: string, bookingId: string, q: ListQuotesQueryDto): Promise<Page<QuoteForCustomerDto>> {
    const booking = await this.prisma.booking.findFirst({ where: { id: bookingId, customerId }, select: { id: true, serviceId: true } });
    if (!booking) throw notFound('Booking');
    const now = new Date();

    const where: Prisma.QuoteWhereInput = {
      bookingId,
      ...(q.status && q.status.length > 0
        ? { status: { in: q.status } }
        : { status: QuoteStatus.SUBMITTED, validUntil: { gt: now } }),
    };
    const orderBy: Prisma.QuoteOrderByWithRelationInput[] =
      q.sort === 'price_desc'
        ? [{ priceHalalas: 'desc' }, { id: 'asc' }]
        : q.sort === 'soonest'
          ? [{ proposedStartAt: 'asc' }, { priceHalalas: 'asc' }, { id: 'asc' }]
          : q.sort === 'newest'
            ? [{ createdAt: 'desc' }, { id: 'asc' }]
            : [{ priceHalalas: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }];

    const [rows, total] = await Promise.all([
      this.prisma.quote.findMany({
        where,
        orderBy,
        skip: q.skip,
        take: q.limit,
        include: { worker: { include: { user: { select: { fullName: true, fullNameAr: true } }, services: { select: { serviceId: true, yearsOfExperience: true } } } } },
      }),
      this.prisma.quote.count({ where }),
    ]);

    const completed = await this.completedJobs(rows.map((r) => r.workerProfileId));
    const items = rows.map<QuoteForCustomerDto>((r) => {
      const summary: WorkerPublicSummaryDto = {
        workerId: r.worker.id,
        fullName: r.worker.user.fullName,
        fullNameAr: r.worker.user.fullNameAr,
        bio: r.worker.bio,
        yearsOfExperience: r.worker.yearsOfExperience,
        serviceYearsOfExperience: r.worker.services.find((s) => s.serviceId === booking.serviceId)?.yearsOfExperience ?? null,
        ratingAverage: null,
        ratingCount: 0,
        completedJobs: completed.get(r.workerProfileId) ?? 0,
      };
      return {
        id: r.id,
        bookingId: r.bookingId,
        status: r.status,
        version: r.version,
        money: quoteCustomerMoney(r), // never includes the platform commission
        proposedStartAt: r.proposedStartAt.toISOString(),
        proposedEndAt: r.proposedEndAt.toISOString(),
        estimatedDurationMinutes: r.estimatedDurationMinutes,
        message: r.message,
        validUntil: r.validUntil.toISOString(),
        isExpired: r.status === QuoteStatus.SUBMITTED && r.validUntil.getTime() <= now.getTime(),
        worker: summary,
        createdAt: r.createdAt.toISOString(),
      };
    });
    return toPage(items, total, q);
  }

  // ======================================================================== worker

  /**
   * OPEN requests this worker can quote on: right service, right city, not expired, the worker is online, and the requested start falls
   * inside the weekly hours they set (no hours set = no filter).
   */
  async requests(workerUserId: string, q: ListRequestsQueryDto): Promise<Page<WorkerRequestSummaryDto>> {
    const worker = await this.quotes.workerContext(workerUserId);
    if (!worker.isOnline) return toPage([], 0, q);
    const now = new Date();
    const serviceIds = [...worker.serviceIds.keys()].filter((id) => !q.serviceId || id === q.serviceId);
    const cityIds = [...worker.cityIds].filter((id) => !q.cityId || id === q.cityId);

    const where: Prisma.BookingWhereInput = {
      status: BookingStatus.OPEN,
      expiresAt: { gt: now },
      serviceId: { in: serviceIds },
      cityId: { in: cityIds },
      ...(q.urgentOnly ? { isUrgent: true } : {}),
      ...(q.startFrom || q.startTo
        ? { preferredStartAt: { ...(q.startFrom ? { gte: new Date(q.startFrom) } : {}), ...(q.startTo ? { lt: new Date(q.startTo) } : {}) } }
        : {}),
    };
    const include = { service: SERVICE_SELECT, city: CITY_SELECT, quotes: { where: { workerProfileId: worker.id }, include: { booking: { select: { reference: true } } } } };
    const orderBy: Prisma.BookingOrderByWithRelationInput[] = q.sort === 'soonest' ? [{ preferredStartAt: 'asc' }, { id: 'asc' }] : [{ createdAt: 'desc' }, { id: 'desc' }];

    if (worker.hours.length === 0) {
      const [rows, total] = await Promise.all([this.prisma.booking.findMany({ where, orderBy, skip: q.skip, take: q.limit, include }), this.prisma.booking.count({ where })]);
      return toPage(rows.map((r) => this.toRequestSummary(r, now)), total, q);
    }
    // The hours are weekly windows in Saudi time, so they are applied here rather than in SQL. The pool is bounded by city, service and
    // expiry, and a worker looks at the newest few hundred at most.
    const pool = await this.prisma.booking.findMany({ where, orderBy, take: 500, include });
    const inHours = pool.filter((r) => coversInstant(worker.hours, r.preferredStartAt));
    return toPage(inHours.slice(q.skip, q.skip + q.limit).map((r) => this.toRequestSummary(r, now)), inHours.length, q);
  }

  async requestDetail(workerUserId: string, bookingId: string): Promise<WorkerRequestDetailDto> {
    const worker = await this.quotes.workerContext(workerUserId);
    const now = new Date();
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      include: {
        service: SERVICE_SELECT,
        city: CITY_SELECT,
        photos: { orderBy: { createdAt: 'asc' } },
        quotes: { where: { workerProfileId: worker.id }, include: { booking: { select: { reference: true } } } },
      },
    });
    // Not eligible = not found. A worker who already quoted keeps access to that request.
    if (!booking || !(this.quotes.isEligible(worker, booking) && (booking.status === BookingStatus.OPEN || booking.quotes.length > 0))) {
      throw notFound('Request');
    }
    return {
      ...this.toRequestSummary(booking, now),
      problemDescription: booking.problemDescription,
      photos: booking.photos.filter((p) => p.status === 'UPLOADED').map(photoDto),
    };
  }

  async myQuote(workerUserId: string, quoteId: string): Promise<QuoteForWorkerDto> {
    const worker = await this.quotes.workerContext(workerUserId);
    const quote = await this.prisma.quote.findFirst({ where: { id: quoteId, workerProfileId: worker.id }, include: { booking: { select: { reference: true } } } });
    if (!quote) throw notFound('Quote');
    return toQuoteForWorker(quote);
  }

  async myQuotes(workerUserId: string, q: ListMyQuotesQueryDto): Promise<Page<QuoteForWorkerDto>> {
    const worker = await this.quotes.workerContext(workerUserId);
    const where: Prisma.QuoteWhereInput = { workerProfileId: worker.id, ...(q.status && q.status.length > 0 ? { status: { in: q.status } } : {}) };
    const [rows, total] = await Promise.all([
      this.prisma.quote.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: q.skip, take: q.limit, include: { booking: { select: { reference: true } } } }),
      this.prisma.quote.count({ where }),
    ]);
    const now = new Date();
    return toPage(rows.map((r) => toQuoteForWorker(r, now)), total, q);
  }

  /** Bookings assigned to this worker (accepted quote, any later status). */
  async myBookings(workerUserId: string, q: ListBookingsQueryDto): Promise<Page<WorkerBookingDto>> {
    const worker = await this.quotes.workerContext(workerUserId);
    const where: Prisma.BookingWhereInput = {
      workerProfileId: worker.id,
      ...statusFilter(q.status),
      ...(q.serviceId ? { serviceId: q.serviceId } : {}),
      ...(q.cityId ? { cityId: q.cityId } : {}),
      ...createdRange(q),
    };
    const include = this.workerBookingInclude();
    const [rows, total] = await Promise.all([
      this.prisma.booking.findMany({ where, include, orderBy: bookingOrder(q.sort), skip: q.skip, take: q.limit }),
      this.prisma.booking.count({ where }),
    ]);
    return toPage(rows.map((r) => this.toWorkerBooking(r)), total, q);
  }

  async myBookingDetail(workerUserId: string, bookingId: string): Promise<WorkerBookingDto> {
    const worker = await this.quotes.workerContext(workerUserId);
    const booking = await this.prisma.booking.findFirst({ where: { id: bookingId, workerProfileId: worker.id }, include: this.workerBookingInclude() });
    if (!booking) throw notFound('Booking');
    return this.toWorkerBooking(booking);
  }

  // ======================================================================== admin

  async adminList(q: AdminListBookingsQueryDto) {
    const where: Prisma.BookingWhereInput = {
      ...statusFilter(q.status),
      ...(q.serviceId ? { serviceId: q.serviceId } : {}),
      ...(q.cityId ? { cityId: q.cityId } : {}),
      ...(q.customerId ? { customerId: q.customerId } : {}),
      ...(q.workerId ? { workerProfileId: q.workerId } : {}),
      ...(q.reference ? { reference: { startsWith: q.reference } } : {}),
      ...(q.paymentMethod === 'CASH' ? { paymentMethod: 'CASH' } : {}),
      // Only cash is stored on the booking; a confirmed booking that is not cash was paid online.
      ...(q.paymentMethod === 'ONLINE' ? { confirmedAt: { not: null }, OR: [{ paymentMethod: null }, { paymentMethod: { not: 'CASH' } }] } : {}),
      ...(q.q
        ? {
            OR: [
              { reference: { startsWith: q.q.toUpperCase() } },
              { service: { OR: [{ nameEn: { contains: q.q, mode: 'insensitive' } }, { nameAr: { contains: q.q } }] } },
              { customer: { OR: [{ fullName: { contains: q.q, mode: 'insensitive' } }, { phone: { contains: q.q } }] } },
              { worker: { user: { OR: [{ fullName: { contains: q.q, mode: 'insensitive' } }, { fullNameAr: { contains: q.q } }] } } },
            ],
          }
        : {}),
      ...createdRange(q),
    };
    const page = await this.summaries(where, q);
    // Administrators see who is on each booking, where it is and how it is paid (the summary alone only has ids).
    const rows = await this.prisma.booking.findMany({
      where: { id: { in: page.items.map((i) => i.id) } },
      select: {
        id: true, customerId: true, workerProfileId: true, paymentMethod: true, confirmedAt: true, cashCollectedAt: true, status: true, totalAmountHalalas: true, serviceAmountHalalas: true, vatAmountHalalas: true,
        customer: { select: { fullName: true } },
        worker: { select: { user: { select: { fullName: true, fullNameAr: true } } } },
        city: { select: { nameEn: true, nameAr: true } },
      },
    });
    const byId = new Map(rows.map((r) => [r.id, r]));
    return {
      ...page,
      items: page.items.map((item) => {
        const r = byId.get(item.id);
        return {
          ...item,
          customerId: r?.customerId ?? null,
          customerName: r?.customer.fullName ?? null,
          workerId: r?.workerProfileId ?? null,
          workerName: r?.worker?.user.fullName ?? null,
          workerNameAr: r?.worker?.user.fullNameAr ?? null,
          cityNameEn: r?.city.nameEn ?? null,
          cityNameAr: r?.city.nameAr ?? null,
          paymentMethod: r?.paymentMethod === 'CASH' ? 'CASH' : r?.confirmedAt ? 'ONLINE' : null,
          cashCollected: r?.cashCollectedAt != null,
        };
      }),
    };
  }

  async adminDetail(id: string): Promise<AdminBookingDetailDto> {
    const booking = await this.prisma.booking.findUnique({
      where: { id },
      include: { ...DETAIL_INCLUDE, customer: { select: { id: true, phone: true } }, quotes: { orderBy: { createdAt: 'asc' }, include: { booking: { select: { reference: true } } } } },
    });
    if (!booking) throw notFound('Booking');
    const now = new Date();
    return {
      ...this.toDetail(booking, true, true),
      customerId: booking.customer.id,
      customerPhone: booking.customer.phone,
      workerId: booking.workerProfileId,
      fullMoney: bookingWorkerMoney(booking),
      quotes: booking.quotes.map((qt) => toQuoteForWorker(qt, now)),
    };
  }

  // ===================================================================== helpers

  private async summaries(where: Prisma.BookingWhereInput, q: ListBookingsQueryDto): Promise<Page<BookingSummaryDto>> {
    const now = new Date();
    const [rows, total] = await Promise.all([
      this.prisma.booking.findMany({
        where,
        include: { ...SUMMARY_INCLUDE, _count: { select: { quotes: { where: { status: QuoteStatus.SUBMITTED, validUntil: { gt: now } } } } } },
        orderBy: bookingOrder(q.sort),
        skip: q.skip,
        take: q.limit,
      }),
      this.prisma.booking.count({ where }),
    ]);
    return toPage(rows.map((r) => this.toSummary(r, r._count.quotes)), total, q);
  }

  private toSummary(b: SummaryRow, quoteCount: number): BookingSummaryDto {
    return {
      id: b.id,
      reference: b.reference,
      status: b.status,
      service: serviceDto(b.service),
      cityId: b.cityId,
      isUrgent: b.isUrgent,
      preferredStartAt: b.preferredStartAt.toISOString(),
      preferredEndAt: b.preferredEndAt.toISOString(),
      expiresAt: b.expiresAt.toISOString(),
      quoteCount,
      money: bookingCustomerMoney(b),
      createdAt: b.createdAt.toISOString(),
    };
  }

  /** Full booking for its owner (or an administrator). The customer's own address is always visible to them. */
  private toDetail(b: DetailRow, ownerView: boolean, adminView = false): BookingDetailDto {
    const paid = PAID.includes(b.status);
    const location: BookingLocationDto = {
      cityId: b.city.id,
      cityNameEn: b.city.nameEn,
      cityNameAr: b.city.nameAr,
      district: b.district,
      ...(ownerView ? { addressLine: b.addressLine, building: b.building, locationNotes: b.locationNotes, latitude: b.latitude, longitude: b.longitude } : {}),
    };
    return {
      ...this.toSummary(b, 0),
      problemDescription: b.problemDescription,
      location,
      worker: b.worker
        ? {
            workerId: b.worker.id,
            fullName: b.worker.user.fullName,
            fullNameAr: b.worker.user.fullNameAr,
            ...(paid || adminView ? { phone: b.worker.user.phone } : {}),
          }
        : null,
      acceptedQuoteId: b.acceptedQuoteId,
      paymentDueAt: b.paymentDueAt?.toISOString() ?? null,
      paymentMethod: toMethod(b.paymentMethod),
      photos: b.photos.map(photoDto),
      timeline: b.events.map(eventDto),
      cancelledAt: b.cancelledAt?.toISOString() ?? null,
      cancellationReason: b.cancellation?.reason ?? null,
    };
  }

  private toRequestSummary(
    b: SummaryRow & { city: { id: string; nameEn: string; nameAr: string }; district: string | null; quotes: (QuoteRow & { booking: { reference: string } })[] },
    now: Date,
  ): WorkerRequestSummaryDto {
    return {
      id: b.id,
      reference: b.reference,
      status: b.status,
      service: serviceDto(b.service),
      // Before payment a worker learns only the city and district, never the street or coordinates.
      location: { cityId: b.city.id, cityNameEn: b.city.nameEn, cityNameAr: b.city.nameAr, district: b.district },
      isUrgent: b.isUrgent,
      preferredStartAt: b.preferredStartAt.toISOString(),
      preferredEndAt: b.preferredEndAt.toISOString(),
      expiresAt: b.expiresAt.toISOString(),
      myQuote: b.quotes[0] ? toQuoteForWorker(b.quotes[0], now) : null,
      createdAt: b.createdAt.toISOString(),
    };
  }

  private workerBookingInclude() {
    return {
      service: SERVICE_SELECT,
      city: CITY_SELECT,
      photos: { orderBy: { createdAt: 'asc' as const } },
      customer: { select: { fullName: true, phone: true } },
      quotes: { include: { booking: { select: { reference: true } } } },
    } satisfies Prisma.BookingInclude;
  }

  private toWorkerBooking(
    b: SummaryRow & {
      city: { id: string; nameEn: string; nameAr: string };
      photos: { id: string; status: BookingPhotoDto['status']; fileName: string; mimeType: string; sizeBytes: number; scanStatus: BookingPhotoDto['scanStatus'] }[];
      customer: { fullName: string | null; phone: string | null };
      quotes: (QuoteRow & { booking: { reference: string } })[];
    },
  ): WorkerBookingDto {
    const now = new Date();
    const paid = PAID.includes(b.status);
    const mine = b.quotes.find((q) => q.id === b.acceptedQuoteId) ?? null;
    const base = this.toRequestSummary({ ...b, quotes: mine ? [mine] : [] }, now);
    return {
      ...base,
      // Full address and customer contact are released only once the customer has paid.
      location: paid
        ? { ...base.location, addressLine: b.addressLine, building: b.building, locationNotes: b.locationNotes, latitude: b.latitude, longitude: b.longitude }
        : base.location,
      problemDescription: b.problemDescription,
      money: bookingWorkerMoney(b),
      photos: b.photos.filter((p) => p.status === 'UPLOADED').map(photoDto),
      ...(paid ? { customerName: b.customer.fullName, customerPhone: b.customer.phone } : {}),
      paymentMethod: toMethod(b.paymentMethod),
      cashCollectedAt: b.cashCollectedAt?.toISOString() ?? null,
      startedAt: b.startedAt?.toISOString() ?? null,
      completedAt: b.completedAt?.toISOString() ?? null,
    };
  }

  private async completedJobs(workerIds: string[]): Promise<Map<string, number>> {
    if (workerIds.length === 0) return new Map();
    const rows = await this.prisma.booking.groupBy({
      by: ['workerProfileId'],
      where: { workerProfileId: { in: workerIds }, status: BookingStatus.COMPLETED },
      _count: { _all: true },
    });
    return new Map(rows.map((r) => [r.workerProfileId as string, r._count._all]));
  }
}

export type { WorkerContext };
