/**
 * REAL POSTGRESQL: refund requests, the append-only ledger, admin visibility and the database's own
 * protections (CHECK, UNIQUE and trigger rules). Nothing here returns money: refunds stay REQUESTED.
 */
import { LedgerService } from '../src/modules/payments/ledger.service.js';
import { type Harness, bootHarness } from './support/bookings-harness.js';

const run = process.env['TEST_DATABASE_URL'] ? describe : describe.skip;
if (!process.env['TEST_DATABASE_URL']) console.warn('payments-refunds-ledger.integration-spec: TEST_DATABASE_URL is not set, suite skipped');

run('refunds, ledger and database protections (real PostgreSQL)', () => {
  let h: Harness;
  let seq = 0;
  const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
  const evt = () => `itest-rl-${Date.now().toString(36)}-${++seq}`;

  beforeAll(async () => {
    h = await bootHarness({ phonePrefix: '+9665997', slugPrefix: 'itest-rl-', adminEmailPrefix: 'itest-rl-admin', payments: 'signed' });
    await h.seedReferenceData();
  });

  afterAll(async () => {
    if (h) await h.close();
  });

  /** A captured and applied payment of 23000 halalas (price 20000 + 15% VAT). */
  async function paid(price = 20000) {
    const base = await h.acceptedBooking(price);
    const pay = await h.startedPayment(base.customer, base.booking.id);
    await h
      .sendWebhook({ id: evt(), type: 'payment.succeeded', paymentId: pay.providerPaymentId, amount: base.quote.money.totalHalalas, currency: 'SAR' })
      .expect(200);
    return { ...base, ...pay, total: base.quote.money.totalHalalas as number };
  }

  const refund = (paymentId: string, body: object, key = h.newKey(), token = h.adminToken) =>
    h.api().post(`/api/v1/admin/payments/${paymentId}/refunds`).set(bearer(token)).set('X-Forwarded-For', h.freshIp()).set('Idempotency-Key', key).send(body);
  const payment = (id: string) => h.prisma.paymentAttempt.findUniqueOrThrow({ where: { id } });

  // ------------------------------------------------------------- authorization

  describe('authorization', () => {
    it('keeps every payment, refund, ledger and event view administrator-only', async () => {
      const p = await paid();
      const customer = p.customer;
      const id = p.dto.id;
      const calls: [string, string][] = [
        ['get', '/api/v1/admin/payments'],
        ['get', `/api/v1/admin/payments/${id}`],
        ['get', '/api/v1/admin/payments/reconciliation'],
        ['get', '/api/v1/admin/payments/webhook-events'],
        ['post', `/api/v1/admin/payments/${id}/refunds`],
        ['get', '/api/v1/admin/refunds'],
        ['get', '/api/v1/admin/ledger'],
      ];
      for (const [method, url] of calls) {
        const anon = await (h.api() as any)[method](url).send({});
        expect({ url, status: anon.status, code: anon.body.code }).toEqual({ url, status: 401, code: 'AUTH_REQUIRED' });
        for (const who of [customer, p.worker]) {
          const res = await (h.api() as any)[method](url).set(bearer(who.accessToken)).set('Idempotency-Key', h.newKey()).send({ amountHalalas: 100, reason: 'try' });
          expect({ url, status: res.status }).toEqual({ url, status: 403 });
        }
      }
      expect(await h.prisma.paymentRefund.count({ where: { paymentId: id } })).toBe(0);
    });

    it('offers no way to set a payment to succeeded or to edit the ledger over HTTP', async () => {
      const p = await paid();
      const id = p.dto.id;
      for (const [method, url] of [
        ['put', `/api/v1/admin/payments/${id}`],
        ['patch', `/api/v1/admin/payments/${id}`],
        ['delete', `/api/v1/admin/payments/${id}`],
        ['post', `/api/v1/admin/payments/${id}/succeed`],
        ['post', `/api/v1/admin/payments/${id}/mark-paid`],
        ['post', '/api/v1/admin/ledger'],
        ['put', '/api/v1/admin/ledger/1'],
        ['patch', '/api/v1/admin/ledger/1'],
        ['delete', '/api/v1/admin/ledger/1'],
      ] as const) {
        const res = await (h.api() as any)[method](url).set(bearer(h.adminToken)).send({ status: 'SUCCEEDED' });
        expect({ method, url, ok: res.status < 400 }).toEqual({ method, url, ok: false });
      }
      expect((await payment(id)).status).toBe('SUCCEEDED');
      expect(await h.prisma.ledgerEntry.count({ where: { paymentId: id } })).toBe(1);
    });
  });

  // ------------------------------------------------------------------ refunds

  describe('refund requests', () => {
    it('creates a REQUEST that returns no money, reserves the amount and posts no ledger entry', async () => {
      const p = await paid();
      const res = await refund(p.dto.id, { amountHalalas: 5000, reason: 'Customer complained about the visit' }).expect(201);
      expect(res.body).toMatchObject({ status: 'REQUESTED', moneyReturned: false, amountHalalas: 5000, currency: 'SAR', paymentId: p.dto.id, bookingId: p.booking.id });
      expect(res.body.notice).toMatch(/No money has been returned/);
      expect((await payment(p.dto.id)).refundReservedHalalas).toBe(5000);
      expect(await h.prisma.ledgerEntry.count({ where: { paymentId: p.dto.id, entryType: 'REFUND_COMPLETED' } })).toBe(0);
      expect(await h.prisma.ledgerEntry.count({ where: { paymentId: p.dto.id } })).toBe(1); // only the original capture
      expect(await h.prisma.auditLog.count({ where: { action: 'payment.refund.requested', entityId: res.body.id } })).toBe(1);
      // the booking and payment keep their paid state
      expect((await payment(p.dto.id)).status).toBe('SUCCEEDED');
      expect((await h.prisma.booking.findUniqueOrThrow({ where: { id: p.booking.id } })).status).toBe('CONFIRMED');
    });

    it('validates the request', async () => {
      const p = await paid();
      expect((await refund(p.dto.id, { amountHalalas: 100 })).status).toBe(400); // reason is required
      expect((await refund(p.dto.id, { amountHalalas: 100, reason: ' ' })).status).toBe(400);
      expect((await refund(p.dto.id, { amountHalalas: 100, reason: 'ab' })).status).toBe(400);
      for (const bad of [0, -5, 10.5, '12.5', null, 'x']) expect((await refund(p.dto.id, { amountHalalas: bad, reason: 'valid reason' })).status).toBe(400);
      expect((await refund(p.dto.id, { amountHalalas: 100, reason: 'valid reason', status: 'SUCCEEDED' })).status).toBe(400);
      expect((await refund(p.dto.id, { amountHalalas: 100, reason: 'valid reason', currency: 'USD' })).status).toBe(400);
      expect((await h.api().post(`/api/v1/admin/payments/${p.dto.id}/refunds`).set(bearer(h.adminToken)).send({ amountHalalas: 100, reason: 'valid reason' })).body.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
      expect((await refund('6f1c2f0e-6d4a-4a39-9d1e-0f6b1a9a0001', { amountHalalas: 100, reason: 'valid reason' })).status).toBe(404);
      expect(await h.prisma.paymentRefund.count({ where: { paymentId: p.dto.id } })).toBe(0);
    });

    it('only refunds money that was captured', async () => {
      const base = await h.acceptedBooking();
      const open = await h.startedPayment(base.customer, base.booking.id); // still PROCESSING
      const res = await refund(open.dto.id, { amountHalalas: 100, reason: 'nothing was paid' }).expect(409);
      expect(res.body).toMatchObject({ code: 'PAYMENT_NOT_REFUNDABLE', details: { status: 'PROCESSING' } });
      expect(await h.prisma.paymentRefund.count({ where: { paymentId: open.dto.id } })).toBe(0);
    });

    it('can refund captured money that was held for reconciliation', async () => {
      const base = await h.acceptedBooking();
      const open = await h.startedPayment(base.customer, base.booking.id);
      await h.api().post(`/api/v1/bookings/${base.booking.id}/cancel`).set(bearer(base.customer.accessToken)).send({ reason: 'CHANGED_MIND' }).expect(200);
      await h.sendWebhook({ id: evt(), type: 'payment.succeeded', paymentId: open.providerPaymentId, amount: 23000, currency: 'SAR' }).expect(200);
      expect((await payment(open.dto.id)).status).toBe('CAPTURED_UNAPPLIED');
      const res = await refund(open.dto.id, { amountHalalas: 23000, reason: 'Booking was cancelled before payment arrived' }).expect(201);
      expect(res.body.status).toBe('REQUESTED');
    });

    it('never lets requests exceed what was captured', async () => {
      const p = await paid(); // 23000
      await refund(p.dto.id, { amountHalalas: 20000, reason: 'first part' }).expect(201);
      const over = await refund(p.dto.id, { amountHalalas: 3001, reason: 'too much' }).expect(409);
      expect(over.body).toMatchObject({ code: 'REFUND_EXCEEDS_ELIGIBLE', details: { eligibleHalalas: 3000, requestedHalalas: 3001 } });
      await refund(p.dto.id, { amountHalalas: 3000, reason: 'exactly the rest' }).expect(201);
      expect((await refund(p.dto.id, { amountHalalas: 1, reason: 'one halala more' }).expect(409)).body.code).toBe('REFUND_EXCEEDS_ELIGIBLE');
      expect((await payment(p.dto.id)).refundReservedHalalas).toBe(23000);
    });

    it('keeps simultaneous requests within the captured amount', async () => {
      const p = await paid(); // 23000
      const results = await Promise.all(Array.from({ length: 8 }, () => refund(p.dto.id, { amountHalalas: 5000, reason: 'race for the money' })));
      expect(results.filter((r) => r.status === 201)).toHaveLength(4); // 4 x 5000 = 20000 <= 23000 < 25000
      expect(results.filter((r) => r.status === 409).every((r) => r.body.code === 'REFUND_EXCEEDS_ELIGIBLE')).toBe(true);
      expect(results.some((r) => r.status >= 500)).toBe(false);
      const rows = await h.prisma.paymentRefund.findMany({ where: { paymentId: p.dto.id } });
      expect(rows).toHaveLength(4);
      expect(rows.reduce((sum, r) => sum + r.amountHalalas, 0)).toBe(20000);
      expect((await payment(p.dto.id)).refundReservedHalalas).toBe(20000);

      // two requests that each fit alone but not together
      const q = await paid();
      const two = await Promise.all([refund(q.dto.id, { amountHalalas: 13000, reason: 'big one' }), refund(q.dto.id, { amountHalalas: 13000, reason: 'big two' })]);
      expect(two.map((r) => r.status).sort()).toEqual([201, 409]);
      expect((await payment(q.dto.id)).refundReservedHalalas).toBe(13000);
    });

    it('is idempotent: the same key and body returns the same refund, the same key with another body is refused', async () => {
      const p = await paid();
      const key = h.newKey();
      const first = await refund(p.dto.id, { amountHalalas: 4000, reason: 'goodwill gesture' }, key).expect(201);
      const again = await refund(p.dto.id, { amountHalalas: 4000, reason: 'goodwill gesture' }, key).expect(201);
      expect(again.body.id).toBe(first.body.id);
      expect((await refund(p.dto.id, { amountHalalas: 4001, reason: 'goodwill gesture' }, key).expect(409)).body.code).toBe('IDEMPOTENCY_CONFLICT');
      expect((await refund(p.dto.id, { amountHalalas: 4000, reason: 'different words' }, key).expect(409)).body.code).toBe('IDEMPOTENCY_CONFLICT');
      expect(await h.prisma.paymentRefund.count({ where: { paymentId: p.dto.id } })).toBe(1);
      expect((await payment(p.dto.id)).refundReservedHalalas).toBe(4000);
      expect(await h.prisma.auditLog.count({ where: { action: 'payment.refund.requested', entityId: first.body.id } })).toBe(1);

      // simultaneous duplicates of one request create one refund and reserve once
      const k2 = h.newKey();
      const dup = await Promise.all(Array.from({ length: 6 }, () => refund(p.dto.id, { amountHalalas: 2000, reason: 'double click' }, k2)));
      expect(dup.every((r) => r.status === 201)).toBe(true);
      expect(new Set(dup.map((r) => r.body.id)).size).toBe(1);
      expect((await payment(p.dto.id)).refundReservedHalalas).toBe(6000);
    });

    it('releases the reserved amount when a request is withdrawn, and refuses to withdraw one already in progress', async () => {
      const p = await paid();
      const r = (await refund(p.dto.id, { amountHalalas: 10000, reason: 'to be withdrawn' }).expect(201)).body;
      const url = `/api/v1/admin/refunds/${r.id}/cancel`;
      await h.api().post(url).set(bearer(p.customer.accessToken)).send({ reason: 'x' }).expect(403);
      await h.api().post(url).set(bearer(h.adminToken)).send({}).expect(400);
      const cancelled = await h.api().post(url).set(bearer(h.adminToken)).send({ reason: 'Raised by mistake' }).expect(200);
      expect(cancelled.body).toMatchObject({ status: 'CANCELLED', moneyReturned: false });
      expect((await payment(p.dto.id)).refundReservedHalalas).toBe(0);
      await h.api().post(url).set(bearer(h.adminToken)).send({ reason: 'again' }).expect(200); // idempotent, no double release
      expect((await payment(p.dto.id)).refundReservedHalalas).toBe(0);

      const inFlight = (await refund(p.dto.id, { amountHalalas: 1000, reason: 'handed to provider' }).expect(201)).body;
      await h.prisma.paymentRefund.update({ where: { id: inFlight.id }, data: { status: 'PROCESSING' } });
      expect((await h.api().post(`/api/v1/admin/refunds/${inFlight.id}/cancel`).set(bearer(h.adminToken)).send({ reason: 'too late' }).expect(409)).body.code).toBe('REFUND_NOT_CANCELLABLE');
      expect((await payment(p.dto.id)).refundReservedHalalas).toBe(1000);
    });

    it('lists and filters refund requests', async () => {
      const p = await paid();
      await refund(p.dto.id, { amountHalalas: 1000, reason: 'list me 1' }).expect(201);
      await refund(p.dto.id, { amountHalalas: 2000, reason: 'list me 2' }).expect(201);
      const list = await h.api().get(`/api/v1/admin/refunds?paymentId=${p.dto.id}&status=requested&limit=1`).set(bearer(h.adminToken)).expect(200);
      expect(list.body.meta).toMatchObject({ total: 2, totalPages: 2, limit: 1 });
      await h.api().get('/api/v1/admin/refunds?status=BOGUS').set(bearer(h.adminToken)).expect(400);
      const one = await h.api().get(`/api/v1/admin/refunds/${list.body.items[0].id}`).set(bearer(h.adminToken)).expect(200);
      expect(one.body.moneyReturned).toBe(false);
    });
  });

  // ------------------------------------------------------------- admin visibility

  describe('admin payment operations', () => {
    it('lists, filters and details payments with their history', async () => {
      const p = await paid();
      const sim = await h.acceptedBooking();
      await h.startPayment(sim.customer, sim.booking.id).expect(201); // stays PROCESSING

      const byBooking = await h.api().get(`/api/v1/admin/payments?bookingId=${p.booking.id}`).set(bearer(h.adminToken)).expect(200);
      expect(byBooking.body.items.map((x: any) => x.id)).toEqual([p.dto.id]);
      expect(byBooking.body.items[0]).toMatchObject({ bookingReference: p.booking.reference, status: 'SUCCEEDED', capturedAmountHalalas: 23000, needsReconciliation: false, simulated: false });
      const processing = await h.api().get('/api/v1/admin/payments?status=processing&simulated=false&limit=5').set(bearer(h.adminToken)).expect(200);
      expect(processing.body.items.every((x: any) => x.status === 'PROCESSING')).toBe(true);
      expect((await h.api().get('/api/v1/admin/payments?simulated=true').set(bearer(h.adminToken)).expect(200)).body.items.every((x: any) => x.simulated)).toBe(true);
      await h.api().get('/api/v1/admin/payments?status=BOGUS').set(bearer(h.adminToken)).expect(400);
      await h.api().get('/api/v1/admin/payments?bookingId=nope').set(bearer(h.adminToken)).expect(400);

      await refund(p.dto.id, { amountHalalas: 1000, reason: 'see it in the detail' }).expect(201);
      const detail = (await h.api().get(`/api/v1/admin/payments/${p.dto.id}`).set(bearer(h.adminToken)).expect(200)).body;
      expect(detail.booking).toMatchObject({ id: p.booking.id, status: 'CONFIRMED', totalAmountHalalas: 23000 });
      expect(detail.bookingTimeline.map((e: any) => e.type)).toEqual(expect.arrayContaining(['BOOKING_CREATED', 'QUOTE_ACCEPTED', 'PAYMENT_CONFIRMED']));
      expect(detail.webhookEvents).toHaveLength(1);
      expect(detail.webhookEvents[0]).toMatchObject({ status: 'PROCESSED', outcome: 'APPLIED' });
      expect(detail.refunds).toHaveLength(1);
      expect(detail.ledger).toHaveLength(1);
      // no secrets or raw provider payloads anywhere
      expect(JSON.stringify(detail)).not.toMatch(/secret|signature|payloadHash|requestFingerprint|idempotencyKey":"itest-key|authorization/i);

      const events = await h.api().get(`/api/v1/admin/payments/webhook-events?paymentId=${p.dto.id}&status=processed`).set(bearer(h.adminToken)).expect(200);
      expect(events.body.meta.total).toBe(1);
      const ledger = await h.api().get(`/api/v1/admin/ledger?paymentId=${p.dto.id}&entryType=PAYMENT_CAPTURED`).set(bearer(h.adminToken)).expect(200);
      expect(ledger.body.items).toHaveLength(1);
      await h.api().get('/api/v1/admin/ledger?entryType=NOPE').set(bearer(h.adminToken)).expect(400);
      await h.api().get('/api/v1/admin/payments/6f1c2f0e-6d4a-4a39-9d1e-0f6b1a9a0001').set(bearer(h.adminToken)).expect(404);
    });
  });

  // ------------------------------------------------------------------- ledger

  describe('the append-only ledger', () => {
    it('refuses UPDATE, DELETE and TRUNCATE for the application, at the database', async () => {
      const p = await paid();
      const entry = await h.prisma.ledgerEntry.findFirstOrThrow({ where: { paymentId: p.dto.id } });
      await expect(h.prisma.ledgerEntry.update({ where: { id: entry.id }, data: { amountHalalas: 1 } })).rejects.toThrow(/append-only/);
      await expect(h.prisma.ledgerEntry.update({ where: { id: entry.id }, data: { description: 'rewritten' } })).rejects.toThrow(/append-only/);
      await expect(h.prisma.ledgerEntry.delete({ where: { id: entry.id } })).rejects.toThrow(/append-only/);
      await expect(h.prisma.ledgerEntry.deleteMany({ where: { id: entry.id } })).rejects.toThrow(/append-only/);
      await expect(h.prisma.$executeRawUnsafe('TRUNCATE TABLE ledger_entries')).rejects.toThrow(/append-only/);
      await expect(h.prisma.$executeRawUnsafe(`UPDATE ledger_entries SET amount_halalas = 1 WHERE id = '${entry.id}'`)).rejects.toThrow(/append-only/);
      expect(await h.prisma.ledgerEntry.findUniqueOrThrow({ where: { id: entry.id } })).toMatchObject({ amountHalalas: 23000, description: entry.description });
    });

    it('does not post the same entry twice, and corrects mistakes with a compensating entry', async () => {
      const p = await paid();
      const ledger = h.app.get(LedgerService);
      const original = await h.prisma.ledgerEntry.findFirstOrThrow({ where: { paymentId: p.dto.id } });
      const post = (key: string, over: object = {}) =>
        h.prisma.$transaction((tx) =>
          ledger.post(tx, { entryType: 'PAYMENT_CAPTURED', amountHalalas: 23000, currency: 'SAR', bookingId: p.booking.id, paymentId: p.dto.id, idempotencyKey: key, sourceType: 'itest', description: 'dup test', isSimulated: false, ...over }),
        );
      // the capture key is already taken by the genuine event
      expect(await post(`payment:${p.dto.id}:capture`)).toBe(false);
      expect(await h.prisma.ledgerEntry.count({ where: { paymentId: p.dto.id } })).toBe(1);

      // a correction is a NEW entry that points at what it reverses
      const correction = {
        entryType: 'CORRECTION' as const,
        amountHalalas: -23000,
        reversesEntryId: original.id,
      };
      await h.prisma.$transaction((tx) =>
        tx.ledgerEntry.create({ data: { ...correction, currency: 'SAR', bookingId: p.booking.id, paymentId: p.dto.id, idempotencyKey: `itest:correct:${original.id}`, sourceType: 'itest', description: 'compensating entry', isSimulated: false } }),
      );
      const entries = await h.prisma.ledgerEntry.findMany({ where: { paymentId: p.dto.id }, orderBy: { postedAt: 'asc' } });
      expect(entries.map((e) => [e.entryType, e.amountHalalas])).toEqual([['PAYMENT_CAPTURED', 23000], ['CORRECTION', -23000]]);
      expect(entries.reduce((s, e) => s + e.amountHalalas, 0)).toBe(0);
      // an entry can be reversed only once
      await expect(
        h.prisma.ledgerEntry.create({ data: { ...correction, currency: 'SAR', idempotencyKey: `itest:correct-again:${original.id}`, sourceType: 'itest', description: 'second reversal', isSimulated: false } }),
      ).rejects.toBeDefined();
    });

    it('refuses entries that make no accounting sense', async () => {
      const p = await paid();
      const base = { currency: 'SAR', bookingId: p.booking.id, paymentId: p.dto.id, sourceType: 'itest', description: 'bad', isSimulated: false };
      const bad = (over: object) => h.prisma.ledgerEntry.create({ data: { entryType: 'PAYMENT_CAPTURED', amountHalalas: 100, idempotencyKey: `itest:bad:${Math.random()}`, ...base, ...over } as never });
      await expect(bad({ amountHalalas: 0 })).rejects.toBeDefined();
      await expect(bad({ amountHalalas: -100 })).rejects.toBeDefined(); // a capture is money IN
      await expect(bad({ entryType: 'REFUND_COMPLETED', amountHalalas: -100 })).rejects.toBeDefined(); // a refund must name its refund
      await expect(bad({ entryType: 'REFUND_COMPLETED', amountHalalas: 100, refundId: null })).rejects.toBeDefined();
      await expect(bad({ entryType: 'CORRECTION', amountHalalas: 100 })).rejects.toBeDefined(); // must reverse something
      await expect(bad({ currency: 'sar' })).rejects.toBeDefined();
      await expect(bad({ paymentId: null })).rejects.toBeDefined();
    });
  });

  // ---------------------------------------------------- other database protections

  describe('database constraints', () => {
    it('makes the agreed booking money snapshot immutable', async () => {
      const p = await paid();
      for (const data of [{ serviceAmountHalalas: 1 }, { totalAmountHalalas: 1 }, { vatAmountHalalas: 1 }, { commissionAmountHalalas: 1 }, { workerPayoutHalalas: 1 }, { vatRateBps: 1 }, { commissionRateBps: 1 }, { currency: 'USD' }]) {
        await expect(h.prisma.booking.update({ where: { id: p.booking.id }, data })).rejects.toThrow(/immutable/);
      }
      await expect(h.prisma.booking.update({ where: { id: p.booking.id }, data: { serviceAmountHalalas: null, vatAmountHalalas: null, totalAmountHalalas: null } })).rejects.toBeDefined();
      // everything else about the booking can still change
      await h.prisma.booking.update({ where: { id: p.booking.id }, data: { locationNotes: 'gate code 1234' } });
      expect(await h.prisma.booking.findUniqueOrThrow({ where: { id: p.booking.id } })).toMatchObject({ totalAmountHalalas: 23000, vatRateBps: 1500 });
    });

    it('allows only one open attempt per booking and only consistent attempt rows', async () => {
      const base = await h.acceptedBooking();
      const open = await h.startedPayment(base.customer, base.booking.id);
      const clone = {
        bookingId: base.booking.id, customerId: base.customer.userId, provider: 'testgw', amountHalalas: 23000, currency: 'SAR',
        requestFingerprint: 'a'.repeat(64),
      };
      const insert = (over: object) => h.prisma.paymentAttempt.create({ data: { ...clone, attemptNumber: 9, idempotencyKey: `itest-k-${Math.random()}`, status: 'PROCESSING', openSlot: true, ...over } as never });
      await expect(insert({ attemptNumber: 9 })).rejects.toBeDefined(); // a second open attempt
      await expect(insert({ attemptNumber: open.row.attemptNumber, status: 'FAILED', openSlot: null })).rejects.toBeDefined(); // duplicate attempt number
      await expect(insert({ status: 'FAILED', openSlot: true })).rejects.toBeDefined(); // open slot must mirror the status
      await expect(insert({ status: 'PROCESSING', openSlot: null })).rejects.toBeDefined();
      await expect(insert({ status: 'FAILED', openSlot: null, amountHalalas: 0 })).rejects.toBeDefined();
      await expect(insert({ status: 'FAILED', openSlot: null, currency: 'sar' })).rejects.toBeDefined();
      await expect(insert({ status: 'SUCCEEDED', openSlot: null })).rejects.toBeDefined(); // success must say what was captured
      await expect(insert({ status: 'SUCCEEDED', openSlot: null, capturedAmountHalalas: 1, capturedCurrency: 'SAR' })).rejects.toBeDefined(); // ...and it must equal the agreed amount
      await expect(h.prisma.paymentAttempt.update({ where: { id: open.dto.id }, data: { refundReservedHalalas: 1 } })).rejects.toBeDefined(); // nothing captured to refund
      expect(await h.prisma.paymentAttempt.count({ where: { bookingId: base.booking.id } })).toBe(1);
    });

    it('caps refund reservations at the captured amount even if the application check were bypassed', async () => {
      const p = await paid();
      await expect(h.prisma.paymentAttempt.update({ where: { id: p.dto.id }, data: { refundReservedHalalas: 23001 } })).rejects.toBeDefined();
      await expect(h.prisma.paymentAttempt.update({ where: { id: p.dto.id }, data: { refundReservedHalalas: -1 } })).rejects.toBeDefined();
      await h.prisma.paymentAttempt.update({ where: { id: p.dto.id }, data: { refundReservedHalalas: 23000 } });
      await expect(h.prisma.paymentAttempt.update({ where: { id: p.dto.id }, data: { refundReservedHalalas: { increment: 1 } } })).rejects.toBeDefined();
    });

    it('stores each provider event once and keeps terminal events dated', async () => {
      const dupe = { provider: 'testgw', accountScope: 'itest-x', providerEventId: evt(), eventType: 'PAYMENT_SUCCEEDED' };
      await h.prisma.paymentWebhookEvent.create({ data: dupe });
      await expect(h.prisma.paymentWebhookEvent.create({ data: dupe })).rejects.toBeDefined();
      await expect(h.prisma.paymentWebhookEvent.create({ data: { ...dupe, providerEventId: evt(), status: 'PROCESSED' } })).rejects.toBeDefined(); // processed needs processed_at
      await expect(h.prisma.paymentWebhookEvent.create({ data: { ...dupe, providerEventId: evt(), amountHalalas: 0 } })).rejects.toBeDefined();
      await expect(h.prisma.paymentRefund.create({ data: { paymentId: '6f1c2f0e-6d4a-4a39-9d1e-0f6b1a9a0001', bookingId: '6f1c2f0e-6d4a-4a39-9d1e-0f6b1a9a0001', amountHalalas: 1, currency: 'SAR', reason: 'x', requestedById: '6f1c2f0e-6d4a-4a39-9d1e-0f6b1a9a0001', idempotencyKey: 'x'.repeat(10), requestFingerprint: 'a'.repeat(64) } })).rejects.toBeDefined();
    });

    it('does not allow deleting a booking or customer that has payments', async () => {
      const p = await paid();
      await expect(h.prisma.booking.delete({ where: { id: p.booking.id } })).rejects.toBeDefined();
      await expect(h.prisma.user.delete({ where: { id: p.customer.userId } })).rejects.toBeDefined();
      await expect(h.prisma.paymentAttempt.delete({ where: { id: p.dto.id } })).rejects.toBeDefined(); // the ledger points at it
    });
  });
});
