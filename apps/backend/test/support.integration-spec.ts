/**
 * REAL POSTGRESQL: support conversations between customers / workers and the administrators.
 *
 * A worker whose application is NOT approved must be able to write to support (that is the point), nobody can read anybody else's
 * conversation, administrators see who is writing and why, and a reply reaches the person.
 */
import { WorkerVerificationStatus } from '../src/generated/prisma/client.js';
import { type Harness, bootHarness } from './support/bookings-harness.js';

const run = process.env['TEST_DATABASE_URL'] ? describe : describe.skip;
if (!process.env['TEST_DATABASE_URL']) console.warn('support.integration-spec: TEST_DATABASE_URL is not set, suite skipped');

run('support conversations (real PostgreSQL)', () => {
  let h: Harness;
  let ref: Awaited<ReturnType<Harness['seedReferenceData']>>;
  const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
  let counter = 0;
  const cid = () => `itest-sup-${Date.now().toString(36)}-${++counter}-${Math.random().toString(36).slice(2, 8)}`;

  beforeAll(async () => {
    h = await bootHarness({ phonePrefix: '+9665996', slugPrefix: 'itest-sup-', adminEmailPrefix: 'itest-sup-admin' });
    ref = await h.seedReferenceData();
  });

  afterAll(async () => {
    if (h) await h.close();
  });

  const write = (token: string, body: string, clientMessageId = cid()) =>
    h.api().post('/api/v1/support/messages').set(bearer(token)).set('X-Forwarded-For', h.freshIp()).send({ clientMessageId, body });
  const mine = (token: string, query = '') => h.api().get(`/api/v1/support/messages${query}`).set(bearer(token));
  const admin = () => h.adminToken;
  const adminThreads = (query = '') => h.api().get(`/api/v1/admin/support/threads${query}`).set(bearer(admin()));
  const threadIdOf = async (userId: string) => (await h.prisma.supportThread.findUniqueOrThrow({ where: { userId } })).id;

  it('a worker whose application is NOT approved can write to support, and the conversation starts OPEN', async () => {
    for (const status of [WorkerVerificationStatus.SUBMITTED, WorkerVerificationStatus.REJECTED, WorkerVerificationStatus.SUSPENDED, WorkerVerificationStatus.INFO_REQUIRED]) {
      const w = await h.makeWorker([ref.service.id], [ref.city.id], status);
      const res = await write(w.accessToken, `Why is my application ${status}?`).expect(201);
      expect(res.body).toMatchObject({ seq: 1, senderRole: 'WORKER', fromMe: true, duplicate: false });
      expect((await h.prisma.supportThread.findUniqueOrThrow({ where: { userId: w.userId } })).status).toBe('OPEN');
    }
  });

  it('customers can write too, and the history comes back oldest first with a polling cursor', async () => {
    const c = await h.makeCustomer();
    expect((await mine(c.accessToken).expect(200)).body).toMatchObject({ items: [], meta: { lastSeq: 0, canSend: true, status: null } });

    await write(c.accessToken, 'one').expect(201);
    await write(c.accessToken, 'two').expect(201);
    await write(c.accessToken, 'three').expect(201);

    const all = (await mine(c.accessToken).expect(200)).body;
    expect(all.items.map((m: { body: string }) => m.body)).toEqual(['one', 'two', 'three']);
    expect(all.items.map((m: { seq: number }) => m.seq)).toEqual([1, 2, 3]);
    expect(all.meta).toMatchObject({ lastSeq: 3, status: 'OPEN', hasMore: false });

    const after = (await mine(c.accessToken, '?afterSeq=2').expect(200)).body;
    expect(after.items.map((m: { body: string }) => m.body)).toEqual(['three']);
    await mine(c.accessToken, '?afterSeq=1&beforeSeq=3').expect(400);
  });

  it('a retried send is stored once; the same id with other text is refused', async () => {
    const c = await h.makeCustomer();
    const id = cid();
    const first = await write(c.accessToken, 'hello', id).expect(201);
    const again = await write(c.accessToken, 'hello', id).expect(200);
    expect(again.body).toMatchObject({ id: first.body.id, seq: 1, duplicate: true });
    await write(c.accessToken, 'something else', id).expect(409);
    expect(await h.prisma.supportMessage.count({ where: { thread: { userId: c.userId } } })).toBe(1);
  });

  it('two sends at once get different numbers with no gaps', async () => {
    const c = await h.makeCustomer();
    const results = await Promise.all([write(c.accessToken, 'a'), write(c.accessToken, 'b'), write(c.accessToken, 'c')]);
    results.forEach((r) => expect(r.status).toBe(201));
    const seqs = (await mine(c.accessToken).expect(200)).body.items.map((m: { seq: number }) => m.seq).sort();
    expect(seqs).toEqual([1, 2, 3]);
  });

  it('nobody reads anybody else\'s conversation', async () => {
    const a = await h.makeCustomer();
    const b = await h.makeCustomer();
    await write(a.accessToken, 'private to A').expect(201);
    expect((await mine(b.accessToken).expect(200)).body.items).toEqual([]);
    const threadA = await threadIdOf(a.userId);
    await h.api().get(`/api/v1/admin/support/threads/${threadA}`).set(bearer(b.accessToken)).expect(403);
    await h.api().get('/api/v1/admin/support/threads').set(bearer(b.accessToken)).expect(403);
    await h.api().post(`/api/v1/admin/support/threads/${threadA}/reply`).set(bearer(b.accessToken)).send({ body: 'x' }).expect(403);
    await h.api().get('/api/v1/support/messages').expect(401);
  });

  it('administrators cannot use the person\'s endpoints', async () => {
    await h.api().get('/api/v1/support/messages').set(bearer(admin())).expect(403);
  });

  it('refuses empty, too long and control-character messages and a bad client id', async () => {
    const c = await h.makeCustomer();
    await write(c.accessToken, '   ').expect(400);
    await write(c.accessToken, 'x'.repeat(2001)).expect(400);
    await write(c.accessToken, 'bad\u0000text').expect(400);
    await write(c.accessToken, 'ok', 'short').expect(400);
    expect(await h.prisma.supportMessage.count({ where: { thread: { userId: c.userId } } })).toBe(0);
    await write(c.accessToken, 'x'.repeat(2000)).expect(201);
  });

  it('slows down a flood', async () => {
    const c = await h.makeCustomer();
    for (let i = 0; i < 10; i++) await write(c.accessToken, `m${i}`).expect(201);
    await write(c.accessToken, 'one too many').expect(429);
  });

  it('the administrator sees who is writing (and for a worker, the application status), replies, and the person receives it', async () => {
    const w = await h.makeWorker([ref.service.id], [ref.city.id], WorkerVerificationStatus.REJECTED);
    await write(w.accessToken, 'My documents were rejected, what do I do?').expect(201);
    const threadId = await threadIdOf(w.userId);

    const list = (await adminThreads('?status=OPEN').expect(200)).body;
    const row = list.items.find((t: { id: string }) => t.id === threadId);
    expect(row).toMatchObject({ role: 'WORKER', workerVerificationStatus: 'REJECTED', status: 'OPEN', lastSenderRole: 'WORKER', messageCount: 1 });
    expect(row.workerId).toBe(w.workerId);
    expect(row.phone).toBe(w.phone);
    expect(row.lastMessage).toContain('documents were rejected');

    const detail = (await h.api().get(`/api/v1/admin/support/threads/${threadId}`).set(bearer(admin())).expect(200)).body;
    expect(detail.messages).toHaveLength(1);
    expect(detail.messages[0]).toMatchObject({ senderRole: 'WORKER', seq: 1 });

    const replied = (await h.api().post(`/api/v1/admin/support/threads/${threadId}/reply`).set(bearer(admin())).send({ body: 'Please upload a clearer photo of your ID.' }).expect(200)).body;
    expect(replied.status).toBe('ANSWERED');
    expect(replied.messages.map((m: { senderRole: string }) => m.senderRole)).toEqual(['WORKER', 'ADMIN']);

    const seen = (await mine(w.accessToken).expect(200)).body;
    expect(seen.items).toHaveLength(2);
    expect(seen.items[1]).toMatchObject({ body: 'Please upload a clearer photo of your ID.', senderRole: 'ADMIN', fromMe: false, seq: 2 });
    expect(seen.meta.status).toBe('ANSWERED');
    expect((await mine(w.accessToken, '?afterSeq=1').expect(200)).body.items).toHaveLength(1);
  });

  it('the person writing again reopens it; resolving closes it; a new message reopens a resolved one', async () => {
    const c = await h.makeCustomer();
    await write(c.accessToken, 'help').expect(201);
    const id = await threadIdOf(c.userId);
    await h.api().post(`/api/v1/admin/support/threads/${id}/reply`).set(bearer(admin())).send({ body: 'How can I help?' }).expect(200);
    expect((await h.prisma.supportThread.findUniqueOrThrow({ where: { id } })).status).toBe('ANSWERED');

    await write(c.accessToken, 'thanks, one more thing').expect(201);
    expect((await h.prisma.supportThread.findUniqueOrThrow({ where: { id } })).status).toBe('OPEN');

    const resolved = (await h.api().post(`/api/v1/admin/support/threads/${id}/resolve`).set(bearer(admin())).expect(200)).body;
    expect(resolved.status).toBe('RESOLVED');
    expect((await adminThreads('?status=RESOLVED').expect(200)).body.items.some((t: { id: string }) => t.id === id)).toBe(true);

    await write(c.accessToken, 'it happened again').expect(201);
    expect((await h.prisma.supportThread.findUniqueOrThrow({ where: { id } })).status).toBe('OPEN');

    await h.api().post(`/api/v1/admin/support/threads/${id}/resolve`).set(bearer(admin())).expect(200);
    const reopened = (await h.api().post(`/api/v1/admin/support/threads/${id}/reopen`).set(bearer(admin())).expect(200)).body;
    expect(reopened.status).toBe('OPEN');
  });

  it('a repeated admin reply (same id) is stored once; an empty reply is refused; an unknown conversation is 404', async () => {
    const c = await h.makeCustomer();
    await write(c.accessToken, 'hi').expect(201);
    const id = await threadIdOf(c.userId);
    const reply = () => h.api().post(`/api/v1/admin/support/threads/${id}/reply`).set(bearer(admin())).send({ body: 'Hello', clientMessageId: 'admin-retry-0001' });
    await reply().expect(200);
    await reply().expect(200);
    expect(await h.prisma.supportMessage.count({ where: { threadId: id, senderRole: 'ADMIN' } })).toBe(1);
    await h.api().post(`/api/v1/admin/support/threads/${id}/reply`).set(bearer(admin())).send({ body: '  ' }).expect(400);
    await h.api().get('/api/v1/admin/support/threads/6f1c2f0e-6d4a-4a39-9d1e-0f6b1a9a0001').set(bearer(admin())).expect(404);
    await h.api().post('/api/v1/admin/support/threads/6f1c2f0e-6d4a-4a39-9d1e-0f6b1a9a0001/reply').set(bearer(admin())).send({ body: 'x' }).expect(404);
    await h.api().get('/api/v1/admin/support/threads/not-a-uuid').set(bearer(admin())).expect(400);
  });

  it('administrator actions are written to the audit log, without the message text', async () => {
    const c = await h.makeCustomer();
    await write(c.accessToken, 'audit me').expect(201);
    const id = await threadIdOf(c.userId);
    await h.api().post(`/api/v1/admin/support/threads/${id}/reply`).set(bearer(admin())).send({ body: 'secret reply text' }).expect(200);
    await h.api().post(`/api/v1/admin/support/threads/${id}/resolve`).set(bearer(admin())).expect(200);
    const rows = await h.prisma.auditLog.findMany({ where: { entityType: 'support_thread', entityId: id }, orderBy: { createdAt: 'asc' } });
    expect(rows.map((r) => r.action)).toEqual(['support.reply', 'support.resolve']);
    expect(JSON.stringify(rows)).not.toContain('secret reply text');
  });

  it('the list can be searched by name or phone and filtered by state', async () => {
    const c = await h.makeCustomer();
    await write(c.accessToken, 'find me').expect(201);
    const found = (await adminThreads(`?search=${encodeURIComponent(c.phone.slice(-6))}`).expect(200)).body;
    expect(found.items.some((t: { userId: string }) => t.userId === c.userId)).toBe(true);
    const none = (await adminThreads('?search=zzzzzz-no-such-person').expect(200)).body;
    expect(none.items).toHaveLength(0);
    await adminThreads('?status=NOPE').expect(400);
  });
});
