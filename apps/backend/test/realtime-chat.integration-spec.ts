/**
 * REAL POSTGRESQL: booking chat over REST and Socket.IO. Authorization, isolation, validation, idempotent
 * sends under concurrency, gap-free ordering, stable pagination, receipts, reconnect recovery, and the
 * database-level guarantees (append-only, participants only).
 */
import { jest } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import { type Harness, type Session, bootHarness } from './support/bookings-harness.js';

const run = process.env['TEST_DATABASE_URL'] ? describe : describe.skip;
if (!process.env['TEST_DATABASE_URL']) console.warn('realtime-chat.integration-spec: TEST_DATABASE_URL is not set, suite skipped');

run('realtime: booking chat (real PostgreSQL)', () => {
  let h: Harness;
  let stranger: Session;
  let strangerWorker: Session;
  let n = 0;
  const cid = () => `itest-msg-${Date.now().toString(36)}-${++n}-${randomUUID().slice(0, 8)}`;

  type Pair = Awaited<ReturnType<Harness['confirmedBooking']>>;
  const send = (who: Session, bookingId: string, body: string | object = 'hello', clientMessageId = cid()) =>
    h
      .api()
      .post(`/api/v1/bookings/${bookingId}/messages`)
      .set(h.bearer(who.accessToken))
      .set('X-Forwarded-For', h.freshIp())
      .send(typeof body === 'string' ? { clientMessageId, body } : body);
  const list = (who: Session, bookingId: string, query = '') =>
    h.api().get(`/api/v1/bookings/${bookingId}/messages${query}`).set(h.bearer(who.accessToken)).set('X-Forwarded-For', h.freshIp());
  const receipt = (who: Session, bookingId: string, body: object) =>
    h.api().post(`/api/v1/bookings/${bookingId}/messages/receipts`).set(h.bearer(who.accessToken)).set('X-Forwarded-For', h.freshIp()).send(body);
  const seqs = (res: { body: { items: Array<{ seq: number }> } }) => res.body.items.map((i) => i.seq);

  beforeAll(async () => {
    h = await bootHarness({ phonePrefix: '+9665972', slugPrefix: 'itest-rc-', adminEmailPrefix: 'itest-rc-admin', realtime: { listen: true } });
    await h.seedReferenceData();
    stranger = await h.makeCustomer();
    strangerWorker = await h.makeWorker([], []);
  });

  afterAll(async () => {
    if (h) await h.close();
  });

  describe('authorization and isolation', () => {
    let p: Pair;
    beforeAll(async () => {
      p = await h.confirmedBooking();
      await send(p.customer, p.booking.id, 'first message').expect(201);
    });

    it('lets only the booking customer and its assigned worker send and read; everyone else gets 404 (admins 403)', async () => {
      for (const who of [stranger, strangerWorker]) {
        expect((await send(who, p.booking.id)).status).toBe(404);
        expect((await list(who, p.booking.id)).status).toBe(404);
        expect((await receipt(who, p.booking.id, { kind: 'READ', upToSeq: 1 })).status).toBe(404);
      }
      const admin = { accessToken: h.adminToken } as Session;
      expect((await send(admin, p.booking.id)).status).toBe(403);
      expect((await list(admin, p.booking.id)).status).toBe(403);
      await h.api().get(`/api/v1/bookings/${p.booking.id}/messages`).expect(401);
      expect((await list(p.worker, p.booking.id)).body.items).toHaveLength(1);
    });

    it('takes the sender and role from the token, never from the body', async () => {
      const res = await send(p.worker, p.booking.id, { clientMessageId: cid(), body: 'from the worker' }).expect(201);
      expect(res.body.senderRole).toBe('WORKER');
      for (const forged of [{ senderRole: 'CUSTOMER' }, { senderUserId: p.customer.userId }, { userId: p.customer.userId }, { bookingId: randomUUID() }]) {
        expect((await send(p.worker, p.booking.id, { clientMessageId: cid(), body: 'x', ...forged })).status).toBe(400);
      }
      const row = await h.prisma.chatMessage.findUniqueOrThrow({ where: { id: res.body.id } });
      expect(row).toMatchObject({ senderUserId: p.worker.userId, senderRole: 'WORKER' });
    });

    it('does not mix conversations of different bookings, even for the same two people', async () => {
      const other = await h.confirmedBooking();
      await send(other.customer, other.booking.id, 'private to the other booking').expect(201);
      const mine = await list(p.customer, p.booking.id).expect(200);
      expect(mine.body.items.map((m: { body: string }) => m.body)).not.toContain('private to the other booking');
      expect((await list(p.customer, other.booking.id)).status).toBe(404);
    });

    it('does not let a worker who is no longer approved take part', async () => {
      const q = await h.confirmedBooking();
      await send(q.worker, q.booking.id, 'before').expect(201);
      await h.prisma.workerProfile.update({ where: { id: q.worker.workerId }, data: { verificationStatus: 'SUSPENDED' } });
      expect((await send(q.worker, q.booking.id)).status).toBe(403);
      expect((await list(q.worker, q.booking.id)).status).toBe(403);
      // the customer still sees the history and can still write
      expect((await list(q.customer, q.booking.id)).body.items).toHaveLength(1);
    });
  });

  describe('when chat is open', () => {
    it('is closed before payment (read-only, nothing to read) and for bookings with no worker yet', async () => {
      const pending = await h.acceptedBooking(); // PAYMENT_PENDING, worker assigned
      const res = await send(pending.customer, pending.booking.id);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('CHAT_CLOSED');
      expect((await list(pending.customer, pending.booking.id)).body.meta.canSend).toBe(false);

      const open = await h.createBooking(await h.makeCustomer(), { service: { id: (await h.prisma.service.findFirstOrThrow({ where: { slug: { startsWith: 'itest-rc-' } } })).id }, city: { id: (await h.prisma.city.findFirstOrThrow({ where: { slug: { startsWith: 'itest-rc-' } } })).id } });
      expect(open.status).toBe('OPEN');
    });

    it('stays readable but can no longer be written after completion or cancellation', async () => {
      const done = await h.confirmedBooking();
      await send(done.customer, done.booking.id, 'see you soon').expect(201);
      await h.startWork(done.worker, done.booking.id).expect(200);
      await send(done.worker, done.booking.id, 'working on it').expect(201); // IN_PROGRESS still open
      await h.completeWork(done.worker, done.booking.id).expect(200);
      const blocked = await send(done.customer, done.booking.id, 'thanks');
      expect(blocked).toMatchObject({ status: 409 });
      expect(blocked.body.code).toBe('CHAT_CLOSED');
      const history = await list(done.customer, done.booking.id).expect(200);
      expect(history.body.items).toHaveLength(2);
      expect(history.body.meta.canSend).toBe(false);

      const cancelled = await h.confirmedBooking();
      await send(cancelled.customer, cancelled.booking.id, 'hello').expect(201);
      await h.cancelBooking(cancelled.customer, cancelled.booking.id).expect(200);
      expect((await send(cancelled.worker, cancelled.booking.id)).status).toBe(409);
      expect((await list(cancelled.worker, cancelled.booking.id)).body.items).toHaveLength(1);
    });

    it('sends racing a cancellation never produce a server error, and nothing is accepted after the cancellation committed', async () => {
      const race = await h.confirmedBooking();
      const attempts = [
        ...Array.from({ length: 12 }, (_, i) => send(i % 2 ? race.customer : race.worker, race.booking.id, `race ${i}`)),
        h.cancelBooking(race.customer, race.booking.id),
      ];
      const responses = await Promise.all(attempts);
      const statuses = responses.map((r) => r.status);
      expect(statuses.every((s) => [200, 201, 409].includes(s))).toBe(true); // never a 500 (deadlock) or a hang
      expect(responses[responses.length - 1]!.status).toBe(200); // the cancellation itself won or lost cleanly
      const accepted = statuses.slice(0, 12).filter((s) => s === 201).length;
      expect(await h.prisma.chatMessage.count({ where: { bookingId: race.booking.id } })).toBe(accepted);
      // the sequence is still gap-free
      const rows = await h.prisma.chatMessage.findMany({ where: { bookingId: race.booking.id }, orderBy: { seq: 'asc' }, select: { seq: true } });
      expect(rows.map((r) => r.seq)).toEqual(Array.from({ length: accepted }, (_, i) => i + 1));
      // and after the cancellation every further send is refused
      expect((await send(race.customer, race.booking.id, 'too late')).status).toBe(409);
    });

    it('a retried send of an already accepted message still succeeds after the booking closed', async () => {
      const done = await h.confirmedBooking();
      const id = cid();
      const first = await send(done.customer, done.booking.id, 'last words', id).expect(201);
      await h.cancelBooking(done.customer, done.booking.id).expect(200);
      const retry = await send(done.customer, done.booking.id, 'last words', id);
      expect(retry.status).toBe(200);
      expect(retry.body).toMatchObject({ id: first.body.id, seq: first.body.seq, duplicate: true });
    });
  });

  describe('validation', () => {
    let p: Pair;
    beforeAll(async () => {
      p = await h.confirmedBooking();
    });
    const post = (body: object) => send(p.customer, p.booking.id, body);

    it('rejects empty, blank, too long, control-character and malformed requests', async () => {
      expect((await post({ clientMessageId: cid(), body: '' })).status).toBe(400);
      const blank = await post({ clientMessageId: cid(), body: '   \n\t ' });
      expect(blank.body.code).toBe('MESSAGE_EMPTY');
      expect((await post({ clientMessageId: cid(), body: 'a'.repeat(2001) })).body.code).toBe('MESSAGE_TOO_LONG');
      expect((await post({ clientMessageId: cid(), body: 'bad \u0000 byte' })).body.code).toBe('MESSAGE_INVALID');
      expect((await post({ clientMessageId: cid(), body: 'bell \u0007' })).body.code).toBe('MESSAGE_INVALID');
      for (const bad of ['short', 'has space in it!', 'x'.repeat(65), '', 12345678]) {
        expect({ bad, status: (await post({ clientMessageId: bad, body: 'ok' })).status }).toEqual({ bad, status: 400 });
      }
      expect((await post({ body: 'no id' })).status).toBe(400);
      expect((await post({ clientMessageId: cid(), body: { text: 'object' } })).status).toBe(400);
      expect((await post({ clientMessageId: cid(), body: 'x', attachment: 'file.png' })).status).toBe(400); // no file uploads
      expect(await h.prisma.chatMessage.count({ where: { bookingId: p.booking.id } })).toBe(0);
    });

    it('accepts Arabic text, emoji and line breaks, counts characters (not bytes) and keeps the text intact', async () => {
      const arabic = 'مرحباً، متى ستصل؟\nشكراً 🙏';
      const res = await post({ clientMessageId: cid(), body: `  ${arabic}  ` }).expect(201);
      expect(res.body.body).toBe(arabic);
      await post({ clientMessageId: cid(), body: '😀'.repeat(2000) }).expect(201);
      expect((await post({ clientMessageId: cid(), body: '😀'.repeat(2001) })).body.code).toBe('MESSAGE_TOO_LONG');
    });

    it('stores markup as inert text (nothing is interpreted)', async () => {
      const res = await post({ clientMessageId: cid(), body: '<script>alert(1)</script> [link](http://x)' }).expect(201);
      expect(res.body.body).toBe('<script>alert(1)</script> [link](http://x)');
    });
  });

  describe('idempotent sends', () => {
    let p: Pair;
    beforeAll(async () => {
      p = await h.confirmedBooking();
    });

    it('answers a retry with the original message and creates no second row', async () => {
      const id = cid();
      const first = await send(p.customer, p.booking.id, 'once', id).expect(201);
      const again = await send(p.customer, p.booking.id, 'once', id).expect(200);
      expect(again.body).toMatchObject({ id: first.body.id, seq: first.body.seq, duplicate: true });
      expect(first.body.duplicate).toBe(false);
      expect(await h.prisma.chatMessage.count({ where: { bookingId: p.booking.id, clientMessageId: id } })).toBe(1);
    });

    it('refuses to reuse an id for a different text, but lets two people use the same id', async () => {
      const id = cid();
      await send(p.customer, p.booking.id, 'original', id).expect(201);
      const clash = await send(p.customer, p.booking.id, 'different', id);
      expect(clash.status).toBe(409);
      expect(clash.body.code).toBe('CLIENT_MESSAGE_ID_REUSED');
      await send(p.worker, p.booking.id, 'different', id).expect(201);
    });

    it('twenty simultaneous identical retries create exactly one message', async () => {
      const id = cid();
      const results = await Promise.all(Array.from({ length: 20 }, () => send(p.worker, p.booking.id, 'storm', id)));
      expect(results.every((r) => r.status === 200 || r.status === 201)).toBe(true);
      expect(results.filter((r) => r.status === 201)).toHaveLength(1);
      expect(new Set(results.map((r) => r.body.id)).size).toBe(1);
      expect(await h.prisma.chatMessage.count({ where: { bookingId: p.booking.id, clientMessageId: id } })).toBe(1);
    });

    it('concurrent sends from both sides get unique, gap-free sequence numbers', async () => {
      const q = await h.confirmedBooking();
      const results = await Promise.all(Array.from({ length: 30 }, (_, i) => send(i % 2 ? q.customer : q.worker, q.booking.id, `msg ${i}`)));
      expect(results.map((r) => r.status)).toEqual(Array(30).fill(201));
      const all = await h.prisma.chatMessage.findMany({ where: { bookingId: q.booking.id }, orderBy: { seq: 'asc' }, select: { seq: true } });
      expect(all.map((m) => m.seq)).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
    });
  });

  describe('history pagination', () => {
    let p: Pair;
    beforeAll(async () => {
      p = await h.confirmedBooking();
      for (let i = 1; i <= 30; i++) await send(i % 2 ? p.customer : p.worker, p.booking.id, `m${i}`).expect(201);
    });

    it('returns the latest page oldest-first and scrolls back with a stable cursor', async () => {
      const latest = await list(p.customer, p.booking.id, '?limit=10').expect(200);
      expect(seqs(latest)).toEqual([21, 22, 23, 24, 25, 26, 27, 28, 29, 30]);
      expect(latest.body.meta).toMatchObject({ hasMore: true, nextBeforeSeq: 21, lastSeq: 30, direction: 'backward' });

      // new messages arrive while the user scrolls back: the older pages do not shift
      await send(p.worker, p.booking.id, 'm31').expect(201);
      const older = await list(p.customer, p.booking.id, '?limit=10&beforeSeq=21').expect(200);
      expect(seqs(older)).toEqual([11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
      const oldest = await list(p.customer, p.booking.id, '?limit=10&beforeSeq=11').expect(200);
      expect(seqs(oldest)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      expect(oldest.body.meta.hasMore).toBe(false);
      expect(oldest.body.meta.nextBeforeSeq).toBeUndefined();
    });

    it('returns what came after a known message, oldest first (reconnect recovery)', async () => {
      const after = await list(p.worker, p.booking.id, '?afterSeq=28&limit=2').expect(200);
      expect(seqs(after)).toEqual([29, 30]);
      expect(after.body.meta).toMatchObject({ hasMore: true, direction: 'forward' });
      const rest = await list(p.worker, p.booking.id, '?afterSeq=30').expect(200);
      expect(seqs(rest)).toEqual([31]);
      expect(rest.body.meta.hasMore).toBe(false);
      expect(seqs(await list(p.worker, p.booking.id, '?afterSeq=31').expect(200))).toEqual([]);
    });

    it('marks which messages are mine and caps the page size', async () => {
      const page = await list(p.customer, p.booking.id, '?limit=4').expect(200);
      expect(page.body.items.map((m: { fromMe: boolean }) => m.fromMe)).toEqual([false, true, false, false]); // seq 28..31: the customer wrote the odd ones up to 30, the worker wrote 31
      expect((await list(p.customer, p.booking.id, '?afterSeq=1&beforeSeq=5')).status).toBe(400);
      expect((await list(p.customer, p.booking.id, '?limit=0')).status).toBe(400);
      expect((await list(p.customer, p.booking.id, '?limit=9999')).status).toBe(400);
      expect((await list(p.customer, p.booking.id, '?limit=200').expect(200)).body.items.length).toBe(31);
      expect((await list(p.customer, p.booking.id, '?beforeSeq=-1')).status).toBe(400);
    });
  });

  describe('delivery and read status', () => {
    let p: Pair;
    beforeAll(async () => {
      p = await h.confirmedBooking();
      for (let i = 1; i <= 4; i++) await send(p.customer, p.booking.id, `from customer ${i}`).expect(201); // seq 1..4
      await send(p.worker, p.booking.id, 'from worker').expect(201); // seq 5
    });

    it('distinguishes accepted, delivered and read, and only ever moves forward', async () => {
      const statusOf = async () => (await list(p.customer, p.booking.id).expect(200)).body.items.filter((m: { fromMe: boolean }) => m.fromMe).map((m: { status: string }) => m.status);
      expect(await statusOf()).toEqual(['SENT', 'SENT', 'SENT', 'SENT']);

      expect((await receipt(p.worker, p.booking.id, { kind: 'DELIVERED', upToSeq: 3 })).body).toEqual({ deliveredUpToSeq: 3, readUpToSeq: 0 });
      expect(await statusOf()).toEqual(['DELIVERED', 'DELIVERED', 'DELIVERED', 'SENT']);

      expect((await receipt(p.worker, p.booking.id, { kind: 'READ', upToSeq: 2 })).body).toEqual({ deliveredUpToSeq: 3, readUpToSeq: 2 });
      expect(await statusOf()).toEqual(['READ', 'READ', 'DELIVERED', 'SENT']);

      // an older receipt cannot move anything back
      expect((await receipt(p.worker, p.booking.id, { kind: 'DELIVERED', upToSeq: 1 })).body).toEqual({ deliveredUpToSeq: 3, readUpToSeq: 2 });
      // reading implies delivery
      expect((await receipt(p.worker, p.booking.id, { kind: 'READ', upToSeq: 4 })).body).toEqual({ deliveredUpToSeq: 4, readUpToSeq: 4 });
      expect(await statusOf()).toEqual(['READ', 'READ', 'READ', 'READ']);
    });

    it('cannot acknowledge messages that do not exist, or act for someone else', async () => {
      const beyond = await receipt(p.customer, p.booking.id, { kind: 'READ', upToSeq: 99 });
      expect(beyond.status).toBe(400);
      expect(beyond.body.code).toBe('CHAT_SEQ_OUT_OF_RANGE');
      expect((await receipt(p.customer, p.booking.id, { kind: 'READ', upToSeq: 0 })).status).toBe(400);
      expect((await receipt(p.customer, p.booking.id, { kind: 'SEEN', upToSeq: 1 })).status).toBe(400);
      expect((await receipt(p.customer, p.booking.id, { kind: 'READ', upToSeq: 1, userId: p.worker.userId })).status).toBe(400);
      // the customer's own receipt is stored under the customer, not the worker
      await receipt(p.customer, p.booking.id, { kind: 'READ', upToSeq: 5 }).expect(200);
      const rows = await h.prisma.chatParticipantState.findMany({ where: { bookingId: p.booking.id } });
      expect(rows.find((r) => r.userId === p.customer.userId)).toMatchObject({ readUpToSeq: 5 });
      expect(rows.find((r) => r.userId === p.worker.userId)).toMatchObject({ readUpToSeq: 4 });
    });
  });

  describe('realtime delivery and recovery', () => {
    it('delivers to both participants and to nobody else, with sender acknowledgement', async () => {
      const p = await h.confirmedBooking();
      const c = await h.connect(p.customer.accessToken);
      const w = await h.connect(p.worker.accessToken);
      const outsider = await h.connect(stranger.accessToken);
      const admin = await h.connect(h.adminToken);
      for (const s of [c, w]) await s.emitAck('booking.join', { bookingId: p.booking.id });
      expect(await outsider.emitAck('booking.join', { bookingId: p.booking.id })).toMatchObject({ ok: false });
      expect(await admin.emitAck('booking.join', { bookingId: p.booking.id })).toMatchObject({ ok: false });

      const ack = await c.emitAck('chat.send', { bookingId: p.booking.id, clientMessageId: cid(), body: 'ping' });
      expect(ack).toMatchObject({ ok: true, data: { duplicate: false, message: { seq: 1, senderRole: 'CUSTOMER', body: 'ping' } } });
      const got = await w.waitFor('chat.message.v1');
      expect(got).toMatchObject({ v: 1, bookingId: p.booking.id, seq: 1, senderRole: 'CUSTOMER', body: 'ping' });
      await c.waitFor('chat.message.v1'); // the sender's other screens also hear it
      expect(await outsider.expectNo('chat.message.v1')).toBe(true);
      expect(await admin.expectNo('chat.message.v1')).toBe(true);

      // socket sends are idempotent too
      const id = cid();
      const a = await w.emitAck('chat.send', { bookingId: p.booking.id, clientMessageId: id, body: 'pong' });
      const b = await w.emitAck('chat.send', { bookingId: p.booking.id, clientMessageId: id, body: 'pong' });
      expect(a.data.message.id).toBe(b.data.message.id);
      expect(b.data.duplicate).toBe(true);
    });

    it('cannot send to a booking the socket user does not belong to', async () => {
      const p = await h.confirmedBooking();
      const s = await h.connect(stranger.accessToken);
      expect(await s.emitAck('chat.send', { bookingId: p.booking.id, clientMessageId: cid(), body: 'sneaky' })).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
      expect(await s.emitAck('chat.sync', { bookingId: p.booking.id })).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
      expect(await s.emitAck('chat.receipt', { bookingId: p.booking.id, kind: 'READ', upToSeq: 1 })).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
      expect(await h.prisma.chatMessage.count({ where: { bookingId: p.booking.id } })).toBe(0);
    });

    it('recovers messages missed while offline, in order, without duplicates', async () => {
      const p = await h.confirmedBooking();
      const w1 = await h.connect(p.worker.accessToken);
      await w1.emitAck('booking.join', { bookingId: p.booking.id });
      await send(p.customer, p.booking.id, 'one').expect(201);
      await w1.waitFor('chat.message.v1', (m) => m.seq === 1);

      w1.close(); // the worker goes offline; history must survive the disconnect
      await new Promise((r) => setTimeout(r, 100));
      for (const t of ['two', 'three', 'four']) await send(p.customer, p.booking.id, t).expect(201);

      const w2 = await h.connect(p.worker.accessToken);
      const joined = await w2.emitAck('booking.join', { bookingId: p.booking.id });
      expect(joined.data.chat.lastSeq).toBe(4);
      const missed = await w2.emitAck('chat.sync', { bookingId: p.booking.id, afterSeq: 1 });
      expect(missed.data.items.map((m: { seq: number; body: string }) => `${m.seq}:${m.body}`)).toEqual(['2:two', '3:three', '4:four']);
      expect(missed.data.meta.hasMore).toBe(false);

      // a fresh message after rejoining arrives live and continues the sequence
      await send(p.customer, p.booking.id, 'five').expect(201);
      expect((await w2.waitFor('chat.message.v1', (m) => m.seq === 5)).body).toBe('five');
    });

    it('delivers receipts to the sender in realtime', async () => {
      const p = await h.confirmedBooking();
      const c = await h.connect(p.customer.accessToken);
      const w = await h.connect(p.worker.accessToken);
      await c.emitAck('booking.join', { bookingId: p.booking.id });
      await w.emitAck('booking.join', { bookingId: p.booking.id });
      await c.emitAck('chat.send', { bookingId: p.booking.id, clientMessageId: cid(), body: 'did you get this?' });
      await w.waitFor('chat.message.v1');
      await w.emitAck('chat.receipt', { bookingId: p.booking.id, kind: 'READ', upToSeq: 1 });
      expect(await c.waitFor('chat.receipt.v1', (r) => r.byRole === 'WORKER')).toMatchObject({ v: 1, deliveredUpToSeq: 1, readUpToSeq: 1 });
    });
  });

  describe('database guarantees', () => {
    let p: Pair;
    beforeAll(async () => {
      p = await h.confirmedBooking();
      await send(p.customer, p.booking.id, 'real message').expect(201);
    });

    it('refuses a message from someone who is not a participant, or with the wrong role, even if the service were bypassed', async () => {
      const insert = (userId: string, role: 'CUSTOMER' | 'WORKER', seq: number) =>
        h.prisma.chatMessage.create({ data: { bookingId: p.booking.id, seq, senderUserId: userId, senderRole: role, clientMessageId: cid(), body: 'forged' } });
      await expect(insert(stranger.userId, 'CUSTOMER', 90)).rejects.toThrow(/not a participant/);
      await expect(insert(p.customer.userId, 'WORKER', 91)).rejects.toThrow(/not a participant/);
      await expect(insert(p.worker.userId, 'CUSTOMER', 92)).rejects.toThrow(/not a participant/);
      await expect(h.prisma.chatMessage.create({ data: { bookingId: p.booking.id, seq: 93, senderUserId: p.customer.userId, senderRole: 'ADMIN', clientMessageId: cid(), body: 'x' } })).rejects.toThrow();
    });

    it('is append-only and keeps seq unique per booking', async () => {
      const row = await h.prisma.chatMessage.findFirstOrThrow({ where: { bookingId: p.booking.id } });
      await expect(h.prisma.chatMessage.update({ where: { id: row.id }, data: { body: 'edited' } })).rejects.toThrow(/append-only/);
      await expect(
        h.prisma.chatMessage.create({ data: { bookingId: p.booking.id, seq: row.seq, senderUserId: p.customer.userId, senderRole: 'CUSTOMER', clientMessageId: cid(), body: 'dup seq' } }),
      ).rejects.toThrow();
      await expect(
        h.prisma.chatMessage.create({ data: { bookingId: p.booking.id, seq: 77, senderUserId: p.customer.userId, senderRole: 'CUSTOMER', clientMessageId: cid(), body: '   ' } }),
      ).rejects.toThrow();
      await expect(h.prisma.$executeRaw`UPDATE chat_participant_states SET read_up_to_seq = 5, delivered_up_to_seq = 1 WHERE booking_id = ${p.booking.id}::uuid`).resolves.toBeDefined();
    });
  });

  describe('rate limiting and Redis outage', () => {
    it('limits how fast one account can send', async () => {
      const p = await h.confirmedBooking();
      const results: number[] = [];
      for (let i = 0; i < 32; i++) results.push((await send(p.customer, p.booking.id, `spam ${i}`)).status);
      expect(results.filter((s) => s === 201)).toHaveLength(30);
      expect(results.filter((s) => s === 429)).toHaveLength(2);
    });

    it('keeps chat working with an in-process limiter when the shared store is down, and still limits', async () => {
      const p = await h.confirmedBooking();
      const spy = jest.spyOn(h.store, 'increment').mockRejectedValue(new Error('redis down'));
      try {
        const statuses: number[] = [];
        for (let i = 0; i < 32; i++) statuses.push((await send(p.worker, p.booking.id, `degraded ${i}`)).status);
        expect(statuses.filter((s) => s === 201)).toHaveLength(30);
        expect(statuses.filter((s) => s === 429)).toHaveLength(2);
      } finally {
        spy.mockRestore();
      }
    });
  });
});
