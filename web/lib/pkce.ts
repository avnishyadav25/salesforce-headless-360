/**
 * PKCE (RFC 7636) and OAuth state helpers.
 * Salesforce hosted MCP servers require PKCE with the S256 method; the org's
 * /.well-known/openid-configuration lists code_challenge_methods_supported: ["S256"].
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** RFC 7636 section 4.1: 43-128 characters from the unreserved set. */
const VERIFIER_PATTERN = /^[A-Za-z0-9\-._~]{43,128}$/;

export function generateCodeVerifier(byteLength = 32): string {
  if (byteLength < 32 || byteLength > 96) {
    throw new RangeError("byteLength must be between 32 and 96 bytes (43-128 characters)");
  }
  return randomBytes(byteLength).toString("base64url");
}

export function isValidCodeVerifier(verifier: string): boolean {
  return VERIFIER_PATTERN.test(verifier);
}

/** code_challenge = BASE64URL(SHA256(ASCII(code_verifier))), method "S256". */
export function codeChallengeS256(verifier: string): string {
  if (!isValidCodeVerifier(verifier)) {
    throw new Error("Invalid PKCE code_verifier");
  }
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

/** Opaque, unguessable value that ties the callback to the browser that started login. */
export function generateState(): string {
  return randomBytes(32).toString("base64url");
}

/** Constant-time string comparison for state values. */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}
