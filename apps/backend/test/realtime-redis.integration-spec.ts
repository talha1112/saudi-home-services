/**
 * REAL POSTGRESQL + REAL REDIS-COMPATIBLE SERVER (Memurai locally, logical DB 15, unique key prefix per run):
 *  - the Socket.IO Redis adapter across two API instances,
 *  - BullMQ jobs: scheduled dispatch, duplicate workers, recovery after Redis loses its keys, a start while
 *    Redis is unreachable,
 *  - the live position with a real Redis expiry and SCAN-based cleanup.
 * Only keys carrying this run's prefix (or the booking ids this run created) are ever deleted.
 */
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { randomBytes, randomUUID } from 'node:crypto';
import { recordEvent } from '../src/modules/bookings/booking-support.js';
import { BookingAccessService } from '../src/modules/realtime/booking-access.service.js';
import { StorageDeletionService } from '../src/modules/storage/storage-deletion.service.js';
import { JobsService } from '../src/modules/realtime/jobs/jobs.service.js';
import { NotificationsService } from '../src/modules/notifications/notifications.service.js';
import { OutboxDispatcherService } from '../src/modules/realtime/jobs/outbox-dispatcher.service.js';
import { LocationService } from '../src/modules/realtime/location/location.service.js';
import { KEYS } from '../src/modules/realtime/realtime.constants.js';
import { RealtimeEmitter } from '../src/modules/realtime/realtime-emitter.js';
import { RealtimeGateway } from '../src/modules/realtime/realtime.gateway.js';
import { RedisKeyValueStore } from '../src/database/redis-key-value.store.js';
import { RedisService } from '../src/database/redis.service.js';
import { testConfigService } from '../src/testing/test-support.js';
import { type Harness, bootHarness, redisTestUrl } from './support/bookings-harness.js';

const run = process.env['TEST_DATABASE_URL'] ? describe : describe.skip;
if (!process.env['TEST_DATABASE_URL']) console.warn('realtime-redis.integration-spec: TEST_DATABASE_URL is not set, suite skipped');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(fn: () => Promise<T | undefined | false>, timeoutMs = 8000, everyMs = 100): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('condition not met in time');
    await sleep(everyMs);
  }
}
const started = (bookingId: string) => ({ bookingId, type: 'WORK_STARTED' as const, fromStatus: 'CONFIRMED' as const, toStatus: 'IN_PROGRESS' as const });

