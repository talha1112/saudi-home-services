import "server-only";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import {
  ACCESS_COOKIE, REFRESH_COOKIE, SingleFlight, cookieLifetimes, passthroughHeaders, type Tokens,
} from "./bff-rules";

/** The backend API root including the version, read on the server only (never exposed to the browser). */
export function apiBase(): string {
  return process.env.BACKEND_API_URL ?? "http://127.0.0.1:3001/api/v1";
}

const secure = process.env.NODE_ENV === "production";
const COOKIE_BASE = { httpOnly: true, sameSite: "strict" as const, secure, path: "/" };

const refreshes = new SingleFlight<Tokens | "dead" | "unreachable">(15_000);

function tokensFromSession(body: Record<string, unknown>): Tokens {
  return {
    accessToken: String(body.accessToken),
    refreshToken: String(body.refreshToken),
    accessExpiresIn: Number(body.accessTokenExpiresInSeconds ?? 900),
    refreshExpiresAt: new Date(String(body.refreshTokenExpiresAt)),
  };
}

export { tokensFromSession };

/** Exchanges a refresh token. "dead" = the backend refused it (sign in again); "unreachable" = try again later, keep the session. */
export function refreshTokens(refreshToken: string, forwardHeaders: Record<string, string>): Promise<Tokens | "dead" | "unreachable"> {
  return refreshes.run(refreshToken, async () => {
    try {
      const res = await fetch(`${apiBase()}/auth/refresh`, {
        method: "POST",
        headers: { "content-type": "application/json", ...forwardHeaders },
        body: JSON.stringify({ refreshToken }),
        cache: "no-store",
      });
      if (res.status === 401 || res.status === 403) return "dead";
      if (!res.ok) return "unreachable";
      return tokensFromSession((await res.json()) as Record<string, unknown>);
    } catch {
      return "unreachable";
    }
  });
}

export function setSessionCookies(res: NextResponse, t: Tokens): void {
  const { accessMaxAge, refreshMaxAge } = cookieLifetimes(t);
  res.cookies.set(ACCESS_COOKIE, t.accessToken, { ...COOKIE_BASE, maxAge: accessMaxAge });
  res.cookies.set(REFRESH_COOKIE, t.refreshToken, { ...COOKIE_BASE, maxAge: refreshMaxAge });
}

export function clearSessionCookies(res: NextResponse): void {
  res.cookies.set(ACCESS_COOKIE, "", { ...COOKIE_BASE, maxAge: 0 });
  res.cookies.set(REFRESH_COOKIE, "", { ...COOKIE_BASE, maxAge: 0 });
}

/** Client details the backend needs for rate limits and the audit trail (it only sees this server otherwise). */
export function forwardHeaders(req: Request): Record<string, string> {
  const out: Record<string, string> = {};
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) out["x-forwarded-for"] = fwd;
  const ua = req.headers.get("user-agent");
  if (ua) out["user-agent"] = ua;
  return out;
}

export const jsonError = (status: number, code: string, message: string) => NextResponse.json({ statusCode: status, code, message }, { status });

/**
 * Calls the backend as the signed-in admin. Reads the session cookies, refreshes first when the access cookie is gone, retries once on a 401,
 * and tells the caller which cookies to set. Returns a ready NextResponse that mirrors the backend's answer (status, JSON body, retry-after).
 */
export async function callAsAdmin(req: Request, url: string, init: { method: string; body?: string; headers?: Record<string, string> }): Promise<NextResponse> {
  const jar = await cookies();
  const refresh = jar.get(REFRESH_COOKIE)?.value;
  let access = jar.get(ACCESS_COOKIE)?.value;
  if (!refresh) return jsonError(401, "NO_SESSION", "Please sign in");

  const fwd = forwardHeaders(req);
  let rotated: Tokens | null = null;
  const rotate = async (): Promise<NextResponse | null> => {
    const r = await refreshTokens(refresh, fwd);
    if (r === "dead") {
      const dead = jsonError(401, "SESSION_ENDED", "Your session has ended. Please sign in again");
      clearSessionCookies(dead);
      return dead;
    }
    if (r === "unreachable") return jsonError(502, "BACKEND_UNAVAILABLE", "The service is temporarily unavailable");
    rotated = r;
    access = r.accessToken;
    return null;
  };

  if (!access) {
    const failed = await rotate();
    if (failed) return failed;
  }

  const send = async (token: string): Promise<Response | null> => {
    try {
      return await fetch(url, {
        method: init.method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/json",
          ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
          ...fwd,
          ...init.headers,
        },
        body: init.body,
        cache: "no-store",
        redirect: "manual",
      });
    } catch {
      return null;
    }
  };

  let upstream = await send(access!);
  if (upstream && upstream.status === 401 && !rotated) {
    const failed = await rotate();
    if (failed) return failed;
    upstream = await send(access!);
  }
  if (!upstream) return jsonError(502, "BACKEND_UNAVAILABLE", "The service is temporarily unavailable");

  const text = upstream.status === 204 ? null : await upstream.text();
  const res = new NextResponse(text, { status: upstream.status, headers: passthroughHeaders(upstream.headers) });
  if (rotated) setSessionCookies(res, rotated);
  return res;
}
