import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiError, unavailable } from '../../common/errors/api-error.js';
import { APP_CONFIG, type AppConfig } from '../../config/app.config.js';
import type { ScanStatus } from '../../generated/prisma/client.js';
import { DocumentStorage } from '../workers/storage/document-storage.js';
import { type ContentProblem, checkContent } from './file-signature.js';
import { FileScanner } from './file-scanner.js';

export interface IntakeInput {
  storageKey: string;
  declaredMime: string;
  declaredSize: number;
  /** Category ceiling (the global STORAGE_MAX_FILE_BYTES also applies). */
  categoryMaxBytes: number;
  allowedMimes: readonly string[];
}

export interface IntakeResult {
  /** Null when the adapter cannot read bytes (the development stand-in): the file is then NOT content-verified. */
  contentVerifiedAt: Date | null;
  /**
   * NOT_SCANNED: no scanner configured. PENDING: a real (deferred) scanner will scan the whole object; the caller MUST queue it with
   * FileScanService.enqueue in the same transaction that marks the file uploaded. CLEAN/INFECTED/ERROR: an inline scanner answered.
   */
  scanStatus: ScanStatus;
}

/** The uploaded object is not acceptable. The caller removes the metadata row and queues the object for deletion. */
export class FileRejectedError extends ApiError {
  constructor(
    readonly problem: ContentProblem | 'INFECTED',
  ) {
    super(HttpStatus.UNPROCESSABLE_ENTITY, problem === 'INFECTED' ? 'FILE_REJECTED_BY_SCAN' : 'FILE_CONTENT_INVALID', 'The uploaded file was rejected', {
      details: { reason: problem },
    });
  }
}

/**
 * Server-side verification of an upload, run when the client says it has finished uploading.
 * The client's declarations (name, Content-Type, size) are never trusted: the stored object is read and
 * judged by its real size and file signature, then handed to the scanner.
 */
@Injectable()
export class FileIntakeService {
  private readonly logger = new Logger(FileIntakeService.name);
  private readonly globalMax: number;

  constructor(
    config: ConfigService,
    private readonly storage: DocumentStorage,
    private readonly scanner: FileScanner,
  ) {
    this.globalMax = config.getOrThrow<AppConfig>(APP_CONFIG).storage.maxFileBytes;
  }

  async verify(input: IntakeInput): Promise<IntakeResult> {
    const inspection = await this.guarded(() => this.storage.inspect(input.storageKey));
    if (inspection === null) throw new ApiError(HttpStatus.CONFLICT, 'UPLOAD_NOT_FOUND', 'The file has not been uploaded yet');
    if (inspection === 'UNINSPECTABLE') {
      if (!(await this.guarded(() => this.storage.exists(input.storageKey)))) throw new ApiError(HttpStatus.CONFLICT, 'UPLOAD_NOT_FOUND', 'The file has not been uploaded yet');
      return { contentVerifiedAt: null, scanStatus: 'NOT_SCANNED' };
    }

    const problem = checkContent({
      declaredMime: input.declaredMime,
      declaredSize: input.declaredSize,
      actualSize: inspection.sizeBytes,
      head: inspection.head,
      maxBytes: Math.min(this.globalMax, input.categoryMaxBytes),
      allowed: input.allowedMimes,
    });
    if (problem) throw new FileRejectedError(problem);

    // A real scanner reads the whole object later, through the scan queue. Until it reports, the file is PENDING: never clean.
    if (this.scanner.deferred) return { contentVerifiedAt: new Date(), scanStatus: 'PENDING' };

    let scan: ScanStatus;
    try {
      scan = await this.scanner.scan({ storageKey: input.storageKey, head: inspection.head, sizeBytes: inspection.sizeBytes });
    } catch (err) {
      this.logger.warn(`Scanner failed: ${(err as Error).name}`); // never the key or content
      scan = 'ERROR';
    }
    if (scan === 'INFECTED') throw new FileRejectedError('INFECTED');
    return { contentVerifiedAt: new Date(), scanStatus: scan };
  }

  /**
   * An unreachable or failing object store is a temporary 503 for the client (who may confirm again), never a rejection of the
   * file and never a bare 500. Deliberate API errors (for example "storage not configured") pass through unchanged.
   */
  private async guarded<T>(read: () => Promise<T>): Promise<T> {
    try {
      return await read();
    } catch (err) {
      if (err instanceof ApiError) throw err;
      const text = (err as Error | undefined)?.message ?? '';
      this.logger.error(`Object storage check failed: ${/^[A-Z][A-Z0-9_]{2,60}$/.test(text) ? text : ((err as Error | undefined)?.name ?? 'Error')}`); // a code such as STORAGE_ERROR_403, never a URL or raw message
      throw unavailable('STORAGE_UNAVAILABLE', 'File storage is temporarily unavailable. Please try again shortly');
    }
  }
}
