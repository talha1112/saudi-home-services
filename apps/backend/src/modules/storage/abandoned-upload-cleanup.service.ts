import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_CONFIG, type AppConfig } from '../../config/app.config.js';
import { describeError } from '../../common/logging/safe-error.js';
import { PrismaService } from '../../database/prisma.service.js';
import { StorageDeletionService } from './storage-deletion.service.js';

export interface CleanupResult {
  photos: number;
  documents: number;
}

/**
 * Removes uploads that were registered but never confirmed.
 *
 * A client registers a file (a PENDING_UPLOAD row and a signed upload link of at most 60 minutes) and may never come back. Such a row,
 * and any object it uploaded, would stay forever. After STORAGE_ABANDONED_UPLOAD_MIN_AGE_MINUTES (at least 120, so every link has long
 * expired and no late upload can land after the cleanup) the row is deleted and its EXACT object key is handed to the removal queue, in
 * one transaction. Rules:
 *  - only rows still PENDING_UPLOAD and older than the cutoff; a confirmed (UPLOADED) file is never touched;
 *  - a photo cited as dispute evidence is never touched (the NOT EXISTS guard, and the database foreign key behind it);
 *  - rows are locked with FOR UPDATE SKIP LOCKED, so two workers never take the same row and a repeat run finds nothing to do;
 *  - the bucket is never listed: the only objects ever deleted are the keys of the rows deleted here;
 *  - the removal queue keeps its own safety (an object still referenced by a row is skipped) and its retries and backoff;
 *  - nothing is logged except counts.
 */
@Injectable()
export class AbandonedUploadCleanupService {
  private readonly logger = new Logger(AbandonedUploadCleanupService.name);
  private readonly minAgeMs: number;

  constructor(
    config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly deletions: StorageDeletionService,
  ) {
    this.minAgeMs = config.getOrThrow<AppConfig>(APP_CONFIG).storage.abandonedUploads.minAgeMinutes * 60_000;
  }

  async runOnce(now: Date = new Date(), batch = 100): Promise<CleanupResult> {
    const cutoff = new Date(now.getTime() - this.minAgeMs);
    try {
      return await this.prisma.$transaction(
        async (tx) => {
          const photos = await tx.$queryRaw<Array<{ storage_key: string }>>`
            WITH due AS (
              SELECT p.id FROM booking_photos p
              WHERE p.status = 'PENDING_UPLOAD' AND p.created_at < ${cutoff}
                AND NOT EXISTS (SELECT 1 FROM dispute_evidence e WHERE e.booking_photo_id = p.id)
              ORDER BY p.created_at, p.id LIMIT ${batch} FOR UPDATE SKIP LOCKED)
            DELETE FROM booking_photos WHERE id IN (SELECT id FROM due) AND status = 'PENDING_UPLOAD'
            RETURNING storage_key`;
          const documents = await tx.$queryRaw<Array<{ storage_key: string }>>`
            WITH due AS (
              SELECT d.id FROM worker_verification_documents d
              WHERE d.status = 'PENDING_UPLOAD' AND d.created_at < ${cutoff}
              ORDER BY d.created_at, d.id LIMIT ${batch} FOR UPDATE SKIP LOCKED)
            DELETE FROM worker_verification_documents WHERE id IN (SELECT id FROM due) AND status = 'PENDING_UPLOAD'
            RETURNING storage_key`;
          for (const row of [...photos, ...documents]) await this.deletions.enqueue(tx, row.storage_key, 'abandoned-upload');
          return { photos: photos.length, documents: documents.length };
        },
        { timeout: 30_000, maxWait: 5_000 },
      ).then((result) => {
        if (result.photos + result.documents > 0) this.logger.log(`Removed ${result.photos} abandoned photo uploads and ${result.documents} abandoned document uploads`);
        return result;
      });
    } catch (err) {
      this.logger.warn(`Abandoned-upload cleanup failed: ${describeError(err)}`);
      throw err;
    }
  }
}
