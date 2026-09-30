/**
 * Encrypted, httpOnly cookie sessions.
 *
 * The Salesforce access and refresh tokens live only in these cookies, sealed with
 * AES-256-GCM under a key derived from SESSION_SECRET. The browser stores opaque
 * ciphertext it cannot read (httpOnly) or forge (GCM authentication tag), and the
 * tokens are only ever decrypted on the server.
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import type { NextResponse } from "next/server";

export interface SalesforceTokens {
  accessToken: string;
  refreshToken?: string;
  /** e.g. https://acme.my.salesforce.com */
  instanceUrl: string;
  /** When Salesforce issued the access token (epoch ms). */
  issuedAt: number;
  /** From the JWT `exp` claim when the access token is a JWT (epoch ms). */
  expiresAt?: number;
  scope?: string;
}

export interface SalesforceUser {
  userId?: string;
  orgId?: string;
  username?: string;
}

export interface SessionData {
  v: 1;
  tokens: SalesforceTokens;
  user: SalesforceUser;
  createdAt: number;
}

export interface OAuthTransaction {
  state: string;
  codeVerifier: string;
  createdAt: number;
}

export const SESSION_COOKIE = "sfh360_session";
export const OAUTH_TX_COOKIE = "sfh360_oauth_tx";
export const OAUTH_TX_PATH = "/api/auth/salesforce";
export const SESSION_MAX_AGE_SECONDS = 8 * 60 * 60;
export const OAUTH_TX_MAX_AGE_SECONDS = 10 * 60;

/** Browsers cap a single cookie at ~4 KB; JWT access tokens are large, so sessions are chunked. */
export const COOKIE_CHUNK_SIZE = 3800;
export const MAX_COOKIE_CHUNKS = 4;

const VERSION = "v1";

function deriveKey(secret: string, purpose: string): Buffer {
  return Buffer.from(hkdfSync("sha256", secret, "sfh360-cookie-v1", purpose, 32));
}

/** Encrypt `payload` for one purpose ("session" or "oauth-tx") with an absolute expiry. */
export function seal(payload: unknown, secret: string, purpose: string, maxAgeSeconds: number, now = Date.now()): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", deriveKey(secret, purpose), iv);
  cipher.setAAD(Buffer.from(purpose, "utf8"));
  const plaintext = Buffer.from(JSON.stringify({ exp: now + maxAgeSeconds * 1000, data: payload }), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString("base64url"), ciphertext.toString("base64url"), tag.toString("base64url")].join(".");
}

/** Returns null for anything tampered with, sealed with another secret/purpose, malformed or expired. */
export function unseal<T>(sealed: string, secret: string, purpose: string, now = Date.now()): T | null {
  const parts = sealed.split(".");
  if (parts.length !== 4 || parts[0] !== VERSION) return null;
  const [, ivPart, dataPart, tagPart] = parts as [string, string, string, string];
  try {
    const iv = Buffer.from(ivPart, "base64url");
    const tag = Buffer.from(tagPart, "base64url");
    if (iv.length !== 12 || tag.length !== 16) return null;
    const decipher = createDecipheriv("aes-256-gcm", deriveKey(secret, purpose), iv);
    decipher.setAAD(Buffer.from(purpose, "utf8"));
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(Buffer.from(dataPart, "base64url")), decipher.final()]);
    const envelope = JSON.parse(plaintext.toString("utf8")) as { exp?: unknown; data?: unknown };
    if (typeof envelope.exp !== "number" || envelope.exp <= now) return null;
    return envelope.data as T;
  } catch {
    return null;
  }
}

function isSessionData(value: unknown): value is SessionData {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<SessionData>;
  return (
    candidate.v === 1 &&
    typeof candidate.tokens?.accessToken === "string" &&
    typeof candidate.tokens.instanceUrl === "string" &&
    typeof candidate.tokens.issuedAt === "number"
  );
}

export function sealSession(data: SessionData, secret: string, now = Date.now()): string {
  return seal(data, secret, "session", SESSION_MAX_AGE_SECONDS, now);
}

export function unsealSession(value: string, secret: string, now = Date.now()): SessionData | null {
  const data = unseal<unknown>(value, secret, "session", now);
  return isSessionData(data) ? data : null;
}

export function sealOAuthTransaction(tx: OAuthTransaction, secret: string, now = Date.now()): string {
  return seal(tx, secret, "oauth-tx", OAUTH_TX_MAX_AGE_SECONDS, now);
}

export function unsealOAuthTransaction(value: string, secret: string, now = Date.now()): OAuthTransaction | null {
  const tx = unseal<Partial<OAuthTransaction>>(value, secret, "oauth-tx", now);
  if (!tx || typeof tx.state !== "string" || typeof tx.codeVerifier !== "string") return null;
  return { state: tx.state, codeVerifier: tx.codeVerifier, createdAt: Number(tx.createdAt) };
}

// ---------------------------------------------------------------------------
// Cookie plumbing
// ---------------------------------------------------------------------------

/** Satisfied by NextRequest#cookies and by `await cookies()` from next/headers. */
export interface CookieReader {
  get(name: string): { value: string } | undefined;
}

export function splitIntoChunks(value: string, size = COOKIE_CHUNK_SIZE): string[] {
  const chunks: string[] = [];
  for (let offset = 0; offset < value.length; offset += size) {
    chunks.push(value.slice(offset, offset + size));
  }
  return chunks.length > 0 ? chunks : [""];
}

export function chunkName(baseName: string, index: number): string {
  return `${baseName}.${index}`;
}

export function readChunkedCookie(cookies: CookieReader, baseName: string): string | undefined {
  let value = "";
  for (let index = 0; index < MAX_COOKIE_CHUNKS; index += 1) {
    const chunk = cookies.get(chunkName(baseName, index))?.value;
    if (!chunk) break;
    value += chunk;
  }
  return value || undefined;
}

export function cookieOptions(secure: boolean, maxAge: number, path = "/") {
  return { httpOnly: true, secure, sameSite: "lax" as const, path, maxAge };
}

export function readSession(cookies: CookieReader, secret: string, now = Date.now()): SessionData | null {
  const sealed = readChunkedCookie(cookies, SESSION_COOKIE);
  return sealed ? unsealSession(sealed, secret, now) : null;
}

export function writeSession(
  response: NextResponse,
  data: SessionData,
  { secret, secure }: { secret: string; secure: boolean },
): void {
  const chunks = splitIntoChunks(sealSession(data, secret));
  if (chunks.length > MAX_COOKIE_CHUNKS) {
    throw new Error("Session is too large to store in cookies");
  }
  const options = cookieOptions(secure, SESSION_MAX_AGE_SECONDS);
  chunks.forEach((chunk, index) => response.cookies.set(chunkName(SESSION_COOKIE, index), chunk, options));
  // Expire chunks left over from a previous, longer session.
  for (let index = chunks.length; index < MAX_COOKIE_CHUNKS; index += 1) {
    response.cookies.set(chunkName(SESSION_COOKIE, index), "", { ...options, maxAge: 0 });
  }
}

export function clearSession(response: NextResponse, secure: boolean): void {
  const options = cookieOptions(secure, 0);
  for (let index = 0; index < MAX_COOKIE_CHUNKS; index += 1) {
    response.cookies.set(chunkName(SESSION_COOKIE, index), "", options);
  }
}