run('Socket.IO Redis adapter across two API instances (Memurai)', () => {
  let a: Harness;
  let b: Harness;

  beforeAll(async () => {
    a = await bootHarness({ phonePrefix: '+9665973', slugPrefix: 'itest-ra-', adminEmailPrefix: 'itest-ra-admin', realtime: { listen: true, redisAdapter: true } });
    b = await bootHarness({
      phonePrefix: '+9665974',
      slugPrefix: 'itest-rb-',
      adminEmailPrefix: 'itest-rb-admin',
      realtime: { listen: true, redisAdapter: true, env: { QUEUE_PREFIX: a.queuePrefix } }, // same adapter channels as A
    });
    await a.seedReferenceData();
    await sleep(300); // let both subscribers attach
  });

  afterAll(async () => {
    if (b) await b.close();
    if (a) await a.close();
  });

  it('delivers a booking event dispatched by instance B to a customer connected to instance A', async () => {
    const p = await a.confirmedBooking();
    await a.app.get(OutboxDispatcherService).runOnce();
    const customer = await a.connect(p.customer.accessToken);
    await customer.emitAck('booking.join', { bookingId: p.booking.id });

    await a.prisma.$transaction((tx) => recordEvent(tx, started(p.booking.id)));
    const result = await b.app.get(OutboxDispatcherService).runOnce(); // B has no socket of this customer
    expect(result.delivered).toBeGreaterThanOrEqual(1);
    expect(await customer.waitFor('booking.event.v1', (e) => e.type === 'WORK_STARTED')).toMatchObject({ v: 1, bookingId: p.booking.id });
  });

  it('delivers chat across instances in both directions', async () => {
    const p = await a.confirmedBooking();
    const worker = await a.connect(p.worker.accessToken);
    const customerOnB = await b.connect(p.customer.accessToken);
    await worker.emitAck('booking.join', { bookingId: p.booking.id });
    await customerOnB.emitAck('booking.join', { bookingId: p.booking.id });

    await customerOnB.emitAck('chat.send', { bookingId: p.booking.id, clientMessageId: `itest-x-${randomUUID().slice(0, 12)}`, body: 'hello across nodes' });
    expect(await worker.waitFor('chat.message.v1')).toMatchObject({ body: 'hello across nodes', senderRole: 'CUSTOMER' });
    await worker.emitAck('chat.send', { bookingId: p.booking.id, clientMessageId: `itest-y-${randomUUID().slice(0, 12)}`, body: 'reply' });
    expect(await customerOnB.waitFor('chat.message.v1', (m) => m.body === 'reply')).toMatchObject({ senderRole: 'WORKER' });
  });

  it('delivers the live position across instances and, when sharing ends, empties the room on every instance', async () => {
    const p = await a.confirmedBooking();
    const customer = await a.connect(p.customer.accessToken);
    const workerOnB = await b.connect(p.worker.accessToken);
    await customer.emitAck('location.subscribe', { bookingId: p.booking.id });
    // the position store of the harness is per-process memory; each instance has its own, which is fine for one publisher
    const res = await workerOnB.emitAck('location.publish', { bookingId: p.booking.id, latitude: 24.71, longitude: 46.67, recordedAt: new Date().toISOString() });
    expect(res.ok).toBe(true);
    expect(await customer.waitFor('location.update.v1')).toMatchObject({ bookingId: p.booking.id, latitude: 24.71 });

    await a.cancelBooking(p.customer, p.booking.id).expect(200);
    await b.app.get(OutboxDispatcherService).runOnce();
    await customer.waitFor('location.ended.v1');
    const gateway = b.app.get(RealtimeGateway) as unknown as { server: { in: (r: string) => { fetchSockets: () => Promise<unknown[]> } } };
    expect(await gateway.server.in(`booking:${p.booking.id}:location`).fetchSockets()).toHaveLength(0);
  });
});

run('Socket.IO with the adapter configured but Redis unreachable', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await bootHarness({
      phonePrefix: '+9665975',
      slugPrefix: 'itest-rd-',
      adminEmailPrefix: 'itest-rd-admin',
      realtime: { listen: true, redisAdapter: true, env: { REDIS_URL: 'redis://127.0.0.1:1' } },
    });
    await h.seedReferenceData();
  });

  afterAll(async () => {
    if (h) await h.close();
  });

  it('still starts and serves the sockets of this instance; durable data is untouched', async () => {
    const p = await h.confirmedBooking();
    const customer = await h.connect(p.customer.accessToken);
    const worker = await h.connect(p.worker.accessToken);
    await customer.emitAck('booking.join', { bookingId: p.booking.id });
    await worker.emitAck('booking.join', { bookingId: p.booking.id });
    const sent = await customer.emitAck('chat.send', { bookingId: p.booking.id, clientMessageId: `itest-z-${randomUUID().slice(0, 12)}`, body: 'still works' });
    expect(sent.ok).toBe(true);
    expect(await h.prisma.chatMessage.count({ where: { bookingId: p.booking.id } })).toBe(1);
    // recovery through REST is always available
    const history = await h.api().get(`/api/v1/bookings/${p.booking.id}/messages`).set(h.bearer(p.worker.accessToken)).expect(200);
    expect(history.body.items).toHaveLength(1);
  });
});

