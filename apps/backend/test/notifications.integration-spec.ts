/**
 * REAL POSTGRESQL: durable notifications, the outbox-to-notification path (after commit, idempotent, retried),
 * the push delivery pipeline with a test double, and device-token ownership.
 */
import { jest } from '@jest/globals';
import { Logger } from '@nestjs/common';
import { randomBytes, randomUUID } from 'node:crypto';
import { recordEvent } from '../src/modules/bookings/booking-support.js';
import { NotificationDeliveryService } from '../src/modules/notifications/notification-delivery.service.js';
import { NotificationsService } from '../src/modules/notifications/notifications.service.js';
import { DisabledPushProvider, MockPushProvider, PushProvider } from '../src/modules/notifications/push/push-provider.js';
import { OutboxDispatcherService } from '../src/modules/realtime/jobs/outbox-dispatcher.service.js';
import { type Harness, type Session, type Worker, bootHarness } from './support/bookings-harness.js';

const run = process.env['TEST_DATABASE_URL'] ? describe : describe.skip;
if (!process.env['TEST_DATABASE_URL']) console.warn('notifications.integration-spec: TEST_DATABASE_URL is not set, suite skipped');

const KEY = randomBytes(32).toString('base64');
const tok = (prefix = 'tok') => `${prefix}-${randomUUID()}-${randomUUID()}`;

