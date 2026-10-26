/**
 * Shared setup for the booking integration suites (REAL PostgreSQL, full HTTP stack).
 *
 * Real: PostgreSQL (TEST_DATABASE_URL, name must be exactly home_services_test), Prisma, every guard, service and
 * constraint. Doubles: the key-value store (rate limits/OTP), the SMS gateway, document storage (dev adapter).
 * Each suite passes its own phone and slug prefixes and only ever deletes rows carrying them.
 */
import { randomInt } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import { configureApp } from '../../src/app.setup.js';
import { APP_CONFIG, type AppConfig } from '../../src/config/app.config.js';
import { KeyValueStore } from '../../src/database/key-value.store.js';
import { PrismaService } from '../../src/database/prisma.service.js';
import { Role, UserStatus, WorkerVerificationStatus } from '../../src/generated/prisma/client.js';
import { PasswordService } from '../../src/modules/auth/password.service.js';
import { FirebaseIdentityVerifier } from '../../src/modules/auth/firebase/firebase-identity-verifier.js';
import { PushProvider } from '../../src/modules/notifications/push/push-provider.js';
import { SmsProvider } from '../../src/modules/auth/sms/sms-provider.js';
import { PaymentProvider } from '../../src/modules/payments/provider/payment-provider.js';
import { MemoryKeyValueStore } from '../../src/testing/memory-key-value.store.js';
import { SignedTestPaymentProvider, type TestWebhookPayload, signTestWebhook } from '../../src/testing/signed-test-payment.provider.js';
import { FakeFirebaseIdentityVerifier } from '../../src/testing/firebase-test-support.js';
import { CapturingSmsProvider } from '../../src/testing/test-support.js';
import { assertTestDatabaseMigrated, assertTestDatabaseName } from '../migration-guard.js';
import { Redis } from 'ioredis';
import { type Socket as ClientSocket, io as connectClient } from 'socket.io-client';
import { purgeAuditLogsSince } from './audit-cleanup.js';

export const ADMIN_PASSWORD = 'Itest-Admin-Passw0rd-1';

export interface Session {
  accessToken: string;
  /** The session's refresh token (single use). */
  refreshToken?: string;
  userId: string;
  phone: string;
}

export interface Worker extends Session {
  workerId: string;
}

export const hoursFromNow = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();
export const daysFromNow = (d: number) => hoursFromNow(d * 24);

export type PaymentMode = 'signed' | 'mock' | 'disabled';

export interface RealtimeOptions {
  /** Start the HTTP server on a free local port so Socket.IO clients can connect. */
  listen?: boolean;
  /** Use the Socket.IO Redis adapter (needs the real Redis; implies realRedis). */
  redisAdapter?: boolean;
  /** Run the BullMQ workers (needs the real Redis; implies realRedis). */
  jobs?: boolean;
  /** Point REDIS_URL at the local Redis-compatible server, logical DB 15, with a unique key prefix (only that prefix is ever deleted). */
  realRedis?: boolean;
  /** Extra environment variables for this boot (e.g. LOCATION_MIN_INTERVAL_MS). */
  env?: Record<string, string>;
}

export interface TestSocket {
  raw: ClientSocket;
  events: Array<{ event: string; payload: any }>;
  emitAck: (event: string, payload?: unknown) => Promise<any>;
  waitFor: (event: string, predicate?: (payload: any) => boolean, timeoutMs?: number) => Promise<any>;
  /** Resolves true when `event` (matching) does NOT arrive within `ms`. */
  expectNo: (event: string, predicate?: (payload: any) => boolean, ms?: number) => Promise<boolean>;
  close: () => void;
}

