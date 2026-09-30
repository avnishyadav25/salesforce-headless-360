import { NextResponse } from "next/server";
import { describe, expect, it } from "vitest";
import {
  chunkName,
  COOKIE_CHUNK_SIZE,
  readChunkedCookie,
  readSession,
  seal,
  sealOAuthTransaction,
  sealSession,
  SESSION_COOKIE,
  SESSION_MAX_AGE_SECONDS,
  splitIntoChunks,
  unseal,
  unsealOAuthTransaction,
  unsealSession,
  writeSession,
} from "@/lib/session";
import { testSession } from "./helpers";

const SECRET = "a-very-long-session-secret-for-tests-0001";

function readerFrom(response: NextResponse) {
  return { get: (name: string) => response.cookies.get(name) };
}

describe("session encryption", () => {
  it("round-trips session data and never stores tokens in plaintext", () => {
    const session = testSession();
    const sealed = sealSession(session, SECRET);
    expect(sealed.startsWith("v1.")).toBe(true);
    expect(sealed).not.toContain(session.tokens.accessToken);
    expect(sealed).not.toContain(session.tokens.refreshToken);
    expect(unsealSession(sealed, SECRET)).toEqual(session);
  });

  it("uses a fresh IV per seal", () => {
    const session = testSession();
    expect(sealSession(session, SECRET)).not.toBe(sealSession(session, SECRET));
  });

  it("rejects tampered ciphertext, the wrong secret and the wrong purpose", () => {
    const sealed = sealSession(testSession(), SECRET);
    const [version, iv, data, tag] = sealed.split(".") as [string, string, string, string];
    const flipped = `${data.slice(0, -2)}${data.at(-2) === "A" ? "B" : "A"}${data.at(-1)}`;
    expect(unsealSession([version, iv, flipped, tag].join("."), SECRET)).toBeNull();
    expect(unsealSession(sealed, `${SECRET}-other`)).toBeNull();
    expect(unseal(sealed, SECRET, "oauth-tx")).toBeNull();
    expect(unsealSession("not-a-session", SECRET)).toBeNull();
  });

  it("expires sealed values", () => {
    const now = Date.now();
    const sealed = sealSession(testSession(), SECRET, now);
    expect(unsealSession(sealed, SECRET, now + SESSION_MAX_AGE_SECONDS * 1000 - 1)).not.toBeNull();
    expect(unsealSession(sealed, SECRET, now + SESSION_MAX_AGE_SECONDS * 1000 + 1)).toBeNull();
  });

  it("round-trips the short-lived OAuth transaction (state + PKCE verifier)", () => {
    const tx = { state: "state-1", codeVerifier: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk", createdAt: 1 };
    const sealed = sealOAuthTransaction(tx, SECRET);
    expect(unsealOAuthTransaction(sealed, SECRET)).toEqual(tx);
    expect(unsealSession(sealed, SECRET)).toBeNull();
  });

  it("rejects well-formed payloads that are not sessions", () => {
    const sealed = seal({ hello: "world" }, SECRET, "session", 60);
    expect(unsealSession(sealed, SECRET)).toBeNull();
  });
});

describe("session cookies", () => {
  it("splits large values into chunks and reassembles them in order", () => {
    const value = "x".repeat(COOKIE_CHUNK_SIZE * 2 + 10);
    const chunks = splitIntoChunks(value);
    expect(chunks).toHaveLength(3);
    const jar = new Map(chunks.map((chunk, index) => [chunkName(SESSION_COOKIE, index), { value: chunk }]));
    expect(readChunkedCookie({ get: (name) => jar.get(name) }, SESSION_COOKIE)).toBe(value);
  });

  it("writes httpOnly, SameSite=Lax cookies that read back as the same session", () => {
    const session = testSession({ accessToken: `eyJ.${"a".repeat(5000)}.sig` });
    const response = NextResponse.json({});
    writeSession(response, session, { secret: SECRET, secure: false });

    const setCookies = response.headers.getSetCookie();
    const written = setCookies.filter((header) => header.startsWith(`${SESSION_COOKIE}.`) && !header.includes("Max-Age=0"));
    expect(written.length).toBeGreaterThan(1);
    for (const header of written) {
      expect(header).toMatch(/HttpOnly/i);
      expect(header).toMatch(/SameSite=lax/i);
      expect(header.length).toBeLessThan(4096);
    }
    expect(readSession(readerFrom(response), SECRET)).toEqual(session);
  });
});
