# Home Services — Backend

NestJS (TypeScript) REST API for the Saudi home-maintenance marketplace. It is a **modular monolith**; it contains the application foundation, a PostgreSQL (Prisma) and Redis layer, and the identity/profile schema.

## What is included

- Global prefix and URI versioning: `/api/v1/...`
- DTO validation (`ValidationPipe`: whitelist, reject unknown fields, transform)
- Swagger / OpenAPI at `/api/docs` (JSON at `/api/docs-json`)
- Centralised error handling with one JSON error shape and a `requestId`
- Structured JSON logging with `nestjs-pino` (pretty output in development), request IDs via `X-Request-Id`, auth headers redacted
- Environment configuration, validated at boot (the app refuses to start on invalid values)
- CORS allow-list from `CORS_ORIGINS`, `helmet` security headers, per-request timeout
- Health endpoints: `GET /api/v1/health` (liveness) and `GET /api/v1/health/ready` (PostgreSQL + Redis, `503` when degraded)
- PostgreSQL via Prisma, Redis via ioredis, local Docker Compose in `infra/`
- Foundation schema: `users`, `user_roles`, `customer_profiles`, `worker_profiles`, `refresh_tokens`, `audit_logs`

- Authentication and authorisation for the customer app, worker app and admin portal (see [Authentication](#authentication))

Not included yet: a real SMS provider, Firebase, and the marketplace tables (services, bookings, quotes, payments, ...).

## Requirements

- Node.js 22 or newer (developed on Node 24) and npm 9 or newer
- PostgreSQL 15 or newer (developed against a native Windows install of PostgreSQL 18)
- A Redis-compatible server with `GETDEL` support (Redis 6.2+). On Windows, **Memurai** works (Memurai 8.1 = Redis 8.2).
- Docker is **optional**. `infra/docker-compose.yml` is an alternative way to run PostgreSQL and Redis; it is not needed with native installs.

## Run locally (native PostgreSQL + Memurai, PowerShell)

### 1. One-time PostgreSQL setup

Run in `psql` as the `postgres` superuser (you will be prompted for its password; choose your own database password in place of `<choose-a-password>`):

```powershell
& 'C:\Program Files\PostgreSQL\18\bin\psql.exe' -h 127.0.0.1 -U postgres
```

```sql
CREATE USER home_services_app WITH PASSWORD '<choose-a-password>';
-- ENCODING 'UTF8' matters: the catalog and worker names are stored in Arabic. A Windows cluster can
-- default to WIN1252, which rejects Arabic text. TEMPLATE template0 is required to override the encoding.
CREATE DATABASE home_services OWNER home_services_app
  ENCODING 'UTF8' TEMPLATE template0 LC_COLLATE 'C' LC_CTYPE 'C';
CREATE DATABASE home_services_test OWNER home_services_app          -- only needed for npm run test:integration
  ENCODING 'UTF8' TEMPLATE template0 LC_COLLATE 'C' LC_CTYPE 'C';
\q
```

Never reuse the `postgres` superuser for the application. If a database already exists, check it with `SHOW server_encoding;` (inside that database); `npm run check:local` fails when it is not `UTF8`. A wrong-encoding database that is still empty can be dropped and recreated with the command above; do not do that to a database that holds data.

### 2. Configure the backend

```powershell
cd E:\saudi-home-services\apps\backend
npm install                          # also runs `prisma generate`
Copy-Item .env.example .env
.\scripts\setup-local-env.ps1        # generates JWT_ACCESS_SECRET / OTP_HMAC_SECRET, prints nothing secret
notepad .env                         # replace CHANGE_ME in DATABASE_URL with your database password
```

`REDIS_URL` is already `redis://127.0.0.1:6379`, correct for a Memurai without a password.

### 3. Check everything before changing anything (read-only)

```powershell
npm run check:local
```

It reports which settings are missing, whether PostgreSQL accepts the login (host, port, database and user are shown, the password never is), which migrations are applied or pending, and whether Memurai answers and supports `GETDEL`.

### 4. Apply migrations (only after step 3 shows the intended database)

```powershell
npm run db:migrate:status      # read-only
npm run db:migrate:deploy      # applies pending migrations only; never resets or drops anything
npm run check:local            # should now say "all 2 migrations are applied"
```

### 5. Start the API and verify

```powershell
npm run start:dev
# in a second terminal:
curl.exe -i http://127.0.0.1:3001/api/v1/health
curl.exe -i http://127.0.0.1:3001/api/v1/health/ready      # expect 200 with database: up, redis: up
```

Swagger UI: http://127.0.0.1:3001/api/docs

Production-style run: `npm run build` then `npm run start:prod`.

## Scripts

| Command | Purpose |
|---|---|
| `npm run start:dev` | Start with file watching |
| `npm run build` | Compile to `dist/` |
| `npm run start:prod` | Run the compiled build |
| `npm run typecheck` | Type-check without emitting |
| `npm test` | Unit tests |
| `npm run test:cov` | Unit tests with coverage |
| `npm run test:e2e` | HTTP-level tests (boots the real app wiring; **in-memory** database/Redis doubles, needs nothing running) |
| `npm run test:integration` | **Real** services: Memurai/Redis (`REDIS_URL`, logical DB 15) and PostgreSQL (`TEST_DATABASE_URL`, the database must be exactly `home_services_test`) |
| `npm run test:integration:redis` / `:postgres` | Only one of the two real-service suites |
| `npm run db:migrate:test:status` / `db:migrate:test` | Status / apply migrations on `TEST_DATABASE_URL` only (accepts only the arguments `status` or `deploy`; aborts unless the database is exactly `home_services_test`, differs from the dev database and a read-only `current_database()` check on the connection confirms it, all before Prisma starts) |
| `npm run db:migrate:test:resolve-applied -- <migration>` / `db:migrate:test:resolve-rolled-back -- <migration>` | Repair ONE failed migration on `home_services_test` (exact folder name required; refuses unless that migration is recorded as failed; see `docs/DEVICE_SESSION_BINDING.md`) |
| `npm run check:local` | Read-only check of `.env`, PostgreSQL, migrations and Memurai (no secrets printed) |
| `npm run tokens:purge` | Manual refresh-token cleanup (also runs automatically every 6 h) |
| `npm run db:seed` | Creates the launch cities, categories and services that are missing, plus ONE provisional pricing row if none exists (needs `npm run build` first; never overwrites edits) |
| `npm run test:integration:workers` | Catalog + worker onboarding + verification over HTTP against **real PostgreSQL** (`TEST_DATABASE_URL`) |
| `npm run test:integration:bookings` | Booking and quotation lifecycle plus concurrency races and database constraints, against **real PostgreSQL** |
| `npm run test:integration:payments` | Payment initiation, verified events, refund requests, ledger and sweep, against **real PostgreSQL** (gateway is a test double) |
| `npm run test:integration:admin` | Administrator operations, disputes, reviews and reports against **real PostgreSQL** |
| `npm run test:integration:files` | Private storage with real bytes (local provider), notifications and push pipeline, offers, against **real PostgreSQL** |
| `npm run test:s3-smoke` | **Live** check of the real S3 adapter against the configured bucket (needs `S3_SMOKE_TEST=1` and `S3_SMOKE_CONFIRM_BUCKET`; never part of the automated suites) |
| `npm run test:integration:realtime` | Sockets, live position, chat, outbox and job runner against **real PostgreSQL** and the **real Redis-compatible server** (logical DB 15, unique key prefix) |
| `npm run prisma:generate` | Regenerate the Prisma client |
| `npm run prisma:validate` | Validate `schema.prisma` |
| `npm run db:migrate:dev` | Create and apply a migration after editing the schema (development only) |
| `npm run db:migrate:deploy` | Apply committed migrations without changing them (use in CI/production) |
| `npm run db:migrate:status` | Show which migrations are applied |
| `npm run db:studio` | Browse data in Prisma Studio |
| `npm run admin:bootstrap` | Create the first administrator (run `npm run build` first; see Administrators) |
| `npm run admin:reset-password` | Operator recovery of an admin password |

## Configuration

Copy `.env.example` to `.env`. Only `.env.example` is tracked by git; `.env*` files are ignored. In deployed environments, provide variables through the platform, not a committed file.

| Variable | Default | Notes |
|---|---|---|
| `NODE_ENV` | `development` | `development`, `test` or `production` |
| `PORT` / `HOST` | `3001` / `0.0.0.0` | |
| `API_PREFIX` | `api` | URL prefix |
| `API_DEFAULT_VERSION` | `1` | Becomes `/api/v1` |
| `CORS_ORIGINS` | empty | Comma-separated allow-list; empty disables CORS; `*` is rejected in production |
| `LOG_LEVEL` | `info` | `fatal` … `trace`, `silent` |
| `SWAGGER_ENABLED` | on outside production | Set explicitly to override |
| `REQUEST_TIMEOUT_MS` | `30000` | `0` disables |
| `JWT_ACCESS_SECRET` | required | At least 32 chars; signs access tokens. Must differ from `OTP_HMAC_SECRET` |
| `OTP_HMAC_SECRET` | required | At least 32 chars; keys the HMAC that protects stored OTPs |
| `ACCESS_TOKEN_TTL_SECONDS` | `900` | Access token lifetime (15 min) |
| `REFRESH_TOKEN_TTL_DAYS` / `ADMIN_REFRESH_TOKEN_TTL_HOURS` | `30` / `12` | Mobile vs admin-portal session length |
| `OTP_TTL_SECONDS` / `OTP_MAX_ATTEMPTS` | `300` / `5` | Code lifetime; wrong guesses before the code is destroyed |
| `OTP_RESEND_COOLDOWN_SECONDS` / `OTP_MAX_SENDS_PER_HOUR` | `60` / `5` | Resend limits per phone number |
| `DEFAULT_PHONE_REGION` | `SA` | Region for national numbers such as `0501234567` |
| `SMS_PROVIDER` | `dev` outside production, `disabled` in production | `dev` is **refused** when `NODE_ENV=production` |
| `TRUST_PROXY_HOPS` | `0` | Reverse proxies in front of the API, so per-IP limits see the real client |
| `DATABASE_URL` | required | `postgresql://user:password@host:5432/db?schema=public`; URL-encode special characters in the password |
| `WORKER_REQUIRE_IDENTITY_DOCUMENT` | `true` | A worker needs an uploaded national ID or iqama to submit; an admin must accept it before approving |
| `DOCUMENT_STORAGE` | `dev` outside production, `disabled` in production | `dev` (fake URLs, nothing stored) is **refused** in production |
| `DOCUMENT_URL_TTL_SECONDS` | `900` | Lifetime of signed upload/download URLs |
| `BOOKING_REQUEST_TTL_HOURS` | `48` | How long a request stays open for quotes |
| `BOOKING_MIN_LEAD_MINUTES` / `BOOKING_MAX_OPEN_PER_CUSTOMER` | `30` / `10` | Earliest allowed start; open requests per customer |
| `BOOKING_MAX_QUOTES` / `BOOKING_MAX_PHOTOS` | `10` / `5` | Live quotes per request; photos per booking |
| `QUOTE_DEFAULT_VALIDITY_HOURS` / `QUOTE_MAX_VALIDITY_HOURS` | `24` / `72` | Quote validity |
| `QUOTE_MAX_PRICE_HALALAS` | `5000000` | Highest quotable service price (halalas; SAR 50,000) |
| `PAYMENT_WINDOW_MINUTES` | `30` | Time to pay after accepting a quote (stored as `payment_due_at`; enforced by the payments phase) |
| `PAYMENT_PROVIDER` | `disabled` | `disabled` or `mock`. `mock` is simulation only and **refused in production** (the API will not start) |
| `PAYMENT_CHECKOUT_TTL_MINUTES` / `PAYMENT_STALE_AFTER_MINUTES` | `20` / `30` | Checkout lifetime; age after which an open attempt is reported as stale |
| `PAYMENT_WEBHOOK_MAX_BODY_BYTES` / `PAYMENT_WEBHOOK_LEASE_SECONDS` | `65536` / `120` | Webhook size limit; how long a claimed event is protected from takeover |
| `PAYMENT_RETURN_URL_ORIGINS` | empty | Origins a checkout may return the customer to (empty = no `returnUrl` accepted) |
| `REALTIME_ENABLED` / `REALTIME_REDIS_ADAPTER` | `true` / `true` | Socket.IO on or off; share rooms across API instances through Redis |
| `LOCATION_TTL_SECONDS` / `LOCATION_SHARING_LEAD_MINUTES` | `120` / `180` | How long the latest worker position lives in Redis; how long before the preferred start a `CONFIRMED` booking may start sharing (`0` = no limit) |
| `JOBS_ENABLED` / `QUEUE_PREFIX` | `true` / `hs` | BullMQ workers in this process (at least one instance must run them); Redis key prefix of queues and adapter |
| `OUTBOX_MAX_ATTEMPTS` / `OUTBOX_RETENTION_DAYS` | `8` / `7` | Delivery attempts before an event is parked as dead; days finished outbox rows are kept |
| *(more)* | | The remaining realtime, location, chat and outbox limits are listed in `.env.example` and explained in [docs/REALTIME.md](docs/REALTIME.md) |
| `DOCUMENT_STORAGE` | `disabled` (production), `dev` otherwise | `disabled`, `dev` (fake), `local` (real bytes, dev/test only), `s3`. `dev` and `local` are refused in production |
| `STORAGE_MAX_FILE_BYTES` / `DOCUMENT_URL_TTL_SECONDS` | `10485760` / `900` | Upload size ceiling; lifetime of signed upload/download URLs |
| `FILE_SCANNER` / `STORAGE_REQUIRE_CLEAN_SCAN` | `disabled` / `false` | No scanner is integrated: `disabled` leaves files `NOT_SCANNED` (not "clean"). `mock` is refused in production |
| `PUSH_PROVIDER` / `DEVICE_TOKEN_ENCRYPTION_KEY` | `disabled` / none | `disabled` or `mock` (refused in production); base64 of 32 bytes, encrypts stored push tokens |
| *(more)* | | S3, local-storage, removal-job and notification settings are listed in `.env.example` and explained in [docs/STORAGE_NOTIFICATIONS_OFFERS.md](docs/STORAGE_NOTIFICATIONS_OFFERS.md) |
| `REDIS_URL` | required | `redis://:password@host:6379` (use `rediss://` for TLS) |

For the admin portal running on port 3000 locally, set `CORS_ORIGINS=http://localhost:3000`. Mobile apps do not need CORS.

## Project layout

```text
src/
├── main.ts                 Bootstrap
├── app.module.ts           Root module (config, logging, feature modules)
├── app.setup.ts            Shared HTTP wiring (prefix, versioning, pipes, filters, CORS, Swagger)
├── common/
│   ├── decorators/         (empty — added with auth)
│   ├── guards/             (empty — added with auth)
│   ├── filters/            AllExceptionsFilter
│   └── interceptors/       TimeoutInterceptor
├── config/                 Environment schema + typed config
├── database/               PrismaService, RedisService (global DatabaseModule)
├── generated/prisma/       Generated Prisma client (git-ignored)
└── modules/
    └── health/             GET /api/v1/health
test/                       e2e tests
prisma/
├── schema.prisma           Data model
└── migrations/             Committed SQL migrations
```


See `src/modules/README.md` for the module boundary rules and the planned modules.

## Database

### Schema (first migration `init`)

- `users`: one row per person (UUID v7 id, unique E.164 phone, optional unique email, optional password hash, locale, status).
- `user_roles`: composite key `(user_id, role)` with `CUSTOMER`, `WORKER`, `ADMIN`. One person can hold several roles on a single account, so no duplicate accounts.
- `customer_profiles` / `worker_profiles`: one optional row per user (worker verification status, online flag).
- `refresh_tokens`: SHA-256 hash of each token, rotation chain (`family_id`, `replaced_by_id`) for reuse detection, `revoked_at` for session revocation.
- `audit_logs`: append-only record of sensitive actions; actor is kept as `NULL` if the user is deleted.

Passwords, refresh tokens and one-time codes are never stored in clear. One-time codes belong in Redis, hashed, with a TTL.

### Changing the schema

1. Edit `prisma/schema.prisma`.
2. `npm run db:migrate:dev -- --name <what_changed>` against your local database.
3. Review the generated SQL in `prisma/migrations/` and commit it with the schema change.
4. Never edit a migration that has already been applied elsewhere; add a new one.

### Safe operations (data loss warnings)

| Action | Effect |
|---|---|
| `docker compose stop` / `down` | Safe. Data stays in the named volumes. |
| `docker compose up -d --build` | Safe. |
| `npm run db:migrate:deploy` | Safe. Only applies pending migrations. |
| `docker compose down -v` | **Deletes all PostgreSQL and Redis data.** |
| `npx prisma migrate reset` | **Drops and recreates the database.** Prisma asks for confirmation; refuses in non-interactive mode without `--force`. |
| `npx prisma db push` | Do not use: bypasses migration history. |

To reset on purpose, use the disposable test database only:

```bash
# DATABASE_URL pointing at .../home_services_test
npx prisma migrate reset
```

Check the database name in `DATABASE_URL` before running any reset. Take a backup (`docker compose exec postgres pg_dump -U <user> <db> > backup.sql`) before anything destructive.

### Infrastructure notes

The Docker files in `infra/` are optional (this project is developed against native PostgreSQL and Memurai) and have never been run on the development machine.

- `infra/docker-compose.yml` is for local development: ports are bound to `127.0.0.1` only, credentials come from `infra/.env` (git-ignored), Redis requires a password.
- `infra/docker-compose.prod.yml` is an override that publishes no ports and puts the stores on an internal network. Prefer managed PostgreSQL/Redis in production and provide credentials from the platform's secret store.
- The first start also creates `home_services_test` for automated tests so tests never touch development data.

## Authentication

### Who signs in how

| Client | Method | Endpoints |
|---|---|---|
| Customer app, worker app | Phone number + SMS one-time code | `POST /api/v1/auth/otp/request`, `POST /api/v1/auth/otp/verify` |
| Admin portal | Email + password | `POST /api/v1/auth/admin/login`, `POST /api/v1/auth/admin/change-password` |
| All | Session management | `POST /auth/refresh`, `POST /auth/logout`, `POST /auth/logout-all`, `GET /auth/me` |

Schemas are in Swagger (`/api/docs`). Errors carry a stable `code` (for example `OTP_EXPIRED`, `OTP_INVALID`, `RATE_LIMITED`, `WORKER_NOT_APPROVED`) next to the message, and 429 responses include `Retry-After`.

### Phone numbers

Input such as `0501234567`, `+966 50 123 4567` or `00966501234567` is normalised to E.164 (`+966501234567`) with `libphonenumber-js`; other countries work with their `+` prefix. The same person therefore always maps to the same account.

### One-time codes

- 6 digits from a CSPRNG, valid for 5 minutes, single use.
- Stored in **Redis only**, as an HMAC of `phone:code` (keyed by `OTP_HMAC_SECRET`) with a TTL. The code itself exists only in the SMS. Redis key names contain a hash of the phone, not the number.
- Limits (all counters live in Redis, so they hold across API instances; every lock is temporary):
  - sending: 60 s resend cooldown per number; 6 codes per hour per number, of which one client IP may use at most 3; 10 requests per IP per 10 minutes;
  - guessing: 5 wrong codes per (number, client IP) and 15 per number per 15 minutes. Hitting a limit only pauses guessing; it never destroys the real user's code, and up to 3 recent codes stay valid, so an attacker cannot lock a real user out by requesting codes or guessing;
  - brute force stays infeasible: at most 15 wrong guesses per number per 15 minutes against 1,000,000 codes.
- Requesting a code never reveals whether the number has an account.

### SMS providers

`SmsProvider` (`src/modules/auth/sms/sms-provider.ts`) is the contract. Two adapters exist:

- `dev`: logs the message, **including the code**, to the server log. Development only: environment validation and `SmsModule` both refuse it when `NODE_ENV=production`.
- `disabled`: fails closed with `503 SMS_PROVIDER_NOT_CONFIGURED`. The production default until a provider is added.

If Redis or PostgreSQL is unreachable, the API answers `503 SERVICE_UNAVAILABLE` (fail closed, no internals in the body) instead of an unhandled 500.

To add a real provider (Unifonic, Taqnyat, Twilio, ...): implement `SmsProvider` with credentials from environment variables, add its name to `SmsProviderName` and the switch in `sms.module.ts`, and document the variables in `.env.example`. Nothing in this repository talks to an SMS service.

### Tokens and sessions

- **Access token**: JWT (HS256), 15 minutes, carrying only user id, session id and acting role.
- **Refresh token**: opaque random string, single use, rotated on every refresh; only its SHA-256 hash is stored. Mobile apps should keep it in the Keystore/Keychain. The admin portal should keep it in an `httpOnly`, `Secure`, `SameSite` cookie set by its own server side (this API returns it in the body for now).
- Every refresh token belongs to a **session** (family). Replaying a spent token revokes the whole session. Logout revokes the session; `logout-all` revokes all of the user's sessions.
- The auth guard re-reads the account on every request, so logout, suspension and worker-approval changes take effect **immediately**, not when the access token expires.

### Authorisation

- `JwtAuthGuard` and `RolesGuard` are global: **every route requires a token unless marked `@Public()`**.
- `@Roles(Role.X)` restricts a route to sessions *acting as* that role. A person who is both customer and worker gets separate sessions per app, and a customer-app token cannot call worker routes.
- `@RequireApprovedWorker()` guards worker job operations: workers who are not `APPROVED` get `403 WORKER_NOT_APPROVED`.
- `assertOwnerOrAdmin(user, ownerId)` (`common/auth/ownership.ts`) is the resource-level check. Call it in every handler that loads a record by id (bookings will), so one customer or worker can never read another's data.
- Clients cannot request roles: the sign-in DTOs accept only `app: customer | worker`, unknown fields are rejected, and `ADMIN` is created only by the operator CLI. Signing in through the worker app adds the `WORKER` role in `NOT_SUBMITTED` state; an admin must approve it (approval endpoints come with the admin features).
- Account status is enforced on sign-in, refresh and every request (`SUSPENDED` / `DEACTIVATED` accounts get `403`).

### Administrators

There is no registration endpoint. The first administrator is created on the server by an operator:

```bash
npm run build
# bash:
ADMIN_EMAIL=owner@example.com ADMIN_PASSWORD='a-long-unique-password' npm run admin:bootstrap
# PowerShell:
$env:ADMIN_EMAIL='owner@example.com'; $env:ADMIN_PASSWORD='a-long-unique-password'; npm run admin:bootstrap
```

- Refuses to run if any administrator already exists. The password (12-128 chars, letters plus numbers or symbols) is read from the environment, never printed, and stored as an Argon2id hash. Clear the variable afterwards (`unset ADMIN_PASSWORD` / `Remove-Item Env:ADMIN_PASSWORD`).
- The account is flagged `mustChangePassword`: until the admin calls `change-password`, every other route answers `403 PASSWORD_CHANGE_REQUIRED`.
- **Recovery** of a forgotten password is operator-only: `npm run admin:reset-password` (same variables). It sets a temporary password, forces a change, and revokes all sessions. There is no emailed reset link because no email provider is configured yet.
- Failed logins are throttled per email+IP (5), per email (20) and per IP (30) per 15 minutes; wrong-password and unknown-email responses are identical.
- **MFA extension point**: `AdminMfaPolicy` (`modules/auth/admin/admin-mfa.policy.ts`). Login already calls `isRequired` / `verify` after the password check and accepts an optional `mfaCode`; today `NoMfaPolicy` is bound. To add TOTP, implement the class and rebind it in `AuthModule`.

## Service catalog and worker verification

### Reference data (managed through the admin API, not code)

`cities`, `service_categories` and `services` are ordinary rows with English and Arabic names and descriptions, an `isActive` flag and a `sortOrder`. Nothing in the application logic mentions Riyadh, Electrical, etc. Deactivating a row hides it from customers and from new worker selections; it is never deleted (history and existing workers keep working).

Create the three launch cities and three launch categories (with starter services) once, on a migrated database:

```powershell
npm run build
npm run db:seed        # safe to repeat: only creates what is missing, never overwrites admin edits
```

| Endpoint | Who | Purpose |
|---|---|---|
| `GET /api/v1/catalog`, `GET /api/v1/catalog/cities` | public | Active categories with services, active cities (EN + AR) |
| `GET/POST/PATCH /api/v1/admin/service-categories[/:id]` | admin | Manage categories |
| `GET/POST/PATCH /api/v1/admin/services[/:id]` | admin | Manage services (`categoryId`, `isActive`, `q` filters) |
| `GET/POST/PATCH /api/v1/admin/cities[/:id]` | admin | Manage launch cities |

Slugs are unique and immutable; list endpoints return `{ items, meta: { page, limit, total, totalPages } }` and accept `page`, `limit` (max 100), `q`, `isActive`.

### Worker onboarding (worker app, role `WORKER`)

| Endpoint | Purpose |
|---|---|
| `GET /api/v1/workers/me/onboarding` | Everything: profile, services, cities, schedule, documents, verification status |
| `PUT /workers/me/profile` | Name (EN/AR), introduction, years of experience |
| `PUT /workers/me/services` | Services offered (with years per service); replaces the list |
| `PUT /workers/me/areas` | Cities served; replaces the list |
| `PUT /workers/me/availability` | Weekly windows (`dayOfWeek` 0=Sunday..6, `HH:mm`, Saudi time); replaces the schedule |
| `POST /workers/me/documents` then `POST .../:id/confirm` | Register a document, upload to the signed URL, confirm. `GET`/`DELETE` also available |
| `GET /workers/me/verification` | Status, reviewer message, history, `missing` items, `canSubmit` |
| `POST /workers/me/verification/submit` | Submit for review (`409 VERIFICATION_INCOMPLETE` with `details.missing` until complete) |

### Verification workflow

```text
NOT_SUBMITTED --submit--> SUBMITTED --start-review--> UNDER_REVIEW
SUBMITTED | UNDER_REVIEW --approve--> APPROVED --suspend--> SUSPENDED --reinstate--> APPROVED
SUBMITTED | UNDER_REVIEW --reject--------> REJECTED       \  worker fixes things
SUBMITTED | UNDER_REVIEW --request-info--> INFO_REQUIRED  /  and resubmits
```

Admin endpoints (`/api/v1/admin/workers`, role `ADMIN` only): `GET` (review queue by default, oldest first; filters `status` CSV or `ALL`, `cityId`, `serviceId`, `q`, `sort`), `GET /:id`, `POST /:id/start-review|approve|reject|request-info|suspend|reinstate`, `PATCH /:id/documents/:docId` (accept/reject), `GET /:id/documents/:docId/download-url` (audited).

Rules enforced in code and covered by tests:

- Only administrators can change a verification status; a worker can only submit. Transitions outside the diagram return `409 INVALID_STATE`; two admins deciding at once cannot both succeed.
- `reject`, `request-info` and `suspend` require a written `reason` (shown to the worker and stored in `worker_verification_events` with the admin's id). Every decision is also written to `audit_logs` (which records that a reason was given, not its text).
- Approval needs a complete profile and, when `WORKER_REQUIRE_IDENTITY_DOCUMENT` is on, an **accepted** national ID or iqama.
- `APPROVED` is the only status that unlocks worker job routes and customer discovery. A suspended worker disappears from discovery, loses job access and cannot edit the profile; going offline is forced.
- Customers find workers with `GET /api/v1/discovery/workers` (filters `cityId`, `serviceId`, `categoryId`, `onlineOnly`) and `GET /discovery/workers/:id`. Responses contain only name, bio, experience, services, cities and online state. Never phone, email, account id, documents, review notes or history. Unknown, unapproved and suspended workers all return `404`.
- Identity documents are metadata only. File bytes go straight to private object storage through the `DocumentStorage` interface (`modules/workers/storage`). **No real storage adapter exists yet**: `dev` fakes it for development and `disabled` (the production default) answers `503 DOCUMENT_STORAGE_NOT_CONFIGURED`. Storage keys and checksums are never returned by any endpoint; admins view a file only through a short-lived signed URL, and each request is audited.

## Bookings and quotations

### Workflow

1. The **customer** creates a request (`POST /api/v1/bookings`): service, city, address, preferred time window, problem description, optional photos. No worker is chosen.
2. **Eligible workers** (approved, account active, offering that service in that city) see it in `GET /api/v1/workers/me/requests`. Before payment they see only the city and district, never the street, coordinates or customer identity.
3. A worker sends **one quote** (`POST /workers/me/requests/:id/quote`) with only their own price before VAT in halalas, a proposed time window and a message. They can edit it (`PATCH /workers/me/quotes/:id`) or withdraw it, while it is live.
4. The customer **compares** quotes (`GET /bookings/:id/quotes`): price, VAT, total, proposed time, message and a public worker summary (name, bio, experience, completed jobs; `ratingAverage` is `null` and `ratingCount` is 0 until reviews exist). Commission is never shown to customers.
5. The customer **accepts one** (`POST /bookings/:id/quotes/:quoteId/accept`, optionally with `expectedVersion`). The booking becomes `PAYMENT_PENDING`; every other quote is rejected.
6. Payment (next phase) calls `BookingLifecycleService.confirmPaymentInTransaction()` (or `confirmPayment()`) with the gateway amount and currency, which are verified against the agreed total; the booking becomes `CONFIRMED`. Duplicates and payments for bookings that cannot take them are reported with distinct codes (`BOOKING_ALREADY_PAID`, `BOOKING_NOT_PAYABLE`). See [docs/PAYMENTS_INTEGRATION.md](docs/PAYMENTS_INTEGRATION.md). **There is no HTTP endpoint that marks a booking paid.** The assigned worker may then `start` and `complete` it.

### Status model

```text
OPEN --accept quote (customer)--> PAYMENT_PENDING --payment confirmed (system)--> CONFIRMED
CONFIRMED --start (assigned worker)--> IN_PROGRESS --complete (assigned worker)--> COMPLETED
OPEN --nobody chosen in time (system)--> EXPIRED
OPEN | PAYMENT_PENDING | CONFIRMED --cancel (customer or admin)--> CANCELLED
IN_PROGRESS --cancel (admin only)--> CANCELLED
```

The table lives in `modules/bookings/booking-state-machine.ts` and is exhaustively unit-tested. Quote statuses: `SUBMITTED`, `ACCEPTED`, `REJECTED`, `WITHDRAWN`, `EXPIRED`. Every change is a compare-and-set update in one transaction together with its `booking_events` row, so the timeline is complete and consistent. Cancellations also write `booking_cancellations` (who, why, previous status, so refunds can be handled later) and admin cancellations are audit-logged.

### Money (integers only)

- Amounts are **integer halalas** (100 = SAR 1) and rates are **integer basis points** (1500 = 15%); there is no floating point anywhere in money maths (`modules/pricing/money.ts`, rounded half up, unit-tested over thousands of combinations). The database stores `INTEGER` columns with CHECK constraints (`total = price + VAT`, `payout = price - commission`, non-negative).
- A worker sends only `priceHalalas`. VAT, commission, total and payout are computed by the server; any attempt to send them is rejected with 400.
- **VAT, commission rate and the minimum service charge are business settings, not code.** They live in `pricing_settings` (versioned, append-only), are read at quote time, and are managed by administrators with `GET/POST /api/v1/admin/pricing-settings`. Each quote and booking keeps the rates it was created with; later changes never alter them.
- `npm run db:seed` inserts one row **marked `is_provisional = true`** (VAT 15%, commission 15%, minimum SAR 50) so development works. **These are placeholders, not confirmed business rules.** Until a real version is published, the "current" pricing is that placeholder; if no pricing row exists at all, quoting answers `503 PRICING_NOT_CONFIGURED`.
- Provisional assumptions to confirm: VAT is charged to the customer on top of the worker's price; the commission is deducted from the worker's price; both are calculated on the price before VAT.

### Rules enforced (and tested against real PostgreSQL)

- Only the booking owner can view or accept (anyone else gets 404, which looks the same as a missing booking). Only the assigned worker can see the job, start or complete it. Workers see only requests for services they offer in cities they serve.
- Only approved workers (account active) can see requests or quote; a suspended worker loses access at once, and their un-accepted quotes can no longer be accepted.
- A booking can never have two accepted quotes: the accept is a compare-and-set on the quote (still `SUBMITTED`, unexpired, same `version`), a compare-and-set on the booking (still `OPEN` with no accepted quote), all under a per-booking row lock, with a UNIQUE index on `(booking_id, is_accepted)` as the final guard. Simultaneous accepts of different or identical quotes produce exactly one success.
- `expectedVersion` makes the customer accept exactly what they saw: if the worker edited the quote meanwhile, the request fails with `409 QUOTE_CHANGED` (the price is never taken from the client).
- Expired, withdrawn, rejected or invalid quotes cannot be accepted; expiry is re-checked at acceptance time, and a housekeeping job (every 5 minutes, disabled in tests) marks expired quotes and requests.
- Privacy: before payment workers never see the street address, coordinates or customer contact; after payment the assigned worker (only) does. The customer sees the worker's phone only after payment. Photos are metadata plus signed links, visible to the owner, eligible/assigned workers and admins (admin access is audited).

### Endpoints

| Area | Endpoints |
|---|---|
| Customer (`CUSTOMER`) | `POST/GET /bookings`, `GET /bookings/:id`, `POST /bookings/:id/cancel`, `GET /bookings/:id/quotes`, `POST /bookings/:id/quotes/:quoteId/accept`, photos: `POST /bookings/:id/photos`, `.../:photoId/confirm`, `DELETE`, `GET .../download-url` |
| Worker (approved `WORKER`) | `GET /workers/me/requests[/:id]`, `POST /workers/me/requests/:id/quote`, `GET /workers/me/quotes`, `PATCH /workers/me/quotes/:id`, `POST /workers/me/quotes/:id/withdraw`, `GET /workers/me/bookings[/:id]`, `POST /workers/me/bookings/:id/start`, `POST /workers/me/bookings/:id/complete`, `GET /workers/me/requests/:id/photos/:photoId/download-url` |
| Admin (`ADMIN`) | `GET /admin/bookings`, `GET /admin/bookings/:id` (all quotes, commission, timeline), `POST /admin/bookings/:id/cancel` (note required), `GET /admin/pricing-settings[/current]`, `POST /admin/pricing-settings` |

List endpoints return `{ items, meta }` and accept `page`, `limit` (max 100), `status` (comma-separated), `serviceId`, `cityId`, `createdFrom/To`, `sort`. Admin lists also filter by `customerId`, `workerId` and `reference`.

## Payments

**No real payment gateway is integrated, and no real charge or refund can happen.** The infrastructure is provider-neutral and tested on real PostgreSQL; the full design, state machines, invariants and the list of undecided business/accounting questions are in [docs/PAYMENTS_INTEGRATION.md](docs/PAYMENTS_INTEGRATION.md).

- `PAYMENT_PROVIDER=disabled` (default everywhere): starting a payment answers `503 PAYMENT_PROVIDER_NOT_CONFIGURED`; nothing is created and no booking can be marked paid.
- `PAYMENT_PROVIDER=mock` (development only): a **simulated** checkout (`simulated: true`). Outcomes are injected with the administrator-only `POST /api/v1/dev/payments/:id/simulate`, which exists only while the mock is active outside production. The mock does not accept webhooks, and it is rejected at startup in production.

| Area | Endpoints |
|---|---|
| Customer (`CUSTOMER`) | `POST /bookings/:id/payments` (header `Idempotency-Key` required), `GET /payments`, `GET /payments/:id`, `POST /payments/:id/cancel` |
| Provider events | `POST /payments/webhooks/:provider` (public route; trust comes only from the adapter's signature check over the raw body; answers 404 while no real provider exists) |
| Admin (`ADMIN`) | `GET /admin/payments`, `GET /admin/payments/:id`, `GET /admin/payments/reconciliation`, `GET /admin/payments/webhook-events[/:id]`, `POST /admin/payments/webhook-events/:id/retry`, `POST /admin/payments/:id/refunds` (idempotent, reason required, request only), `GET /admin/refunds[/:id]`, `POST /admin/refunds/:id/cancel`, `GET /admin/ledger` (read-only) |

How it keeps money safe, in short:

- The amount is always the booking's immutable agreed total (a database trigger forbids changing it); clients cannot send an amount.
- A booking becomes `CONFIRMED` only inside the same database transaction that records a **verified** provider event, the payment and the ledger entry. Coming back from a checkout page proves nothing.
- Repeated, concurrent, late and out-of-order events cannot confirm twice or post twice. Money captured for a cancelled booking, a duplicate payment or a wrong amount is stored as `CAPTURED_UNAPPLIED`, posted to the ledger, listed in the reconciliation report, and **not** refunded automatically.
- Refund requests reserve part of the captured amount (database-capped) and stay `REQUESTED`; nothing says money was returned until a provider confirms it (future phase).
- The ledger is append-only (triggers). The payment-deadline action is **disabled** until the business decides what an unpaid booking becomes; the sweep only reports.

Run the payment tests with `npm run test:integration:payments` (needs `TEST_DATABASE_URL`, see Tests).

## Realtime tracking, booking chat and background jobs

Backend foundation only (no app screens). Architecture, event contracts, authorization model, location lifecycle, chat behaviour, Redis keys, job strategy and the Memurai-versus-production-Redis notes are in
**[docs/REALTIME.md](docs/REALTIME.md)**. In short:

- **Sockets.** Socket.IO namespace `/realtime`, authenticated with the normal access token in the handshake (never the URL). Every room join and every sensitive event is re-authorized from PostgreSQL;
  only a booking's customer and its assigned, approved worker take part, everyone else (administrators included) gets "not found". Event names are versioned (`booking.event.v1`, `chat.message.v1`, ...).
- **Live position.** The assigned worker publishes while the booking is `CONFIRMED` (inside a configurable lead window before the preferred start) or `IN_PROGRESS`. Only the latest position is kept, **in Redis only**, with an expiry;
  nothing is written to PostgreSQL. Stale, future, implausible, too-frequent or inaccurate readings are rejected. Only the owning customer can read it; it stops the moment the booking is completed, cancelled or expired.
- **Chat.** `GET/POST /api/v1/bookings/{id}/messages` (+ receipts) and matching socket events. Durable in PostgreSQL, text only, idempotent sends (`clientMessageId`), gap-free `seq` ordering with stable pagination,
  explicit delivered/read receipts, recovery of missed messages after a reconnect.
- **Booking events.** Written to a transactional outbox in the same transaction as the booking change (a rollback announces nothing) and delivered after commit by a BullMQ job (at-least-once, backoff, parked after `OUTBOX_MAX_ATTEMPTS`).
- **Jobs.** BullMQ on Redis: outbox delivery, stale-data cleanup, stale/dead reporting, notification groundwork (no provider). Status is visible in `GET /api/v1/health/ready` (`jobs`).
- **Migration.** `20261027090000_realtime_chat_and_outbox` adds `chat_messages`, `chat_participant_states` and `realtime_outbox_events` (new tables only; no existing table or data is touched).

Run its tests with `npm run test:integration:realtime` (needs `TEST_DATABASE_URL` and the local Redis-compatible server).

## Private storage, notifications and offers

Backend only (no app screens). Provider interfaces, the upload and download workflow, access rules, scanning and deletion semantics, the event-to-recipient mapping, push delivery statuses, the device-token contract for the apps,
offer eligibility and the missing redemption decisions are in **[docs/STORAGE_NOTIFICATIONS_OFFERS.md](docs/STORAGE_NOTIFICATIONS_OFFERS.md)**. In short:

- **Files are private.** Storage keys are generated by the server (never the user's file name). Uploads go to short-lived signed URLs; on *confirm* the server reads the stored object and checks its real size and **file signature**, then scans it
  (no scanner is integrated, so files are `NOT_SCANNED`, which is not "clean"). Downloads are short-lived signed URLs issued only after an ownership/role check; verification documents are administrator-only and every view is audited.
  Deleting a file queues its removal in the same transaction; a retried, idempotent job removes the object.
- **Notifications** are durable rows (template key + safe parameters, rendered in Arabic or English per reader), created after commit from the realtime outbox and idempotent per business event; `GET /api/v1/notifications` lists, counts and marks them read.
  **Push** is a provider-neutral pipeline (`SENT` means accepted by the provider, never "delivered"); no real FCM/APNs/HMS, SMS or email is configured, so nothing external is ever sent. `POST /api/v1/devices` is the token-registration contract for the apps.
- **Offers** are admin-managed announcements (`/api/v1/admin/offers`, customer/worker listing at `/api/v1/offers`) with scheduling, targeting and audit history. They carry **no discount or price** and **cannot be redeemed**; bookings and the ledger are untouched.
- **Migration.** `20261028090000_storage_notifications_offers` (two defaulted columns on existing file tables, new tables otherwise).

Run its tests with `npm run test:integration:files` (needs `TEST_DATABASE_URL`).

## Admin operations, disputes, reviews and reporting

Backend only. Permission boundaries, audit behaviour and redaction, the dispute state machine, review eligibility, moderation and the rating calculation, every report's definition and source tables, which financial numbers are provider-confirmed and which are not,
and the migration commands are in **[docs/ADMIN_DISPUTES_REVIEWS_REPORTS.md](docs/ADMIN_DISPUTES_REVIEWS_REPORTS.md)**. In short:

- **Administrators** have one role (`ADMIN`, all-or-nothing). New: `GET /admin/users` (redacted list, search, filters), `GET /admin/users/{id}/overview`, `POST /admin/users/{id}/suspend|reactivate` (reason required; sessions and live sockets end at once; nothing is deleted), `GET /admin/audit-logs`.
  Sensitive actions are audited; secrets, tokens and signed links are redacted centrally. Administrators cannot mark payments paid, edit financial records, impersonate users, or create/edit reviews.
- **Disputes** (`/disputes` for the two parties, `/admin/disputes` for staff): `OPEN -> UNDER_REVIEW <-> AWAITING_INFO -> RESOLVED -> CLOSED`, evidence referencing existing photos/chat messages of the booking, hidden internal notes, auditable reopen. A dispute changes no booking, money, ledger, rating or account; a money follow-up is only a flag.
- **Reviews**: the customer of a completed booking rates the worker 1-5 once (no edits; withdrawal is final); administrators can hide/restore with a reason but never rewrite. A worker's rating is the average of published reviews, recomputed from the table under a lock on every change.
- **Reports** (`/admin/reports/*`): bookings, trend, quotes, workers, reviews, disputes, notifications, operations, payments, ledger. Aggregated in PostgreSQL, no personal data, per-currency, with the meaning of each money figure spelled out (a requested refund is never reported as a completed one; a ledger total is not a balance or revenue).
- **Defect fixed:** application-written timestamps were stored shifted by the PostgreSQL server's time-zone offset on this machine (Asia/Karachi); connections now run in UTC (details in the document, section 11).
- **Migration:** `20261029090000_disputes_reviews_reporting` (new tables, two defaulted columns, report indexes).

Run its tests with `npm run test:integration:admin` (needs `TEST_DATABASE_URL`).

### Production-readiness gaps

See [SECURITY.md](SECURITY.md): no real SMS provider, no MFA, admin refresh-token delivery, and the missing admin approval/suspension endpoints are documented there.

### Auth migration

`prisma/migrations/20261023090000_auth_foundation` makes `users.phone` nullable (admins have none; a CHECK requires a phone or an email) and adds `must_change_password`, `password_changed_at` and `refresh_tokens.session_role`.

### Tests

| Command | Uses | Proves |
|---|---|---|
| `npm test` | In-memory doubles (`src/testing/`) | Logic: OTP rules, sessions, guards, admin flows |
| `npm run test:e2e` | In-memory doubles, real HTTP stack | Routes, validation, error shapes, role and ownership rules |
| `npm run test:integration:redis` | **Real Memurai/Redis**, logical DB 15 | `GETDEL` one-time consumption (also under concurrency), TTL expiry, OTP storage, rate-limit counters, 503 on outage |
| `npm run test:integration:postgres` | **Real PostgreSQL** (`TEST_DATABASE_URL`) | Migrations applied, constraints, cascades, sign-up/refresh/replay flows, token purge |
| `npm run test:integration:bookings` | **Real PostgreSQL**, full HTTP stack (Redis, SMS and storage are doubles) | The whole booking and quote lifecycle, the payment-confirmation contract and pinned known gaps, ownership and role rules, exact money maths through the API, expiry, photos; simultaneous accept/withdraw/edit/cancel/submit races; the CHECK and UNIQUE constraints refusing inconsistent rows |
| `npm run test:integration:payments` | **Real PostgreSQL**, full HTTP stack (Redis, SMS, storage and the payment gateway are doubles) | Concurrent attempts and idempotency, signed webhooks (invalid signature, 20 simultaneous duplicates, out-of-order, unknown references, late payment for a cancelled booking, wrong amount/currency), atomic rollback and retry, refund limits under concurrency, the append-only ledger and database constraints, the report-only sweep |
| `npm run test:integration:realtime` | **Real PostgreSQL** and **real Socket.IO clients** over a local port; the Redis-specific suite uses the real Memurai (DB 15, only keys of its own unique prefix are touched) and two API instances | Handshake auth (missing/garbage/expired/forged/revoked/suspended), token refresh and expiry, room authorization (strangers, other customers/workers, admins, suspended workers, identity fields in payloads), live position rules (assigned worker only, statuses, stale/future/implausible/too-frequent/out-of-order/inaccurate readings, expiry, Redis loss and outage, end of sharing, disconnect), chat (authorization, validation, idempotent and concurrent sends, gap-free ordering, stable pagination, receipts, reconnect recovery, race with cancellation, database triggers), outbox (rollback announces nothing, after-commit delivery, minimal payload, retries/backoff/dead, no duplicates with competing dispatchers), BullMQ on Memurai (schedules, two workers, notification jobs, recovery after Redis loses its keys, start while Redis is down), Socket.IO Redis adapter across two instances |
| `npm run test:integration:files` | **Real PostgreSQL**, full HTTP stack, **real bytes** through the local storage provider's signed URLs (temp folder) | Upload workflow for booking photos and worker documents (registration, signed-URL abuse, size/type/signature checks, scanning, rejection and cleanup), photo and document isolation between customers, workers and admins, the retried idempotent removal queue (outage, backoff, parking, concurrent runs, still-referenced files); notifications (recipient mapping, nothing before commit, no duplicates under redelivery and racing dispatchers, retry, ownership, pagination, read state, Arabic/English), push delivery with a test double (sent vs delivered, backoff, invalid tokens, disabled mode, races), device-token ownership/move/revoke/limits; offers (lifecycle and history, edit rules, scheduling, derived expiry, audience and city/service targeting, localization fallback, and proof that bookings, quotes, payments and the ledger are untouched) |
| `npm run test:integration:admin` | **Real PostgreSQL**, full HTTP stack and real sockets (Redis and SMS are doubles) | Administrator boundaries on every new route, no public way to change own role/status, account suspension taking effect at once (sessions, REST, live sockets, sign-in), admin booking cancellation through the lifecycle with no financial side effects, audit coverage and redaction, financial immutability (no way to mark a payment paid; ledger and money snapshots refuse edits); disputes (eligibility, participant isolation, the full state machine, evidence rules enforced in service and database, concurrent opens and decisions, no financial effect, internal notes hidden, audit without note text); reviews (eligibility, self-review, one per booking under 10 simultaneous submits, immutability and append-only history by trigger, hide/restore/withdraw keeping the cached rating exactly equal to the reviews table, concurrent moderation); reports (inclusive/exclusive range boundaries, Riyadh midnight buckets, per-currency money, pending attempt vs captured vs unapplied vs requested refund semantics, simulated exclusion, no personal data, reading changes nothing) |
| `npm run test:integration:workers` | **Real PostgreSQL**, full HTTP stack (Redis, SMS and the OTP gateway are doubles) | Authorization of every admin/worker/discovery endpoint, catalog management, the whole worker approval workflow, privacy of documents and public profiles, concurrent decisions, audit and history |

The integration suites are separate on purpose: they need your local services and credentials. They never migrate, reset or drop anything, they refuse to run against any database other than `home_services_test` (PostgreSQL) or a non-empty logical DB 15 (Redis), and they delete only rows they created.

To run the PostgreSQL suites, put `TEST_DATABASE_URL` (database `home_services_test`) in `.env`, migrate that database with the safe wrapper, then run them:

```powershell
npm run db:migrate:test:status   # read-only; the first lines name the exact target database
npm run db:migrate:test          # applies pending migrations to the TEST database only
npm run test:integration
```

`db:migrate:test` is needed once, and again after each new migration. If it was forgotten, the suites stop immediately with that instruction instead of failing with "table does not exist". They also remove the audit-log rows they created (by time window, test database only).

## ESM note

NestJS 12 is ESM-only, so this project is an ES module (`"type": "module"`, `nodenext`). Relative imports must include the `.js` extension (`import { X } from './x.js'`), even though the files are `.ts`. Tests run through Jest's ESM mode (`node --experimental-vm-modules`), which the npm scripts already do for you.

## Adding a feature module

1. Create `src/modules/<name>/` with `<name>.module.ts`, controller, service and DTOs.
2. Version the controller: `@Controller({ path: '<name>', version: '1' })`.
3. Import the module in `src/app.module.ts`.
4. Describe request/response DTOs with `class-validator` and `@nestjs/swagger` decorators.
