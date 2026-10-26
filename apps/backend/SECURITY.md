# Backend security notes and production-readiness checklist

Status of the authentication/authorisation foundation (phases 1-3) after the stabilisation pass.
Items under **Outstanding** must be resolved before real users are onboarded.

## Outstanding for production

| Item | Why it matters | Planned approach |
|---|---|---|
| **Real SMS provider** | Only `dev` (logs the code) and `disabled` (fails with 503) exist. In production OTP sign-in is unavailable until a provider is added. | Implement `SmsProvider` for a Saudi-licensed gateway (e.g. Unifonic, Taqnyat) or Twilio, credentials from the host secret store. Check sender-ID registration with the CST for Saudi traffic. |
| **MFA for administrators (deferred by decision)** | Administrators sign in with email and password only. A stolen or phished admin password gives full admin access, and the per-account failure limit lets an attacker lock an administrator out. | Product decision: MFA is a deferred future enhancement. Risks and interim mitigations are listed in [docs/PRODUCTION_HARDENING.md](docs/PRODUCTION_HARDENING.md) section 1. The `AdminMfaPolicy` hook remains a no-op placeholder. |
| **Account-level suspension endpoint** | Worker verification can be suspended (phase 4), but a whole account can only be blocked by editing the database. | See "Worker verification" below. |
| **CAPTCHA / app attestation on OTP request** | Rate limits cap SMS cost and abuse, but cannot stop a determined distributed attacker from temporarily pausing a victim's sign-in (see "OTP abuse model"). | Firebase App Check / Play Integrity / reCAPTCHA in front of `otp/request`. |
| **Managed secrets** | `.env` is for local development only. | Provide `JWT_ACCESS_SECRET`, `OTP_HMAC_SECRET`, `DATABASE_URL`, `REDIS_URL` from the platform secret store; rotate on a schedule. |
| **Redis with authentication and TLS** | Local Memurai has no password and is bound to 127.0.0.1, which is fine only for a single developer machine. | Managed Redis with password/ACL and `rediss://`. |
| **Audit log retention** | `audit_logs` grows without bound. | Retention policy and archiving once volumes are known. |

## OTP abuse model

Goal: stop SMS bombing and brute force without letting a remote attacker keep a real user from signing in.

| Attack | Control | Residual risk |
|---|---|---|
| Spam a victim's phone with SMS | 60 s cooldown per number; 6 sends per hour per number; one client IP gets at most 3 of those 6; 10 requests per IP per 10 min | Several attacker IPs can use the whole hourly budget and block new code requests for up to an hour. The user can still use a code already received. |
| Overwrite the victim's code with a new request | Up to 3 recent codes stay valid; a new request never invalidates the previous ones | None for this vector. |
| Guess the code | Wrong guesses counted per (number, IP) = 5 and per number = 15 per 15 min; 6 digits; codes expire after 5 min; stored only as HMAC | Distributed guessing succeeds with probability about 15 / 1,000,000 per 15 minutes per number. |
| Burn the victim's guess budget to lock them out | Only wrong guesses count; the lock is per-IP first, then a temporary per-number pause (15 min). Real codes are never deleted by guessing. | An attacker using 3+ IPs can pause guessing for that number for 15 minutes at a time. CAPTCHA/attestation is the real fix. |
| Redis outage | Fail closed with `503 SERVICE_UNAVAILABLE` (no sign-in without the limiter) | Availability depends on Redis. |

Trade-off to be aware of: the per-number controls protect cost and security but can be used to cause a *temporary* annoyance. Nothing here creates a permanent lock-out.

## Tokens

* Access token: HS256 JWT, 15 minutes, only ids and the acting role. The guard re-reads the account (status, roles, worker approval, session) on every request, so revocation is immediate.
* Refresh token: 256-bit random, only SHA-256 stored, single use, rotated, replay revokes the whole session.
* Expired/revoked/spent token rows are purged automatically every 6 hours (7 day grace so recent replays are still detected) and via `npm run tokens:purge`.

