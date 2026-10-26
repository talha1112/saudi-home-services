import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { type Page, toPage } from '../../common/pagination/pagination.js';
import { APP_CONFIG, type AppConfig, type PaymentsConfig } from '../../config/app.config.js';
import { PrismaService } from '../../database/prisma.service.js';
import { type Prisma, PaymentStatus, RefundStatus, WebhookEventStatus } from '../../generated/prisma/client.js';
import { notFound } from '../bookings/booking-support.js';
import type { AdminListLedgerQueryDto, AdminListPaymentsQueryDto, AdminListRefundsQueryDto, AdminListWebhookEventsQueryDto } from './dto/payments.dto.js';
import type {
  AdminPaymentDetailDto,
  AdminPaymentDto,
  LedgerEntryDto,
  PaymentBookingSummaryDto,
  ReconciliationReportDto,
  RefundDto,
  WebhookEventDto,
} from './dto/admin-payments.dto.js';
import { OUTCOME } from './payment-events.service.js';

/** The payment-deadline action is intentionally report-only until the business decides what an unpaid booking becomes. */
export const PAYMENT_DEADLINE_ACTION = 'REPORT_ONLY';

type AttemptWithBooking = Prisma.PaymentAttemptGetPayload<{ include: { booking: { select: { reference: true } } } }>;

export const toAdminPayment = (a: AttemptWithBooking): AdminPaymentDto => ({
  id: a.id,
  bookingId: a.bookingId,
  bookingReference: a.booking.reference,
  customerId: a.customerId,
  attemptNumber: a.attemptNumber,
  provider: a.provider,
  providerPaymentId: a.providerPaymentId,
  status: a.status,
  amountHalalas: a.amountHalalas,
  currency: a.currency,
  simulated: a.isSimulated,
  capturedAmountHalalas: a.capturedAmountHalalas,
  capturedCurrency: a.capturedCurrency,
  refundReservedHalalas: a.refundReservedHalalas,
  failureCode: a.failureCode,
  failureMessage: a.failureMessage,
  reconciliationReason: a.reconciliationReason,
  needsReconciliation: a.status === PaymentStatus.CAPTURED_UNAPPLIED,
  createdAt: a.createdAt.toISOString(),
  processingAt: a.processingAt?.toISOString() ?? null,
  settledAt: a.settledAt?.toISOString() ?? null,
});

export const toWebhookDto = (e: Prisma.PaymentWebhookEventGetPayload<object>): WebhookEventDto => ({
  id: e.id,
  provider: e.provider,
  accountScope: e.accountScope,
  providerEventId: e.providerEventId,
  eventType: e.eventType,
  providerPaymentId: e.providerPaymentId,
  paymentId: e.paymentAttemptId,
  status: e.status,
  outcome: e.outcome,
  attempts: e.attempts,
  amountHalalas: e.amountHalalas,
  currency: e.currency,
  occurredAt: e.occurredAt?.toISOString() ?? null,
  simulated: e.isSimulated,
  lastError: e.lastError,
  receivedAt: e.receivedAt.toISOString(),
  processedAt: e.processedAt?.toISOString() ?? null,
});

export const toRefundDto = (r: Prisma.PaymentRefundGetPayload<object>): RefundDto => ({
  id: r.id,
  paymentId: r.paymentId,
  bookingId: r.bookingId,
  amountHalalas: r.amountHalalas,
  currency: r.currency,
  reason: r.reason,
  status: r.status,
  moneyReturned: r.status === RefundStatus.SUCCEEDED,
  requestedById: r.requestedById,
  providerRefundId: r.providerRefundId,
  failureCode: r.failureCode,
  createdAt: r.createdAt.toISOString(),
  completedAt: r.completedAt?.toISOString() ?? null,
});

export const toLedgerDto = (l: Prisma.LedgerEntryGetPayload<object>): LedgerEntryDto => ({
  id: l.id,
  entryType: l.entryType,
  amountHalalas: l.amountHalalas,
  currency: l.currency,
  bookingId: l.bookingId,
  paymentId: l.paymentId,
  refundId: l.refundId,
  reversesEntryId: l.reversesEntryId,
  idempotencyKey: l.idempotencyKey,
  sourceType: l.sourceType,
  sourceId: l.sourceId,
  description: l.description,
  simulated: l.isSimulated,
  postedAt: l.postedAt.toISOString(),
});

