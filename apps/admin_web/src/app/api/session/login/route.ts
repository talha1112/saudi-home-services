import { NextResponse, type NextRequest } from "next/server";
import { isSameOrigin, passthroughHeaders } from "@/lib/server/bff-rules";
import { apiBase, forwardHeaders, jsonError, setSessionCookies, tokensFromSession } from "@/lib/server/backend";

/** Signs an administrator in. The tokens go into httpOnly cookies; the browser only gets the user's name and whether a password change is due. */
export async function POST(req: NextRequest) {
  if (!isSameOrigin(req.headers.get("origin"), req.headers.get("host"))) return jsonError(403, "BAD_ORIGIN", "Request refused");
  let input: { email?: unknown; password?: unknown; mfaCode?: unknown };
  try {
    input = await req.json();
  } catch {
    return jsonError(400, "BAD_REQUEST", "Invalid request");
  }
  if (typeof input.email !== "string" || typeof input.password !== "string") return jsonError(400, "BAD_REQUEST", "Email and password are required");

  let upstream: Response;
  try {
    upstream = await fetch(`${apiBase()}/auth/admin/login`, {
      method: "POST",
      headers: { "content-type": "application/json", ...forwardHeaders(req) },
      body: JSON.stringify({
        email: input.email,
        password: input.password,
        ...(typeof input.mfaCode === "string" && input.mfaCode ? { mfaCode: input.mfaCode } : {}),
      }),
      cache: "no-store",
    });
  } catch {
    return jsonError(502, "BACKEND_UNAVAILABLE", "The service is temporarily unavailable");
  }
  if (!upstream.ok) {
    // Pass the backend's own answer through (it is deliberately generic for wrong credentials, and carries Retry-After for lockouts).
    return new NextResponse(await upstream.text(), { status: upstream.status, headers: passthroughHeaders(upstream.headers) });
  }
  const session = (await upstream.json()) as {
    user: { id: string; fullName: string | null; email: string | null; activeRole: string; mustChangePassword?: boolean };
  };
  if (session.user.activeRole !== "ADMIN") return jsonError(403, "NOT_ADMIN", "This account is not an administrator");
  const res = NextResponse.json({
    user: { id: session.user.id, fullName: session.user.fullName, email: session.user.email },
    mustChangePassword: session.user.mustChangePassword === true,
  });
  setSessionCookies(res, tokensFromSession(session as unknown as Record<string, unknown>));
  return res;
}
