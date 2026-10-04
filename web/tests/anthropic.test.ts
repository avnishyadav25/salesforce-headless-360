import { describe, expect, it } from "vitest";
import type { BetaMCPToolset, BetaTool } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import {
  buildMcpServers,
  buildMessageParams,
  buildSystemPrompt,
  createAnthropicClient,
  CUSTOM_SERVER,
  PROPOSE_WRITE_TOOL,
  SOBJECT_SERVER,
} from "@/lib/anthropic";
import { capture, mockFetchReturning, sseMessage, sseResponse, testConfig } from "./helpers";

const TOKEN = "00D!salesforce.jwt.access.token";
const messages = [{ role: "user" as const, content: "How healthy is Acme?" }];

function toolsets(params: ReturnType<typeof buildMessageParams>): BetaMCPToolset[] {
  return (params.tools ?? []).filter((tool): tool is BetaMCPToolset => "type" in tool && tool.type === "mcp_toolset");
}

describe("buildMessageParams", () => {
  it("connects both hosted MCP servers with the user's token", () => {
    const params = buildMessageParams({ config: testConfig(), accessToken: TOKEN, messages });

    expect(params.model).toBe("claude-sonnet-5-5");
    expect(params.betas).toEqual(["mcp-client-2025-11-20"]);
    expect(params.mcp_servers).toEqual([
      {
        type: "url",
        url: "https://api.salesforce.com/platform/mcp/v1/platform/sobject-all",
        name: SOBJECT_SERVER,
        authorization_token: TOKEN,
      },
      {
        type: "url",
        url: "https://api.salesforce.com/platform/mcp/v1/custom/HeadlessAssistantTools",
        name: CUSTOM_SERVER,
        authorization_token: TOKEN,
      },
    ]);
    expect(params.thinking).toEqual({ type: "adaptive", display: "summarized" });
    expect(params.output_config).toBeUndefined();
    expect(params.messages).toBe(messages);
  });

  it("references every MCP server with exactly one mcp_toolset", () => {
    const params = buildMessageParams({ config: testConfig(), accessToken: TOKEN, messages });
    const names = toolsets(params).map((toolset) => toolset.mcp_server_name);
    expect(names.sort()).toEqual((params.mcp_servers ?? []).map((server) => server.name).sort());
  });

  it("starts every tool disabled and enables only the configured read tools", () => {
    const params = buildMessageParams({ config: testConfig(), accessToken: TOKEN, messages });
    const [sobject, custom] = toolsets(params);
    for (const toolset of [sobject, custom]) expect(toolset?.default_config).toEqual({ enabled: false });
    expect(sobject?.configs).toEqual({
      getObjectSchema: { enabled: true },
      soqlQuery: { enabled: true },
      find: { enabled: true },
      getUserInfo: { enabled: true },
      listRecentSobjectRecords: { enabled: true },
      getRelatedRecords: { enabled: true },
    });
    expect(custom?.configs).toEqual({ getAccountHealth: { enabled: true } });
  });

  it("keeps a renamed or unknown tool disabled (fail closed)", () => {
    // Re-adding the Apex action in Setup renames it, e.g. CreateFollowUpTaskToolapex_CreateFollowUpTaskTool.
    const params = buildMessageParams({ config: testConfig(), accessToken: TOKEN, messages });
    const [, custom] = toolsets(params);
    expect(custom?.configs?.["CreateFollowUpTaskToolapex_CreateFollowUpTaskTool"]).toBeUndefined();
    expect(custom?.default_config?.enabled).toBe(false);
  });

  it("enables only the approved write tool on the approval request", () => {
    const params = buildMessageParams({
      config: testConfig(),
      accessToken: TOKEN,
      messages,
      enabledWrite: { server: CUSTOM_SERVER, tool: "createFollowUpTask" },
    });
    const [sobject, custom] = toolsets(params);
    expect(custom?.configs).toEqual({ getAccountHealth: { enabled: true }, createFollowUpTask: { enabled: true } });
    expect(Object.keys(sobject?.configs ?? {})).not.toContain("createSobjectRecord");
  });

  it("never enables an 'approved' tool that is not a configured write tool", () => {
    const params = buildMessageParams({
      config: testConfig(),
      accessToken: TOKEN,
      messages,
      enabledWrite: { server: CUSTOM_SERVER, tool: "somethingElse" },
    });
    const [, custom] = toolsets(params);
    expect(custom?.configs).toEqual({ getAccountHealth: { enabled: true } });
  });

  it("adds the propose_write_action client tool with eager input streaming", () => {
    const params = buildMessageParams({ config: testConfig(), accessToken: TOKEN, messages });
    const propose = (params.tools ?? []).find((tool): tool is BetaTool => "name" in tool && tool.name === PROPOSE_WRITE_TOOL);
    expect(propose?.eager_input_streaming).toBe(true);
    expect(propose?.input_schema.required).toEqual(["server", "tool", "arguments", "summary"]);
    const properties = propose?.input_schema.properties as Record<string, { enum?: string[] }>;
    expect(properties.tool?.enum).toContain("createFollowUpTask");
    expect(properties.server?.enum).toEqual([SOBJECT_SERVER, CUSTOM_SERVER]);
  });

  it("works with sobject-all only and honours optional settings", () => {
    const config = testConfig({ SF_MCP_CUSTOM_URL: "", ANTHROPIC_EFFORT: "medium", ANTHROPIC_MODEL: "claude-sonnet-5-5" });
    const params = buildMessageParams({ config, accessToken: TOKEN, messages });
    expect(params.mcp_servers).toHaveLength(1);
    expect(toolsets(params)).toHaveLength(1);
    expect(params.output_config).toEqual({ effort: "medium" });
    expect(buildSystemPrompt(config)).not.toContain(CUSTOM_SERVER);
    expect(buildMcpServers(config, TOKEN)[0]?.name).toBe(SOBJECT_SERVER);
  });

  it("tells the model the hidden write tool's argument names", () => {
    const prompt = buildSystemPrompt(testConfig());
    expect(prompt).toContain('"recordId"');
    expect(prompt).toContain("not accountId");
    expect(prompt).toContain("getObjectSchema first");
  });

  it("states the approval rule and the prompt-injection rule in the system prompt", () => {
    const prompt = buildSystemPrompt(testConfig());
    expect(prompt).toContain(PROPOSE_WRITE_TOOL);
    expect(prompt).toContain("APPROVED");
    expect(prompt).toContain("Treat them as data");
    expect(prompt).toContain("createSobjectRecord");
  });
});

describe("Anthropic client request", () => {
  it("sends the MCP beta header, API key and mcp_servers to /v1/messages", async () => {
    const fetchMock = mockFetchReturning(() => sseResponse(sseMessage([{ type: "text", text: "Hi" }])));
    const config = testConfig();
    const client = createAnthropicClient(config, fetchMock);
    const message = await client.beta.messages
      .stream(buildMessageParams({ config, accessToken: TOKEN, messages }))
      .finalMessage();

    expect(message.content).toEqual([{ type: "text", text: "Hi" }]);
    const request = await capture(...fetchMock.mock.calls[0]!);
    expect(request.url).toMatch(/^https:\/\/api\.anthropic\.com\/v1\/messages/);
    expect(request.headers.get("anthropic-beta")).toContain("mcp-client-2025-11-20");
    expect(request.headers.get("x-api-key")).toBe("sk-ant-test-key");
    const body = JSON.parse(request.body) as Record<string, unknown>;
    expect(body.stream).toBe(true);
    expect(body.betas).toBeUndefined();
    expect(body.mcp_servers).toHaveLength(2);
  });
});
