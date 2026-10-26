import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_CONFIG, type AppConfig } from '../../config/app.config.js';
import { PrismaService } from '../../database/prisma.service.js';
import { BookingStatus, PhotoStatus } from '../../generated/prisma/client.js';
import { isServable, unavailableReason } from '../storage/file-access.js';
import { FileIntakeService, FileRejectedError } from '../storage/file-intake.service.js';
import { FileScanService } from '../storage/file-scan.service.js';
import { StorageDeletionService } from '../storage/storage-deletion.service.js';
import { AuditService } from '../auth/audit.service.js';
import { DocumentStorage } from '../workers/storage/document-storage.js';
import { ApiError } from '../../common/errors/api-error.js';
import { conflict, notFound } from './booking-support.js';
import { BOOKING_PHOTO_MIME_TYPES, MAX_BOOKING_PHOTO_BYTES, type BookingPhotoDto, type PhotoDownloadDto, type PhotoUploadDto, type RegisterBookingPhotoDto } from './dto/bookings.dto.js';
import { QuotesService } from './quotes.service.js';

/** Photos may be added while the job is still being arranged, not after it is finished. */
const EDITABLE: BookingStatus[] = [BookingStatus.OPEN, BookingStatus.PAYMENT_PENDING, BookingStatus.CONFIRMED];

const toDto = (p: { id: string; status: BookingPhotoDto['status']; fileName: string; mimeType: string; sizeBytes: number; scanStatus: BookingPhotoDto['scanStatus'] }): BookingPhotoDto => ({
  id: p.id,
  status: p.status,
  scanStatus: p.scanStatus,
  fileName: p.fileName,
  mimeType: p.mimeType,
  sizeBytes: p.sizeBytes,
});

/** Optional problem photos. Bytes go straight to private storage; only metadata lives in the database. */
@Injectable()
export class BookingPhotosService {
  private readonly maxPhotos: number;
  private readonly uploadUrlTtl: number;
  private readonly viewUrlTtl: number;
  private readonly maxFileBytes: number;
  private readonly requireCleanScan: boolean;

  constructor(
    config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly storage: DocumentStorage,
    private readonly quotes: QuotesService,
    private readonly audit: AuditService,
    private readonly intake: FileIntakeService,
    private readonly deletions: StorageDeletionService,
    private readonly scans: FileScanService,
  ) {
    const app = config.getOrThrow<AppConfig>(APP_CONFIG);
    this.maxPhotos = app.bookings.maxPhotos;
    this.uploadUrlTtl = app.storage.urlTtl.upload;
    this.viewUrlTtl = app.storage.urlTtl.bookingPhotoView;
    this.maxFileBytes = app.storage.maxFileBytes;
    this.requireCleanScan = app.storage.requireCleanScan;
  }

  async register(customerId: string, bookingId: string, dto: RegisterBookingPhotoDto): Promise<PhotoUploadDto> {
    const booking = await this.ownedBooking(customerId, bookingId);
    if (!EDITABLE.includes(booking.status)) throw conflict('INVALID_STATE', 'Photos can no longer be added to this booking');
    if (booking.photos.length >= this.maxPhotos) throw conflict('PHOTO_LIMIT', `A booking can have at most ${this.maxPhotos} photos`);
    if (dto.sizeBytes > this.maxFileBytes) throw new ApiError(400, 'FILE_TOO_LARGE', 'The file is larger than the allowed size', { details: { maxBytes: this.maxFileBytes } });

    const id = randomUUID();
    const storageKey = `bookings/${bookingId}/photos/${id}`;
    // Storage first: if it is down, nothing is left half-created.
    const target = await this.storage.createUploadTarget({ storageKey, mimeType: dto.mimeType, sizeBytes: dto.sizeBytes, ttlSeconds: this.uploadUrlTtl });
    const photo = await this.prisma.bookingPhoto.create({
      data: { id, bookingId, storageKey, fileName: dto.fileName, mimeType: dto.mimeType, sizeBytes: dto.sizeBytes },
    });
    return { photo: toDto(photo), uploadUrl: target.uploadUrl, method: target.method, headers: target.headers, expiresAt: target.expiresAt.toISOString() };
  }

