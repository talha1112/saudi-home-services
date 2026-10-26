/**
 * REAL POSTGRESQL, FULL HTTP STACK, Firebase boundary replaced by a test double (FakeFirebaseIdentityVerifier).
 * Covers sign-in with a Firebase ID token: what is accepted, what is refused and why, account ownership rules, sessions, replay and
 * the "feature off" behaviour. What it cannot prove: Firebase's own signature check (done by the Firebase Admin SDK against a real project
 * or the Auth Emulator) - see docs/FIREBASE_SETUP.md.
 */
import { Role, UserStatus } from '../src/generated/prisma/client.js';
import { AuditIntegrityCheck } from '../src/modules/auth/firebase/audit-integrity-check.service.js';
import { type Harness, bootHarness } from './support/bookings-harness.js';

const run = process.env['TEST_DATABASE_URL'] ? describe : describe.skip;
if (!process.env['TEST_DATABASE_URL']) console.warn('firebase-auth.integration-spec: TEST_DATABASE_URL is not set, suite skipped');

const INTERNATIONAL = ['+14155552671', '+442071838750'];
const ENABLED = { FIREBASE_AUTH_ENABLED: 'true', FIREBASE_PROJECT_ID: 'hs-test-project' };

const url = '/api/v1/auth/firebase/phone';

