import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiError, badRequest, unavailable } from '../../common/errors/api-error.js';
import { type Page, toPage } from '../../common/pagination/pagination.js';
import { APP_CONFIG, type AppConfig, type PaymentsConfig } from '../../config/app.config.js';
import { PrismaService } from '../../database/prisma.service.js';
import { type Prisma, PaymentStatus, UserStatus, WorkerVerificationStatus } from '../../generated/prisma/client.js';
import { type Tx, conflict, lockBooking, notFound } from '../bookings/booking-support.js';
import type { InitiatePaymentDto, ListMyPaymentsQueryDto, PaymentAttemptDto } from './dto/payments.dto.js';
import { assertTransition, isCaptured, isOpen } from './payment-state.js';
import { lockPayment, sha256, toAttemptDto } from './payments-support.js';
import { PaymentProvider, ProviderRejectedError } from './provider/payment-provider.js';

/**
 * Customer-facing payment initiation.
 *
 * Which parts are transactional and which are an external side effect:
 *  1. TRANSACTION A (database only): lock the booking, verify ownership/state/deadline, reuse the
 *     idempotent attempt or create a new INITIATED one (unique constraints forbid a second open
 *     attempt and a reused key with another payload).
 *  2. EXTERNAL SIDE EFFECT (no transaction held): ask the provider for a checkout, passing our
 *     attempt's idempotency key, so asking twice yields the same checkout.
 *  3. TRANSACTION B (database only): move INITIATED -> PROCESSING and store the provider reference.
 *
 * If the process dies between 2 and 3 the attempt stays INITIATED. The customer repeating the same
 * Idempotency-Key reaches step 2 again, gets the SAME provider checkout and completes step 3, so no
 * second payment is ever created; unresolved INITIATED rows show up in the stale report.
 */
