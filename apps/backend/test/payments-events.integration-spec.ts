/**
 * REAL POSTGRESQL, FULL HTTP STACK: provider events (webhooks).
 * Events are posted to the real public webhook route as signed raw JSON by the test gateway, so
 * signature checking, the inbox, locking, booking confirmation and the ledger all run for real.
 */
import { LedgerService } from '../src/modules/payments/ledger.service.js';
import { PaymentEventsService } from '../src/modules/payments/payment-events.service.js';
import { PaymentsMaintenanceService } from '../src/modules/payments/payments-maintenance.service.js';
import { type Harness, bootHarness } from './support/bookings-harness.js';
import { jest } from '@jest/globals';
import { signTestWebhook } from '../src/testing/signed-test-payment.provider.js';

const run = process.env['TEST_DATABASE_URL'] ? describe : describe.skip;
if (!process.env['TEST_DATABASE_URL']) console.warn('payments-events.integration-spec: TEST_DATABASE_URL is not set, suite skipped');

run('payment events (real PostgreSQL)', () => {
  let h: Harness;
  let seq = 0;
  const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
  const evt = () => `itest-evt-${Date.now().toString(36)}-${++seq}`;

  beforeAll(async () => {
    h = await bootHarness({ phonePrefix: '+9665996', slugPrefix: 'itest-pe-', adminEmailPrefix: 'itest-pe-admin', payments: 'signed' });
    await h.seedReferenceData();
  });

  afterAll(async () => {
    if (h) await h.close();
  });

  const succeeded = (paymentId: string, extra: object = {}) => ({ id: evt(), type: 'payment.succeeded', paymentId, amount: 23000, currency: 'SAR', ...extra });
  const booking = (id: string) => h.prisma.booking.findUniqueOrThrow({ where: { id } });
  const attempt = (id: string) => h.prisma.paymentAttempt.findUniqueOrThrow({ where: { id } });
  const ledger = (bookingId: string) => h.prisma.ledgerEntry.findMany({ where: { bookingId }, orderBy: { postedAt: 'asc' } });
  const confirmations = (bookingId: string) => h.prisma.bookingEvent.count({ where: { bookingId, type: 'PAYMENT_CONFIRMED' } });
  const inbox = (providerEventId: string) => h.prisma.paymentWebhookEvent.findMany({ where: { providerEventId } });

  /** A booking waiting for payment with one payment in PROCESSING (total 23000). */
  async function payable(price = 20000) {
    const base = await h.acceptedBooking(price);
    const pay = await h.startedPayment(base.customer, base.booking.id);
    return { ...base, ...pay };
  }

  // ------------------------------------------------------------- authenticity

  describe('authenticity', () => {
    it('rejects bad signatures before any state is touched', async () => {
      const p = await payable();
      const payload = succeeded(p.providerPaymentId);
      const res = (signature?: string, body?: string) => h.sendWebhook(payload, { signature, body });
      const eventsBefore = await h.prisma.paymentWebhookEvent.count();

      expect((await res('0'.repeat(64))).status).toBe(401);
      expect((await res('')).status).toBe(401);
      expect((await h.api().post('/api/v1/payments/webhooks/testgw').set('Content-Type', 'application/json').send(JSON.stringify(payload))).status).toBe(401); // no header at all
      // a signature that is valid for a DIFFERENT body, and a body changed by one character after signing
      const other = signTestWebhook({ ...payload, amount: 1 });
      expect((await res(other.signature)).status).toBe(401);
      const exact = signTestWebhook(payload);
      expect((await res(exact.signature, exact.body.replace('23000', '23001'))).status).toBe(401);
      expect((await res(exact.signature, ` ${exact.body}`)).status).toBe(401); // even whitespace: the exact bytes are signed

      const body = (await res(undefined)).body;
      expect(body.code).toBeUndefined(); // the genuine one is accepted (below), the rejected ones never named a reason
      expect(await h.prisma.paymentWebhookEvent.count()).toBe(eventsBefore + 1);
      // only the one genuine request had any effect
      expect((await booking(p.booking.id)).status).toBe('CONFIRMED');
    });

    it('stores nothing and changes nothing for an invalid signature', async () => {
      const p = await payable();
      const payload = succeeded(p.providerPaymentId);
      const before = await h.prisma.paymentWebhookEvent.count();
      const res = await h.sendWebhook(payload, { signature: 'f'.repeat(64) }).expect(401);
      expect(res.body).toMatchObject({ code: 'INVALID_SIGNATURE' });
      expect(JSON.stringify(res.body)).not.toMatch(/secret|expected|hmac/i);
      expect(await h.prisma.paymentWebhookEvent.count()).toBe(before);
      expect(await inbox(payload.id)).toHaveLength(0);
      expect(await booking(p.booking.id)).toMatchObject({ status: 'PAYMENT_PENDING', confirmedAt: null });
      expect(await attempt(p.dto.id)).toMatchObject({ status: 'PROCESSING' });
      expect(await ledger(p.booking.id)).toHaveLength(0);
    });

    it('refuses unknown providers, oversize bodies and empty bodies', async () => {
      const payload = succeeded('whatever');
      expect((await h.sendWebhook(payload, { provider: 'nope' })).status).toBe(404);
      expect((await h.sendWebhook(payload, { provider: 'mock' })).status).toBe(404);
      const huge = JSON.stringify({ ...payload, padding: 'x'.repeat(70_000) });
      expect((await h.sendWebhook(payload, { body: huge, signature: 'a'.repeat(64) })).status).toBe(413);
      expect((await h.api().post('/api/v1/payments/webhooks/testgw').set('Content-Type', 'application/json').send('')).status).toBe(400);
    });
  });

  // --------------------------------------------------------------- the happy path

  describe('a genuine successful payment', () => {
    it('confirms the booking, captures the amount and posts exactly one ledger entry, atomically', async () => {
      const p = await payable(20000);
      const payload = succeeded(p.providerPaymentId);
      const res = await h.sendWebhook(payload).expect(200);
      expect(res.body).toEqual({ received: true, result: 'processed' });

      expect(await booking(p.booking.id)).toMatchObject({ status: 'CONFIRMED', totalAmountHalalas: 23000 });
      expect(await attempt(p.dto.id)).toMatchObject({ status: 'SUCCEEDED', openSlot: null, capturedAmountHalalas: 23000, capturedCurrency: 'SAR', reconciliationReason: null });
      const entries = await ledger(p.booking.id);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ entryType: 'PAYMENT_CAPTURED', amountHalalas: 23000, currency: 'SAR', paymentId: p.dto.id, isSimulated: false, idempotencyKey: `payment:${p.dto.id}:capture` });
      const [row] = await inbox(payload.id);
      expect(row).toMatchObject({ status: 'PROCESSED', outcome: 'APPLIED', paymentAttemptId: p.dto.id, amountHalalas: 23000, attempts: 1 });
      expect(row.payloadHash).toMatch(/^[0-9a-f]{64}$/);
      const timeline = await h.prisma.bookingEvent.findFirstOrThrow({ where: { bookingId: p.booking.id, type: 'PAYMENT_CONFIRMED' } });
      expect(timeline.note).toContain(p.dto.id);
      // the customer sees the result; the agreed snapshot is untouched
      expect((await h.api().get(`/api/v1/payments/${p.dto.id}`).set(bearer(p.customer.accessToken)).expect(200)).body.status).toBe('SUCCEEDED');
    });

    it('does not trust a checkout return: the booking stays unpaid until a verified event arrives', async () => {
      const p = await payable();
      // everything a browser could do after the hosted page: read its own payment, reload the booking
      await h.api().get(`/api/v1/payments/${p.dto.id}`).set(bearer(p.customer.accessToken)).expect(200);
      const detail = await h.api().get(`/api/v1/bookings/${p.booking.id}`).set(bearer(p.customer.accessToken)).expect(200);
      expect(detail.body.status).toBe('PAYMENT_PENDING');
      expect(await ledger(p.booking.id)).toHaveLength(0);
    });
  });

  // ------------------------------------------------------------ duplicates

  describe('duplicates and concurrency', () => {
    it('applies the same event delivered 20 times at once exactly once', async () => {
      const p = await payable();
      const payload = succeeded(p.providerPaymentId);
      const results = await Promise.all(Array.from({ length: 20 }, () => h.sendWebhook(payload)));
      expect(results.every((r) => r.status === 200)).toBe(true);
      const outcomes = results.map((r) => r.body.result as string);
      expect(outcomes.filter((o) => o === 'processed')).toHaveLength(1);
      expect(outcomes.filter((o) => o !== 'processed').every((o) => ['duplicate', 'in_progress'].includes(o))).toBe(true);

      expect(await inbox(payload.id)).toHaveLength(1);
      expect(await confirmations(p.booking.id)).toBe(1);
      expect(await ledger(p.booking.id)).toHaveLength(1);
      expect((await booking(p.booking.id)).status).toBe('CONFIRMED');
      expect((await inbox(payload.id))[0]).toMatchObject({ status: 'PROCESSED', outcome: 'APPLIED' });
      // and a later redelivery is a quiet no-op
      expect((await h.sendWebhook(payload).expect(200)).body.result).toBe('duplicate');
      expect(await confirmations(p.booking.id)).toBe(1);
    });

    it('applies different events for the same payment once (the provider resent it under a new id)', async () => {
      const p = await payable();
      const results = await Promise.all(Array.from({ length: 10 }, () => h.sendWebhook(succeeded(p.providerPaymentId))));
      expect(results.every((r) => r.status === 200)).toBe(true);
      expect(results.filter((r) => r.body.result === 'processed')).toHaveLength(1);
      expect(results.filter((r) => r.body.result === 'ignored')).toHaveLength(9);
      expect(await confirmations(p.booking.id)).toBe(1);
      const entries = await ledger(p.booking.id);
      expect(entries).toHaveLength(1);
      const events = await h.prisma.paymentWebhookEvent.findMany({ where: { paymentAttemptId: p.dto.id } });
      expect(events.filter((e) => e.outcome === 'APPLIED')).toHaveLength(1);
      expect(events.filter((e) => e.outcome === 'DUPLICATE_EVENT')).toHaveLength(9);
    });

    it('records a second payment for an already-paid booking as captured-but-unapplied, never as a second confirmation', async () => {
      const base = await h.acceptedBooking(20000);
      const first = await h.startedPayment(base.customer, base.booking.id);
      await h.api().post(`/api/v1/payments/${first.dto.id}/cancel`).set(bearer(base.customer.accessToken)).expect(200);
      const second = await h.startedPayment(base.customer, base.booking.id);

      // the customer paid on both checkouts; the provider reports both at the same moment
      const [a, b] = await Promise.all([
        h.sendWebhook(succeeded(first.providerPaymentId)),
        h.sendWebhook(succeeded(second.providerPaymentId)),
      ]);
      expect([a.status, b.status]).toEqual([200, 200]);

      const rows = await Promise.all([attempt(first.dto.id), attempt(second.dto.id)]);
      expect(rows.map((r) => r.status).sort()).toEqual(['CAPTURED_UNAPPLIED', 'SUCCEEDED']);
      expect(rows.find((r) => r.status === 'CAPTURED_UNAPPLIED')?.reconciliationReason).toBe('DUPLICATE_PAYMENT');
      expect(await confirmations(base.booking.id)).toBe(1);
      const entries = await ledger(base.booking.id);
      expect(entries.map((e) => e.entryType).sort()).toEqual(['PAYMENT_CAPTURED', 'PAYMENT_CAPTURED_UNAPPLIED']);
      expect(entries.every((e) => e.amountHalalas === 23000)).toBe(true);
      // nothing was refunded automatically
      expect(await h.prisma.paymentRefund.count({ where: { bookingId: base.booking.id } })).toBe(0);
    });
  });

  // ----------------------------------------------------- races with the booking

  describe('payment racing booking cancellation', () => {
    it('always leaves a consistent, traceable outcome', async () => {
      for (let round = 0; round < 6; round++) {
        const p = await payable();
        const [pay, cancel] = await Promise.all([
          h.sendWebhook(succeeded(p.providerPaymentId)),
          h.api().post(`/api/v1/bookings/${p.booking.id}/cancel`).set(bearer(p.customer.accessToken)).send({ reason: 'CHANGED_MIND' }),
        ]);
        expect(pay.status).toBe(200);
        expect(cancel.status).toBe(200);

        const a = await attempt(p.dto.id);
        const b = await booking(p.booking.id);
        const entries = await ledger(p.booking.id);
        // The money is ALWAYS recorded exactly once, and never silently dropped.
        expect(entries).toHaveLength(1);
        expect(entries[0].amountHalalas).toBe(23000);
        expect(['SUCCEEDED', 'CAPTURED_UNAPPLIED']).toContain(a.status);

        if (a.status === 'SUCCEEDED') {
          // paid first; the cancel came after and records that the booking was CONFIRMED (refund candidate)
          expect(b.confirmedAt).not.toBeNull();
          expect(entries[0].entryType).toBe('PAYMENT_CAPTURED');
          const cancellation = await h.prisma.bookingCancellation.findUniqueOrThrow({ where: { bookingId: p.booking.id } });
          expect(cancellation.previousStatus).toBe('CONFIRMED');
        } else {
          // cancelled first; the payment is held for reconciliation and the booking is NOT marked paid
          expect(a.reconciliationReason).toBe('BOOKING_NOT_PAYABLE');
          expect(b.confirmedAt).toBeNull();
          expect(b.status).toBe('CANCELLED');
          expect(entries[0].entryType).toBe('PAYMENT_CAPTURED_UNAPPLIED');
          expect(await confirmations(p.booking.id)).toBe(0);
        }
        // paid <=> confirmed
        expect(a.status === 'SUCCEEDED').toBe(b.confirmedAt !== null);
      }
    });

    it('holds a late payment for a booking that was cancelled, without paying it or refunding it automatically', async () => {
      const p = await payable();
      await h.api().post(`/api/v1/bookings/${p.booking.id}/cancel`).set(bearer(p.customer.accessToken)).send({ reason: 'CHANGED_MIND' }).expect(200);
      const payload = succeeded(p.providerPaymentId);
      expect((await h.sendWebhook(payload).expect(200)).body.result).toBe('processed');

      expect(await booking(p.booking.id)).toMatchObject({ status: 'CANCELLED', confirmedAt: null });
      expect(await attempt(p.dto.id)).toMatchObject({ status: 'CAPTURED_UNAPPLIED', capturedAmountHalalas: 23000, reconciliationReason: 'BOOKING_NOT_PAYABLE' });
      expect((await ledger(p.booking.id)).map((e) => e.entryType)).toEqual(['PAYMENT_CAPTURED_UNAPPLIED']);
      expect((await inbox(payload.id))[0].outcome).toBe('CAPTURED_UNAPPLIED:BOOKING_NOT_PAYABLE');
      expect(await confirmations(p.booking.id)).toBe(0);
      expect(await h.prisma.paymentRefund.count({ where: { bookingId: p.booking.id } })).toBe(0);
      // visible to reconciliation
      const report = await h.api().get('/api/v1/admin/payments/reconciliation').set(bearer(h.adminToken)).expect(200);
      expect(report.body.capturedUnapplied.map((x: any) => x.id)).toContain(p.dto.id);
    });
  });

  // ------------------------------------------------------- amounts and currency

  describe('amount and currency verification', () => {
    it.each([
      ['less than agreed', { amount: 20000 }, 'AMOUNT_MISMATCH', 20000],
      ['more than agreed', { amount: 25000 }, 'AMOUNT_MISMATCH', 25000],
      ['another currency', { currency: 'USD' }, 'CURRENCY_MISMATCH', 23000],
    ])('does not confirm the booking when the captured amount is %s', async (_label, override, reason, capturedAmount) => {
      const p = await payable();
      const payload = succeeded(p.providerPaymentId, override);
      expect((await h.sendWebhook(payload).expect(200)).body.result).toBe('processed');
      expect(await booking(p.booking.id)).toMatchObject({ status: 'PAYMENT_PENDING', confirmedAt: null });
      expect(await attempt(p.dto.id)).toMatchObject({ status: 'CAPTURED_UNAPPLIED', reconciliationReason: reason, capturedAmountHalalas: capturedAmount });
      const [entry] = await ledger(p.booking.id);
      expect(entry).toMatchObject({ entryType: 'PAYMENT_CAPTURED_UNAPPLIED', amountHalalas: capturedAmount });
      expect(await confirmations(p.booking.id)).toBe(0);
      // the correct amount can never be added to a captured attempt afterwards
      expect((await h.sendWebhook(succeeded(p.providerPaymentId)).expect(200)).body.result).toBe('ignored');
      expect((await attempt(p.dto.id)).capturedAmountHalalas).toBe(capturedAmount);
    });

    it('refuses to record a capture that carries no usable amount, leaving a retryable failed event and no side effects', async () => {
      const p = await payable();
      const payload = succeeded(p.providerPaymentId, { amount: null });
      const res = await h.sendWebhook(payload);
      expect(res.status).toBe(503);
      expect(res.body.code).toBe('PAYMENT_EVENT_FAILED');
      expect(JSON.stringify(res.body)).not.toMatch(/amount|prisma|stack/i);
      expect(await booking(p.booking.id)).toMatchObject({ status: 'PAYMENT_PENDING' });
      expect(await attempt(p.dto.id)).toMatchObject({ status: 'PROCESSING' });
      expect(await ledger(p.booking.id)).toHaveLength(0);
      const [row] = await inbox(payload.id);
      expect(row).toMatchObject({ status: 'FAILED', attempts: 1 });
      expect(row.lastError).toBe('Error'); // a short class name, never provider text
    });
  });

  // ------------------------------------------------------ ordering and unknowns

  describe('out-of-order and repeated events', () => {
    it('never lets a later failure undo a capture, and ignores repeated failures', async () => {
      const p = await payable();
      await h.sendWebhook(succeeded(p.providerPaymentId)).expect(200);
      const late = { id: evt(), type: 'payment.failed', paymentId: p.providerPaymentId, failureCode: 'LATE' };
      const res = await h.sendWebhook(late).expect(200);
      expect(res.body.result).toBe('ignored');
      expect((await inbox(late.id))[0].outcome).toBe('STALE_EVENT');
      expect(await attempt(p.dto.id)).toMatchObject({ status: 'SUCCEEDED', failureCode: null });
      expect((await booking(p.booking.id)).status).toBe('CONFIRMED');
    });

    it('records a capture that arrives AFTER a failure/expiry/cancel event for the same attempt', async () => {
      for (const type of ['payment.failed', 'payment.expired', 'payment.cancelled']) {
        const p = await payable();
        await h.sendWebhook({ id: evt(), type, paymentId: p.providerPaymentId }).expect(200);
        expect((await attempt(p.dto.id)).openSlot).toBeNull();
        await h.sendWebhook(succeeded(p.providerPaymentId)).expect(200);
        // the money really moved, the booking is still payable, so it is applied
        expect(await attempt(p.dto.id)).toMatchObject({ status: 'SUCCEEDED' });
        expect((await booking(p.booking.id)).status).toBe('CONFIRMED');
        expect(await ledger(p.booking.id)).toHaveLength(1);
      }
    });

    it('ignores an older failure that is delivered after a newer applied failure, and repeated terminal events', async () => {
      const p = await payable();
      const t0 = Date.now();
      await h.sendWebhook({ id: evt(), type: 'payment.expired', paymentId: p.providerPaymentId, occurredAt: new Date(t0).toISOString() }).expect(200);
      expect((await attempt(p.dto.id)).status).toBe('EXPIRED');
      const failed = { id: evt(), type: 'payment.failed', paymentId: p.providerPaymentId, occurredAt: new Date(t0 - 60_000).toISOString() };
      expect((await h.sendWebhook(failed).expect(200)).body.result).toBe('ignored');
      expect((await attempt(p.dto.id)).status).toBe('EXPIRED'); // terminal outcomes are not rewritten by other failures
      const again = { id: evt(), type: 'payment.expired', paymentId: p.providerPaymentId };
      await h.sendWebhook(again).expect(200);
      expect((await inbox(again.id))[0].outcome).toBe('DUPLICATE_EVENT');
    });

    it('ignores unsupported event types safely', async () => {
      const p = await payable();
      const payload = { id: evt(), type: 'payment.something_new', paymentId: p.providerPaymentId };
      expect((await h.sendWebhook(payload).expect(200)).body.result).toBe('ignored');
      expect((await inbox(payload.id))[0]).toMatchObject({ status: 'IGNORED', outcome: 'UNSUPPORTED_EVENT' });
      expect((await attempt(p.dto.id)).status).toBe('PROCESSING');
    });

    it('never lets a simulated event touch a real payment', async () => {
      const p = await payable();
      const result = await h.app.get(PaymentEventsService).handleVerified(
        'testgw',
        { providerEventId: evt(), accountScope: 'itest-sim', kind: 'PAYMENT_SUCCEEDED', providerPaymentId: p.providerPaymentId, amountHalalas: 23000, currency: 'SAR', occurredAt: new Date(), isSimulated: true },
        null,
      );
      expect(result).toBe('ignored');
      expect(await booking(p.booking.id)).toMatchObject({ status: 'PAYMENT_PENDING', confirmedAt: null });
      expect(await attempt(p.dto.id)).toMatchObject({ status: 'PROCESSING' });
      expect(await ledger(p.booking.id)).toHaveLength(0);
    });
  });

  describe('unknown payment references', () => {
    it('records the event, confirms nothing and lists it for reconciliation', async () => {
      const base = await h.acceptedBooking(); // a booking exists and is payable, but this payment id is not ours
      const payload = succeeded('tg_does_not_exist');
      expect((await h.sendWebhook(payload).expect(200)).body.result).toBe('ignored');
      expect((await inbox(payload.id))[0]).toMatchObject({ status: 'IGNORED', outcome: 'ORPHAN_UNKNOWN_PAYMENT', paymentAttemptId: null, amountHalalas: 23000, currency: 'SAR' });
      expect(await booking(base.booking.id)).toMatchObject({ status: 'PAYMENT_PENDING', confirmedAt: null });
      expect(await h.prisma.ledgerEntry.count({ where: { sourceId: (await inbox(payload.id))[0].id } })).toBe(0);
      const report = await h.api().get('/api/v1/admin/payments/reconciliation').set(bearer(h.adminToken)).expect(200);
      expect(report.body.orphanWebhookEvents.map((e: any) => e.providerEventId)).toContain(payload.id);
    });

    it('applies an early event once the payment reference becomes known (delivery that overtook our own commit)', async () => {
      const base = await h.acceptedBooking(20000);
      const started = await h.startedPayment(base.customer, base.booking.id);
      const payload = succeeded('tg_early_reference', {});
      await h.sendWebhook(payload).expect(200);
      expect((await inbox(payload.id))[0].outcome).toBe('ORPHAN_UNKNOWN_PAYMENT');
      // our database learns the reference (the initiation commit lands)
      await h.prisma.paymentAttempt.update({ where: { id: started.dto.id }, data: { providerPaymentId: 'tg_early_reference' } });

      const sweep = await h.app.get(PaymentsMaintenanceService).run();
      expect(sweep.reprocessedOrphans).toBeGreaterThanOrEqual(1);
      expect((await inbox(payload.id))[0]).toMatchObject({ status: 'PROCESSED', outcome: 'APPLIED', paymentAttemptId: started.dto.id });
      expect((await booking(base.booking.id)).status).toBe('CONFIRMED');
      expect(await ledger(base.booking.id)).toHaveLength(1);
      // running again changes nothing
      await h.app.get(PaymentsMaintenanceService).run();
      expect(await confirmations(base.booking.id)).toBe(1);
    });
  });

  // ----------------------------------------------------- atomicity and retries

  describe('atomicity and safe retries', () => {
    it('rolls EVERYTHING back when a later step fails, then completes cleanly on retry', async () => {
      const p = await payable();
      const payload = succeeded(p.providerPaymentId);
      const spy = jest.spyOn(h.app.get(LedgerService), 'post').mockRejectedValueOnce(new Error('ledger unavailable: password=hunter2'));

      const res = await h.sendWebhook(payload);
      expect(res.status).toBe(503);
      expect(res.body.code).toBe('PAYMENT_EVENT_FAILED');
      expect(JSON.stringify(res.body)).not.toContain('hunter2');
      spy.mockRestore();

      // nothing partial: the booking confirmation happened inside the same transaction and was rolled back
      expect(await booking(p.booking.id)).toMatchObject({ status: 'PAYMENT_PENDING', confirmedAt: null });
      expect(await attempt(p.dto.id)).toMatchObject({ status: 'PROCESSING', capturedAmountHalalas: null, openSlot: true });
      expect(await confirmations(p.booking.id)).toBe(0);
      expect(await ledger(p.booking.id)).toHaveLength(0);
      const [failed] = await inbox(payload.id);
      expect(failed).toMatchObject({ status: 'FAILED', attempts: 1, processedAt: null });
      expect(failed.lastError).toBe('Error');
      expect(JSON.stringify(failed)).not.toContain('hunter2');

      // the provider redelivers: the same event is claimed again and now succeeds
      expect((await h.sendWebhook(payload).expect(200)).body.result).toBe('processed');
      expect((await inbox(payload.id))[0]).toMatchObject({ status: 'PROCESSED', outcome: 'APPLIED', attempts: 2 });
      expect(await confirmations(p.booking.id)).toBe(1);
      expect(await ledger(p.booking.id)).toHaveLength(1);
    });

    it('lets an administrator retry a failed event, exactly once in effect', async () => {
      const p = await payable();
      const payload = succeeded(p.providerPaymentId);
      const spy = jest.spyOn(h.app.get(LedgerService), 'post').mockRejectedValueOnce(new Error('boom'));
      await h.sendWebhook(payload).expect(503);
      spy.mockRestore();
      const [failed] = await inbox(payload.id);

      const customer = await h.makeCustomer();
      await h.api().post(`/api/v1/admin/payments/webhook-events/${failed.id}/retry`).set(bearer(customer.accessToken)).expect(403);
      await h.api().post(`/api/v1/admin/payments/webhook-events/${failed.id}/retry`).expect(401);

      const retried = await h.api().post(`/api/v1/admin/payments/webhook-events/${failed.id}/retry`).set(bearer(h.adminToken)).expect(200);
      expect(retried.body).toMatchObject({ status: 'PROCESSED', outcome: 'APPLIED' });
      // concurrent / repeated retries of a processed event are refused and change nothing
      await h.api().post(`/api/v1/admin/payments/webhook-events/${failed.id}/retry`).set(bearer(h.adminToken)).expect(409);
      expect(await confirmations(p.booking.id)).toBe(1);
      expect(await ledger(p.booking.id)).toHaveLength(1);
    });

    it('lets a crashed claim be taken over after the lease, and never before', async () => {
      const p = await payable();
      const payload = succeeded(p.providerPaymentId);
      // simulate a worker that claimed the event and died: PROCESSING with a fresh lease, then an old one
      await h.prisma.paymentWebhookEvent.createMany({
        data: [{ provider: 'testgw', accountScope: `itest-${'itest-pe-'}`, providerEventId: payload.id, eventType: 'PAYMENT_SUCCEEDED', providerPaymentId: p.providerPaymentId, amountHalalas: 23000, currency: 'SAR', occurredAt: new Date(), status: 'PROCESSING', processingStartedAt: new Date(), attempts: 1 }],
        skipDuplicates: true,
      });
      expect((await h.sendWebhook(payload).expect(200)).body.result).toBe('in_progress'); // lease still valid: hands off
      expect((await booking(p.booking.id)).status).toBe('PAYMENT_PENDING');

      await h.prisma.paymentWebhookEvent.updateMany({ where: { providerEventId: payload.id }, data: { processingStartedAt: new Date(Date.now() - 10 * 60_000) } });
      expect((await h.sendWebhook(payload).expect(200)).body.result).toBe('processed'); // lease expired: taken over
      expect(await confirmations(p.booking.id)).toBe(1);
    });
  });
});
