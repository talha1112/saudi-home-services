import { Injectable } from '@nestjs/common';
import type { AuthenticatedUser } from '../../common/auth/authenticated-user.js';
import { ApiError, badRequest, badRequestWith } from '../../common/errors/api-error.js';
import { type Page, toPage } from '../../common/pagination/pagination.js';
import { PrismaService } from '../../database/prisma.service.js';
import { type Prisma, Role, SupportThreadStatus } from '../../generated/prisma/client.js';
import { AuditService } from '../auth/audit.service.js';
import { notFound } from '../bookings/booking-support.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import type {
  AdminReplyDto,
  AdminSupportThreadDetailDto,
  AdminSupportThreadDto,
  ListSupportThreadsQueryDto,
  SendSupportMessageDto,
  SupportMessageDto,
  SupportMessagesPageDto,
  SupportMessagesQueryDto,
} from './support.dto.js';

const MAX_BODY_CHARS = 2000;
/** Control characters other than tab / newline / carriage return are never legitimate text. */
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
/** A person may write at most this many messages per minute (a cheap guard against floods; messages are plain text). */
const MAX_PER_MINUTE = 10;

type Tx = Prisma.TransactionClient;

/**
 * Support conversations. Every customer and worker (including a worker whose application is not approved) has at most one conversation
 * with the administrators. PostgreSQL is the only store. The person's side only ever sees their own conversation; administrators see all of
 * them. Nothing here changes a booking, an application or a payment.
 */
