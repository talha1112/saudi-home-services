import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_CONFIG, type AppConfig } from '../../config/app.config.js';
import { DocumentStorageName, FileScannerName } from '../../config/env.validation.js';
import { DevDocumentStorage } from '../workers/storage/dev-document-storage.js';
import { DisabledDocumentStorage } from '../workers/storage/disabled-document-storage.js';
import { DocumentStorage } from '../workers/storage/document-storage.js';
import { LocalDocumentStorage } from './adapters/local-document-storage.js';
import { LocalStorageController } from './adapters/local-storage.controller.js';
import { S3DocumentStorage } from './adapters/s3-document-storage.js';
import { AuthModule } from '../auth/auth.module.js';
import { AbandonedUploadCleanupService } from './abandoned-upload-cleanup.service.js';
import { DisabledFileScanner, FileScanner, MockAsyncFileScanner, MockFileScanner } from './file-scanner.js';
import { FileScanService } from './file-scan.service.js';
import { FileIntakeService } from './file-intake.service.js';
import { StorageDeletionService } from './storage-deletion.service.js';

/**
 * Private object storage for uploaded files (worker identity documents, booking photos).
 * Chosen from DOCUMENT_STORAGE:
 *   disabled (default; production-safe), dev (non-routable fake, development only), local (real bytes on disk behind
 *   signed API URLs, development/test only), s3 (S3-compatible, private bucket).
 * To add another vendor: implement `DocumentStorage`, add its name to `DocumentStorageName` and the switch below,
 * and document its settings in `.env.example`.
 */
@Module({
  imports: [AuthModule],
  controllers: [LocalStorageController],
  providers: [
    DevDocumentStorage,
    DisabledDocumentStorage,
    LocalDocumentStorage,
    {
      provide: DocumentStorage,
      inject: [ConfigService, DevDocumentStorage, DisabledDocumentStorage, LocalDocumentStorage],
      useFactory: (config: ConfigService, dev: DevDocumentStorage, disabled: DisabledDocumentStorage, local: LocalDocumentStorage): DocumentStorage => {
        const app = config.getOrThrow<AppConfig>(APP_CONFIG);
        switch (app.workers.documentStorage) {
          case DocumentStorageName.Dev:
          case DocumentStorageName.Local:
            // Second line of defence next to env validation.
            if (app.isProduction) throw new Error(`The ${app.workers.documentStorage} document storage must not be used in production`);
            return app.workers.documentStorage === DocumentStorageName.Dev ? dev : local;
          case DocumentStorageName.S3:
            return new S3DocumentStorage(config);
          default:
            return disabled;
        }
      },
    },
    DisabledFileScanner,
    MockFileScanner,
    MockAsyncFileScanner,
    {
      provide: FileScanner,
      inject: [ConfigService, DisabledFileScanner, MockFileScanner, MockAsyncFileScanner],
      useFactory: (config: ConfigService, disabled: DisabledFileScanner, mock: MockFileScanner, mockAsync: MockAsyncFileScanner): FileScanner => {
        const app = config.getOrThrow<AppConfig>(APP_CONFIG);
        // To add a real scanner: implement `FileScanner` (deferred = true), add its name to `FileScannerName`, and return it here.
        if (app.storage.scanner === FileScannerName.Mock || app.storage.scanner === FileScannerName.MockAsync) {
          if (app.isProduction) throw new Error('The mock file scanners must not be used in production');
          return app.storage.scanner === FileScannerName.Mock ? mock : mockAsync;
        }
        return disabled;
      },
    },
    FileIntakeService,
    StorageDeletionService,
    FileScanService,
    AbandonedUploadCleanupService,
  ],
  exports: [DocumentStorage, FileScanner, FileIntakeService, StorageDeletionService, FileScanService, AbandonedUploadCleanupService],
})
export class StorageModule {}
