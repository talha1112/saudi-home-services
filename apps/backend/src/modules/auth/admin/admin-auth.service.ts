import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { AuthenticatedUser } from '../../../common/auth/authenticated-user.js';
import { badRequest, forbidden, tooManyRequests, unauthorized } from '../../../common/errors/api-error.js';
import { KeyValueStore } from '../../../database/key-value.store.js';
import { PrismaService } from '../../../database/prisma.service.js';
import { Role, UserStatus } from '../../../generated/prisma/client.js';
import { AuditService } from '../audit.service.js';
import { AuthService } from '../auth.service.js';
import type { ClientMeta } from '../auth.types.js';
import type { AdminLoginDto, AuthSessionDto, ChangePasswordDto } from '../dto/auth.dto.js';
import { PasswordService } from '../password.service.js';
import { SessionsService } from '../sessions.service.js';
import { toAuthUser } from '../user-view.js';
import { AdminMfaPolicy } from './admin-mfa.policy.js';

const WINDOW_SECONDS = 15 * 60;
const MAX_FAILURES_PER_EMAIL_AND_IP = 5;
const MAX_FAILURES_PER_EMAIL = 20;
const MAX_FAILURES_PER_IP = 30;

const WITH_ROLES = { roles: true } as const;

/**
 * Email + password sign-in for the admin portal. There is no public sign-up:
 * administrators are created only by the operator CLI (see AdminBootstrapService).
 */
@Injectable()
export class AdminAuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly store: KeyValueStore,
    private readonly passwords: PasswordService,
    private readonly sessions: SessionsService,
    private readonly mfa: AdminMfaPolicy,
    private readonly audit: AuditService,
    private readonly auth: AuthService,
  ) {}

  async login(dto: AdminLoginDto, meta: ClientMeta): Promise<AuthSessionDto> {
    const keys = this.failureKeys(dto.email, meta.ip);
    await this.assertNotLocked(keys);

    const user = await this.prisma.user.findUnique({ where: { email: dto.email }, include: WITH_ROLES });
    const isAdmin = user?.roles.some((r) => r.role === Role.ADMIN) ?? false;

    let passwordOk = false;
    if (user?.passwordHash && isAdmin) {
      passwordOk = await this.passwords.verify(user.passwordHash, dto.password);
    } else {
      await this.passwords.verifyDummy(dto.password);
    }

    if (!user || !passwordOk) {
      await this.recordFailure(keys);
      await this.audit.record({
        action: 'admin.login_failed',
        actorUserId: user?.id,
        entityType: 'user',
        entityId: user?.id,
        ipAddress: meta.ip,
        userAgent: meta.userAgent,
      });
      throw unauthorized('INVALID_CREDENTIALS', 'Email or password is incorrect');
    }

    if (user.status !== UserStatus.ACTIVE) {
      throw forbidden('ACCOUNT_NOT_ACTIVE', 'This account cannot sign in');
    }

    const subject = { id: user.id, email: user.email };
    if ((await this.mfa.isRequired(subject)) && !(await this.mfa.verify(subject, dto.mfaCode))) {
      await this.recordFailure(keys);
      throw unauthorized('MFA_REQUIRED', 'A valid second-factor code is required');
    }

    await this.store.del(keys.emailAndIp);
    const tokens = await this.sessions.create(user.id, Role.ADMIN, meta);
    await this.prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    await this.audit.record({
      action: 'admin.login',
      actorUserId: user.id,
      entityType: 'user',
      entityId: user.id,
      ipAddress: meta.ip,
      userAgent: meta.userAgent,
    });
    return this.auth.toSession(tokens, toAuthUser(user, Role.ADMIN));
  }

  /**
   * Changes the password, signs the account out everywhere (every other device
   * and the old session) and returns a fresh session for the caller.
   */
  async changePassword(current: AuthenticatedUser, dto: ChangePasswordDto, meta: ClientMeta): Promise<AuthSessionDto> {
    const throttleKey = `pwchange:${current.id}`;
    const failures = Number((await this.store.get(throttleKey)) ?? 0);
    if (failures >= MAX_FAILURES_PER_EMAIL_AND_IP) {
      throw tooManyRequests('PASSWORD_CHANGE_LOCKED', 'Too many attempts, try again later', await this.store.ttl(throttleKey));
    }

    const user = await this.prisma.user.findUnique({ where: { id: current.id }, include: WITH_ROLES });
    if (!user?.passwordHash || !(await this.passwords.verify(user.passwordHash, dto.currentPassword))) {
      await this.store.increment(throttleKey, WINDOW_SECONDS);
      throw unauthorized('INVALID_CREDENTIALS', 'The current password is incorrect');
    }
    if (dto.newPassword === dto.currentPassword) {
      throw badRequest('WEAK_PASSWORD', 'The new password must be different from the current one');
    }
    this.passwords.assertAcceptable(dto.newPassword, { email: user.email });

    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        passwordHash: await this.passwords.hash(dto.newPassword),
        mustChangePassword: false,
        passwordChangedAt: new Date(),
      },
    });
    await this.store.del(throttleKey);
    await this.sessions.revokeAllForUser(user.id);
    const tokens = await this.sessions.create(user.id, Role.ADMIN, meta);
    await this.audit.record({
      action: 'admin.password_changed',
      actorUserId: user.id,
      entityType: 'user',
      entityId: user.id,
      ipAddress: meta.ip,
      userAgent: meta.userAgent,
    });
    const fresh = await this.prisma.user.findUnique({ where: { id: user.id }, include: WITH_ROLES });
    return this.auth.toSession(tokens, toAuthUser(fresh ?? user, Role.ADMIN));
  }

  private failureKeys(email: string, ip = 'unknown') {
    const e = createHash('sha256').update(email).digest('hex').slice(0, 24);
    return {
      emailAndIp: `adminlogin:${e}:${ip}`,
      email: `adminlogin-email:${e}`,
      ip: `adminlogin-ip:${ip}`,
    };
  }

  private async assertNotLocked(keys: ReturnType<AdminAuthService['failureKeys']>): Promise<void> {
    const limits: [string, number][] = [
      [keys.emailAndIp, MAX_FAILURES_PER_EMAIL_AND_IP],
      [keys.email, MAX_FAILURES_PER_EMAIL],
      [keys.ip, MAX_FAILURES_PER_IP],
    ];
    for (const [key, max] of limits) {
      if (Number((await this.store.get(key)) ?? 0) >= max) {
        throw tooManyRequests(
          'LOGIN_LOCKED',
          'Too many failed attempts. Try again later',
          await this.store.ttl(key),
        );
      }
    }
  }

  private async recordFailure(keys: ReturnType<AdminAuthService['failureKeys']>): Promise<void> {
    await Promise.all([
      this.store.increment(keys.emailAndIp, WINDOW_SECONDS),
      this.store.increment(keys.email, WINDOW_SECONDS),
      this.store.increment(keys.ip, WINDOW_SECONDS),
    ]);
  }
}
