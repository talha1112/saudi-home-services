import { randomInt } from 'node:crypto';
import { HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiError, badRequest, forbidden } from '../../common/errors/api-error.js';
import { APP_CONFIG, type AppConfig, type BookingsConfig } from '../../config/app.config.js';
import { PrismaService } from '../../database/prisma.service.js';
import {
  BookingEventType,
  BookingStatus,
  CancellationReason,
  QuoteStatus,
  Role,
  UserStatus,
  WorkerVerificationStatus,
} from '../../generated/prisma/client.js';
import { AuditService } from '../auth/audit.service.js';
import type { ClientMeta } from '../auth/auth.types.js';
import { type Actor, type BookingAction, allowedFrom, check } from './booking-state-machine.js';
import { StaleStateError, type Tx, conflict, isUniqueViolation, lockBooking, notFound, recordEvent } from './booking-support.js';
import type { AdminCancelBookingDto, CancelBookingDto, CreateBookingDto } from './dto/bookings.dto.js';

const REFERENCE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no I, L, O, 0, 1: easy to read out loud
const MAX_HORIZON_DAYS = 60;

function newReference(): string {
  let code = '';
  for (let i = 0; i < 8; i++) code += REFERENCE_ALPHABET[randomInt(REFERENCE_ALPHABET.length)];
  return `BK-${code}`;
}

/** What the payments layer knows about a successful payment; every field is checked against the booking. */
export interface PaymentConfirmation {
  /** Amount the gateway says it captured, in halalas. Must equal the booking's agreed total. */
  paidAmountHalalas?: number;
  /** ISO currency code the gateway used. Must equal the booking's currency. */
  currency?: string;
  /** Free-text reference for the timeline (never card data). */
  note?: string;
}

export interface Caller {
  userId: string;
  role: 'CUSTOMER' | 'WORKER' | 'ADMIN';
}

/**
 * The domain service for everything that changes a booking's status. Every change:
 *  - is allowed by the state machine table (booking-state-machine.ts);
 *  - is a compare-and-set UPDATE (`WHERE id = ? AND status = <expected>`), so two requests
 *    racing for the same booking cannot both win;
 *  - writes its BookingEvent in the SAME transaction.
 */
@Injectable()
export class BookingLifecycleService {
  private readonly cfg: BookingsConfig;

