# Home Services admin web

Next.js (App Router, Cache Components) admin portal for the Home Services backend.

## How it talks to the backend

The browser never holds a token and never calls the backend directly. Every call goes through this app's own server (a backend-for-frontend):

| Route | Purpose |
|---|---|
| `POST /api/session/login` | Admin sign-in (email + password). Tokens are stored in **httpOnly, SameSite=Strict** cookies; the browser only gets the user's name and whether a password change is due. |
| `POST /api/session/change-password` | Required after the first sign-in with a bootstrap/reset password. Replaces the session. |
| `POST /api/session/logout` | Ends the session on the server and clears the cookies. |
| `GET /api/session/me` | The signed-in administrator. |
| `/api/admin/[...path]` | Relays to the backend's `/admin/*` API with the bearer token. Only known admin areas are reachable (no `..`, no `auth`, no other backend areas). Refreshes the access token when needed. |

* **Refresh tokens are single use.** Concurrent requests share one refresh, and its result is kept for 15 s for late requests that still carry the old cookie (otherwise the backend would treat the second use as theft and end the session). This is **in-process**: run a single server instance, or use sticky sessions, until the refresh is moved to a shared store.
* **CSRF:** state-changing routes require an `Origin` equal to this site (on top of SameSite=Strict cookies).
* **`src/proxy.ts`** only redirects signed-out visitors to `/login`; it is not the security boundary. The backend checks the token on every call and requires the `ADMIN` role.
* **Client IP / audit:** `x-forwarded-for` and `user-agent` are forwarded. Set the backend's `TRUST_PROXY_HOPS` so its rate limits and audit trail see real client addresses, not this server's.

## Configuration

| Variable | Default | |
|---|---|---|
| `BACKEND_API_URL` | `http://127.0.0.1:3001/api/v1` | Backend API root including the version. Server-side only (never exposed to the browser). Use HTTPS outside local development. |

Cookies are `Secure` when `NODE_ENV=production`, so serve production over HTTPS.

## Run

```bash
npm install
BACKEND_API_URL=http://127.0.0.1:3001/api/v1 npm run dev     # http://localhost:3000
npm run build && npm start                                  # production, port 3000
npm test                                                    # BFF rules (Node's test runner)
npm run lint
```

The backend needs a migrated database and an administrator: `ADMIN_EMAIL=... ADMIN_PASSWORD=... npm run admin:bootstrap` in `apps/backend` (a password change is required at first sign-in). A forgotten password is reset by an operator with `npm run admin:reset-password`.

## Pages wired to the backend

| Page | Backend |
|---|---|
| Sign-in, change password, sign-out | `/auth/admin/*`, `/auth/logout` |
| **Worker verification** | `/admin/workers` (queue, detail, start-review, approve, reject, request-info, document accept/reject, signed document links) |
| **Workers** | `/admin/workers` (status tabs, search, suspend, reinstate) |

All other pages (dashboard, customers, services, bookings, quotes, disputes, reviews, payments, commissions, subscriptions, offers, notifications, reports, settings) still show **prototype data** and are wired one slice at a time. Note that the backend has no module for **subscriptions** yet.
