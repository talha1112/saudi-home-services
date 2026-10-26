import type { Readable } from 'node:stream';
import { Injectable } from '@nestjs/common';
import type { ScanStatus } from '../../generated/prisma/client.js';

export type ScanVerdict = Extract<ScanStatus, 'NOT_SCANNED' | 'CLEAN' | 'INFECTED' | 'ERROR'>;

export interface ScanInput {
  storageKey: string;
  /** The first bytes of the object (at most 128). */
  head: Buffer;
  sizeBytes: number;
  /**
   * Opens the WHOLE object as a stream, read server-side through the storage adapter (a vendor adapter should scan this stream,
   * or hand the object to its engine; it should not need the object to be public or a signed URL). Present for deferred scanners.
   */
  open?: () => Promise<Readable>;
}

/**
 * Malware scanning contract: the boundary between the storage module and any scanning product (a ClamAV daemon, a cloud scanning
 * service, ...). The storage module knows nothing about a vendor; an adapter implements `scan` and is selected by FILE_SCANNER.
 *
 * Rules every adapter must follow:
 *  - return CLEAN only when a scanner actually inspected the WHOLE object and found nothing;
 *  - return INFECTED when it found malware;
 *  - return NOT_SCANNED when nothing was inspected, or ERROR when the scanner failed (throwing is treated like ERROR). Neither is ever
 *    "clean": the file stays unavailable and the scan is retried with backoff, then parked as ERROR;
 *  - never log file content, object keys' contents, or signed URLs, and never put them in a thrown message
 *    (the message is reduced to a short code before it is stored).
 */
export abstract class FileScanner {
  /** Short identifier recorded with every verdict (for example "clamav"). */
  abstract readonly name: string;
  /**
   * True for every real scanner: confirmation only queues the file (status PENDING) and a background job scans the whole object.
   * False for scanners that answer instantly during confirmation (no scanner, and the inline test double).
   */
  readonly deferred: boolean = false;
  abstract scan(input: ScanInput): Promise<ScanVerdict>;
}

/** Default: no scanner. Every file stays NOT_SCANNED, which is explicitly not "clean". */
@Injectable()
export class DisabledFileScanner extends FileScanner {
  readonly name = 'disabled';
  async scan(): Promise<'NOT_SCANNED'> {
    return 'NOT_SCANNED';
  }
}

/** Harmless marker (not the real EICAR string, which desktop antivirus programs delete on sight). */
export const MOCK_INFECTED_MARKER = 'HS-MOCK-SCANNER-INFECTED-TEST-MARKER';

/** TEST DOUBLE (refused in production): flags files whose first bytes contain MOCK_INFECTED_MARKER as INFECTED and passes everything else. Answers inline. */
@Injectable()
export class MockFileScanner extends FileScanner {
  readonly name = 'mock';
  async scan(input: ScanInput): Promise<'CLEAN' | 'INFECTED'> {
    return input.head.toString('latin1').includes(MOCK_INFECTED_MARKER) ? 'INFECTED' : 'CLEAN';
  }
}

/**
 * TEST DOUBLE (refused in production) that behaves like a real scanner for the lifecycle: deferred, and it reads the WHOLE object
 * through `open()`. It exists to exercise the queue, retries and access rules; it is not a malware engine and must never be
 * configured in production.
 */
@Injectable()
export class MockAsyncFileScanner extends FileScanner {
  readonly name = 'mock-async';
  override readonly deferred = true;
  async scan(input: ScanInput): Promise<'CLEAN' | 'INFECTED' | 'ERROR'> {
    if (!input.open) return 'ERROR';
    const stream = await input.open();
    let tail = '';
    for await (const chunk of stream) {
      const text = tail + (chunk as Buffer).toString('latin1');
      if (text.includes(MOCK_INFECTED_MARKER)) {
        stream.destroy();
        return 'INFECTED';
      }
      tail = text.slice(-MOCK_INFECTED_MARKER.length);
    }
    return 'CLEAN';
  }
}
