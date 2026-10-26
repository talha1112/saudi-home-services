import { PaymentStatus } from '../../generated/prisma/client.js';

const P = PaymentStatus;

/** What a verified provider event is about, after the adapter normalised it. */
export type ProviderEventKind = 'PAYMENT_SUCCEEDED' | 'PAYMENT_FAILED' | 'PAYMENT_CANCELLED' | 'PAYMENT_EXPIRED' | 'UNKNOWN';

export const PROVIDER_EVENT_KINDS: ProviderEventKind[] = ['PAYMENT_SUCCEEDED', 'PAYMENT_FAILED', 'PAYMENT_CANCELLED', 'PAYMENT_EXPIRED', 'UNKNOWN'];

/** An attempt that may still turn into money: at most one per booking (database-enforced). */
export const OPEN_STATUSES: PaymentStatus[] = [P.INITIATED, P.PROCESSING];

/** Money was captured by the provider. Final: nothing moves a captured attempt back. */
export const CAPTURED_STATUSES: PaymentStatus[] = [P.SUCCEEDED, P.CAPTURED_UNAPPLIED];

export const isOpen = (s: PaymentStatus) => OPEN_STATUSES.includes(s);
export const isCaptured = (s: PaymentStatus) => CAPTURED_STATUSES.includes(s);

/**
 * Payment attempt state machine.
 *
 *   INITIATED --> PROCESSING --> SUCCEEDED            captured, exact amount, booking confirmed
 *        |            |     \\-> CAPTURED_UNAPPLIED    captured but NOT applied (reconciliation)
 *        |            |     \\-> FAILED | CANCELLED | EXPIRED
 *        \\-> (any open outcome directly, e.g. the provider rejected the session)
 *   FAILED | CANCELLED | EXPIRED --> SUCCEEDED | CAPTURED_UNAPPLIED     a LATE capture is a fact
 *   SUCCEEDED, CAPTURED_UNAPPLIED are terminal.
 *
 * A late capture after a failure/cancel/expiry is allowed because money that really moved must be
 * recorded; an older failure arriving after a capture is not allowed to undo it.
 */
const ALLOWED: Record<PaymentStatus, PaymentStatus[]> = {
  [P.INITIATED]: [P.PROCESSING, P.SUCCEEDED, P.CAPTURED_UNAPPLIED, P.FAILED, P.CANCELLED, P.EXPIRED],
  [P.PROCESSING]: [P.SUCCEEDED, P.CAPTURED_UNAPPLIED, P.FAILED, P.CANCELLED, P.EXPIRED],
  [P.FAILED]: [P.SUCCEEDED, P.CAPTURED_UNAPPLIED],
  [P.CANCELLED]: [P.SUCCEEDED, P.CAPTURED_UNAPPLIED],
  [P.EXPIRED]: [P.SUCCEEDED, P.CAPTURED_UNAPPLIED],
  [P.SUCCEEDED]: [],
  [P.CAPTURED_UNAPPLIED]: [],
};

export function canTransition(from: PaymentStatus, to: PaymentStatus): boolean {
  return ALLOWED[from].includes(to);
}

/** Every status write goes through this: a forbidden move is a programming error, never data. */
export function assertTransition(from: PaymentStatus, to: PaymentStatus): void {
  if (!canTransition(from, to)) throw new Error(`Illegal payment transition ${from} -> ${to}`);
}

export type EventDecision =
  | { action: 'capture' }
  | { action: 'settle'; to: 'FAILED' | 'CANCELLED' | 'EXPIRED' }
  | { action: 'ignore'; reason: 'DUPLICATE_EVENT' | 'STALE_EVENT' | 'UNSUPPORTED_EVENT' };

const TARGET: Record<Exclude<ProviderEventKind, 'PAYMENT_SUCCEEDED' | 'UNKNOWN'>, 'FAILED' | 'CANCELLED' | 'EXPIRED'> = {
  PAYMENT_FAILED: 'FAILED',
  PAYMENT_CANCELLED: 'CANCELLED',
  PAYMENT_EXPIRED: 'EXPIRED',
};

/**
 * What a verified event does to an attempt that is currently `current`.
 * Pure function: the processing service applies the decision under row locks.
 *
 * `eventAt` / `lastEventAt` are the provider's own timestamps. A non-capturing event that is OLDER
 * than the newest one already applied is ignored (out-of-order delivery).
 */
export function decideEvent(current: PaymentStatus, kind: ProviderEventKind, eventAt: Date | null, lastEventAt: Date | null): EventDecision {
  if (kind === 'UNKNOWN') return { action: 'ignore', reason: 'UNSUPPORTED_EVENT' };

  if (kind === 'PAYMENT_SUCCEEDED') {
    return isCaptured(current) ? { action: 'ignore', reason: 'DUPLICATE_EVENT' } : { action: 'capture' };
  }

  // Failure-type events can never undo a capture, and never rewrite an earlier final outcome.
  if (isCaptured(current)) return { action: 'ignore', reason: 'STALE_EVENT' };
  const to = TARGET[kind];
  if (current === to) return { action: 'ignore', reason: 'DUPLICATE_EVENT' };
  if (!isOpen(current)) return { action: 'ignore', reason: 'STALE_EVENT' };
  if (eventAt && lastEventAt && eventAt.getTime() < lastEventAt.getTime()) return { action: 'ignore', reason: 'STALE_EVENT' };
  return { action: 'settle', to };
}
