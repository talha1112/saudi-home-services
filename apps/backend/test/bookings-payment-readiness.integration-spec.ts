/**
 * REAL POSTGRESQL: the contract between bookings and the (future) payments phase.
 *
 * Part 1 proves the guarantees payments can rely on: confirming is idempotent-safe, exactly one
 * PAYMENT_CONFIRMED can ever exist, late/duplicate payment events are distinguishable, the amount is
 * verified, and the confirmation can be part of the payments layer's own transaction.
 *
 * Part 2 PINS today's behaviour for the open business decisions (payment deadline, worker suspended
 * before payment, cancelling a paid booking). Those tests describe what happens NOW, not what is
 * desirable; they must be rewritten when the decisions are made (see docs/PAYMENTS_INTEGRATION.md).
 */
import { BookingLifecycleService } from '../src/modules/bookings/booking-lifecycle.service.js';
import { BookingMaintenanceService } from '../src/modules/bookings/booking-maintenance.service.js';
import { WorkerVerificationStatus } from '../src/generated/prisma/client.js';
import { type Harness, bootHarness } from './support/bookings-harness.js';

const run = process.env['TEST_DATABASE_URL'] ? describe : describe.skip;
if (!process.env['TEST_DATABASE_URL']) console.warn('bookings-payment-readiness.integration-spec: TEST_DATABASE_URL is not set, suite skipped');

