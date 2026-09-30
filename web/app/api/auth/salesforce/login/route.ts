import type { NextRequest } from "next/server";
import { loadConfig } from "@/lib/config";
import { redirectTo } from "@/lib/http";
import { codeChallengeS256, generateCodeVerifier, generateState } from "@/lib/pkce";
import { authorizeUrl } from "@/lib/salesforce-oauth";
import {
  cookieOptions,
  OAUTH_TX_COOKIE,
  OAUTH_TX_MAX_AGE_SECONDS,
  OAUTH_TX_PATH,
  sealOAuthTransaction,
} from "@/lib/session";

export const dynamic = "force-dynamic";

/** Starts Authorization Code + PKCE: remember verifier and state server-side (sealed cookie), then redirect. */
export async function GET(request: NextRequest) {
  let config;
  try {
    config = loadConfig();
  } catch {
    return redirectTo(request, "/?auth_error=config");
  }

  const state = generateState();
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = codeChallengeS256(codeVerifier);

  const response = redirectTo(request, authorizeUrl(config, { state, codeChallenge }));
  response.cookies.set(
    OAUTH_TX_COOKIE,
    sealOAuthTransaction({ state, codeVerifier, createdAt: Date.now() }, config.sessionSecret),
    cookieOptions(config.secureCookies, OAUTH_TX_MAX_AGE_SECONDS, OAUTH_TX_PATH),
  );
  return response;
}
