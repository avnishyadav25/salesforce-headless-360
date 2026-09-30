import { describe, expect, it } from "vitest";
import { codeChallengeS256, generateCodeVerifier, generateState, isValidCodeVerifier, safeEqual } from "@/lib/pkce";
import { authorizeUrl } from "@/lib/salesforce-oauth";
import { testConfig } from "./helpers";

describe("PKCE helpers", () => {
  it("matches the RFC 7636 Appendix B S256 test vector", () => {
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    expect(codeChallengeS256(verifier)).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  it("generates 43-character base64url verifiers that are unique", () => {
    const verifiers = new Set(Array.from({ length: 50 }, () => generateCodeVerifier()));
    expect(verifiers.size).toBe(50);
    for (const verifier of verifiers) {
      expect(verifier).toHaveLength(43);
      expect(isValidCodeVerifier(verifier)).toBe(true);
      expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  it("produces challenges without padding and rejects invalid verifiers", () => {
    const challenge = codeChallengeS256(generateCodeVerifier());
    expect(challenge).toHaveLength(43);
    expect(challenge).not.toContain("=");
    expect(() => codeChallengeS256("too-short")).toThrow(/code_verifier/);
    expect(() => generateCodeVerifier(16)).toThrow(RangeError);
  });

  it("generates unguessable state and compares it in constant time", () => {
    const state = generateState();
    expect(state.length).toBeGreaterThanOrEqual(43);
    expect(generateState()).not.toBe(state);
    expect(safeEqual(state, state)).toBe(true);
    expect(safeEqual(state, `${state}x`)).toBe(false);
    expect(safeEqual(state, generateState())).toBe(false);
  });
});

describe("authorizeUrl", () => {
  it("builds the Salesforce authorize request with PKCE S256 and GA MCP scopes", () => {
    const url = new URL(authorizeUrl(testConfig(), { state: "state-123", codeChallenge: "challenge-abc" }));
    expect(url.origin + url.pathname).toBe("https://login.salesforce.com/services/oauth2/authorize");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: "code",
      client_id: "3MVG9test-consumer-key",
      redirect_uri: "http://localhost:3000/api/auth/salesforce/callback",
      scope: "mcp_api refresh_token",
      state: "state-123",
      code_challenge: "challenge-abc",
      code_challenge_method: "S256",
    });
  });

  it("uses a My Domain login URL and adds optional RFC 8707 resource indicators", () => {
    const config = testConfig({
      SF_LOGIN_URL: "https://acme-dev-ed.develop.my.salesforce.com/",
      SF_OAUTH_RESOURCE:
        "https://api.salesforce.com/platform/mcp/v1/platform/sobject-all, https://api.salesforce.com/platform/mcp/v1/custom/Headless_Assistant_Tools",
    });
    const url = new URL(authorizeUrl(config, { state: "s", codeChallenge: "c" }));
    expect(url.host).toBe("acme-dev-ed.develop.my.salesforce.com");
    expect(url.searchParams.getAll("resource")).toEqual([
      "https://api.salesforce.com/platform/mcp/v1/platform/sobject-all",
      "https://api.salesforce.com/platform/mcp/v1/custom/Headless_Assistant_Tools",
    ]);
  });
});
