import { jest } from '@jest/globals';
import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { SignJWT } from 'jose';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { APP_CONFIG, type AppConfig } from '../src/config/app.config.js';
import { KeyValueStore } from '../src/database/key-value.store.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { AdminBootstrapService } from '../src/modules/auth/admin/admin-bootstrap.service.js';
import { SmsProvider } from '../src/modules/auth/sms/sms-provider.js';
import { InMemoryPrisma } from '../src/testing/in-memory-prisma.js';
import { MemoryKeyValueStore } from '../src/testing/memory-key-value.store.js';
import { CapturingSmsProvider } from '../src/testing/test-support.js';

const ACCESS_SECRET = 'e2e-access-secret-e2e-access-secret-0123456789';
const ADMIN_EMAIL = 'owner@example.com';
const ADMIN_PASSWORD = 'initial-Passw0rd-xyz';

let app: INestApplication;
let db: InMemoryPrisma;
let sms: CapturingSmsProvider;
let store: MemoryKeyValueStore;
let phoneCounter = 0;
let ipCounter = 0;

/** Every call looks like a different client, so the per-IP limits only bite where a test wants them to. */
const freshIp = () => `10.1.${Math.floor(++ipCounter / 250)}.${(ipCounter % 250) + 1}`;
const freshPhone = () => `+9665${String(10000000 + ++phoneCounter)}`;
const api = () => request(app.getHttpServer());
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

interface Session {
  accessToken: string;
  refreshToken: string;
  userId: string;
  phone: string;
  body: any;
}

async function signIn(appType: 'customer' | 'worker', phone = freshPhone(), ip = freshIp()): Promise<Session> {
  store.deleteByPrefix('otp:cooldown:'); // sign-ins in these tests are not waiting out the 60s resend cooldown
  await api().post('/api/v1/auth/otp/request').set('X-Forwarded-For', ip).send({ phone, app: appType }).expect(200);
  const res = await api()
    .post('/api/v1/auth/otp/verify')
    .set('X-Forwarded-For', ip)
    .send({ phone, code: sms.lastCode(phone.startsWith('0') ? `+966${phone.slice(1)}` : phone), app: appType })
    .expect(200);
  return { accessToken: res.body.accessToken, refreshToken: res.body.refreshToken, userId: res.body.user.id, phone, body: res.body };
}

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  process.env.LOG_LEVEL = 'silent';
  process.env.SWAGGER_ENABLED = 'false';
  process.env.DATABASE_URL = 'postgresql://nobody:nopass@127.0.0.1:1/none';
  process.env.REDIS_URL = 'redis://:nopass@127.0.0.1:1';
  process.env.JWT_ACCESS_SECRET = ACCESS_SECRET;
  process.env.OTP_HMAC_SECRET = 'e2e-otp-secret-e2e-otp-secret-0123456789abcdef';
  process.env.TRUST_PROXY_HOPS = '1';

  db = new InMemoryPrisma();
  store = new MemoryKeyValueStore();
  sms = new CapturingSmsProvider();
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(PrismaService)
    .useValue(db.asPrisma())
    .overrideProvider(KeyValueStore)
    .useValue(store)
    .overrideProvider(SmsProvider)
    .useValue(sms)
    .compile();
  app = moduleRef.createNestApplication();
  configureApp(app, app.get(ConfigService).getOrThrow<AppConfig>(APP_CONFIG));
  await app.init();

  await app.get(AdminBootstrapService).createInitialAdmin({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
});

afterAll(async () => {
  await app.close();
});

