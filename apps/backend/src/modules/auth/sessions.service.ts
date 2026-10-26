import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { forbidden, unauthorized } from '../../common/errors/api-error.js';
import { APP_CONFIG, type AppConfig, type AuthConfig } from '../../config/app.config.js';
import { PrismaService } from '../../database/prisma.service.js';
import { Role, UserStatus } from '../../generated/prisma/client.js';
import { AuditService } from './audit.service.js';
import { lockSession, lockUser } from './session-locks.js';
import type { ClientMeta, IssuedTokens } from './auth.types.js';
import { TokenService } from './tokens/token.service.js';

/**
 * A session is a family of refresh tokens that descend from one sign-in.
 *
 * - Each refresh token is single use: refreshing marks it used and issues the next one.
 * - Presenting a token that was already used means it was copied. The whole
 *   family is revoked, which signs out both the thief and the real user.
 * - Revoking a family also kills its access tokens at once, because the auth
 *   guard checks that the session is still active.
 */
@Injectable()
export class SessionsService {
  private readonly cfg: AuthConfig;

  constructor(
    config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly tokens: TokenService,
    private readonly audit: AuditService,
  ) {
    this.cfg = config.getOrThrow<AppConfig>(APP_CONFIG).auth;
  }

  /** Starts a new session (new family) acting as `role`. */
  create(userId: string, role: Role, meta: ClientMeta): Promise<IssuedTokens> {
    return this.issue(userId, role, randomUUID(), meta);
  }

  async refresh(refreshToken: string, meta: ClientMeta): Promise<{ tokens: IssuedTokens; userId: string; role: Role }> {
    const hash = this.tokens.hashRefreshToken(refreshToken);
    const current = await this.prisma.refreshToken.findUnique({ where: { tokenHash: hash } });
    if (!current) throw unauthorized('REFRESH_TOKEN_INVALID', 'The session is not valid. Please sign in again');

    if (current.revokedAt && !current.usedAt) {
      throw unauthorized('REFRESH_TOKEN_REVOKED', 'The session has ended. Please sign in again');
    }
    if (current.usedAt) {
      // A spent token is being replayed: treat the session as compromised.
      await this.revokeFamily(current.familyId, current.userId);
      await this.audit.record({
        action: 'auth.refresh_token_reuse_detected',
        actorUserId: current.userId,
        entityType: 'session',
        entityId: current.familyId,
        ipAddress: meta.ip,
        userAgent: meta.userAgent,
      });
      throw unauthorized('REFRESH_TOKEN_REUSED', 'The session is no longer valid. Please sign in again');
    }
    if (current.expiresAt <= new Date()) {
      throw unauthorized('REFRESH_TOKEN_EXPIRED', 'The session has expired. Please sign in again');
    }

    const user = await this.prisma.user.findUnique({ where: { id: current.userId }, include: { roles: true } });
    const stillAllowed =
      user?.status === UserStatus.ACTIVE && user.roles.some((r) => r.role === current.sessionRole);
    if (!user || !stillAllowed) {
      await this.revokeFamily(current.familyId, current.userId);
      throw forbidden('ACCOUNT_NOT_ACTIVE', 'This account cannot sign in');
    }

    // Claim the token and issue the next one in ONE transaction under the session lock, so a logout/revocation of this session either
    // completes before this starts (and is seen below) or waits until the next token is committed (and then revokes it as well). Without
    // this a revocation landing between the claim and the insert left a live token in a revoked session.
    const { token, hash: nextHash } = this.tokens.newRefreshToken();
    const expiresAt = new Date(Date.now() + this.refreshTtlMs(current.sessionRole));
    const outcome = await this.prisma.$transaction(async (tx) => {
      await lockSession(tx, current.familyId);
      const fresh = await tx.refreshToken.findUnique({ where: { id: current.id } });
      if (!fresh) return 'invalid' as const;
      if (fresh.revokedAt && !fresh.usedAt) return 'revoked' as const; // the session was ended while we waited for the lock
      if (fresh.usedAt || fresh.revokedAt) return 'reused' as const; // a parallel request claimed it first
      const claimed = await tx.refreshToken.updateMany({ where: { id: current.id, usedAt: null, revokedAt: null }, data: { usedAt: new Date() } });
      if (claimed.count !== 1) return 'reused' as const;
      const next = await tx.refreshToken.create({
        data: {
          userId: current.userId,
          tokenHash: nextHash,
          familyId: current.familyId,
          sessionRole: current.sessionRole,
          expiresAt,
          userAgent: meta.userAgent?.slice(0, 512),
          ipAddress: meta.ip?.slice(0, 45),
        },
      });
      await tx.refreshToken.update({ where: { id: current.id }, data: { replacedById: next.id } });
      return 'ok' as const;
    });
    if (outcome === 'invalid') throw unauthorized('REFRESH_TOKEN_INVALID', 'The session is not valid. Please sign in again');
    if (outcome === 'revoked') throw unauthorized('REFRESH_TOKEN_REVOKED', 'The session has ended. Please sign in again');
    if (outcome === 'reused') {
      await this.revokeFamily(current.familyId, current.userId);
      throw unauthorized('REFRESH_TOKEN_REUSED', 'The session is no longer valid. Please sign in again');
    }

    const access = await this.tokens.signAccessToken({
      userId: current.userId,
      sessionId: current.familyId,
      role: current.sessionRole,
    });
    return {
      userId: current.userId,
      role: current.sessionRole,
      tokens: {
        accessToken: access.token,
        accessTokenExpiresInSeconds: access.expiresInSeconds,
        refreshToken: token,
        refreshTokenExpiresAt: expiresAt,
      },
    };
  }

