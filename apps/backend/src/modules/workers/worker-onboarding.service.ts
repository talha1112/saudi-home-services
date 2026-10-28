import { randomUUID } from 'node:crypto';
import { HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiError, badRequest, forbidden } from '../../common/errors/api-error.js';
import { APP_CONFIG, type AppConfig, type WorkersConfig } from '../../config/app.config.js';
import { PrismaService } from '../../database/prisma.service.js';
import { DocumentStatus, Prisma, VerificationAction, WorkerVerificationStatus } from '../../generated/prisma/client.js';
import { AuditService } from '../auth/audit.service.js';
import type { ClientMeta } from '../auth/auth.types.js';
import { toCityDto, toServiceDto } from '../catalog/catalog.service.js';
import { toAvailabilityRows, toWindow } from './availability.js';
import type {
  ConfirmDocumentDto,
  DocumentUploadDto,
  RegisterDocumentDto,
  SetWorkerAreasDto,
  SetWorkerAvailabilityDto,
  SetWorkerServicesDto,
  UpdateWorkerProfileDto,
  VerificationStatusDto,
  WorkerDocumentDto,
  WorkerOnboardingDto,
} from './dto/worker-onboarding.dto.js';
import { FileIntakeService, FileRejectedError } from '../storage/file-intake.service.js';
import { FileScanService } from '../storage/file-scan.service.js';
import { isServable } from '../storage/file-access.js';
import { StorageDeletionService } from '../storage/storage-deletion.service.js';
import { ALLOWED_DOCUMENT_MIME_TYPES, MAX_DOCUMENT_BYTES } from './dto/worker-onboarding.dto.js';
import { DocumentStorage } from './storage/document-storage.js';
import {
  DOCUMENTS_DELETABLE,
  SUBMITTABLE,
  missingForSubmission,
  type OnboardingSnapshot,
} from './verification-workflow.js';

const MAX_DOCUMENTS = 20;

const notFound = (what: string) => new ApiError(HttpStatus.NOT_FOUND, 'NOT_FOUND', `${what} not found`);
const conflict = (code: string, message: string, details?: Record<string, unknown>) =>
  new ApiError(HttpStatus.CONFLICT, code, message, details ? { details } : {});

const FULL_INCLUDE = {
  user: { select: { fullName: true, fullNameAr: true } },
  services: { include: { service: true }, orderBy: { createdAt: 'asc' as const } },
  serviceAreas: { include: { city: true } },
  availability: { orderBy: [{ dayOfWeek: 'asc' as const }, { startMinute: 'asc' as const }] },
  documents: { orderBy: { createdAt: 'asc' as const } },
  verificationEvents: { orderBy: { createdAt: 'desc' as const } },
} satisfies Prisma.WorkerProfileInclude;

type FullProfile = Prisma.WorkerProfileGetPayload<{ include: typeof FULL_INCLUDE }>;

/** Everything a worker does to get onboarded and verified: profile, services, areas, availability, documents, submission. */
@Injectable()
export class WorkerOnboardingService {
  private readonly cfg: WorkersConfig;
  private readonly maxFileBytes: number;
  private readonly uploadUrlTtl: number;
  private readonly photoUrlTtl: number;
  private readonly requireCleanScan: boolean;

  constructor(
    config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly storage: DocumentStorage,
    private readonly audit: AuditService,
    private readonly intake: FileIntakeService,
    private readonly deletions: StorageDeletionService,
    private readonly scans: FileScanService,
  ) {
    this.cfg = config.getOrThrow<AppConfig>(APP_CONFIG).workers;
    this.maxFileBytes = config.getOrThrow<AppConfig>(APP_CONFIG).storage.maxFileBytes;
    this.uploadUrlTtl = config.getOrThrow<AppConfig>(APP_CONFIG).storage.urlTtl.upload;
    this.photoUrlTtl = config.getOrThrow<AppConfig>(APP_CONFIG).storage.urlTtl.identityDocumentView;
    this.requireCleanScan = config.getOrThrow<AppConfig>(APP_CONFIG).storage.requireCleanScan;
  }

  // ------------------------------------------------------------------- reads

  /** A short-lived link to the worker's own profile photo, or null while there is none (or it is not yet safe to show). */
  async profilePhoto(userId: string): Promise<{ url: string | null; expiresAt: string | null }> {
    const profile = await this.load(userId);
    const photo = profile.documents
      .filter((d) => d.type === 'PHOTO' && d.status !== DocumentStatus.PENDING_UPLOAD && d.status !== DocumentStatus.REJECTED && isServable(d.scanStatus, this.requireCleanScan))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
    if (!photo) return { url: null, expiresAt: null };
    const target = await this.storage.createDownloadTarget(photo.storageKey, this.photoUrlTtl);
    return { url: target.url, expiresAt: target.expiresAt.toISOString() };
  }

