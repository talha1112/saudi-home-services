# Secure file lifecycle: scanning, access, link lifetimes and cleanup

Backend only. Applies to booking photos and worker verification documents. Storage providers, upload and download links, and the removal queue are described in [STORAGE_NOTIFICATIONS_OFFERS.md](STORAGE_NOTIFICATIONS_OFFERS.md); this document adds the malware-scan boundary, the access rule, per-purpose link lifetimes and abandoned-upload cleanup.

**No real malware scanner is integrated.** The boundary, queue, retries, access rules and tests exist and are exercised with a test double (`FILE_SCANNER=mock-async`). With `FILE_SCANNER=disabled` (the default) nothing is scanned and every file stays `NOT_SCANNED`. Nothing in this code marks a file clean except a scanner's own `CLEAN` verdict.

## 1. File states

`scan_status` reuses the existing values; no enum was added.

| `scan_status` | Meaning | Served? |
|---|---|---|
| `NOT_SCANNED` | No scanner is configured (or the file predates scanning). Not a statement that the file is safe | Only while `STORAGE_REQUIRE_CLEAN_SCAN=false` |
| `PENDING` | Confirmed and queued for, or in, a scan (the "scanning" state) | Never |
| `CLEAN` | A real scanner inspected the whole object and found nothing | Yes |
| `INFECTED` | The scanner found malware | Never; object queued for removal |
| `ERROR` | The scan failed for good after the maximum attempts (the "scan failed" state) | Never |

Upload row status (`PENDING_UPLOAD` -> `UPLOADED`) is separate from scan status.

### Before and after

| Step | Before this phase | Now |
|---|---|---|
| Confirm upload | Server checks real size and file signature, then (inline) calls the scanner on the first 128 bytes. Default: `NOT_SCANNED` | Same checks. With a real (deferred) scanner the file becomes `UPLOADED` + `PENDING` and a `file_scan_jobs` row is queued **in the same transaction**. With no scanner: `NOT_SCANNED`, as before |
| Scan | Inline, first 128 bytes only; no retries | Background job reads the **whole object** through the storage adapter, retries with backoff, parks as `ERROR` after the maximum attempts |
| Viewing | Blocked only for non-`CLEAN` files when `STORAGE_REQUIRE_CLEAN_SCAN=true`; `ERROR` was viewable otherwise | `PENDING`, `ERROR`, `INFECTED` are **never** served. `NOT_SCANNED` is served only while clean scans are not required |
| Infected | Rejected at confirmation and removed (inline double only) | Marked `INFECTED`, never served, object queued for removal (reason `infected`), audit entry `file.scan.infected`; the metadata row stays as the record |
| Abandoned upload | Row and any uploaded object stayed forever | Removed by the cleanup job (section 5) |
| Link lifetimes | One setting for everything (15 min) | Per purpose (section 4) |

## 2. The scanner boundary

`FileScanner` (`src/modules/storage/file-scanner.ts`):

```ts
abstract class FileScanner {
  abstract readonly name: string;           // recorded with every verdict
  readonly deferred: boolean = false;       // true for every real scanner: confirmation only queues; a job scans
  abstract scan(input: { storageKey; head; sizeBytes; open?: () => Promise<Readable> }): Promise<'CLEAN' | 'INFECTED' | 'NOT_SCANNED' | 'ERROR'>;
}
```

- `open()` streams the whole object server-side through the storage adapter (`DocumentStorage.openReadStream`, implemented for S3 and local storage). The stream is never given to a client, and a vendor adapter does not need a signed URL.
- A verdict of `NOT_SCANNED` or `ERROR`, a thrown error, a timeout, an unreadable or missing object are all **failures**: the file stays unavailable and the scan is retried. Only `CLEAN` / `INFECTED` are stored as verdicts (a database CHECK enforces it).
- Messages are reduced to short codes (`SCANNER_ERROR`, `OBJECT_MISSING`, `SCAN_TIMEOUT`, ...) before they are stored or logged. File content, keys' contents and signed URLs are never logged.

