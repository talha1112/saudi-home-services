import { jest } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { validateEnv } from '../../config/env.validation.js';
import { testConfigService } from '../../testing/test-support.js';
import { LocalDocumentStorage, LocalStorageError, STORAGE_KEY_RE } from './adapters/local-document-storage.js';
import { S3DocumentStorage } from './adapters/s3-document-storage.js';
import { signLocalUrl, verifyLocalUrl } from './adapters/signed-url.js';
import { DisabledFileScanner, MOCK_INFECTED_MARKER, MockFileScanner } from './file-scanner.js';
import { checkContent, detectMime } from './file-signature.js';
import { deletionBackoffMs } from './storage-deletion.service.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 1]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([1, 0, 0, 0]), Buffer.from('WEBPVP8 ')]);
const PDF = Buffer.from('%PDF-1.7\n%...');

describe('file signature detection', () => {
  it('recognises the accepted formats by content', () => {
    expect(detectMime(PNG)).toBe('image/png');
    expect(detectMime(JPG)).toBe('image/jpeg');
    expect(detectMime(WEBP)).toBe('image/webp');
    expect(detectMime(PDF)).toBe('application/pdf');
  });

  it('refuses everything else, including things that merely look similar', () => {
    for (const bad of [Buffer.alloc(0), Buffer.from('MZ\x90\x00'), Buffer.from('<?php echo 1;'), Buffer.from('<svg xmlns='), Buffer.from('GIF89a'), Buffer.from('PK\x03\x04'), Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.from('RIFF....WAVE'), Buffer.from('%PDF')]) {
      expect(detectMime(bad)).toBeNull();
    }
  });

  it('checks size, type and declaration together', () => {
    const base = { declaredMime: 'image/png', declaredSize: 11, actualSize: 11, head: PNG, maxBytes: 100, allowed: ['image/png', 'image/jpeg'] };
    expect(checkContent(base)).toBeNull();
    expect(checkContent({ ...base, actualSize: 0, declaredSize: 0 })).toBe('MISSING_SIZE');
    expect(checkContent({ ...base, actualSize: 101, declaredSize: 101 })).toBe('TOO_LARGE');
    expect(checkContent({ ...base, actualSize: 12 })).toBe('SIZE_MISMATCH');
    expect(checkContent({ ...base, head: Buffer.from('MZ..') })).toBe('UNKNOWN_TYPE');
    expect(checkContent({ ...base, head: PDF })).toBe('TYPE_NOT_ALLOWED');
    expect(checkContent({ ...base, head: JPG })).toBe('TYPE_MISMATCH');
    expect(checkContent({ ...base, declaredMime: 'image/jpeg' })).toBe('TYPE_MISMATCH');
  });
});

describe('scanners', () => {
  it('the default scanner never claims a file is clean', async () => {
    expect(await new DisabledFileScanner().scan()).toBe('NOT_SCANNED');
  });
  it('the mock scanner flags only its marker', async () => {
    const scan = (head: Buffer) => new MockFileScanner().scan({ storageKey: 'k', head, sizeBytes: head.length });
    expect(await scan(Buffer.concat([JPG, Buffer.from(MOCK_INFECTED_MARKER)]))).toBe('INFECTED');
    expect(await scan(JPG)).toBe('CLEAN');
  });
});

describe('signed local URLs', () => {
  const secret = 'x'.repeat(40);
  const parts = { op: 'put' as const, key: 'k', exp: Math.floor(Date.now() / 1000) + 60, size: 10, type: 'image/png' };

  it('verifies only the exact parts, in constant time, and only before expiry', () => {
    const sig = signLocalUrl(secret, parts);
    expect(verifyLocalUrl(secret, parts, sig)).toBe(true);
    for (const changed of [{ op: 'get' as const }, { key: 'other' }, { size: 11 }, { type: 'image/jpeg' }, { exp: parts.exp + 1 }]) {
      expect(verifyLocalUrl(secret, { ...parts, ...changed }, sig)).toBe(false);
    }
    expect(verifyLocalUrl('y'.repeat(40), parts, sig)).toBe(false);
    expect(verifyLocalUrl(secret, parts, sig.slice(2))).toBe(false);
    expect(verifyLocalUrl(secret, parts, 'zz')).toBe(false);
    expect(verifyLocalUrl(secret, parts, sig, (parts.exp + 1) * 1000)).toBe(false);
  });
});

