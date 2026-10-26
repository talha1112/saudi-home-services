/**
 * REAL POSTGRESQL + real Socket.IO over a local port: handshake authentication, room authorization,
 * live position, booking events after commit, token lifecycle and flood control.
 * (Redis is the in-memory double here; the real Memurai is exercised in realtime-redis.integration-spec.ts.)
 */
import { jest } from '@jest/globals';
import { SignJWT } from 'jose';
import { OutboxDispatcherService } from '../src/modules/realtime/jobs/outbox-dispatcher.service.js';
import { SocketEmitter } from '../src/modules/realtime/socket-emitter.js';
import { recordEvent } from '../src/modules/bookings/booking-support.js';
import { KEYS } from '../src/modules/realtime/realtime.constants.js';
import { type Harness, type Session, type TestSocket, bootHarness } from './support/bookings-harness.js';

const run = process.env['TEST_DATABASE_URL'] ? describe : describe.skip;
if (!process.env['TEST_DATABASE_URL']) console.warn('realtime-sockets.integration-spec: TEST_DATABASE_URL is not set, suite skipped');

const SECRET = new TextEncoder().encode('itest-access-secret-itest-access-secret-0123456789');
const claimsOf = (token: string) => JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString()) as { sub: string; sid: string; role: string };

/** A token for an existing session with a chosen lifetime (negative = already expired). */
async function forge(token: string, expiresInSeconds: number, overrides: { sub?: string; sid?: string; role?: string } = {}) {
  const c = claimsOf(token);
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ sid: overrides.sid ?? c.sid, role: overrides.role ?? c.role })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(overrides.sub ?? c.sub)
    .setIssuer('home-services-api')
    .setAudience('home-services')
    .setIssuedAt(now - 10)
    .setExpirationTime(now + expiresInSeconds)
    .sign(SECRET);
}

const fix = (n: number) => ({ latitude: 24.7136 + n * 0.0001, longitude: 46.6753, recordedAt: new Date().toISOString() });

