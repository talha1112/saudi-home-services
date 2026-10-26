# Staging preparation (Render) and migration safety review

Status: **inspection and planning only.** Nothing was deployed, no migration was applied, no database or bucket was changed. Every database check was read-only (read-only transactions / `migrate diff`). Statements are labelled **[verified]** (read from code or a read-only query in this review), **[doc]** (taken from Render's public documentation, not tested), or **[assumption]** (must be tested manually).

## 1. What the backend does today (Part A)

| Topic | Finding |
|---|---|
| Build | `npm run build` = `prisma generate` (via `prebuild`) then `nest build` into `dist/` **[verified]**. `postinstall` also runs `prisma generate` **[verified]** |
| Start | `npm run start` = `node dist/main.js` **[verified]**. `PORT` (default 3001) and `HOST` (default `0.0.0.0`) are read from the environment **[verified]**, which matches Render's rule to bind `0.0.0.0` and honour `PORT` **[doc]** |
| Node | `engines.node >= 22` (raised from 20 because `firebase-admin` 14 needs Node 22); no `.node-version`/`.nvmrc` file **[verified]**. Development uses Node 24; Render's default Node version is **[assumption]**, so set `NODE_VERSION` explicitly |
| Build tooling | `prisma`, `@nestjs/cli` and `typescript` are **devDependencies** **[verified]**. The build and the migration command need them, so install with devDependencies (`npm ci --include=dev`) **[assumption: Render sets NODE_ENV=production at build time]** |
| Liveness | `GET /api/v1/health` -> 200 with `environment`, `uptimeSeconds`, `timestamp`; touches no dependency **[verified]** |
| Readiness | `GET /api/v1/health/ready` -> runs `SELECT 1` on PostgreSQL and `PING` on Redis, each with a 2 s timeout; **503** when either is down; also reports background-job state (`jobs`) without failing on it **[verified, and unit-tested]** |
| What readiness cannot see | S3 reachability, whether **migrations are applied** (a database missing tables still answers `SELECT 1`), scan/cleanup job health **[verified from code]**. Both health routes are unauthenticated and disclose the environment name and job state (low) |
| Database TLS | Supported through the connection string. **Important:** the installed `pg` (8.23.1 / `pg-connection-string` 2.14.1) treats `sslmode=require` as `verify-full` (certificate must verify), **[verified by parsing a sample URL]**; `sslmode=require&uselibpqcompat=true` gives encrypt-without-verify. Render says internal database connections use self-signed certificates and do not support `verify-ca`/`verify-full` **[doc]**, so for Render's **internal** URL use `?sslmode=require&uselibpqcompat=true`; for the **external** URL (Render-managed certificate **[doc]**) plain `sslmode=require` should work **[assumption]**. The production check from Phase 11 accepts both forms **[verified]** |
| Redis TLS | `rediss://` is handled by ioredis for the cache/limits client, BullMQ and the Socket.IO adapter, which all take the same URL **[verified in code, not against a TLS server]** |
| Production start-up refusals | no explicit `TRUST_PROXY_HOPS`; remote DB without password/`sslmode`; remote Redis without password **and** `rediss://`; wildcard CORS; `dev`/`mock` providers; equal JWT/OTP secrets; `FILE_SCANNER=disabled` with `DOCUMENT_STORAGE=s3` unless `STORAGE_ALLOW_UNSCANNED_FILES=true`; non-https `S3_ENDPOINT` **[verified, unit-tested]** |
| Proxy trust | `TRUST_PROXY_HOPS=N` makes Express trust the last N proxies for `X-Forwarded-For`. Render terminates TLS at its load balancer **[doc]**, but Render's documentation does not state how many proxy hops add to `X-Forwarded-For` or whether the header is sanitised **[doc gap]**. Too low = every client shares the proxy's IP (rate limits collapse); too high = a client can spoof its IP. The right number must be **measured in staging** (section 6, check 4). This is not yet safe to assume |
| Background jobs | BullMQ on Redis, started inside the web process when `JOBS_ENABLED=true` (default) and Redis answers within 5 s; otherwise the API still serves and jobs retry every 30 s **[verified]**. Schedulers use fixed ids, so two instances never duplicate a repeatable job **[verified by an integration test with two instances]**. Monitor with the `jobs` field of `/health/ready` and the log lines `Background jobs ...`, `Storage removals need attention`, `File scans need attention`, `Realtime outbox needs attention` **[verified]** |
| Queues needing `noeviction` | BullMQ requires Redis `maxmemory-policy noeviction` **[verified in docs/REALTIME.md]**. Render Key Value's default policy and whether it is configurable is **[assumption]** |
| Storage | `DOCUMENT_STORAGE` = `disabled` (default; endpoints answer 503 `DOCUMENT_STORAGE_NOT_CONFIGURED`), `dev`, `local` (both refused in production), `s3` **[verified]**. S3 settings are `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` (the `AWS_*` names are accepted as fallbacks) **[verified]** |
| Unscanned files | With no scanner, files are `NOT_SCANNED`. They are served only while `STORAGE_REQUIRE_CLEAN_SCAN=false`. In production with S3 the API will not start without either a scanner or `STORAGE_ALLOW_UNSCANNED_FILES=true` **[verified]**. `STORAGE_REQUIRE_CLEAN_SCAN=true` is rejected when `FILE_SCANNER=disabled` **[verified]** - so there is **no** configuration today that accepts S3 uploads and refuses to serve them |
| Providers | SMS: `dev` (refused in production) or `disabled`; **no real SMS provider exists**. Payments: `mock` (refused in production) or `disabled`; no gateway. Push: `mock` or `disabled`. Scanner: `mock`, `mock-async` (both refused in production) or `disabled`; no real scanner. Email: no email provider exists at all **[verified]** |
| Logging | `nestjs-pino`: JSON in production, pretty only outside it (`pino-pretty` is a devDependency); request id from `X-Request-Id` or generated and returned; `Authorization`/`Cookie` headers redacted; database error text is never logged (only class and code); 5xx responses never leak internals **[verified]** |
| CORS / Swagger | CORS is off unless `CORS_ORIGINS` lists origins (wildcard refused in production). Swagger is off in production unless `SWAGGER_ENABLED=true` **[verified]** |

## 2. Findings that decide the staging design

1. **No customer or worker can sign in on a production-mode staging.** OTP sign-in needs an SMS provider; the only ones are `dev` (refused in production) and `disabled` (every OTP request answers 503). Only the administrator (email + password) can sign in. Running staging with `NODE_ENV=development` to get the `dev` SMS provider would switch off every production safeguard and print OTP codes to the log - **not recommended**. Customer/worker flows therefore cannot be smoke-tested on staging until an SMS provider is integrated.
2. **Render's default Key Value URL conflicts with the Phase 11 Redis rule.** The internal URL is unauthenticated by default and the document does not say it uses TLS **[doc]**; the backend refuses a non-local Redis without a password **and** `rediss://`. Options: (a) enable authentication on the internal URL and check whether `rediss://` is offered on it; (b) use the external URL (TLS and authentication always **[doc]**) with an IP allow-list, which needs stable outbound IPs for the web service **[assumption]**; (c) a reviewed code change adding an explicit "private network" override. None is applied.
3. **No safe S3-enabled configuration exists without a scanner** (see the table above). For staging: run `DOCUMENT_STORAGE=disabled` and verify the graceful 503, or approve a small code change that lets `STORAGE_REQUIRE_CLEAN_SCAN=true` run with `FILE_SCANNER=disabled` ("accept uploads, never serve them"), which would let staging exercise upload, confirmation, deletion and denial against S3. Setting `STORAGE_ALLOW_UNSCANNED_FILES=true` is **not** recommended.
4. **`TRUST_PROXY_HOPS` must be measured**, not guessed (section 6, check 4).
5. **Readiness does not prove the schema is migrated.** Use the pre-deploy migration step and a smoke test that reads a migrated table (section 6).

## 3. Staging architecture

```
Admin web / test clients  --HTTPS-->  Render load balancer (TLS)  --HTTP-->  Web service "hs-staging-api" (Node, 1 instance)
                                                                          |-- private network --> Render PostgreSQL "hs-staging-db"  (NOT saudi_home_services, NOT home_services_test)
                                                                          |-- private network --> Render Key Value "hs-staging-redis" (dedicated; BullMQ, rate limits, OTP cooldowns, Socket.IO adapter)
                                                                          '-- HTTPS ----------> S3 (only if enabled; synthetic files only)
```

- One staging instance only at first (Socket.IO with `REALTIME_REDIS_ADAPTER=true` and BullMQ are designed for several, but verify with one).
- A **dedicated** Key Value instance. If it were ever shared, `QUEUE_PREFIX` must differ per environment (the integration tests use Redis DB 15 and unique prefixes; staging must not point at them).
- The database and Redis use Render's **internal** URLs (same account and region **[doc]**); keep external access off or restricted to your own IP **[doc]**.
- Region: Render offers a fixed list of regions; none is assumed to be in Saudi Arabia. Staging holds synthetic data only, so region is not a compliance issue; production is.

## 4. Environment variables (names only)

`R` = required by validation. Values below are placeholders; generate real secrets with a password manager or `openssl rand -hex 32`, never commit them.

| Variable | Staging value | Notes |
|---|---|---|
| `NODE_ENV` | `production` | Turns the Phase 11/12 safeguards on. Do **not** use `development` for staging |
| `NODE_VERSION` | `22` or `24` (Render setting) | Match what was tested (24) or a supported LTS you test |
| `PORT` / `HOST` | Render sets `PORT`; leave `HOST` default `0.0.0.0` | |
| `DATABASE_URL` (R) | `postgresql://<user>:<password>@<internal-host>/<db>?sslmode=require&uselibpqcompat=true` | internal Render URL; see TLS note above |
| `REDIS_URL` (R) | decision needed (section 2, finding 2) | |
| `JWT_ACCESS_SECRET` (R) | `<64 hex chars>` | distinct from the OTP secret |
| `OTP_HMAC_SECRET` (R) | `<64 hex chars>` | |
| `TRUST_PROXY_HOPS` | `<measured number>` | required explicitly in production; start with the test in section 5 |
| `CORS_ORIGINS` | `https://<staging-admin-web-origin>` or empty | no `*`; empty disables CORS (mobile apps do not need it) |
| `SWAGGER_ENABLED` | unset | off in production by default |
| `LOG_LEVEL` | `info` | |
| `SMS_PROVIDER` | `disabled` | no real provider exists |
| `PAYMENT_PROVIDER` | `disabled` | no gateway; keep real payments off |
| `PUSH_PROVIDER` | `disabled` | |
| `FILE_SCANNER` | `disabled` | no real scanner selected |
| `DOCUMENT_STORAGE` | `disabled` (recommended until finding 3 is resolved) | |
| `STORAGE_ALLOW_UNSCANNED_FILES` | unset (`false`) | do not set |
| `JOBS_ENABLED` | `true` | one instance; fixed scheduler ids prevent duplicates |
| `QUEUE_PREFIX` | `hs-staging` | |
| `REALTIME_ENABLED` / `REALTIME_REDIS_ADAPTER` | defaults (`true`) | |
| `IDENTITY_DOCUMENT_URL_TTL_SECONDS` | `300` | default already 300 |
| S3 (only if enabled later) | `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | least-privilege key from docs/STORAGE_NOTIFICATIONS_OFFERS.md |
| One-off CLI only | `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `ADMIN_NAME` | for `npm run admin:bootstrap`; remove afterwards |

### Secrets and who uses them

| Secret | Used by | Where to store |
|---|---|---|
| `DATABASE_URL` (contains the DB password) | web service; pre-deploy migration step; admin/seed CLI runs | Render environment (secret), generated by the database resource |
| `REDIS_URL` (password if enabled) | web service; admin CLI (it boots the full config) | Render environment (secret) |
| `JWT_ACCESS_SECRET`, `OTP_HMAC_SECRET` | web service; admin CLI (config validation) | Render environment (secret) |
| `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | web service only, and only when S3 is enabled | Render environment (secret); never in Flutter apps or admin web |
| `ADMIN_PASSWORD` | the one-off `admin:bootstrap` command | typed into the shell for that command; not stored |
| `DEVICE_TOKEN_ENCRYPTION_KEY` | web service, only when push registration is enabled (not now) | Render environment (secret) |

## 5. Render configuration steps (nothing has been created)

1. **PostgreSQL**: create `hs-staging-db` (new, empty). Note the internal URL; leave external access off (or allow-list your own IP only).
2. **Key Value**: create `hs-staging-redis` in the same region. Set the eviction policy to `noeviction` if the dashboard allows **[assumption]**. Decide the URL form (section 2, finding 2).
3. **Web service** `hs-staging-api`: connect the repository, **Root Directory** `apps/backend`, runtime Node.
   - Build command: `npm ci --include=dev && npm run build`
   - Pre-deploy command: `npx prisma migrate deploy` (runs against `DATABASE_URL`; availability of pre-deploy commands on the chosen plan is **[assumption]**; otherwise run it once from a Render shell)
   - Start command: `npm run start`
   - Health check path: `/api/v1/health/ready` (2xx/3xx healthy; 4xx/5xx unhealthy; traffic stops after 15 s of failures and the instance restarts after 60 s **[doc]**). Trade-off: a Redis or database outage will restart the service repeatedly although a restart cannot fix it; use `/api/v1/health` if that is unwanted
   - Instances: 1. Auto-deploy: off (deploy manually while staging is being established)
   - Environment: the table in section 4
4. **First deploy**, then from a Render shell on the service (or a one-off job): `npm run db:seed` (catalog: cities, categories, services) and `ADMIN_EMAIL=<email> ADMIN_PASSWORD=<strong password> npm run admin:bootstrap` (a password change is forced at first sign-in).
5. **Do not** point any real customer app build at staging until the blockers below are resolved.

## 6. Smoke tests (PowerShell; placeholders only)

```powershell
$h = "https://<staging-host>"
# 1 liveness and readiness
curl.exe -s -i "$h/api/v1/health"
curl.exe -s -i "$h/api/v1/health/ready"          # expect 200 and database/redis "up"
# 2 request id is returned and errors are redacted
curl.exe -s -i "$h/api/v1/nonexistent" -H "X-Request-Id: smoke-001"   # expect 404 JSON with requestId, no stack
# 3 administrator sign-in works; wrong password and unknown email give the same generic 401
$body = '{"email":"<admin email>","password":"<admin password>"}'
curl.exe -s -X POST "$h/api/v1/auth/admin/login" -H "Content-Type: application/json" -d $body
# 4 proxy hops (the audit API does NOT return IP addresses, so measure through behaviour or the database)
#    4a too HIGH (client can spoof its IP): fail the same account 6 times from ONE network, each time with a different spoofed header.
#       Expect the 6th answer to be 429 LOGIN_LOCKED (the limit is 5 failures per account+IP). If it never locks, the header is trusted too far.
1..6 | ForEach-Object { curl.exe -s -o NUL -w "%{http_code}`n" -X POST "$h/api/v1/auth/admin/login" -H "Content-Type: application/json" -H "X-Forwarded-For: 203.0.113.$_" -d '{"email":"nobody@example.com","password":"wrong-Password-1"}' }
#    4b too LOW (everyone shares the proxy's IP): after 4a locked that account for this network, try the SAME account from a DIFFERENT network
#       (phone hotspot) with a wrong password. Expect 401, not 429. A 429 means both networks look like one address.
#    4c direct evidence: in a Render shell, psql into the staging database:  select ip_address, created_at from audit_logs where action = 'admin.login_failed' order by created_at desc limit 5;
#       ip_address must be your real public address (and never 203.0.113.x).
# 5 migrated schema and database access: an admin list route that reads migrated tables
curl.exe -s "$h/api/v1/admin/users" -H "Authorization: Bearer <admin access token>"
# 6 graceful failure of unconfigured providers
curl.exe -s -X POST "$h/api/v1/auth/otp/request" -H "Content-Type: application/json" -d '{"phone":"+966500000000","app":"customer"}'   # expect 503, not 500
#    document endpoints answer 503 DOCUMENT_STORAGE_NOT_CONFIGURED while storage is disabled
# 7 dependency failure drill (in the Render dashboard): suspend Redis, then expect /health/ready = 503 with redis "down" and
#    the API still answering /health; resume Redis and expect recovery within ~30 s and jobs "running" again.
```

File upload / scan / access / deletion cannot be smoke-tested on staging until finding 3 is resolved; the automated suites (25 integration suites) cover them locally with a test scanner.

## 7. Backup and restore procedure for `saudi_home_services` (review only - not run)

**Inspected [verified]:** the development database is `saudi_home_services` on `127.0.0.1:5432` (PostgreSQL 18.6 service `postgresql-x64-18` is running; the connection string has a user and a password and no query options). The tools are in `C:\Program Files\PostgreSQL\18\bin` (`pg_dump` 18.6 and `pg_restore` 18.6), **not** on `PATH`; `psql`/`createdb` live in the same folder. The database currently holds only seed data (3 cities, 3 categories, 9 services) and 3 applied migrations.

**Format:** PostgreSQL custom format (`--format=custom`): compressed, supports `pg_restore --list` verification and selective restore. `pg_dump` takes a consistent snapshot and does not block writers.

```powershell
$pg    = "C:\Program Files\PostgreSQL\18\bin"
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$dir   = "E:\db-backups"                         # OUTSIDE the repository; never commit dumps
New-Item -ItemType Directory -Force $dir | Out-Null
$file  = "$dir\saudi_home_services-$stamp.dump"

# password: type it, do not put it in the command line or in a file
$sec = Read-Host "PostgreSQL password" -AsSecureString
$env:PGPASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec))

