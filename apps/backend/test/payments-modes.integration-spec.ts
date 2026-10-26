/**
 * REAL POSTGRESQL: the two built-in provider modes. `disabled` (the default) must never pretend to take
 * money; `mock` is a clearly-marked simulation that cannot be reached by an unauthenticated caller.
 */
import { type Harness, bootHarness } from './support/bookings-harness.js';

const run = process.env['TEST_DATABASE_URL'] ? describe : describe.skip;
if (!process.env['TEST_DATABASE_URL']) console.warn('payments-modes.integration-spec: TEST_DATABASE_URL is not set, suite skipped');

const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

run('payment provider: disabled mode (the default)', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await bootHarness({ phonePrefix: '+9665999', slugPrefix: 'itest-pd-', adminEmailPrefix: 'itest-pd-admin', payments: 'disabled' });
    await h.seedReferenceData();
  });

  afterAll(async () => {
    if (h) await h.close();
  });

  it('answers 503 and creates nothing, so nothing can be marked paid', async () => {
    const { customer, booking } = await h.acceptedBooking();
    const res = await h.startPayment(customer, booking.id);
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('PAYMENT_PROVIDER_NOT_CONFIGURED');
    expect(await h.prisma.paymentAttempt.count({ where: { bookingId: booking.id } })).toBe(0);
    expect(await h.prisma.ledgerEntry.count({ where: { bookingId: booking.id } })).toBe(0);
    expect(await h.prisma.booking.findUniqueOrThrow({ where: { id: booking.id } })).toMatchObject({ status: 'PAYMENT_PENDING', confirmedAt: null });
    // the customer's payment list is empty and the booking is still unpaid
    expect((await h.api().get('/api/v1/payments').set(bearer(customer.accessToken)).expect(200)).body.items).toHaveLength(0);
  });

  it('has no webhook endpoint and no simulation endpoint, even for administrators', async () => {
    const { booking } = await h.acceptedBooking();
    for (const provider of ['mock', 'disabled', 'testgw', 'stripe']) {
      const res = await h.sendWebhook({ id: `itest-pd-${provider}`, type: 'payment.succeeded', paymentId: 'x', amount: 23000, currency: 'SAR' }, { provider });
      expect({ provider, status: res.status }).toEqual({ provider, status: 404 });
    }
    expect((await h.api().post('/api/v1/dev/payments/6f1c2f0e-6d4a-4a39-9d1e-0f6b1a9a0001/simulate').set(bearer(h.adminToken)).send({ outcome: 'succeeded' })).status).toBe(404);
    expect(await h.prisma.paymentWebhookEvent.count({ where: { accountScope: { startsWith: 'itest' } } })).toBe(0);
    expect((await h.prisma.booking.findUniqueOrThrow({ where: { id: booking.id } })).status).toBe('PAYMENT_PENDING');
  });
});