  /** True while the session has an unrevoked, unexpired token belonging to this user. */
  async isActive(sessionId: string, userId: string): Promise<boolean> {
    const live = await this.prisma.refreshToken.findFirst({
      where: { familyId: sessionId, userId, revokedAt: null, expiresAt: { gt: new Date() } },
      select: { id: true },
    });
    return live !== null;
  }

  /** Revokes the session a refresh token belongs to. Silent when the token is unknown. */
  async revokeByRefreshToken(refreshToken: string): Promise<string | null> {
    const found = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: this.tokens.hashRefreshToken(refreshToken) },
    });
    if (!found) return null;
    await this.revokeFamily(found.familyId, found.userId);
    return found.userId;
  }

  /**
   * Ends one session: its refresh tokens AND the push registrations that session made, in one transaction, so they cannot disagree.
   * Idempotent (already-revoked rows are untouched, so a second call or a concurrent one changes nothing). Rotation never calls this, so a
   * continuing session keeps its registrations. Scoped by user as well as session: one account can never revoke another's devices.
   */
  async revokeFamily(familyId: string, userId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await lockUser(tx, userId);
      await lockSession(tx, familyId);
      // Both statements start after the locks are held, so they see everything a refresh or registration committed before us.
      const now = new Date();
      await tx.refreshToken.updateMany({ where: { familyId, revokedAt: null }, data: { revokedAt: now } });
      await tx.deviceToken.updateMany({ where: { sessionId: familyId, userId, revokedAt: null }, data: { revokedAt: now } });
    });
  }

  /** Signs the user out everywhere, optionally keeping one session. */
  async revokeAllForUser(userId: string, exceptSessionId?: string): Promise<void> {
    // Without an exception every registration of the user goes (including ones made before registrations were bound to sessions). With an
    // exception only registrations bound to OTHER sessions go: an unbound (legacy) registration cannot be attributed, so it is left to
    // the sweep in revokeDevicesOfEndedSessions.
    await this.prisma.$transaction(async (tx) => {
      await lockUser(tx, userId);
      const live = await tx.refreshToken.findMany({
        where: { userId, revokedAt: null, ...(exceptSessionId ? { familyId: { not: exceptSessionId } } : {}) },
        select: { familyId: true },
      });
      for (const familyId of [...new Set(live.map((t) => t.familyId))].sort()) await lockSession(tx, familyId); // ascending: one global order
      // A sign-in that creates a brand-new session after this point is a new session, not one this call was meant to end.
      const now = new Date();
      await tx.refreshToken.updateMany({
        where: { userId, revokedAt: null, ...(exceptSessionId ? { familyId: { not: exceptSessionId } } : {}) },
        data: { revokedAt: now },
      });
      await tx.deviceToken.updateMany({
        where: { userId, revokedAt: null, ...(exceptSessionId ? { sessionId: { not: exceptSessionId } } : {}) },
        data: { revokedAt: now },
      });
    });
  }

  /**
   * Revokes push registrations whose session has ended without anyone calling logout: the refresh token simply expired, or its rows were
   * purged. Also registrations from before sessions were recorded (no session id) when their owner has no live session left in that app.
   * Safe to run at any time and from several instances: it only ever sets revoked_at on rows that are still active, and a session that has
   * ended never becomes live again. Returns how many registrations it revoked.
   */
  async revokeDevicesOfEndedSessions(batchSize = 500): Promise<{ bound: number; legacy: number }> {
    const result = { bound: 0, legacy: 0 };
    const now = new Date();
    let after: string | undefined;
    for (;;) {
      const page = await this.prisma.deviceToken.findMany({
        where: { revokedAt: null, sessionId: { not: null }, ...(after ? { id: { gt: after } } : {}) },
        orderBy: { id: 'asc' },
        take: batchSize,
        select: { id: true, sessionId: true },
      });
      if (page.length === 0) break;
      after = page[page.length - 1]!.id;
      const ids = [...new Set(page.map((d) => d.sessionId!))];
      const live = await this.prisma.refreshToken.findMany({
        where: { familyId: { in: ids }, revokedAt: null, expiresAt: { gt: now } },
        select: { familyId: true },
      });
      const liveSet = new Set(live.map((t) => t.familyId));
      const ended = ids.filter((id) => !liveSet.has(id));
      for (const sessionId of ended.sort()) {
        // One short transaction per ended session, under its lock: serialized with registrations and logouts of that session. The session id is
        // part of the condition, so a registration that moved to a live session in the meantime is not touched.
        result.bound += await this.prisma.$transaction(async (tx) => {
          await lockSession(tx, sessionId);
          return (await tx.deviceToken.updateMany({ where: { sessionId, revokedAt: null }, data: { revokedAt: now } })).count;
        });
      }
      if (page.length < batchSize) break;
    }

    let afterLegacy: string | undefined;
    for (;;) {
      const page: { id: string; userId: string; appRole: Role }[] = await this.prisma.deviceToken.findMany({
        where: { revokedAt: null, sessionId: null, ...(afterLegacy ? { id: { gt: afterLegacy } } : {}) },
        orderBy: { id: 'asc' },
        take: batchSize,
        select: { id: true, userId: true, appRole: true },
      });
      if (page.length === 0) break;
      afterLegacy = page[page.length - 1]!.id;
      const users = [...new Set(page.map((d) => d.userId))];
      const live = await this.prisma.refreshToken.findMany({
        where: { userId: { in: users }, revokedAt: null, expiresAt: { gt: now } },
        select: { userId: true, sessionRole: true },
      });
      const liveKey = new Set(live.map((t) => `${t.userId}:${t.sessionRole}`));
      const orphaned = page.filter((d) => !liveKey.has(`${d.userId}:${d.appRole}`));
      for (const userId of [...new Set(orphaned.map((d) => d.userId))].sort()) {
        // Per user, under the user lock (one lock at a time), and only rows that are STILL unbound and active: a registration the app has just
        // re-made (now bound to a session) is not touched.
        const ids = orphaned.filter((d) => d.userId === userId).map((d) => d.id);
        result.legacy += await this.prisma.$transaction(async (tx) => {
          await lockUser(tx, userId);
          return (await tx.deviceToken.updateMany({ where: { id: { in: ids }, sessionId: null, revokedAt: null }, data: { revokedAt: now } })).count;
        });
      }
      if (page.length < batchSize) break;
    }
    return result;
  }

  /**
   * Deletes refresh-token rows that can no longer matter: expired, revoked or already
   * spent more than `retentionDays` ago. The retention window keeps recent rows around so
   * a replayed token is still recognised as reuse (and its session revoked) for a week.
   */
  async purgeStale(retentionDays = 7): Promise<{ expired: number; revoked: number; spent: number }> {
    const cutoff = new Date(Date.now() - retentionDays * 24 * 3600 * 1000);
    const [expired, revoked, spent] = await Promise.all([
      this.prisma.refreshToken.deleteMany({ where: { expiresAt: { lt: cutoff } } }),
      this.prisma.refreshToken.deleteMany({ where: { revokedAt: { lt: cutoff } } }),
      this.prisma.refreshToken.deleteMany({ where: { usedAt: { lt: cutoff } } }),
    ]);
    return { expired: expired.count, revoked: revoked.count, spent: spent.count };
  }

  private async issue(userId: string, role: Role, familyId: string, meta: ClientMeta): Promise<IssuedTokens> {
    const { token, hash } = this.tokens.newRefreshToken();
    const expiresAt = new Date(Date.now() + this.refreshTtlMs(role));
    await this.prisma.refreshToken.create({
      data: {
        userId,
        tokenHash: hash,
        familyId,
        sessionRole: role,
        expiresAt,
        userAgent: meta.userAgent?.slice(0, 512),
        ipAddress: meta.ip?.slice(0, 45),
      },
    });
    const access = await this.tokens.signAccessToken({ userId, sessionId: familyId, role });
    return {
      accessToken: access.token,
      accessTokenExpiresInSeconds: access.expiresInSeconds,
      refreshToken: token,
      refreshTokenExpiresAt: expiresAt,
    };
  }

  private refreshTtlMs(role: Role): number {
    const seconds = role === Role.ADMIN ? this.cfg.adminRefreshTokenTtlSeconds : this.cfg.refreshTokenTtlSeconds;
    return seconds * 1000;
  }
}
