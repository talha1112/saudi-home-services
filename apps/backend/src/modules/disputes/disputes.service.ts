import { HttpStatus, Injectable } from '@nestjs/common';
import type { AuthenticatedUser } from '../../common/auth/authenticated-user.js';
import { ApiError, badRequest } from '../../common/errors/api-error.js';
import { type Page, PageQueryDto, toPage } from '../../common/pagination/pagination.js';
import { PrismaService } from '../../database/prisma.service.js';
import { BookingStatus, DisputeFinancialFollowup, DisputeStatus, Prisma, Role } from '../../generated/prisma/client.js';
import { AuditService } from '../auth/audit.service.js';
import type { ClientMeta } from '../auth/auth.types.js';
import { lockBooking } from '../bookings/booking-support.js';
import { DISPUTE_RULES, type DisputeAction, nextStatus } from './dispute-state-machine.js';
import { type AdminListDisputesQueryDto, type AdminNoteDto, type EvidenceRefsDto, MAX_EVIDENCE, type OpenDisputeDto, type ResolveDisputeDto } from './disputes.dto.js';

type Tx = Prisma.TransactionClient;
type Side = 'CUSTOMER' | 'WORKER';

const conflict = (code: string, message: string, details?: Record<string, unknown>) => new ApiError(HttpStatus.CONFLICT, code, message, details ? { details } : {});
const notFound = (what = 'Dispute') => new ApiError(HttpStatus.NOT_FOUND, 'NOT_FOUND', `${what} not found`);

/**
 * A booking can be disputed once money was committed to it: CONFIRMED, IN_PROGRESS, COMPLETED, or CANCELLED after it had
 * been confirmed (confirmed_at is set). Open, unpaid and expired requests have nothing to dispute. No time limit exists
 * because none was approved (see docs/ADMIN_DISPUTES_REVIEWS_REPORTS.md).
 */
const DISPUTABLE: BookingStatus[] = [BookingStatus.CONFIRMED, BookingStatus.IN_PROGRESS, BookingStatus.COMPLETED, BookingStatus.CANCELLED];

const FULL = {
  booking: { select: { id: true, reference: true, status: true, customerId: true, workerProfileId: true, worker: { select: { userId: true } } } },
  events: { orderBy: [{ createdAt: 'asc' as const }, { id: 'asc' as const }] },
  evidence: { include: { photo: { select: { id: true, fileName: true, mimeType: true, status: true } }, message: { select: { id: true, seq: true, senderRole: true, body: true, createdAt: true } } }, orderBy: { createdAt: 'asc' as const } },
} satisfies Prisma.DisputeInclude;
type Full = Prisma.DisputeGetPayload<{ include: typeof FULL }>;

/** What an administrator needs to recognise a dispute at a glance: who, what, where and how much. */
const ADMIN_BOOKING = {
  select: {
    reference: true, status: true, totalAmountHalalas: true, currency: true, paymentMethod: true, confirmedAt: true, cashCollectedAt: true,
    city: { select: { nameEn: true, nameAr: true } },
    service: { select: { nameEn: true, nameAr: true } },
    customer: { select: { id: true, fullName: true } },
    worker: { select: { id: true, user: { select: { fullName: true, fullNameAr: true } } } },
  },
} satisfies { select: Prisma.BookingSelect };
type AdminBooking = Prisma.BookingGetPayload<typeof ADMIN_BOOKING>;
const contains = (q: string) => ({ contains: q, mode: 'insensitive' as const });

/**
 * Disputes between the two parties of a booking, handled by administrators.
 *
 * Isolation: a dispute is visible only to the booking's customer and its assigned worker (and to administrators). Anyone
 * else gets 404. Internal notes never leave the admin API. Evidence is a reference to an existing private photo or chat message
 * of the SAME booking (also enforced by a database trigger); nothing is copied and no link is stored.
 * Nothing here moves money, changes a booking, a rating or an account.
 */
