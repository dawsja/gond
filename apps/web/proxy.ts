import { getSessionCookie } from "better-auth/cookies";
import { NextResponse, type NextRequest } from "next/server";
import { apiUrl } from "@/lib/api-url";

const PUBLIC_PATH = /^\/(login|register|api|healthz)(\/|$)/;

export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;

  if (pathname === "/api" || pathname.startsWith("/api/")) {
    return NextResponse.rewrite(new URL(`${pathname}${search}`, apiUrl()));
  }
  if (PUBLIC_PATH.test(pathname) || getSessionCookie(request)) return NextResponse.next();
  const login = request.nextUrl.clone();
  login.pathname = "/login";
  login.search = "";
  login.searchParams.set("next", `${pathname}${search}`);
  return NextResponse.redirect(login);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon\\.ico|icon\\.png|logo\\.png|robots\\.txt).*)"],
};
