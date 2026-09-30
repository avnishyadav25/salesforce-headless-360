import { describe, expect, it, vi } from "vitest";
import {
  ensureFreshSession,
  exchangeCode,
  parseIdentityUrl,
  ReauthenticationRequired,
  SalesforceOAuthError,
  toSessionData,
} from "@/lib/salesforce-oauth";
import { capture, fakeJwt, mockFetchReturning, testConfig, testSession } from "./helpers";

function tokenResponse(accessToken: string, extra: Record<string, unknown> = {}) {
  return new Response(
    JSON.stringify({
      access_token: accessToken,
      instance_url: "https://acme-dev-ed.develop.my.salesforce.com",
      id: "https://login.salesforce.com/id/00D000000000001EAA/005000000000001AAA",
      issued_at: String(Date.now()),
      scope: "mcp_api refresh_token",
      token_type: "Bearer",
      ...extra,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

describe("Salesforce token endpoint", () => {
  it("exchanges the code with the PKCE verifier (no secret unless configured)", async () => {
    const fetchMock = mockFetchReturning(() => tokenResponse("access-1", { refresh_token: "refresh-1" }));
    const result = await exchangeCode(testConfig(), { code: "auth-code", codeVerifier: "verifier-xyz" }, fetchMock);

    expect(result.access_token).toBe("access-1");
    const request = await capture(...fetchMock.mock.calls[0]!);
    expect(request.url).toBe("https://login.salesforce.com/services/oauth2/token");
    expect(request.method).toBe("POST");
    expect(request.headers.get("content-type")).toBe("application/x-www-form-urlencoded");
    expect(Object.fromEntries(new URLSearchParams(request.body))).toEqual({
      grant_type: "authorization_code",
      code: "auth-code",
      redirect_uri: "http://localhost:3000/api/auth/salesforce/callback",
      code_verifier: "verifier-xyz",
      client_id: "3MVG9test-consumer-key",
    });
  });

  it("sends the client secret when the External Client App requires one", async () => {
    const fetchMock = mockFetchReturning(() => tokenResponse("access-1"));
    await exchangeCode(testConfig({ SF_CLIENT_SECRET: "shh" }), { code: "c", codeVerifier: "v" }, fetchMock);
    const request = await capture(...fetchMock.mock.calls[0]!);
    expect(new URLSearchParams(request.body).get("client_secret")).toBe("shh");
  });

  it("turns OAuth errors into SalesforceOAuthError", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: "invalid_grant", error_description: "authentication failure" }), { status: 400 }),
    );
    await expect(exchangeCode(testConfig(), { code: "c", codeVerifier: "v" }, fetchMock)).rejects.toMatchObject({
      name: "SalesforceOAuthError",
      code: "invalid_grant",
      status: 400,
    });
    await expect(exchangeCode(testConfig(), { code: "c", codeVerifier: "v" }, fetchMock)).rejects.toBeInstanceOf(
      SalesforceOAuthError,
    );
  });
});

describe("session data from tokens", () => {
  it("reads expiry from the JWT and identity from the id URL", () => {
    const exp = Math.floor(Date.now() / 1000) + 1800;
    const session = toSessionData({
      access_token: fakeJwt({ exp, username: "demo@acme.example" }),
      refresh_token: "refresh-1",
      instance_url: "https://acme.my.salesforce.com",
      id: "https://login.salesforce.com/id/00D000000000001EAA/005000000000001AAA",
      issued_at: "1700000000000",
    });
    expect(session.tokens.expiresAt).toBe(exp * 1000);
    expect(session.tokens.issuedAt).toBe(1700000000000);
    expect(session.user).toEqual({ userId: "005000000000001AAA", orgId: "00D000000000001EAA", username: "demo@acme.example" });
  });

  it("keeps the previous refresh token when a refresh response omits it", () => {
    const previous = testSession();
    const next = toSessionData({ access_token: "opaque", instance_url: previous.tokens.instanceUrl }, Date.now(), previous);
    expect(next.tokens.refreshToken).toBe(previous.tokens.refreshToken);
    expect(next.user).toEqual(previous.user);
  });

  it("parses only well-formed identity URLs", () => {
    expect(parseIdentityUrl("https://login.salesforce.com/id/00D5g000004abcdEAA/0055g00000Abcd1AAC")).toEqual({
      orgId: "00D5g000004abcdEAA",
      userId: "0055g00000Abcd1AAC",
    });
    expect(parseIdentityUrl("https://example.com/whatever")).toEqual({});
    expect(parseIdentityUrl(undefined)).toEqual({});
  });
});

describe("ensureFreshSession", () => {
  const config = testConfig({ SF_TOKEN_MAX_AGE_SECONDS: "900" });

  it("does not call Salesforce while the token is young", async () => {
    const fetchMock = vi.fn();
    const session = testSession();
    const result = await ensureFreshSession(session, config, fetchMock);
    expect(result).toEqual({ session, refreshed: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refreshes a token older than SF_TOKEN_MAX_AGE_SECONDS", async () => {
    const now = Date.now();
    const fetchMock = mockFetchReturning(() => tokenResponse("access-2"));
    const stale = testSession({ issuedAt: now - 901_000, expiresAt: now + 600_000 });
    const result = await ensureFreshSession(stale, config, fetchMock, now);

    expect(result.refreshed).toBe(true);
    expect(result.session.tokens.accessToken).toBe("access-2");
    expect(result.session.tokens.refreshToken).toBe(stale.tokens.refreshToken);
    const request = await capture(...fetchMock.mock.calls[0]!);
    expect(Object.fromEntries(new URLSearchParams(request.body))).toMatchObject({
      grant_type: "refresh_token",
      refresh_token: stale.tokens.refreshToken,
      client_id: "3MVG9test-consumer-key",
    });
  });

  it("refreshes a token that is about to hit its JWT exp", async () => {
    const now = Date.now();
    const fetchMock = vi.fn(async () => tokenResponse("access-3"));
    const expiring = testSession({ issuedAt: now - 1000, expiresAt: now + 30_000 });
    expect((await ensureFreshSession(expiring, config, fetchMock, now)).refreshed).toBe(true);
  });

  it("asks the user to sign in again when refresh is impossible or rejected", async () => {
    const now = Date.now();
    const noRefresh = testSession({ issuedAt: now - 3_600_000, refreshToken: undefined });
    await expect(ensureFreshSession(noRefresh, config, vi.fn(), now)).rejects.toBeInstanceOf(ReauthenticationRequired);

    const rejected = vi.fn(async () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }));
    await expect(
      ensureFreshSession(testSession({ issuedAt: now - 3_600_000 }), config, rejected, now),
    ).rejects.toBeInstanceOf(ReauthenticationRequired);
  });
});