# 1 backup (read-only on the database)
& "$pg\pg_dump.exe" --host 127.0.0.1 --port 5432 --username <db user> --format=custom --compress=6 --no-owner --no-acl --file $file saudi_home_services

# 2 verify the file
Get-Item $file | Select-Object Name, Length, LastWriteTime        # exists and is not tiny
Get-FileHash $file -Algorithm SHA256                              # record the hash with the file
& "$pg\pg_restore.exe" --list $file | Select-String -Pattern "TABLE DATA" | Measure-Object   # one entry per table with data
& "$pg\pg_restore.exe" --list $file | Select-String -Pattern "_prisma_migrations"

# 3 prove it restores: into a NEW throwaway database, never the original
$target = "restore_check_$stamp"
if ($target -eq "saudi_home_services") { throw "refusing to restore over the original" }
& "$pg\createdb.exe" --host 127.0.0.1 --port 5432 --username <db user> $target
& "$pg\pg_restore.exe" --host 127.0.0.1 --port 5432 --username <db user> --dbname $target --no-owner --no-acl --exit-on-error $file
& "$pg\psql.exe" --host 127.0.0.1 --port 5432 --username <db user> --dbname $target -c "select (select count(*) from cities) cities, (select count(*) from services) services, (select count(*) from _prisma_migrations) migrations"
#    expect 3 / 9 / 3 (the values you saw before the backup)