@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);
  private readonly cfg: PaymentsConfig;

  constructor(
    config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly provider: PaymentProvider,
  ) {
    this.cfg = config.getOrThrow<AppConfig>(APP_CONFIG).payments;
  }

  async initiate(customerId: string, bookingId: string, idempotencyKey: string, dto: InitiatePaymentDto): Promise<PaymentAttemptDto> {
    // Fail closed before anything is written: with no provider nothing can be paid.
    if (!this.provider.isAvailable) {
      throw unavailable('PAYMENT_PROVIDER_NOT_CONFIGURED', 'Online payment is temporarily unavailable');
    }
    const returnUrl = this.checkReturnUrl(dto.returnUrl);
    const fingerprint = sha256(JSON.stringify({ bookingId, returnUrl }));

    // ---- Transaction A
    const prepared = await this.prisma.$transaction(async (tx) => {
      await lockBooking(tx, bookingId);
      const now = new Date();

      const booking = await tx.booking.findFirst({
        where: { id: bookingId, customerId },
        select: {
          id: true,
          reference: true,
          status: true,
          confirmedAt: true,
          paymentDueAt: true,
          totalAmountHalalas: true,
          currency: true,
          worker: { select: { verificationStatus: true, user: { select: { status: true } } } },
        },
      });
      if (!booking) throw notFound('Booking'); // someone else's booking looks exactly like a missing one

      // Same key again: replay, or refuse when the payload differs.
      const existing = await tx.paymentAttempt.findUnique({ where: { customerId_idempotencyKey: { customerId, idempotencyKey } } });
      if (existing) {
        if (existing.requestFingerprint !== fingerprint) {
          throw conflict('IDEMPOTENCY_CONFLICT', 'This Idempotency-Key was already used for a different request');
        }
        return { attempt: existing, reference: booking.reference, replay: true };
      }

      if (booking.confirmedAt !== null) throw conflict('BOOKING_ALREADY_PAID', 'This booking has already been paid');
      if (booking.status !== 'PAYMENT_PENDING' || booking.totalAmountHalalas === null) {
        throw conflict('BOOKING_NOT_PAYABLE', `A booking that is ${booking.status} cannot be paid`, { status: booking.status });
      }
      if (booking.paymentDueAt && booking.paymentDueAt.getTime() <= now.getTime()) {
        throw conflict('PAYMENT_DEADLINE_PASSED', 'The time to pay for this booking has passed');
      }
      // Do not start taking money for a job nobody can perform. (What happens to such a booking is a pending business decision.)
      if (!booking.worker || booking.worker.verificationStatus !== WorkerVerificationStatus.APPROVED || booking.worker.user.status !== UserStatus.ACTIVE) {
        throw conflict('WORKER_UNAVAILABLE', 'The worker for this booking is no longer available');
      }

      // At most one open attempt. A stale one (its checkout expired) is closed locally; if the provider
      // still reports a capture later, that late success is recorded, never lost.
      const open = await tx.paymentAttempt.findFirst({ where: { bookingId, openSlot: true } });
      if (open) {
        if (open.checkoutExpiresAt && open.checkoutExpiresAt.getTime() <= now.getTime()) {
          await this.settle(tx, open.id, open.status, PaymentStatus.EXPIRED, { failureCode: 'CHECKOUT_EXPIRED' });
        } else {
          throw conflict('PAYMENT_IN_PROGRESS', 'A payment for this booking is already in progress', { paymentId: open.id });
        }
      }

      const last = await tx.paymentAttempt.aggregate({ where: { bookingId }, _max: { attemptNumber: true } });
      const expiresAt = new Date(Math.min(now.getTime() + this.cfg.checkoutTtlMinutes * 60_000, booking.paymentDueAt?.getTime() ?? Infinity));
      const attempt = await tx.paymentAttempt.create({
        data: {
          bookingId,
          customerId,
          attemptNumber: (last._max.attemptNumber ?? 0) + 1,
          provider: this.provider.name,
          status: PaymentStatus.INITIATED,
          openSlot: true,
          // The amount is NEVER taken from the client: it is the agreed snapshot.
          amountHalalas: booking.totalAmountHalalas,
          currency: booking.currency,
          idempotencyKey,
          requestFingerprint: fingerprint,
          isSimulated: this.provider.isSimulated,
          checkoutExpiresAt: expiresAt,
        },
      });
      return { attempt, reference: booking.reference, replay: false };
    });

    const { attempt, reference } = prepared;
    // A finished attempt is simply reported; only an INITIATED one still needs the provider call.
    if (attempt.status !== PaymentStatus.INITIATED) return toAttemptDto(attempt);
    return this.callProvider(attempt, reference, returnUrl);
  }

  // ---- steps 2 and 3

  private async callProvider(attempt: Prisma.PaymentAttemptGetPayload<object>, bookingReference: string, returnUrl: string | null): Promise<PaymentAttemptDto> {
    let session;
    try {
      session = await this.provider.createCheckout({
        paymentId: attempt.id,
        // Server-derived and unique per attempt. The customer's own key is only unique per customer, so it must
        // never be the provider-facing key: two customers could otherwise collide on one provider payment.
        idempotencyKey: `pay_${attempt.id}`,
        bookingReference,
        amountHalalas: attempt.amountHalalas,
        currency: attempt.currency,
        expiresAt: attempt.checkoutExpiresAt ?? new Date(Date.now() + this.cfg.checkoutTtlMinutes * 60_000),
        returnUrl,
      });
    } catch (err) {
      if (err instanceof ProviderRejectedError) {
        // Definitive refusal: record it and free the open slot so the customer can try again.
        await this.prisma.$transaction(async (tx) => {
          await lockBooking(tx, attempt.bookingId);
          await lockPayment(tx, attempt.id);
          const fresh = await tx.paymentAttempt.findUniqueOrThrow({ where: { id: attempt.id } });
          if (fresh.status === PaymentStatus.INITIATED) {
            await this.settle(tx, fresh.id, fresh.status, PaymentStatus.FAILED, { failureCode: err.code, failureMessage: 'The payment provider refused the request' });
          }
        });
        throw new ApiError(HttpStatus.BAD_GATEWAY, 'PAYMENT_PROVIDER_REJECTED', 'The payment provider could not start this payment');
      }
      // Unknown outcome: keep the attempt INITIATED so the same Idempotency-Key can safely resume it.
      this.logger.warn(`Provider call failed for payment ${attempt.id}: ${(err as Error).constructor.name}`);
      if (err instanceof ApiError) throw err;
      throw unavailable('PAYMENT_PROVIDER_UNAVAILABLE', 'The payment provider is not responding. Retry with the same Idempotency-Key');
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      await lockBooking(tx, attempt.bookingId);
      await lockPayment(tx, attempt.id);
      const fresh = await tx.paymentAttempt.findUniqueOrThrow({ where: { id: attempt.id } });
      // A webhook, a cancellation or an earlier resume may have moved it on while we waited for the provider.
      if (fresh.status !== PaymentStatus.INITIATED) return fresh;
      assertTransition(fresh.status, PaymentStatus.PROCESSING);
      return tx.paymentAttempt.update({
        where: { id: fresh.id },
        data: {
          status: PaymentStatus.PROCESSING,
          providerPaymentId: session.providerPaymentId,
          checkoutUrl: session.checkoutUrl,
          processingAt: new Date(),
        },
      });
    });
    return toAttemptDto(updated);
  }

  // ----------------------------------------------------------------- reads and cancel

  async listMine(customerId: string, q: ListMyPaymentsQueryDto): Promise<Page<PaymentAttemptDto>> {
    const where: Prisma.PaymentAttemptWhereInput = {
      customerId,
      ...(q.bookingId ? { bookingId: q.bookingId } : {}),
      ...(q.status && q.status.length > 0 ? { status: { in: q.status } } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.paymentAttempt.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: q.skip, take: q.limit }),
      this.prisma.paymentAttempt.count({ where }),
    ]);
    return toPage(rows.map(toAttemptDto), total, q);
  }

  async getMine(customerId: string, paymentId: string): Promise<PaymentAttemptDto> {
    const row = await this.prisma.paymentAttempt.findFirst({ where: { id: paymentId, customerId } });
    if (!row) throw notFound('Payment'); // never reveals that another customer's payment exists
    return toAttemptDto(row);
  }

  /** The customer abandons an open attempt. A capture reported later by the provider is still recorded. */
  async cancelMine(customerId: string, paymentId: string): Promise<PaymentAttemptDto> {
    const owned = await this.prisma.paymentAttempt.findFirst({ where: { id: paymentId, customerId }, select: { id: true, bookingId: true } });
    if (!owned) throw notFound('Payment');

    const row = await this.prisma.$transaction(async (tx) => {
      await lockBooking(tx, owned.bookingId);
      await lockPayment(tx, owned.id);
      const fresh = await tx.paymentAttempt.findUniqueOrThrow({ where: { id: owned.id } });
      if (fresh.status === PaymentStatus.CANCELLED) return fresh; // idempotent
      if (isCaptured(fresh.status)) throw conflict('PAYMENT_ALREADY_CAPTURED', 'This payment was already completed and cannot be cancelled');
      if (!isOpen(fresh.status)) throw conflict('PAYMENT_NOT_CANCELLABLE', `A payment that is ${fresh.status} cannot be cancelled`, { status: fresh.status });
      return this.settle(tx, fresh.id, fresh.status, PaymentStatus.CANCELLED, {});
    });
    return toAttemptDto(row);
  }

  // ----------------------------------------------------------------------- helpers

  /** Closes an open attempt with a non-capturing outcome. Caller holds the booking and payment locks. */
  private async settle(
    tx: Tx,
    id: string,
    from: PaymentStatus,
    to: 'FAILED' | 'CANCELLED' | 'EXPIRED',
    detail: { failureCode?: string; failureMessage?: string },
  ) {
    assertTransition(from, to);
    return tx.paymentAttempt.update({
      where: { id },
      data: { status: to, openSlot: null, settledAt: new Date(), failureCode: detail.failureCode ?? null, failureMessage: detail.failureMessage ?? null },
    });
  }

  private checkReturnUrl(url: string | undefined): string | null {
    if (!url) return null;
    let origin: string;
    try {
      origin = new URL(url).origin;
    } catch {
      throw badRequest('RETURN_URL_INVALID', 'returnUrl is not a valid address');
    }
    if (!this.cfg.returnUrlOrigins.includes(origin)) {
      throw badRequest('RETURN_URL_NOT_ALLOWED', 'returnUrl is not on the list of allowed addresses');
    }
    return url;
  }
}
