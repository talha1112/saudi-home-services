/**
 * REAL INFRASTRUCTURE TEST: talks to the Redis-compatible server in REDIS_URL (Memurai locally).
 * No in-memory doubles are used for the store.
 *
 * Isolation: everything runs in Redis logical database 15, never the one the API uses (0).
 * The suite refuses to start if database 15 already holds keys, and flushes only database 15.
 */
import { Redis } from 'ioredis';
import { ApiError } from '../src/common/errors/api-error.js';
import { RedisKeyValueStore } from '../src/database/redis-key-value.store.js';
import type { RedisService } from '../src/database/redis.service.js';
import { OtpService } from '../src/modules/auth/otp/otp.service.js';
import { CapturingSmsProvider, testConfigService } from '../src/testing/test-support.js';

const URL = process.env['REDIS_URL'] || 'redis://127.0.0.1:6379';
const TEST_DB = 15;
const PHONE = '+966500000123';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let client: Redis;
let store: RedisKeyValueStore;

function makeStore(redis: Redis) {
  return new RedisKeyValueStore({ client: redis } as unknown as RedisService);
}

function makeOtp(authOverrides: Parameters<typeof testConfigService>[0] = {}) {
  const sms = new CapturingSmsProvider();
  return { otp: new OtpService(testConfigService(authOverrides), store, sms), sms };
}

beforeAll(async () => {
  client = new Redis(URL, { db: TEST_DB, lazyConnect: true, maxRetriesPerRequest: 1, retryStrategy: () => null });
  client.on('error', () => undefined);
  await client.connect();
  if ((await client.dbsize()) > 0) {
    throw new Error(`Refusing to run: Redis database ${TEST_DB} is not empty. It is reserved for tests.`);
  }
  store = makeStore(client);
});

afterEach(async () => {
  await client.flushdb(); // database 15 only
});

afterAll(async () => {
  await client?.flushdb();
  client?.disconnect();
});

describe('real Redis / Memurai: server', () => {
  it('supports GETDEL (Redis 6.2+)', async () => {
    const info = await client.info('server');
    const version = /redis_version:(\S+)/.exec(info)?.[1] ?? '0.0';
    const [major, minor] = version.split('.').map(Number);
    expect(major > 6 || (major === 6 && minor >= 2)).toBe(true);
  });
});

describe('real Redis / Memurai: KeyValueStore primitives', () => {
  it('take() is an atomic read-and-delete', async () => {
    await store.set('itest:one', 'value', 30);
    expect(await store.take('itest:one')).toBe('value');
    expect(await store.take('itest:one')).toBeNull();
    expect(await store.get('itest:one')).toBeNull();
  });

  it('take() hands a one-time value to exactly one of many concurrent callers', async () => {
    await store.set('itest:race', 'secret', 30);
    const results = await Promise.all(Array.from({ length: 40 }, () => store.take('itest:race')));
    expect(results.filter((r) => r !== null)).toEqual(['secret']);
  });

  it('setIfAbsent() only sets the first time', async () => {
    expect(await store.setIfAbsent('itest:nx', 'a', 30)).toBe(true);
    expect(await store.setIfAbsent('itest:nx', 'b', 30)).toBe(false);
    expect(await store.get('itest:nx')).toBe('a');
  });

  it('increment() counts, sets an expiry once, and is exact under concurrency', async () => {
    const counts = await Promise.all(Array.from({ length: 25 }, () => store.increment('itest:counter', 30)));
    expect([...counts].sort((a, b) => a - b)).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
    const ttl = await store.ttl('itest:counter');
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(30);
  });

  it('values really expire', async () => {
    await store.set('itest:ttl', 'x', 1);
    expect(await store.get('itest:ttl')).toBe('x');
    await sleep(1300);
    expect(await store.get('itest:ttl')).toBeNull();
    expect(await store.ttl('itest:ttl')).toBe(-1);
  });
});

