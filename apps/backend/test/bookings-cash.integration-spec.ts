/**
 * REAL POSTGRESQL: paying a booking in cash (cash on delivery).
 *
 * The customer picks cash on a PAYMENT_PENDING booking; it is confirmed at once, the worker then sees the address and the customer's
 * phone, and later confirms receiving the cash. No payment attempt and no ledger entry is written (how cash is accounted is an open
 * business decision), and none of the online-payment guarantees are weakened.
 */
import { BookingLifecycleService } from '../src/modules/bookings/booking-lifecycle.service.js';
import { type Harness, bootHarness } from './support/bookings-harness.js';

const run = process.env['TEST_DATABASE_URL'] ? describe : describe.skip;
if (!process.env['TEST_DATABASE_URL']) console.warn('bookings-cash.integration-spec: TEST_DATABASE_URL is not set, suite skipped');

run('cash on delivery (real PostgreSQL)', () => {
  let h: Harness;
  let ref: Awaited<ReturnType<Harness['seedReferenceData']>>;
  const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

  beforeAll(async () => {
    h = await bootHarness({ phonePrefix: '+9665995', slugPrefix: 'itest-cash-', adminEmailPrefix: 'itest-cash-admin' });
    ref = await h.seedReferenceData();
  });

  afterAll(async () => {
    if (h) await h.close();
  });

  const cash = (token: string, bookingId: string) => h.api().post(`/api/v1/bookings/${bookingId}/payments/cash`).set(bearer(token)).send({});
  const worker = (path: string, bookingId: string, token: string, method: 'get' | 'post' = 'post') =>
    h.api()[method](`/api/v1/workers/me/bookings/${bookingId}${path}`).set(bearer(token));
  const row = (id: string) => h.prisma.booking.findUniqueOrThrow({ where: { id } });

  it('confirms the booking at once as CASH, with no payment attempt and no ledger entry', async () => {
    const { customer, booking } = await h.acceptedBooking(20000, ref);

    const res = await cash(customer.accessToken, booking.id).expect(200);

    expect(res.body).toMatchObject({ id: booking.id, status: 'CONFIRMED', paymentMethod: 'CASH' });
    const after = await row(booking.id);
    expect(after).toMatchObject({ status: 'CONFIRMED', paymentMethod: 'CASH', cashCollectedAt: null });
    expect(after.confirmedAt).not.toBeNull();
    expect(await h.prisma.paymentAttempt.count({ where: { bookingId: booking.id } })).toBe(0);
    expect(await h.prisma.ledgerEntry.count({ where: { bookingId: booking.id } })).toBe(0);
    expect(await h.prisma.bookingEvent.count({ where: { bookingId: booking.id, type: 'PAYMENT_CONFIRMED' } })).toBe(1);
  });

  it('is safe to repeat: still one confirmation, same booking', async () => {
    const { customer, booking } = await h.acceptedBooking(20000, ref);
    await cash(customer.accessToken, booking.id).expect(200);
    const first = await row(booking.id);
    await Promise.all([cash(customer.accessToken, booking.id), cash(customer.accessToken, booking.id)].map((r) => r.then((x) => expect([200, 409]).toContain(x.status))));
    await cash(customer.accessToken, booking.id).expect(200);

    const after = await row(booking.id);
    expect(after.confirmedAt?.getTime()).toBe(first.confirmedAt?.getTime());
    expect(await h.prisma.bookingEvent.count({ where: { bookingId: booking.id, type: 'PAYMENT_CONFIRMED' } })).toBe(1);
  });

  it('releases the address, exact point and customer phone to the worker only after cash is chosen', async () => {
    const { customer, worker: wk, booking } = await h.acceptedBooking(20000, ref);

    const before = (await worker('', booking.id, wk.accessToken, 'get').expect(200)).body;
    expect(before.status).toBe('PAYMENT_PENDING');
    expect(before.location.addressLine).toBeUndefined();
    expect(before.location.latitude).toBeUndefined();
    expect(before.customerPhone).toBeUndefined();
    expect(before.paymentMethod).toBeNull();

    await cash(customer.accessToken, booking.id).expect(200);

    const after = (await worker('', booking.id, wk.accessToken, 'get').expect(200)).body;
    expect(after.status).toBe('CONFIRMED');
    expect(after.paymentMethod).toBe('CASH');
    expect(after.cashCollectedAt).toBeNull();
    expect(after.location.addressLine).toBeDefined();
    expect(after.customerPhone).toBe(customer.phone);
    expect(after.money.totalHalalas).toBeGreaterThan(0);
  });

  it('refuses what cannot be paid in cash, and never reveals another customer\'s booking', async () => {
    const customer = await h.makeCustomer();
    const open = await h.createBooking(customer, ref);
    await cash(customer.accessToken, open.id).expect(409).expect((r) => expect(r.body.code).toBe('BOOKING_NOT_PAYABLE'));

    const { booking } = await h.acceptedBooking(20000, ref);
    const stranger = await h.makeCustomer();
    await cash(stranger.accessToken, booking.id).expect(404);
    expect((await row(booking.id)).status).toBe('PAYMENT_PENDING');

    const { worker: wk, booking: other } = await h.acceptedBooking(20000, ref);
    await cash(wk.accessToken, other.id).expect(403);
  });

  it('refuses a cancelled booking and one already paid online', async () => {
    const cancelled = await h.acceptedBooking(20000, ref);
    await h.api().post(`/api/v1/bookings/${cancelled.booking.id}/cancel`).set(bearer(cancelled.customer.accessToken)).send({ reason: 'CHANGED_MIND' }).expect(200);
    await cash(cancelled.customer.accessToken, cancelled.booking.id).expect(409);

    const paid = await h.acceptedBooking(20000, ref);
    await h.app.get(BookingLifecycleService).confirmPayment(paid.booking.id); // as an online payment event would
    await cash(paid.customer.accessToken, paid.booking.id).expect(409).expect((r) => expect(r.body.code).toBe('BOOKING_ALREADY_PAID'));
    expect((await row(paid.booking.id)).paymentMethod).toBeNull();
  });

  it('is refused while an online payment for the booking is still open (no double payment)', async () => {
    const { customer, booking } = await h.acceptedBooking(20000, ref);
    await h.prisma.paymentAttempt.create({
      data: {
        bookingId: booking.id,
        customerId: customer.userId,
        attemptNumber: 1,
        provider: 'mock',
        status: 'PROCESSING',
        openSlot: true,
        amountHalalas: 23000,
        currency: 'SAR',
        idempotencyKey: `itest-cash-open-${booking.id}`,
        requestFingerprint: 'a'.repeat(64),
        isSimulated: true,
      },
    });
    await cash(customer.accessToken, booking.id).expect(409).expect((r) => expect(r.body.code).toBe('PAYMENT_IN_PROGRESS'));
    expect((await row(booking.id)).status).toBe('PAYMENT_PENDING');
  });

  it('is refused after the payment deadline or when the worker is no longer available', async () => {
    const late = await h.acceptedBooking(20000, ref);
    await h.prisma.booking.update({ where: { id: late.booking.id }, data: { paymentDueAt: new Date(Date.now() - 60_000) } });
    await cash(late.customer.accessToken, late.booking.id).expect(409).expect((r) => expect(r.body.code).toBe('PAYMENT_DEADLINE_PASSED'));

    const gone = await h.acceptedBooking(20000, ref);
    await h.prisma.workerProfile.update({ where: { id: gone.worker.workerId }, data: { verificationStatus: 'SUSPENDED' } });
    await cash(gone.customer.accessToken, gone.booking.id).expect(409).expect((r) => expect(r.body.code).toBe('WORKER_UNAVAILABLE'));
  });

  describe('the worker confirms receiving the cash', () => {
    async function confirmedCash() {
      const ctx = await h.acceptedBooking(20000, ref);
      await cash(ctx.customer.accessToken, ctx.booking.id).expect(200);
      return ctx;
    }

    it('only once the work has started, only by the assigned worker, and repeating it changes nothing', async () => {
      const { worker: wk, booking } = await confirmedCash();
      await worker('/cash-collected', booking.id, wk.accessToken).expect(409).expect((r) => expect(r.body.code).toBe('CASH_NOT_DUE_YET'));

      await worker('/start', booking.id, wk.accessToken).expect(200);
      const stranger = await h.makeWorker([ref.service.id], [ref.city.id]);
      await worker('/cash-collected', booking.id, stranger.accessToken).expect(404);
      expect((await row(booking.id)).cashCollectedAt).toBeNull();

      const res = await worker('/cash-collected', booking.id, wk.accessToken).expect(200);
      expect(res.body.cashCollectedAt).not.toBeNull();
      const first = (await row(booking.id)).cashCollectedAt;
      await worker('/cash-collected', booking.id, wk.accessToken).expect(200);
      expect((await row(booking.id)).cashCollectedAt?.getTime()).toBe(first?.getTime());

      await worker('/complete', booking.id, wk.accessToken).expect(200);
      expect((await row(booking.id)).status).toBe('COMPLETED');
    });

    it('is not available for a booking that was not paid in cash', async () => {
      const online = await h.acceptedBooking(20000, ref);
      await h.app.get(BookingLifecycleService).confirmPayment(online.booking.id);
      await worker('/start', online.booking.id, online.worker.accessToken).expect(200);
      await worker('/cash-collected', online.booking.id, online.worker.accessToken).expect(409).expect((r) => expect(r.body.code).toBe('NOT_A_CASH_BOOKING'));
    });

    it('is not available to customers', async () => {
      const { customer, booking } = await confirmedCash();
      await worker('/cash-collected', booking.id, customer.accessToken).expect(403);
    });
  });

  it('the database itself refuses an unknown method and "cash collected" on a non-cash booking', async () => {
    const { customer, booking } = await h.acceptedBooking(20000, ref);
    void customer;
    await expect(h.prisma.booking.update({ where: { id: booking.id }, data: { paymentMethod: 'BARTER' } })).rejects.toThrow();
    await expect(h.prisma.booking.update({ where: { id: booking.id }, data: { cashCollectedAt: new Date() } })).rejects.toThrow();
  });
});