run('background jobs (BullMQ on Memurai)', () => {
  // Instances of one deployment share the same secrets and talk to each other through Redis.
  const SHARED = { STORAGE_DELETION_POLL_SECONDS: '1', PUSH_PROVIDER: 'mock', DEVICE_TOKEN_ENCRYPTION_KEY: randomBytes(32).toString('base64') };
  let c: Harness;
  let d: Harness;
  let probe: Queue;
  let probeRedis: Redis;
  const queueOf = (name: string) => new Queue(name, { connection: probeRedis, prefix: `${c.queuePrefix}:bull` });

  beforeAll(async () => {
    c = await bootHarness({ phonePrefix: '+9665976', slugPrefix: 'itest-rj-', adminEmailPrefix: 'itest-rj-admin', realtime: { listen: true, jobs: true, redisAdapter: true, env: { OUTBOX_POLL_INTERVAL_MS: '200' } }, env: SHARED });
    d = await bootHarness({
      phonePrefix: '+9665977',
      slugPrefix: 'itest-rk-',
      adminEmailPrefix: 'itest-rk-admin',
      realtime: { jobs: true, redisAdapter: true, env: { QUEUE_PREFIX: c.queuePrefix, OUTBOX_POLL_INTERVAL_MS: '200' } }, // a second instance on the same queues and adapter channels
      env: SHARED,
    });
    await c.seedReferenceData();
    probeRedis = new Redis(redisTestUrl(), { maxRetriesPerRequest: null });
    probe = queueOf('realtime-outbox');
  });

  afterAll(async () => {
    await probe?.close();
    probeRedis?.disconnect();
    if (d) await d.close();
    if (c) await c.close();
  });

  it('starts the workers and keeps each repeatable job exactly once, even with two instances', async () => {
    expect(c.app.get(JobsService).status()).toEqual({ state: 'running' });
    expect(d.app.get(JobsService).status()).toEqual({ state: 'running' });
    const schedulers = await probe.getJobSchedulers();
    expect(schedulers.map((s) => s.key).sort()).toEqual(['outbox-dispatch', 'outbox-purge', 'outbox-report']);
    const maintenance = await queueOf('maintenance').getJobSchedulers();
    expect(maintenance.map((s) => s.key).sort()).toEqual(['abandoned-uploads', 'file-scan-purge', 'file-scan-report', 'location-cleanup', 'storage-deletions', 'storage-purge', 'storage-report']);
    expect((await queueOf('file-scans').getJobSchedulers()).map((s) => s.key)).toEqual(['file-scans']); // the scan queue has its own scheduler and worker
    expect((await queueOf('notifications').getJobSchedulers()).map((s) => s.key)).toEqual(['notification-deliver']);
    await c.app.get(JobsService).ensureSchedulers(); // idempotent
    expect((await probe.getJobSchedulers()).length).toBe(3);
  });

  it('delivers committed events by itself, once each, with two competing workers', async () => {
    const p = await c.confirmedBooking();
    await until(async () => (await c.prisma.realtimeOutboxEvent.count({ where: { bookingId: p.booking.id, dispatchedAt: null } })) === 0);
    const customer = await c.connect(p.customer.accessToken);
    await customer.emitAck('booking.join', { bookingId: p.booking.id });

    for (let i = 0; i < 12; i++) await c.prisma.$transaction((tx) => recordEvent(tx, started(p.booking.id)));
    await until(async () => (await c.prisma.realtimeOutboxEvent.count({ where: { bookingId: p.booking.id, dispatchedAt: null } })) === 0);

    await sleep(300);
    const received = customer.events.filter((e) => e.event === 'booking.event.v1' && e.payload.type === 'WORK_STARTED').map((e) => e.payload.eventId);
    expect(received).toHaveLength(12);
    expect(new Set(received).size).toBe(12); // no duplicates
    const rows = await c.prisma.realtimeOutboxEvent.findMany({ where: { bookingId: p.booking.id, bookingEvent: { type: 'WORK_STARTED' } } });
    expect(rows.every((r) => r.attempts === 1 && r.dispatchedAt && !r.deadAt)).toBe(true);
  });

  it('creates the notifications of an event once per recipient, even when delivery is repeated', async () => {
    const p = await c.confirmedBooking(); // PAYMENT_CONFIRMED notifies the customer and the worker
    const paymentEvent = await c.prisma.bookingEvent.findFirstOrThrow({ where: { bookingId: p.booking.id, type: 'PAYMENT_CONFIRMED' } });
    await until(async () => (await c.prisma.notification.count({ where: { sourceKey: `booking-event:${paymentEvent.id}` } })) === 2);
    const rows = await c.prisma.notification.findMany({ where: { sourceKey: `booking-event:${paymentEvent.id}` } });
    expect(rows.map((r) => r.userId).sort()).toEqual([p.customer.userId, p.worker.userId].sort());
    expect(JSON.stringify(rows.map((r) => r.params))).not.toMatch(/amount|price|address|phone/i);

    // the same event delivered again (outbox retry, second instance) creates nothing new
    const again = await c.app.get(NotificationsService).createFromBookingEvent({ eventId: paymentEvent.id, bookingId: p.booking.id, type: 'PAYMENT_CONFIRMED' });
    expect(again).toBe(0);
    expect(await c.prisma.notification.count({ where: { sourceKey: `booking-event:${paymentEvent.id}` } })).toBe(2);
  });

  it('delivers pushes and removes stored objects by itself, from the database state alone', async () => {
    const p = await c.confirmedBooking();
    const dev = await c.api().post('/api/v1/devices').set(c.bearer(p.customer.accessToken)).send({ platform: 'ANDROID', provider: 'FCM', token: `job-token-${randomUUID()}-${randomUUID()}` }).expect(200);
    await c.prisma.$transaction((tx) => recordEvent(tx, { bookingId: p.booking.id, type: 'WORK_STARTED', fromStatus: 'CONFIRMED', toStatus: 'IN_PROGRESS' }));
    // outbox -> notification -> queued push -> sent, with no manual call
    const sent = await until(async () =>
      c.prisma.notificationDelivery.findFirst({ where: { targetKey: `push:${dev.body.id}`, status: 'SENT', notification: { type: 'work.started' } } }),
    );
    expect(sent!.providerMessageId).toMatch(/^mock-/);
    expect(sent!.deliveredAt).toBeNull(); // accepted by the provider, not proven delivered

    const key = `bookings/${randomUUID()}/photos/${randomUUID()}`;
    await c.prisma.$transaction((tx) => c.app.get(StorageDeletionService).enqueue(tx, key, 'itest'));
    await until(async () => (await c.prisma.storageDeletion.findUniqueOrThrow({ where: { storageKey: key } })).completedAt);
  });

  it('heals after Redis loses its keys: the repeatable jobs are re-created and pending events are delivered', async () => {
    const p = await c.confirmedBooking();
    await until(async () => (await c.prisma.realtimeOutboxEvent.count({ where: { bookingId: p.booking.id, dispatchedAt: null } })) === 0);

    // simulate a Redis restart without persistence: every queue key of this run disappears
    let cursor = '0';
    do {
      const [next, keys] = await probeRedis.scan(cursor, 'MATCH', `${c.queuePrefix}:bull:*`, 'COUNT', 500);
      cursor = next;
      if (keys.length) await probeRedis.del(...keys);
    } while (cursor !== '0');
    expect((await probe.getJobSchedulers()).length).toBe(0);

    await c.prisma.$transaction((tx) => recordEvent(tx, started(p.booking.id)));
    await c.app.get(JobsService).startOrRecover(); // what the 30 s recovery timer does
    await d.app.get(JobsService).startOrRecover();
    expect((await probe.getJobSchedulers()).length).toBe(3);
    await until(async () => (await c.prisma.realtimeOutboxEvent.count({ where: { bookingId: p.booking.id, dispatchedAt: null } })) === 0, 10000);
  });

  it('removes stale positions of finished bookings through the cleanup job', async () => {
    const p = await c.confirmedBooking();
    await c.cancelBooking(p.customer, p.booking.id).expect(200);
    // With the job runner active the outbox ends sharing by itself within a poll interval. Wait for that to finish, and only THEN plant a
    // key, so the position really outlives its booking: this is the safety net for a key written after (or surviving) the normal end of sharing.
    await until(async () => (await c.prisma.realtimeOutboxEvent.count({ where: { bookingId: p.booking.id, dispatchedAt: null } })) === 0);
    await c.store.set(KEYS.location(p.booking.id), JSON.stringify({ lat: 24.7, lng: 46.7, rec: Date.now(), got: Date.now() }), 600);
    expect(await c.store.get(KEYS.location(p.booking.id))).not.toBeNull();
    const result = await c.app.get(LocationService).cleanupIneligible();
    expect(result.removed).toBeGreaterThanOrEqual(1);
    expect(await c.store.get(KEYS.location(p.booking.id))).toBeNull();
  });
});

