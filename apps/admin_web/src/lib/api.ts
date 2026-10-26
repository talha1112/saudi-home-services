"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/** An error answer from the backend (relayed by the BFF), or a failure to reach it (`status` 0). Never contains tokens. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
    readonly fieldMessages: string[] = [],
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
  }
}

async function parse(res: Response): Promise<unknown> {
  if (res.status === 204) return null;
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function toError(res: Response, body: unknown): ApiError {
  const b = (body ?? {}) as { code?: string; message?: string | string[]; details?: Record<string, unknown>; retryAfterSeconds?: number };
  const messages = Array.isArray(b.message) ? b.message.filter((m): m is string => typeof m === "string") : [];
  const message = typeof b.message === "string" ? b.message : messages[0] ?? "Something went wrong";
  const retry = b.retryAfterSeconds ?? (Number(res.headers.get("retry-after")) || undefined);
  return new ApiError(res.status, b.code ?? `HTTP_${res.status}`, message, b.details, messages, retry);
}

/* A full page load is intentional here: it drops all client state and picks up the cleared cookies. */
function leaveForSignIn(error: ApiError): void {
  if (typeof window === "undefined") return;
  /* eslint-disable @next/next/no-location-assign-relative-destination */
  if (error.code === "PASSWORD_CHANGE_REQUIRED") window.location.assign("/change-password");
  else if (error.status === 401) {
    // Clear whatever session cookies are left first, otherwise the sign-in page would bounce a visitor with a dead cookie straight back.
    void fetch("/api/session/logout", { method: "POST", credentials: "same-origin" }).finally(() => window.location.assign("/login"));
  }
  /* eslint-enable @next/next/no-location-assign-relative-destination */
}

async function request<T>(url: string, init: { method: string; body?: unknown; headers?: Record<string, string> }, redirectOnAuth: boolean): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: init.method,
      credentials: "same-origin",
      headers: { ...(init.body !== undefined ? { "content-type": "application/json", accept: "application/json" } : { accept: "application/json" }), ...init.headers },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
  } catch {
    throw new ApiError(0, "NETWORK", "No connection. Check your internet and try again.");
  }
  const body = await parse(res);
  if (!res.ok) {
    const error = toError(res, body);
    if (redirectOnAuth) leaveForSignIn(error);
    throw error;
  }
  return body as T;
}

/** Calls the backend's `/admin/<path>` through the BFF. A 401 sends the browser to the sign-in page. */
export const api = {
  get: <T>(path: string) => request<T>(`/api/admin/${path}`, { method: "GET" }, true),
  post: <T>(path: string, body: unknown = {}, headers?: Record<string, string>) => request<T>(`/api/admin/${path}`, { method: "POST", body, headers }, true),
  patch: <T>(path: string, body: unknown = {}) => request<T>(`/api/admin/${path}`, { method: "PATCH", body }, true),
  put: <T>(path: string, body: unknown = {}) => request<T>(`/api/admin/${path}`, { method: "PUT", body }, true),
  delete: <T>(path: string) => request<T>(`/api/admin/${path}`, { method: "DELETE" }, true),
};

export interface SessionUser {
  id: string;
  fullName: string | null;
  email: string | null;
}

/** Sign-in, sign-out and password change. These never redirect on 401 themselves: the caller shows the message. */
export const sessionApi = {
  login: (email: string, password: string, mfaCode?: string) =>
    request<{ user: SessionUser; mustChangePassword: boolean }>("/api/session/login", { method: "POST", body: { email, password, mfaCode } }, false),
  logout: () => request<null>("/api/session/logout", { method: "POST", body: {} }, false),
  me: () => request<SessionUser & { activeRole: string; mustChangePassword?: boolean }>("/api/session/me", { method: "GET" }, true),
  changePassword: (currentPassword: string, newPassword: string) =>
    request<{ ok: true }>("/api/session/change-password", { method: "POST", body: { currentPassword, newPassword } }, false),
};

/** Plain-language text for an error, safe to show to an administrator. */
export function describeError(e: unknown): string {
  if (!(e instanceof ApiError)) return "Something went wrong. Please try again.";
  if (e.status === 0) return e.message;
  if (e.status === 429) return e.retryAfterSeconds ? `Too many attempts. Try again in ${Math.ceil(e.retryAfterSeconds / 60)} min.` : "Too many attempts. Try again later.";
  if (e.status === 502 || e.status === 503) return "The service is temporarily unavailable. Please try again shortly.";
  if (e.status === 400 && e.fieldMessages.length > 1) return e.fieldMessages.join("; ");
  return e.message;
}

export interface Query<T> {
  data: T | null;
  error: ApiError | null;
  loading: boolean;
  reload: () => void;
}

/** Loads `path` (relative to `/admin/`) and reloads when it changes. `null` skips loading. The previous data stays visible while reloading. */
export function useQuery<T>(path: string | null, refresh = 0): Query<T> {
  const [state, setState] = useState<{ data: T | null; error: ApiError | null; loading: boolean }>({ data: null, error: null, loading: path !== null });
  const [tick, setTick] = useState(0);
  const latest = useRef(0);

  useEffect(() => {
    if (path === null) return;
    const id = ++latest.current;
    let cancelled = false;
    api
      .get<T>(path)
      .then((data) => {
        if (!cancelled && id === latest.current) setState({ data, error: null, loading: false });
      })
      .catch((e: unknown) => {
        if (!cancelled && id === latest.current) setState((s) => ({ data: s.data, error: e instanceof ApiError ? e : new ApiError(0, "UNKNOWN", "Something went wrong"), loading: false }));
      });
    return () => {
      cancelled = true;
    };
  }, [path, tick, refresh]);

  const reload = useCallback(() => {
    setState((s) => ({ ...s, loading: true }));
    setTick((t) => t + 1);
  }, []);
  return { ...state, loading: path === null ? false : state.loading, reload };
}

/**
 * The `meta.total` of several list requests at once (for the counts on tabs). `null` entries are skipped. The previous numbers stay
 * until the new ones arrive; a request that fails shows no number.
 */
export function useTotals(paths: (string | null)[], refresh = 0): (number | null)[] {
  const key = JSON.stringify(paths);
  const [state, setState] = useState<{ key: string; totals: (number | null)[] }>({ key: "", totals: paths.map(() => null) });
  useEffect(() => {
    let live = true;
    const list = JSON.parse(key) as (string | null)[];
    Promise.all(
      list.map((p) =>
        p === null
          ? Promise.resolve(null)
          : api
              .get<{ meta: { total: number } }>(p)
              .then((r) => r.meta.total)
              .catch(() => null),
      ),
    ).then((totals) => {
      if (live) setState({ key, totals });
    });
    return () => {
      live = false;
    };
  }, [key, refresh]);
  return state.totals.length === paths.length ? state.totals : paths.map(() => null);
}

/** Builds "a=1&b=2" from the entries that have a value. */
export function qs(params: Record<string, string | number | undefined | null>): string {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") u.set(k, String(v));
  return u.toString();
}
