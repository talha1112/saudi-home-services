import type { Readable } from 'node:stream';

export interface UploadTarget {
  /** Where the client sends the file bytes directly (never through this API). */
  uploadUrl: string;
  method: 'PUT';
  /** Headers the client must send with the upload. */
  headers: Record<string, string>;
  expiresAt: Date;
}

export interface DownloadTarget {
  url: string;
  expiresAt: Date;
}

/** What the server learned by reading the stored object itself. */
export interface ObjectInspection {
  sizeBytes: number;
  /** The first bytes of the object (at most 128), used to check the file signature. */
  head: Buffer;
}

/**
 * Contract for private object storage of identity and licence documents.
 *
 * This phase defines the interface only; a real adapter (S3-compatible, Azure Blob, ...) is
 * added later and selected in `workers.module.ts`. Rules every adapter must follow:
 *  - the bucket/container is PRIVATE; only short-lived signed URLs give access;
 *  - `storageKey` is an opaque path chosen by the API and contains no personal data;
 *  - credentials come from environment variables or the platform secret store;
 *  - never log URLs, keys' contents or file bytes.
 */
export abstract class DocumentStorage {
  /** Creates a short-lived signed upload target for `storageKey`. */
  abstract createUploadTarget(input: {
    storageKey: string;
    mimeType: string;
    sizeBytes: number;
    ttlSeconds: number;
  }): Promise<UploadTarget>;

  /** True when an object exists at `storageKey` (used to confirm that the client really uploaded). */
  abstract exists(storageKey: string): Promise<boolean>;

  /** Short-lived signed URL for an administrator to view the document. */
  abstract createDownloadTarget(storageKey: string, ttlSeconds: number): Promise<DownloadTarget>;

  /**
   * Reads the object's real size and first bytes. `null` = no such object. `'UNINSPECTABLE'` = this adapter
   * cannot read bytes (the development stand-in); callers then record the file as NOT content-verified.
   */
  async inspect(_storageKey: string): Promise<ObjectInspection | null | 'UNINSPECTABLE'> {
    return 'UNINSPECTABLE';
  }

  /**
   * Streams the WHOLE object, for a malware scanner. Server-side only: the stream is never handed to a client. Throws when the
   * object is missing or this adapter cannot read bytes (the development stand-in), which a scan treats as a failure, never as clean.
   */
  async openReadStream(_storageKey: string): Promise<Readable> {
    throw new Error('STORAGE_READ_UNSUPPORTED');
  }

  /** Removes the object. Must not fail when it is already gone. */
  abstract delete(storageKey: string): Promise<void>;
}
