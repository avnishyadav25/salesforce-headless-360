import { NextResponse, type NextRequest } from "next/server";

/**
 * Defense in depth for state-changing POSTs: the session cookies are SameSite=Lax,
 * and a browser-sent Origin header must also match this host.
 */
export function isSameOrigin(request: NextRequest): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  // Browsers send "Origin: null" for form posts from a page with a strict referrer policy.
  // Fall back to Fetch Metadata, which the browser sets and pages can't forge.
  if (origin === "null") return request.headers.get("sec-fetch-site") === "same-origin";
  try {
    const host = request.headers.get("host") ?? request.nextUrl.host;
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

export function jsonError(status: number, message: string, code: string): NextResponse {
  return NextResponse.json({ error: code, message }, { status, headers: { "cache-control": "no-store" } });
}

export function redirectTo(request: NextRequest, path: string, status: 302 | 303 = 302): NextResponse {
  const response = NextResponse.redirect(new URL(path, request.url), status);
  response.headers.set("cache-control", "no-store");
  return response;
}
