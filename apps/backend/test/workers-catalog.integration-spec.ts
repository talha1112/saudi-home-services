/**
 * REAL POSTGRESQL, FULL HTTP STACK: service catalog, worker onboarding, admin verification and discovery.
 *
 * Uses the real application (guards, validation, services, Prisma) against TEST_DATABASE_URL.
 * In-memory doubles are used ONLY for Redis (rate limits/OTP), the SMS gateway and, where noted,
 * the document storage, because those are external systems.
 *
 * Safety: needs TEST_DATABASE_URL whose database name ends in "_test" and whose migrations are
 * applied. It never migrates, resets or drops. It creates rows with the reserved prefixes below
 * (slug "itest-", phone "+9665991", email "itest-") and deletes only those.
 */
import { randomInt } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { APP_CONFIG, type AppConfig } from '../src/config/app.config.js';
import { KeyValueStore } from '../src/database/key-value.store.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { Role, UserStatus } from '../src/generated/prisma/client.js';
import { PasswordService } from '../src/modules/auth/password.service.js';
import { SmsProvider } from '../src/modules/auth/sms/sms-provider.js';
import { DisabledDocumentStorage } from '../src/modules/workers/storage/disabled-document-storage.js';
import { DocumentStorage } from '../src/modules/workers/storage/document-storage.js';
import { assertTestDatabaseMigrated, assertTestDatabaseName } from './migration-guard.js';
import { MemoryKeyValueStore } from '../src/testing/memory-key-value.store.js';
import { CapturingSmsProvider } from '../src/testing/test-support.js';
import { purgeAuditLogsSince } from './support/audit-cleanup.js';

const URL_ = process.env['TEST_DATABASE_URL'];
const run = URL_ ? describe : describe.skip;
if (!URL_) console.warn('workers-catalog.integration-spec: TEST_DATABASE_URL is not set, suite skipped');

const SLUG = 'itest-';
const PHONE_PREFIX = '+9665991';
const ADMIN_EMAIL = `itest-admin-${randomInt(100000, 999999)}@example.com`;
const ADMIN_PASSWORD = 'Itest-Admin-Passw0rd-1';

/** Audit rows written by this run belong to the test database only (the name guard in beforeAll guarantees it). */
const startedAt = new Date(Date.now() - 2000);
let app: INestApplication;
let ready = false; // set once the target is verified as a migrated *_test database
let prisma: PrismaService;
let store: MemoryKeyValueStore;
let sms: CapturingSmsProvider;
let phoneCounter = 0;
let ipCounter = 0;
const disabledStorage = new DisabledDocumentStorage();

const api = () => request(app.getHttpServer());
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
const freshIp = () => `10.2.${Math.floor(++ipCounter / 250)}.${(ipCounter % 250) + 1}`;
const freshPhone = () => `${PHONE_PREFIX}${String(10000 + ++phoneCounter + randomInt(0, 80000))}`.slice(0, 13);

interface Session {
  accessToken: string;
  userId: string;
  phone: string;
}

async function otpSignIn(appType: 'customer' | 'worker', phone = freshPhone()): Promise<Session> {
  const ip = freshIp();
  store.deleteByPrefix('otp:cooldown:');
  await api().post('/api/v1/auth/otp/request').set('X-Forwarded-For', ip).send({ phone, app: appType }).expect(200);
  const res = await api()
    .post('/api/v1/auth/otp/verify')
    .set('X-Forwarded-For', ip)
    .send({ phone, code: sms.lastCode(phone), app: appType })
    .expect(200);
  return { accessToken: res.body.accessToken, userId: res.body.user.id, phone };
}

async function adminLogin(): Promise<string> {
  const res = await api()
    .post('/api/v1/auth/admin/login')
    .set('X-Forwarded-For', freshIp())
    .send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD })
    .expect(200);
  return res.body.accessToken;
}

async function cleanup() {
  await prisma.user.deleteMany({
    where: { OR: [{ phone: { startsWith: PHONE_PREFIX } }, { email: { startsWith: 'itest-' } }] },
  });
  await prisma.service.deleteMany({ where: { slug: { startsWith: SLUG } } });
  await prisma.serviceCategory.deleteMany({ where: { slug: { startsWith: SLUG } } });
  await prisma.city.deleteMany({ where: { slug: { startsWith: SLUG } } });
}

