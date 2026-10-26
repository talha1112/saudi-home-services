import { randomUUID } from 'node:crypto';
import type { PrismaService } from '../database/prisma.service.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Row = Record<string, any>;

/**
 * Minimal in-memory stand-in for the slice of PrismaClient the auth layer uses,
 * so unit and e2e tests need no database. It mirrors the behaviour that matters
 * here: unique constraints (P2002), defaults, nested creates, relation includes.
 * Run the e2e suite against real PostgreSQL by setting E2E_DATABASE_URL.
 */
export class InMemoryPrisma {
  users: Row[] = [];
  userRoles: Row[] = [];
  customerProfiles: Row[] = [];
  workerProfiles: Row[] = [];
  refreshTokens: Row[] = [];
  deviceTokens: Row[] = [];
  auditLogs: Row[] = [];

  user = {
    findUnique: async ({ where, include }: any) => this.hydrate(this.find(this.users, where), include),
    create: async ({ data, include }: any) => {
      this.assertUnique(this.users, data, ['phone', 'email']);
      const user = this.insert(this.users, {
        phone: null,
        email: null,
        passwordHash: null,
        fullName: null,
        locale: 'AR',
        status: 'PENDING_VERIFICATION',
        mustChangePassword: false,
        passwordChangedAt: null,
        lastLoginAt: null,
        phoneVerifiedAt: null,
        emailVerifiedAt: null,
        ...this.scalars(data),
      });
      this.applyNested(user, data);
      return this.hydrate(user, include);
    },
    update: async ({ where, data, include }: any) => {
      const user = this.find(this.users, where);
      if (!user) throw new Error('Record to update not found');
      Object.assign(user, this.scalars(data), { updatedAt: new Date() });
      this.applyNested(user, data);
      return this.hydrate(user, include);
    },
  };

  userRole = {
    count: async ({ where }: any) => this.userRoles.filter((r) => this.matches(r, where)).length,
  };

  customerProfile = {
    findUnique: async ({ where, include }: any) => this.hydrate(this.find(this.customerProfiles, where), include),
  };

  workerProfile = {
    findUnique: async ({ where, include }: any) => this.hydrate(this.find(this.workerProfiles, where), include),
  };

  refreshToken = {
    create: async ({ data }: any) => {
      await this.hook?.('refreshToken.create');
      this.assertUnique(this.refreshTokens, data, ['tokenHash']);
      return { ...this.insert(this.refreshTokens, { revokedAt: null, usedAt: null, replacedById: null, ...data }) };
    },
    findUnique: async ({ where }: any) => this.copy(this.find(this.refreshTokens, where)),
    findFirst: async ({ where }: any) => this.copy(this.refreshTokens.find((r) => this.matches(r, where))),
    findMany: async ({ where }: any = {}) => this.refreshTokens.filter((r) => this.matches(r, where)).map((r) => ({ ...r })),
    update: async ({ where, data }: any) => {
      const row = this.find(this.refreshTokens, where);
      if (!row) throw new Error('Record to update not found');
      return { ...Object.assign(row, data) };
    },
    updateMany: async ({ where, data }: any) => {
      const rows = this.refreshTokens.filter((r) => this.matches(r, where));
      rows.forEach((r) => Object.assign(r, data));
      return { count: rows.length };
    },
    deleteMany: async ({ where }: any) => {
      const doomed = this.refreshTokens.filter((r) => this.matches(r, where));
      this.refreshTokens = this.refreshTokens.filter((r) => !doomed.includes(r));
      return { count: doomed.length };
    },
  };

