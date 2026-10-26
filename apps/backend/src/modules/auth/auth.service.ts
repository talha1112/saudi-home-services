import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AuthenticatedUser } from '../../common/auth/authenticated-user.js';
import { badRequest, forbidden, unauthorized } from '../../common/errors/api-error.js';
import { APP_CONFIG, type AppConfig } from '../../config/app.config.js';
import { PrismaService } from '../../database/prisma.service.js';
import { Role, UserStatus, WorkerVerificationStatus } from '../../generated/prisma/client.js';
import { AuditService } from './audit.service.js';
import type { ClientMeta, IssuedTokens } from './auth.types.js';
import type { AuthSessionDto, AuthUserDto, OtpRequestedDto, RequestOtpDto, VerifyOtpDto } from './dto/auth.dto.js';
import { OtpService } from './otp/otp.service.js';
import { normalizePhone } from './phone.js';
import { SessionsService } from './sessions.service.js';
import { toAuthUser } from './user-view.js';

const WITH_ROLES = { roles: true, workerProfile: { select: { verificationStatus: true } } } as const;

@Injectable()
export class AuthService {
  private readonly region: string;

  constructor(
    config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly otp: OtpService,
    private readonly sessions: SessionsService,
    private readonly audit: AuditService,
  ) {
    this.region = config.getOrThrow<AppConfig>(APP_CONFIG).auth.defaultPhoneRegion;
  }

  requestOtp(dto: RequestOtpDto, meta: ClientMeta = {}): Promise<OtpRequestedDto> {
    // The response never says whether the number already has an account.
    return this.otp.request(this.phone(dto.phone), meta.ip, dto.locale);
  }

  async verifyOtp(dto: VerifyOtpDto, meta: ClientMeta): Promise<AuthSessionDto> {
    const phone = this.phone(dto.phone);
    const role = dto.app === 'worker' ? Role.WORKER : Role.CUSTOMER;

    await this.otp.verify(phone, dto.code, meta.ip);

    const { user, isNewUser } = await this.findOrCreate(phone, role, meta);
    this.assertCanSignIn(user.status);

    const tokens = await this.sessions.create(user.id, role, meta);
    await this.prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    await this.audit.record({
      action: 'auth.sign_in',
      actorUserId: user.id,
      entityType: 'user',
      entityId: user.id,
      metadata: { method: 'otp', role, newUser: isNewUser },
      ipAddress: meta.ip,
      userAgent: meta.userAgent,
    });
    return { ...this.toSession(tokens, toAuthUser(user, role)), isNewUser };
  }

  async refresh(refreshToken: string, meta: ClientMeta): Promise<AuthSessionDto> {
    const { tokens, userId, role } = await this.sessions.refresh(refreshToken, meta);
    const user = await this.prisma.user.findUnique({ where: { id: userId }, include: WITH_ROLES });
    if (!user) throw unauthorized('REFRESH_TOKEN_INVALID', 'The session is not valid. Please sign in again');
    return this.toSession(tokens, toAuthUser(user, role));
  }

  /** Always succeeds, so the endpoint reveals nothing about which tokens exist. */
  async logout(refreshToken: string, meta: ClientMeta): Promise<void> {
    const userId = await this.sessions.revokeByRefreshToken(refreshToken);
    if (userId) {
      await this.audit.record({
        action: 'auth.sign_out',
        actorUserId: userId,
        entityType: 'user',
        entityId: userId,
        ipAddress: meta.ip,
        userAgent: meta.userAgent,
      });
    }
  }

  async logoutEverywhere(user: AuthenticatedUser, meta: ClientMeta): Promise<void> {
    await this.sessions.revokeAllForUser(user.id);
    await this.audit.record({
      action: 'auth.sign_out_all',
      actorUserId: user.id,
      entityType: 'user',
      entityId: user.id,
      ipAddress: meta.ip,
      userAgent: meta.userAgent,
    });
  }

  async me(current: AuthenticatedUser): Promise<AuthUserDto> {
    const user = await this.prisma.user.findUnique({ where: { id: current.id }, include: WITH_ROLES });
    if (!user) throw unauthorized('TOKEN_INVALID', 'The access token is invalid');
    return toAuthUser(user, current.role);
  }