# 4 clean up the throwaway database and the password variable (your decision, after you checked it)
& "$pg\dropdb.exe" --host 127.0.0.1 --port 5432 --username <db user> $target
Remove-Item Env:PGPASSWORD
```

Also keep the dump's SHA-256 and the date; keep at least two generations; the dump contains whatever test personal data the database holds, so store it as carefully as the database.

## 8. Pending migrations (Part C)

### Verified inventory (read-only)

- Migration directories on disk: **10**.
- `saudi_home_services` (dev): **3 applied** (`init`, `auth_foundation`, `catalog_and_worker_onboarding`), all checksums match the files, none failed or rolled back -> **7 pending**.
- `home_services_test`: **10 applied**, all checksums match -> 0 pending.
- A read-only `prisma migrate diff` of `home_services_test` against `schema.prisma` is **empty**: the migrations produce exactly the Prisma schema (tables, columns, indexes, enums). Triggers, functions and CHECKs are hand-written and are not part of that comparison.
- **Six versus seven:** the pending set is **seven**. The earlier "six" was my counting error: Phases 5-9 left five pending; the audit-log migration (Phase 11) made six; the file-scan migration (Phase 12) made seven. My Phase 12 report kept the old number while listing both newer migrations. The list in the request is correct.
- The current application needs all 10: it queries tables from every migration. Run against the dev database as it is now, most features would fail (readiness would still say "ok").

### Migration-by-migration (in the order to apply them)

Order is the directory name order; each depends on the earlier ones. Whether a failed migration leaves anything behind is **not proven** for Prisma - see "Transaction behaviour and failed migrations" below (an earlier version of this document claimed otherwise without evidence).

| # | Migration | What it does | Existing tables touched | Risk on a populated database |
|---|---|---|---|---|
| 1 | `20261025090000_bookings_and_quotes` | creates `pricing_settings`, `bookings`, `quotes`, `booking_events`, `booking_photos`, `booking_cancellations`; 5 enums; 13 indexes; foreign keys to `users`, `services`, `cities`, `worker_profiles`; 10 CHECKs. No data change | none altered. Foreign keys take a brief lock on the referenced tables | **Low.** New tables only. Rollback = drop the six tables and five enums (no data exists yet) |
| 2 | `20261026090000_payments_and_ledger` | creates `payment_attempts`, `payment_webhook_events`, `payment_refunds`, `ledger_entries`; 4 enums; 2 functions; 3 triggers (`ledger_entries` blocks UPDATE/DELETE/TRUNCATE; `bookings` money snapshot is immutable); index on `bookings(status, payment_due_at)` | `bookings` (trigger and one **non-concurrent** index: blocks writes to `bookings` while built; trivial while `bookings` is new/empty) | **Low now, one-way later.** Once real ledger rows exist the append-only triggers make "rollback" a deliberate table drop that destroys financial history. Take a backup first. |
| 3 | `20261027090000_realtime_chat_and_outbox` | creates `chat_messages`, `chat_participant_states`, `realtime_outbox_events`; 2 functions and 2 triggers (chat rows immutable; sender must be a booking participant) | none | **Low.** New tables only |
| 4 | `20261028090000_storage_notifications_offers` | creates `storage_deletions`, `notifications`, `notification_deliveries`, `device_tokens`, `offers`, `offer_events`; 7 enums including `ScanStatus`; **adds** `scan_status` (NOT NULL DEFAULT `NOT_SCANNED`) and `content_verified_at` to `booking_photos` and `worker_verification_documents` | `booking_photos`, `worker_verification_documents` (ADD COLUMN with a constant default is metadata-only on PostgreSQL 11+: no rewrite, very short lock) | **Low.** Existing files become `NOT_SCANNED` (unscanned, which is the honest state) with no content verification time; no backfill is possible or needed. Rollback = drop the columns and tables (column data is lost but is only defaults) |
| 5 | `20261029090000_disputes_reviews_reporting` | creates `disputes`, `dispute_events`, `dispute_evidence`, `reviews`, `review_events`; 5 enums; 7 functions and 8 triggers (immutability, eligibility, one active dispute); **adds** `rating_count`, `rating_sum` (DEFAULT 0) and a CHECK to `worker_profiles`; 4 report indexes | `worker_profiles` (ADD COLUMN default 0, then CHECK validated against all rows: scans the table under a lock; trivial with few workers). `bookings` (3 indexes) and `quotes` (1 index), all **non-concurrent**: writes to those tables wait while each index builds | **Medium on a large live database** (index builds on `bookings`/`quotes` block writes for the build time; Prisma cannot run `CREATE INDEX CONCURRENTLY` in a migration). **Low** for staging or a quiet window. Cached ratings start at 0, which is correct while no reviews exist; if reviews existed before this migration they would need a recompute (none do) |
| 6 | `20261030090000_audit_log_integrity` | one function and two triggers making `audit_logs` append-only (UPDATE/DELETE/TRUNCATE refused; the foreign-key action that clears `actor_user_id` when a user is deleted is still allowed). No data change | `audit_logs` (trigger creation takes a brief lock; no row scan) | **Low to apply; behavioural risk.** Anything that deletes or edits audit rows (retention scripts, manual clean-ups) will start failing by design. The application never does. Rollback = drop the triggers and function (non-destructive) |
| 7 | `20261031090000_file_scan_lifecycle` | creates `file_scan_jobs` and 2 enums; 3 CHECKs. Uses the `ScanStatus` enum from migration 4 | none | **Low.** Additive. Rollback = drop the table and two enums |

- **Destructive operations:** none of the seven drops, truncates, deletes, updates or rewrites data (scanned for DROP/TRUNCATE/DELETE/UPDATE/INSERT/type changes; the only "TRUNCATE" mentions are the triggers that *forbid* it).
- **Blocking operations:** only the non-concurrent index builds (migrations 2 and 5) and short catalog locks from foreign keys, triggers and ADD COLUMN.
- **Rollback limits:** Prisma has no down migrations. Rollback means restoring the pre-migration backup, or the generated cleanup SQL in the appendix below (safe only while the new tables are empty, and only for the latest, failed migration).
- **Compatibility:** all seven are consistent with `schema.prisma` (empty diff against the test database) and with the code that passed 440 integration tests on that database.
- **Applying to a populated database:** safe in principle for all seven; the dev database has no users or bookings, and staging will start empty (all 10 apply to an empty database in order).

### Transaction behaviour and failed migrations (evidence, and what is NOT proven)

**Correction.** An earlier version of this document said "Prisma runs each file in one transaction ... so a failing migration leaves nothing half-applied". That was stated as a fact and is **not supported** by anything I could verify. What the files and sources actually show:

| Question | Evidence | Status |
|---|---|---|
| Do the seven files contain explicit transaction control (`BEGIN`/`COMMIT`/`ROLLBACK`/`SAVEPOINT`/`START TRANSACTION`)? | None. The `BEGIN`/`END;` lines found in migrations 2, 3, 5 and 6 are PL/pgSQL block delimiters inside `$$ ... $$` function bodies, e.g. migration 6 lines 20-39 (`CREATE FUNCTION ... AS $$ BEGIN ... END; $$;`), migration 2 lines 295-300 and 314-331, migration 3 lines 106-110 and 118-134, migration 5 lines 209-314. Migrations 1, 4 and 7 have no `$$` at all | **Verified** (file contents) |
| Do they contain statements PostgreSQL refuses inside a transaction block? | None: no `CREATE INDEX CONCURRENTLY`, no `ALTER TYPE ... ADD VALUE`, no `VACUUM`, `CLUSTER`, `REINDEX`, `CREATE/DROP DATABASE` (the only match for "DROP DATABASE" is a comment on line 288 of migration 2). Every statement is DDL that PostgreSQL can roll back | **Verified** (file contents) |
| Does PostgreSQL run a multi-statement script atomically? | PostgreSQL documents that a simple Query message containing several statements runs "as a single transaction, unless explicit transaction control commands are included", that execution is "abandoned at the first error" and that the earlier statements are rolled back; a syntax error anywhere in the string prevents any statement from running | Documented ([PostgreSQL protocol flow](https://www.postgresql.org/docs/current/protocol-flow.html)); not tested here |
| Does **Prisma** send each `migration.sql` as one such message, or wrap it in its own transaction? | Prisma's public pages I could read (rollbacks and recovery, patching and hotfixing, migration histories) **do not say**. The patching guide tells users what to do if "a migration partly ran" (make it re-runnable with `IF NOT EXISTS`, or revert the completed steps by hand), so Prisma does not promise atomicity in general. A newer Prisma tool documents a single transaction, but that is a different tool | **Not verified** |
| Local hints | In both databases `_prisma_migrations.applied_steps_count` is `1` for every recorded migration (3 on development, 10 on test), all have `finished_at` set and no error log | Consistent with "one script = one step"; **not** proof of atomicity |

**Conclusion.** Each of the seven migrations is **probably** all-or-nothing on PostgreSQL, but this has not been proven for Prisma's schema engine, and nothing has been executed to test it (executing a migration, even a deliberately failing one on a scratch database, was outside this review). Plan recovery for **both** outcomes: begin every recovery by comparing the real schema with the migration file (below).

- None of the files uses `IF NOT EXISTS`, `OR REPLACE` or `DROP`. If a migration were partly applied, simply re-running it would fail at the first object that already exists, so `migrate resolve --rolled-back` alone would not be enough.
- A failed migration stays recorded with `started_at` set, `finished_at` empty, `rolled_back_at` empty and the error in `logs`. Later `migrate deploy` runs refuse to continue (error P3009 "found failed migrations", recalled from experience, not from the pages fetched) until you run `migrate resolve` with `--rolled-back` or `--applied`.
- The application does **not** check migrations at start-up and `/health/ready` only runs `SELECT 1`. A service started against a database with a failed migration will run and report "ok".
- Optional experiment (needs your approval; not run): on a scratch database, copy the migration folder, append one deliberately failing statement to a new last migration, run `migrate deploy`, and look at what remains. That would settle the atomicity question.

### What a failure leaves behind, per migration

"Statement order" shows where in the file things happen (verified from the files). "If NOT atomic" describes the worst case; if the run is atomic, nothing from the failed migration remains in any of these cases.

| # | Migration | Statement order (line ranges) | If it fails and is **not** atomic: what could remain | Recovery |
|---|---|---|---|---|
| 1 | `..25_bookings_and_quotes` (294 lines) | types 5-17; tables 20-136; indexes 150-204; foreign keys 207-249; CHECKs 259-294 (the last statement is a CHECK on `booking_photos`) | tables without foreign keys or without the money CHECKs (the table is usable, the integrity rules are not) | cleanup 1 |
| 2 | `..26_payments_and_ledger` (335 lines) | types 5-14; tables 17-97; indexes 118-190; foreign keys 193-223; CHECKs 233-271; **functions and triggers 295-335**; the last statement is the `bookings` money-snapshot trigger (lines 333-335) | `ledger_entries` **without** its append-only triggers, or with `UPDATE/DELETE` blocked (line 302) but `TRUNCATE` not (line 306); `bookings` money snapshot not protected (line 333); the non-concurrent index on `bookings` (line 190) | cleanup 2. **Never** with real ledger rows: restore a backup instead |
| 3 | `..27_realtime_chat_and_outbox` (138 lines) | tables 6-31; indexes 47-103; foreign keys 65-80; CHECKs 88-98; **functions and triggers 106-138** (last) | `chat_messages` mutable, or the "sender must be a participant" check missing | cleanup 3 |
| 4 | `..28_storage_notifications_offers` (221 lines) | types 6-24; **`ADD COLUMN` on `booking_photos` and `worker_verification_documents` 27-31**; tables 35-124; indexes 137-198 and the last two (partial indexes on `storage_deletions`, about lines 220-221); foreign keys 167-191; CHECKs 199-219 | the two new columns on existing tables with none of the new tables (harmless: the columns have safe defaults) | cleanup 4 |
| 5 | `..29_disputes_reviews_reporting` (327 lines) | types 6-18; `ADD COLUMN` on `worker_profiles` 21; tables 25-89; foreign keys 146-185; CHECKs 192-276 (including the rating CHECK); **functions 209-314 and triggers 226-319**; the last statements are four indexes on `bookings` and `quotes` (324-327) | triggers missing (dispute evidence / review eligibility / immutability), or all triggers present but the report indexes missing (performance only); the index builds are also where a lock timeout is most likely | cleanup 5 |
| 6 | `..30_audit_log_integrity` (47 lines) | function 20-39; trigger `UPDATE/DELETE` 41-43; trigger `TRUNCATE` 45-47 (last) | the function with **no** triggers (no protection), or `UPDATE/DELETE` blocked but `TRUNCATE` not | cleanup 6 (non-destructive) |
| 7 | `..31_file_scan_lifecycle` (42 lines) | types 6-9; table 12; indexes 32-35; CHECKs 39-41 (last) | `file_scan_jobs` without the CHECKs that stop a scanner failure being stored as a verdict | cleanup 7 |

**Can the audit-log and ledger protections be left partially installed?**
- If the run is atomic: no.
- If it is not: yes, in the ways shown in rows 2, 3, 5 and 6, because the function and the triggers are separate statements at the end of each file. This is the dangerous partial state, since the tables work normally while their protection is missing, and nothing at runtime notices. The defence is procedural: **never start the application against a database that has a failed migration**, and after every successful migration confirm the protection exists with the checks below.

**After a successful migration, expected totals** (read-only query on `home_services_test`, which has all ten): 15 user triggers (ledger 2 + bookings snapshot 1 + chat 2 + disputes/reviews 8 + audit 2), 12 functions in `public` (2 + 2 + 7 + 1), 39 tables besides `_prisma_migrations`, 30 enums. The development database today has 0 triggers, 0 functions, 14 tables and 7 enums, i.e. none of the seven migrations' objects exist there (a read-only comparison of every object in the seven files with the live catalog found **none** present on development and **all** present on test, so neither database is in a partial state).

```sql
-- read-only checks to run in the staging database after migrate deploy
select count(*) as user_triggers from pg_trigger where not tgisinternal;                                  -- expect 15
select count(*) as functions from pg_proc p join pg_namespace s on s.oid = p.pronamespace where s.nspname = 'public';   -- expect 12
select c.relname as table_name, t.tgname as trigger_name from pg_trigger t join pg_class c on c.oid = t.tgrelid
  where not t.tgisinternal order by 1, 2;                          -- expect audit_logs x2, ledger_entries x2, bookings x1, chat_messages x2, + dispute/review triggers
