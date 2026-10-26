import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiError } from '../../common/errors/api-error.js';
import { APP_CONFIG, type AppConfig, type PaymentsConfig } from '../../config/app.config.js';
import { PrismaService } from '../../database/prisma.service.js';
import { LedgerEntryType, PaymentStatus, WebhookEventStatus } from '../../generated/prisma/client.js';
import { type Tx, lockBooking } from '../bookings/booking-support.js';
import { BookingLifecycleService } from '../bookings/booking-lifecycle.service.js';
import { LedgerService } from './ledger.service.js';
import { assertTransition, decideEvent, PROVIDER_EVENT_KINDS, type ProviderEventKind } from './payment-state.js';
import { lockPayment, safeErrorSummary } from './payments-support.js';
import type { NormalizedPaymentEvent } from './provider/payment-provider.js';

export type EventResult = 'processed' | 'ignored' | 'duplicate' | 'in_progress';

interface InboxRef {
  id: string;
  status: WebhookEventStatus;
}

/** Outcomes recorded on the inbox row (what processing decided). */
export const OUTCOME = {
  APPLIED: 'APPLIED',
  CAPTURED_UNAPPLIED: 'CAPTURED_UNAPPLIED',
  SETTLED: 'SETTLED',
  DUPLICATE_EVENT: 'DUPLICATE_EVENT',
  STALE_EVENT: 'STALE_EVENT',
  UNSUPPORTED_EVENT: 'UNSUPPORTED_EVENT',
  ORPHAN_UNKNOWN_PAYMENT: 'ORPHAN_UNKNOWN_PAYMENT',
  SIMULATION_MISMATCH: 'SIMULATION_MISMATCH',
} as const;

/**
 * Applies VERIFIED provider events (signature already checked by the adapter, or produced by the
 * development simulation endpoint) to payment attempts, bookings and the ledger.
 *
 * Design:
 *  1. INBOX: the event id is inserted under UNIQUE(provider, account, event id). Only one delivery
 *     inserts; repeats see the existing row. A row is CLAIMED by a compare-and-set to PROCESSING
 *     (a lease lets a crashed worker's claim be taken over).
 *  2. APPLY, in ONE database transaction: lock booking, then payment attempt (always this order),
 *     re-read, decide, change the payment, confirm the booking with
 *     BookingLifecycleService.confirmPaymentInTransaction, post the ledger entry, and mark the
 *     inbox row PROCESSED/IGNORED. Either all of it commits or none of it does, so an event is never
 *     recorded as processed before its effects exist.
 *  3. On any error the transaction rolls back and the row is marked FAILED with a safe summary; the
 *     caller gets a 5xx so the provider redelivers, and an admin can retry it.
 */
@Injectable()
export class PaymentEventsService {
  private readonly logger = new Logger(PaymentEventsService.name);
  private readonly cfg: PaymentsConfig;

  constructor(
    config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly lifecycle: BookingLifecycleService,
    private readonly ledger: LedgerService,
  ) {
    this.cfg = config.getOrThrow<AppConfig>(APP_CONFIG).payments;
  }

  async handleVerified(provider: string, event: NormalizedPaymentEvent, payloadHash: string | null): Promise<EventResult> {
    // 1. inbox: insert-if-absent, then claim
    await this.prisma.paymentWebhookEvent.createMany({
      data: [
        {
          provider,
          accountScope: event.accountScope,
          providerEventId: event.providerEventId,
          eventType: event.kind,
          providerPaymentId: event.providerPaymentId,
          amountHalalas: event.amountHalalas,
          currency: event.currency,
          occurredAt: event.occurredAt,
          isSimulated: event.isSimulated,
          payloadHash,
        },
      ],
      skipDuplicates: true,
    });
    const row = await this.prisma.paymentWebhookEvent.findUniqueOrThrow({
      where: { provider_accountScope_providerEventId: { provider, accountScope: event.accountScope, providerEventId: event.providerEventId } },
      select: { id: true, status: true },
    });
    return this.claimAndProcess(row, provider, event);
  }

