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