select migration_name, started_at, finished_at, rolled_back_at, applied_steps_count from _prisma_migrations order by started_at;   -- every row finished_at set
```

### Safe recovery plan for a failed staging migration

Scope: the **staging** database only (empty, synthetic data). Never run any of this against `saudi_home_services` or `home_services_test`; for the development database the recovery is the backup from section 7.

1. **Stop.** Do not redeploy in a loop and do not start the new application version. Turn auto-deploy off. (Render keeps the previous version serving if a pre-deploy command fails: **[assumption, not found in the Render pages read]**.)
2. **Collect evidence (read-only).** The migrate error text, and `select migration_name, started_at, finished_at, rolled_back_at, applied_steps_count, left(logs, 800) as log from _prisma_migrations where finished_at is null;`.
3. **Find the real state** of the failed migration by comparing its file with the catalog: do its tables, enums, functions, triggers, columns, indexes and constraints exist? (The comparison I used on the two databases is a read-only script in the scratchpad: `migstate.mjs`; the same facts can be read with the queries above.) Exactly one of three outcomes:
   - **A. Nothing from it exists** (the atomic outcome): go to step 4.
   - **B. Everything exists but `finished_at` is empty** (a crash after the work was done): check every object in the file, including the trigger bodies; then `npx prisma migrate resolve --applied <migration_name>`. Only if the comparison is complete; otherwise treat as C.
   - **C. Some objects exist** (partial): go to step 5.
4. **Outcome A.** Fix the cause (missing privilege, lock timeout, disk, network, statement timeout, a typo in an environment-specific setting - never edit the migration file: it is already applied to the test database and its checksum is recorded), then `npx prisma migrate resolve --rolled-back <migration_name>` and `npx prisma migrate deploy`.
5. **Outcome C.** Either:
   - **Staging is empty or disposable (expected):** delete the staging database resource and create a new empty one, then run `npx prisma migrate deploy` for all ten. This is a staging-only action and is the least error-prone; or
   - **Keep the database:** read the cleanup SQL for that migration (appendix), run it inside one transaction (`BEGIN; ... COMMIT;`) after checking it removes only that migration's objects, re-run the comparison until **nothing** from it exists, then `migrate resolve --rolled-back <migration_name>` and `migrate deploy`.
6. **Verify the result** with the read-only checks above (15 triggers, 12 functions, every `_prisma_migrations` row finished), `npx prisma migrate status`, and the staging smoke tests, **before** starting the application.
7. **Rules.** Do not edit applied migration files. If SQL truly has to change, add a new migration. Never use `migrate dev`, `db push` or `migrate reset` against staging or any shared database. Never run the migration 2 cleanup against a database that has ledger rows: restore the pre-migration backup (section 7) instead.

### Appendix: cleanup SQL per migration (generated from the files; **not run**; staging use only)

Each block removes only the objects its own migration creates, newest first, and uses `IF EXISTS` so it is safe whether the migration was partly or not at all applied. Review before running. They are destructive for that migration's tables.

```sql
-- cleanup 1: 20261025090000_bookings_and_quotes
DROP TABLE IF EXISTS booking_cancellations CASCADE;
DROP TABLE IF EXISTS booking_photos CASCADE;
DROP TABLE IF EXISTS booking_events CASCADE;
DROP TABLE IF EXISTS quotes CASCADE;
DROP TABLE IF EXISTS bookings CASCADE;
DROP TABLE IF EXISTS pricing_settings CASCADE;
DROP TYPE IF EXISTS "PhotoStatus"; DROP TYPE IF EXISTS "BookingEventType"; DROP TYPE IF EXISTS "CancellationReason";
DROP TYPE IF EXISTS "QuoteStatus"; DROP TYPE IF EXISTS "BookingStatus";

