import type { NextRequest } from "next/server";
import { loadConfig } from "@/lib/config";
import { isSameOrigin, jsonError, redirectTo } from "@/lib/http";
import { revokeToken } from "@/lib/salesforce-oauth";
import { clearSession, readSession } from "@/lib/session";

export const dynamic = "force-dynamic";

/** POST only (a form button), so a cross-site link or image cannot sign the user out. */
export async function POST(request: NextRequest) {
  if (!isSameOrigin(request)) {
    return jsonError(403, "Cross-origin requests are not allowed.", "forbidden");
  }

  let config;
  try {
    config = loadConfig();
  } catch {
    return redirectTo(request, "/?auth_error=config", 303);
  }

  const session = readSession(request.cookies, config.sessionSecret);
  const token = session?.tokens.refreshToken ?? session?.tokens.accessToken;
  if (token) {
    try {
      await revokeToken(config, token);
    } catch (error) {
      console.warn("Token revocation failed (the session cookie is cleared anyway):", error instanceof Error ? error.message : error);
    }
  }

  const response = redirectTo(request, "/", 303);
  clearSession(response, config.secureCookies);
  return response;
}
