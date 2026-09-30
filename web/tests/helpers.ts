import { vi } from "vitest";
import { loadConfig, type AppConfig } from "@/lib/config";
import { chunkName, sealSession, SESSION_COOKIE, splitIntoChunks, type SessionData } from "@/lib/session";

export const TEST_ENV: Record<string, string> = {
  SF_LOGIN_URL: "https://login.salesforce.com",
  SF_CLIENT_ID: "3MVG9test-consumer-key",
  SF_CALLBACK_URL: "http://localhost:3000/api/auth/salesforce/callback",
  SF_MCP_SOBJECT_URL: "https://api.salesforce.com/platform/mcp/v1/platform/sobject-all",
  SF_MCP_CUSTOM_URL: "https://api.salesforce.com/platform/mcp/v1/custom/Headless_Assistant_Tools",
  ANTHROPIC_API_KEY: "sk-ant-test-key",
  ANTHROPIC_MODEL: "claude-sonnet-5-5",
  SESSION_SECRET: "test-session-secret-that-is-long-enough-123",
};

export function testConfig(overrides: Record<string, string | undefined> = {}): AppConfig {
  return loadConfig({ ...TEST_ENV, ...overrides });
}

export function stubTestEnv(overrides: Record<string, string> = {}): void {
  for (const [name, value] of Object.entries({ ...TEST_ENV, ...overrides })) {
    vi.stubEnv(name, value);
  }
}

/** Builds an unsigned JWT-shaped token (the app only decodes claims; Salesforce validates). */
export function fakeJwt(claims: Record<string, unknown>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "RS256", typ: "JWT" })}.${encode(claims)}.c2lnbmF0dXJl`;
}

export function testSession(overrides: Partial<SessionData["tokens"]> = {}, now = Date.now()): SessionData {
  return {
    v: 1,
    tokens: {
      accessToken: fakeJwt({ sub: "005000000000001AAA", exp: Math.floor(now / 1000) + 3600 }),
      refreshToken: "5Aep861-refresh-token",
      instanceUrl: "https://acme-dev-ed.develop.my.salesforce.com",
      issuedAt: now,
      expiresAt: now + 3600_000,
      scope: "mcp_api refresh_token",
      ...overrides,
    },
    user: { userId: "005000000000001AAA", orgId: "00D000000000001EAA", username: "demo@acme.example" },
    createdAt: now,
  };
}

type Block = Record<string, unknown> & { type: string };

/** Serializes a Claude Messages API streaming response (SSE) that ends with the given content blocks. */
export function sseMessage(blocks: Block[], stopReason = "end_turn", usage = { input_tokens: 120, output_tokens: 40 }): string {
  const events: Array<Record<string, unknown>> = [
    {
      type: "message_start",
      message: {
        id: "msg_test",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-5-5",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: usage.input_tokens, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    },
  ];

  blocks.forEach((block, index) => {
    if (block.type === "text") {
      events.push({ type: "content_block_start", index, content_block: { type: "text", text: "" } });
      events.push({ type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } });
    } else if (block.type === "mcp_tool_use" || block.type === "tool_use") {
      events.push({ type: "content_block_start", index, content_block: { ...block, input: {} } });
      events.push({
        type: "content_block_delta",
        index,
        delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) },
      });
    } else if (block.type === "thinking") {
      events.push({ type: "content_block_start", index, content_block: { type: "thinking", thinking: "", signature: "" } });
      events.push({ type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: block.thinking } });
      events.push({ type: "content_block_delta", index, delta: { type: "signature_delta", signature: "sig" } });
    } else {
      events.push({ type: "content_block_start", index, content_block: block });
    }
    events.push({ type: "content_block_stop", index });
  });

  events.push({
    type: "message_delta",
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: usage.output_tokens },
  });
  events.push({ type: "message_stop" });

  return events.map((event) => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`).join("");
}

export function sseResponse(body: string): Response {
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream", "request-id": "req_test" } });
}

export interface CapturedRequest {
  url: string;
  method: string;
  headers: Headers;
  body: string;
}

export async function capture(input: string | URL | Request, init?: RequestInit): Promise<CapturedRequest> {
  const request = input instanceof Request ? input : new Request(input, init);
  return {
    url: request.url,
    method: request.method,
    headers: new Headers(init?.headers ?? request.headers),
    body: init?.body !== undefined && init.body !== null ? String(init.body) : await request.text(),
  };
}

export type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** A typed fetch mock whose calls can be passed straight to capture(). */
export function mockFetchReturning(respond: () => Response) {
  return vi.fn<FetchFn>(async () => respond());
}

/** Cookie header carrying a sealed session, as the browser would send it. */
export function sessionCookie(session: SessionData): string {
  return splitIntoChunks(sealSession(session, TEST_ENV.SESSION_SECRET!))
    .map((chunk, index) => `${chunkName(SESSION_COOKIE, index)}=${chunk}`)
    .join("; ");
}

/**
 * Routes mocked fetch calls: Salesforce token endpoint vs. Anthropic Messages API.
 * Each Anthropic call takes the next item: an SSE body (string) or a ready Response.
 */
export function mockFetch(anthropicResponses: Array<string | Response>, salesforceToken?: string) {
  const anthropicCalls: CapturedRequest[] = [];
  const salesforceCalls: CapturedRequest[] = [];
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const request = await capture(input, init);
    if (request.url.startsWith("https://login.salesforce.com/services/oauth2/token")) {
      salesforceCalls.push(request);
      return new Response(
        JSON.stringify({
          access_token: salesforceToken,
          instance_url: "https://acme-dev-ed.develop.my.salesforce.com",
          id: "https://login.salesforce.com/id/00D000000000001EAA/005000000000001AAA",
          issued_at: String(Date.now()),
          token_type: "Bearer",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (request.url.startsWith("https://api.anthropic.com/v1/messages")) {
      anthropicCalls.push(request);
      const next = anthropicResponses.shift();
      if (next === undefined) throw new Error("Unexpected extra Anthropic call");
      return typeof next === "string" ? sseResponse(next) : next;
    }
    throw new Error(`Unexpected fetch to ${request.url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, anthropicCalls, salesforceCalls };
}
