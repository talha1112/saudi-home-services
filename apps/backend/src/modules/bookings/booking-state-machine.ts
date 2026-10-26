import { BookingEventType, BookingStatus } from '../../generated/prisma/client.js';

const S = BookingStatus;

export type Actor = 'CUSTOMER' | 'WORKER' | 'ADMIN' | 'SYSTEM';

/** Everything that can change a booking's status. Quote-level changes (submit, revise, withdraw) do not. */
export type BookingAction =
  | 'accept_quote'
  | 'confirm_payment'
  | 'start_work'
  | 'complete_work'
  | 'cancel'
  | 'expire';

interface Rule {
  to: BookingStatus;
  event: BookingEventType;
  /** Who may perform it, and from which statuses. */
  allow: Partial<Record<Actor, BookingStatus[]>>;
}

/**
 * The booking lifecycle. This table is the single source of truth: services never compare
 * statuses ad hoc, they ask `allowedFrom()` / `assertAllowed()`.
 *
 *   OPEN --accept_quote (customer)--> PAYMENT_PENDING --confirm_payment (system)--> CONFIRMED
 *   CONFIRMED --start_work (assigned worker)--> IN_PROGRESS --complete_work (assigned worker)--> COMPLETED
 *   OPEN --expire (system)--> EXPIRED
 *   OPEN | PAYMENT_PENDING | CONFIRMED --cancel (customer or admin)--> CANCELLED
 *   IN_PROGRESS --cancel (admin only)--> CANCELLED
 *
 * COMPLETED, CANCELLED and EXPIRED are final. Payment-related reversals (payment timeout,
 * refunds) belong to the payments phase and will add rules here.
 */
export const RULES: Record<BookingAction, Rule> = {
  accept_quote: { to: S.PAYMENT_PENDING, event: BookingEventType.QUOTE_ACCEPTED, allow: { CUSTOMER: [S.OPEN] } },
  confirm_payment: { to: S.CONFIRMED, event: BookingEventType.PAYMENT_CONFIRMED, allow: { SYSTEM: [S.PAYMENT_PENDING] } },
  start_work: { to: S.IN_PROGRESS, event: BookingEventType.WORK_STARTED, allow: { WORKER: [S.CONFIRMED] } },
  complete_work: { to: S.COMPLETED, event: BookingEventType.WORK_COMPLETED, allow: { WORKER: [S.IN_PROGRESS] } },
  cancel: {
    to: S.CANCELLED,
    event: BookingEventType.BOOKING_CANCELLED,
    allow: {
      CUSTOMER: [S.OPEN, S.PAYMENT_PENDING, S.CONFIRMED],
      ADMIN: [S.OPEN, S.PAYMENT_PENDING, S.CONFIRMED, S.IN_PROGRESS],
    },
  },
  expire: { to: S.EXPIRED, event: BookingEventType.BOOKING_EXPIRED, allow: { SYSTEM: [S.OPEN] } },
};

export const FINAL_STATUSES: BookingStatus[] = [S.COMPLETED, S.CANCELLED, S.EXPIRED];

/** Statuses from which `actor` may perform `action` (empty when the actor may never do it). */
export function allowedFrom(action: BookingAction, actor: Actor): BookingStatus[] {
  return RULES[action].allow[actor] ?? [];
}

export type Verdict = 'ok' | 'wrong_actor' | 'wrong_state';

export function check(action: BookingAction, actor: Actor, from: BookingStatus): Verdict {
  const rule = RULES[action];
  if (!(actor in rule.allow)) return 'wrong_actor';
  return (rule.allow[actor] ?? []).includes(from) ? 'ok' : 'wrong_state';
}
