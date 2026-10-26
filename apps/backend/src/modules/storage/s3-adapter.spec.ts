import { jest } from '@jest/globals';
import { Logger } from '@nestjs/common';
import { ApiError } from '../../common/errors/api-error.js';
import { validateEnv } from '../../config/env.validation.js';
import { testConfigService } from '../../testing/test-support.js';
import { DocumentStorage } from '../workers/storage/document-storage.js';
import { S3DocumentStorage } from './adapters/s3-document-storage.js';
import { DisabledFileScanner, FileScanner } from './file-scanner.js';
import { FileIntakeService, FileRejectedError } from './file-intake.service.js';

const KEY = 'bookings/6f1c2f0e-6d4a-4a39-9d1e-0f6b1a9a0001/photos/6f1c2f0e-6d4a-4a39-9d1e-0f6b1a9a0002';
const SECRET = 'secret-key-secret-key-1234567890';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const NOW = new Date('2026-11-01T10:00:00.000Z');

const makeS3 = (clock: () => Date = () => NOW) => {
  const base = testConfigService().getOrThrow('x') as { storage: object };
  const s3 = { region: 'ap-southeast-2', bucket: 'private-bucket', accessKeyId: 'AKIDEXAMPLE', secretAccessKey: SECRET, forcePathStyle: false };
  return new S3DocumentStorage({ getOrThrow: () => ({ ...base, storage: { ...base.storage, s3 } }) } as never, clock);
};
const reply = (status: number, body: Buffer | string = '', headers: Record<string, string> = {}) => new Response(body.length ? new Uint8Array(Buffer.from(body)) : null, { status, headers });

