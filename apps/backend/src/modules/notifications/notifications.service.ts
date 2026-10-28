import { HttpStatus, Injectable } from '@nestjs/common';
import { ApiError } from '../../common/errors/api-error.js';
import { parseLocale } from '../../common/i18n/localize.js';
import { type Page, PageQueryDto, toPage } from '../../common/pagination/pagination.js';
import { PrismaService } from '../../database/prisma.service.js';
import { coversInstant } from '../workers/availability.js';
import type { Locale, Prisma } from '../../generated/prisma/client.js';
import { type NotificationType, renderNotification } from './notification-templates.js';

type Db = Prisma.TransactionClient | PrismaService;

export interface NewNotification {
  userId: string;
  type: NotificationType;
  /** Unique per user: replaying the same business event creates nothing. */
  sourceKey: string;
  params: Record<string, string>;
  resource?: { type: string; id: string };
}

export interface NotificationView {
  id: string;
  type: string;
  title: string;
  body: string;
  resource: { type: string; id: string } | null;
  read: boolean;
  readAt: string | null;
  createdAt: string;
}

/** Which booking events notify whom. Unlisted events notify nobody. See docs/STORAGE_NOTIFICATIONS_OFFERS.md. */
type Target = 'customer' | 'assigned-worker' | 'quote-worker';
const BOOKING_EVENT_RULES: Record<string, Array<{ to: Target; type: NotificationType }>> = {
  QUOTE_SUBMITTED: [{ to: 'customer', type: 'quote.received' }],
  QUOTE_REVISED: [{ to: 'customer', type: 'quote.revised' }],
  QUOTE_ACCEPTED: [{ to: 'assigned-worker', type: 'quote.accepted' }],
  QUOTE_REJECTED: [{ to: 'quote-worker', type: 'quote.rejected' }],
  QUOTE_CHANGE_REQUESTED: [{ to: 'quote-worker', type: 'quote.change_requested' }],
  PAYMENT_CONFIRMED: [
    { to: 'customer', type: 'payment.confirmed' },
    { to: 'assigned-worker', type: 'payment.confirmed' },
  ],
  WORK_STARTED: [{ to: 'customer', type: 'work.started' }],
  WORK_COMPLETED: [{ to: 'customer', type: 'work.completed' }],
  BOOKING_CANCELLED: [
    { to: 'customer', type: 'booking.cancelled' },
    { to: 'assigned-worker', type: 'booking.cancelled' },
  ],
  BOOKING_EXPIRED: [{ to: 'customer', type: 'booking.expired' }],
  // Handled specially below: the recipients are every approved worker who offers the service in the city.
  BOOKING_CREATED: [],
};

export const notifiedBookingEventTypes = Object.keys(BOOKING_EVENT_RULES);

/**
 * Durable in-app notifications (PostgreSQL) plus the queued external deliveries.
 *
 * Idempotency: (user_id, source_key) is unique, so the outbox retrying an event, two workers racing, or a replay
 * creates exactly one notification per recipient and never a second push. Content is a template key plus safe
 * parameters; wording is rendered per reader (language) at read/send time.
 */