const bookingSummary = (b: { id: string; reference: string; status: PaymentBookingSummaryDto['status']; totalAmountHalalas: number | null; currency: string; paymentDueAt: Date | null; confirmedAt: Date | null }): PaymentBookingSummaryDto => ({
  id: b.id,
  reference: b.reference,
  status: b.status,
  totalAmountHalalas: b.totalAmountHalalas,
  currency: b.currency,
  paymentDueAt: b.paymentDueAt?.toISOString() ?? null,
  confirmedAt: b.confirmedAt?.toISOString() ?? null,
});

const BOOKING_SELECT = { select: { reference: true } } as const;

/** Read-only operational views for administrators. Nothing here can change a payment's outcome. */
@Injectable()
export class PaymentsAdminService {
  private readonly cfg: PaymentsConfig;

  constructor(
    config: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    this.cfg = config.getOrThrow<AppConfig>(APP_CONFIG).payments;
  }

  async listPayments(q: AdminListPaymentsQueryDto): Promise<Page<AdminPaymentDto>> {
    const where: Prisma.PaymentAttemptWhereInput = {
      ...(q.bookingId ? { bookingId: q.bookingId } : {}),
      ...(q.customerId ? { customerId: q.customerId } : {}),
      ...(q.provider ? { provider: q.provider } : {}),
      ...(q.simulated === undefined ? {} : { isSimulated: q.simulated }),
      ...(q.needsReconciliation ? { status: PaymentStatus.CAPTURED_UNAPPLIED } : q.status && q.status.length > 0 ? { status: { in: q.status } } : {}),
      ...(q.createdFrom || q.createdTo ? { createdAt: { ...(q.createdFrom ? { gte: q.createdFrom } : {}), ...(q.createdTo ? { lt: q.createdTo } : {}) } } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.paymentAttempt.findMany({ where, include: { booking: BOOKING_SELECT }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: q.skip, take: q.limit }),
      this.prisma.paymentAttempt.count({ where }),
    ]);
    return toPage(rows.map(toAdminPayment), total, q);
  }

  async paymentDetail(id: string): Promise<AdminPaymentDetailDto> {
    const a = await this.prisma.paymentAttempt.findUnique({
      where: { id },
      include: {
        booking: { select: { id: true, reference: true, status: true, totalAmountHalalas: true, currency: true, paymentDueAt: true, confirmedAt: true, events: { orderBy: { createdAt: 'asc' } } } },
        webhookEvents: { orderBy: { receivedAt: 'asc' } },
        refunds: { orderBy: { createdAt: 'asc' } },
        ledgerEntries: { orderBy: { postedAt: 'asc' } },
      },
    });
    if (!a) throw notFound('Payment');
    return {
      ...toAdminPayment(a),
      booking: bookingSummary(a.booking),
      bookingTimeline: a.booking.events.map((e) => ({ type: e.type, fromStatus: e.fromStatus, toStatus: e.toStatus, note: e.note, createdAt: e.createdAt.toISOString() })),
      webhookEvents: a.webhookEvents.map(toWebhookDto),
      refunds: a.refunds.map(toRefundDto),
      ledger: a.ledgerEntries.map(toLedgerDto),
    };
  }

