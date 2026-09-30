/**
 * OAuth 2.0 Authorization Code + PKCE against a Salesforce External Client App.
 *
 * Endpoints come from the org's OpenID configuration
 * (https://login.salesforce.com/.well-known/openid-configuration):
 *   authorize  {SF_LOGIN_URL}/services/oauth2/authorize
 *   token      {SF_LOGIN_URL}/services/oauth2/token
 *   revoke     {SF_LOGIN_URL}/services/oauth2/revoke
 */
import type { AppConfig } from "./config";
import type { SessionData } from "./session";

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface SalesforceTokenResponse {
  access_token: string;
  refresh_token?: string;
  instance_url: string;
  /** Identity URL: https://login.salesforce.com/id/<orgId>/<userId> */
  id?: string;
  issued_at?: string;
  scope?: string;
  token_type?: string;
  signature?: string;
}

export class SalesforceOAuthError extends Error {
  constructor(
    public readonly code: string,
    public readonly description?: string,
    public readonly status?: number,
  ) {
    super(description ? `${code}: ${description}` : code);
    this.name = "SalesforceOAuthError";
  }
}

/** Refresh this long before the JWT `exp` so a token never expires mid-request. */
export const EXPIRY_SKEW_MS = 60_000;

export function authorizeUrl(config: AppConfig, { state, codeChallenge }: { state: string; codeChallenge: string }): string {
  const url = new URL(`${config.salesforce.loginUrl}/services/oauth2/authorize`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", config.salesforce.clientId);
  url.searchParams.set("redirect_uri", config.salesforce.callbackUrl);
  url.searchParams.set("scope", config.salesforce.scopes);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  for (const resource of config.salesforce.resources) {
    url.searchParams.append("resource", resource);
  }
  return url.toString();
}

async function postTokenEndpoint(config: AppConfig, form: URLSearchParams, fetchImpl: FetchLike): Promise<SalesforceTokenResponse> {
  form.set("client_id", config.salesforce.clientId);
  if (config.salesforce.clientSecret) {
    form.set("client_secret", config.salesforce.clientSecret);
  }
  for (const resource of config.salesforce.resources) {
    form.append("resource", resource);
  }

  const response = await fetchImpl(`${config.salesforce.loginUrl}/services/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: form.toString(),
    cache: "no-store",
  });

  let payload: Record<string, unknown> = {};
  try {
    payload = (await response.json()) as Record<string, unknown>;
  } catch {
    // Non-JSON error bodies fall through to the generic error below.
  }

  if (!response.ok || typeof payload.access_token !== "string" || typeof payload.instance_url !== "string") {
    throw new SalesforceOAuthError(
      typeof payload.error === "string" ? payload.error : "token_request_failed",
      typeof payload.error_description === "string" ? payload.error_description : `HTTP ${response.status}`,
      response.status,
    );
  }
  return payload as unknown as SalesforceTokenResponse;
}

export function exchangeCode(
  config: AppConfig,
  { code, codeVerifier }: { code: string; codeVerifier: string },
  fetchImpl: FetchLike = fetch,
): Promise<SalesforceTokenResponse> {
  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: config.salesforce.callbackUrl,
    code_verifier: codeVerifier,
  });
  return postTokenEndpoint(config, form, fetchImpl);
}

export function refreshTokens(config: AppConfig, refreshToken: string, fetchImpl: FetchLike = fetch): Promise<SalesforceTokenResponse> {
  const form = new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken });
  return postTokenEndpoint(config, form, fetchImpl);
}

/** Best effort: revoking the refresh token also invalidates the access tokens issued from it. */
export async function revokeToken(config: AppConfig, token: string, fetchImpl: FetchLike = fetch): Promise<void> {
  await fetchImpl(`${config.salesforce.loginUrl}/services/oauth2/revoke`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token }).toString(),
    cache: "no-store",
  });
}

/**
 * Decode (NOT verify) a JWT payload. Used only to read `exp` and display names;
 * the hosted MCP server is what validates the token.
 */
export function decodeJwtClaims(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[1]) return null;
  try {
    const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as unknown;
    return claims && typeof claims === "object" ? (claims as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** https://login.salesforce.com/id/00Dxx.../005xx... -> { orgId, userId } */
export function parseIdentityUrl(id: string | undefined): { orgId?: string; userId?: string } {
  const match = id?.match(/\/id\/(00D[A-Za-z0-9]{12,15})\/(005[A-Za-z0-9]{12,15})\/?$/);
  return match ? { orgId: match[1], userId: match[2] } : {};
}

export function toSessionData(response: SalesforceTokenResponse, now = Date.now(), previous?: SessionData): SessionData {
  const issuedAt = Number(response.issued_at);
  const claims = decodeJwtClaims(response.access_token);
  const exp = typeof claims?.exp === "number" ? claims.exp * 1000 : undefined;
  const identity = parseIdentityUrl(response.id);
  const username = [claims?.username, claims?.preferred_username, claims?.email].find(
    (value): value is string => typeof value === "string" && value.length > 0,
  );

  return {
    v: 1,
    tokens: {
      accessToken: response.access_token,
      // Without refresh token rotation Salesforce omits refresh_token on refresh: keep the old one.
      refreshToken: response.refresh_token ?? previous?.tokens.refreshToken,
      instanceUrl: response.instance_url,
      issuedAt: Number.isFinite(issuedAt) && issuedAt > 0 ? issuedAt : now,
      expiresAt: exp,
      scope: response.scope ?? previous?.tokens.scope,
    },
    user: {
      userId: identity.userId ?? previous?.user.userId,
      orgId: identity.orgId ?? previous?.user.orgId,
      username: username ?? previous?.user.username,
    },
    createdAt: previous?.createdAt ?? now,
  };
}

export function needsRefresh(session: SessionData, config: AppConfig, now = Date.now()): boolean {
  const { issuedAt, expiresAt } = session.tokens;
  if (expiresAt !== undefined && expiresAt - EXPIRY_SKEW_MS <= now) return true;
  return now - issuedAt >= config.salesforce.tokenMaxAgeSeconds * 1000;
}

export class ReauthenticationRequired extends Error {
  constructor(message = "Salesforce session expired. Sign in again.") {
    super(message);
    this.name = "ReauthenticationRequired";
  }
}

/**
 * Keep the access token short-lived before it leaves this server: refresh it when it
 * is close to its JWT expiry or older than SF_TOKEN_MAX_AGE_SECONDS.
 */
export async function ensureFreshSession(
  session: SessionData,
  config: AppConfig,
  fetchImpl: FetchLike = fetch,
  now = Date.now(),
): Promise<{ session: SessionData; refreshed: boolean }> {
  if (!needsRefresh(session, config, now)) {
    return { session, refreshed: false };
  }
  const refreshToken = session.tokens.refreshToken;
  if (!refreshToken) {
    throw new ReauthenticationRequired("No refresh token in the session. Add the refresh_token scope to the External Client App.");
  }
  try {
    const response = await refreshTokens(config, refreshToken, fetchImpl);
    return { session: toSessionData(response, now, session), refreshed: true };
  } catch (error) {
    if (error instanceof SalesforceOAuthError) {
      throw new ReauthenticationRequired(`Could not refresh the Salesforce token (${error.message}). Sign in again.`);
    }
    throw error;
  }
}
