/** REAL POSTGRESQL: a customer sets their own name (the profile screen's Edit). */
import { type Harness, bootHarness } from './support/bookings-harness.js';

const run = process.env['TEST_DATABASE_URL'] ? describe : describe.skip;
if (!process.env['TEST_DATABASE_URL']) console.warn('profile-me.integration-spec: TEST_DATABASE_URL is not set, suite skipped');

run('my profile (real PostgreSQL)', () => {
  let h: Harness;
  const as = (t: { accessToken: string }) => h.bearer(t.accessToken);

  beforeAll(async () => {
    h = await bootHarness({ phonePrefix: '+9665987', slugPrefix: 'itest-pm-', adminEmailPrefix: 'itest-pm-admin' });
  });
  afterAll(async () => {
    if (h) await h.close();
  });

  it('lets a customer set their name, tidies spaces, and shows it everywhere the app reads it', async () => {
    const me = await h.makeCustomer();
    expect((await h.api().get('/api/v1/customers/me').set(as(me)).expect(200)).body.fullName).toBeNull();
    const res = await h.api().patch('/api/v1/customers/me').set(as(me)).send({ fullName: '  Sara   Al-Qahtani ' }).expect(200);
    expect(res.body).toMatchObject({ userId: me.userId, fullName: 'Sara Al-Qahtani' });
    expect((await h.api().get('/api/v1/auth/me').set(as(me)).expect(200)).body.fullName).toBe('Sara Al-Qahtani');
    expect((await h.prisma.user.findUniqueOrThrow({ where: { id: me.userId } })).fullName).toBe('Sara Al-Qahtani');
  });

  it('refuses a name that is too short, too long, not text, or from someone who is not a customer', async () => {
    const me = await h.makeCustomer();
    for (const fullName of ['', ' a ', 'x'.repeat(121), 42, null]) {
      await h.api().patch('/api/v1/customers/me').set(as(me)).send({ fullName }).expect(400);
    }
    await h.api().patch('/api/v1/customers/me').set(as(me)).send({ fullName: 'Ok Name', role: 'ADMIN', status: 'SUSPENDED' }).expect((r) => expect([200, 400]).toContain(r.status));
    expect((await h.prisma.user.findUniqueOrThrow({ where: { id: me.userId } })).status).not.toBe('SUSPENDED');
    await h.api().patch('/api/v1/customers/me').send({ fullName: 'Nobody' }).expect(401);
    const ref = await h.seedReferenceData();
    const worker = await h.makeWorker([ref.service.id], [ref.city.id]);
    await h.api().patch('/api/v1/customers/me').set(as(worker)).send({ fullName: 'Not A Customer' }).expect(403);
  });
});

run('my language and my photo (real PostgreSQL)', () => {
  let h: Harness;
  let ref: Awaited<ReturnType<Harness['seedReferenceData']>>;
  const as = (t: { accessToken: string }) => h.bearer(t.accessToken);

  beforeAll(async () => {
    h = await bootHarness({ phonePrefix: '+9665988', slugPrefix: 'itest-pl-', adminEmailPrefix: 'itest-pl-admin' });
    ref = await h.seedReferenceData();
  });
  afterAll(async () => {
    if (h) await h.close();
  });

  it('keeps the language the app tells it, for customers and workers, and refuses anything else', async () => {
    const me = await h.makeCustomer();
    const worker = await h.makeWorker([ref.service.id], [ref.city.id]);
    for (const who of [me, worker]) {
      await h.api().patch('/api/v1/account/locale').set(as(who)).send({ locale: 'EN' }).expect(204);
      expect((await h.prisma.user.findUniqueOrThrow({ where: { id: who.userId } })).locale).toBe('EN');
      await h.api().patch('/api/v1/account/locale').set(as(who)).send({ locale: 'AR' }).expect(204);
      expect((await h.prisma.user.findUniqueOrThrow({ where: { id: who.userId } })).locale).toBe('AR');
    }
    await h.api().patch('/api/v1/account/locale').set(as(me)).send({ locale: 'FR' }).expect(400);
    await h.api().patch('/api/v1/account/locale').send({ locale: 'EN' }).expect(401);
  });

  it('writes the worker\'s notifications in the language the worker chose', async () => {
    const worker = await h.makeWorker([ref.service.id], [ref.city.id]);
    await h.prisma.notification.create({ data: { userId: worker.userId, type: 'verification.approved', params: {}, sourceKey: `itest-lang-${worker.userId}` } });
    await h.api().patch('/api/v1/account/locale').set(as(worker)).send({ locale: 'EN' }).expect(204);
    const en = (await h.api().get('/api/v1/notifications').set(as(worker)).expect(200)).body.items[0];
    expect(en.title).toMatch(/[A-Za-z]/);
    await h.api().patch('/api/v1/account/locale').set(as(worker)).send({ locale: 'AR' }).expect(204);
    const ar = (await h.api().get('/api/v1/notifications').set(as(worker)).expect(200)).body.items[0];
    expect(ar.title).toMatch(/[؀-ۿ]/);
    expect(ar.title).not.toBe(en.title);
  });

  it('gives a worker a link to their own photo only once one has been uploaded', async () => {
    const worker = await h.makeWorker([ref.service.id], [ref.city.id]);
    expect((await h.api().get('/api/v1/workers/me/photo').set(as(worker)).expect(200)).body).toEqual({ url: null, expiresAt: null });
    const profile = await h.prisma.workerProfile.findUniqueOrThrow({ where: { userId: worker.userId } });
    const data = { workerProfileId: profile.id, type: 'PHOTO' as const, fileName: 'me.jpg', mimeType: 'image/jpeg', sizeBytes: 10 };
    await h.prisma.workerVerificationDocument.create({ data: { ...data, status: 'PENDING_UPLOAD', storageKey: `workers/${profile.id}/documents/pending` } });
    expect((await h.api().get('/api/v1/workers/me/photo').set(as(worker)).expect(200)).body.url).toBeNull();
    await h.prisma.workerVerificationDocument.create({ data: { ...data, status: 'UPLOADED', storageKey: `workers/${profile.id}/documents/done` } });
    const res = (await h.api().get('/api/v1/workers/me/photo').set(as(worker)).expect(200)).body;
    expect(typeof res.url).toBe('string');
    expect(res.url).toContain('done');
    const me = await h.makeCustomer();
    await h.api().get('/api/v1/workers/me/photo').set(as(me)).expect(403);
  });
});
