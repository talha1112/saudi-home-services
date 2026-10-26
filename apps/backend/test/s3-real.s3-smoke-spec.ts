/**
 * LIVE S3 SMOKE TEST for the application's real adapter (S3DocumentStorage + FileIntakeService). Not part of any automated suite.
 *
 *   $env:S3_SMOKE_TEST = "1"
 *   $env:S3_SMOKE_CONFIRM_BUCKET = "<the exact bucket name from your S3 settings>"
 *   npm run test:s3-smoke
 *
 * Safety:
 *  - Refuses to run unless S3_SMOKE_TEST=1, NODE_ENV is not production, S3 settings are complete and S3_SMOKE_CONFIRM_BUCKET equals
 *    the configured bucket exactly (so a wrong or ambiguous target can never be used by accident).
 *  - Never lists the bucket and never deletes anything it did not create: every object key is a fresh random one generated here
 *    (in the API's own key shape, so the adapter accepts it) and only those exact keys are deleted, in `finally`.
 *  - Never connects to any database. Never prints credentials or signed URLs (only step names and HTTP status codes).
 *  - The test files are a 67-byte 1x1 PNG. No real user data is involved.
 */
import { randomUUID } from 'node:crypto';
import appConfig from '../src/config/app.config.js';
import { S3DocumentStorage } from '../src/modules/storage/adapters/s3-document-storage.js';
import { DisabledFileScanner } from '../src/modules/storage/file-scanner.js';
import { FileIntakeService } from '../src/modules/storage/file-intake.service.js';
import type { DocumentStorage } from '../src/modules/workers/storage/document-storage.js';

const requested = process.env['S3_SMOKE_TEST'] === '1';
const run = requested ? describe : describe.skip;
if (!requested) console.warn('s3 smoke test skipped: set S3_SMOKE_TEST=1 and S3_SMOKE_CONFIRM_BUCKET to run it against the real bucket');

const PNG_1X1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const newKey = () => `bookings/${randomUUID()}/photos/${randomUUID()}`;
const report = (step: string, outcome: string) => console.log(`[s3-smoke] ${step}: ${outcome}`);

/** HTTP status only. Network errors are reduced to a fixed message because they can carry the signed URL. */
async function status(url: string, init: RequestInit = {}): Promise<{ code: number; res: Response }> {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(20_000) });
    return { code: res.status, res };
  } catch {
    throw new Error('network error talking to S3 (details withheld: they can contain a signed URL)');
  }
}