describe('LocalDocumentStorage', () => {
  let dir: string;
  let storage: LocalDocumentStorage;
  const key = () => `bookings/${randomUUID()}/photos/${randomUUID()}`;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hs-unit-storage-'));
    const base = testConfigService().getOrThrow('x') as { storage: object };
    storage = new LocalDocumentStorage({ getOrThrow: () => ({ ...base, storage: { ...base.storage, localDir: dir } }) } as never);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('accepts only keys of the generated shape and rejects traversal and look-alikes', () => {
    expect(STORAGE_KEY_RE.test(key())).toBe(true);
    for (const bad of ['', '../a', 'bookings/../../x', `bookings/${randomUUID()}/photos/${randomUUID()}/extra`, `bookings/${randomUUID()}/photos/../${randomUUID()}`, `other/${randomUUID()}/photos/${randomUUID()}`, `bookings/${randomUUID()}/photos/${randomUUID()}.png`, `bookings\\${randomUUID()}\\photos\\${randomUUID()}`]) {
      expect(() => storage.pathFor(bad)).toThrow(LocalStorageError);
    }
  });

  it('stores exactly the declared bytes, never overwrites, and removes idempotently', async () => {
    const k = key();
    await storage.store(k, Readable.from([PNG]), PNG.length);
    expect(readFileSync(storage.pathFor(k)).equals(PNG)).toBe(true);
    await expect(storage.store(k, Readable.from([JPG]), JPG.length)).rejects.toMatchObject({ code: 'EXISTS' });
    expect(readFileSync(storage.pathFor(k)).equals(PNG)).toBe(true);
    expect(await storage.inspect(k)).toMatchObject({ sizeBytes: PNG.length });

    await expect(storage.store(key(), Readable.from([PNG]), PNG.length - 1)).rejects.toMatchObject({ code: 'TOO_LARGE' });
    await expect(storage.store(key(), Readable.from([PNG]), PNG.length + 1)).rejects.toMatchObject({ code: 'SIZE_MISMATCH' });

    await storage.delete(k);
    await storage.delete(k);
    expect(await storage.exists(k)).toBe(false);
    expect(await storage.inspect(k)).toBeNull();
  });

  it('leaves no partial file behind when an upload fails', async () => {
    const k = key();
    await expect(storage.store(k, Readable.from([PNG]), 3)).rejects.toBeDefined();
    expect(await storage.exists(k)).toBe(false);
  });
});

describe('S3DocumentStorage', () => {
  const key = 'workers/6f1c2f0e-6d4a-4a39-9d1e-0f6b1a9a0001/documents/6f1c2f0e-6d4a-4a39-9d1e-0f6b1a9a0002';
  const make = (over: object = {}) => {
    const base = testConfigService().getOrThrow('x') as { storage: object };
    const s3 = { region: 'me-south-1', bucket: 'private-bucket', accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret-key-secret-key', forcePathStyle: false, ...over };
    return new S3DocumentStorage({ getOrThrow: () => ({ ...base, storage: { ...base.storage, s3 } }) } as never, () => new Date('2026-11-01T10:00:00.000Z'));
  };

  it('builds virtual-host and path-style URLs for a private bucket, with short expiry', async () => {
    const a = await make().createDownloadTarget(key, 300);
    const u = new URL(a.url);
    expect(u.host).toBe('private-bucket.s3.me-south-1.amazonaws.com');
    expect(u.pathname).toBe(`/${key}`);
    expect(u.searchParams.get('X-Amz-Expires')).toBe('300');
    expect(u.searchParams.get('response-content-disposition')).toBe('attachment');
    expect(a.expiresAt.toISOString()).toBe('2026-11-01T10:05:00.000Z');

    const b = new URL((await make({ endpoint: 'https://minio.internal:9000', forcePathStyle: true }).createDownloadTarget(key, 60)).url);
    expect(b.origin).toBe('https://minio.internal:9000');
    expect(b.pathname).toBe(`/private-bucket/${key}`);
  });

  it('signs the content type and length into upload URLs and asks the client to send them', async () => {
    const t = await make().createUploadTarget({ storageKey: key, mimeType: 'application/pdf', sizeBytes: 1234, ttlSeconds: 300 });
    expect(t.method).toBe('PUT');
    expect(t.headers).toEqual({ 'Content-Type': 'application/pdf', 'Content-Length': '1234' });
    expect(new URL(t.uploadUrl).searchParams.get('X-Amz-SignedHeaders')).toBe('content-length;content-type;host');
  });

  it('refuses keys it did not generate', async () => {
    await expect(make().createDownloadTarget('../../x', 60)).rejects.toThrow('INVALID_STORAGE_KEY');
  });

  describe('talking to the provider', () => {
    let fetchSpy: ReturnType<typeof jest.spyOn>;
    afterEach(() => fetchSpy?.mockRestore());
    const reply = (status: number, body: string | Buffer = '', headers: Record<string, string> = {}) => new Response(body.length ? new Uint8Array(Buffer.from(body)) : null, { status, headers });

    it('signs every request, never sends the secret, and maps results', async () => {
      const calls: Array<{ url: string; init: RequestInit }> = [];
      fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation((async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        const method = init.method;
        if (method === 'HEAD') return reply(200, '', { 'content-length': '11' });
        if (method === 'GET') return reply(206, PNG);
        return reply(204);
      }) as never);
      const s3 = make();
      expect(await s3.exists(key)).toBe(true);
      const info = await s3.inspect(key);
      expect(info?.sizeBytes).toBe(11);
      expect(info?.head.subarray(0, 4).equals(PNG.subarray(0, 4))).toBe(true);
      await s3.delete(key);
      for (const c of calls) {
        const headers = c.init.headers as Record<string, string>;
        expect(headers['Authorization']).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20261101\/me-south-1\/s3\/aws4_request/);
        expect(JSON.stringify(c)).not.toContain('secret-key-secret-key');
      }
      expect((calls.find((c) => c.init.method === 'GET')!.init.headers as Record<string, string>)['range']).toBe('bytes=0-127');
    });

    it('treats a missing object as absent / already deleted, and anything else as an error', async () => {
      fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(reply(404));
      const s3 = make();
      expect(await s3.exists(key)).toBe(false);
      expect(await s3.inspect(key)).toBeNull();
      await expect(s3.delete(key)).resolves.toBeUndefined();

      fetchSpy.mockResolvedValue(reply(500));
      await expect(s3.exists(key)).rejects.toThrow('STORAGE_ERROR_500');
      await expect(s3.delete(key)).rejects.toThrow('STORAGE_ERROR_500');
      fetchSpy.mockRejectedValue(new Error('connect ECONNREFUSED https://secret-host/with-signed-url?X-Amz-Signature=abc'));
      const err = await s3.delete(key).catch((e: Error) => e);
      expect((err as Error).message).toBe('STORAGE_UNREACHABLE'); // the raw network error (which could carry a URL) is not propagated
    });
  });
});

