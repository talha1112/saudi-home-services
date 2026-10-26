import { validateEnv } from '../../../config/env.validation.js';
import { DevDocumentStorage } from './dev-document-storage.js';
import { DisabledDocumentStorage } from './disabled-document-storage.js';

describe('document storage adapters', () => {
  it('the disabled adapter fails closed with a controlled 503 for every operation that needs storage', async () => {
    const storage = new DisabledDocumentStorage();
    const calls = [
      () => storage.createUploadTarget(),
      () => storage.exists(),
      () => storage.createDownloadTarget(),
    ];
    for (const call of calls) {
      const err = (await call().catch((e: unknown) => e)) as { getStatus(): number; code: string };
      expect(err.getStatus()).toBe(503);
      expect(err.code).toBe('DOCUMENT_STORAGE_NOT_CONFIGURED');
    }
    await expect(storage.delete()).resolves.toBeUndefined(); // removing metadata must still work
  });

  it('the dev adapter hands out non-routable URLs and stores nothing', async () => {
    const storage = new DevDocumentStorage();
    const up = await storage.createUploadTarget({ storageKey: 'workers/a/documents/b', mimeType: 'image/png', ttlSeconds: 60 });
    expect(up.uploadUrl).toBe('https://dev-storage.invalid/upload/workers/a/documents/b');
    expect(up.method).toBe('PUT');
    expect(up.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(await storage.exists()).toBe(true);
  });
});

describe('document storage configuration', () => {
  const base = {
    DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
    REDIS_URL: 'redis://127.0.0.1:6379',
    JWT_ACCESS_SECRET: 'a'.repeat(40),
    OTP_HMAC_SECRET: 'b'.repeat(40),
  };

  it('refuses the dev storage in production', () => {
    expect(() => validateEnv({ ...base, NODE_ENV: 'production', TRUST_PROXY_HOPS: '1', DOCUMENT_STORAGE: 'dev' })).toThrow('DOCUMENT_STORAGE');
    expect(() => validateEnv({ ...base, NODE_ENV: 'production', TRUST_PROXY_HOPS: '1', DOCUMENT_STORAGE: 'disabled' })).not.toThrow();
    expect(() => validateEnv({ ...base, NODE_ENV: 'development', DOCUMENT_STORAGE: 'dev' })).not.toThrow();
  });

  it('requires an identity document by default and can be switched off', () => {
    expect(validateEnv({ ...base }).WORKER_REQUIRE_IDENTITY_DOCUMENT).toBe(true);
    expect(validateEnv({ ...base, WORKER_REQUIRE_IDENTITY_DOCUMENT: 'false' }).WORKER_REQUIRE_IDENTITY_DOCUMENT).toBe(false);
  });
});
