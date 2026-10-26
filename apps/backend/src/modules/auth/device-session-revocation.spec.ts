import { jest } from '@jest/globals';
import { randomBytes, randomUUID } from 'node:crypto';
import type { ConfigService } from '@nestjs/config';
import type { AuthenticatedUser } from '../../common/auth/authenticated-user.js';
import { Role, UserStatus } from '../../generated/prisma/client.js';
import { buildAuthServices } from '../../testing/harness.js';
import { DeviceTokensService } from '../notifications/device-tokens.service.js';
import { TokenCleanupService } from './token-cleanup.service.js';

/**
 * Push registrations end with the session that made them. These tests run against the in-memory stand-in for the database (no real
 * PostgreSQL, no migration), so they prove the application logic and the query conditions; the SQL itself is covered by
 * test/device-session-revocation.integration-spec.ts, which needs the migration applied to a test database.
 */
async function setup() {
  const s = buildAuthServices();
  const mkUser = (phone: string, role: Role = Role.CUSTOMER) =>
    s.prisma.user.create({ data: { phone, status: UserStatus.ACTIVE, roles: { create: [{ role }] } } });
  const a = await mkUser('+966501110001');
  const b = await mkUser('+966501110002');
  const sessionOf = (refreshTokenHash: string) => s.db.refreshTokens.find((r) => r.tokenHash === refreshTokenHash)!.familyId as string;
  const familyOf = (userId: string) => s.db.refreshTokens.filter((r) => r.userId === userId).map((r) => r.familyId as string);

  /** Registers a device the way the endpoint does: bound to the caller's session. */
  const key = randomBytes(32);
  const config = { getOrThrow: () => ({ notifications: { deviceTokenKey: key, maxDevicesPerUser: 10 } }) } as unknown as ConfigService;
  const devices = new DeviceTokensService(config, s.prisma);
  const caller = (userId: string, sessionId: string, role: Role = Role.CUSTOMER): AuthenticatedUser =>
    ({ id: userId, sessionId, role }) as unknown as AuthenticatedUser;
  const register = (userId: string, sessionId: string, token = `fcm-${randomUUID()}-${randomUUID()}`, role: Role = Role.CUSTOMER) =>
    devices.register(caller(userId, sessionId, role), { platform: 'ANDROID', provider: 'FCM', token });
  const active = (userId: string) => s.db.deviceTokens.filter((d) => d.userId === userId && d.revokedAt === null);
  const legacy = (userId: string, appRole: Role = Role.CUSTOMER) =>
    s.db.deviceToken.create({
      data: { userId, platform: 'ANDROID', provider: 'FCM', tokenHash: randomUUID(), tokenCiphertext: 'x', appRole },
    });
  return { ...s, a, b, sessionOf, familyOf, register, active, legacy, devices, caller };
}

