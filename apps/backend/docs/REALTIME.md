# Realtime, live position, booking chat and background jobs (Phase 7)

This is the backend foundation only. No mobile or web screen was changed. Everything below is covered by
tests that run against real PostgreSQL and a real Redis-compatible server (Memurai locally); see
[Verification](#verification).

- [1. What lives where](#1-what-lives-where)
- [2. Socket connection and authentication](#2-socket-connection-and-authentication)
- [3. Event contract (version 1)](#3-event-contract-version-1)
- [4. Booking rooms and authorization](#4-booking-rooms-and-authorization)
- [5. Live worker position](#5-live-worker-position)
- [6. Booking chat](#6-booking-chat)
- [7. Booking events and the transactional outbox](#7-booking-events-and-the-transactional-outbox)
- [8. Background jobs](#8-background-jobs)
- [9. Redis conventions, loss and restart](#9-redis-conventions-loss-and-restart)
- [10. Configuration](#10-configuration)
- [11. Memurai versus production Redis](#11-memurai-versus-production-redis)
- [12. Verification](#12-verification)
- [13. Decisions that need the business, and known limits](#13-decisions-that-need-the-business-and-known-limits)

## 1. What lives where

| Data | Store | Why |
|---|---|---|
| Booking status, assignment, payments, ledger | PostgreSQL | Source of truth. Redis is **never** consulted for any of it. |
| Chat messages, chat delivery/read cursors | PostgreSQL (`chat_messages`, `chat_participant_states`) | Durable history. |
| Booking events to announce (outbox) | PostgreSQL (`realtime_outbox_events`) | Written in the same transaction as the change. |
| Latest worker position | Redis only, one key per booking, short expiry | Ephemeral by design. **Never written to PostgreSQL**; no history is kept. |
| Rate-limit counters, Socket.IO adapter traffic, job queues and schedules | Redis | Ephemeral; rebuilt from PostgreSQL if lost. |

## 2. Socket connection and authentication

- URL: `<api origin>/realtime` (Socket.IO namespace `/realtime`, default path `/socket.io`). Transport: WebSocket (polling also works).
- The client sends the **access token** in the handshake auth payload: `io(url + '/realtime', { auth: { token } })`.
  An `Authorization: Bearer ...` header is also accepted for non-browser clients. A token in the URL/query string is **ignored**.
- The token is verified exactly like an HTTP request (`AccessAuthenticator`, shared with the REST guard): signature, expiry,
  session still active, account `ACTIVE`, role still held, no pending forced password change. Failure => the connection is refused
  with a `connect_error` whose `data.code` is one of `AUTH_REQUIRED`, `TOKEN_INVALID`, `TOKEN_EXPIRED`, `SESSION_REVOKED`,
  `ACCOUNT_NOT_ACTIVE`, `INSUFFICIENT_ROLE`, `PASSWORD_CHANGE_REQUIRED`, `RATE_LIMITED`, `REALTIME_DISABLED`.
- Identity comes **only** from the token. No payload field is read as a user id, worker id, role, ownership or booking status
  (payloads with unknown fields are rejected with `VALIDATION_FAILED`).
- **Token lifetime.** A socket outlives its access token only for `REALTIME_TOKEN_GRACE_SECONDS`. Events sent after expiry answer
  `TOKEN_EXPIRED`; the app obtains a new access token by its normal refresh and sends `auth.refresh {token}`. The new token must belong
  to the same user, session and role (`TOKEN_MISMATCH` otherwise). If nobody refreshes, the server sends `session.ending.v1`
  (`reason: TOKEN_EXPIRED`) and closes the socket.
- **Revocation.** Every event except position updates re-reads the session/account from PostgreSQL. A sweep every
  `REALTIME_REVALIDATE_SECONDS` re-checks the session and *every booking room the socket sits in*. A revoked/suspended session gets
  `session.ending.v1` and is closed; a user who stopped participating in a booking (for example a worker who was suspended) is removed from
  its rooms and receives `booking.access-revoked.v1`.
- **Limits.** Connection attempts per IP (60/min; `X-Forwarded-For` honoured only when `TRUST_PROXY_HOPS > 0`), `REALTIME_MAX_SOCKETS_PER_USER`
  open sockets per account (the oldest is closed, reason `TOO_MANY_CONNECTIONS`), message size `REALTIME_MAX_MESSAGE_BYTES`, 60 events per
  10 seconds per socket (a persistent offender is closed, reason `RATE_LIMITED`), 20 rooms per socket.
- **Logs** contain event names, user ids and error classes. Never tokens, message text or coordinates.
- CORS follows `CORS_ORIGINS`. A browser WebSocket upgrade is not subject to CORS, which is acceptable because the credential is a bearer token in
  the handshake payload, not a cookie, so a hostile web page has nothing to ride on.

### Acknowledgements

Every client-to-server event takes an acknowledgement callback and is answered with
`{ ok: true, data }` or `{ ok: false, error: { code, message, details?, retryAfterSeconds? } }`.
Error codes are the same stable codes the REST API uses (`NOT_FOUND`, `VALIDATION_FAILED`, `RATE_LIMITED`, ...). A booking you do not take part in
is always `NOT_FOUND`, indistinguishable from one that does not exist.

## 3. Event contract (version 1)

The version is part of the event name. A breaking change ships as a **new** name (`...v2`) next to the old one.

### Client to server

| Event | Payload | Result (`data`) |
|---|---|---|
| `auth.refresh` | `{ token }` | `{ expiresAt }` |
| `booking.join` | `{ bookingId }` | `{ bookingId, side: 'CUSTOMER'\|'WORKER', status, chat: { lastSeq } }` |
| `booking.leave` | `{ bookingId }` | `{ bookingId }` |
| `chat.send` | `{ bookingId, clientMessageId, body }` | `{ message, duplicate }` |
| `chat.sync` | `{ bookingId, afterSeq? \| beforeSeq?, limit? }` | `{ items, meta }` (same as REST history) |
| `chat.receipt` | `{ bookingId, kind: 'DELIVERED'\|'READ', upToSeq }` | `{ deliveredUpToSeq, readUpToSeq }` |
| `location.publish` | `{ bookingId, latitude, longitude, accuracyMeters?, headingDegrees?, speedMps?, recordedAt }` | `{ recordedAt, receivedAt }` |
| `location.subscribe` | `{ bookingId }` | `{ bookingId, latest }` (`latest` is the same object as the REST read) |
| `location.unsubscribe` | `{ bookingId }` | `{ bookingId }` |

### Server to client

| Event | Payload | Sent to |
|---|---|---|
| `booking.event.v1` | `{ v:1, eventId, bookingId, type, fromStatus, toStatus, occurredAt }` | Booking room. Quote activity (`BOOKING_CREATED`, `QUOTE_SUBMITTED/REVISED/WITHDRAWN/REJECTED/EXPIRED`) only to the customer-only room. |
| `chat.message.v1` | `{ v:1, id, bookingId, seq, senderRole, clientMessageId, body, createdAt }` | Booking room (both participants, including the sender's other screens). |
| `chat.receipt.v1` | `{ v:1, bookingId, byRole, deliveredUpToSeq, readUpToSeq }` | Booking room. |
| `location.update.v1` | `{ v:1, bookingId, latitude, longitude, accuracyMeters?, headingDegrees?, speedMps?, recordedAt, receivedAt }` | Location room (subscribed customer only). |
| `location.ended.v1` | `{ v:1, bookingId }` | Location room; the room is then emptied. |
| `booking.access-revoked.v1` | `{ v:1, bookingId, reason }` | The one socket that lost access. |
| `session.ending.v1` | `{ v:1, reason }` | The one socket about to be closed. |

`booking.event.v1` carries **no** price, address, phone, note or person. It says what changed; the app fetches details over REST.
Delivery is **at-least-once**: de-duplicate on `eventId`. Order is per booking by `occurredAt`; after a retry an older event can arrive after a newer one,
so treat `toStatus` of the event with the latest `occurredAt` as current, and re-fetch over REST after any reconnect. REST is always authoritative.

## 4. Booking rooms and authorization

Rooms (no client can name a room; the server joins sockets after checking):

| Room | Members | Used for |
|---|---|---|
| `booking:{id}` | the booking's customer and its assigned worker | status events, chat, receipts |
| `booking:{id}:customer` | the customer only | quote activity |
| `booking:{id}:location` | the customer, after `location.subscribe` | live position |

Participation is decided from PostgreSQL on **every** join and every sensitive event:

- **Customer**: acting role `CUSTOMER` and `bookings.customer_id = caller`.
- **Worker**: acting role `WORKER`, `bookings.worker_profile_id` belongs to the caller (the worker the accepted quote assigned), and the worker is still
  `APPROVED` (a suspended worker gets `WORKER_NOT_APPROVED` and is removed from rooms by the next sweep or booking event).
- **Everyone else, including administrators**: `NOT_FOUND`. Administrators keep the REST booking views; they do **not** join booking rooms,
  read chat or see positions. Opening any of that to support staff needs an explicit product decision and an audit trail (see section 13).

## 5. Live worker position

### When sharing is allowed

Sharing is decided in `location-policy.ts` / `realtime.constants.ts`, from the real booking row, never from the client:

| Booking status | Position sharing |
|---|---|
| `OPEN`, `PAYMENT_PENDING` | no (nothing agreed or paid; the worker does not yet have the address) |
| `CONFIRMED` | yes, from `LOCATION_SHARING_LEAD_MINUTES` (default 180) before `preferred_start_at`, and any time after it |
| `IN_PROGRESS` | yes |
| `COMPLETED`, `CANCELLED`, `EXPIRED` | no; sharing stops at once |

**Ambiguity reported, not invented.** The booking state machine has no "worker is on the way" status. The statuses above follow from the existing
rules (address released from `CONFIRMED`; work starts from `CONFIRMED`). Because `CONFIRMED` can last days, the lead window above is an
**added privacy limit** chosen by engineering; it is configurable (`0` disables it). Confirm both the statuses and the window with the business (section 13).

### Publishing (worker)

`location.publish`. Only the assigned, approved worker of an eligible booking. Server-side checks, in order: booking participation and side,
sharing eligibility, per-booking rate limit (`LOCATION_RATE_LIMIT_PER_MINUTE`), payload validation (latitude/longitude ranges, finite numbers, ISO time), then:

| Rule | Rejection code |
|---|---|
| (0, 0) or malformed | `LOCATION_INVALID` / `VALIDATION_FAILED` |
| `accuracyMeters` > `LOCATION_MAX_ACCURACY_METERS` | `LOCATION_ACCURACY_TOO_LOW` |
| `recordedAt` older than `LOCATION_MAX_AGE_SECONDS` | `LOCATION_STALE` |
| `recordedAt` more than `LOCATION_MAX_CLOCK_SKEW_SECONDS` in the future | `LOCATION_FROM_FUTURE` |
| Closer than `LOCATION_MIN_INTERVAL_MS` to the previous accepted update | `LOCATION_TOO_FREQUENT` (429) |
| `recordedAt` not newer than the previous one (replay/out of order) | `LOCATION_OUT_OF_ORDER` |
| Implied speed above `LOCATION_MAX_SPEED_MPS` (the two accuracy radii are forgiven) | `LOCATION_IMPLAUSIBLE` |
| Sharing not active | `LOCATION_SHARING_NOT_ACTIVE` (409, `details.reason`: `STATUS_NOT_ELIGIBLE` / `TOO_EARLY`) |

Accepted positions are rounded to 6 decimals (about 11 cm), stored under `loc:v1:{bookingId}` with an expiry of `LOCATION_TTL_SECONDS`
(**replaced** on every update; there is no trail), and pushed to the booking's location room.

### Reading (customer)

- REST `GET /api/v1/bookings/{id}/location` (customer only) or `location.subscribe` for live updates.
- Answers `{ available: true, location, ageSeconds }`, or `{ available: false, reason: 'SHARING_NOT_ACTIVE' | 'NO_RECENT_POSITION' }`.
  `location.subscribe` refuses with `LOCATION_SHARING_NOT_ACTIVE` instead of answering "unavailable".
- Nothing is invented: an expired, missing, flushed or corrupt Redis value is "no recent position". If Redis cannot be reached the answer is
  `503`, never an empty or stale guess.
- Only the owning customer. Not the worker, another customer, another worker or an administrator.

### Lifecycle

- A **disconnect does not end sharing** and deletes nothing; the position simply expires.
- When a booking reaches `COMPLETED`/`CANCELLED`/`EXPIRED`, the outbox delivery ends sharing: key deleted, `location.ended.v1` sent, room emptied on every instance.
  Even before that delivery (up to one poll interval), publishing and reading are already refused because they re-read the booking.
- A repeatable job (`location-cleanup`, every 5 minutes) scans `loc:v1:*` and deletes positions whose booking no longer authorises sharing: the safety net
  for a key written just before a booking ended.
- Positions never reach logs, the outbox, the notification jobs, or PostgreSQL.

## 6. Booking chat

REST (the reliable path) and the socket events above share one service.

| Endpoint | Purpose |
|---|---|
| `GET  /api/v1/bookings/{id}/messages?afterSeq=&beforeSeq=&limit=` | History |
| `POST /api/v1/bookings/{id}/messages` `{ clientMessageId, body }` | Send. 201 when stored, **200 with the original** when `clientMessageId` was already accepted |
| `POST /api/v1/bookings/{id}/messages/receipts` `{ kind, upToSeq }` | Delivered / read |

Roles: `CUSTOMER` and `WORKER` only (administrators get 403). Authorization is the participation rule of section 4; strangers get 404.

- **Who may send, when.** Only a participant, only while the booking is `CONFIRMED` or `IN_PROGRESS` (`409 CHAT_CLOSED` otherwise). History stays readable
  to both participants after completion or cancellation. Nothing is deleted on disconnect or when the booking ends. (Ambiguity: section 13.)
- **Sender identity** is the token's user and acting role; `senderRole` or ids in a body are rejected. A database trigger independently refuses a row whose sender is not the
  booking's customer or assigned worker, and another forbids updates (history is append-only).
- **Content.** Plain text, 1-2000 characters (`CHAT_MAX_BODY_CHARS`; counted in characters, so Arabic and emoji are not penalised), trimmed, no control characters except
  newline/tab. No attachments or files: use the existing private-storage design in a later integration. Text is stored and returned as-is; nothing is interpreted or rendered by the server.
- **Idempotency.** `clientMessageId` (8-64 chars `A-Za-z0-9_-`, generated by the app once per message and reused on every retry) is unique per (booking, sender).
  A retry returns the original message (also after the booking closed and under 20 simultaneous retries); the same id with a different text is `409 CLIENT_MESSAGE_ID_REUSED`.
- **Ordering.** `seq` is a gap-free per-booking number assigned while holding the booking row lock (the same lock every booking writer takes), so sends serialise with each other and with
  cancellations. History pages by `seq`: default = latest page oldest-first; `beforeSeq` = older page; `afterSeq` = newer messages. `meta` carries `hasMore`, `nextBeforeSeq`, `lastSeq`, `canSend` and both participants' receipts.
- **Accepted, delivered, read.** `SENT` = the server stored it (the send acknowledgement). `DELIVERED` / `READ` appear only after the *recipient's app* sends a receipt
  (`chat.receipt` / REST) for a `seq` up to the latest; a receipt can never exceed the latest message and can never move backwards; reading implies delivery.
  A connected socket alone proves nothing, so it is never counted as delivered. Own messages in history carry `status`.
- **Rate limit.** `CHAT_RATE_LIMIT_PER_MINUTE` sends per account (shared Redis counter; if Redis is down, an in-process counter takes over so chat keeps working and stays limited).

### Reconnect and missed messages

1. After (re)connecting, `booking.join` and read `data.chat.lastSeq`.
2. If it is greater than the app's last known `seq`, call `chat.sync { afterSeq }` (or REST history with `afterSeq`) repeatedly while `meta.hasMore`.
3. Merge by `id`/`seq`; live `chat.message.v1` events may arrive at any time and are idempotent to merge.
4. Resend unsent messages with their original `clientMessageId`.

The realtime push is a hint. A missed or dropped push loses nothing, because the history is always recoverable by `seq`.

## 7. Booking events and the transactional outbox

`recordEvent()` (the single place that appends to `booking_events`, called inside every lifecycle transaction) also inserts a `realtime_outbox_events` row **in the same
transaction**. A rolled-back change therefore announces nothing, and a committed change cannot lose its announcement even if the process dies right after commit.

The dispatcher (`OutboxDispatcherService`, run by the `realtime-outbox` job every `OUTBOX_POLL_INTERVAL_MS`):

1. in one transaction, selects due rows `FOR UPDATE SKIP LOCKED` (two dispatchers or instances never take the same row at once);
2. emits `booking.event.v1`, ends position sharing when the new status is final, re-checks room membership, enqueues notification jobs;
3. marks the row delivered in the same transaction.

Guarantees and limits:

- **At-least-once.** If the process dies between the emit and the commit, the row is delivered again; receivers de-duplicate on `eventId`.
- **Failure.** `attempts` increases, `next_attempt_at` backs off exponentially (1 s, 2 s, 4 s ... capped at 10 min, 20% jitter), after `OUTBOX_MAX_ATTEMPTS` the row is marked **dead** (reported, never retried forever).
  Only an error class is stored in `last_error`.
- **No duplicate durable effects.** The delivery's only durable effects are the row's own columns and notification jobs whose id is `notif_{eventId}_{userId}` (the queue ignores duplicates).
- **Reporting.** The `report` job (every 5 minutes) logs a warning with counts when events are stale (older than `OUTBOX_STALE_AFTER_MINUTES` and undelivered) or dead.
- **Retention.** The `purge` job deletes delivered or dead rows older than `OUTBOX_RETENTION_DAYS`. Pending rows are never deleted.
- Dispatch needs a running Socket.IO server in the same process (jobs and sockets share the API process in this phase; see section 13).

## 8. Background jobs

BullMQ, in the API process, started when `JOBS_ENABLED=true` (off under `NODE_ENV=test` unless a suite opts in). Queue names and jobs:

| Queue | Job | Schedule | Purpose | Retry |
|---|---|---|---|---|
| `realtime-outbox` | `dispatch` | every `OUTBOX_POLL_INTERVAL_MS` | deliver pending events | none at job level; per-row retry/backoff/dead in PostgreSQL |
| `realtime-outbox` | `report` | 5 min | stale/dead report | none |
| `realtime-outbox` | `purge` | 1 h | retention | none |
| `maintenance` | `location-cleanup` | 5 min | delete positions of ineligible bookings | none |
| `notifications` | `booking-event` | on demand | notification groundwork (no provider; the only sender records that it skipped) | 5 attempts, exponential backoff from 2 s, then kept in a bounded failed set |

- **Idempotent and repeatable.** Schedules are BullMQ job schedulers with fixed ids: restarts and any number of instances never multiply them. Every job body is safe to run twice.
- **Bounded retention.** Completed: last 20 (notifications: 1 h / 1000). Failed: last 100 (notifications: 7 days / 1000). No unbounded growth, no infinite retry.
- **Logging.** Job failures log the job name, attempt and error class; never job data.
- **Ephemeral state.** Queue contents and schedules may vanish with Redis; nothing business-critical lives there.
- **Visibility and recovery.** `GET /api/v1/health/ready` includes `jobs: running | degraded | starting` (informational; it does not turn readiness red). If Redis is unreachable at start the API still serves
  requests, logs `Background jobs are not running`, and reports `degraded`. A timer (every 30 s) retries the start, and once running re-asserts the schedulers, so a Redis restart without persistence heals by itself.
- **No payment expiration.** The payment-deadline sweep of Phase 6 remains report-only; nothing here changes payments. No real push notification or provider exists.

## 9. Redis conventions, loss and restart

| Key / channel | Content | Expiry |
|---|---|---|
| `loc:v1:{bookingId}` | latest position JSON | `LOCATION_TTL_SECONDS` (default 120 s) |
| `rl:loc:v1:{bookingId}` | publish counter | 60 s |
| `rl:chat:v1:{userId}`, `rl:chatrcpt:v1:{userId}` | chat counters | 60 s |
| `rl:ws-connect:v1:{ip}` | handshake counter | 60 s |
| `{QUEUE_PREFIX}:bull:*` | BullMQ queues and schedules | managed by BullMQ (bounded retention) |
| `{QUEUE_PREFIX}:sio*` | Socket.IO adapter pub/sub channels | none (pub/sub) |

Rules: keys are versioned (`v1`) so a new format can coexist during a rollout; keys and the Redis URL are never exposed by any endpoint; Redis is never the source of truth.
Use a **separate Redis (or database + `QUEUE_PREFIX`) per environment**; the `loc:v1:` and `rl:` keys carry no environment prefix.

After a Redis **flush or restart without persistence**: positions vanish (customers see "no recent position" until the next update); rate-limit counters reset;
queue schedules are re-created within 30 s; pending outbox events are still in PostgreSQL and are delivered afterwards; sockets keep working on their instance but cross-instance delivery
pauses until the adapter reconnects (automatic). Chat history and booking state are untouched.

While Redis is **down**: REST/socket chat keeps working (in-process limiter); position publish/read answer `503`; outbox delivery waits; sockets of one instance keep receiving that instance's emits.
Events emitted during an outage on a multi-instance deployment may not reach sockets on *other* instances; clients recover on reconnect through REST (`chat.sync`, booking detail).

## 10. Configuration

All variables, their defaults and their meaning are in [`.env.example`](../.env.example) (section "Realtime, live position, chat, background jobs") and validated at startup
(`src/config/env.validation.ts`). The ones most relevant to operations:

`REALTIME_ENABLED`, `REALTIME_REDIS_ADAPTER`, `JOBS_ENABLED`, `QUEUE_PREFIX`, `LOCATION_TTL_SECONDS`, `LOCATION_SHARING_LEAD_MINUTES`, `OUTBOX_MAX_ATTEMPTS`, `OUTBOX_RETENTION_DAYS`,
`REDIS_URL` (also used by the adapter and BullMQ), `TRUST_PROXY_HOPS`, `CORS_ORIGINS`.

## 11. Memurai versus production Redis

Verified here: Memurai 8.1 (Redis 8.2.5 compatible) at `127.0.0.1:6379`.

| Feature | On Memurai (verified by tests) | Notes for production Redis |
|---|---|---|
| `@socket.io/redis-adapter` (pub/sub, `fetchSockets`, `socketsLeave`) | Works across two API instances | Same. For Redis Cluster use the sharded adapter, not the classic one. |
| BullMQ 6 (Lua scripts, streams, job schedulers, blocking commands) | Works, including competing workers on one queue | Needs Redis >= 5 (>= 6.2 recommended); `maxmemory-policy` must be `noeviction` (Memurai default here). |
| `GETDEL`, `SCAN`, `SET EX/NX`, `INCR` + `EXPIRE` in `MULTI` | Works | Same. |
| Persistence | Not relied upon | Nothing business-critical is stored; persistence only avoids the 30 s schedule re-creation and keeps queued notification jobs. |
| Redis Cluster / Sentinel | Not tested (single local server) | BullMQ needs hash-tagged prefixes under Cluster (e.g. `{hs}`); test the failover behaviour (adapter reconnect, job recovery) in staging. |
| TLS, ACL users, password | Not exercised locally (no password) | Use `rediss://` and a dedicated ACL user with the commands above. |
| Managed Redis (ElastiCache, Redis Cloud...) | Not tested | Confirm Lua scripting and pub/sub are enabled and that `CONFIG` commands are not required (BullMQ warns if the eviction policy is wrong but does not need `CONFIG SET`). |

Differences that matter: Memurai is a Windows build of the Redis protocol; behaviour matched the tests, but production must be verified against the actual managed service and version
before launch. This phase makes no claim of production readiness for the infrastructure.

## 12. Verification

Commands (from `apps/backend`):

```powershell
npm run typecheck
npx prisma validate
npm test                                   # unit
npm run test:e2e                           # in-memory HTTP wiring
npm run test:integration:realtime          # real PostgreSQL (TEST_DATABASE_URL) + real Memurai (logical DB 15, unique key prefix)
npm run test:integration                   # everything real, including Phases 3-6
```

Local manual check (test database and an isolated Redis database, nothing in `saudi_home_services`):

```powershell
npm run build
$env:DATABASE_URL = $env:TEST_DATABASE_URL     # a *_test database
$env:REDIS_URL = "redis://127.0.0.1:6379/15"; $env:QUEUE_PREFIX = "hsmanual"; $env:PORT = "3999"
node dist/main.js
# GET http://127.0.0.1:3999/api/v1/health/ready  ->  {"status":"ok", "jobs":"running", ...}
# a Socket.IO client to http://127.0.0.1:3999/realtime without a token  ->  connect_error, data.code = AUTH_REQUIRED
```

What the suites prove: see the "Realtime" rows of the README test table.

## 13. Decisions that need the business, and known limits

1. **Statuses that enable position sharing and chat** (`CONFIRMED`, `IN_PROGRESS`) and the **3-hour lead window** for `CONFIRMED` are engineering defaults derived from the existing state machine, not an approved rule.
   Should the customer be able to chat before paying? Should chat stay open for a grace period after completion (for example for a late complaint)? Should sharing require an explicit "I am on my way" action by the worker (needs a new state or flag)?
2. **Administrator access** to chat and positions is denied. Support tooling for disputes needs an explicit rule plus audit logging of every admin read.
3. **Chat retention and privacy.** Messages are kept indefinitely. A retention period, export/erase handling (PDPL) and moderation/reporting flows are not defined.
4. **Attachments** are not supported; when added they must use the private document-storage architecture with the same participation rule.
5. **Jobs and sockets share the API process.** Delivery needs the Socket.IO server in the process that runs the dispatcher. A dedicated worker process would need `@socket.io/redis-emitter`. At least one API instance must have `JOBS_ENABLED=true`.
6. **Multi-instance behaviour is verified with two instances on one machine**, not on a real load-balanced deployment (sticky sessions are not required for WebSocket-only clients; clients using HTTP long-polling need them).
7. **Dead outbox rows** are reported in the log every 5 minutes; there is no alerting integration or operator endpoint to replay them.
8. **Notification delivery** is groundwork only (no provider, no templates, no per-user preferences, no localisation).
9. **Connection-attempt limit** (60/min per IP) is fixed in code; many users behind one NAT can hit it.
10. **Realtime events are a hint, REST is the truth.** Clients must refetch state after reconnecting.