run('notifications, delivery pipeline and devices (real PostgreSQL)', () => {
  let h: Harness;
  let dispatcher: OutboxDispatcherService;
  let notifications: NotificationsService;
  let delivery: NotificationDeliveryService;
  let push: MockPushProvider;

  const get = (who: { accessToken: string }, path: string) => h.api().get(`/api/v1${path}`).set(h.bearer(who.accessToken)).set('X-Forwarded-For', h.freshIp());
  const post = (who: { accessToken: string }, path: string, body: object = {}) => h.api().post(`/api/v1${path}`).set(h.bearer(who.accessToken)).set('X-Forwarded-For', h.freshIp()).send(body);
  const mine = (userId: string) => h.prisma.notification.findMany({ where: { userId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
  const register = (who: Session, token = tok(), platform = 'ANDROID', provider = 'FCM') => post(who, '/devices', { platform, provider, token });

  beforeAll(async () => {
    h = await bootHarness({
      phonePrefix: '+9665982',
      slugPrefix: 'itest-nt-',
      adminEmailPrefix: 'itest-nt-admin',
      realtime: { listen: true },
      env: { PUSH_PROVIDER: 'mock', DEVICE_TOKEN_ENCRYPTION_KEY: KEY, NOTIFICATION_MAX_ATTEMPTS: '3', MAX_DEVICE_TOKENS_PER_USER: '2' },
    });
    await h.seedReferenceData();
    dispatcher = h.app.get(OutboxDispatcherService);
    notifications = h.app.get(NotificationsService);
    delivery = h.app.get(NotificationDeliveryService);
    push = h.app.get(PushProvider) as MockPushProvider;
    expect(push).toBeInstanceOf(MockPushProvider);
  });

  afterAll(async () => {
    if (h) await h.close();
  });

  describe('events create notifications after commit, exactly once, for the right people', () => {
    it('maps the booking journey to recipients, never notifies the actor, and puts only safe parameters in the row', async () => {
      const { customer, worker, booking } = await h.confirmedBooking();
      expect(await mine(customer.userId)).toHaveLength(0); // nothing exists until the committed events are dispatched
      expect(await mine(worker.userId)).toHaveLength(0);

      await dispatcher.runOnce();
      const c = await mine(customer.userId);
      const w = await mine(worker.userId);
      expect(c.map((n) => n.type).sort()).toEqual(['payment.confirmed', 'quote.received']);
      expect(w.map((n) => n.type).sort()).toEqual(['payment.confirmed', 'quote.accepted']); // the customer who accepted the quote is not told about it
      const ref = (await h.prisma.booking.findUniqueOrThrow({ where: { id: booking.id } })).reference;
      for (const n of [...c, ...w]) {
        expect(n.params).toEqual({ ref });
        expect(n).toMatchObject({ resourceType: 'booking', resourceId: booking.id });
        expect(JSON.stringify(n)).not.toMatch(/amount|price|halalas|address|phone|@/i);
      }

      await h.startWork(worker, booking.id).expect(200);
      await h.completeWork(worker, booking.id).expect(200);
      await dispatcher.runOnce();
      expect((await mine(customer.userId)).map((n) => n.type)).toEqual(expect.arrayContaining(['work.started', 'work.completed']));
      expect((await mine(worker.userId)).map((n) => n.type)).not.toContain('work.started'); // the worker did it
    });

    it('notifies the other participant of a cancellation, and both when the cancellation has no participant actor', async () => {
      const a = await h.confirmedBooking();
      await h.cancelBooking(a.customer, a.booking.id).expect(200);
      await dispatcher.runOnce();
      expect((await mine(a.worker.userId)).map((n) => n.type)).toContain('booking.cancelled');
      expect((await mine(a.customer.userId)).map((n) => n.type)).not.toContain('booking.cancelled');

      const b = await h.confirmedBooking();
      await h.api().post(`/api/v1/admin/bookings/${b.booking.id}/cancel`).set(h.bearer(h.adminToken)).send({ note: 'itest admin cancel' }).expect(200);
      await dispatcher.runOnce();
      expect((await mine(b.customer.userId)).map((n) => n.type)).toContain('booking.cancelled');
      expect((await mine(b.worker.userId)).map((n) => n.type)).toContain('booking.cancelled');
    });

    it('creates nothing for events that were rolled back, and nothing for other people\'s bookings', async () => {
      const p = await h.confirmedBooking();
      await dispatcher.runOnce();
      const before = await h.prisma.notification.count();
      await expect(
        h.prisma.$transaction(async (tx) => {
          await recordEvent(tx, { bookingId: p.booking.id, type: 'WORK_STARTED', fromStatus: 'CONFIRMED', toStatus: 'IN_PROGRESS' });
          throw new Error('rollback');
        }),
      ).rejects.toThrow('rollback');
      await dispatcher.runOnce();
      expect(await h.prisma.notification.count()).toBe(before);
    });

    it('is idempotent: redelivering the same event, or racing dispatchers, creates no duplicates', async () => {
      const p = await h.confirmedBooking();
      await h.prisma.realtimeOutboxEvent.updateMany({ where: { bookingId: p.booking.id }, data: { dispatchedAt: null, attempts: 0, nextAttemptAt: new Date() } }); // pretend nothing was delivered
      await Promise.all([dispatcher.runOnce(), dispatcher.runOnce(), dispatcher.runOnce()]);
      const counts = await mine(p.customer.userId);
      await h.prisma.realtimeOutboxEvent.updateMany({ where: { bookingId: p.booking.id }, data: { dispatchedAt: null, attempts: 0, nextAttemptAt: new Date() } }); // and again
      await dispatcher.runOnce();
      expect(await mine(p.customer.userId)).toHaveLength(counts.length);
      const event = await h.prisma.bookingEvent.findFirstOrThrow({ where: { bookingId: p.booking.id, type: 'PAYMENT_CONFIRMED' } });
      expect(await notifications.createFromBookingEvent({ eventId: event.id, bookingId: p.booking.id, type: 'PAYMENT_CONFIRMED' })).toBe(0);
      // the database itself refuses a second row for the same user and event
      await expect(
        h.prisma.notification.create({ data: { userId: p.customer.userId, type: 'payment.confirmed', sourceKey: `booking-event:${event.id}`, params: {} } }),
      ).rejects.toThrow();
    });

    it('retries after a failure and still ends with exactly one notification per recipient', async () => {
      const p = await h.confirmedBooking();
      await dispatcher.runOnce();
      await h.prisma.$transaction((tx) => recordEvent(tx, { bookingId: p.booking.id, type: 'WORK_STARTED', fromStatus: 'CONFIRMED', toStatus: 'IN_PROGRESS' }));
      const spy = jest.spyOn(NotificationsService.prototype, 'createFromBookingEvent').mockRejectedValueOnce(new Error('DB_HICCUP'));
      try {
        const now = new Date();
        expect(await dispatcher.runOnce(now)).toMatchObject({ failed: 1, delivered: 0 });
        expect((await mine(p.customer.userId)).filter((n) => n.type === 'work.started')).toHaveLength(0);
        expect(await dispatcher.runOnce(new Date(now.getTime() + 120_000))).toMatchObject({ delivered: 1 });
      } finally {
        spy.mockRestore();
      }
      expect((await mine(p.customer.userId)).filter((n) => n.type === 'work.started')).toHaveLength(1);
    });
  });

  describe('worker verification decisions', () => {
    it('notifies the worker inside the decision transaction, without the reviewer\'s note, and nothing when the decision fails', async () => {
      const worker = await h.makeWorker([], [], 'UNDER_REVIEW');
      const other = await h.makeWorker([], [], 'UNDER_REVIEW');
      const reject = await post({ accessToken: h.adminToken }, `/admin/workers/${worker.workerId}/reject`, { reason: 'The scan of the document is unreadable - SECRET-NOTE' });
      expect(reject.status).toBe(200);
      const rows = await mine(worker.userId);
      expect(rows.map((n) => n.type)).toEqual(['verification.rejected']);
      expect(JSON.stringify(rows)).not.toContain('SECRET-NOTE');
      expect(await mine(other.userId)).toHaveLength(0);

      const again = await post({ accessToken: h.adminToken }, `/admin/workers/${worker.workerId}/reject`, { reason: 'twice' });
      expect(again.status).toBe(409);
      expect(await mine(worker.userId)).toHaveLength(1); // the failed decision left nothing behind

      const view = await get(worker, '/notifications?locale=en');
      expect(view.body.items[0]).toMatchObject({ type: 'verification.rejected', title: 'Verification was not approved' });
      expect(JSON.stringify(view.body)).not.toContain('SECRET-NOTE');
    });
  });

  describe('reading my notifications', () => {
    let customer: Session;
    let worker: Worker;

    beforeAll(async () => {
      const p = await h.confirmedBooking();
      customer = p.customer;
      worker = p.worker;
      await h.startWork(worker, p.booking.id).expect(200);
      await h.completeWork(worker, p.booking.id).expect(200);
      await dispatcher.runOnce();
    });

    it('lists only my own notifications, newest first, paginated, with localized text', async () => {
      const all = await get(customer, '/notifications?limit=100').expect(200);
      expect(all.body.items.length).toBeGreaterThanOrEqual(4);
      const dates = all.body.items.map((i: { createdAt: string }) => i.createdAt);
      expect([...dates].sort().reverse()).toEqual(dates);
      const ids = new Set(all.body.items.map((i: { id: string }) => i.id));
      const workerIds = (await get(worker, '/notifications?limit=100').expect(200)).body.items.map((i: { id: string }) => i.id);
      expect(workerIds.some((id: string) => ids.has(id))).toBe(false);

      const first = await get(customer, '/notifications?limit=2&page=1').expect(200);
      const second = await get(customer, '/notifications?limit=2&page=2').expect(200);
      expect(first.body.meta).toMatchObject({ page: 1, limit: 2, total: all.body.meta.total });
      expect([...first.body.items, ...second.body.items].map((i: { id: string }) => i.id)).toEqual(all.body.items.slice(0, 4).map((i: { id: string }) => i.id));

      const item = all.body.items[0];
      expect(Object.keys(item).sort()).toEqual(['body', 'createdAt', 'id', 'read', 'readAt', 'resource', 'title', 'type']);
      expect(item.title).toMatch(/[؀-ۿ]/); // Arabic by default
      const en = await get(customer, '/notifications?limit=1&locale=en').expect(200);
      expect(en.body.items[0].title).not.toMatch(/[؀-ۿ]/);
      await h.prisma.user.update({ where: { id: customer.userId }, data: { locale: 'EN' } });
      expect((await get(customer, '/notifications?limit=1').expect(200)).body.items[0].title).not.toMatch(/[؀-ۿ]/); // the stored preference applies
      expect((await get(customer, '/notifications?locale=ar&limit=1').expect(200)).body.items[0].title).toMatch(/[؀-ۿ]/); // an explicit override wins
      expect((await get(customer, '/notifications?locale=fr')).status).toBe(400);
    });

    it('counts, filters and marks as read, only for my own notifications', async () => {
      const unread0 = (await get(customer, '/notifications/unread-count').expect(200)).body.unread;
      expect(unread0).toBeGreaterThan(0);
      const list = (await get(customer, '/notifications?unread=true&limit=100').expect(200)).body;
      expect(list.meta.total).toBe(unread0);

      const target = list.items[0];
      const read = await post(customer, `/notifications/${target.id}/read`).expect(200);
      expect(read.body).toMatchObject({ id: target.id, read: true });
      const readAt = read.body.readAt;
      expect((await post(customer, `/notifications/${target.id}/read`).expect(200)).body.readAt).toBe(readAt); // idempotent: the first time stays
      expect((await get(customer, '/notifications/unread-count').expect(200)).body.unread).toBe(unread0 - 1);

      // somebody else's notification: not found, and untouched
      const theirs = (await get(worker, '/notifications?unread=true&limit=1').expect(200)).body.items[0];
      expect((await post(customer, `/notifications/${theirs.id}/read`)).status).toBe(404);
      expect((await post(customer, `/notifications/${randomUUID()}/read`)).status).toBe(404);
      expect((await h.prisma.notification.findUniqueOrThrow({ where: { id: theirs.id } })).readAt).toBeNull();

      const all = await post(customer, '/notifications/read-all').expect(200);
      expect(all.body.updated).toBe(unread0 - 1);
      expect((await get(customer, '/notifications/unread-count').expect(200)).body.unread).toBe(0);
      expect((await get(worker, '/notifications/unread-count').expect(200)).body.unread).toBeGreaterThan(0); // the worker's are untouched
    });

    it('requires authentication and a customer or worker role, and ignores any recipient the client names', async () => {
      await h.api().get('/api/v1/notifications').expect(401);
      expect((await get({ accessToken: h.adminToken }, '/notifications')).status).toBe(403);
      const res = await get(customer, `/notifications?userId=${worker.userId}`);
      expect(res.status).toBe(400); // unknown query parameters are rejected
      const body = await post(customer, '/notifications/read-all', { userId: worker.userId });
      expect(body.status).toBe(200); // the body is ignored; only the caller's own rows could change
      expect((await get(worker, '/notifications/unread-count').expect(200)).body.unread).toBeGreaterThan(0);
    });

    it('renders an unknown or newer notification type as a generic message instead of failing', async () => {
      await h.prisma.notification.create({ data: { userId: customer.userId, type: 'something.new', sourceKey: `itest:${randomUUID()}`, params: {} } });
      const res = await get(customer, '/notifications?limit=1&locale=en').expect(200);
      expect(res.body.items[0]).toMatchObject({ type: 'something.new', title: 'Update' });
    });
  });

  describe('device tokens', () => {
    it('registers for the caller only, never returns the token, and stores it encrypted', async () => {
      const customer = await h.makeCustomer();
      const token = tok('secret-device-token');
      const res = await register(customer, token).expect(200);
      expect(res.body).toMatchObject({ platform: 'ANDROID', provider: 'FCM', app: 'CUSTOMER' });
      expect(JSON.stringify(res.body)).not.toContain(token);
      const row = await h.prisma.deviceToken.findUniqueOrThrow({ where: { id: res.body.id } });
      expect(row.userId).toBe(customer.userId);
      expect(row.tokenCiphertext).not.toContain(token);
      expect(JSON.stringify(row)).not.toContain(token);
      expect(JSON.stringify((await get(customer, '/devices').expect(200)).body)).not.toContain(token);
      expect((await register(customer, token).expect(200)).body.id).toBe(res.body.id); // idempotent
      expect(await h.prisma.deviceToken.count({ where: { userId: customer.userId } })).toBe(1);
    });

    it('validates input, requires authentication, and refuses impossible platform/provider pairs', async () => {
      const customer = await h.makeCustomer();
      await h.api().post('/api/v1/devices').send({ platform: 'ANDROID', provider: 'FCM', token: tok() }).expect(401);
      expect((await register(customer, tok(), 'ANDROID', 'APNS')).status).toBe(400);
      expect((await register(customer, tok(), 'HUAWEI', 'FCM')).status).toBe(400);
      expect((await register(customer, tok(), 'IOS', 'HMS')).status).toBe(400);
      expect((await register(customer, tok(), 'IOS', 'APNS')).status).toBe(200);
      expect((await register(customer, tok(), 'HUAWEI', 'HMS')).status).toBe(200);
      expect((await post(customer, '/devices', { platform: 'ANDROID', provider: 'FCM', token: 'short' })).status).toBe(400);
      expect((await post(customer, '/devices', { platform: 'ANDROID', provider: 'FCM', token: 'has a space in it 1234' })).status).toBe(400);
      expect((await post(customer, '/devices', { platform: 'ANDROID', provider: 'FCM', token: tok(), userId: randomUUID() })).status).toBe(400); // no owner field is accepted
      expect((await post({ accessToken: h.adminToken }, '/devices', { platform: 'ANDROID', provider: 'FCM', token: tok() })).status).toBe(403);
    });

    it('moves a token to the account that registers it, and lets only the owner revoke', async () => {
      const first = await h.makeCustomer();
      const second = await h.makeWorker([], []);
      const token = tok();
      const a = (await register(first, token).expect(200)).body;
      const b = (await register(second, token).expect(200)).body;
      expect(b.id).toBe(a.id);
      expect((await get(first, '/devices').expect(200)).body.items).toHaveLength(0); // the previous account no longer receives pushes
      expect((await get(second, '/devices').expect(200)).body.items).toHaveLength(1);

      expect((await h.api().delete(`/api/v1/devices/${b.id}`).set(h.bearer(first.accessToken))).status).toBe(404); // not theirs any more
      expect((await h.api().delete(`/api/v1/devices/${randomUUID()}`).set(h.bearer(second.accessToken))).status).toBe(404);
      await h.api().delete(`/api/v1/devices/${b.id}`).set(h.bearer(second.accessToken)).expect(204);
      await h.api().delete(`/api/v1/devices/${b.id}`).set(h.bearer(second.accessToken)).expect(204); // idempotent for the owner
      expect((await get(second, '/devices').expect(200)).body.items).toHaveLength(0);
      expect((await h.prisma.deviceToken.findUniqueOrThrow({ where: { id: b.id } })).revokedAt).not.toBeNull();
      expect((await register(second, token).expect(200)).body.id).toBe(b.id); // registering again reactivates it
    });

    it('keeps at most the configured number of active devices per account, revoking the oldest', async () => {
      const customer = await h.makeCustomer();
      const ids: string[] = [];
      for (let i = 0; i < 3; i++) {
        ids.push((await register(customer).expect(200)).body.id);
        await new Promise((r) => setTimeout(r, 15));
      }
      const active = (await get(customer, '/devices').expect(200)).body.items.map((d: { id: string }) => d.id);
      expect(active.sort()).toEqual([ids[1], ids[2]].sort());
    });

    it('answers 503 while no encryption key is configured', async () => {
      const { DeviceTokensService } = await import('../src/modules/notifications/device-tokens.service.js');
      const service = new DeviceTokensService(
        { getOrThrow: () => ({ notifications: { maxDevicesPerUser: 5 } }) } as never,
        h.prisma,
      );
      const customer = await h.makeCustomer();
      await expect(service.register({ id: customer.userId, role: 'CUSTOMER' } as never, { platform: 'ANDROID', provider: 'FCM', token: tok() })).rejects.toMatchObject({ status: 503, code: 'PUSH_NOT_CONFIGURED' });
    });
  });

  describe('push delivery', () => {
    let customer: Session;
    let deviceId: string;

    const queued = async (token: string, provider: 'FCM' = 'FCM') => {
      const user = await h.makeCustomer();
      const dev = (await register(user, token, 'ANDROID', provider).expect(200)).body;
      const { created } = await notifications.create(h.prisma, { userId: user.userId, type: 'work.started', sourceKey: `itest:${randomUUID()}`, params: { ref: 'BK-TEST0001' }, resource: { type: 'booking', id: randomUUID() } });
      expect(created).toBe(true);
      const n = (await mine(user.userId))[0]!;
      const d = await h.prisma.notificationDelivery.findFirstOrThrow({ where: { notificationId: n.id } });
      return { user, dev, notification: n, delivery: d };
    };

    beforeAll(async () => {
      customer = await h.makeCustomer();
      deviceId = (await register(customer).expect(200)).body.id;
    });

    it('queues a push per active device when a notification is created, and only then', async () => {
      const before = await h.prisma.notificationDelivery.count();
      await notifications.create(h.prisma, { userId: customer.userId, type: 'work.started', sourceKey: `itest:${randomUUID()}`, params: { ref: 'BK-X' } });
      expect(await h.prisma.notificationDelivery.count()).toBe(before + 1);
      const row = await h.prisma.notificationDelivery.findFirstOrThrow({ where: { targetKey: `push:${deviceId}` }, orderBy: { createdAt: 'desc' } });
      expect(row).toMatchObject({ status: 'QUEUED', channel: 'PUSH', attempts: 0 });
      const nobody = await h.makeCustomer(); // no device: in-app only
      await notifications.create(h.prisma, { userId: nobody.userId, type: 'work.started', sourceKey: `itest:${randomUUID()}`, params: {} });
      expect(await h.prisma.notificationDelivery.count({ where: { notification: { userId: nobody.userId } } })).toBe(0);
    });

    it('sends once, in the recipient\'s language, records SENT (not delivered), and never resends', async () => {
      const { user, delivery: d, notification } = await queued(tok('good'));
      await h.prisma.user.update({ where: { id: user.userId }, data: { locale: 'EN' } });
      const sentBefore = push.accepted.length;
      const run = await delivery.runOnce();
      expect(run.sent).toBeGreaterThanOrEqual(1);
      const after = await h.prisma.notificationDelivery.findUniqueOrThrow({ where: { id: d.id } });
      expect(after).toMatchObject({ status: 'SENT', attempts: 1, deliveredAt: null });
      expect(after.providerMessageId).toMatch(/^mock-/);
      expect(after.sentAt).not.toBeNull();
      const msg = push.accepted.slice(sentBefore).find((m) => m.data['notificationId'] === notification.id)!;
      expect(msg).toMatchObject({ title: 'Work has started', body: 'The worker started work on booking BK-TEST0001.', provider: 'FCM' });
      expect(msg.data).toMatchObject({ type: 'work.started', resourceType: 'booking' });
      expect(JSON.stringify(msg.data)).not.toMatch(/token/i);

      const count = push.accepted.length;
      await delivery.runOnce();
      await delivery.runOnce();
      expect(push.accepted.length).toBe(count);
    });

    it('two workers racing never send the same delivery twice', async () => {
      const items = await Promise.all([queued(tok('race')), queued(tok('race')), queued(tok('race'))]);
      const before = push.accepted.length;
      await Promise.all([delivery.runOnce(), delivery.runOnce(), delivery.runOnce()]);
      expect(push.accepted.length - before).toBeGreaterThanOrEqual(3);
      for (const i of items) {
        expect(push.accepted.filter((m) => m.data['notificationId'] === i.notification.id)).toHaveLength(1);
      }
    });

    it('retries transient failures with bounded exponential backoff, then marks FAILED instead of retrying forever', async () => {
      const { delivery: d } = await queued(tok('transient'));
      const t0 = new Date();
      expect((await delivery.runOnce(t0)).retried).toBeGreaterThanOrEqual(1);
      let row = await h.prisma.notificationDelivery.findUniqueOrThrow({ where: { id: d.id } });
      expect(row).toMatchObject({ status: 'QUEUED', attempts: 1, lastError: 'TRANSIENT' });
      expect(row.nextAttemptAt.getTime()).toBeGreaterThan(t0.getTime());
      const gap1 = row.nextAttemptAt.getTime() - t0.getTime();
      expect((await delivery.runOnce(t0)).claimed).toBe(0 + (await h.prisma.notificationDelivery.count({ where: { status: 'QUEUED', nextAttemptAt: { lte: t0 } } })));

      await delivery.runOnce(new Date(t0.getTime() + 3_600_000));
      row = await h.prisma.notificationDelivery.findUniqueOrThrow({ where: { id: d.id } });
      expect(row.attempts).toBe(2);
      expect(row.nextAttemptAt.getTime() - (t0.getTime() + 3_600_000)).toBeGreaterThan(gap1); // the wait grew

      await delivery.runOnce(new Date(t0.getTime() + 7_200_000)); // 3rd attempt = NOTIFICATION_MAX_ATTEMPTS
      row = await h.prisma.notificationDelivery.findUniqueOrThrow({ where: { id: d.id } });
      expect(row).toMatchObject({ status: 'FAILED', attempts: 3, lastError: 'ATTEMPTS_EXHAUSTED' });
      expect((await delivery.runOnce(new Date(t0.getTime() + 86_400_000))).claimed).toBe(0 + (await h.prisma.notificationDelivery.count({ where: { status: 'QUEUED', nextAttemptAt: { lte: new Date(t0.getTime() + 86_400_000) } } })));
    });

    it('an invalid token fails permanently and revokes that device', async () => {
      const { delivery: d, dev, user } = await queued(tok('invalid'));
      await delivery.runOnce();
      expect(await h.prisma.notificationDelivery.findUniqueOrThrow({ where: { id: d.id } })).toMatchObject({ status: 'FAILED', lastError: 'INVALID_TOKEN' });
      expect((await h.prisma.deviceToken.findUniqueOrThrow({ where: { id: dev.id } })).revokedAt).not.toBeNull();
      expect((await get(user, '/devices').expect(200)).body.items).toHaveLength(0);
    });

    it('a device revoked before sending is not used', async () => {
      const { delivery: d, dev, user } = await queued(tok('revoked'));
      await h.api().delete(`/api/v1/devices/${dev.id}`).set(h.bearer(user.accessToken)).expect(204);
      const before = push.accepted.length;
      await delivery.runOnce();
      expect(push.accepted.length).toBe(before);
      expect(await h.prisma.notificationDelivery.findUniqueOrThrow({ where: { id: d.id } })).toMatchObject({ status: 'FAILED', lastError: 'TOKEN_UNAVAILABLE' });
    });

    it('with no push provider every delivery is recorded UNSUPPORTED and nothing is attempted', async () => {
      const { delivery: d } = await queued(tok('nosend'));
      const off = new NotificationDeliveryService(
        { getOrThrow: () => ({ notifications: { maxAttempts: 3, deviceTokenKey: Buffer.from(KEY, 'base64') } }) } as never,
        h.prisma,
        new DisabledPushProvider(),
      );
      const before = push.accepted.length;
      expect((await off.runOnce()).unsupported).toBeGreaterThanOrEqual(1);
      expect(await h.prisma.notificationDelivery.findUniqueOrThrow({ where: { id: d.id } })).toMatchObject({ status: 'UNSUPPORTED', sentAt: null, attempts: 0 });
      expect(push.accepted.length).toBe(before);
    });

    it('never logs tokens, titles or bodies when a delivery fails', async () => {
      const spies = (['log', 'warn', 'error', 'debug', 'verbose'] as const).map((l) => jest.spyOn(Logger.prototype, l).mockImplementation(() => undefined));
      try {
        const token = tok('invalid-LEAKCHECK');
        const { delivery: d } = await queued(token);
        await delivery.runOnce();
        expect((await h.prisma.notificationDelivery.findUniqueOrThrow({ where: { id: d.id } })).status).toBe('FAILED');
        const logged = spies.flatMap((s) => s.mock.calls.map((c) => JSON.stringify(c))).join('\n');
        expect(logged).not.toContain('LEAKCHECK');
        expect(logged).not.toContain('Work has started');
        expect(logged).not.toContain('BK-TEST0001');
      } finally {
        spies.forEach((s) => s.mockRestore());
      }
    });
  });
});