describe('push registrations follow their session', () => {
  afterEach(() => jest.useRealTimers());

  it('a registration is bound to the session that made it; re-registering the same token refreshes the binding', async () => {
    const t = await setup();
    const first = await t.sessions.create(t.a.id, Role.CUSTOMER, {});
    const [s1] = t.familyOf(t.a.id);
    const dev = await t.register(t.a.id, s1!, 'tok-shared-aaaaaaaaaaaaaaaa');
    expect(t.db.deviceTokens[0]).toMatchObject({ id: dev.id, userId: t.a.id, sessionId: s1 });
    // a new sign-in (new session) on the same phone registers the same FCM token: it now belongs to the new session
    await t.sessions.create(t.a.id, Role.CUSTOMER, {});
    const s2 = t.familyOf(t.a.id).find((f) => f !== s1)!;
    await t.register(t.a.id, s2, 'tok-shared-aaaaaaaaaaaaaaaa');
    expect(t.db.deviceTokens).toHaveLength(1);
    expect(t.db.deviceTokens[0]!.sessionId).toBe(s2);
    // ...so ending the OLD session no longer touches it
    await t.auth.logout(first.refreshToken, {});
    expect(t.active(t.a.id)).toHaveLength(1);
  });

  describe('explicit logout', () => {
    it('revokes the registrations of that session only, and the refresh tokens with them', async () => {
      const t = await setup();
      const one = await t.sessions.create(t.a.id, Role.CUSTOMER, {});
      const two = await t.sessions.create(t.a.id, Role.CUSTOMER, {});
      const [s1, s2] = t.familyOf(t.a.id) as [string, string];
      await t.register(t.a.id, s1);
      await t.register(t.a.id, s2);
      await t.auth.logout(one.refreshToken, {});
      const rows = t.db.deviceTokens;
      expect(rows.find((d) => d.sessionId === s1)!.revokedAt).toBeInstanceOf(Date);
      expect(rows.find((d) => d.sessionId === s2)!.revokedAt).toBeNull();
      expect(t.db.refreshTokens.filter((r) => r.familyId === s2).every((r) => r.revokedAt === null)).toBe(true);
      void two;
    });

    it('is idempotent: a second logout with the same token changes nothing and does not fail', async () => {
      const t = await setup();
      const one = await t.sessions.create(t.a.id, Role.CUSTOMER, {});
      await t.register(t.a.id, t.familyOf(t.a.id)[0]!);
      await t.auth.logout(one.refreshToken, {});
      const stamp = t.db.deviceTokens[0]!.revokedAt;
      await expect(t.auth.logout(one.refreshToken, {})).resolves.toBeUndefined();
      expect(t.db.deviceTokens[0]!.revokedAt).toBe(stamp);
    });

    it('keeps the public contract: logout with an unknown or malformed token still resolves quietly and revokes nothing', async () => {
      const t = await setup();
      await t.sessions.create(t.a.id, Role.CUSTOMER, {});
      await t.register(t.a.id, t.familyOf(t.a.id)[0]!);
      await expect(t.auth.logout('x'.repeat(43), {})).resolves.toBeUndefined();
      await expect(t.auth.logout('', {})).resolves.toBeUndefined();
      expect(t.active(t.a.id)).toHaveLength(1);
      expect(await t.sessions.revokeByRefreshToken('nope')).toBeNull();
    });
  });

  describe('forced session revocation', () => {
    it('replaying a spent refresh token (theft) revokes the session and its registrations', async () => {
      const t = await setup();
      const first = await t.sessions.create(t.a.id, Role.CUSTOMER, {});
      await t.register(t.a.id, t.familyOf(t.a.id)[0]!);
      await t.sessions.refresh(first.refreshToken, {});
      await expect(t.sessions.refresh(first.refreshToken, {})).rejects.toMatchObject({ code: 'REFRESH_TOKEN_REUSED' });
      expect(t.active(t.a.id)).toHaveLength(0);
    });

    it('a suspended account that tries to refresh loses its registrations', async () => {
      const t = await setup();
      const first = await t.sessions.create(t.a.id, Role.CUSTOMER, {});
      await t.register(t.a.id, t.familyOf(t.a.id)[0]!);
      await t.prisma.user.update({ where: { id: t.a.id }, data: { status: UserStatus.SUSPENDED } });
      await expect(t.sessions.refresh(first.refreshToken, {})).rejects.toMatchObject({ code: 'ACCOUNT_NOT_ACTIVE' });
      expect(t.active(t.a.id)).toHaveLength(0);
    });

    it('sign out everywhere revokes every registration; sparing one session spares only that session\'s', async () => {
      const t = await setup();
      await t.sessions.create(t.a.id, Role.CUSTOMER, {});
      await t.sessions.create(t.a.id, Role.CUSTOMER, {});
      const [s1, s2] = t.familyOf(t.a.id) as [string, string];
      await t.register(t.a.id, s1);
      await t.register(t.a.id, s2);
      await t.sessions.revokeAllForUser(t.a.id, s1);
      expect(t.active(t.a.id).map((d) => d.sessionId)).toEqual([s1]);
      await t.sessions.revokeAllForUser(t.a.id);
      expect(t.active(t.a.id)).toHaveLength(0);
    });
  });

  describe('refresh-token rotation', () => {
    it('does not touch the registrations of the continuing session; a later logout with the NEW token still revokes them', async () => {
      const t = await setup();
      const first = await t.sessions.create(t.a.id, Role.CUSTOMER, {});
      await t.register(t.a.id, t.familyOf(t.a.id)[0]!);
      const { tokens: second } = await t.sessions.refresh(first.refreshToken, {});
      const { tokens: third } = await t.sessions.refresh(second.refreshToken, {});
      expect(t.active(t.a.id)).toHaveLength(1);
      await t.auth.logout(third.refreshToken, {});
      expect(t.active(t.a.id)).toHaveLength(0);
    });
  });

  describe('expired sessions (the sweep)', () => {
    it('revokes registrations whose session has no live refresh token; leaves live sessions alone; is idempotent', async () => {
      const t = await setup();
      jest.useFakeTimers({ now: new Date('2026-10-22T10:00:00Z') });
      await t.sessions.create(t.a.id, Role.CUSTOMER, {}); // will expire
      const old = t.familyOf(t.a.id)[0]!;
      await t.register(t.a.id, old); // registered while its session is live
      jest.setSystemTime(new Date('2026-12-15T10:00:00Z'));
      await t.sessions.create(t.a.id, Role.CUSTOMER, {}); // still live
      const live = t.familyOf(t.a.id).find((f) => f !== old)!;
      await t.register(t.a.id, live);
      expect(await t.sessions.revokeDevicesOfEndedSessions()).toEqual({ bound: 1, legacy: 0 });
      expect(t.active(t.a.id).map((d) => d.sessionId)).toEqual([live]);
      expect(await t.sessions.revokeDevicesOfEndedSessions()).toEqual({ bound: 0, legacy: 0 });
    });

    it('also catches a session whose rows were purged, and works across several batches', async () => {
      const t = await setup();
      // five registrations bound to sessions that have no refresh tokens at all (purged long ago); the endpoint would refuse these, so insert directly
      for (let i = 0; i < 5; i++) {
        await t.db.deviceToken.create({
          data: { userId: t.a.id, platform: 'ANDROID', provider: 'FCM', tokenHash: randomUUID(), tokenCiphertext: 'x', appRole: Role.CUSTOMER, sessionId: randomUUID() },
        });
      }
      const live = await t.sessions.create(t.b.id, Role.CUSTOMER, {});
      await t.register(t.b.id, t.familyOf(t.b.id)[0]!);
      expect(await t.sessions.revokeDevicesOfEndedSessions(2)).toEqual({ bound: 5, legacy: 0 });
      expect(t.active(t.a.id)).toHaveLength(0);
      expect(t.active(t.b.id)).toHaveLength(1);
      void live;
    });

    it('the cleanup job sweeps BEFORE it purges, and survives a failure', async () => {
      const t = await setup();
      const order: string[] = [];
      jest.spyOn(t.sessions, 'revokeDevicesOfEndedSessions').mockImplementation(async () => (order.push('sweep'), { bound: 2, legacy: 0 }));
      jest.spyOn(t.sessions, 'purgeStale').mockImplementation(async () => (order.push('purge'), { expired: 0, revoked: 0, spent: 0 }));
      const job = new TokenCleanupService({ getOrThrow: () => ({ env: 'test' }) } as unknown as ConfigService, t.sessions);
      await job.run();
      expect(order).toEqual(['sweep', 'purge']);
      jest.spyOn(t.sessions, 'revokeDevicesOfEndedSessions').mockRejectedValue(new Error('db down'));
      await expect(job.run()).resolves.toBeUndefined();
    });
  });

  describe('cross-account isolation', () => {
    it('one account\'s logout or revocation never revokes another account\'s registrations', async () => {
      const t = await setup();
      const sa = await t.sessions.create(t.a.id, Role.CUSTOMER, {});
      await t.sessions.create(t.b.id, Role.CUSTOMER, {});
      const [fa] = t.familyOf(t.a.id) as [string];
      const [fb] = t.familyOf(t.b.id) as [string];
      await t.register(t.a.id, fa);
      await t.register(t.b.id, fb);
      await t.auth.logout(sa.refreshToken, {});
      await t.sessions.revokeAllForUser(t.a.id);
      expect(t.active(t.b.id)).toHaveLength(1);
    });

    it('another account cannot register against this session at all; and even a row that carries it (inserted directly) is not revoked by it', async () => {
      const t = await setup();
      const sa = await t.sessions.create(t.a.id, Role.CUSTOMER, {});
      const [fa] = t.familyOf(t.a.id) as [string];
      await expect(t.register(t.b.id, fa)).rejects.toMatchObject({ code: 'SESSION_ENDED' }); // the session is not B's
      await t.db.deviceToken.create({
        data: { userId: t.b.id, platform: 'ANDROID', provider: 'FCM', tokenHash: randomUUID(), tokenCiphertext: 'x', appRole: Role.CUSTOMER, sessionId: fa },
      });
      await t.auth.logout(sa.refreshToken, {});
      expect(t.active(t.b.id)).toHaveLength(1); // the user condition protects it
    });

    it('a token moved to another account is revoked with the NEW owner\'s session, not the previous one\'s', async () => {
      const t = await setup();
      const sa = await t.sessions.create(t.a.id, Role.CUSTOMER, {});
      await t.sessions.create(t.b.id, Role.CUSTOMER, {});
      await t.register(t.a.id, t.familyOf(t.a.id)[0]!, 'tok-handover-aaaaaaaaaaaaaaaa');
      await t.register(t.b.id, t.familyOf(t.b.id)[0]!, 'tok-handover-aaaaaaaaaaaaaaaa');
      await t.auth.logout(sa.refreshToken, {}); // A signs out: must not kill the device that now belongs to B
      expect(t.active(t.b.id)).toHaveLength(1);
    });
  });

  describe('registrations from before this change (no session id)', () => {
    it('are not revoked by a logout or by sparing revokeAllForUser (they cannot be attributed to a session)', async () => {
      const t = await setup();
      const s = await t.sessions.create(t.a.id, Role.CUSTOMER, {});
      await t.legacy(t.a.id);
      await t.auth.logout(s.refreshToken, {});
      await t.sessions.create(t.a.id, Role.CUSTOMER, {});
      const live = t.familyOf(t.a.id).at(-1)!;
      await t.sessions.revokeAllForUser(t.a.id, live);
      expect(t.active(t.a.id)).toHaveLength(1);
    });

    it('are revoked by "sign out everywhere"', async () => {
      const t = await setup();
      await t.sessions.create(t.a.id, Role.CUSTOMER, {});
      await t.legacy(t.a.id);
      await t.sessions.revokeAllForUser(t.a.id);
      expect(t.active(t.a.id)).toHaveLength(0);
    });

    it('are swept once their owner has no live session left in that app, and kept while one exists', async () => {
      const t = await setup();
      await t.legacy(t.a.id, Role.CUSTOMER); // A has a live CUSTOMER session below -> kept
      await t.legacy(t.a.id, Role.WORKER); // ...but no live WORKER session -> swept
      await t.legacy(t.b.id, Role.CUSTOMER); // B has no session at all -> swept
      await t.sessions.create(t.a.id, Role.CUSTOMER, {});
      expect(await t.sessions.revokeDevicesOfEndedSessions()).toEqual({ bound: 0, legacy: 2 });
      expect(t.active(t.a.id).map((d) => d.appRole)).toEqual([Role.CUSTOMER]);
      expect(t.active(t.b.id)).toHaveLength(0);
    });
  });

  describe('redaction', () => {
    it('revocation leaves no token, ciphertext or hash in the audit trail or in anything it returns', async () => {
      const t = await setup();
      const s = await t.sessions.create(t.a.id, Role.CUSTOMER, {});
      const token = `fcm-secret-${randomUUID()}-${randomUUID()}`;
      const dev = await t.register(t.a.id, t.familyOf(t.a.id)[0]!, token);
      const row = t.db.deviceTokens[0]!;
      const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
      await t.auth.logout(s.refreshToken, {});
      await t.sessions.revokeDevicesOfEndedSessions();
      const everything = JSON.stringify([t.db.auditLogs, dev, log.mock.calls]);
      for (const secret of [token, row.tokenCiphertext as string, row.tokenHash as string]) expect(everything).not.toContain(secret);
      log.mockRestore();
    });
  });
});

