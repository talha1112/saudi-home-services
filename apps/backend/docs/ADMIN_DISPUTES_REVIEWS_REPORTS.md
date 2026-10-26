# Admin operations, disputes, reviews and reporting (Phase 9)

Backend only; no app or admin-portal code changed. Tested against real PostgreSQL ([Verification](#9-verification)).

- [1. Administrator model and audit](#1-administrator-model-and-audit)
- [2. Account administration](#2-account-administration)
- [3. Booking administration](#3-booking-administration)
- [4. Disputes](#4-disputes)
- [5. Reviews and ratings](#5-reviews-and-ratings)
- [6. Reports](#6-reports)
- [7. Financial integrity](#7-financial-integrity)
- [8. Decisions still needed, limitations](#8-decisions-still-needed-limitations)
- [9. Verification](#9-verification)
- [10. Migration](#10-migration)
- [11. A defect found on the way: database time zone](#11-a-defect-found-on-the-way-database-time-zone)

## 1. Administrator model and audit

**One role exists: `ADMIN`.** There are no permission tiers, and none were invented (no concrete requirement exists). Every `/api/v1/admin/**` route requires the `ADMIN` acting role
(`@Roles(Role.ADMIN)`, enforced by the global `RolesGuard` after `JwtAuthGuard`; a coverage test fails if a new route forgets it) and the services re-check the state of the target.
Authentication (who you are: token, live session, active account) and authorization (what you may do: role, ownership, state) stay separate layers. Consequences to be aware of:
any administrator may do everything below, including suspending accounts and moderating reviews; there is no separation of duties, no four-eyes approval and no per-administrator scope. If that is not acceptable, a permission model must be designed first.

What an administrator can **not** do, on purpose: impersonate a user; mark a payment successful (the only way a booking becomes paid is a signature-verified provider event); edit or delete payments, refunds, ledger entries or booking money snapshots
(no such routes exist, and database triggers refuse it); create, edit or delete a review; edit a dispute's text; suspend or change another administrator; delete any user.

**Audit trail.** Sensitive actions write to the existing `audit_logs` table through the existing `AuditService` (actor, dotted action, entity type and id, small metadata, IP address and user agent, timestamp):

| Area | Actions |
|---|---|
| Accounts | `user.suspended`, `user.reactivated` (before/after status, reason) |
| Worker verification | `worker.verification.*` (existing), `worker.document.accessed`, document review (existing) |
| Bookings | `booking.cancelled_by_admin` (previous status), `booking.photo.accessed` |
| Disputes | `dispute.assign`, `.start_review`, `.request_info`, `.internal_note`, `.resolve`, `.close`, `.reopen` (before/after status, whether a note exists, money follow-up flag; **never the note text**) |
| Reviews | `review.hide`, `review.restore` (before/after status, reason) |
| Pricing, offers, payments | `pricing.setting.created`, `offer.created/updated/publish/pause/archive`, `payment.refund.*` (existing), `payment.webhook_event.retried` |

Domain history tables (`booking_events`, `dispute_events`, `review_events`, `offer_events`, `worker_verification_events`) hold the full append-only story; `audit_logs` is the uniform "who did what" feed, readable by administrators at `GET /api/v1/admin/audit-logs`
(filters: actor, action, entity type/id, date range; paginated; IP address and user agent are not returned).

**Redaction** is applied to every audit entry centrally (`redactAuditMetadata`), whatever the caller passes: values of keys that look like `password`, `secret`, `token`, `authorization`, `cookie`, `signature`, `signed`, `credential`, `otp`, `storageKey`, `url` become `[redacted]`;
values that look like a bearer header, a JWT, a PEM block or a signed link (`X-Amz-...`, `sig=`) are redacted under any key; strings are cut at 300 characters. Callers must still pass only small, non-personal context. Reviewed text, dispute descriptions and notes are never copied into audit metadata.
Not audited: plain reads of lists and reports (document and photo reads are audited, as before).

## 2. Account administration

`/api/v1/admin/users` (the existing `GET :userId` summary remains):

| Route | Purpose |
|---|---|
| `GET /admin/users?role&status&q&page&limit` | Customers and workers, **redacted**: masked phone (`+9665••••5678`) and e-mail, status, roles, worker verification status. `q` searches phone, e-mail and name (2-60 characters). Administrators are never listed. |
| `GET /admin/users/{id}/overview` | Status and reason; for workers: verification status, online flag, service/area counts, document *kinds and review state only*, rating; booking counts by status and the 10 latest booking summaries (as customer and as worker); dispute counts. No storage keys, no documents, no addresses. |
| `POST /admin/users/{id}/suspend` `{reason}` | `ACTIVE -> SUSPENDED`. Reason (3-500 characters) required. |
| `POST /admin/users/{id}/reactivate` `{reason}` | `SUSPENDED -> ACTIVE`. Reason required. |

Suspension is reversible and **takes effect at once**: the status change is a compare-and-set (two simultaneous decisions: one wins); every refresh token is revoked (so existing access tokens are refused as `SESSION_REVOKED` on their next use and the person must sign in again after reactivation);
a worker is set offline so no new requests are offered; live sockets of the account are closed on every instance (and the periodic revalidation closes any it missed). Existing bookings, payments, disputes and reviews are **not** touched: an administrator decides about them separately.
Cannot be applied to administrators, to oneself, or to an account that is not in the required state. Worker *verification* (approve, reject, request info, suspend, reinstate) keeps using the existing workflow; account suspension is separate and stronger.
Nothing is deleted: bookings, payments, ledger entries, disputes, reviews and audit records are retained. Users cannot change their own role or approval status: no public route accepts those fields (tested; unknown fields are rejected).

Identity documents appear only through the existing audited document routes. Saudi identity-document requirements are not modelled beyond the existing configurable rule.

## 3. Booking administration

Existing routes, reused: `GET /admin/bookings` (filters: status, serviceId, cityId, customerId, workerId, reference, createdFrom/createdTo), `GET /admin/bookings/{id}` (quotes, money including commission, event timeline),
`POST /admin/bookings/{id}/cancel` (note required), payments/refunds/ledger/reconciliation under `/admin/payments`, `/admin/refunds`, `/admin/ledger`. Phase 9 added tests and the missing audit/redaction coverage, not new ways to change bookings.
Cancellation goes through `BookingLifecycleService` (compare-and-set, event row with `actorRole = ADMIN`, audit entry). It does **not** refund automatically and posts nothing to the ledger; refunds remain requests (`REQUESTED`) until a provider workflow exists.
Quote acceptance and assignment rules are unchanged.

## 4. Disputes

A dispute is a complaint about **one booking**, opened by its customer or its assigned worker and handled by administrators. It changes nothing else: no booking status, money, ledger entry, refund, rating or account.

**Who and when.** Only the booking's customer, or the worker assigned to it, can open one (anyone else: 404). The booking must be `CONFIRMED`, `IN_PROGRESS`, `COMPLETED`, or `CANCELLED` **after having been confirmed** (paid). Open, unpaid and expired requests cannot be disputed.
No time limit applies because none was approved. **One active dispute per booking** (`OPEN`, `UNDER_REVIEW`, `AWAITING_INFO`): enforced by a partial unique index, also under simultaneous attempts. A `RESOLVED` dispute is not active, so a recurring problem can start a new one; then the old one cannot be reopened (409) until the new one is finished.

**State machine** (`dispute-state-machine.ts`; nothing else decides):

| Action | From | To | Who | Note |
|---|---|---|---|---|
| open | - | OPEN | participant | description 10-2000 characters, category, optional evidence |
| comment | OPEN, UNDER_REVIEW, AWAITING_INFO | same; AWAITING_INFO -> UNDER_REVIEW | participant | text required |
| add evidence | the three active states | same | participant | up to 10 items |
| withdraw | OPEN | CLOSED | the opener only | |
| assign | active | same | admin | to an active administrator (default: me) |
| start review | OPEN, AWAITING_INFO | UNDER_REVIEW | admin | assigns the admin when unassigned |
| request info | OPEN, UNDER_REVIEW | AWAITING_INFO | admin | note shown to participants (required) |
| internal note | any except CLOSED | same | admin | visible to administrators only |
| resolve | UNDER_REVIEW | RESOLVED | admin | `summary` (shown to participants, required); optional internal note; optional `financialFollowup = REQUESTED` |
| close | RESOLVED | CLOSED (final) | admin | note required (kept internal) |
| reopen | RESOLVED | UNDER_REVIEW | admin | reason required (kept internal); counts reopenings |

A resolved dispute cannot be edited: participants can only read it; only `reopen` (reasoned, audited, recorded in history) or `close` move it. The description, category, booking and opener never change (database trigger). History (`dispute_events`) is append-only (trigger).

**Visibility.** Participants (both parties of the booking) see the description, shared history, evidence and, once resolved, the resolution summary. They never see internal notes, administrators' reasons for reopening/closing, who handles the case, or a resolution that has been superseded by a reopening.
Administrators see everything. Evidence is a **reference** to an existing uploaded booking photo or chat message **of the same booking** (checked by the service and by a database trigger); files are never copied, no links are stored, and a photo cited as evidence cannot be deleted (409) while the dispute exists.

**Money.** `financialFollowup = REQUESTED` only *flags* that someone should consider a refund or compensation in a **separate, not yet existing, approved workflow**. Nothing is refunded, reversed or compensated; reports count the flag, never an amount.

**Not decided (do not guess):** arbitration or compensation rules; time limit for opening; service-level targets; whether workers may be penalised or suspended because of a dispute (explicitly not connected); notifications for dispute events (not sent; the notification templates have no dispute types); dispute evidence beyond photos and chat (for example documents).

## 5. Reviews and ratings

**Eligibility.** The customer of a `COMPLETED` booking reviews the worker who did it: rating 1-5, optional comment up to 1000 characters. One review per booking (unique), enforced under concurrency. A worker can never review their own service. Checked in the service **and** by a database trigger (completed booking, same customer, same worker, not self, created `PUBLISHED`).
No time limit exists (none approved).

**Editing / withdrawal (conservative defaults; no policy was approved).** Reviews are **not editable** (trigger). The customer may **withdraw** a review (`DELETE /bookings/{id}/review`): final, it stops counting, and the booking cannot be reviewed again. Reviews are never deleted (trigger).

**Moderation.** Administrators can `hide` a published review and `restore` a hidden one, with a required reason. They cannot create, edit or delete reviews (no such routes) and cannot revive a withdrawn review. Every change appends to `review_events` (actor, role, reason) and `audit_logs`; the original rating and comment are never altered.
The customer sees "HIDDEN" but not the reason or the administrator. Moderation is independent of payments and disputes.

**Rating calculation.** A worker's rating is the average of their **PUBLISHED** reviews (hidden and withdrawn ones excluded), rounded to 2 decimals, `null` with no reviews. The count and sum are cached on `worker_profiles` and **recomputed from the `reviews` table**, never incremented, inside the same transaction as every
submission, withdrawal, hide and restore, after taking a row lock on the worker profile so concurrent changes for one worker run one after another (tested with simultaneous submissions and mixed moderation). A CHECK keeps `sum` within `count`..`5 x count`. The rating is exposed via
`GET /reviews/workers/{workerId}` (customers; approved active workers only; published reviews, no customer identity, paginated, distribution) and `GET /reviews/received` (the worker). Discovery and profile responses were not changed.

## 6. Reports

All under `GET /api/v1/admin/reports/...`, `ADMIN` only, read-only, aggregated in PostgreSQL, no personal data (no names, phones, e-mails or ids of people). Ranges: `from` inclusive, `to` exclusive (ISO 8601), default last 30 days, at most 366 days, otherwise `400 INVALID_RANGE`.
Every response includes a `definitions` object; the table gives the essentials.

| Endpoint | Metrics | Source |
|---|---|---|
| `bookings?top` | bookings **created** in the range by their **current** status, per service and per city (top N, max 100); cancellations in the range by reason and who cancelled | `bookings`, `booking_cancellations` |
| `bookings/trend?interval=day\|week\|month` | created / completed / cancelled counts per **Asia/Riyadh** calendar bucket; empty buckets omitted | `bookings.created_at`, `completed_at`, `cancelled_at` |
| `quotes` | quotes created in the range (and by current status); bookings whose quote was **accepted** in the range. Different populations: no ratio is computed | `quotes`, `bookings.accepted_at` |
| `workers` | **snapshots** (ignore the range): workers by verification status, active (approved + account active), online now (a flag), accounts by status; registrations in the range by role | `worker_profiles`, `users`, `user_roles` |
| `reviews` | reviews submitted in the range by current status; of the published ones: count, average (2 decimals), distribution 1-5 | `reviews` |
| `disputes` | opened in the range by current status and category; how many flagged a money follow-up; how many were reopened | `disputes` |
| `notifications` | in-app notifications created/read; external delivery rows by channel and status | `notifications`, `notification_deliveries` |
| `operations` | **snapshot**: realtime outbox pending/stale/dead, storage removals pending/dead, notification deliveries queued/failed, failed payment webhook events, payments awaiting reconciliation | `realtime_outbox_events`, `storage_deletions`, `notification_deliveries`, `payment_webhook_events`, `payment_attempts` |
| `payments?includeSimulated` | see below | `payment_attempts`, `payment_refunds` |
| `ledger?includeSimulated` | see below | `ledger_entries` |

**Reading the money numbers (important).** Amounts are integer **halalas, grouped per currency; currencies are never summed together.** Simulated (mock-provider) money is excluded unless `includeSimulated=true`.

| Field | What it is | What it is **not** |
|---|---|---|
| `paymentAttemptsByStatus[].requestedToCollectHalalas` | what we asked customers to pay, per attempt status | funds. An `INITIATED` or `PROCESSING` attempt has collected nothing |
| `providerReportedCapturedAndApplied` | attempts in the range with status `SUCCEEDED`: what a signature-verified provider event reported and that was applied to a booking | a bank settlement, payout or revenue |
| `capturedButUnappliedAllTime` | **all-time** open reconciliation items: captured money not applied to a booking (cancelled booking, duplicate, wrong amount) | refunded or lost money; nothing is refunded automatically |
| `refundRequestsByStatus` | refund **requests** created in the range by status; `REQUESTED` = asked for, **no money has moved** | completed refunds |
| `refundsConfirmedByProvider` | only status `SUCCEEDED`. No provider can execute refunds yet, so this stays empty | |
| `ledger.entriesByType` | the append-only ledger entries posted in the range, summed per entry type and currency exactly as stored (refunds are negative) | a bank balance, recognised revenue, VAT, commission or worker payout. Commission, earnings and payout entry types are reserved and unused until the accounting policy is approved |

No VAT liability, recognised revenue or worker payout obligation is calculated anywhere. **Indexes** added only for the new date-range queries: `bookings(created_at)`, `bookings(completed_at)` and `(cancelled_at)` (partial), `quotes(created_at)`.
Existing indexes already cover disputes, reviews, refunds, payment attempts and ledger entries by status/type and time. Notification delivery counts by date scan the table (acceptable at current volumes; add an index if it grows).

## 7. Financial integrity

Untouched and tested: no payment gateway, no charges or refunds executed, no payouts, no change to ledger entries, VAT, commission or the booking money snapshot, no offer redemption. Reports only read. See also the Phase 6 document for the payment model.

## 8. Decisions still needed, limitations

1. **Administrator permissions.** One role; a permission model (support vs finance vs operations), separation of duties, and restrictions on who may suspend or moderate need a requirement.
2. **Dispute policy.** Categories, time limit, service levels, evidence types, who may be notified and how, arbitration/compensation rules, and what a "financial follow-up" becomes (needs the approved refund and accounting policy).
3. **Review policy.** Whether customers may edit within a window, a review time limit, whether workers may reply or report a review, minimum text rules, how a hidden review is explained to its author, and any link between disputes, refunds and reviews (none exists).
4. **Reporting policy.** Fiscal definitions (revenue, VAT, commission, payouts) are intentionally absent. Report access is all-or-nothing per administrator, and reports are computed live (no snapshots, caching or export).
5. **Data protection.** Reviews, dispute text and audit entries are retained indefinitely; retention, erasure and export rules are not defined. Admin account lists show masked contact data but the account overview shows the full phone number and e-mail.
6. **Not implemented:** notifications for disputes and reviews, admin routes to edit worker/customer profile data, bulk operations, CSV export, an admin UI, alerting on the operations report, realtime push of a suspension to other API instances without the Redis adapter (the 60-second revalidation covers it).

## 9. Verification

```powershell
npm run typecheck
npx prisma validate
npm test                                # unit, including the dispute state machine and audit redaction
npm run test:e2e
npm run test:integration:admin          # admin operations, disputes, reviews, reports (real PostgreSQL)
npm run test:integration                # everything
npm audit --omit=dev
```

## 10. Migration

`20261029090000_disputes_reviews_reporting`: new tables `disputes`, `dispute_events`, `dispute_evidence`, `reviews`, `review_events`; two defaulted columns on `worker_profiles` (`rating_count`, `rating_sum`); CHECK constraints, triggers and partial indexes written by hand at the end; four report indexes. No existing data is changed.
It is applied to the isolated test database only. The development database `saudi_home_services` still has **five** migrations pending (Phases 5, 6, 7, 8 and 9). After approval, from `apps\backend`:

```powershell
npm run check:local          # read-only: confirms the target database and UTF-8 encoding
npm run db:migrate:status    # read-only: should list the five pending migrations
npm run db:migrate:deploy    # applies pending migrations only; never resets or drops
```

## 11. A defect found on the way: database time zone

While testing report buckets, rows written by the application with an explicit timestamp (for example `createdAt` set in a test) came back five hours off. Cause: the Prisma PostgreSQL adapter sends JavaScript `Date` values as zone-less UTC text, and PostgreSQL interprets such text in the **session** time zone;
the local Windows cluster runs in `Asia/Karachi`, so every application-supplied timestamp (offer windows, quote validity, preferred times, token expiries, ...) was stored shifted by the server's offset while `now()` defaults were correct. A production database normally runs in UTC and would not show it.
Fix: `PrismaService` now opens every connection with the startup option `-c TimeZone=UTC` (per-connection, no server configuration changed). A regression test asserts the session zone and an exact round trip. If a connection pooler that rejects startup options is ever placed in front of PostgreSQL, the pooler/database must be configured for UTC instead.
