import type { PrismaService } from '../../database/prisma.service.js';

/**
 * Push registrations found dead while delivering, keyed by device id. The value is the session the registration was bound to when it was
 * found dead (the session had ended), or null when the push provider said the token itself is invalid.
 */
export type DeadRegistrations = Map<string, string | null>;

/**
 * Revokes dead registrations after the delivery batch has committed.
 *
 * Why the condition on the session: between "this registration's session has ended" (found during the batch) and this update, the same
 * phone may have signed in again and re-registered the same push token, which rebinds the row to a NEW live session. Revoking by id alone
 * would silently kill that fresh registration. So a registration found dead because of its session is revoked only while it is still bound to
 * that same session. A token the provider rejected is invalid whichever session holds it (a row's token never changes), so it is revoked
 * unconditionally. Idempotent: rows that are already revoked are untouched.
 */
export async function revokeDeadRegistrations(prisma: PrismaService, dead: DeadRegistrations, now: Date = new Date()): Promise<number> {
  let revoked = 0;
  const invalidTokens = [...dead].filter(([, session]) => session === null).map(([id]) => id);
  if (invalidTokens.length > 0) {
    revoked += (await prisma.deviceToken.updateMany({ where: { id: { in: invalidTokens }, revokedAt: null }, data: { revokedAt: now } })).count;
  }
  const bySession = new Map<string, string[]>();
  for (const [id, session] of dead) {
    if (session !== null) bySession.set(session, [...(bySession.get(session) ?? []), id]);
  }
  for (const [sessionId, ids] of bySession) {
    revoked += (await prisma.deviceToken.updateMany({ where: { id: { in: ids }, sessionId, revokedAt: null }, data: { revokedAt: now } })).count;
  }
  return revoked;
}