To integrate a real scanner (outstanding, needs a vendor decision): implement `FileScanner` with `deferred = true` (for example a ClamAV `clamd` INSTREAM client, or a cloud scanning API), add its name to `FileScannerName` and to the factory in `storage.module.ts`, add its connection settings to `env.validation.ts`/`.env.example`, test it against the real product, and only then set `STORAGE_REQUIRE_CLEAN_SCAN=true`. Nothing else in the lifecycle changes.

## 3. The queue (`file_scan_jobs`)

- One job per object (unique `storage_key`); enqueue is idempotent.
- Claiming: `FOR UPDATE SKIP LOCKED`, status `RUNNING`, `attempts + 1`, a lease (`FILE_SCAN_LEASE_SECONDS`, default 300). A job whose lease expired is claimable again.
- Result: applied only if the job is still `RUNNING` with the **same attempt number** (a fencing token) and the file is still `PENDING` (compare-and-set). A duplicate run, a run that lost its lease, or a late result cannot change a file's state (covered by tests, including a stale `CLEAN` arriving after another run finished `INFECTED`).
- Failures retry with exponential backoff (10 s, 20 s, 40 s ... 10 min, +-20%), `FILE_SCAN_MAX_ATTEMPTS` (default 5), then the job is `DEAD` and the file `ERROR`. Dead jobs are logged every 5 minutes (`File scans need attention`). Finished jobs are purged after `STORAGE_DELETION_RETENTION_DAYS`; dead ones are kept.
- `FileScanService.requeueFailed(storageKey)` requeues a dead scan (operator action; there is no HTTP route for it yet).
- The job runs in its own BullMQ queue (`file-scans`, every `FILE_SCAN_POLL_SECONDS`), so a slow scan never delays removals or housekeeping.

### Infected policy

The file is marked `INFECTED` (denied to everyone), the object is queued for deletion immediately, the removal queue ignores `INFECTED` rows when deciding whether an object is still referenced, an audit entry is written (no content), and the row is kept. The row is kept because a booking photo may be cited in a dispute and the uploader should see that the upload was rejected. Whether to also notify the uploader, block the account after repeated infections, or keep a quarantine copy for investigation is a **product/security decision** not made here.

## 4. Access rules and link lifetimes

Every route that issues a signed download link goes through `isServable(scanStatus, requireCleanScan)`:

| Route | Who | Extra rules (unchanged) |
|---|---|---|
| `GET /bookings/{id}/photos/{photoId}/download-url` | The booking's customer | Ownership; stranger gets 404 |
| `GET /workers/me/requests/{id}/photos/{photoId}/download-url` | A worker who may quote on, or is assigned to, the booking | Eligibility / assignment; others 404 |
| `GET /admin/bookings/{id}/photos/{photoId}/download-url` | Administrator | Audited (`booking.photo.accessed`) |
| `GET /admin/workers/{workerId}/documents/{docId}/download-url` | Administrator only | Audited (`worker.document.accessed`); the document is bound to its worker |

A refused file answers `409 FILE_NOT_AVAILABLE` with `details.reason` of `SCAN_PENDING`, `SCAN_FAILED`, `REJECTED` or `NOT_SCANNED`; no scanner name or code is exposed. No link is issued, so no view is audited, for an unavailable file.

**Already-issued links.** A presigned S3 URL is a bearer credential that cannot be revoked; it works until it expires or the object is deleted. Because only `CLEAN` (or explicitly allowed `NOT_SCANNED`) files get links, a link is never issued for a pending or infected file. The remaining window: a file served as `CLEAN` that is later found infected (there is no re-scan feature yet) keeps working for at most the link lifetime, and for an infected object the deletion removes it at once. Short lifetimes are the mitigation.

### Lifetimes (seconds)

| Purpose | Setting | Default | Allowed |
|---|---|---|---|
| Upload links (photos and documents) | `STORAGE_UPLOAD_URL_TTL_SECONDS` | `DOCUMENT_URL_TTL_SECONDS` (900) | 60-3600 |
| Booking-photo view links | `BOOKING_PHOTO_URL_TTL_SECONDS` | `DOCUMENT_URL_TTL_SECONDS` (900) | 60-3600 |
| Identity / licence document view links (administrators) | `IDENTITY_DOCUMENT_URL_TTL_SECONDS` | `min(300, DOCUMENT_URL_TTL_SECONDS)` | 30-900 |

