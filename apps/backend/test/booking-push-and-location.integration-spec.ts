/**
 * REAL POSTGRESQL, push provider replaced by a recording double (nothing reaches a device).
 *
 * The whole booking path tells the people involved by push: a new request reaches the workers who could take it, each step reaches the
 * other side, and a chat message reaches the recipient once per run of unread messages, never with its text. The assigned worker's phone
 * reports its position over REST and only the booking's customer can read it while sharing is open.
 */
import { randomBytes } from 'node:crypto';
import { NotificationDeliveryService } from '../src/modules/notifications/notification-delivery.service.js';
import { MockPushProvider } from '../src/modules/notifications/push/push-provider.js';
import { OutboxDispatcherService } from '../src/modules/realtime/jobs/outbox-dispatcher.service.js';
import { WorkerVerificationStatus } from '../src/generated/prisma/client.js';
import { type Harness, type Session, bootHarness } from './support/bookings-harness.js';

const run = process.env['TEST_DATABASE_URL'] ? describe : describe.skip;
if (!process.env['TEST_DATABASE_URL']) console.warn('booking-push-and-location.integration-spec: TEST_DATABASE_URL is not set, suite skipped');

run('booking push notifications, chat push and live position (real PostgreSQL, fake push)', () => {
  let h: Harness;
  let push: MockPushProvider;
  let dispatcher: OutboxDispatcherService;
  let delivery: NotificationDeliveryService;
  let ref: Awaited<ReturnType<Harness['seedReferenceData']>>;
  let otherCity: { id: string };
  const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
  let n = 0;
  const cid = () => `itest-bk-${Date.now().toString(36)}-${++n}-${Math.random().toString(36).slice(2, 8)}`;

  beforeAll(async () => {
    push = new MockPushProvider();
    h = await bootHarness({
      phonePrefix: '+9665998',
      slugPrefix: 'itest-bk-',
      adminEmailPrefix: 'itest-bk-admin',
      pushProvider: push,
      env: { PUSH_PROVIDER: 'mock', DEVICE_TOKEN_ENCRYPTION_KEY: randomBytes(32).toString('base64'), LOCATION_SHARING_LEAD_MINUTES: '0', LOCATION_MIN_INTERVAL_MS: '2000' },
    });
    ref = await h.seedReferenceData();
    otherCity = await h.prisma.city.create({ data: { slug: 'itest-bk-other', nameEn: 'Other city', nameAr: 'مدينة أخرى', isActive: true } });
    dispatcher = h.app.get(OutboxDispatcherService);
    delivery = h.app.get(NotificationDeliveryService);
  });

  afterAll(async () => {
    if (h) await h.close();
  });

  async function withPhone<T extends Session>(who: T): Promise<T> {
    await h
      .api()
      .post('/api/v1/devices')
      .set(bearer(who.accessToken))
      .set('X-Forwarded-For', h.freshIp())
      .send({ platform: 'ANDROID', provider: 'FCM', token: `tok-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}-padding` })
      .expect(200);
    return who;
  }

  /** A customer and an approved worker for the shared service and city, both with a registered phone, and an OPEN request. */
  async function openRequest() {
    const customer = await withPhone(await h.makeCustomer());
    const worker = await withPhone(await h.makeWorker([ref.service.id], [ref.city.id]));
    const booking = await h.createBooking(customer, ref);
    await dispatcher.runOnce();
    return { customer, worker, booking };
  }
  const types = (userId: string) => h.prisma.notification.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } }).then((r) => r.map((x) => x.type));
  const flush = async () => {
    await dispatcher.runOnce();
    const before = push.accepted.length;
    await delivery.runOnce();
    return push.accepted.slice(before);
  };

  it('a new request reaches only the approved workers who offer that service in that city', async () => {
    const customer = await h.makeCustomer();
    const eligible = await withPhone(await h.makeWorker([ref.service.id], [ref.city.id]));
    const wrongCity = await withPhone(await h.makeWorker([ref.service.id], [otherCity.id]));
    const notApproved = await withPhone(await h.makeWorker([ref.service.id], [ref.city.id], WorkerVerificationStatus.SUBMITTED));

    const booking = await h.createBooking(customer, ref);
    await dispatcher.runOnce();

    const rows = await h.prisma.notification.findMany({ where: { userId: eligible.userId, type: 'request.new' } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ resourceType: 'booking', resourceId: booking.id });
    expect(await types(wrongCity.userId)).not.toContain('request.new');
    expect(await types(notApproved.userId)).not.toContain('request.new');
    expect(await types(customer.userId)).not.toContain('request.new');

    await dispatcher.runOnce(); // replaying the event creates nothing more
    expect(await h.prisma.notification.count({ where: { userId: eligible.userId, type: 'request.new' } })).toBe(1);
  });

  it('an offline worker, or one whose weekly hours do not cover the requested start, is neither shown the request nor pushed', async () => {
    const customer = await h.makeCustomer();
    const start = new Date(Date.now() + 5 * 24 * 3_600_000);
    const local = new Date(start.getTime() + 3 * 3_600_000); // Saudi time is UTC+3 all year
    const day = local.getUTCDay();
    const minute = local.getUTCHours() * 60 + local.getUTCMinutes();
    const worker = async (hours: { dayOfWeek: number; startMinute: number; endMinute: number }[], online = true) => {
      const w = await withPhone(await h.makeWorker([ref.service.id], [ref.city.id]));
      await h.prisma.workerProfile.update({ where: { id: w.workerId }, data: { isOnline: online } });
      if (hours.length) await h.prisma.workerAvailability.createMany({ data: hours.map((x) => ({ ...x, workerProfileId: w.workerId })) });
      return w;
    };
    const inside = await worker([{ dayOfWeek: day, startMinute: Math.max(0, minute - 60), endMinute: Math.min(1440, minute + 60) }]);
    const noHours = await worker([]);
    const otherDay = await worker([{ dayOfWeek: (day + 1) % 7, startMinute: 0, endMinute: 1440 }]);
    const wrongTime = await worker(minute >= 600 ? [{ dayOfWeek: day, startMinute: 0, endMinute: 300 }] : [{ dayOfWeek: day, startMinute: 1000, endMinute: 1400 }]);
    const offline = await worker([{ dayOfWeek: day, startMinute: 0, endMinute: 1440 }], false);

    const booking = await h.createBooking(customer, ref, { preferredStartAt: start.toISOString(), preferredEndAt: new Date(start.getTime() + 3_600_000).toISOString() });
    await dispatcher.runOnce();

    for (const w of [inside, noHours]) expect(await types(w.userId)).toContain('request.new');
    for (const w of [otherDay, wrongTime, offline]) expect(await types(w.userId)).not.toContain('request.new');

    const feed = async (w: { accessToken: string }) => (await h.api().get('/api/v1/workers/me/requests').set(h.bearer(w.accessToken)).expect(200)).body.items.map((r: { id: string }) => r.id);
    for (const w of [inside, noHours]) expect(await feed(w)).toContain(booking.id);
    for (const w of [otherDay, wrongTime, offline]) expect(await feed(w)).not.toContain(booking.id);

    // coming back online shows it again
    await h.api().put('/api/v1/workers/me/online').set(h.bearer(offline.accessToken)).send({ isOnline: true }).expect(200);
    await h.prisma.workerAvailability.deleteMany({ where: { workerProfileId: offline.workerId } });
    expect(await feed(offline)).toContain(booking.id);
  });

  it('only an approved worker can switch online and offline, and the choice is kept', async () => {
    const approved = await h.makeWorker([ref.service.id], [ref.city.id]);
    const off = await h.api().put('/api/v1/workers/me/online').set(h.bearer(approved.accessToken)).send({ isOnline: false }).expect(200);
    expect(off.body.isOnline).toBe(false);
    expect((await h.api().get('/api/v1/workers/me').set(h.bearer(approved.accessToken)).expect(200)).body.isOnline).toBe(false);
    await h.api().put('/api/v1/workers/me/online').set(h.bearer(approved.accessToken)).send({ isOnline: 'yes' }).expect(400);
    const pending = await h.makeWorker([ref.service.id], [ref.city.id], WorkerVerificationStatus.SUBMITTED);
    await h.api().put('/api/v1/workers/me/online').set(h.bearer(pending.accessToken)).send({ isOnline: true }).expect(403);
    await h.api().put('/api/v1/workers/me/online').send({ isOnline: true }).expect(401);
  });

  it('every step of the booking reaches the other side by push, with the booking to open and no private text', async () => {
    const { customer, worker, booking } = await openRequest();
    expect(await types(worker.userId)).toContain('request.new');

    const quote = await h.submitQuote(worker, booking.id, { priceHalalas: 20000 });
    await dispatcher.runOnce();
    expect(await types(customer.userId)).toContain('quote.received');

    await h.api().post(`/api/v1/bookings/${booking.id}/quotes/${quote.id}/accept`).set(bearer(customer.accessToken)).send({}).expect(200);
    await dispatcher.runOnce();
    expect(await types(worker.userId)).toContain('quote.accepted');

    await h.api().post(`/api/v1/bookings/${booking.id}/payments/cash`).set(bearer(customer.accessToken)).send({}).expect(200);
    await dispatcher.runOnce();
    expect(await types(worker.userId)).toContain('payment.confirmed');
    expect(await types(customer.userId)).toContain('payment.confirmed');

    await h.api().post(`/api/v1/workers/me/bookings/${booking.id}/start`).set(bearer(worker.accessToken)).expect(200);
    await dispatcher.runOnce();
    expect(await types(customer.userId)).toContain('work.started');

    await h.api().post(`/api/v1/workers/me/bookings/${booking.id}/complete`).set(bearer(worker.accessToken)).expect(200);
    await dispatcher.runOnce();
    expect(await types(customer.userId)).toContain('work.completed');

    const sent = await flush();
    const mine = sent.filter((m) => m.data['resourceId'] === booking.id);
    expect(mine.length).toBeGreaterThanOrEqual(6);
    for (const m of mine) expect(m.data['resourceType']).toBe('booking');
    // nothing private is in any push: no price, no address, no phone
    const all = JSON.stringify(mine);
    expect(all).not.toContain(customer.phone);
    expect(all).not.toContain('Prince Sultan');
    expect(all).not.toContain('200');
  });

  it('a cancelled booking is told to the other side only', async () => {
    const { customer, worker, booking } = await openRequest();
    const quote = await h.submitQuote(worker, booking.id, { priceHalalas: 20000 });
    await h.api().post(`/api/v1/bookings/${booking.id}/quotes/${quote.id}/accept`).set(bearer(customer.accessToken)).send({}).expect(200);
    await h.api().post(`/api/v1/bookings/${booking.id}/cancel`).set(bearer(customer.accessToken)).send({ reason: 'CHANGED_MIND' }).expect(200);
    await dispatcher.runOnce();
    expect(await types(worker.userId)).toContain('booking.cancelled');
    expect(await types(customer.userId)).not.toContain('booking.cancelled'); // nobody is notified about their own action
  });

  describe('chat', () => {
    const send = (who: Session, bookingId: string, body: string) =>
      h.api().post(`/api/v1/bookings/${bookingId}/messages`).set(bearer(who.accessToken)).set('X-Forwarded-For', h.freshIp()).send({ clientMessageId: cid(), body });
    const chatRows = (userId: string) => h.prisma.notification.findMany({ where: { userId, type: 'chat.message' } });

    async function confirmed() {
      const ctx = await openRequest();
      const quote = await h.submitQuote(ctx.worker, ctx.booking.id, { priceHalalas: 20000 });
      await h.api().post(`/api/v1/bookings/${ctx.booking.id}/quotes/${quote.id}/accept`).set(bearer(ctx.customer.accessToken)).send({}).expect(200);
      await h.api().post(`/api/v1/bookings/${ctx.booking.id}/payments/cash`).set(bearer(ctx.customer.accessToken)).send({}).expect(200);
      return ctx;
    }

    it('a message pushes the OTHER person once per run of unread messages, never with its text, and again after they read', async () => {
      const { customer, worker, booking } = await confirmed();

      await send(customer, booking.id, 'The gate code is 4821').expect(201);
      expect(await chatRows(worker.userId)).toHaveLength(1);
      expect(await chatRows(customer.userId)).toHaveLength(0); // not the sender

      await send(customer, booking.id, 'Second message before you looked').expect(201);
      expect(await chatRows(worker.userId)).toHaveLength(1);

      const sent = await flush();
      const chat = sent.find((m) => m.data['type'] === 'chat.message' && m.data['resourceId'] === booking.id)!;
      expect(chat).toBeDefined();
      expect(JSON.stringify(chat)).not.toContain('4821');
      expect(chat.data['resourceType']).toBe('booking');

      await h.api().post(`/api/v1/bookings/${booking.id}/messages/receipts`).set(bearer(worker.accessToken)).set('X-Forwarded-For', h.freshIp()).send({ kind: 'READ', upToSeq: 2 }).expect(200);
      await send(customer, booking.id, 'One more thing').expect(201);
      expect(await chatRows(worker.userId)).toHaveLength(2);

      await send(worker, booking.id, 'Understood').expect(201);
      expect(await chatRows(customer.userId)).toHaveLength(1);
    });

    it('a retried send (same id) does not push twice', async () => {
      const { customer, worker, booking } = await confirmed();
      const id = cid();
      const post = () => h.api().post(`/api/v1/bookings/${booking.id}/messages`).set(bearer(customer.accessToken)).set('X-Forwarded-For', h.freshIp()).send({ clientMessageId: id, body: 'hello' });
      await post().expect(201);
      await post().expect(200);
      expect(await chatRows(worker.userId)).toHaveLength(1);
    });

    it('a message that is refused (chat closed) pushes nobody', async () => {
      const { customer, worker, booking } = await openRequest();
      await send(customer, booking.id, 'too early').expect(409);
      expect(await chatRows(worker.userId)).toHaveLength(0);
    });
  });

  describe('the assigned worker\'s live position over REST', () => {
    const report = (who: Session, bookingId: string, body: object) =>
      h.api().post(`/api/v1/workers/me/bookings/${bookingId}/location`).set(bearer(who.accessToken)).set('X-Forwarded-For', h.freshIp()).send(body);
    const read = (who: Session, bookingId: string) => h.api().get(`/api/v1/bookings/${bookingId}/location`).set(bearer(who.accessToken)).set('X-Forwarded-For', h.freshIp());
    const fix = (lat = 24.7136, lng = 46.6753) => ({ latitude: lat, longitude: lng, accuracyMeters: 12, recordedAt: new Date().toISOString() });

    async function paid() {
      const ctx = await openRequest();
      const quote = await h.submitQuote(ctx.worker, ctx.booking.id, { priceHalalas: 20000 });
      await h.api().post(`/api/v1/bookings/${ctx.booking.id}/quotes/${quote.id}/accept`).set(bearer(ctx.customer.accessToken)).send({}).expect(200);
      return { ...ctx, pay: () => h.api().post(`/api/v1/bookings/${ctx.booking.id}/payments/cash`).set(bearer(ctx.customer.accessToken)).send({}).expect(200) };
    }

    it('nothing is shared before the booking is paid; after payment the customer sees the worker\'s latest position', async () => {
      const { customer, worker, booking, pay } = await paid();
      await report(worker, booking.id, fix()).expect(409); // PAYMENT_PENDING: sharing is not active
      expect((await read(customer, booking.id).expect(200)).body).toMatchObject({ available: false, reason: 'SHARING_NOT_ACTIVE' });

      await pay();
      expect((await read(customer, booking.id).expect(200)).body).toMatchObject({ available: false, reason: 'NO_RECENT_POSITION' });

      await report(worker, booking.id, fix(24.7136, 46.6753)).expect(200);
      const seen = (await read(customer, booking.id).expect(200)).body;
      expect(seen.available).toBe(true);
      expect(seen.location).toMatchObject({ latitude: 24.7136, longitude: 46.6753 });
      expect(typeof seen.ageSeconds).toBe('number');
    });

    it('only the assigned approved worker can report, only the booking\'s customer can read', async () => {
      const { customer, worker, booking, pay } = await paid();
      await pay();
      const otherWorker = await h.makeWorker([ref.service.id], [ref.city.id]);
      const otherCustomer = await h.makeCustomer();

      await report(otherWorker, booking.id, fix()).expect(404);
      await report(customer, booking.id, fix()).expect(403); // a customer token cannot use the worker endpoint
      await report(worker, booking.id, fix()).expect(200);
      await read(otherCustomer, booking.id).expect(404);
      await read(worker, booking.id).expect(403);
    });

    it('refuses an impossible or invented position, and a flood', async () => {
      const { worker, booking, pay } = await paid();
      await pay();
      await report(worker, booking.id, fix(0, 0)).expect(400); // never 0,0
      await report(worker, booking.id, { ...fix(), latitude: 91 }).expect(400);
      await report(worker, booking.id, { ...fix(), recordedAt: new Date(Date.now() + 3_600_000).toISOString() }).expect(400);
      await report(worker, booking.id, { ...fix(), accuracyMeters: 99999 }).expect(400);
      await report(worker, booking.id, fix()).expect(200);
      await report(worker, booking.id, { ...fix(24.7137, 46.6754), recordedAt: new Date(Date.now() + 1).toISOString() }).expect(429);
    });

    it('sharing ends when the job is finished', async () => {
      const { customer, worker, booking, pay } = await paid();
      await pay();
      await h.api().post(`/api/v1/workers/me/bookings/${booking.id}/start`).set(bearer(worker.accessToken)).expect(200);
      await report(worker, booking.id, fix()).expect(200);
      await h.api().post(`/api/v1/workers/me/bookings/${booking.id}/complete`).set(bearer(worker.accessToken)).expect(200);
      await report(worker, booking.id, fix(24.7140, 46.6760)).expect(409);
      expect((await read(customer, booking.id).expect(200)).body).toMatchObject({ available: false, reason: 'SHARING_NOT_ACTIVE' });
    });
  });
});
