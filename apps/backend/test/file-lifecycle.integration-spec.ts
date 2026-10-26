/**
 * REAL POSTGRESQL + REAL BYTES (local provider), with the asynchronous test scanner (FILE_SCANNER=mock-async) and clean scans required.
 * Covers the malware-scan lifecycle: pending files are never served, only a scanner's CLEAN verdict opens a file, infected files are denied
 * and queued for removal, scanner outages fail closed with bounded retries, duplicate / late results cannot change a file's state,
 * and the per-type link lifetimes. The scanner is a test double: this suite does not prove any real malware engine.
 */
import { jest } from '@jest/globals';
import { existsSync } from 'node:fs';
import { LocalDocumentStorage } from '../src/modules/storage/adapters/local-document-storage.js';
import { FileScanService } from '../src/modules/storage/file-scan.service.js';
import { FileScanner, MOCK_INFECTED_MARKER } from '../src/modules/storage/file-scanner.js';
import { StorageDeletionService } from '../src/modules/storage/storage-deletion.service.js';
import { DocumentStorage } from '../src/modules/workers/storage/document-storage.js';
import { type Harness, type Session, bootHarness } from './support/bookings-harness.js';

const run = process.env['TEST_DATABASE_URL'] ? describe : describe.skip;
if (!process.env['TEST_DATABASE_URL']) console.warn('file-lifecycle.integration-spec: TEST_DATABASE_URL is not set, suite skipped');

const SECRET = 'itest-lifecycle-signing-secret-0123456789abcdef';
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const png = (n = 600) => Buffer.concat([PNG_SIG, Buffer.alloc(n - 8, 7)]);
/** A valid PNG signature whose body (beyond the first 128 bytes the intake reads) carries the scanner's test marker: only a whole-object scan sees it. */
const infectedPng = () => Buffer.concat([PNG_SIG, Buffer.alloc(300, 7), Buffer.from(MOCK_INFECTED_MARKER), Buffer.alloc(100, 7)]);
const pdf = (n = 700) => Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(n - 9, 32)]);
const pathOf = (url: string) => {
  const u = new URL(url);
  return u.pathname + u.search;
};