describe('unauthenticated access', () => {
  it.each([
    ['get', '/api/v1/auth/me'],
    ['get', '/api/v1/customers/me'],
    ['get', '/api/v1/workers/me'],
    ['get', '/api/v1/workers/me/jobs'],
    ['get', '/api/v1/admin/users/6f1c2f0e-6d4a-4a39-9d1e-0f6b1a9a0001'],
    ['post', '/api/v1/auth/logout-all'],
    ['post', '/api/v1/auth/admin/change-password'],
  ])('%s %s requires a token', async (method, url) => {
    const res = await (api() as any)[method](url).send({});
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('AUTH_REQUIRED');
  });

  it('rejects a malformed or forged bearer token', async () => {
    const res = await api().get('/api/v1/auth/me').set(bearer('not.a.jwt')).expect(401);
    expect(res.body.code).toBe('TOKEN_INVALID');
    await api().get('/api/v1/auth/me').set({ Authorization: 'Basic abc' }).expect(401);
  });

  it('rejects an expired access token', async () => {
    const session = await signIn('customer');
    const expired = await new SignJWT({ sid: 'x', role: 'CUSTOMER' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(session.userId)
      .setIssuer('home-services-api')
      .setAudience('home-services')
      .setIssuedAt(Math.floor(Date.now() / 1000) - 3600)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 10)
      .sign(new TextEncoder().encode(ACCESS_SECRET));
    const res = await api().get('/api/v1/auth/me').set(bearer(expired)).expect(401);
    expect(res.body.code).toBe('TOKEN_EXPIRED');
  });

  it('keeps health checks public', async () => {
    await api().get('/api/v1/health').expect(200);
  });

  it('has no admin registration endpoint', async () => {
    for (const url of ['/api/v1/auth/admin/register', '/api/v1/auth/register', '/api/v1/admin/users']) {
      const res = await api().post(url).send({ email: 'x@example.com', password: 'whatever-123456', role: 'ADMIN' });
      expect([401, 404]).toContain(res.status);
    }
    expect(db.userRoles.filter((r) => r.role === 'ADMIN')).toHaveLength(1);
  });
});

describe('customer / worker OTP sign-in', () => {
  it('creates a customer account and never returns secrets', async () => {
    const phone = freshPhone();
    const ip = freshIp();
    const requested = await api().post('/api/v1/auth/otp/request').set('X-Forwarded-For', ip).send({ phone, app: 'customer' }).expect(200);
    expect(requested.body).toEqual({ expiresInSeconds: 300, resendAfterSeconds: 60 });

    const res = await api()
      .post('/api/v1/auth/otp/verify')
      .set('X-Forwarded-For', ip)
      .send({ phone, code: sms.lastCode(phone), app: 'customer' })
      .expect(200);
    expect(res.body).toMatchObject({ tokenType: 'Bearer', isNewUser: true, user: { phone, roles: ['CUSTOMER'], activeRole: 'CUSTOMER', status: 'ACTIVE' } });
    const text = JSON.stringify(res.body);
    expect(text).not.toMatch(/passwordHash|tokenHash|argon2|otp/i);

    const me = await api().get('/api/v1/auth/me').set(bearer(res.body.accessToken)).expect(200);
    expect(me.body.id).toBe(res.body.user.id);
    expect(JSON.stringify(me.body)).not.toMatch(/passwordHash|tokenHash/);
    await api().get('/api/v1/customers/me').set(bearer(res.body.accessToken)).expect(200);
  });

  it('treats 05… and +966… as the same person', async () => {
    const national = `05${String(10000000 + ++phoneCounter)}`;
    const international = `+966${national.slice(1)}`;
    const first = await signIn('customer', national);
    const second = await signIn('customer', international);
    expect(second.userId).toBe(first.userId);
    expect(second.body.isNewUser).toBe(false);
    expect(db.users.filter((u) => u.phone === international)).toHaveLength(1);
  });

  it('gives one person both roles without duplicating the account', async () => {
    const phone = freshPhone();
    const asCustomer = await signIn('customer', phone);
    const asWorker = await signIn('worker', phone);
    expect(asWorker.userId).toBe(asCustomer.userId);
    expect(asWorker.body.user.roles.sort()).toEqual(['CUSTOMER', 'WORKER']);
    expect(asWorker.body.user.activeRole).toBe('WORKER');
    expect(db.users.filter((u) => u.phone === phone)).toHaveLength(1);
    expect(db.customerProfiles.filter((p) => p.userId === asCustomer.userId)).toHaveLength(1);
    expect(db.workerProfiles.filter((p) => p.userId === asCustomer.userId)).toHaveLength(1);
  });

  it('validates input', async () => {
    const ip = freshIp();
    const post = (body: object) => api().post('/api/v1/auth/otp/request').set('X-Forwarded-For', ip).send(body);
    expect((await post({ phone: '1234567', app: 'customer' })).body.code).toBe('INVALID_PHONE');
    expect((await post({ phone: 'hello', app: 'customer' })).status).toBe(400);
    expect((await post({ phone: freshPhone() })).status).toBe(400);
    expect((await post({ phone: freshPhone(), app: 'customer', extra: 1 })).status).toBe(400);
  });

  it('cannot become an admin by sending a role from the client', async () => {
    const phone = freshPhone();
    const ip = freshIp();
    await api().post('/api/v1/auth/otp/request').set('X-Forwarded-For', ip).send({ phone, app: 'customer' }).expect(200);
    const code = sms.lastCode(phone);
    const verify = (extra: object) =>
      api().post('/api/v1/auth/otp/verify').set('X-Forwarded-For', ip).send({ phone, code, app: 'customer', ...extra });

    expect((await verify({ role: 'ADMIN' })).status).toBe(400);
    expect((await verify({ roles: ['ADMIN'] })).status).toBe(400);
    expect((await verify({ app: 'admin' })).status).toBe(400);

    const ok = await verify({}).expect(200);
    expect(ok.body.user.roles).toEqual(['CUSTOMER']);
    await api().get(`/api/v1/admin/users/${ok.body.user.id}`).set(bearer(ok.body.accessToken)).expect(403);
  });

  it('does not reveal whether a number is registered', async () => {
    const existing = await signIn('customer');
    store.deleteByPrefix('otp:cooldown:');
    const a = await api().post('/api/v1/auth/otp/request').set('X-Forwarded-For', freshIp()).send({ phone: existing.phone, app: 'customer' });
    const b = await api().post('/api/v1/auth/otp/request').set('X-Forwarded-For', freshIp()).send({ phone: freshPhone(), app: 'customer' });
    expect(a.status).toBe(b.status);
    expect(a.body).toEqual(b.body);
  });
});

describe('OTP abuse limits', () => {
  it('enforces the resend cooldown with Retry-After', async () => {
    const phone = freshPhone();
    const ip = freshIp();
    await api().post('/api/v1/auth/otp/request').set('X-Forwarded-For', ip).send({ phone, app: 'customer' }).expect(200);
    const res = await api().post('/api/v1/auth/otp/request').set('X-Forwarded-For', ip).send({ phone, app: 'customer' }).expect(429);
    expect(res.body.code).toBe('OTP_RESEND_COOLDOWN');
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('pauses guessing after 5 wrong codes from one client, but the real user can still sign in', async () => {
    const phone = freshPhone();
    const ownerIp = freshIp();
    const attackerIp = freshIp();
    await api().post('/api/v1/auth/otp/request').set('X-Forwarded-For', ownerIp).send({ phone, app: 'customer' }).expect(200);
    const real = sms.lastCode(phone);
    const wrong = real === '000000' ? '111111' : '000000';
    const guess = (code: string, ip: string) =>
      api().post('/api/v1/auth/otp/verify').set('X-Forwarded-For', ip).send({ phone, code, app: 'customer' });

    for (let i = 0; i < 5; i++) {
      const res = await guess(wrong, attackerIp);
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('OTP_INVALID');
    }
    const blocked = await guess(wrong, attackerIp);
    expect(blocked.status).toBe(429);
    expect(blocked.body.code).toBe('OTP_ATTEMPTS_EXCEEDED');
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    // Even the right code is refused to the blocked client.
    expect((await guess(real, attackerIp)).status).toBe(429);

    // The attacker did not destroy the real code: the owner signs in.
    const ok = await guess(real, ownerIp);
    expect(ok.status).toBe(200);
    expect(ok.body.user.phone).toBe(phone);
  });

  it('rejects an expired code', async () => {
    const phone = freshPhone();
    const ip = freshIp();
    await api().post('/api/v1/auth/otp/request').set('X-Forwarded-For', ip).send({ phone, app: 'customer' }).expect(200);
    const code = sms.lastCode(phone);
    const now = Date.now();
    const spy = jest.spyOn(Date, 'now').mockReturnValue(now + 301_000);
    try {
      const res = await api().post('/api/v1/auth/otp/verify').set('X-Forwarded-For', ip).send({ phone, code, app: 'customer' });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('OTP_EXPIRED');
    } finally {
      spy.mockRestore();
    }
  });

  it('rate limits OTP requests per client IP', async () => {
    const ip = freshIp();
    for (let i = 0; i < 10; i++) {
      await api().post('/api/v1/auth/otp/request').set('X-Forwarded-For', ip).send({ phone: freshPhone(), app: 'customer' }).expect(200);
    }
    const res = await api().post('/api/v1/auth/otp/request').set('X-Forwarded-For', ip).send({ phone: freshPhone(), app: 'customer' }).expect(429);
    expect(res.body.code).toBe('RATE_LIMITED');
    expect(res.headers['retry-after']).toBeDefined();
  });

  it('fails closed with 503 when no SMS provider is configured', async () => {
    const original = sms.failWith;
    sms.failWith = Object.assign(new Error('x'), {});
    try {
      const res = await api().post('/api/v1/auth/otp/request').set('X-Forwarded-For', freshIp()).send({ phone: freshPhone(), app: 'customer' });
      expect(res.status).toBe(503);
      expect(res.body.code).toBe('SMS_DELIVERY_FAILED');
    } finally {
      sms.failWith = original;
    }
  });
});

describe('role and ownership rules', () => {
  it('blocks an unapproved worker from job operations until approved', async () => {
    const worker = await signIn('worker');
    expect(worker.body.user.workerVerificationStatus).toBe('NOT_SUBMITTED');

    const profile = await api().get('/api/v1/workers/me').set(bearer(worker.accessToken)).expect(200);
    expect(profile.body.verificationStatus).toBe('NOT_SUBMITTED');

    const blocked = await api().get('/api/v1/workers/me/jobs').set(bearer(worker.accessToken)).expect(403);
    expect(blocked.body.code).toBe('WORKER_NOT_APPROVED');

    for (const status of ['SUBMITTED', 'UNDER_REVIEW', 'INFO_REQUIRED', 'REJECTED']) {
      db.workerProfiles.find((p) => p.userId === worker.userId)!.verificationStatus = status;
      await api().get('/api/v1/workers/me/jobs').set(bearer(worker.accessToken)).expect(403);
    }

    db.workerProfiles.find((p) => p.userId === worker.userId)!.verificationStatus = 'APPROVED';
    // Takes effect immediately, with the same access token.
    await api().get('/api/v1/workers/me/jobs').set(bearer(worker.accessToken)).expect(200);
  });

  it('keeps customer and worker sessions separate even for the same person', async () => {
    const phone = freshPhone();
    const customer = await signIn('customer', phone);
    const worker = await signIn('worker', phone);
    db.workerProfiles.find((p) => p.userId === worker.userId)!.verificationStatus = 'APPROVED';

    expect((await api().get('/api/v1/workers/me').set(bearer(customer.accessToken))).status).toBe(403);
    expect((await api().get('/api/v1/workers/me/jobs').set(bearer(customer.accessToken))).status).toBe(403);
    expect((await api().get('/api/v1/customers/me').set(bearer(worker.accessToken))).status).toBe(403);
  });

  it('stops a customer reading another customer, and a worker reading another worker', async () => {
    const [c1, c2] = [await signIn('customer'), await signIn('customer')];
    const [w1, w2] = [await signIn('worker'), await signIn('worker')];

    await api().get(`/api/v1/customers/${c1.userId}`).set(bearer(c1.accessToken)).expect(200);
    const crossCustomer = await api().get(`/api/v1/customers/${c2.userId}`).set(bearer(c1.accessToken)).expect(403);
    expect(crossCustomer.body.code).toBe('FORBIDDEN_RESOURCE');

    await api().get(`/api/v1/workers/${w1.userId}`).set(bearer(w1.accessToken)).expect(200);
    const crossWorker = await api().get(`/api/v1/workers/${w2.userId}`).set(bearer(w1.accessToken)).expect(403);
    expect(crossWorker.body.code).toBe('FORBIDDEN_RESOURCE');

    // A customer cannot reach worker data, nor a worker customer data.
    expect((await api().get(`/api/v1/workers/${w1.userId}`).set(bearer(c1.accessToken))).status).toBe(403);
    expect((await api().get(`/api/v1/customers/${c1.userId}`).set(bearer(w1.accessToken))).status).toBe(403);
  });

  it('rejects non-UUID ids', async () => {
    const c = await signIn('customer');
    await api().get('/api/v1/customers/not-a-uuid').set(bearer(c.accessToken)).expect(400);
  });
});

describe('administrator', () => {
  it('forces a password change before anything else, then grants admin access', async () => {
    const login = await api()
      .post('/api/v1/auth/admin/login')
      .set('X-Forwarded-For', freshIp())
      .send({ email: ADMIN_EMAIL.toUpperCase(), password: ADMIN_PASSWORD })
      .expect(200);
    expect(login.body.user).toMatchObject({ email: ADMIN_EMAIL, roles: ['ADMIN'], activeRole: 'ADMIN' });
    expect(JSON.stringify(login.body)).not.toMatch(/passwordHash|argon2/);

    const gated = await api().get(`/api/v1/admin/users/${login.body.user.id}`).set(bearer(login.body.accessToken)).expect(403);
    expect(gated.body.code).toBe('PASSWORD_CHANGE_REQUIRED');
    await api().get('/api/v1/auth/me').set(bearer(login.body.accessToken)).expect(200);

    const changed = await api()
      .post('/api/v1/auth/admin/change-password')
      .set(bearer(login.body.accessToken))
      .send({ currentPassword: ADMIN_PASSWORD, newPassword: 'rotated-Passw0rd-123' })
      .expect(200);
    // The old session ended; the new one works.
    await api().get('/api/v1/auth/me').set(bearer(login.body.accessToken)).expect(401);
    const summary = await api().get(`/api/v1/admin/users/${login.body.user.id}`).set(bearer(changed.body.accessToken)).expect(200);
    expect(summary.body.email).toBe(ADMIN_EMAIL);
    expect(JSON.stringify(summary.body)).not.toMatch(/passwordHash|argon2/);
  });

  it('rejects wrong credentials identically and locks out repeated failures', async () => {
    const ip = freshIp();
    const bad = (email: string) =>
      api().post('/api/v1/auth/admin/login').set('X-Forwarded-For', ip).send({ email, password: 'definitely-wrong-1' });
    const a = await bad(ADMIN_EMAIL);
    const b = await bad('ghost@example.com');
    expect(a.status).toBe(401);
    expect(b.status).toBe(401);
    expect(a.body.message).toBe(b.body.message);

    for (let i = 0; i < 4; i++) await bad(ADMIN_EMAIL);
    const locked = await bad(ADMIN_EMAIL);
    expect(locked.status).toBe(429);
    expect(locked.body.code).toBe('LOGIN_LOCKED');
  });

  it('admin tokens cannot be used on customer or worker areas, and vice versa', async () => {
    const customer = await signIn('customer');
    const adminLogin = await api()
      .post('/api/v1/auth/admin/login')
      .set('X-Forwarded-For', freshIp())
      .send({ email: ADMIN_EMAIL, password: 'rotated-Passw0rd-123' });
    // The previous test already rotated to this password.
    expect(adminLogin.status).toBe(200);
    await api().get('/api/v1/customers/me').set(bearer(adminLogin.body.accessToken)).expect(403);
    await api().get('/api/v1/workers/me').set(bearer(adminLogin.body.accessToken)).expect(403);
    await api().get(`/api/v1/admin/users/${customer.userId}`).set(bearer(customer.accessToken)).expect(403);
  });
});

describe('sessions', () => {
  it('rotates refresh tokens and returns a working access token', async () => {
    const s = await signIn('customer');
    const res = await api().post('/api/v1/auth/refresh').set('X-Forwarded-For', freshIp()).send({ refreshToken: s.refreshToken }).expect(200);
    expect(res.body.refreshToken).not.toBe(s.refreshToken);
    expect(res.body.user.activeRole).toBe('CUSTOMER');
    await api().get('/api/v1/auth/me').set(bearer(res.body.accessToken)).expect(200);
  });

  it('revokes the whole session if an old refresh token is replayed', async () => {
    const s = await signIn('customer');
    const ip = freshIp();
    const next = await api().post('/api/v1/auth/refresh').set('X-Forwarded-For', ip).send({ refreshToken: s.refreshToken }).expect(200);

    const replay = await api().post('/api/v1/auth/refresh').set('X-Forwarded-For', ip).send({ refreshToken: s.refreshToken }).expect(401);
    expect(replay.body.code).toBe('REFRESH_TOKEN_REUSED');

    // The legitimate newer tokens are dead too.
    await api().post('/api/v1/auth/refresh').set('X-Forwarded-For', ip).send({ refreshToken: next.body.refreshToken }).expect(401);
    const me = await api().get('/api/v1/auth/me').set(bearer(next.body.accessToken)).expect(401);
    expect(me.body.code).toBe('SESSION_REVOKED');
  });

  it('logout ends the session immediately, access token included', async () => {
    const s = await signIn('customer');
    await api().get('/api/v1/auth/me').set(bearer(s.accessToken)).expect(200);

    await api().post('/api/v1/auth/logout').set('X-Forwarded-For', freshIp()).send({ refreshToken: s.refreshToken }).expect(204);

    const me = await api().get('/api/v1/auth/me').set(bearer(s.accessToken)).expect(401);
    expect(me.body.code).toBe('SESSION_REVOKED');
    const refresh = await api().post('/api/v1/auth/refresh').set('X-Forwarded-For', freshIp()).send({ refreshToken: s.refreshToken }).expect(401);
    expect(refresh.body.code).toBe('REFRESH_TOKEN_REVOKED');
  });

  it('logout never reveals whether a token existed', async () => {
    await api().post('/api/v1/auth/logout').set('X-Forwarded-For', freshIp()).send({ refreshToken: 'x'.repeat(43) }).expect(204);
  });

  it('logout-all ends every device', async () => {
    const phone = freshPhone();
    const phoneA = await signIn('customer', phone);
    const phoneB = await signIn('customer', phone);
    await api().post('/api/v1/auth/logout-all').set(bearer(phoneA.accessToken)).expect(204);
    await api().get('/api/v1/auth/me').set(bearer(phoneA.accessToken)).expect(401);
    await api().get('/api/v1/auth/me').set(bearer(phoneB.accessToken)).expect(401);
  });

  it('a suspended account loses access at once and cannot sign in again', async () => {
    const s = await signIn('customer');
    db.users.find((u) => u.id === s.userId)!.status = 'SUSPENDED';

    const me = await api().get('/api/v1/auth/me').set(bearer(s.accessToken)).expect(403);
    expect(me.body.code).toBe('ACCOUNT_NOT_ACTIVE');
    await api().post('/api/v1/auth/refresh').set('X-Forwarded-For', freshIp()).send({ refreshToken: s.refreshToken }).expect(403);

    const ip = freshIp();
    store.deleteByPrefix('otp:cooldown:');
    await api().post('/api/v1/auth/otp/request').set('X-Forwarded-For', ip).send({ phone: s.phone, app: 'customer' }).expect(200);
    const verify = await api().post('/api/v1/auth/otp/verify').set('X-Forwarded-For', ip).send({ phone: s.phone, code: sms.lastCode(s.phone), app: 'customer' });
    expect(verify.status).toBe(403);
    expect(verify.body.code).toBe('ACCOUNT_SUSPENDED');
  });

  it('an admin session also dies on logout', async () => {
    // Runs after the administrator tests, which rotated the bootstrap password.
    const login = await api()
      .post('/api/v1/auth/admin/login')
      .set('X-Forwarded-For', freshIp())
      .send({ email: ADMIN_EMAIL, password: 'rotated-Passw0rd-123' })
      .expect(200);
    await api().get('/api/v1/auth/me').set(bearer(login.body.accessToken)).expect(200);
    await api().post('/api/v1/auth/logout').set('X-Forwarded-For', freshIp()).send({ refreshToken: login.body.refreshToken }).expect(204);
    await api().get('/api/v1/auth/me').set(bearer(login.body.accessToken)).expect(401);
  });
});
