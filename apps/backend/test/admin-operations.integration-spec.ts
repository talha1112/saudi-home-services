/**
 * REAL POSTGRESQL: administrator boundaries, account administration (suspension taking effect everywhere), booking
 * intervention through the lifecycle service, audit coverage and redaction, and the immutability of financial records.
 */
import { randomUUID } from 'node:crypto';
import { AuditService } from '../src/modules/auth/audit.service.js';
import { type Harness, type Session, type Worker, bootHarness } from './support/bookings-harness.js';

const run = process.env['TEST_DATABASE_URL'] ? describe : describe.skip;
if (!process.env['TEST_DATABASE_URL']) console.warn('admin-operations.integration-spec: TEST_DATABASE_URL is not set, suite skipped');

run('administrator operations (real PostgreSQL)', () => {
  let h: Harness;
  let ref: Awaited<ReturnType<Harness['seedReferenceData']>>;
  const admin = { accessToken: '' };
  const as = (w: { accessToken: string }) => h.bearer(w.accessToken);
  const post = (path: string, body: object = {}, who: { accessToken: string } = admin) => h.api().post(`/api/v1${path}`).set(as(who)).set('X-Forwarded-For', h.freshIp()).send(body);
  const get = (path: string, who: { accessToken: string } = admin) => h.api().get(`/api/v1${path}`).set(as(who)).set('X-Forwarded-For', h.freshIp());

  beforeAll(async () => {
    h = await bootHarness({
      phonePrefix: '+9665986',
      slugPrefix: 'itest-ad-',
      adminEmailPrefix: 'itest-ad-admin',
      realtime: { listen: true, env: { REALTIME_REVALIDATE_SECONDS: '1' } },
    });
    ref = await h.seedReferenceData();
    admin.accessToken = h.adminToken;
  });

  afterAll(async () => {
    if (h) await h.close();
  });

  describe('who may call administrator routes', () => {
    it('refuses customers, workers and anonymous callers on every new administrator route', async () => {
      const customer = await h.makeCustomer();
      const worker = await h.makeWorker([ref.service.id], [ref.city.id]);
      const id = randomUUID();
      const routes: Array<['get' | 'post', string]> = [
        ['get', '/admin/users'],
        ['get', `/admin/users/${id}/overview`],
        ['post', `/admin/users/${id}/suspend`],
        ['post', `/admin/users/${id}/reactivate`],
        ['get', '/admin/audit-logs'],
        ['get', '/admin/disputes'],
        ['get', `/admin/disputes/${id}`],
        ['post', `/admin/disputes/${id}/resolve`],
        ['get', '/admin/reviews'],
        ['post', `/admin/reviews/${id}/hide`],
        ['get', '/admin/reports/bookings'],
        ['get', '/admin/reports/bookings/trend'],
        ['get', '/admin/reports/quotes'],
        ['get', '/admin/reports/workers'],
        ['get', '/admin/reports/reviews'],
        ['get', '/admin/reports/disputes'],
        ['get', '/admin/reports/notifications'],
        ['get', '/admin/reports/operations'],
        ['get', '/admin/reports/payments'],
        ['get', '/admin/reports/ledger'],
      ];
      for (const [method, path] of routes) {
        const call = (who?: { accessToken: string }) => {
          const r = h.api()[method](`/api/v1${path}`).set('X-Forwarded-For', h.freshIp());
          return (who ? r.set(as(who)) : r).send(method === 'post' ? {} : undefined);
        };
        expect({ path, anon: (await call()).status }).toEqual({ path, anon: 401 });
        expect({ path, customer: (await call(customer)).status }).toEqual({ path, customer: 403 });
        expect({ path, worker: (await call(worker)).status }).toEqual({ path, worker: 403 });
      }
    });

    it('does not give users any public way to change their own role or approval status', async () => {
      const worker = await h.makeWorker([ref.service.id], [ref.city.id], 'NOT_SUBMITTED');
      for (const field of [{ verificationStatus: 'APPROVED' }, { status: 'ACTIVE' }, { roles: ['ADMIN'] }, { role: 'ADMIN' }, { isOnline: true, verifiedAt: new Date().toISOString() }]) {
        const res = await h.api().put('/api/v1/workers/me/profile').set(as(worker)).send({ bio: 'I fix things.', yearsOfExperience: 3, ...field });
        expect({ field, status: res.status }).toEqual({ field, status: 400 });
      }
      expect(await h.prisma.workerProfile.findUniqueOrThrow({ where: { id: worker.workerId }, select: { verificationStatus: true } })).toEqual({ verificationStatus: 'NOT_SUBMITTED' });
      expect((await h.prisma.userRole.findMany({ where: { userId: worker.userId } })).map((r) => r.role)).not.toContain('ADMIN');
      for (const path of ['/customers/me', '/workers/me', '/admin/users']) {
        expect([404, 405, 403]).toContain((await h.api().patch(`/api/v1${path}`).set(as(worker)).send({ status: 'ACTIVE' })).status);
      }
      // approval itself is administrator-only
      expect((await post(`/admin/workers/${worker.workerId}/approve`, {}, worker)).status).toBe(403);
    });
  });

  describe('accounts', () => {
    it('lists customers and workers redacted, filtered, searchable and paginated, never administrators', async () => {
      const customer = await h.makeCustomer();
      const worker = await h.makeWorker([ref.service.id], [ref.city.id]);
      await h.prisma.user.update({ where: { id: customer.userId }, data: { fullName: 'Layla Itest-Searchable' } });

      const list = (await get('/admin/users?limit=100').expect(200)).body;
      const mine = list.items.find((u: { id: string }) => u.id === customer.userId);
      expect(mine).toMatchObject({ status: 'ACTIVE', roles: ['CUSTOMER'] });
      expect(mine.phone).toMatch(/^\+9665•+\d{4}$/);
      expect(mine.phone).not.toBe(customer.phone);
      expect(JSON.stringify(list)).not.toContain(customer.phone);
      expect(JSON.stringify(list)).not.toMatch(/storageKey|document|passwordHash|address/i);
      expect(list.items.every((u: { roles: string[] }) => !u.roles.includes('ADMIN'))).toBe(true);
      expect(list.items.find((u: { id: string }) => u.id === worker.userId).workerVerificationStatus).toBe('APPROVED');

      expect((await get('/admin/users?q=Itest-Searchable').expect(200)).body.items.map((u: { id: string }) => u.id)).toEqual([customer.userId]);
      expect((await get(`/admin/users?q=${customer.phone.slice(-7)}`).expect(200)).body.items.map((u: { id: string }) => u.id)).toContain(customer.userId);
      expect((await get('/admin/users?role=WORKER&limit=100').expect(200)).body.items.every((u: { roles: string[] }) => u.roles.includes('WORKER'))).toBe(true);
      expect((await get('/admin/users?role=ADMIN')).status).toBe(400);
      expect((await get('/admin/users?q=a')).status).toBe(400);
      expect((await get('/admin/users?status=NOPE')).status).toBe(400);
      expect((await get('/admin/users?limit=1&page=2').expect(200)).body.items).toHaveLength(1);
      expect((await get('/admin/users?status=SUSPENDED&role=WORKER&q=Itest-Searchable').expect(200)).body.meta.total).toBe(0);
    });

    it('shows an overview with booking summaries and verification state but no documents', async () => {
      const p = await h.confirmedBooking();
      const doc = await h.prisma.workerVerificationDocument.create({ data: { workerProfileId: p.worker.workerId, type: 'IQAMA', status: 'ACCEPTED', storageKey: `workers/${p.worker.workerId}/documents/${randomUUID()}`, fileName: 'iqama.png', mimeType: 'image/png', sizeBytes: 10 } });
      const w = (await get(`/admin/users/${p.worker.userId}/overview`).expect(200)).body;
      expect(w.worker).toMatchObject({ verificationStatus: 'APPROVED', rating: { count: 0, average: null }, documents: [{ type: 'IQAMA', status: 'ACCEPTED' }] });
      expect(w.bookings.asWorker).toEqual({ CONFIRMED: 1 });
      expect(w.bookings.recentAsWorker[0]).toMatchObject({ id: p.booking.id, status: 'CONFIRMED' });
      expect(JSON.stringify(w)).not.toMatch(new RegExp(`${doc.storageKey}|iqama.png|storageKey|checksum`));
      const c = (await get(`/admin/users/${p.customer.userId}/overview`).expect(200)).body;
      expect(c.worker).toBeNull();
      expect(c.bookings.asCustomer).toEqual({ CONFIRMED: 1 });
      expect((await get(`/admin/users/${randomUUID()}/overview`)).status).toBe(404);
    });

    it('suspends an account at once: sessions, API calls, sockets and new sign-ins all stop, and bookings are left alone', async () => {
      const p = await h.confirmedBooking();
      const socket = await h.connect(p.worker.accessToken);
      expect((await socket.emitAck('booking.join', { bookingId: p.booking.id })).ok).toBe(true);
      expect((await get('/workers/me/bookings', p.worker)).status).toBe(200);
      const before = await h.prisma.booking.findUniqueOrThrow({ where: { id: p.booking.id }, select: { status: true, totalAmountHalalas: true } });

      expect((await post(`/admin/users/${p.worker.userId}/suspend`, {})).status).toBe(400); // a reason is required
      expect((await post(`/admin/users/${p.worker.userId}/suspend`, { reason: 'x' })).status).toBe(400);
      const res = await post(`/admin/users/${p.worker.userId}/suspend`, { reason: 'Repeated no-shows reported by customers.' }).expect(200);
      expect(res.body).toMatchObject({ status: 'SUSPENDED', statusReason: 'Repeated no-shows reported by customers.', worker: { isOnline: false } });

      await socket.waitFor('session.ending.v1', (e) => e.reason === 'ACCOUNT_NOT_ACTIVE', 3000);
      await new Promise<void>((resolve) => (socket.raw.connected ? socket.raw.once('disconnect', () => resolve()) : resolve()));
      expect(socket.raw.connected).toBe(false);
      // suspension revokes every session, so the old tokens are refused as ended sessions (and would be refused as inactive accounts anyway)
      await expect(h.connect(p.worker.accessToken)).rejects.toMatchObject({ code: expect.stringMatching(/^(SESSION_REVOKED|ACCOUNT_NOT_ACTIVE)$/) });
      const blocked = await get('/workers/me/bookings', p.worker);
      expect(blocked.status).toBe(401);
      expect(blocked.body.code).toBe('SESSION_REVOKED');
      expect((await get('/notifications', p.worker)).status).toBe(401);
      expect(await h.prisma.refreshToken.count({ where: { userId: p.worker.userId, revokedAt: null } })).toBe(0);
      const login = await h.api().post('/api/v1/auth/otp/request').set('X-Forwarded-For', h.freshIp()).send({ phone: p.worker.phone, app: 'worker' });
      if (login.status === 200) {
        const verify = await h.api().post('/api/v1/auth/otp/verify').set('X-Forwarded-For', h.freshIp()).send({ phone: p.worker.phone, code: h.sms.lastCode(p.worker.phone), app: 'worker' });
        expect(verify.status).toBeGreaterThanOrEqual(400); // a suspended account cannot sign in again
      }

      // the booking itself is untouched: an administrator decides separately what to do with it
      expect(await h.prisma.booking.findUniqueOrThrow({ where: { id: p.booking.id }, select: { status: true, totalAmountHalalas: true } })).toEqual(before);
    });

    it('reactivates, restores access, and keeps a complete audit trail with the reasons', async () => {
      const customer = await h.makeCustomer();
      await post(`/admin/users/${customer.userId}/suspend`, { reason: 'Fraud review pending.' }).expect(200);
      expect((await get('/notifications', customer)).status).toBe(401); // every session ended
      const back = (await post(`/admin/users/${customer.userId}/reactivate`, { reason: 'Review finished, no issue found.' }).expect(200)).body;
      expect(back).toMatchObject({ status: 'ACTIVE', statusReason: null });
      expect((await get('/notifications', customer)).status).toBe(401); // old sessions stay ended: the person signs in again
      const again = await h.otpSignIn('customer', customer.phone);
      expect(again.userId).toBe(customer.userId);
      expect((await get('/notifications', again)).status).toBe(200);
      const rows = await h.prisma.auditLog.findMany({ where: { entityType: 'user', entityId: customer.userId, action: { in: ['user.suspended', 'user.reactivated'] } }, orderBy: { createdAt: 'asc' } });
      expect(rows.map((r) => r.action)).toEqual(['user.suspended', 'user.reactivated']);
      expect(rows[0]).toMatchObject({ metadata: { beforeStatus: 'ACTIVE', afterStatus: 'SUSPENDED', reason: 'Fraud review pending.' } });
      expect(rows.every((r) => r.actorUserId !== null)).toBe(true);
    });

    it('refuses to change administrators, oneself, repeated or impossible transitions', async () => {
      const customer = await h.makeCustomer();
      const adminUser = await h.prisma.user.findFirstOrThrow({ where: { roles: { some: { role: 'ADMIN' } }, email: { startsWith: 'itest-ad-admin' } } });
      expect((await post(`/admin/users/${adminUser.id}/suspend`, { reason: 'Trying to lock out an admin.' })).body.code).toMatch(/CANNOT_MODIFY_(SELF|ADMIN)/);
      expect((await post(`/admin/users/${randomUUID()}/suspend`, { reason: 'Nobody lives here.' })).status).toBe(404);
      expect((await post(`/admin/users/${customer.userId}/reactivate`, { reason: 'Not suspended at all.' })).status).toBe(409);
      await post(`/admin/users/${customer.userId}/suspend`, { reason: 'First suspension reason.' }).expect(200);
      expect((await post(`/admin/users/${customer.userId}/suspend`, { reason: 'Second suspension reason.' })).status).toBe(409);
      const results = await Promise.all([1, 2, 3].map(() => post(`/admin/users/${customer.userId}/reactivate`, { reason: 'Racing reactivations.' })));
      expect(results.filter((r) => r.status === 200)).toHaveLength(1);
      expect(await h.prisma.auditLog.count({ where: { action: 'user.reactivated', entityId: customer.userId } })).toBe(1);

      // a second administrator is protected too
      const other = await h.prisma.user.create({ data: { email: `itest-ad-admin-other-${randomUUID().slice(0, 6)}@example.com`, status: 'ACTIVE', roles: { create: [{ role: 'ADMIN' }] } } });
      expect((await post(`/admin/users/${other.id}/suspend`, { reason: 'Colleagues are not managed here.' })).body.code).toBe('CANNOT_MODIFY_ADMIN');
    });
  });

  describe('booking intervention', () => {
    it('cancels through the lifecycle service with a required note, an audit record and no financial side effects', async () => {
      const p = await h.confirmedBooking(20000);
      const financial = async () => ({
        booking: await h.prisma.booking.findUniqueOrThrow({ where: { id: p.booking.id }, select: { totalAmountHalalas: true, serviceAmountHalalas: true, vatAmountHalalas: true, commissionAmountHalalas: true, workerPayoutHalalas: true } }),
        payments: await h.prisma.paymentAttempt.findMany({ where: { bookingId: p.booking.id }, select: { id: true, status: true, refundReservedHalalas: true } }),
        refunds: await h.prisma.paymentRefund.count({ where: { bookingId: p.booking.id } }),
        ledger: await h.prisma.ledgerEntry.count({ where: { bookingId: p.booking.id } }),
      });
      const before = await financial();
      expect((await post(`/admin/bookings/${p.booking.id}/cancel`, {})).status).toBe(400);
      expect((await post(`/admin/bookings/${p.booking.id}/cancel`, { note: 'x' })).status).toBe(400);
      expect((await post(`/admin/bookings/${p.booking.id}/cancel`, { note: 'Customer unreachable and worker unavailable.' }, p.customer)).status).toBe(403);
      const res = await post(`/admin/bookings/${p.booking.id}/cancel`, { note: 'Customer unreachable and worker unavailable.' }).expect(200);
      expect(res.body.status).toBe('CANCELLED');

      expect(await financial()).toEqual(before); // no automatic refund, no ledger posting, money snapshot intact
      const event = await h.prisma.bookingEvent.findFirstOrThrow({ where: { bookingId: p.booking.id, type: 'BOOKING_CANCELLED' } });
      expect(event).toMatchObject({ actorRole: 'ADMIN', fromStatus: 'CONFIRMED', toStatus: 'CANCELLED' });
      expect(event.actorUserId).not.toBeNull();
      const audit = await h.prisma.auditLog.findFirstOrThrow({ where: { action: 'booking.cancelled_by_admin', entityId: p.booking.id } });
      expect(audit.metadata).toMatchObject({ previousStatus: 'CONFIRMED' });
      const detail = (await get(`/admin/bookings/${p.booking.id}`).expect(200)).body;
      expect(detail.timeline.map((e: { type: string }) => e.type)).toEqual(expect.arrayContaining(['BOOKING_CREATED', 'PAYMENT_CONFIRMED', 'BOOKING_CANCELLED']));
      expect((await post(`/admin/bookings/${p.booking.id}/cancel`, { note: 'Cancelling a finished booking again.' })).status).toBe(409);
    });

    it('searches bookings by status, city, service, customer, worker and date range', async () => {
      const p = await h.confirmedBooking();
      const q = async (query: string) => (await get(`/admin/bookings?limit=100&${query}`).expect(200)).body;
      const ids = (b: { items: Array<{ id: string }> }) => b.items.map((i) => i.id);
      expect(ids(await q(`customerId=${p.customer.userId}`))).toEqual([p.booking.id]);
      expect(ids(await q(`workerId=${p.worker.workerId}`))).toEqual([p.booking.id]);
      expect(ids(await q(`customerId=${p.customer.userId}&status=CONFIRMED`))).toEqual([p.booking.id]);
      expect(ids(await q(`customerId=${p.customer.userId}&status=COMPLETED`))).toEqual([]);
      expect(ids(await q(`customerId=${p.customer.userId}&cityId=${ref.city.id}&serviceId=${ref.service.id}`))).toEqual([p.booking.id]);
      expect(ids(await q(`customerId=${p.customer.userId}&cityId=${ref.otherCity.id}`))).toEqual([]);
      const created = (await h.prisma.booking.findUniqueOrThrow({ where: { id: p.booking.id } })).createdAt;
      expect(ids(await q(`customerId=${p.customer.userId}&createdFrom=${created.toISOString()}`))).toEqual([p.booking.id]); // inclusive start
      expect(ids(await q(`customerId=${p.customer.userId}&createdTo=${created.toISOString()}`))).toEqual([]); // exclusive end
      expect((await get('/admin/bookings?createdFrom=soon')).status).toBe(400);
    });
  });

  describe('financial records stay immutable', () => {
    it('offers no way to mark a payment successful, edit a payment, or change the ledger or money snapshots', async () => {
      const p = await h.acceptedBooking();
      const started = await h.startedPayment(p.customer, p.booking.id);
      for (const [method, path] of [
        ['post', `/admin/payments/${started.row.id}/succeed`],
        ['post', `/admin/payments/${started.row.id}/capture`],
        ['post', `/admin/payments/${started.row.id}/confirm`],
        ['post', `/admin/payments/${started.row.id}/mark-paid`],
        ['patch', `/admin/payments/${started.row.id}`],
        ['put', `/admin/payments/${started.row.id}`],
        ['delete', `/admin/payments/${started.row.id}`],
        ['post', '/admin/ledger'],
        ['patch', '/admin/ledger/anything'],
        ['delete', '/admin/ledger/anything'],
        ['patch', `/admin/bookings/${p.booking.id}`],
        ['post', `/admin/bookings/${p.booking.id}/status`],
        ['post', `/admin/bookings/${p.booking.id}/confirm-payment`],
      ] as const) {
        const res = await h.api()[method](`/api/v1${path}`).set(as(admin)).send({ status: 'SUCCEEDED', totalAmountHalalas: 1 });
        expect({ method, path, status: res.status }).toEqual({ method, path, status: 404 });
      }
      expect((await h.prisma.paymentAttempt.findUniqueOrThrow({ where: { id: started.row.id } })).status).toBe('PROCESSING');
      expect((await h.prisma.booking.findUniqueOrThrow({ where: { id: p.booking.id } })).status).toBe('PAYMENT_PENDING');

      // and the database refuses direct edits as well
      await expect(h.prisma.booking.update({ where: { id: p.booking.id }, data: { totalAmountHalalas: 1 } })).rejects.toThrow();
      const entry = await h.prisma.ledgerEntry.findFirst();
      if (entry) {
        await expect(h.prisma.ledgerEntry.update({ where: { id: entry.id }, data: { amountHalalas: 1 } })).rejects.toThrow();
        await expect(h.prisma.ledgerEntry.delete({ where: { id: entry.id } })).rejects.toThrow();
      }
    });

    it('lets administrators read payments, refunds and the ledger, and request (not execute) a refund with an audit record', async () => {
      const p = await h.confirmedBooking();
      const payment = await h.prisma.paymentAttempt.findFirstOrThrow({ where: { bookingId: p.booking.id, status: 'SUCCEEDED' } });
      expect((await get(`/admin/payments?bookingId=${p.booking.id}`).expect(200)).body.items).toHaveLength(1);
      expect((await get(`/admin/ledger?bookingId=${p.booking.id}`).expect(200)).body.items.length).toBeGreaterThanOrEqual(1);
      const refund = await h.api().post(`/api/v1/admin/payments/${payment.id}/refunds`).set(as(admin)).set('Idempotency-Key', `itest-ad-${randomUUID()}`).send({ amountHalalas: 1000, reason: 'Goodwill requested by support.' });
      expect(refund.status).toBe(201);
      expect(refund.body.status).toBe('REQUESTED'); // nothing was refunded
      expect(await h.prisma.ledgerEntry.count({ where: { bookingId: p.booking.id, entryType: 'REFUND_COMPLETED' } })).toBe(0);
      expect(await h.prisma.auditLog.count({ where: { entityType: { in: ['payment_refund', 'refund'] }, createdAt: { gte: new Date(Date.now() - 60_000) } } })).toBeGreaterThanOrEqual(1);
    });
  });

  describe('the audit trail', () => {
    it('is read-only, admin-only, filterable and paginated', async () => {
      const customer = await h.makeCustomer();
      await post(`/admin/users/${customer.userId}/suspend`, { reason: 'Audit listing test.' }).expect(200);
      const list = (await get(`/admin/audit-logs?action=user.suspended&entityType=user&entityId=${customer.userId}`).expect(200)).body;
      expect(list.items).toHaveLength(1);
      expect(list.items[0]).toMatchObject({ action: 'user.suspended', entityType: 'user', entityId: customer.userId });
      expect(Object.keys(list.items[0]).sort()).toEqual(['action', 'actorUserId', 'createdAt', 'entityId', 'entityType', 'id', 'metadata']); // no IP address or user agent
      expect((await get('/admin/audit-logs?action=user.suspended&limit=1').expect(200)).body.items).toHaveLength(1);
      expect((await get(`/admin/audit-logs?to=${new Date(Date.now() - 86_400_000 * 400).toISOString()}`).expect(200)).body.items).toHaveLength(0);
      expect((await get('/admin/audit-logs?actorUserId=nope')).status).toBe(400);
      for (const m of ['post', 'patch', 'put', 'delete'] as const) {
        expect({ m, status: (await h.api()[m]('/api/v1/admin/audit-logs').set(as(admin)).send({})).status }).toEqual({ m, status: 404 });
      }
    });

    it('redacts passwords, tokens, secrets and signed links before they are stored', async () => {
      const audit = h.app.get(AuditService);
      await audit.record({
        action: 'itest.redaction',
        entityType: 'itest',
        entityId: 'redaction-1',
        metadata: {
          password: 'hunter2-hunter2',
          accessToken: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig',
          refresh_token: 'abc',
          clientSecret: 's3cr3t',
          signedUrl: 'https://bucket.s3.amazonaws.com/k?X-Amz-Signature=abcdef',
          note: 'see https://x.example/file?X-Amz-Signature=abcdef for details',
          header: 'Bearer abcdefghijklmnop',
          pem: '-----BEGIN PRIVATE KEY-----',
          reason: 'x'.repeat(500),
          beforeStatus: 'ACTIVE',
          afterStatus: 'SUSPENDED',
          count: 3,
          flag: true,
        },
      });
      const row = await h.prisma.auditLog.findFirstOrThrow({ where: { action: 'itest.redaction' } });
      const text = JSON.stringify(row.metadata);
      for (const secret of ['hunter2', 'eyJhbGci', 'abcdef', 's3cr3t', 'BEGIN PRIVATE', 'abcdefghijklmnop']) expect(text).not.toContain(secret);
      expect(row.metadata).toMatchObject({ password: '[redacted]', accessToken: '[redacted]', signedUrl: '[redacted]', beforeStatus: 'ACTIVE', afterStatus: 'SUSPENDED', count: 3, flag: true });
      expect((row.metadata as { reason: string }).reason.length).toBeLessThan(310);
    });

    it('records every sensitive administrator action', async () => {
      const since = new Date(Date.now() - 1000);
      const p = await h.confirmedBooking();
      const worker = await h.makeWorker([ref.service.id], [ref.city.id], 'UNDER_REVIEW');

      await post('/admin/pricing-settings', { vatRateBps: 1500, commissionRateBps: 1500, minServiceChargeHalalas: 5000, note: 'itest pricing itest-ad- audit coverage' }).expect(201);
      const offer = (await post('/admin/offers', { audience: 'ALL', titleEn: 'itest-ad-coverage', descriptionEn: 'Text', startsAt: new Date(Date.now() - 3600_000).toISOString(), endsAt: new Date(Date.now() + 86_400_000).toISOString() }).expect(201)).body;
      await post(`/admin/offers/${offer.id}/publish`).expect(200);
      await post(`/admin/offers/${offer.id}/pause`).expect(200);
      await post(`/admin/workers/${worker.workerId}/reject`, { reason: 'Documents are unreadable, please resubmit.' }).expect(200);
      await post(`/admin/users/${p.customer.userId}/suspend`, { reason: 'Coverage test suspension.' }).expect(200);
      await post(`/admin/users/${p.customer.userId}/reactivate`, { reason: 'Coverage test reactivation.' }).expect(200);
      await post(`/admin/bookings/${p.booking.id}/cancel`, { note: 'Coverage test cancellation.' }).expect(200);

      const actions = (await h.prisma.auditLog.findMany({ where: { createdAt: { gte: since }, actorUserId: { not: null } }, select: { action: true } })).map((r) => r.action);
      for (const expected of ['pricing.setting.created', 'offer.created', 'offer.publish', 'offer.pause', 'worker.verification.reject', 'user.suspended', 'user.reactivated', 'booking.cancelled_by_admin']) {
        expect(actions).toContain(expected);
      }
    });
  });
});
