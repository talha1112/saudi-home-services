import type { NextRequest } from "next/server";
import { apiBase, callAsAdmin } from "@/lib/server/backend";

/** The signed-in administrator, or 401. Used by the shell to show who is signed in. */
export async function GET(req: NextRequest) {
  return callAsAdmin(req, `${apiBase()}/auth/me`, { method: "GET" });
}
