/**
 * REAL POSTGRESQL: the dispute workflow. Participant isolation, eligibility, the state machine, evidence rules,
 * concurrency, audit, and the guarantee that a dispute changes nothing financial.
 */
import { randomUUID } from 'node:crypto';
import { type Harness, type Session, type Worker, bootHarness } from './support/bookings-harness.js';

const run = process.env['TEST_DATABASE_URL'] ? describe : describe.skip;
if (!process.env['TEST_DATABASE_URL']) console.warn('disputes.integration-spec: TEST_DATABASE_URL is not set, suite skipped');

const DESCRIPTION = 'The technician left before finishing and the outlet still sparks.';

run('disputes (real PostgreSQL)', () => {
  let h: Harness;
  let stranger: Session;
  let strangerWorker: Worker;
  let ref: Awaited<ReturnType<Harness['seedReferenceData']>>;
  const admin = { accessToken: '' };
  const as = (w: { accessToken: string }) => h.bearer(w.accessToken);

  type Pair = Awaited<ReturnType<Harness['confirmedBooking']>>;
  const open = (who: Session, bookingId: string, body: object = {}) =>
    h.api().post('/api/v1/disputes').set(as(who)).set('X-Forwarded-For', h.freshIp()).send({ bookingId, category: 'SERVICE_QUALITY', description: DESCRIPTION, ...body });
  const get = (who: { accessToken: string }, id: string) => h.api().get(`/api/v1/disputes/${id}`).set(as(who));
  const act = (id: string, action: string, body: object = {}, who: { accessToken: string } = admin) =>
    h.api().post(`/api/v1/admin/disputes/${id}/${action}`).set(as(who)).send(body);
  const participantPost = (who: Session, id: string, path: string, body: object = {}) => h.api().post(`/api/v1/disputes/${id}/${path}`).set(as(who)).set('X-Forwarded-For', h.freshIp()).send(body);
  const adminGet = async (id: string) => (await h.api().get(`/api/v1/admin/disputes/${id}`).set(as(admin)).expect(200)).body;

  /** A dispute taken to UNDER_REVIEW, ready to resolve. */
  async function reviewing(p: Pair) {
    const d = (await open(p.customer, p.booking.id).expect(201)).body;
    await act(d.id, 'start-review').expect(200);
    return d;
  }
  const photo = (bookingId: string, status: 'UPLOADED' | 'PENDING_UPLOAD' = 'UPLOADED') =>
    h.prisma.bookingPhoto.create({ data: { bookingId, status, storageKey: `bookings/${bookingId}/photos/${randomUUID()}`, fileName: 'p.png', mimeType: 'image/png', sizeBytes: 10 } });
  const message = async (who: Session, bookingId: string) =>
    (await h.api().post(`/api/v1/bookings/${bookingId}/messages`).set(as(who)).set('X-Forwarded-For', h.freshIp()).send({ clientMessageId: `itest-${randomUUID().slice(0, 12)}`, body: 'He said he would come back tomorrow.' }).expect(201)).body;

  beforeAll(async () => {
    h = await bootHarness({ phonePrefix: '+9665984', slugPrefix: 'itest-dp-', adminEmailPrefix: 'itest-dp-admin' });
    ref = await h.seedReferenceData();
    admin.accessToken = h.adminToken;
    stranger = await h.makeCustomer();
    strangerWorker = await h.makeWorker([], []);
  });

  afterAll(async () => {
    if (h) await h.close();
  });

  describe('opening a dispute', () => {
    it('lets the booking customer open one and records the history', async () => {
      const p = await h.confirmedBooking();
      const res = await open(p.customer, p.booking.id).expect(201);
      expect(res.body).toMatchObject({ status: 'OPEN', category: 'SERVICE_QUALITY', openedByMe: true, openedByRole: 'CUSTOMER', resolution: null, financialFollowupRequested: false });
      expect(res.body.events).toEqual([expect.objectContaining({ action: 'OPENED', toStatus: 'OPEN', by: 'ME' })]);
      const row = await h.prisma.dispute.findUniqueOrThrow({ where: { id: res.body.id } });
      expect(row).toMatchObject({ openedById: p.customer.userId, openedByRole: 'CUSTOMER', assignedAdminId: null });
    });

    it('lets the assigned worker open one too, and shows it to the customer', async () => {
      const p = await h.confirmedBooking();
      const d = (await open(p.worker, p.booking.id, { category: 'PAYMENT' }).expect(201)).body;
      expect(d).toMatchObject({ openedByRole: 'WORKER', openedByMe: true });
      const asCustomer = (await get(p.customer, d.id).expect(200)).body;
      expect(asCustomer).toMatchObject({ id: d.id, openedByMe: false, openedByRole: 'WORKER' });
      expect(asCustomer.events[0].by).toBe('OTHER_PARTY');
    });

    it('is limited to participants of a disputable booking', async () => {
      const p = await h.confirmedBooking();
      expect((await open(stranger, p.booking.id)).status).toBe(404);
      expect((await open(strangerWorker, p.booking.id)).status).toBe(404);
      expect((await open({ accessToken: h.adminToken } as Session, p.booking.id)).status).toBe(403);
      await h.api().post('/api/v1/disputes').send({}).expect(401);
      expect((await open(p.customer, randomUUID())).status).toBe(404);

      const waiting = await h.acceptedBooking(); // PAYMENT_PENDING: nothing paid yet
      const early = await open(waiting.customer, waiting.booking.id);
      expect(early.status).toBe(409);
      expect(early.body.code).toBe('BOOKING_NOT_DISPUTABLE');
      expect((await open(waiting.worker, waiting.booking.id)).status).toBe(409);

      const openRequest = await h.createBooking(await h.makeCustomer(), ref);
      const customerOfOpen = await h.prisma.booking.findUniqueOrThrow({ where: { id: openRequest.id }, select: { customerId: true } });
      expect(customerOfOpen.customerId).toBeDefined();
    });

    it('allows a cancelled booking only if it had been confirmed, and a completed one', async () => {
      const paid = await h.confirmedBooking();
      await h.cancelBooking(paid.customer, paid.booking.id).expect(200);
      expect((await open(paid.customer, paid.booking.id)).status).toBe(201);

      const unpaid = await h.acceptedBooking();
      await h.cancelBooking(unpaid.customer, unpaid.booking.id).expect(200);
      expect((await open(unpaid.customer, unpaid.booking.id)).body.code).toBe('BOOKING_NOT_DISPUTABLE');

      const done = await h.confirmedBooking();
      await h.startWork(done.worker, done.booking.id).expect(200);
      await h.completeWork(done.worker, done.booking.id).expect(200);
      expect((await open(done.customer, done.booking.id)).status).toBe(201);
    });

    it('validates the request and ignores no client-supplied identity', async () => {
      const p = await h.confirmedBooking();
      expect((await open(p.customer, p.booking.id, { description: 'short' })).status).toBe(400);
      expect((await open(p.customer, p.booking.id, { description: 'x'.repeat(2001) })).status).toBe(400);
      expect((await open(p.customer, p.booking.id, { category: 'REFUND_ME' })).status).toBe(400);
      for (const extra of [{ openedById: p.worker.userId }, { openedByRole: 'WORKER' }, { status: 'RESOLVED' }, { assignedAdminId: randomUUID() }]) {
        expect({ extra, status: (await open(p.customer, p.booking.id, extra)).status }).toEqual({ extra, status: 400 });
      }
      expect(await h.prisma.dispute.count({ where: { bookingId: p.booking.id } })).toBe(0);
    });

    it('allows one active dispute per booking, even under simultaneous attempts, and a new one after it is finished', async () => {
      const p = await h.confirmedBooking();
      const results = await Promise.all(Array.from({ length: 6 }, (_, i) => open(i % 2 ? p.worker : p.customer, p.booking.id)));
      expect(results.filter((r) => r.status === 201)).toHaveLength(1);
      expect(results.filter((r) => r.status === 409).every((r) => r.body.code === 'DISPUTE_ALREADY_ACTIVE')).toBe(true);
      expect(await h.prisma.dispute.count({ where: { bookingId: p.booking.id } })).toBe(1);

      const d = await h.prisma.dispute.findFirstOrThrow({ where: { bookingId: p.booking.id } });
      await act(d.id, 'start-review').expect(200);
      await act(d.id, 'resolve', { summary: 'Both sides were heard; no further action is needed.' }).expect(200);
      // A RESOLVED dispute is not active: a recurring problem can start a new case, but then the old one cannot be reopened.
      const newer = (await open(p.customer, p.booking.id).expect(201)).body;
      const blocked = await act(d.id, 'reopen', { note: 'Reopening the earlier case.' });
      expect(blocked.status).toBe(409);
      expect(blocked.body.code).toBe('DISPUTE_ALREADY_ACTIVE');
      expect((await open(p.worker, p.booking.id)).body.code).toBe('DISPUTE_ALREADY_ACTIVE'); // the newer one is active
      await participantPost(p.customer, newer.id, 'withdraw').expect(200);
      await act(d.id, 'close', { note: 'Closing the case.' }).expect(200);
      expect((await open(p.customer, p.booking.id)).status).toBe(201);
    });
  });

  describe('who can see a dispute', () => {
    it('shows it only to the two participants and administrators, and lists only mine', async () => {
      const p = await h.confirmedBooking();
      const other = await h.confirmedBooking();
      const d = (await open(p.customer, p.booking.id).expect(201)).body;
      await open(other.customer, other.booking.id).expect(201);

      for (const who of [p.customer, p.worker]) expect((await get(who, d.id)).status).toBe(200);
      for (const who of [stranger, strangerWorker, other.customer, other.worker]) expect({ who: who.userId === other.customer.userId, status: (await get(who, d.id)).status }).toMatchObject({ status: 404 });
      expect((await get({ accessToken: h.adminToken }, d.id)).status).toBe(403); // admins use the admin routes
      expect((await h.api().get(`/api/v1/disputes/${d.id}`)).status).toBe(401);
      expect((await h.api().get('/api/v1/disputes/not-a-uuid').set(as(p.customer))).status).toBe(400);

      const mineC = (await h.api().get('/api/v1/disputes?limit=100').set(as(p.customer)).expect(200)).body;
      expect(mineC.items.map((i: { id: string }) => i.id)).toEqual([d.id]);
      expect((await h.api().get('/api/v1/disputes?limit=100').set(as(p.worker)).expect(200)).body.items.map((i: { id: string }) => i.id)).toEqual([d.id]);
      expect((await h.api().get('/api/v1/disputes').set(as(stranger)).expect(200)).body.items).toHaveLength(0);
      expect((await h.api().get('/api/v1/disputes?status=RESOLVED').set(as(p.customer)).expect(200)).body.items).toHaveLength(0);
      expect((await h.api().get('/api/v1/disputes?status=BOGUS').set(as(p.customer))).status).toBe(400);
    });

    it('never lets a stranger act on it', async () => {
      const p = await h.confirmedBooking();
      const d = (await open(p.customer, p.booking.id).expect(201)).body;
      for (const who of [stranger, strangerWorker]) {
        expect((await participantPost(who, d.id, 'comments', { text: 'hello' })).status).toBe(404);
        expect((await participantPost(who, d.id, 'evidence', { chatMessageIds: [randomUUID()] })).status).toBe(404);
        expect((await participantPost(who, d.id, 'withdraw')).status).toBe(404);
      }
      for (const who of [p.customer, p.worker, stranger]) {
        expect((await act(d.id, 'start-review', {}, who)).status).toBe(403);
        expect((await h.api().get('/api/v1/admin/disputes').set(as(who))).status).toBe(403);
      }
    });
  });

  describe('evidence', () => {
    it('references existing photos and chat messages of the same booking without copying anything', async () => {
      const p = await h.confirmedBooking();
      const ph = await photo(p.booking.id);
      const msg = await message(p.customer, p.booking.id);
      const filesBefore = await h.prisma.bookingPhoto.count();
      const d = (await open(p.customer, p.booking.id, { bookingPhotoIds: [ph.id, ph.id], chatMessageIds: [msg.id] }).expect(201)).body;
      expect(d.evidence).toEqual(
        expect.arrayContaining([expect.objectContaining({ kind: 'BOOKING_PHOTO', id: ph.id, fileName: 'p.png' }), expect.objectContaining({ kind: 'CHAT_MESSAGE', id: msg.id, senderRole: 'CUSTOMER' })]),
      );
      expect(d.evidence).toHaveLength(2); // duplicates collapse
      expect(JSON.stringify(d)).not.toMatch(/storageKey|bookings\/[0-9a-f-]+\/photos/);
      expect(await h.prisma.bookingPhoto.count()).toBe(filesBefore); // referenced, not duplicated
      expect((await get(p.worker, d.id).expect(200)).body.evidence).toHaveLength(2); // the other party sees what the dispute relies on
    });

    it('refuses evidence from another booking, unfinished uploads, unknown ids and too many items', async () => {
      const p = await h.confirmedBooking();
      const other = await h.confirmedBooking();
      const foreign = await photo(other.booking.id);
      const foreignMsg = await message(other.customer, other.booking.id);
      const pending = await photo(p.booking.id, 'PENDING_UPLOAD');
      for (const body of [{ bookingPhotoIds: [foreign.id] }, { chatMessageIds: [foreignMsg.id] }, { bookingPhotoIds: [pending.id] }, { bookingPhotoIds: [randomUUID()] }, { chatMessageIds: [randomUUID()] }]) {
        const res = await open(p.customer, p.booking.id, body);
        expect({ body, status: res.status, code: res.body.code }).toEqual({ body, status: 400, code: 'EVIDENCE_NOT_FOUND' });
      }
      expect(await h.prisma.dispute.count({ where: { bookingId: p.booking.id } })).toBe(0);
      const many = await Promise.all(Array.from({ length: 11 }, () => photo(p.booking.id)));
      expect((await open(p.customer, p.booking.id, { bookingPhotoIds: many.map((m) => m.id) })).status).toBe(400);

      const d = (await open(p.customer, p.booking.id).expect(201)).body;
      expect((await participantPost(p.customer, d.id, 'evidence', { bookingPhotoIds: [foreign.id] })).status).toBe(400);
      expect((await participantPost(p.customer, d.id, 'evidence', {})).body.code).toBe('EVIDENCE_REQUIRED');
      expect((await participantPost(p.customer, d.id, 'evidence', { bookingPhotoIds: [many[0]!.id] }).expect(200)).body.evidence).toHaveLength(1);
    });

    it('is enforced by the database too, and keeps a cited photo from being deleted', async () => {
      const p = await h.confirmedBooking();
      const other = await h.confirmedBooking();
      const d = (await open(p.customer, p.booking.id).expect(201)).body;
      const foreign = await photo(other.booking.id);
      await expect(h.prisma.disputeEvidence.create({ data: { disputeId: d.id, bookingPhotoId: foreign.id, addedById: p.customer.userId } })).rejects.toThrow(/belong to the booking/);
      await expect(h.prisma.disputeEvidence.create({ data: { disputeId: d.id, addedById: p.customer.userId } })).rejects.toThrow(); // exactly one reference

      const cited = await photo(p.booking.id);
      await participantPost(p.customer, d.id, 'evidence', { bookingPhotoIds: [cited.id] }).expect(200);
      const del = await h.api().delete(`/api/v1/bookings/${p.booking.id}/photos/${cited.id}`).set(as(p.customer));
      expect(del.status).toBe(409);
      expect(del.body.code).toBe('PHOTO_IS_EVIDENCE');
      expect(await h.prisma.bookingPhoto.count({ where: { id: cited.id } })).toBe(1);
    });
  });

  describe('the state machine', () => {
    it('walks OPEN -> UNDER_REVIEW -> AWAITING_INFO -> UNDER_REVIEW -> RESOLVED -> CLOSED with every step in the history', async () => {
      const p = await h.confirmedBooking();
      const id = (await open(p.customer, p.booking.id).expect(201)).body.id;

      expect((await act(id, 'resolve', { summary: 'Too early to resolve anything here.' })).status).toBe(409); // must be reviewed first
      expect((await act(id, 'close', { note: 'nope nope' })).status).toBe(409);
      expect((await act(id, 'reopen', { note: 'nope nope' })).status).toBe(409);

      expect((await act(id, 'start-review').expect(200)).body).toMatchObject({ status: 'UNDER_REVIEW' });
      expect((await act(id, 'request-info', { note: 'Please send a photo of the damaged outlet.' }).expect(200)).body.status).toBe('AWAITING_INFO');
      expect((await act(id, 'request-info', { note: 'Again please.' })).status).toBe(409); // already waiting

      // the participant answers: the dispute goes back under review
      const answered = (await participantPost(p.customer, id, 'comments', { text: 'Here is more detail about what happened.' }).expect(200)).body;
      expect(answered.status).toBe('UNDER_REVIEW');
      expect(answered.events.map((e: { action: string }) => e.action)).toEqual(['OPENED', 'REVIEW_STARTED', 'INFO_REQUESTED', 'COMMENT']);

      const resolved = (await act(id, 'resolve', { summary: 'The worker will not be contacted again; the job stays as completed.', internalNote: 'Customer credible; worker history clean.', financialFollowup: 'NONE' }).expect(200)).body;
      expect(resolved).toMatchObject({ status: 'RESOLVED', financialFollowup: 'NONE' });
      expect(resolved.resolvedAt).not.toBeNull();
      expect((await act(id, 'close', { note: 'Case closed after the follow-up period.' }).expect(200)).body).toMatchObject({ status: 'CLOSED' });
      expect((await adminGet(id)).closedAt).not.toBeNull();

      // CLOSED is final
      const bodies: Record<string, object> = {
        'start-review': {},
        'request-info': { note: 'anything at all' },
        'internal-note': { note: 'anything at all' },
        resolve: { summary: 'anything at all, long enough' },
        close: { note: 'anything at all' },
        reopen: { note: 'anything at all' },
      };
      for (const [a, body] of Object.entries(bodies)) expect({ a, status: (await act(id, a, body)).status }).toEqual({ a, status: 409 });
      expect((await participantPost(p.customer, id, 'comments', { text: 'one more thing' })).status).toBe(409);
    });

    it('freezes a resolved dispute for participants and only reopens it through an audited, reasoned step', async () => {
      const p = await h.confirmedBooking();
      const d = await reviewing(p);
      await act(d.id, 'resolve', { summary: 'Compensation is outside this process; no change made.' }).expect(200);

      expect((await participantPost(p.customer, d.id, 'comments', { text: 'but wait' })).status).toBe(409);
      expect((await participantPost(p.worker, d.id, 'evidence', { chatMessageIds: [(await message(p.customer, p.booking.id)).id] })).status).toBe(409);
      expect((await participantPost(p.customer, d.id, 'withdraw')).status).toBe(409);
      expect((await act(d.id, 'resolve', { summary: 'Changing my mind quietly.' })).status).toBe(409); // no silent edits

      expect((await act(d.id, 'reopen', {})).status).toBe(400); // a reason is required
      expect((await act(d.id, 'reopen', { note: 'New evidence was supplied by the customer.' }).expect(200)).body).toMatchObject({ status: 'UNDER_REVIEW', reopenCount: 1, resolvedAt: null });
      const history = (await adminGet(d.id)).events.map((e: { action: string }) => e.action);
      expect(history).toEqual(['OPENED', 'REVIEW_STARTED', 'RESOLVED', 'REOPENED']);
      expect(await h.prisma.auditLog.count({ where: { action: 'dispute.reopen', entityId: d.id } })).toBe(1);
    });

    it('lets only the opener withdraw, and only before anyone started reviewing', async () => {
      const p = await h.confirmedBooking();
      const d = (await open(p.customer, p.booking.id).expect(201)).body;
      expect((await participantPost(p.worker, d.id, 'withdraw')).status).toBe(403);
      expect((await participantPost(p.customer, d.id, 'withdraw').expect(200)).body.status).toBe('CLOSED');

      const q = await h.confirmedBooking();
      const e = await reviewing(q);
      expect((await participantPost(q.customer, e.id, 'withdraw')).status).toBe(409);
    });

    it('requires notes and a valid state for every administrator decision', async () => {
      const p = await h.confirmedBooking();
      const d = await reviewing(p);
      expect((await act(d.id, 'request-info', {})).status).toBe(400);
      expect((await act(d.id, 'request-info', { note: 'x' })).status).toBe(400);
      expect((await act(d.id, 'internal-note', { note: '' })).status).toBe(400);
      expect((await act(d.id, 'resolve', { summary: 'short' })).status).toBe(400);
      expect((await act(d.id, 'resolve', { summary: 'A proper summary for everyone.', financialFollowup: 'REFUND_NOW' })).status).toBe(400);
      expect((await act(d.id, 'resolve', { summary: 'A proper summary for everyone.', status: 'CLOSED' })).status).toBe(400);
      expect((await act(randomUUID(), 'start-review')).status).toBe(404);
    });

    it('lets exactly one of several simultaneous conflicting decisions win', async () => {
      const p = await h.confirmedBooking();
      const d = await reviewing(p);
      const results = await Promise.all([
        act(d.id, 'resolve', { summary: 'Resolved in favour of the customer, see notes.' }),
        act(d.id, 'resolve', { summary: 'Resolved in favour of the worker, see notes.' }),
        act(d.id, 'request-info', { note: 'Need one more document from you.' }),
      ]);
      expect(results.filter((r) => r.status === 200)).toHaveLength(1);
      expect(results.filter((r) => r.status !== 200).every((r) => r.status === 409)).toBe(true);
      const events = (await adminGet(d.id)).events.filter((e: { action: string }) => ['RESOLVED', 'INFO_REQUESTED'].includes(e.action));
      expect(events).toHaveLength(1);
    });

    it('assigns only active administrators', async () => {
      const p = await h.confirmedBooking();
      const d = (await open(p.customer, p.booking.id).expect(201)).body;
      expect((await act(d.id, 'assign', { adminId: p.customer.userId })).body.code).toBe('INVALID_ASSIGNEE'); // a customer is not an administrator
      expect((await act(d.id, 'assign', { adminId: randomUUID() })).status).toBe(400);
      const me = (await act(d.id, 'assign').expect(200)).body;
      expect(me.assignedAdminId).not.toBeNull();
      const second = await h.prisma.user.create({ data: { email: `itest-dp-admin-second-${randomUUID().slice(0, 6)}@example.com`, status: 'ACTIVE', roles: { create: [{ role: 'ADMIN' }] } } });
      expect((await act(d.id, 'assign', { adminId: second.id }).expect(200)).body.assignedAdminId).toBe(second.id);
      await h.prisma.user.update({ where: { id: second.id }, data: { status: 'SUSPENDED' } });
      expect((await act(d.id, 'assign', { adminId: second.id })).body.code).toBe('INVALID_ASSIGNEE');
    });
  });

  describe('what participants may see', () => {
    it('hides internal notes, reasons for reopening and the handler, and shows the resolution only once resolved', async () => {
      const p = await h.confirmedBooking();
      const d = await reviewing(p);
      await act(d.id, 'internal-note', { note: 'INTERNAL-SECRET-A worker has two earlier complaints.' }).expect(200);
      await act(d.id, 'request-info', { note: 'Please describe the damage.' }).expect(200);
      const during = (await get(p.worker, d.id).expect(200)).body;
      expect(JSON.stringify(during)).not.toContain('INTERNAL-SECRET-A');
      expect(during.events.map((e: { action: string }) => e.action)).not.toContain('INTERNAL_NOTE');
      expect(during.events.map((e: { action: string }) => e.action)).not.toContain('ASSIGNED');
      expect(during.events.find((e: { action: string }) => e.action === 'INFO_REQUESTED')).toMatchObject({ by: 'SUPPORT', note: 'Please describe the damage.' });
      expect(JSON.stringify(during)).not.toMatch(/assignedAdmin/);
      expect(during.resolution).toBeNull();

      await act(d.id, 'start-review').expect(200);
      await act(d.id, 'resolve', { summary: 'The visit will be repeated at no extra charge by agreement.', internalNote: 'INTERNAL-SECRET-B', financialFollowup: 'REQUESTED' }).expect(200);
      const after = (await get(p.customer, d.id).expect(200)).body;
      expect(after).toMatchObject({ status: 'RESOLVED', resolution: 'The visit will be repeated at no extra charge by agreement.', financialFollowupRequested: true });
      expect(JSON.stringify(after)).not.toMatch(/INTERNAL-SECRET/);

      await act(d.id, 'reopen', { note: 'REOPEN-REASON-PRIVATE' }).expect(200);
      const reopened = (await get(p.customer, d.id).expect(200)).body;
      expect(reopened.resolution).toBeNull(); // not final any more
      expect(JSON.stringify(reopened)).not.toContain('REOPEN-REASON-PRIVATE');
      expect(JSON.stringify(reopened)).not.toContain('The visit will be repeated'); // the superseded decision is not shown either
    });
  });

  describe('a dispute changes nothing financial', () => {
    it('leaves the booking, money snapshot, payments, refunds, ledger, ratings and accounts untouched, even with a money follow-up flagged', async () => {
      const p = await h.confirmedBooking(20000);
      const snapshot = async () => ({
        booking: await h.prisma.booking.findUniqueOrThrow({ where: { id: p.booking.id }, select: { status: true, totalAmountHalalas: true, serviceAmountHalalas: true, vatAmountHalalas: true, commissionAmountHalalas: true, workerPayoutHalalas: true } }),
        payments: await h.prisma.paymentAttempt.findMany({ where: { bookingId: p.booking.id }, select: { id: true, status: true, refundReservedHalalas: true } }),
        refunds: await h.prisma.paymentRefund.count(),
        ledger: await h.prisma.ledgerEntry.count(),
        worker: await h.prisma.workerProfile.findUniqueOrThrow({ where: { id: p.worker.workerId }, select: { verificationStatus: true, ratingCount: true, ratingSum: true } }),
        users: await h.prisma.user.findMany({ where: { id: { in: [p.customer.userId, p.worker.userId] } }, select: { id: true, status: true }, orderBy: { id: 'asc' } }),
      });
      const before = await snapshot();
      const d = await reviewing(p);
      await act(d.id, 'resolve', { summary: 'The customer is owed a goodwill gesture; finance will decide separately.', financialFollowup: 'REQUESTED' }).expect(200);
      await act(d.id, 'close', { note: 'Closing; the money follow-up is a separate matter.' }).expect(200);
      expect(await snapshot()).toEqual(before);
      expect(before.booking.totalAmountHalalas).toBe(23000);
      expect((await adminGet(d.id)).financialFollowup).toBe('REQUESTED');
    });
  });

  describe('integrity and audit', () => {
    it('forbids changing what a dispute is about, and erasing its history, at the database', async () => {
      const p = await h.confirmedBooking();
      const d = (await open(p.customer, p.booking.id).expect(201)).body;
      await expect(h.prisma.dispute.update({ where: { id: d.id }, data: { description: 'rewritten after the fact' } })).rejects.toThrow(/cannot change/);
      await expect(h.prisma.dispute.update({ where: { id: d.id }, data: { openedById: p.worker.userId } })).rejects.toThrow();
      await expect(h.prisma.dispute.update({ where: { id: d.id }, data: { status: 'RESOLVED' } })).rejects.toThrow(); // resolved needs a summary and time
      const ev = await h.prisma.disputeEvent.findFirstOrThrow({ where: { disputeId: d.id } });
      await expect(h.prisma.disputeEvent.update({ where: { id: ev.id }, data: { note: 'edited' } })).rejects.toThrow(/append-only/);
      await expect(h.prisma.disputeEvent.delete({ where: { id: ev.id } })).rejects.toThrow(/append-only/);
      // nobody but a participant can be recorded as the opener
      await expect(h.prisma.dispute.create({ data: { bookingId: p.booking.id, openedById: stranger.userId, openedByRole: 'CUSTOMER', category: 'OTHER', description: 'forged complaint' } })).rejects.toThrow();
    });

    it('audits every administrator decision without copying the notes', async () => {
      const p = await h.confirmedBooking();
      const d = await reviewing(p);
      await act(d.id, 'internal-note', { note: 'AUDIT-LEAK-CHECK private details' }).expect(200);
      await act(d.id, 'resolve', { summary: 'AUDIT-LEAK-CHECK summary shown to everybody.', financialFollowup: 'REQUESTED' }).expect(200);
      const rows = await h.prisma.auditLog.findMany({ where: { entityType: 'dispute', entityId: d.id }, orderBy: { createdAt: 'asc' } });
      expect(rows.map((r) => r.action)).toEqual(['dispute.start_review', 'dispute.internal_note', 'dispute.resolve']);
      expect(rows.every((r) => r.actorUserId !== null)).toBe(true);
      expect(rows[2]!.metadata).toMatchObject({ beforeStatus: 'UNDER_REVIEW', afterStatus: 'RESOLVED', financialFollowup: 'REQUESTED', hasNote: true });
      expect(JSON.stringify(rows)).not.toContain('AUDIT-LEAK-CHECK');
    });

    it('lists and filters disputes for administrators with pagination', async () => {
      const p = await h.confirmedBooking();
      const d = await reviewing(p);
      const list = (q: string) => h.api().get(`/api/v1/admin/disputes?${q}`).set(as(admin)).expect(200);
      expect((await list(`bookingId=${p.booking.id}`)).body.items.map((i: { id: string }) => i.id)).toEqual([d.id]);
      expect((await list(`status=UNDER_REVIEW&bookingId=${p.booking.id}`)).body.meta.total).toBe(1);
      expect((await list(`status=CLOSED&bookingId=${p.booking.id}`)).body.meta.total).toBe(0);
      expect((await list(`openedById=${p.customer.userId}`)).body.items.every((i: { openedById: string }) => i.openedById === p.customer.userId)).toBe(true);
      expect((await list(`category=PAYMENT&bookingId=${p.booking.id}`)).body.meta.total).toBe(0);
      expect((await list('limit=2&page=1')).body.items).toHaveLength(2);
      const past = new Date(Date.now() - 86_400_000).toISOString();
      expect((await list(`bookingId=${p.booking.id}&to=${past}`)).body.meta.total).toBe(0);
      expect((await h.api().get('/api/v1/admin/disputes?from=yesterday').set(as(admin))).status).toBe(400);
    });
  });
});
