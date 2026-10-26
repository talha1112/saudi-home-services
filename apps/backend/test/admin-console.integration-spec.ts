/**
 * REAL POSTGRESQL: the administrator console's read models and actions. Every number the admin screens show comes from these endpoints,
 * so they are checked against rows the real booking flow produced (a completed online booking, a completed cash booking, an open request
 * with a live quote, a dispute and a review).
 */
import { randomBytes } from 'node:crypto';
import { type Harness, type Session, type Worker, bootHarness } from './support/bookings-harness.js';

const run = process.env['TEST_DATABASE_URL'] ? describe : describe.skip;
if (!process.env['TEST_DATABASE_URL']) console.warn('admin-console.integration-spec: TEST_DATABASE_URL is not set, suite skipped');

run('administrator console (real PostgreSQL)', () => {
  // The test database keeps rows between runs, so names are unique per run.
  const ctag = randomBytes(3).toString('hex');
  const wtag = randomBytes(3).toString('hex');
  const CN = `Hessa ${ctag}`;
  const WN = `Faisal ${wtag}`;
  const qtag = randomBytes(3).toString('hex');
  let h: Harness;
  let ref: Awaited<ReturnType<Harness['seedReferenceData']>>;
  let customer: Session;
  let quietCustomer: Session;
  let w1: Worker;
  let w2: Worker;
  let onlineBooking: { id: string; reference: string };
  let cashBooking: { id: string; reference: string };
  let openBooking: { id: string; reference: string };
  let disputeId: string;
  const as = (t: { accessToken: string }) => h.bearer(t.accessToken);
  const admin = () => h.bearer(h.adminToken);
  const get = (path: string) => h.api().get(`/api/v1/admin/${path}`).set(admin());
  const rangeQuery = () => `from=${encodeURIComponent(new Date(Date.now() - 86_400_000).toISOString())}&to=${encodeURIComponent(new Date(Date.now() + 3_600_000).toISOString())}`;

  async function accept(c: Session, w: Worker, bookingId: string, price = 20000) {
    const quote = await h.submitQuote(w, bookingId, { priceHalalas: price });
    await h.api().post(`/api/v1/bookings/${bookingId}/quotes/${quote.id}/accept`).set(as(c)).send({}).expect(200);
    return quote;
  }

  beforeAll(async () => {
    h = await bootHarness({
      phonePrefix: '+9665986',
      slugPrefix: 'itest-ac-',
      adminEmailPrefix: 'itest-ac-admin',
      env: { PUSH_PROVIDER: 'mock', DEVICE_TOKEN_ENCRYPTION_KEY: randomBytes(32).toString('base64') },
    });
    ref = await h.seedReferenceData();
    customer = await h.makeCustomer();
    quietCustomer = await h.makeCustomer();
    await h.prisma.user.update({ where: { id: customer.userId }, data: { fullName: CN, status: 'ACTIVE' } });
    await h.prisma.user.update({ where: { id: quietCustomer.userId }, data: { fullName: `Quiet ${qtag}`, status: 'ACTIVE' } });
    w1 = await h.makeWorker([ref.service.id], [ref.city.id]);
    w2 = await h.makeWorker([ref.service.id], [ref.city.id]);
    await h.prisma.user.update({ where: { id: w1.userId }, data: { fullName: WN } });

    // 1. completed, paid online
    onlineBooking = await h.createBooking(customer, ref);
    await accept(customer, w1, onlineBooking.id, 20000);
    await h.confirmBooking({ customer, booking: onlineBooking });
    await h.startWork(w1, onlineBooking.id).expect(200);
    await h.completeWork(w1, onlineBooking.id).expect(200);

    // 2. completed, paid in cash
    cashBooking = await h.createBooking(customer, ref);
    await accept(customer, w1, cashBooking.id, 30000);
    await h.api().post(`/api/v1/bookings/${cashBooking.id}/payments/cash`).set(as(customer)).send({}).expect(200);
    await h.startWork(w1, cashBooking.id).expect(200);
    await h.api().post(`/api/v1/workers/me/bookings/${cashBooking.id}/cash-collected`).set(as(w1)).send({}).expect(200);
    await h.completeWork(w1, cashBooking.id).expect(200);

    // 3. open, with one live quote
    openBooking = await h.createBooking(customer, ref);
    await h.submitQuote(w2, openBooking.id, { priceHalalas: 15000 });

    // a review and a dispute on the first booking
    await h.api().post(`/api/v1/bookings/${onlineBooking.id}/review`).set(as(customer)).set('X-Forwarded-For', h.freshIp()).send({ rating: 5, comment: 'Arrived on time, clean work.' }).expect(201);
    const dispute = await h
      .api()
      .post('/api/v1/disputes')
      .set(as(customer))
      .set('X-Forwarded-For', h.freshIp())
      .send({ bookingId: onlineBooking.id, category: 'SERVICE_QUALITY', description: 'The second unit still is not cooling at all.' })
      .expect(201);
    disputeId = dispute.body.id;
  });

  afterAll(async () => {
    if (h) await h.close();
  });

  it('is for administrators only', async () => {
    for (const path of ['dashboard', 'customers', 'quotes', 'search?q=ab', 'commissions', 'notifications', 'transactions', 'admins', 'system', 'catalog-stats']) {
      await h.api().get(`/api/v1/admin/${path}`).expect(401);
      await h.api().get(`/api/v1/admin/${path}`).set(as(customer)).expect(403);
      await h.api().get(`/api/v1/admin/${path}`).set(as(w1)).expect(403);
    }
  });

  describe('dashboard', () => {
    it('counts the window from the database: bookings, completed value, commission, workers, disputes, customers', async () => {
      const body = (await get(`dashboard?${rangeQuery()}&cityId=${ref.city.id}`).expect(200)).body;
      const k = body.kpis;
      expect(k.bookingsCreated).toBe(3);
      expect(k.completedBookings).toBe(2);
      // completed value = both totals (price + 15% VAT): 20000*1.15 + 30000*1.15
      expect(k.completedValueHalalas).toBe(23000 + 34500);
      expect(k.serviceAmountHalalas).toBe(50000);
      expect(k.commissionHalalas).toBe(7500); // 15% of 50,000
      expect(k.workerEarningsHalalas).toBe(42500);
      expect(k.effectiveCommissionPct).toBe(15);
      expect(k.completionRatePct).toBe(100);
      expect(k.activeWorkers).toBe(2);
      expect(k.openDisputes).toBe(1);
      expect(k.disputesNeedingAction).toBe(1);
      expect(k.customers).toBeGreaterThanOrEqual(2);
      expect(body.bookingsByStatus.find((s: { status: string }) => s.status === 'COMPLETED').count).toBe(2);
      expect(body.trend.length).toBeGreaterThan(0);
      expect(body.trend[0]).toMatchObject({ created: 3, completed: 2 });
      const city = body.cities.find((c: { id: string }) => c.id === ref.city.id);
      expect(city).toMatchObject({ bookings: 3, completedValueHalalas: 57500, workers: 2, averageRating: 5 });
      expect(body.topWorkers[0]).toMatchObject({ fullName: WN, completedJobs: 2, earningsHalalas: 42500 });
      expect(body.openDisputesList[0]).toMatchObject({ id: disputeId, bookingReference: onlineBooking.reference });
      const cat = body.categories.find((c: { id: string }) => c.id === ref.category.id);
      expect(cat.bookings).toBe(3);
    });

    it('follows the city: another city has none of it', async () => {
      const body = (await get(`dashboard?${rangeQuery()}&cityId=${ref.otherCity.id}`).expect(200)).body;
      expect(body.kpis.bookingsCreated).toBe(0);
      expect(body.kpis.completedValueHalalas).toBe(0);
      expect(body.kpis.activeWorkers).toBe(0);
      expect(body.topWorkers).toEqual([]);
    });

    it('follows the window: a window in the past is empty', async () => {
      const from = encodeURIComponent('2020-01-01T00:00:00.000Z');
      const to = encodeURIComponent('2020-02-01T00:00:00.000Z');
      const body = (await get(`dashboard?from=${from}&to=${to}&cityId=${ref.city.id}`).expect(200)).body;
      expect(body.kpis.bookingsCreated).toBe(0);
      expect(body.kpis.completedBookings).toBe(0);
      expect(body.kpis.completionRatePct).toBeNull();
    });

    it('rejects a bad window', async () => {
      await get('dashboard?from=2026-02-01T00:00:00.000Z&to=2026-01-01T00:00:00.000Z').expect(400);
      await get('dashboard?cityId=nope').expect(400);
    });
  });

  describe('customers', () => {
    it('lists customers with bookings, spend, last booking, city and disputes; the phone is masked', async () => {
      const list = (await get(`customers?q=${ctag}`).expect(200)).body;
      expect(list.items).toHaveLength(1);
      expect(list.items[0]).toMatchObject({ fullName: CN, bookings: 3, completedBookings: 2, spentHalalas: 57500, disputes: 1, status: 'ACTIVE' });
      expect(list.items[0].city.id).toBe(ref.city.id);
      expect(list.items[0].phone).toContain('•');
      expect(list.meta.total).toBe(1);
    });

    it('filters by spend, disputes and status, and searches by name and phone', async () => {
      expect((await get(`customers?minSpentHalalas=50000&q=${ctag}`).expect(200)).body.items).toHaveLength(1);
      expect((await get(`customers?maxSpentHalalas=1000&q=${ctag}`).expect(200)).body.items).toHaveLength(0);
      expect((await get(`customers?hasDisputes=true&q=${ctag}`).expect(200)).body.items).toHaveLength(1);
      expect((await get(`customers?hasDisputes=false&q=${ctag}`).expect(200)).body.items).toHaveLength(0);
      expect((await get(`customers?hasDisputes=false&q=${qtag}`).expect(200)).body.items).toHaveLength(1);
      expect((await get(`customers?status=SUSPENDED&q=${ctag}`).expect(200)).body.items).toHaveLength(0);
      expect((await get(`customers?q=${encodeURIComponent(customer.phone.slice(-6))}`).expect(200)).body.items.map((i: { id: string }) => i.id)).toContain(customer.userId);
      expect((await get(`customers?cityId=${ref.otherCity.id}&q=${ctag}`).expect(200)).body.items).toHaveLength(0);
    });

    it('treats search text literally (no wildcard injection)', async () => {
      expect((await get('customers?q=%25').expect(200)).body.items).toHaveLength(0);
      expect((await get('customers?q=Hess_').expect(200)).body.items).toHaveLength(0);
    });

    it('summarises, and shows one customer with history, disputes and payment methods', async () => {
      const s = (await get('customers/summary').expect(200)).body;
      expect(s.total).toBeGreaterThanOrEqual(2);
      expect(s.repeatCustomers).toBeGreaterThanOrEqual(1);
      expect(s.withDisputes).toBeGreaterThanOrEqual(1);
      const d = (await get(`customers/${customer.userId}`).expect(200)).body;
      expect(d).toMatchObject({ fullName: CN, phone: customer.phone, bookings: 3, spentHalalas: 57500, reviewsGiven: 1, averageRatingGiven: 5 });
      expect(d.recentBookings).toHaveLength(3);
      expect(d.disputes[0]).toMatchObject({ id: disputeId, bookingReference: onlineBooking.reference });
      expect(d.paymentMethods.map((p: { method: string }) => p.method).sort()).toEqual(['CASH', 'ONLINE']);
      await get(`customers/${w1.userId}`).expect(404); // a worker is not a customer
      await get('customers/not-a-uuid').expect(400);
    });
  });

  describe('bookings, quotes and transactions', () => {
    it('lists bookings with the people, city and payment method, and searches reference, names and service', async () => {
      const all = (await get('bookings?limit=50').expect(200)).body;
      const row = all.items.find((b: { id: string }) => b.id === cashBooking.id);
      expect(row).toMatchObject({ customerName: CN, workerName: WN, cityNameEn: 'Riyadh (test)', paymentMethod: 'CASH', cashCollected: true, status: 'COMPLETED' });
      expect((await get(`bookings?q=${onlineBooking.reference}`).expect(200)).body.items.map((b: { id: string }) => b.id)).toEqual([onlineBooking.id]);
      expect((await get(`bookings?q=${wtag}`).expect(200)).body.items.length).toBe(2);
      expect((await get(`bookings?q=${ctag}&paymentMethod=CASH`).expect(200)).body.items.map((b: { id: string }) => b.id)).toEqual([cashBooking.id]);
      expect((await get(`bookings?serviceId=${ref.service.id}&q=${ctag}&status=OPEN`).expect(200)).body.items.map((b: { id: string }) => b.id)).toEqual([openBooking.id]);
      expect((await get('bookings?q=zzzz').expect(200)).body.items).toHaveLength(0);
    });

    it('lists quotes with their state, searches by reference/worker/service and summarises', async () => {
      const q = (await get(`quotes?q=${openBooking.reference}`).expect(200)).body;
      expect(q.items).toHaveLength(1);
      expect(q.items[0]).toMatchObject({ bookingReference: openBooking.reference, status: 'PENDING', priceHalalas: 15000, serviceNameEn: 'Wiring' });
      expect(q.items[0].workerPayoutHalalas).toBe(12750);
      const accepted = (await get(`quotes?status=ACCEPTED&q=${wtag}`).expect(200)).body;
      expect(accepted.items.length).toBe(2);
      expect((await get(`quotes?status=PENDING&q=${openBooking.reference}`).expect(200)).body.items.every((i: { status: string }) => i.status === 'PENDING')).toBe(true);
      expect((await get(`quotes?workerId=${w2.workerId}`).expect(200)).body.items).toHaveLength(1);
      const s = (await get(`quotes/summary?${rangeQuery()}`).expect(200)).body;
      expect(s.sent).toBeGreaterThanOrEqual(3);
      expect(s.accepted).toBeGreaterThanOrEqual(2);
      expect(s.pendingNow).toBeGreaterThanOrEqual(1);
      expect(s.requestsQuoted).toBeGreaterThanOrEqual(3);
      expect(s.averageFirstResponseMinutes).not.toBeNull();
    });

    it('shows an overdue pending quote as expired', async () => {
      await h.prisma.quote.updateMany({ where: { bookingId: openBooking.id }, data: { validUntil: new Date(Date.now() - 60_000) } });
      const q = (await get(`quotes?q=${openBooking.reference}`).expect(200)).body;
      expect(q.items[0].status).toBe('EXPIRED');
      expect((await get(`quotes?status=EXPIRED&q=${openBooking.reference}`).expect(200)).body.items.map((i: { bookingReference: string }) => i.bookingReference)).toContain(openBooking.reference);
      expect((await get(`quotes?status=PENDING&q=${openBooking.reference}`).expect(200)).body.items).toHaveLength(0);
      await h.prisma.quote.updateMany({ where: { bookingId: openBooking.id }, data: { validUntil: new Date(Date.now() + 3_600_000) } });
    });

    it('lists payments by booking (cash and online) with the derived state, plus refunds and failed attempts', async () => {
      const t = (await get('transactions?limit=50').expect(200)).body;
      const cash = t.items.find((x: { bookingId: string }) => x.bookingId === cashBooking.id);
      const online = t.items.find((x: { bookingId: string }) => x.bookingId === onlineBooking.id);
      expect(cash).toMatchObject({ method: 'CASH', state: 'COLLECTED', totalHalalas: 34500, vatHalalas: 4500, customerName: CN });
      expect(online).toMatchObject({ method: 'ONLINE', state: 'PAID', totalHalalas: 23000 });
      expect(online.payment).not.toBeNull();
      expect(t.items.find((x: { bookingId: string }) => x.bookingId === openBooking.id)).toBeUndefined();
      expect((await get('transactions?method=CASH').expect(200)).body.items.every((x: { method: string }) => x.method === 'CASH')).toBe(true);
      expect((await get(`transactions?q=${onlineBooking.reference}`).expect(200)).body.items).toHaveLength(1);
      expect((await get('transactions?state=CASH_DUE').expect(200)).body.items.find((x: { bookingId: string }) => x.bookingId === cashBooking.id)).toBeUndefined();
      expect(Array.isArray((await get('transactions?view=refunds').expect(200)).body.items)).toBe(true);
      expect(Array.isArray((await get('transactions?view=failed').expect(200)).body.items)).toBe(true);
      const s = (await get(`transactions/summary?${rangeQuery()}`).expect(200)).body;
      // the window is shared with other suites' rows in this database, so ours are a lower bound
      expect(s.agreedHalalas).toBeGreaterThanOrEqual(57500);
      expect(s.vatHalalas).toBeGreaterThanOrEqual(7500);
      expect(s.cash.totalHalalas).toBeGreaterThanOrEqual(34500);
      expect(s.online.totalHalalas).toBeGreaterThanOrEqual(23000);
    });

    it('requests a refund for an online payment and lists it', async () => {
      const t = (await get(`transactions?q=${onlineBooking.reference}`).expect(200)).body.items[0];
      await h
        .api()
        .post(`/api/v1/admin/payments/${t.payment.id}/refunds`)
        .set(admin())
        .set('Idempotency-Key', `itest-ac-refund-${Date.now()}`)
        .send({ amountHalalas: 1000, reason: 'Goodwill after the dispute.' })
        .expect(201);
      const refunds = (await get('transactions?view=refunds').expect(200)).body.items;
      expect(refunds[0]).toMatchObject({ reference: onlineBooking.reference, amountHalalas: 1000, status: 'REQUESTED', moneyReturned: false });
    });
  });

  describe('disputes and reviews', () => {
    it('shows who, what, where and how much on the list and the detail, and searches', async () => {
      const list = (await get(`disputes?q=${ctag}`).expect(200)).body;
      expect(list.items[0]).toMatchObject({ id: disputeId, customerName: CN, workerName: WN, serviceNameEn: 'Wiring', cityNameEn: 'Riyadh (test)', amountHalalas: 23000, status: 'OPEN' });
      expect((await get(`disputes?q=${onlineBooking.reference}`).expect(200)).body.items).toHaveLength(1);
      expect((await get('disputes?q=nobody-here').expect(200)).body.items).toHaveLength(0);
      const d = (await get(`disputes/${disputeId}`).expect(200)).body;
      expect(d).toMatchObject({ openedByName: CN, customerName: CN, description: 'The second unit still is not cooling at all.' });
      expect(d.booking).toMatchObject({ reference: onlineBooking.reference, paymentMethod: 'ONLINE' });
    });

    it('moves a dispute through review, a message to the parties, an internal note and resolution, naming the actor', async () => {
      await h.api().post(`/api/v1/admin/disputes/${disputeId}/start-review`).set(admin()).send({}).expect(200);
      await h.api().post(`/api/v1/admin/disputes/${disputeId}/request-info`).set(admin()).send({ note: 'Please send photos of both units.' }).expect(200);
      await h.api().post(`/api/v1/admin/disputes/${disputeId}/start-review`).set(admin()).send({}).expect(200);
      await h.api().post(`/api/v1/admin/disputes/${disputeId}/internal-note`).set(admin()).send({ note: 'Worker says the capacitor is faulty.' }).expect(200);
      const d = (await get(`disputes/${disputeId}`).expect(200)).body;
      expect(d.status).toBe('UNDER_REVIEW');
      expect(d.assignedAdminName).toBeTruthy();
      expect(d.events.map((e: { action: string }) => e.action)).toEqual(expect.arrayContaining(['INFO_REQUESTED', 'INTERNAL_NOTE']));
      expect(d.events.find((e: { action: string }) => e.action === 'INTERNAL_NOTE').actorName).toBeTruthy();
    });

    it('lists reviews with names and the booking, searches, and hides one with a reason', async () => {
      const r = (await get(`reviews?q=${ctag}`).expect(200)).body;
      expect(r.items[0]).toMatchObject({ customerName: CN, workerName: WN, bookingReference: onlineBooking.reference, rating: 5, status: 'PUBLISHED' });
      expect((await get('reviews?q=on%20time').expect(200)).body.items).toHaveLength(1);
      expect((await get('reviews?q=zzzz').expect(200)).body.items).toHaveLength(0);
      await h.api().post(`/api/v1/admin/reviews/${r.items[0].id}/hide`).set(admin()).send({ reason: 'Contains a phone number.' }).expect(200);
      expect((await get('reviews?status=HIDDEN').expect(200)).body.items).toHaveLength(1);
    });
  });

  describe('commissions', () => {
    it('reports commission and worker earnings per worker from completed bookings, with the current rule', async () => {
      const c = (await get(`commissions?${rangeQuery()}&cityId=${ref.city.id}`).expect(200)).body;
      expect(c.rule).toMatchObject({ commissionRateBps: 1500, vatRateBps: 1500 });
      expect(c.totals).toMatchObject({ completedBookings: 2, serviceAmountHalalas: 50000, commissionHalalas: 7500, workerEarningsHalalas: 42500, effectiveRatePct: 15 });
      const w = (await get(`commissions/workers?${rangeQuery()}&cityId=${ref.city.id}`).expect(200)).body;
      expect(w.items).toHaveLength(1);
      expect(w.items[0]).toMatchObject({ fullName: WN, completedJobs: 2, serviceAmountHalalas: 50000, commissionHalalas: 7500, workerEarningsHalalas: 42500 });
      expect(w.meta.total).toBe(1);
      expect((await get(`commissions/workers?${rangeQuery()}&cityId=${ref.city.id}&q=nobody`).expect(200)).body.items).toHaveLength(0);
      expect((await get(`commissions/workers?${rangeQuery()}&cityId=${ref.city.id}&q=${wtag}`).expect(200)).body.items).toHaveLength(1);
      expect((await get(`commissions?${rangeQuery()}&cityId=${ref.otherCity.id}`).expect(200)).body.totals.completedBookings).toBe(0);
    });
  });

  describe('search', () => {
    it('finds customers, workers, bookings, services and disputes, with masked phones', async () => {
      const hits = (q: string) => get(`search?q=${encodeURIComponent(q)}`).expect(200).then((r) => r.body.hits as Array<{ type: string; id: string; title: string; subtitle: string }>);
      expect((await hits(ctag)).filter((x) => x.type === 'customer').map((x) => x.id)).toEqual([customer.userId]);
      expect((await hits(wtag)).some((x) => x.type === 'worker' && x.id === w1.workerId)).toBe(true);
      expect((await hits(onlineBooking.reference)).some((x) => x.type === 'booking' && x.id === onlineBooking.id)).toBe(true);
      expect((await hits(onlineBooking.reference)).some((x) => x.type === 'dispute' && x.id === disputeId)).toBe(true);
      expect((await hits('Wiring')).some((x) => x.type === 'service')).toBe(true);
      const byPhone = await hits(customer.phone.slice(-7));
      expect(byPhone.find((x) => x.type === 'customer')?.subtitle).toContain('•');
      expect(await hits('qqqqzzzz')).toEqual([]);
      await get('search?q=a').expect(400);
      await get('search').expect(400);
    });
  });

  describe('catalog statistics and system facts', () => {
    it('counts bookings, workers and average quote per service and category', async () => {
      const s = (await get('catalog-stats').expect(200)).body;
      const svc = s.services.find((x: { serviceId: string }) => x.serviceId === ref.service.id);
      expect(svc).toMatchObject({ bookings: 3, completedBookings: 2, workers: 2 });
      expect(svc.averageQuoteHalalas).toBe(21667); // (20000 + 30000 + 15000) / 3
      expect(s.categories.find((x: { categoryId: string }) => x.categoryId === ref.category.id)).toMatchObject({ bookings: 3, workers: 2 });
    });

    it('lists administrators and non-secret deployment facts', async () => {
      const a = (await get('admins').expect(200)).body;
      expect(a.length).toBeGreaterThanOrEqual(1);
      expect(Object.keys(a[0]).sort()).toEqual(['createdAt', 'email', 'fullName', 'id', 'lastLoginAt', 'mustChangePassword', 'status']);
      const sys = (await get('system').expect(200)).body;
      expect(sys.payments.cashOnDelivery).toBe(true);
      expect(sys.notifications.pushProvider).toBe('mock');
      expect(sys.cities.some((c: { id: string }) => c.id === ref.city.id)).toBe(true);
      expect(JSON.stringify(sys)).not.toMatch(/secret|password|token|key/i);
    });
  });

  describe('announcements', () => {
    it('reports the audience size before sending, by group, city and category', async () => {
      const reach = async (qs: string) => (await get(`notifications/reach?${qs}`).expect(200)).body.recipients as number;
      expect(await reach('audience=WORKERS&group=APPROVED')).toBeGreaterThanOrEqual(2);
      expect(await reach(`audience=WORKERS&group=APPROVED&cityIds=${ref.city.id}`)).toBe(2);
      expect(await reach(`audience=WORKERS&group=APPROVED&cityIds=${ref.otherCity.id}`)).toBe(0);
      expect(await reach(`audience=WORKERS&categoryIds=${ref.category.id}&cityIds=${ref.city.id}`)).toBe(2);
      expect(await reach(`audience=CUSTOMERS&cityIds=${ref.city.id}`)).toBe(1); // only the customer who booked there
      expect(await reach('audience=CUSTOMERS&group=REPEAT')).toBeGreaterThanOrEqual(1);
      expect(await reach(`audience=CUSTOMERS&group=NEW`)).toBeGreaterThanOrEqual(1);
      await get('notifications/reach?audience=WORKERS&group=REPEAT').expect(400); // a customer group on workers
      await get('notifications/reach?audience=EVERYONE').expect(400);
    });

    it('sends to the audience once, in each person\'s language slot, queues a push for registered phones, audits it, and lists it', async () => {
      await h.api().post('/api/v1/devices').set(as(w1)).set('X-Forwarded-For', h.freshIp()).send({ platform: 'ANDROID', provider: 'FCM', token: `tok-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}-padding` }).expect(200);
      const sent = (await h
        .api()
        .post('/api/v1/admin/notifications/broadcast')
        .set(admin())
        .send({ audience: 'WORKERS', group: 'APPROVED', cityIds: [ref.city.id], titleEn: 'Riyadh is busy', bodyEn: 'Switch your status to online to receive more requests.', titleAr: 'الرياض مزدحمة' })
        .expect(200)).body;
      expect(sent).toMatchObject({ recipients: 2, pushDeliveries: 1 });
      const rows = await h.prisma.notification.findMany({ where: { sourceKey: `announce:${sent.campaignId}` } });
      expect(rows.map((r) => r.userId).sort()).toEqual([w1.userId, w2.userId].sort());
      expect(rows[0]!.type).toBe('admin.announcement');
      expect(rows[0]!.params).toMatchObject({ titleEn: 'Riyadh is busy', titleAr: 'الرياض مزدحمة', bodyAr: 'Switch your status to online to receive more requests.' }); // missing Arabic body falls back
      // the person reads it rendered in their language
      const inbox = (await h.api().get('/api/v1/notifications').set(as(w2)).expect(200)).body;
      expect(inbox.items.some((n: { title: string; type: string }) => n.type === 'admin.announcement' && n.title.length > 0)).toBe(true);
      expect(await h.prisma.notificationDelivery.count({ where: { notification: { sourceKey: `announce:${sent.campaignId}` } } })).toBe(1);
      expect(await h.prisma.auditLog.count({ where: { action: 'notification.broadcast', entityId: sent.campaignId } })).toBe(1);

      await h.api().post(`/api/v1/notifications/${rows.find((r) => r.userId === w2.userId)!.id}/read`).set(as(w2)).send({}).expect((r) => expect([200, 204]).toContain(r.status));
      const list = (await get('notifications').expect(200)).body;
      expect(list.items[0]).toMatchObject({ campaignId: sent.campaignId, titleEn: 'Riyadh is busy', audience: 'WORKERS', reach: 2 });
      expect(list.items[0].opened).toBeGreaterThanOrEqual(0);
      const summary = (await get('notifications/summary').expect(200)).body;
      expect(summary.campaignsThisMonth).toBeGreaterThanOrEqual(1);
      expect(summary.pushOptIn.workers.withPhone).toBeGreaterThanOrEqual(1);
    });

    it('refuses an empty message, an empty audience and a title-less announcement', async () => {
      const send = (body: object) => h.api().post('/api/v1/admin/notifications/broadcast').set(admin()).send(body);
      await send({ audience: 'WORKERS', titleEn: 'Hi' }).expect(400);
      await send({ audience: 'WORKERS', bodyEn: 'Hi' }).expect(400);
      await send({ audience: 'WORKERS', cityIds: [ref.otherCity.id], titleEn: 'Hi', bodyEn: 'There' }).expect(400).expect((r) => expect(r.body.code).toBe('NO_RECIPIENTS'));
      await send({ audience: 'WORKERS', group: 'REPEAT', titleEn: 'Hi', bodyEn: 'There' }).expect(400);
      await send({ audience: 'WORKERS', titleEn: 'x'.repeat(81), bodyEn: 'There' }).expect(400);
    });
  });
  describe('reports and filters', () => {
    it('charts a report by month and city, and summarises it for the window', async () => {
      const rev = (await get('report-series?metric=revenue&months=6').expect(200)).body;
      expect(rev.months).toHaveLength(6);
      const ci = rev.cities.findIndex((c: { id: string }) => c.id === ref.city.id);
      expect(ci).toBeGreaterThanOrEqual(0);
      expect(rev.values[5][ci]).toBe(57500); // both completed bookings were completed this month
      const bookings = (await get('report-series?metric=bookings&months=3').expect(200)).body;
      expect(bookings.values[2][bookings.cities.findIndex((c: { id: string }) => c.id === ref.city.id)]).toBe(3);
      const subs = (await get('report-series?metric=subscriptions').expect(200)).body;
      expect(subs.available).toBe(false);
      await get('report-series?metric=nonsense').expect(400);
      await get('report-series?metric=revenue&months=99').expect(400);

      const sum = (m: string) => get(`report-series/summary?metric=${m}&${rangeQuery()}`).expect(200).then((r) => r.body.rows as Array<{ label: string; value: number | string | null }>);
      for (const m of ['revenue', 'bookings', 'commissions', 'earnings', 'cancellations', 'refunds', 'disputes', 'offers', 'subscriptions', 'customers', 'workers', 'cities']) {
        expect((await sum(m)).length).toBe(4);
      }
      expect((await sum('disputes')).find((r) => r.label === 'Disputes opened')!.value).toBeGreaterThanOrEqual(1);
    });

    it('gives one row per city with a total', async () => {
      const c = (await get(`report-series/cities?${rangeQuery()}`).expect(200)).body;
      const row = c.items.find((x: { id: string }) => x.id === ref.city.id);
      expect(row).toMatchObject({ bookings: 3, revenueHalalas: 57500, commissionHalalas: 7500, workerEarningsHalalas: 42500, refundsHalalas: 1000, disputes: 1, averageRating: null }); // the one review was hidden above, and the refund requested earlier
      expect(c.total.bookings).toBeGreaterThanOrEqual(3);
    });

    it('filters disputes by several statuses and by city, reviews by city and star range, payments and quotes by city', async () => {
      const ids = (b: { items: Array<{ id: string }> }) => b.items.map((i) => i.id);
      expect(ids((await get(`disputes?status=OPEN,UNDER_REVIEW,AWAITING_INFO&cityId=${ref.city.id}`).expect(200)).body)).toContain(disputeId);
      expect(ids((await get(`disputes?status=RESOLVED,CLOSED&cityId=${ref.city.id}`).expect(200)).body)).not.toContain(disputeId);
      expect((await get(`disputes?cityId=${ref.otherCity.id}`).expect(200)).body.items).toHaveLength(0);
      await get('disputes?status=NOPE').expect(400);
      expect((await get(`reviews?cityId=${ref.city.id}&maxRating=5`).expect(200)).body.items.length).toBeGreaterThanOrEqual(1);
      expect((await get(`reviews?cityId=${ref.city.id}&maxRating=3`).expect(200)).body.items).toHaveLength(0);
      expect((await get(`reviews?cityId=${ref.otherCity.id}`).expect(200)).body.items).toHaveLength(0);
      expect((await get(`transactions?cityId=${ref.otherCity.id}`).expect(200)).body.items).toHaveLength(0);
      expect((await get(`transactions?cityId=${ref.city.id}&limit=50`).expect(200)).body.items.length).toBeGreaterThanOrEqual(2);
      expect((await get(`transactions/summary?${rangeQuery()}&cityId=${ref.otherCity.id}`).expect(200)).body.agreedHalalas).toBe(0);
      expect((await get(`quotes?cityId=${ref.otherCity.id}`).expect(200)).body.items).toHaveLength(0);
      expect((await get(`quotes/summary?${rangeQuery()}&cityId=${ref.otherCity.id}`).expect(200)).body.sent).toBe(0);
    });

    it('lists offers by phase and searches their title', async () => {
      const post = (body: object) => h.api().post('/api/v1/admin/offers').set(admin()).send(body);
      const tag = randomBytes(3).toString('hex');
      const now = Date.now();
      const live = (await post({ audience: 'ALL', titleEn: `Live ${tag}`, descriptionEn: 'Details', startsAt: new Date(now - 3_600_000).toISOString(), endsAt: new Date(now + 86_400_000).toISOString(), termsEn: '20% OFF' }).expect(201)).body;
      const later = (await post({ audience: 'ALL', titleEn: `Later ${tag}`, descriptionEn: 'Details', startsAt: new Date(now + 86_400_000).toISOString(), endsAt: new Date(now + 2 * 86_400_000).toISOString() }).expect(201)).body;
      await post({ audience: 'ALL', titleEn: `Draft ${tag}`, startsAt: new Date(now).toISOString(), endsAt: new Date(now + 86_400_000).toISOString() }).expect(201);
      await h.api().post(`/api/v1/admin/offers/${live.id}/publish`).set(admin()).send({}).expect(200);
      await h.api().post(`/api/v1/admin/offers/${later.id}/publish`).set(admin()).send({}).expect(200);
      const titles = async (qs: string) => ((await get(`offers?q=${tag}&${qs}`).expect(200)).body.items as Array<{ titleEn: string }>).map((o) => o.titleEn.split(' ')[0]);
      expect(await titles('')).toHaveLength(3);
      expect(await titles('phase=ACTIVE')).toEqual(['Live']);
      expect(await titles('phase=SCHEDULED')).toEqual(['Later']);
      expect(await titles('phase=EXPIRED')).toEqual([]);
      expect(await titles('status=DRAFT')).toEqual(['Draft']);
      await get('offers?phase=SOMETIME').expect(400);
    });

    it('searches and filters the announcement history', async () => {
      const list = (await get(`notifications?q=${encodeURIComponent('Riyadh is busy')}`).expect(200)).body;
      expect(list.items.length).toBeGreaterThanOrEqual(1);
      expect(list.items[0]).toMatchObject({ kind: 'Announcement', audienceLabel: expect.stringContaining('Workers') });
      expect((await get('notifications?q=zzzznothing').expect(200)).body.items).toHaveLength(0);
      expect((await get('notifications?status=SCHEDULED').expect(200)).body.items).toHaveLength(0);
      expect((await get('notifications?status=SENT').expect(200)).body.items.length).toBeGreaterThanOrEqual(1);
      await get('notifications?status=LATER').expect(400);
    });

    it('puts weekly figures on the dashboard', async () => {
      const body = (await get(`dashboard?${rangeQuery()}&cityId=${ref.city.id}`).expect(200)).body;
      expect(body.weekly).toHaveLength(1);
      expect(body.weekly[0]).toMatchObject({ grossHalalas: 57500, commissionHalalas: 7500, workerEarningsHalalas: 42500 });
    });
  });
});