run('payment integration points (real PostgreSQL)', () => {
  let h: Harness;
  let ref: Awaited<ReturnType<Harness['seedReferenceData']>>;
  let lifecycle: BookingLifecycleService;
  const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

  beforeAll(async () => {
    h = await bootHarness({ phonePrefix: '+9665994', slugPrefix: 'itest-bp-', adminEmailPrefix: 'itest-bp-admin' });
    ref = await h.seedReferenceData();
    lifecycle = h.app.get(BookingLifecycleService);
  });

  afterAll(async () => {
    if (h) await h.close();
  });

  /** A booking whose quote was accepted and now waits for payment. */
  async function pendingBooking(price = 20000) {
    const customer = await h.makeCustomer();
    const worker = await h.makeWorker([ref.service.id], [ref.city.id]);
    const booking = await h.createBooking(customer, ref);
    const quote = await h.submitQuote(worker, booking.id, { priceHalalas: price });
    await h.api().post(`/api/v1/bookings/${booking.id}/quotes/${quote.id}/accept`).set(bearer(customer.accessToken)).send({}).expect(200);
    return { customer, worker, booking, quote };
  }

  const state = async (id: string) => h.prisma.booking.findUniqueOrThrow({ where: { id } });
  const paymentEvents = (id: string) => h.prisma.bookingEvent.count({ where: { bookingId: id, type: 'PAYMENT_CONFIRMED' } });

  // =========================================================================
  // Part 1: guarantees
  // =========================================================================

  describe('confirmPayment guarantees', () => {
    it('confirms exactly once and tells a duplicate event apart from "this booking cannot be paid"', async () => {
      const { booking } = await pendingBooking();
      await lifecycle.confirmPayment(booking.id);
      const first = await state(booking.id);
      expect(first).toMatchObject({ status: 'CONFIRMED' });
      expect(first.confirmedAt).not.toBeNull();

      // A repeated payment event is recognisable as "already paid" and changes nothing.
      for (let i = 0; i < 3; i++) {
        await expect(lifecycle.confirmPayment(booking.id)).rejects.toMatchObject({ code: 'BOOKING_ALREADY_PAID' });
      }
      const after = await state(booking.id);
      expect(after.confirmedAt?.getTime()).toBe(first.confirmedAt?.getTime());
      expect(await paymentEvents(booking.id)).toBe(1);
    });

    it('reports a booking that was cancelled, expired or never accepted as not payable (a refund case for the payments layer)', async () => {
      const cancelled = await pendingBooking();
      await h.api().post(`/api/v1/bookings/${cancelled.booking.id}/cancel`).set(bearer(cancelled.customer.accessToken)).send({ reason: 'CHANGED_MIND' }).expect(200);
      await expect(lifecycle.confirmPayment(cancelled.booking.id)).rejects.toMatchObject({ code: 'BOOKING_NOT_PAYABLE', response: { details: { status: 'CANCELLED' } } });

      const customer = await h.makeCustomer();
      const open = await h.createBooking(customer, ref);
      await expect(lifecycle.confirmPayment(open.id)).rejects.toMatchObject({ code: 'BOOKING_NOT_PAYABLE', response: { details: { status: 'OPEN' } } });

      await expect(lifecycle.confirmPayment('6f1c2f0e-6d4a-4a39-9d1e-0f6b1a9a0001')).rejects.toMatchObject({ status: 404 });
      expect(await paymentEvents(cancelled.booking.id)).toBe(0);
    });

    it('treats a duplicate event for a booking that was paid and then cancelled as "already paid", not as a new payment', async () => {
      const { customer, booking } = await pendingBooking();
      await lifecycle.confirmPayment(booking.id);
      await h.api().post(`/api/v1/bookings/${booking.id}/cancel`).set(bearer(customer.accessToken)).send({ reason: 'CHANGED_MIND' }).expect(200);
      await expect(lifecycle.confirmPayment(booking.id)).rejects.toMatchObject({ code: 'BOOKING_ALREADY_PAID' });
      expect(await paymentEvents(booking.id)).toBe(1);
    });

    it('lets exactly one of many simultaneous confirmations through, never failing with a server error', async () => {
      const { booking } = await pendingBooking();
      const results = await Promise.allSettled(Array.from({ length: 8 }, () => lifecycle.confirmPayment(booking.id)));
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      for (const r of results.filter((x): x is PromiseRejectedResult => x.status === 'rejected')) {
        expect(r.reason).toMatchObject({ status: 409, code: 'BOOKING_ALREADY_PAID' });
      }
      expect(await paymentEvents(booking.id)).toBe(1);
      expect((await state(booking.id)).status).toBe('CONFIRMED');
    });

    it('resolves a confirmation racing a customer cancellation into a consistent, detectable outcome', async () => {
      for (let round = 0; round < 6; round++) {
        const { customer, booking } = await pendingBooking();
        const [pay, cancel] = await Promise.allSettled([
          lifecycle.confirmPayment(booking.id),
          h.api().post(`/api/v1/bookings/${booking.id}/cancel`).set(bearer(customer.accessToken)).send({ reason: 'CHANGED_MIND' }),
        ]);
        const row = await state(booking.id);
        const cancellation = await h.prisma.bookingCancellation.findUnique({ where: { bookingId: booking.id } });
        const paid = (await paymentEvents(booking.id)) === 1;

        if (pay.status === 'fulfilled') {
          // Payment first: if the cancel also succeeded it ran afterwards and says so (this is a refund case).
          expect(paid).toBe(true);
          if (cancellation) expect(cancellation.previousStatus).toBe('CONFIRMED');
          else expect(row.status).toBe('CONFIRMED');
        } else {
          // Cancel first: the payment is refused as "not payable" and no PAYMENT_CONFIRMED exists.
          expect(pay.reason).toMatchObject({ code: 'BOOKING_NOT_PAYABLE' });
          expect(paid).toBe(false);
          expect(row.status).toBe('CANCELLED');
          expect(cancellation?.previousStatus).toBe('PAYMENT_PENDING');
        }
        // "money was taken" is always derivable from the data: confirmed_at set <=> a PAYMENT_CONFIRMED event
        expect(row.confirmedAt !== null).toBe(paid);
        expect(cancel.status).toBe('fulfilled');
      }
    });

    it('verifies the paid amount and currency against the booking snapshot', async () => {
      const { booking } = await pendingBooking(20000); // total 23000 with 15% VAT
      await expect(lifecycle.confirmPayment(booking.id, { paidAmountHalalas: 20000 })).rejects.toMatchObject({
        code: 'PAYMENT_AMOUNT_MISMATCH',
        response: { details: { expectedHalalas: 23000, paidHalalas: 20000 } },
      });
      await expect(lifecycle.confirmPayment(booking.id, { paidAmountHalalas: 23001 })).rejects.toMatchObject({ code: 'PAYMENT_AMOUNT_MISMATCH' });
      await expect(lifecycle.confirmPayment(booking.id, { paidAmountHalalas: 23000.5 })).rejects.toMatchObject({ code: 'PAYMENT_AMOUNT_MISMATCH' });
      await expect(lifecycle.confirmPayment(booking.id, { paidAmountHalalas: 23000, currency: 'USD' })).rejects.toMatchObject({ code: 'PAYMENT_CURRENCY_MISMATCH' });
      expect(await state(booking.id)).toMatchObject({ status: 'PAYMENT_PENDING', confirmedAt: null });
      expect(await paymentEvents(booking.id)).toBe(0);

      await lifecycle.confirmPayment(booking.id, { paidAmountHalalas: 23000, currency: 'SAR', note: 'itest gateway ref' });
      expect(await state(booking.id)).toMatchObject({ status: 'CONFIRMED' });
    });

    it('can be part of the payments layer\'s own transaction: committed together, rolled back together', async () => {
      const a = await pendingBooking();
      await expect(
        h.prisma.$transaction(async (tx) => {
          await lifecycle.confirmPaymentInTransaction(tx, a.booking.id, { paidAmountHalalas: 23000 });
          // inside the transaction the booking is already confirmed...
          expect((await tx.booking.findUniqueOrThrow({ where: { id: a.booking.id } })).status).toBe('CONFIRMED');
          // ...but the payment record write that follows fails, so everything must roll back
          throw new Error('payment record insert failed');
        }),
      ).rejects.toThrow('payment record insert failed');
      expect(await state(a.booking.id)).toMatchObject({ status: 'PAYMENT_PENDING', confirmedAt: null });
      expect(await paymentEvents(a.booking.id)).toBe(0);

      const b = await pendingBooking();
      await h.prisma.$transaction(async (tx) => {
        await lifecycle.confirmPaymentInTransaction(tx, b.booking.id, { paidAmountHalalas: 23000 });
        await tx.auditLog.create({ data: { action: 'itest.payment.recorded', entityType: 'booking', entityId: b.booking.id } });
      });
      expect(await state(b.booking.id)).toMatchObject({ status: 'CONFIRMED' });
      expect(await h.prisma.auditLog.count({ where: { action: 'itest.payment.recorded', entityId: b.booking.id } })).toBe(1);
    });
  });

  // =========================================================================
  // Pricing is versioned and never rewrites what a customer already agreed to
  // =========================================================================

  describe('pricing versions and the money snapshot', () => {
    it('keeps an accepted booking\'s amounts and rates when the pricing changes later', async () => {
      const { booking } = await pendingBooking(20000);
      const before = await state(booking.id);
      expect(before).toMatchObject({ serviceAmountHalalas: 20000, vatAmountHalalas: 3000, totalAmountHalalas: 23000, commissionAmountHalalas: 3000, workerPayoutHalalas: 17000, vatRateBps: 1500, commissionRateBps: 1500 });

      await h.setPricing({ vatRateBps: 500, commissionRateBps: 2000, minServiceChargeHalalas: 7000 });
      await lifecycle.confirmPayment(booking.id, { paidAmountHalalas: 23000 }); // still the amount the customer agreed to
      const after = await state(booking.id);
      for (const field of ['serviceAmountHalalas', 'vatAmountHalalas', 'totalAmountHalalas', 'commissionAmountHalalas', 'workerPayoutHalalas', 'vatRateBps', 'commissionRateBps'] as const) {
        expect({ field, value: after[field] }).toEqual({ field, value: before[field] });
      }

      // New quotes use the new version; the history keeps both.
      const customer = await h.makeCustomer();
      const worker = await h.makeWorker([ref.service.id], [ref.city.id]);
      const next = await h.createBooking(customer, ref);
      const low = await h.api().post(`/api/v1/workers/me/requests/${next.id}/quote`).set(bearer(worker.accessToken)).send(h.quoteBody({ priceHalalas: 6000 }));
      expect(low.body).toMatchObject({ code: 'PRICE_BELOW_MINIMUM', details: { minServiceChargeHalalas: 7000 } });
      const q = await h.submitQuote(worker, next.id, { priceHalalas: 20000 });
      expect(q.money).toMatchObject({ vatHalalas: 1000, totalHalalas: 21000, commissionHalalas: 4000, payoutHalalas: 16000, vatRateBps: 500, commissionRateBps: 2000 });
      const history = await h.api().get('/api/v1/admin/pricing-settings').set(bearer(h.adminToken)).expect(200);
      expect(history.body.meta.total).toBeGreaterThanOrEqual(2);
      await h.setPricing({ vatRateBps: 1500, commissionRateBps: 1500, minServiceChargeHalalas: 5000 }); // restore for the next tests
    });

    it('refuses to edit an accepted quote, so the agreed price cannot drift', async () => {
      const { worker, quote } = await pendingBooking();
      await h.api().patch(`/api/v1/workers/me/quotes/${quote.id}`).set(bearer(worker.accessToken)).send({ priceHalalas: 99999 }).expect(409);
      await h.api().post(`/api/v1/workers/me/quotes/${quote.id}/withdraw`).set(bearer(worker.accessToken)).expect(409);
    });
  });

  // =========================================================================
  // Part 2: PINNED current behaviour for open business decisions
  // =========================================================================

  describe('KNOWN GAPS (pinned until the business decides; rewrite these tests with the decision)', () => {
    it('GAP 1: nothing enforces the payment deadline; a late payment is still accepted', async () => {
      const { booking } = await pendingBooking();
      await h.prisma.booking.update({ where: { id: booking.id }, data: { paymentDueAt: new Date(Date.now() - 3_600_000) } });
      await h.app.get(BookingMaintenanceService).run();
      expect((await state(booking.id)).status).toBe('PAYMENT_PENDING'); // never expires
      await lifecycle.confirmPayment(booking.id); // and a payment an hour after the deadline still confirms it
      expect((await state(booking.id)).status).toBe('CONFIRMED');
    });

    it('GAP 2: a worker suspended between acceptance and payment still gets the job confirmed', async () => {
      const { booking, worker } = await pendingBooking();
      await h.prisma.workerProfile.update({ where: { id: worker.workerId }, data: { verificationStatus: WorkerVerificationStatus.SUSPENDED } });
      await lifecycle.confirmPayment(booking.id);
      expect((await state(booking.id)).status).toBe('CONFIRMED'); // assigned to a suspended worker who cannot act on it
      await h.api().post(`/api/v1/workers/me/bookings/${booking.id}/start`).set(bearer(worker.accessToken)).expect(403);
    });

    it('GAP 3: a paid booking can be cancelled with no refund record, only a cancellation row saying it was CONFIRMED', async () => {
      const { customer, booking } = await pendingBooking();
      await lifecycle.confirmPayment(booking.id);
      await h.api().post(`/api/v1/bookings/${booking.id}/cancel`).set(bearer(customer.accessToken)).send({ reason: 'CHANGED_MIND' }).expect(200);
      const cancellation = await h.prisma.bookingCancellation.findUniqueOrThrow({ where: { bookingId: booking.id } });
      expect(cancellation.previousStatus).toBe('CONFIRMED'); // the only trace that money may need to go back
      // (there is no payments or refunds table yet; the payments phase must create the refund obligation)
    });

    it('GAP 4: the other quotes are already rejected when a quote is accepted, so a failed payment cannot fall back to the runner-up', async () => {
      const customer = await h.makeCustomer();
      const w1 = await h.makeWorker([ref.service.id], [ref.city.id]);
      const w2 = await h.makeWorker([ref.service.id], [ref.city.id]);
      const booking = await h.createBooking(customer, ref);
      const q1 = await h.submitQuote(w1, booking.id, { priceHalalas: 20000 });
      const q2 = await h.submitQuote(w2, booking.id, { priceHalalas: 25000 });
      await h.api().post(`/api/v1/bookings/${booking.id}/quotes/${q1.id}/accept`).set(bearer(customer.accessToken)).send({}).expect(200);
      expect((await h.prisma.quote.findUniqueOrThrow({ where: { id: q2.id } })).status).toBe('REJECTED');
    });
  });
});
