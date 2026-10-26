import { jest } from '@jest/globals';
import { Logger } from '@nestjs/common';
import { Readable } from 'node:stream';
import { resolveUrlTtls } from '../../config/app.config.js';
import { validateEnv } from '../../config/env.validation.js';
import { testConfigService } from '../../testing/test-support.js';
import { S3DocumentStorage } from './adapters/s3-document-storage.js';
import { isServable, unavailableReason } from './file-access.js';
import { FileIntakeService } from './file-intake.service.js';
import { scanBackoffMs, scanErrorCode } from './file-scan.service.js';
import { DisabledFileScanner, MOCK_INFECTED_MARKER, MockAsyncFileScanner, MockFileScanner } from './file-scanner.js';
import type { DocumentStorage } from '../workers/storage/document-storage.js';

const KEY = 'bookings/6f1c2f0e-6d4a-4a39-9d1e-0f6b1a9a0001/photos/6f1c2f0e-6d4a-4a39-9d1e-0f6b1a9a0002';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

describe('file access rule', () => {
  it('serves only CLEAN files, and NOT_SCANNED ones only while clean scans are not required', () => {
    expect(isServable('CLEAN', true)).toBe(true);
    expect(isServable('CLEAN', false)).toBe(true);
    expect(isServable('NOT_SCANNED', false)).toBe(true);
    expect(isServable('NOT_SCANNED', true)).toBe(false);
  });

  it('never serves a pending, failed or infected file, whatever the setting', () => {
    for (const status of ['PENDING', 'ERROR', 'INFECTED'] as const) {
      expect(isServable(status, true)).toBe(false);
      expect(isServable(status, false)).toBe(false);
    }
  });

  it('explains an unavailable file with a safe reason that names no scanner', () => {
    expect(unavailableReason('PENDING')).toBe('SCAN_PENDING');
    expect(unavailableReason('ERROR')).toBe('SCAN_FAILED');
    expect(unavailableReason('INFECTED')).toBe('REJECTED');
    expect(unavailableReason('NOT_SCANNED')).toBe('NOT_SCANNED');
  });
});

describe('scan retry helpers', () => {
  it('backs off exponentially from 10 seconds up to 10 minutes, with bounded jitter', () => {
    const mid = () => 0.5;
    expect(scanBackoffMs(1, mid)).toBe(10_000);
    expect(scanBackoffMs(2, mid)).toBe(20_000);
    expect(scanBackoffMs(3, mid)).toBe(40_000);
    expect(scanBackoffMs(20, mid)).toBe(600_000);
    expect(scanBackoffMs(1, () => 0)).toBe(8_000);
    expect(scanBackoffMs(1, () => 1)).toBe(12_000);
  });

  it('reduces whatever a scanner throws to a short code without its message', () => {
    expect(scanErrorCode(new Error('SCANNER_DOWN'))).toBe('SCANNER_DOWN');
    expect(scanErrorCode(new Error('connect ECONNREFUSED https://scan.internal/x?token=abc'))).toBe('SCANNER_ERROR');
    expect(scanErrorCode(new TypeError('boom /secret/path'))).toBe('SCANNER_TYPEERROR');
    expect(scanErrorCode('not even an error')).toBe('SCANNER_ERROR');
    expect(scanErrorCode(new Error('x'.repeat(500))).length).toBeLessThanOrEqual(60);
  });
});

describe('scanners', () => {
  it('the disabled scanner never says clean and is not deferred', async () => {
    const s = new DisabledFileScanner();
    expect(await s.scan()).toBe('NOT_SCANNED');
    expect(s.deferred).toBe(false);
  });

  it('the inline test double looks at the first bytes only; the async double reads the whole object, across chunk boundaries', async () => {
    const body = Buffer.concat([PNG, Buffer.alloc(500, 1), Buffer.from(MOCK_INFECTED_MARKER), Buffer.alloc(50, 1)]);
    expect(await new MockFileScanner().scan({ storageKey: KEY, head: body.subarray(0, 128), sizeBytes: body.length })).toBe('CLEAN'); // the marker is beyond the first 128 bytes
    const scanner = new MockAsyncFileScanner();
    expect(scanner.deferred).toBe(true);
    const split = 500 + PNG.length + 10; // the marker straddles two chunks
    const open = async () => Readable.from([body.subarray(0, split), body.subarray(split)]);
    expect(await scanner.scan({ storageKey: KEY, head: body.subarray(0, 128), sizeBytes: body.length, open })).toBe('INFECTED');
    expect(await scanner.scan({ storageKey: KEY, head: PNG, sizeBytes: PNG.length, open: async () => Readable.from([PNG]) })).toBe('CLEAN');
    expect(await scanner.scan({ storageKey: KEY, head: PNG, sizeBytes: PNG.length })).toBe('ERROR'); // cannot read the object: never clean
  });

  it('a stream that breaks off propagates as a failure, not a verdict', async () => {
    const broken = new Readable({
      read() {
        this.destroy(new Error('STORAGE_UNREACHABLE'));
      },
    });
    await expect(new MockAsyncFileScanner().scan({ storageKey: KEY, head: PNG, sizeBytes: 11, open: async () => broken })).rejects.toThrow('STORAGE_UNREACHABLE');
  });
});

