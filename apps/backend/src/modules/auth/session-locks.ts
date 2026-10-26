import type { Prisma } from '../../generated/prisma/client.js';

/**
 * Transaction-scoped advisory locks that serialize everything that changes a session or the devices of a user.
 *
 * Why: under READ COMMITTED an `UPDATE ... WHERE family_id = X AND revoked_at IS NULL` only sees rows that were committed when the
 * statement started. A refresh that is inserting the next token of that family at the same moment would therefore be missed by a
 * concurrent logout, and the session would stay alive. Taking the same lock first makes the two run one after the other, and the second
 * one then sees the first one's committed rows.
 *
 * LOCK ORDER (always in this order, never the reverse, which is what rules out deadlocks between them):
 *   1. the user lock, 2. session locks (several only in ascending id order), 3. row locks taken by the statements themselves.
 * Refresh takes only a session lock. Locks are released at commit or rollback; taking the same lock twice in one transaction is a no-op.
 * They are keyed by a 64-bit hash of the id, so an unlikely collision only causes extra waiting, never a wrong result.
 */
type LockableTx = Pick<Prisma.TransactionClient, '$executeRaw'>;

export const lockUser = async (tx: LockableTx, userId: string): Promise<void> => {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`user:${userId}`}, 0))`;
};

export const lockSession = async (tx: LockableTx, sessionId: string): Promise<void> => {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`session:${sessionId}`}, 0))`;
};
