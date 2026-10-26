import { randomUUID } from 'node:crypto';
import { Role } from '../../generated/prisma/client.js';
import { InMemoryPrisma } from '../../testing/in-memory-prisma.js';
import { type DeadRegistrations, revokeDeadRegistrations } from './dead-registrations.js';

/**
 * A registration found dead during a delivery batch is revoked after the batch commits. These tests pin down what that late update may and
 * may not touch, in particular a registration the phone has re-made in the meantime.
 */
function setup() {
  const db = new InMemoryPrisma();
  const prisma = db.asPrisma();
  const device = async (sessionId: string | null, userId = 'user-1') =>
    (
      await db.deviceToken.create({
        data: { userId, platform: 'ANDROID', provider: 'FCM', tokenHash: randomUUID(), tokenCiphertext: 'x', appRole: Role.CUSTOMER, sessionId },
      })
    ).id as string;
  const revoked = (id: string) => db.deviceTokens.find((d) => d.id === id)!.revokedAt !== null;
  return { db, prisma, device, revoked };
}

describe('revokeDeadRegistrations', () => {
  it('revokes a registration whose session had ended while it is still bound to that session', async () => {
    const t = setup();
    const id = await t.device('session-old');
    const dead: DeadRegistrations = new Map([[id, 'session-old']]);
    expect(await revokeDeadRegistrations(t.prisma, dead)).toBe(1);
    expect(t.revoked(id)).toBe(true);
  });

  it('does NOT revoke a registration that was rebound to a new live session after it was found dead', async () => {
    const t = setup();
    const id = await t.device('session-old');
    const dead: DeadRegistrations = new Map([[id, 'session-old']]); // found dead during the batch...
    t.db.deviceTokens.find((d) => d.id === id)!.sessionId = 'session-new'; // ...then the phone signed in again and re-registered the same token
    expect(await revokeDeadRegistrations(t.prisma, dead)).toBe(0);
    expect(t.revoked(id)).toBe(false);
  });

  it('revokes a token the provider rejected whichever session holds it', async () => {
    const t = setup();
    const a = await t.device('session-a');
    const b = await t.device(null); // legacy, unbound
    const dead: DeadRegistrations = new Map([
      [a, null],
      [b, null],
    ]);
    expect(await revokeDeadRegistrations(t.prisma, dead)).toBe(2);
    expect(t.revoked(a) && t.revoked(b)).toBe(true);
  });

  it('handles a mix, leaves other registrations alone, and is idempotent', async () => {
    const t = setup();
    const ended = await t.device('session-1');
    const invalid = await t.device('session-2');
    const rebound = await t.device('session-3');
    const bystander = await t.device('session-4');
    const dead: DeadRegistrations = new Map<string, string | null>([
      [ended, 'session-1'],
      [invalid, null],
      [rebound, 'session-3-before'],
    ]);
    expect(await revokeDeadRegistrations(t.prisma, dead)).toBe(2);
    expect([ended, invalid].every(t.revoked)).toBe(true);
    expect(t.revoked(rebound)).toBe(false);
    expect(t.revoked(bystander)).toBe(false);
    expect(await revokeDeadRegistrations(t.prisma, dead)).toBe(0); // second run changes nothing
  });

  it('does nothing for an empty set', async () => {
    const t = setup();
    expect(await revokeDeadRegistrations(t.prisma, new Map())).toBe(0);
  });
});
