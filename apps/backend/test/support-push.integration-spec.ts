/**
 * REAL POSTGRESQL, push provider replaced by a recording double: nothing is sent to a device.
 *
 * A worker whose application is not approved must be told, by push, when (a) an administrator replies to their support message and
 * (b) an administrator changes the status of their application. The push carries no private text, and a repeated or retried action does not
 * notify twice.
 */
import { randomBytes } from 'node:crypto';
import { NotificationDeliveryService } from '../src/modules/notifications/notification-delivery.service.js';
import { MockPushProvider } from '../src/modules/notifications/push/push-provider.js';
import { WorkerVerificationStatus } from '../src/generated/prisma/client.js';
import { type Harness, type Session, bootHarness } from './support/bookings-harness.js';

const run = process.env['TEST_DATABASE_URL'] ? describe : describe.skip;
if (!process.env['TEST_DATABASE_URL']) console.warn('support-push.integration-spec: TEST_DATABASE_URL is not set, suite skipped');

run('push to a worker when support replies or the application changes (real PostgreSQL, fake push)', () => {
  let h: Harness;
  let push: MockPushProvider;
  let delivery: NotificationDeliveryService;
  let ref: Awaited<ReturnType<Harness['seedReferenceData']>>;
  const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
  let n = 0;
  const cid = () => `itest-sp-${Date.now().toString(36)}-${++n}-${Math.random().toString(36).slice(2, 8)}`;

  beforeAll(async () => {
    push = new MockPushProvider();
    h = await bootHarness({ phonePrefix: '+9665997', slugPrefix: 'itest-sp-', adminEmailPrefix: 'itest-sp-admin', pushProvider: push, env: { WORKER_REQUIRE_IDENTITY_DOCUMENT: 'false', PUSH_PROVIDER: 'mock', DEVICE_TOKEN_ENCRYPTION_KEY: randomBytes(32).toString('base64') } });
    ref = await h.seedReferenceData();
    delivery = h.app.get(NotificationDeliveryService);
  });

  afterAll(async () => {
    if (h) await h.close();
  });

  /** A worker with the given application status and one registered phone. */
  async function workerWithPhone(status: WorkerVerificationStatus): Promise<Session & { workerId: string }> {
    const w = await h.makeWorker([ref.service.id], [ref.city.id], status);
    // a complete application (the administrator can only approve one that could have been submitted)
    await h.prisma.workerAvailability.create({ data: { workerProfileId: w.workerId, dayOfWeek: 0, startMinute: 480, endMinute: 1020 } });
    await h
      .api()
      .post('/api/v1/devices')
      .set(bearer(w.accessToken))
      .set('X-Forwarded-For', h.freshIp())
      .send({ platform: 'ANDROID', provider: 'FCM', token: `tok-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}-padding` })
      .expect(200);
    return w;
  }

  const write = (token: string, body: string) =>
    h.api().post('/api/v1/support/messages').set(bearer(token)).set('X-Forwarded-For', h.freshIp()).send({ clientMessageId: cid(), body }).expect(201);
  const threadOf = async (userId: string) => (await h.prisma.supportThread.findUniqueOrThrow({ where: { userId } })).id;
  const reply = (threadId: string, body: string, clientMessageId?: string) =>
    h.api().post(`/api/v1/admin/support/threads/${threadId}/reply`).set(bearer(h.adminToken)).send({ body, ...(clientMessageId ? { clientMessageId } : {}) });
  const notificationsOf = (userId: string, type: string) => h.prisma.notification.findMany({ where: { userId, type } });
  const deliveriesOf = (notificationId: string) => h.prisma.notificationDelivery.findMany({ where: { notificationId } });

  it('an administrator\'s reply queues a push to the worker\'s phone, and sending it carries no text of the reply', async () => {
    const w = await workerWithPhone(WorkerVerificationStatus.REJECTED);
    await write(w.accessToken, 'Why was I rejected?');
    const threadId = await threadOf(w.userId);

    await reply(threadId, 'Your ID photo was too dark: please upload it again.').expect(200);

    const rows = await notificationsOf(w.userId, 'support.reply');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ resourceType: 'support_thread', resourceId: threadId });
    const deliveries = await deliveriesOf(rows[0]!.id);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({ channel: 'PUSH', status: 'QUEUED' });

    const before = push.accepted.length;
    await delivery.runOnce();
    const sent = push.accepted.slice(before);
    expect(sent.length).toBeGreaterThanOrEqual(1);
    const mine = sent.find((m) => m.data['notificationId'] === rows[0]!.id)!;
    expect(mine).toBeDefined();
    expect(mine.data).toMatchObject({ type: 'support.reply', resourceType: 'support_thread', resourceId: threadId });
    expect(JSON.stringify(mine)).not.toContain('ID photo');
    expect((await deliveriesOf(rows[0]!.id))[0]!.status).toBe('SENT');
  });

  it('a retried reply (same id) does not notify twice', async () => {
    const w = await workerWithPhone(WorkerVerificationStatus.SUBMITTED);
    await write(w.accessToken, 'hello');
    const threadId = await threadOf(w.userId);
    await reply(threadId, 'One moment', 'admin-retry-push-1').expect(200);
    await reply(threadId, 'One moment', 'admin-retry-push-1').expect(200);
    expect(await notificationsOf(w.userId, 'support.reply')).toHaveLength(1);
    await reply(threadId, 'Another message').expect(200);
    expect(await notificationsOf(w.userId, 'support.reply')).toHaveLength(2);
  });

  it('a worker without a registered phone still gets the in-app notification; nothing is queued for push', async () => {
    const w = await h.makeWorker([ref.service.id], [ref.city.id], WorkerVerificationStatus.SUBMITTED);
    await write(w.accessToken, 'hi');
    await reply(await threadOf(w.userId), 'Hello').expect(200);
    const rows = await notificationsOf(w.userId, 'support.reply');
    expect(rows).toHaveLength(1);
    expect(await deliveriesOf(rows[0]!.id)).toHaveLength(0);
  });

  it('only the person\'s own notifications: another worker is not told', async () => {
    const a = await workerWithPhone(WorkerVerificationStatus.SUBMITTED);
    const b = await workerWithPhone(WorkerVerificationStatus.SUBMITTED);
    await write(a.accessToken, 'from A');
    await reply(await threadOf(a.userId), 'to A').expect(200);
    expect(await notificationsOf(a.userId, 'support.reply')).toHaveLength(1);
    expect(await notificationsOf(b.userId, 'support.reply')).toHaveLength(0);
  });

  it('the notification can be read in the app list, in the worker\'s language, without the reply text', async () => {
    const w = await workerWithPhone(WorkerVerificationStatus.INFO_REQUIRED);
    await write(w.accessToken, 'question');
    await reply(await threadOf(w.userId), 'secret answer text').expect(200);
    const list = (await h.api().get('/api/v1/notifications').set(bearer(w.accessToken)).expect(200)).body;
    const item = list.items.find((i: { type: string }) => i.type === 'support.reply');
    expect(item).toMatchObject({ read: false, resource: { type: 'support_thread' } });
    expect(JSON.stringify(item)).not.toContain('secret answer text');
    expect(item.title.length).toBeGreaterThan(0);
  });

  describe('application status changes by an administrator', () => {
    const decide = (workerId: string, action: string, body: object = {}) =>
      h.api().post(`/api/v1/admin/workers/${workerId}/${action}`).set(bearer(h.adminToken)).send(body);

    it('request-info, reject and approve each queue a push for the worker\'s phone, with the right type', async () => {
      const w = await workerWithPhone(WorkerVerificationStatus.UNDER_REVIEW);

      const backToReview = () => h.prisma.workerProfile.update({ where: { id: w.workerId }, data: { verificationStatus: WorkerVerificationStatus.UNDER_REVIEW } });
      await decide(w.workerId, 'request-info', { reason: 'Please add a certificate' }).expect(200);
      await backToReview(); // the worker fixed it and resubmitted
      await decide(w.workerId, 'reject', { reason: 'Documents unreadable' }).expect(200);
      await backToReview();
      await decide(w.workerId, 'approve').expect(200);

      for (const type of ['verification.info_requested', 'verification.rejected', 'verification.approved']) {
        const rows = await notificationsOf(w.userId, type);
        expect(rows).toHaveLength(1);
        const d = await deliveriesOf(rows[0]!.id);
        expect(d).toHaveLength(1);
        expect(d[0]!.channel).toBe('PUSH');
      }

      const before = push.accepted.length;
      await delivery.runOnce();
      const types = push.accepted.slice(before).map((m) => m.data['type']);
      expect(types).toEqual(expect.arrayContaining(['verification.info_requested', 'verification.rejected', 'verification.approved']));
      // the reviewer's note is never in the push
      expect(JSON.stringify(push.accepted.slice(before))).not.toContain('Documents unreadable');
    });

    it('suspending and reinstating notify too', async () => {
      const w = await workerWithPhone(WorkerVerificationStatus.APPROVED);
      await decide(w.workerId, 'suspend', { reason: 'Complaint under review' }).expect(200);
      await decide(w.workerId, 'reinstate').expect(200);
      expect(await notificationsOf(w.userId, 'verification.suspended')).toHaveLength(1);
      expect(await notificationsOf(w.userId, 'verification.reinstated')).toHaveLength(1);
    });
  });
});