run('catalog + worker onboarding + verification (real PostgreSQL, full HTTP stack)', () => {
  let adminToken: string;
  let category: { id: string };
  let service: { id: string };
  let service2: { id: string };
  let city: { id: string };
  let city2: { id: string };

  beforeAll(async () => {
    const dbName = decodeURIComponent(new URL(URL_!).pathname.slice(1));
    assertTestDatabaseName(dbName);

    process.env['NODE_ENV'] = 'test';
    process.env['LOG_LEVEL'] = 'silent';
    process.env['DATABASE_URL'] = URL_!;
    process.env['REDIS_URL'] = 'redis://127.0.0.1:1'; // unused: the key-value store is replaced
    process.env['JWT_ACCESS_SECRET'] = 'itest-access-secret-itest-access-secret-0123456789';
    process.env['OTP_HMAC_SECRET'] = 'itest-otp-secret-itest-otp-secret-0123456789abcdef';
    process.env['TRUST_PROXY_HOPS'] = '1';
    process.env['SWAGGER_ENABLED'] = 'false';

    store = new MemoryKeyValueStore();
    sms = new CapturingSmsProvider();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(KeyValueStore)
      .useValue(store)
      .overrideProvider(SmsProvider)
      .useValue(sms)
      .compile();
    app = moduleRef.createNestApplication();
    configureApp(app, app.get(ConfigService).getOrThrow<AppConfig>(APP_CONFIG));
    await app.init();
    prisma = app.get(PrismaService);
    await assertTestDatabaseMigrated(prisma);
    ready = true;
    await cleanup();

    // An administrator, created directly (the bootstrap CLI refuses when an admin already exists).
    const passwords = app.get(PasswordService);
    await prisma.user.create({
      data: {
        email: ADMIN_EMAIL,
        passwordHash: await passwords.hash(ADMIN_PASSWORD),
        status: UserStatus.ACTIVE,
        roles: { create: [{ role: Role.ADMIN }] },
      },
    });
    adminToken = await adminLogin();

    // Reference data through the admin API itself.
    category = (
      await api()
        .post('/api/v1/admin/service-categories')
        .set(bearer(adminToken))
        .send({ slug: `${SLUG}electrical`, nameEn: 'Electrical (test)', nameAr: 'الكهرباء (اختبار)', iconKey: 'bolt' })
        .expect(201)
    ).body;
    service = (
      await api()
        .post('/api/v1/admin/services')
        .set(bearer(adminToken))
        .send({ categoryId: category.id, slug: `${SLUG}wiring`, nameEn: 'Wiring', nameAr: 'تمديدات', sortOrder: 1 })
        .expect(201)
    ).body;
    service2 = (
      await api()
        .post('/api/v1/admin/services')
        .set(bearer(adminToken))
        .send({ categoryId: category.id, slug: `${SLUG}lighting`, nameEn: 'Lighting', nameAr: 'إضاءة', sortOrder: 2 })
        .expect(201)
    ).body;
    city = (
      await api().post('/api/v1/admin/cities').set(bearer(adminToken)).send({ slug: `${SLUG}riyadh`, nameEn: 'Riyadh (test)', nameAr: 'الرياض (اختبار)' }).expect(201)
    ).body;
    city2 = (
      await api().post('/api/v1/admin/cities').set(bearer(adminToken)).send({ slug: `${SLUG}jeddah`, nameEn: 'Jeddah (test)', nameAr: 'جدة (اختبار)' }).expect(201)
    ).body;
  });

  afterAll(async () => {
    if (prisma && ready) {
      await cleanup();
      // Audit rows lose their link to deleted users, so remove this run's rows by time window.
      await purgeAuditLogsSince(prisma, startedAt);
      await prisma.storageDeletion.deleteMany({ where: { createdAt: { gte: startedAt } } }); // document deletions queue a removal row
    }
    await app?.close();
  });

  // ------------------------------------------------------------------ authz

  describe('authorization', () => {
    it('requires a token for every admin, worker and discovery endpoint', async () => {
      const id = '6f1c2f0e-6d4a-4a39-9d1e-0f6b1a9a0001';
      const calls: [string, string][] = [
        ['get', '/api/v1/admin/cities'],
        ['post', '/api/v1/admin/cities'],
        ['get', '/api/v1/admin/service-categories'],
        ['get', '/api/v1/admin/services'],
        ['get', '/api/v1/admin/workers'],
        ['get', `/api/v1/admin/workers/${id}`],
        ['post', `/api/v1/admin/workers/${id}/approve`],
        ['get', '/api/v1/workers/me/onboarding'],
        ['put', '/api/v1/workers/me/services'],
        ['post', '/api/v1/workers/me/verification/submit'],
        ['get', '/api/v1/discovery/workers'],
      ];
      for (const [method, url] of calls) {
        const res = await (api() as any)[method](url).send({});
        expect({ url, status: res.status, code: res.body.code }).toEqual({ url, status: 401, code: 'AUTH_REQUIRED' });
      }
    });

    it('keeps customers and workers out of every admin endpoint', async () => {
      const customer = await otpSignIn('customer');
      const worker = await otpSignIn('worker');
      const id = '6f1c2f0e-6d4a-4a39-9d1e-0f6b1a9a0001';
      const calls: [string, string][] = [
        ['get', '/api/v1/admin/cities'],
        ['post', '/api/v1/admin/cities'],
        ['patch', `/api/v1/admin/cities/${id}`],
        ['get', '/api/v1/admin/service-categories'],
        ['post', '/api/v1/admin/service-categories'],
        ['get', '/api/v1/admin/services'],
        ['patch', `/api/v1/admin/services/${id}`],
        ['get', '/api/v1/admin/workers'],
        ['get', `/api/v1/admin/workers/${id}`],
        ['post', `/api/v1/admin/workers/${id}/approve`],
        ['post', `/api/v1/admin/workers/${id}/reject`],
        ['post', `/api/v1/admin/workers/${id}/suspend`],
        ['post', `/api/v1/admin/workers/${id}/reinstate`],
        ['patch', `/api/v1/admin/workers/${id}/documents/${id}`],
        ['get', `/api/v1/admin/workers/${id}/documents/${id}/download-url`],
      ];
      for (const who of [customer, worker]) {
        for (const [method, url] of calls) {
          const res = await (api() as any)[method](url).set(bearer(who.accessToken)).send({});
          expect({ url, status: res.status, code: res.body.code }).toEqual({ url, status: 403, code: 'INSUFFICIENT_ROLE' });
        }
      }
    });

    it('keeps worker onboarding for worker sessions and discovery for customers/admins', async () => {
      const customer = await otpSignIn('customer');
      const worker = await otpSignIn('worker');
      await api().get('/api/v1/workers/me/onboarding').set(bearer(customer.accessToken)).expect(403);
      await api().get('/api/v1/workers/me/onboarding').set(bearer(adminToken)).expect(403);
      await api().get('/api/v1/discovery/workers').set(bearer(worker.accessToken)).expect(403);
      await api().get('/api/v1/discovery/workers').set(bearer(customer.accessToken)).expect(200);
      await api().get('/api/v1/discovery/workers').set(bearer(adminToken)).expect(200);
    });
  });

  // ---------------------------------------------------------------- catalog

  describe('catalog management', () => {
    it('stores English and Arabic content and serves it publicly without sign-in', async () => {
      const res = await api().get('/api/v1/catalog').set('X-Forwarded-For', freshIp()).expect(200);
      const mine = res.body.categories.find((c: any) => c.slug === `${SLUG}electrical`);
      expect(mine).toMatchObject({ nameEn: 'Electrical (test)', nameAr: 'الكهرباء (اختبار)', iconKey: 'bolt' });
      expect(mine.services.map((s: any) => s.slug)).toEqual([`${SLUG}wiring`, `${SLUG}lighting`]);
      const cities = await api().get('/api/v1/catalog/cities').set('X-Forwarded-For', freshIp()).expect(200);
      expect(cities.body.items.map((c: any) => c.slug)).toEqual(expect.arrayContaining([`${SLUG}riyadh`, `${SLUG}jeddah`]));
    });

    it('rejects duplicate slugs and invalid input with clear errors', async () => {
      const dup = await api()
        .post('/api/v1/admin/cities')
        .set(bearer(adminToken))
        .send({ slug: `${SLUG}riyadh`, nameEn: 'Again', nameAr: 'مرة أخرى' })
        .expect(409);
      expect(dup.body.code).toBe('SLUG_TAKEN');

      await api().post('/api/v1/admin/cities').set(bearer(adminToken)).send({ slug: 'Bad Slug!', nameEn: 'X', nameAr: 'س' }).expect(400);
      await api().post('/api/v1/admin/cities').set(bearer(adminToken)).send({ slug: 'ok', nameEn: 'Fine', nameAr: 'جيد', evil: true }).expect(400);
      await api()
        .post('/api/v1/admin/services')
        .set(bearer(adminToken))
        .send({ categoryId: '6f1c2f0e-6d4a-4a39-9d1e-0f6b1a9a0001', slug: `${SLUG}orphan`, nameEn: 'Orphan', nameAr: 'يتيم' })
        .expect(404);
    });

    it('paginates and filters', async () => {
      const page = await api().get('/api/v1/admin/services?limit=1&page=2&q=itest').set(bearer(adminToken)).expect(200);
      expect(page.body.items).toHaveLength(1);
      expect(page.body.meta).toMatchObject({ page: 2, limit: 1, total: 2, totalPages: 2 });

      const byCategory = await api().get(`/api/v1/admin/services?categoryId=${category.id}`).set(bearer(adminToken)).expect(200);
      expect(byCategory.body.meta.total).toBe(2);
      await api().get('/api/v1/admin/services?limit=1000').set(bearer(adminToken)).expect(400);
      await api().get('/api/v1/admin/services?isActive=maybe').set(bearer(adminToken)).expect(400);
    });

    it('hides deactivated items from the public catalog but keeps them in the admin list', async () => {
      const extra = (
        await api()
          .post('/api/v1/admin/services')
          .set(bearer(adminToken))
          .send({ categoryId: category.id, slug: `${SLUG}retired`, nameEn: 'Retired', nameAr: 'متوقف' })
          .expect(201)
      ).body;
      await api().patch(`/api/v1/admin/services/${extra.id}`).set(bearer(adminToken)).send({ isActive: false }).expect(200);
      const catalog = await api().get('/api/v1/catalog').set('X-Forwarded-For', freshIp()).expect(200);
      const mine = catalog.body.categories.find((c: any) => c.slug === `${SLUG}electrical`);
      expect(mine.services.map((s: any) => s.slug)).not.toContain(`${SLUG}retired`);
      const admin = await api().get('/api/v1/admin/services?isActive=false&q=retired').set(bearer(adminToken)).expect(200);
      expect(admin.body.items).toHaveLength(1);
      // The slug cannot be changed through the API.
      await api().patch(`/api/v1/admin/services/${extra.id}`).set(bearer(adminToken)).send({ slug: 'changed' }).expect(400);
    });
  });

  // ------------------------------------------------------------- the workflow

  describe('worker onboarding and verification workflow', () => {
    let worker: Session;
    let workerId: string;
    let docId: string;
    const adminPost = (path: string, body: object = {}) => api().post(`/api/v1/admin/workers/${workerId}/${path}`).set(bearer(adminToken)).send(body);

    beforeAll(async () => {
      worker = await otpSignIn('worker');
      workerId = (await api().get('/api/v1/workers/me/onboarding').set(bearer(worker.accessToken)).expect(200)).body.profile.id;
    });

    it('starts empty and cannot be submitted, listing exactly what is missing', async () => {
      const status = (await api().get('/api/v1/workers/me/verification').set(bearer(worker.accessToken)).expect(200)).body;
      expect(status).toMatchObject({ status: 'NOT_SUBMITTED', canSubmit: false });
      expect(status.missing).toEqual(
        expect.arrayContaining(['FULL_NAME', 'YEARS_OF_EXPERIENCE', 'SERVICES', 'SERVICE_AREAS', 'AVAILABILITY', 'IDENTITY_DOCUMENT']),
      );
      const res = await api().post('/api/v1/workers/me/verification/submit').set(bearer(worker.accessToken)).expect(409);
      expect(res.body.code).toBe('VERIFICATION_INCOMPLETE');
      expect(res.body.details.missing).toContain('SERVICES');
    });

    it('validates onboarding input', async () => {
      const put = (path: string, body: object) => api().put(`/api/v1/workers/me/${path}`).set(bearer(worker.accessToken)).send(body);
      expect((await put('services', { services: [] })).status).toBe(400);
      expect((await put('services', { services: [{ serviceId: 'nope' }] })).status).toBe(400);
      expect((await put('services', { services: [{ serviceId: service.id }, { serviceId: service.id }] })).body.code).toBe('DUPLICATE_SERVICE');
      expect((await put('services', { services: [{ serviceId: '6f1c2f0e-6d4a-4a39-9d1e-0f6b1a9a0001' }] })).body.code).toBe('INVALID_SERVICE');
      expect((await put('areas', { cityIds: [] })).status).toBe(400);
      expect((await put('areas', { cityIds: ['6f1c2f0e-6d4a-4a39-9d1e-0f6b1a9a0001'] })).body.code).toBe('INVALID_CITY');
      expect((await put('availability', { windows: [{ dayOfWeek: 7, startTime: '08:00', endTime: '12:00' }] })).status).toBe(400);
      expect((await put('availability', { windows: [{ dayOfWeek: 1, startTime: '12:00', endTime: '08:00' }] })).body.code).toBe('INVALID_AVAILABILITY');
      expect((await put('availability', { windows: [{ dayOfWeek: 1, startTime: '08:00', endTime: '12:00' }, { dayOfWeek: 1, startTime: '11:00', endTime: '15:00' }] })).body.code).toBe('INVALID_AVAILABILITY');
      expect((await put('profile', { yearsOfExperience: 99 })).status).toBe(400);
      expect((await put('profile', { role: 'ADMIN' })).status).toBe(400);
    });

    it('refuses inactive services and cities', async () => {
      const inactive = (
        await api()
          .post('/api/v1/admin/services')
          .set(bearer(adminToken))
          .send({ categoryId: category.id, slug: `${SLUG}inactive-svc`, nameEn: 'Off', nameAr: 'مغلق', isActive: false })
          .expect(201)
      ).body;
      const res = await api().put('/api/v1/workers/me/services').set(bearer(worker.accessToken)).send({ services: [{ serviceId: inactive.id }] }).expect(400);
      expect(res.body.code).toBe('INVALID_SERVICE');
    });

    it('lets the worker fill in profile, services, areas and availability', async () => {
      const t = bearer(worker.accessToken);
      await api().put('/api/v1/workers/me/profile').set(t).send({ fullName: 'Ahmed Itest', fullNameAr: 'أحمد', bio: 'Licensed electrician', yearsOfExperience: 8 }).expect(200);
      await api().put('/api/v1/workers/me/services').set(t).send({ services: [{ serviceId: service.id, yearsOfExperience: 6 }, { serviceId: service2.id }] }).expect(200);
      await api().put('/api/v1/workers/me/areas').set(t).send({ cityIds: [city.id] }).expect(200);
      const res = await api()
        .put('/api/v1/workers/me/availability')
        .set(t)
        .send({ windows: [{ dayOfWeek: 0, startTime: '08:00', endTime: '17:00' }, { dayOfWeek: 1, startTime: '08:00', endTime: '12:00' }, { dayOfWeek: 1, startTime: '14:00', endTime: '18:00' }] })
        .expect(200);
      expect(res.body.availability).toHaveLength(3);
      expect(res.body.services.map((s: any) => s.slug)).toEqual([`${SLUG}wiring`, `${SLUG}lighting`]);
      expect(res.body.services[0].workerYearsOfExperience).toBe(6);
      expect(res.body.verification.missing).toEqual(['IDENTITY_DOCUMENT']);
      // Replacing really replaces.
      const again = await api().put('/api/v1/workers/me/areas').set(t).send({ cityIds: [city.id, city2.id] }).expect(200);
      expect(again.body.cities).toHaveLength(2);
      await api().put('/api/v1/workers/me/areas').set(t).send({ cityIds: [city.id] }).expect(200);
    });

    it('registers and confirms an identity document without ever exposing storage details', async () => {
      const t = bearer(worker.accessToken);
      const bad = await api().post('/api/v1/workers/me/documents').set(t).send({ type: 'IQAMA', fileName: '../x.exe', mimeType: 'application/x-msdownload', sizeBytes: 100 });
      expect(bad.status).toBe(400);

      const reg = await api()
        .post('/api/v1/workers/me/documents')
        .set(t)
        .send({ type: 'IQAMA', fileName: 'iqama.jpg', mimeType: 'image/jpeg', sizeBytes: 123456, expiresOn: '2030-01-31' })
        .expect(201);
      docId = reg.body.document.id;
      expect(reg.body).toMatchObject({ method: 'PUT', document: { status: 'PENDING_UPLOAD', expiresOn: '2030-01-31' } });
      expect(reg.body.uploadUrl).toContain('/upload/');
      expect(JSON.stringify(reg.body.document)).not.toMatch(/storageKey|workers\//);

      const confirmed = await api().post(`/api/v1/workers/me/documents/${docId}/confirm`).set(t).send({}).expect(200);
      expect(confirmed.body.status).toBe('UPLOADED');

      const list = await api().get('/api/v1/workers/me/documents').set(t).expect(200);
      expect(JSON.stringify(list.body)).not.toMatch(/storageKey|checksum|workers\//);
    });

    it('does not let another worker or a customer touch this worker\'s documents', async () => {
      const other = await otpSignIn('worker');
      await api().post(`/api/v1/workers/me/documents/${docId}/confirm`).set(bearer(other.accessToken)).send({}).expect(404);
      await api().delete(`/api/v1/workers/me/documents/${docId}`).set(bearer(other.accessToken)).expect(404);
      const list = await api().get('/api/v1/workers/me/documents').set(bearer(other.accessToken)).expect(200);
      expect(list.body.items).toHaveLength(0);
    });

    it('submits the application and shows it in the admin queue', async () => {
      const res = await api().post('/api/v1/workers/me/verification/submit').set(bearer(worker.accessToken)).expect(200);
      expect(res.body).toMatchObject({ status: 'SUBMITTED', canSubmit: false });
      expect(res.body.history[0]).toMatchObject({ action: 'SUBMITTED', fromStatus: 'NOT_SUBMITTED', toStatus: 'SUBMITTED' });
      // Cannot submit twice.
      expect((await api().post('/api/v1/workers/me/verification/submit').set(bearer(worker.accessToken))).body.code).toBe('INVALID_STATE');

      const queue = await api().get('/api/v1/admin/workers?q=Itest').set(bearer(adminToken)).expect(200);
      expect(queue.body.items.map((w: any) => w.id)).toContain(workerId);
      expect(queue.body.items.find((w: any) => w.id === workerId)).toMatchObject({ verificationStatus: 'SUBMITTED', serviceCount: 2, cityCount: 1, documentCount: 1 });
      // Filters
      expect((await api().get(`/api/v1/admin/workers?status=APPROVED&q=Itest`).set(bearer(adminToken)).expect(200)).body.items).toHaveLength(0);
      expect((await api().get(`/api/v1/admin/workers?status=ALL&cityId=${city.id}&serviceId=${service.id}`).set(bearer(adminToken)).expect(200)).body.items.map((w: any) => w.id)).toContain(workerId);
      await api().get('/api/v1/admin/workers?status=BOGUS').set(bearer(adminToken)).expect(400);
    });

    it('is not visible to customers or usable for jobs before approval', async () => {
      const customer = await otpSignIn('customer');
      const list = await api().get(`/api/v1/discovery/workers?cityId=${city.id}`).set(bearer(customer.accessToken)).expect(200);
      expect(list.body.items).toHaveLength(0);
      await api().get(`/api/v1/discovery/workers/${workerId}`).set(bearer(customer.accessToken)).expect(404);
      const jobs = await api().get('/api/v1/workers/me/jobs').set(bearer(worker.accessToken)).expect(403);
      expect(jobs.body.code).toBe('WORKER_NOT_APPROVED');
    });

    it('reviews: start, refuses approval until the identity document is accepted, then approves', async () => {
      const started = await adminPost('start-review').expect(200);
      expect(started.body.verificationStatus).toBe('UNDER_REVIEW');
      // start-review is only valid from SUBMITTED
      expect((await adminPost('start-review')).body.code).toBe('INVALID_STATE');

      const early = await adminPost('approve').expect(409);
      expect(early.body.code).toBe('IDENTITY_DOCUMENT_NOT_ACCEPTED');

      expect((await api().patch(`/api/v1/admin/workers/${workerId}/documents/${docId}`).set(bearer(adminToken)).send({ status: 'REJECTED' })).body.code).toBe('REASON_REQUIRED');
      const accepted = await api().patch(`/api/v1/admin/workers/${workerId}/documents/${docId}`).set(bearer(adminToken)).send({ status: 'ACCEPTED', note: 'Clear photo' }).expect(200);
      expect(accepted.body).toMatchObject({ status: 'ACCEPTED', reviewNote: 'Clear photo' });

      const approved = await adminPost('approve', { reason: 'Documents verified' }).expect(200);
      expect(approved.body).toMatchObject({ verificationStatus: 'APPROVED', verificationNote: 'Documents verified' });
      expect(approved.body.verifiedAt).not.toBeNull();
      expect(approved.body.history.map((h: any) => h.action)).toEqual(['APPROVED', 'REVIEW_STARTED', 'SUBMITTED']);
      expect(approved.body.history[0]).toMatchObject({ reason: 'Documents verified' });
      expect(approved.body.history[0].actorUserId).not.toBeNull();
    });

    it('rejects invalid transitions and handles simultaneous decisions safely', async () => {
      expect((await adminPost('approve')).body.code).toBe('INVALID_STATE'); // already approved
      expect((await adminPost('reject', { reason: 'late' })).body.code).toBe('INVALID_STATE');
      expect((await adminPost('reinstate')).body.code).toBe('INVALID_STATE'); // not suspended

      // A second worker, approved by two admins at the same instant: exactly one wins.
      const racer = await otpSignIn('worker');
      const racerId = (await api().get('/api/v1/workers/me/onboarding').set(bearer(racer.accessToken))).body.profile.id;
      await prisma.user.update({ where: { id: racer.userId }, data: { fullName: 'Racer Itest' } });
      await prisma.workerProfile.update({ where: { id: racerId }, data: { yearsOfExperience: 2, verificationStatus: 'SUBMITTED' } });
      await prisma.workerService.create({ data: { workerProfileId: racerId, serviceId: service.id } });
      await prisma.workerServiceArea.create({ data: { workerProfileId: racerId, cityId: city.id } });
      await prisma.workerAvailability.create({ data: { workerProfileId: racerId, dayOfWeek: 2, startMinute: 480, endMinute: 600 } });
      const doc = await prisma.workerVerificationDocument.create({
        data: { workerProfileId: racerId, type: 'NATIONAL_ID', status: 'ACCEPTED', storageKey: `workers/${racerId}/documents/itest`, fileName: 'id.png', mimeType: 'image/png', sizeBytes: 10 },
      });
      expect(doc.id).toBeDefined();
      const results = await Promise.all([
        api().post(`/api/v1/admin/workers/${racerId}/approve`).set(bearer(adminToken)).send({}),
        api().post(`/api/v1/admin/workers/${racerId}/approve`).set(bearer(adminToken)).send({}),
        api().post(`/api/v1/admin/workers/${racerId}/reject`).set(bearer(adminToken)).send({ reason: 'racing' }),
      ]);
      const statuses = results.map((r) => r.status).sort();
      expect(statuses.filter((s) => s === 200)).toHaveLength(1);
      expect(statuses.filter((s) => s === 409)).toHaveLength(2);
      const events = await prisma.workerVerificationEvent.findMany({ where: { workerProfileId: racerId } });
      expect(events).toHaveLength(1); // one decision, one history row
    });

    it('shows approved workers to customers with public data only', async () => {
      const customer = await otpSignIn('customer');
      const t = bearer(customer.accessToken);
      const list = await api().get(`/api/v1/discovery/workers?cityId=${city.id}&serviceId=${service.id}`).set(t).expect(200);
      const mine = list.body.items.find((w: any) => w.id === workerId);
      expect(mine).toMatchObject({ fullName: 'Ahmed Itest', fullNameAr: 'أحمد', yearsOfExperience: 8 });
      expect(mine.services.map((s: any) => s.slug)).toEqual(expect.arrayContaining([`${SLUG}wiring`]));
      expect(mine.cities.map((c: any) => c.slug)).toEqual([`${SLUG}riyadh`]);

      const detail = await api().get(`/api/v1/discovery/workers/${workerId}`).set(t).expect(200);
      const everything = JSON.stringify([list.body, detail.body]);
      // No contact details, account ids, documents, review data or storage information.
      for (const secret of [worker.phone, worker.userId, 'storageKey', 'workers/', 'iqama.jpg', 'verification', 'Documents verified', 'phone', 'email', 'userId']) {
        expect(everything).not.toContain(secret);
      }
      // Filters exclude non-matching workers.
      expect((await api().get(`/api/v1/discovery/workers?cityId=${city2.id}`).set(t).expect(200)).body.items.map((w: any) => w.id)).not.toContain(workerId);
      expect((await api().get(`/api/v1/discovery/workers?categoryId=${category.id}&onlineOnly=true`).set(t).expect(200)).body.items.map((w: any) => w.id)).not.toContain(workerId);
      expect((await api().get(`/api/v1/discovery/workers?categoryId=${category.id}`).set(t).expect(200)).body.items.map((w: any) => w.id)).toContain(workerId);
    });

    it('now lets the approved worker use job operations', async () => {
      await api().get('/api/v1/workers/me/jobs').set(bearer(worker.accessToken)).expect(200);
    });

    it('lets an administrator view private documents only through an audited, short-lived link', async () => {
      const detail = await api().get(`/api/v1/admin/workers/${workerId}`).set(bearer(adminToken)).expect(200);
      expect(detail.body.documents[0]).toMatchObject({ id: docId, type: 'IQAMA', status: 'ACCEPTED' });
      expect(detail.body.phone).toBe(worker.phone);
      expect(JSON.stringify(detail.body)).not.toMatch(/storageKey|checksum|workers\/[0-9a-f-]+\/documents/);

      const link = await api().get(`/api/v1/admin/workers/${workerId}/documents/${docId}/download-url`).set(bearer(adminToken)).expect(200);
      expect(link.body.url).toContain('/download/');
      expect(new Date(link.body.expiresAt).getTime()).toBeGreaterThan(Date.now());
      const audit = await prisma.auditLog.findMany({ where: { action: 'worker.document.accessed', entityId: docId } });
      expect(audit).toHaveLength(1);
      expect(audit[0].actorUserId).not.toBeNull();
      expect(JSON.stringify(audit[0])).not.toContain(link.body.url);

      // Wrong worker/document pair does not leak existence.
      const other = await otpSignIn('worker');
      const otherId = (await api().get('/api/v1/workers/me/onboarding').set(bearer(other.accessToken))).body.profile.id;
      await api().get(`/api/v1/admin/workers/${otherId}/documents/${docId}/download-url`).set(bearer(adminToken)).expect(404);
    });

    it('fails closed with 503 while no document storage is configured', async () => {
      // Swap the storage adapter on the running app for the production default.
      const real = app.get(DocumentStorage);
      const spies = ['createUploadTarget', 'exists', 'createDownloadTarget', 'delete'] as const;
      const originals = spies.map((m) => (real as any)[m]);
      spies.forEach((m) => ((real as any)[m] = (disabledStorage as any)[m].bind(disabledStorage)));
      try {
        const w = await otpSignIn('worker');
        const reg = await api().post('/api/v1/workers/me/documents').set(bearer(w.accessToken)).send({ type: 'NATIONAL_ID', fileName: 'id.png', mimeType: 'image/png', sizeBytes: 5000 });
        expect(reg.status).toBe(503);
        expect(reg.body.code).toBe('DOCUMENT_STORAGE_NOT_CONFIGURED');
        const dl = await api().get(`/api/v1/admin/workers/${workerId}/documents/${docId}/download-url`).set(bearer(adminToken));
        expect(dl.status).toBe(503);
        // Nothing half-created.
        const profile = await prisma.workerProfile.findUniqueOrThrow({ where: { userId: w.userId } });
        expect(await prisma.workerVerificationDocument.count({ where: { workerProfileId: profile.id } })).toBe(0);
      } finally {
        spies.forEach((m, i) => ((real as any)[m] = originals[i]));
      }
    });

    it('suspends with a mandatory reason, removing the worker everywhere that matters', async () => {
      expect((await adminPost('suspend')).body.code).toBe('REASON_REQUIRED');
      const suspended = await adminPost('suspend', { reason: 'Customer complaints under investigation' }).expect(200);
      expect(suspended.body.verificationStatus).toBe('SUSPENDED');

      const customer = await otpSignIn('customer');
      await api().get(`/api/v1/discovery/workers/${workerId}`).set(bearer(customer.accessToken)).expect(404);
      expect((await api().get(`/api/v1/discovery/workers?cityId=${city.id}`).set(bearer(customer.accessToken)).expect(200)).body.items.map((w: any) => w.id)).not.toContain(workerId);

      expect((await api().get('/api/v1/workers/me/jobs').set(bearer(worker.accessToken)).expect(403)).body.code).toBe('WORKER_NOT_APPROVED');
      const edit = await api().put('/api/v1/workers/me/profile').set(bearer(worker.accessToken)).send({ bio: 'trying to edit' }).expect(403);
      expect(edit.body.code).toBe('WORKER_SUSPENDED');
      await api().post('/api/v1/workers/me/verification/submit').set(bearer(worker.accessToken)).expect(403);

      const status = (await api().get('/api/v1/workers/me/verification').set(bearer(worker.accessToken)).expect(200)).body;
      expect(status).toMatchObject({ status: 'SUSPENDED', note: 'Customer complaints under investigation' });
    });

    it('reinstates a suspended worker', async () => {
      expect((await adminPost('request-info', { reason: 'x' })).body.code).toBe('INVALID_STATE');
      await adminPost('reinstate', { reason: 'Investigation closed' }).expect(200);
      await api().get('/api/v1/workers/me/jobs').set(bearer(worker.accessToken)).expect(200);
      const customer = await otpSignIn('customer');
      await api().get(`/api/v1/discovery/workers/${workerId}`).set(bearer(customer.accessToken)).expect(200);
    });

    it('keeps a complete, ordered history of decisions with reasons', async () => {
      const detail = (await api().get(`/api/v1/admin/workers/${workerId}`).set(bearer(adminToken)).expect(200)).body;
      expect(detail.history.map((h: any) => h.action)).toEqual(['REINSTATED', 'SUSPENDED', 'APPROVED', 'REVIEW_STARTED', 'SUBMITTED']);
      expect(detail.history[1]).toMatchObject({ reason: 'Customer complaints under investigation', fromStatus: 'APPROVED', toStatus: 'SUSPENDED' });
      const worker_ = (await api().get('/api/v1/workers/me/verification').set(bearer(worker.accessToken)).expect(200)).body;
      // Workers see what happened and why, but not which admin decided.
      expect(JSON.stringify(worker_.history)).not.toMatch(/actor/i);
      const audit = await prisma.auditLog.findMany({ where: { entityType: 'worker_profile', entityId: workerId }, orderBy: { createdAt: 'asc' } });
      expect(audit.map((a) => a.action)).toEqual(
        expect.arrayContaining(['worker.verification.submitted', 'worker.verification.start_review', 'worker.verification.approve', 'worker.verification.suspend', 'worker.verification.reinstate']),
      );
      // The reason text lives in the history table; the audit log only records that one was given.
      expect(JSON.stringify(audit)).not.toContain('Customer complaints');
    });

    it('lets a rejected worker see the reason, fix things and resubmit', async () => {
      const w = await otpSignIn('worker');
      const t = bearer(w.accessToken);
      const profileId = (await api().get('/api/v1/workers/me/onboarding').set(t)).body.profile.id;
      await api().put('/api/v1/workers/me/profile').set(t).send({ fullName: 'Resubmit Itest', yearsOfExperience: 3 }).expect(200);
      await api().put('/api/v1/workers/me/services').set(t).send({ services: [{ serviceId: service.id }] }).expect(200);
      await api().put('/api/v1/workers/me/areas').set(t).send({ cityIds: [city.id] }).expect(200);
      await api().put('/api/v1/workers/me/availability').set(t).send({ windows: [{ dayOfWeek: 3, startTime: '09:00', endTime: '13:00' }] }).expect(200);
      const d = (await api().post('/api/v1/workers/me/documents').set(t).send({ type: 'NATIONAL_ID', fileName: 'id.pdf', mimeType: 'application/pdf', sizeBytes: 2048 }).expect(201)).body.document;
      await api().post(`/api/v1/workers/me/documents/${d.id}/confirm`).set(t).send({}).expect(200);
      await api().post('/api/v1/workers/me/verification/submit').set(t).expect(200);

      const reject = await api().post(`/api/v1/admin/workers/${profileId}/reject`).set(bearer(adminToken)).send({ reason: 'Photo is blurry' }).expect(200);
      expect(reject.body.verificationStatus).toBe('REJECTED');

      const status = (await api().get('/api/v1/workers/me/verification').set(t).expect(200)).body;
      expect(status).toMatchObject({ status: 'REJECTED', note: 'Photo is blurry', canSubmit: true });
      // Documents can be replaced after a rejection...
      await api().delete(`/api/v1/workers/me/documents/${d.id}`).set(t).expect(204);
      expect((await api().post('/api/v1/workers/me/verification/submit').set(t).expect(409)).body.details.missing).toContain('IDENTITY_DOCUMENT');
      const d2 = (await api().post('/api/v1/workers/me/documents').set(t).send({ type: 'NATIONAL_ID', fileName: 'id2.pdf', mimeType: 'application/pdf', sizeBytes: 2048 }).expect(201)).body.document;
      await api().post(`/api/v1/workers/me/documents/${d2.id}/confirm`).set(t).send({}).expect(200);
      expect((await api().post('/api/v1/workers/me/verification/submit').set(t).expect(200)).body.status).toBe('SUBMITTED');

      // ...but not while a review is running.
      await api().delete(`/api/v1/workers/me/documents/${d2.id}`).set(t).expect(409);

      const info = await api().post(`/api/v1/admin/workers/${profileId}/request-info`).set(bearer(adminToken)).send({ reason: 'Please add a licence' }).expect(200);
      expect(info.body.verificationStatus).toBe('INFO_REQUIRED');
      expect((await api().post(`/api/v1/admin/workers/${profileId}/request-info`).set(bearer(adminToken)).send({})).body.code).toMatch(/REASON_REQUIRED|INVALID_STATE/);
    });
  });
});