describe('S3DocumentStorage: transient failures and error mapping', () => {
  let fetchSpy: ReturnType<typeof jest.spyOn>;
  let warn: ReturnType<typeof jest.spyOn>;
  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    fetchSpy?.mockRestore();
    warn.mockRestore();
  });

  it('retries throttling and server errors, then succeeds', async () => {
    fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValueOnce(reply(503)).mockResolvedValueOnce(reply(500)).mockResolvedValueOnce(reply(200, '', { 'content-length': '11' }));
    expect(await makeS3().exists(KEY)).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it('gives up after three attempts and reports the status', async () => {
    fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation((async () => reply(503)) as never);
    await expect(makeS3().exists(KEY)).rejects.toThrow('STORAGE_ERROR_503');
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it('retries a dropped connection and a timeout, and never puts the URL or the secret in the error or the log', async () => {
    fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(new Error(`connect ECONNRESET https://private-bucket.s3.ap-southeast-2.amazonaws.com/${KEY}?X-Amz-Signature=abc`))
      .mockRejectedValueOnce(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }))
      .mockResolvedValueOnce(reply(204));
    await expect(makeS3().delete(KEY)).resolves.toBeUndefined();
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    fetchSpy.mockRejectedValue(new Error(`boom ${KEY} X-Amz-Signature=abc`));
    const err = (await makeS3().delete(KEY).catch((e: Error) => e)) as Error;
    expect(err.message).toBe('STORAGE_UNREACHABLE');
    const logged = JSON.stringify(warn.mock.calls);
    for (const leaked of [KEY, 'X-Amz-Signature', SECRET, 'amazonaws.com']) expect(logged).not.toContain(leaked);
  });

  it('does not retry answers that a repeat cannot fix (denied, bad request, missing)', async () => {
    for (const status of [400, 403]) {
      fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation((async () => reply(status)) as never);
      await expect(makeS3().exists(KEY)).rejects.toThrow(`STORAGE_ERROR_${status}`);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      fetchSpy.mockRestore();
    }
    fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation((async () => reply(404)) as never);
    expect(await makeS3().exists(KEY)).toBe(false);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('deleting twice is safe: S3 answers 204 for a key that is already gone, and a 404 is accepted too', async () => {
    fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValueOnce(reply(204)).mockResolvedValueOnce(reply(204)).mockResolvedValueOnce(reply(404));
    const s3 = makeS3();
    await expect(s3.delete(KEY)).resolves.toBeUndefined();
    await expect(s3.delete(KEY)).resolves.toBeUndefined();
    await expect(s3.delete(KEY)).resolves.toBeUndefined();
  });

  it('refuses a malformed size from the provider and reports a body that breaks off', async () => {
    fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(reply(200, '', { 'content-length': 'abc' }));
    await expect(makeS3().inspect(KEY)).rejects.toThrow('STORAGE_BAD_RESPONSE');
    fetchSpy.mockRestore();
    const broken = {
      status: 206,
      ok: true,
      headers: new Headers(),
      body: null,
      arrayBuffer: async () => {
        throw new Error('terminated');
      },
    };
    fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValueOnce(reply(200, '', { 'content-length': '11' })).mockResolvedValueOnce(broken as never);
    await expect(makeS3().inspect(KEY)).rejects.toThrow('STORAGE_UNREACHABLE');
  });

  it('signs each retry afresh', async () => {
    const times = [NOW, new Date(NOW.getTime() + 1000), new Date(NOW.getTime() + 2000)];
    let i = 0;
    const dates: string[] = [];
    fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation((async (_u: string, init: RequestInit) => {
      dates.push((init.headers as Record<string, string>)['x-amz-date']!);
      return dates.length < 3 ? reply(503) : reply(200);
    }) as never);
    await makeS3(() => times[Math.min(i++, 2)]!).exists(KEY);
    expect(new Set(dates).size).toBe(3);
  });
});

describe('S3DocumentStorage: presigned URLs', () => {
  it('expires at the requested time and is signed for exactly the declared type and size', async () => {
    const t = await makeS3().createUploadTarget({ storageKey: KEY, mimeType: 'image/png', sizeBytes: 11, ttlSeconds: 300 });
    const u = new URL(t.uploadUrl);
    expect(u.searchParams.get('X-Amz-Expires')).toBe('300');
    expect(u.searchParams.get('X-Amz-Date')).toBe('20261101T100000Z');
    expect(t.expiresAt.toISOString()).toBe('2026-11-01T10:05:00.000Z');
    expect(u.searchParams.get('X-Amz-SignedHeaders')).toBe('content-length;content-type;host');
    // Changing the declared type or size changes the signature, so a URL for one file cannot be used for another.
    const other = await makeS3().createUploadTarget({ storageKey: KEY, mimeType: 'application/pdf', sizeBytes: 11, ttlSeconds: 300 });
    const bigger = await makeS3().createUploadTarget({ storageKey: KEY, mimeType: 'image/png', sizeBytes: 12, ttlSeconds: 300 });
    const sig = (url: string) => new URL(url).searchParams.get('X-Amz-Signature');
    expect(sig(other.uploadUrl)).not.toBe(sig(t.uploadUrl));
    expect(sig(bigger.uploadUrl)).not.toBe(sig(t.uploadUrl));
  });

  it('downloads are forced to an attachment and carry no credentials besides the signature', async () => {
    const d = await makeS3().createDownloadTarget(KEY, 120);
    const u = new URL(d.url);
    expect(u.searchParams.get('response-content-disposition')).toBe('attachment');
    expect(d.url).not.toContain(SECRET);
    expect(u.protocol).toBe('https:');
  });
});

describe('S3 settings accept AWS variable names', () => {
  const base = { DATABASE_URL: 'postgresql://u:p@localhost:5432/db', REDIS_URL: 'redis://127.0.0.1:6379', JWT_ACCESS_SECRET: 'a'.repeat(40), OTP_HMAC_SECRET: 'b'.repeat(40), DOCUMENT_STORAGE: 's3' };

  it('uses AWS_REGION, AWS_S3_BUCKET, AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY when the S3_* names are absent', () => {
    const env = validateEnv({ ...base, AWS_REGION: 'ap-southeast-2', AWS_S3_BUCKET: 'bucket-a', AWS_ACCESS_KEY_ID: 'AKIDA', AWS_SECRET_ACCESS_KEY: 'secret-a' });
    expect([env.S3_REGION, env.S3_BUCKET, env.S3_ACCESS_KEY_ID, env.S3_SECRET_ACCESS_KEY]).toEqual(['ap-southeast-2', 'bucket-a', 'AKIDA', 'secret-a']);
  });

  it('prefers the S3_* names, treats an empty one as unset, and still demands all four', () => {
    const env = validateEnv({ ...base, S3_BUCKET: 'bucket-s3', AWS_S3_BUCKET: 'bucket-aws', S3_REGION: '', AWS_REGION: 'ap-southeast-2', S3_ACCESS_KEY_ID: 'K', S3_SECRET_ACCESS_KEY: 'S' });
    expect([env.S3_BUCKET, env.S3_REGION]).toEqual(['bucket-s3', 'ap-southeast-2']);
    expect(() => validateEnv({ ...base, AWS_REGION: 'ap-southeast-2', AWS_S3_BUCKET: 'b' })).toThrow('S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY');
  });

  it('is inert unless s3 is selected: the safe default stays disabled', () => {
    const env = validateEnv({ ...base, DOCUMENT_STORAGE: undefined, AWS_REGION: 'ap-southeast-2', AWS_S3_BUCKET: 'b', AWS_ACCESS_KEY_ID: 'K', AWS_SECRET_ACCESS_KEY: 'S' });
    expect(env.DOCUMENT_STORAGE ?? 'disabled').toBe('disabled');
  });
});

describe('FileIntakeService against object-storage outcomes', () => {
  const config = { getOrThrow: () => ({ storage: { maxFileBytes: 1000 } }) } as never;
  const intakeInput = { storageKey: KEY, declaredMime: 'image/png', declaredSize: 11, categoryMaxBytes: 500, allowedMimes: ['image/png', 'image/jpeg'] };
  const intakeWith = (inspect: () => Promise<unknown>, scanner: FileScanner = new DisabledFileScanner()) =>
    new FileIntakeService(config, { inspect, exists: async () => true } as unknown as DocumentStorage, scanner);
  let error: ReturnType<typeof jest.spyOn>;
  beforeEach(() => {
    error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => error.mockRestore());

  it('accepts a real image of the declared size and never calls it scanned without a scanner', async () => {
    const out = await intakeWith(async () => ({ sizeBytes: 11, head: PNG })).verify(intakeInput);
    expect(out.scanStatus).toBe('NOT_SCANNED');
    expect(out.contentVerifiedAt).toBeInstanceOf(Date);
  });

  it('answers "not uploaded yet" for a missing object', async () => {
    await expect(intakeWith(async () => null).verify(intakeInput)).rejects.toMatchObject({ status: 409, code: 'UPLOAD_NOT_FOUND' });
  });

  it('rejects an oversized object, a size that differs from the declaration, and content that is not the declared type', async () => {
    const problem = async (inspection: { sizeBytes: number; head: Buffer }, input = intakeInput) => (await intakeWith(async () => inspection).verify(input).catch((e: unknown) => e)) as FileRejectedError;
    expect((await problem({ sizeBytes: 501, head: PNG }, { ...intakeInput, declaredSize: 501 })).problem).toBe('TOO_LARGE');
    expect((await problem({ sizeBytes: 12, head: PNG })).problem).toBe('SIZE_MISMATCH');
    expect((await problem({ sizeBytes: 11, head: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 1, 2, 3, 4, 5, 6]) })).problem).toBe('TYPE_MISMATCH'); // a JPEG declared as PNG
    expect((await problem({ sizeBytes: 11, head: Buffer.from('%PDF-1.7\n....') })).problem).toBe('TYPE_NOT_ALLOWED'); // a real PDF in an images-only category
    expect((await problem({ sizeBytes: 11, head: Buffer.from('<?php echo 1;') })).problem).toBeDefined();
  });

  it('turns a failing or unreachable object store into a retryable 503, not a rejection and not a 500', async () => {
    for (const code of ['STORAGE_UNREACHABLE', 'STORAGE_ERROR_503', 'STORAGE_ERROR_403']) {
      const err = (await intakeWith(async () => {
        throw new Error(code);
      })
        .verify(intakeInput)
        .catch((e: unknown) => e)) as ApiError;
      expect(err).toBeInstanceOf(ApiError);
      expect(err).not.toBeInstanceOf(FileRejectedError);
      expect(err.getStatus()).toBe(503);
      expect(JSON.stringify(err.getResponse())).toContain('STORAGE_UNAVAILABLE');
    }
    expect(JSON.stringify(error.mock.calls)).toContain('STORAGE_ERROR_403'); // the operator sees the code
  });

  it('lets a deliberate API error (storage not configured) through unchanged', async () => {
    const configured = new ApiError(503, 'DOCUMENT_STORAGE_NOT_CONFIGURED', 'Document upload is temporarily unavailable');
    await expect(
      intakeWith(async () => {
        throw configured;
      }).verify(intakeInput),
    ).rejects.toBe(configured);
  });

  it('records a scanner failure as ERROR, never as clean', async () => {
    const broken: FileScanner = {
      scan: async () => {
        throw new Error('scanner down');
      },
    } as never;
    const out = await intakeWith(async () => ({ sizeBytes: 11, head: PNG }), broken).verify(intakeInput);
    expect(out.scanStatus).toBe('ERROR');
  });
});