export async function bootHarness(opts: { phonePrefix: string; slugPrefix: string; adminEmailPrefix: string; payments?: PaymentMode; realtime?: RealtimeOptions; env?: Record<string, string>; pushProvider?: PushProvider }) {
  const rt = opts.realtime ?? {};
  const realRedis = Boolean(rt.realRedis || rt.redisAdapter || rt.jobs);
  const paymentMode: PaymentMode = opts.payments ?? 'signed';
  const url = process.env['TEST_DATABASE_URL'];
  if (!url) throw new Error('TEST_DATABASE_URL is not set');
  const dbName = decodeURIComponent(new URL(url).pathname.slice(1));
  assertTestDatabaseName(dbName); // exactly the test database; the connection is re-checked in assertTestDatabaseMigrated before any test writes

  const queuePrefix = `hsit${randomInt(100000, 999999)}`;
  const storageDir = mkdtempSync(join(tmpdir(), 'hs-itest-storage-'));
  for (const k of ['REALTIME_REVALIDATE_SECONDS', 'REALTIME_TOKEN_GRACE_SECONDS', 'REALTIME_MAX_SOCKETS_PER_USER', 'LOCATION_TTL_SECONDS', 'LOCATION_SHARING_LEAD_MINUTES', 'OUTBOX_MAX_ATTEMPTS', 'OUTBOX_POLL_INTERVAL_MS', 'ACCESS_TOKEN_TTL_SECONDS', 'CHAT_RATE_LIMIT_PER_MINUTE', 'LOCATION_RATE_LIMIT_PER_MINUTE', 'DOCUMENT_STORAGE', 'FILE_SCANNER', 'PUSH_PROVIDER', 'STORAGE_MAX_FILE_BYTES', 'STORAGE_SIGNING_SECRET', 'STORAGE_REQUIRE_CLEAN_SCAN', 'STORAGE_DELETION_MAX_ATTEMPTS', 'DEVICE_TOKEN_ENCRYPTION_KEY', 'NOTIFICATION_MAX_ATTEMPTS', 'MAX_DEVICE_TOKENS_PER_USER', 'DOCUMENT_URL_TTL_SECONDS', 'FIREBASE_AUTH_ENABLED', 'FIREBASE_PROJECT_ID', 'FIREBASE_SERVICE_ACCOUNT_BASE64', 'FIREBASE_CHECK_REVOKED', 'FIREBASE_MAX_AUTH_AGE_SECONDS', 'FIREBASE_ALLOW_PHONE_ACCOUNT_ADOPTION', 'FIREBASE_AUTH_EMULATOR_HOST', 'FIREBASE_ADOPTION_CONFIRM_PROJECT', 'FCM_DRY_RUN']) delete process.env[k];
  Object.assign(process.env, {
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: url,
    REDIS_URL: realRedis ? redisTestUrl() : 'redis://127.0.0.1:1', // otherwise unused: the key-value store is replaced
    QUEUE_PREFIX: queuePrefix,
    REALTIME_REDIS_ADAPTER: rt.redisAdapter ? 'true' : 'false',
    JOBS_ENABLED: rt.jobs ? 'true' : 'false',
    LOCATION_MIN_INTERVAL_MS: '0',
    LOCATION_SHARING_LEAD_MINUTES: '0',
    STORAGE_LOCAL_DIR: storageDir,
    PUBLIC_API_URL: 'http://127.0.0.1:3999',
    ...rt.env,
    JWT_ACCESS_SECRET: 'itest-access-secret-itest-access-secret-0123456789',
    OTP_HMAC_SECRET: 'itest-otp-secret-itest-otp-secret-0123456789abcdef',
    TRUST_PROXY_HOPS: '1',
    SWAGGER_ENABLED: 'false',
    BOOKING_MAX_OPEN_PER_CUSTOMER: '4',
    // 'signed' injects the test gateway (the configured provider stays disabled); 'mock' uses the real mock adapter.
    PAYMENT_PROVIDER: paymentMode === 'mock' ? 'mock' : 'disabled',
    ...opts.env,
  });

  const store = new MemoryKeyValueStore();
  const sms = new CapturingSmsProvider();
  // The Firebase boundary is always a double here; it follows the configuration, so "feature off" behaves like the real disabled verifier.
  const firebase = new FakeFirebaseIdentityVerifier();
  firebase.enabled = process.env['FIREBASE_AUTH_ENABLED'] === 'true';
  const gateway = new SignedTestPaymentProvider();
  let builder = Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(KeyValueStore)
    .useValue(store)
    .overrideProvider(SmsProvider)
    .useValue(sms)
    .overrideProvider(FirebaseIdentityVerifier)
    .useValue(firebase);
  if (paymentMode === 'signed') builder = builder.overrideProvider(PaymentProvider).useValue(gateway);
  if (opts.pushProvider) builder = builder.overrideProvider(PushProvider).useValue(opts.pushProvider); // e.g. the FCM adapter over a fake Firebase client
  const moduleRef = await builder.compile();
  // rawBody: payment webhooks are signature-checked over the exact bytes received (same as main.ts).
  const app: INestApplication = moduleRef.createNestApplication({ rawBody: true });
  configureApp(app, app.get(ConfigService).getOrThrow<AppConfig>(APP_CONFIG));
  await app.init();
  // Always listen ONCE on an ephemeral local port. supertest otherwise calls server.listen(0) for every request on a server that is not
  // listening yet, adding a 'listening', 'error' and 'close' listener each time: tests that fire many requests at once (retries, races)
  // then trip Node's MaxListenersExceededWarning for [Server]. That was a test-harness artifact, not a leak in the application.
  await app.listen(0, '127.0.0.1');
  const baseUrl = await app.getUrl();
  const prisma = app.get(PrismaService);
  await assertTestDatabaseMigrated(prisma);

  const startedAt = new Date(Date.now() - 2000);
  let phoneCounter = 0;
  let ipCounter = 0;
  const adminEmail = `${opts.adminEmailPrefix}-${randomInt(100000, 999999)}@example.com`;

  const api = () => request(app.getHttpServer());
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
  const freshIp = () => `10.3.${Math.floor(++ipCounter / 250)}.${(ipCounter % 250) + 1}`;
  // Every account this harness creates needs a number nobody else in the run has. A random draw per account (the old
  // `counter + random(0..80000)`) collides with ~5% probability in a suite of ~90 accounts (birthday paradox); two accounts then
  // share one number, which showed up as flaky duplicate-user failures and, when the two sign-ins overlap, as an OTP
  // "resend cooldown" 429 (the cooldown and the hourly cap are per PHONE, so a fresh IP cannot help). A random START per
  // harness plus a strictly increasing counter makes a repeat impossible within the run and unlikely across runs.
  const phoneBase = randomInt(10000, 60000);
  const freshPhone = () => {
    const n = phoneBase + ++phoneCounter;
    if (n > 99999) throw new Error('harness phone range exhausted');
    return `${opts.phonePrefix}${n}`;
  };

  async function otpSignIn(appType: 'customer' | 'worker', phone = freshPhone()): Promise<Session> {
    const ip = freshIp();
    store.deleteByPrefix('otp:cooldown:');
    const requested = await api().post('/api/v1/auth/otp/request').set('X-Forwarded-For', ip).send({ phone, app: appType });
    if (requested.status !== 200) {
      // Say WHICH limit fired (never the code or the full number): a bare "429" cannot be debugged.
      throw new Error(`OTP request refused: HTTP ${requested.status} ${requested.body?.code ?? ''} (ip ${ip}, phone ...${phone.slice(-4)}, ${appType})`);
    }
    const res = await api()
      .post('/api/v1/auth/otp/verify')
      .set('X-Forwarded-For', ip)
      .send({ phone, code: sms.lastCode(phone), app: appType })
      .expect(200);
    return { accessToken: res.body.accessToken, refreshToken: res.body.refreshToken, userId: res.body.user.id, phone };
  }

  async function cleanup(): Promise<void> {
    const customers = { customer: { phone: { startsWith: opts.phonePrefix } } };
    const workers = { worker: { user: { phone: { startsWith: opts.phonePrefix } } } };

    // Payments first: they reference bookings and users with RESTRICT. The ledger is append-only, so this
    // test-only cleanup (guarded by the *_test name check above) briefly disables its trigger inside a transaction.
    const bookingIds = (await prisma.booking.findMany({ where: { OR: [customers, workers] }, select: { id: true } })).map((b) => b.id);
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('ALTER TABLE ledger_entries DISABLE TRIGGER ledger_entries_no_update_delete');
      try {
        await tx.ledgerEntry.deleteMany({ where: { bookingId: { in: bookingIds } } });
      } finally {
        await tx.$executeRawUnsafe('ALTER TABLE ledger_entries ENABLE TRIGGER ledger_entries_no_update_delete');
      }
      // Disputes and reviews keep append-only history: test-only cleanup lifts those triggers inside this transaction.
      for (const t of ['ALTER TABLE dispute_events DISABLE TRIGGER dispute_events_immutable', 'ALTER TABLE review_events DISABLE TRIGGER review_events_immutable', 'ALTER TABLE reviews DISABLE TRIGGER reviews_no_delete']) await tx.$executeRawUnsafe(t);
      try {
        await tx.dispute.deleteMany({ where: { bookingId: { in: bookingIds } } });
        await tx.reviewEvent.deleteMany({ where: { review: { bookingId: { in: bookingIds } } } });
        await tx.review.deleteMany({ where: { bookingId: { in: bookingIds } } });
      } finally {
        for (const t of ['ALTER TABLE dispute_events ENABLE TRIGGER dispute_events_immutable', 'ALTER TABLE review_events ENABLE TRIGGER review_events_immutable', 'ALTER TABLE reviews ENABLE TRIGGER reviews_no_delete']) await tx.$executeRawUnsafe(t);
      }
      await tx.paymentRefund.deleteMany({ where: { bookingId: { in: bookingIds } } });
      await tx.paymentWebhookEvent.deleteMany({ where: { OR: [{ paymentAttempt: { bookingId: { in: bookingIds } } }, { accountScope: { startsWith: 'itest' } }] } });
      await tx.paymentAttempt.deleteMany({ where: { bookingId: { in: bookingIds } } });
    });

    // Bookings reference users, services and cities with RESTRICT, so they go first (quotes, events,
    // photos and cancellations cascade).
    await prisma.booking.deleteMany({ where: { OR: [customers, workers] } });
    await prisma.quote.deleteMany({ where: workers });
    // support conversations reference users with RESTRICT (their messages go with them)
    await prisma.supportThread.deleteMany({ where: { user: { phone: { startsWith: opts.phonePrefix } } } });
    await prisma.user.deleteMany({ where: { OR: [{ phone: { startsWith: opts.phonePrefix } }, { email: { startsWith: opts.adminEmailPrefix } }] } });
    await prisma.pricingSetting.deleteMany({ where: { note: { startsWith: `itest pricing ${opts.slugPrefix}` } } }); // own rows only: other harnesses in the same process keep theirs
    await prisma.offer.deleteMany({ where: { OR: [{ titleEn: { startsWith: opts.slugPrefix } }, { titleAr: { startsWith: opts.slugPrefix } }] } });
    await prisma.service.deleteMany({ where: { slug: { startsWith: opts.slugPrefix } } });
    await prisma.serviceCategory.deleteMany({ where: { slug: { startsWith: opts.slugPrefix } } });
    await prisma.city.deleteMany({ where: { slug: { startsWith: opts.slugPrefix } } });
  }

  await cleanup();

  const passwords = app.get(PasswordService);
  await prisma.user.create({
    data: { email: adminEmail, passwordHash: await passwords.hash(ADMIN_PASSWORD), status: UserStatus.ACTIVE, roles: { create: [{ role: Role.ADMIN }] } },
  });
  const adminToken = (
    await api().post('/api/v1/auth/admin/login').set('X-Forwarded-For', freshIp()).send({ email: adminEmail, password: ADMIN_PASSWORD }).expect(200)
  ).body.accessToken as string;

  /** Catalog and pricing created through the admin API, like a real administrator would. */
  let lastRef: { service: { id: string }; city: { id: string } } | undefined;

  async function seedReferenceData() {
    const post = async (path: string, body: object) => (await api().post(path).set(bearer(adminToken)).send(body).expect(201)).body;
    const category = await post('/api/v1/admin/service-categories', { slug: `${opts.slugPrefix}elec`, nameEn: 'Electrical (test)', nameAr: 'الكهرباء (اختبار)' });
    const service = await post('/api/v1/admin/services', { categoryId: category.id, slug: `${opts.slugPrefix}wiring`, nameEn: 'Wiring', nameAr: 'تمديدات' });
    const otherService = await post('/api/v1/admin/services', { categoryId: category.id, slug: `${opts.slugPrefix}lighting`, nameEn: 'Lighting', nameAr: 'إضاءة' });
    const city = await post('/api/v1/admin/cities', { slug: `${opts.slugPrefix}riyadh`, nameEn: 'Riyadh (test)', nameAr: 'الرياض (اختبار)' });
    const otherCity = await post('/api/v1/admin/cities', { slug: `${opts.slugPrefix}jeddah`, nameEn: 'Jeddah (test)', nameAr: 'جدة (اختبار)' });
    await setPricing({ vatRateBps: 1500, commissionRateBps: 1500, minServiceChargeHalalas: 5000 });
    lastRef = { service, city };
    return { category, service, otherService, city, otherCity } as {
      category: { id: string };
      service: { id: string };
      otherService: { id: string };
      city: { id: string };
      otherCity: { id: string };
    };
  }

  async function setPricing(p: { vatRateBps: number; commissionRateBps: number; minServiceChargeHalalas: number }) {
    // effectiveFrom must be strictly later than any earlier test row so this one is "current".
    await new Promise((r) => setTimeout(r, 15));
    return (await api().post('/api/v1/admin/pricing-settings').set(bearer(adminToken)).send({ ...p, note: `itest pricing ${opts.slugPrefix}` }).expect(201)).body;
  }

  /** A signed-in worker who is approved and offers `serviceIds` in `cityIds` (set up directly in the database for speed). */
  async function makeWorker(serviceIds: string[], cityIds: string[], status: WorkerVerificationStatus = WorkerVerificationStatus.APPROVED): Promise<Worker> {
    const session = await otpSignIn('worker');
    const profile = await prisma.workerProfile.findUniqueOrThrow({ where: { userId: session.userId } });
    await prisma.user.update({ where: { id: session.userId }, data: { fullName: `Worker ${profile.id.slice(0, 6)}`, fullNameAr: 'عامل' } });
    await prisma.workerProfile.update({ where: { id: profile.id }, data: { verificationStatus: status, yearsOfExperience: 5, bio: 'Experienced' } });
    await prisma.workerService.createMany({ data: serviceIds.map((serviceId) => ({ workerProfileId: profile.id, serviceId, yearsOfExperience: 4 })) });
    await prisma.workerServiceArea.createMany({ data: cityIds.map((cityId) => ({ workerProfileId: profile.id, cityId })) });
    return { ...session, workerId: profile.id };
  }

  const makeCustomer = () => otpSignIn('customer');

  const bookingBody = (ref: { service: { id: string }; city: { id: string } }, overrides: object = {}) => ({
    serviceId: ref.service.id,
    cityId: ref.city.id,
    problemDescription: 'The kitchen outlet sparks whenever I plug something in.',
    preferredStartAt: daysFromNow(2),
    preferredEndAt: new Date(Date.parse(daysFromNow(2)) + 4 * 3_600_000).toISOString(),
    district: 'Al Olaya',
    addressLine: '12 Prince Sultan Street',
    building: 'Villa 7',
    latitude: 24.7136,
    longitude: 46.6753,
    ...overrides,
  });

  async function createBooking(customer: Session, ref: { service: { id: string }; city: { id: string } }, overrides: object = {}) {
    return (await api().post('/api/v1/bookings').set(bearer(customer.accessToken)).send(bookingBody(ref, overrides)).expect(201)).body;
  }

  const quoteBody = (overrides: object = {}) => ({
    priceHalalas: 20000,
    proposedStartAt: hoursFromNow(30),
    proposedEndAt: hoursFromNow(34),
    estimatedDurationMinutes: 90,
    message: 'I can fix it the same day.',
    ...overrides,
  });

  async function submitQuote(worker: Worker, bookingId: string, overrides: object = {}) {
    return (await api().post(`/api/v1/workers/me/requests/${bookingId}/quote`).set(bearer(worker.accessToken)).send(quoteBody(overrides)).expect(201)).body;
  }

  /** Booking whose quote was accepted: PAYMENT_PENDING, waiting for payment. */
  async function acceptedBooking(price = 20000, ref?: { service: { id: string }; city: { id: string } }) {
    const reference = ref ?? lastRef;
    if (!reference) throw new Error('call seedReferenceData() first or pass ref');
    const customer = await makeCustomer();
    const worker = await makeWorker([reference.service.id], [reference.city.id]);
    const booking = await createBooking(customer, reference);
    const quote = await submitQuote(worker, booking.id, { priceHalalas: price });
    await api().post(`/api/v1/bookings/${booking.id}/quotes/${quote.id}/accept`).set(bearer(customer.accessToken)).send({}).expect(200);
    return { customer, worker, booking, quote };
  }

  let keyCounter = 0;
  const newKey = () => `itest-key-${opts.slugPrefix}${Date.now().toString(36)}-${++keyCounter}-${randomInt(100000, 999999)}`;

  /** Customer starts paying; returns the supertest response. */
  const startPayment = (customer: Session, bookingId: string, key = newKey(), body: object = {}) =>
    api().post(`/api/v1/bookings/${bookingId}/payments`).set(bearer(customer.accessToken)).set('X-Forwarded-For', freshIp()).set('Idempotency-Key', key).send(body);

  /** Posts a gateway event exactly as the provider would (signed raw JSON body). */
  const sendWebhook = (payload: TestWebhookPayload, opts2: { signature?: string; body?: string; provider?: string } = {}) => {
    const signed = signTestWebhook({ account: `itest-${opts.slugPrefix}`, ...payload });
    return api()
      .post(`/api/v1/payments/webhooks/${opts2.provider ?? 'testgw'}`)
      .set('X-Forwarded-For', freshIp())
      .set('Content-Type', 'application/json')
      .set('x-testgw-signature', opts2.signature ?? signed.signature)
      .send(opts2.body ?? signed.body);
  };

  /** A started payment: returns the attempt and the provider reference needed to build events. */
  async function startedPayment(customer: Session, bookingId: string) {
    const res = await startPayment(customer, bookingId).expect(201);
    const row = await prisma.paymentAttempt.findUniqueOrThrow({ where: { id: res.body.id } });
    return { dto: res.body, row, providerPaymentId: row.providerPaymentId as string };
  }


  // ---- Phase 7 helpers -------------------------------------------------------------------------

  /** Moves an accepted booking to CONFIRMED the real way: a started payment plus a signed provider event. */
  async function confirmBooking(ctx: { customer: Session; booking: { id: string } }) {
    const { row, providerPaymentId } = await startedPayment(ctx.customer, ctx.booking.id);
    const total = (await prisma.booking.findUniqueOrThrow({ where: { id: ctx.booking.id } })).totalAmountHalalas;
    await sendWebhook({ id: `itest-rt-${row.id}`, type: 'payment.succeeded', paymentId: providerPaymentId, amount: total as number, currency: 'SAR' }).expect(200);
  }

  async function confirmedBooking(price = 20000) {
    const ctx = await acceptedBooking(price);
    await confirmBooking(ctx);
    return ctx;
  }

  const startWork = (worker: Session, bookingId: string) => api().post(`/api/v1/workers/me/bookings/${bookingId}/start`).set(bearer(worker.accessToken)).set('X-Forwarded-For', freshIp()).send({});
  const completeWork = (worker: Session, bookingId: string) => api().post(`/api/v1/workers/me/bookings/${bookingId}/complete`).set(bearer(worker.accessToken)).set('X-Forwarded-For', freshIp()).send({});
  const cancelBooking = (customer: Session, bookingId: string) =>
    api().post(`/api/v1/bookings/${bookingId}/cancel`).set(bearer(customer.accessToken)).set('X-Forwarded-For', freshIp()).send({ reason: 'CHANGED_MIND' });

  const openSockets: TestSocket[] = [];

  /** Connects a Socket.IO client to /realtime. Rejects with the server's error (code in `.code`) when refused. */
  function connect(token: string | undefined, extra: { headers?: Record<string, string> } = {}): Promise<TestSocket> {
    if (!baseUrl) throw new Error('the harness server is not listening');
    const raw = connectClient(`${baseUrl}/realtime`, {
      auth: token === undefined ? {} : { token },
      extraHeaders: extra.headers,
      transports: ['websocket'],
      reconnection: false,
      forceNew: true,
    });
    const events: TestSocket['events'] = [];
    raw.onAny((event, payload) => events.push({ event, payload }));
    const wait = (event: string, predicate: (p: any) => boolean = () => true, timeoutMs = 3000) =>
      new Promise<any>((resolve, reject) => {
        const hit = events.find((e) => e.event === event && predicate(e.payload));
        if (hit) return resolve(hit.payload);
        const timer = setTimeout(() => reject(new Error(`timed out waiting for ${event}`)), timeoutMs);
        const handler = (payload: any) => {
          if (!predicate(payload)) return;
          clearTimeout(timer);
          raw.off(event, handler);
          resolve(payload);
        };
        raw.on(event, handler);
      });
    const socket: TestSocket = {
      raw,
      events,
      emitAck: (event, payload) =>
        new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(`no acknowledgement for ${event}`)), 4000);
          raw.emit(event, payload, (res: unknown) => {
            clearTimeout(timer);
            resolve(res);
          });
        }),
      waitFor: wait,
      expectNo: async (event, predicate, ms = 400) => {
        try {
          await wait(event, predicate, ms);
          return false;
        } catch {
          return true;
        }
      },
      close: () => raw.close(),
    };
    return new Promise((resolve, reject) => {
      raw.once('connect', () => {
        openSockets.push(socket);
        resolve(socket);
      });
      raw.once('connect_error', (err: Error & { data?: unknown }) => {
        raw.close();
        reject(Object.assign(err, { code: (err.data as { code?: string } | undefined)?.code }));
      });
    });
  }

  async function close(): Promise<void> {
    for (const sock of openSockets) sock.close();
    await cleanup();
    // Audit rows lose their link to deleted users, so remove this run's rows by time window.
    await purgeAuditLogsSince(prisma, startedAt); // audit_logs is append-only: the helper lifts the trigger for this one statement
    await prisma.storageDeletion.deleteMany({ where: { createdAt: { gte: startedAt } } });
    await app.close();
    if (realRedis) await deleteRedisPrefix(queuePrefix);
    try {
      rmSync(storageDir, { recursive: true, force: true });
    } catch {
      // a desktop antivirus may hold a file for a moment; the folder is a throwaway temp folder
    }
  }

  return {
    app, prisma, api, bearer, store, sms, firebase, freshIp, freshPhone, otpSignIn, adminToken,
    seedReferenceData, setPricing, makeWorker, makeCustomer, bookingBody, createBooking, quoteBody, submitQuote, close,
    gateway, acceptedBooking, startPayment, sendWebhook, startedPayment, newKey,
    baseUrl, queuePrefix, storageDir, confirmBooking, confirmedBooking, startWork, completeWork, cancelBooking, connect, hoursFromNow,
  };
}

export type Harness = Awaited<ReturnType<typeof bootHarness>>;

// Captured before any boot rewrites process.env.REDIS_URL (some suites deliberately point it at a dead port).
const ORIGINAL_REDIS_URL = process.env['REDIS_URL'] || 'redis://127.0.0.1:6379';

/** Local Redis-compatible server (Memurai), logical database 15. Never the database the API itself uses. */
export function redisTestUrl(): string {
  const url = new URL(ORIGINAL_REDIS_URL);
  url.pathname = '/15';
  return url.toString();
}

/** Deletes ONLY the keys of this run's unique prefix (queues, adapter channels). Never flushes anything. */
async function deleteRedisPrefix(prefix: string): Promise<void> {
  const redis = new Redis(redisTestUrl(), { maxRetriesPerRequest: 1, lazyConnect: true });
  try {
    await redis.connect();
    let cursor = '0';
    do {
      const [next, keys] = await redis.scan(cursor, 'MATCH', `${prefix}:*`, 'COUNT', 500);
      cursor = next;
      if (keys.length > 0) await redis.del(...keys);
    } while (cursor !== '0');
  } catch {
    // Redis unreachable during teardown: nothing of ours can be left behind that matters.
  } finally {
    redis.disconnect();
  }
}