### Admin refresh token in the response body

The API returns the admin refresh token in the JSON body. For the **Next.js admin portal** the safest integration is a *backend-for-frontend* pattern, **without changing this API**:

1. The browser posts credentials to a Next.js Route Handler (same origin).
2. The route handler calls `POST /api/v1/auth/admin/login` server-side.
3. It stores the refresh token in an `httpOnly; Secure; SameSite=Strict` cookie and keeps the short-lived access token server-side (or in memory), never in `localStorage`.
4. Admin pages call the API from the server (Server Components/Route Handlers) with the access token and refresh through the cookie when it expires.

This keeps tokens out of JavaScript (XSS cannot steal them) and does not break the mobile apps, which should keep tokens in the Keystore/Keychain. Cookie-based auth *on the API itself* was deliberately not introduced: it would add CSRF concerns and change the contract. Revisit if the admin portal ever calls the API directly from the browser.

## Error exposure review

* Sign-in failures return generic messages (`INVALID_CREDENTIALS`, identical for unknown email and wrong password; admin login takes the same time for both).
* `OTP_INVALID` reports the remaining attempts only; there is no hint about the real code.
* Phone numbers, IPs and codes never appear in Redis key names or stored values (hashed); audit metadata never contains codes, passwords or tokens.
* Unexpected errors return `Something went wrong`; dependency outages return `SERVICE_UNAVAILABLE`. Stack traces, SQL, connection strings and driver messages stay in server logs. Unit tests assert this for Redis, PostgreSQL and generic errors.
* Known intentional disclosures after proof of identity: `ACCOUNT_SUSPENDED` / `ACCOUNT_DEACTIVATED` (after a correct OTP), `MFA_REQUIRED` and `ACCOUNT_NOT_ACTIVE` (after a correct password).
* The `dev` SMS adapter prints the code to the API log. It is refused in production and must never be used with real users.

## Worker verification: what exists and what is still open

Implemented in phase 4 (see the README for the endpoints): admin approve / reject / request-info / suspend / reinstate with mandatory reasons for adverse decisions, an append-only history (`worker_verification_events`), audit-log entries, atomic status changes, and enforcement everywhere a worker's status matters.

Still open:

| Gap | Impact | Suggested handling |
|---|---|---|
| **Account-level suspension** (`PATCH /admin/users/:id/status`) | An admin can suspend a worker's *verification* but not block the whole account (customer role included) without editing the database. | Small endpoint: set `status`, revoke sessions, audit; forbid suspending yourself or the last admin. |
| **Real document storage** | Only the interface exists; production answers 503 for documents. | S3-compatible private bucket, signed URLs with short TTL, server-side encryption, no public ACLs, lifecycle policy. |
| **File content checks** | Only declared MIME type and size are validated; a client can lie. | Sniff content type and scan for malware after upload (before `confirm` counts). |
| **Re-review after edits** | An approved worker can still change services and cities without a new review. | Decide policy: re-review on service/city changes, or keep and rely on suspension. |
| **Document retention / PDPL** | Identity documents are personal data. | Retention period, deletion on account closure, access logging review. The download audit trail already exists. |
| **Rate limits on worker writes** | Onboarding endpoints are authenticated but not separately throttled. | Add `@RateLimit` per user once abuse is observed. |
| **Hard delete of catalog rows** | Intentionally absent; rows are deactivated. | Add only if a real need appears; deleting used rows would break history. |

Privacy rules verified by tests: public/discovery responses never contain phone, email, account id, documents, review notes or history; storage keys and checksums are not returned by any endpoint; workers can only act on their own documents (others get `404`); viewing a document is an audited admin action.

## Bookings and quotations: what exists and what is still open

Covered by tests on real PostgreSQL: ownership and role rules on every route, exact integer money, server-side pricing, one accepted quote per booking under simultaneous requests, database CHECK/UNIQUE constraints, privacy of address and contact before payment.

