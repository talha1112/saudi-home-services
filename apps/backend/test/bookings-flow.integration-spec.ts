/**
 * REAL POSTGRESQL, FULL HTTP STACK: the booking and quotation lifecycle.
 * Needs TEST_DATABASE_URL (database name ending in _test, migrations applied). See bookings-harness.ts.
 */
import { BookingLifecycleService } from '../src/modules/bookings/booking-lifecycle.service.js';
import { BookingMaintenanceService } from '../src/modules/bookings/booking-maintenance.service.js';
import { DocumentStorage } from '../src/modules/workers/storage/document-storage.js';
import { DisabledDocumentStorage } from '../src/modules/workers/storage/disabled-document-storage.js';
import { WorkerVerificationStatus } from '../src/generated/prisma/client.js';
import { type Harness, type Worker, bootHarness, daysFromNow, hoursFromNow } from './support/bookings-harness.js';

const run = process.env['TEST_DATABASE_URL'] ? describe : describe.skip;
if (!process.env['TEST_DATABASE_URL']) console.warn('bookings-flow.integration-spec: TEST_DATABASE_URL is not set, suite skipped');

run('bookings and quotations (real PostgreSQL, full HTTP stack)', () => {
  let h: Harness;
  let ref: Awaited<ReturnType<Harness['seedReferenceData']>>;
  let worker: Worker;
  let worker2: Worker;
  const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

  beforeAll(async () => {
    h = await bootHarness({ phonePrefix: '+9665992', slugPrefix: 'itest-bf-', adminEmailPrefix: 'itest-bf-admin' });
    ref = await h.seedReferenceData();
    worker = await h.makeWorker([ref.service.id], [ref.city.id]);
    worker2 = await h.makeWorker([ref.service.id], [ref.city.id]);
  });

  afterAll(async () => {
    if (h) await h.close();
  });

  // ---------------------------------------------------------------- pricing

  describe('pricing settings', () => {
    it('are admin-only and validated', async () => {
      const customer = await h.makeCustomer();
      const body = { vatRateBps: 1500, commissionRateBps: 1500, minServiceChargeHalalas: 5000 };
      await h.api().get('/api/v1/admin/pricing-settings').expect(401);
      await h.api().get('/api/v1/admin/pricing-settings').set(bearer(customer.accessToken)).expect(403);
      await h.api().post('/api/v1/admin/pricing-settings').set(bearer(worker.accessToken)).send(body).expect(403);
      for (const bad of [{ ...body, vatRateBps: 5001 }, { ...body, commissionRateBps: -1 }, { ...body, minServiceChargeHalalas: 1.5 }, { ...body, vatRateBps: 'x' }, { ...body, effectiveFrom: '2000-01-01T00:00:00Z' }, { ...body, isProvisional: false }]) {
        await h.api().post('/api/v1/admin/pricing-settings').set(bearer(h.adminToken)).send(bad).expect(400);
      }
      const current = await h.api().get('/api/v1/admin/pricing-settings/current').set(bearer(h.adminToken)).expect(200);
      expect(current.body).toMatchObject({ vatRateBps: 1500, commissionRateBps: 1500, minServiceChargeHalalas: 5000, isProvisional: false });
      const list = await h.api().get('/api/v1/admin/pricing-settings?limit=1').set(bearer(h.adminToken)).expect(200);
      expect(list.body.meta.limit).toBe(1);
    });
  });

  // ---------------------------------------------------------------- creating

  describe('creating a booking request', () => {
    it('creates an OPEN request without choosing a worker, and returns the customer\'s own address', async () => {
      const customer = await h.makeCustomer();
      const res = await h.api().post('/api/v1/bookings').set(bearer(customer.accessToken)).send(h.bookingBody(ref)).expect(201);
      expect(res.body).toMatchObject({
        status: 'OPEN',
        worker: null,
        money: null,
        acceptedQuoteId: null,
        location: { district: 'Al Olaya', addressLine: '12 Prince Sultan Street', cityNameAr: 'الرياض (اختبار)' },
        service: { nameAr: 'تمديدات' },
      });
      expect(res.body.reference).toMatch(/^BK-[A-HJ-NP-Z2-9]{8}$/);
      expect(res.body.timeline.map((e: any) => e.type)).toEqual(['BOOKING_CREATED']);
    });

    it('validates input and refuses client-controlled server fields', async () => {
      const customer = await h.makeCustomer();
      const post = (overrides: object) => h.api().post('/api/v1/bookings').set(bearer(customer.accessToken)).send(h.bookingBody(ref, overrides));
      expect((await post({ problemDescription: 'short' })).status).toBe(400);
      expect((await post({ preferredStartAt: hoursFromNow(-5), preferredEndAt: hoursFromNow(-1) })).body.code).toBe('INVALID_SCHEDULE');
      expect((await post({ preferredStartAt: hoursFromNow(0.1) })).body.code).toBe('INVALID_SCHEDULE'); // inside the minimum lead time
      expect((await post({ preferredStartAt: daysFromNow(2), preferredEndAt: daysFromNow(1) })).body.code).toBe('INVALID_SCHEDULE');
      expect((await post({ preferredStartAt: daysFromNow(400), preferredEndAt: daysFromNow(401) })).body.code).toBe('INVALID_SCHEDULE');
      expect((await post({ serviceId: '6f1c2f0e-6d4a-4a39-9d1e-0f6b1a9a0001' })).body.code).toBe('INVALID_SERVICE');
      expect((await post({ cityId: '6f1c2f0e-6d4a-4a39-9d1e-0f6b1a9a0001' })).body.code).toBe('INVALID_CITY');
      expect((await post({ longitude: undefined })).status).toBe(400); // latitude without longitude
      expect((await post({ latitude: 95 })).status).toBe(400);
      for (const field of ['status', 'customerId', 'workerProfileId', 'acceptedQuoteId', 'totalAmountHalalas', 'reference', 'expiresAt']) {
        expect((await post({ [field]: 'x' })).status).toBe(400);
      }
    });

    it('limits how many open requests one customer can have', async () => {
      const customer = await h.makeCustomer();
      for (let i = 0; i < 4; i++) await h.createBooking(customer, ref);
      const res = await h.api().post('/api/v1/bookings').set(bearer(customer.accessToken)).send(h.bookingBody(ref)).expect(409);
      expect(res.body.code).toBe('BOOKING_LIMIT');
    });

    it('is not available to workers or administrators', async () => {
      await h.api().post('/api/v1/bookings').set(bearer(worker.accessToken)).send(h.bookingBody(ref)).expect(403);
      await h.api().post('/api/v1/bookings').set(bearer(h.adminToken)).send(h.bookingBody(ref)).expect(403);
      await h.api().post('/api/v1/bookings').send(h.bookingBody(ref)).expect(401);
    });
  });

  // -------------------------------------------------- worker discovery of requests

  describe('which workers can see and quote on a request', () => {
    it('shows eligible approved workers the request, with city and district only', async () => {
      const customer = await h.makeCustomer();
      const booking = await h.createBooking(customer, ref, { isUrgent: true });
      const list = await h.api().get('/api/v1/workers/me/requests?urgentOnly=true').set(bearer(worker.accessToken)).expect(200);
      const mine = list.body.items.find((r: any) => r.id === booking.id);
      expect(mine).toBeDefined();
      expect(mine.location).toEqual({ cityId: ref.city.id, cityNameEn: 'Riyadh (test)', cityNameAr: 'الرياض (اختبار)', district: 'Al Olaya' });
      const everything = JSON.stringify([list.body, (await h.api().get(`/api/v1/workers/me/requests/${booking.id}`).set(bearer(worker.accessToken)).expect(200)).body]);
      for (const secret of ['Prince Sultan', 'Villa 7', 'addressLine', 'latitude', '24.7136', customer.phone, customer.userId]) expect(everything).not.toContain(secret);
    });

    it('hides it from workers who do not offer the service or serve the city, and from unapproved workers', async () => {
      const customer = await h.makeCustomer();
      const booking = await h.createBooking(customer, ref);
      const wrongService = await h.makeWorker([ref.otherService.id], [ref.city.id]);
      const wrongCity = await h.makeWorker([ref.service.id], [ref.otherCity.id]);
      const pending = await h.makeWorker([ref.service.id], [ref.city.id], WorkerVerificationStatus.SUBMITTED);

      for (const w of [wrongService, wrongCity]) {
        const list = await h.api().get('/api/v1/workers/me/requests').set(bearer(w.accessToken)).expect(200);
        expect(list.body.items.map((r: any) => r.id)).not.toContain(booking.id);
        await h.api().get(`/api/v1/workers/me/requests/${booking.id}`).set(bearer(w.accessToken)).expect(404);
        await h.api().post(`/api/v1/workers/me/requests/${booking.id}/quote`).set(bearer(w.accessToken)).send(h.quoteBody()).expect(404);
      }
      for (const url of ['/api/v1/workers/me/requests', `/api/v1/workers/me/requests/${booking.id}`]) {
        const res = await h.api().get(url).set(bearer(pending.accessToken)).expect(403);
        expect(res.body.code).toBe('WORKER_NOT_APPROVED');
      }
      const q = await h.api().post(`/api/v1/workers/me/requests/${booking.id}/quote`).set(bearer(pending.accessToken)).send(h.quoteBody()).expect(403);
      expect(q.body.code).toBe('WORKER_NOT_APPROVED');
    });

    it('filters and paginates', async () => {
      const customer = await h.makeCustomer();
      await h.createBooking(customer, ref, { isUrgent: true });
      await h.createBooking(customer, ref);
      const all = await h.api().get('/api/v1/workers/me/requests?limit=1&sort=soonest').set(bearer(worker.accessToken)).expect(200);
      expect(all.body.items).toHaveLength(1);
      expect(all.body.meta.total).toBeGreaterThanOrEqual(2);
      const urgent = await h.api().get('/api/v1/workers/me/requests?urgentOnly=true').set(bearer(worker.accessToken)).expect(200);
      expect(urgent.body.items.every((r: any) => r.isUrgent)).toBe(true);
      await h.api().get('/api/v1/workers/me/requests?serviceId=nope').set(bearer(worker.accessToken)).expect(400);
      await h.api().get('/api/v1/workers/me/requests?limit=500').set(bearer(worker.accessToken)).expect(400);
    });
  });

  // ------------------------------------------------------------------ quoting

  describe('submitting and editing quotes', () => {
    let customer: Awaited<ReturnType<Harness['makeCustomer']>>;
    let booking: { id: string };

    beforeAll(async () => {
      customer = await h.makeCustomer();
      booking = await h.createBooking(customer, ref);
    });

    it('computes VAT, commission, total and payout on the server with exact integer arithmetic', async () => {
      const q = await h.submitQuote(worker, booking.id, { priceHalalas: 33333 });
      // 15% of 33333 = 4999.95 -> 5000 (half up); total 38333; payout 28333
      expect(q.money).toMatchObject({ serviceHalalas: 33333, vatHalalas: 5000, totalHalalas: 38333, commissionHalalas: 5000, payoutHalalas: 28333, vatRateBps: 1500, commissionRateBps: 1500, currency: 'SAR' });
      expect(q).toMatchObject({ status: 'SUBMITTED', version: 1 });
      await h.api().post(`/api/v1/workers/me/quotes/${q.id}/withdraw`).set(bearer(worker.accessToken)).expect(200);
    });

    it('rejects prices below the minimum or above the maximum, and non-integer prices', async () => {
      const url = `/api/v1/workers/me/requests/${booking.id}/quote`;
      const post = (overrides: object) => h.api().post(url).set(bearer(worker2.accessToken)).send(h.quoteBody(overrides));
      const low = await post({ priceHalalas: 4999 });
      expect(low.body).toMatchObject({ code: 'PRICE_BELOW_MINIMUM', details: { minServiceChargeHalalas: 5000 } });
      expect((await post({ priceHalalas: 5_000_001 })).body.code).toBe('PRICE_TOO_HIGH');
      for (const bad of [0, -100, 100.5, '12.5', null, 'abc']) expect((await post({ priceHalalas: bad })).status).toBe(400);
    });

    it('never trusts client-sent VAT, commission, totals, status or identities', async () => {
      const url = `/api/v1/workers/me/requests/${booking.id}/quote`;
      for (const field of ['vatHalalas', 'vatAmountHalalas', 'totalHalalas', 'totalAmountHalalas', 'commissionHalalas', 'commissionRateBps', 'vatRateBps', 'workerPayoutHalalas', 'status', 'workerProfileId', 'bookingId', 'version', 'isAccepted', 'pricingSettingId']) {
        const res = await h.api().post(url).set(bearer(worker2.accessToken)).send(h.quoteBody({ [field]: 1 }));
        expect({ field, status: res.status }).toEqual({ field, status: 400 });
      }
      expect(await h.prisma.quote.count({ where: { bookingId: booking.id, workerProfileId: worker2.workerId } })).toBe(0);
    });

    it('validates the proposed window and validity', async () => {
      const url = `/api/v1/workers/me/requests/${booking.id}/quote`;
      const post = (overrides: object) => h.api().post(url).set(bearer(worker2.accessToken)).send(h.quoteBody(overrides));
      expect((await post({ proposedStartAt: hoursFromNow(-48), proposedEndAt: hoursFromNow(-44) })).body.code).toBe('INVALID_PROPOSED_WINDOW');
      expect((await post({ proposedStartAt: hoursFromNow(10), proposedEndAt: hoursFromNow(9) })).body.code).toBe('INVALID_PROPOSED_WINDOW');
      expect((await post({ validForHours: 100 })).body.code).toBe('INVALID_VALIDITY');
      expect((await post({ message: 'x'.repeat(1001) })).status).toBe(400);
    });

    it('accepts one quote per worker per request, and lets the worker edit it', async () => {
      const q1 = await h.submitQuote(worker, booking.id, { priceHalalas: 20000 });
      expect(q1.money).toMatchObject({ serviceHalalas: 20000, vatHalalas: 3000, totalHalalas: 23000, commissionHalalas: 3000, payoutHalalas: 17000 });
      const dup = await h.api().post(`/api/v1/workers/me/requests/${booking.id}/quote`).set(bearer(worker.accessToken)).send(h.quoteBody()).expect(409);
      expect(dup.body.code).toBe('QUOTE_EXISTS');

      const edited = await h.api().patch(`/api/v1/workers/me/quotes/${q1.id}`).set(bearer(worker.accessToken)).send({ priceHalalas: 18000, message: 'Better price' }).expect(200);
      expect(edited.body).toMatchObject({ version: q1.version + 1, message: 'Better price' });
      expect(edited.body.money).toMatchObject({ serviceHalalas: 18000, vatHalalas: 2700, totalHalalas: 20700 });
      expect((await h.api().patch(`/api/v1/workers/me/quotes/${q1.id}`).set(bearer(worker.accessToken)).send({}).expect(400)).body.code).toBe('NOTHING_TO_UPDATE');
      await h.api().patch(`/api/v1/workers/me/quotes/${q1.id}`).set(bearer(worker.accessToken)).send({ priceHalalas: 100 }).expect(400);
      await h.api().patch(`/api/v1/workers/me/quotes/${q1.id}`).set(bearer(worker.accessToken)).send({ totalHalalas: 1 }).expect(400);
    });

    it('keeps one worker\'s quotes private from another worker', async () => {
      const mine = (await h.api().get('/api/v1/workers/me/quotes').set(bearer(worker.accessToken)).expect(200)).body.items[0];
      await h.api().patch(`/api/v1/workers/me/quotes/${mine.id}`).set(bearer(worker2.accessToken)).send({ priceHalalas: 6000 }).expect(404);
      await h.api().post(`/api/v1/workers/me/quotes/${mine.id}/withdraw`).set(bearer(worker2.accessToken)).expect(404);
      const theirs = await h.api().get('/api/v1/workers/me/quotes').set(bearer(worker2.accessToken)).expect(200);
      expect(theirs.body.items.map((q: any) => q.id)).not.toContain(mine.id);
      const req = await h.api().get(`/api/v1/workers/me/requests/${booking.id}`).set(bearer(worker2.accessToken)).expect(200);
      expect(req.body.myQuote).toBeNull(); // worker2 cannot see worker's quote
    });

    it('lets a worker withdraw and later send the quote again (same row, new version)', async () => {
      const mine = (await h.api().get('/api/v1/workers/me/quotes').set(bearer(worker.accessToken)).expect(200)).body.items[0];
      const withdrawn = await h.api().post(`/api/v1/workers/me/quotes/${mine.id}/withdraw`).set(bearer(worker.accessToken)).expect(200);
      expect(withdrawn.body.status).toBe('WITHDRAWN');
      await h.api().patch(`/api/v1/workers/me/quotes/${mine.id}`).set(bearer(worker.accessToken)).send({ priceHalalas: 7000 }).expect(409);
      await h.api().post(`/api/v1/workers/me/quotes/${mine.id}/withdraw`).set(bearer(worker.accessToken)).expect(409);
      const again = await h.submitQuote(worker, booking.id, { priceHalalas: 21000 });
      expect(again.id).toBe(mine.id);
      expect(again).toMatchObject({ status: 'SUBMITTED', version: withdrawn.body.version + 1 });
      const events = await h.prisma.bookingEvent.findMany({ where: { quoteId: mine.id }, orderBy: { createdAt: 'asc' } });
      expect(events[0].type).toBe('QUOTE_SUBMITTED');
      expect(events.slice(-3).map((e) => e.type)).toEqual(['QUOTE_REVISED', 'QUOTE_WITHDRAWN', 'QUOTE_REVISED']);
    });

    it('lets the customer compare quotes without ever seeing the commission', async () => {
      await h.submitQuote(worker2, booking.id, { priceHalalas: 15000, proposedStartAt: hoursFromNow(26), proposedEndAt: hoursFromNow(30) });
      const res = await h.api().get(`/api/v1/bookings/${booking.id}/quotes`).set(bearer(customer.accessToken)).expect(200);
      expect(res.body.items.map((q: any) => q.money.serviceHalalas)).toEqual([15000, 21000]); // cheapest first
      expect(res.body.items[0]).toMatchObject({ status: 'SUBMITTED', isExpired: false, worker: { workerId: worker2.workerId, ratingAverage: null, ratingCount: 0, completedJobs: 0, yearsOfExperience: 5, serviceYearsOfExperience: 4 } });
      expect(res.body.items[0].worker.fullNameAr).toBe('عامل');
      expect(JSON.stringify(res.body)).not.toMatch(/commission|payout|pricingSetting/i);
      expect(JSON.stringify(res.body)).not.toContain(worker2.phone);

      const desc = await h.api().get(`/api/v1/bookings/${booking.id}/quotes?sort=price_desc`).set(bearer(customer.accessToken)).expect(200);
      expect(desc.body.items.map((q: any) => q.money.serviceHalalas)).toEqual([21000, 15000]);
      const soonest = await h.api().get(`/api/v1/bookings/${booking.id}/quotes?sort=soonest&limit=1`).set(bearer(customer.accessToken)).expect(200);
      expect(soonest.body.items[0].money.serviceHalalas).toBe(15000);
      expect(soonest.body.meta).toMatchObject({ total: 2, totalPages: 2 });
      await h.api().get(`/api/v1/bookings/${booking.id}/quotes?status=NOPE`).set(bearer(customer.accessToken)).expect(400);
    });

    it('keeps the comparison private to the booking owner', async () => {
      const stranger = await h.makeCustomer();
      await h.api().get(`/api/v1/bookings/${booking.id}/quotes`).set(bearer(stranger.accessToken)).expect(404);
      await h.api().get(`/api/v1/bookings/${booking.id}`).set(bearer(stranger.accessToken)).expect(404);
      await h.api().get(`/api/v1/bookings/${booking.id}/quotes`).set(bearer(worker.accessToken)).expect(403);
      await h.api().get(`/api/v1/bookings/${booking.id}/quotes`).set(bearer(h.adminToken)).expect(403);
    });
  });

  // ---------------------------------------------------------- accepting a quote

  describe('accepting a quote', () => {
    it('lets only the owner accept, exactly once, and rejects the other quotes', async () => {
      const customer = await h.makeCustomer();
      const stranger = await h.makeCustomer();
      const booking = await h.createBooking(customer, ref);
      const qa = await h.submitQuote(worker, booking.id, { priceHalalas: 25000 });
      const qb = await h.submitQuote(worker2, booking.id, { priceHalalas: 22000 });
      const accept = (c: { accessToken: string }, quoteId: string, body: object = {}) =>
        h.api().post(`/api/v1/bookings/${booking.id}/quotes/${quoteId}/accept`).set(bearer(c.accessToken)).send(body);

      expect((await accept(stranger, qb.id)).status).toBe(404); // not the owner
      expect((await accept({ accessToken: worker.accessToken }, qb.id)).status).toBe(403); // wrong role
      expect((await accept(customer, qb.id, { priceHalalas: 1 })).status).toBe(400); // price from the client is refused
      expect((await accept(customer, qb.id, { expectedVersion: 9 })).body.code).toBe('QUOTE_CHANGED');
      expect((await accept(customer, '6f1c2f0e-6d4a-4a39-9d1e-0f6b1a9a0001')).status).toBe(404);

      const ok = await accept(customer, qb.id, { expectedVersion: 1 }).expect(200);
      expect(ok.body).toMatchObject({
        status: 'PAYMENT_PENDING',
        acceptedQuoteId: qb.id,
        worker: { workerId: worker2.workerId },
        money: { serviceHalalas: 22000, vatHalalas: 3300, totalHalalas: 25300, vatRateBps: 1500 },
      });
      expect(ok.body.worker.phone).toBeUndefined(); // contact is shared only after payment
      expect(ok.body.paymentDueAt).not.toBeNull();
      expect(JSON.stringify(ok.body)).not.toMatch(/commission/i);

      const row = await h.prisma.booking.findUniqueOrThrow({ where: { id: booking.id } });
      expect(row).toMatchObject({ serviceAmountHalalas: 22000, vatAmountHalalas: 3300, totalAmountHalalas: 25300, commissionAmountHalalas: 3300, workerPayoutHalalas: 18700, vatRateBps: 1500, commissionRateBps: 1500, workerProfileId: worker2.workerId });
      const quotes = await h.prisma.quote.findMany({ where: { bookingId: booking.id }, orderBy: { priceHalalas: 'asc' } });
      expect(quotes.map((q) => [q.priceHalalas, q.status, q.isAccepted])).toEqual([[22000, 'ACCEPTED', true], [25000, 'REJECTED', null]]);

      // a second accept, of either quote, fails
      expect((await accept(customer, qa.id)).body.code).toBe('INVALID_STATE');
      expect((await accept(customer, qb.id)).body.code).toBe('INVALID_STATE');
      // the rejected worker can no longer edit, and nobody can quote on a booking that moved on
      await h.api().patch(`/api/v1/workers/me/quotes/${qa.id}`).set(bearer(worker.accessToken)).send({ priceHalalas: 6000 }).expect(409);
      await h.api().post(`/api/v1/workers/me/quotes/${qb.id}/withdraw`).set(bearer(worker2.accessToken)).expect(409); // accepted quotes cannot be withdrawn
      const late = await h.makeWorker([ref.service.id], [ref.city.id]);
      expect((await h.api().post(`/api/v1/workers/me/requests/${booking.id}/quote`).set(bearer(late.accessToken)).send(h.quoteBody()).expect(409)).body.code).toBe('BOOKING_NOT_OPEN');

      const types = (await h.prisma.bookingEvent.findMany({ where: { bookingId: booking.id }, orderBy: { createdAt: 'asc' } })).map((e) => e.type);
      expect(types).toEqual(expect.arrayContaining(['BOOKING_CREATED', 'QUOTE_SUBMITTED', 'QUOTE_ACCEPTED', 'QUOTE_REJECTED']));
    });

    it('refuses withdrawn, expired and suspended-worker quotes', async () => {
      const customer = await h.makeCustomer();
      const booking = await h.createBooking(customer, ref);
      const w1 = await h.makeWorker([ref.service.id], [ref.city.id]);
      const w2 = await h.makeWorker([ref.service.id], [ref.city.id]);
      const w3 = await h.makeWorker([ref.service.id], [ref.city.id]);
      const q1 = await h.submitQuote(w1, booking.id);
      const q2 = await h.submitQuote(w2, booking.id);
      const q3 = await h.submitQuote(w3, booking.id);
      const accept = (quoteId: string) => h.api().post(`/api/v1/bookings/${booking.id}/quotes/${quoteId}/accept`).set(bearer(customer.accessToken)).send({});

      await h.api().post(`/api/v1/workers/me/quotes/${q1.id}/withdraw`).set(bearer(w1.accessToken)).expect(200);
      expect((await accept(q1.id).expect(409)).body.code).toBe('QUOTE_NOT_AVAILABLE');

      await h.prisma.quote.update({ where: { id: q2.id }, data: { validUntil: new Date(Date.now() - 1000) } });
      expect((await accept(q2.id).expect(409)).body.code).toBe('QUOTE_EXPIRED');

      await h.prisma.workerProfile.update({ where: { id: w3.workerId }, data: { verificationStatus: WorkerVerificationStatus.SUSPENDED } });
      expect((await accept(q3.id).expect(409)).body.code).toBe('QUOTE_NOT_AVAILABLE');

      const row = await h.prisma.booking.findUniqueOrThrow({ where: { id: booking.id } });
      expect(row.status).toBe('OPEN');
      expect(await h.prisma.quote.count({ where: { bookingId: booking.id, status: 'ACCEPTED' } })).toBe(0);
    });
  });

  // ------------------------------------------------- the paid, in-progress job

  describe('after acceptance: payment, start and completion', () => {
    it('follows the lifecycle, hides contact details until paid, and enforces who may do what', async () => {
      const customer = await h.makeCustomer();
      const booking = await h.createBooking(customer, ref);
      const wk = await h.makeWorker([ref.service.id], [ref.city.id]);
      const other = await h.makeWorker([ref.service.id], [ref.city.id]);
      const quote = await h.submitQuote(wk, booking.id, { priceHalalas: 40000 });
      await h.api().post(`/api/v1/bookings/${booking.id}/quotes/${quote.id}/accept`).set(bearer(customer.accessToken)).send({ expectedVersion: 1 }).expect(200);
      const w = (path: string) => `/api/v1/workers/me/bookings/${booking.id}${path}`;

      // PAYMENT_PENDING: the worker may not start, and sees no address or customer contact
      expect((await h.api().post(w('/start')).set(bearer(wk.accessToken)).expect(409)).body.code).toBe('INVALID_STATE');
      const pending = (await h.api().get(w('')).set(bearer(wk.accessToken)).expect(200)).body;
      expect(pending.status).toBe('PAYMENT_PENDING');
      expect(JSON.stringify(pending)).not.toMatch(/Prince Sultan|Villa 7|latitude|customerPhone|customerName/);
      expect(pending.money).toMatchObject({ serviceHalalas: 40000, commissionHalalas: 6000, payoutHalalas: 34000 }); // the worker sees what they earn

      // nobody can mark a booking paid through the API
      for (const [method, url] of [['post', `/api/v1/bookings/${booking.id}/confirm-payment`], ['post', `/api/v1/bookings/${booking.id}/pay`], ['patch', `/api/v1/bookings/${booking.id}`], ['post', w('/confirm')]] as const) {
        const res = await (h.api() as any)[method](url).set(bearer(customer.accessToken)).send({ status: 'CONFIRMED' });
        expect([404, 403]).toContain(res.status);
      }
      expect((await h.prisma.booking.findUniqueOrThrow({ where: { id: booking.id } })).status).toBe('PAYMENT_PENDING');

      // the payments phase confirms payment through the domain service
      await h.app.get(BookingLifecycleService).confirmPayment(booking.id, { note: 'itest payment' });
      await expect(h.app.get(BookingLifecycleService).confirmPayment(booking.id)).rejects.toMatchObject({ code: 'BOOKING_ALREADY_PAID' });

      const paid = (await h.api().get(w('')).set(bearer(wk.accessToken)).expect(200)).body;
      expect(paid).toMatchObject({ status: 'CONFIRMED', customerPhone: customer.phone, location: { addressLine: '12 Prince Sultan Street', building: 'Villa 7' } });
      const custView = (await h.api().get(`/api/v1/bookings/${booking.id}`).set(bearer(customer.accessToken)).expect(200)).body;
      expect(custView.worker.phone).toBe(wk.phone);

      // only the assigned worker acts on it
      await h.api().get(w('')).set(bearer(other.accessToken)).expect(404);
      await h.api().post(w('/start')).set(bearer(other.accessToken)).expect(404);
      await h.api().post(w('/start')).set(bearer(customer.accessToken)).expect(403);
      await h.api().post(w('/start')).set(bearer(h.adminToken)).expect(403);
      await h.api().post(w('/complete')).set(bearer(wk.accessToken)).expect(409); // not started

      const started = await h.api().post(w('/start')).set(bearer(wk.accessToken)).expect(200);
      expect(started.body.startedAt).not.toBeNull();
      await h.api().post(w('/start')).set(bearer(wk.accessToken)).expect(409);
      // once the work has started the customer can no longer cancel
      expect((await h.api().post(`/api/v1/bookings/${booking.id}/cancel`).set(bearer(customer.accessToken)).send({ reason: 'CHANGED_MIND' }).expect(409)).body.code).toBe('INVALID_STATE');

      const done = await h.api().post(w('/complete')).set(bearer(wk.accessToken)).expect(200);
      expect(done.body).toMatchObject({ status: 'COMPLETED' });
      await h.api().post(w('/complete')).set(bearer(wk.accessToken)).expect(409);
      expect((await h.api().post(`/api/v1/admin/bookings/${booking.id}/cancel`).set(bearer(h.adminToken)).send({ note: 'too late' }).expect(409)).body.code).toBe('INVALID_STATE');

      const types = (await h.prisma.bookingEvent.findMany({ where: { bookingId: booking.id }, orderBy: { createdAt: 'asc' } })).map((e) => e.type);
      expect(types).toEqual(['BOOKING_CREATED', 'QUOTE_SUBMITTED', 'QUOTE_ACCEPTED', 'PAYMENT_CONFIRMED', 'WORK_STARTED', 'WORK_COMPLETED']);

      // completed jobs now count on the worker's public summary
      const next = await h.makeCustomer();
      const b2 = await h.createBooking(next, ref);
      await h.submitQuote(wk, b2.id);
      const cmp = await h.api().get(`/api/v1/bookings/${b2.id}/quotes`).set(bearer(next.accessToken)).expect(200);
      expect(cmp.body.items[0].worker.completedJobs).toBe(1);

      // the worker's job list and the admin view
      const mine = await h.api().get('/api/v1/workers/me/bookings?status=COMPLETED').set(bearer(wk.accessToken)).expect(200);
      expect(mine.body.items.map((b: any) => b.id)).toEqual([booking.id]);
      const admin = (await h.api().get(`/api/v1/admin/bookings/${booking.id}`).set(bearer(h.adminToken)).expect(200)).body;
      expect(admin.fullMoney).toMatchObject({ serviceHalalas: 40000, commissionHalalas: 6000, payoutHalalas: 34000 });
      expect(admin.quotes).toHaveLength(1);
      expect(admin.customerPhone).toBe(customer.phone);
    });
  });

  // ------------------------------------------------------------- cancellation

  describe('cancellation', () => {
    it('lets the owner cancel an open request, rejecting live quotes and keeping the reason', async () => {
      const customer = await h.makeCustomer();
      const stranger = await h.makeCustomer();
      const booking = await h.createBooking(customer, ref);
      await h.submitQuote(worker, booking.id);
      const cancel = (c: { accessToken: string }, body: object) => h.api().post(`/api/v1/bookings/${booking.id}/cancel`).set(bearer(c.accessToken)).send(body);

      expect((await cancel(customer, { reason: 'OTHER' })).body.code).toBe('NOTE_REQUIRED');
      expect((await cancel(customer, { reason: 'ADMIN_ACTION' })).status).toBe(400);
      expect((await cancel(customer, {})).status).toBe(400);
      expect((await cancel(stranger, { reason: 'CHANGED_MIND' })).status).toBe(404);
      expect((await cancel({ accessToken: worker.accessToken }, { reason: 'CHANGED_MIND' })).status).toBe(403);

      const ok = await cancel(customer, { reason: 'FOUND_ALTERNATIVE', note: 'Hired my cousin' }).expect(200);
      expect(ok.body).toMatchObject({ status: 'CANCELLED', cancellationReason: 'FOUND_ALTERNATIVE' });
      expect(ok.body.cancelledAt).not.toBeNull();
      expect((await cancel(customer, { reason: 'CHANGED_MIND' })).body.code).toBe('INVALID_STATE');

      const row = await h.prisma.bookingCancellation.findUniqueOrThrow({ where: { bookingId: booking.id } });
      expect(row).toMatchObject({ cancelledByUserId: customer.userId, cancelledByRole: 'CUSTOMER', previousStatus: 'OPEN', note: 'Hired my cousin' });
      expect(await h.prisma.quote.count({ where: { bookingId: booking.id, status: 'REJECTED' } })).toBe(1);
      const gone = await h.api().get('/api/v1/workers/me/requests').set(bearer(worker.accessToken)).expect(200);
      expect(gone.body.items.map((r: any) => r.id)).not.toContain(booking.id);
      expect((await h.api().post(`/api/v1/workers/me/requests/${booking.id}/quote`).set(bearer(worker2.accessToken)).send(h.quoteBody()).expect(409)).body.code).toBe('BOOKING_NOT_OPEN');
    });

    it('records the status a paid booking was in, and lets administrators cancel with a note', async () => {
      const customer = await h.makeCustomer();
      const booking = await h.createBooking(customer, ref);
      const wk = await h.makeWorker([ref.service.id], [ref.city.id]);
      const quote = await h.submitQuote(wk, booking.id);
      await h.api().post(`/api/v1/bookings/${booking.id}/quotes/${quote.id}/accept`).set(bearer(customer.accessToken)).send({}).expect(200);
      await h.app.get(BookingLifecycleService).confirmPayment(booking.id);
      await h.api().post(`/api/v1/workers/me/bookings/${booking.id}/start`).set(bearer(wk.accessToken)).expect(200);

      const url = `/api/v1/admin/bookings/${booking.id}/cancel`;
      await h.api().post(url).set(bearer(customer.accessToken)).send({ note: 'x' }).expect(403);
      await h.api().post(url).set(bearer(wk.accessToken)).send({ note: 'x' }).expect(403);
      await h.api().post(url).set(bearer(h.adminToken)).send({}).expect(400);
      const res = await h.api().post(url).set(bearer(h.adminToken)).send({ note: 'Customer reported a safety issue' }).expect(200);
      expect(res.body.status).toBe('CANCELLED');
      const row = await h.prisma.bookingCancellation.findUniqueOrThrow({ where: { bookingId: booking.id } });
      expect(row).toMatchObject({ cancelledByRole: 'ADMIN', previousStatus: 'IN_PROGRESS', reason: 'ADMIN_ACTION' });
      const audit = await h.prisma.auditLog.findMany({ where: { action: 'booking.cancelled_by_admin', entityId: booking.id } });
      expect(audit).toHaveLength(1);
      expect(JSON.stringify(audit)).not.toContain('safety issue');
    });
  });

  // ----------------------------------------------------- expiry and housekeeping

  describe('expiry', () => {
    it('stops accepting quotes when the request or a quote runs out of time, and records it', async () => {
      const customer = await h.makeCustomer();
      const booking = await h.createBooking(customer, ref);
      const expiring = await h.makeWorker([ref.service.id], [ref.city.id]);
      const staying = await h.makeWorker([ref.service.id], [ref.city.id]);
      const q1 = await h.submitQuote(expiring, booking.id);
      await h.submitQuote(staying, booking.id);

      // a quote whose validity ran out
      await h.prisma.quote.update({ where: { id: q1.id }, data: { validUntil: new Date(Date.now() - 5000) } });
      const maintenance = h.app.get(BookingMaintenanceService);
      expect((await maintenance.run()).quotes).toBeGreaterThanOrEqual(1);
      expect((await h.prisma.quote.findUniqueOrThrow({ where: { id: q1.id } })).status).toBe('EXPIRED');
      const live = await h.api().get(`/api/v1/bookings/${booking.id}/quotes`).set(bearer(customer.accessToken)).expect(200);
      expect(live.body.items).toHaveLength(1);
      // an expired quote can be offered again
      expect((await h.api().post(`/api/v1/workers/me/requests/${booking.id}/quote`).set(bearer(expiring.accessToken)).send(h.quoteBody()).expect(201)).body.status).toBe('SUBMITTED');

      // the whole request expires
      await h.prisma.booking.update({ where: { id: booking.id }, data: { expiresAt: new Date(Date.now() - 5000) } });
      expect((await h.api().post(`/api/v1/workers/me/requests/${booking.id}/quote`).set(bearer(expiring.accessToken)).send(h.quoteBody()).expect(409)).body.code).toBe('BOOKING_NOT_OPEN');
      const stillThere = await h.api().get('/api/v1/workers/me/requests').set(bearer(staying.accessToken)).expect(200);
      expect(stillThere.body.items.map((r: any) => r.id)).not.toContain(booking.id);
      const quotes = await h.api().get(`/api/v1/bookings/${booking.id}/quotes`).set(bearer(customer.accessToken)).expect(200);
      const target = quotes.body.items[0];
      expect((await h.api().post(`/api/v1/bookings/${booking.id}/quotes/${target.id}/accept`).set(bearer(customer.accessToken)).send({}).expect(409)).body.code).toBe('BOOKING_EXPIRED');

      expect((await maintenance.run()).bookings).toBeGreaterThanOrEqual(1);
      const row = await h.prisma.booking.findUniqueOrThrow({ where: { id: booking.id } });
      expect(row.status).toBe('EXPIRED');
      expect(await h.prisma.quote.count({ where: { bookingId: booking.id, status: 'SUBMITTED' } })).toBe(0);
      const types = (await h.prisma.bookingEvent.findMany({ where: { bookingId: booking.id } })).map((e) => e.type);
      expect(types).toEqual(expect.arrayContaining(['QUOTE_EXPIRED', 'BOOKING_EXPIRED']));
      // running again changes nothing
      expect(await maintenance.run()).toEqual({ quotes: expect.any(Number), bookings: expect.any(Number) });
      expect((await h.prisma.booking.findUniqueOrThrow({ where: { id: booking.id } })).status).toBe('EXPIRED');
    });
  });

  // ------------------------------------------------------- suspended workers

  describe('suspended and unapproved workers', () => {
    it('lose access to requests, quoting and their assigned jobs', async () => {
      const customer = await h.makeCustomer();
      const booking = await h.createBooking(customer, ref);
      const wk = await h.makeWorker([ref.service.id], [ref.city.id]);
      const quote = await h.submitQuote(wk, booking.id);
      await h.api().post(`/api/v1/bookings/${booking.id}/quotes/${quote.id}/accept`).set(bearer(customer.accessToken)).send({}).expect(200);
      await h.app.get(BookingLifecycleService).confirmPayment(booking.id);

      await h.prisma.workerProfile.update({ where: { id: wk.workerId }, data: { verificationStatus: WorkerVerificationStatus.SUSPENDED } });
      for (const [method, url] of [
        ['get', '/api/v1/workers/me/requests'],
        ['get', '/api/v1/workers/me/quotes'],
        ['get', '/api/v1/workers/me/bookings'],
        ['get', `/api/v1/workers/me/bookings/${booking.id}`],
        ['post', `/api/v1/workers/me/bookings/${booking.id}/start`],
      ] as const) {
        const res = await (h.api() as any)[method](url).set(bearer(wk.accessToken));
        expect({ url, status: res.status, code: res.body.code }).toEqual({ url, status: 403, code: 'WORKER_NOT_APPROVED' });
      }
    });
  });

  // ------------------------------------------------------ authorization matrix

  describe('authorization matrix', () => {
    it('requires authentication on every booking endpoint', async () => {
      const id = '6f1c2f0e-6d4a-4a39-9d1e-0f6b1a9a0001';
      const calls: [string, string][] = [
        ['post', '/api/v1/bookings'], ['get', '/api/v1/bookings'], ['get', `/api/v1/bookings/${id}`], ['post', `/api/v1/bookings/${id}/cancel`],
        ['get', `/api/v1/bookings/${id}/quotes`], ['post', `/api/v1/bookings/${id}/quotes/${id}/accept`], ['post', `/api/v1/bookings/${id}/photos`],
        ['get', '/api/v1/workers/me/requests'], ['get', `/api/v1/workers/me/requests/${id}`], ['post', `/api/v1/workers/me/requests/${id}/quote`],
        ['get', '/api/v1/workers/me/quotes'], ['patch', `/api/v1/workers/me/quotes/${id}`], ['post', `/api/v1/workers/me/quotes/${id}/withdraw`],
        ['get', '/api/v1/workers/me/bookings'], ['post', `/api/v1/workers/me/bookings/${id}/start`], ['post', `/api/v1/workers/me/bookings/${id}/complete`],
        ['get', '/api/v1/admin/bookings'], ['get', `/api/v1/admin/bookings/${id}`], ['post', `/api/v1/admin/bookings/${id}/cancel`],
        ['get', '/api/v1/admin/pricing-settings'], ['post', '/api/v1/admin/pricing-settings'],
      ];
      for (const [method, url] of calls) {
        const res = await (h.api() as any)[method](url).send({});
        expect({ url, status: res.status, code: res.body.code }).toEqual({ url, status: 401, code: 'AUTH_REQUIRED' });
      }
    });

    it('keeps each role inside its own area', async () => {
      const id = '6f1c2f0e-6d4a-4a39-9d1e-0f6b1a9a0001';
      const customer = await h.makeCustomer();
      const customerOnly: [string, string][] = [['get', '/api/v1/bookings'], ['post', '/api/v1/bookings'], ['get', `/api/v1/bookings/${id}`], ['post', `/api/v1/bookings/${id}/cancel`], ['get', `/api/v1/bookings/${id}/quotes`]];
      const workerOnly: [string, string][] = [['get', '/api/v1/workers/me/requests'], ['get', '/api/v1/workers/me/quotes'], ['get', '/api/v1/workers/me/bookings'], ['post', `/api/v1/workers/me/bookings/${id}/start`]];
      const adminOnly: [string, string][] = [['get', '/api/v1/admin/bookings'], ['get', `/api/v1/admin/bookings/${id}`], ['post', `/api/v1/admin/bookings/${id}/cancel`], ['post', '/api/v1/admin/pricing-settings']];
      const expect403 = async (token: string, calls: [string, string][]) => {
        for (const [method, url] of calls) {
          const res = await (h.api() as any)[method](url).set(bearer(token)).send({});
          expect({ url, status: res.status }).toEqual({ url, status: 403 });
        }
      };
      await expect403(customer.accessToken, [...workerOnly, ...adminOnly]);
      await expect403(worker.accessToken, [...customerOnly, ...adminOnly]);
      await expect403(h.adminToken, [...customerOnly, ...workerOnly]);
    });
  });

  // -------------------------------------------------------- lists and filters

  describe('lists, filters and pagination', () => {
    it('scopes the customer list to its owner and filters it', async () => {
      const customer = await h.makeCustomer();
      const other = await h.makeCustomer();
      const a = await h.createBooking(customer, ref);
      const b = await h.createBooking(customer, ref, { preferredStartAt: daysFromNow(5), preferredEndAt: daysFromNow(6) });
      await h.createBooking(other, ref);
      await h.api().post(`/api/v1/bookings/${b.id}/cancel`).set(bearer(customer.accessToken)).send({ reason: 'CHANGED_MIND' }).expect(200);

      const all = await h.api().get('/api/v1/bookings').set(bearer(customer.accessToken)).expect(200);
      expect(all.body.items.map((x: any) => x.id).sort()).toEqual([a.id, b.id].sort());
      expect(all.body.meta).toMatchObject({ total: 2, page: 1 });
      const open = await h.api().get('/api/v1/bookings?status=OPEN').set(bearer(customer.accessToken)).expect(200);
      expect(open.body.items.map((x: any) => x.id)).toEqual([a.id]);
      const both = await h.api().get('/api/v1/bookings?status=open,cancelled&sort=soonest&limit=1').set(bearer(customer.accessToken)).expect(200);
      expect(both.body.items[0].id).toBe(a.id);
      expect(both.body.meta).toMatchObject({ total: 2, totalPages: 2, limit: 1 });
      expect((await h.api().get(`/api/v1/bookings?cityId=${ref.otherCity.id}`).set(bearer(customer.accessToken)).expect(200)).body.items).toHaveLength(0);
      expect((await h.api().get(`/api/v1/bookings?serviceId=${ref.service.id}&createdFrom=2000-01-01T00:00:00Z`).set(bearer(customer.accessToken)).expect(200)).body.meta.total).toBe(2);
      await h.api().get('/api/v1/bookings?status=BOGUS').set(bearer(customer.accessToken)).expect(400);
      await h.api().get('/api/v1/bookings?sort=random').set(bearer(customer.accessToken)).expect(400);
    });

    it('lets administrators search every booking', async () => {
      const customer = await h.makeCustomer();
      const booking = await h.createBooking(customer, ref);
      const byRef = await h.api().get(`/api/v1/admin/bookings?reference=${booking.reference.toLowerCase()}`).set(bearer(h.adminToken)).expect(200);
      expect(byRef.body.items.map((x: any) => x.id)).toEqual([booking.id]);
      const byCustomer = await h.api().get(`/api/v1/admin/bookings?customerId=${customer.userId}&status=OPEN`).set(bearer(h.adminToken)).expect(200);
      expect(byCustomer.body.meta.total).toBe(1);
      await h.api().get('/api/v1/admin/bookings?customerId=nope').set(bearer(h.adminToken)).expect(400);
      const detail = await h.api().get(`/api/v1/admin/bookings/${booking.id}`).set(bearer(h.adminToken)).expect(200);
      expect(detail.body).toMatchObject({ customerId: customer.userId, customerPhone: customer.phone, location: { addressLine: '12 Prince Sultan Street' } });
    });
  });

  // ------------------------------------------------------------------ photos

  describe('problem photos', () => {
    it('are private to the owner, the eligible worker and administrators', async () => {
      const customer = await h.makeCustomer();
      const stranger = await h.makeCustomer();
      const booking = await h.createBooking(customer, ref);
      const t = bearer(customer.accessToken);
      const bad = await h.api().post(`/api/v1/bookings/${booking.id}/photos`).set(t).send({ fileName: 'a.exe', mimeType: 'application/x-msdownload', sizeBytes: 100 });
      expect(bad.status).toBe(400);
      await h.api().post(`/api/v1/bookings/${booking.id}/photos`).set(bearer(stranger.accessToken)).send({ fileName: 'a.jpg', mimeType: 'image/jpeg', sizeBytes: 100 }).expect(404);

      const reg = await h.api().post(`/api/v1/bookings/${booking.id}/photos`).set(t).send({ fileName: 'outlet.jpg', mimeType: 'image/jpeg', sizeBytes: 2048 }).expect(201);
      expect(reg.body).toMatchObject({ method: 'PUT', photo: { status: 'PENDING_UPLOAD' } });
      expect(JSON.stringify(reg.body.photo)).not.toMatch(/storage|bookings\//);
      const photoId = reg.body.photo.id;

      // not confirmed yet: nobody can fetch it
      await h.api().get(`/api/v1/bookings/${booking.id}/photos/${photoId}/download-url`).set(t).expect(404);
      await h.api().post(`/api/v1/bookings/${booking.id}/photos/${photoId}/confirm`).set(bearer(stranger.accessToken)).expect(404);
      expect((await h.api().post(`/api/v1/bookings/${booking.id}/photos/${photoId}/confirm`).set(t).expect(200)).body.status).toBe('UPLOADED');

      const own = await h.api().get(`/api/v1/bookings/${booking.id}/photos/${photoId}/download-url`).set(t).expect(200);
      expect(own.body.url).toContain('/download/');
      await h.api().get(`/api/v1/bookings/${booking.id}/photos/${photoId}/download-url`).set(bearer(stranger.accessToken)).expect(404);
      await h.api().get(`/api/v1/workers/me/requests/${booking.id}/photos/${photoId}/download-url`).set(bearer(worker.accessToken)).expect(200);
      const ineligible = await h.makeWorker([ref.otherService.id], [ref.city.id]);
      await h.api().get(`/api/v1/workers/me/requests/${booking.id}/photos/${photoId}/download-url`).set(bearer(ineligible.accessToken)).expect(404);
      await h.api().get(`/api/v1/admin/bookings/${booking.id}/photos/${photoId}/download-url`).set(bearer(h.adminToken)).expect(200);
      expect(await h.prisma.auditLog.count({ where: { action: 'booking.photo.accessed', entityId: photoId } })).toBe(1);

      // listed in the detail without storage details; eligible worker sees the metadata too
      const detail = (await h.api().get(`/api/v1/bookings/${booking.id}`).set(t).expect(200)).body;
      expect(detail.photos).toHaveLength(1);
      expect(JSON.stringify(detail)).not.toMatch(/storageKey|bookings\/[0-9a-f-]+\/photos/);

      // limit
      for (let i = 0; i < 4; i++) await h.api().post(`/api/v1/bookings/${booking.id}/photos`).set(t).send({ fileName: `p${i}.png`, mimeType: 'image/png', sizeBytes: 10 }).expect(201);
      expect((await h.api().post(`/api/v1/bookings/${booking.id}/photos`).set(t).send({ fileName: 'x.png', mimeType: 'image/png', sizeBytes: 10 }).expect(409)).body.code).toBe('PHOTO_LIMIT');
      await h.api().delete(`/api/v1/bookings/${booking.id}/photos/${photoId}`).set(bearer(stranger.accessToken)).expect(404);
      await h.api().delete(`/api/v1/bookings/${booking.id}/photos/${photoId}`).set(t).expect(204);
    });

    it('fail closed with 503 while no storage is configured', async () => {
      const customer = await h.makeCustomer();
      const booking = await h.createBooking(customer, ref);
      const real = h.app.get(DocumentStorage);
      const disabled = new DisabledDocumentStorage();
      const methods = ['createUploadTarget', 'exists', 'createDownloadTarget', 'delete'] as const;
      const originals = methods.map((m) => (real as any)[m]);
      methods.forEach((m) => ((real as any)[m] = (disabled as any)[m].bind(disabled)));
      try {
        const res = await h.api().post(`/api/v1/bookings/${booking.id}/photos`).set(bearer(customer.accessToken)).send({ fileName: 'a.jpg', mimeType: 'image/jpeg', sizeBytes: 100 });
        expect(res.status).toBe(503);
        expect(res.body.code).toBe('DOCUMENT_STORAGE_NOT_CONFIGURED');
        expect(await h.prisma.bookingPhoto.count({ where: { bookingId: booking.id } })).toBe(0);
      } finally {
        methods.forEach((m, i) => ((real as any)[m] = originals[i]));
      }
    });
  });
});
