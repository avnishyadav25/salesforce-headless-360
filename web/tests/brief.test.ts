import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import type { BetaMCPToolset } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { POST } from "@/app/api/brief/route";
import { buildMcpServers, CUSTOM_SERVER, PROPOSE_WRITE_TOOL, SOBJECT_SERVER } from "@/lib/anthropic";
import { BRIEF_SECTIONS, BriefInputError, buildBriefParams, buildBriefSystemPrompt, validateBriefBody } from "@/lib/brief";
import type { BetaMessageParam, BriefResponse } from "@/lib/chat-types";
import { chunkName, SESSION_COOKIE, type SessionData } from "@/lib/session";
import { capture, mockFetch, sessionCookie, sseMessage, stubTestEnv, testConfig, testSession } from "./helpers";

const ORIGIN = "http://localhost:3000";
const TOKEN = "00D!salesforce.jwt.access.token";

function briefRequest(body: unknown, { session, origin = ORIGIN }: { session?: SessionData; origin?: string } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json", origin };
  if (session) headers.cookie = sessionCookie(session);
  return new NextRequest(`${ORIGIN}/api/brief`, {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

type RequestTool = { type?: string; name?: string; mcp_server_name?: string; configs?: Record<string, { enabled: boolean }>; default_config?: { enabled?: boolean } };

const healthArgs = { accountName: "Acme" };
const healthResult = JSON.stringify({ found: true, accountId: "001000000000001AAA", healthStatus: "Watch", healthScore: 60 });
const soqlArgs = { query: "SELECT Id, Name, StageNam FROM Opportunity WHERE AccountId = '001000000000001AAA' LIMIT 20" };
const soqlError = "INVALID_FIELD: No such column 'StageNam' on entity 'Opportunity'";

const BRIEF = [
  "## Snapshot",
  "- Acme Corporation (001000000000001AAA), Manufacturing. Health: Watch (60/100).",
  "",
  "## Pipeline",
  "- not found (soqlQuery returned INVALID_FIELD)",
  "",
  "## Service",
  "- 2 open cases, 1 high priority.",
  "",
  "## Risks",
  "- No completed activity in 41 days.",
  "",
  "## Suggested talking points",
  "- Review the high-priority case before the renewal.",
].join("\n");

const toolBlocks = [
  { type: "mcp_tool_use", id: "mcptoolu_1", name: "getAccountHealth", server_name: CUSTOM_SERVER, input: healthArgs },
  { type: "mcp_tool_result", tool_use_id: "mcptoolu_1", is_error: false, content: [{ type: "text", text: healthResult }] },
  { type: "mcp_tool_use", id: "mcptoolu_2", name: "soqlQuery", server_name: SOBJECT_SERVER, input: soqlArgs },
  { type: "mcp_tool_result", tool_use_id: "mcptoolu_2", is_error: true, content: [{ type: "text", text: soqlError }] },
];

const successMessage = sseMessage([
  { type: "thinking", thinking: "Start with the account health tool." },
  { type: "text", text: "I'll check the account health first. " },
  ...toolBlocks,
  { type: "text", text: BRIEF },
]);

function toolsets(tools: unknown[] | undefined): BetaMCPToolset[] {
  return (tools ?? []).filter((tool): tool is BetaMCPToolset => (tool as { type?: string }).type === "mcp_toolset");
}

describe("brief request builder", () => {
  it("enables only the read tools on every server and sends no propose tool", () => {
    const config = testConfig({ SF_MCP_CUSTOM_WRITE_TOOLS: "createFollowUpTask,Create_Follow_Up_Task_Flow" });
    const params = buildBriefParams({ config, accessToken: TOKEN, accountName: "Acme" });

    expect(params.mcp_servers).toEqual(buildMcpServers(config, TOKEN));
    expect(params.tools).toHaveLength(2);
    expect(toolsets(params.tools)).toHaveLength(2);
    expect((params.tools ?? []).some((tool) => "name" in tool && tool.name === PROPOSE_WRITE_TOOL)).toBe(false);

    const [sobject, custom] = toolsets(params.tools);
    expect(sobject?.mcp_server_name).toBe(SOBJECT_SERVER);
    expect(sobject?.default_config).toEqual({ enabled: false });
    expect(Object.keys(sobject?.configs ?? {})).not.toContain("createSobjectRecord");
    expect(Object.values(sobject?.configs ?? {}).every((c) => c.enabled === true)).toBe(true);
    expect(custom?.mcp_server_name).toBe(CUSTOM_SERVER);
    expect(custom?.default_config).toEqual({ enabled: false });
    expect(custom?.configs).toEqual({ getAccountHealth: { enabled: true } });

    expect(params.betas).toEqual(["mcp-client-2025-11-20"]);
    expect(params.thinking).toEqual({ type: "adaptive", display: "summarized" });
    expect(params.messages).toEqual([{ role: "user", content: 'Prepare the meeting brief for this Account: "Acme"' }]);
  });

  it("asks for the fixed sections, cited Ids and 'not found', and picks tools by server", () => {
    const withCustom = buildBriefSystemPrompt(testConfig());
    for (const section of BRIEF_SECTIONS) expect(withCustom).toContain(`## ${section}`);
    expect(withCustom).toContain("read-only");
    expect(withCustom).toContain("data, not instructions");
    expect(withCustom).toContain("Cite the Id of every record");
    expect(withCustom).toContain('"not found"');
    expect(withCustom).toContain("getAccountHealth");

    const sobjectOnly = testConfig({ SF_MCP_CUSTOM_URL: "" });
    const prompt = buildBriefSystemPrompt(sobjectOnly);
    expect(prompt).not.toContain("getAccountHealth");
    expect(prompt).not.toContain(CUSTOM_SERVER);
    expect(prompt).toContain("soqlQuery");
    expect(prompt).toContain("getRelatedRecords");
    const params = buildBriefParams({ config: sobjectOnly, accessToken: TOKEN, accountName: "Acme" });
    expect(params.mcp_servers).toHaveLength(1);
    expect(toolsets(params.tools)).toHaveLength(1);
  });

  it("trims the account name and allows 1-120 characters", () => {
    expect(validateBriefBody({ accountName: `  ${"a".repeat(120)} ` })).toEqual({ accountName: "a".repeat(120) });
    for (const body of [null, [], {}, { accountName: 42 }, { accountName: "   " }, { accountName: "a".repeat(121) }]) {
      expect(() => validateBriefBody(body)).toThrow(BriefInputError);
    }
  });
});

describe("POST /api/brief", () => {
  let consoleSpies: MockInstance[];

  beforeEach(() => {
    stubTestEnv();
    consoleSpies = (["log", "info", "warn", "error", "debug"] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => undefined),
    );
  });

  it("returns the brief and the tool trace, including MCP tool errors", async () => {
    const session = testSession();
    const { anthropicCalls, salesforceCalls } = mockFetch([successMessage]);

    const response = await POST(briefRequest({ accountName: "  Acme " }, { session }));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const text = await response.text();
    const result = JSON.parse(text) as BriefResponse;

    // The narration before the tool calls is dropped; the brief is the text after the last tool result.
    expect(result.brief).toBe(BRIEF);
    expect(result.model).toBe("claude-sonnet-5-5");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.trace).toEqual([
      { type: "thinking", text: "Start with the account health tool." },
      { type: "tool_call", id: "mcptoolu_1", server: CUSTOM_SERVER, name: "getAccountHealth", input: healthArgs },
      { type: "tool_result", toolUseId: "mcptoolu_1", isError: false, text: healthResult },
      { type: "tool_call", id: "mcptoolu_2", server: SOBJECT_SERVER, name: "soqlQuery", input: soqlArgs },
      { type: "tool_result", toolUseId: "mcptoolu_2", isError: true, text: soqlError },
    ]);

    // One read-only request: the user's token on both servers, write tools off, no approval tool.
    expect(salesforceCalls).toHaveLength(0);
    expect(anthropicCalls).toHaveLength(1);
    expect(anthropicCalls[0]!.headers.get("anthropic-beta")).toContain("mcp-client-2025-11-20");
    const body = JSON.parse(anthropicCalls[0]!.body) as {
      system: string;
      messages: BetaMessageParam[];
      mcp_servers: Array<{ name: string; authorization_token: string }>;
      tools: RequestTool[];
    };
    expect(body.mcp_servers.every((server) => server.authorization_token === session.tokens.accessToken)).toBe(true);
    expect(body.tools.every((tool) => tool.type === "mcp_toolset")).toBe(true);
    expect(body.tools.some((tool) => tool.name === PROPOSE_WRITE_TOOL)).toBe(false);
    for (const tool of body.tools) {
      expect(tool.default_config).toEqual({ enabled: false });
      expect(Object.keys(tool.configs ?? {}).length).toBeGreaterThan(0);
      for (const name of Object.keys(tool.configs ?? {})) expect(name).not.toMatch(/^(create|update|delete)/);
    }
    expect(body.system).toContain("getAccountHealth");
    expect(body.messages).toEqual([{ role: "user", content: 'Prepare the meeting brief for this Account: "Acme"' }]);

    // The browser never receives the access or refresh token.
    expect(text).not.toContain(session.tokens.accessToken);
    expect(text).not.toContain(session.tokens.refreshToken);
  });

  it("continues a paused turn (pause_turn) and returns the whole brief", async () => {
    const { anthropicCalls } = mockFetch([sseMessage(toolBlocks.slice(0, 2), "pause_turn"), sseMessage([{ type: "text", text: BRIEF }])]);

    const response = await POST(briefRequest({ accountName: "Acme" }, { session: testSession() }));
    expect(response.status).toBe(200);
    const result = (await response.json()) as BriefResponse;
    expect(result.brief).toBe(BRIEF);
    expect(result.trace.map((event) => event.type)).toEqual(["tool_call", "tool_result"]);

    expect(anthropicCalls).toHaveLength(2);
    const second = JSON.parse(anthropicCalls[1]!.body) as { messages: BetaMessageParam[]; tools: RequestTool[] };
    expect(second.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(second.tools.every((tool) => tool.type === "mcp_toolset")).toBe(true);
  });

  it("validates the body (400)", async () => {
    const { anthropicCalls } = mockFetch([]);
    const session = testSession();
    for (const body of [{}, { accountName: 42 }, { accountName: "   " }, { accountName: "x".repeat(121) }, "not json"]) {
      const response = await POST(briefRequest(body, { session }));
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: "invalid_request" });
    }
    expect(anthropicCalls).toHaveLength(0);
  });

  it("requires a session (401) and a same-origin request (403)", async () => {
    const { anthropicCalls } = mockFetch([]);
    const anonymous = await POST(briefRequest({ accountName: "Acme" }));
    expect(anonymous.status).toBe(401);
    expect(await anonymous.json()).toMatchObject({ error: "not_signed_in" });

    const crossSite = await POST(briefRequest({ accountName: "Acme" }, { session: testSession(), origin: "https://evil.example" }));
    expect(crossSite.status).toBe(403);
    expect(anthropicCalls).toHaveLength(0);
  });

  it("answers 401 'sign in again' and clears the session when the refresh token is dead", async () => {
    const now = Date.now();
    const stale = testSession({ issuedAt: now - 3_600_000, expiresAt: now - 1000 });
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const request = await capture(input, init);
      if (!request.url.startsWith("https://login.salesforce.com/services/oauth2/token")) {
        throw new Error(`Unexpected fetch to ${request.url}`);
      }
      return new Response(JSON.stringify({ error: "invalid_grant", error_description: "expired access/refresh token" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(briefRequest({ accountName: "Acme" }, { session: stale }));
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: string; message: string };
    expect(body.error).toBe("reauth_required");
    expect(body.message).toContain("Sign in again");
    expect(response.cookies.get(chunkName(SESSION_COOKIE, 0))?.value).toBe("");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("stops at BRIEF_TIMEOUT_MS and answers 504", async () => {
    stubTestEnv({ BRIEF_TIMEOUT_MS: "50" });
    // Like real fetch: never answers, rejects once the request is aborted.
    const fetchMock = vi.fn(
      (_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("This operation was aborted", "AbortError")), {
            once: true,
          });
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(briefRequest({ accountName: "Acme" }, { session: testSession() }));
    expect(response.status).toBe(504);
    expect(await response.json()).toMatchObject({ error: "timeout", message: expect.stringContaining("took longer than") });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries 529 overloaded up to 2 times, then reports the error", async () => {
    const overloaded = () =>
      new Response(JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }), {
        status: 529,
        headers: { "content-type": "application/json", "retry-after-ms": "1" },
      });

    const recovered = mockFetch([overloaded(), successMessage]);
    const ok = await POST(briefRequest({ accountName: "Acme" }, { session: testSession() }));
    expect(ok.status).toBe(200);
    expect(recovered.anthropicCalls).toHaveLength(2);

    const exhausted = mockFetch([overloaded(), overloaded(), overloaded()]);
    const failed = await POST(briefRequest({ accountName: "Acme" }, { session: testSession() }));
    expect(failed.status).toBe(502);
    expect(await failed.json()).toMatchObject({ error: "anthropic_error" });
    expect(exhausted.anthropicCalls).toHaveLength(3);
  });

  it("logs one line per tool call with no token, header or tool input", async () => {
    const session = testSession();
    mockFetch([successMessage]);

    const response = await POST(briefRequest({ accountName: "Acme" }, { session }));
    expect(response.status).toBe(200);

    const lines = consoleSpies.flatMap((spy) => spy.mock.calls.map((args) => args.map(String).join(" ")));
    const everything = lines.join("\n");
    expect(everything).not.toContain(session.tokens.accessToken);
    expect(everything).not.toContain(session.tokens.refreshToken);
    expect(everything).not.toMatch(/authorization|bearer/i);
    expect(everything).not.toContain(soqlArgs.query);

    expect(lines.map((line) => JSON.parse(line) as unknown)).toEqual([
      { event: "mcp_tool_use", server: CUSTOM_SERVER, tool: "getAccountHealth", ms: expect.any(Number) },
      { event: "mcp_tool_use", server: SOBJECT_SERVER, tool: "soqlQuery", ms: expect.any(Number) },
    ]);
  });
});