  deviceToken = {
    create: async ({ data }: any) => ({ ...this.insert(this.deviceTokens, { revokedAt: null, sessionId: null, lastSeenAt: new Date(), ...data }) }),
    findUnique: async ({ where }: any) => this.copy(this.find(this.deviceTokens, where)),
    upsert: async ({ where, create, update }: any) => {
      await this.hook?.('deviceToken.upsert');
      const row = this.find(this.deviceTokens, where);
      if (row) return { ...Object.assign(row, update) };
      return { ...this.insert(this.deviceTokens, { revokedAt: null, sessionId: null, lastSeenAt: new Date(), ...create }) };
    },
    findMany: async ({ where, orderBy, take }: any = {}) => {
      let rows = this.deviceTokens.filter((r) => this.matches(r, where));
      if (orderBy?.id === 'asc') rows = [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      return (take ? rows.slice(0, take) : rows).map((r) => ({ ...r }));
    },
    updateMany: async ({ where, data }: any) => {
      const rows = this.deviceTokens.filter((r) => this.matches(r, where));
      rows.forEach((r) => Object.assign(r, data));
      return { count: rows.length };
    },
  };

  /**
   * Test hook, called with an event name at the points where a concurrent request could interleave: `lock:<key>` just before a transaction
   * asks for an advisory lock, `refreshToken.create` and `deviceToken.upsert` just before those writes. A test sets it (and clears it itself
   * for a one-shot) to run another operation at exactly that moment, which makes a race ordering deterministic.
   */
  hook?: (event: string) => Promise<void> | void;
  private lockTails = new Map<string, Promise<void>>();

  /**
   * Array form: runs every operation (Prisma applies them atomically; here they are simply all applied).
   * Callback form: runs with a client whose `$executeRaw` stands for `pg_advisory_xact_lock(...)`: a per-key mutex held until the callback
   * ends (re-entrant inside one transaction, like the real thing). Row-level writes are not otherwise isolated or rolled back.
   */
  $transaction = async (arg: any) => {
    if (Array.isArray(arg)) return Promise.all(arg);
    const held = new Map<string, () => void>();
    const tx: any = Object.create(this);
    tx.$executeRaw = async (_strings: TemplateStringsArray, ...values: unknown[]) => {
      const key = String(values[0]);
      if (held.has(key)) return 1;
      await this.hook?.(`lock:${key}`);
      const previous = this.lockTails.get(key) ?? Promise.resolve();
      let release!: () => void;
      const mine = new Promise<void>((resolve) => (release = resolve));
      this.lockTails.set(
        key,
        previous.then(() => mine),
      );
      await previous;
      held.set(key, release);
      return 1;
    };
    try {
      return await arg(tx);
    } finally {
      held.forEach((release) => release());
    }
  };

  auditLog = {
    create: async ({ data }: any) => ({ ...this.insert(this.auditLogs, data) }),
  };

  asPrisma(): PrismaService {
    return this as unknown as PrismaService;
  }

  // --- helpers -----------------------------------------------------------

  private insert(table: Row[], data: Row): Row {
    const row = { id: randomUUID(), createdAt: new Date(), updatedAt: new Date(), ...data };
    table.push(row);
    return row;
  }

  private scalars(data: Row): Row {
    return Object.fromEntries(
      Object.entries(data).filter(([, v]) => v === null || v instanceof Date || typeof v !== 'object'),
    );
  }

  private applyNested(user: Row, data: Row): void {
    for (const r of data.roles?.create ?? []) {
      this.userRoles.push({ userId: user.id, grantedAt: new Date(), grantedById: null, ...r });
    }
    if (data.customerProfile?.create) {
      this.insert(this.customerProfiles, { userId: user.id, marketingOptIn: false, ...data.customerProfile.create });
    }
    if (data.workerProfile?.create) {
      this.insert(this.workerProfiles, {
        userId: user.id,
        bio: null,
        yearsOfExperience: null,
        verificationStatus: 'NOT_SUBMITTED',
        verificationNote: null,
        isOnline: false,
        acceptsUrgentJobs: true,
        ...data.workerProfile.create,
      });
    }
  }

  private assertUnique(table: Row[], data: Row, fields: string[]): void {
    for (const f of fields) {
      if (data[f] != null && table.some((r) => r[f] === data[f])) {
        throw Object.assign(new Error(`Unique constraint failed on ${f}`), { code: 'P2002' });
      }
    }
  }

  private find(table: Row[], where: Row): Row | undefined {
    return table.find((r) => this.matches(r, where));
  }

  private copy(row: Row | undefined): Row | null {
    return row ? { ...row } : null;
  }

  private matches(row: Row, where: Row = {}): boolean {
    return Object.entries(where).every(([key, cond]) => {
      const value = row[key];
      if (cond === null) return value == null;
      if (cond instanceof Date) return value instanceof Date && value.getTime() === cond.getTime();
      if (typeof cond === 'object') {
        if ('gt' in cond) return value > cond.gt;
        if ('lt' in cond) return value != null && value < cond.lt;
        if ('in' in cond) return (cond.in as unknown[]).includes(value);
        // SQL semantics: NOT (column = x) is never true for a NULL column.
        if ('not' in cond) return cond.not === null ? value != null : value != null && value !== cond.not;
        throw new Error(`InMemoryPrisma: unsupported condition on ${key}`);
      }
      return value === cond;
    });
  }

  private hydrate(row: Row | undefined, include?: Row): Row | null {
    if (!row) return null;
    const out: Row = { ...row };
    if (include?.roles) out.roles = this.userRoles.filter((r) => r.userId === row.id).map((r) => ({ ...r }));
    if (include?.workerProfile) {
      out.workerProfile = this.copy(this.workerProfiles.find((p) => p.userId === row.id));
    }
    if (include?.customerProfile) {
      out.customerProfile = this.copy(this.customerProfiles.find((p) => p.userId === row.id));
    }
    if (include?.user) out.user = { ...this.users.find((u) => u.id === row.userId) };
    return out;
  }
}
