/**
 * Push registrations end with their session (real PostgreSQL, fake Firebase client).
 *
 * NEEDS the migration 20261101090000_device_session_binding applied to the TEST database (device_tokens.session_id). Until then the
 * migration guard stops this suite on purpose. It was written against the code but could not be run when the migration was prepared,
 * because applying migrations was out of scope: run it after the migration has been applied to a test database.
 */
import { jest } from '@jest/globals';
import { randomBytes, randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import type { Message } from 'firebase-admin/messaging';
import { NotificationDeliveryService } from '../src/modules/notifications/notification-delivery.service.js';
import { NotificationsService } from '../src/modules/notifications/notifications.service.js';
import { FcmPushProvider, type FcmMessagingClient } from '../src/modules/notifications/push/fcm-push-provider.js';
import { SessionsService } from '../src/modules/auth/sessions.service.js';
import { TokenCleanupService } from '../src/modules/auth/token-cleanup.service.js';
import { type Harness, type Session, bootHarness } from './support/bookings-harness.js';

const run = process.env['TEST_DATABASE_URL'] ? describe : describe.skip;
if (!process.env['TEST_DATABASE_URL']) console.warn('device-session-revocation.integration-spec: TEST_DATABASE_URL is not set, suite skipped');

const KEY = randomBytes(32).toString('base64');
const PROJECT = 'hs-session-test';
const SERVICE_ACCOUNT = { project_id: PROJECT, client_email: `svc@${PROJECT}.iam.gserviceaccount.com`, private_key: 'x PRIVATE KEY x TESTONLY-NOT-A-KEY' };
const SA_BASE64 = Buffer.from(JSON.stringify(SERVICE_ACCOUNT)).toString('base64');
const tok = (prefix = 'tok') => `${prefix}-${randomUUID()}-${randomUUID()}`;

class FakeFcm implements FcmMessagingClient {
  sent: Message[] = [];
  /** Runs once, inside the send call: lets a test revoke "while the push is in flight". */
  onSend?: () => Promise<void>;
  async send(message: Message): Promise<string> {
    const hook = this.onSend;
    this.onSend = undefined;
    if (hook) await hook();
    this.sent.push(message);
    return `projects/${PROJECT}/messages/${this.sent.length}`;
  }
}

run('push registrations follow their session (real PostgreSQL)', () => {
  let h: Harness;
  let fake: FakeFcm;
  let notifications: NotificationsService;
  let delivery: NotificationDeliveryService;
  let sessions: SessionsService;

  const post = (who: { accessToken: string }, path: string, body: object = {}) => h.api().post(`/api/v1${path}`).set(h.bearer(who.accessToken)).set('X-Forwarded-For', h.freshIp()).send(body);
  const register = (who: Session, token = tok()) => post(who, '/devices', { platform: 'ANDROID', provider: 'FCM', token });
  const logout = (who: Session) => h.api().post('/api/v1/auth/logout').set('X-Forwarded-For', h.freshIp()).send({ refreshToken: who.refreshToken });
  const device = (id: string) => h.prisma.deviceToken.findUniqueOrThrow({ where: { id } });
  const familyOf = async (userId: string) => (await h.prisma.refreshToken.findFirstOrThrow({ where: { userId }, orderBy: { createdAt: 'desc' } })).familyId;
  const queuePush = async (who: Session, deviceId: string) => {
    await notifications.create(h.prisma, { userId: who.userId, type: 'work.started', sourceKey: `itest:${randomUUID()}`, params: { ref: 'BK-SECRET' } });
    return h.prisma.notificationDelivery.findFirstOrThrow({ where: { targetKey: `push:${deviceId}` }, orderBy: { createdAt: 'desc' } });
  };
  const row = (id: string) => h.prisma.notificationDelivery.findUniqueOrThrow({ where: { id } });

  beforeAll(async () => {
    fake = new FakeFcm();
    h = await bootHarness({
      // Phone prefixes must be unique per suite (harness cleanup deletes every user whose number starts with it). The prefixes in use are
      // +9665971..+9665988 and +9665990..+9665999 (grep "phonePrefix\|PHONE_PREFIX" test); +9665989 was the only free one when this suite was written.
      phonePrefix: '+9665989',
      slugPrefix: 'itest-ds-',
      adminEmailPrefix: 'itest-ds-admin',
      pushProvider: new FcmPushProvider({ projectId: PROJECT, serviceAccount: SERVICE_ACCOUNT, dryRun: false }, () => fake),
      env: { PUSH_PROVIDER: 'fcm', FIREBASE_PROJECT_ID: PROJECT, FIREBASE_SERVICE_ACCOUNT_BASE64: SA_BASE64, DEVICE_TOKEN_ENCRYPTION_KEY: KEY },
    });
    notifications = h.app.get(NotificationsService);
    delivery = h.app.get(NotificationDeliveryService);
    sessions = h.app.get(SessionsService);
  });

  afterAll(async () => {
    if (h) await h.close();
  });

  it('registers the device with the caller\'s session, and rotation keeps that session', async () => {
    const a = await h.makeCustomer();
    const dev = (await register(a).expect(200)).body;
    const family = await familyOf(a.userId);
    expect(await device(dev.id)).toMatchObject({ userId: a.userId, sessionId: family });
    const refreshed = await h.api().post('/api/v1/auth/refresh').set('X-Forwarded-For', h.freshIp()).send({ refreshToken: a.refreshToken }).expect(200);
    expect((await device(dev.id)).revokedAt).toBeNull(); // rotation is not the end of the session
    await logout({ ...a, refreshToken: refreshed.body.refreshToken }).expect(204);
    expect((await device(dev.id)).revokedAt).not.toBeNull();
  });

  it('logout revokes that session\'s registration only, answers 204 as before, and a repeat or an unknown token still answers 204', async () => {
    const a = await h.makeCustomer();
    const devA = (await register(a).expect(200)).body;
    const second = await h.makeCustomer(); // another account, also registered
    const devB = (await register(second).expect(200)).body;
    await logout(a).expect(204);
    await logout(a).expect(204);
    await h.api().post('/api/v1/auth/logout').set('X-Forwarded-For', h.freshIp()).send({ refreshToken: 'x'.repeat(43) }).expect(204);
    expect((await device(devA.id)).revokedAt).not.toBeNull();
    expect((await device(devB.id)).revokedAt).toBeNull();
  });

  it('logout-all revokes every registration of the account and nobody else\'s', async () => {
    const a = await h.makeCustomer();
    const b = await h.makeCustomer();
    const devA = (await register(a).expect(200)).body;
    const devB = (await register(b).expect(200)).body;
    await post(a, '/auth/logout-all').expect(204);
    expect((await device(devA.id)).revokedAt).not.toBeNull();
    expect((await device(devB.id)).revokedAt).toBeNull();
  });

  it('a stolen-token replay (forced revocation) ends the registrations', async () => {
    const a = await h.makeCustomer();
    const dev = (await register(a).expect(200)).body;
    await h.api().post('/api/v1/auth/refresh').set('X-Forwarded-For', h.freshIp()).send({ refreshToken: a.refreshToken }).expect(200);
    await h.api().post('/api/v1/auth/refresh').set('X-Forwarded-For', h.freshIp()).send({ refreshToken: a.refreshToken }).expect(401); // spent token replayed
    expect((await device(dev.id)).revokedAt).not.toBeNull();
  });

  describe('expiry', () => {
    it('the sweep revokes registrations of an expired session; the delivery guard already refuses to send to one', async () => {
      const a = await h.makeCustomer();
      const dev = (await register(a).expect(200)).body;
      const queued = await queuePush(a, dev.id);
      await h.prisma.refreshToken.updateMany({ where: { userId: a.userId }, data: { expiresAt: new Date(Date.now() - 60_000) } }); // the session expires; nothing revokes the device
      expect((await device(dev.id)).revokedAt).toBeNull();
      const before = fake.sent.length;
      await delivery.runOnce();
      expect(await row(queued.id)).toMatchObject({ status: 'FAILED', lastError: 'SESSION_ENDED' });
      expect(fake.sent).toHaveLength(before); // never sent
      expect((await device(dev.id)).revokedAt).not.toBeNull(); // and the guard revoked it
    });

    it('the periodic job sweeps without a delivery', async () => {
      const a = await h.makeCustomer();
      const dev = (await register(a).expect(200)).body;
      await h.prisma.refreshToken.updateMany({ where: { userId: a.userId }, data: { expiresAt: new Date(Date.now() - 60_000) } });
      await h.app.get(TokenCleanupService).run();
      expect((await device(dev.id)).revokedAt).not.toBeNull();
      expect(await sessions.revokeDevicesOfEndedSessions()).toEqual({ bound: 0, legacy: expect.any(Number) }); // idempotent
    });
  });

  describe('legacy registrations (no session id)', () => {
    it('keep working while their owner has a live session, are not touched by logout of a session, and are swept once no live session remains', async () => {
      const a = await h.makeCustomer();
      const dev = (await register(a).expect(200)).body;
      await h.prisma.deviceToken.update({ where: { id: dev.id }, data: { sessionId: null } }); // as if registered before the migration
      const queued = await queuePush(a, dev.id);
      await delivery.runOnce();
      expect((await row(queued.id)).status).toBe('SENT'); // no session id: no guard, delivery as before
      await sessions.revokeDevicesOfEndedSessions();
      expect((await device(dev.id)).revokedAt).toBeNull(); // owner still signed in
      await h.prisma.refreshToken.updateMany({ where: { userId: a.userId }, data: { revokedAt: new Date() } }); // signed out some other way
      await sessions.revokeDevicesOfEndedSessions();
      expect((await device(dev.id)).revokedAt).not.toBeNull();
    });
  });

  describe('concurrency', () => {
    it('revocation during an in-flight send: that one push may complete, every later delivery sees the revocation', async () => {
      const a = await h.makeCustomer();
      const dev = (await register(a).expect(200)).body;
      const first = await queuePush(a, dev.id);
      fake.onSend = async () => {
        await logout(a).expect(204); // logout lands while the delivery transaction is sending
      };
      await delivery.runOnce();
      expect((await row(first.id)).status).toBe('SENT');
      expect((await device(dev.id)).revokedAt).not.toBeNull();
      const count = () => h.prisma.notificationDelivery.count({ where: { targetKey: `push:${dev.id}` } });
      const queuedBefore = await count();
      await notifications.create(h.prisma, { userId: a.userId, type: 'work.started', sourceKey: `itest:${randomUUID()}`, params: { ref: 'BK-SECRET' } });
      expect(await count()).toBe(queuedBefore); // no active registration left: nothing is even queued for it
      const before = fake.sent.length;
      await delivery.runOnce();
      expect(fake.sent).toHaveLength(before);
    });

    it('concurrent logouts, logout-all, a sweep and two delivery runs: explicit statuses, one consistent end state, nothing delivered after revocation', async () => {
      const a = await h.makeCustomer();
      const dev = (await register(a).expect(200)).body;
      const queued = await queuePush(a, dev.id);
      const before = fake.sent.length;
      const [logout1, logout2, logoutAll, sweep, run1, run2] = await Promise.all([
        logout(a).then((r) => r.status),
        logout(a).then((r) => r.status),
        post(a, '/auth/logout-all').then((r) => r.status),
        sessions.revokeDevicesOfEndedSessions(),
        delivery.runOnce(),
        delivery.runOnce(),
      ]);
      // Allowed outcomes, stated explicitly: logout always answers 204; logout-all is 204, or 401 when a logout already ended the session.
      expect([logout1, logout2]).toEqual([204, 204]);
      expect([204, 401]).toContain(logoutAll);
      expect(sweep).toEqual({ bound: expect.any(Number), legacy: expect.any(Number) });
      // The test database is shared, so the runs may also claim deliveries that are not ours: only require that ours was claimed (at least
      // one row in total) and judge it by its own row below. SKIP LOCKED guarantees it was claimed by one run, never both.
      expect(run1.claimed + run2.claimed).toBeGreaterThanOrEqual(1);
      expect(['QUEUED']).not.toContain((await row(queued.id)).status); // it was claimed and settled, not left waiting

      // End state in the database.
      expect((await device(dev.id)).revokedAt).not.toBeNull();
      expect(await h.prisma.refreshToken.count({ where: { userId: a.userId, revokedAt: null } })).toBe(0);
      const settled = await row(queued.id);
      if (settled.status === 'SENT') {
        expect(fake.sent.slice(before).filter((m) => m.data?.['notificationId'] === queued.notificationId)).toHaveLength(1); // the push that was already in flight
      } else {
        expect(settled).toMatchObject({ status: 'FAILED' });
        expect(['TOKEN_UNAVAILABLE', 'SESSION_ENDED']).toContain(settled.lastError);
        expect(fake.sent.slice(before).filter((m) => m.data?.['notificationId'] === queued.notificationId)).toHaveLength(0);
      }

      // After revocation nothing new is queued for the device, nothing is sent, and no SENT delivery appears.
      const sentSoFar = fake.sent.length;
      const deliveriesSoFar = await h.prisma.notificationDelivery.count({ where: { targetKey: `push:${dev.id}` } });
      await notifications.create(h.prisma, { userId: a.userId, type: 'work.started', sourceKey: `itest:${randomUUID()}`, params: { ref: 'BK-SECRET' } });
      await delivery.runOnce();
      await delivery.runOnce();
      expect(fake.sent).toHaveLength(sentSoFar);
      expect(await h.prisma.notificationDelivery.count({ where: { targetKey: `push:${dev.id}` } })).toBe(deliveriesSoFar);
    });

    it('refresh and logout racing each other never leave a live token behind', async () => {
      for (let i = 0; i < 5; i++) {
        const a = await h.makeCustomer();
        const dev = (await register(a).expect(200)).body;
        const [refresh, out] = await Promise.all([
          h.api().post('/api/v1/auth/refresh').set('X-Forwarded-For', h.freshIp()).send({ refreshToken: a.refreshToken }).then((r) => r.status),
          logout(a).then((r) => r.status),
        ]);
        expect(out).toBe(204);
        expect([200, 401]).toContain(refresh); // refresh won (200) or lost (401 REFRESH_TOKEN_REVOKED)
        expect(await h.prisma.refreshToken.count({ where: { userId: a.userId, revokedAt: null } })).toBe(0);
        expect((await device(dev.id)).revokedAt).not.toBeNull();
      }
    });

    it('registration and logout racing each other never leave an active registration behind', async () => {
      for (let i = 0; i < 5; i++) {
        const a = await h.makeCustomer();
        const token = tok('race');
        const [reg, out] = await Promise.all([register(a, token).then((r) => r.status), logout(a).then((r) => r.status)]);
        expect(out).toBe(204);
        expect([200, 401]).toContain(reg); // registered before the logout (then revoked by it) or refused because the session had ended
        expect(await h.prisma.deviceToken.count({ where: { userId: a.userId, revokedAt: null } })).toBe(0);
      }
    });
  });

  describe('ended sessions', () => {
    it('refresh after logout is refused with REFRESH_TOKEN_REVOKED, and registration after logout with SESSION_ENDED', async () => {
      const a = await h.makeCustomer();
      await logout(a).expect(204);
      const refreshed = await h.api().post('/api/v1/auth/refresh').set('X-Forwarded-For', h.freshIp()).send({ refreshToken: a.refreshToken });
      expect(refreshed.status).toBe(401);
      expect(refreshed.body.code).toBe('REFRESH_TOKEN_REVOKED');
      // the access token of an ended session is already refused by the guard, so the 401 here is the generic one; the service-level code is covered by the unit tests
      expect((await register(a)).status).toBe(401);
      expect(await h.prisma.deviceToken.count({ where: { userId: a.userId } })).toBe(0);
    });
  });

  it('never writes tokens or credentials to the logs while revoking', async () => {
    const spies = (['log', 'warn', 'error', 'debug', 'verbose'] as const).map((l) => jest.spyOn(Logger.prototype, l).mockImplementation(() => undefined));
    const token = tok('leakcheck');
    try {
      const a = await h.makeCustomer();
      await register(a, token).expect(200);
      await logout(a).expect(204);
      await sessions.revokeDevicesOfEndedSessions();
      const logged = spies.flatMap((s) => s.mock.calls.flat()).map(String).join('\n');
      for (const secret of [token, KEY, 'PRIVATE KEY']) expect(logged).not.toContain(secret);
    } finally {
      spies.forEach((s) => s.mockRestore());
    }
  });

  it('cross-account isolation over the API: another account cannot revoke or see this device', async () => {
    const a = await h.makeCustomer();
    const b = await h.makeCustomer();
    const dev = (await register(a).expect(200)).body;
    await h.api().delete(`/api/v1/devices/${dev.id}`).set(h.bearer(b.accessToken)).expect(404);
    await logout(b).expect(204);
    expect((await device(dev.id)).revokedAt).toBeNull();
  });
});