  constructor(
    config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {
    this.cfg = config.getOrThrow<AppConfig>(APP_CONFIG).bookings;
  }

  // ------------------------------------------------------------------ create

  async create(customerId: string, dto: CreateBookingDto): Promise<{ id: string; reference: string }> {
    const now = new Date();
    const start = new Date(dto.preferredStartAt);
    const end = new Date(dto.preferredEndAt);
    if (start.getTime() < now.getTime() + this.cfg.minLeadMinutes * 60_000) {
      throw badRequest('INVALID_SCHEDULE', `The preferred start must be at least ${this.cfg.minLeadMinutes} minutes from now`);
    }
    if (end.getTime() <= start.getTime()) throw badRequest('INVALID_SCHEDULE', 'The preferred end must be after the start');
    if (start.getTime() > now.getTime() + MAX_HORIZON_DAYS * 86_400_000) {
      throw badRequest('INVALID_SCHEDULE', `Bookings can be made at most ${MAX_HORIZON_DAYS} days ahead`);
    }

    const [service, city] = await Promise.all([
      this.prisma.service.findFirst({ where: { id: dto.serviceId, isActive: true, category: { isActive: true } }, select: { id: true } }),
      this.prisma.city.findFirst({ where: { id: dto.cityId, isActive: true }, select: { id: true } }),
    ]);
    if (!service) throw badRequest('INVALID_SERVICE', 'That service is not available');
    if (!city) throw badRequest('INVALID_CITY', 'We do not operate in that city yet');

    const expiresAt = new Date(now.getTime() + this.cfg.requestTtlHours * 3_600_000);

    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        return await this.prisma.$transaction(async (tx) => {
          const open = await tx.booking.count({ where: { customerId, status: BookingStatus.OPEN, expiresAt: { gt: now } } });
          if (open >= this.cfg.maxOpenPerCustomer) {
            throw conflict('BOOKING_LIMIT', `You can have at most ${this.cfg.maxOpenPerCustomer} open requests at a time`);
          }
          const booking = await tx.booking.create({
            data: {
              reference: newReference(),
              customerId,
              serviceId: dto.serviceId,
              cityId: dto.cityId,
              status: BookingStatus.OPEN,
              problemDescription: dto.problemDescription,
              isUrgent: dto.isUrgent ?? false,
              preferredStartAt: start,
              preferredEndAt: end,
              district: dto.district ?? null,
              addressLine: dto.addressLine,
              building: dto.building ?? null,
              locationNotes: dto.locationNotes ?? null,
              latitude: dto.latitude ?? null,
              longitude: dto.longitude ?? null,
              expiresAt,
            },
            select: { id: true, reference: true },
          });
          await recordEvent(tx, {
            bookingId: booking.id,
            type: BookingEventType.BOOKING_CREATED,
            toStatus: BookingStatus.OPEN,
            actorUserId: customerId,
            actorRole: Role.CUSTOMER,
          });
          return booking;
        });
      } catch (err) {
        if (isUniqueViolation(err)) continue; // the random reference collided: draw another
        throw err;
      }
    }
    throw new ApiError(HttpStatus.SERVICE_UNAVAILABLE, 'SERVICE_UNAVAILABLE', 'Could not create the booking, please try again');
  }

  // ------------------------------------------------------------------ cancel

  async cancelByCustomer(customerId: string, bookingId: string, dto: CancelBookingDto, meta: ClientMeta): Promise<void> {
    if (dto.reason === CancellationReason.OTHER && !(dto.note && dto.note.length >= 3)) {
      throw badRequest('NOTE_REQUIRED', 'Please tell us the reason when you choose "other"');
    }
    await this.cancel({ userId: customerId, role: 'CUSTOMER' }, bookingId, dto.reason, dto.note, meta);
  }

  async cancelByAdmin(adminId: string, bookingId: string, dto: AdminCancelBookingDto, meta: ClientMeta): Promise<void> {
    await this.cancel({ userId: adminId, role: 'ADMIN' }, bookingId, CancellationReason.ADMIN_ACTION, dto.note, meta);
  }

  private async cancel(caller: Caller, bookingId: string, reason: CancellationReason, note: string | undefined, meta: ClientMeta): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const previous = await this.prisma.$transaction(async (tx) => {
          await lockBooking(tx, bookingId);
          const booking = await tx.booking.findFirst({
            where: { id: bookingId, ...(caller.role === 'CUSTOMER' ? { customerId: caller.userId } : {}) },
            select: { id: true, status: true },
          });
          if (!booking) throw notFound('Booking');
          this.assertAllowed('cancel', caller.role, booking.status);

          const now = new Date();
          const moved = await tx.booking.updateMany({
            where: { id: booking.id, status: booking.status },
            data: { status: BookingStatus.CANCELLED, cancelledAt: now },
          });
          if (moved.count !== 1) throw new StaleStateError();

          await tx.bookingCancellation.create({
            data: {
              bookingId: booking.id,
              cancelledByUserId: caller.userId,
              cancelledByRole: caller.role as Role,
              reason,
              note: note ?? null,
              previousStatus: booking.status,
              cancelledAt: now,
            },
          });
          await this.rejectLiveQuotes(tx, booking.id, undefined, 'Booking cancelled');
          await recordEvent(tx, {
            bookingId: booking.id,
            type: BookingEventType.BOOKING_CANCELLED,
            fromStatus: booking.status,
            toStatus: BookingStatus.CANCELLED,
            actorUserId: caller.userId,
            actorRole: caller.role as Role,
            note: note ?? reason,
          });
          return booking.status;
        });
        if (caller.role === 'ADMIN') {
          await this.audit.record({
            action: 'booking.cancelled_by_admin',
            actorUserId: caller.userId,
            entityType: 'booking',
            entityId: bookingId,
            metadata: { previousStatus: previous },
            ipAddress: meta.ip,
            userAgent: meta.userAgent,
          });
        }
        return;
      } catch (err) {
        if (err instanceof StaleStateError) continue; // status moved under us: re-read and decide again
        throw err;
      }
    }
    throw conflict('BOOKING_BUSY', 'The booking is being changed by someone else, please try again');
  }

  // ------------------------------------------------------------ accept quote

  /**
   * The customer picks one quote. Several protections work together so that exactly one quote
   * can ever be accepted for a booking, whatever the timing:
   *  1. the quote is flipped SUBMITTED -> ACCEPTED only if it is still SUBMITTED, unexpired and
   *     at the version the customer saw;
   *  2. the booking is flipped OPEN -> PAYMENT_PENDING only if it is still OPEN with no accepted quote;
   *  3. a unique index on (booking_id, is_accepted) makes PostgreSQL refuse a second accepted quote;
   * all in one transaction, so a loser rolls back completely.
   */
  async acceptQuote(customerId: string, bookingId: string, quoteId: string, expectedVersion: number | undefined): Promise<void> {
    try {
      await this.prisma.$transaction(async (tx) => {
        await lockBooking(tx, bookingId);
        const now = new Date();
        const booking = await tx.booking.findFirst({ where: { id: bookingId, customerId }, select: { id: true, status: true, expiresAt: true } });
        if (!booking) throw notFound('Booking');
        this.assertAllowed('accept_quote', 'CUSTOMER', booking.status);
        if (booking.expiresAt.getTime() <= now.getTime()) throw conflict('BOOKING_EXPIRED', 'This request has expired');

        const quote = await tx.quote.findFirst({
          where: { id: quoteId, bookingId },
          include: { worker: { select: { id: true, verificationStatus: true, user: { select: { status: true } } } } },
        });
        if (!quote) throw notFound('Quote');
        if (quote.status !== QuoteStatus.SUBMITTED) {
          throw conflict('QUOTE_NOT_AVAILABLE', `This quote can no longer be accepted (${quote.status})`, { status: quote.status });
        }
        if (quote.validUntil.getTime() <= now.getTime()) throw conflict('QUOTE_EXPIRED', 'This quote has expired');
        if (expectedVersion !== undefined && expectedVersion !== quote.version) {
          throw conflict('QUOTE_CHANGED', 'The worker changed this quote. Review the new offer first', { currentVersion: quote.version });
        }
        if (quote.worker.verificationStatus !== WorkerVerificationStatus.APPROVED || quote.worker.user.status !== UserStatus.ACTIVE) {
          throw conflict('QUOTE_NOT_AVAILABLE', 'This worker is no longer available');
        }

        const quoteMoved = await tx.quote.updateMany({
          where: { id: quote.id, bookingId, status: QuoteStatus.SUBMITTED, version: quote.version, validUntil: { gt: now } },
          data: { status: QuoteStatus.ACCEPTED, isAccepted: true, acceptedAt: now },
        });
        if (quoteMoved.count !== 1) {
          // Someone changed the quote between our read and our update. Say what happened, not just "no".
          const latest = await tx.quote.findUnique({ where: { id: quote.id }, select: { status: true, version: true, validUntil: true } });
          if (latest && latest.status === QuoteStatus.SUBMITTED && latest.version !== quote.version) {
            throw conflict('QUOTE_CHANGED', 'The worker changed this quote. Review the new offer first', { currentVersion: latest.version });
          }
          if (latest && latest.status === QuoteStatus.SUBMITTED && latest.validUntil.getTime() <= now.getTime()) {
            throw conflict('QUOTE_EXPIRED', 'This quote has expired');
          }
          throw conflict('QUOTE_NOT_AVAILABLE', 'This quote can no longer be accepted', latest ? { status: latest.status } : undefined);
        }

        const bookingMoved = await tx.booking.updateMany({
          where: { id: bookingId, customerId, status: BookingStatus.OPEN, acceptedQuoteId: null },
          data: {
            status: BookingStatus.PAYMENT_PENDING,
            acceptedQuoteId: quote.id,
            workerProfileId: quote.workerProfileId,
            acceptedAt: now,
            paymentDueAt: new Date(now.getTime() + this.cfg_paymentWindowMs()),
            serviceAmountHalalas: quote.priceHalalas,
            vatAmountHalalas: quote.vatAmountHalalas,
            totalAmountHalalas: quote.totalAmountHalalas,
            commissionAmountHalalas: quote.commissionAmountHalalas,
            workerPayoutHalalas: quote.workerPayoutHalalas,
            vatRateBps: quote.vatRateBps,
            commissionRateBps: quote.commissionRateBps,
          },
        });
        if (bookingMoved.count !== 1) throw conflict('BOOKING_ALREADY_ACCEPTED', 'Another quote was accepted for this request');

        await recordEvent(tx, {
          bookingId,
          type: BookingEventType.QUOTE_ACCEPTED,
          fromStatus: BookingStatus.OPEN,
          toStatus: BookingStatus.PAYMENT_PENDING,
          quoteId: quote.id,
          actorUserId: customerId,
          actorRole: Role.CUSTOMER,
          amountHalalas: quote.priceHalalas,
        });
        await this.rejectLiveQuotes(tx, bookingId, quote.id, 'Another quote was chosen');
      });
    } catch (err) {
      // The unique index refused a second accepted quote: the other request won.
      if (isUniqueViolation(err)) throw conflict('BOOKING_ALREADY_ACCEPTED', 'Another quote was accepted for this request');
      throw err;
    }
  }

  /** The customer turns one quote down. The booking stays OPEN so the other quotes (and new ones) can still be chosen. */
  async rejectQuote(customerId: string, bookingId: string, quoteId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await lockBooking(tx, bookingId);
      const booking = await tx.booking.findFirst({ where: { id: bookingId, customerId }, select: { id: true, status: true } });
      if (!booking) throw notFound('Booking');
      if (booking.status !== BookingStatus.OPEN) throw conflict('INVALID_STATE', `This cannot be done while the booking is ${booking.status}`, { status: booking.status });
      const quote = await tx.quote.findFirst({ where: { id: quoteId, bookingId }, select: { id: true, status: true, priceHalalas: true } });
      if (!quote) throw notFound('Quote');
      if (quote.status !== QuoteStatus.SUBMITTED) throw conflict('QUOTE_NOT_AVAILABLE', `This quote can no longer be rejected (${quote.status})`, { status: quote.status });
      const moved = await tx.quote.updateMany({ where: { id: quote.id, status: QuoteStatus.SUBMITTED }, data: { status: QuoteStatus.REJECTED } });
      if (moved.count !== 1) throw conflict('QUOTE_NOT_AVAILABLE', 'This quote can no longer be rejected');
      await recordEvent(tx, {
        bookingId,
        type: BookingEventType.QUOTE_REJECTED,
        quoteId: quote.id,
        actorUserId: customerId,
        actorRole: Role.CUSTOMER,
        amountHalalas: quote.priceHalalas,
        note: 'Rejected by the customer',
      });
    });
  }

  /** The customer asks the worker to change a quote. Nothing about the quote changes until the worker edits it (which clears the request). */
  async requestQuoteChange(customerId: string, bookingId: string, quoteId: string, message: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await lockBooking(tx, bookingId);
      const booking = await tx.booking.findFirst({ where: { id: bookingId, customerId }, select: { id: true, status: true } });
      if (!booking) throw notFound('Booking');
      if (booking.status !== BookingStatus.OPEN) throw conflict('INVALID_STATE', `This cannot be done while the booking is ${booking.status}`, { status: booking.status });
      const quote = await tx.quote.findFirst({ where: { id: quoteId, bookingId }, select: { id: true, status: true, priceHalalas: true, validUntil: true } });
      if (!quote) throw notFound('Quote');
      if (quote.status !== QuoteStatus.SUBMITTED || quote.validUntil.getTime() <= Date.now()) {
        throw conflict('QUOTE_NOT_AVAILABLE', `This quote can no longer be changed (${quote.status})`, { status: quote.status });
      }
      await tx.quote.update({ where: { id: quote.id }, data: { changeRequest: message, changeRequestedAt: new Date() } });
      await recordEvent(tx, {
        bookingId,
        type: BookingEventType.QUOTE_CHANGE_REQUESTED,
        quoteId: quote.id,
        actorUserId: customerId,
        actorRole: Role.CUSTOMER,
        amountHalalas: quote.priceHalalas,
      });
    });
  }

  // ------------------------------------------------------- worker operations

  startWork(workerProfileId: string, workerUserId: string, bookingId: string): Promise<void> {
    return this.workerStep('start_work', workerProfileId, workerUserId, bookingId, { startedAt: new Date() });
  }

  completeWork(workerProfileId: string, workerUserId: string, bookingId: string): Promise<void> {
    return this.workerStep('complete_work', workerProfileId, workerUserId, bookingId, { completedAt: new Date() });
  }

  private async workerStep(
    action: 'start_work' | 'complete_work',
    workerProfileId: string,
    workerUserId: string,
    bookingId: string,
    data: { startedAt?: Date; completedAt?: Date },
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await lockBooking(tx, bookingId);
      // Only the assigned worker can even see the booking; anyone else gets 404.
      const booking = await tx.booking.findFirst({ where: { id: bookingId, workerProfileId }, select: { id: true, status: true } });
      if (!booking) throw notFound('Booking');
      this.assertAllowed(action, 'WORKER', booking.status);
      const moved = await tx.booking.updateMany({
        where: { id: booking.id, workerProfileId, status: booking.status },
        data: { status: this.targetOf(action), ...data },
      });
      if (moved.count !== 1) throw conflict('INVALID_STATE', 'The booking changed, please reload');
      await recordEvent(tx, {
        bookingId,
        type: action === 'start_work' ? BookingEventType.WORK_STARTED : BookingEventType.WORK_COMPLETED,
        fromStatus: booking.status,
        toStatus: this.targetOf(action),
        actorUserId: workerUserId,
        actorRole: Role.WORKER,
      });
    });
  }

  // ----------------------------------------------- system (payments, expiry)

  /**
   * Called by the payments phase once the customer's payment is confirmed. There is deliberately
   * NO HTTP endpoint for this: nobody can mark a booking as paid by calling the API.
   *
   * Outcomes the payments layer must handle (all HTTP 409 with a stable `code`):
   *  - BOOKING_ALREADY_PAID    a PAYMENT_CONFIRMED already exists: a duplicate event, nothing changed;
   *  - BOOKING_NOT_PAYABLE     the booking was cancelled/expired/never accepted: money arrived for a
   *                            booking that cannot take it, so the payments layer must refund;
   *  - PAYMENT_AMOUNT_MISMATCH / PAYMENT_CURRENCY_MISMATCH  the gateway amount differs from the
   *                            agreed snapshot: do not confirm, investigate.
   * Prefer {@link confirmPaymentInTransaction} so the payment record and the booking change commit together.
   */
  async confirmPayment(bookingId: string, options: PaymentConfirmation = {}): Promise<void> {
    await this.prisma.$transaction((tx) => this.confirmPaymentInTransaction(tx, bookingId, options));
  }

  /**
   * Same as {@link confirmPayment} but joins the caller's transaction. The payments layer writes
   * its own payment/ledger rows with the SAME `tx`, so either both the payment record and the
   * booking confirmation are saved, or neither is.
   */
  async confirmPaymentInTransaction(tx: Tx, bookingId: string, options: PaymentConfirmation = {}): Promise<void> {
    await lockBooking(tx, bookingId);
    const booking = await tx.booking.findUnique({
      where: { id: bookingId },
      select: { id: true, status: true, confirmedAt: true, totalAmountHalalas: true, currency: true },
    });
    if (!booking) throw notFound('Booking');

    // A booking that was ever confirmed has been paid once; a repeat is a duplicate, not a new payment.
    if (booking.confirmedAt !== null) throw conflict('BOOKING_ALREADY_PAID', 'This booking has already been paid', { status: booking.status });
    if (booking.status !== BookingStatus.PAYMENT_PENDING) {
      throw conflict('BOOKING_NOT_PAYABLE', `A booking that is ${booking.status} cannot be paid`, { status: booking.status });
    }
    if (options.paidAmountHalalas !== undefined && options.paidAmountHalalas !== booking.totalAmountHalalas) {
      throw conflict('PAYMENT_AMOUNT_MISMATCH', 'The paid amount does not match the agreed total', {
        expectedHalalas: booking.totalAmountHalalas,
        paidHalalas: options.paidAmountHalalas,
      });
    }
    if (options.currency !== undefined && options.currency !== booking.currency) {
      throw conflict('PAYMENT_CURRENCY_MISMATCH', 'The payment currency does not match the booking', {
        expected: booking.currency,
        received: options.currency,
      });
    }

    const moved = await tx.booking.updateMany({
      where: { id: bookingId, status: BookingStatus.PAYMENT_PENDING, confirmedAt: null },
      data: { status: BookingStatus.CONFIRMED, confirmedAt: new Date() },
    });
    if (moved.count !== 1) throw conflict('BOOKING_NOT_PAYABLE', 'The booking changed, please reload');
    await recordEvent(tx, {
      bookingId,
      type: BookingEventType.PAYMENT_CONFIRMED,
      fromStatus: BookingStatus.PAYMENT_PENDING,
      toStatus: BookingStatus.CONFIRMED,
      note: options.note ?? null,
    });
  }

  /**
   * The customer chooses to pay the worker in cash. The booking is confirmed (the worker then sees the address and phone and can start)
   * with `paymentMethod = CASH`; no money moves through the platform, no payment attempt and no ledger entry is written (how cash is
   * accounted, and the commission on it, is an open business decision). Repeating the call on a booking already confirmed as CASH
   * returns without changing anything.
   */
  async chooseCash(customerId: string, bookingId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await lockBooking(tx, bookingId);
      const booking = await tx.booking.findFirst({
        where: { id: bookingId, customerId },
        select: {
          id: true,
          status: true,
          confirmedAt: true,
          paymentDueAt: true,
          paymentMethod: true,
          totalAmountHalalas: true,
          worker: { select: { verificationStatus: true, user: { select: { status: true } } } },
        },
      });
      if (!booking) throw notFound('Booking'); // someone else's booking looks exactly like a missing one
      if (booking.paymentMethod === 'CASH' && booking.confirmedAt !== null) return; // repeat: already chosen
      if (booking.confirmedAt !== null) throw conflict('BOOKING_ALREADY_PAID', 'This booking has already been paid');
      if (booking.status !== BookingStatus.PAYMENT_PENDING || booking.totalAmountHalalas === null) {
        throw conflict('BOOKING_NOT_PAYABLE', `A booking that is ${booking.status} cannot be paid`, { status: booking.status });
      }
      if (booking.paymentDueAt && booking.paymentDueAt.getTime() <= Date.now()) {
        throw conflict('PAYMENT_DEADLINE_PASSED', 'The time to pay for this booking has passed');
      }
      if (!booking.worker || booking.worker.verificationStatus !== 'APPROVED' || booking.worker.user.status !== 'ACTIVE') {
        throw conflict('WORKER_UNAVAILABLE', 'The worker for this booking is no longer available');
      }
      // An online payment that may still turn into money must be settled first, or the customer could pay twice.
      const open = await tx.paymentAttempt.findFirst({ where: { bookingId, openSlot: true }, select: { id: true } });
      if (open) throw conflict('PAYMENT_IN_PROGRESS', 'An online payment for this booking is in progress', { paymentId: open.id });

      await this.confirmPaymentInTransaction(tx, bookingId, { note: 'Cash on delivery: the customer pays the worker in person' });
      await tx.booking.update({ where: { id: bookingId }, data: { paymentMethod: 'CASH' } });
    });
  }

  /** The worker confirms they received the cash (in progress or after the job). Only the assigned worker, only for CASH, and repeating it changes nothing. */
  async markCashCollected(workerProfileId: string, bookingId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await lockBooking(tx, bookingId);
      const booking = await tx.booking.findFirst({
        where: { id: bookingId, workerProfileId },
        select: { id: true, status: true, paymentMethod: true, cashCollectedAt: true },
      });
      if (!booking) throw notFound('Booking'); // another worker's booking looks exactly like a missing one
      if (booking.paymentMethod !== 'CASH') throw conflict('NOT_A_CASH_BOOKING', 'This booking is not paid in cash');
      if (booking.cashCollectedAt !== null) return;
      if (booking.status !== BookingStatus.IN_PROGRESS && booking.status !== BookingStatus.COMPLETED) {
        throw conflict('CASH_NOT_DUE_YET', `Cash can be confirmed once the work has started (the booking is ${booking.status})`, { status: booking.status });
      }
      await tx.booking.update({ where: { id: bookingId }, data: { cashCollectedAt: new Date() } });
    });
  }

  /** The assigned worker says they have reached the customer. Only a paid (CONFIRMED) booking; saying it again changes nothing. */
  async markArrived(workerProfileId: string, bookingId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await lockBooking(tx, bookingId);
      const booking = await tx.booking.findFirst({ where: { id: bookingId, workerProfileId }, select: { id: true, status: true, arrivedAt: true } });
      if (!booking) throw notFound('Booking'); // another worker's booking looks exactly like a missing one
      if (booking.arrivedAt !== null) return;
      if (booking.status !== BookingStatus.CONFIRMED) {
        throw conflict('INVALID_STATE', `Arrival can be reported on a paid booking that has not started (the booking is ${booking.status})`, { status: booking.status });
      }
      await tx.booking.update({ where: { id: bookingId }, data: { arrivedAt: new Date() } });
    });
  }

  /** Expires one OPEN booking whose time ran out. Returns false when it was not (or no longer) eligible. */
  async expireBooking(bookingId: string): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      await lockBooking(tx, bookingId);
      const now = new Date();
      const moved = await tx.booking.updateMany({
        where: { id: bookingId, status: BookingStatus.OPEN, expiresAt: { lte: now } },
        data: { status: BookingStatus.EXPIRED },
      });
      if (moved.count !== 1) return false;
      await this.rejectLiveQuotes(tx, bookingId, undefined, 'Request expired');
      await recordEvent(tx, {
        bookingId,
        type: BookingEventType.BOOKING_EXPIRED,
        fromStatus: BookingStatus.OPEN,
        toStatus: BookingStatus.EXPIRED,
      });
      return true;
    });
  }

  // ----------------------------------------------------------------- helpers

  /** Turns every still-SUBMITTED quote of a booking (except `keep`) into REJECTED, with events. */
  private async rejectLiveQuotes(tx: Tx, bookingId: string, keep: string | undefined, note: string): Promise<void> {
    const others = await tx.quote.findMany({
      where: { bookingId, status: QuoteStatus.SUBMITTED, ...(keep ? { id: { not: keep } } : {}) },
      select: { id: true, priceHalalas: true },
    });
    if (others.length === 0) return;
    await tx.quote.updateMany({
      where: { id: { in: others.map((q) => q.id) }, status: QuoteStatus.SUBMITTED },
      data: { status: QuoteStatus.REJECTED },
    });
    for (const q of others) {
      await recordEvent(tx, { bookingId, type: BookingEventType.QUOTE_REJECTED, quoteId: q.id, amountHalalas: q.priceHalalas, note });
    }
  }

  /** Throws the right HTTP error when the state machine forbids this action. */
  private assertAllowed(action: BookingAction, actor: Actor, from: BookingStatus): void {
    const verdict = check(action, actor, from);
    if (verdict === 'ok') return;
    if (verdict === 'wrong_actor') throw forbidden('FORBIDDEN_ACTION', 'You are not allowed to do that');
    throw conflict('INVALID_STATE', `This cannot be done while the booking is ${from}`, {
      status: from,
      allowedFrom: allowedFrom(action, actor),
    });
  }

  private targetOf(action: 'start_work' | 'complete_work'): BookingStatus {
    return action === 'start_work' ? BookingStatus.IN_PROGRESS : BookingStatus.COMPLETED;
  }

  private cfg_paymentWindowMs(): number {
    return this.cfg.paymentWindowMinutes * 60_000;
  }
}
