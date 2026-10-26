/**
 * REAL POSTGRESQL, FULL HTTP STACK: starting a payment.
 * The payment gateway is the test double in src/testing (signed webhooks, switchable failures);
 * everything else (guards, locking, constraints, idempotency) is real.
 */
import { type Harness, bootHarness, hoursFromNow } from './support/bookings-harness.js';
import { WorkerVerificationStatus } from '../src/generated/prisma/client.js';

const run = process.env['TEST_DATABASE_URL'] ? describe : describe.skip;
if (!process.env['TEST_DATABASE_URL']) console.warn('payments-initiation.integration-spec: TEST_DATABASE_URL is not set, suite skipped');

run('payment initiation (real PostgreSQL)', () => {
  let h: Harness;
  let ref: Awaited<ReturnType<Harness['seedReferenceData']>>;
  const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

  beforeAll(async () => {
    process.env['PAYMENT_RETURN_URL_ORIGINS'] = 'https://app.example';
    h = await bootHarness({ phonePrefix: '+9665995', slugPrefix: 'itest-pi-', adminEmailPrefix: 'itest-pi-admin', payments: 'signed' });
    ref = await h.seedReferenceData();
  });

  afterAll(async () => {
    if (h) await h.close();
  });

  const attempts = (bookingId: string) => h.prisma.paymentAttempt.findMany({ where: { bookingId }, orderBy: { attemptNumber: 'asc' } });

  describe('ownership and roles', () => {
    it('requires authentication, the customer role, and the owning customer', async () => {
      const { customer, worker, booking } = await h.acceptedBooking();
      const stranger = await h.makeCustomer();
      const url = `/api/v1/bookings/${booking.id}/payments`;
      await h.api().post(url).set('Idempotency-Key', h.newKey()).expect(401);
      await h.api().post(url).set(bearer(worker.accessToken)).set('Idempotency-Key', h.newKey()).expect(403);
      await h.api().post(url).set(bearer(h.adminToken)).set('Idempotency-Key', h.newKey()).expect(403);
      // someone else's booking looks like a missing one
      const other = await h.startPayment(stranger, booking.id);
      expect(other.status).toBe(404);
      expect(await attempts(booking.id)).toHaveLength(0);

      const own = await h.startPayment(customer, booking.id).expect(201);
      const id = own.body.id;
      await h.api().get(`/api/v1/payments/${id}`).set(bearer(stranger.accessToken)).expect(404);
      await h.api().post(`/api/v1/payments/${id}/cancel`).set(bearer(stranger.accessToken)).expect(404);
      await h.api().get(`/api/v1/payments/${id}`).set(bearer(worker.accessToken)).expect(403);
      await h.api().get(`/api/v1/payments/${id}`).set(bearer(h.adminToken)).expect(403);
      const list = await h.api().get('/api/v1/payments').set(bearer(stranger.accessToken)).expect(200);
      expect(list.body.items).toHaveLength(0);
      await h.api().post(`/api/v1/bookings/not-a-uuid/payments`).set(bearer(customer.accessToken)).set('Idempotency-Key', h.newKey()).expect(400);
    });
  });

  describe('what the client can and cannot control', () => {
    it('uses the agreed total, never a client amount, currency or any server field', async () => {
      const { customer, booking } = await h.acceptedBooking(20000); // total 23000
      for (const field of ['amountHalalas', 'amount', 'currency', 'totalAmountHalalas', 'vatHalalas', 'commissionHalalas', 'status', 'provider', 'providerPaymentId', 'customerId', 'bookingId']) {
        const res = await h.startPayment(customer, booking.id, h.newKey(), { [field]: 1 });
        expect({ field, status: res.status }).toEqual({ field, status: 400 });
      }
      expect(await attempts(booking.id)).toHaveLength(0);

      const res = await h.startPayment(customer, booking.id).expect(201);
      expect(res.body).toMatchObject({ status: 'PROCESSING', amountHalalas: 23000, currency: 'SAR', attemptNumber: 1, simulated: false, bookingId: booking.id });
      expect(res.body.checkout.url).toContain('https://testgw.invalid/pay/');
      // nothing internal leaks
      expect(JSON.stringify(res.body)).not.toMatch(/providerPaymentId|tg_|idempotency|fingerprint|customerId|webhook|secret/i);
      const row = (await attempts(booking.id))[0];
      expect(row).toMatchObject({ amountHalalas: 23000, currency: 'SAR', openSlot: true, provider: 'testgw', isSimulated: false });
      expect(row.providerPaymentId).toMatch(/^tg_/);
    });

    it('validates and constrains returnUrl to the allowed origins', async () => {
      const { customer, booking } = await h.acceptedBooking();
      const key = h.newKey();
      expect((await h.startPayment(customer, booking.id, h.newKey(), { returnUrl: 'https://evil.example/steal' })).body.code).toBe('RETURN_URL_NOT_ALLOWED');
      expect((await h.startPayment(customer, booking.id, h.newKey(), { returnUrl: 'javascript:alert(1)' })).status).toBe(400);
      expect((await h.startPayment(customer, booking.id, h.newKey(), { returnUrl: 'not a url' })).status).toBe(400);
      expect(await attempts(booking.id)).toHaveLength(0);
      const ok = await h.startPayment(customer, booking.id, key, { returnUrl: 'https://app.example/booking/1/done' }).expect(201);
      expect(h.gateway.checkoutCalls.at(-1)?.returnUrl).toBe('https://app.example/booking/1/done');
      // same key, other return address = a different request
      expect((await h.startPayment(customer, booking.id, key, { returnUrl: 'https://app.example/other' }).expect(409)).body.code).toBe('IDEMPOTENCY_CONFLICT');
      expect(ok.body.attemptNumber).toBe(1);
    });

    it('requires a well-formed Idempotency-Key', async () => {
      const { customer, booking } = await h.acceptedBooking();
      const url = `/api/v1/bookings/${booking.id}/payments`;
      expect((await h.api().post(url).set(bearer(customer.accessToken)).send({}).expect(400)).body.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
      for (const bad of ['short', 'has spaces in it', 'x'.repeat(129), 'bad/char/slash']) {
        expect((await h.api().post(url).set(bearer(customer.accessToken)).set('Idempotency-Key', bad).send({}).expect(400)).body.code).toBe('IDEMPOTENCY_KEY_INVALID');
      }
      expect(await attempts(booking.id)).toHaveLength(0);
    });
  });

  describe('eligibility of the booking', () => {
    it('refuses bookings that cannot be paid, creating nothing', async () => {
      const customer = await h.makeCustomer();
      const open = await h.createBooking(customer, ref); // never accepted
      expect((await h.startPayment(customer, open.id).expect(409)).body).toMatchObject({ code: 'BOOKING_NOT_PAYABLE', details: { status: 'OPEN' } });

      const cancelled = await h.acceptedBooking();
      await h.api().post(`/api/v1/bookings/${cancelled.booking.id}/cancel`).set(bearer(cancelled.customer.accessToken)).send({ reason: 'CHANGED_MIND' }).expect(200);
      expect((await h.startPayment(cancelled.customer, cancelled.booking.id).expect(409)).body.code).toBe('BOOKING_NOT_PAYABLE');

      const late = await h.acceptedBooking();
      await h.prisma.booking.update({ where: { id: late.booking.id }, data: { paymentDueAt: new Date(Date.now() - 60_000) } });
      expect((await h.startPayment(late.customer, late.booking.id).expect(409)).body.code).toBe('PAYMENT_DEADLINE_PASSED');

      const suspended = await h.acceptedBooking();
      await h.prisma.workerProfile.update({ where: { id: suspended.worker.workerId }, data: { verificationStatus: WorkerVerificationStatus.SUSPENDED } });
      expect((await h.startPayment(suspended.customer, suspended.booking.id).expect(409)).body.code).toBe('WORKER_UNAVAILABLE');

      for (const id of [open.id, cancelled.booking.id, late.booking.id, suspended.booking.id]) expect(await attempts(id)).toHaveLength(0);
    });

    it('refuses a booking that is already paid', async () => {
      const { customer, booking } = await h.acceptedBooking(20000);
      const { providerPaymentId } = await h.startedPayment(customer, booking.id);
      await h.sendWebhook({ id: 'itest-evt-paid-1', type: 'payment.succeeded', paymentId: providerPaymentId, amount: 23000, currency: 'SAR' }).expect(200);
      expect((await h.startPayment(customer, booking.id).expect(409)).body.code).toBe('BOOKING_ALREADY_PAID');
    });
  });

  describe('concurrency and idempotency', () => {
    it('lets only one of many simultaneous attempts (different keys) open, keeping a single open attempt', async () => {
      const { customer, booking } = await h.acceptedBooking();
      const results = await Promise.all(Array.from({ length: 10 }, () => h.startPayment(customer, booking.id)));
      expect(results.filter((r) => r.status === 201)).toHaveLength(1);
      const refused = results.filter((r) => r.status === 409);
      expect(refused).toHaveLength(9);
      expect(refused.every((r) => r.body.code === 'PAYMENT_IN_PROGRESS')).toBe(true);
      const rows = await attempts(booking.id);
      expect(rows).toHaveLength(1);
      expect(rows[0].openSlot).toBe(true);
    });

    it('returns the same attempt for many simultaneous requests with the SAME key, asking the provider idempotently', async () => {
      const { customer, booking } = await h.acceptedBooking();
      const key = h.newKey();
      const before = h.gateway.checkoutCalls.length;
      const results = await Promise.all(Array.from({ length: 8 }, () => h.startPayment(customer, booking.id, key)));
      expect(results.every((r) => r.status === 201)).toBe(true);
      expect(new Set(results.map((r) => r.body.id)).size).toBe(1);
      expect(await attempts(booking.id)).toHaveLength(1);
      const calls = h.gateway.checkoutCalls.slice(before);
      expect(calls.length).toBeGreaterThanOrEqual(1);
      expect(new Set(calls.map((c) => c.idempotencyKey)).size).toBe(1); // every provider call carried the same stable key
      expect(calls[0].idempotencyKey).toMatch(/^pay_[0-9a-f-]{36}$/); // derived from our attempt id, never the customer's text
      expect(JSON.stringify(calls[0])).not.toContain(key);
      expect(calls.every((c) => c.amountHalalas === 23000 && c.currency === 'SAR')).toBe(true);
      // a later replay changes nothing
      const again = await h.startPayment(customer, booking.id, key).expect(201);
      expect(again.body.id).toBe(results[0].body.id);
      expect((await attempts(booking.id))[0].status).toBe('PROCESSING');
    });

    it('refuses to reuse a key for a different booking, and scopes keys per customer', async () => {
      const a = await h.acceptedBooking();
      const b = await h.acceptedBooking();
      const key = h.newKey();
      await h.startPayment(a.customer, a.booking.id, key).expect(201);
      expect((await h.startPayment(a.customer, b.booking.id, key)).status).toBe(404); // not a's booking
      // another customer may use the same key text for their own booking without clashing
      await h.startPayment(b.customer, b.booking.id, key).expect(201);
      expect(await attempts(b.booking.id)).toHaveLength(1);
    });

    it('allows a fresh attempt after the previous one failed, was cancelled or expired, and keeps history', async () => {
      const { customer, booking } = await h.acceptedBooking();
      const first = await h.startedPayment(customer, booking.id);
      await h.sendWebhook({ id: 'itest-evt-retry-fail', type: 'payment.failed', paymentId: first.providerPaymentId, failureCode: 'DECLINED' }).expect(200);
      const second = await h.startPayment(customer, booking.id).expect(201);
      expect(second.body.attemptNumber).toBe(2);

      await h.api().post(`/api/v1/payments/${second.body.id}/cancel`).set(bearer(customer.accessToken)).expect(200);
      const third = await h.startPayment(customer, booking.id).expect(201);
      expect(third.body.attemptNumber).toBe(3);

      // an open attempt whose checkout has expired is closed locally so the customer is not stuck
      await h.prisma.paymentAttempt.update({ where: { id: third.body.id }, data: { checkoutExpiresAt: new Date(Date.now() - 1000) } });
      const fourth = await h.startPayment(customer, booking.id).expect(201);
      expect(fourth.body.attemptNumber).toBe(4);

      const rows = await attempts(booking.id);
      expect(rows.map((r) => r.status)).toEqual(['FAILED', 'CANCELLED', 'EXPIRED', 'PROCESSING']);
      expect(rows.filter((r) => r.openSlot === true)).toHaveLength(1);
      expect(rows[0].failureCode).toBe('DECLINED');
    });
  });

  describe('provider trouble', () => {
    it('keeps an attempt INITIATED when the provider outcome is unknown, and resumes it with the same key', async () => {
      const { customer, booking } = await h.acceptedBooking();
      const key = h.newKey();
      h.gateway.failNextCheckout = 'unavailable';
      const failed = await h.startPayment(customer, booking.id, key);
      expect(failed.status).toBe(503);
      expect(failed.body.code).toBe('PAYMENT_PROVIDER_UNAVAILABLE');
      const parked = (await attempts(booking.id))[0];
      expect(parked).toMatchObject({ status: 'INITIATED', openSlot: true, providerPaymentId: null });

      // another key cannot start a parallel payment while this one is unresolved
      expect((await h.startPayment(customer, booking.id).expect(409)).body.code).toBe('PAYMENT_IN_PROGRESS');

      const resumed = await h.startPayment(customer, booking.id, key).expect(201);
      expect(resumed.body).toMatchObject({ id: parked.id, status: 'PROCESSING' });
      expect(await attempts(booking.id)).toHaveLength(1);
      const calls = h.gateway.checkoutCalls.filter((c) => c.paymentId === parked.id);
      expect(calls).toHaveLength(2);
      expect(calls[0].idempotencyKey).toBe(calls[1].idempotencyKey);
    });

    it('records a definitive provider refusal and frees the slot for another try', async () => {
      const { customer, booking } = await h.acceptedBooking();
      h.gateway.failNextCheckout = 'rejected';
      const res = await h.startPayment(customer, booking.id);
      expect(res.status).toBe(502);
      expect(res.body.code).toBe('PAYMENT_PROVIDER_REJECTED');
      expect(JSON.stringify(res.body)).not.toMatch(/MERCHANT_DECLINED|simulated refusal/); // provider text stays internal
      const row = (await attempts(booking.id))[0];
      expect(row).toMatchObject({ status: 'FAILED', openSlot: null, failureCode: 'MERCHANT_DECLINED' });
      await h.startPayment(customer, booking.id).expect(201);
    });
  });

  describe('reading and cancelling my payments', () => {
    it('lists only my own attempts with filters and pagination, and hides internals', async () => {
      const { customer, booking } = await h.acceptedBooking();
      const first = await h.startedPayment(customer, booking.id);
      await h.api().post(`/api/v1/payments/${first.dto.id}/cancel`).set(bearer(customer.accessToken)).expect(200);
      await h.startPayment(customer, booking.id).expect(201);

      const all = await h.api().get('/api/v1/payments').set(bearer(customer.accessToken)).expect(200);
      expect(all.body.meta.total).toBe(2);
      expect(all.body.items.map((p: any) => p.attemptNumber)).toEqual([2, 1]);
      const cancelledOnly = await h.api().get(`/api/v1/payments?status=cancelled&bookingId=${booking.id}`).set(bearer(customer.accessToken)).expect(200);
      expect(cancelledOnly.body.items.map((p: any) => p.id)).toEqual([first.dto.id]);
      expect(cancelledOnly.body.items[0].checkout).toBeNull(); // no checkout once closed
      const page = await h.api().get('/api/v1/payments?limit=1&page=2').set(bearer(customer.accessToken)).expect(200);
      expect(page.body).toMatchObject({ meta: { total: 2, totalPages: 2, page: 2, limit: 1 } });
      await h.api().get('/api/v1/payments?status=BOGUS').set(bearer(customer.accessToken)).expect(400);
      await h.api().get('/api/v1/payments?limit=500').set(bearer(customer.accessToken)).expect(400);
      expect(JSON.stringify(all.body)).not.toMatch(/providerPaymentId|tg_|idempotency|fingerprint/i);
    });

    it('cancels an open attempt idempotently, but never a captured one', async () => {
      const { customer, booking } = await h.acceptedBooking(20000);
      const p = await h.startedPayment(customer, booking.id);
      const c1 = await h.api().post(`/api/v1/payments/${p.dto.id}/cancel`).set(bearer(customer.accessToken)).expect(200);
      expect(c1.body.status).toBe('CANCELLED');
      expect((await h.api().post(`/api/v1/payments/${p.dto.id}/cancel`).set(bearer(customer.accessToken)).expect(200)).body.status).toBe('CANCELLED');

      // the provider can still report a capture for a cancelled attempt: that money is recorded, not lost
      await h.sendWebhook({ id: 'itest-evt-cancel-then-pay', type: 'payment.succeeded', paymentId: p.providerPaymentId, amount: 23000, currency: 'SAR' }).expect(200);
      const after = await h.prisma.paymentAttempt.findUniqueOrThrow({ where: { id: p.dto.id } });
      expect(after.status).toBe('SUCCEEDED');
      expect((await h.api().post(`/api/v1/payments/${p.dto.id}/cancel`).set(bearer(customer.accessToken)).expect(409)).body.code).toBe('PAYMENT_ALREADY_CAPTURED');
    });
  });
});
