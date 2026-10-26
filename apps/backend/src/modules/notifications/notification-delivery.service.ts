import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { renderNotification } from './notification-templates.js';
import { APP_CONFIG, type AppConfig, type NotificationsConfig } from '../../config/app.config.js';
import { PrismaService } from '../../database/prisma.service.js';
import { type DeadRegistrations, revokeDeadRegistrations } from './dead-registrations.js';
import { decryptToken } from './push/token-cipher.js';
import { PushError, PushProvider } from './push/push-provider.js';

interface DueRow {
  id: string;
  notification_id: string;
  target_key: string;
  attempts: number;
}

/** 2 s, 4 s, 8 s ... capped at 10 minutes, +-20% jitter. */
export function deliveryBackoffMs(attempts: number, random: () => number = Math.random): number {
  const base = Math.min(2000 * 2 ** Math.max(0, attempts - 1), 10 * 60_000);
  return Math.round(base * (0.8 + random() * 0.4));
}

export interface DeliveryRun {
  claimed: number;
  sent: number;
  retried: number;
  failed: number;
  unsupported: number;
}

/**
 * Sends the queued external deliveries (push). Driven by the database, not by Redis: a repeatable job calls
 * `runOnce` and rows are claimed with FOR UPDATE SKIP LOCKED, so a lost queue loses nothing and two workers never
 * send the same row at once.
 *
 * Status semantics (only what the provider can substantiate):
 *   QUEUED       not attempted yet, or waiting for a retry
 *   SENT         the provider ACCEPTED the message; this is NOT proof the device received it
 *   DELIVERED    never set today (needs vendor delivery receipts that are not wired up)
 *   FAILED       permanent error or the attempts ran out (an invalid token also revokes that token)
 *   UNSUPPORTED  no push provider is configured, so nothing was attempted
 * A crash between the provider call and the commit can send twice (at-least-once); the payload carries the
 * notification id so the app can collapse duplicates. Logs never contain tokens, titles, bodies or credentials.
 */
@Injectable()
export class NotificationDeliveryService {
  private readonly logger = new Logger(NotificationDeliveryService.name);
  private readonly cfg: NotificationsConfig;

  constructor(
    config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly push: PushProvider,
  ) {
    this.cfg = config.getOrThrow<AppConfig>(APP_CONFIG).notifications;
  }

  async runOnce(now: Date = new Date(), batch = 50): Promise<DeliveryRun> {
    const run: DeliveryRun = { claimed: 0, sent: 0, retried: 0, failed: 0, unsupported: 0 };
    // Registrations found dead during this run. They are revoked AFTER the batch transaction commits: this transaction stays open while it
    // calls the push provider (up to its timeout), and a row lock on a device taken here would make a concurrent logout wait for the whole
    // batch (or deadlock with it over two devices of the same user). Within the batch the set is consulted so a dead device is not tried twice.
    const dead: DeadRegistrations = new Map();
    await this.prisma.$transaction(
      async (tx) => {
        const rows = await tx.$queryRaw<DueRow[]>`
          SELECT id, notification_id, target_key, attempts FROM notification_deliveries
          WHERE status = 'QUEUED' AND next_attempt_at <= ${now}
          ORDER BY created_at, id LIMIT ${batch} FOR UPDATE SKIP LOCKED`;
        run.claimed = rows.length;

        for (const row of rows) {
          if (!this.push.supported) {
            await tx.notificationDelivery.update({ where: { id: row.id }, data: { status: 'UNSUPPORTED', lastError: 'NO_PROVIDER' } });
            run.unsupported += 1;
            continue;
          }
          const tokenId = row.target_key.startsWith('push:') ? row.target_key.slice(5) : null;
          const [notification, device] = await Promise.all([
            tx.notification.findUnique({ where: { id: row.notification_id }, include: { user: { select: { locale: true } } } }),
            tokenId ? tx.deviceToken.findUnique({ where: { id: tokenId } }) : null,
          ]);
          if (!notification || !device || device.revokedAt || dead.has(device.id) || !this.cfg.deviceTokenKey || device.userId !== notification.userId) {
            await tx.notificationDelivery.update({ where: { id: row.id }, data: { status: 'FAILED', lastError: 'TOKEN_UNAVAILABLE' } });
            run.failed += 1;
            continue;
          }
          // A registration whose session has ended is not active even if nothing has revoked it yet (expiry, or a registration that raced a
          // logout). Registrations from before sessions were recorded have no session id and are covered by the periodic sweep instead.
          if (device.sessionId) {
            const live = await tx.refreshToken.findFirst({
              where: { familyId: device.sessionId, userId: device.userId, revokedAt: null, expiresAt: { gt: now } },
              select: { id: true },
            });
            if (!live) {
              dead.set(device.id, device.sessionId); // revoked later only while still bound to THIS session (see revokeDeadRegistrations)
              await tx.notificationDelivery.update({ where: { id: row.id }, data: { status: 'FAILED', lastError: 'SESSION_ENDED' } });
              run.failed += 1;
              continue;
            }
          }
          try {
            const params = (notification.params && typeof notification.params === 'object' && !Array.isArray(notification.params) ? notification.params : {}) as Record<string, unknown>;
            const { title, body } = renderNotification(notification.type, notification.user.locale, params);
            const sent = await this.push.send({
              provider: device.provider,
              platform: device.platform,
              token: decryptToken(this.cfg.deviceTokenKey, device.tokenCiphertext),
              title,
              body,
              data: { notificationId: notification.id, type: notification.type, ...(notification.resourceType && notification.resourceId ? { resourceType: notification.resourceType, resourceId: notification.resourceId } : {}) },
            });
            await tx.notificationDelivery.update({
              where: { id: row.id },
              data: { status: 'SENT', attempts: row.attempts + 1, providerMessageId: sent.messageId.slice(0, 200), sentAt: new Date(), lastError: null },
            });
            run.sent += 1;
          } catch (err) {
            const kind = err instanceof PushError ? err.kind : 'TRANSIENT';
            const attempts = row.attempts + 1;
            if (kind === 'INVALID_TOKEN') dead.set(device.id, null);
            if (kind === 'TRANSIENT' && attempts < this.cfg.maxAttempts) {
              await tx.notificationDelivery.update({
                where: { id: row.id },
                data: { attempts, lastError: 'TRANSIENT', nextAttemptAt: new Date(now.getTime() + deliveryBackoffMs(attempts)) },
              });
              run.retried += 1;
            } else {
              await tx.notificationDelivery.update({ where: { id: row.id }, data: { status: 'FAILED', attempts, lastError: kind === 'TRANSIENT' ? 'ATTEMPTS_EXHAUSTED' : kind } });
              run.failed += 1;
              this.logger.warn(`Push delivery ${row.id} failed (${kind})`);
            }
          }
        }
      },
      { timeout: 30_000, maxWait: 5_000 },
    );
    if (dead.size > 0) {
      try {
        await revokeDeadRegistrations(this.prisma, dead);
      } catch {
        // The deliveries are already settled. A registration that is still dead is found again on its next use or by the periodic sweep.
        this.logger.warn(`Could not revoke ${dead.size} dead push registration(s) after delivery; the sweep will retry`);
      }
    }
    return run;
  }
}
