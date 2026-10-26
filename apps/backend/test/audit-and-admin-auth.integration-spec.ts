/**
 * REAL POSTGRESQL, FULL HTTP STACK.
 *  1. audit_logs is append-only at the database (migration 20261030090000_audit_log_integrity) and the application still works.
 *  2. Administrator sign-in stays email + password only, with generic errors and brute-force limits per address, per account and
 *     per client, and nothing secret reaches the audit trail.
 */
import { randomUUID } from 'node:crypto';
import { PasswordService } from '../src/modules/auth/password.service.js';
import { Role, UserStatus } from '../src/generated/prisma/client.js';
import { ADMIN_PASSWORD, type Harness, bootHarness } from './support/bookings-harness.js';

const run = process.env['TEST_DATABASE_URL'] ? describe : describe.skip;
if (!process.env['TEST_DATABASE_URL']) console.warn('audit-and-admin-auth.integration-spec: TEST_DATABASE_URL is not set, suite skipped');

const ADMIN_EMAIL_PREFIX = 'itest-ai-admin';

run('audit-log integrity and administrator sign-in (real PostgreSQL)', () => {
  let h: Harness;
  let passwords: PasswordService;

  beforeAll(async () => {
    h = await bootHarness({ phonePrefix: '+9665987', slugPrefix: 'itest-ai-', adminEmailPrefix: ADMIN_EMAIL_PREFIX });
    passwords = h.app.get(PasswordService);
  });

  afterAll(async () => {
    if (h) await h.close();
  });

  const login = (email: string, password: string, ip = h.freshIp()) =>
    h.api().post('/api/v1/auth/admin/login').set('X-Forwarded-For', ip).send({ email, password });
  const newEmail = (tag: string) => `${ADMIN_EMAIL_PREFIX}-${tag}-${randomUUID().slice(0, 8)}@example.com`;
  const newAdmin = async (tag: string) => {
    const email = newEmail(tag);
    const user = await h.prisma.user.create({
      data: { email, passwordHash: await passwords.hash(ADMIN_PASSWORD), status: UserStatus.ACTIVE, roles: { create: [{ role: Role.ADMIN }] } },
    });
    return { email, id: user.id };
  };
  const sample = async (action = 'itest.audit.sample', actorUserId?: string) =>
    h.prisma.auditLog.create({ data: { action, entityType: 'itest', entityId: randomUUID(), metadata: { note: 'sample' }, actorUserId } });

  describe('audit_logs is append-only', () => {
    it('refuses to change what an entry says, who did it, or when', async () => {
      const admin = await newAdmin('upd');
      const row = await sample('itest.audit.immutable', admin.id);
      await expect(h.prisma.auditLog.update({ where: { id: row.id }, data: { action: 'itest.audit.rewritten' } })).rejects.toThrow(/append-only/);
      await expect(h.prisma.auditLog.update({ where: { id: row.id }, data: { metadata: { note: 'edited' } } })).rejects.toThrow(/append-only/);
      await expect(h.prisma.auditLog.update({ where: { id: row.id }, data: { createdAt: new Date(0) } })).rejects.toThrow(/append-only/);
      const other = await newAdmin('upd2');
      await expect(h.prisma.auditLog.update({ where: { id: row.id }, data: { actorUserId: other.id } })).rejects.toThrow(/append-only/); // no re-attribution
      await expect(h.prisma.auditLog.updateMany({ where: { id: row.id }, data: { ipAddress: '1.2.3.4' } })).rejects.toThrow(/append-only/);
      const unchanged = await h.prisma.auditLog.findUniqueOrThrow({ where: { id: row.id } });
      expect(unchanged).toEqual(row);
    });

    it('refuses to delete entries, singly, in bulk or by truncating the table', async () => {
      const row = await sample();
      await expect(h.prisma.auditLog.delete({ where: { id: row.id } })).rejects.toThrow(/append-only/);
      await expect(h.prisma.auditLog.deleteMany({ where: { id: row.id } })).rejects.toThrow(/append-only/);
      await expect(
        h.prisma.$transaction(async (tx) => {
          await tx.$executeRawUnsafe('TRUNCATE TABLE audit_logs');
          throw new Error('rolled back on purpose');
        }),
      ).rejects.toThrow(/append-only/); // if the trigger were missing this would be "rolled back on purpose" and nothing is lost either way
      expect(await h.prisma.auditLog.count({ where: { id: row.id } })).toBe(1);
    });

    it('refuses to hide who acted while pretending a user was removed (clearing the actor may not change anything else)', async () => {
      const admin = await newAdmin('mix');
      const row = await sample('itest.audit.mixed', admin.id);
      await expect(h.prisma.auditLog.update({ where: { id: row.id }, data: { actorUserId: null, action: 'itest.audit.other' } })).rejects.toThrow(/append-only/);
      await expect(h.prisma.auditLog.update({ where: { id: row.id }, data: { actorUserId: null, metadata: {} } })).rejects.toThrow(/append-only/);
      expect((await h.prisma.auditLog.findUniqueOrThrow({ where: { id: row.id } })).actorUserId).toBe(admin.id);
    });

    it('still lets an account be removed: the entry stays, only its link to the user is cleared', async () => {
      const admin = await newAdmin('del');
      const row = await sample('itest.audit.survives', admin.id);
      await h.prisma.user.delete({ where: { id: admin.id } });
      const after = await h.prisma.auditLog.findUniqueOrThrow({ where: { id: row.id } });
      expect(after.actorUserId).toBeNull();
      expect({ ...after, actorUserId: row.actorUserId }).toEqual(row);
    });

    it('is still written by the application (sign-in and failed sign-in are recorded)', async () => {
      const admin = await newAdmin('app');
      await login(admin.email, 'definitely-wrong-Password-1').expect(401);
      await login(admin.email, ADMIN_PASSWORD).expect(200);
      const actions = (await h.prisma.auditLog.findMany({ where: { actorUserId: admin.id }, select: { action: true } })).map((r) => r.action);
      expect(actions).toEqual(expect.arrayContaining(['admin.login_failed', 'admin.login']));
    });
  });

  describe('administrator sign-in is email and password only', () => {
    it('answers a wrong password, an unknown address and a non-administrator identically', async () => {
      const admin = await newAdmin('same');
      const customerEmail = newEmail('cust');
      await h.prisma.user.create({
        data: { email: customerEmail, passwordHash: await passwords.hash(ADMIN_PASSWORD), status: UserStatus.ACTIVE, roles: { create: [{ role: Role.CUSTOMER }] } },
      });
      const shape = (res: { status: number; body: Record<string, unknown> }) => ({ status: res.status, code: res.body['code'], message: res.body['message'], error: res.body['error'] });
      const wrong = shape(await login(admin.email, 'definitely-wrong-Password-1'));
      const unknown = shape(await login(newEmail('nobody'), ADMIN_PASSWORD));
      const notAdmin = shape(await login(customerEmail, ADMIN_PASSWORD)); // correct password, but not an administrator
      expect(wrong).toEqual({ status: 401, code: 'INVALID_CREDENTIALS', message: 'Email or password is incorrect', error: expect.any(String) });
      expect(unknown).toEqual(wrong);
      expect(notAdmin).toEqual(wrong);
    });

    it('needs nothing beyond email and password: an extra second-factor field changes nothing', async () => {
      const admin = await newAdmin('nomfa');
      const res = await h.api().post('/api/v1/auth/admin/login').set('X-Forwarded-For', h.freshIp()).send({ email: admin.email, password: ADMIN_PASSWORD }).expect(200);
      expect(res.body.accessToken).toEqual(expect.any(String));
      expect(res.body.refreshToken).toEqual(expect.any(String));
      const wrongWithCode = await h.api().post('/api/v1/auth/admin/login').set('X-Forwarded-For', h.freshIp()).send({ email: admin.email, password: 'wrong-Password-12', mfaCode: '000000' });
      expect(wrongWithCode.status).toBe(401); // a made-up code never rescues a wrong password
    });

    it('locks one address after 5 failures, even for the right password, without locking other addresses', async () => {
      const admin = await newAdmin('ip');
      const ip = h.freshIp();
      for (let i = 0; i < 5; i++) await login(admin.email, 'wrong-Password-12', ip).expect(401);
      const locked = await login(admin.email, ADMIN_PASSWORD, ip);
      expect(locked.status).toBe(429);
      expect(locked.body.code).toBe('LOGIN_LOCKED');
      expect(locked.body.retryAfterSeconds).toBeGreaterThan(0);
      expect((await login(admin.email, ADMIN_PASSWORD)).status).toBe(200); // a different address is not locked by this one
    });

    it('locks one account after 20 failures spread over many addresses', async () => {
      const admin = await newAdmin('acct');
      for (let i = 0; i < 20; i++) await login(admin.email, 'wrong-Password-12', h.freshIp()).expect(401); // each address stays under its own limit
      const locked = await login(admin.email, ADMIN_PASSWORD, h.freshIp());
      expect(locked.status).toBe(429);
      expect(locked.body.code).toBe('LOGIN_LOCKED');
      const other = await newAdmin('acct-other');
      expect((await login(other.email, ADMIN_PASSWORD)).status).toBe(200); // other accounts are unaffected
    });

    it('records failures and successes without any password or token', async () => {
      const admin = await newAdmin('leak');
      const secretGuess = 'Guess-That-Must-Never-Be-Logged-9';
      await login(admin.email, secretGuess).expect(401);
      const ok = await login(admin.email, ADMIN_PASSWORD).expect(200);
      await h.api().post('/api/v1/auth/refresh').set('X-Forwarded-For', h.freshIp()).send({ refreshToken: ok.body.refreshToken }).expect(200);
      const rows = await h.prisma.auditLog.findMany({ where: { actorUserId: admin.id } });
      expect(rows.length).toBeGreaterThanOrEqual(2);
      const dump = JSON.stringify(rows);
      for (const secret of [secretGuess, ADMIN_PASSWORD, ok.body.accessToken, ok.body.refreshToken]) expect(dump).not.toContain(secret);
    });

    it('rotates the refresh token and revokes the whole session when an old one is replayed', async () => {
      const admin = await newAdmin('rot');
      const first = (await login(admin.email, ADMIN_PASSWORD).expect(200)).body;
      const second = (await h.api().post('/api/v1/auth/refresh').set('X-Forwarded-For', h.freshIp()).send({ refreshToken: first.refreshToken }).expect(200)).body;
      expect(second.refreshToken).not.toBe(first.refreshToken);
      await h.api().post('/api/v1/auth/refresh').set('X-Forwarded-For', h.freshIp()).send({ refreshToken: first.refreshToken }).expect(401); // replay
      await h.api().post('/api/v1/auth/refresh').set('X-Forwarded-For', h.freshIp()).send({ refreshToken: second.refreshToken }).expect(401); // family revoked
    });
  });
});