  /** Re-runs a FAILED event, or an unknown-payment event that may now be resolvable. */
  async retry(eventId: string): Promise<EventResult> {
    const row = await this.prisma.paymentWebhookEvent.findUnique({ where: { id: eventId } });
    if (!row) throw new ApiError(HttpStatus.NOT_FOUND, 'NOT_FOUND', 'Webhook event not found');
    const retryable = row.status === WebhookEventStatus.FAILED || (row.status === WebhookEventStatus.IGNORED && row.outcome === OUTCOME.ORPHAN_UNKNOWN_PAYMENT);
    if (!retryable) {
      throw new ApiError(HttpStatus.CONFLICT, 'EVENT_NOT_RETRYABLE', `An event that is ${row.status}${row.outcome ? ` (${row.outcome})` : ''} cannot be retried`);
    }
    const reset = await this.prisma.paymentWebhookEvent.updateMany({
      where: { id: row.id, status: row.status, outcome: row.outcome },
      data: { status: WebhookEventStatus.RECEIVED, processedAt: null },
    });
    if (reset.count !== 1) return 'in_progress';
    const kind = (PROVIDER_EVENT_KINDS as string[]).includes(row.eventType) ? (row.eventType as ProviderEventKind) : 'UNKNOWN';
    const event: NormalizedPaymentEvent = {
      providerEventId: row.providerEventId,
      accountScope: row.accountScope,
      kind,
      providerPaymentId: row.providerPaymentId,
      amountHalalas: row.amountHalalas,
      currency: row.currency,
      occurredAt: row.occurredAt ?? row.receivedAt,
      isSimulated: row.isSimulated,
    };
    return this.claimAndProcess({ id: row.id, status: WebhookEventStatus.RECEIVED }, row.provider, event);
  }

  // ------------------------------------------------------------------------ claim

  private async claimAndProcess(row: InboxRef, provider: string, event: NormalizedPaymentEvent): Promise<EventResult> {
    if (row.status === WebhookEventStatus.PROCESSED || row.status === WebhookEventStatus.IGNORED) return 'duplicate';

    const now = new Date();
    const leaseEnds = new Date(now.getTime() - this.cfg.webhookLeaseSeconds * 1000);
    const claimed = await this.prisma.paymentWebhookEvent.updateMany({
      where: {
        id: row.id,
        OR: [
          { status: { in: [WebhookEventStatus.RECEIVED, WebhookEventStatus.FAILED] } },
          { status: WebhookEventStatus.PROCESSING, processingStartedAt: { lt: leaseEnds } },
        ],
      },
      data: { status: WebhookEventStatus.PROCESSING, processingStartedAt: now, attempts: { increment: 1 }, lastError: null },
    });
    // Someone else is processing it right now (a concurrent delivery): it will finish the work.
    if (claimed.count !== 1) return 'in_progress';

    try {
      return await this.prisma.$transaction(async (tx) => this.apply(tx, row.id, provider, event));
    } catch (err) {
      this.logger.error(`Payment event ${row.id} failed: ${safeErrorSummary(err)}`);
      await this.prisma.paymentWebhookEvent.updateMany({
        where: { id: row.id, status: WebhookEventStatus.PROCESSING },
        data: { status: WebhookEventStatus.FAILED, lastError: safeErrorSummary(err), processingStartedAt: null },
      });
      throw new ApiError(HttpStatus.SERVICE_UNAVAILABLE, 'PAYMENT_EVENT_FAILED', 'The payment event could not be processed yet and will be retried');
    }
  }

  // ------------------------------------------------------------------------ apply