-- cleanup 2: 20261026090000_payments_and_ledger
DROP TRIGGER IF EXISTS bookings_money_snapshot_immutable ON bookings;
DROP INDEX IF EXISTS bookings_status_payment_due_at_idx;
DROP TABLE IF EXISTS ledger_entries CASCADE;
DROP TABLE IF EXISTS payment_refunds CASCADE;
DROP TABLE IF EXISTS payment_webhook_events CASCADE;
DROP TABLE IF EXISTS payment_attempts CASCADE;
DROP FUNCTION IF EXISTS bookings_money_snapshot_immutable();
DROP FUNCTION IF EXISTS ledger_entries_append_only();
DROP TYPE IF EXISTS "LedgerEntryType"; DROP TYPE IF EXISTS "RefundStatus"; DROP TYPE IF EXISTS "WebhookEventStatus"; DROP TYPE IF EXISTS "PaymentStatus";

-- cleanup 3: 20261027090000_realtime_chat_and_outbox
DROP TABLE IF EXISTS realtime_outbox_events CASCADE;
DROP TABLE IF EXISTS chat_participant_states CASCADE;
DROP TABLE IF EXISTS chat_messages CASCADE;
DROP FUNCTION IF EXISTS chat_messages_check_participant();
DROP FUNCTION IF EXISTS chat_messages_immutable();

