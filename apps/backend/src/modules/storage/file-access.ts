import type { ScanStatus } from '../../generated/prisma/client.js';

/**
 * Whether a stored file may be handed out (a signed link issued) given its scan state.
 *  - CLEAN: yes. Only a real scanner's successful verdict ever produces it.
 *  - NOT_SCANNED: only while clean scans are not required (no scanner configured; development, or the explicit production acknowledgement).
 *  - PENDING (waiting for or in a scan), ERROR (the scan failed) and INFECTED: never. A scanner outage therefore fails closed.
 */
export function isServable(scanStatus: ScanStatus, requireCleanScan: boolean): boolean {
  if (scanStatus === 'CLEAN') return true;
  if (scanStatus === 'NOT_SCANNED') return !requireCleanScan;
  return false;
}

/** The safe, client-facing reason a file is unavailable (no scanner names, no codes from the scanner). */
export function unavailableReason(scanStatus: ScanStatus): 'SCAN_PENDING' | 'SCAN_FAILED' | 'REJECTED' | 'NOT_SCANNED' {
  switch (scanStatus) {
    case 'PENDING':
      return 'SCAN_PENDING';
    case 'ERROR':
      return 'SCAN_FAILED';
    case 'INFECTED':
      return 'REJECTED';
    default:
      return 'NOT_SCANNED';
  }
}