run('background jobs when Redis is unreachable at start', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await bootHarness({
      phonePrefix: '+9665978',
      slugPrefix: 'itest-re-',
      adminEmailPrefix: 'itest-re-admin',
      realtime: { listen: true, jobs: true, env: { REDIS_URL: 'redis://127.0.0.1:1', OUTBOX_POLL_INTERVAL_MS: '200' } },
    });
    await h.seedReferenceData();
  }, 30000);

  afterAll(async () => {
    if (h) await h.close();
  });

  it('keeps serving requests, reports the degraded state, keeps events pending, and recovers when Redis is back', async () => {
    const jobs = h.app.get(JobsService);
    expect(jobs.status().state).toBe('degraded');
    expect(jobs.status().lastError).toBeDefined();
    await h.api().get('/api/v1/health').expect(200);
    const degradedReady = await h.api().get('/api/v1/health/ready');
    expect(degradedReady.body).toMatchObject({ jobs: 'degraded', status: 'degraded' }); // operators can see it

    const p = await h.confirmedBooking(); // the booking flow works; events are written to the outbox
    const pending = await h.prisma.realtimeOutboxEvent.count({ where: { bookingId: p.booking.id, dispatchedAt: null } });
    expect(pending).toBeGreaterThan(0);
    await sleep(600);
    expect(await h.prisma.realtimeOutboxEvent.count({ where: { bookingId: p.booking.id, dispatchedAt: null } })).toBe(pending); // nothing lost, nothing delivered

    // Redis comes back (the same step the 30 s timer takes)
    (jobs as unknown as { redisUrl: string }).redisUrl = redisTestUrl();
    await jobs.startOrRecover();
    expect(jobs.status().state).toBe('running');
    expect((await h.api().get('/api/v1/health/ready')).body.jobs).toBe('running');
    await until(async () => (await h.prisma.realtimeOutboxEvent.count({ where: { bookingId: p.booking.id, dispatchedAt: null } })) === 0, 10000);
  }, 40000);
});

