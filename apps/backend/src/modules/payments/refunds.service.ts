import { Injectable } from '@nestjs/common';
import { type Prisma, RefundStatus } from '../../generated/prisma/client.js';
import { PrismaService } from '../../database/prisma.service.js';
import { type Tx, conflict, lockBooking, notFound } from '../bookings/booking-support.js';
import { AuditService } from '../auth/audit.service.js';
import type { ClientMeta } from '../auth/auth.types.js';
import { isCaptured } from './payment-state.js';
import { lockPayment, sha256 } from './payments-support.js';

type RefundRow = Prisma.PaymentRefundGetPayload<object>;

/**
 * Refund REQUESTS. Nothing here moves money: a request reserves part of the captured amount and
 * stays REQUESTED until a provider confirms it (a later phase). Policy (who may be refunded, how
 * much, VAT/commission treatment) is not decided here: an administrator chooses the amount, the
 * system only guarantees it can never exceed what was captured.
 *
 * Concurrency: the payment attempt row is locked (after the booking row) and a database CHECK
 * (refund_reserved_halalas <= captured_amount_halalas) is the last line of defence, so two admins
 * racing for the same money cannot both succeed.
 */
@Injectable()
export class RefundsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async request(
    adminId: string,
    paymentId: string,
    idempotencyKey: string,
    input: { amountHalalas: number; reason: string },
    meta: ClientMeta,
  ): Promise<RefundRow> {
    const fingerprint = sha256(JSON.stringify({ paymentId, amount: input.amountHalalas, reason: input.reason }));

    const located = await this.prisma.paymentAttempt.findUnique({ where: { id: paymentId }, select: { id: true, bookingId: true } });
    if (!located) throw notFound('Payment');

    const result = await this.prisma.$transaction(async (tx) => {
      // LOCK ORDER: booking, payment attempt.
      await lockBooking(tx, located.bookingId);
      await lockPayment(tx, located.id);

      const existing = await tx.paymentRefund.findUnique({ where: { requestedById_idempotencyKey: { requestedById: adminId, idempotencyKey } } });
      if (existing) {
        if (existing.requestFingerprint !== fingerprint) {
          throw conflict('IDEMPOTENCY_CONFLICT', 'This Idempotency-Key was already used for a different refund request');
        }
        return { refund: existing, replay: true };
      }

      const payment = await tx.paymentAttempt.findUniqueOrThrow({ where: { id: located.id } });
      if (!isCaptured(payment.status) || payment.capturedAmountHalalas === null || payment.capturedCurrency === null) {
        throw conflict('PAYMENT_NOT_REFUNDABLE', `A payment that is ${payment.status} has no captured money to refund`, { status: payment.status });
      }
      const eligible = payment.capturedAmountHalalas - payment.refundReservedHalalas;
      if (input.amountHalalas > eligible) {
        throw conflict('REFUND_EXCEEDS_ELIGIBLE', 'The refund is larger than the captured amount still available', {
          eligibleHalalas: eligible,
          requestedHalalas: input.amountHalalas,
        });
      }

      await tx.paymentAttempt.update({ where: { id: payment.id }, data: { refundReservedHalalas: { increment: input.amountHalalas } } });
      const refund = await tx.paymentRefund.create({
        data: {
          paymentId: payment.id,
          bookingId: payment.bookingId,
          amountHalalas: input.amountHalalas,
          currency: payment.capturedCurrency,
          reason: input.reason,
          status: RefundStatus.REQUESTED,
          requestedById: adminId,
          idempotencyKey,
          requestFingerprint: fingerprint,
          provider: payment.provider,
        },
      });
      return { refund, replay: false };
    });

    if (!result.replay) {
      await this.audit.record({
        action: 'payment.refund.requested',
        actorUserId: adminId,
        entityType: 'payment_refund',
        entityId: result.refund.id,
        metadata: { paymentId, amountHalalas: input.amountHalalas },
        ipAddress: meta.ip,
        userAgent: meta.userAgent,
      });
    }
    return result.refund;
  }

  /** Withdraws a refund that has not been handed to a provider, releasing the reserved amount. */
  async cancel(adminId: string, refundId: string, reason: string, meta: ClientMeta): Promise<RefundRow> {
    const located = await this.prisma.paymentRefund.findUnique({ where: { id: refundId }, select: { id: true, paymentId: true, bookingId: true } });
    if (!located) throw notFound('Refund');

    const refund = await this.prisma.$transaction(async (tx) => {
      await lockBooking(tx, located.bookingId);
      await lockPayment(tx, located.paymentId);
      return this.cancelLocked(tx, located.id, located.paymentId);
    });
    await this.audit.record({
      action: 'payment.refund.cancelled',
      actorUserId: adminId,
      entityType: 'payment_refund',
      entityId: refund.id,
      metadata: { reasonGiven: reason.length > 0 },
      ipAddress: meta.ip,
      userAgent: meta.userAgent,
    });
    return refund;
  }

  private async cancelLocked(tx: Tx, refundId: string, paymentId: string): Promise<RefundRow> {
    const fresh = await tx.paymentRefund.findUniqueOrThrow({ where: { id: refundId } });
    if (fresh.status === RefundStatus.CANCELLED) return fresh; // idempotent
    if (fresh.status !== RefundStatus.REQUESTED) {
      throw conflict('REFUND_NOT_CANCELLABLE', `A refund that is ${fresh.status} can no longer be cancelled`, { status: fresh.status });
    }
    const moved = await tx.paymentRefund.updateMany({
      where: { id: fresh.id, status: RefundStatus.REQUESTED },
      data: { status: RefundStatus.CANCELLED, completedAt: new Date() },
    });
    if (moved.count !== 1) throw conflict('REFUND_NOT_CANCELLABLE', 'The refund changed, please reload');
    await tx.paymentAttempt.update({ where: { id: paymentId }, data: { refundReservedHalalas: { decrement: fresh.amountHalalas } } });
    return tx.paymentRefund.findUniqueOrThrow({ where: { id: fresh.id } });
  }
}