  private async apply(tx: Tx, inboxId: string, provider: string, event: NormalizedPaymentEvent): Promise<EventResult> {
    const finish = async (status: 'PROCESSED' | 'IGNORED', outcome: string, paymentAttemptId: string | null): Promise<EventResult> => {
      await tx.paymentWebhookEvent.update({
        where: { id: inboxId },
        data: {
          status: status === 'PROCESSED' ? WebhookEventStatus.PROCESSED : WebhookEventStatus.IGNORED,
          outcome,
          paymentAttemptId,
          processedAt: new Date(),
          processingStartedAt: null,
          lastError: null,
        },
      });
      return status === 'PROCESSED' ? 'processed' : 'ignored';
    };

    // Which attempt does the event refer to? (Unlocked look-up only to learn the booking id for the lock.)
    const located = event.providerPaymentId
      ? await tx.paymentAttempt.findFirst({ where: { provider, providerPaymentId: event.providerPaymentId }, select: { id: true, bookingId: true } })
      : null;
    // Unknown reference: record and keep it for reconciliation. It can never confirm an arbitrary booking.
    if (!located) return finish('IGNORED', OUTCOME.ORPHAN_UNKNOWN_PAYMENT, null);

    // LOCK ORDER: booking, then payment attempt.
    await lockBooking(tx, located.bookingId);
    await lockPayment(tx, located.id);
    const attempt = await tx.paymentAttempt.findUniqueOrThrow({ where: { id: located.id } });

    // Simulated and real events must never meet: a mock event cannot touch a real payment, or vice versa.
    if (event.isSimulated !== attempt.isSimulated) return finish('IGNORED', OUTCOME.SIMULATION_MISMATCH, attempt.id);

    const decision = decideEvent(attempt.status, event.kind, event.occurredAt, attempt.lastProviderEventAt);
    if (decision.action === 'ignore') return finish('IGNORED', decision.reason, attempt.id);

    if (decision.action === 'settle') {
      assertTransition(attempt.status, decision.to as PaymentStatus);
      await tx.paymentAttempt.update({
        where: { id: attempt.id },
        data: {
          status: decision.to as PaymentStatus,
          openSlot: null,
          settledAt: new Date(),
          failureCode: event.failureCode ?? null,
          lastProviderEventAt: event.occurredAt,
        },
      });
      return finish('PROCESSED', OUTCOME.SETTLED, attempt.id);
    }

    // ---- a capture
    if (event.amountHalalas === null || !Number.isSafeInteger(event.amountHalalas) || event.amountHalalas <= 0 || !event.currency) {
      // A success event without a usable amount cannot be recorded truthfully. Roll back; an admin can retry
      // once the adapter/provider supplies it.
      throw new Error('Capture event without a usable amount and currency');
    }
    const captured = { amount: event.amountHalalas, currency: event.currency };

    let unappliedReason: string | null = null;
    if (captured.amount !== attempt.amountHalalas) unappliedReason = 'AMOUNT_MISMATCH';
    else if (captured.currency !== attempt.currency) unappliedReason = 'CURRENCY_MISMATCH';

    if (!unappliedReason) {
      try {
        await this.lifecycle.confirmPaymentInTransaction(tx, attempt.bookingId, {
          paidAmountHalalas: captured.amount,
          currency: captured.currency,
          note: `${attempt.isSimulated ? 'SIMULATED ' : ''}payment ${attempt.id}`,
        });
      } catch (err) {
        // These checks run before any write, so the transaction is still healthy.
        const code = (err as { code?: string }).code;
        if (code === 'BOOKING_ALREADY_PAID') unappliedReason = 'DUPLICATE_PAYMENT';
        else if (code === 'BOOKING_NOT_PAYABLE') unappliedReason = 'BOOKING_NOT_PAYABLE';
        else if (code === 'PAYMENT_AMOUNT_MISMATCH') unappliedReason = 'AMOUNT_MISMATCH';
        else if (code === 'PAYMENT_CURRENCY_MISMATCH') unappliedReason = 'CURRENCY_MISMATCH';
        else throw err;
      }
    }

    const applied = unappliedReason === null;
    const next = applied ? PaymentStatus.SUCCEEDED : PaymentStatus.CAPTURED_UNAPPLIED;
    assertTransition(attempt.status, next);
    await tx.paymentAttempt.update({
      where: { id: attempt.id },
      data: {
        status: next,
        openSlot: null,
        capturedAmountHalalas: captured.amount,
        capturedCurrency: captured.currency,
        settledAt: new Date(),
        lastProviderEventAt: event.occurredAt,
        failureCode: null,
        failureMessage: null,
        reconciliationReason: unappliedReason,
      },
    });
    await this.ledger.post(tx, {
      entryType: applied ? LedgerEntryType.PAYMENT_CAPTURED : LedgerEntryType.PAYMENT_CAPTURED_UNAPPLIED,
      amountHalalas: captured.amount,
      currency: captured.currency,
      bookingId: attempt.bookingId,
      paymentId: attempt.id,
      // One capture entry per attempt, ever: a repeated event cannot post a second one.
      idempotencyKey: `payment:${attempt.id}:capture`,
      sourceType: 'webhook_event',
      sourceId: inboxId,
      description: applied
        ? `Customer payment captured for booking (attempt ${attempt.attemptNumber})`
        : `Captured but NOT applied to the booking: ${unappliedReason}`,
      isSimulated: attempt.isSimulated,
    });
    return finish('PROCESSED', applied ? OUTCOME.APPLIED : `${OUTCOME.CAPTURED_UNAPPLIED}:${unappliedReason}`, attempt.id);
  }
}
