# Payments, refunds and the ledger

Status after Phase 6: **the provider-neutral infrastructure is built and tested on real PostgreSQL. No real payment gateway is integrated, no real charge or refund can happen, and the accounting policy is not decided.** Read sections 12 and 13 before calling any part of this production-ready.

Related: [SECURITY.md](../SECURITY.md), [README.md](../README.md#payments).

## 1. What exists

| Piece | Where | Purpose |
|---|---|---|
| `payment_attempts` | `prisma/schema.prisma`, `modules/payments` | One try to collect a booking's agreed total. Many per booking over time, **at most one open** (database-enforced). |
| `payment_webhook_events` | same | Inbox of **verified** provider events, deduplicated by `UNIQUE(provider, account_scope, provider_event_id)`. |
| `payment_refunds` | same | Refund **requests**. Nothing is returned until a provider confirms (future phase). |
| `ledger_entries` | same | Append-only journal of money movements (triggers forbid UPDATE/DELETE/TRUNCATE). |
| `PaymentProvider` adapter | `modules/payments/provider` | Gateway abstraction with two built-ins: `disabled` (default) and `mock` (development). |
| Booking hook | `BookingLifecycleService.confirmPaymentInTransaction` | The only way a booking becomes `CONFIRMED`; reused unchanged by the event processor. |
| Money snapshot trigger | `bookings_money_snapshot_immutable` | The agreed amounts on a booking can never change after acceptance. |

Not built (by design): any real gateway, real refunds, worker payouts, commission/VAT/earnings postings, invoices, the payment-deadline action.

## 2. Invariants and how they are enforced

| # | Invariant | Enforced by |
|---|---|---|
| 1 | Money = integer halalas + ISO currency | `INTEGER` columns, `CHECK currency ~ '^[A-Z]{3}$'`, `CHECK amount > 0`, no float arithmetic anywhere (`modules/pricing/money.ts`) |
| 2 | The agreed booking amounts never change | Database trigger `bookings_money_snapshot_immutable` (tested), plus the existing accept-time snapshot |
| 3 | A payment attempt cannot choose its amount | `PaymentsService.initiate` copies `total_amount_halalas`/`currency` from the booking; the DTO rejects any amount/currency field |
| 4 | Exactly one open attempt per booking | `UNIQUE(booking_id, open_slot)` where `open_slot` is TRUE only for `INITIATED`/`PROCESSING` (a `CHECK` keeps the flag consistent with the status) |
| 5 | A repeated request is not a second payment | `UNIQUE(customer_id, idempotency_key)` + request fingerprint; the same key with another body is `409 IDEMPOTENCY_CONFLICT` |
| 6 | A repeated provider event has no second effect | `UNIQUE(provider, account_scope, provider_event_id)`; claim by compare-and-set; ledger `UNIQUE(idempotency_key)` (`payment:<id>:capture`); `confirmPaymentInTransaction` refuses a second confirmation |
| 7 | Payment, booking confirmation, ledger entry and "event processed" commit together | One database transaction in `PaymentEventsService.apply`; a failure rolls everything back and marks the event `FAILED` |
| 8 | A browser return is never proof of payment | Nothing in the API marks a payment succeeded; only a verified event (or the admin-only development simulation) does |
| 9 | A cancelled/non-payable booking is never marked paid | `confirmPaymentInTransaction` returns `BOOKING_NOT_PAYABLE`; the capture is stored as `CAPTURED_UNAPPLIED` and posted to the ledger as `PAYMENT_CAPTURED_UNAPPLIED` |
| 10 | Captured money that cannot be applied stays traceable | `CAPTURED_UNAPPLIED` status + reason + ledger entry + reconciliation report; never discarded, never auto-refunded |
| 11 | Posted ledger entries are never edited | Triggers raise an error on UPDATE/DELETE/TRUNCATE; the only writer is `LedgerService.post`; corrections are `CORRECTION` entries |
| 12 | Refunds never exceed what was captured | `refund_reserved_halalas` on the attempt, updated under row locks, with `CHECK refund_reserved_halalas <= captured_amount_halalas` as the final guard |
| 13 | Mock events never pass as genuine | Mock does not accept webhooks; simulated events only match simulated attempts; everything simulated is flagged `is_simulated` |
| 14 | No secrets in logs/responses | Provider references, fingerprints, idempotency keys and raw payloads are never returned to customers; the inbox stores a hash and normalised facts, not the payload |

## 3. State machines

### Payment attempt (`payment-state.ts`, unit-tested over the whole matrix)

```text
INITIATED --> PROCESSING --> SUCCEEDED           captured, exact agreed amount and currency, booking CONFIRMED
     |            |     \-> CAPTURED_UNAPPLIED   captured but NOT applied (reconciliation)
     |            |     \-> FAILED | CANCELLED | EXPIRED
     \-> any open outcome directly (provider refused, customer cancelled...)
FAILED | CANCELLED | EXPIRED --> SUCCEEDED | CAPTURED_UNAPPLIED     a LATE capture is a fact and is recorded
SUCCEEDED, CAPTURED_UNAPPLIED are terminal.
```

A later failure/cancel/expiry event can never undo a capture; an event older than the newest applied one is ignored; repeated events are ignored as duplicates.

### Webhook inbox

`RECEIVED -> PROCESSING -> PROCESSED | IGNORED | FAILED`. `FAILED` can be retried (provider redelivery or the admin retry endpoint); a `PROCESSING` claim older than `PAYMENT_WEBHOOK_LEASE_SECONDS` can be taken over after a crash. `IGNORED` with outcome `ORPHAN_UNKNOWN_PAYMENT` can be retried once the payment reference exists.

Outcomes recorded: `APPLIED`, `CAPTURED_UNAPPLIED:<reason>` (`AMOUNT_MISMATCH`, `CURRENCY_MISMATCH`, `DUPLICATE_PAYMENT`, `BOOKING_NOT_PAYABLE`), `SETTLED` (failed/cancelled/expired), `DUPLICATE_EVENT`, `STALE_EVENT`, `UNSUPPORTED_EVENT`, `SIMULATION_MISMATCH`, `ORPHAN_UNKNOWN_PAYMENT`.

### Refund

`REQUESTED -> PROCESSING -> SUCCEEDED | FAILED`, `REQUESTED -> CANCELLED`. In this phase only `REQUESTED` and `CANCELLED` can happen: there is no endpoint that moves a refund forward and `moneyReturned` is true only for `SUCCEEDED`. A request reserves the amount; cancelling releases it.

### Booking (unchanged rules, new interplay)

`PAYMENT_PENDING --verified full-amount capture--> CONFIRMED`. Every other outcome leaves the booking as it was. What an unpaid booking becomes after its deadline is **not decided** (section 8).

## 4. Initiation (`POST /api/v1/bookings/:bookingId/payments`)

Header `Idempotency-Key` is mandatory. Body: optional `returnUrl` (must match `PAYMENT_RETURN_URL_ORIGINS`).

1. **Transaction A (database only)**: lock the booking; check ownership (someone else's booking is a 404), the idempotency key (replay or `409 IDEMPOTENCY_CONFLICT`), `PAYMENT_PENDING`, not already paid, deadline not passed, worker still approved and active; close a stale open attempt whose checkout expired; create the next `INITIATED` attempt with the booking's snapshot amount.
2. **External side effect (no transaction held)**: `provider.createCheckout(...)` with the server-derived key `pay_<attempt id>`. The customer's own key is deliberately **not** sent to the provider: it is unique only per customer and two customers could collide (a defect found and fixed in this phase).
3. **Transaction B (database only)**: `INITIATED -> PROCESSING`, store the provider reference and checkout address. If a webhook or a cancellation changed the attempt meanwhile, the newer state wins.

Failure handling: a definitive refusal (`ProviderRejectedError`) records `FAILED` and answers `502`; an unknown outcome (timeout, crash between steps 2 and 3, database error) leaves the attempt `INITIATED`. Repeating the request with the same key repeats step 2 with the same provider key (an idempotent adapter returns the same checkout) and completes step 3. No second payment is created. Stuck `INITIATED` attempts appear in the stale report.

With no provider configured nothing is written and the answer is `503 PAYMENT_PROVIDER_NOT_CONFIGURED`.

## 5. Event processing (`PaymentEventsService`)

```text
adapter.verifyWebhook(rawBody, headers)       signature over the exact bytes; invalid => 401, nothing stored
  -> inbox INSERT ... ON CONFLICT DO NOTHING  only one delivery inserts
  -> claim (compare-and-set RECEIVED/FAILED/stale PROCESSING -> PROCESSING)   a concurrent delivery answers "in_progress"
  -> ONE TRANSACTION:
       lock booking  ->  lock payment attempt     (always this order)
       re-read attempt, decide from its CURRENT state (payment-state.decideEvent)
       capture: verify amount + currency -> confirmPaymentInTransaction -> attempt SUCCEEDED
                or CAPTURED_UNAPPLIED with a reason
       post ledger entry (idempotent), mark inbox PROCESSED/IGNORED with the outcome
  -> commit.  On any error: roll back, mark FAILED with a short code (never provider text), answer 503 so the provider retries
```

Lock order everywhere (initiation, events, refunds, cancellation, sweep): **booking, then payment attempt, then refund.** One order is what prevents deadlocks.

Unknown payment reference: recorded as `ORPHAN_UNKNOWN_PAYMENT`, confirms nothing, listed in the reconciliation report. The sweep retries recent orphans whose payment reference has since appeared (a delivery that overtook our own commit).

## 6. Providers

| Mode (`PAYMENT_PROVIDER`) | Behaviour |
|---|---|
| `disabled` (default, every environment) | Initiation answers `503`; webhook and simulation routes answer `404`; nothing is stored. |
| `mock` | Development/tests only. **Refused in production**: environment validation fails and `selectPaymentProvider` throws, so the process does not start. Checkout is simulated (`https://mock-checkout.invalid/...`), every row it creates is `is_simulated`. It accepts **no** webhooks. Outcomes are injected by `POST /api/v1/dev/payments/:id/simulate`: administrators only, 404 unless the mock is active outside production, a different path from the webhook route, and it can only touch simulated attempts. |

The test-only `SignedTestPaymentProvider` (`src/testing`) is injected by the test suites to exercise the real webhook path with HMAC signatures. It cannot be selected by configuration.

### Integration points for a real provider (nothing provider-specific is assumed here)

Implement `PaymentProvider` (`provider/payment-provider.ts`), add its name to `PaymentProviderName` and `selectPaymentProvider`, document its variables in `.env.example`. Work that is provider-specific and **not done**:

- **`verifyWebhook`**: the provider's documented signature scheme, header names, timestamp tolerance, secret rotation; return a `NormalizedPaymentEvent` with integer halalas and a stable event id. A success event must carry amount and currency (call `getPayment` if the webhook does not).
- **`createCheckout`**: request fields, amount formatting (no floating point), hosted page vs client secret, expiry, and honouring the idempotency key `pay_<attempt id>`.
- **`getPayment`**: authoritative status for reconciliation.
- **`requestRefund`**: execution, refund events, mapping to `payment_refunds` and the (reserved) `REFUND_COMPLETED` ledger entry. Not implemented by any adapter yet.
- **Webhook endpoint hardening** beyond this repo: provider IP allow-listing if the provider publishes ranges, TLS, secret storage, alerting on repeated invalid signatures.
- Raw body: `rawBody: true` is already enabled in `main.ts`; the route rejects bodies over `PAYMENT_WEBHOOK_MAX_BODY_BYTES`.

## 7. Refund requests

`POST /api/v1/admin/payments/:id/refunds` (administrators, `Idempotency-Key` required, `reason` required). Allowed only for captured payments (`SUCCEEDED` or `CAPTURED_UNAPPLIED`); the amount may not exceed `captured - reserved`. Concurrent requests are serialised by the payment row lock and bounded by the database `CHECK`. The response says plainly `REQUESTED ... No money has been returned`. `POST /admin/refunds/:id/cancel` withdraws a request that has not reached a provider.

No policy is encoded: the administrator chooses the amount. VAT, commission and fees on refunds are **undecided**.

## 8. Payment deadline and reconciliation

`bookings.payment_due_at` is set at acceptance (`PAYMENT_WINDOW_MINUTES`, provisional 30). **The state-changing action is disabled** (`PAYMENT_DEADLINE_ACTION = 'REPORT_ONLY'`) because the business has not decided the deadline length or whether an unpaid booking is cancelled, expired, reopened, or falls back to another quote.

Built so the decision is a small change later:

- `PaymentsAdminService.findOverduePendingBookings` (indexed by `bookings(status, payment_due_at)`), `findStaleAttempts`, and the report at `GET /api/v1/admin/payments/reconciliation` (overdue unpaid bookings, stale attempts, captured-but-unapplied payments, failed events, orphan events).
- `PaymentsMaintenanceService` (every 5 minutes, disabled in tests): counts and logs, changes no booking, never marks an attempt successful, and only retries orphan events through the normal verified path.
- When a policy exists, the action belongs in that service under `lockBooking()` with a re-check of `status = PAYMENT_PENDING AND confirmed_at IS NULL AND payment_due_at <= now()` and no open attempt, writing a booking event. A payment that arrives afterwards is already handled: it becomes `CAPTURED_UNAPPLIED` with `BOOKING_NOT_PAYABLE`.
- Checkout expiry is capped by the payment deadline. An open attempt whose checkout has expired is closed locally (`EXPIRED`) when the customer starts a new one; a later provider capture for it is still recorded.

This is **not** reconciliation with the gateway's balances: that needs a real provider.

## 9. The ledger

`ledger_entries` (append-only): `entry_type`, signed `amount_halalas` (+ money received, - money paid out), `currency`, links to `booking`/`payment`/`refund`, `reverses_entry_id`, unique `idempotency_key`, `source_type`/`source_id`, `description`, `is_simulated`, `posted_at`. `CHECK`s enforce non-zero amounts, sign by type, a payment link on captures, a refund link on refunds, and a reversed entry on corrections (an entry can be reversed once).

Posted today: `PAYMENT_CAPTURED` and `PAYMENT_CAPTURED_UNAPPLIED`. Reserved and **not posted until approved**: `REFUND_COMPLETED`, `COMMISSION_ACCRUAL`, `WORKER_EARNING_ACCRUAL`, `WORKER_PAYOUT`, `CORRECTION`.

Implications of the triggers: migrations must never UPDATE/DELETE ledger rows (fix data with a correcting entry); `TRUNCATE` is refused; a table owner or superuser can still disable the triggers, so this protects against application mistakes and casual edits, not a malicious DBA. The integration-test cleanup (`test/support/bookings-harness.ts`) disables the trigger inside a transaction for its own rows, only after the `_test` database-name guard. Never do that on a real database.

**This is a journal, not a finished accounting system.** It is not production-accounting compliant: there are no accounts, balances, revenue recognition or tax treatment, because those need an approved design.

## 10. What can safely use the booking snapshot, and what needs confirmation

Safe (the snapshot is immutable and already agreed with the customer): the amount to collect (`total_amount_halalas`), its components as recorded (`service`, `vat`, `commission`, `worker_payout`) and the rates they were calculated with.

Needs client/accountant confirmation before anything is posted or invoiced:

- whether VAT is included in or added to the displayed price (the code adds it on top, **provisionally**);
- commission basis and who bears it (the code deducts it from the worker's price, **provisionally**), and whether VAT applies to commission;
- the figures VAT 15%, commission 15%, minimum SAR 50 (a provisional seed row, `is_provisional = true`);
- refund treatment of VAT and commission; cancellation fees;
- tax invoice and credit-note behaviour, and Saudi e-invoicing obligations;
- worker payout timing and deductions; authorise-and-capture vs immediate capture.

## 11. Configuration

| Variable | Default | Notes |
|---|---|---|
| `PAYMENT_PROVIDER` | `disabled` | `disabled` or `mock`; `mock` is refused when `NODE_ENV=production` |
| `PAYMENT_CHECKOUT_TTL_MINUTES` | `20` | Also capped by the booking's payment deadline |
| `PAYMENT_STALE_AFTER_MINUTES` | `30` | Open attempts older than this are reported |
| `PAYMENT_WEBHOOK_MAX_BODY_BYTES` | `65536` | Larger webhook bodies are refused with 413 |
| `PAYMENT_WEBHOOK_LEASE_SECONDS` | `120` | A stuck `PROCESSING` event can be claimed again after this |
| `PAYMENT_RETURN_URL_ORIGINS` | empty | Comma-separated origins `returnUrl` may use; empty = `returnUrl` refused |
| `PAYMENT_WINDOW_MINUTES` | `30` | Booking payment deadline (Phase 5 setting, provisional) |

## 12. Commands

```powershell
cd E:\saudi-home-services\apps\backend

# Test database only (safe wrapper: aborts unless the database is exactly home_services_test)
npm run db:migrate:test:status
npm run db:migrate:test

# Run the suites (real PostgreSQL + Memurai where noted)
npm run typecheck
npm run prisma:validate
npm test                                  # unit tests, in-memory doubles
npm run test:e2e                          # HTTP stack, in-memory doubles
npm run test:integration                  # real PostgreSQL (TEST_DATABASE_URL) and Memurai
npm run test:integration:payments         # only the payment suites

# Development database LATER, after you have reviewed the status. Never reset.
npm run db:migrate:status                 # should list 20261025090000_bookings_and_quotes and 20261026090000_payments_and_ledger
npm run db:migrate:deploy
npm run build
npm run db:seed                           # safe to repeat
```

## 13. Not production-ready: limits and remaining work

- No real gateway, signature scheme, checkout, refund execution or reconciliation against gateway data.
- Accounting policy undecided (section 10); the ledger records captures only; no invoices, no payouts, no commission or earnings postings.
- Deadline action disabled; unpaid bookings stay `PAYMENT_PENDING` and are only reported.
- Worker suspended after the customer starts paying: the booking is still confirmed (the check is at initiation only); needs a business decision.
- No automatic refund of unapplied or duplicate captures (needs an approved policy and a real provider).
- Notifications to customers, workers and finance about payment events are not built.
- Webhook endpoint relies on the adapter for authenticity and replay protection; provider IP allow-listing and alerting are deployment work.
- The development simulation endpoint is gated by environment, not removed from the build; confirm `PAYMENT_PROVIDER` in every deployed environment.
- The Memurai/Redis rate limits protect initiation and webhooks only per client address.
- The ledger trigger can be disabled by a database owner (see section 9).

## 14. Defects found while building this phase

| # | Defect | Fix |
|---|---|---|
| 1 | The provider-facing idempotency key was the customer's own key, unique only per customer: two customers using the same text collided on one provider payment (a 500; with a real gateway, possibly one customer receiving another's checkout). | The provider key is now `pay_<attempt id>`, server-derived and globally unique. Tested. |
| 2 | Server-side trigger errors were reported by Prisma as "foreign key constraint violated" because they used SQLSTATE `restrict_violation`. | Triggers now raise a plain exception so the message is accurate in logs. |
| 3 | Rate limits keyed by IP made every test from one address share one budget. | Test helpers send a distinct client address per call (behind `TRUST_PROXY_HOPS`). |

## 15. Earlier review (Phase 5) in brief

`confirmPayment` now distinguishes `BOOKING_ALREADY_PAID` from `BOOKING_NOT_PAYABLE`, verifies amount and currency, and can join the caller's transaction (`confirmPaymentInTransaction`). The pinned gaps from that review remain: deadline not enforced (still true by decision), worker suspended between acceptance and payment, paid-booking cancellation without refund policy, and no fallback to the runner-up quote. They are listed in SECURITY.md.
