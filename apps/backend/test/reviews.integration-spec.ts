/**
 * REAL POSTGRESQL: reviews and ratings. Eligibility, uniqueness under concurrency, immutability, moderation history,
 * and the cached worker aggregate staying equal to the reviews table after every kind of change.
 */
import { randomUUID } from 'node:crypto';
import { type Harness, type Session, type Worker, bootHarness } from './support/bookings-harness.js';

const run = process.env['TEST_DATABASE_URL'] ? describe : describe.skip;
if (!process.env['TEST_DATABASE_URL']) console.warn('reviews.integration-spec: TEST_DATABASE_URL is not set, suite skipped');

run('reviews and ratings (real PostgreSQL)', () => {
  let h: Harness;
  let ref: Awaited<ReturnType<Harness['seedReferenceData']>>;
  let stranger: Session;
  const admin = { accessToken: '' };
  const as = (w: { accessToken: string }) => h.bearer(w.accessToken);

  const submit = (who: Session, bookingId: string, body: object = { rating: 5 }) =>
    h.api().post(`/api/v1/bookings/${bookingId}/review`).set(as(who)).set('X-Forwarded-For', h.freshIp()).send(body);
  const hide = (id: string, reason = 'Contains abusive language.') => h.api().post(`/api/v1/admin/reviews/${id}/hide`).set(as(admin)).send({ reason });
  const restore = (id: string, reason = 'Reviewed again: acceptable.') => h.api().post(`/api/v1/admin/reviews/${id}/restore`).set(as(admin)).send({ reason });

  /** A COMPLETED booking done by `worker` for a fresh customer (the real flow: quote, accept, pay, start, complete). */
  async function completedFor(worker: Worker, customer?: Session) {
    const c = customer ?? (await h.makeCustomer());
    const booking = await h.createBooking(c, ref);
    const quote = await h.submitQuote(worker, booking.id);
    await h.api().post(`/api/v1/bookings/${booking.id}/quotes/${quote.id}/accept`).set(as(c)).send({}).expect(200);
    await h.confirmBooking({ customer: c, booking });
    await h.startWork(worker, booking.id).expect(200);
    await h.completeWork(worker, booking.id).expect(200);
    return { customer: c, booking };
  }

  /** The cached aggregate must always equal what the reviews table says. */
  async function expectAggregateConsistent(workerId: string) {
    const rows = await h.prisma.review.findMany({ where: { workerProfileId: workerId, status: 'PUBLISHED' }, select: { rating: true } });
    const profile = await h.prisma.workerProfile.findUniqueOrThrow({ where: { id: workerId }, select: { ratingCount: true, ratingSum: true } });
    expect(profile).toEqual({ ratingCount: rows.length, ratingSum: rows.reduce((a, r) => a + r.rating, 0) });
    return profile;
  }
  const newWorker = () => h.makeWorker([ref.service.id], [ref.city.id]);

  beforeAll(async () => {
    h = await bootHarness({ phonePrefix: '+9665985', slugPrefix: 'itest-rv-', adminEmailPrefix: 'itest-rv-admin' });
    ref = await h.seedReferenceData();
    admin.accessToken = h.adminToken;
    stranger = await h.makeCustomer();
  });

  afterAll(async () => {
    if (h) await h.close();
  });

  describe('who may review what', () => {
    it('lets the customer of a completed booking review its worker once', async () => {
      const w = await newWorker();
      const done = await completedFor(w);
      const res = await submit(done.customer, done.booking.id, { rating: 4, comment: '  Arrived on time and fixed it.  ' }).expect(201);
      expect(res.body).toMatchObject({ bookingId: done.booking.id, rating: 4, comment: 'Arrived on time and fixed it.', status: 'PUBLISHED' });
      const row = await h.prisma.review.findUniqueOrThrow({ where: { id: res.body.id } });
      expect(row).toMatchObject({ customerId: done.customer.userId, workerProfileId: w.workerId });
      expect((await h.api().get(`/api/v1/bookings/${done.booking.id}/review`).set(as(done.customer)).expect(200)).body.id).toBe(res.body.id);
      expect(await expectAggregateConsistent(w.workerId)).toEqual({ ratingCount: 1, ratingSum: 4 });
    });

    it('refuses bookings that are not completed, not yours, or have no worker', async () => {
      const pending = await h.acceptedBooking();
      const early = await submit(pending.customer, pending.booking.id);
      expect(early.status).toBe(409);
      expect(early.body.code).toBe('NOT_REVIEWABLE');
      const confirmed = await h.confirmedBooking();
      expect((await submit(confirmed.customer, confirmed.booking.id)).body.code).toBe('NOT_REVIEWABLE');
      await h.startWork(confirmed.worker, confirmed.booking.id).expect(200);
      expect((await submit(confirmed.customer, confirmed.booking.id)).body.code).toBe('NOT_REVIEWABLE'); // in progress

      const cancelled = await h.confirmedBooking();
      await h.cancelBooking(cancelled.customer, cancelled.booking.id).expect(200);
      expect((await submit(cancelled.customer, cancelled.booking.id)).status).toBe(409);

      const open = await h.createBooking(await h.makeCustomer(), ref);
      const openOwner = await h.prisma.booking.findUniqueOrThrow({ where: { id: open.id } });
      expect(openOwner.workerProfileId).toBeNull();

      const done = await completedFor(await newWorker());
      expect((await submit(stranger, done.booking.id)).status).toBe(404);
      expect((await submit(stranger, randomUUID())).status).toBe(404);
      expect((await h.api().get(`/api/v1/bookings/${done.booking.id}/review`).set(as(stranger))).status).toBe(404);
    });

    it('does not let workers, administrators or anonymous callers review, and rejects client-supplied identity', async () => {
      const w = await newWorker();
      const done = await completedFor(w);
      expect((await submit(w as unknown as Session, done.booking.id)).status).toBe(403);
      expect((await submit({ accessToken: h.adminToken } as Session, done.booking.id)).status).toBe(403);
      await h.api().post(`/api/v1/bookings/${done.booking.id}/review`).send({ rating: 5 }).expect(401);
      for (const extra of [{ customerId: stranger.userId }, { workerProfileId: w.workerId }, { status: 'PUBLISHED' }, { bookingId: done.booking.id }, { userId: stranger.userId }]) {
        expect({ extra, status: (await submit(done.customer, done.booking.id, { rating: 5, ...extra })).status }).toEqual({ extra, status: 400 });
      }
      expect(await h.prisma.review.count({ where: { bookingId: done.booking.id } })).toBe(0);
    });

    it('never lets someone review their own service', async () => {
      const w = await newWorker();
      const done = await completedFor(w);
      // The worker's own account also holds the customer role and became the customer of this booking.
      const dual = await h.otpSignIn('customer', w.phone);
      expect(dual.userId).toBe(w.userId);
      await h.prisma.booking.update({ where: { id: done.booking.id }, data: { customerId: w.userId } });
      const res = await submit(dual, done.booking.id);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('CANNOT_REVIEW_OWN_SERVICE');
      await expect(h.prisma.review.create({ data: { bookingId: done.booking.id, customerId: w.userId, workerProfileId: w.workerId, rating: 5 } })).rejects.toThrow(/own service/);
    });

    it('validates the rating and the comment', async () => {
      const done = await completedFor(await newWorker());
      for (const bad of [{ rating: 0 }, { rating: 6 }, { rating: 4.5 }, { rating: '5; DROP' }, { rating: -1 }, {}, { rating: null }, { rating: 5, comment: 'x'.repeat(1001) }, { rating: 5, comment: { a: 1 } }]) {
        expect({ bad, status: (await submit(done.customer, done.booking.id, bad)).status }).toEqual({ bad, status: 400 });
      }
      expect(await h.prisma.review.count({ where: { bookingId: done.booking.id } })).toBe(0);
      const blank = await submit(done.customer, done.booking.id, { rating: 1, comment: '   ' }).expect(201);
      expect(blank.body.comment).toBeNull();
    });
  });

  describe('one review per booking', () => {
    it('refuses a second review, also after withdrawing the first', async () => {
      const done = await completedFor(await newWorker());
      await submit(done.customer, done.booking.id, { rating: 5 }).expect(201);
      const again = await submit(done.customer, done.booking.id, { rating: 1 });
      expect(again.status).toBe(409);
      expect(again.body.code).toBe('REVIEW_EXISTS');
      await h.api().delete(`/api/v1/bookings/${done.booking.id}/review`).set(as(done.customer)).expect(200);
      expect((await submit(done.customer, done.booking.id, { rating: 3 })).body.code).toBe('REVIEW_EXISTS');
    });

    it('creates exactly one review out of many simultaneous submissions', async () => {
      const w = await newWorker();
      const done = await completedFor(w);
      const results = await Promise.all(Array.from({ length: 10 }, (_, i) => submit(done.customer, done.booking.id, { rating: (i % 5) + 1 })));
      expect(results.filter((r) => r.status === 201)).toHaveLength(1);
      expect(results.filter((r) => r.status === 409).every((r) => r.body.code === 'REVIEW_EXISTS')).toBe(true);
      expect(await h.prisma.review.count({ where: { bookingId: done.booking.id } })).toBe(1);
      expect(await h.prisma.reviewEvent.count({ where: { review: { bookingId: done.booking.id } } })).toBe(1);
      await expectAggregateConsistent(w.workerId);
    });

    it('keeps the aggregate exact when many customers review the same worker at once', async () => {
      const w = await newWorker();
      const jobs = await Promise.all([1, 2, 3, 4].map(() => completedFor(w)));
      const ratings = [5, 4, 3, 2];
      await Promise.all(jobs.map((j, i) => submit(j.customer, j.booking.id, { rating: ratings[i] }).expect(201)));
      expect(await expectAggregateConsistent(w.workerId)).toEqual({ ratingCount: 4, ratingSum: 14 });
    });
  });

  describe('the database protects reviews by itself', () => {
    it('refuses reviews for incomplete bookings, wrong people, and out-of-range ratings', async () => {
      const w = await newWorker();
      const done = await completedFor(w);
      const confirmed = await h.confirmedBooking();
      const data = { bookingId: done.booking.id, customerId: done.customer.userId, workerProfileId: w.workerId, rating: 5 };
      await expect(h.prisma.review.create({ data: { ...data, bookingId: confirmed.booking.id } })).rejects.toThrow(/completed/);
      await expect(h.prisma.review.create({ data: { ...data, customerId: stranger.userId } })).rejects.toThrow(/booking customer/);
      await expect(h.prisma.review.create({ data: { ...data, workerProfileId: (await newWorker()).workerId } })).rejects.toThrow(/booking customer about the booking worker/);
      await expect(h.prisma.review.create({ data: { ...data, rating: 0 } })).rejects.toThrow();
      await expect(h.prisma.review.create({ data: { ...data, rating: 6 } })).rejects.toThrow();
      await expect(h.prisma.review.create({ data: { ...data, status: 'HIDDEN' } })).rejects.toThrow(/published/);
      const ok = await h.prisma.review.create({ data });
      await expect(h.prisma.review.create({ data })).rejects.toThrow(); // unique per booking
      await expect(h.prisma.workerProfile.update({ where: { id: w.workerId }, data: { ratingSum: 99 } })).rejects.toThrow(); // CHECK: sum within 5 x count
      expect(ok.status).toBe('PUBLISHED');
    });

    it('never lets a review be rewritten, deleted, revived after withdrawal, or its history erased', async () => {
      const w = await newWorker();
      const done = await completedFor(w);
      const r = (await submit(done.customer, done.booking.id, { rating: 2, comment: 'Not good' }).expect(201)).body;
      await expect(h.prisma.review.update({ where: { id: r.id }, data: { rating: 5 } })).rejects.toThrow(/cannot be changed/);
      await expect(h.prisma.review.update({ where: { id: r.id }, data: { comment: 'Great!' } })).rejects.toThrow(/cannot be changed/);
      await expect(h.prisma.review.update({ where: { id: r.id }, data: { customerId: stranger.userId } })).rejects.toThrow();
      await expect(h.prisma.review.delete({ where: { id: r.id } })).rejects.toThrow(/never deleted/);
      const ev = await h.prisma.reviewEvent.findFirstOrThrow({ where: { reviewId: r.id } });
      await expect(h.prisma.reviewEvent.update({ where: { id: ev.id }, data: { reason: 'edited' } })).rejects.toThrow(/append-only/);
      await expect(h.prisma.reviewEvent.delete({ where: { id: ev.id } })).rejects.toThrow(/append-only/);

      await h.api().delete(`/api/v1/bookings/${done.booking.id}/review`).set(as(done.customer)).expect(200);
      await expect(h.prisma.review.update({ where: { id: r.id }, data: { status: 'PUBLISHED' } })).rejects.toThrow(/final/);
    });
  });

  describe('withdrawal and moderation keep the rating exact', () => {
    it('recomputes the average after every hide, restore and withdrawal, and keeps the original text and history', async () => {
      const w = await newWorker();
      const jobs = await Promise.all([completedFor(w), completedFor(w), completedFor(w)]);
      const reviews = [];
      for (const [i, rating] of [5, 4, 3].entries()) reviews.push((await submit(jobs[i]!.customer, jobs[i]!.booking.id, { rating, comment: `Comment ${rating}` }).expect(201)).body);
      const rated = async () => (await h.api().get(`/api/v1/reviews/workers/${w.workerId}`).set(as(stranger)).expect(200)).body;
      expect((await rated()).summary).toMatchObject({ count: 3, average: 4 });

      const hidden = (await hide(reviews[2].id).expect(200)).body;
      expect(hidden).toMatchObject({ status: 'HIDDEN', rating: 3, comment: 'Comment 3' }); // the text is preserved, not rewritten
      expect((await rated()).summary).toMatchObject({ count: 2, average: 4.5 });
      expect(await expectAggregateConsistent(w.workerId)).toEqual({ ratingCount: 2, ratingSum: 9 });

      await restore(reviews[2].id).expect(200);
      expect((await rated()).summary).toMatchObject({ count: 3, average: 4 });

      await h.api().delete(`/api/v1/bookings/${jobs[0]!.booking.id}/review`).set(as(jobs[0]!.customer)).expect(200);
      const after = await rated();
      expect(after.summary).toMatchObject({ count: 2, average: 3.5, distribution: { 1: 0, 2: 0, 3: 1, 4: 1, 5: 0 } });
      await expectAggregateConsistent(w.workerId);

      const detail = (await h.api().get(`/api/v1/admin/reviews/${reviews[2].id}`).set(as(admin)).expect(200)).body;
      expect(detail.history.map((e: { action: string; reason: string | null }) => [e.action, e.reason])).toEqual([
        ['SUBMITTED', null],
        ['HIDDEN', 'Contains abusive language.'],
        ['RESTORED', 'Reviewed again: acceptable.'],
      ]);
      expect(detail.history.every((e: { actorUserId: string | null }) => e.actorUserId !== null)).toBe(true);
      expect(detail.comment).toBe('Comment 3');
    });

    it('enforces the allowed moves and requires a reason', async () => {
      const w = await newWorker();
      const done = await completedFor(w);
      const r = (await submit(done.customer, done.booking.id, { rating: 1 }).expect(201)).body;
      expect((await restore(r.id)).status).toBe(409); // already published
      expect((await h.api().post(`/api/v1/admin/reviews/${r.id}/hide`).set(as(admin)).send({})).status).toBe(400);
      expect((await h.api().post(`/api/v1/admin/reviews/${r.id}/hide`).set(as(admin)).send({ reason: 'x' })).status).toBe(400);
      expect((await h.api().post(`/api/v1/admin/reviews/${r.id}/hide`).set(as(admin)).send({ reason: 'fine reason', rating: 5 })).status).toBe(400); // moderation cannot carry content
      await hide(r.id).expect(200);
      expect((await hide(r.id)).status).toBe(409);
      // the customer may still withdraw a hidden review; after that an administrator cannot revive it
      await h.api().delete(`/api/v1/bookings/${done.booking.id}/review`).set(as(done.customer)).expect(200);
      expect((await restore(r.id)).status).toBe(409);
      expect((await hide(r.id)).status).toBe(409);
      expect((await h.api().delete(`/api/v1/bookings/${done.booking.id}/review`).set(as(done.customer))).status).toBe(409); // already withdrawn
      await expectAggregateConsistent(w.workerId);
    });

    it('stays consistent under simultaneous hide / restore / withdraw / new reviews', async () => {
      const w = await newWorker();
      const jobs = await Promise.all([1, 2, 3, 4, 5].map(() => completedFor(w)));
      const reviews = [];
      for (const [i, j] of jobs.entries()) reviews.push((await submit(j.customer, j.booking.id, { rating: (i % 5) + 1 }).expect(201)).body);
      await Promise.all([
        hide(reviews[0].id),
        hide(reviews[1].id),
        hide(reviews[1].id),
        h.api().delete(`/api/v1/bookings/${jobs[2]!.booking.id}/review`).set(as(jobs[2]!.customer)),
        h.api().delete(`/api/v1/bookings/${jobs[2]!.booking.id}/review`).set(as(jobs[2]!.customer)),
        restore(reviews[3].id),
      ]);
      await Promise.all([restore(reviews[0].id), hide(reviews[3].id), h.api().delete(`/api/v1/bookings/${jobs[4]!.booking.id}/review`).set(as(jobs[4]!.customer))]);
      await expectAggregateConsistent(w.workerId);
      const finals = await h.prisma.review.findMany({ where: { workerProfileId: w.workerId }, select: { id: true, status: true } });
      for (const f of finals) {
        const events = await h.prisma.reviewEvent.count({ where: { reviewId: f.id } });
        expect(events).toBeGreaterThanOrEqual(1);
      }
    });

    it('records moderation in the audit trail', async () => {
      const done = await completedFor(await newWorker());
      const r = (await submit(done.customer, done.booking.id, { rating: 2, comment: 'AUDIT-REVIEW-TEXT' }).expect(201)).body;
      await hide(r.id).expect(200);
      await restore(r.id).expect(200);
      const rows = await h.prisma.auditLog.findMany({ where: { entityType: 'review', entityId: r.id }, orderBy: { createdAt: 'asc' } });
      expect(rows.map((x) => x.action)).toEqual(['review.hide', 'review.restore']);
      expect(rows[0]!.metadata).toMatchObject({ beforeStatus: 'PUBLISHED', afterStatus: 'HIDDEN', reason: 'Contains abusive language.' });
      expect(JSON.stringify(rows)).not.toContain('AUDIT-REVIEW-TEXT');
    });

    it('has no way for an administrator to create or edit a review', async () => {
      const done = await completedFor(await newWorker());
      const r = (await submit(done.customer, done.booking.id, { rating: 3 }).expect(201)).body;
      expect((await h.api().post('/api/v1/admin/reviews').set(as(admin)).send({ bookingId: done.booking.id, rating: 5 })).status).toBe(404);
      expect((await h.api().patch(`/api/v1/admin/reviews/${r.id}`).set(as(admin)).send({ rating: 5 })).status).toBe(404);
      expect((await h.api().put(`/api/v1/admin/reviews/${r.id}`).set(as(admin)).send({ rating: 5 })).status).toBe(404);
      expect((await h.api().delete(`/api/v1/admin/reviews/${r.id}`).set(as(admin))).status).toBe(404);
      for (const who of [done.customer, stranger]) {
        expect((await h.api().get('/api/v1/admin/reviews').set(as(who))).status).toBe(403);
        expect((await h.api().post(`/api/v1/admin/reviews/${r.id}/hide`).set(as(who)).send({ reason: 'trying it' })).status).toBe(403);
      }
    });
  });

  describe('reading ratings', () => {
    it('shows published reviews without identities, paginated, and only for approved active workers', async () => {
      const w = await newWorker();
      const jobs = await Promise.all([completedFor(w), completedFor(w), completedFor(w)]);
      const made = [];
      for (const [i, j] of jobs.entries()) {
        made.push((await submit(j.customer, j.booking.id, { rating: 5 - i, comment: `c${i}` }).expect(201)).body);
        await new Promise((r) => setTimeout(r, 10));
      }
      await hide(made[1].id).expect(200);

      const list = (await h.api().get(`/api/v1/reviews/workers/${w.workerId}?limit=1&page=1`).set(as(stranger)).expect(200)).body;
      expect(list.meta).toMatchObject({ total: 2, limit: 1 });
      expect(list.items[0]).toMatchObject({ rating: 3, comment: 'c2' }); // newest first
      expect(Object.keys(list.items[0]).sort()).toEqual(['comment', 'createdAt', 'id', 'rating']);
      const all = JSON.stringify((await h.api().get(`/api/v1/reviews/workers/${w.workerId}?limit=100`).set(as(stranger)).expect(200)).body);
      expect(all).not.toContain('c1'); // the hidden one
      expect(all).not.toContain(jobs[0]!.customer.userId);
      expect(all).not.toMatch(/customerId|bookingId/);

      const mine = (await h.api().get('/api/v1/reviews/received?limit=100').set(as(w)).expect(200)).body;
      expect(mine.summary).toMatchObject({ count: 2, average: 4 });
      expect(mine.items).toHaveLength(2);
      expect((await h.api().get('/api/v1/reviews/received').set(as(stranger))).status).toBe(403);

      await h.prisma.workerProfile.update({ where: { id: w.workerId }, data: { verificationStatus: 'SUSPENDED' } });
      expect((await h.api().get(`/api/v1/reviews/workers/${w.workerId}`).set(as(stranger))).status).toBe(404);
      expect((await h.api().get(`/api/v1/reviews/workers/${randomUUID()}`).set(as(stranger))).status).toBe(404);
    });

    it('computes the average to two decimals and reports null without reviews', async () => {
      const w = await newWorker();
      expect((await h.api().get('/api/v1/reviews/received').set(as(w)).expect(200)).body.summary).toMatchObject({ count: 0, average: null });
      const jobs = await Promise.all([completedFor(w), completedFor(w), completedFor(w)]);
      for (const [i, r] of [5, 5, 4].entries()) await submit(jobs[i]!.customer, jobs[i]!.booking.id, { rating: r }).expect(201);
      expect((await h.api().get('/api/v1/reviews/received').set(as(w)).expect(200)).body.summary.average).toBe(4.67);
    });

    it('lists, filters and paginates reviews for administrators', async () => {
      const w = await newWorker();
      const jobs = await Promise.all([completedFor(w), completedFor(w)]);
      const a = (await submit(jobs[0]!.customer, jobs[0]!.booking.id, { rating: 1 }).expect(201)).body;
      await submit(jobs[1]!.customer, jobs[1]!.booking.id, { rating: 5 }).expect(201);
      await hide(a.id).expect(200);
      const list = (q: string) => h.api().get(`/api/v1/admin/reviews?workerProfileId=${w.workerId}&${q}`).set(as(admin)).expect(200);
      expect((await list('')).body.meta.total).toBe(2);
      expect((await list('status=HIDDEN')).body.items.map((i: { id: string }) => i.id)).toEqual([a.id]);
      expect((await list('rating=5')).body.items).toHaveLength(1);
      expect((await list('limit=1&page=2')).body.items).toHaveLength(1);
      expect((await list(`to=${new Date(Date.now() - 86_400_000).toISOString()}`)).body.meta.total).toBe(0);
      expect((await h.api().get('/api/v1/admin/reviews?rating=9').set(as(admin))).status).toBe(400);
    });
  });
});
