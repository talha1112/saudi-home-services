/**
 * REAL POSTGRESQL, FULL HTTP STACK, the Firebase messaging client replaced by a fake (FakeFcm): nothing is ever sent to a device.
 * The FCM adapter (FcmPushProvider) runs for real inside the existing delivery pipeline: retries, revocation of dead tokens, ownership of
 * device tokens, redaction in logs, and independence from Firebase phone sign-in. FCM's own servers are only reachable with a real Firebase
 * project (see docs/FIREBASE_SETUP.md).
 */
import { jest } from '@jest/globals';
import { Logger } from '@nestjs/common';
import { randomBytes, randomUUID } from 'node:crypto';
import type { Message } from 'firebase-admin/messaging';
import { NotificationDeliveryService } from '../src/modules/notifications/notification-delivery.service.js';
import { NotificationsService } from '../src/modules/notifications/notifications.service.js';
import { FcmPushProvider, type FcmMessagingClient } from '../src/modules/notifications/push/fcm-push-provider.js';
import { type Harness, type Session, bootHarness } from './support/bookings-harness.js';

const run = process.env['TEST_DATABASE_URL'] ? describe : describe.skip;
if (!process.env['TEST_DATABASE_URL']) console.warn('fcm-push.integration-spec: TEST_DATABASE_URL is not set, suite skipped');

const KEY = randomBytes(32).toString('base64');
const PROJECT = 'hs-fcm-test';
const SERVICE_ACCOUNT = { project_id: PROJECT, client_email: `svc@${PROJECT}.iam.gserviceaccount.com`, private_key: 'x PRIVATE KEY x TESTONLY-NOT-A-KEY' };
const SA_BASE64 = Buffer.from(JSON.stringify(SERVICE_ACCOUNT)).toString('base64');
const tok = (prefix = 'tok') => `${prefix}-${randomUUID()}-${randomUUID()}`;

/** Behaves like Firebase for tokens that start with a scenario name; records what a good send would have delivered. */
class FakeFcm implements FcmMessagingClient {
  sent: Array<{ message: Message; dryRun: boolean | undefined }> = [];
  private n = 0;
  private readonly scenarios: Record<string, [code: string, text: string]> = {
    'unregistered-': ['messaging/registration-token-not-registered', 'Requested entity was not found.'],
    'malformed-': ['messaging/invalid-argument', 'The registration token is not a valid FCM registration token'],
    'badpayload-': ['messaging/invalid-argument', 'Invalid JSON payload received.'],
    'unavailable-': ['messaging/server-unavailable', 'The service is currently unavailable.'],
    'quota-': ['messaging/message-rate-exceeded', 'Quota exceeded.'],
    'apnsauth-': ['messaging/third-party-auth-error', 'APNs authentication failed.'],
    'authfail-': ['messaging/authentication-error', 'Request had invalid authentication credentials.'],
    'mismatch-': ['messaging/mismatched-credential', 'SenderId mismatch.'],
  };
  async send(message: Message, dryRun?: boolean): Promise<string> {
    const token = (message as { token: string }).token;
    for (const [prefix, [code, text]] of Object.entries(this.scenarios)) {
      if (token.startsWith(prefix)) throw Object.assign(new Error(`${text} (token ${token})`), { code });
    }
    this.sent.push({ message, dryRun });
    return `projects/${PROJECT}/messages/${++this.n}`;
  }
}

