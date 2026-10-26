import { jest } from '@jest/globals';
import { Role, UserStatus } from '../../generated/prisma/client.js';
import { buildAuthServices } from '../../testing/harness.js';

async function setup() {
  const s = buildAuthServices();
  const user = await s.prisma.user.create({
    data: { phone: '+966501234567', status: UserStatus.ACTIVE, roles: { create: [{ role: Role.CUSTOMER }] } },
  });
  return { ...s, user };
}

describe('SessionsService', () => {
  afterEach(() => jest.useRealTimers());

  it('stores only the hash of the refresh token', async () => {
    const { sessions, db, user } = await setup();
    const tokens = await sessions.create(user.id, Role.CUSTOMER, {});
    expect(db.refreshTokens).toHaveLength(1);
    expect(JSON.stringify(db.refreshTokens[0])).not.toContain(tokens.refreshToken);
    expect(db.refreshTokens[0].tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rotates: the old token is spent and the new one works', async () => {
    const { sessions, db, user } = await setup();
    const first = await sessions.create(user.id, Role.CUSTOMER, {});
    const { tokens: second } = await sessions.refresh(first.refreshToken, {});
    expect(second.refreshToken).not.toBe(first.refreshToken);
    expect(db.refreshTokens).toHaveLength(2);
    expect(db.refreshTokens[0].usedAt).toBeInstanceOf(Date);
    expect(db.refreshTokens[0].replacedById).toBe(db.refreshTokens[1].id);
    // Same session (family) throughout.
    expect(db.refreshTokens[1].familyId).toBe(db.refreshTokens[0].familyId);
    await expect(sessions.refresh(second.refreshToken, {})).resolves.toBeDefined();
  });

  it('revokes the whole session when a spent token is replayed', async () => {
    const { sessions, user } = await setup();
    const first = await sessions.create(user.id, Role.CUSTOMER, {});
    const { tokens: second } = await sessions.refresh(first.refreshToken, {});

    await expect(sessions.refresh(first.refreshToken, {})).rejects.toMatchObject({ code: 'REFRESH_TOKEN_REUSED' });
    // The thief's replay also killed the legitimate newest token.
    await expect(sessions.refresh(second.refreshToken, {})).rejects.toMatchObject({ code: 'REFRESH_TOKEN_REVOKED' });
  });

  it('rejects unknown and expired refresh tokens', async () => {
    const { sessions, user } = await setup();
    await expect(sessions.refresh('x'.repeat(43), {})).rejects.toMatchObject({ code: 'REFRESH_TOKEN_INVALID' });

    jest.useFakeTimers({ now: new Date('2026-10-22T10:00:00Z') });
    const t = await sessions.create(user.id, Role.CUSTOMER, {});
    jest.setSystemTime(new Date('2026-12-01T10:00:00Z'));
    await expect(sessions.refresh(t.refreshToken, {})).rejects.toMatchObject({ code: 'REFRESH_TOKEN_EXPIRED' });
  });

  it('revoking a session makes it inactive and blocks refresh', async () => {
    const { sessions, db, user } = await setup();
    const t = await sessions.create(user.id, Role.CUSTOMER, {});
    const sid = db.refreshTokens[0].familyId as string;
    expect(await sessions.isActive(sid, user.id)).toBe(true);

    await sessions.revokeByRefreshToken(t.refreshToken);
    expect(await sessions.isActive(sid, user.id)).toBe(false);
    await expect(sessions.refresh(t.refreshToken, {})).rejects.toMatchObject({ code: 'REFRESH_TOKEN_REVOKED' });
  });

  it('a session is not active for a different user', async () => {
    const { sessions, db, user } = await setup();
    await sessions.create(user.id, Role.CUSTOMER, {});
    expect(await sessions.isActive(db.refreshTokens[0].familyId as string, 'someone-else')).toBe(false);
  });

  it('revokeAllForUser can spare the current session', async () => {
    const { sessions, db, user } = await setup();
    await sessions.create(user.id, Role.CUSTOMER, {});
    await sessions.create(user.id, Role.CUSTOMER, {});
    const [a, b] = db.refreshTokens.map((r) => r.familyId as string);
    await sessions.revokeAllForUser(user.id, a);
    expect(await sessions.isActive(a, user.id)).toBe(true);
    expect(await sessions.isActive(b, user.id)).toBe(false);
  });

  it('refuses to refresh for a suspended account and ends the session', async () => {
    const { sessions, prisma, db, user } = await setup();
    const t = await sessions.create(user.id, Role.CUSTOMER, {});
    await prisma.user.update({ where: { id: user.id }, data: { status: UserStatus.SUSPENDED } });
    await expect(sessions.refresh(t.refreshToken, {})).rejects.toMatchObject({ code: 'ACCOUNT_NOT_ACTIVE' });
    expect(await sessions.isActive(db.refreshTokens[0].familyId as string, user.id)).toBe(false);
  });

  it('admin sessions get the shorter refresh lifetime', async () => {
    const { sessions, db, user } = await setup();
    const customer = await sessions.create(user.id, Role.CUSTOMER, {});
    const admin = await sessions.create(user.id, Role.ADMIN, {});
    expect(admin.refreshTokenExpiresAt.getTime()).toBeLessThan(customer.refreshTokenExpiresAt.getTime());
    expect(db.refreshTokens[1].sessionRole).toBe(Role.ADMIN);
  });

  describe('purgeStale', () => {
    const DAY = 24 * 3600 * 1000;

    it('deletes old expired, revoked and spent tokens but keeps live and recent ones', async () => {
      const { sessions, db, user } = await setup();
      const now = Date.now();
      const base = { userId: user.id, sessionRole: Role.CUSTOMER, createdAt: new Date(), revokedAt: null, usedAt: null, replacedById: null };
      const row = (n: string, extra: object) => ({ id: n, tokenHash: n.padEnd(64, '0'), familyId: n, expiresAt: new Date(now + 10 * DAY), ...base, ...extra });
      db.refreshTokens.push(
        row('live', {}),
        row('expired-old', { expiresAt: new Date(now - 8 * DAY) }),
        row('expired-recent', { expiresAt: new Date(now - 1 * DAY) }),
        row('revoked-old', { revokedAt: new Date(now - 9 * DAY) }),
        row('revoked-recent', { revokedAt: new Date(now - 1 * DAY) }),
        row('spent-old', { usedAt: new Date(now - 10 * DAY) }),
        row('spent-recent', { usedAt: new Date(now - 1 * DAY) }),
      );

      const result = await sessions.purgeStale(7);
      expect(result).toEqual({ expired: 1, revoked: 1, spent: 1 });
      expect(db.refreshTokens.map((r) => r.id).sort()).toEqual(['expired-recent', 'live', 'revoked-recent', 'spent-recent']);
    });

    it('is idempotent and leaves nothing to do on a clean table', async () => {
      const { sessions } = await setup();
      expect(await sessions.purgeStale()).toEqual({ expired: 0, revoked: 0, spent: 0 });
    });

    it('does not disturb an active session', async () => {
      const { sessions, db, user } = await setup();
      const t = await sessions.create(user.id, Role.CUSTOMER, {});
      await sessions.purgeStale();
      expect(await sessions.isActive(db.refreshTokens[0].familyId as string, user.id)).toBe(true);
      await expect(sessions.refresh(t.refreshToken, {})).resolves.toBeDefined();
    });
  });
});
