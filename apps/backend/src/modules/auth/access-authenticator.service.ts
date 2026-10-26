import { Injectable } from '@nestjs/common';
import type { AuthenticatedUser } from '../../common/auth/authenticated-user.js';
import { forbidden, unauthorized } from '../../common/errors/api-error.js';
import { PrismaService } from '../../database/prisma.service.js';
import { type Role, UserStatus } from '../../generated/prisma/client.js';
import { SessionsService } from './sessions.service.js';
import { TokenService } from './tokens/token.service.js';

export interface AuthenticatedAccess {
  user: AuthenticatedUser;
  /** When the presented access token expires (epoch ms). */
  expiresAtMs: number;
}

/**
 * The one place that turns an access token into a live caller. The HTTP guard and the Socket.IO
 * gateway both use it, so a suspended account, a revoked session or a removed role is refused the
 * same way on every transport.
 */
@Injectable()
export class AccessAuthenticator {
  constructor(
    private readonly tokens: TokenService,
    private readonly sessions: SessionsService,
    private readonly prisma: PrismaService,
  ) {}

  async authenticate(token: string): Promise<AuthenticatedAccess> {
    const claims = await this.tokens.verifyAccessToken(token);
    const user = await this.revalidate(claims);
    return { user, expiresAtMs: claims.expiresAtMs ?? 0 };
  }

  /**
   * Re-checks an already-verified identity against the database (session still active, account
   * still ACTIVE, role still held). Long-lived connections call this before sensitive actions
   * instead of keeping the token around.
   */
  async revalidate(claims: { userId: string; sessionId: string; role: Role }): Promise<AuthenticatedUser> {
    if (!(await this.sessions.isActive(claims.sessionId, claims.userId))) {
      throw unauthorized('SESSION_REVOKED', 'This session has ended. Please sign in again');
    }

    const user = await this.prisma.user.findUnique({
      where: { id: claims.userId },
      include: { roles: true, workerProfile: { select: { verificationStatus: true } } },
    });
    if (!user) throw unauthorized('TOKEN_INVALID', 'The access token is invalid');
    if (user.status !== UserStatus.ACTIVE) {
      throw forbidden('ACCOUNT_NOT_ACTIVE', 'This account cannot access the service');
    }
    if (!user.roles.some((r) => r.role === claims.role)) {
      throw forbidden('INSUFFICIENT_ROLE', 'Your account type cannot perform this action');
    }

    return {
      id: user.id,
      sessionId: claims.sessionId,
      role: claims.role,
      roles: user.roles.map((r) => r.role),
      status: user.status,
      mustChangePassword: user.mustChangePassword,
      workerVerificationStatus: user.workerProfile?.verificationStatus,
    };
  }
}
