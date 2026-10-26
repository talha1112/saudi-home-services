import { applyDecorators, SetMetadata, UseGuards } from '@nestjs/common';
import { RateLimitGuard } from '../guards/rate-limit.guard.js';

export const RATE_LIMIT_KEY = 'auth:rate-limit';

export interface RateLimitOptions {
  /** Bucket name; routes sharing a name share the counter. */
  name: string;
  limit: number;
  windowSeconds: number;
}

/** Per-client-IP request limit, counted in Redis so it holds across API instances. */
export const RateLimit = (options: RateLimitOptions) =>
  applyDecorators(SetMetadata(RATE_LIMIT_KEY, options), UseGuards(RateLimitGuard));
