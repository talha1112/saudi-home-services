/**
 * REAL POSTGRESQL + REAL BYTES (local provider): cleanup of uploads that were registered but never confirmed.
 * Only stale PENDING_UPLOAD rows with no reference are removed, only their exact object keys are queued, confirmed and referenced files are never
 * touched, repeated and concurrent runs are harmless, and a storage failure is retried by the existing removal queue.
 */
import { jest } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { AbandonedUploadCleanupService } from '../src/modules/storage/abandoned-upload-cleanup.service.js';
import { LocalDocumentStorage } from '../src/modules/storage/adapters/local-document-storage.js';
import { StorageDeletionService } from '../src/modules/storage/storage-deletion.service.js';
import { DocumentStorage } from '../src/modules/workers/storage/document-storage.js';
import { type Harness, type Session, bootHarness } from './support/bookings-harness.js';

const run = process.env['TEST_DATABASE_URL'] ? describe : describe.skip;
if (!process.env['TEST_DATABASE_URL']) console.warn('abandoned-uploads.integration-spec: TEST_DATABASE_URL is not set, suite skipped');

const SECRET = 'itest-abandoned-signing-secret-0123456789abcdef';
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(92, 7)]);
const HOUR = 3_600_000;
const ago = (ms: number) => new Date(Date.now() - ms);

