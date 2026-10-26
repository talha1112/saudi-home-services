import { Injectable } from '@nestjs/common';
import { DocumentStorage, DownloadTarget, UploadTarget } from './document-storage.js';

/**
 * DEVELOPMENT ONLY. Stores nothing: it hands out URLs on a non-routable host and reports every
 * object as existing, so the whole onboarding flow can be exercised without object storage.
 * Environment validation and WorkersModule both refuse it when NODE_ENV=production.
 */
@Injectable()
export class DevDocumentStorage extends DocumentStorage {
  async createUploadTarget(input: { storageKey: string; mimeType: string; ttlSeconds: number }): Promise<UploadTarget> {
    return {
      uploadUrl: `https://dev-storage.invalid/upload/${input.storageKey}`,
      method: 'PUT',
      headers: { 'Content-Type': input.mimeType },
      expiresAt: new Date(Date.now() + input.ttlSeconds * 1000),
    };
  }

  async exists(): Promise<boolean> {
    return true;
  }

  async createDownloadTarget(storageKey: string, ttlSeconds: number): Promise<DownloadTarget> {
    return { url: `https://dev-storage.invalid/download/${storageKey}`, expiresAt: new Date(Date.now() + ttlSeconds * 1000) };
  }

  async delete(): Promise<void> {
    /* nothing stored */
  }
}
