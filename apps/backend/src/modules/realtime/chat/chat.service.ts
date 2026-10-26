import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AuthenticatedUser } from '../../../common/auth/authenticated-user.js';
import { ApiError, badRequest, badRequestWith, tooManyRequests } from '../../../common/errors/api-error.js';
import { APP_CONFIG, type AppConfig, type RealtimeConfig } from '../../../config/app.config.js';
import { KeyValueStore } from '../../../database/key-value.store.js';
import { PrismaService } from '../../../database/prisma.service.js';
import type { Role } from '../../../generated/prisma/client.js';
import { lockBooking } from '../../bookings/booking-support.js';
import { type BookingSide, BookingAccessService } from '../booking-access.service.js';
import { CHAT_SEND_STATUSES, SERVER_EVENTS, bookingRoom } from '../realtime.constants.js';
import { NotificationsService } from '../../notifications/notifications.service.js';
import { RealtimeEmitter } from '../realtime-emitter.js';
import type { ReceiptDto, SendMessageDto } from './chat.dto.js';

export interface ChatMessageView {
  id: string;
  bookingId: string;
  seq: number;
  senderRole: BookingSide;
  clientMessageId: string;
  body: string;
  createdAt: string;
}

export interface ChatReceipts {
  deliveredUpToSeq: number;
  readUpToSeq: number;
}

/** Control characters other than tab / newline / carriage return are never legitimate chat text. */
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

/**
 * Booking chat. PostgreSQL is the only store of messages; sockets merely announce what was committed.
 *
 * Message states, from the sender's point of view:
 *   SENT       the server accepted and stored it (the send acknowledgement returns the id and seq)
 *   DELIVERED  the other participant's app acknowledged receiving up to this seq
 *   READ       the other participant's user has seen it
 * DELIVERED and READ come only from the recipient's explicit receipt, never inferred from a socket
 * being connected. History is never deleted (a disconnect or a finished booking keeps it).
 */
