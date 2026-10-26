import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { badRequest } from '../../common/errors/api-error.js';
import type { AuthenticatedUser } from '../../common/auth/authenticated-user.js';
import { type Page, type PageQueryDto } from '../../common/pagination/pagination.js';
import { PrismaService } from '../../database/prisma.service.js';
import { Prisma, Role, UserStatus, WorkerVerificationStatus } from '../../generated/prisma/client.js';
import { AuditService } from '../auth/audit.service.js';
import type { Audience, AudienceGroup, BroadcastDto } from './admin-console.dto.js';

/** Most recipients one announcement may reach. A bigger audience needs a queue and a rate plan this phase does not have. */
export const MAX_BROADCAST_RECIPIENTS = 5000;
const INACTIVE_DAYS = 60;
const BATCH = 1000;

export interface AudienceFilter {
  audience: Audience;
  group?: AudienceGroup;
  cityIds?: string[];
  categoryIds?: string[];
}

const GROUPS_FOR: Record<Audience, AudienceGroup[]> = {
  CUSTOMERS: ['ALL', 'NEW', 'INACTIVE', 'REPEAT'],
  WORKERS: ['ALL', 'APPROVED', 'PENDING_VERIFICATION', 'SUSPENDED'],
};

/**
 * Announcements to a whole audience, and the history of what was sent. An announcement is one notification per recipient (so it shows in
 * their notification list and, when they have a phone registered, as a push) with a shared source key that identifies the campaign. Nothing
 * is sent twice to the same person for the same campaign. Opening is "read in the app", not "seen on the lock screen".
 */
