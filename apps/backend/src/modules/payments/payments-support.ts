import { createHash } from 'node:crypto';
import { badRequest } from '../../common/errors/api-error.js';
import type { Prisma } from '../../generated/prisma/client.js';
import type { Tx } from '../bookings/booking-support.js';
import type { PaymentAttemptDto } from './dto/payments.dto.js';
import { isOpen } from './payment-state.js';

export const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

const KEY_PATTERN = /^[A-Za-z0-9_.:-]{8,128}$/;

/** `Idempotency-Key` is mandatory for requests that create money-related records. */
export function parseIdempotencyKey(header: string | string[] | undefined): string {
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) throw badRequest('IDEMPOTENCY_KEY_REQUIRED', 'Send an Idempotency-Key header (8-128 characters) so retries are safe');
  if (!KEY_PATTERN.test(value)) {
    throw badRequest('IDEMPOTENCY_KEY_INVALID', 'Idempotency-Key must be 8-128 characters: letters, digits and _ . : -');
  }
  return value;
}

/**
 * Row lock on a payment attempt. LOCK ORDER everywhere in the payments code:
 * booking (lockBooking) first, then the payment attempt, then refunds. Keeping one order is what
 * prevents deadlocks between webhooks, customers, admins and the sweep.
 */
export async function lockPayment(tx: Tx, paymentId: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM payment_attempts WHERE id = ${paymentId}::uuid FOR UPDATE`;
}

type AttemptRow = Prisma.PaymentAttemptGetPayload<object>;

/** Customer-safe view. Provider references, fingerprints and reconciliation details stay inside. */
export function toAttemptDto(a: AttemptRow): PaymentAttemptDto {
  const open = isOpen(a.status);
  return {
    id: a.id,
    bookingId: a.bookingId,
    attemptNumber: a.attemptNumber,
    status: a.status,
    amountHalalas: a.amountHalalas,
    currency: a.currency,
    simulated: a.isSimulated,
    checkout: open && a.checkoutUrl ? { url: a.checkoutUrl, expiresAt: a.checkoutExpiresAt?.toISOString() ?? null } : null,
    failure: a.failureCode ? { code: a.failureCode, message: a.failureMessage } : null,
    createdAt: a.createdAt.toISOString(),
  };
}

/** Short, secret-free description of an error for storage in the webhook inbox. */
export function safeErrorSummary(err: unknown): string {
  const code = (err as { code?: unknown })?.code;
  const name = err instanceof Error ? err.constructor.name : 'Error';
  return (typeof code === 'string' ? `${name}:${code}` : name).slice(0, 200);
}