run('FCM push through the delivery pipeline (real PostgreSQL, fake Firebase client)', () => {
  let h: Harness;
  let hSignIn: Harness;
  let fake: FakeFcm;
  let notifications: NotificationsService;
  let delivery: NotificationDeliveryService;

  const post = (who: { accessToken: string }, path: string, body: object = {}) => h.api().post(`/api/v1${path}`).set(h.bearer(who.accessToken)).set('X-Forwarded-For', h.freshIp()).send(body);
  const get = (who: { accessToken: string }, path: string) => h.api().get(`/api/v1${path}`).set(h.bearer(who.accessToken)).set('X-Forwarded-For', h.freshIp());
  const register = (who: Session, token = tok(), platform = 'ANDROID', provider = 'FCM') => post(who, '/devices', { platform, provider, token });
  const mine = (userId: string) => h.prisma.notification.findMany({ where: { userId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });

  /** A user with one registered device and one queued push for it. */
  const queued = async (token: string, platform = 'ANDROID', provider = 'FCM') => {
    const user = await h.makeCustomer();
    const dev = (await register(user, token, platform, provider).expect(200)).body;
    await notifications.create(h.prisma, { userId: user.userId, type: 'work.started', sourceKey: `itest:${randomUUID()}`, params: { ref: 'BK-SECRET01' }, resource: { type: 'booking', id: randomUUID() } });
    const n = (await mine(user.userId))[0]!;
    const d = await h.prisma.notificationDelivery.findFirstOrThrow({ where: { notificationId: n.id } });
    return { user, dev, notification: n, delivery: d };
  };
  const row = (id: string) => h.prisma.notificationDelivery.findUniqueOrThrow({ where: { id } });

  beforeAll(async () => {
    fake = new FakeFcm();
    h = await bootHarness({
      phonePrefix: '+9665974',
      slugPrefix: 'itest-fc-',
      adminEmailPrefix: 'itest-fc-admin',
      pushProvider: new FcmPushProvider({ projectId: PROJECT, serviceAccount: SERVICE_ACCOUNT, dryRun: false }, () => fake),
      // PUSH_PROVIDER=fcm is validated for real (project, service account, device-token key); phone sign-in is NOT enabled.
      env: { PUSH_PROVIDER: 'fcm', FIREBASE_PROJECT_ID: PROJECT, FIREBASE_SERVICE_ACCOUNT_BASE64: SA_BASE64, DEVICE_TOKEN_ENCRYPTION_KEY: KEY, NOTIFICATION_MAX_ATTEMPTS: '3', MAX_DEVICE_TOKENS_PER_USER: '2' },
    });
    // The other way round: phone sign-in on, push left at its default (disabled).
    hSignIn = await bootHarness({
      phonePrefix: '+9665973',
      slugPrefix: 'itest-fs-',
      adminEmailPrefix: 'itest-fs-admin',
      env: { FIREBASE_AUTH_ENABLED: 'true', FIREBASE_PROJECT_ID: PROJECT, DEVICE_TOKEN_ENCRYPTION_KEY: KEY },
    });
    notifications = h.app.get(NotificationsService);
    delivery = h.app.get(NotificationDeliveryService);
  });

  afterAll(async () => {
    if (h) await h.close();
    if (hSignIn) await hSignIn.close();
  });

  describe('sending', () => {
    it('sends once through FCM in the recipient\'s language, records SENT with the message id, and never resends', async () => {
      const token = tok('good');
      const { user, delivery: d, notification } = await queued(token);
      await h.prisma.user.update({ where: { id: user.userId }, data: { locale: 'EN' } });
      const before = fake.sent.length;
      expect((await delivery.runOnce()).sent).toBeGreaterThanOrEqual(1);

      const after = await row(d.id);
      expect(after).toMatchObject({ status: 'SENT', attempts: 1, deliveredAt: null });
      expect(after.providerMessageId).toMatch(new RegExp(`^projects/${PROJECT}/messages/`));
      const sent = fake.sent.slice(before).find((s) => s.message.data?.['notificationId'] === notification.id)!;
      expect(sent.dryRun).toBe(false);
      expect(sent.message).toMatchObject({
        token, // decrypted from storage, handed to FCM and nowhere else
        notification: { title: 'Work has started', body: 'The worker started work on booking BK-SECRET01.' },
        data: { type: 'work.started', resourceType: 'booking' },
        android: { priority: 'high' },
      });
      const count = fake.sent.length;
      await delivery.runOnce();
      await delivery.runOnce();
      expect(fake.sent.length).toBe(count);
    });

    it('revokes a device FCM reports as unregistered, and one whose token is malformed, but keeps the others', async () => {
      const { delivery: d, dev, user } = await queued(tok('unregistered'));
      await delivery.runOnce();
      expect(await row(d.id)).toMatchObject({ status: 'FAILED', lastError: 'INVALID_TOKEN' });
      expect((await h.prisma.deviceToken.findUniqueOrThrow({ where: { id: dev.id } })).revokedAt).not.toBeNull();
      expect((await get(user, '/devices').expect(200)).body.items).toHaveLength(0);

      const bad = await queued(tok('malformed'));
      await delivery.runOnce();
      expect(await row(bad.delivery.id)).toMatchObject({ status: 'FAILED', lastError: 'INVALID_TOKEN' });
      expect((await h.prisma.deviceToken.findUniqueOrThrow({ where: { id: bad.dev.id } })).revokedAt).not.toBeNull();
    });

    it.each([['unavailable-'], ['quota-']])('retries "%s" failures with growing back-off and then gives up, without revoking the device', async (prefix) => {
      const { delivery: d, dev } = await queued(tok(prefix));
      const t0 = new Date();
      expect((await delivery.runOnce(t0)).retried).toBeGreaterThanOrEqual(1);
      let r = await row(d.id);
      expect(r).toMatchObject({ status: 'QUEUED', attempts: 1, lastError: 'TRANSIENT' });
      const gap1 = r.nextAttemptAt.getTime() - t0.getTime();
      expect(gap1).toBeGreaterThan(0);

      await delivery.runOnce(new Date(t0.getTime() + 3_600_000));
      r = await row(d.id);
      expect(r.attempts).toBe(2);
      expect(r.nextAttemptAt.getTime() - (t0.getTime() + 3_600_000)).toBeGreaterThan(gap1);

      await delivery.runOnce(new Date(t0.getTime() + 7_200_000)); // third attempt = NOTIFICATION_MAX_ATTEMPTS
      expect(await row(d.id)).toMatchObject({ status: 'FAILED', attempts: 3, lastError: 'ATTEMPTS_EXHAUSTED' });
      expect((await h.prisma.deviceToken.findUniqueOrThrow({ where: { id: dev.id } })).revokedAt).toBeNull();
    });

    it('a transient failure that clears is sent on the retry', async () => {
      const token = tok('flaky');
      const { delivery: d } = await queued(token);
      const original = fake.send.bind(fake);
      const spy = jest.spyOn(fake, 'send').mockRejectedValueOnce(Object.assign(new Error('The service is currently unavailable.'), { code: 'messaging/server-unavailable' })).mockImplementation(original);
      try {
        const t0 = new Date();
        await delivery.runOnce(t0);
        expect(await row(d.id)).toMatchObject({ status: 'QUEUED', attempts: 1 });
        await delivery.runOnce(new Date(t0.getTime() + 3_600_000));
        expect(await row(d.id)).toMatchObject({ status: 'SENT', attempts: 2, lastError: null });
      } finally {
        spy.mockRestore();
      }
    });

    it.each([['apnsauth-'], ['authfail-'], ['mismatch-'], ['badpayload-']])('"%s" (configuration or credential trouble) fails permanently and does NOT revoke the device', async (prefix) => {
      const { delivery: d, dev } = await queued(tok(prefix));
      await delivery.runOnce();
      expect(await row(d.id)).toMatchObject({ status: 'FAILED', lastError: 'PERMANENT', attempts: 1 });
      expect((await h.prisma.deviceToken.findUniqueOrThrow({ where: { id: dev.id } })).revokedAt).toBeNull(); // a misconfiguration must not wipe registrations
    });

    it('a device registered with another vendor (APNS) is a permanent failure and FCM is never asked', async () => {
      const { delivery: d } = await queued(tok('ios'), 'IOS', 'APNS');
      const before = fake.sent.length;
      await delivery.runOnce();
      expect(await row(d.id)).toMatchObject({ status: 'FAILED', lastError: 'PERMANENT' });
      expect(fake.sent.length).toBe(before);
    });

    it('never logs tokens, titles, bodies, payloads, the service account or Firebase\'s error text', async () => {
      const spies = (['log', 'warn', 'error', 'debug', 'verbose'] as const).map((l) => jest.spyOn(Logger.prototype, l).mockImplementation(() => undefined));
      try {
        const names = ['unregistered-LEAKCHECK', 'unavailable-LEAKCHECK', 'apnsauth-LEAKCHECK'];
        const items = await Promise.all(names.map((n) => queued(tok(n))));
        await delivery.runOnce();
        expect(items.length).toBe(3);
        const logged = spies.flatMap((s) => (s.mock.calls as unknown[][]).map((c) => JSON.stringify(c))).join('\n');
        expect(logged).toContain('messaging/'); // the code is there...
        for (const secret of ['LEAKCHECK', 'Work has started', 'BK-SECRET01', 'PRIVATE KEY', 'TESTONLY', 'svc@', 'Requested entity', 'APNs authentication failed', 'notificationId']) expect(logged).not.toContain(secret); // ...nothing else
      } finally {
        spies.forEach((s) => s.mockRestore());
      }
    });
  });

  describe('device tokens: ownership, refresh and revocation', () => {
    it('requires authentication, accepts no user id from the client, and the owner is always the caller', async () => {
      const token = tok('owner');
      expect((await h.api().post('/api/v1/devices').set('X-Forwarded-For', h.freshIp()).send({ platform: 'ANDROID', provider: 'FCM', token })).status).toBe(401);
      const a = await h.makeCustomer();
      const b = await h.makeCustomer();
      for (const extra of [{ userId: b.userId }, { user_id: b.userId }, { ownerId: b.userId }]) {
        expect((await post(a, '/devices', { platform: 'ANDROID', provider: 'FCM', token, ...extra })).status).toBe(400);
      }
      const dev = (await register(a, token).expect(200)).body;
      expect(JSON.stringify(dev)).not.toContain(token); // never returned
      expect(await h.prisma.deviceToken.findUniqueOrThrow({ where: { id: dev.id } })).toMatchObject({ userId: a.userId, appRole: 'CUSTOMER' });
      expect((await get(b, '/devices').expect(200)).body.items).toHaveLength(0);
    });

    it('stores tokens encrypted, refreshes idempotently, and lets only the owner revoke', async () => {
      const a = await h.makeCustomer();
      const b = await h.makeCustomer();
      const token = tok('mine');
      const first = (await register(a, token).expect(200)).body;
      const again = (await register(a, token).expect(200)).body; // refresh = same token again
      expect(again.id).toBe(first.id);
      const stored = await h.prisma.deviceToken.findUniqueOrThrow({ where: { id: first.id } });
      expect(stored.tokenCiphertext).not.toContain(token);
      expect(await h.prisma.deviceToken.count({ where: { userId: a.userId, revokedAt: null } })).toBe(1);

      expect((await h.api().delete(`/api/v1/devices/${first.id}`).set(h.bearer(b.accessToken))).status).toBe(404); // someone else's device is "not found"
      expect((await h.api().delete(`/api/v1/devices/${first.id}`)).status).toBe(401);
      await h.api().delete(`/api/v1/devices/${first.id}`).set(h.bearer(a.accessToken)).expect(204);
      expect((await get(a, '/devices').expect(200)).body.items).toHaveLength(0);
    });

    it('a token registered by another account moves there, and the previous account stops receiving pushes', async () => {
      const a = await h.makeCustomer();
      const b = await h.makeCustomer();
      const token = tok('handover');
      const devA = (await register(a, token).expect(200)).body;
      await notifications.create(h.prisma, { userId: a.userId, type: 'work.started', sourceKey: `itest:${randomUUID()}`, params: { ref: 'BK-X' } });
      const queuedForA = await h.prisma.notificationDelivery.findFirstOrThrow({ where: { targetKey: `push:${devA.id}` } });
      const devB = (await register(b, token).expect(200)).body;
      expect(devB.id).toBe(devA.id);
      expect((await h.prisma.deviceToken.findUniqueOrThrow({ where: { id: devA.id } })).userId).toBe(b.userId);
      const before = fake.sent.length;
      await delivery.runOnce();
      expect(await row(queuedForA.id)).toMatchObject({ status: 'FAILED', lastError: 'TOKEN_UNAVAILABLE' }); // A's push never reaches B's phone
      expect(fake.sent.filter((s, i) => i >= before && s.message.data?.['notificationId'] === queuedForA.notificationId)).toHaveLength(0);
    });
  });

  describe('independence from phone sign-in', () => {
    it('FCM works while phone sign-in is OFF (the endpoint answers 503)', async () => {
      expect(h.firebase.enabled).toBe(false);
      const res = await h.api().post('/api/v1/auth/firebase/phone').set('X-Forwarded-For', h.freshIp()).send({ idToken: h.firebase.mint(), app: 'customer' });
      expect(res.status).toBe(503);
      expect(res.body.code).toBe('FIREBASE_AUTH_NOT_CONFIGURED');
      const { delivery: d } = await queued(tok('independent'));
      await delivery.runOnce();
      expect((await row(d.id)).status).toBe('SENT');
    });

    it('phone sign-in works while FCM is OFF (push is disabled by default: deliveries are recorded UNSUPPORTED, nothing is attempted)', async () => {
      const phone = hSignIn.freshPhone();
      const session = (await hSignIn.api().post('/api/v1/auth/firebase/phone').set('X-Forwarded-For', hSignIn.freshIp()).send({ idToken: hSignIn.firebase.mint({ phoneNumber: phone }), app: 'customer' }).expect(200)).body;
      expect(session.user.phone).toBe(phone);
      const dev = (await hSignIn.api().post('/api/v1/devices').set(hSignIn.bearer(session.accessToken)).set('X-Forwarded-For', hSignIn.freshIp()).send({ platform: 'ANDROID', provider: 'FCM', token: tok('nopush') }).expect(200)).body;
      await hSignIn.app.get(NotificationsService).create(hSignIn.prisma, { userId: session.user.id, type: 'work.started', sourceKey: `itest:${randomUUID()}`, params: { ref: 'BK-X' } });
      const d = await hSignIn.prisma.notificationDelivery.findFirstOrThrow({ where: { targetKey: `push:${dev.id}` } });
      await hSignIn.app.get(NotificationDeliveryService).runOnce();
      expect(await hSignIn.prisma.notificationDelivery.findUniqueOrThrow({ where: { id: d.id } })).toMatchObject({ status: 'UNSUPPORTED', sentAt: null, attempts: 0 });
    });
  });
});
