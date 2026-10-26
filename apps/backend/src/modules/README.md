# Modules

The backend is a **modular monolith**: one deployable, split into feature modules with explicit boundaries.

Only `health/` exists today. Each future module is added here as its own folder with its own `*.module.ts`:

| Planned module | Owns |
|---|---|
| `auth/` | Sign-in, tokens, guards/decorators for roles |
| `users/` | Customer and admin accounts |
| `workers/` | Worker profiles, verification, subscriptions |
| `bookings/` | Requests, quotes, scheduling |
| `payments/` | Payment records, refunds, commissions |
| `tracking/` | Job status and location updates |

## Rules

1. A module exposes a small public surface through its `*.module.ts` (`exports`) and nothing else.
2. Other modules import the module, never its files. No deep imports like `../bookings/entities/...`.
3. Modules talk through injected services (or events later), not by sharing database tables.
4. Cross-cutting code (filters, interceptors, guards, decorators) lives in `src/common/`, never in a feature module.
5. Register a new module in `src/app.module.ts`.
