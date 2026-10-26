import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { REFRESH_COOKIE, isSameOrigin } from "@/lib/server/bff-rules";
import { apiBase, clearSessionCookies, forwardHeaders, jsonError } from "@/lib/server/backend";

/** Ends the session on the server and clears the cookies. Always succeeds locally, even if the backend cannot be reached. */
export async function POST(req: NextRequest) {
  if (!isSameOrigin(req.headers.get("origin"), req.headers.get("host"))) return jsonError(403, "BAD_ORIGIN", "Request refused");
  const refreshToken = (await cookies()).get(REFRESH_COOKIE)?.value;
  if (refreshToken) {
    try {
      await fetch(`${apiBase()}/auth/logout`, {
        method: "POST",
        headers: { "content-type": "application/json", ...forwardHeaders(req) },
        body: JSON.stringify({ refreshToken }),
        cache: "no-store",
        signal: AbortSignal.timeout(5000),
      });
    } catch {
      // The backend answers 204 for anything; if it is unreachable the session simply expires. The browser is signed out regardless.
    }
  }
  const res = new NextResponse(null, { status: 204 });
  clearSessionCookies(res);
  return res;
}
