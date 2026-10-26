import { HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AuthenticatedUser } from '../../common/auth/authenticated-user.js';
import { ApiError, badRequest, unauthorized, unavailable } from '../../common/errors/api-error.js';
import { APP_CONFIG, type AppConfig, type NotificationsConfig } from '../../config/app.config.js';
import { PrismaService } from '../../database/prisma.service.js';
import type { DevicePlatform, PushProviderName, Role } from '../../generated/prisma/client.js';
import { lockSession, lockUser } from '../auth/session-locks.js';
import { encryptToken, hashToken } from './push/token-cipher.js';

/** Which push vendor can reach which platform. FCM also reaches iOS (through APNs). */
export const PLATFORM_PROVIDERS: Record<DevicePlatform, PushProviderName[]> = {
  ANDROID: ['FCM'],
  IOS: ['APNS', 'FCM'],
  HUAWEI: ['HMS'],
};

export interface DeviceView {
  id: string;
  platform: DevicePlatform;
  provider: PushProviderName;
  app: Role;
  createdAt: string;
  lastSeenAt: string;
}

/**
 * Push-token registration (backend contract only; the apps are not changed in this phase).
 *
 * - The owner is always the authenticated caller; a user id is never accepted from the client.
 * - A token is stored encrypted (AES-256-GCM); only its SHA-256 is used for lookup. Tokens are never returned or logged.
 * - One physical token belongs to one account at a time: registering it from another account moves it
 *   (the device was handed over / a different person signed in), atomically, so the previous account stops receiving pushes.
 * - Each account keeps at most MAX_DEVICE_TOKENS_PER_USER active tokens; the least recently seen are revoked.
 * - Revocation is soft (revoked_at), so a later registration of the same token reactivates it.
 */
@Injectable()
export class DeviceTokensService {
  private readonly cfg: NotificationsConfig;

  constructor(
    config: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    this.cfg = config.getOrThrow<AppConfig>(APP_CONFIG).notifications;
  }

  async register(user: AuthenticatedUser, dto: { platform: DevicePlatform; provider: PushProviderName; token: string }): Promise<DeviceView> {
    const key = this.cfg.deviceTokenKey;
    if (!key) throw unavailable('PUSH_NOT_CONFIGURED', 'Push notifications are not available yet');
    if (!PLATFORM_PROVIDERS[dto.platform].includes(dto.provider)) {
      throw badRequest('PROVIDER_PLATFORM_MISMATCH', `${dto.provider} cannot deliver to ${dto.platform} devices`);
    }
    const tokenHash = hashToken(dto.token);
    const tokenCiphertext = encryptToken(key, dto.token);

    return this.prisma.$transaction(async (tx) => {
      // Same lock order as revocation (user, then session), so registering and logging out of this session run one after the other: either
      // the logout already happened and this is refused, or it happens afterwards and revokes what is registered here. Nothing can be
      // registered or reactivated against a session that has ended.
      await lockUser(tx, user.id);
      await lockSession(tx, user.sessionId);
      const live = await tx.refreshToken.findFirst({
        where: { familyId: user.sessionId, userId: user.id, revokedAt: null, expiresAt: { gt: new Date() } },
        select: { id: true },
      });
      if (!live) throw unauthorized('SESSION_ENDED', 'The session has ended. Please sign in again');
      const row = await tx.deviceToken.upsert({
        where: { tokenHash },
        create: { userId: user.id, platform: dto.platform, provider: dto.provider, tokenHash, tokenCiphertext, appRole: user.role, sessionId: user.sessionId },
        update: { userId: user.id, platform: dto.platform, provider: dto.provider, tokenCiphertext, appRole: user.role, sessionId: user.sessionId, lastSeenAt: new Date(), revokedAt: null },
      });
      const active = await tx.deviceToken.findMany({ where: { userId: user.id, revokedAt: null }, orderBy: [{ lastSeenAt: 'desc' }, { id: 'desc' }], select: { id: true } });
      const excess = active.slice(this.cfg.maxDevicesPerUser).map((d) => d.id);
      if (excess.length > 0) await tx.deviceToken.updateMany({ where: { id: { in: excess } }, data: { revokedAt: new Date() } });
      return this.view(row);
    });
  }

  async list(userId: string): Promise<{ items: DeviceView[] }> {
    const rows = await this.prisma.deviceToken.findMany({ where: { userId, revokedAt: null }, orderBy: { createdAt: 'asc' } });
    return { items: rows.map((r) => this.view(r)) };
  }

  /** Revokes one of the caller's own tokens. Someone else's id (or an unknown one) is "not found". */
  async revoke(userId: string, id: string): Promise<void> {
    const res = await this.prisma.deviceToken.updateMany({ where: { id, userId, revokedAt: null }, data: { revokedAt: new Date() } });
    if (res.count === 0) {
      const exists = await this.prisma.deviceToken.count({ where: { id, userId } });
      if (exists === 0) throw new ApiError(HttpStatus.NOT_FOUND, 'NOT_FOUND', 'Device not found');
    }
  }

  private view(r: { id: string; platform: DevicePlatform; provider: PushProviderName; appRole: Role; createdAt: Date; lastSeenAt: Date }): DeviceView {
    return { id: r.id, platform: r.platform, provider: r.provider, app: r.appRole, createdAt: r.createdAt.toISOString(), lastSeenAt: r.lastSeenAt.toISOString() };
  }
}
