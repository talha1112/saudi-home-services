/**
 * REAL POSTGRESQL: the payment sweep and reconciliation report.
 *
 * The state-changing payment-deadline action is intentionally DISABLED (the business has not decided
 * what an unpaid booking becomes). These tests prove the sweep only observes and is safe to repeat,
 * and that stale attempts are reported without ever being marked successful.
 */
import { BookingMaintenanceService } from '../src/modules/bookings/booking-maintenance.service.js';
import { PaymentsMaintenanceService } from '../src/modules/payments/payments-maintenance.service.js';
import { type Harness, bootHarness } from './support/bookings-harness.js';

const run = process.env['TEST_DATABASE_URL'] ? describe : describe.skip;
if (!process.env['TEST_DATABASE_URL']) console.warn('payments-maintenance.integration-spec: TEST_DATABASE_URL is not set, suite skipped');

run('payment sweep and reconciliation (real PostgreSQL)', () => {
  let h: Harness;
  let sweep: PaymentsMaintenanceService;
  const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
  const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000);

  beforeAll(async () => {
    h = await bootHarness({ phonePrefix: '+9665998', slugPrefix: 'itest-pm-', adminEmailPrefix: 'itest-pm-admin', payments: 'signed' });
    await h.seedReferenceData();
    sweep = h.app.get(PaymentsMaintenanceService);
  });

  afterAll(async () => {
    if (h) await h.close();
  });

  const bookingRow = (id: string) => h.prisma.booking.findUniqueOrThrow({ where: { id } });
  const eventCount = (id: string) => h.prisma.bookingEvent.count({ where: { bookingId: id } });
  const report = async () => (await h.api().get('/api/v1/admin/payments/reconciliation').set(bearer(h.adminToken)).expect(200)).body;

  describe('payment deadline', () => {
    it('reports overdue unpaid bookings but changes nothing, however often it runs', async () => {
      const { booking } = await h.acceptedBooking();
      await h.prisma.booking.update({ where: { id: booking.id }, data: { paymentDueAt: ago(120) } });
      const before = await bookingRow(booking.id);
      const eventsBefore = await eventCount(booking.id);

      const runs = [];
      for (let i = 0; i < 4; i++) runs.push(await sweep.run());
      expect(runs.every((r) => r.overdueBookings >= 1)).toBe(true);

      const after = await bookingRow(booking.id);
      expect(after).toMatchObject({ status: 'PAYMENT_PENDING', confirmedAt: null, paymentDueAt: before.paymentDueAt, acceptedQuoteId: before.acceptedQuoteId });
      expect(await eventCount(booking.id)).toBe(eventsBefore); // no state change, so no timeline entry
      expect(await h.prisma.paymentAttempt.count({ where: { bookingId: booking.id } })).toBe(0);

      const r = await report();
      expect(r.deadlineAction).toBe('REPORT_ONLY');
      expect(r.overduePendingBookings.map((b: any) => b.id)).toContain(booking.id);
      expect(r.overduePendingBookings.find((b: any) => b.id === booking.id)).toMatchObject({ status: 'PAYMENT_PENDING', totalAmountHalalas: 23000 });
    });

    it('is safe to run many sweeps at the same time', async () => {
      const { booking } = await h.acceptedBooking();
      await h.prisma.booking.update({ where: { id: booking.id }, data: { paymentDueAt: ago(10) } });
      const results = await Promise.allSettled(Array.from({ length: 6 }, () => sweep.run()));
      expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
      expect((await bookingRow(booking.id)).status).toBe('PAYMENT_PENDING');
    });

    it('never lists a booking that has already been paid, and does not disturb it', async () => {
      const { customer, booking } = await h.acceptedBooking(20000);
      const p = await h.startedPayment(customer, booking.id);
      await h.sendWebhook({ id: `itest-pm-${Date.now()}`, type: 'payment.succeeded', paymentId: p.providerPaymentId, amount: 23000, currency: 'SAR' }).expect(200);
      await h.prisma.booking.update({ where: { id: booking.id }, data: { paymentDueAt: ago(500) } }); // deadline long past, but it IS paid
      await sweep.run();
      expect(await bookingRow(booking.id)).toMatchObject({ status: 'CONFIRMED' });
      expect((await report()).overduePendingBookings.map((b: any) => b.id)).not.toContain(booking.id);
    });

    it('does not interfere with the booking-request sweep', async () => {
      const { booking } = await h.acceptedBooking();
      await h.prisma.booking.update({ where: { id: booking.id }, data: { paymentDueAt: ago(60) } });
      await h.app.get(BookingMaintenanceService).run();
      await sweep.run();
      expect((await bookingRow(booking.id)).status).toBe('PAYMENT_PENDING');
    });
  });

  describe('stale payment attempts', () => {
    it('reports attempts that stay open too long without ever resolving them', async () => {
      const { customer, booking } = await h.acceptedBooking();
      const fresh = await h.startedPayment(customer, booking.id);
      const stale = await h.acceptedBooking();
      const old = await h.startedPayment(stale.customer, stale.booking.id);
      await h.prisma.paymentAttempt.update({ where: { id: old.dto.id }, data: { processingAt: ago(45) } });

      const initiated = await h.acceptedBooking();
      h.gateway.failNextCheckout = 'unavailable';
      await h.startPayment(initiated.customer, initiated.booking.id).expect(503); // parked as INITIATED
      const parked = await h.prisma.paymentAttempt.findFirstOrThrow({ where: { bookingId: initiated.booking.id } });
      await h.prisma.paymentAttempt.update({ where: { id: parked.id }, data: { createdAt: ago(90) } });

      const r = await report();
      const staleIds = r.staleAttempts.map((a: any) => a.id);
      expect(staleIds).toEqual(expect.arrayContaining([old.dto.id, parked.id]));
      expect(staleIds).not.toContain(fresh.dto.id);
      expect((await sweep.run()).staleAttempts).toBeGreaterThanOrEqual(2);

      // reported, never "reconciled": nothing became successful and nothing was captured or posted
      for (const id of [old.dto.id, parked.id]) {
        const a = await h.prisma.paymentAttempt.findUniqueOrThrow({ where: { id } });
        expect(['PROCESSING', 'INITIATED']).toContain(a.status);
        expect(a).toMatchObject({ capturedAmountHalalas: null, settledAt: null });
        expect(await h.prisma.ledgerEntry.count({ where: { paymentId: id } })).toBe(0);
      }
      expect((await bookingRow(stale.booking.id)).status).toBe('PAYMENT_PENDING');
      // and it keeps being reported until a verified event arrives
      expect((await report()).staleAttempts.map((a: any) => a.id)).toContain(old.dto.id);
    });

    it('stops reporting an attempt once a verified event resolves it', async () => {
      const { customer, booking } = await h.acceptedBooking(20000);
      const p = await h.startedPayment(customer, booking.id);
      await h.prisma.paymentAttempt.update({ where: { id: p.dto.id }, data: { processingAt: ago(60) } });
      expect((await report()).staleAttempts.map((a: any) => a.id)).toContain(p.dto.id);
      await h.sendWebhook({ id: `itest-pm-r-${Date.now()}`, type: 'payment.succeeded', paymentId: p.providerPaymentId, amount: 23000, currency: 'SAR' }).expect(200);
      expect((await report()).staleAttempts.map((a: any) => a.id)).not.toContain(p.dto.id);
    });
  });

  describe('the reconciliation report', () => {
    it('is administrator-only and lists captured-but-unapplied money and failed events', async () => {
      const customer = await h.makeCustomer();
      await h.api().get('/api/v1/admin/payments/reconciliation').expect(401);
      await h.api().get('/api/v1/admin/payments/reconciliation').set(bearer(customer.accessToken)).expect(403);

      const { customer: c2, booking } = await h.acceptedBooking();
      const p = await h.startedPayment(c2, booking.id);
      await h.sendWebhook({ id: `itest-pm-u-${Date.now()}`, type: 'payment.succeeded', paymentId: p.providerPaymentId, amount: 1000, currency: 'SAR' }).expect(200);
      const r = await report();
      expect(r.capturedUnapplied.find((x: any) => x.id === p.dto.id)).toMatchObject({ needsReconciliation: true, reconciliationReason: 'AMOUNT_MISMATCH', capturedAmountHalalas: 1000 });
      expect(r).toEqual(expect.objectContaining({ generatedAt: expect.any(String), failedWebhookEvents: expect.any(Array), orphanWebhookEvents: expect.any(Array) }));
      const flagged = await h.api().get('/api/v1/admin/payments?needsReconciliation=true').set(bearer(h.adminToken)).expect(200);
      expect(flagged.body.items.map((x: any) => x.id)).toContain(p.dto.id);
    });
  });
});
