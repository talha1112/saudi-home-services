# Production hardening: configuration safeguards, audit integrity, safe logging, admin sign-in

Backend only. Nothing here adds a feature or changes an API contract.

## 1. Administrator authentication (decision: email and password only, MFA deferred)

Administrators sign in with **email and password only** (`POST /api/v1/auth/admin/login`). No MFA, OTP, authenticator app, recovery code or extra step exists, and none was added. The placeholder `AdminMfaPolicy` (`NoMfaPolicy`) always answers "not required"; the optional `mfaCode` field is ignored and never rescues a wrong password (covered by a test).

Controls in place and covered by `test/audit-and-admin-auth.integration-spec.ts` and `test/auth.e2e-spec.ts`:

| Control | Behaviour |
|---|---|
| Password hashing | Argon2 via `PasswordService`; a dummy verification runs for unknown or non-admin addresses, so timing does not reveal whether an account exists |
| Generic errors | Wrong password, unknown email and a non-administrator all return the same `401 INVALID_CREDENTIALS` body |
| Brute-force limits (15 minute window) | 5 failures per (email, client IP); 20 failures per email across all IPs; 30 failures per client IP. The right password is refused while locked (`429 LOGIN_LOCKED`, `Retry-After`) |
| Sessions | Refresh tokens are single use and rotate; replaying an old token revokes the whole session family; password change signs out everywhere; suspension revokes sessions |
| Audit | `admin.login`, `admin.login_failed`, `admin.password_changed` are recorded with IP and user agent, never a password or token (central redaction plus a test) |
| Authorization | Every `/admin/*` route requires the `ADMIN` role, re-checked against the database on each request |

### Refresh token in the response body: security implications (no change made)

The admin session response contains `refreshToken` in the JSON body, and the admin web app must store it. Consequences:

- Any script running in the admin origin (an XSS bug, a compromised third-party script) can read it from wherever the app stores it (JavaScript-visible storage). An `HttpOnly` cookie would hide it from scripts, but then needs CSRF protection, a cookie/CORS policy and a contract change.
- It lives for the refresh lifetime (`ADMIN_REFRESH_TOKEN_TTL_HOURS`, default 12 hours for administrators), much longer than the 15 minute access token, so theft gives lasting access until it is rotated or revoked. Rotation and reuse detection limit this: if the thief and the real user both use it, the family is revoked.
- Mitigations available without changing the contract: keep the admin web app free of third-party scripts, strict Content-Security-Policy, the already short admin refresh lifetime, keep the token in memory rather than `localStorage` when the product can tolerate re-login on reload, and monitor `admin.login` audit entries (new IP/user agent).
- **Needs a product/engineering decision** before real use: move to an `HttpOnly; Secure; SameSite` cookie (breaking change for the admin web) or accept the body design with the mitigations above.

### Remaining risks of operating without MFA

- A phished or reused password gives full administrator power (suspend accounts, resolve disputes, moderate reviews, read every report and the full contact data in account overviews). There is one all-powerful role and no second approver.
- Rate limits slow guessing but cannot stop a correct password. Credential-stuffing from many IPs against one account is capped at 20 attempts per 15 minutes per account, which also lets an attacker **lock an administrator out** (a denial of service on that account) by sending failures.
- No alerting on suspicious administrator sign-ins exists yet (audit rows are recorded, nobody is notified).
- Mitigations until MFA exists: long unique administrator passwords (the policy enforces a minimum length and a letters-plus-numbers/symbols mix), few administrators, network restriction of the admin web (VPN/IP allow list at the proxy), review of `admin.login*` audit entries, and prompt suspension of departed staff. MFA stays a deferred future enhancement.

## 2. Production configuration safeguards (`src/config/env.validation.ts`)

With `NODE_ENV=production` the API now refuses to start when:

- `TRUST_PROXY_HOPS` is not **set explicitly**. Rate limits and audit IPs depend on it: behind a load balancer the default `0` would make every client share the proxy's address. Set `0` only when clients connect directly.
- `DATABASE_URL` points to a host other than localhost without a password, or without `sslmode=require|verify-ca|verify-full` (`verify-full` is recommended).
- `REDIS_URL` points to a host other than localhost without a password, or without TLS (`rediss://`).

Already enforced before this phase: no `*` in `CORS_ORIGINS`, no dev/mock providers (SMS, payments, storage, scanner, push), distinct JWT and OTP secrets, no placeholder secrets, `S3_ENDPOINT` over https. Error messages never contain the connection strings.

Operators on a private network without database TLS must terminate TLS elsewhere or request an explicit, reviewed exception; there is deliberately no "disable this check" variable.

## 3. Audit-log integrity

Migration `20261030090000_audit_log_integrity` makes `audit_logs` append-only in PostgreSQL (triggers, no table change):

- `DELETE` and `TRUNCATE` are refused.
- `UPDATE` is refused, except clearing `actor_user_id` while every other column stays identical (what `ON DELETE SET NULL` does when a user is removed).
- The application only ever inserts. No retention or purge job exists; if a retention policy is approved it needs a separately authorised procedure.
- Limits: the table owner or a superuser can disable the triggers. Run the API as a role that does **not** own the tables, keep migrations on an owner role, and export entries off-site for tamper evidence. Audit writes remain best effort (a failed write is logged, not retried).
- Tests that clean up their own rows use `test/support/audit-cleanup.ts`, which lifts the trigger inside one transaction and only on a `*_test` database.
- Rollback: `DROP TRIGGER audit_logs_append_only ON audit_logs; DROP TRIGGER audit_logs_no_truncate ON audit_logs; DROP FUNCTION audit_logs_append_only();`

## 4. Sensitive-data-safe logging

`src/common/logging/safe-error.ts`:

- Database errors (Prisma, driver) are logged by class and code only (`PrismaClientKnownRequestError:P2002`): their text can quote the failing row.
- Other errors keep their message, with connection strings, bearer tokens, JWTs, signed-URL signatures, `password=`/`token=` pairs and private keys removed, and are length-limited. Stack frames are logged without the message line.
- Used by the 5xx handler (`AllExceptionsFilter`), the audit writer and the two housekeeping jobs that logged raw `err.message`. Other log sites already log only error class names.
- Request logging redacts the `Authorization` and `Cookie` headers; request bodies are not logged.
- **Not covered / still to review:** Redis driver messages (low risk: hosts and ports), `DevSmsProvider` (logs the OTP text by design, refused in production), and any logging added later. Log-shipping configuration is the operator's responsibility.

## 5. Deploying the audit migration

Not applied to `saudi_home_services`. It has been applied to `home_services_test` only. When approved, it is part of the pending migration set (see the migration inventory in the Phase 10 report): `npm run check:local`, `npm run db:migrate:status`, `npm run db:migrate:deploy` from `apps/backend`, after a backup.