| Gap | Impact | Suggested handling |
|---|---|---|
| **No real payment gateway** | The provider-neutral payments, refund-request and ledger infrastructure exists and is tested, but no gateway adapter does: real money cannot move, and the webhook route answers 404. | Choose a provider, then implement `PaymentProvider` (signature verification, checkout, status lookup, refund execution). The integration points are listed in [docs/PAYMENTS_INTEGRATION.md](docs/PAYMENTS_INTEGRATION.md). |
| **Payment timeout / reopening** | An unpaid `PAYMENT_PENDING` booking stays there forever and a payment an hour past `payment_due_at` still confirms it (pinned by a test, gap 1). | Decision needed (cancel, expire or reopen), then a lock-and-recheck sweep; see the payments document. |
| **Worker suspended between acceptance and payment** | The booking still confirms and is assigned to a worker who cannot act (pinned, gap 2). | Check at payment creation and before confirming; decision on cancel/refund/reassign. |
| **Fallback to the runner-up quote** | All other quotes are rejected at acceptance, so a failed payment cannot fall back (pinned, gap 4). | Decision; may need a `SUPERSEDED`-style status instead of `REJECTED`. |
| **Worker cancellation after acceptance** | A worker cannot withdraw an accepted quote; only the customer or an admin can cancel. | Define the policy (penalties, re-opening the request to other quotes) with the business. |
| **Provisional pricing** | VAT 15%, commission 15%, minimum SAR 50 are placeholders inserted by `db:seed`. | Business confirms the figures, an admin publishes them with `POST /admin/pricing-settings`. Also confirm the VAT/commission assumptions in the README. |
| **Reviews / ratings** | `ratingAverage` is always `null` and `ratingCount` 0. Quotes show completed-job counts instead. | Reviews phase; only customers of COMPLETED bookings may review. |
| **Spam / abuse limits** | Per-customer open-request cap and per-booking quote cap exist, but no per-worker quote rate limit. | Add `@RateLimit` per user once abuse is observed. |
| **Photo content** | Only declared MIME type and size are validated, as for worker documents. | Content sniffing and malware scan after upload. |
| **Address handling** | The street address is stored in clear text (needed for service delivery). | Restrict database access, encrypt at rest at the platform level, define retention for old bookings. |
| **Housekeeping on several instances** | The expiry job is idempotent, so multiple API instances are safe, but it is a simple timer. | Move to a job queue (Redis-backed) when jobs multiply. |

Transaction design notes: every booking writer first takes `SELECT ... FOR NO KEY UPDATE` on the booking row, so locks are always acquired in the order booking, then quotes. Without that, simultaneous accept requests deadlocked (HTTP 500) in testing.

## Payments, refunds and the ledger: what exists and what is still open

Covered by tests on real PostgreSQL: one open attempt per booking under concurrency, idempotent initiation and refunds, signature rejection with no side effects, 20 simultaneous duplicate webhooks, out-of-order and unknown events, late payment for a cancelled booking, wrong amount or currency, atomic rollback and safe retry, refund limits under concurrency (also at the database), append-only ledger and immutable booking money, mock refused in production, disabled mode.

