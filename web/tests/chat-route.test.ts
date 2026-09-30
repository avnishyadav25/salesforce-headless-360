import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/chat/route";
import { CUSTOM_SERVER, PROPOSE_WRITE_TOOL, SOBJECT_SERVER } from "@/lib/anthropic";
import type { BetaMessageParam, ChatStreamEvent } from "@/lib/chat-types";
import { readNdjson } from "@/lib/ndjson";
import { chunkName, readSession, sealSession, SESSION_COOKIE, splitIntoChunks, type SessionData } from "@/lib/session";
import { capture, fakeJwt, sseMessage, sseResponse, stubTestEnv, TEST_ENV, testSession, type CapturedRequest } from "./helpers";

const ORIGIN = "http://localhost:3000";

function sessionCookie(session: SessionData): string {
  return splitIntoChunks(sealSession(session, TEST_ENV.SESSION_SECRET!))
    .map((chunk, index) => `${chunkName(SESSION_COOKIE, index)}=${chunk}`)
    .join("; ");
}

function chatRequest(body: unknown, { session, origin = ORIGIN }: { session?: SessionData; origin?: string } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json", origin };
  if (session) headers.cookie = sessionCookie(session);
  return new NextRequest(`${ORIGIN}/api/chat`, { method: "POST", headers, body: JSON.stringify(body) });
}

async function readEvents(response: Response): Promise<ChatStreamEvent[]> {
  const events: ChatStreamEvent[] = [];
  if (response.body) await readNdjson<ChatStreamEvent>(response.body, (event) => events.push(event));
  return events;
}