  async listWebhookEvents(q: AdminListWebhookEventsQueryDto): Promise<Page<WebhookEventDto>> {
    const where: Prisma.PaymentWebhookEventWhereInput = {
      ...(q.status && q.status.length > 0 ? { status: { in: q.status } } : {}),
      ...(q.provider ? { provider: q.provider } : {}),
      ...(q.paymentId ? { paymentAttemptId: q.paymentId } : {}),
      ...(q.providerEventId ? { providerEventId: q.providerEventId } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.paymentWebhookEvent.findMany({ where, orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }], skip: q.skip, take: q.limit }),
      this.prisma.paymentWebhookEvent.count({ where }),
    ]);
    return toPage(rows.map(toWebhookDto), total, q);
  }

  async getWebhookEvent(id: string): Promise<WebhookEventDto> {
    const row = await this.prisma.paymentWebhookEvent.findUnique({ where: { id } });
    if (!row) throw notFound('Webhook event');
    return toWebhookDto(row);
  }

  async listRefunds(q: AdminListRefundsQueryDto): Promise<Page<RefundDto>> {
    const where: Prisma.PaymentRefundWhereInput = {
      ...(q.status && q.status.length > 0 ? { status: { in: q.status } } : {}),
      ...(q.paymentId ? { paymentId: q.paymentId } : {}),
      ...(q.bookingId ? { bookingId: q.bookingId } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.paymentRefund.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: q.skip, take: q.limit }),
      this.prisma.paymentRefund.count({ where }),
    ]);
    return toPage(rows.map(toRefundDto), total, q);
  }

  async getRefund(id: string): Promise<RefundDto> {
    const row = await this.prisma.paymentRefund.findUnique({ where: { id } });
    if (!row) throw notFound('Refund');
    return toRefundDto(row);
  }

  async listLedger(q: AdminListLedgerQueryDto): Promise<Page<LedgerEntryDto>> {
    const where: Prisma.LedgerEntryWhereInput = {
      ...(q.bookingId ? { bookingId: q.bookingId } : {}),
      ...(q.paymentId ? { paymentId: q.paymentId } : {}),
      ...(q.refundId ? { refundId: q.refundId } : {}),
      ...(q.entryType ? { entryType: q.entryType } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.ledgerEntry.findMany({ where, orderBy: [{ postedAt: 'desc' }, { id: 'desc' }], skip: q.skip, take: q.limit }),
      this.prisma.ledgerEntry.count({ where }),
    ]);
    return toPage(rows.map(toLedgerDto), total, q);
  }

  // ---------------------------------------------------------------- reconciliation

  /** Candidate selection shared by the report and the scheduled sweep. Read-only. */
  async findOverduePendingBookings(now: Date, limit: number) {
    return this.prisma.booking.findMany({
      where: { status: 'PAYMENT_PENDING', confirmedAt: null, paymentDueAt: { lte: now } },
      select: { id: true, reference: true, status: true, totalAmountHalalas: true, currency: true, paymentDueAt: true, confirmedAt: true },
      orderBy: { paymentDueAt: 'asc' },
      take: limit,
    });
  }

  async findStaleAttempts(now: Date, limit: number): Promise<AttemptWithBooking[]> {
    const cutoff = new Date(now.getTime() - this.cfg.staleAfterMinutes * 60_000);
    return this.prisma.paymentAttempt.findMany({
      where: {
        OR: [
          { status: PaymentStatus.PROCESSING, processingAt: { lte: cutoff } },
          { status: PaymentStatus.INITIATED, createdAt: { lte: cutoff } },
        ],
      },
      include: { booking: BOOKING_SELECT },
      orderBy: { createdAt: 'asc' },
      take: limit,
    });
  }

  async report(now: Date = new Date(), limit = 100): Promise<ReconciliationReportDto> {
    const [overdue, stale, unapplied, failed, orphans] = await Promise.all([
      this.findOverduePendingBookings(now, limit),
      this.findStaleAttempts(now, limit),
      this.prisma.paymentAttempt.findMany({ where: { status: PaymentStatus.CAPTURED_UNAPPLIED }, include: { booking: BOOKING_SELECT }, orderBy: { settledAt: 'asc' }, take: limit }),
      this.prisma.paymentWebhookEvent.findMany({ where: { status: WebhookEventStatus.FAILED }, orderBy: { receivedAt: 'asc' }, take: limit }),
      this.prisma.paymentWebhookEvent.findMany({ where: { status: WebhookEventStatus.IGNORED, outcome: OUTCOME.ORPHAN_UNKNOWN_PAYMENT }, orderBy: { receivedAt: 'asc' }, take: limit }),
    ]);
    return {
      generatedAt: now.toISOString(),
      deadlineAction: PAYMENT_DEADLINE_ACTION,
      overduePendingBookings: overdue.map(bookingSummary),
      staleAttempts: stale.map(toAdminPayment),
      capturedUnapplied: unapplied.map(toAdminPayment),
      failedWebhookEvents: failed.map(toWebhookDto),
      orphanWebhookEvents: orphans.map(toWebhookDto),
    };
  }
}
