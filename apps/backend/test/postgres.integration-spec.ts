/**
 * REAL INFRASTRUCTURE TEST: talks to the PostgreSQL database in TEST_DATABASE_URL.
 *
 * Safety rules, enforced below:
 *  - TEST_DATABASE_URL must be set, and the database name must be exactly "home_services_test";
 *  - the migrations must already be applied (run `npm run db:migrate:deploy` with
 *    DATABASE_URL pointing at the test database; this suite never migrates, resets or drops);
 *  - the suite only creates rows with a reserved phone prefix and deletes only those rows.
 * Without TEST_DATABASE_URL the whole suite is skipped (and says so).
 */
import { randomInt } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, Role, UserStatus, WorkerVerificationStatus } from '../src/generated/prisma/client.js';
import { assertTestDatabaseMigrated, assertTestDatabaseName } from './migration-guard.js';
import type { PrismaService } from '../src/database/prisma.service.js';
import { AuditService } from '../src/modules/auth/audit.service.js';
import { AuthService } from '../src/modules/auth/auth.service.js';
import { OtpService } from '../src/modules/auth/otp/otp.service.js';
import { SessionsService } from '../src/modules/auth/sessions.service.js';
import { TokenService } from '../src/modules/auth/tokens/token.service.js';
import { MemoryKeyValueStore } from '../src/testing/memory-key-value.store.js';
import { CapturingSmsProvider, testConfigService } from '../src/testing/test-support.js';
import { purgeAuditLogsSince } from './support/audit-cleanup.js';

const URL = process.env['TEST_DATABASE_URL'];
const run = URL ? describe : describe.skip;
if (!URL) console.warn('postgres.integration-spec: TEST_DATABASE_URL is not set, suite skipped');

const PHONE_PREFIX = '+9665990'; // reserved for this suite
const newPhone = () => `${PHONE_PREFIX}${String(randomInt(10000, 99999))}`;

let prisma: PrismaClient;
let ready = false; // set once the target is verified as a migrated *_test database
/** Audit rows written by this run belong to the test database only (the name guard below guarantees it). */
const startedAt = new Date(Date.now() - 2000);

function dbNameOf(url: string): string {
  return decodeURIComponent(new globalThis.URL(url).pathname.slice(1));
}

async function cleanup() {
  await prisma.user.deleteMany({ where: { phone: { startsWith: PHONE_PREFIX } } });
}

/** Audit rows keep no link to a deleted user, so remove the ones this run created by time window. */
async function cleanupAudit() {
  await purgeAuditLogsSince(prisma, startedAt);
}

