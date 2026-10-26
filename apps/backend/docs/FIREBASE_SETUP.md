# Firebase Phone Authentication (backend) and Firebase setup

Status: **stages 1 and 2 of 4 are implemented in the backend:** phone sign-in (section 1-5) and Firebase Cloud Messaging (section 6). Not yet built: the customer app (stage 3) and the worker app (stage 4), so **nothing can sign in or receive a push from a phone yet**. Nothing here is deployed, no migration was needed or applied, and no secret is stored in the repository.

The intended Firebase project for this deployment is `saudi-home-services-b8ca5` (the project ID is not a secret). It is not configured anywhere automatically: nothing is switched on in any `.env`, and test phone numbers must exist only in a non-production Firebase project.

## 1. How sign-in works

```
App (Flutter)                         Firebase                          Backend (this repository)
   | verify the phone number  ------>  |  SMS code / test code
   | <-------- Firebase ID token ----  |
   | POST /api/v1/auth/firebase/phone  { idToken, app: "customer" | "worker" }  ------------------------->
   |                                   |  <- the Admin SDK checks signature, issuer, audience, expiry -------|
   | <----- the usual session: access token + rotating refresh token, user, isNewUser ---------------------|
```

- The request carries **only** the ID token and which app is asking. A phone number, user id or role in the body is rejected (400): the number, the Firebase user id and the time of the SMS check come from the verified token.
- After verification the backend applies its own rules and issues the **same session** as the code flow: 15-minute access token, single-use rotating refresh token with reuse detection, `/auth/refresh`, `/auth/logout`, `/auth/logout-all`. Nothing about sessions changed.
- Administrators keep email + password (`/auth/admin/login`). MFA remains out of scope. The old code endpoints (`/auth/otp/*`) are unchanged; with SMS disabled they answer 503.

### What the backend checks, in order

1. The feature is on (`FIREBASE_AUTH_ENABLED=true`), else `503 FIREBASE_AUTH_NOT_CONFIGURED`. No Firebase code runs and nothing is created.
2. The token verifies against the configured project (Admin SDK: signature, expiry; then the backend re-checks audience and issuer itself). Optional revocation check with the service account.
3. The Firebase sign-in provider is `phone` (anonymous, password, Google and custom tokens are refused).
4. The `phone_number` claim exists and is already canonical E.164 (international numbers are accepted, Saudi +966 included).
5. The SMS check was recent: `auth_time` within `FIREBASE_MAX_AUTH_AGE_SECONDS` (default 300). An ID token lives an hour; this stops a captured old token being exchanged later.
6. Account ownership rules (section 2).
7. The token is consumed exactly once (a hash is kept in Redis until the token would expire). A replay, also several at the same instant, gets `401 FIREBASE_TOKEN_REPLAYED`.
8. Account created or signed in; existing suspended / deactivated checks apply; role added if the person uses the other app (worker role = still unapproved, worker routes stay closed until an administrator approves).

### Answers the apps must handle

| Status | `code` | Meaning for the app |
|---|---|---|
| 200 | | Session issued (`isNewUser` tells whether the account was created) |
| 400 | validation | Extra fields, or the token is not shaped like a JWT |
| 401 | `FIREBASE_TOKEN_INVALID` | Not verifiable (bad, wrong project, revoked, user disabled): sign in again |
| 401 | `FIREBASE_TOKEN_EXPIRED` | Ask Firebase for a fresh ID token (or repeat the SMS step) |
| 401 | `FIREBASE_TOKEN_STALE` | The SMS check is older than 5 minutes: verify the number again |
| 401 | `FIREBASE_TOKEN_REPLAYED` | This token was already exchanged |
| 401 | `FIREBASE_PROVIDER_NOT_ALLOWED`, `FIREBASE_PHONE_MISSING`, `FIREBASE_PHONE_INVALID` | Not a phone sign-in / no usable number |
| 403 | `ACCOUNT_SUSPENDED`, `ACCOUNT_DEACTIVATED` | As for the code flow |
| 403 | `ACCOUNT_NOT_ELIGIBLE` | The number belongs to an administrator account: never reachable here |
| 409 | `ACCOUNT_LINK_REVIEW_REQUIRED`, `FIREBASE_IDENTITY_CONFLICT` | Ownership of an existing account is ambiguous: contact support (section 2) |
| 429 | | Too many attempts from this address (20 per 10 minutes) |
| 503 | `FIREBASE_AUTH_NOT_CONFIGURED`, `FIREBASE_UNAVAILABLE` | Feature off, or Firebase/its keys unreachable: try again later |