run('file scan lifecycle (real PostgreSQL, real bytes, asynchronous test scanner)', () => {
  let h: Harness;
  let storage: LocalDocumentStorage;
  let scans: FileScanService;
  let scanner: FileScanner;
  let deletions: StorageDeletionService;

  const bearer = (s: Session | { accessToken: string }) => h.bearer(s.accessToken);
  const put = (uploadUrl: string, bytes: Buffer, type = 'image/png') => h.api().put(pathOf(uploadUrl)).set('Content-Type', type).send(bytes);
  const registerPhoto = (customer: Session, bookingId: string, size: number) =>
    h.api().post(`/api/v1/bookings/${bookingId}/photos`).set(bearer(customer)).send({ fileName: 'a.png', mimeType: 'image/png', sizeBytes: size });
  const confirmPhoto = (customer: Session, bookingId: string, photoId: string) =>
    h.api().post(`/api/v1/bookings/${bookingId}/photos/${photoId}/confirm`).set(bearer(customer)).send({});
  const photoLink = (who: { accessToken: string }, bookingId: string, photoId: string) =>
    h.api().get(`/api/v1/bookings/${bookingId}/photos/${photoId}/download-url`).set(bearer(who));
  const adminPhotoLink = (bookingId: string, photoId: string) => h.api().get(`/api/v1/admin/bookings/${bookingId}/photos/${photoId}/download-url`).set(h.bearer(h.adminToken));

  /** Registers, uploads and confirms a booking photo; returns ids and the storage key. The file is PENDING until the scan job runs. */
  async function confirmedPhoto(bytes = png(900)) {
    const { customer, booking } = await h.acceptedBooking();
    const reg = await registerPhoto(customer, booking.id, bytes.length).expect(201);
    await put(reg.body.uploadUrl, bytes).expect(200);
    const confirmed = await confirmPhoto(customer, booking.id, reg.body.photo.id).expect(200);
    const key = `bookings/${booking.id}/photos/${reg.body.photo.id}`;
    return { customer, booking, photoId: reg.body.photo.id as string, key, confirmed: confirmed.body };
  }
  async function confirmedDocument(bytes = pdf()) {
    const worker = await h.makeWorker([], [], 'NOT_SUBMITTED');
    const reg = await h.api().post('/api/v1/workers/me/documents').set(bearer(worker)).send({ type: 'IQAMA', fileName: 'iqama.pdf', mimeType: 'application/pdf', sizeBytes: bytes.length }).expect(201);
    await put(reg.body.uploadUrl, bytes, 'application/pdf').expect(200);
    const confirmed = await h.api().post(`/api/v1/workers/me/documents/${reg.body.document.id}/confirm`).set(bearer(worker)).send({}).expect(200);
    return { worker, docId: reg.body.document.id as string, key: `workers/${worker.workerId}/documents/${reg.body.document.id}`, confirmed: confirmed.body };
  }
  const adminDocLink = (workerId: string, docId: string) => h.api().get(`/api/v1/admin/workers/${workerId}/documents/${docId}/download-url`).set(h.bearer(h.adminToken));
  const job = (key: string) => h.prisma.fileScanJob.findUniqueOrThrow({ where: { storageKey: key } });
  const photoRow = (id: string) => h.prisma.bookingPhoto.findUniqueOrThrow({ where: { id } });
  /** Runs the scan job until nothing is due (far in the future so back-offs do not matter). */
  const scanAll = async (at = new Date(Date.now() + 3_600_000)) => scans.runOnce(at, 50);

  beforeAll(async () => {
    h = await bootHarness({
      phonePrefix: '+9665986',
      slugPrefix: 'itest-fl-',
      adminEmailPrefix: 'itest-fl-admin',
      env: {
        DOCUMENT_STORAGE: 'local',
        STORAGE_SIGNING_SECRET: SECRET,
        FILE_SCANNER: 'mock-async',
        STORAGE_REQUIRE_CLEAN_SCAN: 'true',
        FILE_SCAN_MAX_ATTEMPTS: '3',
        STORAGE_UPLOAD_URL_TTL_SECONDS: '120',
        BOOKING_PHOTO_URL_TTL_SECONDS: '600',
        IDENTITY_DOCUMENT_URL_TTL_SECONDS: '240',
      },
    });
    await h.seedReferenceData();
    storage = h.app.get(DocumentStorage) as LocalDocumentStorage;
    scans = h.app.get(FileScanService);
    scanner = h.app.get(FileScanner);
    deletions = h.app.get(StorageDeletionService);
    expect(storage).toBeInstanceOf(LocalDocumentStorage);
    expect(scanner.deferred).toBe(true);
  });

  afterAll(async () => {
    if (h) {
      await h.prisma.fileScanJob.deleteMany({}); // only this suite uses the asynchronous scanner, so every job in the queue is ours
      await h.close();
    }
  });

  beforeEach(async () => {
    // The scan queue is global (one queue for all files), so each test starts from an empty one and only sees its own jobs.
    await h.prisma.fileScanJob.deleteMany({});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('a confirmed file is pending, and pending files are never served', () => {
    it('queues the scan with the confirmation, reports PENDING, and refuses every viewer until the verdict', async () => {
      const p = await confirmedPhoto();
      expect(p.confirmed).toMatchObject({ status: 'UPLOADED', scanStatus: 'PENDING' });
      expect(await job(p.key)).toMatchObject({ status: 'QUEUED', attempts: 0, subject: 'BOOKING_PHOTO', subjectId: p.photoId });

      const owner = await photoLink(p.customer, p.booking.id, p.photoId);
      expect(owner.status).toBe(409);
      expect(owner.body).toMatchObject({ code: 'FILE_NOT_AVAILABLE', details: { reason: 'SCAN_PENDING' } });
      const admin = await adminPhotoLink(p.booking.id, p.photoId);
      expect(admin.status).toBe(409);
      expect(admin.body.details.reason).toBe('SCAN_PENDING');
      expect(JSON.stringify([owner.body, admin.body])).not.toMatch(/mock-async|scanner|storage|X-Amz/i);
      expect(await h.prisma.auditLog.count({ where: { action: 'booking.photo.accessed', entityId: p.photoId } })).toBe(0); // no link issued, no view audited
    });

    it('queues a worker identity document the same way and keeps it from the administrator until clean', async () => {
      const d = await confirmedDocument();
      expect(d.confirmed).toMatchObject({ status: 'UPLOADED', scanStatus: 'PENDING' });
      const denied = await adminDocLink(d.worker.workerId, d.docId);
      expect(denied.status).toBe(409);
      expect(denied.body.details.reason).toBe('SCAN_PENDING');
      expect(await h.prisma.auditLog.count({ where: { action: 'worker.document.accessed', entityId: d.docId } })).toBe(0);
      await scanAll();
      expect((await adminDocLink(d.worker.workerId, d.docId)).status).toBe(200);
      expect(await h.prisma.auditLog.count({ where: { action: 'worker.document.accessed', entityId: d.docId } })).toBe(1); // admin views stay audited
    });

    it('queues once however often a file is confirmed, and a repeated confirm does not reset the state', async () => {
      const p = await confirmedPhoto();
      await confirmPhoto(p.customer, p.booking.id, p.photoId).expect(200);
      await confirmPhoto(p.customer, p.booking.id, p.photoId).expect(200);
      expect(await h.prisma.fileScanJob.count({ where: { storageKey: p.key } })).toBe(1);
      await scanAll();
      expect((await photoRow(p.photoId)).scanStatus).toBe('CLEAN');
      await confirmPhoto(p.customer, p.booking.id, p.photoId).expect(200);
      expect((await photoRow(p.photoId)).scanStatus).toBe('CLEAN'); // not pushed back to PENDING
    });
  });

  describe('every download-link route refuses a file that is not CLEAN', () => {
    const workerPhotoLink = (worker: { accessToken: string }, bookingId: string, photoId: string) =>
      h.api().get(`/api/v1/workers/me/requests/${bookingId}/photos/${photoId}/download-url`).set(bearer(worker));

    it.each([
      ['PENDING', 'SCAN_PENDING'],
      ['ERROR', 'SCAN_FAILED'],
      ['INFECTED', 'REJECTED'],
      ['NOT_SCANNED', 'NOT_SCANNED'],
    ] as const)('%s: booking photo (customer, assigned worker, administrator) and identity document (administrator) all answer 409 and issue no link', async (state, reason) => {
      const p = await h.acceptedBooking();
      const reg = await registerPhoto(p.customer, p.booking.id, png(900).length).expect(201);
      await put(reg.body.uploadUrl, png(900)).expect(200);
      await confirmPhoto(p.customer, p.booking.id, reg.body.photo.id).expect(200);
      await h.prisma.bookingPhoto.update({ where: { id: reg.body.photo.id }, data: { scanStatus: state } });
      const d = await confirmedDocument();
      await h.prisma.workerVerificationDocument.update({ where: { id: d.docId }, data: { scanStatus: state } });

      const responses = [
        await photoLink(p.customer, p.booking.id, reg.body.photo.id),
        await workerPhotoLink(p.worker, p.booking.id, reg.body.photo.id),
        await adminPhotoLink(p.booking.id, reg.body.photo.id),
        await adminDocLink(d.worker.workerId, d.docId),
      ];
      for (const res of responses) {
        expect(res.status).toBe(409);
        expect(res.body).toMatchObject({ code: 'FILE_NOT_AVAILABLE', details: { reason } });
        expect(res.body.url).toBeUndefined();
      }
      expect(await h.prisma.auditLog.count({ where: { action: { in: ['booking.photo.accessed', 'worker.document.accessed'] }, entityId: { in: [reg.body.photo.id, d.docId] } } })).toBe(0);

      // and the same four routes open once the file is CLEAN
      await h.prisma.bookingPhoto.update({ where: { id: reg.body.photo.id }, data: { scanStatus: 'CLEAN' } });
      await h.prisma.workerVerificationDocument.update({ where: { id: d.docId }, data: { scanStatus: 'CLEAN' } });
      expect((await photoLink(p.customer, p.booking.id, reg.body.photo.id)).status).toBe(200);
      expect((await workerPhotoLink(p.worker, p.booking.id, reg.body.photo.id)).status).toBe(200);
      expect((await adminPhotoLink(p.booking.id, reg.body.photo.id)).status).toBe(200);
      expect((await adminDocLink(d.worker.workerId, d.docId)).status).toBe(200);
    });

    it('a stranger and an unrelated worker still get "not found" for a pending file, not a hint that it exists', async () => {
      const p = await confirmedPhoto();
      const stranger = await h.makeCustomer();
      const outsider = await h.makeWorker([], []);
      expect((await photoLink(stranger, p.booking.id, p.photoId)).status).toBe(404);
      expect((await workerPhotoLink(outsider, p.booking.id, p.photoId)).status).toBe(404);
    });
  });

  describe('only the scanner can open a file', () => {
    it('a CLEAN verdict is recorded with the scanner and a timestamp, and then the owner, an admin and an assigned worker can view the file', async () => {
      const p = await confirmedPhoto();
      expect(await scanAll()).toMatchObject({ clean: expect.any(Number) });
      expect(await photoRow(p.photoId)).toMatchObject({ scanStatus: 'CLEAN' });
      const done = await job(p.key);
      expect(done).toMatchObject({ status: 'DONE', verdict: 'CLEAN', scanner: 'mock-async', lastError: null, attempts: 1 });
      expect(done.completedAt).toBeInstanceOf(Date);
      expect((await photoLink(p.customer, p.booking.id, p.photoId)).status).toBe(200);
      expect((await adminPhotoLink(p.booking.id, p.photoId)).status).toBe(200);
    });

    it('ownership is unchanged: a stranger still gets "not found", not "not available"', async () => {
      const p = await confirmedPhoto();
      const stranger = await h.makeCustomer();
      expect((await photoLink(stranger, p.booking.id, p.photoId)).status).toBe(404);
      await scanAll();
      expect((await photoLink(stranger, p.booking.id, p.photoId)).status).toBe(404);
      expect((await h.api().get(`/api/v1/bookings/${p.booking.id}/photos/${p.photoId}/download-url`)).status).toBe(401);
    });

    it('an infected file is denied, its object is queued for removal and then removed even though a row still exists', async () => {
      const p = await confirmedPhoto(infectedPng());
      const result = await scanAll();
      expect(result.infected).toBeGreaterThanOrEqual(1);
      expect(await photoRow(p.photoId)).toMatchObject({ scanStatus: 'INFECTED' });
      expect(await job(p.key)).toMatchObject({ status: 'DONE', verdict: 'INFECTED' });
      const denied = await photoLink(p.customer, p.booking.id, p.photoId);
      expect(denied.status).toBe(409);
      expect(denied.body.details.reason).toBe('REJECTED');
      expect((await adminPhotoLink(p.booking.id, p.photoId)).status).toBe(409);
      expect(await h.prisma.storageDeletion.count({ where: { storageKey: p.key, reason: 'infected' } })).toBe(1);
      expect(await h.prisma.auditLog.count({ where: { action: 'file.scan.infected', entityId: p.photoId } })).toBe(1);
      expect(await storage.exists(p.key)).toBe(true);
      await deletions.runOnce();
      expect(await storage.exists(p.key)).toBe(false);
      expect(JSON.stringify(await h.prisma.auditLog.findMany({ where: { entityId: p.photoId } }))).not.toContain(MOCK_INFECTED_MARKER);
    });

    it('an infected identity document is denied to the administrator', async () => {
      const d = await confirmedDocument(Buffer.concat([pdf(300), Buffer.from(MOCK_INFECTED_MARKER), Buffer.alloc(200, 32)]));
      await scanAll();
      expect(await h.prisma.workerVerificationDocument.findUniqueOrThrow({ where: { id: d.docId } })).toMatchObject({ scanStatus: 'INFECTED' });
      const denied = await adminDocLink(d.worker.workerId, d.docId);
      expect(denied.status).toBe(409);
      expect(denied.body.details.reason).toBe('REJECTED');
      await deletions.runOnce();
      expect(await storage.exists(d.key)).toBe(false);
    });
  });

  describe('scanner problems fail closed', () => {
    it('retries a failing scanner with back-off, keeps the file PENDING and unavailable meanwhile, then recovers', async () => {
      const p = await confirmedPhoto();
      const spy = jest.spyOn(scanner, 'scan').mockRejectedValueOnce(new Error('SCANNER_DOWN')).mockRejectedValueOnce(Object.assign(new Error('connect ECONNREFUSED https://scan.internal/x?token=abc'), { name: 'Error' }));
      const t0 = new Date();
      expect(await scans.runOnce(t0, 50)).toMatchObject({ retried: expect.any(Number) });
      let row = await job(p.key);
      expect(row).toMatchObject({ status: 'QUEUED', attempts: 1, lastError: 'SCANNER_DOWN' });
      expect(row.nextAttemptAt.getTime()).toBeGreaterThan(t0.getTime()); // backed off
      expect((await scans.runOnce(t0, 50)).claimed).toBe(0); // not due yet
      expect((await photoLink(p.customer, p.booking.id, p.photoId)).status).toBe(409);

      await scans.runOnce(new Date(t0.getTime() + 3_600_000), 50); // second failure
      row = await job(p.key);
      expect(row).toMatchObject({ status: 'QUEUED', attempts: 2 });
      expect(row.lastError).toMatch(/^[A-Z0-9_]{3,60}$/); // a short code, never the message with the URL and token
      expect(JSON.stringify(row)).not.toMatch(/scan\.internal|token/);

      spy.mockRestore();
      await scans.runOnce(new Date(t0.getTime() + 7_200_000), 50); // the real test scanner works again
      expect(await photoRow(p.photoId)).toMatchObject({ scanStatus: 'CLEAN' });
      expect((await job(p.key)).attempts).toBe(3);
    });

    it('gives up after the maximum attempts: the job is DEAD, the file is ERROR and never served; an operator can requeue it', async () => {
      const p = await confirmedPhoto();
      jest.spyOn(scanner, 'scan').mockRejectedValue(new Error('SCANNER_DOWN'));
      let at = Date.now();
      for (let i = 0; i < 3; i++) await scans.runOnce(new Date((at += 3_600_000)), 50);
      expect(await job(p.key)).toMatchObject({ status: 'DEAD', attempts: 3, lastError: 'SCANNER_DOWN' });
      expect(await photoRow(p.photoId)).toMatchObject({ scanStatus: 'ERROR' });
      const denied = await photoLink(p.customer, p.booking.id, p.photoId);
      expect(denied.status).toBe(409);
      expect(denied.body.details.reason).toBe('SCAN_FAILED');
      expect((await scans.report()).dead).toBeGreaterThanOrEqual(1);
      expect((await scans.runOnce(new Date((at += 3_600_000)), 50)).claimed).toBe(0); // dead means dead: no endless retries

      jest.restoreAllMocks();
      expect(await scans.requeueFailed(p.key)).toBe(true);
      expect(await photoRow(p.photoId)).toMatchObject({ scanStatus: 'PENDING' });
      await scans.runOnce(new Date((at += 3_600_000)), 50);
      expect(await photoRow(p.photoId)).toMatchObject({ scanStatus: 'CLEAN' });
      expect(await scans.requeueFailed(p.key)).toBe(false); // nothing failed any more; a clean file is never requeued
    });

    it('never treats "nothing was inspected" or a scanner error as clean', async () => {
      const a = await confirmedPhoto();
      const b = await confirmedPhoto();
      const spy = jest.spyOn(scanner, 'scan').mockResolvedValueOnce('NOT_SCANNED').mockResolvedValueOnce('ERROR');
      await scans.runOnce(new Date(Date.now() + 60_000), 50);
      spy.mockRestore();
      const codes = [(await job(a.key)).lastError, (await job(b.key)).lastError].sort();
      expect(codes).toEqual(['SCANNER_ERROR', 'SCANNER_NOT_SCANNED']);
      for (const id of [a.photoId, b.photoId]) expect((await photoRow(id)).scanStatus).toBe('PENDING');
    });

    it('treats a missing object as a failure with a code, not as clean', async () => {
      const p = await confirmedPhoto();
      await storage.delete(p.key);
      await scans.runOnce(new Date(Date.now() + 60_000), 50);
      expect(await job(p.key)).toMatchObject({ status: 'QUEUED', lastError: 'OBJECT_MISSING' });
      expect((await photoRow(p.photoId)).scanStatus).toBe('PENDING');
    });

    it('a hung scanner does not hold the job forever: the lease expires and another run takes over', async () => {
      const p = await confirmedPhoto();
      await h.prisma.fileScanJob.update({ where: { storageKey: p.key }, data: { status: 'RUNNING', attempts: 1, lockedUntil: new Date(Date.now() - 1000) } }); // a crashed run
      const out = await scans.runOnce(new Date(), 50);
      expect(out.clean).toBeGreaterThanOrEqual(1);
      expect(await job(p.key)).toMatchObject({ status: 'DONE', verdict: 'CLEAN', attempts: 2 });
    });
  });

  describe('duplicate and late results cannot change a file', () => {
    it('two scan runs at the same time scan each file once', async () => {
      const files = await Promise.all([confirmedPhoto(), confirmedPhoto(), confirmedPhoto()]);
      const spy = jest.spyOn(scanner, 'scan');
      const [a, b] = await Promise.all([scans.runOnce(new Date(Date.now() + 60_000), 50), scans.runOnce(new Date(Date.now() + 60_000), 50)]);
      expect(a.clean + b.clean).toBeGreaterThanOrEqual(3);
      const scannedKeys = spy.mock.calls.map((c) => (c[0] as { storageKey: string }).storageKey);
      for (const f of files) expect(scannedKeys.filter((k) => k === f.key)).toHaveLength(1);
      for (const f of files) expect((await photoRow(f.photoId)).scanStatus).toBe('CLEAN');
    });

    it('a result from a run whose lease was taken over is discarded', async () => {
      const p = await confirmedPhoto();
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => (release = resolve));
      // The first run claims the job, then hangs; its answer ("CLEAN") arrives only after another run has finished the job as INFECTED.
      const spy = jest.spyOn(scanner, 'scan').mockImplementationOnce(async () => {
        await gate;
        return 'CLEAN';
      });
      const first = scans.runOnce(new Date(), 50);
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect((await job(p.key)).status).toBe('RUNNING');
      await h.prisma.fileScanJob.update({ where: { storageKey: p.key }, data: { lockedUntil: new Date(Date.now() - 1000) } }); // lease expired
      spy.mockResolvedValueOnce('INFECTED');
      const second = await scans.runOnce(new Date(), 50);
      expect(second.infected).toBe(1);
      release();
      const late = await first;
      expect(late.stale).toBe(1);
      expect(await photoRow(p.photoId)).toMatchObject({ scanStatus: 'INFECTED' }); // the stale CLEAN did not win
      expect(await job(p.key)).toMatchObject({ status: 'DONE', verdict: 'INFECTED' });
    });

    it('a verdict never overwrites a file that is no longer pending, and a file deleted meanwhile is simply skipped', async () => {
      const p = await confirmedPhoto();
      await h.prisma.bookingPhoto.update({ where: { id: p.photoId }, data: { scanStatus: 'ERROR' } }); // changed by someone else
      await scans.runOnce(new Date(Date.now() + 60_000), 50);
      expect((await photoRow(p.photoId)).scanStatus).toBe('ERROR'); // compare-and-set from PENDING only
      const q = await confirmedPhoto();
      await h.prisma.bookingPhoto.delete({ where: { id: q.photoId } });
      const out = await scans.runOnce(new Date(Date.now() + 60_000), 50);
      expect(out.stale).toBe(0);
      expect(await job(q.key)).toMatchObject({ status: 'DONE' });
    });
  });

  describe('link lifetimes by purpose', () => {
    const seconds = (iso: string) => Math.round((new Date(iso).getTime() - Date.now()) / 1000);

    it('upload links use the upload setting, photo views the photo setting, identity documents the shorter identity setting', async () => {
      const { customer, booking } = await h.acceptedBooking();
      const reg = await registerPhoto(customer, booking.id, png(900).length).expect(201);
      expect(seconds(reg.body.expiresAt)).toBeGreaterThan(110);
      expect(seconds(reg.body.expiresAt)).toBeLessThanOrEqual(120);
      await put(reg.body.uploadUrl, png(900)).expect(200);
      await confirmPhoto(customer, booking.id, reg.body.photo.id).expect(200);
      await scanAll();
      const view = await photoLink(customer, booking.id, reg.body.photo.id).expect(200);
      expect(seconds(view.body.expiresAt)).toBeGreaterThan(590);
      expect(seconds(view.body.expiresAt)).toBeLessThanOrEqual(600);

      const d = await confirmedDocument();
      await scanAll();
      const docView = await adminDocLink(d.worker.workerId, d.docId).expect(200);
      expect(seconds(docView.body.expiresAt)).toBeGreaterThan(230);
      expect(seconds(docView.body.expiresAt)).toBeLessThanOrEqual(240);
      const worker = await h.makeWorker([], [], 'NOT_SUBMITTED');
      const docReg = await h.api().post('/api/v1/workers/me/documents').set(bearer(worker)).send({ type: 'IQAMA', fileName: 'a.pdf', mimeType: 'application/pdf', sizeBytes: 700 }).expect(201);
      expect(seconds(docReg.body.expiresAt)).toBeLessThanOrEqual(120);
      expect(existsSync(storage.pathFor(d.key))).toBe(true);
    });
  });
});