| Gap | Impact | Suggested handling |
|---|---|---|
| **Accounting policy undecided** | The ledger records customer captures only. No commission, earnings, payout, VAT or invoice postings; not production-accounting compliant. | Client and accountant decide (VAT inclusive/exclusive, commission basis, refund treatment of VAT/commission, cancellation fees, e-invoicing, payout timing), then post the reserved entry types. |
| **Refund execution** | Refunds are requests; nothing is returned and no `REFUND_COMPLETED` entry is posted. | Provider integration plus an approved refund policy. |
| **Captured-but-unapplied money** | Held and reported, never refunded automatically. | Finance procedure and, once approved, an automated refund policy. |
| **Payment-deadline action** | Disabled by design (report only); overdue unpaid bookings stay `PAYMENT_PENDING`. | Business decision on deadline length and the resulting state. |
| **Worker suspended after payment started** | Checked when payment starts, not when it completes; the paid booking is still confirmed. | Decision: cancel and refund, or reassign. |
| **Webhook hardening** | Authenticity and replay protection depend entirely on the future adapter; no IP allow-list; no alert on repeated invalid signatures. | Provider-specific work plus monitoring. |
| **Ledger protection limits** | Triggers stop application writes and casual edits; a database owner or superuser can disable them. | Separate database roles (the application role must not own the tables in production), restricted DBA access, off-site audit export. |
| **Simulation route in the build** | The development simulation endpoint is gated by configuration (404 unless the mock runs outside production), not compiled out. | Keep `PAYMENT_PROVIDER` unset or `disabled` in every deployed environment; consider excluding it from production builds. |
| **Notifications** | Customers, workers and finance are not notified of payment events. | Notifications phase. |

Operational notes: payment, webhook and refund code locks the booking row first and the payment attempt second, in every path. The provider-facing idempotency key is derived from our attempt id, never from a customer-chosen key. Provider references, fingerprints and raw payloads are not returned to customers and raw payloads are not stored.

## Realtime, live position, chat and jobs: what exists and what is still open

Covered by tests on real PostgreSQL and Memurai (details in [docs/REALTIME.md](docs/REALTIME.md)): handshake authentication with the existing access token (no token in URLs), rejection of missing, malformed, expired, forged, revoked-session and suspended-account credentials,
token refresh bound to the same session, periodic and per-event re-validation (revoked sessions are closed, users who stop participating are removed from rooms), room joins authorised from PostgreSQL (strangers, other customers/workers and administrators get "not found"),
no identity, role or status ever read from a payload, validated and rate-limited payloads, flood control, a transactional outbox (rollback announces nothing), idempotent chat sends under concurrency, a database trigger that refuses chat rows from non-participants,
append-only chat history, positions kept only in Redis with an expiry, no coordinates, tokens or message text in logs, safe behaviour when Redis is unavailable (position answers 503, chat keeps working with an in-process limiter, jobs report `degraded` and recover).

| Gap | Impact | Suggested handling |
|---|---|---|
| **Position-sharing and chat rules are engineering defaults** | The statuses (`CONFIRMED`, `IN_PROGRESS`), the 3-hour lead window and "no chat before payment" are derived from the existing state machine, not an approved policy. The state machine has no "on the way" status. | Product/legal decision; if needed an explicit worker action (new state or flag) with its own state-machine change. |
| **Live location is personal data (PDPL)** | Precise worker coordinates are processed (Redis, minutes). Worker consent, notice, purpose limitation and the customer-facing disclosure are not implemented. | Privacy review, worker consent flow in the worker app, retention statement. The 120 s expiry is configurable. |
| **Chat retention and moderation** | Messages are stored indefinitely; no report/block, profanity or abuse handling, no erase/export procedure. | Retention period, DSAR handling, moderation policy. |
| **No administrator access to chat/position** | Dispute handling cannot see conversations. | If required: explicit role rule plus mandatory audit log of every read. |
| **Bearer token over WebSocket** | The handshake token is the only credential; a leaked access token works for its remaining lifetime (<= 15 min plus the grace period) unless the session is revoked, in which case sockets close within `REALTIME_REVALIDATE_SECONDS`. | Keep TLS mandatory in production (`wss://`), keep access tokens short. |
| **Handshake rate limit is per IP and fixed** | Users behind one NAT share 60 attempts per minute; a distributed attacker is only slowed. | Make configurable, add edge rate limiting / WAF. |
| **Redis security and topology** | Local Memurai has no password. Position keys and rate-limit keys carry no environment prefix. Cluster/Sentinel behaviour is untested. | Separate Redis (or database + `QUEUE_PREFIX`) per environment, password/ACL, TLS, test failover in staging. |
| **Outbox delivery is at-least-once and best effort across instances** | During a Redis outage, events may not reach sockets on other instances (the row is still marked delivered). Clients must refetch over REST after reconnect. | Documented contract; a durable per-user notification feed would remove the dependency. |
| **Dead outbox rows are only logged** | No alert, no operator replay endpoint. | Alerting on the warning, an admin replay tool. |
| **Jobs run inside the API process** | If no instance has `JOBS_ENABLED=true`, nothing is delivered. A dedicated worker needs `@socket.io/redis-emitter`. | Deployment checklist; separate worker process when volumes justify it. |
| **No push notifications** | Offline users learn nothing until they open the app. The notification job is inert (no provider). | FCM integration in the notifications phase. |
| **Attachments not supported** | By design (no arbitrary uploads over sockets). | Use the private document-storage architecture when added. |

