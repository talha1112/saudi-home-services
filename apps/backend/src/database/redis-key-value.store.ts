import { Injectable, Logger } from '@nestjs/common';
import { ApiError } from '../common/errors/api-error.js';
import { KeyValueStore } from './key-value.store.js';
import { RedisService } from './redis.service.js';

/**
 * Redis-backed store (works with Redis and Redis-compatible servers such as Memurai).
 * Any Redis failure surfaces as a controlled 503 instead of an unhandled 500. Callers
 * fail closed: when the limiter or code store is down, sign-in is refused, not allowed.
 */
@Injectable()
export class RedisKeyValueStore extends KeyValueStore {
  private readonly logger = new Logger(RedisKeyValueStore.name);

  constructor(private readonly redis: RedisService) {
    super();
  }

  get(key: string): Promise<string | null> {
    return this.run(() => this.redis.client.get(key));
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    await this.run(() => this.redis.client.set(key, value, 'EX', ttlSeconds));
  }

  async setIfAbsent(key: string, value: string, ttlSeconds: number): Promise<boolean> {
    return (await this.run(() => this.redis.client.set(key, value, 'EX', ttlSeconds, 'NX'))) === 'OK';
  }

  /** GETDEL: atomic read-and-delete (Redis 6.2+, Memurai 4+), so a one-time value is consumed exactly once. */
  take(key: string): Promise<string | null> {
    return this.run(() => this.redis.client.getdel(key));
  }

  async del(...keys: string[]): Promise<void> {
    if (keys.length > 0) await this.run(() => this.redis.client.del(...keys));
  }

  async increment(key: string, ttlSeconds: number): Promise<number> {
    return this.run(async () => {
      const results = await this.redis.client.multi().incr(key).ttl(key).exec();
      const count = Number(results?.[0]?.[1]);
      const ttl = Number(results?.[1]?.[1]);
      // ttl -1 means the key has no expiry (e.g. a crash between INCR and EXPIRE): repair it.
      if (count === 1 || ttl === -1) await this.redis.client.expire(key, ttlSeconds);
      return count;
    });
  }

  /** Redis answers -2 for a missing key and -1 for no expiry; both mean "no countdown" here. */
  async ttl(key: string): Promise<number> {
    return Math.max(-1, await this.run(() => this.redis.client.ttl(key)));
  }

  /** SCAN (cursor based, never KEYS), bounded by `max`. */
  async scan(prefix: string, max: number): Promise<string[]> {
    return this.run(async () => {
      const found: string[] = [];
      let cursor = '0';
      do {
        const [next, keys] = await this.redis.client.scan(cursor, 'MATCH', `${escapeGlob(prefix)}*`, 'COUNT', 200);
        cursor = next;
        for (const k of keys) if (found.length < max) found.push(k);
      } while (cursor !== '0' && found.length < max);
      return found;
    });
  }

  private async run<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (err) {
      this.logger.error(`Redis operation failed: ${(err as Error).message}`);
      throw new ApiError(503, 'SERVICE_UNAVAILABLE', 'The service is temporarily unavailable. Please try again shortly');
    }
  }
}

function escapeGlob(value: string): string {
  return value.replace(/[\\*?[\]]/g, (ch) => `\\${ch}`);
}