@Injectable()
export class AdminNotificationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Who an audience means right now: active accounts only (suspended workers are reachable through their own group). */
  async recipientIds(a: AudienceFilter, limit: number): Promise<{ ids: string[]; total: number }> {
    const group = a.group ?? 'ALL';
    if (!GROUPS_FOR[a.audience].includes(group)) throw badRequest('INVALID_GROUP', `The group ${group} does not apply to ${a.audience.toLowerCase()}`);
    return a.audience === 'WORKERS' ? this.workerIds(a, group, limit) : this.customerIds(a, group, limit);
  }

  private async workerIds(a: AudienceFilter, group: AudienceGroup, limit: number) {
    const status: Prisma.WorkerProfileWhereInput =
      group === 'APPROVED'
        ? { verificationStatus: WorkerVerificationStatus.APPROVED, user: { status: UserStatus.ACTIVE } }
        : group === 'PENDING_VERIFICATION'
          ? { verificationStatus: { in: [WorkerVerificationStatus.SUBMITTED, WorkerVerificationStatus.UNDER_REVIEW, WorkerVerificationStatus.INFO_REQUIRED] }, user: { status: UserStatus.ACTIVE } }
          : group === 'SUSPENDED'
            ? { verificationStatus: WorkerVerificationStatus.SUSPENDED }
            : { user: { status: UserStatus.ACTIVE } };
    const where: Prisma.WorkerProfileWhereInput = {
      ...status,
      ...(a.cityIds?.length ? { serviceAreas: { some: { cityId: { in: a.cityIds } } } } : {}),
      ...(a.categoryIds?.length ? { services: { some: { service: { categoryId: { in: a.categoryIds } } } } } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.workerProfile.findMany({ where, select: { userId: true }, orderBy: { id: 'asc' }, take: limit }),
      this.prisma.workerProfile.count({ where }),
    ]);
    return { ids: rows.map((r) => r.userId), total };
  }

  private async customerIds(a: AudienceFilter, group: AudienceGroup, limit: number) {
    const cities = a.cityIds?.length ? a.cityIds.join(',') : null;
    const categories = a.categoryIds?.length ? a.categoryIds.join(',') : null;
    const where = Prisma.sql`u.status = 'ACTIVE'
      ${cities ? Prisma.sql`AND EXISTS (SELECT 1 FROM bookings b WHERE b.customer_id = u.id AND b.city_id = ANY(string_to_array(${cities}, ',')::uuid[]))` : Prisma.empty}
      ${categories ? Prisma.sql`AND EXISTS (SELECT 1 FROM bookings b JOIN services s ON s.id = b.service_id WHERE b.customer_id = u.id AND s.category_id = ANY(string_to_array(${categories}, ',')::uuid[]))` : Prisma.empty}
      ${group === 'NEW' ? Prisma.sql`AND NOT EXISTS (SELECT 1 FROM bookings b WHERE b.customer_id = u.id)` : Prisma.empty}
      ${group === 'INACTIVE' ? Prisma.sql`AND EXISTS (SELECT 1 FROM bookings b WHERE b.customer_id = u.id) AND NOT EXISTS (SELECT 1 FROM bookings b WHERE b.customer_id = u.id AND b.created_at > now() - make_interval(days => ${INACTIVE_DAYS}))` : Prisma.empty}
      ${group === 'REPEAT' ? Prisma.sql`AND (SELECT count(*) FROM bookings b WHERE b.customer_id = u.id) >= 2` : Prisma.empty}`;
    const [rows, total] = await Promise.all([
      this.prisma.$queryRaw<Array<{ id: string }>>`SELECT u.id FROM users u JOIN user_roles ur ON ur.user_id = u.id AND ur.role = 'CUSTOMER' WHERE ${where} ORDER BY u.id LIMIT ${limit}`,
      this.prisma.$queryRaw<Array<{ n: number }>>`SELECT count(*)::int AS n FROM users u JOIN user_roles ur ON ur.user_id = u.id AND ur.role = 'CUSTOMER' WHERE ${where}`,
    ]);
    return { ids: rows.map((r) => r.id), total: total[0]?.n ?? 0 };
  }

  async reach(a: AudienceFilter) {
    const { total } = await this.recipientIds(a, 1);
    return { audience: a.audience, group: a.group ?? 'ALL', recipients: total, maxPerAnnouncement: MAX_BROADCAST_RECIPIENTS };
  }

  async broadcast(admin: AuthenticatedUser, dto: BroadcastDto) {
    const titleEn = dto.titleEn?.trim() || undefined;
    const titleAr = dto.titleAr?.trim() || undefined;
    const bodyEn = dto.bodyEn?.trim() || undefined;
    const bodyAr = dto.bodyAr?.trim() || undefined;
    if (!titleEn && !titleAr) throw badRequest('TITLE_REQUIRED', 'Write a title in English, Arabic or both');
    if (!bodyEn && !bodyAr) throw badRequest('MESSAGE_REQUIRED', 'Write a message in English, Arabic or both');

    const { ids, total } = await this.recipientIds(dto, MAX_BROADCAST_RECIPIENTS + 1);
    if (total === 0) throw badRequest('NO_RECIPIENTS', 'Nobody matches this audience');
    if (total > MAX_BROADCAST_RECIPIENTS) throw badRequest('AUDIENCE_TOO_LARGE', `This would reach ${total} people. Narrow the audience to at most ${MAX_BROADCAST_RECIPIENTS}.`);

    const [cityNames, categoryNames] = await Promise.all([
      dto.cityIds?.length ? this.prisma.city.findMany({ where: { id: { in: dto.cityIds } }, select: { nameEn: true } }) : Promise.resolve([]),
      dto.categoryIds?.length ? this.prisma.serviceCategory.findMany({ where: { id: { in: dto.categoryIds } }, select: { nameEn: true } }) : Promise.resolve([]),
    ]);
    const audienceLabel = [dto.audience === 'WORKERS' ? 'Workers' : 'Customers', cityNames.length ? cityNames.map((c) => c.nameEn).join(', ') : 'All cities', ...(categoryNames.length ? [categoryNames.map((c) => c.nameEn).join(', ')] : [])].join(' · ');
    const campaignId = randomUUID();
    const sourceKey = `announce:${campaignId}`;
    // A missing language falls back to the other one, so every recipient sees something in their own language slot.
    const params = {
      titleEn: titleEn ?? titleAr!, titleAr: titleAr ?? titleEn!, bodyEn: bodyEn ?? bodyAr!, bodyAr: bodyAr ?? bodyEn!,
      audience: dto.audience, group: dto.group ?? 'ALL', kind: dto.kind ?? 'Announcement', audienceLabel,
    };
    for (let i = 0; i < ids.length; i += BATCH) {
      await this.prisma.notification.createMany({ data: ids.slice(i, i + BATCH).map((userId) => ({ userId, type: 'admin.announcement', sourceKey, params })), skipDuplicates: true });
    }
    const created = await this.prisma.notification.findMany({ where: { sourceKey }, select: { id: true, userId: true } });
    const tokens = await this.prisma.deviceToken.findMany({ where: { userId: { in: ids }, revokedAt: null }, select: { id: true, userId: true } });
    const byUser = new Map<string, string[]>();
    for (const t of tokens) byUser.set(t.userId, [...(byUser.get(t.userId) ?? []), t.id]);
    const deliveries = created.flatMap((n) => (byUser.get(n.userId) ?? []).map((tokenId) => ({ notificationId: n.id, channel: 'PUSH' as const, targetKey: `push:${tokenId}` })));
    for (let i = 0; i < deliveries.length; i += BATCH) await this.prisma.notificationDelivery.createMany({ data: deliveries.slice(i, i + BATCH), skipDuplicates: true });

    await this.audit.record({
      action: 'notification.broadcast',
      actorUserId: admin.id,
      entityType: 'notification_campaign',
      entityId: campaignId,
      metadata: { audience: dto.audience, group: dto.group ?? 'ALL', recipients: created.length, pushDeliveries: deliveries.length },
    });
    return { campaignId, recipients: created.length, pushDeliveries: deliveries.length };
  }

  async campaigns(q: PageQueryDto & { status?: string; q?: string }): Promise<Page<{ campaignId: string; kind: string; titleEn: string; titleAr: string; bodyEn: string; audience: string; audienceLabel: string; group: string; sentAt: string; reach: number; opened: number }>> {
    // Everything is sent at once; nothing is ever scheduled, so that status is always empty.
    if (q.status === 'SCHEDULED') return { items: [], meta: { page: q.page, limit: q.limit, total: 0, totalPages: 1 } };
    const like = q.q ? `%${q.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
    const match = like ? Prisma.sql`AND (params->>'titleEn' ILIKE ${like} OR params->>'titleAr' ILIKE ${like} OR params->>'kind' ILIKE ${like})` : Prisma.empty;
    const [rows, total] = await Promise.all([
      this.prisma.$queryRaw<Array<{ source_key: string; sent_at: Date; reach: number; opened: number; params: Prisma.JsonValue }>>`
        SELECT source_key, min(created_at) AS sent_at, count(*)::int AS reach, count(read_at)::int AS opened, (array_agg(params))[1] AS params
        FROM notifications WHERE type = 'admin.announcement' ${match} GROUP BY source_key ORDER BY min(created_at) DESC, source_key LIMIT ${q.limit} OFFSET ${q.skip}`,
      this.prisma.$queryRaw<Array<{ n: number }>>`SELECT count(DISTINCT source_key)::int AS n FROM notifications WHERE type = 'admin.announcement' ${match}`,
    ]);
    const items = rows.map((r) => {
      const p = (r.params && typeof r.params === 'object' && !Array.isArray(r.params) ? r.params : {}) as Record<string, string>;
      return {
        campaignId: r.source_key.replace(/^announce:/, ''),
        titleEn: p['titleEn'] ?? '', titleAr: p['titleAr'] ?? '', bodyEn: p['bodyEn'] ?? '',
        kind: p['kind'] ?? 'Announcement', audience: p['audience'] ?? '', audienceLabel: p['audienceLabel'] ?? '', group: p['group'] ?? 'ALL',
        sentAt: r.sent_at.toISOString(), reach: r.reach, opened: r.opened,
      };
    });
    const count = total[0]?.n ?? 0;
    return { items, meta: { page: q.page, limit: q.limit, total: count, totalPages: Math.max(1, Math.ceil(count / q.limit)) } };
  }

  async summary(now: Date = new Date()) {
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const [month, totals, devices, accounts, allNotifications, allRead] = await Promise.all([
      this.prisma.$queryRaw<Array<{ n: number }>>`SELECT count(DISTINCT source_key)::int AS n FROM notifications WHERE type = 'admin.announcement' AND created_at >= ${monthStart}`,
      this.prisma.$queryRaw<Array<{ reach: number; opened: number }>>`SELECT count(*)::int AS reach, count(read_at)::int AS opened FROM notifications WHERE type = 'admin.announcement'`,
      this.prisma.$queryRaw<Array<{ role: string; n: number }>>`
        SELECT ur.role::text AS role, count(DISTINCT u.id)::int AS n FROM users u JOIN user_roles ur ON ur.user_id = u.id
        WHERE ur.role IN ('CUSTOMER','WORKER') AND EXISTS (SELECT 1 FROM device_tokens d WHERE d.user_id = u.id AND d.revoked_at IS NULL) GROUP BY ur.role`,
      this.prisma.userRole.groupBy({ by: ['role'], where: { role: { in: [Role.CUSTOMER, Role.WORKER] } }, _count: { _all: true } }),
      this.prisma.notification.count({ where: { createdAt: { gte: monthStart } } }),
      this.prisma.notification.count({ where: { createdAt: { gte: monthStart }, readAt: { not: null } } }),
    ]);
    const t = totals[0] ?? { reach: 0, opened: 0 };
    const optIn = (role: string) => {
      const total = accounts.find((a) => a.role === role)?._count._all ?? 0;
      const withPhone = devices.find((d) => d.role === role)?.n ?? 0;
      return { accounts: total, withPhone, pct: total > 0 ? Math.round((withPhone / total) * 100) : null };
    };
    return {
      campaignsThisMonth: month[0]?.n ?? 0,
      announcementReach: t.reach,
      announcementOpenRatePct: t.reach > 0 ? Math.round((t.opened / t.reach) * 100) : null,
      notificationsThisMonth: allNotifications,
      openRateThisMonthPct: allNotifications > 0 ? Math.round((allRead / allNotifications) * 100) : null,
      pushOptIn: { customers: optIn('CUSTOMER'), workers: optIn('WORKER') },
      definitions: {
        pushOptIn: 'Accounts with at least one phone registered for push (a registration, not proof the person allowed notifications).',
        opened: 'Read in the app, not seen on the lock screen.',
      },
    };
  }
}
