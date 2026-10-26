import { Injectable } from '@nestjs/common';
import { IsEmail, validateSync } from 'class-validator';
import { PrismaService } from '../../../database/prisma.service.js';
import { Role, UserStatus } from '../../../generated/prisma/client.js';
import { AuditService } from '../audit.service.js';
import { PasswordService } from '../password.service.js';
import { SessionsService } from '../sessions.service.js';

class EmailCheck {
  @IsEmail()
  email: string;
}

/** Operator error with a message that is safe to print on the console. */
export class AdminSetupError extends Error {}

/**
 * Operator-only account management, reachable from the CLI (`src/cli/admin.cli.ts`)
 * and nowhere in the HTTP API. This is the only way an administrator comes to exist.
 */
@Injectable()
export class AdminBootstrapService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly sessions: SessionsService,
    private readonly audit: AuditService,
  ) {}

  /** Creates the first administrator. Refuses when any administrator already exists. */
  async createInitialAdmin(input: { email: string; password: string; fullName?: string }): Promise<{ id: string; email: string }> {
    const email = this.normalizeEmail(input.email);
    if ((await this.prisma.userRole.count({ where: { role: Role.ADMIN } })) > 0) {
      throw new AdminSetupError(
        'An administrator already exists. Use "reset-password" to recover access instead of creating another.',
      );
    }
    this.assertPassword(input.password, email);

    const user = await this.prisma.user.create({
      data: {
        email,
        emailVerifiedAt: new Date(),
        fullName: input.fullName?.trim() || null,
        passwordHash: await this.passwords.hash(input.password),
        // The bootstrap password travels through an operator's shell: force a change on first sign-in.
        mustChangePassword: true,
        status: UserStatus.ACTIVE,
        roles: { create: [{ role: Role.ADMIN }] },
      },
    });
    await this.audit.record({ action: 'admin.bootstrapped', actorUserId: user.id, entityType: 'user', entityId: user.id });
    return { id: user.id, email };
  }

  /** Recovery path: sets a new temporary password and signs the admin out everywhere. */
  async resetPassword(emailInput: string, newPassword: string): Promise<void> {
    const email = this.normalizeEmail(emailInput);
    const user = await this.prisma.user.findUnique({ where: { email }, include: { roles: true } });
    if (!user || !user.roles.some((r) => r.role === Role.ADMIN)) {
      throw new AdminSetupError('No administrator account exists for that email.');
    }
    this.assertPassword(newPassword, email);

    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        passwordHash: await this.passwords.hash(newPassword),
        mustChangePassword: true,
        passwordChangedAt: new Date(),
        status: UserStatus.ACTIVE,
      },
    });
    await this.sessions.revokeAllForUser(user.id);
    await this.audit.record({
      action: 'admin.password_reset_by_operator',
      actorUserId: null,
      entityType: 'user',
      entityId: user.id,
    });
  }

  private normalizeEmail(raw: string): string {
    const email = (raw ?? '').trim().toLowerCase();
    const check = Object.assign(new EmailCheck(), { email });
    if (validateSync(check).length > 0) throw new AdminSetupError('The email address is not valid.');
    return email;
  }

  private assertPassword(password: string, email: string): void {
    try {
      this.passwords.assertAcceptable(password ?? '', { email });
    } catch (err) {
      throw new AdminSetupError((err as { response?: { message?: string } }).response?.message ?? 'Password is not acceptable.');
    }
  }
}
