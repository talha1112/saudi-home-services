/**
 * REAL POSTGRESQL + REAL BYTES (the local provider writes to a temp folder behind HMAC-signed API URLs):
 * private upload workflow for booking photos and worker documents, content validation, scanning, isolation,
 * signed-URL abuse, and the retried, idempotent removal queue.
 */
import { jest } from '@jest/globals';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { LocalDocumentStorage } from '../src/modules/storage/adapters/local-document-storage.js';
import { signLocalUrl } from '../src/modules/storage/adapters/signed-url.js';
import { MOCK_INFECTED_MARKER } from '../src/modules/storage/file-scanner.js';
import { StorageDeletionService } from '../src/modules/storage/storage-deletion.service.js';
import { DocumentStorage } from '../src/modules/workers/storage/document-storage.js';
import { type Harness, type Session, type Worker, bootHarness } from './support/bookings-harness.js';

const run = process.env['TEST_DATABASE_URL'] ? describe : describe.skip;
if (!process.env['TEST_DATABASE_URL']) console.warn('storage-files.integration-spec: TEST_DATABASE_URL is not set, suite skipped');

const SECRET = 'itest-storage-signing-secret-0123456789abcdef';
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const png = (n = 600) => Buffer.concat([PNG_SIG, Buffer.alloc(n - 8, 7)]);
const jpeg = (n = 600) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(n - 4, 9)]);
const pdf = (n = 600) => Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(n - 9, 32)]);
const exe = (n = 600) => Buffer.concat([Buffer.from('MZ'), Buffer.alloc(n - 2, 1)]);
const infectedJpeg = () => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(MOCK_INFECTED_MARKER), Buffer.alloc(200, 3)]);

const pathOf = (url: string) => {
  const u = new URL(url);
  return u.pathname + u.search;
};