@Injectable()
export class SupportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  // ================================================================== the person's side

  async list(user: AuthenticatedUser, query: SupportMessagesQueryDto): Promise<SupportMessagesPageDto> {
    if (query.afterSeq !== undefined && query.beforeSeq !== undefined) {
      throw badRequest('SUPPORT_QUERY_INVALID', 'Use either afterSeq or beforeSeq, not both');
    }
    const limit = Math.min(query.limit ?? 50, 200);
    const thread = await this.prisma.supportThread.findUnique({ where: { userId: user.id }, select: { id: true, status: true } });
    if (!thread) return { items: [], meta: { limit, hasMore: false, lastSeq: 0, canSend: true, status: null } };
    const { rows, hasMore, lastSeq } = await this.page(thread.id, query, limit);
    return { items: rows.map((r) => this.toView(r, user.id)), meta: { limit, hasMore, lastSeq, canSend: true, status: thread.status } };
  }

  async send(user: AuthenticatedUser, dto: SendSupportMessageDto): Promise<{ message: SupportMessageDto; duplicate: boolean }> {
    const body = this.cleanBody(dto.body);
    await this.guardRate(user.id);

    const result = await this.prisma.$transaction(
      async (tx) => {
        // One conversation per person; created by their first message.
        const thread = await tx.supportThread.upsert({
          where: { userId: user.id },
          create: { userId: user.id, status: SupportThreadStatus.OPEN, lastSenderRole: user.role },
          update: {},
        });
        // Serialises writers of this conversation, so seq has no gaps or duplicates.
        await tx.$queryRaw`SELECT 1 FROM support_threads WHERE id = ${thread.id}::uuid FOR UPDATE`;

        const existing = await tx.supportMessage.findUnique({
          where: { threadId_senderUserId_clientMessageId: { threadId: thread.id, senderUserId: user.id, clientMessageId: dto.clientMessageId } },
        });
        if (existing) {
          if (existing.body !== body) throw new ApiError(409, 'CLIENT_MESSAGE_ID_REUSED', 'This clientMessageId was already used for a different message');
          return { row: existing, duplicate: true };
        }
        const row = await this.append(tx, thread.id, user.id, user.role, dto.clientMessageId, body);
        // The person wrote: the conversation waits for an administrator again (also after it was resolved).
        await tx.supportThread.update({
          where: { id: thread.id },
          data: { status: SupportThreadStatus.OPEN, lastSenderRole: user.role, lastMessageAt: row.createdAt },
        });
        return { row, duplicate: false };
      },
      { timeout: 10_000 },
    );
    return { message: this.toView(result.row, user.id), duplicate: result.duplicate };
  }

  // ================================================================== administrators

  async adminList(q: ListSupportThreadsQueryDto): Promise<Page<AdminSupportThreadDto>> {
    const search = q.search?.trim();
    const where: Prisma.SupportThreadWhereInput = {
      ...(q.status ? { status: q.status } : {}),
      ...(search ? { user: { OR: [{ fullName: { contains: search, mode: 'insensitive' } }, { fullNameAr: { contains: search, mode: 'insensitive' } }, { phone: { contains: search } }] } } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.supportThread.findMany({
        where,
        // waiting-for-us first, then newest activity
        orderBy: [{ status: 'asc' }, { lastMessageAt: 'desc' }, { id: 'desc' }],
        skip: q.skip,
        take: q.limit,
        include: { user: { select: this.userSelect() }, _count: { select: { messages: true } }, messages: { orderBy: { seq: 'desc' }, take: 1, select: { body: true } } },
      }),
      this.prisma.supportThread.count({ where }),
    ]);
    return toPage(rows.map((r) => this.toThreadView(r, r.messages[0]?.body ?? null)), total, q);
  }

  async adminThread(threadId: string, query: SupportMessagesQueryDto): Promise<AdminSupportThreadDetailDto> {
    const thread = await this.prisma.supportThread.findUnique({
      where: { id: threadId },
      include: { user: { select: this.userSelect() }, _count: { select: { messages: true } } },
    });
    if (!thread) throw notFound('Conversation');
    const limit = Math.min(query.limit ?? 200, 200);
    const { rows } = await this.page(thread.id, query.afterSeq === undefined && query.beforeSeq === undefined ? { limit } : query, limit);
    const last = rows[rows.length - 1];
    return { ...this.toThreadView(thread, last?.body ?? null), messages: rows.map((r) => this.toView(r, '')) };
  }

  async adminReply(adminId: string, threadId: string, dto: AdminReplyDto, meta: { ip?: string; userAgent?: string }): Promise<AdminSupportThreadDetailDto> {
    const body = this.cleanBody(dto.body);
    const clientMessageId = dto.clientMessageId ?? `admin-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    await this.prisma.$transaction(async (tx) => {
      const found = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM support_threads WHERE id = ${threadId}::uuid FOR UPDATE`;
      if (found.length === 0) throw notFound('Conversation');
      const existing = await tx.supportMessage.findUnique({
        where: { threadId_senderUserId_clientMessageId: { threadId, senderUserId: adminId, clientMessageId } },
      });
      if (existing) return; // a retried reply
      const row = await this.append(tx, threadId, adminId, Role.ADMIN, clientMessageId, body);
      const thread = await tx.supportThread.update({
        where: { id: threadId },
        data: { status: SupportThreadStatus.ANSWERED, lastSenderRole: Role.ADMIN, lastMessageAt: row.createdAt },
        select: { userId: true },
      });
      // Written in the SAME transaction as the reply: the person is told only about a reply that was stored, and the source key makes a
      // repeat impossible. A push goes to their registered devices; the text of the reply is not part of it.
      await this.notifications.create(tx, {
        userId: thread.userId,
        type: 'support.reply',
        sourceKey: `support:${row.id}`,
        params: {},
        resource: { type: 'support_thread', id: threadId },
      });
    });
    await this.audit.record({ action: 'support.reply', actorUserId: adminId, entityType: 'support_thread', entityId: threadId, ipAddress: meta.ip, userAgent: meta.userAgent });
    return this.adminThread(threadId, { limit: 200 } as SupportMessagesQueryDto);
  }

  async adminSetStatus(adminId: string, threadId: string, status: 'RESOLVED' | 'OPEN', meta: { ip?: string; userAgent?: string }): Promise<AdminSupportThreadDetailDto> {
    const moved = await this.prisma.supportThread.updateMany({ where: { id: threadId }, data: { status } });
    if (moved.count !== 1) throw notFound('Conversation');
    await this.audit.record({ action: `support.${status === 'RESOLVED' ? 'resolve' : 'reopen'}`, actorUserId: adminId, entityType: 'support_thread', entityId: threadId, ipAddress: meta.ip, userAgent: meta.userAgent });
    return this.adminThread(threadId, { limit: 200 } as SupportMessagesQueryDto);
  }

  // ================================================================== helpers

  private async append(tx: Tx, threadId: string, senderUserId: string, senderRole: Role, clientMessageId: string, body: string) {
    const [{ next }] = await tx.$queryRaw<{ next: number }[]>`SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM support_messages WHERE thread_id = ${threadId}::uuid`;
    return tx.supportMessage.create({ data: { threadId, seq: Number(next), senderUserId, senderRole, clientMessageId, body } });
  }

  private async page(threadId: string, query: { afterSeq?: number; beforeSeq?: number; limit?: number }, limit: number) {
    let rows;
    let hasMore: boolean;
    if (query.afterSeq !== undefined) {
      const found = await this.prisma.supportMessage.findMany({ where: { threadId, seq: { gt: query.afterSeq } }, orderBy: { seq: 'asc' }, take: limit + 1 });
      hasMore = found.length > limit;
      rows = found.slice(0, limit);
    } else {
      const found = await this.prisma.supportMessage.findMany({
        where: { threadId, ...(query.beforeSeq !== undefined ? { seq: { lt: query.beforeSeq } } : {}) },
        orderBy: { seq: 'desc' },
        take: limit + 1,
      });
      hasMore = found.length > limit;
      rows = found.slice(0, limit).reverse();
    }
    const last = await this.prisma.supportMessage.aggregate({ where: { threadId }, _max: { seq: true } });
    return { rows, hasMore, lastSeq: last._max.seq ?? 0 };
  }

  private userSelect() {
    return { id: true, fullName: true, fullNameAr: true, phone: true, roles: { select: { role: true } }, workerProfile: { select: { id: true, verificationStatus: true } } } satisfies Prisma.UserSelect;
  }

  private toThreadView(
    t: {
      id: string;
      userId: string;
      status: SupportThreadStatus;
      lastSenderRole: Role;
      lastMessageAt: Date;
      user: { fullName: string | null; fullNameAr: string | null; phone: string | null; roles: { role: Role }[]; workerProfile: { id: string; verificationStatus: string } | null };
      _count: { messages: number };
    },
    lastBody: string | null,
  ): AdminSupportThreadDto {
    const isWorker = Boolean(t.user.workerProfile) || t.user.roles.some((r) => r.role === Role.WORKER);
    return {
      id: t.id,
      userId: t.userId,
      status: t.status,
      role: isWorker ? Role.WORKER : Role.CUSTOMER,
      fullName: t.user.fullName ?? t.user.fullNameAr,
      phone: t.user.phone,
      workerVerificationStatus: t.user.workerProfile?.verificationStatus ?? null,
      workerId: t.user.workerProfile?.id ?? null,
      lastMessage: lastBody ? (lastBody.length > 140 ? `${lastBody.slice(0, 140)}...` : lastBody) : null,
      lastSenderRole: t.lastSenderRole,
      lastMessageAt: t.lastMessageAt.toISOString(),
      messageCount: t._count.messages,
    };
  }

  private toView(r: { id: string; seq: number; senderUserId: string; senderRole: Role; clientMessageId: string; body: string; createdAt: Date }, viewerId: string): SupportMessageDto {
    return {
      id: r.id,
      seq: r.seq,
      senderRole: r.senderRole,
      clientMessageId: r.clientMessageId,
      body: r.body,
      createdAt: r.createdAt.toISOString(),
      fromMe: r.senderUserId === viewerId,
    };
  }

  private cleanBody(raw: string): string {
    const body = raw.trim();
    const length = [...body].length;
    if (length < 1) throw badRequest('MESSAGE_EMPTY', 'The message is empty');
    if (length > MAX_BODY_CHARS) throw badRequestWith('MESSAGE_TOO_LONG', 'The message is too long', { maxChars: MAX_BODY_CHARS });
    if (CONTROL_CHARS.test(body)) throw badRequest('MESSAGE_INVALID', 'The message contains characters that are not allowed');
    return body;
  }

  /** Counts the person's recent messages in the database itself (survives restarts and works across instances). */
  private async guardRate(userId: string): Promise<void> {
    const since = new Date(Date.now() - 60_000);
    const recent = await this.prisma.supportMessage.count({ where: { senderUserId: userId, createdAt: { gt: since } } });
    if (recent >= MAX_PER_MINUTE) throw new ApiError(429, 'RATE_LIMITED', 'Too many messages, slow down', { retryAfterSeconds: 30 });
  }
}