run('Firebase phone sign-in (real PostgreSQL, Firebase double)', () => {
  let h: Harness;
  let hOff: Harness;
  let hAdopt: Harness;

  const call = (hh: Harness, idToken: string, app: string = 'customer', extra: object = {}) =>
    hh.api().post(url).set('X-Forwarded-For', hh.freshIp()).send({ idToken, app, ...extra });
  const callMain = (idToken: string, app: string = 'customer', extra: object = {}) => call(h, idToken, app, extra);
  const userByPhone = (hh: Harness, phone: string) => hh.prisma.user.findUnique({ where: { phone }, include: { roles: true, workerProfile: true, customerProfile: true } });
  const sessionsOf = (hh: Harness, userId: string) => hh.prisma.refreshToken.count({ where: { userId } });
  const auditOf = (hh: Harness, userId: string, action: string) => hh.prisma.auditLog.findMany({ where: { actorUserId: userId, action }, orderBy: { createdAt: 'asc' } });
  /** A verified, active, phone-verified account that Firebase sign-in did NOT create (no recorded Firebase identity). */
  const preexisting = (hh: Harness, phone: string, over: object = {}) =>
    hh.prisma.user.create({ data: { phone, status: UserStatus.ACTIVE, phoneVerifiedAt: new Date(), roles: { create: [{ role: Role.CUSTOMER }] }, customerProfile: { create: {} }, ...over } });

  beforeAll(async () => {
    hAdopt = await bootHarness({ phonePrefix: '+9665975', slugPrefix: 'itest-fa-', adminEmailPrefix: 'itest-fa-admin', env: { ...ENABLED, FIREBASE_ALLOW_PHONE_ACCOUNT_ADOPTION: 'true' } });
    hOff = await bootHarness({ phonePrefix: '+9665976', slugPrefix: 'itest-fo-', adminEmailPrefix: 'itest-fo-admin' });
    h = await bootHarness({ phonePrefix: '+9665977', slugPrefix: 'itest-fb-', adminEmailPrefix: 'itest-fb-admin', env: ENABLED });
    await h.prisma.user.deleteMany({ where: { phone: { in: INTERNATIONAL } } });
  });

  afterAll(async () => {
    if (h) {
      await h.prisma.user.deleteMany({ where: { phone: { in: INTERNATIONAL } } }); // international numbers are outside the harness's prefix cleanup
      await h.close();
    }
    if (hOff) await hOff.close();
    if (hAdopt) await hAdopt.close();
  });

  describe('switched off (the default)', () => {
    it('answers 503, never calls Firebase and creates nothing; the code flow endpoints are still there', async () => {
      const phone = hOff.freshPhone();
      const token = hOff.firebase.mint({ phoneNumber: phone });
      const res = await call(hOff, token);
      expect(res.status).toBe(503);
      expect(res.body.code).toBe('FIREBASE_AUTH_NOT_CONFIGURED');
      expect(hOff.firebase.verifyCalls).toBe(0);
      expect(await userByPhone(hOff, phone)).toBeNull();
      expect((await hOff.api().post('/api/v1/auth/otp/request').set('X-Forwarded-For', hOff.freshIp()).send({ phone: hOff.freshPhone(), app: 'customer' })).status).toBe(200);
    });
  });

  describe('a valid sign-in', () => {
    it('creates a customer, issues the usual session and records which Firebase identity the account belongs to', async () => {
      const phone = h.freshPhone();
      const uid = 'uid-customer-1';
      const token = h.firebase.mint({ phoneNumber: phone, uid });
      const res = await callMain(token).expect(200);
      expect(res.body).toMatchObject({ tokenType: 'Bearer', isNewUser: true, user: { phone, roles: ['CUSTOMER'], activeRole: 'CUSTOMER', status: 'ACTIVE' } });
      expect(res.body.accessToken).toEqual(expect.any(String));
      expect(res.body.refreshToken).toEqual(expect.any(String));

      const user = (await userByPhone(h, phone))!;
      expect(user.status).toBe('ACTIVE');
      expect(user.phoneVerifiedAt).toBeInstanceOf(Date);
      expect(user.customerProfile).not.toBeNull();
      expect((await auditOf(h, user.id, 'auth.firebase_identity_bound')).map((a) => a.metadata)).toEqual([{ firebaseUid: uid, reason: 'created' }]);
      expect((await auditOf(h, user.id, 'user.registered')).length).toBe(1);
      expect((await auditOf(h, user.id, 'auth.sign_in'))[0]!.metadata).toMatchObject({ method: 'firebase_phone', newUser: true });

      const me = await h.api().get('/api/v1/auth/me').set(h.bearer(res.body.accessToken)).expect(200);
      expect(me.body.id).toBe(user.id);
    });

    it('creates a worker who is NOT approved: worker routes stay closed', async () => {
      const phone = h.freshPhone();
      const res = await callMain(h.firebase.mint({ phoneNumber: phone }), 'worker').expect(200);
      expect(res.body.user).toMatchObject({ roles: ['WORKER'], activeRole: 'WORKER', workerVerificationStatus: 'NOT_SUBMITTED' });
      const blocked = await h.api().get('/api/v1/workers/me/requests').set(h.bearer(res.body.accessToken));
      expect(blocked.status).toBe(403);
      expect(blocked.body.code).toBe('WORKER_NOT_APPROVED');
    });

    it('accepts international numbers in E.164, Saudi or not', async () => {
      for (const [i, phone] of INTERNATIONAL.entries()) {
        const res = await callMain(h.firebase.mint({ phoneNumber: phone }), i === 0 ? 'customer' : 'worker').expect(200);
        expect(res.body.user.phone).toBe(phone);
      }
    });

    it('signs the same Firebase identity in again, and adds the worker role when the same person uses the worker app (still unapproved)', async () => {
      const phone = h.freshPhone();
      const uid = 'uid-two-apps';
      await callMain(h.firebase.mint({ phoneNumber: phone, uid })).expect(200);
      const again = await callMain(h.firebase.mint({ phoneNumber: phone, uid })).expect(200);
      expect(again.body.isNewUser).toBe(false);
      const asWorker = await callMain(h.firebase.mint({ phoneNumber: phone, uid }), 'worker').expect(200);
      expect(asWorker.body.user.roles.sort()).toEqual(['CUSTOMER', 'WORKER']);
      expect(asWorker.body.user.workerVerificationStatus).toBe('NOT_SUBMITTED');
      const user = (await userByPhone(h, phone))!;
      expect((await auditOf(h, user.id, 'user.role_granted')).length).toBe(1);
      expect((await h.api().get('/api/v1/workers/me/requests').set(h.bearer(asWorker.body.accessToken))).status).toBe(403);
    });
  });

  describe('the request cannot carry identity', () => {
    it('rejects a phone number, user id, role or app that the token should decide', async () => {
      const token = h.firebase.mint({ phoneNumber: h.freshPhone() });
      for (const extra of [{ phone: '+966500000000' }, { userId: 'x' }, { role: 'ADMIN' }, { uid: 'someone-else' }]) {
        expect((await callMain(token, 'customer', extra)).status).toBe(400);
      }
      expect((await callMain(token, 'admin')).status).toBe(400);
    });

    it('rejects things that are not shaped like an ID token before Firebase is asked', async () => {
      const before = h.firebase.verifyCalls;
      for (const bad of ['abc', 'a.b.c', 'x'.repeat(200), `${'a'.repeat(60)}.${'b'.repeat(60)} ${'c'.repeat(20)}`]) {
        expect((await callMain(bad)).status).toBe(400);
      }
      expect((await h.api().post(url).set('X-Forwarded-For', h.freshIp()).send({ app: 'customer' })).status).toBe(400);
      expect(h.firebase.verifyCalls).toBe(before);
    });
  });

  describe('tokens that are refused', () => {
    const noTrace = async (phone: string) => expect(await userByPhone(h, phone)).toBeNull();

    it('a token Firebase does not recognise, one from the wrong project, revoked, disabled: all the same 401, and nothing is created', async () => {
      const phone = h.freshPhone();
      const unknown = `${h.firebase.mint({ phoneNumber: phone })}x`; // altered after "signing": the double no longer knows it
      for (const token of [unknown, h.firebase.mintFailure('INVALID'), h.firebase.mintFailure('REVOKED'), h.firebase.mintFailure('USER_DISABLED')]) {
        const res = await callMain(token);
        expect(res.status).toBe(401);
        expect(res.body.code).toBe('FIREBASE_TOKEN_INVALID');
        expect(JSON.stringify(res.body)).not.toContain(token);
      }
      await noTrace(phone);
    });

    it('an expired token says so (the app can ask Firebase for a new one)', async () => {
      const res = await callMain(h.firebase.mintFailure('EXPIRED'));
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('FIREBASE_TOKEN_EXPIRED');
    });

    it('a Firebase outage is a 503, not a 401, and creates nothing', async () => {
      const phone = h.freshPhone();
      const res = await callMain(h.firebase.mintFailure('UNAVAILABLE'));
      expect(res.status).toBe(503);
      expect(res.body.code).toBe('FIREBASE_UNAVAILABLE');
      await noTrace(phone);
    });

    it('a Firebase token that is not a phone sign-in (anonymous, password, Google) is refused', async () => {
      for (const provider of ['anonymous', 'password', 'google.com', 'custom']) {
        const phone = h.freshPhone();
        const res = await callMain(h.firebase.mint({ phoneNumber: phone, signInProvider: provider }));
        expect(res.status).toBe(401);
        expect(res.body.code).toBe('FIREBASE_PROVIDER_NOT_ALLOWED');
        await noTrace(phone);
      }
    });

    it('a token without a phone number, or with a number that is not canonical E.164, is refused', async () => {
      const missing = await callMain(h.firebase.mint({ phoneNumber: undefined }));
      expect(missing.status).toBe(401);
      expect(missing.body.code).toBe('FIREBASE_PHONE_MISSING');
      for (const claim of ['0501234567', '+966 50 123 4567', '+9665', 'not-a-number', '+966501234567 ']) {
        const res = await callMain(h.firebase.mint({ phoneNumber: claim }));
        expect(res.status).toBe(401);
        expect(res.body.code).toBe('FIREBASE_PHONE_INVALID');
      }
      expect(await h.prisma.user.count({ where: { phone: { in: ['0501234567', '+966501234567', ' +966501234567'] } } })).toBe(0);
    });

    it('a token whose phone check happened too long ago is refused, a recent one is accepted, a future one is refused', async () => {
      const old = await callMain(h.firebase.mint({ phoneNumber: h.freshPhone(), authTime: new Date(Date.now() - 10 * 60_000) }));
      expect(old.status).toBe(401);
      expect(old.body.code).toBe('FIREBASE_TOKEN_STALE');
      const recent = await callMain(h.firebase.mint({ phoneNumber: h.freshPhone(), authTime: new Date(Date.now() - 4 * 60_000) }));
      expect(recent.status).toBe(200);
      const future = await callMain(h.firebase.mint({ phoneNumber: h.freshPhone(), authTime: new Date(Date.now() + 10 * 60_000) }));
      expect(future.status).toBe(401);
    });

    it('a Firebase user id outside the safe character set or length is refused (it becomes a stored binding)', async () => {
      for (const uid of ['has space', 'dot.dot', 'x'.repeat(129), '', 'Bearer abc', 'a?sig=1', '-----BEGIN KEY-----']) {
        const phone = h.freshPhone();
        const res = await callMain(h.firebase.mint({ phoneNumber: phone, uid }));
        expect(res.status).toBe(401);
        expect(res.body.code).toBe('FIREBASE_TOKEN_INVALID');
        await noTrace(phone);
      }
    });

    it('a token can be exchanged once; a replay (also several at once) gets exactly one session', async () => {
      const phone = h.freshPhone();
      const token = h.firebase.mint({ phoneNumber: phone });
      await callMain(token).expect(200);
      const replay = await callMain(token);
      expect(replay.status).toBe(401);
      expect(replay.body.code).toBe('FIREBASE_TOKEN_REPLAYED');
      const user = (await userByPhone(h, phone))!;
      expect(await sessionsOf(h, user.id)).toBe(1);

      const racePhone = h.freshPhone();
      const raceToken = h.firebase.mint({ phoneNumber: racePhone });
      const results = await Promise.all(Array.from({ length: 6 }, () => callMain(raceToken)));
      expect(results.filter((r) => r.status === 200)).toHaveLength(1);
      expect(results.filter((r) => r.status === 401).every((r) => r.body.code === 'FIREBASE_TOKEN_REPLAYED')).toBe(true);
      expect(await sessionsOf(h, (await userByPhone(h, racePhone))!.id)).toBe(1);
    });

    it('a refused sign-in does not use the token up', async () => {
      const phone = h.freshPhone();
      const first = await callMain(h.firebase.mint({ phoneNumber: phone, uid: 'uid-keep' })).expect(200);
      expect(first.status).toBe(200);
      await h.prisma.user.update({ where: { phone }, data: { status: UserStatus.SUSPENDED } });
      const token = h.firebase.mint({ phoneNumber: phone, uid: 'uid-keep' });
      expect((await callMain(token)).status).toBe(403);
      expect((await callMain(token)).body.code).toBe('ACCOUNT_SUSPENDED'); // still the account refusal, not "replayed"
    });

    it('is rate limited per client address', async () => {
      const ip = h.freshIp();
      const statuses: number[] = [];
      for (let i = 0; i < 22; i++) statuses.push((await h.api().post(url).set('X-Forwarded-For', ip).send({ idToken: h.firebase.mintFailure('INVALID'), app: 'customer' })).status);
      expect(statuses.slice(0, 20).every((s) => s === 401)).toBe(true);
      expect(statuses.slice(20)).toEqual([429, 429]);
    });
  });

  describe('concurrent first sign-ins for one number', () => {
    it('the same Firebase identity with several tokens at once: one account, one binding, everyone signed in', async () => {
      const phone = h.freshPhone();
      const results = await Promise.all(Array.from({ length: 5 }, () => callMain(h.firebase.mint({ phoneNumber: phone, uid: 'uid-race-same' }))));
      expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
      expect(results.filter((r) => r.body.isNewUser === true)).toHaveLength(1);
      expect(await h.prisma.user.count({ where: { phone } })).toBe(1);
      const user = (await userByPhone(h, phone))!;
      expect((await auditOf(h, user.id, 'auth.firebase_identity_bound')).length).toBe(1);
      expect((await auditOf(h, user.id, 'user.registered')).length).toBe(1);
      expect(await sessionsOf(h, user.id)).toBe(5);
    });

    it('two DIFFERENT Firebase identities at once: exactly one wins the number, the other is refused, and the loser leaves no trace', async () => {
      const phone = h.freshPhone();
      const results = await Promise.all(['uid-race-a', 'uid-race-b', 'uid-race-c'].map((uid) => callMain(h.firebase.mint({ phoneNumber: phone, uid }))));
      expect(results.filter((r) => r.status === 200)).toHaveLength(1);
      const losers = results.filter((r) => r.status !== 200);
      expect(losers).toHaveLength(2);
      expect(losers.every((r) => r.status === 409 && r.body.code === 'FIREBASE_IDENTITY_CONFLICT')).toBe(true);
      expect(await h.prisma.user.count({ where: { phone } })).toBe(1);
      const user = (await userByPhone(h, phone))!;
      const bound = await auditOf(h, user.id, 'auth.firebase_identity_bound');
      expect(bound).toHaveLength(1); // the loser's insert was rolled back together with its failed account creation
      expect(await sessionsOf(h, user.id)).toBe(1);
      const winnerUid = (bound[0]!.metadata as { firebaseUid: string }).firebaseUid;
      await callMain(h.firebase.mint({ phoneNumber: phone, uid: winnerUid })).expect(200);
    });
  });

  describe('the identity binding cannot be rewritten', () => {
    it('the real database passes the start-up integrity check (both audit triggers present, enabled and correct)', async () => {
      await expect(h.app.get(AuditIntegrityCheck, { strict: false }).verify()).resolves.toBeUndefined();
    });

    it('the append-only audit trail refuses to change or delete the binding entry', async () => {
      const phone = h.freshPhone();
      await callMain(h.firebase.mint({ phoneNumber: phone, uid: 'uid-immutable' })).expect(200);
      const user = (await userByPhone(h, phone))!;
      const [entry] = await auditOf(h, user.id, 'auth.firebase_identity_bound');
      await expect(h.prisma.auditLog.update({ where: { id: entry!.id }, data: { metadata: { firebaseUid: 'uid-attacker', reason: 'created' } } })).rejects.toThrow(/append-only/);
      await expect(h.prisma.auditLog.delete({ where: { id: entry!.id } })).rejects.toThrow(/append-only/);
      expect((await auditOf(h, user.id, 'auth.firebase_identity_bound'))[0]!.metadata).toEqual({ firebaseUid: 'uid-immutable', reason: 'created' });
      expect((await callMain(h.firebase.mint({ phoneNumber: phone, uid: 'uid-attacker' }))).status).toBe(409);
    });
  });

  describe('accounts that already exist (identity ownership)', () => {
    it('an account Firebase sign-in did not create is NOT handed to whoever verifies its number: 409 and nothing changes', async () => {
      const phone = h.freshPhone();
      const owner = await preexisting(h, phone);
      const res = await callMain(h.firebase.mint({ phoneNumber: phone }), 'worker');
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('ACCOUNT_LINK_REVIEW_REQUIRED');
      expect(res.body.message).not.toMatch(/uid|firebase/i); // says nothing about which identity is linked
      const after = (await userByPhone(h, phone))!;
      expect(after.roles.map((r) => r.role)).toEqual(['CUSTOMER']); // no worker role was granted
      expect(after.lastLoginAt).toBeNull();
      expect(await sessionsOf(h, owner.id)).toBe(0);
      expect((await auditOf(h, owner.id, 'auth.firebase_link_refused')).map((a) => (a.metadata as { reason: string }).reason)).toEqual(['no_recorded_firebase_identity']);
    });

    it('a number that was never verified cannot be claimed through Firebase', async () => {
      const phone = h.freshPhone();
      const u = await preexisting(h, phone, { phoneVerifiedAt: null, status: UserStatus.PENDING_VERIFICATION });
      const res = await callMain(h.firebase.mint({ phoneNumber: phone }));
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('ACCOUNT_LINK_REVIEW_REQUIRED');
      expect((await userByPhone(h, phone))!.status).toBe('PENDING_VERIFICATION');
      expect(await sessionsOf(h, u.id)).toBe(0);
    });

    it('a DIFFERENT Firebase identity for a number that is already linked is refused, and the real owner still works', async () => {
      const phone = h.freshPhone();
      await callMain(h.firebase.mint({ phoneNumber: phone, uid: 'uid-owner' })).expect(200);
      const intruder = await callMain(h.firebase.mint({ phoneNumber: phone, uid: 'uid-new-identity' }));
      expect(intruder.status).toBe(409);
      expect(intruder.body.code).toBe('FIREBASE_IDENTITY_CONFLICT');
      const user = (await userByPhone(h, phone))!;
      expect(await sessionsOf(h, user.id)).toBe(1); // only the owner's first sign-in
      expect((await auditOf(h, user.id, 'auth.firebase_link_refused')).length).toBe(1);
      await callMain(h.firebase.mint({ phoneNumber: phone, uid: 'uid-owner' })).expect(200);
    });

    it('an administrator account can never be reached with a phone number', async () => {
      const phone = h.freshPhone();
      const admin = await h.prisma.user.create({
        data: { phone, phoneVerifiedAt: new Date(), email: `itest-fb-admin-${Date.now()}@example.com`, status: UserStatus.ACTIVE, roles: { create: [{ role: Role.ADMIN }] } },
      });
      for (const app of ['customer', 'worker']) {
        const res = await callMain(h.firebase.mint({ phoneNumber: phone }), app);
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('ACCOUNT_NOT_ELIGIBLE');
      }
      expect((await userByPhone(h, phone))!.roles.map((r) => r.role)).toEqual(['ADMIN']);
      expect(await sessionsOf(h, admin.id)).toBe(0);
    });

    it('suspended and deactivated accounts get no session, and signing in works again after reactivation', async () => {
      const phone = h.freshPhone();
      const uid = 'uid-status';
      await callMain(h.firebase.mint({ phoneNumber: phone, uid })).expect(200);
      const user = (await userByPhone(h, phone))!;
      const before = await sessionsOf(h, user.id);
      for (const [status, code] of [[UserStatus.SUSPENDED, 'ACCOUNT_SUSPENDED'], [UserStatus.DEACTIVATED, 'ACCOUNT_DEACTIVATED']] as const) {
        await h.prisma.user.update({ where: { id: user.id }, data: { status } });
        const res = await callMain(h.firebase.mint({ phoneNumber: phone, uid }));
        expect(res.status).toBe(403);
        expect(res.body.code).toBe(code);
        expect(await sessionsOf(h, user.id)).toBe(before);
      }
      await h.prisma.user.update({ where: { id: user.id }, data: { status: UserStatus.ACTIVE } });
      await callMain(h.firebase.mint({ phoneNumber: phone, uid })).expect(200);
    });
  });

  describe('sessions are the existing ones', () => {
    it('refresh tokens rotate, an old one cannot be replayed, and logout ends the session', async () => {
      const first = (await callMain(h.firebase.mint({ phoneNumber: h.freshPhone() })).expect(200)).body;
      const second = (await h.api().post('/api/v1/auth/refresh').set('X-Forwarded-For', h.freshIp()).send({ refreshToken: first.refreshToken }).expect(200)).body;
      expect(second.refreshToken).not.toBe(first.refreshToken);
      const replay = await h.api().post('/api/v1/auth/refresh').set('X-Forwarded-For', h.freshIp()).send({ refreshToken: first.refreshToken });
      expect(replay.status).toBe(401);
      expect((await h.api().post('/api/v1/auth/refresh').set('X-Forwarded-For', h.freshIp()).send({ refreshToken: second.refreshToken })).status).toBe(401); // reuse revoked the whole family

      const third = (await callMain(h.firebase.mint({ phoneNumber: h.freshPhone() })).expect(200)).body;
      await h.api().post('/api/v1/auth/logout').set('X-Forwarded-For', h.freshIp()).send({ refreshToken: third.refreshToken }).expect(204);
      expect((await h.api().post('/api/v1/auth/refresh').set('X-Forwarded-For', h.freshIp()).send({ refreshToken: third.refreshToken })).status).toBe(401);
    });
  });

  describe('secrets stay out of the data', () => {
    it('no ID token (or a piece of one) is written to the audit trail or echoed in any answer', async () => {
      const phone = h.freshPhone();
      const token = h.firebase.mint({ phoneNumber: phone });
      const ok = await callMain(token).expect(200);
      const bad = await callMain(h.firebase.mintFailure('INVALID'));
      const user = (await userByPhone(h, phone))!;
      const trail = JSON.stringify(await h.prisma.auditLog.findMany({ where: { actorUserId: user.id } }));
      for (const piece of [token, token.slice(0, 50), token.split('.')[1]!.slice(0, 30)]) {
        expect(trail).not.toContain(piece);
        expect(JSON.stringify(ok.body)).not.toContain(piece);
      }
      expect(JSON.stringify(bad.body)).not.toMatch(/eyJ|[A-Za-z0-9_-]{80,}/);
    });
  });

  describe('demo account adoption (FIREBASE_ALLOW_PHONE_ACCOUNT_ADOPTION=true)', () => {
    it('lets a verified number adopt an existing account, and records it', async () => {
      const phone = hAdopt.freshPhone();
      const owner = await preexisting(hAdopt, phone);
      const res = await call(hAdopt, hAdopt.firebase.mint({ phoneNumber: phone, uid: 'uid-demo' })).expect(200);
      expect(res.body.isNewUser).toBe(false);
      expect((await auditOf(hAdopt, owner.id, 'auth.firebase_identity_bound')).map((a) => a.metadata)).toEqual([{ firebaseUid: 'uid-demo', reason: 'adopted' }]);
    });

    it('lets a changed Firebase identity in, with an explicit audit entry', async () => {
      const phone = hAdopt.freshPhone();
      await call(hAdopt, hAdopt.firebase.mint({ phoneNumber: phone, uid: 'uid-a' })).expect(200);
      await call(hAdopt, hAdopt.firebase.mint({ phoneNumber: phone, uid: 'uid-b' })).expect(200);
      const user = (await userByPhone(hAdopt, phone))!;
      expect((await auditOf(hAdopt, user.id, 'auth.firebase_identity_changed')).length).toBe(1);
      expect((await auditOf(hAdopt, user.id, 'auth.firebase_identity_bound')).map((a) => (a.metadata as { reason: string }).reason)).toEqual(['created', 'changed']);
    });

    it('still never reaches an administrator, an unverified number, or a suspended account', async () => {
      const adminPhone = hAdopt.freshPhone();
      await hAdopt.prisma.user.create({ data: { phone: adminPhone, phoneVerifiedAt: new Date(), email: `itest-fa-admin-${Date.now()}@example.com`, status: UserStatus.ACTIVE, roles: { create: [{ role: Role.ADMIN }] } } });
      expect((await call(hAdopt, hAdopt.firebase.mint({ phoneNumber: adminPhone }))).body.code).toBe('ACCOUNT_NOT_ELIGIBLE');

      const unverified = hAdopt.freshPhone();
      await preexisting(hAdopt, unverified, { phoneVerifiedAt: null, status: UserStatus.PENDING_VERIFICATION });
      expect((await call(hAdopt, hAdopt.firebase.mint({ phoneNumber: unverified }))).status).toBe(409);

      const suspended = hAdopt.freshPhone();
      await preexisting(hAdopt, suspended, { status: UserStatus.SUSPENDED });
      expect((await call(hAdopt, hAdopt.firebase.mint({ phoneNumber: suspended }))).body.code).toBe('ACCOUNT_SUSPENDED');
    });
  });
});
