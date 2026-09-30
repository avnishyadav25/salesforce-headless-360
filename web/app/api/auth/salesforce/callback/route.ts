import type { NextRequest } from "next/server";
import { loadConfig } from "@/lib/config";
import { redirectTo } from "@/lib/http";
import { safeEqual } from "@/lib/pkce";
import { exchangeCode, SalesforceOAuthError, toSessionData } from "@/lib/salesforce-oauth";
import { cookieOptions, OAUTH_TX_COOKIE, OAUTH_TX_PATH, unsealOAuthTransaction, writeSession } from "@/lib/session";

export const dynamic = "force-dynamic";

/** Salesforce redirects here with ?code&state (or ?error). Exchange the code with the PKCE verifier. */
export async function GET(request: NextRequest) {
  let config;
  try {
    config = loadConfig();
  } catch {
    return redirectTo(request, "/?auth_error=config");
  }

  const params = request.nextUrl.searchParams;
  const sealedTx = request.cookies.get(OAUTH_TX_COOKIE)?.value;
  const tx = sealedTx ? unsealOAuthTransaction(sealedTx, config.sessionSecret) : null;

  const finish = (path: string) => {
    const response = redirectTo(request, path);
    // The PKCE verifier is single-use: always drop it.
    response.cookies.set(OAUTH_TX_COOKIE, "", cookieOptions(config.secureCookies, 0, OAUTH_TX_PATH));
    return response;
  };

  const error = params.get("error");
  if (error) {
    return finish(`/?auth_error=${encodeURIComponent(error)}`);
  }

  const code = params.get("code");
  const state = params.get("state");
  if (!tx || !code || !state || !safeEqual(tx.state, state)) {
    return finish("/?auth_error=invalid_state");
  }

  try {
    const tokens = await exchangeCode(config, { code, codeVerifier: tx.codeVerifier });
    const response = finish("/");
    writeSession(response, toSessionData(tokens), { secret: config.sessionSecret, secure: config.secureCookies });
    return response;
  } catch (exchangeError) {
    const reason = exchangeError instanceof SalesforceOAuthError ? exchangeError.code : "token_exchange";
    console.error("Salesforce token exchange failed:", exchangeError instanceof Error ? exchangeError.message : exchangeError);
    return finish(`/?auth_error=${encodeURIComponent(reason)}`);
  }
}
