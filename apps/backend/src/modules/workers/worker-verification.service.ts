import { HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiError, badRequest } from '../../common/errors/api-error.js';
import { type Page, toPage } from '../../common/pagination/pagination.js';
import { APP_CONFIG, type AppConfig, type WorkersConfig } from '../../config/app.config.js';
import { PrismaService } from '../../database/prisma.service.js';
import { DocumentStatus, Prisma, UserStatus, WorkerVerificationStatus } from '../../generated/prisma/client.js';
import { AuditService } from '../auth/audit.service.js';
import type { ClientMeta } from '../auth/auth.types.js';
import { toCityDto, toServiceDto } from '../catalog/catalog.service.js';
import { toWindow } from './availability.js';
import type {
  AdminDocumentDto,
  AdminWorkerDetailDto,
  AdminWorkerListItemDto,
  DocumentDownloadDto,
  ListWorkersQueryDto,
  ReviewDocumentDto,
} from './dto/admin-workers.dto.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import type { NotificationType } from '../notifications/notification-templates.js';
import { isServable, unavailableReason } from '../storage/file-access.js';
import { DocumentStorage } from './storage/document-storage.js';
import {
  type ReviewAction,
  TRANSITIONS,
  hasUsableIdentityDocument,
  missingForSubmission,
} from './verification-workflow.js';

const VERIFICATION_NOTIFICATIONS: Partial<Record<ReviewAction, NotificationType>> = {
  approve: 'verification.approved',
  reject: 'verification.rejected',
  request_info: 'verification.info_requested',
  suspend: 'verification.suspended',
  reinstate: 'verification.reinstated',
};

const PENDING: WorkerVerificationStatus[] = [WorkerVerificationStatus.SUBMITTED, WorkerVerificationStatus.UNDER_REVIEW];

const notFound = (what: string) => new ApiError(HttpStatus.NOT_FOUND, 'NOT_FOUND', `${what} not found`);
const conflict = (code: string, message: string, details?: Record<string, unknown>) =>
  new ApiError(HttpStatus.CONFLICT, code, message, details ? { details } : {});

const DETAIL_INCLUDE = {
  user: { select: { id: true, fullName: true, fullNameAr: true, phone: true, email: true, status: true } },
  services: { include: { service: true }, orderBy: { createdAt: 'asc' as const } },
  serviceAreas: { include: { city: true } },
  availability: { orderBy: [{ dayOfWeek: 'asc' as const }, { startMinute: 'asc' as const }] },
  documents: { orderBy: { createdAt: 'asc' as const } },
  verificationEvents: { orderBy: { createdAt: 'desc' as const }, include: { actor: { select: { fullName: true } } } },
} satisfies Prisma.WorkerProfileInclude;

type DetailProfile = Prisma.WorkerProfileGetPayload<{ include: typeof DETAIL_INCLUDE }>;

/** Administrator side of worker verification: the review queue, decisions with reasons, and document review. */
@Injectable()
export class WorkerVerificationService {
  private readonly cfg: WorkersConfig;

  private readonly requireCleanScan: boolean;
  private readonly identityUrlTtl: number;

