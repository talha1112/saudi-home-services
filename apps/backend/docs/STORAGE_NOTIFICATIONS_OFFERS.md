# Private storage, notifications and offers (Phase 8)

Backend only. No Flutter or web code was changed; where an app needs to do something, this document gives the
contract. Everything here is covered by tests against real PostgreSQL (and real Memurai for the job runner); see
[Verification](#10-verification).

- [1. Private file storage](#1-private-file-storage)
- [2. Upload and download workflow](#2-upload-and-download-workflow)
- [3. Access-control rules](#3-access-control-rules)
- [4. Scanning and deletion](#4-scanning-and-deletion)
- [5. Notifications](#5-notifications)
- [6. Push delivery and device tokens](#6-push-delivery-and-device-tokens)
- [7. Offers](#7-offers)
- [8. Localization](#8-localization)
- [9. Decisions still needed, and outstanding provider work](#9-decisions-still-needed-and-outstanding-provider-work)
- [10. Verification](#10-verification)
- [11. Applying the migration to the development database later](#11-applying-the-migration-to-the-development-database-later)

## 1. Private file storage

The existing `DocumentStorage` abstraction (same import path as before) gained one method, `inspect()`, and two adapters.
Selected by `DOCUMENT_STORAGE`:

| Value | For | Real bytes? | Notes |
|---|---|---|---|
| `disabled` (default) | production until a vendor is chosen | no | Upload endpoints answer `503 DOCUMENT_STORAGE_NOT_CONFIGURED`. Deleting metadata still works. |
| `dev` | development only (unchanged) | **no** | Non-routable fake URLs. It cannot read bytes, so files are recorded with `content_verified_at = NULL` and `scan_status = NOT_SCANNED`. |
| `local` | development and tests only | yes | Files in `STORAGE_LOCAL_DIR` behind HMAC-signed, expiring API URLs (`/api/v1/storage/local/objects`). Exercises the whole flow without an account or Docker. |
| `s3` | production, once a vendor exists | yes | S3-compatible (AWS S3, MinIO, ...). Hand-written SigV4 (the AWS SDK packages in `package.json` are not used by the application), unit-tested against AWS's published signature vector and **smoke-tested against a real AWS S3 bucket** (Section: Live S3 smoke test). Reads, HEADs and deletes retry transient failures twice. |

`dev` and `local` are refused when `NODE_ENV=production` (startup fails, and the module re-checks). `s3` needs a **private** bucket.

Environment variables (all in `.env.example`; secrets are never logged):

| Variable | Default | Meaning |
|---|---|---|
| `DOCUMENT_STORAGE` | `disabled` in production, `dev` otherwise | provider, above |
| `STORAGE_MAX_FILE_BYTES` | `10485760` | hard ceiling for every upload; booking photos are further limited to 8 MiB |
| `DOCUMENT_URL_TTL_SECONDS` | `900` | lifetime of upload and download URLs (keep it in minutes) |
| `STORAGE_LOCAL_DIR`, `STORAGE_SIGNING_SECRET`, `PUBLIC_API_URL` | `./.storage`, none, `http://127.0.0.1:PORT` | for `local`; the secret must be at least 32 characters |
| `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_FORCE_PATH_STYLE` | none | for `s3`; region, bucket and both keys are required, and the endpoint must be https in production. `AWS_REGION`, `AWS_S3_BUCKET`, `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` are accepted as fallbacks when the `S3_*` name is unset (the `S3_*` name wins) |
| `FILE_SCANNER` | `disabled` | `mock` is a test double, refused in production |
| `STORAGE_REQUIRE_CLEAN_SCAN` | `false` | when true, only files with scan result `CLEAN` can be downloaded (needs a scanner) |
| `STORAGE_DELETION_MAX_ATTEMPTS`, `STORAGE_DELETION_POLL_SECONDS`, `STORAGE_DELETION_RETENTION_DAYS` | `8`, `30`, `7` | removal job |

## 2. Upload and download workflow

The API never receives file bytes (except the development `local` provider, which implements the same URLs itself).

1. **Register** (`POST /bookings/{id}/photos` or `POST /workers/me/documents`): the client declares file name, type and size. The server checks
   authorization, the category's type list (photos: JPEG/PNG; documents: JPEG/PNG/PDF), the size limit
   (`min(STORAGE_MAX_FILE_BYTES, category limit)`), the per-booking / per-worker count and (photos) the booking status. It generates the storage key
   itself (`bookings/<booking id>/photos/<random uuid>` or `workers/<worker id>/documents/<random uuid>`; 122 bits of randomness, **never** the user's file name),
   asks the provider for a short-lived upload URL, **then** writes the metadata row as `PENDING_UPLOAD`. A provider outage therefore leaves no row behind.
2. **Upload**: the client `PUT`s the bytes to the URL. The URL is signed for the exact `Content-Type` and `Content-Length` and expires (minutes). An existing object is never overwritten.
3. **Confirm** (`POST .../confirm`): the server reads the stored object itself and judges it:
   - it exists (`409 UPLOAD_NOT_FOUND` otherwise; the row stays `PENDING_UPLOAD`, so the client can retry the upload);
   - its real size equals the declared size and is within the limits;
   - its **file signature** (JPEG, PNG, WebP, PDF magic bytes) is an allowed type for the category and **equals the declared type**; the file name and the client's `Content-Type` prove nothing;
   - the scanner (if any) did not flag it.
   On success the row becomes `UPLOADED` with `scan_status` and `content_verified_at`. On failure (`422 FILE_CONTENT_INVALID` with `details.reason`, or `422 FILE_REJECTED_BY_SCAN`) the metadata row is deleted
   in the same transaction that queues the object for removal, so nothing implies a usable upload.
4. **Download**: the server checks the rules in section 3, then returns a **short-lived signed URL** (`{ url, expiresAt }`). Nothing is permanent and no URL is stored.
   The download response carries `Content-Disposition: attachment`, `X-Content-Type-Options: nosniff` and `Cache-Control: private, no-store`.

Responses never contain storage keys; they carry `scanStatus`.

## 3. Access-control rules

| Resource | Who may register / upload / confirm / delete | Who may obtain a download link | Audited |
|---|---|---|---|
| Booking photo | the booking's customer, while the booking is `OPEN`, `PAYMENT_PENDING` or `CONFIRMED` | the customer; a worker who may quote on the open request or is the assigned worker; an administrator | admin views |
| Worker verification document | the worker, for their own profile only, while documents are editable | **administrators only** (never the worker, customers or other workers; the worker sees metadata) | every view |

Booking photos and verification documents use separate routes, key prefixes and rules. Anyone else, including other customers, unrelated workers and wrong-booking ids, gets `404`; wrong role gets `403`; no token `401`.
A worker cannot approve their own verification: those routes are administrator-only. Verification review status and audit data (`reviewed_by`, `review_note`, `worker_verification_events`) live beside the document row, separate from the stored object.
Registration and confirmation are rate limited per client IP (120 and 240 per 10 minutes).

## 4. Scanning and deletion

**Scanning.** No real malware scanner is integrated. `FileScanner` is the vendor-neutral boundary; with the default `disabled` implementation files stay `NOT_SCANNED`, which is **not** a claim that a file is safe. With a real (deferred) scanner a confirmed file is `PENDING` until a background job scans the whole object; only a `CLEAN` verdict opens it, `PENDING`/`ERROR`/`INFECTED` are never served, scanner outages fail closed, and infected objects are queued for removal. The queue, retries, access rule, per-purpose link lifetimes and abandoned-upload cleanup are described in **[FILE_LIFECYCLE.md](FILE_LIFECYCLE.md)**. Choosing and integrating a real scanner (ClamAV, a cloud service, bucket-level scanning) is outstanding.

**Deletion.** Deleting a photo or document removes its metadata row and inserts a `storage_deletions` record **in the same transaction**; a job (every `STORAGE_DELETION_POLL_SECONDS`) performs the provider call:

- idempotent: "already gone" is success; queueing twice makes one record; two concurrent runs never process the same record (`FOR UPDATE SKIP LOCKED`);
- provider outage: the record stays pending and is retried with exponential backoff (5 s, 10 s, ... capped at 15 min), parked as `dead` after `STORAGE_DELETION_MAX_ATTEMPTS` and reported in the log every 5 minutes. The user's delete request is never blocked by the outage;
- an object still referenced by a photo or document row is **never** deleted (the record is closed as skipped);
- finished records are deleted after `STORAGE_DELETION_RETENTION_DAYS`.

Nothing else is deleted automatically: verification documents are **not** purged on any schedule (no approved retention policy exists). Registered uploads that were never confirmed are removed by the abandoned-upload job (see [FILE_LIFECYCLE.md](FILE_LIFECYCLE.md) section 5).

## 5. Notifications

Durable in-app notifications live in PostgreSQL (`notifications`). A row holds the recipient, a **template key** (`type`), small safe **parameters** (`{ ref }`, the booking reference), an optional authorized resource
(`booking` + id, or `worker_verification` + id), `read_at`, and a `source_key`. `UNIQUE (user_id, source_key)` makes creation idempotent.

### Event to recipient mapping

| Event | Recipient(s) | Template |
|---|---|---|
| `QUOTE_SUBMITTED` | the booking's customer | `quote.received` |
| `QUOTE_REVISED` | the customer | `quote.revised` |
| `QUOTE_ACCEPTED` | the assigned worker (the one whose quote was accepted) | `quote.accepted` |
| `QUOTE_REJECTED` | the worker who made that quote | `quote.rejected` |
| `PAYMENT_CONFIRMED` | the customer and the assigned worker | `payment.confirmed` |
| `WORK_STARTED`, `WORK_COMPLETED` | the customer | `work.started`, `work.completed` |
| `BOOKING_CANCELLED` | the participants **other than the actor** (both when an administrator or the system cancels) | `booking.cancelled` |
| `BOOKING_EXPIRED` | the customer | `booking.expired` |
| Worker verification: approve, reject, request info, suspend, reinstate | the worker | `verification.*` |

Rules: the person who caused an event is never notified about it; a reviewer's note, a cancellation reason, prices, addresses, phone numbers and names are **never** in a notification.

**Deliberately not notified (meaning not established, so not guessed):** `BOOKING_CREATED` (which workers should hear about a new request needs a matching and fan-out policy), `QUOTE_WITHDRAWN`, `QUOTE_EXPIRED`, refund-request status changes (refunds are requests only; no execution exists), and offers becoming available or expiring.

### When and how they are created

- Booking events: the Phase 7 transactional outbox row is written in the same transaction as the booking change. After commit, the outbox dispatcher calls
  `NotificationsService.createFromBookingEvent` — **nothing exists before the commit**, and a rolled-back change produces nothing. If creation fails, the outbox row is retried with backoff and ends with exactly one notification per recipient.
- Verification decisions: the notification is inserted **inside the decision's own transaction** (unique source key `verification:<event id>`), so it exists only if the decision committed.
- Duplicates (outbox redelivery, two instances racing, a job retry) hit the unique key and create nothing. Tested with three concurrent dispatchers and with a replayed event.

### API (customers and workers; always the caller's own data)

`GET /api/v1/notifications?page&limit&unread&locale`, `GET /api/v1/notifications/unread-count`, `POST /api/v1/notifications/{id}/read` (idempotent), `POST /api/v1/notifications/read-all`.
The recipient comes from the token; a notification id that is not yours is `404`; unknown query parameters are rejected.

## 6. Push delivery and device tokens

**Pipeline.** Creating a notification also queues one `notification_deliveries` row per active device (`status QUEUED`). A repeatable job (every 2 s) claims due rows with `FOR UPDATE SKIP LOCKED` and sends them through `PushProvider`.
It is driven by the database, not by Redis queue state, so losing Redis loses nothing.

| Status | Meaning |
|---|---|
| `QUEUED` | not attempted yet, or waiting for a retry |
| `SENT` | the provider **accepted** the message. Not proof the device received it |
| `DELIVERED` | never set today: it needs vendor delivery receipts that are not wired up |
| `FAILED` | permanent error (an invalid token also revokes that device) or `NOTIFICATION_MAX_ATTEMPTS` exhausted (2 s, 4 s, 8 s ... capped at 10 min, jittered) |
| `UNSUPPORTED` | no push provider is configured; nothing was attempted |

A crash between the provider call and the commit can send a message twice (at-least-once); the push `data` carries the `notificationId` so apps can collapse duplicates. Logs contain neither tokens, titles, bodies nor credentials.

**Providers.** `PUSH_PROVIDER=disabled` (default; every delivery becomes `UNSUPPORTED`), `fcm` (Firebase Cloud Messaging, explicit opt-in, see [FIREBASE_SETUP.md](FIREBASE_SETUP.md) section 6) or `mock` (test double, refused in production). Direct APNs and Huawei Push Kit are not integrated; an adapter routes by `message.provider` and maps vendor errors to `TRANSIENT` / `INVALID_TOKEN` / `PERMANENT`. **SMS and email** are interfaces only: the existing `SmsProvider` can be reused, but no notification type is mapped to SMS or
email, so nothing is ever sent through them.

**Device-token contract for the apps (not implemented in the apps):**

- `POST /api/v1/devices` `{ platform: ANDROID|IOS|HUAWEI, provider: FCM|APNS|HMS, token }` registers or refreshes the caller's device (valid pairs: ANDROID-FCM, IOS-APNS, IOS-FCM, HUAWEI-HMS). Idempotent. The owner is always the caller.
  A token registered by another account **moves** to the new caller (so a handed-over phone stops receiving the previous user's pushes). Each account keeps at most `MAX_DEVICE_TOKENS_PER_USER` active tokens (the oldest are revoked).
- `GET /api/v1/devices` lists the caller's devices **without** tokens. `DELETE /api/v1/devices/{id}` revokes one (call it on sign-out); another account's id is `404`.
- Tokens are stored AES-256-GCM-encrypted (`DEVICE_TOKEN_ENCRYPTION_KEY`, base64 of 32 bytes); only their SHA-256 is used for lookup. Without the key the endpoints answer `503 PUSH_NOT_CONFIGURED`.
- Signing out does not revoke tokens by itself yet (the server does not know which device signed out): the app should call `DELETE /devices/{id}`.

## 7. Offers

An offer is an **announcement**: audience (`CUSTOMERS`, `WORKERS`, `ALL`), title/description/terms in Arabic and/or English, a start and end time, and optional city and service eligibility. It has **no discount, price, code, quota or redemption
data**: the tables contain no such columns (a test asserts it) and nothing in the module touches bookings, quotes, payments, refunds or the ledger (a test snapshots all of them across the whole lifecycle). The admin response states `redemptionEnabled: false`.

**Lifecycle (administrators, `/api/v1/admin/offers`):** create (draft) -> publish -> pause -> publish ... -> archive. Edit only drafts and paused offers (pause first). Status changes are compare-and-set (two simultaneous changes cannot both win) and each writes an
append-only `offer_events` row (who, when, from, to), returned as `history`. A published offer needs a title and description (in at least one language) and must not have ended. **Expiry is derived from the end time**: at `ends_at` the offer disappears from every
listing and the admin sees `phase: EXPIRED`; no job has to run.

**Eligibility (customers and workers, `GET /api/v1/offers`)** is decided on the server: `PUBLISHED`, inside the window, audience matching the caller's **acting role from the token**. For workers, a city or service restriction is matched against the worker's own profile (served cities, offered
services), not against the request. For customers, the optional `cityId` / `serviceId` query only **narrows** the list (the server does not know where a customer will book); it can never widen it. Unknown query parameters (`audience`, `status`) are rejected.

**Redemption is intentionally disabled.** Before it can exist the business must decide: what a discount is (fixed, percentage, free service), who funds it (platform or worker), how VAT applies to the discounted price, how the commission is computed (on the original or the discounted amount),
how it interacts with the immutable booking money snapshot and the append-only ledger, redemption limits per customer and overall, stacking, cancellation and refund handling, and fraud controls. Referral rewards, worker bonuses and subscriptions are likewise not implemented.

## 8. Localization

| Content | Where it lives | How it is rendered |
|---|---|---|
| Offer title, description, terms | **database** (`*_ar`, `*_en`), written by administrators | the reader's language, otherwise the other language (never invented); the response says which one was used (`locale`) |
| Notification wording | **backend templates** (`notification-templates.ts`); the database stores only the template key and `{ ref }` | rendered per reader when listing or pushing; an unknown/newer type renders a generic "Update" message |
| Reader's language | `users.locale` (default Arabic); `?locale=ar|en` overrides it for one request | |

Wording changes in a template apply to existing notifications as well. No Flutter localization files were touched.

## 9. Decisions still needed, and outstanding provider work

Business and legal:

1. **Retention** of verification documents, booking photos, replaced/expired documents, rejected applicants' documents, chat and notifications; erase/export (PDPL) handling. Nothing is purged automatically until this is approved.
2. **Which file categories** are needed beyond the current ones, and which verification documents Saudi regulation requires (the model keeps `NATIONAL_ID`, `IQAMA`, `PROFESSIONAL_LICENSE`, `CERTIFICATE`, `PHOTO`, `OTHER`; none is mandated beyond the existing configurable identity-document rule).
3. **Notification policy**: who is told about new requests (`BOOKING_CREATED`), quiet hours, user preferences/opt-out, which events may use SMS or email (cost and consent), the wording approved by the client (including seasonal sounds, which need app-side channels).
4. **Offer redemption model** (section 7) and whether workers get offers at all.
5. **Scan policy**: whether unscanned files may be shown to administrators or to the other side of a booking.

Providers and infrastructure:

- Object storage vendor, bucket (private, public access blocked, lifecycle rules, encryption at rest), credentials, and a staging run of the S3 adapter against it.
- A malware scanner and its integration (`FileScanner`).
- Push vendors: Firebase project(s) for FCM, an Apple key for APNs, Huawei AppGallery Connect for HMS, plus the adapter(s) and the apps' registration code. Delivery receipts if `DELIVERED` is wanted.
- An SMS/email notification path if the business wants one.
- Alerting on dead removal/outbox records, which are only logged today.

## 10. Verification

```powershell
npm run typecheck
npx prisma validate
npm test                                  # unit
npm run test:e2e
npm run test:integration:files            # storage, notifications, offers (real PostgreSQL; the local provider uses a temp folder)
npm run test:integration:realtime         # includes the job runner on Memurai (DB 15, unique key prefix)
npm run test:integration                  # everything
npm audit --omit=dev
```

Manual check with the real byte path (test database, temporary folder, no external service):

```powershell
$env:DOCUMENT_STORAGE = "local"; $env:STORAGE_SIGNING_SECRET = "<at least 32 random characters>"; $env:FILE_SCANNER = "mock"
npm run build; node dist/main.js     # then register -> PUT to the returned URL -> confirm -> download-url
```

## 11. Applying the migration to the development database later

The migration is `20261028090000_storage_notifications_offers`. It adds two columns with defaults to `booking_photos` and `worker_verification_documents` and creates new tables only. It is applied to the isolated test database only.
The development database `saudi_home_services` still has the Phase 5, 6, 7 **and** 8 migrations pending; apply all four in order, after approval:

```powershell
cd apps\backend
npm run check:local          # read-only: confirms the target database and UTF-8 encoding
npm run db:migrate:status    # read-only: should list the four pending migrations
npm run db:migrate:deploy    # applies pending migrations only; never resets or drops
```

## Live S3 smoke test and AWS setup

`npm run test:s3-smoke` runs the application's real `S3DocumentStorage` and `FileIntakeService` against the configured bucket. It is not part of any automated suite and does not touch a database.

PowerShell (replace the bucket name with your own; the second variable must equal the configured bucket, otherwise the test refuses to run):

```powershell
$env:S3_SMOKE_TEST = "1"
$env:S3_SMOKE_CONFIRM_BUCKET = "<exact bucket name>"
npm run test:s3-smoke
```

What it proves against real S3: presigned upload (signed Content-Type and Content-Length), confirmation (exists, real size, file signature, intake), presigned download with `Content-Disposition: attachment`, refusal of anonymous access, deletion and a safe second deletion, refusal of a wrong Content-Type, a tampered signature and an expired link, and "not found" for a key never uploaded. It uses fresh random keys only, never lists the bucket, deletes only the exact keys it created, and prints no URLs or credentials. It does **not** prove: malware scanning (none configured), behaviour under real throttling (503 SlowDown), IAM-role credentials (unsupported), cross-account policies, lifecycle rules, or any bucket other than the one tested.

### Authentication

The adapter signs with a static access key (`S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY`, or the `AWS_*` fallbacks). **IAM roles, instance profiles and temporary (session-token) credentials are not supported**: that needs a credential provider, which the hand-written signer does not have. If staging/production must use roles, that is a separate change (for example adopting the AWS SDK credential chain, already listed in `package.json`).

### Least-privilege IAM policy for the backend user (replace the bucket)

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow", "Action": ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"], "Resource": "arn:aws:s3:::<bucket>/*" },
    { "Effect": "Allow", "Action": "s3:ListBucket", "Resource": "arn:aws:s3:::<bucket>" }
  ]
}
```

`s3:ListBucket` is needed only so S3 answers 404 (instead of 403) for a key that does not exist; without it "not uploaded yet" would look like a storage failure. It does not allow reading object contents. Keep S3 **Block Public Access** on, do not attach a bucket policy that grants public or cross-account read, and keep default encryption on (SSE-S3 or SSE-KMS).

### Failure behaviour

| Situation | Behaviour |
|---|---|
| S3 throttles or fails (408, 429, 5xx) or the connection drops | The adapter retries up to 3 attempts (150 ms, 300 ms) |
| Still failing when a client confirms an upload | `503 STORAGE_UNAVAILABLE` (retryable); the file is **not** rejected and the metadata is kept |
| Credentials or policy wrong (403) on confirm | Same `503`, and the log names the code (`STORAGE_ERROR_403`), never a URL |
| Object removal fails | The removal queue retries with backoff up to `STORAGE_DELETION_MAX_ATTEMPTS`, then parks it as dead; objects still referenced by a photo or document are never removed |
| Wrong size, wrong type, unknown signature | `422 FILE_CONTENT_INVALID`; the row is removed and the object queued for deletion |
| No scanner configured | Files stay `NOT_SCANNED`; nothing is ever marked clean without a real scanner |

### Data residency

`ap-southeast-2` is Sydney. Worker identity documents and booking photos are personal data; confirm with legal advice whether storing them outside Saudi Arabia is acceptable under PDPL before using this bucket for real users.


## S3 configuration precedence and safe defaults

- **Precedence per setting:** the `S3_*` variable wins when it is set and not empty; otherwise the matching `AWS_*` variable is used (`S3_REGION` <- `AWS_REGION`, `S3_BUCKET` <- `AWS_S3_BUCKET`, `S3_ACCESS_KEY_ID` <- `AWS_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` <- `AWS_SECRET_ACCESS_KEY`). It is resolved per setting, so a mixed set works. Covered by unit tests.
- **Disabled unless explicitly enabled:** the `AWS_*` variables alone change nothing. The S3 adapter is used only when `DOCUMENT_STORAGE=s3`; unset means `disabled`, and document/photo endpoints answer 503 `DOCUMENT_STORAGE_NOT_CONFIGURED`. With `s3` selected, startup fails if region, bucket or either key is missing.
- **Production:** `DOCUMENT_STORAGE=dev` and `local`, `FILE_SCANNER=mock` and a non-https `S3_ENDPOINT` are refused at startup, and the storage module re-checks `dev`/`local`/`mock` at run time.
- **Secrets:** the access key and secret live only in `.env` (git-ignored) or the platform secret store. They appear in no example file, document, source file or test (searched), are never logged, and are never put in error messages (tested: a failing request logs only the error class). Signed URLs are bearer credentials: they are returned to the authorised caller and not stored or logged.
- **Smoke test:** operates only on random keys it generates (`bookings/<random uuid>/photos/<random uuid>`), requires `S3_SMOKE_TEST=1` plus `S3_SMOKE_CONFIRM_BUCKET` equal to the configured bucket, refuses `NODE_ENV=production`, never lists the bucket, and deletes only those exact keys.

## Remaining storage risks (what is and is not verified)

| Topic | Current state | Recommendation |
|---|---|---|
| **Malware scanning** | No real scanner exists (the lifecycle and boundary are built, see FILE_LIFECYCLE.md). Files are `NOT_SCANNED`. With `STORAGE_REQUIRE_CLEAN_SCAN=false` (default) a `NOT_SCANNED` file is still viewable by its authorised viewers (owner, assigned worker, administrator); with `true` the API refuses to start without a scanner, so nothing could be enabled. A scanner failure is recorded as `ERROR`, never `CLEAN`. | Product/security decision before launch. Integration needs: a provider (for example a ClamAV service or a cloud object-scanning service), an adapter implementing `FileScanner` that scans the whole stored object (not only its first 128 bytes) and returns `CLEAN`/`INFECTED`/`ERROR`, asynchronous scanning (the confirm step currently scans inline), a re-scan path for `ERROR`/`NOT_SCANNED` rows, and then `STORAGE_REQUIRE_CLEAN_SCAN=true`. Until then treat every file as untrusted: downloads are forced to `attachment`, file type is checked by signature, and the apps must never render documents inline in a trusted context. |
| **Signed URL lifetime** | Per purpose since the file-lifecycle phase: upload links `STORAGE_UPLOAD_URL_TTL_SECONDS`, photo views `BOOKING_PHOTO_URL_TTL_SECONDS` (both default to the legacy `DOCUMENT_URL_TTL_SECONDS`, 900 s) and identity documents `IDENTITY_DOCUMENT_URL_TTL_SECONDS` (default 300 s, max 900). See FILE_LIFECYCLE.md section 4 for precedence. | Keep identity documents at 300 s or shorter. Not verified: that clients never copy links into logs or analytics (a frontend concern). |
| **Oversized uploads** | Registration refuses a declared size above the limit before any link is issued. The link signs `Content-Length` and `Content-Type`; S3 refuses a different content type (verified live) and should refuse a body whose length differs from the signed header (signature covered by unit tests; a mismatched-length request was **not** sent live because the HTTP client derives the length from the body). After upload, the server re-reads the real size and rejects/queues deletion of anything that differs. So oversize is constrained at S3 by the signature and re-checked afterwards. | S3 presigned PUT cannot express a content-length range (only browser POST policies can). Safe additions that keep the design: an application job or bucket rule that removes objects whose upload was never confirmed (the abandoned-upload job now does this for rows; see FILE_LIFECYCLE.md), and per-account upload quotas. |
| **Retries and S3 throttling** | Reads, HEADs and deletes make up to 3 attempts (150 ms, 300 ms delay) on network errors, timeouts, 408, 429 and 5xx (S3 SlowDown is 503), then report the error. Confirmation maps a persistent failure to a retryable 503 and keeps the upload pending. Removals continue through the database queue with exponential backoff until `STORAGE_DELETION_MAX_ATTEMPTS`, then are parked as dead and reported. Uploads and downloads go straight from the client to S3, so their retries are the client's. | Verified with mocked responses only. Real throttling was not observed. Monitor dead `storage_deletions` rows and `STORAGE_UNAVAILABLE` rates in staging. |
| **Bucket versioning, encryption, lifecycle, access logging** | **Not verified.** The backend credentials are least-privilege and are not expected to read bucket configuration, and no bucket setting was read or changed. | Review in the AWS console: Block Public Access on (all four), default encryption (SSE-S3 or SSE-KMS), a versioning decision (versioning keeps deleted identity documents as old versions, which conflicts with erasure requests unless a lifecycle rule expires non-current versions), a lifecycle rule to abort incomplete multipart uploads and (if adopted) expire unconfirmed objects, server access logging or CloudTrail data events to a separate restricted bucket, and a bucket policy that denies non-TLS requests. |

## Saudi data residency (Sydney region) and required approvals

The bucket is in `ap-southeast-2` (Sydney, Australia). It will hold worker identity and licence documents and customer booking photos (personal data, potentially national ID numbers and faces). Implications:

- **Cross-border transfer:** storing Saudi residents' personal data outside the Kingdom is a transfer under the Saudi Personal Data Protection Law (PDPL) and its Implementing Regulations and transfer rules. It generally needs a lawful basis and conditions (adequate protection, appropriate safeguards, purpose limits), may need notification to or approval from SDAIA, and needs transparent notice and consent wording in the apps. Identity documents attract stricter treatment. Whether and how this applies is a legal question; this document is not legal advice.
- **Sector and customer rules:** payment, government-contract and other regulators can add local-hosting requirements. Check them for your business model.
- **Practical effects:** higher latency between Saudi Arabia and Sydney for uploads and downloads, and AWS (a foreign processor) and Australian authorities become relevant parties for access requests.
- **Not changed:** the region was not changed and no data was moved. Moving needs a new bucket in another region (for example an AWS Middle East region, if suitable) and a migration of any stored objects; the application only needs `S3_REGION` and `S3_BUCKET` to change.
- **Approvals needed before real users' data goes there:** legal/compliance review of PDPL transfer rules with a documented decision, a data-processing agreement with AWS, updated privacy policy and in-app consent text (Arabic and English), a record of processing and retention periods per document type, an erasure procedure that also covers object versions and backups, and an incident-response contact. Until then use the bucket for synthetic test data only.

## Static credentials and incident response

The backend uses one static IAM access key. Treat it like a password: keep it only in the secret manager, rotate it on a schedule and whenever it may have been exposed, give it only the policy in the least-privilege section above, enable CloudTrail for the bucket, and plan a move to short-lived role credentials (not supported by the current signer) before production scale.