## 2. Account linking: safe demo behaviour and production requirements

**The risk.** A verified phone number proves who holds the number *now*, not that the holder is the person the account belongs to (numbers are recycled; people lose phones). The existing code flow already treats the phone as the identity. With Firebase there is a stronger signal available (the Firebase user id), and this deployment must not silently give a *new* Firebase identity an *existing* account.

**What is built (no database column, no migration).** The Firebase user id of an account is recorded as an audit entry `auth.firebase_identity_bound` (`{ firebaseUid, reason }`) written **in the same transaction** that creates or adopts the account. The audit table is append-only at the database level (migration `20261030090000`, applied to the test database only). Rules:

| Situation | Result |
|---|---|
| Number unknown | New account (customer or worker), identity recorded |
| Account exists and its recorded identity is the **same** | Signs in |
| Account exists, **no** recorded identity (created by another route, e.g. the code flow or imported) | `409 ACCOUNT_LINK_REVIEW_REQUIRED`, account untouched |
| Account exists, recorded identity is **different** | `409 FIREBASE_IDENTITY_CONFLICT`, account untouched, `auth.firebase_link_refused` audited |
| Account's number was never verified | `409`, never claimed through Firebase |
| Account has the ADMIN role | `403 ACCOUNT_NOT_ELIGIBLE`, always |
| Account suspended / deactivated | `403`, as for the code flow |

If the audit trail were incomplete, existing accounts become "no recorded identity" and are refused: the design **fails closed**.

**Start-up guard.** The binding is only as trustworthy as the append-only audit table. With `FIREBASE_AUTH_ENABLED=true` the application runs a read-only catalog query at start-up and **refuses to start** unless both triggers `audit_logs_append_only` (blocks UPDATE and DELETE, per row) and `audit_logs_no_truncate` (blocks TRUNCATE) exist on `audit_logs`, are enabled (not disabled, not "replica only"), call the expected function and fire on the expected events. The error names the missing or disabled trigger and the migration to apply (`20261030090000_audit_log_integrity`), and never contains connection details; if the check itself cannot run, startup also fails. Limits: it runs once at start-up (a trigger disabled later is not noticed), it is skipped when Firebase sign-in is off and under `NODE_ENV=test`, and a table owner or superuser can always disable the triggers.

**Demo switch.** `FIREBASE_ALLOW_PHONE_ACCOUNT_ADOPTION=true` (default `false`) lets an existing account be adopted by phone match, and lets a *changed* Firebase identity in, recording `adopted` / `changed` and `auth.firebase_identity_changed`. It never bypasses the administrator, unverified-number and suspension rules. Use it only with a demo Firebase project and synthetic data (for example when seed accounts exist, or after deleting and re-creating a test user in the Firebase console). In production mode the API refuses to start with adoption on unless `FIREBASE_ADOPTION_CONFIRM_PROJECT` equals `FIREBASE_PROJECT_ID`, and it logs a warning when it is on.

**Production requirements (not built; needs your decision).**
1. Store the Firebase user id in the database (unique, written in the account-creation transaction) instead of deriving it from the audit trail.
2. A support-assisted, audited recovery flow for lost or recycled numbers (identity check, cooling-off period, notice to the previous device), because `409` has no self-service way out by design.
3. A retention rule that keeps binding entries for as long as the account exists.
4. An abuse plan: Firebase App Check, SMS-region policy limiting countries, SMS quotas and budget alerts, monitoring of `auth.firebase_link_refused`.
5. Never enable the adoption switch against real users.

## 3. Configuration (names only; phone sign-in and push are independent)