run('private storage: upload, verification, access and removal (real PostgreSQL, real bytes)', () => {
  let h: Harness;
  let strangerCustomer: Session;
  let strangerWorker: Worker;
  let storage: LocalDocumentStorage;
  let deletions: StorageDeletionService;

  const bearer = (s: Session | { accessToken: string }) => h.bearer(s.accessToken);

  /** Registers a booking photo and returns the response body. */
  const registerPhoto = (customer: Session, bookingId: string, body: object = {}) =>
    h
      .api()
      .post(`/api/v1/bookings/${bookingId}/photos`)
      .set(bearer(customer))
      .send({ fileName: 'outlet.png', mimeType: 'image/png', sizeBytes: 600, ...body });

  const put = (uploadUrl: string, bytes: Buffer, contentType = 'image/png') => h.api().put(pathOf(uploadUrl)).set('Content-Type', contentType).send(bytes);
  const confirmPhoto = (customer: Session, bookingId: string, photoId: string) =>
    h.api().post(`/api/v1/bookings/${bookingId}/photos/${photoId}/confirm`).set(bearer(customer)).send({});

  async function uploadedPhoto(customer: Session, bookingId: string, bytes = png(), mime = 'image/png') {
    const reg = await registerPhoto(customer, bookingId, { mimeType: mime, sizeBytes: bytes.length }).expect(201);
    await put(reg.body.uploadUrl, bytes, mime).expect(200);
    const confirmed = await confirmPhoto(customer, bookingId, reg.body.photo.id).expect(200);
    return { reg: reg.body, confirmed: confirmed.body };
  }

  beforeAll(async () => {
    h = await bootHarness({
      phonePrefix: '+9665981',
      slugPrefix: 'itest-sf-',
      adminEmailPrefix: 'itest-sf-admin',
      env: { DOCUMENT_STORAGE: 'local', STORAGE_SIGNING_SECRET: SECRET, FILE_SCANNER: 'mock', STORAGE_MAX_FILE_BYTES: '4096', STORAGE_DELETION_MAX_ATTEMPTS: '3' },
    });
    await h.seedReferenceData();
    strangerCustomer = await h.makeCustomer();
    strangerWorker = await h.makeWorker([], []);
    storage = h.app.get(DocumentStorage) as LocalDocumentStorage;
    deletions = h.app.get(StorageDeletionService);
    expect(storage).toBeInstanceOf(LocalDocumentStorage);
  });

  afterAll(async () => {
    if (h) await h.close();
  });

  describe('booking photos: the happy path', () => {
    it('registers, uploads through the signed URL, is verified by the server, and downloads the same bytes', async () => {
      const { customer, booking } = await h.acceptedBooking();
      const bytes = png(900);
      const { reg, confirmed } = await uploadedPhoto(customer, booking.id, bytes);
      expect(reg.method).toBe('PUT');
      expect(JSON.stringify(reg.photo)).not.toMatch(/storage|bookings\//);
      expect(confirmed).toMatchObject({ status: 'UPLOADED', scanStatus: 'CLEAN' });

      const row = await h.prisma.bookingPhoto.findUniqueOrThrow({ where: { id: reg.photo.id } });
      expect(row.contentVerifiedAt).not.toBeNull();
      expect(row.storageKey).toMatch(/^bookings\/[0-9a-f-]{36}\/photos\/[0-9a-f-]{36}$/);
      expect(row.storageKey).not.toContain('outlet'); // the user's file name is never part of the key

      const link = await h.api().get(`/api/v1/bookings/${booking.id}/photos/${reg.photo.id}/download-url`).set(bearer(customer)).expect(200);
      const res = await h.api().get(pathOf(link.body.url)).buffer(true).parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });
      expect(res.status).toBe(200);
      expect(Buffer.compare(res.body as Buffer, bytes)).toBe(0);
      expect(res.headers['content-type']).toBe('image/png');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['content-disposition']).toBe('attachment');
      expect(res.headers['cache-control']).toContain('no-store');
    });

    it('does not persist signed URLs anywhere', async () => {
      const { customer, booking } = await h.acceptedBooking();
      const { reg } = await uploadedPhoto(customer, booking.id);
      const token = new URL(reg.uploadUrl).searchParams.get('sig')!;
      const dump = JSON.stringify(await h.prisma.bookingPhoto.findMany({ where: { bookingId: booking.id } }));
      expect(dump).not.toContain(token);
      expect(dump).not.toContain('sig=');
    });
  });

  describe('content validation', () => {
    it.each([
      ['a JPEG labelled as PNG', () => jpeg(), 'TYPE_MISMATCH'],
      ['an executable labelled as PNG', () => exe(), 'UNKNOWN_TYPE'],
      ['a PDF where only images are allowed', () => pdf(), 'TYPE_NOT_ALLOWED'],
      ['unrecognisable bytes', () => Buffer.alloc(600, 65), 'UNKNOWN_TYPE'],
    ])('rejects %s, removes the metadata and queues the object for removal', async (_label, make, reason) => {
      const { customer, booking } = await h.acceptedBooking();
      const reg = await registerPhoto(customer, booking.id).expect(201);
      await put(reg.body.uploadUrl, make()).expect(200);
      const res = await confirmPhoto(customer, booking.id, reg.body.photo.id);
      expect(res.status).toBe(422);
      expect(res.body).toMatchObject({ code: 'FILE_CONTENT_INVALID', details: { reason } });

      expect(await h.prisma.bookingPhoto.count({ where: { id: reg.body.photo.id } })).toBe(0); // nothing implies a finished upload
      const key = `bookings/${booking.id}/photos/${reg.body.photo.id}`;
      expect(await h.prisma.storageDeletion.count({ where: { storageKey: key } })).toBe(1);
      expect(await storage.exists(key)).toBe(true); // still on disk until the removal job runs
      await deletions.runOnce();
      expect(await storage.exists(key)).toBe(false);
    });

    it('rejects a file the scanner reports as infected', async () => {
      const { customer, booking } = await h.acceptedBooking();
      const reg = await registerPhoto(customer, booking.id, { mimeType: 'image/jpeg', sizeBytes: infectedJpeg().length }).expect(201);
      await put(reg.body.uploadUrl, infectedJpeg(), 'image/jpeg').expect(200);
      const res = await confirmPhoto(customer, booking.id, reg.body.photo.id);
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('FILE_REJECTED_BY_SCAN');
      expect(await h.prisma.bookingPhoto.count({ where: { id: reg.body.photo.id } })).toBe(0);
    });

    it('answers a storage outage during confirmation with a retryable 503, keeps the pending upload, and confirms after recovery', async () => {
      const { customer, booking } = await h.acceptedBooking();
      const bytes = png(900);
      const reg = await registerPhoto(customer, booking.id, { sizeBytes: bytes.length }).expect(201);
      await put(reg.body.uploadUrl, bytes).expect(200);
      const storageKey = (await h.prisma.bookingPhoto.findUniqueOrThrow({ where: { id: reg.body.photo.id } })).storageKey;
      const spy = jest.spyOn(storage, 'inspect').mockRejectedValue(new Error('STORAGE_ERROR_503'));
      try {
        const down = await confirmPhoto(customer, booking.id, reg.body.photo.id);
        expect(down.status).toBe(503);
        expect(down.body.code).toBe('STORAGE_UNAVAILABLE');
        expect(JSON.stringify(down.body)).not.toMatch(/STORAGE_ERROR|amazonaws|X-Amz/);
        expect(await h.prisma.bookingPhoto.findUniqueOrThrow({ where: { id: reg.body.photo.id } })).toMatchObject({ status: 'PENDING_UPLOAD' }); // not rejected, not deleted
        expect(await h.prisma.storageDeletion.count({ where: { storageKey } })).toBe(0); // the object was not queued for removal
      } finally {
        spy.mockRestore();
      }
      expect((await confirmPhoto(customer, booking.id, reg.body.photo.id)).status).toBe(200);
    });

    it('refuses to confirm a file that was never uploaded, and files over the configured size', async () => {
      const { customer, booking } = await h.acceptedBooking();
      const reg = await registerPhoto(customer, booking.id).expect(201);
      const missing = await confirmPhoto(customer, booking.id, reg.body.photo.id);
      expect(missing.status).toBe(409);
      expect(missing.body.code).toBe('UPLOAD_NOT_FOUND');
      expect(await h.prisma.bookingPhoto.findUniqueOrThrow({ where: { id: reg.body.photo.id } })).toMatchObject({ status: 'PENDING_UPLOAD' }); // may retry the upload

      const big = await registerPhoto(customer, booking.id, { sizeBytes: 5000 });
      expect(big.status).toBe(400);
      expect(big.body.code).toBe('FILE_TOO_LARGE');
      expect((await registerPhoto(customer, booking.id, { mimeType: 'image/gif' })).status).toBe(400);
      expect((await registerPhoto(customer, booking.id, { mimeType: 'image/webp' })).status).toBe(400);
      expect((await registerPhoto(customer, booking.id, { fileName: '../../etc/passwd', sizeBytes: 600 })).status).toBe(201); // a name is only a label
      expect((await h.prisma.bookingPhoto.findMany({ where: { bookingId: booking.id, fileName: '../../etc/passwd' } }))[0]!.storageKey).toMatch(/^bookings\/[0-9a-f-]{36}\/photos\/[0-9a-f-]{36}$/);
    });
  });

  describe('signed URLs cannot be abused', () => {
    it('refuses tampered, expired, mismatched and repeated uploads', async () => {
      const { customer, booking } = await h.acceptedBooking();
      const reg = await registerPhoto(customer, booking.id).expect(201);
      const url = new URL(reg.body.uploadUrl);
      const q = (over: Record<string, string>) => {
        const u = new URL(url);
        for (const [k, v] of Object.entries(over)) u.searchParams.set(k, v);
        return u.pathname + u.search;
      };
      const send = (path: string, bytes = png(), type = 'image/png') => h.api().put(path).set('Content-Type', type).send(bytes);

      expect((await send(q({ sig: '0'.repeat(64) }))).status).toBe(403);
      expect((await send(q({ key: `bookings/${randomUUID()}/photos/${randomUUID()}` }))).status).toBe(403); // another key, same signature
      expect((await send(q({ size: '601' }))).status).toBe(403);
      expect((await send(q({ type: 'application/pdf' }))).status).toBe(403);
      expect((await send(q({ op: 'get' }))).status).toBe(403); // a download link cannot upload
      expect((await send(reg.body.uploadUrl.replace(/exp=\d+/, 'exp=1')).catch((e) => e)).status ?? 403).toBe(403);
      expect((await send(pathOf(reg.body.uploadUrl), png(), 'image/jpeg')).status).toBe(400); // Content-Type must match the signature
      expect((await send(pathOf(reg.body.uploadUrl), png(601))).status).toBe(400); // Content-Length must match

      expect((await send(pathOf(reg.body.uploadUrl))).status).toBe(200);
      const again = await send(pathOf(reg.body.uploadUrl), jpeg(), 'image/png');
      expect(again.status).toBe(409); // never overwritten
      expect(again.body.code).toBe('OBJECT_EXISTS');
      const confirmed = await confirmPhoto(customer, booking.id, reg.body.photo.id).expect(200);
      expect(confirmed.body.status).toBe('UPLOADED'); // the original PNG was kept
    });

    it('refuses a download link signed for another operation, expired, or for a missing object', async () => {
      const { customer, booking } = await h.acceptedBooking();
      const { reg } = await uploadedPhoto(customer, booking.id);
      const key = `bookings/${booking.id}/photos/${reg.photo.id}`;
      const exp = Math.floor(Date.now() / 1000) + 300;
      const sig = (over: object) => signLocalUrl(SECRET, { op: 'get', key, exp, ...over });
      const get = (query: Record<string, string>) => h.api().get(`/api/v1/storage/local/objects?${new URLSearchParams(query).toString()}`);

      expect((await get({ op: 'get', key, exp: String(exp), sig: sig({}) })).status).toBe(200);
      expect((await get({ op: 'get', key, exp: String(exp - 600), sig: sig({ exp: exp - 600 }) })).status).toBe(403); // expired
      expect((await get({ op: 'put', key, exp: String(exp), sig: sig({ op: 'put' }) })).status).toBe(403); // wrong operation for GET
      const ghost = `bookings/${randomUUID()}/photos/${randomUUID()}`;
      expect((await get({ op: 'get', key: ghost, exp: String(exp), sig: signLocalUrl(SECRET, { op: 'get', key: ghost, exp }) })).status).toBe(404);
      expect((await get({ op: 'get', key: '../../etc/passwd', exp: String(exp), sig: signLocalUrl(SECRET, { op: 'get', key: '../../etc/passwd', exp }) })).status).toBeGreaterThanOrEqual(400); // even a correctly signed bad key is refused
    });

    it('only accepts keys the API itself generates', () => {
      for (const bad of ['../x', 'workers/../../x', '/etc/passwd', 'bookings/a/photos/b', 'bookings/x/../photos/y', 'workers/' + randomUUID() + '/documents/../' + randomUUID(), '']) {
        expect(() => storage.pathFor(bad)).toThrow();
      }
      const ok = storage.pathFor(`bookings/${randomUUID()}/photos/${randomUUID()}`);
      expect(ok.startsWith(join(h.storageDir))).toBe(true);
    });
  });

  describe('booking photo access isolation', () => {
    it('owner and admin can view; strangers, unrelated workers and anonymous callers cannot', async () => {
      const { customer, booking } = await h.acceptedBooking();
      const { reg } = await uploadedPhoto(customer, booking.id);
      const url = (id: string, pid: string) => `/api/v1/bookings/${id}/photos/${pid}/download-url`;

      expect((await h.api().get(url(booking.id, reg.photo.id)).set(bearer(customer))).status).toBe(200);
      expect((await h.api().get(url(booking.id, reg.photo.id)).set(bearer(strangerCustomer))).status).toBe(404);
      expect((await h.api().get(url(booking.id, reg.photo.id)).set(bearer(strangerWorker))).status).toBe(403); // customer-only route
      expect((await h.api().get(url(booking.id, reg.photo.id))).status).toBe(401);
      const workerPath = `/api/v1/workers/me/requests/${booking.id}/photos/${reg.photo.id}/download-url`;
      expect((await h.api().get(workerPath).set(bearer(strangerWorker))).status).toBe(404); // not eligible, not assigned
      expect((await h.api().get(workerPath).set(bearer(strangerCustomer))).status).toBe(403);

      const admin = await h.api().get(`/api/v1/admin/bookings/${booking.id}/photos/${reg.photo.id}/download-url`).set(h.bearer(h.adminToken)).expect(200);
      expect(admin.body.url).toBeDefined();
      expect(await h.prisma.auditLog.count({ where: { action: 'booking.photo.accessed', entityId: reg.photo.id } })).toBe(1);
    });

    it('a guessed photo id of another booking is "not found" even for the owner of a different booking', async () => {
      const a = await h.acceptedBooking();
      const b = await h.acceptedBooking();
      const { reg } = await uploadedPhoto(a.customer, a.booking.id);
      const res = await h.api().get(`/api/v1/bookings/${b.booking.id}/photos/${reg.photo.id}/download-url`).set(bearer(b.customer));
      expect(res.status).toBe(404);
      const cross = await h.api().get(`/api/v1/bookings/${a.booking.id}/photos/${reg.photo.id}/download-url`).set(bearer(b.customer));
      expect(cross.status).toBe(404);
      expect((await registerPhoto(b.customer, a.booking.id)).status).toBe(404); // cannot upload to someone else's booking
      expect((await confirmPhoto(b.customer, a.booking.id, reg.photo.id)).status).toBe(404);
      expect((await h.api().delete(`/api/v1/bookings/${a.booking.id}/photos/${reg.photo.id}`).set(bearer(b.customer))).status).toBe(404);
    });

    it('the assigned worker can view once assigned; photos cannot be added after the job finished', async () => {
      const done = await h.confirmedBooking();
      const { reg } = await uploadedPhoto(done.customer, done.booking.id);
      const workerPath = `/api/v1/workers/me/requests/${done.booking.id}/photos/${reg.photo.id}/download-url`;
      expect((await h.api().get(workerPath).set(bearer(done.worker))).status).toBe(200);

      await h.startWork(done.worker, done.booking.id).expect(200);
      await h.completeWork(done.worker, done.booking.id).expect(200);
      const late = await registerPhoto(done.customer, done.booking.id);
      expect(late.status).toBe(409);
      expect(late.body.code).toBe('INVALID_STATE');
    });

    it('does not let a pending (unconfirmed) upload be downloaded', async () => {
      const { customer, booking } = await h.acceptedBooking();
      const reg = await registerPhoto(customer, booking.id).expect(201);
      await put(reg.body.uploadUrl, png()).expect(200);
      const res = await h.api().get(`/api/v1/bookings/${booking.id}/photos/${reg.body.photo.id}/download-url`).set(bearer(customer));
      expect(res.status).toBe(404);
    });
  });

  describe('worker verification documents', () => {
    const registerDoc = (w: Session, body: object = {}) =>
      h.api().post('/api/v1/workers/me/documents').set(bearer(w)).send({ type: 'IQAMA', fileName: 'iqama.pdf', mimeType: 'application/pdf', sizeBytes: 700, ...body });

    it('verifies a worker document, keeps it private to the worker and the reviewing admin, and audits admin views', async () => {
      const worker = await h.makeWorker([], [], 'NOT_SUBMITTED');
      const reg = await registerDoc(worker).expect(201);
      await put(reg.body.uploadUrl, pdf(700), 'application/pdf').expect(200);
      const confirmed = await h.api().post(`/api/v1/workers/me/documents/${reg.body.document.id}/confirm`).set(bearer(worker)).send({}).expect(200);
      expect(confirmed.body).toMatchObject({ status: 'UPLOADED', scanStatus: 'CLEAN' });
      expect(JSON.stringify(confirmed.body)).not.toMatch(/storageKey|workers\//);

      const row = await h.prisma.workerVerificationDocument.findUniqueOrThrow({ where: { id: reg.body.document.id } });
      expect(row.contentVerifiedAt).not.toBeNull();

      // nobody but the owner sees it in their list, and nobody else can confirm or delete it
      expect((await h.api().get('/api/v1/workers/me/documents').set(bearer(strangerWorker))).body.items).toHaveLength(0);
      expect((await h.api().post(`/api/v1/workers/me/documents/${reg.body.document.id}/confirm`).set(bearer(strangerWorker)).send({})).status).toBe(404);
      expect((await h.api().delete(`/api/v1/workers/me/documents/${reg.body.document.id}`).set(bearer(strangerWorker))).status).toBe(404);
      const adminUrl = `/api/v1/admin/workers/${worker.workerId}/documents/${reg.body.document.id}/download-url`;
      for (const who of [worker, strangerWorker, strangerCustomer]) expect((await h.api().get(adminUrl).set(bearer(who))).status).toBe(403);
      expect((await h.api().get(adminUrl)).status).toBe(401);

      const link = await h.api().get(adminUrl).set(h.bearer(h.adminToken)).expect(200);
      expect(link.body.url).toContain('/api/v1/storage/local/objects');
      expect(await h.prisma.auditLog.count({ where: { action: 'worker.document.accessed', entityId: reg.body.document.id } })).toBe(1);
      // the document id is bound to its worker: another worker's id in the path finds nothing
      const mismatch = `/api/v1/admin/workers/${strangerWorker.workerId}/documents/${reg.body.document.id}/download-url`;
      expect((await h.api().get(mismatch).set(h.bearer(h.adminToken))).status).toBe(404);
    });

    it('rejects a document whose bytes do not match, and a worker cannot approve themselves', async () => {
      const worker = await h.makeWorker([], [], 'NOT_SUBMITTED');
      const reg = await registerDoc(worker).expect(201);
      await put(reg.body.uploadUrl, exe(700), 'application/pdf').expect(200);
      const res = await h.api().post(`/api/v1/workers/me/documents/${reg.body.document.id}/confirm`).set(bearer(worker)).send({});
      expect(res.status).toBe(422);
      expect(await h.prisma.workerVerificationDocument.count({ where: { id: reg.body.document.id } })).toBe(0);

      expect((await h.api().post(`/api/v1/admin/workers/${worker.workerId}/approve`).set(bearer(worker)).send({})).status).toBe(403);
      expect((await h.api().patch(`/api/v1/admin/workers/${worker.workerId}/documents/${randomUUID()}`).set(bearer(worker)).send({ decision: 'ACCEPTED' })).status).toBe(403);
    });

    it('removes a deleted document through the removal queue', async () => {
      const worker = await h.makeWorker([], [], 'NOT_SUBMITTED');
      const reg = await registerDoc(worker, { mimeType: 'image/png', fileName: 'id.png' }).expect(201);
      await put(reg.body.uploadUrl, png(700), 'image/png').expect(200);
      await h.api().post(`/api/v1/workers/me/documents/${reg.body.document.id}/confirm`).set(bearer(worker)).send({}).expect(200);
      const key = `workers/${worker.workerId}/documents/${reg.body.document.id}`;
      await h.api().delete(`/api/v1/workers/me/documents/${reg.body.document.id}`).set(bearer(worker)).expect(204);
      expect(await h.prisma.workerVerificationDocument.count({ where: { id: reg.body.document.id } })).toBe(0);
      expect(await h.prisma.storageDeletion.count({ where: { storageKey: key, completedAt: null } })).toBe(1);
      await deletions.runOnce();
      expect(existsSync(storage.pathFor(key))).toBe(false);
    });
  });

  describe('abuse limits', () => {
    it('rate limits upload registration per client', async () => {
      const { customer, booking } = await h.acceptedBooking();
      const statuses: number[] = [];
      for (let i = 0; i < 125; i++) {
        const res = await h.api().post(`/api/v1/bookings/${booking.id}/photos`).set(bearer(customer)).set('X-Forwarded-For', '10.77.77.77').send({ fileName: 'a.png', mimeType: 'image/png', sizeBytes: 600 });
        statuses.push(res.status);
      }
      expect(statuses.filter((s) => s === 429).length).toBeGreaterThanOrEqual(5);
      expect(statuses.slice(0, 5)).toEqual([201, 201, 201, 201, 201]);
      expect(await h.prisma.bookingPhoto.count({ where: { bookingId: booking.id } })).toBe(5); // the per-booking photo limit still holds
    });
  });

  describe('removal queue', () => {
    const makeObject = async () => {
      const key = `bookings/${randomUUID()}/photos/${randomUUID()}`;
      await storage.store(key, (await import('node:stream')).Readable.from([png(100)]), 100);
      return key;
    };
    const enqueue = (key: string) => h.prisma.$transaction((tx) => deletions.enqueue(tx, key, 'test'));

    it('is idempotent: queueing twice makes one record, running twice deletes once, a missing object counts as done', async () => {
      const key = await makeObject();
      await enqueue(key);
      await enqueue(key);
      expect(await h.prisma.storageDeletion.count({ where: { storageKey: key } })).toBe(1);
      expect((await deletions.runOnce()).deleted).toBeGreaterThanOrEqual(1);
      expect(existsSync(storage.pathFor(key))).toBe(false);
      expect((await deletions.runOnce()).claimed).toBe(0);

      const ghost = `bookings/${randomUUID()}/photos/${randomUUID()}`;
      await enqueue(ghost);
      await deletions.runOnce();
      expect((await h.prisma.storageDeletion.findUniqueOrThrow({ where: { storageKey: ghost } })).completedAt).not.toBeNull();
    });

    it('retries with backoff during a provider outage, then parks the record instead of retrying forever', async () => {
      const key = await makeObject();
      await enqueue(key);
      const spy = jest.spyOn(storage, 'delete').mockRejectedValue(new Error('STORAGE_UNREACHABLE'));
      try {
        const t0 = new Date();
        expect(await deletions.runOnce(t0)).toMatchObject({ failed: 1 });
        let row = await h.prisma.storageDeletion.findUniqueOrThrow({ where: { storageKey: key } });
        expect(row).toMatchObject({ attempts: 1, completedAt: null, deadAt: null, lastError: 'STORAGE_UNREACHABLE' });
        expect(row.nextAttemptAt.getTime()).toBeGreaterThan(t0.getTime());
        expect((await deletions.runOnce(t0)).claimed).toBe(0); // not due yet
        await deletions.runOnce(new Date(t0.getTime() + 3_600_000));
        expect(await deletions.runOnce(new Date(t0.getTime() + 7_200_000))).toMatchObject({ dead: 1 }); // 3rd attempt
        row = await h.prisma.storageDeletion.findUniqueOrThrow({ where: { storageKey: key } });
        expect(row.deadAt).not.toBeNull();
        expect((await deletions.report()).dead).toBeGreaterThanOrEqual(1);
        expect(existsSync(storage.pathFor(key))).toBe(true); // the object is still there, not silently lost
      } finally {
        spy.mockRestore();
      }
    });

    it('recovers after the outage: the next due run removes the object', async () => {
      const key = await makeObject();
      await enqueue(key);
      const spy = jest.spyOn(storage, 'delete').mockRejectedValueOnce(new Error('STORAGE_UNREACHABLE'));
      try {
        const t0 = new Date();
        expect(await deletions.runOnce(t0)).toMatchObject({ failed: 1 });
        expect(await deletions.runOnce(new Date(t0.getTime() + 3_600_000))).toMatchObject({ deleted: 1 });
      } finally {
        spy.mockRestore();
      }
      expect(existsSync(storage.pathFor(key))).toBe(false);
    });

    it('never deletes an object a metadata row still references', async () => {
      const { customer, booking } = await h.acceptedBooking();
      const { reg } = await uploadedPhoto(customer, booking.id);
      const key = `bookings/${booking.id}/photos/${reg.photo.id}`;
      await enqueue(key); // e.g. a bug or a stale request asks for it
      const run = await deletions.runOnce();
      expect(run.skipped).toBeGreaterThanOrEqual(1);
      expect(existsSync(storage.pathFor(key))).toBe(true);
      expect((await h.api().get(`/api/v1/bookings/${booking.id}/photos/${reg.photo.id}/download-url`).set(bearer(customer))).status).toBe(200);
    });

    it('two competing runs never process the same record twice', async () => {
      const keys = await Promise.all(Array.from({ length: 6 }, makeObject));
      for (const k of keys) await enqueue(k);
      const spy = jest.spyOn(storage, 'delete');
      try {
        const [a, b] = await Promise.all([deletions.runOnce(), deletions.runOnce()]);
        expect(a.deleted + b.deleted).toBe(6);
        expect(spy).toHaveBeenCalledTimes(6);
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe('deleting a photo', () => {
    it('removes the metadata at once and the object through the queue, even if storage is down meanwhile', async () => {
      const { customer, booking } = await h.acceptedBooking();
      const { reg } = await uploadedPhoto(customer, booking.id);
      const key = `bookings/${booking.id}/photos/${reg.photo.id}`;
      const spy = jest.spyOn(storage, 'delete').mockRejectedValue(new Error('STORAGE_UNREACHABLE'));
      try {
        await h.api().delete(`/api/v1/bookings/${booking.id}/photos/${reg.photo.id}`).set(bearer(customer)).expect(204); // not blocked by the outage
        await deletions.runOnce();
      } finally {
        spy.mockRestore();
      }
      expect(await h.prisma.bookingPhoto.count({ where: { id: reg.photo.id } })).toBe(0);
      expect(existsSync(storage.pathFor(key))).toBe(true);
      await deletions.runOnce(new Date(Date.now() + 3_600_000));
      expect(existsSync(storage.pathFor(key))).toBe(false);
    });
  });
});