@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);
  private readonly cfg: RealtimeConfig;
  /** Used only while the shared limiter (Redis) is down, so a Redis outage neither blocks chat nor removes all limits. */
  private readonly local = new Map<string, { count: number; resetAt: number }>();

  constructor(
    config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly access: BookingAccessService,
    private readonly store: KeyValueStore,
    private readonly emitter: RealtimeEmitter,
    private readonly notifications: NotificationsService,
  ) {
    this.cfg = config.getOrThrow<AppConfig>(APP_CONFIG).realtime;
  }

  async send(user: AuthenticatedUser, bookingId: string, dto: SendMessageDto): Promise<{ message: ChatMessageView; duplicate: boolean }> {
    const body = this.cleanBody(dto.body);
    const { side: senderSide, booking: seen } = await this.access.resolve(user, bookingId); // 404 for strangers before anything is counted or written
    await this.limit(`rl:chat:v1:${user.id}`, this.cfg.chat.rateLimitPerMinute);

    const result = await this.prisma.$transaction(
      async (tx) => {
        // Same lock every booking writer takes: sends serialise with each other and with cancel/complete,
        // so the status check below cannot be overtaken and seq has no gaps or duplicates.
        await lockBooking(tx, bookingId);
        const { side, booking } = await this.access.resolve(user, bookingId, tx);

        const existing = await tx.chatMessage.findUnique({
          where: { bookingId_senderUserId_clientMessageId: { bookingId, senderUserId: user.id, clientMessageId: dto.clientMessageId } },
        });
        if (existing) {
          if (existing.body !== body) {
            throw new ApiError(409, 'CLIENT_MESSAGE_ID_REUSED', 'This clientMessageId was already used for a different message');
          }
          return { row: existing, duplicate: true };
        }

        if (!CHAT_SEND_STATUSES.includes(booking.status)) {
          throw new ApiError(409, 'CHAT_CLOSED', 'Messages can only be sent while the booking is confirmed or in progress', {
            details: { status: booking.status },
          });
        }

        const [{ next }] = await tx.$queryRaw<{ next: number }[]>`SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM chat_messages WHERE booking_id = ${bookingId}::uuid`;
        const row = await tx.chatMessage.create({
          data: { bookingId, seq: Number(next), senderUserId: user.id, senderRole: side as Role, clientMessageId: dto.clientMessageId, body },
        });
        return { row, duplicate: false };
      },
      { timeout: 10_000 },
    );

    const message = this.toView(result.row);
    // Only the first acceptance is announced; a retry gets the original back and recovers through chat.sync if needed.
    if (!result.duplicate) {
      this.emitter.toRoom(bookingRoom(bookingId), SERVER_EVENTS.chatMessage, { v: 1, ...message });
      await this.notifyRecipient(bookingId, senderSide, seen, result.row.seq);
    }
    return { message, duplicate: result.duplicate };
  }

  /**
   * Push to the other participant. One notification per run of unread messages: the key contains how far the recipient has read, so a second
   * message before they open the chat does not buzz again. The text is never part of it. A failure here never fails the send.
   */
  private async notifyRecipient(bookingId: string, senderSide: string, booking: { customerId: string; workerUserId: string | null }, seq: number): Promise<void> {
    try {
      const recipientId = senderSide === 'CUSTOMER' ? booking.workerUserId : booking.customerId;
      if (!recipientId) return;
      const [state, row] = await Promise.all([
        this.prisma.chatParticipantState.findUnique({ where: { bookingId_userId: { bookingId, userId: recipientId } }, select: { readUpToSeq: true } }),
        this.prisma.booking.findUnique({ where: { id: bookingId }, select: { reference: true } }),
      ]);
      await this.notifications.create(this.prisma, {
        userId: recipientId,
        type: 'chat.message',
        sourceKey: `chat:${bookingId}:${state?.readUpToSeq ?? 0}`,
        params: { ref: row?.reference ?? '' },
        resource: { type: 'booking', id: bookingId },
      });
    } catch (err) {
      this.logger.warn(`Chat notification for seq ${seq} was not created (${(err as Error).constructor.name})`);
    }
  }

  async list(user: AuthenticatedUser, bookingId: string, query: { afterSeq?: number; beforeSeq?: number; limit?: number }) {
    const { side, booking } = await this.access.resolve(user, bookingId);
    if (query.afterSeq !== undefined && query.beforeSeq !== undefined) {
      throw badRequest('CHAT_QUERY_INVALID', 'Use either afterSeq or beforeSeq, not both');
    }
    const limit = Math.min(query.limit ?? 50, this.cfg.chat.pageSizeMax);
    const otherUserId = side === 'CUSTOMER' ? booking.workerUserId : booking.customerId;

    let rows;
    let hasMore: boolean;
    if (query.afterSeq !== undefined) {
      const found = await this.prisma.chatMessage.findMany({
        where: { bookingId, seq: { gt: query.afterSeq } },
        orderBy: { seq: 'asc' },
        take: limit + 1,
      });
      hasMore = found.length > limit;
      rows = found.slice(0, limit);
    } else {
      const found = await this.prisma.chatMessage.findMany({
        where: { bookingId, ...(query.beforeSeq !== undefined ? { seq: { lt: query.beforeSeq } } : {}) },
        orderBy: { seq: 'desc' },
        take: limit + 1,
      });
      hasMore = found.length > limit;
      rows = found.slice(0, limit).reverse();
    }

    const [states, last] = await Promise.all([
      this.prisma.chatParticipantState.findMany({ where: { bookingId, userId: { in: [user.id, ...(otherUserId ? [otherUserId] : [])] } } }),
      this.prisma.chatMessage.aggregate({ where: { bookingId }, _max: { seq: true } }),
    ]);
    const mine = this.receiptsOf(states.find((s) => s.userId === user.id));
    const other = this.receiptsOf(states.find((s) => s.userId === otherUserId));

    return {
      items: rows.map((r) => {
        const fromMe = r.senderUserId === user.id;
        return {
          ...this.toView(r),
          fromMe,
          ...(fromMe ? { status: r.seq <= other.readUpToSeq ? 'READ' : r.seq <= other.deliveredUpToSeq ? 'DELIVERED' : 'SENT' } : {}),
        };
      }),
      meta: {
        limit,
        hasMore,
        direction: query.afterSeq !== undefined ? 'forward' : 'backward',
        ...(query.afterSeq === undefined && hasMore && rows.length > 0 ? { nextBeforeSeq: rows[0]!.seq } : {}),
        lastSeq: last._max.seq ?? 0,
        canSend: CHAT_SEND_STATUSES.includes(booking.status),
        receipts: { mine, other },
      },
    };
  }

  /** The recipient reports how far its app received (DELIVERED) or the user read (READ). Only moves forward. */
  async receipt(user: AuthenticatedUser, bookingId: string, dto: ReceiptDto): Promise<ChatReceipts> {
    const { side } = await this.access.resolve(user, bookingId);
    await this.limit(`rl:chatrcpt:v1:${user.id}`, this.cfg.chat.rateLimitPerMinute * 4);

    const last = await this.prisma.chatMessage.aggregate({ where: { bookingId }, _max: { seq: true } });
    if (dto.upToSeq > (last._max.seq ?? 0)) {
      throw badRequestWith('CHAT_SEQ_OUT_OF_RANGE', 'upToSeq is beyond the latest message', { lastSeq: last._max.seq ?? 0 });
    }
    const read = dto.kind === 'READ' ? dto.upToSeq : 0;
    const [row] = await this.prisma.$queryRaw<{ delivered_up_to_seq: number; read_up_to_seq: number }[]>`
      INSERT INTO chat_participant_states (booking_id, user_id, delivered_up_to_seq, read_up_to_seq, updated_at)
      VALUES (${bookingId}::uuid, ${user.id}::uuid, ${dto.upToSeq}, ${read}, now())
      ON CONFLICT (booking_id, user_id) DO UPDATE SET
        delivered_up_to_seq = GREATEST(chat_participant_states.delivered_up_to_seq, EXCLUDED.delivered_up_to_seq),
        read_up_to_seq = GREATEST(chat_participant_states.read_up_to_seq, EXCLUDED.read_up_to_seq),
        updated_at = now()
      RETURNING delivered_up_to_seq, read_up_to_seq`;
    const result = { deliveredUpToSeq: row!.delivered_up_to_seq, readUpToSeq: row!.read_up_to_seq };
    this.emitter.toRoom(bookingRoom(bookingId), SERVER_EVENTS.chatReceipt, { v: 1, bookingId, byRole: side, ...result });
    return result;
  }

  private receiptsOf(state?: { deliveredUpToSeq: number; readUpToSeq: number }): ChatReceipts {
    return { deliveredUpToSeq: state?.deliveredUpToSeq ?? 0, readUpToSeq: state?.readUpToSeq ?? 0 };
  }

  private cleanBody(raw: string): string {
    const body = raw.trim();
    const length = [...body].length;
    if (length < 1) throw badRequest('MESSAGE_EMPTY', 'The message is empty');
    if (length > this.cfg.chat.maxBodyChars) throw badRequestWith('MESSAGE_TOO_LONG', 'The message is too long', { maxChars: this.cfg.chat.maxBodyChars });
    if (CONTROL_CHARS.test(body)) throw badRequest('MESSAGE_INVALID', 'The message contains characters that are not allowed');
    return body;
  }

  private toView(r: { id: string; bookingId: string; seq: number; senderRole: Role; clientMessageId: string; body: string; createdAt: Date }): ChatMessageView {
    return {
      id: r.id,
      bookingId: r.bookingId,
      seq: r.seq,
      senderRole: r.senderRole as BookingSide,
      clientMessageId: r.clientMessageId,
      body: r.body,
      createdAt: r.createdAt.toISOString(),
    };
  }

  /** Fixed-window counter in the shared store; falls back to this process's own counter if the store is unreachable. */
  private async limit(key: string, max: number): Promise<void> {
    let count: number;
    let retry = 60;
    try {
      count = await this.store.increment(key, 60);
      if (count > max) retry = Math.max(1, await this.store.ttl(key));
    } catch {
      const now = Date.now();
      if (this.local.size > 10_000) for (const [k, v] of this.local) if (v.resetAt <= now) this.local.delete(k);
      const entry = this.local.get(key);
      if (!entry || entry.resetAt <= now) this.local.set(key, { count: 1, resetAt: now + 60_000 });
      else entry.count += 1;
      count = this.local.get(key)!.count;
      this.logger.warn('Shared rate limiter unavailable; using the in-process limiter');
    }
    if (count > max) throw tooManyRequests('RATE_LIMITED', 'Too many messages, slow down', retry);
  }
}