| Variable | Default | Meaning |
|---|---|---|
| `FIREBASE_AUTH_ENABLED` | `false` | Turns the endpoint on. When `false`, **no other Firebase value is read or validated** |
| `FIREBASE_PROJECT_ID` | none | Required when phone sign-in is enabled **or** `PUSH_PROVIDER=fcm`. The token audience; not a secret |
| `FIREBASE_SERVICE_ACCOUNT_BASE64` | none | **Secret**, backend only: base64 of the service-account JSON. Needed for FCM and for the revocation check; not needed to verify tokens |
| `FIREBASE_CHECK_REVOKED` | on in production, off elsewhere | Ask Firebase whether the token was revoked / user disabled. Needs the service account. Blank counts as "unset", never as "off" |
| `FIREBASE_MAX_AUTH_AGE_SECONDS` | `300` | How recent the SMS check must be (30-3600) |
| `FIREBASE_ALLOW_PHONE_ACCOUNT_ADOPTION` | `false` | Demo only (section 2). In production mode it is refused at start-up unless `FIREBASE_ADOPTION_CONFIRM_PROJECT` is set to exactly `FIREBASE_PROJECT_ID`, so a stray `true` cannot enable it |
| `FIREBASE_ADOPTION_CONFIRM_PROJECT` | none | The deliberate second step for adoption in production mode (a demo Firebase project running as staging). Ignored otherwise |

Start-up refuses: enabled without a valid project id; a service account that is not a key file or belongs to another project than `FIREBASE_PROJECT_ID`; the revocation check without the service account; `FIREBASE_AUTH_EMULATOR_HOST` set in production (with it the SDK accepts **unsigned** tokens). Error messages never contain any part of the key.

## 4. Firebase project setup (you do this; nothing is configured by the repository)

