import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';
import { APP_CONFIG, type AppConfig } from '../config/app.config.js';
import { quitQuietly } from './quit-quietly.js';

/**
 * Redis for temporary data (one-time codes, rate limits, caches) and, later, job queues.
 * Never put data here that must survive a Redis flush: PostgreSQL is the source of truth.
 */
@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  readonly client: Redis;
  private lastError?: string;

  constructor(config: ConfigService) {
    const { redisUrl } = config.getOrThrow<AppConfig>(APP_CONFIG);
    this.client = new Redis(redisUrl, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      retryStrategy: (attempt) => Math.min(attempt * 200, 2000),
    });
    // Without a listener ioredis prints every reconnect failure; log a change only once.
    this.client.on('error', (err: Error) => {
      if (err.message !== this.lastError) {
        this.lastError = err.message;
        this.logger.warn(`Redis connection problem: ${err.message}`);
      }
    });
    this.client.on('ready', () => {
      this.lastError = undefined;
    });
  }

  /** Resolves with the server reply, or rejects if Redis is unreachable. */
  async ping(): Promise<string> {
    if (this.client.status === 'wait') await this.client.connect();
    return this.client.ping();
  }

  async onModuleDestroy(): Promise<void> {
    await quitQuietly(this.client);
  }
}