  async overview(userId: string): Promise<WorkerOnboardingDto> {
    return this.toOverview(await this.load(userId));
  }

  async verificationStatus(userId: string): Promise<VerificationStatusDto> {
    return this.toVerification(await this.load(userId));
  }

  async listDocuments(userId: string): Promise<{ items: WorkerDocumentDto[] }> {
    const profile = await this.load(userId);
    return { items: profile.documents.map(toDocumentDto) };
  }

  // ------------------------------------------------------------------ writes

  async updateProfile(userId: string, dto: UpdateWorkerProfileDto): Promise<WorkerOnboardingDto> {
    const profile = await this.loadEditable(userId);
    await this.prisma.$transaction(async (tx) => {
      if (dto.fullName !== undefined || dto.fullNameAr !== undefined) {
        await tx.user.update({
          where: { id: userId },
          data: { fullName: dto.fullName, fullNameAr: dto.fullNameAr },
        });
      }
      await tx.workerProfile.update({
        where: { id: profile.id },
        data: { bio: dto.bio, yearsOfExperience: dto.yearsOfExperience },
      });
    });
    return this.overview(userId);
  }

  async setServices(userId: string, dto: SetWorkerServicesDto): Promise<WorkerOnboardingDto> {
    const profile = await this.loadEditable(userId);
    const ids = dto.services.map((s) => s.serviceId);
    if (new Set(ids).size !== ids.length) throw badRequest('DUPLICATE_SERVICE', 'Each service can be selected once');

    const found = await this.prisma.service.findMany({
      where: { id: { in: ids }, isActive: true, category: { isActive: true } },
      select: { id: true },
    });
    if (found.length !== ids.length) {
      throw badRequest('INVALID_SERVICE', 'One or more selected services do not exist or are not available');
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.workerService.deleteMany({ where: { workerProfileId: profile.id } });
      await tx.workerService.createMany({
        data: dto.services.map((s) => ({
          workerProfileId: profile.id,
          serviceId: s.serviceId,
          yearsOfExperience: s.yearsOfExperience ?? null,
        })),
      });
    });
    return this.overview(userId);
  }

  async setAreas(userId: string, dto: SetWorkerAreasDto): Promise<WorkerOnboardingDto> {
    const profile = await this.loadEditable(userId);
    const found = await this.prisma.city.findMany({ where: { id: { in: dto.cityIds }, isActive: true }, select: { id: true } });
    if (found.length !== dto.cityIds.length) {
      throw badRequest('INVALID_CITY', 'One or more selected cities do not exist or are not available');
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.workerServiceArea.deleteMany({ where: { workerProfileId: profile.id } });
      await tx.workerServiceArea.createMany({
        data: dto.cityIds.map((cityId) => ({ workerProfileId: profile.id, cityId })),
      });
    });
    return this.overview(userId);
  }

  async setAvailability(userId: string, dto: SetWorkerAvailabilityDto): Promise<WorkerOnboardingDto> {
    const profile = await this.loadEditable(userId);
    const rows = toAvailabilityRows(dto.windows);
    await this.prisma.$transaction(async (tx) => {
      await tx.workerAvailability.deleteMany({ where: { workerProfileId: profile.id } });
      await tx.workerAvailability.createMany({ data: rows.map((r) => ({ ...r, workerProfileId: profile.id })) });
    });
    return this.overview(userId);
  }

  // --------------------------------------------------------------- documents

  /** Step 1: register the file and get a signed URL to upload it to. The bytes never pass through this API. */
  async registerDocument(userId: string, dto: RegisterDocumentDto): Promise<DocumentUploadDto> {
    const profile = await this.loadEditable(userId);
    if (profile.documents.length >= MAX_DOCUMENTS) {
      throw conflict('DOCUMENT_LIMIT', `A worker can keep at most ${MAX_DOCUMENTS} documents`);
    }
    if (dto.sizeBytes > this.maxFileBytes) throw new ApiError(HttpStatus.BAD_REQUEST, 'FILE_TOO_LARGE', 'The file is larger than the allowed size', { details: { maxBytes: this.maxFileBytes } });
    const id = randomUUID();
    const storageKey = `workers/${profile.id}/documents/${id}`;
    // Ask storage first: if it is down nothing is left half-created.
    const target = await this.storage.createUploadTarget({
      storageKey,
      mimeType: dto.mimeType,
      sizeBytes: dto.sizeBytes,
      ttlSeconds: this.uploadUrlTtl,
    });
    const document = await this.prisma.workerVerificationDocument.create({
      data: {
        id,
        workerProfileId: profile.id,
        type: dto.type,
        storageKey,
        fileName: dto.fileName,
        mimeType: dto.mimeType,
        sizeBytes: dto.sizeBytes,
        expiresOn: dto.expiresOn ? new Date(dto.expiresOn) : null,
      },
    });
    return {
      document: toDocumentDto(document),
      uploadUrl: target.uploadUrl,
      method: target.method,
      headers: target.headers,
      expiresAt: target.expiresAt.toISOString(),
    };
  }

  /** Step 2: after uploading, confirm so the document counts toward verification. */
  async confirmDocument(userId: string, documentId: string, dto: ConfirmDocumentDto): Promise<WorkerDocumentDto> {
    const profile = await this.loadEditable(userId);
    const doc = profile.documents.find((d) => d.id === documentId);
    if (!doc) throw notFound('Document');
    if (doc.status !== DocumentStatus.PENDING_UPLOAD) return toDocumentDto(doc); // idempotent
    // The server reads the stored object and judges it itself: real size, file signature, scan.
    let checked;
    try {
      checked = await this.intake.verify({
        storageKey: doc.storageKey,
        declaredMime: doc.mimeType,
        declaredSize: doc.sizeBytes,
        categoryMaxBytes: MAX_DOCUMENT_BYTES,
        allowedMimes: ALLOWED_DOCUMENT_MIME_TYPES,
      });
    } catch (err) {
      if (err instanceof FileRejectedError) {
        // Drop the metadata so nothing implies a usable upload, and queue the object for removal.
        await this.prisma.$transaction(async (tx) => {
          await tx.workerVerificationDocument.deleteMany({ where: { id: doc.id, status: DocumentStatus.PENDING_UPLOAD } });
          await this.deletions.enqueue(tx, doc.storageKey, 'rejected-upload');
        });
      }
      throw err;
    }
    // Compare-and-set on the pending state; the scan job is queued in the same transaction.
    const updated = await this.prisma.$transaction(async (tx) => {
      const res = await tx.workerVerificationDocument.updateMany({
        where: { id: doc.id, status: DocumentStatus.PENDING_UPLOAD },
        data: { status: DocumentStatus.UPLOADED, checksumSha256: dto.checksumSha256 ?? null, scanStatus: checked.scanStatus, contentVerifiedAt: checked.contentVerifiedAt },
      });
      if (res.count === 1 && checked.scanStatus === 'PENDING') await this.scans.enqueue(tx, { storageKey: doc.storageKey, subject: 'WORKER_DOCUMENT', subjectId: doc.id });
      return tx.workerVerificationDocument.findUnique({ where: { id: doc.id } });
    });
    if (!updated) throw notFound('Document');
    return toDocumentDto(updated);
  }

  async deleteDocument(userId: string, documentId: string): Promise<void> {
    const profile = await this.loadEditable(userId);
    const doc = profile.documents.find((d) => d.id === documentId);
    if (!doc) throw notFound('Document');
    if (!DOCUMENTS_DELETABLE.includes(profile.verificationStatus)) {
      throw conflict('DOCUMENTS_LOCKED', 'Documents cannot be removed while the application is under review or approved');
    }
    // Metadata and the removal request change together; the stored object is removed by a retried job, so a storage outage cannot block or half-apply the delete.
    await this.prisma.$transaction(async (tx) => {
      await tx.workerVerificationDocument.delete({ where: { id: doc.id } });
      await this.deletions.enqueue(tx, doc.storageKey, 'owner-deleted');
    });
  }

  // -------------------------------------------------------------- submission

  async submit(userId: string, meta: ClientMeta): Promise<VerificationStatusDto> {
    const profile = await this.loadEditable(userId);
    if (!SUBMITTABLE.includes(profile.verificationStatus)) {
      throw conflict('INVALID_STATE', `An application in status ${profile.verificationStatus} cannot be submitted`);
    }
    const missing = missingForSubmission(this.snapshot(profile), this.cfg.requireIdentityDocument);
    if (missing.length > 0) {
      throw conflict('VERIFICATION_INCOMPLETE', 'Complete the required information before submitting', { missing });
    }

    const from = profile.verificationStatus;
    await this.prisma.$transaction(async (tx) => {
      const moved = await tx.workerProfile.updateMany({
        where: { id: profile.id, verificationStatus: { in: SUBMITTABLE } },
        data: {
          verificationStatus: WorkerVerificationStatus.SUBMITTED,
          verificationSubmittedAt: new Date(),
          verificationNote: null,
        },
      });
      if (moved.count !== 1) throw conflict('INVALID_STATE', 'The application changed, please reload');
      await tx.workerVerificationEvent.create({
        data: {
          workerProfileId: profile.id,
          action: VerificationAction.SUBMITTED,
          fromStatus: from,
          toStatus: WorkerVerificationStatus.SUBMITTED,
          actorUserId: userId,
        },
      });
    });
    await this.audit.record({
      action: 'worker.verification.submitted',
      actorUserId: userId,
      entityType: 'worker_profile',
      entityId: profile.id,
      metadata: { from },
      ipAddress: meta.ip,
      userAgent: meta.userAgent,
    });
    return this.verificationStatus(userId);
  }

  // ----------------------------------------------------------------- helpers

  private async load(userId: string): Promise<FullProfile> {
    const profile = await this.prisma.workerProfile.findUnique({ where: { userId }, include: FULL_INCLUDE });
    if (!profile) throw notFound('Worker profile');
    return profile;
  }

  /** Profile data may be edited in every state except SUSPENDED. */
  private async loadEditable(userId: string): Promise<FullProfile> {
    const profile = await this.load(userId);
    if (profile.verificationStatus === WorkerVerificationStatus.SUSPENDED) {
      throw forbidden('WORKER_SUSPENDED', 'Your worker account is suspended. Contact support');
    }
    return profile;
  }

  private snapshot(profile: FullProfile): OnboardingSnapshot {
    return {
      fullName: profile.user.fullName ?? profile.user.fullNameAr,
      yearsOfExperience: profile.yearsOfExperience,
      serviceCount: profile.services.length,
      areaCount: profile.serviceAreas.length,
      availabilityCount: profile.availability.length,
      documents: profile.documents.map((d) => ({ type: d.type, status: d.status })),
    };
  }

  private toVerification(profile: FullProfile): VerificationStatusDto {
    const missing = missingForSubmission(this.snapshot(profile), this.cfg.requireIdentityDocument);
    return {
      status: profile.verificationStatus,
      note: profile.verificationNote,
      submittedAt: profile.verificationSubmittedAt?.toISOString() ?? null,
      verifiedAt: profile.verifiedAt?.toISOString() ?? null,
      canSubmit: SUBMITTABLE.includes(profile.verificationStatus) && missing.length === 0,
      missing,
      // The worker sees what happened and why, but not which admin decided.
      history: profile.verificationEvents.map((e) => ({
        action: e.action,
        fromStatus: e.fromStatus,
        toStatus: e.toStatus,
        reason: e.reason,
        createdAt: e.createdAt.toISOString(),
      })),
    };
  }

  private toOverview(profile: FullProfile): WorkerOnboardingDto {
    return {
      profile: {
        id: profile.id,
        fullName: profile.user.fullName,
        fullNameAr: profile.user.fullNameAr,
        bio: profile.bio,
        yearsOfExperience: profile.yearsOfExperience,
        isOnline: profile.isOnline,
      },
      services: profile.services.map((ws) => ({ ...toServiceDto(ws.service), workerYearsOfExperience: ws.yearsOfExperience })),
      cities: profile.serviceAreas.map((a) => toCityDto(a.city)),
      availability: profile.availability.map(toWindow),
      documents: profile.documents.map(toDocumentDto),
      verification: this.toVerification(profile),
    };
  }
}

/** Allow-list: storageKey and checksum never leave the API through worker or public endpoints. */
export function toDocumentDto(d: {
  id: string;
  type: WorkerDocumentDto['type'];
  status: WorkerDocumentDto['status'];
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  expiresOn: Date | null;
  reviewNote: string | null;
  scanStatus: WorkerDocumentDto['scanStatus'];
  createdAt: Date;
}): WorkerDocumentDto {
  return {
    id: d.id,
    type: d.type,
    status: d.status,
    fileName: d.fileName,
    mimeType: d.mimeType,
    sizeBytes: d.sizeBytes,
    expiresOn: d.expiresOn ? d.expiresOn.toISOString().slice(0, 10) : null,
    reviewNote: d.reviewNote,
    scanStatus: d.scanStatus,
    createdAt: d.createdAt.toISOString(),
  };
}