describe('file intake with a deferred scanner', () => {
  it('queues instead of scanning: the file comes back PENDING and the scanner is not asked', async () => {
    const config = { getOrThrow: () => ({ storage: { maxFileBytes: 1000 } }) } as never;
    const scanner = new MockAsyncFileScanner();
    const spy = jest.spyOn(scanner, 'scan');
    const storage = { inspect: async () => ({ sizeBytes: 11, head: PNG }), exists: async () => true } as unknown as DocumentStorage;
    const out = await new FileIntakeService(config, storage, scanner).verify({ storageKey: KEY, declaredMime: 'image/png', declaredSize: 11, categoryMaxBytes: 500, allowedMimes: ['image/png'] });
    expect(out.scanStatus).toBe('PENDING');
    expect(out.contentVerifiedAt).toBeInstanceOf(Date);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('S3 reads for scanning and size checks', () => {
  const make = () => {
    const base = testConfigService().getOrThrow('x') as { storage: object };
    const s3 = { region: 'ap-southeast-2', bucket: 'private-bucket', accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret-key-secret-key-1234567890', forcePathStyle: false };
    return new S3DocumentStorage({ getOrThrow: () => ({ ...base, storage: { ...base.storage, s3 } }) } as never, () => new Date('2026-11-01T10:00:00.000Z'));
  };
  let fetchSpy: ReturnType<typeof jest.spyOn>;
  let warn: ReturnType<typeof jest.spyOn>;
  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    fetchSpy?.mockRestore();
    warn.mockRestore();
  });
  const reply = (status: number, body: Buffer | string = '', headers: Record<string, string> = {}) => new Response(body.length ? new Uint8Array(Buffer.from(body)) : null, { status, headers });

  it('streams the whole object with a signed, unranged GET and the long read limit', async () => {
    const calls: Array<{ method: string; headers: Record<string, string> }> = [];
    fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation((async (_u: string, init: RequestInit) => {
      calls.push({ method: String(init.method), headers: init.headers as Record<string, string> });
      return reply(200, PNG);
    }) as never);
    const stream = await make().openReadStream(KEY);
    const chunks: Buffer[] = [];
    for await (const c of stream) chunks.push(c as Buffer);
    expect(Buffer.concat(chunks).equals(PNG)).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('GET');
    expect(calls[0]!.headers['range']).toBeUndefined();
    expect(calls[0]!.headers['Authorization']).toMatch(/^AWS4-HMAC-SHA256 /);
  });

  it('reports a missing object and provider failures with codes, never a URL', async () => {
    fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(reply(404));
    await expect(make().openReadStream(KEY)).rejects.toThrow('STORAGE_OBJECT_MISSING');
    fetchSpy.mockResolvedValue(reply(403));
    await expect(make().openReadStream(KEY)).rejects.toThrow('STORAGE_ERROR_403');
  });

  it('a stream cut off in the middle surfaces as an error to the reader', async () => {
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(PNG));
        controller.error(new Error('terminated'));
      },
    });
    fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(body, { status: 200 }));
    const stream = await make().openReadStream(KEY);
    await expect(
      (async () => {
        for await (const _chunk of stream) void _chunk;
      })(),
    ).rejects.toThrow();
  });

  it('checks a huge object by size and its first 128 bytes only: it is never downloaded in full to be judged', async () => {
    const calls: Array<{ method: string; range?: string }> = [];
    fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation((async (_u: string, init: RequestInit) => {
      const headers = init.headers as Record<string, string>;
      calls.push({ method: String(init.method), range: headers['range'] });
      return init.method === 'HEAD' ? reply(200, '', { 'content-length': String(50 * 1024 * 1024) }) : reply(206, PNG);
    }) as never);
    const info = await make().inspect(KEY);
    expect(info?.sizeBytes).toBe(50 * 1024 * 1024); // the intake then rejects it as TOO_LARGE
    expect(calls).toEqual([{ method: 'HEAD', range: undefined }, { method: 'GET', range: 'bytes=0-127' }]);
  });
});