-- cleanup 4: 20261028090000_storage_notifications_offers
ALTER TABLE worker_verification_documents DROP COLUMN IF EXISTS content_verified_at, DROP COLUMN IF EXISTS scan_status;
ALTER TABLE booking_photos DROP COLUMN IF EXISTS content_verified_at, DROP COLUMN IF EXISTS scan_status;
DROP TABLE IF EXISTS offer_events CASCADE; DROP TABLE IF EXISTS offers CASCADE; DROP TABLE IF EXISTS device_tokens CASCADE;
DROP TABLE IF EXISTS notification_deliveries CASCADE; DROP TABLE IF EXISTS notifications CASCADE; DROP TABLE IF EXISTS storage_deletions CASCADE;
DROP TYPE IF EXISTS "OfferStatus"; DROP TYPE IF EXISTS "OfferAudience"; DROP TYPE IF EXISTS "PushProviderName"; DROP TYPE IF EXISTS "DevicePlatform";
DROP TYPE IF EXISTS "DeliveryStatus"; DROP TYPE IF EXISTS "NotificationChannel"; DROP TYPE IF EXISTS "ScanStatus";

-- cleanup 5: 20261029090000_disputes_reviews_reporting
DROP INDEX IF EXISTS bookings_created_at_idx; DROP INDEX IF EXISTS bookings_completed_at_idx;
DROP INDEX IF EXISTS bookings_cancelled_at_idx; DROP INDEX IF EXISTS quotes_created_at_idx;
ALTER TABLE worker_profiles DROP CONSTRAINT IF EXISTS worker_profiles_rating_ck;
ALTER TABLE worker_profiles DROP COLUMN IF EXISTS rating_count, DROP COLUMN IF EXISTS rating_sum;
DROP TABLE IF EXISTS review_events CASCADE; DROP TABLE IF EXISTS reviews CASCADE; DROP TABLE IF EXISTS dispute_evidence CASCADE;
DROP TABLE IF EXISTS dispute_events CASCADE; DROP TABLE IF EXISTS disputes CASCADE;
DROP FUNCTION IF EXISTS reviews_no_delete(); DROP FUNCTION IF EXISTS reviews_guard_update(); DROP FUNCTION IF EXISTS reviews_check_eligibility();
DROP FUNCTION IF EXISTS dispute_evidence_same_booking(); DROP FUNCTION IF EXISTS history_rows_immutable();
DROP FUNCTION IF EXISTS disputes_keep_identity(); DROP FUNCTION IF EXISTS disputes_check_opener();
DROP TYPE IF EXISTS "ReviewStatus"; DROP TYPE IF EXISTS "DisputeVisibility"; DROP TYPE IF EXISTS "DisputeFinancialFollowup";
DROP TYPE IF EXISTS "DisputeCategory"; DROP TYPE IF EXISTS "DisputeStatus";