Operational notes: chat sends take the same per-booking row lock as the booking lifecycle (booking first, then chat rows), so they cannot deadlock with cancellations; the outbox dispatcher locks only outbox rows (`SKIP LOCKED`).
The position store and rate-limit counters are plain Redis keys documented in docs/REALTIME.md section 9; no endpoint returns keys or connection details.

## Private storage, notifications and offers: what exists and what is still open

Covered by tests on real PostgreSQL with real bytes (details in [docs/STORAGE_NOTIFICATIONS_OFFERS.md](docs/STORAGE_NOTIFICATIONS_OFFERS.md)): server-generated, non-guessable storage keys (no user file names, no traversal);
upload URLs signed for an exact type and size, expiring, never overwriting; server-side size and file-signature verification (an executable renamed `.png` is rejected); rejected uploads removed through a retried queue;
photo and document access isolation (other customers, unrelated workers, wrong-booking ids, workers reading verification documents, anonymous callers); audited administrator document views; no signed URL or storage key in any stored record or response;
notifications that cannot be read or marked by anyone but their recipient, are created only after commit, never twice, and never contain prices, addresses, phones, names or reviewer notes; push tokens encrypted at rest, owner-bound and revocable;
mock providers and the development storage refused in production; offers that cannot change any amount.

| Gap | Impact | Suggested handling |
|---|---|---|
| **No malware scanner** | Uploaded files are `NOT_SCANNED` (not "clean"). An infected PDF/image could reach an administrator's or a worker's device. `STORAGE_REQUIRE_CLEAN_SCAN` exists but cannot be used without a scanner. | Integrate a scanner behind `FileScanner` (ClamAV, a cloud service or bucket-level scanning) and turn the setting on; until then serve files as attachments (already done) and warn reviewers. |
| **S3 adapter not run against a real vendor** | Signing is verified against AWS's published vector and a mocked transport only; vendor quirks (clock skew, path style, checksums, CORS for browser uploads) are untested. | Staging test against the chosen bucket; private bucket with public access blocked, encryption at rest, versioning/lifecycle rules decided. |
| **Retention not defined** | Verification documents, photos, chat and notifications are kept indefinitely; nothing is purged by schedule. Deleted-by-owner objects are removed. | Legal/business retention periods (including rejected applicants and replaced documents), erase/export procedures (PDPL), then scheduled jobs. |
| **Document content is not validated deeply** | Only size, magic bytes and the declared type are checked. A file can be a valid PDF/JPEG and still be a forged or irrelevant document; polyglot files are not analysed; images are not re-encoded. | Re-encode images, sanitise PDFs, human review (exists), optional OCR/ID verification vendor. |
| **Signed URLs are bearer links** | Anyone holding a link can use it until it expires (default 15 minutes). | Keep `DOCUMENT_URL_TTL_SECONDS` short; consider single-use links or an authenticated streaming endpoint for verification documents. |
| **Upload rate limits are per IP** | Many users behind one NAT share them; a distributed attacker is only slowed. Quotas per account are only the existing count limits (5 photos per booking, 20 documents per worker). | Per-account quotas, WAF, bucket-side limits. |
| **Dead storage removals are only logged** | An object whose deletion keeps failing stays in the bucket and is only reported in the log. | Alerting and an operator tool to retry or force-clean. |
| **No push or SMS/email provider** | No external message is ever sent; push deliveries are `UNSUPPORTED`. When added: tokens must be revoked on sign-out by the apps; `SENT` still does not mean delivered; vendor credentials and per-user opt-out/quiet hours are needed. | See the provider list in the Phase 8 document. |
| **Device tokens move between accounts on registration** | A token is trusted to belong to whoever registers it last. A compromised session could register an attacker's device for the victim (the victim's notifications then reach the attacker). | Registration needs the authenticated session already; add device attestation (Play Integrity / App Attest) and notify the user of new devices. |
| **Notification privacy** | Pushes show a short generic text on the lock screen (booking reference only). The reference is shown to both participants of that booking. | Product decision on lock-screen content; per-user opt-outs. |
| **Offers are announcements only** | No discount can be redeemed; marketing text is trusted content written by administrators (no HTML is interpreted, but text is not moderated). | Redemption policy decisions (docs section 7) before any money is involved; admin roles/approval for publishing if more than one administrator exists. |

