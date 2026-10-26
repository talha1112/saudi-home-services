import type { NextRequest } from "next/server";
import { MUTATING, backendUrl, isAllowedAdminPath, isSameOrigin } from "@/lib/server/bff-rules";
import { apiBase, callAsAdmin, jsonError } from "@/lib/server/backend";

type Ctx = { params: Promise<{ path: string[] }> };

/**
 * The browser's only way to reach the backend's `/admin/*` API. It attaches the session's bearer token, refreshes it when needed, and passes
 * the backend's status and JSON through unchanged. Authorization is the backend's: every admin route there requires the ADMIN role.
 */
async function handle(req: NextRequest, ctx: Ctx) {
  const { path } = await ctx.params;
  if (!isAllowedAdminPath(path)) return jsonError(404, "NOT_FOUND", "Not found");
  if (MUTATING.has(req.method) && !isSameOrigin(req.headers.get("origin"), req.headers.get("host"))) {
    return jsonError(403, "BAD_ORIGIN", "Request refused");
  }
  const body = MUTATING.has(req.method) ? await req.text() : undefined;
  const url = backendUrl(apiBase(), path, req.nextUrl.search);
  // A refund request is idempotent only with the caller's key, so that one header is passed on.
  const key = req.headers.get("idempotency-key");
  return callAsAdmin(req, url, { method: req.method, body: body === "" ? undefined : body, headers: key ? { "idempotency-key": key } : undefined });
}

export { handle as GET, handle as POST, handle as PATCH, handle as PUT, handle as DELETE };
