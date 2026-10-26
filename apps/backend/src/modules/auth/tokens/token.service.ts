import { createHash, randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { jwtVerify, SignJWT } from 'jose';
import { unauthorized } from '../../../common/errors/api-error.js';
import { APP_CONFIG, type AppConfig, type AuthConfig } from '../../../config/app.config.js';
import { Role } from '../../../generated/prisma/client.js';

const ISSUER = 'home-services-api';
const AUDIENCE = 'home-services';

export interface AccessClaims {
  userId: string;
  sessionId: string;
  role: Role;
  /** Set by verifyAccessToken: when the token expires (epoch ms). */
  expiresAtMs?: number;
}

/**
 * Access tokens are short-lived signed JWTs (HS256) carrying only identifiers.
 * Authorisation data (status, roles, worker approval) is always re-read from the
 * database, so suspending an account or revoking a session takes effect at once.
 *
 * Refresh tokens are opaque random strings. Only their SHA-256 hash is stored;
 * a high-entropy random token needs no slow hash.
 */
@Injectable()
export class TokenService {
  private readonly cfg: AuthConfig;
  private readonly key: Uint8Array;

  constructor(config: ConfigService) {
    this.cfg = config.getOrThrow<AppConfig>(APP_CONFIG).auth;
    this.key = new TextEncoder().encode(this.cfg.jwtAccessSecret);
  }

  async signAccessToken(claims: AccessClaims): Promise<{ token: string; expiresInSeconds: number }> {
    const expiresInSeconds = this.cfg.accessTokenTtlSeconds;
    const token = await new SignJWT({ sid: claims.sessionId, role: claims.role })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(claims.userId)
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(`${expiresInSeconds}s`)
      .sign(this.key);
    return { token, expiresInSeconds };
  }

  async verifyAccessToken(token: string): Promise<AccessClaims> {
    try {
      const { payload } = await jwtVerify(token, this.key, {
        algorithms: ['HS256'],
        issuer: ISSUER,
        audience: AUDIENCE,
      });
      const role = payload['role'];
      const sessionId = payload['sid'];
      if (!payload.sub || typeof sessionId !== 'string' || !isRole(role)) throw new Error('malformed claims');
      return { userId: payload.sub, sessionId, role, expiresAtMs: typeof payload.exp === 'number' ? payload.exp * 1000 : undefined };
    } catch (err) {
      const expired = (err as { code?: string }).code === 'ERR_JWT_EXPIRED';
      throw expired
        ? unauthorized('TOKEN_EXPIRED', 'The access token has expired')
        : unauthorized('TOKEN_INVALID', 'The access token is invalid');
    }
  }

  newRefreshToken(): { token: string; hash: string } {
    const token = randomBytes(32).toString('base64url');
    return { token, hash: this.hashRefreshToken(token) };
  }

  hashRefreshToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }
}

function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (Object.values(Role) as string[]).includes(value);
}