## Admin operations, disputes, reviews and reporting: what exists and what is still open

Covered by tests on real PostgreSQL (details in [docs/ADMIN_DISPUTES_REVIEWS_REPORTS.md](docs/ADMIN_DISPUTES_REVIEWS_REPORTS.md)): every administrator route refuses customers, workers and anonymous callers; there is no public way to change one's own role or approval status;
suspension revokes sessions, refuses REST calls, closes live sockets and blocks sign-in, and cannot target administrators or oneself; administrators have no route to mark a payment paid or to change payments, refunds, the ledger or booking money (and the database refuses it);
disputes are visible only to the two parties of the booking, evidence must belong to the same booking (service and database trigger), internal notes never reach participants, a resolved dispute can only be reopened with a reason;
reviews come only from the customer of a completed booking, once, never self-review, are immutable and never deleted at the database, and the cached rating always equals the reviews table (also under concurrent moderation);
audit entries are redacted centrally; reports contain no personal data and state what each money figure is.

| Gap | Impact | Suggested handling |
|---|---|---|
| **One administrator role** | Any administrator can suspend accounts, resolve disputes, moderate reviews and read every report. No separation of duties, no approval step, no per-administrator scope; a stolen admin session is as powerful as it was before (MFA for administrators is still outstanding). | Define roles (support, finance, operations), restrict sensitive actions, add four-eyes approval where needed, and complete admin MFA before real use. |
| **Account overview shows the full phone and e-mail** | Needed to contact users, but every administrator sees them; lists are masked. | Decide who may see contact data and audit overview reads if required. |
| **Audit log is in the same database** | A database owner can alter or delete `audit_logs` (it is not append-only at the database level like the ledger). Audit writes are best effort (a failed write is logged, not retried). | Append-only trigger or separate audit store, off-site export, alerting on write failures. |
| **No policies for disputes and reviews** | Eligibility windows, categories, service levels, compensation, review editing and replies are engineering defaults (documented), not approved rules. Disputes are not connected to refunds: the money follow-up flag has no workflow behind it. | Business and legal decisions before launch. |
| **User-generated text is stored indefinitely** | Dispute descriptions, comments and review texts are personal data with no retention, export or erasure procedure; reviews are never deleted (only hidden or withdrawn). | Retention and erasure policy (PDPL), moderation tooling, abuse reporting. |
| **No notifications for disputes and reviews** | Parties learn about dispute progress only by opening the app. | Add notification types when the wording and recipients are approved. |
| **Reports are live queries** | Large ranges on large tables are heavier than snapshots; `operations` and notification counts are not indexed by time. They are not accounting reports and must not be used as such (no VAT, revenue or payout figures exist). | Materialised snapshots, export, and accounting-approved definitions when the policy exists. |
| **Time zone** | Connections are pinned to UTC, but any other component that reads the database (reports tools, BI, DBAs) sees UTC timestamps; report buckets use the Asia/Riyadh calendar day. | Keep UTC in storage; document the Riyadh bucketing for readers of the reports. |