1. Use a **separate Firebase project** for development / staging. Production gets its own project **without** test phone numbers, so a test number can never sign in to a real deployment.
2. Authentication -> Sign-in method -> enable **Phone**. Review billing requirements and SMS pricing in the console.
3. Authentication -> Phone numbers for testing: add fictional numbers with fixed codes (up to the console's limit). Use only these for the demo. Codes live in the console, never in this code.
4. Settings -> SMS region policy: allow only the countries you intend to serve.
5. For stage 3/4 (apps): register the Android apps (package names, debug and release SHA-1 and SHA-256), the iOS apps (bundle IDs; an APNs auth key for push), download the config files, and consider App Check (Play Integrity / App Attest).
6. Backend: set `FIREBASE_AUTH_ENABLED=true` and `FIREBASE_PROJECT_ID`. For the revocation check create a dedicated service account with the least privilege that works (to be confirmed in the console), and store its JSON **base64-encoded as a secret on the server only**. Never put it in a Flutter app, in git, in a log or in a ticket.

**Data residency.** Firebase stores phone numbers used for sign-in on Google infrastructure outside Saudi Arabia. Treat it like the Sydney storage bucket: use synthetic data and fictional test numbers until a PDPL review approves it for real users.

## 5. Testing

| What | Where it runs |
|---|---|
| Valid / invalid / expired / revoked / replayed / stale tokens, non-phone providers, missing or non-canonical phone claims, wrong project, account-linking conflicts, administrator and suspended accounts, worker approval, session rotation, rate limit, feature off, secrets in audit trail | `test/firebase-auth.integration-spec.ts` (real PostgreSQL, Firebase boundary replaced by `FakeFirebaseIdentityVerifier`) |
| Claim handling, audience / issuer re-check, SDK error mapping, no token in logs, lazy SDK start | `src/modules/auth/firebase/firebase-admin-verifier.spec.ts` (SDK replaced by a function) |
| Configuration rules | `src/config/env.validation.spec.ts` |
| Start-up guard (healthy, missing, disabled, replica-only, wrong function or events, query failure, off / test skip) | `src/modules/auth/firebase/audit-integrity-check.spec.ts`, plus the real check against the migrated test database in `test/firebase-auth.integration-spec.ts` |
| **Not testable without Firebase:** the SDK's own signature verification against Google's keys, the revocation call, real SMS | a Firebase project (test phone numbers), or the Firebase Auth Emulator (needs `firebase-tools` and Java; the SDK only runs in plain Node, not inside Jest) |
| **Needs a physical device:** SMS auto-retrieval, reCAPTCHA / APNs fallback on iOS, App Check attestation | stages 3-4 |

## 6. Firebase Cloud Messaging (push notifications), backend

Push goes through the existing pipeline (notification -> delivery row -> `NotificationDeliveryService` -> `PushProvider`); FCM is one more `PushProvider` (`src/modules/notifications/push/fcm-push-provider.ts`). Devices register with the existing authenticated routes (`POST /devices` registers **or refreshes** a token, `GET /devices`, `DELETE /devices/{id}` on sign-out). The owner is always the authenticated caller; a user id in the request is rejected; tokens are stored AES-256-GCM encrypted and never returned or logged.

### Switching it on (explicit opt-in; nothing is on by default)

| Variable | Needed when | Meaning |
|---|---|---|
| `PUSH_PROVIDER=fcm` | to use FCM | Default (unset / `disabled`): every delivery is recorded `UNSUPPORTED` and nothing is attempted |
| `FIREBASE_PROJECT_ID` | `fcm` | e.g. `saudi-home-services-b8ca5` |
| `FIREBASE_SERVICE_ACCOUNT_BASE64` | `fcm` | **Secret**, backend only. Must belong to `FIREBASE_PROJECT_ID` (checked at start-up) |
| `DEVICE_TOKEN_ENCRYPTION_KEY` | `fcm` | Base64 of 32 random bytes; without it device registration answers 503 |
| `FCM_DRY_RUN=true` | optional | Firebase **validates** every message and answers, but delivers **nothing**: the safe way to prove credentials and payloads end to end before any real send |
| `NOTIFICATION_MAX_ATTEMPTS`, `MAX_DEVICE_TOKENS_PER_USER` | optional | Existing retry cap (default 6) and devices per account (default 10) |

Only what an enabled feature needs is validated. FCM does **not** need `FIREBASE_AUTH_ENABLED`, and phone sign-in does not need FCM; when both are on they share the project ID and the service account.

### How failures are handled

| FCM answer | Pipeline result |
|---|---|
| token unregistered / invalid (and "invalid argument" that names the registration token) | `INVALID_TOKEN`: that one device is revoked, delivery `FAILED` |
| server unavailable, internal error, message / device / quota rate limits, network errors, anything unknown | `TRANSIENT`: retried with growing back-off up to `NOTIFICATION_MAX_ATTEMPTS`, then `FAILED` (`ATTEMPTS_EXHAUSTED`); the device is **not** revoked |
| authentication / credential errors, missing APNs key, sender or permission mismatch, bad payload, a device registered with another vendor | `PERMANENT`: not retried, `FAILED`, the device is **not** revoked (a misconfiguration must never wipe every user's registration) |

A message carries the title and body rendered in the recipient's language plus a small data map (`notificationId`, `type`, `resourceType`, `resourceId`): no phone numbers, amounts or addresses. Messages are `SENT` when FCM accepts them, never "delivered". A crash between the send and the commit can send a message twice, so apps collapse duplicates by `notificationId`. Logs contain only the Firebase error **code**: never tokens, titles, bodies, data, the service account or Firebase's error text.

### Firebase console steps for push (you do this)

1. Project `saudi-home-services-b8ca5` -> Project settings -> Cloud Messaging: confirm the **Firebase Cloud Messaging API (V1)** is enabled (the legacy server key is not used).
2. Create a dedicated service account for the backend with the least privilege that can send messages (for example the "Firebase Cloud Messaging API Admin" role; confirm the exact role in the console) and download its JSON key. Store it **base64-encoded as a server secret only**; delete the downloaded file afterwards.
3. Android apps (stage 3-4): register the package names with SHA-1 / SHA-256, download `google-services.json`, create the notification channel in the app.
4. iOS apps (stage 3-4): upload an APNs authentication key (.p8, Key ID, Team ID) under Cloud Messaging; push cannot reach iOS without it (the backend then logs `messaging/third-party-auth-error` and fails those deliveries permanently).
5. First check with `FCM_DRY_RUN=true`; only then switch it off.

### Testing

| What | Where |
|---|---|
| Error classification, message shape, vendor refusal, redaction, lazy SDK start, provider selection | `src/modules/notifications/push/fcm-push-provider.spec.ts` |
| Configuration rules and independence from phone sign-in | `src/config/env.validation.spec.ts` |
| Real pipeline on PostgreSQL with a fake Firebase client: send, revoke, retry, give up, permanent failures, ownership, refresh, revocation, logs, independence | `test/fcm-push.integration-spec.ts` |
| **Not testable without Firebase:** real delivery, credentials, APNs, quotas | a Firebase project with `FCM_DRY_RUN=true` first, then a physical device (stage 3-4) |