run('abandoned upload cleanup (real PostgreSQL, real bytes)', () => {
  let h: Harness;
  let storage: LocalDocumentStorage;
  let cleanup: AbandonedUploadCleanupService;
  let deletions: StorageDeletionService;
  let customer: Session;
  let bookingId: string;
  let workerProfileId: string;

  const store = async (key: string) => storage.store(key, Readable.from([PNG]), PNG.length);
  /** A photo row (and its object) in the given state, created `age` ms ago. */
  async function photo(status: 'PENDING_UPLOAD' | 'UPLOADED', age: number, withObject = true) {
    const id = randomUUID();
    const storageKey = `bookings/${bookingId}/photos/${id}`;
    if (withObject) await store(storageKey);
    await h.prisma.bookingPhoto.create({ data: { id, bookingId, status, storageKey, fileName: 'p.png', mimeType: 'image/png', sizeBytes: PNG.length, createdAt: ago(age) } });
    return { id, storageKey };
  }
  async function document(status: 'PENDING_UPLOAD' | 'UPLOADED', age: number) {
    const id = randomUUID();
    const storageKey = `workers/${workerProfileId}/documents/${id}`;
    await store(storageKey);
    await h.prisma.workerVerificationDocument.create({ data: { id, workerProfileId, type: 'IQAMA', status, storageKey, fileName: 'd.png', mimeType: 'image/png', sizeBytes: PNG.length, createdAt: ago(age) } });
    return { id, storageKey };
  }
  const queued = (key: string) => h.prisma.storageDeletion.findUnique({ where: { storageKey: key } });
  const photoExists = async (id: string) => (await h.prisma.bookingPhoto.count({ where: { id } })) === 1;
  const docExists = async (id: string) => (await h.prisma.workerVerificationDocument.count({ where: { id } })) === 1;

  beforeAll(async () => {
    h = await bootHarness({
      phonePrefix: '+9665985',
      slugPrefix: 'itest-ab-',
      adminEmailPrefix: 'itest-ab-admin',
      env: { DOCUMENT_STORAGE: 'local', STORAGE_SIGNING_SECRET: SECRET, STORAGE_DELETION_MAX_ATTEMPTS: '3' },
    });
    await h.seedReferenceData();
    const accepted = await h.acceptedBooking();
    customer = accepted.customer;
    bookingId = accepted.booking.id;
    workerProfileId = (await h.makeWorker([], [], 'NOT_SUBMITTED')).workerId;
    storage = h.app.get(DocumentStorage) as LocalDocumentStorage;
    cleanup = h.app.get(AbandonedUploadCleanupService);
    deletions = h.app.get(StorageDeletionService);
    expect(customer.accessToken).toBeTruthy();
  });

  afterAll(async () => {
    if (h) await h.close();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('removes stale unconfirmed photo and document uploads: rows deleted, exact keys queued, objects removed by the existing queue', async () => {
    const p = await photo('PENDING_UPLOAD', 3 * 24 * HOUR);
    const d = await document('PENDING_UPLOAD', 3 * 24 * HOUR);
    const result = await cleanup.runOnce();
    expect(result.photos).toBeGreaterThanOrEqual(1);
    expect(result.documents).toBeGreaterThanOrEqual(1);
    expect(await photoExists(p.id)).toBe(false);
    expect(await docExists(d.id)).toBe(false);
    expect(await queued(p.storageKey)).toMatchObject({ reason: 'abandoned-upload', attempts: 0, completedAt: null });
    expect(await queued(d.storageKey)).toMatchObject({ reason: 'abandoned-upload' });
    expect(await storage.exists(p.storageKey)).toBe(true); // the object goes through the retried queue, not inline
    await deletions.runOnce();
    expect(await storage.exists(p.storageKey)).toBe(false);
    expect(await storage.exists(d.storageKey)).toBe(false);
  });

  it('leaves recent uploads alone, including one just inside the minimum age', async () => {
    const fresh = await photo('PENDING_UPLOAD', 5 * 60_000);
    const hours = await photo('PENDING_UPLOAD', 6 * HOUR);
    const edge = await photo('PENDING_UPLOAD', 24 * HOUR - 5 * 60_000); // 5 minutes short of the 24 hour default
    const freshDoc = await document('PENDING_UPLOAD', 2 * HOUR);
    await cleanup.runOnce();
    for (const f of [fresh, hours, edge]) {
      expect(await photoExists(f.id)).toBe(true);
      expect(await queued(f.storageKey)).toBeNull();
      expect(await storage.exists(f.storageKey)).toBe(true);
    }
    expect(await docExists(freshDoc.id)).toBe(true);
    expect(await queued(freshDoc.storageKey)).toBeNull();
  });

  it('never touches confirmed files, however old', async () => {
    const p = await photo('UPLOADED', 90 * 24 * HOUR);
    const d = await document('UPLOADED', 90 * 24 * HOUR);
    await cleanup.runOnce();
    await deletions.runOnce();
    expect(await photoExists(p.id)).toBe(true);
    expect(await docExists(d.id)).toBe(true);
    expect(await queued(p.storageKey)).toBeNull();
    expect(await queued(d.storageKey)).toBeNull();
    expect(await storage.exists(p.storageKey)).toBe(true);
    expect(await storage.exists(d.storageKey)).toBe(true);
  });

  it('never touches a photo that dispute evidence points to, nor an object the removal queue finds still referenced', async () => {
    const booking = await h.confirmedBooking();
    const cited = await h.prisma.bookingPhoto.create({
      data: { bookingId: booking.booking.id, status: 'UPLOADED', storageKey: `bookings/${booking.booking.id}/photos/${randomUUID()}`, fileName: 'e.png', mimeType: 'image/png', sizeBytes: PNG.length },
    });
    await store(cited.storageKey);
    await h.api().post('/api/v1/disputes').set(h.bearer(booking.customer.accessToken)).set('X-Forwarded-For', h.freshIp()).send({ bookingId: booking.booking.id, category: 'SERVICE_QUALITY', description: 'The technician left before finishing and the outlet still sparks.', bookingPhotoIds: [cited.id] }).expect(201);
    await h.prisma.bookingPhoto.update({ where: { id: cited.id }, data: { status: 'PENDING_UPLOAD', createdAt: ago(10 * 24 * HOUR) } }); // an impossible state, to prove the guard rather than the status
    await cleanup.runOnce();
    expect(await photoExists(cited.id)).toBe(true);
    expect(await queued(cited.storageKey)).toBeNull();
    expect(await storage.exists(cited.storageKey)).toBe(true);
    // even if its key were queued, the existing reference protection closes the removal without deleting the object
    await h.prisma.$transaction((tx) => deletions.enqueue(tx, cited.storageKey, 'test'));
    await deletions.runOnce();
    expect(await storage.exists(cited.storageKey)).toBe(true);
    expect(await h.prisma.storageDeletion.findUniqueOrThrow({ where: { storageKey: cited.storageKey } })).toMatchObject({ lastError: 'STILL_REFERENCED' });
  });

  it('is idempotent and safe when several workers run at once: each row is taken once, one removal record per key', async () => {
    const mine = await Promise.all(Array.from({ length: 6 }, () => photo('PENDING_UPLOAD', 2 * 24 * HOUR)));
    const runs = await Promise.all([cleanup.runOnce(), cleanup.runOnce(), cleanup.runOnce()]);
    const taken = runs.reduce((n, r) => n + r.photos, 0);
    expect(taken).toBeGreaterThanOrEqual(6);
    for (const m of mine) {
      expect(await photoExists(m.id)).toBe(false);
      expect(await h.prisma.storageDeletion.count({ where: { storageKey: m.storageKey } })).toBe(1);
    }
    const again = await cleanup.runOnce();
    expect(again.photos + again.documents).toBe(0); // nothing left to do
  });

  it('deletes only the exact keys of the rows it removed: an unrelated object in storage is never touched', async () => {
    const unrelated = `bookings/${randomUUID()}/photos/${randomUUID()}`;
    await store(unrelated); // no row, no queue entry: something this job must not know about
    const stale = await photo('PENDING_UPLOAD', 4 * 24 * HOUR);
    const deleteSpy = jest.spyOn(storage, 'delete');
    await cleanup.runOnce();
    await deletions.runOnce();
    expect(deleteSpy.mock.calls.map((c) => c[0])).toContain(stale.storageKey);
    expect(deleteSpy.mock.calls.map((c) => c[0])).not.toContain(unrelated);
    expect(await storage.exists(unrelated)).toBe(true);
    await storage.delete(unrelated); // test housekeeping: this exact object only
  });

  it('keeps the removal queued and retries when storage fails, then removes the object after recovery', async () => {
    const stale = await photo('PENDING_UPLOAD', 5 * 24 * HOUR);
    const spy = jest.spyOn(storage, 'delete').mockRejectedValue(new Error('STORAGE_UNREACHABLE'));
    await cleanup.runOnce();
    expect(await photoExists(stale.id)).toBe(false); // the metadata cleanup does not depend on storage being up
    const t0 = new Date();
    await deletions.runOnce(t0);
    expect(await queued(stale.storageKey)).toMatchObject({ attempts: 1, completedAt: null, deadAt: null, lastError: 'STORAGE_UNREACHABLE' });
    expect(await storage.exists(stale.storageKey)).toBe(true);
    spy.mockRestore();
    await deletions.runOnce(new Date(t0.getTime() + 3_600_000));
    expect(await storage.exists(stale.storageKey)).toBe(false);
    expect(await queued(stale.storageKey)).toMatchObject({ completedAt: expect.any(Date) });
  });

  it('is safe against a confirmation arriving at the same moment: the file is either confirmed and kept, or cleaned and the confirmation says "not found", never both and never an error', async () => {
    const outcomes = { kept: 0, cleaned: 0 };
    for (let i = 0; i < 8; i++) {
      const accepted = await h.acceptedBooking();
      const reg = await h.api().post(`/api/v1/bookings/${accepted.booking.id}/photos`).set(h.bearer(accepted.customer.accessToken)).send({ fileName: 'a.png', mimeType: 'image/png', sizeBytes: PNG.length }).expect(201);
      const id = reg.body.photo.id as string;
      const key = `bookings/${accepted.booking.id}/photos/${id}`;
      const uploadPath = new URL(reg.body.uploadUrl);
      await h.api().put(uploadPath.pathname + uploadPath.search).set('Content-Type', 'image/png').send(PNG).expect(200);
      await h.prisma.bookingPhoto.update({ where: { id }, data: { createdAt: ago(3 * 24 * HOUR) } }); // eligible for cleanup
      const [confirm] = await Promise.all([
        h.api().post(`/api/v1/bookings/${accepted.booking.id}/photos/${id}/confirm`).set(h.bearer(accepted.customer.accessToken)).send({}),
        cleanup.runOnce(),
      ]);
      expect([200, 404]).toContain(confirm.status); // never a server error
      const row = await h.prisma.bookingPhoto.findUnique({ where: { id } });
      if (row) {
        outcomes.kept += 1;
        expect(confirm.status).toBe(200);
        expect(row.status).toBe('UPLOADED'); // a confirmed file is never removed
        expect(await queued(key)).toBeNull();
        expect(await storage.exists(key)).toBe(true);
      } else {
        outcomes.cleaned += 1;
        expect(confirm.status).toBe(404);
        expect(await queued(key)).toMatchObject({ reason: 'abandoned-upload' });
      }
      // a later run changes nothing about a confirmed file
      await cleanup.runOnce();
      expect((await h.prisma.bookingPhoto.findUnique({ where: { id } }))?.status ?? 'GONE').toBe(row ? 'UPLOADED' : 'GONE');
    }
    expect(outcomes.kept + outcomes.cleaned).toBe(8);
  });

  it('works in bounded batches', async () => {
    const mine = await Promise.all(Array.from({ length: 4 }, () => photo('PENDING_UPLOAD', 6 * 24 * HOUR)));
    const first = await cleanup.runOnce(new Date(), 1);
    expect(first.photos).toBe(1);
    const rest = await cleanup.runOnce(new Date(), 100);
    expect(rest.photos).toBeGreaterThanOrEqual(3);
    for (const m of mine) expect(await photoExists(m.id)).toBe(false);
  });
});