/** Routes mocked fetch calls: Salesforce token endpoint vs. Anthropic Messages API. */
function mockFetch(anthropicBodies: string[], salesforceToken?: string) {
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
      const body = anthropicBodies.shift();
      if (body === undefined) throw new Error("Unexpected extra Anthropic call");
      return sseResponse(body);
    }
    throw new Error(`Unexpected fetch to ${request.url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, anthropicCalls, salesforceCalls };
}

const healthArgs = { accountName: "Acme" };
const healthResult = JSON.stringify({ accountName: "Acme Corporation", healthStatus: "Watch", healthScore: 60 });

describe("POST /api/chat", () => {
  beforeEach(() => {
    stubTestEnv();
  });

  it("streams text and MCP tool calls, and keeps the Salesforce token server-side", async () => {
    const session = testSession();
    const { anthropicCalls, salesforceCalls } = mockFetch([
      sseMessage(
        [
          { type: "text", text: "Checking Acme. " },
          { type: "mcp_tool_use", id: "mcptoolu_1", name: "getAccountHealth", server_name: CUSTOM_SERVER, input: healthArgs },
          { type: "mcp_tool_result", tool_use_id: "mcptoolu_1", is_error: false, content: [{ type: "text", text: healthResult }] },
          { type: "text", text: "Acme Corporation is on Watch (60/100)." },
        ],
        "end_turn",
      ),
    ]);

    const response = await POST(chatRequest({ messages: [], userText: "How healthy is Acme?" }, { session }));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/x-ndjson");
    const events = await readEvents(response);

    expect(salesforceCalls).toHaveLength(0);
    expect(events[0]).toEqual({ type: "start", model: "claude-sonnet-5-5", tokenRefreshed: false, writeEnabled: null });
    expect(events.filter((event) => event.type === "text").map((event) => (event.type === "text" ? event.text : "")).join("")).toBe(
      "Checking Acme. Acme Corporation is on Watch (60/100).",
    );
    expect(events).toContainEqual({ type: "tool_call", id: "mcptoolu_1", server: CUSTOM_SERVER, name: "getAccountHealth", input: healthArgs });
    expect(events).toContainEqual({ type: "tool_result", toolUseId: "mcptoolu_1", isError: false, text: healthResult });

    const done = events.at(-1);
    expect(done?.type).toBe("done");
    if (done?.type !== "done") throw new Error("expected done");
    expect(done.stopReason).toBe("end_turn");
    expect(done.newMessages).toHaveLength(2);
    expect(done.newMessages[0]).toEqual({ role: "user", content: [{ type: "text", text: "How healthy is Acme?" }] });
    expect(done.newMessages[1]?.role).toBe("assistant");

    // Outgoing Anthropic request: MCP connector beta + the user's token on both servers.
    expect(anthropicCalls).toHaveLength(1);
    const outgoing = anthropicCalls[0]!;
    expect(outgoing.headers.get("anthropic-beta")).toContain("mcp-client-2025-11-20");
    const body = JSON.parse(outgoing.body) as {
      model: string;
      mcp_servers: Array<{ name: string; authorization_token: string }>;
      tools: Array<Record<string, unknown>>;
    };
    expect(body.model).toBe("claude-sonnet-5-5");
    expect(body.mcp_servers.map((server) => server.name)).toEqual([SOBJECT_SERVER, CUSTOM_SERVER]);
    expect(body.mcp_servers.every((server) => server.authorization_token === session.tokens.accessToken)).toBe(true);
    expect(body.tools.filter((tool) => tool.type === "mcp_toolset")).toHaveLength(2);

    // The browser never receives the access or refresh token.
    const streamed = JSON.stringify(events);
    expect(streamed).not.toContain(session.tokens.accessToken);
    expect(streamed).not.toContain(session.tokens.refreshToken);
  });

  it("returns 401 without a session and 403 for cross-origin requests", async () => {
    mockFetch([]);
    const anonymous = await POST(chatRequest({ messages: [], userText: "hi" }));
    expect(anonymous.status).toBe(401);
    expect(await anonymous.json()).toMatchObject({ error: "not_signed_in" });

    const crossSite = await POST(chatRequest({ messages: [], userText: "hi" }, { session: testSession(), origin: "https://evil.example" }));
    expect(crossSite.status).toBe(403);
  });

  it("validates the request body", async () => {
    mockFetch([]);
    const both = await POST(
      chatRequest({ messages: [], userText: "hi", decision: { toolUseId: "x", approve: true } }, { session: testSession() }),
    );
    expect(both.status).toBe(400);
    const orphanDecision = await POST(chatRequest({ messages: [], decision: { toolUseId: "x", approve: true } }, { session: testSession() }));
    expect(orphanDecision.status).toBe(409);
  });

  it("refreshes a stale access token before calling Anthropic and re-seals the session", async () => {
    const now = Date.now();
    const newToken = fakeJwt({ sub: "005000000000001AAA", exp: Math.floor(now / 1000) + 3600, n: 2 });
    const stale = testSession({ issuedAt: now - 3_600_000, expiresAt: now - 1000 });
    const { anthropicCalls, salesforceCalls } = mockFetch([sseMessage([{ type: "text", text: "ok" }])], newToken);

    const response = await POST(chatRequest({ messages: [], userText: "hi" }, { session: stale }));
    const events = await readEvents(response);

    expect(salesforceCalls).toHaveLength(1);
    expect(new URLSearchParams(salesforceCalls[0]!.body).get("grant_type")).toBe("refresh_token");
    expect(events[0]).toMatchObject({ type: "start", tokenRefreshed: true });
    const body = JSON.parse(anthropicCalls[0]!.body) as { mcp_servers: Array<{ authorization_token: string }> };
    expect(body.mcp_servers.every((server) => server.authorization_token === newToken)).toBe(true);

    const refreshed = readSession({ get: (name) => response.cookies.get(name) }, TEST_ENV.SESSION_SECRET!);
    expect(refreshed?.tokens.accessToken).toBe(newToken);
    expect(refreshed?.tokens.refreshToken).toBe(stale.tokens.refreshToken);
  });

  it("asks for approval before a write, then enables only the approved tool", async () => {
    const session = testSession();
    const taskArgs = { recordId: "001000000000001AAA", subject: "Send renewal quote", dueDate: "2026-10-09", priority: "High" };
    const proposalInput = {
      server: CUSTOM_SERVER,
      tool: "createFollowUpTask",
      arguments: taskArgs,
      summary: "Create a High priority task 'Send renewal quote' on Acme due 2026-10-09.",
    };
    const { anthropicCalls } = mockFetch([
      sseMessage(
        [
          { type: "text", text: "I'll propose that task." },
          { type: "tool_use", id: "toolu_propose_1", name: PROPOSE_WRITE_TOOL, input: proposalInput },
        ],
        "tool_use",
      ),
      sseMessage(
        [
          { type: "mcp_tool_use", id: "mcptoolu_9", name: "createFollowUpTask", server_name: CUSTOM_SERVER, input: taskArgs },
          {
            type: "mcp_tool_result",
            tool_use_id: "mcptoolu_9",
            is_error: false,
            content: [{ type: "text", text: '{"success":true,"taskId":"00T000000000001AAA"}' }],
          },
          { type: "text", text: "Created task 00T000000000001AAA." },
        ],
        "end_turn",
      ),
    ]);

    // Turn 1: the model proposes; nothing is written.
    const first = await readEvents(await POST(chatRequest({ messages: [], userText: "Create a follow-up task on Acme" }, { session })));
    const proposalEvent = first.find((event) => event.type === "proposal");
    expect(proposalEvent).toEqual({
      type: "proposal",
      proposal: {
        toolUseId: "toolu_propose_1",
        server: CUSTOM_SERVER,
        tool: "createFollowUpTask",
        arguments: taskArgs,
        summary: proposalInput.summary,
      },
    });
    const firstDone = first.at(-1);
    if (firstDone?.type !== "done") throw new Error("expected done");
    expect(firstDone.stopReason).toBe("tool_use");
    const firstBody = JSON.parse(anthropicCalls[0]!.body) as { tools: Array<{ type?: string; mcp_server_name?: string; configs?: object }> };
    expect(firstBody.tools.find((tool) => tool.mcp_server_name === CUSTOM_SERVER)?.configs).toEqual({
      createFollowUpTask: { enabled: false },
    });

    // Turn 2: the user approves.
    const transcript: BetaMessageParam[] = firstDone.newMessages;
    const second = await readEvents(
      await POST(chatRequest({ messages: transcript, decision: { toolUseId: "toolu_propose_1", approve: true } }, { session })),
    );
    expect(second[0]).toMatchObject({ type: "start", writeEnabled: { server: CUSTOM_SERVER, tool: "createFollowUpTask" } });

    const secondBody = JSON.parse(anthropicCalls[1]!.body) as {
      messages: BetaMessageParam[];
      tools: Array<{ type?: string; mcp_server_name?: string; configs?: Record<string, { enabled: boolean }> }>;
    };
    const lastMessage = secondBody.messages.at(-1);
    expect(lastMessage?.role).toBe("user");
    const toolResult = Array.isArray(lastMessage?.content) ? lastMessage.content[0] : undefined;
    expect(toolResult).toMatchObject({ type: "tool_result", tool_use_id: "toolu_propose_1" });
    expect(JSON.stringify(toolResult)).toContain("APPROVED");
    expect(secondBody.tools.find((tool) => tool.mcp_server_name === CUSTOM_SERVER)?.configs).toBeUndefined();
    const sobjectConfigs = secondBody.tools.find((tool) => tool.mcp_server_name === SOBJECT_SERVER)?.configs ?? {};
    expect(Object.values(sobjectConfigs).every((config) => config.enabled === false)).toBe(true);

    const secondDone = second.at(-1);
    if (secondDone?.type !== "done") throw new Error("expected done");
    expect(secondDone.audit).toEqual({
      approved: { server: CUSTOM_SERVER, tool: "createFollowUpTask", arguments: taskArgs },
      executed: [{ server: CUSTOM_SERVER, tool: "createFollowUpTask", input: taskArgs, matchesApproval: true }],
    });
  });

  it("answers a pending proposal automatically when the user sends a new message instead", async () => {
    const { anthropicCalls } = mockFetch([sseMessage([{ type: "text", text: "Okay, not creating it." }])]);
    const transcript: BetaMessageParam[] = [
      { role: "user", content: "Create a task" },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_pending",
            name: PROPOSE_WRITE_TOOL,
            input: { server: CUSTOM_SERVER, tool: "createFollowUpTask", arguments: {}, summary: "x" },
          },
        ],
      },
    ];
    await readEvents(await POST(chatRequest({ messages: transcript, userText: "Actually, never mind" }, { session: testSession() })));
    const body = JSON.parse(anthropicCalls[0]!.body) as { messages: BetaMessageParam[] };
    const content = body.messages.at(-1)?.content;
    expect(Array.isArray(content) && content[0]).toMatchObject({ type: "tool_result", tool_use_id: "toolu_pending" });
    expect(Array.isArray(content) && content[1]).toEqual({ type: "text", text: "Actually, never mind" });
  });

  it("streams an error event when the Anthropic API rejects the request", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "MCP server connection failed" } }),
            { status: 400, headers: { "content-type": "application/json" } },
          ),
      ),
    );
    const events = await readEvents(await POST(chatRequest({ messages: [], userText: "hi" }, { session: testSession() })));
    const error = events.at(-1);
    expect(error).toMatchObject({ type: "error", code: "bad_request" });
    expect(error?.type === "error" && error.message).toContain("MCP server connection failed");
  });
});