## Production hardening (configuration safeguards, audit integrity, safe logging)

See [docs/PRODUCTION_HARDENING.md](docs/PRODUCTION_HARDENING.md): production start-up now requires an explicit `TRUST_PROXY_HOPS` and TLS plus a password for any non-local PostgreSQL or Redis; `audit_logs` is append-only in the database (migration `20261030090000_audit_log_integrity`, applied to the test database only); error logging never quotes database error text and scrubs credential-like fragments; the admin refresh token in the response body is analysed there (unchanged).

## Firebase Phone Authentication

See [docs/FIREBASE_SETUP.md](docs/FIREBASE_SETUP.md). The endpoint `POST /auth/firebase/phone` verifies a Firebase ID token server-side and takes the phone number only from the verified token. It is off by default. An existing account is signed in only if it is already linked to the same Firebase identity (the link is recorded in the append-only audit trail; there is no Firebase UID column), administrators are never reachable this way, tokens are exchanged once and only shortly after the SMS check, and the service-account key stays on the server. With Firebase sign-in on, the API refuses to start unless the audit-log protection triggers are installed and enabled. Production account linking (a stored identity binding, a support recovery flow) is still to be decided.

## Push notifications (FCM)

See [docs/FIREBASE_SETUP.md](docs/FIREBASE_SETUP.md) section 6. Push is off by default; `PUSH_PROVIDER=fcm` is an explicit opt-in that needs the Firebase project, a backend-only service account and the device-token encryption key, and is independent of phone sign-in. Device tokens are owned by the authenticated caller, stored encrypted and never returned or logged; only Firebase error codes are logged; dead tokens are revoked, while credential or configuration failures never revoke devices. `FCM_DRY_RUN=true` validates messages without delivering them.

## File lifecycle and malware scanning

See [docs/FILE_LIFECYCLE.md](docs/FILE_LIFECYCLE.md). No real malware scanner is integrated: files stay `NOT_SCANNED` unless a scanner is added, and production with S3 refuses to start without either a scanner or the explicit `STORAGE_ALLOW_UNSCANNED_FILES=true`. With a scanner, pending, failed and infected files are never served and scanner outages fail closed. Identity-document links default to 300 seconds; unconfirmed uploads are cleaned up after a configurable age.

## Network exposure on the development machine

PostgreSQL 18 on this machine has `listen_addresses = '*'` (the installer default) but `pg_hba.conf` only contains entries for `127.0.0.1/32` and `::1/128`, and Windows Firewall has no inbound allow rule for PostgreSQL. Remote hosts are therefore refused, but the port is still open at the TCP level. Restrict it to loopback as defence in depth (exact steps in the stabilisation report and below). Memurai listens on `127.0.0.1` only.

```powershell
# Run in an elevated (Administrator) PowerShell. Review each step before running.
$conf = 'C:\Program Files\PostgreSQL\18\data\postgresql.conf'
Copy-Item $conf "$conf.bak"                                   # backup first
(Get-Content $conf) -replace "^\s*#?\s*listen_addresses\s*=.*", "listen_addresses = 'localhost'" | Set-Content $conf
Restart-Service postgresql-x64-18
Get-NetTCPConnection -State Listen -LocalPort 5432 | Select LocalAddress,LocalPort   # expect only 127.0.0.1 / ::1
```

Rollback: `Copy-Item "$conf.bak" $conf -Force; Restart-Service postgresql-x64-18`.