@Injectable()
export class NotificationsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Creates one notification (and its queued push deliveries). Returns whether it was newly created. */
  async create(db: Db, n: NewNotification): Promise<{ created: boolean }> {
    const inserted = await db.notification.createMany({
      data: [{ userId: n.userId, type: n.type, sourceKey: n.sourceKey, params: n.params, resourceType: n.resource?.type ?? null, resourceId: n.resource?.id ?? null }],
      skipDuplicates: true,
    });
    if (inserted.count === 0) return { created: false };

    const row = await db.notification.findUniqueOrThrow({ where: { userId_sourceKey: { userId: n.userId, sourceKey: n.sourceKey } }, select: { id: true } });
    const tokens = await db.deviceToken.findMany({ where: { userId: n.userId, revokedAt: null }, select: { id: true } });
    if (tokens.length > 0) {
      await db.notificationDelivery.createMany({
        data: tokens.map((t) => ({ notificationId: row.id, channel: 'PUSH' as const, targetKey: `push:${t.id}` })),
        skipDuplicates: true,
      });
    }
    return { created: true };
  }

  /** Called by the outbox dispatcher AFTER the booking transaction committed. Safe to call again for the same event. */
  async createFromBookingEvent(payload: { eventId: string; bookingId: string; type: string }): Promise<number> {
    const rules = BOOKING_EVENT_RULES[payload.type];
    if (!rules) return 0;
    if (payload.type === 'BOOKING_CREATED') return this.notifyEligibleWorkers(payload);
    const [event, booking] = await Promise.all([
      this.prisma.bookingEvent.findUnique({ where: { id: payload.eventId }, select: { actorUserId: true, quote: { select: { worker: { select: { userId: true } } } } } }),
      this.prisma.booking.findUnique({ where: { id: payload.bookingId }, select: { reference: true, customerId: true, worker: { select: { userId: true } } } }),
    ]);
    if (!event || !booking) return 0;

    const who: Record<Target, string | null | undefined> = {
      customer: booking.customerId,
      'assigned-worker': booking.worker?.userId,
      'quote-worker': event.quote?.worker.userId,
    };
    let created = 0;
    for (const rule of rules) {
      const userId = who[rule.to];
      if (!userId || userId === event.actorUserId) continue; // nobody is notified about their own action
      const res = await this.create(this.prisma, {
        userId,
        type: rule.type,
        sourceKey: `booking-event:${payload.eventId}`,
        params: { ref: booking.reference },
        resource: { type: 'booking', id: payload.bookingId },
      });
      if (res.created) created += 1;
    }
    return created;
  }

  /** A new open request: tell the approved, active, online workers who offer that service in that city during their hours (capped, so a huge pool cannot flood). */
  private async notifyEligibleWorkers(payload: { eventId: string; bookingId: string }): Promise<number> {
    const booking = await this.prisma.booking.findUnique({ where: { id: payload.bookingId }, select: { reference: true, serviceId: true, cityId: true, status: true, customerId: true, preferredStartAt: true } });
    if (!booking || booking.status !== 'OPEN') return 0;
    const workers = await this.prisma.workerProfile.findMany({
      where: {
        verificationStatus: 'APPROVED',
        isOnline: true,
        user: { status: 'ACTIVE' },
        userId: { not: booking.customerId },
        services: { some: { serviceId: booking.serviceId } },
        serviceAreas: { some: { cityId: booking.cityId } },
      },
      select: { userId: true, availability: { select: { dayOfWeek: true, startMinute: true, endMinute: true } } },
      take: 1000,
    });
    // Only workers who are online and whose weekly hours cover the requested start are told (no hours set = always).
    const recipients = workers.filter((w) => coversInstant(w.availability, booking.preferredStartAt)).slice(0, 200);
    let created = 0;
    for (const w of recipients) {
      const res = await this.create(this.prisma, {
        userId: w.userId,
        type: 'request.new',
        sourceKey: `booking-event:${payload.eventId}`,
        params: { ref: booking.reference },
        resource: { type: 'booking', id: payload.bookingId },
      });
      if (res.created) created += 1;
    }
    return created;
  }

  // ----------------------------------------------------------------- reading (own notifications only)

  async list(userId: string, query: PageQueryDto, opts: { unreadOnly?: boolean; locale?: unknown } = {}): Promise<Page<NotificationView>> {
    const where = { userId, ...(opts.unreadOnly ? { readAt: null } : {}) };
    const [rows, total, locale] = await Promise.all([
      this.prisma.notification.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: query.skip, take: query.limit }),
      this.prisma.notification.count({ where }),
      this.localeOf(userId, opts.locale),
    ]);
    return toPage(rows.map((r) => this.view(r, locale)), total, query);
  }

  async unreadCount(userId: string): Promise<{ unread: number }> {
    return { unread: await this.prisma.notification.count({ where: { userId, readAt: null } }) };
  }

  /** Marks one of the caller's own notifications as read. Someone else's id is "not found". Idempotent. */
  async markRead(userId: string, id: string, localeOverride?: unknown): Promise<NotificationView> {
    await this.prisma.notification.updateMany({ where: { id, userId, readAt: null }, data: { readAt: new Date() } });
    const row = await this.prisma.notification.findFirst({ where: { id, userId } });
    if (!row) throw new ApiError(HttpStatus.NOT_FOUND, 'NOT_FOUND', 'Notification not found');
    return this.view(row, await this.localeOf(userId, localeOverride));
  }

  async markAllRead(userId: string): Promise<{ updated: number }> {
    const res = await this.prisma.notification.updateMany({ where: { userId, readAt: null }, data: { readAt: new Date() } });
    return { updated: res.count };
  }

  private async localeOf(userId: string, override?: unknown): Promise<Locale> {
    const explicit = parseLocale(override);
    if (explicit) return explicit;
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { locale: true } });
    return user?.locale ?? 'AR';
  }

  private view(r: { id: string; type: string; params: Prisma.JsonValue; resourceType: string | null; resourceId: string | null; readAt: Date | null; createdAt: Date }, locale: Locale): NotificationView {
    const params = (r.params && typeof r.params === 'object' && !Array.isArray(r.params) ? r.params : {}) as Record<string, unknown>;
    const { title, body } = renderNotification(r.type, locale, params);
    return {
      id: r.id,
      type: r.type,
      title,
      body,
      resource: r.resourceType && r.resourceId ? { type: r.resourceType, id: r.resourceId } : null,
      read: r.readAt !== null,
      readAt: r.readAt?.toISOString() ?? null,
      createdAt: r.createdAt.toISOString(),
    };
  }
}