**Precedence:** the specific setting wins; otherwise the legacy `DOCUMENT_URL_TTL_SECONDS` (60-3600, default 900) applies to uploads and photo views. Identity documents do not inherit the legacy value upward: they default to 300 s, or to the legacy value when that is shorter. A value of 0 (or unset) means "use the default". Anything above the maximum, or negative, stops the API from starting.

## 5. Abandoned-upload cleanup

A job (`abandoned-uploads`, every `STORAGE_ABANDONED_UPLOAD_POLL_MINUTES`, default 10) removes uploads registered but never confirmed.

- **Eligible:** `PENDING_UPLOAD` rows older than `STORAGE_ABANDONED_UPLOAD_MIN_AGE_MINUTES` (default 1440 = 24 h; minimum 120, so every link, at most 60 minutes, has long expired and no late upload can land after the cleanup).
- **Never touched:** `UPLOADED` files (any age, any scan state), photos referenced by dispute evidence, and anything newer than the minimum age.
- **How:** in one transaction, rows are locked (`FOR UPDATE SKIP LOCKED`), deleted, and their exact keys inserted into the existing removal queue (reason `abandoned-upload`), which keeps its own reference protection, retries, backoff and dead-parking. Concurrent runs take different rows; a repeat finds nothing.
- **Never:** the bucket is never listed, and no key that is not the key of a row deleted by this job is ever queued. Only counts are logged.
- Known edge: a client that confirms in the same millisecond the cleanup deletes the row gets "not found" (the confirm is a compare-and-set, so nothing is corrupted).

## 6. Upload size and type enforcement (what is and is not enforced where)

| Control | Where | Verified |
|---|---|---|
| Declared size must not exceed `STORAGE_MAX_FILE_BYTES` or the category ceiling | API, before any link is issued | Integration tests |
| `Content-Type` and `Content-Length` are part of the signature; S3 refuses a different type | S3 (signature check) | Live smoke test (type); length binding by signature unit tests. A body whose real length differs from the signed header was **not** sent live |
| Real size equals declared size, within the ceiling; file signature matches the declared type and the allowed list | API at confirmation, from the stored object's metadata and first 128 bytes. A huge object is never downloaded in full to be judged (one `HEAD` plus a ranged `GET`, unit-tested) | Integration + unit tests |
| Whole-object malware scan | Scan job | Test double only |

S3 itself cannot enforce a maximum for a presigned `PUT` (only browser POST policies can). Upload size is therefore bounded by the signed `Content-Length` (which equals a declared size the API already checked), then re-checked after upload; an object that differs is rejected and queued for removal.

## 7. Settings added

`FILE_SCANNER` (new value `mock-async`, test double, refused in production), `STORAGE_ALLOW_UNSCANNED_FILES`, `STORAGE_UPLOAD_URL_TTL_SECONDS`, `BOOKING_PHOTO_URL_TTL_SECONDS`, `IDENTITY_DOCUMENT_URL_TTL_SECONDS`, `FILE_SCAN_MAX_ATTEMPTS`, `FILE_SCAN_POLL_SECONDS`, `FILE_SCAN_LEASE_SECONDS`, `STORAGE_ABANDONED_UPLOAD_MIN_AGE_MINUTES`, `STORAGE_ABANDONED_UPLOAD_POLL_MINUTES`. See `.env.example`.

**Production rule:** with `NODE_ENV=production` and `DOCUMENT_STORAGE=s3`, `FILE_SCANNER=disabled` is refused unless `STORAGE_ALLOW_UNSCANNED_FILES=true` is set. That variable is the explicit, recorded acceptance that files are served unscanned; the default is to fail to start.

## 8. Migration

`20261031090000_file_scan_lifecycle`: two enums and the table `file_scan_jobs` with three CHECK constraints. Additive only: no existing table, column or row is touched or read, no long locks, safe on a live database. Rollback: `DROP TABLE "file_scan_jobs"; DROP TYPE "FileScanJobStatus"; DROP TYPE "FileScanSubject";` (no other object depends on it). Applied to `home_services_test` only; **not applied to `saudi_home_services`**, where it joins the pending set (Phases 5-9, `20261030090000_audit_log_integrity`).
