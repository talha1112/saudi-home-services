import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { ACCESS_COOKIE, REFRESH_COOKIE, isSameOrigin, passthroughHeaders } from "@/lib/server/bff-rules";
import { apiBase, forwardHeaders, jsonError, refreshTokens, setSessionCookies, tokensFromSession } from "@/lib/server/backend";

/**
 * Changes the administrator's password. The backend signs the account out everywhere and answers with a NEW session, whose cookies replace
 * the old ones here. It works while a password change is still pending, which is the only thing allowed in that state besides /me and logout.
 */
export async function POST(req: NextRequest) {
  if (!isSameOrigin(req.headers.get("origin"), req.headers.get("host"))) return jsonError(403, "BAD_ORIGIN", "Request refused");
  let input: { currentPassword?: unknown; newPassword?: unknown };
  try {
    input = await req.json();
  } catch {
    return jsonError(400, "BAD_REQUEST", "Invalid request");
  }
  if (typeof input.currentPassword !== "string" || typeof input.newPassword !== "string") {
    return jsonError(400, "BAD_REQUEST", "Both passwords are required");
  }

  const jar = await cookies();
  const refresh = jar.get(REFRESH_COOKIE)?.value;
  let access = jar.get(ACCESS_COOKIE)?.value;
  if (!refresh) return jsonError(401, "NO_SESSION", "Please sign in");
  if (!access) {
    const r = await refreshTokens(refresh, forwardHeaders(req));
    if (typeof r === "string") {
      return jsonError(r === "dead" ? 401 : 502, r === "dead" ? "SESSION_ENDED" : "BACKEND_UNAVAILABLE", "Please sign in again");
    }
    access = r.accessToken;
  }
  let upstream: Response;
  try {
    upstream = await fetch(`${apiBase()}/auth/admin/change-password`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${access}`, ...forwardHeaders(req) },
      body: JSON.stringify({ currentPassword: input.currentPassword, newPassword: input.newPassword }),
      cache: "no-store",
    });
  } catch {
    return jsonError(502, "BACKEND_UNAVAILABLE", "The service is temporarily unavailable");
  }
  if (!upstream.ok) return new NextResponse(await upstream.text(), { status: upstream.status, headers: passthroughHeaders(upstream.headers) });
  const res = NextResponse.json({ ok: true });
  setSessionCookies(res, tokensFromSession((await upstream.json()) as Record<string, unknown>));
  return res;
}