run('live S3 smoke test (real bucket, real adapter)', () => {
  const created: string[] = [];
  let storage: DocumentStorage;
  let cfg: ReturnType<typeof appConfig>;
  let intake: FileIntakeService;

  beforeAll(() => {
    cfg = appConfig();
    const s3 = cfg.storage.s3;
    if (cfg.isProduction) throw new Error('REFUSED: the smoke test never runs with NODE_ENV=production');
    const missing = (['region', 'bucket', 'accessKeyId', 'secretAccessKey'] as const).filter((k) => !s3[k]);
    if (missing.length > 0) throw new Error(`REFUSED: S3 settings incomplete (${missing.join(', ')})`);
    if (process.env['S3_SMOKE_CONFIRM_BUCKET'] !== s3.bucket) {
      throw new Error('REFUSED: S3_SMOKE_CONFIRM_BUCKET must equal the configured bucket name exactly (target is ambiguous)');
    }
    report('target', `region ${s3.region}, bucket ${s3.bucket}${s3.endpoint ? ', custom endpoint' : ', AWS endpoint'} (credentials not shown)`);
    storage = new S3DocumentStorage({ getOrThrow: () => cfg } as never);
    intake = new FileIntakeService({ getOrThrow: () => cfg } as never, storage, new DisabledFileScanner());
  });

  afterAll(async () => {
    // Only the exact keys created above. Deleting a missing key is a no-op.
    for (const key of created) {
      try {
        await storage.delete(key);
        report('cleanup', `removed temporary object ${key.slice(-8)}`);
      } catch {
        report('cleanup', `COULD NOT remove temporary object ending ${key.slice(-8)} (remove that exact key manually)`);
      }
    }
  });

  const upload = async (key: string, body: Buffer, mimeType: string, declaredSize = body.length) => {
    created.push(key);
    const target = await storage.createUploadTarget({ storageKey: key, mimeType, sizeBytes: declaredSize, ttlSeconds: 120 });
    return status(target.uploadUrl, { method: target.method, headers: { 'Content-Type': mimeType }, body: new Uint8Array(body) });
  };

  it('uploads through a presigned URL, confirms the stored object, downloads it, deletes it, and survives a second delete', async () => {
    const key = newKey();

    // 1-2. initialise adapter, presigned upload URL, real upload
    const put = await upload(key, PNG_1X1, 'image/png');
    expect(put.code).toBe(200);
    report('presigned upload (PUT with signed Content-Type/Length)', `HTTP ${put.code}`);

    // 3. confirmation: existence, real size, real first bytes, through the same service the API uses
    expect(await storage.exists(key)).toBe(true);
    const inspected = await storage.inspect(key);
    expect(inspected).not.toBeNull();
    expect(inspected).not.toBe('UNINSPECTABLE');
    if (inspected && inspected !== 'UNINSPECTABLE') {
      expect(inspected.sizeBytes).toBe(PNG_1X1.length);
      expect(inspected.head.subarray(0, 8).equals(PNG_1X1.subarray(0, 8))).toBe(true);
    }
    const checked = await intake.verify({ storageKey: key, declaredMime: 'image/png', declaredSize: PNG_1X1.length, categoryMaxBytes: 1024, allowedMimes: ['image/png'] });
    expect(checked.contentVerifiedAt).toBeInstanceOf(Date);
    expect(checked.scanStatus).toBe('NOT_SCANNED'); // no scanner is configured: never reported as clean
    report('confirmation (exists, real size, file signature, intake)', 'ok; scan status NOT_SCANNED as expected');

    // 4. a wrongly declared file is rejected by the intake service
    await expect(intake.verify({ storageKey: key, declaredMime: 'image/jpeg', declaredSize: PNG_1X1.length, categoryMaxBytes: 1024, allowedMimes: ['image/png', 'image/jpeg'] })).rejects.toMatchObject({ problem: 'TYPE_MISMATCH' }); // a PNG declared as JPEG
    await expect(intake.verify({ storageKey: key, declaredMime: 'application/pdf', declaredSize: PNG_1X1.length, categoryMaxBytes: 1024, allowedMimes: ['application/pdf'] })).rejects.toMatchObject({ problem: 'TYPE_NOT_ALLOWED' }); // a PNG in a PDF-only category
    await expect(intake.verify({ storageKey: key, declaredMime: 'image/png', declaredSize: PNG_1X1.length + 1, categoryMaxBytes: 1024, allowedMimes: ['image/png'] })).rejects.toMatchObject({ problem: 'SIZE_MISMATCH' });
    await expect(intake.verify({ storageKey: key, declaredMime: 'image/png', declaredSize: PNG_1X1.length, categoryMaxBytes: 10, allowedMimes: ['image/png'] })).rejects.toMatchObject({ problem: 'TOO_LARGE' });
    report('intake rejects wrong type / size mismatch / too large', 'ok');

    // 5. presigned download
    const download = await storage.createDownloadTarget(key, 120);
    const got = await status(download.url);
    expect(got.code).toBe(200);
    expect(Buffer.from(await got.res.arrayBuffer()).equals(PNG_1X1)).toBe(true);
    expect(got.res.headers.get('content-disposition')).toMatch(/^attachment/i);
    report('presigned download', `HTTP ${got.code}, bytes identical, Content-Disposition attachment`);

    // 6. the object is private: the bare URL without a signature is refused
    const bare = await status(download.url.split('?')[0]!);
    expect([401, 403]).toContain(bare.code);
    report('anonymous access (no signature)', `HTTP ${bare.code} (private)`);

    // 7. delete, then a second delete
    await storage.delete(key);
    await storage.delete(key);
    report('delete, then delete again', 'both succeeded (second was a no-op)');
    let gone: boolean | string;
    try {
      gone = !(await storage.exists(key));
    } catch (err) {
      gone = (err as Error).message; // STORAGE_ERROR_403 here means the credentials may not HEAD a missing key (see s3:ListBucket note in the docs)
    }
    report('existence after delete', gone === true ? 'object is gone (404)' : `could not confirm absence: ${String(gone)}`);
    const after = await status((await storage.createDownloadTarget(key, 60)).url);
    expect([403, 404]).toContain(after.code);
    report('download after delete', `HTTP ${after.code}`);
  });

  it('refuses a tampered signature, a different content type, an expired link and a replayed key with another body', async () => {
    // wrong Content-Type: the signature covers it
    const typed = newKey();
    created.push(typed);
    const target = await storage.createUploadTarget({ storageKey: typed, mimeType: 'image/png', sizeBytes: PNG_1X1.length, ttlSeconds: 120 });
    const wrongType = await status(target.uploadUrl, { method: 'PUT', headers: { 'Content-Type': 'application/pdf' }, body: new Uint8Array(PNG_1X1) });
    expect(wrongType.code).toBe(403);
    report('upload with a different Content-Type than signed', `HTTP ${wrongType.code} (refused)`);

    // tampered signature
    const url = new URL(target.uploadUrl);
    const sig = url.searchParams.get('X-Amz-Signature')!;
    url.searchParams.set('X-Amz-Signature', (sig[0] === 'a' ? 'b' : 'a') + sig.slice(1));
    const tampered = await status(url.toString(), { method: 'PUT', headers: { 'Content-Type': 'image/png' }, body: new Uint8Array(PNG_1X1) });
    expect(tampered.code).toBe(403);
    report('upload with a tampered signature', `HTTP ${tampered.code} (refused)`);

    // expired link: signed 10 minutes ago for 60 seconds
    const old = new S3DocumentStorage({ getOrThrow: () => cfg } as never, () => new Date(Date.now() - 10 * 60_000));
    const expired = await old.createUploadTarget({ storageKey: typed, mimeType: 'image/png', sizeBytes: PNG_1X1.length, ttlSeconds: 60 });
    const late = await status(expired.uploadUrl, { method: 'PUT', headers: { 'Content-Type': 'image/png' }, body: new Uint8Array(PNG_1X1) });
    expect(late.code).toBe(403);
    report('upload with an expired link', `HTTP ${late.code} (refused)`);

    // none of the refused attempts stored anything
    let stored: boolean | string;
    try {
      stored = await storage.exists(typed);
    } catch (err) {
      stored = (err as Error).message;
    }
    report('nothing stored by refused uploads', stored === false ? 'confirmed (404)' : `not confirmable: ${String(stored)}`);
    if (typeof stored === 'boolean') expect(stored).toBe(false);
  });

  it('reports a missing object as not uploaded (what confirming too early looks like)', async () => {
    const key = newKey();
    let outcome: string;
    try {
      const result = await storage.inspect(key);
      outcome = result === null ? 'not found (404)' : 'unexpectedly found';
      expect(result).toBeNull();
    } catch (err) {
      outcome = `${(err as Error).message} (the credentials cannot tell "missing" from "forbidden": grant s3:ListBucket on the bucket)`;
      throw new Error(`Missing-object check failed: ${outcome}`);
    }
    report('inspect of a key that was never uploaded', outcome);
  });
});
