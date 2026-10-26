import { NextResponse, type NextRequest } from "next/server";

const REFRESH_COOKIE = "hs_admin_rt";

/**
 * Keeps signed-out visitors out of the admin pages. This only checks that a session cookie EXISTS, to avoid showing a page that would
 * immediately fail; it is not the security boundary. The backend verifies the token on every API call, and an expired or revoked session
 * is sent back to /login by the client the first time a call returns 401.
 */
export function proxy(request: NextRequest) {
  const signedIn = request.cookies.has(REFRESH_COOKIE);
  const { pathname } = request.nextUrl;
  const onAuthPage = pathname === "/login";
  if (!signedIn && !onAuthPage && pathname !== "/change-password") return NextResponse.redirect(new URL("/login", request.url));
  if (signedIn && onAuthPage) return NextResponse.redirect(new URL("/dashboard", request.url));
  return NextResponse.next();
}

export const config = {
  // Pages only: not the API routes (they answer 401 themselves), Next internals or static files.
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico|.*\\..*).*)"],
};
