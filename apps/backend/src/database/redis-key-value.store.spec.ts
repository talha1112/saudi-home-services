import type { ApiError } from '../common/errors/api-error.js';
import { RedisKeyValueStore } from './redis-key-value.store.js';
import type { RedisService } from './redis.service.js';

const failing = () => {
  const boom = () => Promise.reject(new Error('connect ECONNREFUSED 127.0.0.1:6379'));
  const client = { get: boom, set: boom, getdel: boom, del: boom, ttl: boom, expire: boom, multi: () => ({ incr: () => ({ ttl: () => ({ exec: boom }) }) }) };
  return new RedisKeyValueStore({ client } as unknown as RedisService);
};

describe('RedisKeyValueStore when Redis is down', () => {
  const store = failing();
  const calls: [string, () => Promise<unknown>][] = [
    ['get', () => store.get('k')],
    ['set', () => store.set('k', 'v', 10)],
    ['setIfAbsent', () => store.setIfAbsent('k', 'v', 10)],
    ['take', () => store.take('k')],
    ['del', () => store.del('k')],
    ['increment', () => store.increment('k', 10)],
    ['ttl', () => store.ttl('k')],
  ];

  it.each(calls)('%s becomes a controlled 503 without leaking the cause', async (_name, call) => {
    const err = (await call().catch((e: unknown) => e)) as ApiError;
    expect(err.getStatus()).toBe(503);
    expect(err.code).toBe('SERVICE_UNAVAILABLE');
    expect(JSON.stringify(err.getResponse())).not.toMatch(/ECONN|127\.0\.0\.1|6379/);
  });
});