run('realtime: sockets (real PostgreSQL)', () => {
  let h: Harness;
  let dispatcher: OutboxDispatcherService;
  let ctx: Awaited<ReturnType<Harness['confirmedBooking']>>;
  let stranger: Session;
  let strangerWorker: Session;
  let seq = 0;

  const publish = (s: TestSocket, bookingId: string, n = ++seq) => s.emitAck('location.publish', { bookingId, ...fix(n) });
  const cleanAll = async () => {
    // every outbox row of this suite must be flushed before the next test looks at events
    await dispatcher.runOnce();
  };

  beforeAll(async () => {
    h = await bootHarness({
      phonePrefix: '+9665971',
      slugPrefix: 'itest-rs-',
      adminEmailPrefix: 'itest-rs-admin',
      realtime: { listen: true, env: { REALTIME_REVALIDATE_SECONDS: '1', REALTIME_TOKEN_GRACE_SECONDS: '1', OUTBOX_MAX_ATTEMPTS: '2' } },
    });
    await h.seedReferenceData();
    dispatcher = h.app.get(OutboxDispatcherService);
    ctx = await h.confirmedBooking();
    stranger = await h.makeCustomer();
    strangerWorker = await h.makeWorker([], []);
    await cleanAll();
  });

  afterAll(async () => {
    if (h) await h.close();
  });

  describe('handshake authentication', () => {
    it('refuses a connection without a token', async () => {
      await expect(h.connect(undefined)).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    });

    it('refuses a malformed token and a token passed in the URL instead of the auth payload', async () => {
      await expect(h.connect('not-a-jwt')).rejects.toMatchObject({ code: 'TOKEN_INVALID' });
      const url = `${h.baseUrl}/realtime?token=${ctx.customer.accessToken}`;
      const { io } = await import('socket.io-client');
      const raw = io(url, { transports: ['websocket'], reconnection: false, forceNew: true });
      const err = await new Promise<{ data?: { code?: string } }>((resolve) => raw.once('connect_error', resolve));
      raw.close();
      expect(err.data?.code).toBe('AUTH_REQUIRED');
    });

    it('refuses an expired token and a token signed with another secret', async () => {
      await expect(h.connect(await forge(ctx.customer.accessToken, -30))).rejects.toMatchObject({ code: 'TOKEN_EXPIRED' });
      const wrong = await new SignJWT({ sid: 'x', role: 'CUSTOMER' })
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject(ctx.customer.userId)
        .setIssuer('home-services-api')
        .setAudience('home-services')
        .setExpirationTime('5m')
        .sign(new TextEncoder().encode('some-other-secret-some-other-secret-some-other'));
      await expect(h.connect(wrong)).rejects.toMatchObject({ code: 'TOKEN_INVALID' });
    });

    it('refuses a revoked session and a suspended account', async () => {
      const victim = await h.makeCustomer();
      const sid = claimsOf(victim.accessToken).sid;
      (await h.connect(victim.accessToken)).close(); // a live session connects fine
      await h.prisma.refreshToken.updateMany({ where: { userId: victim.userId, familyId: sid }, data: { revokedAt: new Date() } });
      await expect(h.connect(victim.accessToken)).rejects.toMatchObject({ code: 'SESSION_REVOKED' });

      const other = await h.makeCustomer();
      await h.prisma.user.update({ where: { id: other.userId }, data: { status: 'SUSPENDED' } });
      await expect(h.connect(other.accessToken)).rejects.toMatchObject({ code: 'ACCOUNT_NOT_ACTIVE' });
    });

    it('accepts a valid token passed as an Authorization header (non-browser clients)', async () => {
      const s = await h.connect(undefined, { headers: { Authorization: `Bearer ${ctx.customer.accessToken}` } });
      expect(s.raw.connected).toBe(true);
      s.close();
    });
  });

  describe('booking rooms', () => {
    it('lets the booking customer and the assigned worker join, with the side decided by the server', async () => {
      const c = await h.connect(ctx.customer.accessToken);
      const w = await h.connect(ctx.worker.accessToken);
      expect(await c.emitAck('booking.join', { bookingId: ctx.booking.id })).toMatchObject({ ok: true, data: { side: 'CUSTOMER', status: 'CONFIRMED' } });
      expect(await w.emitAck('booking.join', { bookingId: ctx.booking.id })).toMatchObject({ ok: true, data: { side: 'WORKER', status: 'CONFIRMED' } });
    });

    it('answers "not found" for every other account, admins included, and for malformed ids', async () => {
      const attempts: Array<[string, TestSocket]> = [
        ['other customer', await h.connect(stranger.accessToken)],
        ['unassigned worker', await h.connect(strangerWorker.accessToken)],
        ['admin', await h.connect(h.adminToken)],
      ];
      for (const [who, s] of attempts) {
        const res = await s.emitAck('booking.join', { bookingId: ctx.booking.id });
        expect({ who, ...res }).toMatchObject({ who, ok: false, error: { code: 'NOT_FOUND' } });
      }
      const c = await h.connect(ctx.customer.accessToken);
      expect(await c.emitAck('booking.join', { bookingId: 'not-a-uuid' })).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } });
      expect(await c.emitAck('booking.join', { bookingId: '6f1c2f0e-6d4a-4a39-9d1e-0f6b1a9a0001' })).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    });

    it('answers an event sent without any payload instead of staying silent', async () => {
      const s = await h.connect(ctx.customer.accessToken);
      const res = await new Promise<{ ok: boolean; error?: { code: string } }>((resolve) => s.raw.emit('booking.join', resolve));
      expect(res).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } });
    });

    it('never trusts identity fields in the payload', async () => {
      const s = await h.connect(stranger.accessToken);
      for (const extra of [{ userId: ctx.customer.userId }, { role: 'ADMIN' }, { workerId: ctx.worker.workerId }, { status: 'CONFIRMED' }]) {
        const res = await s.emitAck('booking.join', { bookingId: ctx.booking.id, ...extra });
        expect(res).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } });
      }
    });

    it('rejects a worker who is no longer approved', async () => {
      const pair = await h.confirmedBooking();
      await h.prisma.workerProfile.update({ where: { id: pair.worker.workerId }, data: { verificationStatus: 'SUSPENDED' } });
      const w = await h.connect(pair.worker.accessToken);
      expect(await w.emitAck('booking.join', { bookingId: pair.booking.id })).toMatchObject({ ok: false, error: { code: 'WORKER_NOT_APPROVED' } });
    });
  });

  describe('live position', () => {
    let pair: Awaited<ReturnType<Harness['confirmedBooking']>>;
    let customerSock: TestSocket;
    let workerSock: TestSocket;

    beforeAll(async () => {
      pair = await h.confirmedBooking();
      customerSock = await h.connect(pair.customer.accessToken);
      workerSock = await h.connect(pair.worker.accessToken);
      await workerSock.emitAck('booking.join', { bookingId: pair.booking.id });
      await dispatcher.runOnce();
    });

    it('delivers a published position to the subscribed customer and keeps only the latest in the store', async () => {
      const sub = await customerSock.emitAck('location.subscribe', { bookingId: pair.booking.id });
      expect(sub).toMatchObject({ ok: true, data: { latest: { available: false, reason: 'NO_RECENT_POSITION' } } });

      const res = await publish(workerSock, pair.booking.id, 1);
      expect(res.ok).toBe(true);
      const update = await customerSock.waitFor('location.update.v1');
      expect(update).toMatchObject({ v: 1, bookingId: pair.booking.id, latitude: 24.7137, longitude: 46.6753 });

      await publish(workerSock, pair.booking.id, 2);
      const raw = JSON.parse((await h.store.get(KEYS.location(pair.booking.id)))!);
      expect(raw.lat).toBe(24.7138); // replaced, not appended
      expect(await h.store.ttl(KEYS.location(pair.booking.id))).toBeGreaterThan(0);

      const read = await h.api().get(`/api/v1/bookings/${pair.booking.id}/location`).set(h.bearer(pair.customer.accessToken)).expect(200);
      expect(read.body).toMatchObject({ available: true, location: { latitude: 24.7138 } });
    });

    it('is never written to PostgreSQL', async () => {
      const tables = await h.prisma.$queryRaw<{ table_name: string; column_name: string }[]>`
        SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND (column_name ILIKE '%location%' OR column_name ILIKE '%gps%' OR column_name ILIKE '%position%')`;
      // only the booking's own address snapshot may exist; no table stores worker positions
      expect(tables.map((t) => `${t.table_name}.${t.column_name}`).sort()).toEqual(expect.not.arrayContaining(['chat_messages.latitude']));
      expect(tables.every((t) => ['bookings', 'service_areas', 'addresses', 'saved_addresses'].includes(t.table_name) || t.column_name === 'location_notes')).toBe(true);
    });

    it('only the assigned worker can publish: not the customer, a stranger, or another booking\'s worker', async () => {
      const asCustomer = await publish(customerSock, pair.booking.id);
      expect(asCustomer).toMatchObject({ ok: false, error: { code: 'LOCATION_PUBLISH_FORBIDDEN' } });
      const other = await h.connect(strangerWorker.accessToken);
      expect(await publish(other, pair.booking.id)).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
      const outsiderCustomer = await h.connect(stranger.accessToken);
      expect(await publish(outsiderCustomer, pair.booking.id)).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
      const admin = await h.connect(h.adminToken);
      expect(await publish(admin, pair.booking.id)).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    });

    it('only the owning customer can subscribe or read: not the worker, a stranger, or an admin', async () => {
      const workerRead = await h.api().get(`/api/v1/bookings/${pair.booking.id}/location`).set(h.bearer(pair.worker.accessToken));
      expect(workerRead.status).toBe(403); // role guard: customer-only route
      expect(await workerSock.emitAck('location.subscribe', { bookingId: pair.booking.id })).toMatchObject({ ok: false, error: { code: 'LOCATION_READ_FORBIDDEN' } });
      const outsider = await h.connect(stranger.accessToken);
      expect(await outsider.emitAck('location.subscribe', { bookingId: pair.booking.id })).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
      expect((await h.api().get(`/api/v1/bookings/${pair.booking.id}/location`).set(h.bearer(stranger.accessToken))).status).toBe(404);
      expect((await h.api().get(`/api/v1/bookings/${pair.booking.id}/location`).set(h.bearer(h.adminToken))).status).toBe(403);
    });

    it('does not leak to a customer socket that did not subscribe', async () => {
      const lurker = await h.connect(pair.customer.accessToken);
      await lurker.emitAck('booking.join', { bookingId: pair.booking.id });
      await publish(workerSock, pair.booking.id);
      expect(await lurker.expectNo('location.update.v1')).toBe(true);
    });

    it('rejects malformed, stale, future, implausible and unauthorised-field payloads without storing anything new', async () => {
      const before = await h.store.get(KEYS.location(pair.booking.id));
      const id = pair.booking.id;
      const bad = (payload: object) => workerSock.emitAck('location.publish', { bookingId: id, recordedAt: new Date().toISOString(), latitude: 24.7, longitude: 46.7, ...payload });
      expect(await bad({ latitude: 91 })).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } });
      expect(await bad({ longitude: 'abc' })).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } });
      expect(await bad({ latitude: null })).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } });
      expect(await bad({ recordedAt: 'yesterday' })).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } });
      expect(await bad({ userId: pair.worker.userId })).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } });
      expect(await bad({ latitude: 0, longitude: 0 })).toMatchObject({ ok: false, error: { code: 'LOCATION_INVALID' } });
      expect(await bad({ recordedAt: new Date(Date.now() - 120_000).toISOString() })).toMatchObject({ ok: false, error: { code: 'LOCATION_STALE' } });
      expect(await bad({ recordedAt: new Date(Date.now() + 120_000).toISOString() })).toMatchObject({ ok: false, error: { code: 'LOCATION_FROM_FUTURE' } });
      expect(await bad({ accuracyMeters: 5000 })).toMatchObject({ ok: false, error: { code: 'LOCATION_ACCURACY_TOO_LOW' } });
      // 1000 km away one second later
      expect(await bad({ latitude: 33.7, longitude: 46.7 })).toMatchObject({ ok: false, error: { code: 'LOCATION_IMPLAUSIBLE' } });
      // older than the position already shared
      expect(await bad({ recordedAt: new Date(Date.now() - 20_000).toISOString(), latitude: 24.7138 })).toMatchObject({ ok: false, error: { code: 'LOCATION_OUT_OF_ORDER' } });
      expect(await h.store.get(KEYS.location(id))).toBe(before);
    });

    it('a disconnect does not end sharing or delete the position', async () => {
      workerSock.close();
      await new Promise((r) => setTimeout(r, 200));
      const read = await h.api().get(`/api/v1/bookings/${pair.booking.id}/location`).set(h.bearer(pair.customer.accessToken)).expect(200);
      expect(read.body.available).toBe(true);
    });

    it('stops at once when the booking leaves the sharing statuses, and tells subscribers', async () => {
      const fresh = await h.confirmedBooking();
      const c = await h.connect(fresh.customer.accessToken);
      const w = await h.connect(fresh.worker.accessToken);
      await c.emitAck('location.subscribe', { bookingId: fresh.booking.id });
      expect((await publish(w, fresh.booking.id)).ok).toBe(true);

      await h.cancelBooking(fresh.customer, fresh.booking.id).expect(200);
      // the very next publish is refused by the database state, before any outbox delivery
      expect(await publish(w, fresh.booking.id)).toMatchObject({ ok: false, error: { code: 'LOCATION_SHARING_NOT_ACTIVE' } });
      const read = await h.api().get(`/api/v1/bookings/${fresh.booking.id}/location`).set(h.bearer(fresh.customer.accessToken)).expect(200);
      expect(read.body).toEqual({ available: false, reason: 'SHARING_NOT_ACTIVE' });

      await dispatcher.runOnce();
      await c.waitFor('location.ended.v1', (p) => p.bookingId === fresh.booking.id);
      expect(await h.store.get(KEYS.location(fresh.booking.id))).toBeNull();
      expect(await c.emitAck('location.subscribe', { bookingId: fresh.booking.id })).toMatchObject({ ok: false, error: { code: 'LOCATION_SHARING_NOT_ACTIVE' } });
    });

    it('is not available before payment (PAYMENT_PENDING) or after completion', async () => {
      const pending = await h.acceptedBooking();
      const w = await h.connect(pending.worker.accessToken);
      expect(await publish(w, pending.booking.id)).toMatchObject({ ok: false, error: { code: 'LOCATION_SHARING_NOT_ACTIVE' } });

      const done = await h.confirmedBooking();
      await h.startWork(done.worker, done.booking.id).expect(200);
      const dw = await h.connect(done.worker.accessToken);
      expect((await publish(dw, done.booking.id)).ok).toBe(true); // IN_PROGRESS is eligible
      await h.completeWork(done.worker, done.booking.id).expect(200);
      expect(await publish(dw, done.booking.id)).toMatchObject({ ok: false, error: { code: 'LOCATION_SHARING_NOT_ACTIVE' } });
    });

    it('a suspended worker can no longer publish', async () => {
      const p2 = await h.confirmedBooking();
      const w = await h.connect(p2.worker.accessToken);
      expect((await publish(w, p2.booking.id)).ok).toBe(true);
      await h.prisma.workerProfile.update({ where: { id: p2.worker.workerId }, data: { verificationStatus: 'SUSPENDED' } });
      await new Promise((r) => setTimeout(r, 20));
      expect(await publish(w, p2.booking.id)).toMatchObject({ ok: false, error: { code: 'WORKER_NOT_APPROVED' } });
    });
  });

  describe('booking events (transactional outbox)', () => {
    it('writes the outbox row in the same transaction: a rolled-back change announces nothing', async () => {
      const p = await h.confirmedBooking();
      await dispatcher.runOnce();
      const before = await h.prisma.realtimeOutboxEvent.count({ where: { bookingId: p.booking.id } });
      await expect(
        h.prisma.$transaction(async (tx) => {
          await recordEvent(tx, { bookingId: p.booking.id, type: 'WORK_STARTED', fromStatus: 'CONFIRMED', toStatus: 'IN_PROGRESS' });
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');
      expect(await h.prisma.realtimeOutboxEvent.count({ where: { bookingId: p.booking.id } })).toBe(before);
      expect(await h.prisma.bookingEvent.count({ where: { bookingId: p.booking.id, type: 'WORK_STARTED' } })).toBe(0);
    });

    it('delivers a committed change after commit, once, with a minimal payload', async () => {
      const p = await h.confirmedBooking();
      await dispatcher.runOnce();
      const c = await h.connect(p.customer.accessToken);
      const w = await h.connect(p.worker.accessToken);
      await c.emitAck('booking.join', { bookingId: p.booking.id });
      await w.emitAck('booking.join', { bookingId: p.booking.id });

      await h.startWork(p.worker, p.booking.id).expect(200);
      // nothing is announced until the dispatcher runs (after commit, off the request path)
      expect(await c.expectNo('booking.event.v1', undefined, 150)).toBe(true);
      // two dispatchers at once must still deliver exactly once
      const [a, b] = await Promise.all([dispatcher.runOnce(), dispatcher.runOnce()]);
      expect(a.delivered + b.delivered).toBeGreaterThanOrEqual(1);

      const evt = await c.waitFor('booking.event.v1', (e) => e.type === 'WORK_STARTED');
      expect(Object.keys(evt).sort()).toEqual(['bookingId', 'eventId', 'fromStatus', 'occurredAt', 'toStatus', 'type', 'v']);
      expect(evt).toMatchObject({ v: 1, bookingId: p.booking.id, fromStatus: 'CONFIRMED', toStatus: 'IN_PROGRESS' });
      await w.waitFor('booking.event.v1', (e) => e.type === 'WORK_STARTED');
      await new Promise((r) => setTimeout(r, 150));
      expect(c.events.filter((e) => e.event === 'booking.event.v1' && e.payload.eventId === evt.eventId)).toHaveLength(1);
      expect(JSON.stringify(evt)).not.toMatch(/price|amount|address|phone|note/i);
    });

    it('keeps quote activity away from the assigned worker and everything away from other bookings', async () => {
      const p = await h.confirmedBooking();
      const other = await h.confirmedBooking();
      await dispatcher.runOnce();
      const c = await h.connect(p.customer.accessToken);
      const w = await h.connect(p.worker.accessToken);
      const o = await h.connect(other.customer.accessToken);
      await c.emitAck('booking.join', { bookingId: p.booking.id });
      await w.emitAck('booking.join', { bookingId: p.booking.id });
      await o.emitAck('booking.join', { bookingId: other.booking.id });

      await h.prisma.$transaction((tx) => recordEvent(tx, { bookingId: p.booking.id, type: 'QUOTE_SUBMITTED', amountHalalas: 99999 }));
      await h.prisma.$transaction((tx) => recordEvent(tx, { bookingId: p.booking.id, type: 'WORK_STARTED', fromStatus: 'CONFIRMED', toStatus: 'IN_PROGRESS' }));
      await dispatcher.runOnce();

      await c.waitFor('booking.event.v1', (e) => e.type === 'QUOTE_SUBMITTED');
      await w.waitFor('booking.event.v1', (e) => e.type === 'WORK_STARTED');
      expect(await w.expectNo('booking.event.v1', (e) => e.type === 'QUOTE_SUBMITTED')).toBe(true);
      expect(await o.expectNo('booking.event.v1')).toBe(true);
    });

    it('retries a failed delivery with backoff, then gives up and reports instead of retrying forever', async () => {
      const p = await h.confirmedBooking();
      await dispatcher.runOnce();
      await h.prisma.$transaction((tx) => recordEvent(tx, { bookingId: p.booking.id, type: 'WORK_STARTED', fromStatus: 'CONFIRMED', toStatus: 'IN_PROGRESS' }));
      const spy = jest.spyOn(SocketEmitter.prototype, 'toRoomOrThrow').mockImplementation(() => {
        throw new Error('REDIS_DOWN');
      });
      try {
        const now = new Date();
        const first = await dispatcher.runOnce(now);
        expect(first).toMatchObject({ delivered: 0, failed: 1 });
        let row = await h.prisma.realtimeOutboxEvent.findFirstOrThrow({ where: { bookingId: p.booking.id, dispatchedAt: null } });
        expect(row).toMatchObject({ attempts: 1, deadAt: null, lastError: 'REDIS_DOWN' });
        expect(row.nextAttemptAt.getTime()).toBeGreaterThan(now.getTime());

        // not yet due: untouched
        expect((await dispatcher.runOnce(now)).claimed).toBe(0);

        // due again: attempt 2 hits OUTBOX_MAX_ATTEMPTS=2 and the row is parked as dead
        const later = new Date(now.getTime() + 5 * 60_000);
        expect(await dispatcher.runOnce(later)).toMatchObject({ failed: 0, dead: 1 });
        row = await h.prisma.realtimeOutboxEvent.findUniqueOrThrow({ where: { id: row.id } });
        expect(row.deadAt).not.toBeNull();
        expect((await dispatcher.runOnce(new Date(later.getTime() + 3_600_000))).claimed).toBe(0);
        expect((await dispatcher.report()).dead).toBeGreaterThanOrEqual(1);
      } finally {
        spy.mockRestore();
      }
    });

    it('delivers after a transient failure on the next due run', async () => {
      const p = await h.confirmedBooking();
      await dispatcher.runOnce();
      const c = await h.connect(p.customer.accessToken);
      await c.emitAck('booking.join', { bookingId: p.booking.id });
      await h.prisma.$transaction((tx) => recordEvent(tx, { bookingId: p.booking.id, type: 'WORK_STARTED', fromStatus: 'CONFIRMED', toStatus: 'IN_PROGRESS' }));
      const spy = jest.spyOn(SocketEmitter.prototype, 'toRoomOrThrow').mockImplementationOnce(() => {
        throw new Error('REDIS_DOWN');
      });
      try {
        const now = new Date();
        expect(await dispatcher.runOnce(now)).toMatchObject({ failed: 1 });
      } finally {
        spy.mockRestore();
      }
      expect(await dispatcher.runOnce(new Date(Date.now() + 60_000))).toMatchObject({ delivered: 1 });
      await c.waitFor('booking.event.v1', (e) => e.type === 'WORK_STARTED');
    });

    it('purges only finished rows older than the retention period', async () => {
      const p = await h.confirmedBooking();
      await dispatcher.runOnce();
      const pending = await h.prisma.$transaction(async (tx) => {
        await recordEvent(tx, { bookingId: p.booking.id, type: 'WORK_STARTED', fromStatus: 'CONFIRMED', toStatus: 'IN_PROGRESS' });
        return tx.realtimeOutboxEvent.findFirstOrThrow({ where: { bookingId: p.booking.id, dispatchedAt: null } });
      });
      const future = new Date(Date.now() + 30 * 86_400_000);
      const removed = await dispatcher.purge(future);
      expect(removed).toBeGreaterThanOrEqual(1);
      expect(await h.prisma.realtimeOutboxEvent.findUnique({ where: { id: pending.id } })).not.toBeNull(); // undelivered rows are never purged
      await dispatcher.runOnce();
    });
  });

  describe('token lifecycle and flood control', () => {
    it('answers TOKEN_EXPIRED after expiry, accepts auth.refresh for the same session, and closes the socket if nobody refreshes', async () => {
      const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
      const expOf = (t: string) => (JSON.parse(Buffer.from(t.split('.')[1]!, 'base64url').toString()) as { exp: number }).exp * 1000;

      // Lifetimes leave generous room for a slow machine: the connect and first join must finish before the token expires, and the
      // expiry check then runs inside the 1 s grace window, which is polled instead of hit with one fixed sleep.
      const token = await forge(ctx.customer.accessToken, 6);
      const c = await h.connect(token);
      expect((await c.emitAck('booking.join', { bookingId: ctx.booking.id })).ok).toBe(true);
      await sleep(Math.max(0, expOf(token) - Date.now() + 50));
      let expired: { ok: boolean; error?: { code: string } } | undefined;
      for (let i = 0; i < 8 && c.raw.connected; i++) {
        const answer = (await c.emitAck('booking.join', { bookingId: ctx.booking.id })) as { ok: boolean; error?: { code: string } };
        expired = answer;
        if (!answer.ok) break;
        await sleep(100);
      }
      expect(expired).toMatchObject({ ok: false, error: { code: 'TOKEN_EXPIRED' } });
      const refreshed = await c.emitAck('auth.refresh', { token: await forge(ctx.customer.accessToken, 60) });
      expect(refreshed.ok).toBe(true);
      expect((await c.emitAck('booking.join', { bookingId: ctx.booking.id })).ok).toBe(true);

      const lonely = await h.connect(await forge(ctx.customer.accessToken, 4));
      await lonely.waitFor('session.ending.v1', (p) => p.reason === 'TOKEN_EXPIRED', 9000);
      await new Promise<void>((resolve) => (lonely.raw.connected ? lonely.raw.once('disconnect', () => resolve()) : resolve()));
      expect(lonely.raw.connected).toBe(false);
    });

    it('refuses auth.refresh with another user\'s token, another session, or garbage', async () => {
      const c = await h.connect(ctx.customer.accessToken);
      expect(await c.emitAck('auth.refresh', { token: stranger.accessToken })).toMatchObject({ ok: false, error: { code: 'TOKEN_MISMATCH' } });
      const sameUserOtherSession = await h.otpSignIn('customer', ctx.customer.phone);
      expect(await c.emitAck('auth.refresh', { token: sameUserOtherSession.accessToken })).toMatchObject({ ok: false, error: { code: 'TOKEN_MISMATCH' } });
      expect(await c.emitAck('auth.refresh', { token: 'nope' })).toMatchObject({ ok: false, error: { code: 'TOKEN_INVALID' } });
      expect(await c.emitAck('auth.refresh', {})).toMatchObject({ ok: false });
    });

    it('ends a socket whose session is revoked while connected, and removes a worker who is suspended from the room', async () => {
      const victim = await h.confirmedBooking();
      await dispatcher.runOnce();
      const w = await h.connect(victim.worker.accessToken);
      const c = await h.connect(victim.customer.accessToken);
      await w.emitAck('booking.join', { bookingId: victim.booking.id });
      await c.emitAck('booking.join', { bookingId: victim.booking.id });

      await h.prisma.workerProfile.update({ where: { id: victim.worker.workerId }, data: { verificationStatus: 'SUSPENDED' } });
      await w.waitFor('booking.access-revoked.v1', (p) => p.bookingId === victim.booking.id, 4000);
      await h.prisma.$transaction((tx) => recordEvent(tx, { bookingId: victim.booking.id, type: 'WORK_STARTED', fromStatus: 'CONFIRMED', toStatus: 'IN_PROGRESS' }));
      await dispatcher.runOnce();
      await c.waitFor('booking.event.v1', (e) => e.type === 'WORK_STARTED');
      expect(await w.expectNo('booking.event.v1')).toBe(true);

      await h.prisma.refreshToken.updateMany({ where: { userId: victim.customer.userId, familyId: claimsOf(victim.customer.accessToken).sid }, data: { revokedAt: new Date() } });
      await c.waitFor('session.ending.v1', (p) => p.reason === 'SESSION_REVOKED', 4000);
    });

    it('rate limits event floods and closes the connection of a persistent offender', async () => {
      const c = await h.connect(stranger.accessToken);
      const results = await Promise.all(Array.from({ length: 62 }, () => c.emitAck('booking.leave', { bookingId: ctx.booking.id })));
      expect(results.filter((r) => r.ok).length).toBe(60);
      expect(results.filter((r) => !r.ok && r.error.code === 'RATE_LIMITED').length).toBe(2);
      expect(c.raw.connected).toBe(true); // two strikes are tolerated

      const abuser = await h.connect(stranger.accessToken);
      for (let i = 0; i < 70; i++) abuser.raw.emit('booking.leave', { bookingId: ctx.booking.id });
      await abuser.waitFor('session.ending.v1', (p) => p.reason === 'RATE_LIMITED', 3000);
    });

    it('closes a socket that sends an oversized message', async () => {
      const c = await h.connect(stranger.accessToken);
      const closed = new Promise<void>((resolve) => c.raw.once('disconnect', () => resolve()));
      c.raw.emit('chat.send', { bookingId: ctx.booking.id, clientMessageId: 'x'.repeat(20000), body: 'hi' });
      await closed;
      expect(c.raw.connected).toBe(false);
    });

    it('caps open sockets per account, closing the oldest', async () => {
      const sockets: TestSocket[] = [];
      for (let i = 0; i < 6; i++) sockets.push(await h.connect(stranger.accessToken));
      await sockets[0]!.waitFor('session.ending.v1', (p) => p.reason === 'TOO_MANY_CONNECTIONS', 3000);
      expect(sockets.slice(1).every((s) => s.raw.connected)).toBe(true);
    });
  });
});
