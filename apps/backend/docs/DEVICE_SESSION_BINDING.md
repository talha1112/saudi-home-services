# Push registrations follow their session

Status: **code and migration prepared; the migration is NOT applied to any database.**

## 1. How it worked before (inspected)

| Question | Answer |
|---|---|
| Who owns a registration? | `device_tokens.user_id` (from the access token, never from the client) plus `app_role` (the session's acting role). The token itself is stored AES-256-GCM encrypted (`token_ciphertext`); lookups use `token_hash` (SHA-256, unique). |
| Is it tied to a session? | **No.** A session is the family of refresh tokens that descend from one sign-in (`refresh_tokens.family_id`); it is not a table. Nothing linked a registration to a family. |
| Rotation | Each refresh marks the old token used and inserts a new row with the **same** `family_id`. The session id is stable across rotation. |
| Logout / revocation | `POST /auth/logout` (public, always 204) -> `SessionsService.revokeByRefreshToken` -> `revokeFamily` sets `revoked_at` on the family's tokens. `revokeAllForUser` (logout-all, admin suspend, password reset) does the same for a user. Reuse detection and "account no longer active" also call `revokeFamily`. Nothing touched `device_tokens`. |
| Expiry | Refresh tokens just pass `expires_at`; `purgeStale` later deletes old rows. Nothing revoked registrations. |
| Delivery | `NotificationDeliveryService` skips a registration only if `revoked_at` is set (or it belongs to another user); `INVALID_TOKEN` from FCM revokes it. |

**Root cause:** registrations and sessions were unrelated rows, so the only ways a registration died were the client calling `DELETE /devices/:id` (best effort, impossible offline or after the session is dead) or FCM later reporting the token unregistered. A schema change is therefore necessary: there is nothing to join on.

## 2. Design

* `device_tokens.session_id UUID NULL` (plain column, indexed, **no foreign key**: the family id is not a primary key anywhere, and rows of `refresh_tokens` are purged).
* **Register** (`POST /devices`) stores the caller's `sessionId` (create and update) after verifying, under the session lock, that the session is still live (otherwise 401 `SESSION_ENDED`: an ended session can neither register nor reactivate a registration). A token that moves to another account/session takes the new binding, so the previous session's end cannot revoke it.
* **Every session end funnels through `SessionsService`**, which now revokes in the same database transaction (`$transaction([...])`):
  * `revokeFamily(familyId, userId)`: the family's tokens and `device_tokens WHERE session_id = family AND user_id = user AND revoked_at IS NULL`. Used by logout, reuse detection, inactive-account refresh and parallel-claim detection.
  * `revokeAllForUser(userId, except?)`: all of the user's registrations; with `except`, only registrations bound to *other* sessions (unbound/legacy ones cannot be attributed and are left to the sweep).
* **Rotation never calls these**, so the continuing session keeps its registrations.
* **Expiry:** `revokeDevicesOfEndedSessions()` (run by `TokenCleanupService` every 6 h, **before** `purgeStale`) revokes registrations whose session has no live refresh token (also if the rows were purged), in batches, and legacy registrations whose owner has no live session in that app.
* **Delivery guard:** before sending, a registration with a `session_id` must still have a live token in that family (`revoked_at IS NULL AND expires_at > now`); otherwise it is revoked and the delivery fails with `SESSION_ENDED`, nothing is sent. This closes the gap between expiry and the next sweep, and the register-races-logout case.
* Client cleanup (`DELETE /devices/:id`, FCM token deletion) stays as best effort; the server no longer depends on it.
* Public contract unchanged: `/auth/logout` still answers 204 for any token; no response gains or loses a field (`session_id` is never returned).

## 3. Concurrency, locking and idempotency

Under READ COMMITTED a revoking `UPDATE ... WHERE family_id = X AND revoked_at IS NULL` only sees rows committed when the statement started, so a refresh that is inserting the next token at that moment would be missed and the session would survive (this race existed before the device work). Everything that changes a session or a user's registrations is therefore serialized with **transaction-scoped advisory locks** (`src/modules/auth/session-locks.ts`):

| Operation | Takes (in this order) | Then |
|---|---|---|
| refresh (rotate) | session lock | re-reads the token, claims it, inserts the next one, commits. If the session was revoked while waiting: `REFRESH_TOKEN_REVOKED`, nothing is issued |
| logout / reuse detection / inactive account (`revokeFamily`) | user lock, session lock | revokes the family's tokens and its registrations; statements start after the locks, so they see every committed token |
| sign out everywhere (`revokeAllForUser`) | user lock, then every live session of the user in ascending id order | revokes tokens and registrations |
| register a device (`POST /devices`) | user lock, session lock | checks the session still has a live token (else 401 `SESSION_ENDED`), upserts, trims excess |
| sweep, bound registrations | session lock (one short transaction per ended session) | revokes that session's active registrations |
| sweep, legacy registrations | user lock (one transaction per user) | revokes still-unbound active rows |
| delivery | none | reads; **revokes dead registrations after its batch commits**, never inside the long transaction |

* **Lock order is always user, then sessions (ascending), then rows.** Refresh takes only a session lock, so no cycle can form between it and the others. The delivery transaction no longer writes `device_tokens` rows, so a logout never waits on (or deadlocks with) a batch that is calling the push provider.
* Revocation is idempotent: it only sets `revoked_at` where it is still NULL, scoped by session and user. Repeats and concurrent calls converge.
* Two orderings are now both safe: **logout first** (refresh is refused, registration is refused) and **refresh/registration first** (logout waits, then revokes the new token / the new registration).
* Delivery versus logout: a push already handed to the provider when the logout commits may still arrive; any delivery that reads the registration afterwards sees it revoked, and the session-liveness guard stops sends for sessions that ended without being revoked (expiry).
* A new sign-in made while "sign out everywhere" runs creates a new session, which that call does not end.
* The sweep never revives anything; an ended session cannot become live again.
* Advisory locks are keyed by a 64-bit hash of the id: a collision could only add waiting, never change a result. They are released at commit or rollback.

## 4. Migration `20261101090000_device_session_binding`

```sql
ALTER TABLE "device_tokens" ADD COLUMN "session_id" UUID;
CREATE INDEX "device_tokens_session_id_idx" ON "device_tokens"("session_id");
```

* Additive and non-destructive: nullable column without default (catalog-only; brief ACCESS EXCLUSIVE lock), one plain index (not `CONCURRENTLY`, so it can run inside a migration; `device_tokens` is small).
* The file contains no explicit transaction control and no statement PostgreSQL refuses in a transaction. **Whether Prisma applies it atomically is not proven** (see `STAGING_AND_MIGRATIONS.md`); the two statements are independent, so a failed or interrupted run can leave one of these states. Check which one with these **read-only** queries on the target database:

  ```sql
  select column_name, is_nullable, data_type from information_schema.columns where table_name = 'device_tokens' and column_name = 'session_id';
  select indexname from pg_indexes where tablename = 'device_tokens' and indexname = 'device_tokens_session_id_idx';
  select migration_name, started_at, finished_at, rolled_back_at from _prisma_migrations where migration_name = '20261101090000_device_session_binding';
  ```

  | State | What the queries show | Recovery (**test database**, through the wrapper, which targets only `home_services_test`) |
  |---|---|---|
  | A. nothing applied | no column, no index, migration row with `finished_at` empty | `npm run db:migrate:test:resolve-rolled-back -- 20261101090000_device_session_binding`, then `npm run db:migrate:test` |
  | B. column only | column present, no index, row unfinished | remove the half-applied column first (`ALTER TABLE "device_tokens" DROP COLUMN "session_id";`, run by a person on the test database only; it holds no data yet), then as state A |
  | C. both present, bookkeeping unfinished (crash after the SQL) | column and index present, row unfinished | `npm run db:migrate:test:resolve-applied -- 20261101090000_device_session_binding` |
  | D. finished normally | column, index, row with `finished_at` set | nothing to do |

  The `resolve-*` commands accept only the exact name of a folder in `prisma/migrations`, refuse unless the connection really is `home_services_test` and that migration is recorded as failed (started, not finished, not rolled back), and never fall back to `DATABASE_URL`. Never run `prisma migrate resolve` directly: it would use `.env`'s `DATABASE_URL`, the development database. Do not edit the migration file after any attempt to apply it (its checksum is recorded). That a failed migration blocks `migrate deploy` until resolved (Prisma error P3009) is recalled, not verified against Prisma's own pages (see `STAGING_AND_MIGRATIONS.md`).
* **Backfill:** none possible. Existing registrations stay `session_id = NULL` ("legacy"). They are revoked by logout-all, by the legacy sweep when their owner has no live session in that app, by FCM "unregistered", or replaced by a bound registration the next time the app registers (app start / token refresh).
* **Rollback:** `DROP INDEX "device_tokens_session_id_idx"; ALTER TABLE "device_tokens" DROP COLUMN "session_id";`. Nothing else depends on the column except the new application code, so roll the application back first or together. No data is lost beyond the session bindings themselves.
* **Compatibility:** the previous application version ignores the column. The new version requires it (queries select/update it), so apply the migration before (or with) deploying it.
* Once applied, the existing integration suites' migration guard (`test/migration-guard.ts`) will require the migration in the **test** database too: apply it there with `npm run db:migrate:test` (not done).

## 5. Limits

* Legacy registrations are covered only by logout-all, the sweep and FCM feedback, not by single-session logout.
* Up to 6 h between a refresh token expiring and the sweep revoking the row; the delivery guard makes that window harmless for sends.
* One push already in flight when the logout commits can still arrive.
* The SQL-level behaviour is covered by `test/device-session-revocation.integration-spec.ts`, which needs the migration applied to a test database and **has not been run**. The unit tests use the in-memory database stand-in.
* The unit tests model the advisory locks with an in-memory mutex (`InMemoryPrisma.$transaction`) and make both race orderings deterministic with hooks; they prove the logic and the ordering, **not** PostgreSQL's lock behaviour. `pg_advisory_xact_lock(hashtextextended(text, 0))` needs PostgreSQL 11+ (the project targets 13+). The real-database versions (`refresh and logout racing`, `registration and logout racing`, the concurrency test) are in the integration spec and have not been run.
* A registration or refresh that arrives while a logout holds the locks waits for it (milliseconds). Prisma's default interactive-transaction limits (5 s wait/timeout) apply.
* The migration SQL is unchanged by the locking work: no schema change was needed for it.
