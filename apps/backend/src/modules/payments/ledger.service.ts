import { Injectable } from '@nestjs/common';
import type { LedgerEntryType } from '../../generated/prisma/client.js';
import type { Tx } from '../bookings/booking-support.js';

export interface LedgerPosting {
  entryType: LedgerEntryType;
  /** Signed integer halalas: positive = money received, negative = money paid out. Never zero. */
  amountHalalas: number;
  currency: string;
  bookingId?: string;
  paymentId?: string;
  refundId?: string;
  /** Stable key, e.g. `payment:<id>:capture`. Posting the same key twice is a no-op. */
  idempotencyKey: string;
  sourceType: string;
  sourceId?: string;
  description: string;
  isSimulated: boolean;
  createdById?: string;
}

/**
 * The ONLY writer of ledger_entries. There is no update or delete method: posted entries are
 * immutable (also enforced by database triggers). A mistake is fixed with a new CORRECTION entry.
 *
 * Accrual entries (commission, worker earnings, payouts) are deliberately NOT posted anywhere yet:
 * their rules are unapproved business decisions. The enum values exist so the schema will not change.
 */
@Injectable()
export class LedgerService {
  /**
   * Appends an entry inside the caller's transaction. Returns false when an entry with the same
   * idempotency key already exists (a repeated event), without raising an error that would abort the transaction.
   */
  async post(tx: Tx, posting: LedgerPosting): Promise<boolean> {
    const result = await tx.ledgerEntry.createMany({
      data: [
        {
          entryType: posting.entryType,
          amountHalalas: posting.amountHalalas,
          currency: posting.currency,
          bookingId: posting.bookingId ?? null,
          paymentId: posting.paymentId ?? null,
          refundId: posting.refundId ?? null,
          idempotencyKey: posting.idempotencyKey,
          sourceType: posting.sourceType,
          sourceId: posting.sourceId ?? null,
          description: posting.description.slice(0, 255),
          isSimulated: posting.isSimulated,
          createdById: posting.createdById ?? null,
        },
      ],
      skipDuplicates: true,
    });
    return result.count === 1;
  }
}