@Injectable()
export class DisputesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // ================================================================================== participants

  async open(user: AuthenticatedUser, dto: OpenDisputeDto) {
    const side = this.sideOf(user);
    const photoIds = [...new Set(dto.bookingPhotoIds ?? [])];
    const messageIds = [...new Set(dto.chatMessageIds ?? [])];
    if (photoIds.length + messageIds.length > MAX_EVIDENCE) throw badRequest('TOO_MUCH_EVIDENCE', `At most ${MAX_EVIDENCE} evidence items per dispute`);

    try {
      const id = await this.prisma.$transaction(async (tx) => {
        await lockBooking(tx, dto.bookingId); // serialises with the lifecycle and with other disputes of this booking
        const booking = await tx.booking.findUnique({
          where: { id: dto.bookingId },
          select: { id: true, status: true, customerId: true, confirmedAt: true, worker: { select: { userId: true } } },
        });
        const isParticipant = booking && ((side === 'CUSTOMER' && booking.customerId === user.id) || (side === 'WORKER' && booking.worker?.userId === user.id));
        if (!booking || !isParticipant) throw notFound('Booking'); // strangers cannot tell whether the booking exists
        if (!DISPUTABLE.includes(booking.status) || (booking.status === BookingStatus.CANCELLED && !booking.confirmedAt)) {
          throw conflict('BOOKING_NOT_DISPUTABLE', 'This booking cannot be disputed in its current state', { status: booking.status });
        }
        const active = await tx.dispute.count({ where: { bookingId: booking.id, status: { in: [DisputeStatus.OPEN, DisputeStatus.UNDER_REVIEW, DisputeStatus.AWAITING_INFO] } } });
        if (active > 0) throw conflict('DISPUTE_ALREADY_ACTIVE', 'This booking already has an open dispute');

        await this.assertEvidence(tx, booking.id, photoIds, messageIds);
        const dispute = await tx.dispute.create({
          data: { bookingId: booking.id, openedById: user.id, openedByRole: side as Role, category: dto.category, description: dto.description },
        });
        await tx.disputeEvent.create({ data: { disputeId: dispute.id, action: 'OPENED', toStatus: DisputeStatus.OPEN, actorUserId: user.id, actorRole: side as Role } });
        await this.attachEvidence(tx, dispute.id, user.id, photoIds, messageIds);
        return dispute.id;
      });
      return this.getForUser(user, id);
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002') throw conflict('DISPUTE_ALREADY_ACTIVE', 'This booking already has an open dispute');
      throw err;
    }
  }

  async listMine(user: AuthenticatedUser, query: PageQueryDto, status?: DisputeStatus): Promise<Page<ReturnType<DisputesService['mineItem']>>> {
    const side = this.sideOf(user);
    const where: Prisma.DisputeWhereInput = {
      ...(status ? { status } : {}),
      booking: side === 'CUSTOMER' ? { customerId: user.id } : { worker: { userId: user.id } },
    };
    const [rows, total] = await Promise.all([
      this.prisma.dispute.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: query.skip, take: query.limit, include: { booking: { select: { reference: true } } } }),
      this.prisma.dispute.count({ where }),
    ]);
    return toPage(rows.map((r) => this.mineItem(r, user.id)), total, query);
  }

  private mineItem(r: { id: string; bookingId: string; category: string; status: DisputeStatus; openedById: string; createdAt: Date; updatedAt: Date; booking: { reference: string } }, userId: string) {
    return { id: r.id, bookingId: r.bookingId, bookingReference: r.booking.reference, category: r.category, status: r.status, openedByMe: r.openedById === userId, createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString() };
  }

  async getForUser(user: AuthenticatedUser, id: string) {
    const d = await this.loadForParticipant(user, id);
    return this.participantView(d, user.id);
  }

  async comment(user: AuthenticatedUser, id: string, text: string) {
    const d = await this.loadForParticipant(user, id);
    await this.apply(d.id, 'comment', { userId: user.id, role: this.sideOf(user) as Role }, { note: text });
    return this.getForUser(user, id);
  }

  async addEvidence(user: AuthenticatedUser, id: string, refs: EvidenceRefsDto) {
    const d = await this.loadForParticipant(user, id);
    const photoIds = [...new Set(refs.bookingPhotoIds ?? [])];
    const messageIds = [...new Set(refs.chatMessageIds ?? [])];
    if (photoIds.length + messageIds.length === 0) throw badRequest('EVIDENCE_REQUIRED', 'Name at least one photo or message');
    await this.apply(d.id, 'add_evidence', { userId: user.id, role: this.sideOf(user) as Role }, {}, async (tx) => {
      const existing = await tx.disputeEvidence.count({ where: { disputeId: d.id } });
      if (existing + photoIds.length + messageIds.length > MAX_EVIDENCE) throw badRequest('TOO_MUCH_EVIDENCE', `At most ${MAX_EVIDENCE} evidence items per dispute`);
      await this.assertEvidence(tx, d.bookingId, photoIds, messageIds);
      await this.attachEvidence(tx, d.id, user.id, photoIds, messageIds);
    });
    return this.getForUser(user, id);
  }

  async withdraw(user: AuthenticatedUser, id: string) {
    const d = await this.loadForParticipant(user, id);
    if (d.openedById !== user.id) throw new ApiError(HttpStatus.FORBIDDEN, 'NOT_OPENER', 'Only the person who opened the dispute can withdraw it');
    await this.apply(d.id, 'withdraw', { userId: user.id, role: this.sideOf(user) as Role, isOpener: true });
    return this.getForUser(user, id);
  }

  // ================================================================================== administrators

  async adminList(q: AdminListDisputesQueryDto): Promise<Page<ReturnType<DisputesService['adminItem']>>> {
    const where: Prisma.DisputeWhereInput = {
      ...(q.status?.length ? { status: { in: q.status } } : {}),
      ...(q.category ? { category: q.category } : {}),
      ...(q.cityId ? { booking: { cityId: q.cityId } } : {}),
      ...(q.bookingId ? { bookingId: q.bookingId } : {}),
      ...(q.openedById ? { openedById: q.openedById } : {}),
      ...(q.assignedAdminId ? { assignedAdminId: q.assignedAdminId } : {}),
      ...(q.financialFollowup ? { financialFollowup: q.financialFollowup } : {}),
      ...(q.from || q.to ? { createdAt: { ...(q.from ? { gte: new Date(q.from) } : {}), ...(q.to ? { lt: new Date(q.to) } : {}) } } : {}),
      ...(q.q
        ? {
            OR: [
              { booking: { reference: { startsWith: q.q.toUpperCase() } } },
              { opener: { fullName: contains(q.q) } },
              { booking: { customer: { fullName: contains(q.q) } } },
              { booking: { worker: { user: { fullName: contains(q.q) } } } },
              { booking: { service: { nameEn: contains(q.q) } } },
            ],
          }
        : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.dispute.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: q.skip, take: q.limit, include: { booking: ADMIN_BOOKING } }),
      this.prisma.dispute.count({ where }),
    ]);
    return toPage(rows.map((r) => this.adminItem(r)), total, q);
  }

  private adminItem(r: { id: string; bookingId: string; category: string; description?: string; status: DisputeStatus; openedById: string; openedByRole: Role; assignedAdminId: string | null; financialFollowup: DisputeFinancialFollowup; reopenCount: number; createdAt: Date; updatedAt: Date; booking: Pick<AdminBooking, 'reference'> & Partial<AdminBooking> }) {
    const b = r.booking;
    return {
      id: r.id, bookingId: r.bookingId, bookingReference: b.reference, category: r.category, status: r.status,
      openedById: r.openedById, openedByRole: r.openedByRole, assignedAdminId: r.assignedAdminId, financialFollowup: r.financialFollowup,
      reopenCount: r.reopenCount, createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString(),
      customerName: b.customer?.fullName ?? null,
      workerName: b.worker?.user.fullName ?? null,
      serviceNameEn: b.service?.nameEn ?? null, serviceNameAr: b.service?.nameAr ?? null,
      cityNameEn: b.city?.nameEn ?? null, cityNameAr: b.city?.nameAr ?? null,
      bookingStatus: b.status ?? null,
      amountHalalas: b.totalAmountHalalas ?? null, currency: b.currency ?? null,
    };
  }

  async adminGet(id: string) {
    const d = await this.prisma.dispute.findUnique({ where: { id }, include: FULL });
    if (!d) throw notFound();
    const [booking, opener, handler] = await Promise.all([
      this.prisma.booking.findUniqueOrThrow({ where: { id: d.bookingId }, ...ADMIN_BOOKING }),
      this.prisma.user.findUnique({ where: { id: d.openedById }, select: { fullName: true } }),
      d.assignedAdminId ? this.prisma.user.findUnique({ where: { id: d.assignedAdminId }, select: { fullName: true, email: true } }) : Promise.resolve(null),
    ]);
    const actorIds = [...new Set(d.events.map((e) => e.actorUserId).filter((x): x is string => !!x))];
    const actors = actorIds.length ? await this.prisma.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, fullName: true, email: true } }) : [];
    const nameOf = (userId: string | null) => {
      const a = actors.find((x) => x.id === userId);
      return a ? (a.fullName ?? a.email) : null;
    };
    return {
      ...this.adminItem({ ...d, booking }),
      description: d.description,
      openedByName: opener?.fullName ?? null,
      assignedAdminName: handler ? (handler.fullName ?? handler.email) : null,
      resolutionSummary: d.resolutionSummary,
      resolvedAt: d.resolvedAt?.toISOString() ?? null,
      closedAt: d.closedAt?.toISOString() ?? null,
      booking: {
        id: d.booking.id, reference: d.booking.reference, status: d.booking.status, customerId: d.booking.customerId, workerProfileId: d.booking.workerProfileId,
        paymentMethod: booking.paymentMethod === 'CASH' ? 'CASH' : booking.confirmedAt ? 'ONLINE' : null, cashCollected: booking.cashCollectedAt !== null,
      },
      events: d.events.map((e) => ({ id: e.id, action: e.action, fromStatus: e.fromStatus, toStatus: e.toStatus, actorUserId: e.actorUserId, actorName: nameOf(e.actorUserId), actorRole: e.actorRole, visibility: e.visibility, note: e.note, createdAt: e.createdAt.toISOString() })),
      evidence: this.evidenceView(d),
    };
  }

  async adminAction(admin: AuthenticatedUser, id: string, action: 'assign' | 'start_review' | 'request_info' | 'internal_note' | 'resolve' | 'close' | 'reopen', input: { note?: string; adminId?: string; resolve?: ResolveDisputeDto }, meta: ClientMeta) {
    const note = input.note?.trim();
    let before: DisputeStatus | undefined;
    let after: DisputeStatus | undefined;
    await this.apply(id, action, { userId: admin.id, role: Role.ADMIN, adminId: admin.id }, { note: action === 'resolve' ? input.resolve!.summary : note }, async (tx, d) => {
      const patch: Prisma.DisputeUncheckedUpdateManyInput = {};
      before = d.status;
      if (action === 'assign' || action === 'start_review') {
        const targetId = input.adminId ?? admin.id;
        const target = await tx.user.findFirst({ where: { id: targetId, status: 'ACTIVE', roles: { some: { role: Role.ADMIN } } }, select: { id: true } });
        if (!target) throw badRequest('INVALID_ASSIGNEE', 'The assignee must be an active administrator');
        if (action === 'assign' || !d.assignedAdminId) patch.assignedAdminId = target.id;
      }
      if (action === 'resolve') {
        const r = input.resolve!;
        Object.assign(patch, { resolutionSummary: r.summary, resolvedAt: new Date(), financialFollowup: r.financialFollowup ?? DisputeFinancialFollowup.NONE });
        if (r.internalNote) await tx.disputeEvent.create({ data: { disputeId: id, action: 'INTERNAL_NOTE', actorUserId: admin.id, actorRole: Role.ADMIN, visibility: 'INTERNAL', note: r.internalNote } });
      }
      if (action === 'reopen') {
        // A newer dispute may have been opened about the same booking since this one was resolved; only one can be active.
        const other = await tx.dispute.count({ where: { bookingId: d.bookingId, id: { not: id }, status: { in: [DisputeStatus.OPEN, DisputeStatus.UNDER_REVIEW, DisputeStatus.AWAITING_INFO] } } });
        if (other > 0) throw conflict('DISPUTE_ALREADY_ACTIVE', 'Another dispute about this booking is active; handle that one instead');
        Object.assign(patch, { reopenCount: { increment: 1 }, resolvedAt: null });
      }
      if (action === 'close') patch.closedAt = new Date();
      after = nextStatus(DISPUTE_RULES[action], d.status);
      return patch;
    });
    await this.audit.record({
      action: `dispute.${action}`,
      actorUserId: admin.id,
      entityType: 'dispute',
      entityId: id,
      metadata: { beforeStatus: before ?? null, afterStatus: after ?? null, hasNote: Boolean(note ?? input.resolve?.summary), ...(action === 'resolve' ? { financialFollowup: input.resolve?.financialFollowup ?? 'NONE' } : {}) },
      ipAddress: meta.ip,
      userAgent: meta.userAgent,
    });
    return this.adminGet(id);
  }

  // ================================================================================== internals

  /**
   * One transition: locks the dispute row, checks the table (state, actor, note), compare-and-sets the status, writes the
   * history row, and lets the caller do its extra work in the same transaction.
   */
  private async apply(
    id: string,
    action: DisputeAction,
    actor: { userId: string; role: Role; isOpener?: boolean; adminId?: string },
    opts: { note?: string } = {},
    extra?: (tx: Tx, d: { status: DisputeStatus; bookingId: string; assignedAdminId: string | null }) => Promise<Prisma.DisputeUncheckedUpdateManyInput | void>,
  ): Promise<void> {
    const rule = DISPUTE_RULES[action];
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM disputes WHERE id = ${id}::uuid FOR UPDATE`;
      const d = await tx.dispute.findUnique({ where: { id }, select: { status: true, bookingId: true, assignedAdminId: true } });
      if (!d) throw notFound();
      if (!rule.from.includes(d.status)) throw conflict('INVALID_STATE', `This dispute is ${d.status}; ${action.replace('_', ' ')} is not possible now`, { status: d.status, allowedFrom: rule.from });
      if (rule.noteRequired && !opts.note?.trim()) throw badRequest('NOTE_REQUIRED', 'A note is required for this action');
      // Field changes travel in the SAME UPDATE as the status change, so the table's CHECKs always see a consistent row.
      const patch = (await extra?.(tx, d)) ?? {};

      const to = nextStatus(rule, d.status);
      if (to !== d.status) {
        const moved = await tx.dispute.updateMany({ where: { id, status: d.status }, data: { ...patch, status: to } });
        if (moved.count !== 1) throw conflict('INVALID_STATE', 'The dispute was changed by someone else, please reload');
      } else {
        await tx.dispute.updateMany({ where: { id }, data: { ...patch, updatedAt: new Date() } });
      }
      await tx.disputeEvent.create({
        data: {
          disputeId: id,
          action: rule.event,
          fromStatus: d.status,
          toStatus: to,
          actorUserId: actor.userId,
          actorRole: actor.role,
          visibility: action === 'internal_note' || action === 'assign' ? 'INTERNAL' : 'PARTICIPANTS',
          // The resolution text is shown to participants through resolutionSummary; the history keeps it for the record.
          note: opts.note?.trim() || null,
        },
      });
    });
  }

  private sideOf(user: AuthenticatedUser): Side {
    if (user.role === Role.CUSTOMER) return 'CUSTOMER';
    if (user.role === Role.WORKER) return 'WORKER';
    throw new ApiError(HttpStatus.FORBIDDEN, 'INSUFFICIENT_ROLE', 'Your account type cannot perform this action');
  }

  private async loadForParticipant(user: AuthenticatedUser, id: string): Promise<Full> {
    const side = this.sideOf(user);
    const d = await this.prisma.dispute.findUnique({ where: { id }, include: FULL });
    const ok = d && (side === 'CUSTOMER' ? d.booking.customerId === user.id : d.booking.worker?.userId === user.id);
    if (!d || !ok) throw notFound(); // strangers cannot tell whether a dispute exists
    return d;
  }

  private participantView(d: Full, viewerId: string) {
    const finished = d.status === DisputeStatus.RESOLVED || d.status === DisputeStatus.CLOSED;
    return {
      id: d.id,
      bookingId: d.bookingId,
      bookingReference: d.booking.reference,
      category: d.category,
      description: d.description,
      status: d.status,
      openedByMe: d.openedById === viewerId,
      openedByRole: d.openedByRole,
      /** Shown only once resolved; INTERNAL notes and the handler's identity never are. */
      resolution: finished && d.resolutionSummary ? d.resolutionSummary : null,
      financialFollowupRequested: finished && d.financialFollowup === DisputeFinancialFollowup.REQUESTED,
      createdAt: d.createdAt.toISOString(),
      updatedAt: d.updatedAt.toISOString(),
      events: d.events
        .filter((e) => e.visibility === 'PARTICIPANTS' && !(e.action === 'RESOLVED' && !finished))
        .map((e) => ({ action: e.action, fromStatus: e.fromStatus, toStatus: e.toStatus, by: e.actorRole === Role.ADMIN ? 'SUPPORT' : e.actorUserId === viewerId ? 'ME' : 'OTHER_PARTY', note: e.action === 'REOPENED' || e.action === 'CLOSED' ? null : e.note, createdAt: e.createdAt.toISOString() })), // administrators' reasons for reopening/closing stay internal
      evidence: this.evidenceView(d),
    };
  }

  private evidenceView(d: Full) {
    return d.evidence.map((e) =>
      e.photo
        ? { kind: 'BOOKING_PHOTO' as const, id: e.photo.id, fileName: e.photo.fileName, mimeType: e.photo.mimeType }
        : { kind: 'CHAT_MESSAGE' as const, id: e.message!.id, seq: e.message!.seq, senderRole: e.message!.senderRole, body: e.message!.body, createdAt: e.message!.createdAt.toISOString() },
    );
  }

  /** Every referenced item must exist, belong to THIS booking, and (photos) be a finished upload. */
  private async assertEvidence(tx: Tx, bookingId: string, photoIds: string[], messageIds: string[]): Promise<void> {
    if (photoIds.length) {
      const found = await tx.bookingPhoto.count({ where: { id: { in: photoIds }, bookingId, status: 'UPLOADED' } });
      if (found !== photoIds.length) throw badRequest('EVIDENCE_NOT_FOUND', 'Some photos do not belong to this booking or are not uploaded');
    }
    if (messageIds.length) {
      const found = await tx.chatMessage.count({ where: { id: { in: messageIds }, bookingId } });
      if (found !== messageIds.length) throw badRequest('EVIDENCE_NOT_FOUND', 'Some messages do not belong to this booking');
    }
  }

  private async attachEvidence(tx: Tx, disputeId: string, userId: string, photoIds: string[], messageIds: string[]): Promise<void> {
    const rows = [...photoIds.map((id) => ({ disputeId, addedById: userId, bookingPhotoId: id })), ...messageIds.map((id) => ({ disputeId, addedById: userId, chatMessageId: id }))];
    if (rows.length) await tx.disputeEvidence.createMany({ data: rows, skipDuplicates: true });
  }
}