/** Lets whatever else is runnable make progress (but not what is blocked on a lock) before the caller continues. */
const letOthersRun = async () => {
  for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setImmediate(resolve));
};

describe('refresh versus logout: the session ends exactly once and never comes back', () => {
  async function started() {
    const t = await setup();
    const first = await t.sessions.create(t.a.id, Role.CUSTOMER, {});
    const family = t.familyOf(t.a.id)[0]!;
    await t.register(t.a.id, family);
    const liveTokens = () => t.db.refreshTokens.filter((r) => r.familyId === family && r.revokedAt === null);
    return { ...t, first, family, liveTokens };
  }

  it('logout wins: it completes first, the refresh is refused and creates no token', async () => {
    const t = await started();
    let logout: Promise<void> | undefined;
    // When the refresh asks for the session lock, a complete logout of the same session gets in first.
    t.db.hook = async (event) => {
      if (!event.startsWith('lock:session:')) return;
      t.db.hook = undefined;
      logout = t.auth.logout(t.first.refreshToken, {});
      await logout;
    };
    await expect(t.sessions.refresh(t.first.refreshToken, {})).rejects.toMatchObject({ code: 'REFRESH_TOKEN_REVOKED' });
    expect(t.db.refreshTokens).toHaveLength(1); // nothing was issued
    expect(t.liveTokens()).toHaveLength(0);
    expect(t.active(t.a.id)).toHaveLength(0);
  });

  it('refresh wins: logout waits for the rotation to commit and then revokes the NEW token too', async () => {
    const t = await started();
    let logout: Promise<void> | undefined;
    // The logout starts while the refresh is inserting the next token. It must not be able to finish before the refresh does.
    t.db.hook = async (event) => {
      if (event !== 'refreshToken.create') return;
      t.db.hook = undefined;
      logout = t.auth.logout(t.first.refreshToken, {});
      await letOthersRun();
      expect(t.db.refreshTokens.every((r) => r.revokedAt === null)).toBe(true); // the logout has not revoked anything yet: it is waiting
    };
    const { tokens: next } = await t.sessions.refresh(t.first.refreshToken, {});
    await logout;
    expect(t.db.refreshTokens).toHaveLength(2);
    expect(t.liveTokens()).toHaveLength(0); // including the token the refresh created
    expect(t.active(t.a.id)).toHaveLength(0);
    await expect(t.sessions.refresh(next.refreshToken, {})).rejects.toMatchObject({ code: 'REFRESH_TOKEN_REVOKED' });
    expect(await t.sessions.isActive(t.family, t.a.id)).toBe(false);
  });

  it('sign out everywhere racing a refresh behaves the same (refresh wins, then every token is revoked)', async () => {
    const t = await started();
    let all: Promise<void> | undefined;
    t.db.hook = async (event) => {
      if (event !== 'refreshToken.create') return;
      t.db.hook = undefined;
      all = t.sessions.revokeAllForUser(t.a.id);
      await letOthersRun();
    };
    await t.sessions.refresh(t.first.refreshToken, {});
    await all;
    expect(t.liveTokens()).toHaveLength(0);
    expect(t.active(t.a.id)).toHaveLength(0);
  });

  it('a replay of a spent token and a parallel logout both end the session without error', async () => {
    const t = await started();
    await t.sessions.refresh(t.first.refreshToken, {});
    const results = await Promise.allSettled([t.sessions.refresh(t.first.refreshToken, {}), t.auth.logout(t.first.refreshToken, {})]);
    expect(results[0]).toMatchObject({ status: 'rejected', reason: { code: 'REFRESH_TOKEN_REUSED' } });
    expect(results[1]!.status).toBe('fulfilled');
    expect(t.liveTokens()).toHaveLength(0);
  });
});