  async confirm(customerId: string, bookingId: string, photoId: string): Promise<BookingPhotoDto> {
    const booking = await this.ownedBooking(customerId, bookingId);
    const photo = booking.photos.find((p) => p.id === photoId);
    if (!photo) throw notFound('Photo');
    if (photo.status === PhotoStatus.UPLOADED) return toDto(photo);
    if (!EDITABLE.includes(booking.status)) throw conflict('INVALID_STATE', 'Photos can no longer be added to this booking');
    let checked;
    try {
      checked = await this.intake.verify({
        storageKey: photo.storageKey,
        declaredMime: photo.mimeType,
        declaredSize: photo.sizeBytes,
        categoryMaxBytes: MAX_BOOKING_PHOTO_BYTES,
        allowedMimes: BOOKING_PHOTO_MIME_TYPES,
      });
    } catch (err) {
      if (err instanceof FileRejectedError) {
        await this.prisma.$transaction(async (tx) => {
          await tx.bookingPhoto.deleteMany({ where: { id: photo.id, status: PhotoStatus.PENDING_UPLOAD } });
          await this.deletions.enqueue(tx, photo.storageKey, 'rejected-upload');
        });
      }
      throw err;
    }
    // Compare-and-set on the pending state (a repeated or racing confirm changes nothing twice); the scan job is queued in the same transaction.
    const confirmed = await this.prisma.$transaction(async (tx) => {
      const res = await tx.bookingPhoto.updateMany({
        where: { id: photo.id, status: PhotoStatus.PENDING_UPLOAD },
        data: { status: PhotoStatus.UPLOADED, scanStatus: checked.scanStatus, contentVerifiedAt: checked.contentVerifiedAt },
      });
      if (res.count === 1 && checked.scanStatus === 'PENDING') await this.scans.enqueue(tx, { storageKey: photo.storageKey, subject: 'BOOKING_PHOTO', subjectId: photo.id });
      return tx.bookingPhoto.findUnique({ where: { id: photo.id } });
    });
    if (!confirmed) throw notFound('Photo');
    return toDto(confirmed);
  }

  async remove(customerId: string, bookingId: string, photoId: string): Promise<void> {
    const booking = await this.ownedBooking(customerId, bookingId);
    const photo = booking.photos.find((p) => p.id === photoId);
    if (!photo) throw notFound('Photo');
    if (!EDITABLE.includes(booking.status)) throw conflict('INVALID_STATE', 'Photos can no longer be changed on this booking');
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.bookingPhoto.delete({ where: { id: photo.id } });
        await this.deletions.enqueue(tx, photo.storageKey, 'owner-deleted');
      });
    } catch (err) {
      // A photo cited as evidence in a dispute must be kept until the dispute process is over.
      if ((err as { code?: string }).code === 'P2003') throw conflict('PHOTO_IS_EVIDENCE', 'This photo is evidence in a dispute and cannot be removed');
      throw err;
    }
  }

  // ---- who may view a photo: the owner, an administrator, a worker who may quote on / is assigned to it

  forCustomer(customerId: string, bookingId: string, photoId: string): Promise<PhotoDownloadDto> {
    return this.link(photoId, { id: bookingId, customerId }, undefined);
  }

  async forWorker(workerUserId: string, bookingId: string, photoId: string): Promise<PhotoDownloadDto> {
    const worker = await this.quotes.workerContext(workerUserId);
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      select: { id: true, status: true, serviceId: true, cityId: true, workerProfileId: true },
    });
    const assigned = booking?.workerProfileId === worker.id;
    const canQuote = booking && booking.status === BookingStatus.OPEN && this.quotes.isEligible(worker, booking);
    if (!booking || !(assigned || canQuote)) throw notFound('Photo');
    return this.link(photoId, { id: bookingId }, undefined);
  }

  forAdmin(adminId: string, bookingId: string, photoId: string): Promise<PhotoDownloadDto> {
    return this.link(photoId, { id: bookingId }, adminId);
  }

  private async link(photoId: string, bookingWhere: { id: string; customerId?: string }, auditAdminId: string | undefined): Promise<PhotoDownloadDto> {
    const photo = await this.prisma.bookingPhoto.findFirst({
      where: { id: photoId, status: PhotoStatus.UPLOADED, booking: bookingWhere },
      select: { id: true, bookingId: true, storageKey: true, scanStatus: true },
    });
    if (!photo) throw notFound('Photo');
    if (!isServable(photo.scanStatus, this.requireCleanScan)) {
      throw new ApiError(409, 'FILE_NOT_AVAILABLE', 'This file is not available', { details: { reason: unavailableReason(photo.scanStatus) } });
    }
    const target = await this.storage.createDownloadTarget(photo.storageKey, this.viewUrlTtl);
    if (auditAdminId) {
      await this.audit.record({ action: 'booking.photo.accessed', actorUserId: auditAdminId, entityType: 'booking_photo', entityId: photo.id, metadata: { bookingId: photo.bookingId } });
    }
    return { url: target.url, expiresAt: target.expiresAt.toISOString() };
  }

  private async ownedBooking(customerId: string, bookingId: string) {
    const booking = await this.prisma.booking.findFirst({
      where: { id: bookingId, customerId },
      select: { id: true, status: true, photos: { select: { id: true, status: true, fileName: true, mimeType: true, sizeBytes: true, storageKey: true, scanStatus: true } } },
    });
    if (!booking) throw notFound('Booking');
    return booking;
  }
}
