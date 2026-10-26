/**
 * REAL POSTGRESQL: administrator reports. Date-range semantics (inclusive start, exclusive end, Riyadh day buckets),
 * pagination/limits, per-currency money, and above all the MEANING of the financial numbers: a pending attempt is not
 * funds, a requested refund is not a refund, a ledger total is not a balance.
 */
import { randomUUID } from 'node:crypto';
import { type Harness, bootHarness } from './support/bookings-harness.js';

const run = process.env['TEST_DATABASE_URL'] ? describe : describe.skip;
if (!process.env['TEST_DATABASE_URL']) console.warn('reports.integration-spec: TEST_DATABASE_URL is not set, suite skipped');

// A closed historical window nothing else in the database touches, so counts are exact.
const FROM = '2020-03-10T00:00:00.000Z';
const TO = '2020-03-12T00:00:00.000Z';
const W = `from=${FROM}&to=${TO}`;
const at = (iso: string) => new Date(iso);

type Row = Record<string, unknown>;
const sum = (rows: Row[], pick: (r: Row) => boolean, field: string) => rows.filter(pick).reduce((a, r) => a + Number(r[field] ?? 0), 0);
const count = (rows: Row[], pick: (r: Row) => boolean) => rows.filter(pick).reduce((a, r) => a + Number(r['count'] ?? 0), 0);

