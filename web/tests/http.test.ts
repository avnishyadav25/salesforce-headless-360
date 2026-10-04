import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { isSameOrigin } from "@/lib/http";

const post = (headers: Record<string, string>) =>
  new NextRequest("http://localhost:3002/api/auth/salesforce/logout", { method: "POST", headers: { host: "localhost:3002", ...headers } });

describe("isSameOrigin", () => {
  it("accepts a matching Origin and requests without one", () => {
    expect(isSameOrigin(post({ origin: "http://localhost:3002" }))).toBe(true);
    expect(isSameOrigin(post({}))).toBe(true);
  });

  it("rejects another origin", () => {
    expect(isSameOrigin(post({ origin: "https://evil.example" }))).toBe(false);
  });

  it("accepts Origin: null only when Fetch Metadata says same-origin (the sign-out form, org test T37)", () => {
    expect(isSameOrigin(post({ origin: "null", "sec-fetch-site": "same-origin" }))).toBe(true);
    expect(isSameOrigin(post({ origin: "null", "sec-fetch-site": "cross-site" }))).toBe(false);
    expect(isSameOrigin(post({ origin: "null" }))).toBe(false);
  });
});