  toSession(tokens: IssuedTokens, user: AuthUserDto): AuthSessionDto {
    return {
      tokenType: 'Bearer',
      accessToken: tokens.accessToken,
      accessTokenExpiresInSeconds: tokens.accessTokenExpiresInSeconds,
      refreshToken: tokens.refreshToken,
      refreshTokenExpiresAt: tokens.refreshTokenExpiresAt.toISOString(),
      user,
    };
  }

  private phone(input: string): string {
    const phone = normalizePhone(input, this.region);
    if (!phone) throw badRequest('INVALID_PHONE', 'Enter a valid mobile number');
    return phone;
  }

  private assertCanSignIn(status: UserStatus): void {
    if (status === UserStatus.SUSPENDED) {
      throw forbidden('ACCOUNT_SUSPENDED', 'This account has been suspended. Contact support');
    }
    if (status === UserStatus.DEACTIVATED) {
      throw forbidden('ACCOUNT_DEACTIVATED', 'This account has been deactivated. Contact support');
    }
  }

  /**
   * Existing person: reuse the account and add the requested role if missing.
   * New person: create the account with that role. Only CUSTOMER and WORKER can
   * be granted here; ADMIN is impossible by construction (see APP_TYPES).
   */
  private async findOrCreate(phone: string, role: Role, meta: ClientMeta) {
    const existing = await this.prisma.user.findUnique({ where: { phone }, include: WITH_ROLES });
    if (!existing) {
      try {
        const user = await this.prisma.user.create({
          data: {
            phone,
            status: UserStatus.ACTIVE,
            phoneVerifiedAt: new Date(),
            roles: { create: [{ role }] },
            ...this.profileFor(role),
          },
          include: WITH_ROLES,
        });
        await this.audit.record({
          action: 'user.registered',
          actorUserId: user.id,
          entityType: 'user',
          entityId: user.id,
          metadata: { role },
          ipAddress: meta.ip,
          userAgent: meta.userAgent,
        });
        return { user, isNewUser: true };
      } catch (err) {
        // Two first sign-ins raced and the other one won: use its row.
        if ((err as { code?: string }).code !== 'P2002') throw err;
        const winner = await this.prisma.user.findUnique({ where: { phone }, include: WITH_ROLES });
        if (!winner) throw err;
        return { user: winner, isNewUser: false };
      }
    }

    if (existing.status === UserStatus.SUSPENDED || existing.status === UserStatus.DEACTIVATED) {
      return { user: existing, isNewUser: false };
    }

    const needsRole = !existing.roles.some((r) => r.role === role);
    const needsActivation = existing.status === UserStatus.PENDING_VERIFICATION;
    if (!needsRole && !needsActivation) return { user: existing, isNewUser: false };

    const user = await this.prisma.user.update({
      where: { id: existing.id },
      data: {
        ...(needsActivation ? { status: UserStatus.ACTIVE, phoneVerifiedAt: new Date() } : {}),
        ...(needsRole ? { roles: { create: [{ role }] } } : {}),
        ...(needsRole && role === Role.CUSTOMER && !(await this.hasCustomerProfile(existing.id))
          ? { customerProfile: { create: {} } }
          : {}),
        ...(needsRole && role === Role.WORKER && !existing.workerProfile
          ? { workerProfile: { create: { verificationStatus: WorkerVerificationStatus.NOT_SUBMITTED } } }
          : {}),
      },
      include: WITH_ROLES,
    });
    if (needsRole) {
      await this.audit.record({
        action: 'user.role_granted',
        actorUserId: user.id,
        entityType: 'user',
        entityId: user.id,
        metadata: { role, grantedBy: 'self_signup' },
        ipAddress: meta.ip,
        userAgent: meta.userAgent,
      });
    }
    return { user, isNewUser: false };
  }

  private profileFor(role: Role) {
    return role === Role.WORKER
      ? { workerProfile: { create: { verificationStatus: WorkerVerificationStatus.NOT_SUBMITTED } } }
      : { customerProfile: { create: {} } };
  }

  private async hasCustomerProfile(userId: string): Promise<boolean> {
    return (await this.prisma.customerProfile.findUnique({ where: { userId }, select: { id: true } })) !== null;
  }
}
