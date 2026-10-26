import { HttpStatus } from '@nestjs/common';
import { ApiError } from '../../common/errors/api-error.js';
import type { BookingEventType, BookingStatus, Prisma, Role } from '../../generated/prisma/client.js';

export type Tx = Prisma.TransactionClient;

export const notFound = (what: string) => new ApiError(HttpStatus.NOT_FOUND, 'NOT_FOUND', `${what} not found`);

export const conflict = (code: string, message: string, details?: Record<string, unknown>) =>
  new ApiError(HttpStatus.CONFLICT, code, message, details ? { details } : {});

/** Thrown inside a transaction when a compare-and-set lost a race, so the caller can re-read and retry. */
export class StaleStateError extends Error {}

export function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string })?.code === 'P2002';
}

export interface EventInput {
  bookingId: string;
  type: BookingEventType;
  fromStatus?: BookingStatus | null;
  toStatus?: BookingStatus | null;
  quoteId?: string | null;
  /** Omit (or null) for system actions. */
  actorUserId?: string | null;
  actorRole?: Role | null;
  amountHalalas?: number | null;
  note?: string | null;
}

/**
 * Appends to the booking timeline. Always called in the same transaction as the change it records.
 *
 * It also writes the realtime outbox row for the event, in that same transaction: if the change rolls
 * back, so does the announcement, and if it commits the announcement cannot be lost (a job delivers it
 * after commit). The payload is deliberately minimal and carries no price, address, note or person.
 */
export async function recordEvent(tx: Tx, e: EventInput): Promise<void> {
  const row = await tx.bookingEvent.create({
    data: {
      bookingId: e.bookingId,
      type: e.type,
      fromStatus: e.fromStatus ?? null,
      toStatus: e.toStatus ?? null,
      quoteId: e.quoteId ?? null,
      actorUserId: e.actorUserId ?? null,
      actorRole: e.actorRole ?? null,
      amountHalalas: e.amountHalalas ?? null,
      note: e.note ?? null,
    },
    select: { id: true, createdAt: true },
  });
  await tx.realtimeOutboxEvent.create({
    data: {
      bookingEventId: row.id,
      bookingId: e.bookingId,
      payload: {
        v: 1,
        eventId: row.id,
        bookingId: e.bookingId,
        type: e.type,
        fromStatus: e.fromStatus ?? null,
        toStatus: e.toStatus ?? null,
        occurredAt: row.createdAt.toISOString(),
      },
    },
  });
}

/** Quote is live when it is SUBMITTED and its validity has not run out. */
export function isLive(quote: { status: string; validUntil: Date }, now: Date = new Date()): boolean {
  return quote.status === 'SUBMITTED' && quote.validUntil.getTime() > now.getTime();
}

/**
 * Takes a row lock on the booking for the rest of the transaction, so every writer of one
 * booking (accept, cancel, expire, pay, start, finish, new quote) runs one after another.
 *
 * Why: without it, two transactions that each update a quote row and then the booking row can
 * wait on each other (deadlock, surfacing as a 500). With a single entry point every
 * transaction takes locks in the same order: booking first, then quotes.
 * FOR NO KEY UPDATE is the same lock a plain UPDATE takes, and it does not block the
 * foreign-key checks of concurrent inserts into quotes or events.
 */
export async function lockBooking(tx: Tx, bookingId: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM bookings WHERE id = ${bookingId}::uuid FOR NO KEY UPDATE`;
}
