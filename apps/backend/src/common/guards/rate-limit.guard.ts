import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { KeyValueStore } from '../../database/key-value.store.js';
import type { RequestWithUser } from '../auth/authenticated-user.js';
import { RATE_LIMIT_KEY, type RateLimitOptions } from '../decorators/rate-limit.decorator.js';
import { tooManyRequests } from '../errors/api-error.js';

@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly store: KeyValueStore,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const options = this.reflector.getAllAndOverride<RateLimitOptions | undefined>(RATE_LIMIT_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!options) return true;

    const ip = context.switchToHttp().getRequest<RequestWithUser>().ip ?? 'unknown';
    const key = `rl:${options.name}:${ip}`;
    const count = await this.store.increment(key, options.windowSeconds);
    if (count > options.limit) {
      const retry = await this.store.ttl(key);
      throw tooManyRequests(
        'RATE_LIMITED',
        'Too many requests, please try again later',
        retry > 0 ? retry : options.windowSeconds,
      );
    }
    return true;
  }
}