run('real PostgreSQL: schema, constraints and auth flows', () => {
  beforeAll(async () => {
    const name = dbNameOf(URL!);
    assertTestDatabaseName(name);
    prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: URL, options: '-c TimeZone=UTC' }) }); // same as PrismaService
    await prisma.$queryRaw`SELECT 1`;
    await assertTestDatabaseMigrated(prisma);
    ready = true;
    await cleanup();
  });

  afterAll(async () => {
    if (prisma) {
      if (ready) {
        await cleanup();
        await cleanupAudit();
      }
      await prisma.$disconnect();
    }
  });

  it('has every migration in this repository applied and finished', async () => {
    const rows = await prisma.$queryRaw<{ migration_name: string; finished_at: Date | null; rolled_back_at: Date | null }[]>`
      SELECT migration_name, finished_at, rolled_back_at FROM _prisma_migrations`;
    const done = rows.filter((r) => r.finished_at && !r.rolled_back_at).map((r) => r.migration_name);
    expect(done).toEqual(expect.arrayContaining([expect.stringMatching(/_init$/), expect.stringMatching(/_auth_foundation$/)]));
  });

  it('creates UUID v7 ids and enforces unique phone numbers', async () => {
    const phone = newPhone();
    const user = await prisma.user.create({ data: { phone } });
    expect(user.id[14]).toBe('7');
    await expect(prisma.user.create({ data: { phone } })).rejects.toMatchObject({ code: 'P2002' });
  });

  it('requires a phone or an email (CHECK constraint)', async () => {
    await expect(prisma.user.create({ data: {} })).rejects.toBeDefined();
    const email = `itest-${randomInt(100000, 999999)}@example.com`;
    const admin = await prisma.user.create({ data: { email, roles: { create: [{ role: Role.ADMIN }] } } });
    expect(admin.phone).toBeNull();
    await prisma.user.delete({ where: { id: admin.id } });
  });

  it('cascades roles, profiles and tokens when a user is deleted', async () => {
    const user = await prisma.user.create({
      data: {
        phone: newPhone(),
        roles: { create: [{ role: Role.CUSTOMER }, { role: Role.WORKER }] },
        customerProfile: { create: {} },
        workerProfile: { create: {} },
      },
    });
    await prisma.refreshToken.create({
      data: { userId: user.id, tokenHash: 'a'.repeat(64), familyId: user.id, sessionRole: Role.CUSTOMER, expiresAt: new Date(Date.now() + 1000) },
    });
    await prisma.user.delete({ where: { id: user.id } });
    expect(await prisma.userRole.count({ where: { userId: user.id } })).toBe(0);
    expect(await prisma.workerProfile.count({ where: { userId: user.id } })).toBe(0);
    expect(await prisma.refreshToken.count({ where: { userId: user.id } })).toBe(0);
  });

  function services() {
    const config = testConfigService();
    const service = prisma as unknown as PrismaService;
    const store = new MemoryKeyValueStore();
    const sms = new CapturingSmsProvider();
    const tokens = new TokenService(config);
    const audit = new AuditService(service);
    const sessions = new SessionsService(config, service, tokens, audit);
    const otp = new OtpService(config, store, sms);
    const auth = new AuthService(config, service, otp, sessions, audit);
    return { store, sms, sessions, otp, auth };
  }

  it('signs a worker up through the OTP flow and starts them unverified', async () => {
    const { sms, otp, auth } = services();
    const phone = newPhone();
    await otp.request(phone, '203.0.113.1');
    const session = await auth.verifyOtp({ phone, code: sms.lastCode(phone), app: 'worker' }, { ip: '203.0.113.1' });
    expect(session.isNewUser).toBe(true);
    expect(session.user.roles).toEqual([Role.WORKER]);
    expect(session.user.workerVerificationStatus).toBe(WorkerVerificationStatus.NOT_SUBMITTED);
    expect(JSON.stringify(session)).not.toMatch(/passwordHash|tokenHash/);
    const stored = await prisma.refreshToken.findMany({ where: { userId: session.user.id } });
    expect(stored).toHaveLength(1);
    expect(JSON.stringify(stored)).not.toContain(session.refreshToken);
  });

  it('adds the second role to the same account instead of creating a duplicate', async () => {
    const { sms, otp, auth } = services();
    const phone = newPhone();
    await otp.request(phone, '203.0.113.2');
    const first = await auth.verifyOtp({ phone, code: sms.lastCode(phone), app: 'customer' }, {});
    // A second service set has its own store, so it is not held back by the resend cooldown.
    const second = services();
    await second.otp.request(phone, '203.0.113.3');
    const worker = await second.auth.verifyOtp({ phone, code: second.sms.lastCode(phone), app: 'worker' }, {});
    expect(worker.user.id).toBe(first.user.id);
    expect(worker.user.roles.sort()).toEqual([Role.CUSTOMER, Role.WORKER]);
    expect(await prisma.user.count({ where: { phone } })).toBe(1);
  });

  it('survives two simultaneous first sign-ins for the same new number (unique-violation race)', async () => {
    const { sms, otp, auth } = services();
    const phone = newPhone();
    // The same code submitted twice at the same moment.
    await otp.request(phone, '203.0.113.4');
    const codeA = sms.lastCode(phone);
    const results = await Promise.allSettled([
      auth.verifyOtp({ phone, code: codeA, app: 'customer' }, {}),
      auth.verifyOtp({ phone, code: codeA, app: 'customer' }, {}),
    ]);
    // Only one can consume the code; whatever happens, there is exactly one account.
    expect(results.some((r) => r.status === 'fulfilled')).toBe(true);
    expect(await prisma.user.count({ where: { phone } })).toBe(1);
  });

  it('rotates refresh tokens, detects replay and revokes the session', async () => {
    const { sms, otp, auth, sessions } = services();
    const phone = newPhone();
    await otp.request(phone, '203.0.113.5');
    const s = await auth.verifyOtp({ phone, code: sms.lastCode(phone), app: 'customer' }, {});

    const next = await auth.refresh(s.refreshToken, {});
    expect(next.refreshToken).not.toBe(s.refreshToken);
    await expect(auth.refresh(s.refreshToken, {})).rejects.toMatchObject({ code: 'REFRESH_TOKEN_REUSED' });
    await expect(auth.refresh(next.refreshToken, {})).rejects.toMatchObject({ code: 'REFRESH_TOKEN_REVOKED' });
    const family = (await prisma.refreshToken.findFirstOrThrow({ where: { userId: s.user.id } })).familyId;
    expect(await sessions.isActive(family, s.user.id)).toBe(false);
  });

  it('refuses refresh for a suspended account', async () => {
    const { sms, otp, auth } = services();
    const phone = newPhone();
    await otp.request(phone, '203.0.113.6');
    const s = await auth.verifyOtp({ phone, code: sms.lastCode(phone), app: 'customer' }, {});
    await prisma.user.update({ where: { id: s.user.id }, data: { status: UserStatus.SUSPENDED } });
    await expect(auth.refresh(s.refreshToken, {})).rejects.toMatchObject({ code: 'ACCOUNT_NOT_ACTIVE' });
  });

  it('purges only stale refresh tokens', async () => {
    const { sessions } = services();
    const user = await prisma.user.create({ data: { phone: newPhone() } });
    const day = 24 * 3600 * 1000;
    const row = (n: string, extra: object) => ({
      userId: user.id,
      tokenHash: n.repeat(64).slice(0, 64),
      familyId: user.id,
      sessionRole: Role.CUSTOMER,
      expiresAt: new Date(Date.now() + 10 * day),
      ...extra,
    });
    await prisma.refreshToken.createMany({
      data: [
        row('1', {}),
        row('2', { expiresAt: new Date(Date.now() - 9 * day) }),
        row('3', { revokedAt: new Date(Date.now() - 9 * day) }),
        row('4', { usedAt: new Date(Date.now() - 9 * day) }),
        row('5', { usedAt: new Date(Date.now() - 1 * day) }),
      ],
    });
    const before = await prisma.refreshToken.count();
    const result = await sessions.purgeStale(7);
    expect(result.expired + result.revoked + result.spent).toBeGreaterThanOrEqual(3);
    const left = await prisma.refreshToken.findMany({ where: { userId: user.id }, select: { tokenHash: true } });
    expect(left.map((r) => r.tokenHash[0]).sort()).toEqual(['1', '5']);
    expect(await prisma.refreshToken.count()).toBeLessThanOrEqual(before);
  });
});
