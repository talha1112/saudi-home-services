# Database

Global `DatabaseModule` providing the two data-store clients to every feature module.

| Service | Backed by | Use for |
|---|---|---|
| `PrismaService` | PostgreSQL (Prisma 7, `@prisma/adapter-pg`) | Permanent data. Source of truth. |
| `RedisService` | Redis (`ioredis`) | Temporary data: one-time codes (hashed, with TTL), rate limits, caches, later job queues. |

Rules:

- Never keep data in Redis that cannot be rebuilt or that must survive a flush.
- Never store plaintext passwords, refresh tokens or one-time codes. Store hashes only.
- Both clients connect lazily, so the API boots while the stores start; `GET /api/v1/health/ready` reports the real state.
- The generated Prisma client lives in `src/generated/prisma` (git-ignored, rebuilt by `npm install` and `npm run build`).
- Schema changes go through `prisma/schema.prisma` plus a migration, never by editing the database by hand.