describe('storage configuration', () => {
  const base = { DATABASE_URL: 'postgresql://u:p@localhost:5432/db', REDIS_URL: 'redis://127.0.0.1:6379', JWT_ACCESS_SECRET: 'a'.repeat(40), OTP_HMAC_SECRET: 'b'.repeat(40) };
  const prod = { ...base, NODE_ENV: 'production', TRUST_PROXY_HOPS: '1' };

  it('refuses development-only providers in production and defaults to disabled', () => {
    for (const bad of [{ DOCUMENT_STORAGE: 'dev' }, { DOCUMENT_STORAGE: 'local', STORAGE_SIGNING_SECRET: 'c'.repeat(40) }, { FILE_SCANNER: 'mock' }, { PUSH_PROVIDER: 'mock' }]) {
      expect(() => validateEnv({ ...prod, ...bad })).toThrow('not allowed in production');
    }
    expect(() => validateEnv({ ...prod })).not.toThrow();
    expect(() => validateEnv({ ...base, NODE_ENV: 'development', DOCUMENT_STORAGE: 'local', STORAGE_SIGNING_SECRET: 'c'.repeat(40), FILE_SCANNER: 'mock', PUSH_PROVIDER: 'mock' })).not.toThrow();
  });

  it('validates what each provider needs, without echoing secret values', () => {
    expect(() => validateEnv({ ...base, DOCUMENT_STORAGE: 'local' })).toThrow('STORAGE_SIGNING_SECRET');
    expect(() => validateEnv({ ...base, DOCUMENT_STORAGE: 'local', STORAGE_SIGNING_SECRET: 'short' })).toThrow('STORAGE_SIGNING_SECRET');
    expect(() => validateEnv({ ...base, DOCUMENT_STORAGE: 's3' })).toThrow('S3_REGION, S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY');
    const s3 = { ...base, DOCUMENT_STORAGE: 's3', S3_REGION: 'r', S3_BUCKET: 'b', S3_ACCESS_KEY_ID: 'AKID', S3_SECRET_ACCESS_KEY: 'TOPSECRETVALUE' };
    expect(() => validateEnv(s3)).not.toThrow();
    expect(() => validateEnv({ ...prod, ...s3, STORAGE_ALLOW_UNSCANNED_FILES: 'true', S3_ENDPOINT: 'http://insecure.example' })).toThrow('https');
    try {
      validateEnv({ ...base, DOCUMENT_STORAGE: 's3', S3_SECRET_ACCESS_KEY: 'TOPSECRETVALUE' });
    } catch (e) {
      expect((e as Error).message).not.toContain('TOPSECRETVALUE');
    }
  });

  it('requires a scanner for clean-only downloads and a 32-byte device-token key', () => {
    expect(() => validateEnv({ ...base, STORAGE_REQUIRE_CLEAN_SCAN: 'true' })).toThrow('scanner');
    expect(() => validateEnv({ ...base, STORAGE_REQUIRE_CLEAN_SCAN: 'true', FILE_SCANNER: 'mock' })).not.toThrow();
    expect(() => validateEnv({ ...base, DEVICE_TOKEN_ENCRYPTION_KEY: Buffer.alloc(16).toString('base64') })).toThrow('32 bytes');
    expect(() => validateEnv({ ...base, DEVICE_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32).toString('base64') })).not.toThrow();
  });
});

describe('removal backoff', () => {
  it('grows from 5 seconds, is capped at 15 minutes, and jitters by at most 20 percent', () => {
    const mid = () => 0.5;
    expect([1, 2, 3, 4].map((n) => deletionBackoffMs(n, mid))).toEqual([5000, 10000, 20000, 40000]);
    expect(deletionBackoffMs(40, mid)).toBe(900_000);
    expect(deletionBackoffMs(2, () => 0)).toBe(8000);
    expect(deletionBackoffMs(2, () => 1)).toBe(12000);
  });
});