run('reports (real PostgreSQL)', () => {
  let h: Harness;
  let ref: Awaited<ReturnType<Harness['seedReferenceData']>>;
  const admin = { accessToken: '' };
  const get = (path: string, who: { accessToken: string } = admin) => h.api().get(`/api/v1/admin/reports/${path}`).set(h.bearer(who.accessToken)).set('X-Forwarded-For', h.freshIp());

  beforeAll(async () => {
    h = await bootHarness({ phonePrefix: '+9665987', slugPrefix: 'itest-rp-', adminEmailPrefix: 'itest-rp-admin', realtime: { listen: true } });
    ref = await h.seedReferenceData();
    admin.accessToken = h.adminToken;
  });

  afterAll(async () => {
    if (h) await h.close();
  });

  describe('time handling', () => {
    it('stores application timestamps exactly, whatever time zone the database server runs in', async () => {
      // Regression: with a server zone other than UTC (this project's Windows cluster follows the machine) the adapter's zone-less UTC text
      // was read as local time and every application-written timestamp was shifted by the server's offset.
      const [{ tz }] = await h.prisma.$queryRaw<{ tz: string }[]>`SELECT current_setting('TimeZone') AS tz`;
      expect(tz).toBe('UTC');
      const instant = new Date('2020-03-10T00:00:00.000Z');
      const [{ same }] = await h.prisma.$queryRaw<{ same: boolean }[]>`SELECT (${instant}::timestamptz = '2020-03-10T00:00:00Z'::timestamptz) AS same`;
      expect(same).toBe(true);
      const city = await h.prisma.city.findFirstOrThrow({ where: { slug: { startsWith: 'itest-rp-' } } });
      await h.prisma.city.update({ where: { id: city.id }, data: { updatedAt: instant } });
      expect((await h.prisma.city.findUniqueOrThrow({ where: { id: city.id } })).updatedAt.toISOString()).toBe('2020-03-10T00:00:00.000Z');
      const [{ raw }] = await h.prisma.$queryRaw<{ raw: string }[]>`SELECT (updated_at AT TIME ZONE 'UTC')::text AS raw FROM cities WHERE id = ${city.id}::uuid`;
      expect(raw.startsWith('2020-03-10 00:00:00')).toBe(true);
    });
  });

  describe('ranges', () => {
    it('validates the range and applies the defaults', async () => {
      for (const q of ['from=2020-03-12T00:00:00Z&to=2020-03-10T00:00:00Z', `from=${FROM}&to=${FROM}`, 'from=nope', 'to=nope', 'from=2019-01-01T00:00:00Z&to=2020-03-10T00:00:00Z']) {
        const res = await get(`bookings?${q}`);
        expect({ q, status: res.status }).toEqual({ q, status: 400 });
      }
      expect((await get('bookings?from=2019-03-10T00:00:00Z&to=2020-03-10T00:00:00Z')).body.code ?? 'ok').toBe('ok'); // 366 days exactly is allowed (2020 is a leap year)
      const def = (await get('bookings').expect(200)).body.range;
      expect(new Date(def.to).getTime() - new Date(def.from).getTime()).toBe(30 * 86_400_000);
      expect(def).toMatchObject({ fromInclusive: true, toExclusive: true, timezoneForBuckets: 'Asia/Riyadh' });
      expect((await get('bookings?top=0')).status).toBe(400);
      expect((await get('bookings?top=101')).status).toBe(400);
      expect((await get('bookings/trend?interval=hour')).status).toBe(400);
      expect((await get('payments?includeSimulated=maybe')).status).toBe(400);
    });
  });

  describe('bookings, quotes, reviews and disputes in a closed window', () => {
    let a: Awaited<ReturnType<Harness['confirmedBooking']>>;
    let b: Awaited<ReturnType<Harness['confirmedBooking']>>;
    let c: Awaited<ReturnType<Harness['confirmedBooking']>>;
    let d: Awaited<ReturnType<Harness['acceptedBooking']>>;
    let e: Awaited<ReturnType<Harness['confirmedBooking']>>;

    beforeAll(async () => {
      [a, b, c, e] = await Promise.all([h.confirmedBooking(), h.confirmedBooking(), h.confirmedBooking(), h.confirmedBooking()]);
      d = await h.acceptedBooking();
      await h.startWork(b.worker, b.booking.id).expect(200);
      await h.completeWork(b.worker, b.booking.id).expect(200);
      await h.startWork(e.worker, e.booking.id).expect(200);
      await h.completeWork(e.worker, e.booking.id).expect(200);
      await h.cancelBooking(c.customer, c.booking.id).expect(200);

      // Move everything into the closed window. Boundary cases: exactly `from` (in), exactly `to` (out), and the two sides of
      // Riyadh midnight (20:59:59Z / 21:00:00Z on 11 March).
      const move = (id: string, createdAt: string, extra: object = {}) => h.prisma.booking.update({ where: { id }, data: { createdAt: at(createdAt), ...extra } });
      await move(a.booking.id, FROM, { acceptedAt: at('2020-03-10T01:00:00Z') });
      await move(b.booking.id, '2020-03-11T20:59:59.000Z', { acceptedAt: at('2020-03-11T08:00:00Z'), completedAt: at('2020-03-11T10:00:00Z') });
      await move(c.booking.id, '2020-03-11T21:00:00.000Z', { acceptedAt: at('2020-03-11T22:00:00Z'), cancelledAt: at('2020-03-11T12:00:00Z') });
      await move(d.booking.id, TO, { acceptedAt: at(TO) });
      await move(e.booking.id, '2020-03-10T12:00:00.000Z', { acceptedAt: at('2020-03-10T12:30:00Z'), completedAt: at('2020-03-11T22:30:00Z') }); // completes on the 12th in Riyadh
      await h.prisma.bookingCancellation.updateMany({ where: { bookingId: c.booking.id }, data: { cancelledAt: at('2020-03-11T12:00:00Z') } });
      for (const [id, iso] of [[a.booking.id, '2020-03-10T02:00:00Z'], [b.booking.id, '2020-03-11T05:00:00Z'], [c.booking.id, '2020-03-11T06:00:00Z'], [e.booking.id, '2020-03-10T13:00:00Z'], [d.booking.id, TO]] as const) {
        await h.prisma.quote.updateMany({ where: { bookingId: id }, data: { createdAt: at(iso) } });
      }
    });

    it('counts bookings created in the range by current status, service and city; the end is exclusive', async () => {
      const r = (await get(`bookings?${W}`).expect(200)).body;
      expect(r.createdByCurrentStatus).toEqual(expect.arrayContaining([{ status: 'CONFIRMED', count: 1 }, { status: 'COMPLETED', count: 2 }, { status: 'CANCELLED', count: 1 }]));
      expect(count(r.createdByCurrentStatus, () => true)).toBe(4); // d was created exactly at `to`: excluded
      expect(r.createdByCurrentStatus.find((x: Row) => x['status'] === 'PAYMENT_PENDING')).toBeUndefined();
      expect(r.createdByService).toEqual([expect.objectContaining({ serviceId: ref.service.id, nameEn: 'Wiring', count: 4 })]);
      expect(r.createdByCity).toEqual([expect.objectContaining({ cityId: ref.city.id, count: 4 })]);
      expect(r.cancellations.total).toBe(1);
      expect(r.cancellations.byReasonAndActor).toEqual([{ reason: 'CHANGED_MIND', cancelledByRole: 'CUSTOMER', count: 1 }]);
      expect(r.definitions.createdByCurrentStatus).toMatch(/CREATED in the range/);

      const justA = (await get(`bookings?from=${FROM}&to=2020-03-10T00:00:00.001Z`).expect(200)).body; // `from` is inclusive
      expect(count(justA.createdByCurrentStatus, () => true)).toBe(1);
      const none = (await get(`bookings?from=2020-03-09T00:00:00Z&to=${FROM}`).expect(200)).body; // `to` is exclusive
      expect(count(none.createdByCurrentStatus, () => true)).toBe(0);
      expect((await get(`bookings?${W}&top=1`).expect(200)).body.createdByService).toHaveLength(1);
    });

    it('buckets the trend by Riyadh calendar day, on both sides of midnight', async () => {
      const t = (await get(`bookings/trend?${W}&interval=day`).expect(200)).body;
      expect(t.buckets).toEqual([
        { bucketStart: '2020-03-10', created: 2, completed: 0, cancelled: 0 }, // a (00:00Z = 03:00 Riyadh) and e
        { bucketStart: '2020-03-11', created: 1, completed: 1, cancelled: 1 }, // b at 23:59:59 Riyadh; b completed; c cancelled
        { bucketStart: '2020-03-12', created: 1, completed: 1, cancelled: 0 }, // c created at 00:00:00 Riyadh; e completed at 01:30 Riyadh
      ]);
      const weekly = (await get(`bookings/trend?${W}&interval=week`).expect(200)).body.buckets;
      expect(weekly.reduce((a: number, x: Row) => a + Number(x['created']), 0)).toBe(4);
      const monthly = (await get(`bookings/trend?${W}&interval=month`).expect(200)).body.buckets;
      expect(monthly).toEqual([{ bucketStart: '2020-03-01', created: 4, completed: 2, cancelled: 1 }]);
    });

    it('counts quotes submitted and accepted in the range', async () => {
      const q = (await get(`quotes?${W}`).expect(200)).body;
      expect(q.submitted).toBe(4); // a, b, c, e (d's quote is at `to`)
      expect(q.submittedByCurrentStatus).toEqual([{ status: 'ACCEPTED', count: 4 }]);
      expect(q.acceptedInRange).toBe(4); // by acceptance time: a, b, c, e (d accepted at `to`)
      expect(q.definitions.acceptedInRange).toMatch(/Not a ratio/);
    });

    it('reports review counts, the published rating distribution and the average, excluding hidden reviews', async () => {
      const rb = (await h.api().post(`/api/v1/bookings/${b.booking.id}/review`).set(h.bearer(b.customer.accessToken)).send({ rating: 4 }).expect(201)).body;
      const re = (await h.api().post(`/api/v1/bookings/${e.booking.id}/review`).set(h.bearer(e.customer.accessToken)).send({ rating: 1 }).expect(201)).body;
      await h.api().post(`/api/v1/admin/reviews/${re.id}/hide`).set(h.bearer(admin.accessToken)).send({ reason: 'Abusive text.' }).expect(200);
      await h.prisma.review.updateMany({ where: { id: { in: [rb.id, re.id] } }, data: { createdAt: at('2020-03-11T09:00:00Z') } });

      const r = (await get(`reviews?${W}`).expect(200)).body;
      expect(r.byCurrentStatus).toEqual(expect.arrayContaining([{ status: 'PUBLISHED', count: 1 }, { status: 'HIDDEN', count: 1 }]));
      expect(r.published).toEqual({ count: 1, average: 4, distribution: { 1: 0, 2: 0, 3: 0, 4: 1, 5: 0 } });
      expect(r.definitions.published).toMatch(/excluded/);
    });

    it('reports disputes by status and category and counts flagged money follow-ups as flags only', async () => {
      const open = (booking: typeof a, category: string) => h.api().post('/api/v1/disputes').set(h.bearer(booking.customer.accessToken)).set('X-Forwarded-For', h.freshIp()).send({ bookingId: booking.booking.id, category, description: 'Details of what went wrong are here.' }).expect(201);
      const d1 = (await open(a, 'NO_SHOW')).body;
      const d2 = (await open(c, 'PAYMENT')).body;
      await h.api().post(`/api/v1/admin/disputes/${d1.id}/start-review`).set(h.bearer(admin.accessToken)).send({}).expect(200);
      await h.api().post(`/api/v1/admin/disputes/${d1.id}/resolve`).set(h.bearer(admin.accessToken)).send({ summary: 'Resolved by agreement between the parties.', financialFollowup: 'REQUESTED' }).expect(200);
      await h.prisma.dispute.updateMany({ where: { id: { in: [d1.id, d2.id] } }, data: { createdAt: at('2020-03-11T09:00:00Z') } });

      const r = (await get(`disputes?${W}`).expect(200)).body;
      expect(r.opened).toBe(2);
      expect(r.byCurrentStatus).toEqual(expect.arrayContaining([{ status: 'RESOLVED', count: 1 }, { status: 'OPEN', count: 1 }]));
      expect(r.byCategory).toEqual(expect.arrayContaining([{ category: 'NO_SHOW', count: 1 }, { category: 'PAYMENT', count: 1 }]));
      expect(r.financialFollowupRequested).toBe(1);
      expect(r.definitions.financialFollowupRequested).toMatch(/FLAG/);
      expect(r.definitions.financialFollowupRequested).toMatch(/no refund/i);
    });
  });

  describe('workers, notifications and operations', () => {
    it('reports worker counts as snapshots and registrations in the range', async () => {
      const w = await h.makeWorker([ref.service.id], [ref.city.id]);
      await h.prisma.workerProfile.update({ where: { id: w.workerId }, data: { isOnline: true } });
      const r = (await get('workers').expect(200)).body;
      expect(r.activeWorkers).toBeGreaterThanOrEqual(1);
      expect(r.onlineWorkersNow).toBeGreaterThanOrEqual(1);
      expect(r.workersByVerificationStatus).toEqual(expect.arrayContaining([expect.objectContaining({ status: 'APPROVED' })]));
      expect(r.definitions.activeWorkers).toMatch(/SNAPSHOT/);
      const old = (await get(`workers?${W}`).expect(200)).body;
      expect(old.registrationsInRange).toEqual([]); // nobody registered in 2020
      const now = (await get('workers').expect(200)).body.registrationsInRange;
      expect(count(now, (x) => x['role'] === 'WORKER')).toBeGreaterThanOrEqual(1);
      await h.prisma.workerProfile.update({ where: { id: w.workerId }, data: { verificationStatus: 'SUSPENDED' } });
      expect((await get('workers').expect(200)).body.activeWorkers).toBe(r.activeWorkers - 1);
    });

    it('reports notification outcomes without claiming delivery', async () => {
      await h.confirmedBooking();
      const r = (await get('notifications').expect(200)).body;
      expect(r.inApp.created).toBeGreaterThanOrEqual(0);
      expect(r.definitions.externalDeliveries).toMatch(/NOT proof it reached a device/);
      expect(r.externalDeliveries.every((x: Row) => x['status'] !== 'DELIVERED')).toBe(true);
    });

    it('reports items needing attention', async () => {
      const before = (await get('operations').expect(200)).body;
      const p = await h.confirmedBooking();
      const row = await h.prisma.realtimeOutboxEvent.findFirstOrThrow({ where: { bookingId: p.booking.id, dispatchedAt: null } });
      await h.prisma.realtimeOutboxEvent.update({ where: { id: row.id }, data: { deadAt: new Date() } });
      await h.prisma.storageDeletion.create({ data: { storageKey: `bookings/${randomUUID()}/photos/${randomUUID()}`, reason: 'itest', deadAt: new Date() } });
      await h.prisma.paymentWebhookEvent.count(); // table exists
      const after = (await get('operations').expect(200)).body;
      expect(after.realtimeOutbox.dead).toBe(before.realtimeOutbox.dead + 1);
      expect(after.storageRemovals.dead).toBe(before.storageRemovals.dead + 1);
      expect(after.definitions.all).toMatch(/dead = retries exhausted/);
    });
  });

  describe('money: what each number means', () => {
    const rows = (body: Row, key: string) => body[key] as Row[];
    const snap = async () => ({ pay: (await get('payments').expect(200)).body, led: (await get('ledger').expect(200)).body });
    const at0 = (s: Awaited<ReturnType<typeof snap>>) => ({
      attempts: (status: string, field: string) => sum(rows(s.pay, 'paymentAttemptsByStatus'), (r) => r['status'] === status && r['currency'] === 'SAR', field),
      attemptCount: (status: string) => count(rows(s.pay, 'paymentAttemptsByStatus'), (r) => r['status'] === status && r['currency'] === 'SAR'),
      applied: sum(rows(s.pay, 'providerReportedCapturedAndApplied'), (r) => r['currency'] === 'SAR', 'capturedHalalas'),
      unapplied: sum(rows(s.pay, 'capturedButUnappliedAllTime'), (r) => r['currency'] === 'SAR', 'capturedHalalas'),
      unappliedCount: count(rows(s.pay, 'capturedButUnappliedAllTime'), (r) => r['currency'] === 'SAR'),
      refundCount: (status: string) => count(rows(s.pay, 'refundRequestsByStatus'), (r) => r['status'] === status && r['currency'] === 'SAR'),
      refundAmount: (status: string) => sum(rows(s.pay, 'refundRequestsByStatus'), (r) => r['status'] === status && r['currency'] === 'SAR', 'amountHalalas'),
      confirmedRefunds: rows(s.pay, 'refundsConfirmedByProvider').length,
      ledger: (type: string, field: string) => sum(rows(s.led, 'entriesByType'), (r) => r['entryType'] === type && r['currency'] === 'SAR', field),
    });

    it('does not treat a pending payment attempt as funds, in either the payment or the ledger report', async () => {
      const before = at0(await snap());
      const p = await h.acceptedBooking();
      await h.startedPayment(p.customer, p.booking.id); // PROCESSING: the customer has not paid anything yet
      const after = at0(await snap());
      expect(after.attemptCount('PROCESSING')).toBe(before.attemptCount('PROCESSING') + 1);
      expect(after.attempts('PROCESSING', 'requestedToCollectHalalas')).toBe(before.attempts('PROCESSING', 'requestedToCollectHalalas') + 23000);
      expect(after.applied).toBe(before.applied); // nothing captured
      expect(after.unapplied).toBe(before.unapplied);
      expect(after.ledger('PAYMENT_CAPTURED', 'count')).toBe(before.ledger('PAYMENT_CAPTURED', 'count'));
    });

    it('reports a verified capture as provider-reported and posts it to the ledger', async () => {
      const before = at0(await snap());
      await h.confirmedBooking(20000);
      const after = at0(await snap());
      expect(after.attemptCount('SUCCEEDED')).toBe(before.attemptCount('SUCCEEDED') + 1);
      expect(after.applied).toBe(before.applied + 23000);
      expect(after.ledger('PAYMENT_CAPTURED', 'count')).toBe(before.ledger('PAYMENT_CAPTURED', 'count') + 1);
      expect(after.ledger('PAYMENT_CAPTURED', 'sumHalalas')).toBe(before.ledger('PAYMENT_CAPTURED', 'sumHalalas') + 23000);
    });

    it('keeps captured-but-unapplied money (a late payment for a cancelled booking) separate and reconcilable', async () => {
      const before = at0(await snap());
      const ops = (await get('operations').expect(200)).body.paymentsAwaitingReconciliation;
      const p = await h.acceptedBooking();
      const started = await h.startedPayment(p.customer, p.booking.id);
      await h.cancelBooking(p.customer, p.booking.id).expect(200);
      await h.sendWebhook({ id: `itest-rp-${randomUUID()}`, type: 'payment.succeeded', paymentId: started.providerPaymentId, amount: 23000, currency: 'SAR' }).expect(200);
      const after = at0(await snap());
      expect(after.attemptCount('CAPTURED_UNAPPLIED')).toBe(before.attemptCount('CAPTURED_UNAPPLIED') + 1);
      expect(after.unappliedCount).toBe(before.unappliedCount + 1);
      expect(after.unapplied).toBe(before.unapplied + 23000);
      expect(after.applied).toBe(before.applied); // never counted as applied
      expect(after.ledger('PAYMENT_CAPTURED_UNAPPLIED', 'count')).toBe(before.ledger('PAYMENT_CAPTURED_UNAPPLIED', 'count') + 1);
      expect((await get('operations').expect(200)).body.paymentsAwaitingReconciliation).toBe(ops + 1);
      expect((await get('payments').expect(200)).body.definitions.capturedButUnappliedAllTime).toMatch(/nothing is refunded automatically/);
    });

    it('never reports a requested refund as a completed refund', async () => {
      const p = await h.confirmedBooking();
      const payment = await h.prisma.paymentAttempt.findFirstOrThrow({ where: { bookingId: p.booking.id, status: 'SUCCEEDED' } });
      const before = at0(await snap());
      await h.api().post(`/api/v1/admin/payments/${payment.id}/refunds`).set(h.bearer(admin.accessToken)).set('Idempotency-Key', `itest-rp-${randomUUID()}`).send({ amountHalalas: 1500, reason: 'Goodwill requested by support.' }).expect(201);
      const after = at0(await snap());
      expect(after.refundCount('REQUESTED')).toBe(before.refundCount('REQUESTED') + 1);
      expect(after.refundAmount('REQUESTED')).toBe(before.refundAmount('REQUESTED') + 1500);
      expect(after.refundCount('SUCCEEDED')).toBe(before.refundCount('SUCCEEDED')); // unchanged
      expect(after.confirmedRefunds).toBe(0); // no provider has confirmed anything
      expect(after.ledger('REFUND_COMPLETED', 'count')).toBe(before.ledger('REFUND_COMPLETED', 'count'));
      expect((await get('payments').expect(200)).body.definitions.refundRequestsByStatus).toMatch(/NO money has moved/);
    });

    it('never adds different currencies together, and excludes simulated money unless asked', async () => {
      const p = await h.confirmedBooking();
      const key = () => `itest-rp-${randomUUID()}`;
      const payment = await h.prisma.paymentAttempt.findFirstOrThrow({ where: { bookingId: p.booking.id } });
      const entry = (currency: string, amount: number, simulated = false) =>
        h.prisma.ledgerEntry.create({ data: { entryType: 'PAYMENT_CAPTURED_UNAPPLIED', amountHalalas: amount, currency, bookingId: p.booking.id, paymentId: payment.id, idempotencyKey: key(), sourceType: 'itest', description: 'report test entry', isSimulated: simulated } });
      const before = (await get('ledger').expect(200)).body;
      const usdBefore = sum(before.entriesByType, (r) => r['currency'] === 'USD' && r['entryType'] === 'PAYMENT_CAPTURED_UNAPPLIED', 'sumHalalas');
      const sarBefore = sum(before.entriesByType, (r) => r['currency'] === 'SAR' && r['entryType'] === 'PAYMENT_CAPTURED_UNAPPLIED', 'sumHalalas');

      await entry('USD', 700);
      await entry('SAR', 100, true); // simulated
      const after = (await get('ledger').expect(200)).body;
      expect(sum(after.entriesByType, (r) => r['currency'] === 'USD' && r['entryType'] === 'PAYMENT_CAPTURED_UNAPPLIED', 'sumHalalas')).toBe(usdBefore + 700);
      expect(sum(after.entriesByType, (r) => r['currency'] === 'SAR' && r['entryType'] === 'PAYMENT_CAPTURED_UNAPPLIED', 'sumHalalas')).toBe(sarBefore); // USD did not leak into SAR; simulated is excluded
      const withSim = (await get('ledger?includeSimulated=true').expect(200)).body;
      expect(sum(withSim.entriesByType, (r) => r['currency'] === 'SAR' && r['entryType'] === 'PAYMENT_CAPTURED_UNAPPLIED', 'sumHalalas')).toBe(sarBefore + 100);
      expect(after.entriesByType.every((r: Row) => typeof r['currency'] === 'string')).toBe(true);
      expect(after.definitions.entriesByType).toMatch(/NOT a bank balance, NOT recognised revenue/);
      expect(JSON.stringify(after)).not.toMatch(/"(balance|revenue|vatLiability|payable|netTotal|grandTotal)"/i);
    });

    it('does not mutate any financial record when reports are read', async () => {
      const state = async () => ({ ledger: await h.prisma.ledgerEntry.count(), payments: await h.prisma.paymentAttempt.count(), refunds: await h.prisma.paymentRefund.count(), sums: await h.prisma.ledgerEntry.aggregate({ _sum: { amountHalalas: true } }) });
      const before = await state();
      for (const path of ['payments', 'ledger', 'operations', 'bookings', 'quotes']) await get(path).expect(200);
      expect(await state()).toEqual(before);
    });
  });

  describe('privacy', () => {
    it('contains no personal data in any report', async () => {
      const p = await h.confirmedBooking();
      await h.api().post('/api/v1/disputes').set(h.bearer(p.customer.accessToken)).set('X-Forwarded-For', h.freshIp()).send({ bookingId: p.booking.id, category: 'OTHER', description: 'A private description of the problem.' }).expect(201);
      const bodies: string[] = [];
      for (const path of ['bookings', 'bookings/trend', 'quotes', 'workers', 'reviews', 'disputes', 'notifications', 'operations', 'payments', 'ledger']) bodies.push(JSON.stringify((await get(path).expect(200)).body));
      const text = bodies.join('\n');
      for (const secret of [p.customer.phone, p.worker.phone, p.customer.userId, p.worker.userId, 'private description', '@example.com', p.booking.id]) expect(text).not.toContain(secret);
    });
  });
});