describe('link lifetime settings', () => {
  const base = { DATABASE_URL: 'postgresql://u:p@localhost:5432/db', REDIS_URL: 'redis://127.0.0.1:6379', JWT_ACCESS_SECRET: 'a'.repeat(40), OTP_HMAC_SECRET: 'b'.repeat(40) };
  const ttl = (over: Record<string, unknown> = {}) => resolveUrlTtls(validateEnv({ ...base, ...over }));

  it('defaults: uploads and photo views keep the legacy 15 minutes, identity documents get 5 minutes', () => {
    expect(ttl()).toEqual({ upload: 900, bookingPhotoView: 900, identityDocumentView: 300 });
  });

  it('the legacy DOCUMENT_URL_TTL_SECONDS still sets uploads and photo views; identity documents never exceed 300 unless set explicitly, and a stricter legacy value wins', () => {
    expect(ttl({ DOCUMENT_URL_TTL_SECONDS: '1800' })).toEqual({ upload: 1800, bookingPhotoView: 1800, identityDocumentView: 300 });
    expect(ttl({ DOCUMENT_URL_TTL_SECONDS: '120' })).toEqual({ upload: 120, bookingPhotoView: 120, identityDocumentView: 120 });
  });

  it('a specific setting beats the legacy one, independently per purpose', () => {
    expect(ttl({ DOCUMENT_URL_TTL_SECONDS: '900', STORAGE_UPLOAD_URL_TTL_SECONDS: '180', BOOKING_PHOTO_URL_TTL_SECONDS: '1200', IDENTITY_DOCUMENT_URL_TTL_SECONDS: '600' })).toEqual({ upload: 180, bookingPhotoView: 1200, identityDocumentView: 600 });
  });

  it('refuses links that could be (nearly) indefinite', () => {
    expect(() => validateEnv({ ...base, IDENTITY_DOCUMENT_URL_TTL_SECONDS: '901' })).toThrow('IDENTITY_DOCUMENT_URL_TTL_SECONDS');
    expect(() => validateEnv({ ...base, BOOKING_PHOTO_URL_TTL_SECONDS: '3601' })).toThrow('BOOKING_PHOTO_URL_TTL_SECONDS');
    expect(() => validateEnv({ ...base, STORAGE_UPLOAD_URL_TTL_SECONDS: '86400' })).toThrow('STORAGE_UPLOAD_URL_TTL_SECONDS');
    expect(() => validateEnv({ ...base, DOCUMENT_URL_TTL_SECONDS: '31536000' })).toThrow('DOCUMENT_URL_TTL_SECONDS');
    expect(() => validateEnv({ ...base, IDENTITY_DOCUMENT_URL_TTL_SECONDS: '-1' })).toThrow('IDENTITY_DOCUMENT_URL_TTL_SECONDS');
  });
});

describe('scan and cleanup settings', () => {
  const base = { DATABASE_URL: 'postgresql://u:p@localhost:5432/db', REDIS_URL: 'redis://127.0.0.1:6379', JWT_ACCESS_SECRET: 'a'.repeat(40), OTP_HMAC_SECRET: 'b'.repeat(40) };
  const prod = { ...base, NODE_ENV: 'production', TRUST_PROXY_HOPS: '1' };
  const s3 = { DOCUMENT_STORAGE: 's3', S3_REGION: 'r', S3_BUCKET: 'b', S3_ACCESS_KEY_ID: 'K', S3_SECRET_ACCESS_KEY: 'S' };

  it('applies safe defaults and bounds', () => {
    const env = validateEnv(base);
    expect([env.FILE_SCAN_MAX_ATTEMPTS, env.FILE_SCAN_LEASE_SECONDS, env.STORAGE_ABANDONED_UPLOAD_MIN_AGE_MINUTES]).toEqual([5, 300, 1440]);
    expect(() => validateEnv({ ...base, STORAGE_ABANDONED_UPLOAD_MIN_AGE_MINUTES: '119' })).toThrow('STORAGE_ABANDONED_UPLOAD_MIN_AGE_MINUTES'); // must outlive every upload link
    expect(() => validateEnv({ ...base, FILE_SCAN_MAX_ATTEMPTS: '0' })).toThrow('FILE_SCAN_MAX_ATTEMPTS');
    expect(() => validateEnv({ ...base, FILE_SCAN_LEASE_SECONDS: '5' })).toThrow('FILE_SCAN_LEASE_SECONDS');
  });

  it('production with S3 and no scanner refuses to start unless serving unscanned files is acknowledged', () => {
    expect(() => validateEnv({ ...prod, ...s3 })).toThrow('unscanned');
    expect(() => validateEnv({ ...prod, ...s3, STORAGE_ALLOW_UNSCANNED_FILES: 'true' })).not.toThrow();
    expect(() => validateEnv({ ...base, ...s3 })).not.toThrow(); // development is unaffected
  });

  it('refuses both test scanners in production', () => {
    expect(() => validateEnv({ ...prod, FILE_SCANNER: 'mock' })).toThrow('FILE_SCANNER=mock');
    expect(() => validateEnv({ ...prod, FILE_SCANNER: 'mock-async' })).toThrow('FILE_SCANNER=mock-async');
    expect(() => validateEnv({ ...base, FILE_SCANNER: 'mock-async', STORAGE_REQUIRE_CLEAN_SCAN: 'true' })).not.toThrow();
  });
});