run('live position with a real Redis expiry', () => {
  let h: Harness;
  let redisService: RedisService;
  let location: LocationService;
  let store: RedisKeyValueStore;
  const sent: Array<{ room: string; event: string }> = [];
  const created: string[] = [];

  beforeAll(async () => {
    h = await bootHarness({ phonePrefix: '+9665979', slugPrefix: 'itest-rl-', adminEmailPrefix: 'itest-rl-admin', realtime: { realRedis: true } });
    await h.seedReferenceData();
    redisService = new RedisService({ getOrThrow: () => ({ redisUrl: redisTestUrl() }) } as never);
    store = new RedisKeyValueStore(redisService);
    const appCfg = testConfigService().getOrThrow('app') as { realtime: { location: object } };
    const cfg = {
      getOrThrow: () => ({ ...appCfg, realtime: { ...appCfg.realtime, location: { ...appCfg.realtime.location, ttlSeconds: 2, minIntervalMs: 0, sharingLeadMinutes: 0 } } }),
    };
    const emitter = { toRoom: (room: string, event: string) => sent.push({ room, event }), emptyRoom: () => undefined } as unknown as RealtimeEmitter;
    location = new LocationService(cfg as never, h.app.get(BookingAccessService), store, emitter, h.prisma);
  });

  afterAll(async () => {
    if (store && created.length) await store.del(...created.map((id) => KEYS.location(id)), ...created.map((id) => KEYS.locationRate(id)));
    await redisService?.onModuleDestroy();
    if (h) await h.close();
  });

  const asUser = (s: { userId: string; accessToken: string }, role: 'CUSTOMER' | 'WORKER') => ({ id: s.userId, sessionId: 'x', role, roles: [role], status: 'ACTIVE', mustChangePassword: false }) as never;
  const pos = (n = 1) => ({ bookingId: '', latitude: 24.7 + n * 0.0001, longitude: 46.7, recordedAt: new Date().toISOString() });

  it('keeps only the latest position, expires it by itself, and never invents one afterwards', async () => {
    const p = await h.confirmedBooking();
    created.push(p.booking.id);
    const worker = asUser(p.worker, 'WORKER');
    const customer = asUser(p.customer, 'CUSTOMER');

    expect(await location.read(customer, p.booking.id)).toEqual({ available: false, reason: 'NO_RECENT_POSITION' });
    await location.publish(worker, { ...pos(1), bookingId: p.booking.id });
    await sleep(20);
    await location.publish(worker, { ...pos(2), bookingId: p.booking.id });
    const read = await location.read(customer, p.booking.id);
    expect(read).toMatchObject({ available: true, location: { latitude: 24.7002 } });
    const ttl = await store.ttl(KEYS.location(p.booking.id));
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(2);
    expect(sent.filter((s) => s.event === 'location.update.v1')).toHaveLength(2);

    await sleep(2300);
    expect(await location.read(customer, p.booking.id)).toEqual({ available: false, reason: 'NO_RECENT_POSITION' });
    expect(await store.get(KEYS.location(p.booking.id))).toBeNull();
  });

  it('treats a lost or corrupt Redis value as "no recent position"', async () => {
    const p = await h.confirmedBooking();
    created.push(p.booking.id);
    const customer = asUser(p.customer, 'CUSTOMER');
    await store.set(KEYS.location(p.booking.id), '{not json', 60);
    expect(await location.read(customer, p.booking.id)).toEqual({ available: false, reason: 'NO_RECENT_POSITION' });
    await store.set(KEYS.location(p.booking.id), JSON.stringify({ lat: 'x', lng: 1, rec: 1, got: 1 }), 60);
    expect(await location.read(customer, p.booking.id)).toEqual({ available: false, reason: 'NO_RECENT_POSITION' });
    await store.del(KEYS.location(p.booking.id));
    expect(await location.read(customer, p.booking.id)).toEqual({ available: false, reason: 'NO_RECENT_POSITION' });
  });

  it('reports 503 (and publishes nothing) while Redis is unreachable, instead of guessing', async () => {
    const p = await h.confirmedBooking();
    created.push(p.booking.id);
    const dead = new RedisKeyValueStore(new RedisService({ getOrThrow: () => ({ redisUrl: 'redis://127.0.0.1:1' }) } as never));
    const cfg = { getOrThrow: () => ({ realtime: { location: { ttlSeconds: 2, minIntervalMs: 0, sharingLeadMinutes: 0, rateLimitPerMinute: 30, maxAgeSeconds: 30, maxClockSkewSeconds: 10, maxSpeedMps: 70, maxAccuracyMeters: 500 } } }) };
    const before = sent.length;
    const offline = new LocationService(cfg as never, h.app.get(BookingAccessService), dead, { toRoom: () => sent.push({ room: '', event: 'x' }), emptyRoom: () => undefined } as never, h.prisma);
    await expect(offline.publish(asUser(p.worker, 'WORKER'), { ...pos(), bookingId: p.booking.id })).rejects.toMatchObject({ status: 503 });
    await expect(offline.read(asUser(p.customer, 'CUSTOMER'), p.booking.id)).rejects.toMatchObject({ status: 503 });
    expect(sent.length).toBe(before);
  }, 20000);

  it('cleans up only positions of bookings that no longer authorise sharing (real SCAN)', async () => {
    const live = await h.confirmedBooking();
    const gone = await h.confirmedBooking();
    created.push(live.booking.id, gone.booking.id);
    const orphan = randomUUID();
    created.push(orphan);
    const value = JSON.stringify({ lat: 24.7, lng: 46.7, rec: Date.now(), got: Date.now() });
    for (const id of [live.booking.id, gone.booking.id, orphan]) await store.set(KEYS.location(id), value, 120);
    await store.set('loc:v1x:unrelated', 'keep', 120);
    await h.cancelBooking(gone.customer, gone.booking.id).expect(200);

    const result = await location.cleanupIneligible();
    expect(result.removed).toBeGreaterThanOrEqual(2);
    expect(await store.get(KEYS.location(live.booking.id))).toBe(value);
    expect(await store.get(KEYS.location(gone.booking.id))).toBeNull();
    expect(await store.get(KEYS.location(orphan))).toBeNull();
    expect(await store.get('loc:v1x:unrelated')).toBe('keep');
    await store.del('loc:v1x:unrelated');
  });
});