-- cleanup 6: 20261030090000_audit_log_integrity
DROP TRIGGER IF EXISTS audit_logs_append_only ON audit_logs;
DROP TRIGGER IF EXISTS audit_logs_no_truncate ON audit_logs;
DROP FUNCTION IF EXISTS audit_logs_append_only();

-- cleanup 7: 20261031090000_file_scan_lifecycle
DROP TABLE IF EXISTS file_scan_jobs CASCADE;
DROP TYPE IF EXISTS "FileScanJobStatus"; DROP TYPE IF EXISTS "FileScanSubject";
```

Run a cleanup block only for the **latest, failed** migration. Running cleanup 1 after migration 2 or later has been applied would break their dependencies.

### Addendum: migration 11, `20261101090000_device_session_binding` (added after this review)

The folder count is now **11**. `saudi_home_services` (dev) therefore has **8 pending** (the seven above plus this one); `home_services_test` has the first 10 applied until this one is applied with `npm run db:migrate:test`. It adds one nullable column and one index to `device_tokens` (`session_id`, `device_tokens_session_id_idx`). It touches no row and drops nothing. Recovery states, read-only checks and the wrapper's `resolve-applied` / `resolve-rolled-back` commands are in `DEVICE_SESSION_BINDING.md` section 4. Cleanup SQL, **not run**, for a half-applied run (staging or test only, after confirming which objects exist):

```sql
BEGIN;
DROP INDEX IF EXISTS "device_tokens_session_id_idx";
ALTER TABLE "device_tokens" DROP COLUMN IF EXISTS "session_id";
COMMIT;
```

### Recommended order and (not executed) commands

1. Back up (section 7) - for the dev database; staging needs no backup the first time.
2. Apply in this exact order, which is simply `prisma migrate deploy`: `...25_bookings_and_quotes`, `...26_payments_and_ledger`, `...27_realtime_chat_and_outbox`, `...28_storage_notifications_offers`, `...29_disputes_reviews_reporting`, `...30_audit_log_integrity`, `...31_file_scan_lifecycle`.
3. Staging (Render pre-deploy command, against the staging database only): `npx prisma migrate deploy`.
4. Development database, **only after you approve**, from `apps\backend`: `npm run check:local` then `npm run db:migrate:status` then `npm run db:migrate:deploy`. Re-check with `npm run db:migrate:status` afterwards (expect "Database schema is up to date"). Do not use `migrate dev`, `db push` or `migrate reset`.

## 9. Blockers

**Block a meaningful staging run**
1. No SMS provider: customers and workers cannot sign in on a production-mode staging (only the administrator can).
2. Redis: Render's default internal Key Value URL (no password, TLS unclear) is refused by the production Redis rule. Needs a decision (finding 2).
3. No scanner: S3 cannot be enabled in production mode without `STORAGE_ALLOW_UNSCANNED_FILES=true`, and clean-only serving needs a scanner. Staging must use `DOCUMENT_STORAGE=disabled` unless a "never serve" mode or a scanner is approved.
4. `TRUST_PROXY_HOPS` for Render is unmeasured.
5. Render facts still to confirm in the dashboard: pre-deploy command on the chosen plan, Key Value eviction policy, `NODE_ENV` during build, available regions.
6. Atomicity of a failed Prisma migration is unproven; use the recovery plan ("Safe recovery plan for a failed staging migration") and never start the application against a database with a failed migration.

**Block production use (in addition)**
7. No payment gateway, SMS provider, push provider, email provider or malware scanner exist.
8. Data residency: the S3 bucket is in Sydney; legal review is open. Render's regions are also outside Saudi Arabia **[assumption]**.
9. Administrator MFA is deferred (accepted risk); one all-powerful administrator role.
10. The application connects as the database owner on Render, so the audit-log and ledger triggers can be disabled by the application's own credentials; a separate non-owner runtime role is needed for real protection.
11. Readiness does not check migrations or S3; there is no external monitoring or log shipping yet.
12. Seven migrations pending on the dev database; production needs the backup and restore rehearsal (section 7) and an index-build window plan for large `bookings`/`quotes` tables.

## 10. Verified versus still to test

| Verified in this review (code or read-only query) | Still requires manual testing |
|---|---|
| Build/start commands, health and readiness behaviour, env validation rules, production refusals | Render build with devDependencies; pre-deploy migration step; `NODE_VERSION` |
| `pg` treats `sslmode=require` as verify-full; `uselibpqcompat=true` relaxes it | A real TLS connection to Render Postgres (internal and external) |
| ioredis/BullMQ/Socket.IO take the same `REDIS_URL` | A real `rediss://` connection; Key Value eviction policy and internal TLS |
| 10 migrations on disk, 3 applied on dev, 10 on test, checksums match, test DB schema equals `schema.prisma` | Applying them to a fresh staging database; timing of the index builds on large tables |
| Provider inventory: none real exists; unscanned files cannot be served in production without the override | Behaviour of the full flow with a real scanner and real SMS |
| Backup tools and versions on this machine | Running the backup and restoring it into a throwaway database |
| Proxy-trust semantics in Express and the header-spoofing test design | The actual number of proxy hops on Render |
| The seven files contain no explicit transaction control and no statement PostgreSQL forbids in a transaction; PostgreSQL runs a multi-statement simple query as one implicit transaction; neither database is in a partial migration state; `applied_steps_count` is 1 everywhere | **Whether Prisma applies each file atomically** (not documented in the pages read, never executed here); what a failed run really leaves behind |
