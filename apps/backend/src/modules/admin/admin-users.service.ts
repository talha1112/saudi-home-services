import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ApiError, badRequest } from '../../common/errors/api-error.js';
import { type Page, PageQueryDto, toPage } from '../../common/pagination/pagination.js';
import { PrismaService } from '../../database/prisma.service.js';
import { type Prisma, Role, UserStatus } from '../../generated/prisma/client.js';
import { AuditService } from '../auth/audit.service.js';
import type { ClientMeta } from '../auth/auth.types.js';
import { SessionsService } from '../auth/sessions.service.js';
import { RealtimeGateway } from '../realtime/realtime.gateway.js';

export const maskPhone = (phone: string | null): string | null => (phone ? `${phone.slice(0, 5)}${'•'.repeat(Math.max(0, phone.length - 9))}${phone.slice(-4)}` : null);
export const maskEmail = (email: string | null): string | null => {
  if (!email) return null;
  const [local = '', domain = ''] = email.split('@');
  return `${local.slice(0, 1)}•••@${domain}`;
};

const conflict = (code: string, message: string, details?: Record<string, unknown>) => new ApiError(HttpStatus.CONFLICT, code, message, details ? { details } : {});
const notFound = () => new ApiError(HttpStatus.NOT_FOUND, 'NOT_FOUND', 'User not found');

export interface AdminUserListQuery extends PageQueryDto {
  role?: Role;
  status?: UserStatus;
  q?: string;
}

/**
 * Administrator tooling for customer and worker accounts.
 *
 * Lists are REDACTED (masked phone and email, no documents, no addresses). The overview adds counts and short booking
 * summaries but still no identity documents (those are only reachable through the audited worker-verification routes).
 * Suspension is reversible and takes effect at once: every session is revoked, REST calls re-check the account on each request,
 * and live sockets are closed. Administrator accounts cannot be changed here, and nobody can suspend themselves.
 * There is no deletion: bookings, payments, ledger entries, disputes, reviews and audit records must be retained.
 */
@Injectable()
export class AdminUsersService {
  private readonly logger = new Logger(AdminUsersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionsService,
    private readonly audit: AuditService,
    private readonly realtime: RealtimeGateway,
  ) {}