  constructor(
    config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly storage: DocumentStorage,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {
    this.cfg = config.getOrThrow<AppConfig>(APP_CONFIG).workers;
    this.requireCleanScan = config.getOrThrow<AppConfig>(APP_CONFIG).storage.requireCleanScan;
    this.identityUrlTtl = config.getOrThrow<AppConfig>(APP_CONFIG).storage.urlTtl.identityDocumentView;
  }

  // ------------------------------------------------------------------- reads

  async list(query: ListWorkersQueryDto): Promise<Page<AdminWorkerListItemDto>> {
    const statuses = query.status?.includes('ALL')
      ? undefined
      : ((query.status as WorkerVerificationStatus[] | undefined) ?? PENDING);

    const where: Prisma.WorkerProfileWhereInput = {
      ...(statuses ? { verificationStatus: { in: statuses } } : {}),
      ...(query.cityId ? { serviceAreas: { some: { cityId: query.cityId } } } : {}),
      ...(query.serviceId ? { services: { some: { serviceId: query.serviceId } } } : {}),
      ...(query.q
        ? {
            user: {
              OR: [
                { fullName: { contains: query.q, mode: 'insensitive' } },
                { fullNameAr: { contains: query.q, mode: 'insensitive' } },
                { phone: { contains: query.q } },
              ],
            },
          }
        : {}),
    };
    const direction = query.sort === 'newest' ? ('desc' as const) : ('asc' as const);
    const [rows, total] = await Promise.all([
      this.prisma.workerProfile.findMany({
        where,
        orderBy: [{ verificationSubmittedAt: { sort: direction, nulls: 'last' } }, { createdAt: direction }],
        skip: query.skip,
        take: query.limit,
        include: {
          user: { select: { fullName: true, fullNameAr: true, phone: true } },
          _count: { select: { services: true, serviceAreas: true, documents: true } },
        },
      }),
      this.prisma.workerProfile.count({ where }),
    ]);
    return toPage(
      rows.map((r) => ({
        id: r.id,
        userId: r.userId,
        fullName: r.user.fullName,
        fullNameAr: r.user.fullNameAr,
        phone: r.user.phone,
        verificationStatus: r.verificationStatus,
        submittedAt: r.verificationSubmittedAt?.toISOString() ?? null,
        serviceCount: r._count.services,
        cityCount: r._count.serviceAreas,
        documentCount: r._count.documents,
      })),
      total,
      query,
    );
  }

  async detail(workerId: string): Promise<AdminWorkerDetailDto> {
    const profile = await this.prisma.workerProfile.findUnique({ where: { id: workerId }, include: DETAIL_INCLUDE });
    if (!profile) throw notFound('Worker');
    return this.toDetail(profile);
  }

  // --------------------------------------------------------------- decisions

  /**
   * Applies one allowed transition atomically. The status check is part of the UPDATE, so two
   * admins deciding at the same moment cannot both win; the second gets 409.
   */
  async decide(workerId: string, action: ReviewAction, adminId: string, reason: string | undefined, meta: ClientMeta): Promise<AdminWorkerDetailDto> {
    const transition = TRANSITIONS[action];
    const cleanReason = reason?.trim() || undefined;
    if (transition.reasonRequired && !cleanReason) {
      throw badRequest('REASON_REQUIRED', 'A reason is required for this decision');
    }

    const from = await this.prisma.$transaction(async (tx) => {
      const profile = await tx.workerProfile.findUnique({
        where: { id: workerId },
        include: { user: { select: { status: true, fullName: true, fullNameAr: true } }, documents: true, services: true, serviceAreas: true, availability: true },
      });
      if (!profile) throw notFound('Worker');
      if (!transition.from.includes(profile.verificationStatus)) {
        throw conflict('INVALID_STATE', `Cannot ${action.replace('_', ' ')} a worker whose status is ${profile.verificationStatus}`, {
          status: profile.verificationStatus,
          allowedFrom: transition.from,
        });
      }

      if (action === 'approve' || action === 'reinstate') {
        if (profile.user.status !== UserStatus.ACTIVE) {
          throw conflict('ACCOUNT_NOT_ACTIVE', 'The worker account itself is not active');
        }
      }
      if (action === 'approve') {
        // The submission rules must still hold (the worker could have edited data during review),
        // and the identity document must have been accepted by a reviewer, not merely uploaded.
        const missing = missingForSubmission(
          {
            fullName: profile.user.fullName ?? profile.user.fullNameAr,
            yearsOfExperience: profile.yearsOfExperience,
            serviceCount: profile.services.length,
            areaCount: profile.serviceAreas.length,
            availabilityCount: profile.availability.length,
            documents: [],
          },
          false,
        );
        if (missing.length > 0) throw conflict('PROFILE_INCOMPLETE', 'The worker profile is incomplete', { missing });
        if (this.cfg.requireIdentityDocument && !hasUsableIdentityDocument(profile.documents, [DocumentStatus.ACCEPTED])) {
          throw conflict('IDENTITY_DOCUMENT_NOT_ACCEPTED', 'Accept an identity document (national ID or iqama) before approving');
        }
      }

      const moved = await tx.workerProfile.updateMany({
        where: { id: workerId, verificationStatus: { in: transition.from } },
        data: {
          verificationStatus: transition.to,
          verificationNote: cleanReason ?? null,
          ...(action === 'approve' ? { verifiedAt: new Date() } : {}),
          ...(action === 'suspend' ? { isOnline: false } : {}),
        },
      });
      if (moved.count !== 1) throw conflict('INVALID_STATE', 'The application was changed by someone else, please reload');

      const verificationEvent = await tx.workerVerificationEvent.create({
        data: {
          workerProfileId: workerId,
          action: transition.event,
          fromStatus: profile.verificationStatus,
          toStatus: transition.to,
          actorUserId: adminId,
          reason: cleanReason ?? null,
        },
      });
      // Written in the SAME transaction as the decision: it exists only if the decision committed, and the unique
      // source key makes a repeat impossible. The reviewer's note is deliberately NOT part of the notification.
      const notificationType = VERIFICATION_NOTIFICATIONS[action];
      if (notificationType) {
        await this.notifications.create(tx, {
          userId: profile.userId,
          type: notificationType,
          sourceKey: `verification:${verificationEvent.id}`,
          params: {},
          resource: { type: 'worker_verification', id: workerId },
        });
      }
      return profile.verificationStatus;
    });

    await this.audit.record({
      action: `worker.verification.${action}`,
      actorUserId: adminId,
      entityType: 'worker_profile',
      entityId: workerId,
      metadata: { from, to: transition.to, hasReason: Boolean(cleanReason) },
      ipAddress: meta.ip,
      userAgent: meta.userAgent,
    });
    return this.detail(workerId);
  }

  // --------------------------------------------------------------- documents

  async reviewDocument(workerId: string, documentId: string, adminId: string, dto: ReviewDocumentDto, meta: ClientMeta): Promise<AdminDocumentDto> {
    const doc = await this.findDocument(workerId, documentId);
    if (doc.status === DocumentStatus.PENDING_UPLOAD) {
      throw conflict('DOCUMENT_NOT_UPLOADED', 'The worker has not finished uploading this document');
    }
    const note = dto.note?.trim() || null;
    if (dto.status === DocumentStatus.REJECTED && !note) {
      throw badRequest('REASON_REQUIRED', 'A note is required when rejecting a document');
    }
    const updated = await this.prisma.workerVerificationDocument.update({
      where: { id: doc.id },
      data: { status: dto.status, reviewNote: note, reviewedById: adminId, reviewedAt: new Date() },
    });
    await this.audit.record({
      action: `worker.document.${dto.status.toLowerCase()}`,
      actorUserId: adminId,
      entityType: 'worker_verification_document',
      entityId: doc.id,
      metadata: { workerId, type: doc.type },
      ipAddress: meta.ip,
      userAgent: meta.userAgent,
    });
    return toAdminDocument(updated);
  }

  /** Viewing a private document is itself an audited event. */
  async documentDownload(workerId: string, documentId: string, adminId: string, meta: ClientMeta): Promise<DocumentDownloadDto> {
    const doc = await this.findDocument(workerId, documentId);
    if (doc.status === DocumentStatus.PENDING_UPLOAD) {
      throw conflict('DOCUMENT_NOT_UPLOADED', 'The worker has not finished uploading this document');
    }
    if (!isServable(doc.scanStatus, this.requireCleanScan)) {
      throw new ApiError(409, 'FILE_NOT_AVAILABLE', 'This file is not available', { details: { reason: unavailableReason(doc.scanStatus) } });
    }
    const target = await this.storage.createDownloadTarget(doc.storageKey, this.identityUrlTtl);
    await this.audit.record({
      action: 'worker.document.accessed',
      actorUserId: adminId,
      entityType: 'worker_verification_document',
      entityId: doc.id,
      metadata: { workerId, type: doc.type },
      ipAddress: meta.ip,
      userAgent: meta.userAgent,
    });
    return { url: target.url, expiresAt: target.expiresAt.toISOString() };
  }

  // ----------------------------------------------------------------- helpers

  private async findDocument(workerId: string, documentId: string) {
    const doc = await this.prisma.workerVerificationDocument.findFirst({ where: { id: documentId, workerProfileId: workerId } });
    if (!doc) throw notFound('Document');
    return doc;
  }

  private toDetail(p: DetailProfile): AdminWorkerDetailDto {
    return {
      id: p.id,
      userId: p.userId,
      fullName: p.user.fullName,
      fullNameAr: p.user.fullNameAr,
      phone: p.user.phone,
      email: p.user.email,
      accountStatus: p.user.status,
      bio: p.bio,
      yearsOfExperience: p.yearsOfExperience,
      verificationStatus: p.verificationStatus,
      verificationNote: p.verificationNote,
      submittedAt: p.verificationSubmittedAt?.toISOString() ?? null,
      verifiedAt: p.verifiedAt?.toISOString() ?? null,
      services: p.services.map((ws) => ({ ...toServiceDto(ws.service), workerYearsOfExperience: ws.yearsOfExperience })),
      cities: p.serviceAreas.map((a) => toCityDto(a.city)),
      availability: p.availability.map(toWindow),
      documents: p.documents.map(toAdminDocument),
      history: p.verificationEvents.map((e) => ({
        action: e.action,
        fromStatus: e.fromStatus,
        toStatus: e.toStatus,
        reason: e.reason,
        actorUserId: e.actorUserId,
        actorName: e.actor?.fullName ?? null,
        createdAt: e.createdAt.toISOString(),
      })),
    };
  }
}

function toAdminDocument(d: {
  id: string;
  type: AdminDocumentDto['type'];
  status: AdminDocumentDto['status'];
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  expiresOn: Date | null;
  reviewNote: string | null;
  reviewedAt: Date | null;
  createdAt: Date;
}): AdminDocumentDto {
  return {
    id: d.id,
    type: d.type,
    status: d.status,
    fileName: d.fileName,
    mimeType: d.mimeType,
    sizeBytes: d.sizeBytes,
    expiresOn: d.expiresOn ? d.expiresOn.toISOString().slice(0, 10) : null,
    reviewNote: d.reviewNote,
    reviewedAt: d.reviewedAt?.toISOString() ?? null,
    createdAt: d.createdAt.toISOString(),
  };
}
