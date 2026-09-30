/**
 * Guards shared by the signed-in POST routes (/api/chat, /api/brief): configuration,
 * the same-origin check, the session lookup, and a token refresh before the access
 * token leaves this server. Each returns what the route needs, or the error response
 * the route should return as is.
 */
import type { NextRequest, NextResponse } from "next/server";
import { ConfigError, loadConfig, type AppConfig } from "./config";
import { isSameOrigin, jsonError } from "./http";
import { ensureFreshSession, ReauthenticationRequired } from "./salesforce-oauth";
import { clearSession, readSession, writeSession, type SessionData } from "./session";

export type FreshSession = { session: SessionData; refreshed: boolean };

export function loadRouteConfig(): { config: AppConfig } | { response: NextResponse } {
  try {
    return { config: loadConfig() };
  } catch (error) {
    return { response: jsonError(500, error instanceof ConfigError ? error.message : "Configuration error.", "config") };
  }
}

export function requireSession(request: NextRequest, config: AppConfig): { session: SessionData } | { response: NextResponse } {
  if (!isSameOrigin(request)) {
    return { response: jsonError(403, "Cross-origin requests are not allowed.", "forbidden") };
  }
  const session = readSession(request.cookies, config.sessionSecret);
  if (!session) {
    return { response: jsonError(401, "Sign in with Salesforce first.", "not_signed_in") };
  }
  return { session };
}

/**
 * Refresh the access token if it is stale, because it is about to be sent to Anthropic.
 * A refresh token Salesforce no longer accepts means "sign in again": 401 and the
 * session cookie is cleared.
 */
export async function refreshSession(session: SessionData, config: AppConfig): Promise<FreshSession | { response: NextResponse }> {
  try {
    return await ensureFreshSession(session, config);
  } catch (error) {
    if (error instanceof ReauthenticationRequired) {
      const response = jsonError(401, error.message, "reauth_required");
      clearSession(response, config.secureCookies);
      return { response };
    }
    return { response: jsonError(502, "Could not reach Salesforce to refresh the session.", "salesforce_unreachable") };
  }
}

/** Re-seal the session cookie when this request refreshed the token. */
export function saveRefreshedSession(response: NextResponse, fresh: FreshSession, config: AppConfig): void {
  if (fresh.refreshed) {
    writeSession(response, fresh.session, { secret: config.sessionSecret, secure: config.secureCookies });
  }
}