  async list(q: AdminUserListQuery): Promise<Page<ReturnType<AdminUsersService['listItem']>>> {
    const where: Prisma.UserWhereInput = {
      // Administrators are managed through the CLI and are never listed here.
      roles: { some: { role: q.role ?? { in: [Role.CUSTOMER, Role.WORKER] } } },
      ...(q.status ? { status: q.status } : {}),
      ...(q.q
        ? { OR: [{ phone: { contains: q.q } }, { email: { contains: q.q.toLowerCase() } }, { fullName: { contains: q.q, mode: 'insensitive' } }, { fullNameAr: { contains: q.q } }] }
        : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: q.skip,
        take: q.limit,
        include: { roles: true, workerProfile: { select: { verificationStatus: true } } },
      }),
      this.prisma.user.count({ where }),
    ]);
    return toPage(rows.map((r) => this.listItem(r)), total, q);
  }

  private listItem(u: { id: string; phone: string | null; email: string | null; fullName: string | null; status: UserStatus; createdAt: Date; lastLoginAt: Date | null; roles: Array<{ role: Role }>; workerProfile: { verificationStatus: string } | null }) {
    return {
      id: u.id,
      phone: maskPhone(u.phone),
      email: maskEmail(u.email),
      fullName: u.fullName,
      status: u.status,
      roles: u.roles.map((r) => r.role),
      workerVerificationStatus: u.workerProfile?.verificationStatus ?? null,
      createdAt: u.createdAt.toISOString(),
      lastLoginAt: u.lastLoginAt?.toISOString() ?? null,
    };
  }

  async overview(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        roles: true,
        workerProfile: {
          include: {
            _count: { select: { services: true, serviceAreas: true, documents: true } },
            documents: { select: { type: true, status: true } },
          },
        },
      },
    });
    if (!user) throw notFound();
    const profile = user.workerProfile;

    const [asCustomer, asWorker, recentCustomer, recentWorker, disputes] = await Promise.all([
      this.prisma.booking.groupBy({ by: ['status'], where: { customerId: userId }, _count: { _all: true } }),
      profile ? this.prisma.booking.groupBy({ by: ['status'], where: { workerProfileId: profile.id }, _count: { _all: true } }) : Promise.resolve([]),
      this.prisma.booking.findMany({ where: { customerId: userId }, orderBy: { createdAt: 'desc' }, take: 10, select: { id: true, reference: true, status: true, createdAt: true } }),
      profile ? this.prisma.booking.findMany({ where: { workerProfileId: profile.id }, orderBy: { createdAt: 'desc' }, take: 10, select: { id: true, reference: true, status: true, createdAt: true } }) : Promise.resolve([]),
      this.prisma.dispute.groupBy({ by: ['status'], where: { OR: [{ openedById: userId }, { booking: { customerId: userId } }, ...(profile ? [{ booking: { workerProfileId: profile.id } }] : [])] }, _count: { _all: true } }),
    ]);
    const counts = (rows: Array<{ status: string; _count: { _all: number } }>) => Object.fromEntries(rows.map((r) => [r.status, r._count._all]));
    const summary = (rows: Array<{ id: string; reference: string; status: string; createdAt: Date }>) => rows.map((b) => ({ id: b.id, reference: b.reference, status: b.status, createdAt: b.createdAt.toISOString() }));

    return {
      id: user.id,
      phone: user.phone,
      email: user.email,
      fullName: user.fullName,
      locale: user.locale,
      status: user.status,
      statusReason: user.statusReason,
      roles: user.roles.map((r) => r.role),
      createdAt: user.createdAt.toISOString(),
      lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
      worker: profile
        ? {
            verificationStatus: profile.verificationStatus,
            isOnline: profile.isOnline,
            services: profile._count.services,
            serviceAreas: profile._count.serviceAreas,
            // Only the kind and review state of each document: never storage keys or links.
            documents: profile.documents.map((d) => ({ type: d.type, status: d.status })),
            rating: { count: profile.ratingCount, average: profile.ratingCount ? Math.round((profile.ratingSum / profile.ratingCount) * 100) / 100 : null },
          }
        : null,
      bookings: { asCustomer: counts(asCustomer), asWorker: counts(asWorker), recentAsCustomer: summary(recentCustomer), recentAsWorker: summary(recentWorker) },
      disputes: counts(disputes),
    };
  }

  async suspend(adminId: string, userId: string, reason: string, meta: ClientMeta) {
    return this.changeStatus(adminId, userId, reason, meta, { from: UserStatus.ACTIVE, to: UserStatus.SUSPENDED, action: 'user.suspended' });
  }

  async reactivate(adminId: string, userId: string, reason: string, meta: ClientMeta) {
    return this.changeStatus(adminId, userId, reason, meta, { from: UserStatus.SUSPENDED, to: UserStatus.ACTIVE, action: 'user.reactivated' });
  }

  private async changeStatus(adminId: string, userId: string, rawReason: string, meta: ClientMeta, t: { from: UserStatus; to: UserStatus; action: string }) {
    const reason = rawReason?.trim();
    if (!reason || reason.length < 3) throw badRequest('REASON_REQUIRED', 'A reason is required for this decision');
    if (userId === adminId) throw conflict('CANNOT_MODIFY_SELF', 'You cannot change your own account status');

    await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.findUnique({ where: { id: userId }, include: { roles: true } });
      if (!user) throw notFound();
      if (user.roles.some((r) => r.role === Role.ADMIN)) throw conflict('CANNOT_MODIFY_ADMIN', 'Administrator accounts are not managed here');
      if (user.status !== t.from) throw conflict('INVALID_STATE', `Only an account that is ${t.from} can move to ${t.to}`, { status: user.status });
      // The old status is part of the UPDATE, so two administrators acting at once cannot both succeed.
      const moved = await tx.user.updateMany({
        where: { id: userId, status: t.from },
        data: { status: t.to, statusReason: t.to === UserStatus.SUSPENDED ? reason : null },
      });
      if (moved.count !== 1) throw conflict('INVALID_STATE', 'The account was changed by someone else, please reload');
      if (t.to === UserStatus.SUSPENDED) await tx.workerProfile.updateMany({ where: { userId }, data: { isOnline: false } }); // no new requests
    });

    if (t.to === UserStatus.SUSPENDED) {
      await this.sessions.revokeAllForUser(userId); // refresh tokens die now; access tokens die at the next request (the guard re-reads the account)
      try {
        await this.realtime.endUserSessions(userId, 'ACCOUNT_NOT_ACTIVE');
      } catch (err) {
        this.logger.warn(`Could not close live sockets of a suspended account: ${(err as Error).name}`); // the revalidation sweep closes them anyway
      }
    }
    await this.audit.record({
      action: t.action,
      actorUserId: adminId,
      entityType: 'user',
      entityId: userId,
      metadata: { beforeStatus: t.from, afterStatus: t.to, reason },
      ipAddress: meta.ip,
      userAgent: meta.userAgent,
    });
    return this.overview(userId);
  }
}
