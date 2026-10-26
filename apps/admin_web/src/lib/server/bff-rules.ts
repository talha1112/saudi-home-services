/**
 * Pure rules for the admin web's backend-for-frontend (BFF). No framework imports, so they can be tested with plain Node.
 *
 * The browser never sees a token: the access and refresh tokens live in httpOnly cookies, and every call to the backend goes through
 * this server, which attaches the bearer token. That removes token theft by script injection and the need for CORS.
 */

export const ACCESS_COOKIE = "hs_admin_at";
export const REFRESH_COOKIE = "hs_admin_rt";

/** First path segments of the backend's `/admin/*` API that the browser may reach through the BFF. */
const ADMIN_AREAS = new Set([
  "workers", "users", "bookings", "cities", "service-categories", "services", "disputes", "offers", "payments", "refunds", "ledger",
  "pricing-settings", "reports", "reviews", "audit-logs", "support",
  "dashboard", "customers", "quotes", "search", "commissions", "notifications", "transactions", "admins", "system", "catalog-stats", "report-series",
]);
const SEGMENT = /^[A-Za-z0-9_-]{1,80}$/;

/** Only `/admin/<known area>/...` with plain path segments: the BFF is not an open proxy (no `..`, no other backend areas, no auth routes). */
export function isAllowedAdminPath(segments: readonly string[]): boolean {
  if (segments.length < 1 || segments.length > 6) return false;
  if (!segments.every((s) => SEGMENT.test(s))) return false;
  return ADMIN_AREAS.has(segments[0]!);
}

export function backendUrl(base: string, segments: readonly string[], search: string): string {
  const root = base.endsWith("/") ? base.slice(0, -1) : base;
  const path = segments.map(encodeURIComponent).join("/");
  return `${root}/admin/${path}${search.startsWith("?") && search.length > 1 ? search : ""}`;
}

export const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * CSRF defence for state-changing requests, on top of SameSite=Strict cookies: if the browser sent an Origin it must be this site.
 * A missing Origin on a mutating request is refused too (browsers always send it for cross-origin and for fetch POSTs).
 */
export function isSameOrigin(originHeader: string | null, hostHeader: string | null): boolean {
  if (!originHeader || !hostHeader) return false;
  try {
    return new URL(originHeader).host === hostHeader;
  } catch {
    return false;
  }
}

export interface Tokens {
  accessToken: string;
  refreshToken: string;
  /** Seconds until the access token expires. */
  accessExpiresIn: number;
  refreshExpiresAt: Date;
}

/** Cookie lifetimes: the access cookie vanishes a little BEFORE the token expires, so "no access cookie" means "refresh first". */
export function cookieLifetimes(t: Tokens, now: Date = new Date()): { accessMaxAge: number; refreshMaxAge: number } {
  const accessMaxAge = Math.max(1, Math.floor(t.accessExpiresIn) - 30);
  const refreshMaxAge = Math.max(1, Math.floor((t.refreshExpiresAt.getTime() - now.getTime()) / 1000));
  return { accessMaxAge, refreshMaxAge };
}

/**
 * Refresh tokens are single use. Several requests can arrive at once with the same expired session (a page fires many calls) and, in the
 * moments after a rotation, with the OLD cookie the browser had not replaced yet. Without care the second use of the old token looks like
 * theft and the backend ends the whole session. So one refresh per token is shared by every concurrent caller, and its result is kept for
 * a short while for late callers still holding the same old token.
 */
export class SingleFlight<T> {
  private readonly entries = new Map<string, { promise: Promise<T>; timer?: ReturnType<typeof setTimeout> }>();
  private readonly keepMs: number;
  constructor(keepMs: number) {
    this.keepMs = keepMs;
  }

  run(key: string, work: () => Promise<T>): Promise<T> {
    const existing = this.entries.get(key);
    if (existing) return existing.promise;
    const entry: { promise: Promise<T>; timer?: ReturnType<typeof setTimeout> } = { promise: work() };
    this.entries.set(key, entry);
    const evict = () => {
      entry.timer = setTimeout(() => this.entries.delete(key), this.keepMs);
      entry.timer.unref?.();
    };
    // A failure is not kept: the next caller may try again (it will fail the same way if the token is dead).
    entry.promise.then(evict, () => this.entries.delete(key));
    return entry.promise;
  }

  get size(): number {
    return this.entries.size;
  }
}

/** Response headers worth passing from the backend to the browser. */
export function passthroughHeaders(from: { get(name: string): string | null }): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of ["content-type", "retry-after", "x-request-id"]) {
    const v = from.get(name);
    if (v) out[name] = v;
  }
  return out;
}