run('payment provider: mock mode (development only)', () => {
  let h: Harness;
  let seq = 0;

  beforeAll(async () => {
    h = await bootHarness({ phonePrefix: '+9665980', slugPrefix: 'itest-pk-', adminEmailPrefix: 'itest-pk-admin', payments: 'mock' });
    await h.seedReferenceData();
  });

  afterAll(async () => {
    if (h) await h.close();
  });

  const simulate = (paymentId: string, body: object, token = h.adminToken) =>
    h.api().post(`/api/v1/dev/payments/${paymentId}/simulate`).set(bearer(token)).set('X-Forwarded-For', h.freshIp()).send(body);

  /** A mock payment in PROCESSING for a 23000-halala booking. */
  async function mockPayment() {
    const base = await h.acceptedBooking(20000);
    const res = await h.startPayment(base.customer, base.booking.id).expect(201);
    return { ...base, payment: res.body };
  }

  it('labels everything it creates as simulated', async () => {
    const { payment, booking } = await mockPayment();
    expect(payment).toMatchObject({ status: 'PROCESSING', simulated: true, amountHalalas: 23000, currency: 'SAR' });
    expect(payment.checkout.url).toContain('https://mock-checkout.invalid/pay/');
    const row = await h.prisma.paymentAttempt.findUniqueOrThrow({ where: { id: payment.id } });
    expect(row).toMatchObject({ provider: 'mock', isSimulated: true });
    expect(row.providerPaymentId).toMatch(/^mock_pay_/);
    expect((await h.prisma.booking.findUniqueOrThrow({ where: { id: booking.id } })).status).toBe('PAYMENT_PENDING');
  });

  it('does not accept webhooks: simulated events cannot arrive as if from a genuine provider', async () => {
    const { payment } = await mockPayment();
    const row = await h.prisma.paymentAttempt.findUniqueOrThrow({ where: { id: payment.id } });
    const res = await h.sendWebhook({ id: `itest-pk-wh-${++seq}`, type: 'payment.succeeded', paymentId: row.providerPaymentId, amount: 23000, currency: 'SAR' }, { provider: 'mock' });
    expect(res.status).toBe(404);
    expect((await h.prisma.paymentAttempt.findUniqueOrThrow({ where: { id: payment.id } })).status).toBe('PROCESSING');
  });

  it('exposes the simulation only to authenticated administrators', async () => {
    const { payment, customer, worker } = await mockPayment();
    const url = `/api/v1/dev/payments/${payment.id}/simulate`;
    await h.api().post(url).send({ outcome: 'succeeded' }).expect(401);
    await h.api().post(url).set(bearer(customer.accessToken)).send({ outcome: 'succeeded' }).expect(403);
    await h.api().post(url).set(bearer(worker.accessToken)).send({ outcome: 'succeeded' }).expect(403);
    expect((await h.prisma.paymentAttempt.findUniqueOrThrow({ where: { id: payment.id } })).status).toBe('PROCESSING');
    expect((await simulate(payment.id, { outcome: 'bogus' })).status).toBe(400);
    expect((await simulate(payment.id, { outcome: 'succeeded', status: 'SUCCEEDED' })).status).toBe(400);
  });

  it('runs a simulated success through the real processing path, flagged as simulated everywhere', async () => {
    const { payment, booking } = await mockPayment();
    const res = await simulate(payment.id, { outcome: 'succeeded' }).expect(200);
    expect(res.body).toMatchObject({ status: 'SUCCEEDED', simulated: true, capturedAmountHalalas: 23000 });
    expect(res.body.webhookEvents[0]).toMatchObject({ status: 'PROCESSED', outcome: 'APPLIED', simulated: true, provider: 'mock' });
    expect(res.body.ledger).toHaveLength(1);
    expect(res.body.ledger[0]).toMatchObject({ entryType: 'PAYMENT_CAPTURED', simulated: true, amountHalalas: 23000 });
    expect((await h.prisma.booking.findUniqueOrThrow({ where: { id: booking.id } })).status).toBe('CONFIRMED');
    const note = (await h.prisma.bookingEvent.findFirstOrThrow({ where: { bookingId: booking.id, type: 'PAYMENT_CONFIRMED' } })).note;
    expect(note).toMatch(/^SIMULATED payment/);
    expect(await h.prisma.auditLog.count({ where: { action: 'payment.simulated_event', entityId: payment.id } })).toBe(1);
    // simulated money is easy to exclude from real reporting
    const real = await h.api().get(`/api/v1/admin/payments?simulated=false&bookingId=${booking.id}`).set(bearer(h.adminToken)).expect(200);
    expect(real.body.items).toHaveLength(0);
  });

  it('rehearses mismatches, duplicates and failures like real events', async () => {
    const wrong = await mockPayment();
    const mismatch = await simulate(wrong.payment.id, { outcome: 'succeeded', amountHalalas: 100 }).expect(200);
    expect(mismatch.body).toMatchObject({ status: 'CAPTURED_UNAPPLIED', reconciliationReason: 'AMOUNT_MISMATCH' });
    expect((await h.prisma.booking.findUniqueOrThrow({ where: { id: wrong.booking.id } })).status).toBe('PAYMENT_PENDING');

    const dup = await mockPayment();
    const eventId = `itest-pk-dup-${++seq}`;
    const results = await Promise.all(Array.from({ length: 6 }, () => simulate(dup.payment.id, { outcome: 'succeeded', eventId })));
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(await h.prisma.bookingEvent.count({ where: { bookingId: dup.booking.id, type: 'PAYMENT_CONFIRMED' } })).toBe(1);
    expect(await h.prisma.ledgerEntry.count({ where: { bookingId: dup.booking.id } })).toBe(1);

    const failing = await mockPayment();
    expect((await simulate(failing.payment.id, { outcome: 'failed' }).expect(200)).body).toMatchObject({ status: 'FAILED', failureCode: 'SIMULATED_FAILURE' });
    // a failed attempt can be retried by the customer
    await h.startPayment(failing.customer, failing.booking.id).expect(201);
  });

  it('only ever simulates simulated payments', async () => {
    const { payment } = await mockPayment();
    // pretend this attempt was created by a real provider
    await h.prisma.paymentAttempt.update({ where: { id: payment.id }, data: { isSimulated: false, provider: 'testgw' } });
    expect((await simulate(payment.id, { outcome: 'succeeded' })).status).toBe(409);
    await h.prisma.paymentAttempt.update({ where: { id: payment.id }, data: { isSimulated: true, provider: 'mock' } });
    expect((await simulate('6f1c2f0e-6d4a-4a39-9d1e-0f6b1a9a0001', { outcome: 'succeeded' })).status).toBe(404);
  });
});
