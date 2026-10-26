import { Injectable } from '@nestjs/common';
import { unavailable } from '../../../common/errors/api-error.js';
import { DocumentStorage, DownloadTarget, UploadTarget } from './document-storage.js';

/** Used when no object storage is configured (the production default). Fails closed. */
@Injectable()
export class DisabledDocumentStorage extends DocumentStorage {
  private fail(): never {
    throw unavailable('DOCUMENT_STORAGE_NOT_CONFIGURED', 'Document upload is temporarily unavailable');
  }

  async createUploadTarget(): Promise<UploadTarget> {
    return this.fail();
  }

  async exists(): Promise<boolean> {
    return this.fail();
  }

  async createDownloadTarget(): Promise<DownloadTarget> {
    return this.fail();
  }

  async delete(): Promise<void> {
    // Nothing can have been stored; deleting metadata must still work.
  }
}
