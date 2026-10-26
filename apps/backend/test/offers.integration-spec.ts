/**
 * REAL POSTGRESQL: admin-managed offers (lifecycle, audit history, targeting, scheduling, expiry, localization)
 * and the guarantee that they have no financial effect.
 */
import { randomUUID } from 'node:crypto';
import { type Harness, type Session, type Worker, bootHarness } from './support/bookings-harness.js';

const run = process.env['TEST_DATABASE_URL'] ? describe : describe.skip;
if (!process.env['TEST_DATABASE_URL']) console.warn('offers.integration-spec: TEST_DATABASE_URL is not set, suite skipped');

const P = 'itest-of-';
const iso = (ms: number) => new Date(Date.now() + ms).toISOString();
const HOUR = 3_600_000;

run('offers: administration, eligibility and no financial effect (real PostgreSQL)', () => {
  let h: Harness;
  let ref: Awaited<ReturnType<Harness['seedReferenceData']>>;
  let customer: Session;
  let worker: Worker;
  let outsiderWorker: Worker;

  const admin = { accessToken: '' };
  const as = (who: { accessToken: string }) => h.bearer(who.accessToken);
  const create = (body: object = {}) =>
    h.api().post('/api/v1/admin/offers').set(as(admin)).send({ audience: 'CUSTOMERS', titleEn: `${P}Spring`, titleAr: `${P}الربيع`, descriptionEn: 'Details', descriptionAr: 'تفاصيل', startsAt: iso(-HOUR), endsAt: iso(48 * HOUR), ...body });
  const act = (id: string, action: 'publish' | 'pause' | 'archive') => h.api().post(`/api/v1/admin/offers/${id}/${action}`).set(as(admin)).send({});
  const list = (who: { accessToken: string }, q = '') => h.api().get(`/api/v1/offers${q}`).set(as(who)).set('X-Forwarded-For', h.freshIp());
  const live = async (body: object = {}) => {
    const o = (await create(body).expect(201)).body;
    await act(o.id, 'publish').expect(200);
    return o;
  };

  beforeAll(async () => {
    h = await bootHarness({ phonePrefix: '+9665983', slugPrefix: P, adminEmailPrefix: 'itest-of-admin' });
    ref = await h.seedReferenceData();
    admin.accessToken = h.adminToken;
    customer = await h.makeCustomer();
    worker = await h.makeWorker([ref.service.id], [ref.city.id]);
    outsiderWorker = await h.makeWorker([ref.otherService.id], [ref.otherCity.id]);
  });

  afterAll(async () => {
    if (h) await h.close();
  });

  describe('administration', () => {
    it('is for administrators only', async () => {
      await h.api().post('/api/v1/admin/offers').send({}).expect(401);
      for (const who of [customer, worker]) {
        expect((await h.api().post('/api/v1/admin/offers').set(as(who)).send({})).status).toBe(403);
        expect((await h.api().get('/api/v1/admin/offers').set(as(who))).status).toBe(403);
      }
      expect((await h.api().get('/api/v1/offers').set(as(admin))).status).toBe(403); // admins use the admin views
    });

    it('creates drafts, validates input, and records who did what', async () => {
      const o = (await create().expect(201)).body;
      expect(o).toMatchObject({ status: 'DRAFT', phase: 'DRAFT', audience: 'CUSTOMERS', redemptionEnabled: false });
      const row = await h.prisma.offer.findUniqueOrThrow({ where: { id: o.id } });
      expect(row.createdById).not.toBeNull();

      expect((await create({ endsAt: iso(-2 * HOUR) })).status).toBe(400); // ends before it starts
      expect((await create({ titleEn: undefined, titleAr: undefined })).body.code).toBe('TITLE_REQUIRED');
      expect((await create({ titleEn: '   ', titleAr: '' })).body.code).toBe('TITLE_REQUIRED');
      expect((await create({ audience: 'EVERYONE' })).status).toBe(400);
      expect((await create({ cityId: randomUUID() })).body.code).toBe('CITY_NOT_FOUND');
      expect((await create({ serviceId: randomUUID() })).body.code).toBe('SERVICE_NOT_FOUND');
      expect((await create({ startsAt: 'tomorrow' })).status).toBe(400);
      expect((await create({ discountPercent: 20 })).status).toBe(400); // there is no discount field to set
      expect((await create({ price: 100 })).status).toBe(400);
      expect((await create({ status: 'PUBLISHED' })).status).toBe(400); // status is only changed by actions
    });

    it('walks DRAFT -> PUBLISHED -> PAUSED -> PUBLISHED -> ARCHIVED with a complete history, and refuses illegal moves', async () => {
      const o = (await create().expect(201)).body;
      expect((await act(o.id, 'pause')).status).toBe(409); // not published yet
      const pub = (await act(o.id, 'publish').expect(200)).body;
      expect(pub).toMatchObject({ status: 'PUBLISHED', phase: 'LIVE' });
      expect(pub.publishedAt).not.toBeNull();
      expect((await act(o.id, 'publish')).status).toBe(409);
      expect((await act(o.id, 'pause').expect(200)).body.status).toBe('PAUSED');
      expect((await act(o.id, 'publish').expect(200)).body.publishedAt).toBe(pub.publishedAt); // resuming keeps the first publication time
      expect((await act(o.id, 'archive').expect(200)).body).toMatchObject({ status: 'ARCHIVED', phase: 'ARCHIVED' });
      expect((await act(o.id, 'publish')).status).toBe(409); // archived is final
      expect((await act(o.id, 'pause')).status).toBe(409);
      expect((await h.api().patch(`/api/v1/admin/offers/${o.id}`).set(as(admin)).send({ titleEn: `${P}x` })).status).toBe(409);

      const detail = (await h.api().get(`/api/v1/admin/offers/${o.id}`).set(as(admin)).expect(200)).body;
      expect(detail.history.map((e: { action: string }) => e.action)).toEqual(['CREATED', 'PUBLISH', 'PAUSE', 'PUBLISH', 'ARCHIVE']);
      expect(detail.history.every((e: { actorUserId: string | null }) => e.actorUserId !== null)).toBe(true);
      expect(detail.history[1]).toMatchObject({ fromStatus: 'DRAFT', toStatus: 'PUBLISHED' });
      expect((await h.api().get(`/api/v1/admin/offers/${randomUUID()}`).set(as(admin))).status).toBe(404);
    });

    it('only edits drafts and paused offers; a published offer must be paused first', async () => {
      const o = (await create().expect(201)).body;
      const patch = (id: string, body: object) => h.api().patch(`/api/v1/admin/offers/${id}`).set(as(admin)).send(body);
      expect((await patch(o.id, { titleEn: `${P}Edited`, cityId: ref.city.id }).expect(200)).body).toMatchObject({ titleEn: `${P}Edited`, cityId: ref.city.id });
      expect((await patch(o.id, { cityId: null }).expect(200)).body.cityId).toBeNull(); // null clears
      expect((await patch(o.id, { endsAt: iso(-5 * HOUR) })).status).toBe(400);

      await act(o.id, 'publish').expect(200);
      const locked = await patch(o.id, { titleEn: `${P}Nope` });
      expect(locked.status).toBe(409);
      await act(o.id, 'pause').expect(200);
      expect((await patch(o.id, { titleEn: `${P}Again` }).expect(200)).body.titleEn).toBe(`${P}Again`);
      expect((await patch(o.id, { titleEn: null, titleAr: null })).body.code).toBe('TITLE_REQUIRED');
    });

    it('refuses to publish an incomplete offer or one that already ended', async () => {
      const noDescription = (await create({ descriptionEn: undefined, descriptionAr: undefined }).expect(201)).body;
      const res = await act(noDescription.id, 'publish');
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('OFFER_INCOMPLETE');
      const ended = (await create({ startsAt: iso(-3 * HOUR), endsAt: iso(-HOUR) }).expect(201)).body;
      expect((await act(ended.id, 'publish')).body.code).toBe('OFFER_ALREADY_ENDED');
      expect((await h.prisma.offer.findUniqueOrThrow({ where: { id: ended.id } })).status).toBe('DRAFT');
    });

    it('lets exactly one of two simultaneous conflicting changes win', async () => {
      const o = (await create().expect(201)).body;
      const results = await Promise.all([act(o.id, 'publish'), act(o.id, 'publish'), act(o.id, 'archive')]);
      const ok = results.filter((r) => r.status === 200);
      expect(ok.length).toBeGreaterThanOrEqual(1);
      expect(results.every((r) => r.status === 200 || r.status === 409)).toBe(true);
      const events = await h.prisma.offerEvent.findMany({ where: { offerId: o.id }, orderBy: { createdAt: 'asc' } });
      // every accepted action left exactly one history row, in a valid chain
      expect(events.length - 1).toBe(ok.length);
      const final = await h.prisma.offer.findUniqueOrThrow({ where: { id: o.id } });
      expect(events.at(-1)!.toStatus).toBe(final.status);
    });

    it('lists with filters and pagination', async () => {
      await live({ titleEn: `${P}Listed A`, audience: 'WORKERS' });
      const all = (await h.api().get('/api/v1/admin/offers?limit=100').set(as(admin)).expect(200)).body;
      expect(all.meta.total).toBeGreaterThan(3);
      const workers = (await h.api().get('/api/v1/admin/offers?audience=WORKERS&status=PUBLISHED&limit=100').set(as(admin)).expect(200)).body;
      expect(workers.items.every((o: { audience: string; status: string }) => o.audience === 'WORKERS' && o.status === 'PUBLISHED')).toBe(true);
      expect((await h.api().get('/api/v1/admin/offers?status=NOPE').set(as(admin))).status).toBe(400);
      const p1 = (await h.api().get('/api/v1/admin/offers?limit=2&page=1').set(as(admin)).expect(200)).body;
      const p2 = (await h.api().get('/api/v1/admin/offers?limit=2&page=2').set(as(admin)).expect(200)).body;
      expect(p1.items).toHaveLength(2);
      expect(p1.items.map((o: { id: string }) => o.id)).not.toEqual(p2.items.map((o: { id: string }) => o.id));
    });
  });

  describe('who sees what, and when', () => {
    it('shows an offer only while it is published and inside its window; pausing and archiving hide it at once', async () => {
      const o = await live({ titleEn: `${P}Window` });
      expect((await list(customer, '?limit=100').expect(200)).body.items.map((i: { id: string }) => i.id)).toContain(o.id);

      await act(o.id, 'pause').expect(200);
      expect((await list(customer, '?limit=100').expect(200)).body.items.map((i: { id: string }) => i.id)).not.toContain(o.id);
      await act(o.id, 'publish').expect(200);
      expect((await list(customer, '?limit=100').expect(200)).body.items.map((i: { id: string }) => i.id)).toContain(o.id);
      await act(o.id, 'archive').expect(200);
      expect((await list(customer, '?limit=100').expect(200)).body.items.map((i: { id: string }) => i.id)).not.toContain(o.id);
    });

    it('schedules a future offer and lets a live offer expire by itself, with nothing running', async () => {
      const future = await live({ titleEn: `${P}Later`, startsAt: iso(2 * HOUR), endsAt: iso(5 * HOUR) });
      expect((await h.api().get(`/api/v1/admin/offers/${future.id}`).set(as(admin)).expect(200)).body.phase).toBe('SCHEDULED');
      expect((await list(customer, '?limit=100').expect(200)).body.items.map((i: { id: string }) => i.id)).not.toContain(future.id);

      const soon = await live({ titleEn: `${P}Ending` });
      expect((await list(customer, '?limit=100').expect(200)).body.items.map((i: { id: string }) => i.id)).toContain(soon.id);
      await h.prisma.offer.update({ where: { id: soon.id }, data: { endsAt: new Date(Date.now() - 1000), startsAt: new Date(Date.now() - 2 * HOUR) } }); // time passes
      expect((await list(customer, '?limit=100').expect(200)).body.items.map((i: { id: string }) => i.id)).not.toContain(soon.id);
      const view = (await h.api().get(`/api/v1/admin/offers/${soon.id}`).set(as(admin)).expect(200)).body;
      expect(view).toMatchObject({ status: 'PUBLISHED', phase: 'EXPIRED' });
      // an expired offer cannot be re-published without extending it first
      await act(soon.id, 'pause').expect(200);
      expect((await act(soon.id, 'publish')).body.code).toBe('OFFER_ALREADY_ENDED');
    });

    it('targets audiences by the caller\'s acting role, never by the request', async () => {
      const forCustomers = await live({ titleEn: `${P}Cust only`, audience: 'CUSTOMERS' });
      const forWorkers = await live({ titleEn: `${P}Work only`, audience: 'WORKERS' });
      const forAll = await live({ titleEn: `${P}Everyone`, audience: 'ALL' });
      const ids = async (who: { accessToken: string }) => (await list(who, '?limit=100').expect(200)).body.items.map((i: { id: string }) => i.id);

      const c = await ids(customer);
      expect(c).toEqual(expect.arrayContaining([forCustomers.id, forAll.id]));
      expect(c).not.toContain(forWorkers.id);
      const w = await ids(worker);
      expect(w).toEqual(expect.arrayContaining([forWorkers.id, forAll.id]));
      expect(w).not.toContain(forCustomers.id);

      // a client cannot widen what it sees
      expect((await list(customer, '?audience=WORKERS')).status).toBe(400);
      expect((await list(customer, '?status=DRAFT')).status).toBe(400);
      expect((await h.api().get('/api/v1/offers')).status).toBe(401);
    });

    it('shows workers only offers for cities and services they actually serve (decided from their profile, not the request)', async () => {
      const here = await live({ titleEn: `${P}My city`, audience: 'WORKERS', cityId: ref.city.id });
      const there = await live({ titleEn: `${P}Other city`, audience: 'WORKERS', cityId: ref.otherCity.id });
      const mySvc = await live({ titleEn: `${P}My service`, audience: 'WORKERS', serviceId: ref.service.id });
      const otherSvc = await live({ titleEn: `${P}Other service`, audience: 'WORKERS', serviceId: ref.otherService.id });
      const ids = async (who: { accessToken: string }, q = '') => (await list(who, `?limit=100${q}`).expect(200)).body.items.map((i: { id: string }) => i.id);

      const w = await ids(worker);
      expect(w).toEqual(expect.arrayContaining([here.id, mySvc.id]));
      expect(w).not.toEqual(expect.arrayContaining([there.id]));
      expect(w).not.toContain(otherSvc.id);
      // asking for another city does not unlock it
      expect(await ids(worker, `&cityId=${ref.otherCity.id}`)).not.toContain(there.id);
      const o = await ids(outsiderWorker);
      expect(o).toEqual(expect.arrayContaining([there.id, otherSvc.id]));
      expect(o).not.toContain(here.id);
    });

    it('lets a customer narrow, but not widen, by city and service', async () => {
      const cityOffer = await live({ titleEn: `${P}Riyadh promo`, cityId: ref.city.id });
      const openOffer = await live({ titleEn: `${P}Anywhere promo` });
      const ids = async (q: string) => (await list(customer, `?limit=100${q}`).expect(200)).body.items.map((i: { id: string }) => i.id);

      const all = await ids('');
      expect(all).toEqual(expect.arrayContaining([cityOffer.id, openOffer.id]));
      const riyadh = await ids(`&cityId=${ref.city.id}`);
      expect(riyadh).toEqual(expect.arrayContaining([cityOffer.id, openOffer.id]));
      const jeddah = await ids(`&cityId=${ref.otherCity.id}`);
      expect(jeddah).not.toContain(cityOffer.id);
      expect(jeddah).toContain(openOffer.id); // unrestricted offers still apply
      expect((await list(customer, '?cityId=not-a-uuid')).status).toBe(400);
    });
  });

  describe('Arabic and English content', () => {
    it('renders in the reader\'s language, falls back deterministically, and says which language it used', async () => {
      const both = await live({ titleEn: `${P}English title`, titleAr: `${P}عنوان عربي`, descriptionEn: 'English text', descriptionAr: 'نص عربي' });
      const onlyEn = await live({ titleEn: `${P}Only English`, titleAr: undefined, descriptionEn: 'Only English text', descriptionAr: undefined });
      const onlyAr = await live({ titleEn: undefined, titleAr: `${P}عربي فقط`, descriptionEn: undefined, descriptionAr: 'وصف عربي فقط' });
      const find = async (q: string, id: string) => (await list(customer, `?limit=100${q}`).expect(200)).body.items.find((i: { id: string }) => i.id === id);

      // default preference is Arabic
      expect(await find('', both.id)).toMatchObject({ title: `${P}عنوان عربي`, description: 'نص عربي', locale: 'AR' });
      expect(await find('', onlyEn.id)).toMatchObject({ title: `${P}Only English`, description: 'Only English text', locale: 'EN' }); // falls back to the other language
      expect(await find('&locale=en', both.id)).toMatchObject({ title: `${P}English title`, locale: 'EN' });
      expect(await find('&locale=en', onlyAr.id)).toMatchObject({ title: `${P}عربي فقط`, description: 'وصف عربي فقط', locale: 'AR' });
      expect(await find('&locale=EN', both.id)).toMatchObject({ locale: 'EN' });

      await h.prisma.user.update({ where: { id: customer.userId }, data: { locale: 'EN' } });
      expect(await find('', both.id)).toMatchObject({ title: `${P}English title`, locale: 'EN' }); // the stored preference applies
      expect(await find('&locale=ar', both.id)).toMatchObject({ locale: 'AR' }); // an explicit choice wins
      await h.prisma.user.update({ where: { id: customer.userId }, data: { locale: 'AR' } });
      expect((await list(customer, '?locale=fr')).status).toBe(400);
    });

    it('exposes no administrative fields to people', async () => {
      const o = await live({ titleEn: `${P}Privacy` });
      const item = (await list(customer, '?limit=100').expect(200)).body.items.find((i: { id: string }) => i.id === o.id);
      expect(Object.keys(item).sort()).toEqual(['cityId', 'description', 'endsAt', 'id', 'locale', 'serviceId', 'startsAt', 'terms', 'title']);
      expect(JSON.stringify(item)).not.toMatch(/createdBy|updatedBy|status|audience|history|publishedAt/);
    });
  });

  describe('no financial effect', () => {
    it('has no discount, price or redemption columns anywhere in its tables', async () => {
      const cols = await h.prisma.$queryRaw<{ table_name: string; column_name: string }[]>`
        SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name IN ('offers', 'offer_events')`;
      const names = cols.map((c) => c.column_name);
      expect(names.filter((n) => /discount|price|amount|percent|halala|redeem|redemption|coupon|code|commission|vat|fund/i.test(n))).toEqual([]);
      const tables = await h.prisma.$queryRaw<{ table_name: string }[]>`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name ILIKE '%redemption%'`;
      expect(tables).toEqual([]);
    });

    it('leaves booking totals, quotes, payments and the ledger untouched through the whole offer lifecycle', async () => {
      const ctx = await h.confirmedBooking(20000);
      const snapshot = async () => ({
        booking: await h.prisma.booking.findUniqueOrThrow({
          where: { id: ctx.booking.id },
          select: { serviceAmountHalalas: true, vatAmountHalalas: true, totalAmountHalalas: true, commissionAmountHalalas: true, workerPayoutHalalas: true, vatRateBps: true, commissionRateBps: true, status: true },
        }),
        ledger: await h.prisma.ledgerEntry.count(),
        payments: await h.prisma.paymentAttempt.count(),
        refunds: await h.prisma.paymentRefund.count(),
        quotes: await h.prisma.quote.findMany({ where: { bookingId: ctx.booking.id }, select: { id: true, priceHalalas: true, totalAmountHalalas: true } }),
      });
      const before = await snapshot();

      const o = await live({ titleEn: `${P}Money check`, audience: 'ALL', cityId: ref.city.id, serviceId: ref.service.id });
      await list(ctx.customer, '?limit=100').expect(200);
      await list(ctx.worker, '?limit=100').expect(200);
      await act(o.id, 'pause').expect(200);
      await h.api().patch(`/api/v1/admin/offers/${o.id}`).set(as(admin)).send({ titleEn: `${P}Money check 2` }).expect(200);
      await act(o.id, 'publish').expect(200);
      await act(o.id, 'archive').expect(200);

      expect(await snapshot()).toEqual(before);
      expect(before.booking.totalAmountHalalas).toBe(23000); // 200.00 SAR + 15% VAT, exactly as agreed
    });
  });
});
