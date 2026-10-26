import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { RequestWithUser } from '../../../common/auth/authenticated-user.js';
import { ALLOW_PASSWORD_CHANGE_KEY } from '../../../common/decorators/allow-password-change.decorator.js';
import { IS_PUBLIC_KEY } from '../../../common/decorators/public.decorator.js';
import { forbidden, unauthorized } from '../../../common/errors/api-error.js';
import { AccessAuthenticator } from '../access-authenticator.service.js';

/**
 * Global guard: every route needs a valid access token unless marked @Public().
 *
 * Besides checking the signature it re-reads the account, so a suspended user, a
 * revoked session or a removed role stops working immediately instead of when
 * the 15-minute access token expires.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly authenticator: AccessAuthenticator,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets)) return true;

    const request = context.switchToHttp().getRequest<RequestWithUser>();
    const token = this.bearerToken(request);
    if (!token) throw unauthorized('AUTH_REQUIRED', 'Authentication is required');

    const { user: authenticated } = await this.authenticator.authenticate(token);
    if (authenticated.mustChangePassword && !this.reflector.getAllAndOverride<boolean>(ALLOW_PASSWORD_CHANGE_KEY, targets)) {
      throw forbidden('PASSWORD_CHANGE_REQUIRED', 'You must change your password before continuing');
    }

    request.user = authenticated;
    return true;
  }

  private bearerToken(request: RequestWithUser): string | null {
    const header = request.headers['authorization'];
    const value = Array.isArray(header) ? header[0] : header;
    const match = value?.match(/^Bearer\s+(\S+)$/i);
    return match?.[1] ?? null;
  }
}