describe('real Redis / Memurai: OTP storage and one-time consumption', () => {
  it('stores only hashes, never the code or the phone number', async () => {
    const { otp, sms } = makeOtp();
    await otp.request(PHONE, '203.0.113.1');
    const code = sms.lastCode(PHONE);
    const keys = await client.keys('otp:*');
    expect(keys.length).toBeGreaterThan(0);
    const dump = JSON.stringify(await Promise.all(keys.map(async (k) => [k, await client.get(k)])));
    expect(dump).not.toContain(code);
    expect(dump).not.toContain(PHONE);
    expect(dump).not.toContain('203.0.113.1');
  });

  it('accepts the code once and rejects a replay', async () => {
    const { otp, sms } = makeOtp();
    await otp.request(PHONE, '203.0.113.1');
    const code = sms.lastCode(PHONE);
    await expect(otp.verify(PHONE, code, '203.0.113.1')).resolves.toBeUndefined();
    const replay = (await otp.verify(PHONE, code, '203.0.113.1').catch((e: unknown) => e)) as ApiError;
    expect(replay.code).toBe('OTP_EXPIRED');
    expect(await client.keys('otp:code:*')).toHaveLength(0);
  });

  it('lets exactly one of several simultaneous correct submissions succeed', async () => {
    const { otp, sms } = makeOtp();
    await otp.request(PHONE, '203.0.113.1');
    const code = sms.lastCode(PHONE);
    const outcomes = await Promise.allSettled(Array.from({ length: 12 }, () => otp.verify(PHONE, code, '203.0.113.1')));
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
  });

  it('rejects a code after its real TTL elapses', async () => {
    const { otp, sms } = makeOtp({ otp: { ttlSeconds: 1, maxAttempts: 5, resendCooldownSeconds: 60, maxSendsPerHour: 6, length: 6 } });
    await otp.request(PHONE, '203.0.113.1');
    const code = sms.lastCode(PHONE);
    await sleep(1400);
    const err = (await otp.verify(PHONE, code, '203.0.113.1').catch((e: unknown) => e)) as ApiError;
    expect(err.code).toBe('OTP_EXPIRED');
  });

  it('enforces the resend cooldown and the guess limit against the real store', async () => {
    const { otp, sms } = makeOtp();
    await otp.request(PHONE, '203.0.113.1');
    const cooldown = (await otp.request(PHONE, '203.0.113.1').catch((e: unknown) => e)) as ApiError;
    expect(cooldown.code).toBe('OTP_RESEND_COOLDOWN');

    const real = sms.lastCode(PHONE);
    const wrong = real === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++) {
      expect(((await otp.verify(PHONE, wrong, '198.51.100.9').catch((e: unknown) => e)) as ApiError).code).toBe('OTP_INVALID');
    }
    expect(((await otp.verify(PHONE, wrong, '198.51.100.9').catch((e: unknown) => e)) as ApiError).code).toBe('OTP_ATTEMPTS_EXCEEDED');
    // The genuine user is not locked out by the attacker.
    await expect(otp.verify(PHONE, real, '203.0.113.1')).resolves.toBeUndefined();
  });
});

describe('real Redis / Memurai: outage handling', () => {
  it('returns a controlled 503 (not an unhandled error) when Redis is unreachable', async () => {
    const dead = new Redis('redis://127.0.0.1:1', { lazyConnect: true, maxRetriesPerRequest: 1, retryStrategy: () => null });
    dead.on('error', () => undefined);
    const otp = new OtpService(testConfigService(), makeStore(dead), new CapturingSmsProvider());
    const err = (await otp.request(PHONE, '203.0.113.1').catch((e: unknown) => e)) as ApiError;
    expect(err.getStatus()).toBe(503);
    expect(err.code).toBe('SERVICE_UNAVAILABLE');
    expect(JSON.stringify(err.getResponse())).not.toMatch(/ECONN|127\.0\.0\.1/);
    dead.disconnect();
  });
});