describe('registration versus logout: a device cannot be registered against an ended session', () => {
  async function started() {
    const t = await setup();
    const first = await t.sessions.create(t.a.id, Role.CUSTOMER, {});
    return { ...t, first, family: t.familyOf(t.a.id)[0]! };
  }

  it('is refused after the session was revoked (401 SESSION_ENDED) and registers nothing', async () => {
    const t = await started();
    await t.auth.logout(t.first.refreshToken, {});
    await expect(t.register(t.a.id, t.family)).rejects.toMatchObject({ code: 'SESSION_ENDED' });
    expect(t.db.deviceTokens).toHaveLength(0);
  });

  it('is refused after the session expired', async () => {
    jest.useFakeTimers({ now: new Date('2026-10-22T10:00:00Z') });
    try {
      const t = await started();
      jest.setSystemTime(new Date('2026-12-30T10:00:00Z'));
      await expect(t.register(t.a.id, t.family)).rejects.toMatchObject({ code: 'SESSION_ENDED' });
      expect(t.db.deviceTokens).toHaveLength(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it('cannot reactivate a revoked registration through an ended session', async () => {
    const t = await started();
    const token = 'tok-reactivate-aaaaaaaaaaaaaaaa';
    await t.register(t.a.id, t.family, token);
    await t.auth.logout(t.first.refreshToken, {});
    expect(t.active(t.a.id)).toHaveLength(0);
    await expect(t.register(t.a.id, t.family, token)).rejects.toMatchObject({ code: 'SESSION_ENDED' });
    expect(t.db.deviceTokens[0]!.revokedAt).toBeInstanceOf(Date);
  });

  it('a live session can register and re-register (and a different live session can take the token over)', async () => {
    const t = await started();
    const token = 'tok-live-aaaaaaaaaaaaaaaaaaaa';
    await t.register(t.a.id, t.family, token);
    await t.register(t.a.id, t.family, token);
    await t.sessions.create(t.a.id, Role.CUSTOMER, {});
    const other = t.familyOf(t.a.id).find((f) => f !== t.family)!;
    await t.register(t.a.id, other, token);
    expect(t.active(t.a.id)).toHaveLength(1);
    expect(t.db.deviceTokens[0]!.sessionId).toBe(other);
  });

  it('logout wins the race: registration that was already waiting is refused', async () => {
    const t = await started();
    let logout: Promise<void> | undefined;
    // As the registration asks for its first lock, a complete logout of the session gets in first.
    t.db.hook = async (event) => {
      if (!event.startsWith('lock:')) return;
      t.db.hook = undefined;
      logout = t.auth.logout(t.first.refreshToken, {});
      await logout;
    };
    await expect(t.register(t.a.id, t.family)).rejects.toMatchObject({ code: 'SESSION_ENDED' });
    expect(t.active(t.a.id)).toHaveLength(0);
  });

  it('registration wins the race: the logout waits, then revokes the device that was just registered', async () => {
    const t = await started();
    let logout: Promise<void> | undefined;
    t.db.hook = async (event) => {
      if (event !== 'deviceToken.upsert') return;
      t.db.hook = undefined;
      logout = t.auth.logout(t.first.refreshToken, {});
      await letOthersRun();
      expect(t.db.refreshTokens.every((r) => r.revokedAt === null)).toBe(true); // logout is waiting for the registration's locks
    };
    const device = await t.register(t.a.id, t.family);
    await logout;
    expect(t.db.deviceTokens.find((d) => d.id === device.id)!.revokedAt).toBeInstanceOf(Date);
    expect(t.active(t.a.id)).toHaveLength(0);
  });

  it('sign out everywhere racing a registration also leaves nothing active', async () => {
    const t = await started();
    let all: Promise<void> | undefined;
    t.db.hook = async (event) => {
      if (event !== 'deviceToken.upsert') return;
      t.db.hook = undefined;
      all = t.sessions.revokeAllForUser(t.a.id);
      await letOthersRun();
    };
    await t.register(t.a.id, t.family);
    await all;
    expect(t.active(t.a.id)).toHaveLength(0);
  });
});
