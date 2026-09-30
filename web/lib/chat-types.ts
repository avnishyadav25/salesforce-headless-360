/**
 * Types shared by the chat route (server) and the chat UI (browser).
 * Type-only imports: nothing here pulls server code into the client bundle.
 */
import type { BetaMessageParam, BetaStopReason } from "@anthropic-ai/sdk/resources/beta/messages/messages";

export type { BetaMessageParam };

/** A write the model wants to make, captured from its propose_write_action call. */
export interface Proposal {
  toolUseId: string;
  /** MCP server name as used in mcp_servers, e.g. "salesforce-sobject". */
  server: string;
  /** MCP tool name on that server, e.g. "createFollowUpTask". */
  tool: string;
  arguments: Record<string, unknown>;
  summary: string;
  /** Set when the proposal names a server/tool that is not a configured write tool. */
  problem?: string;
}

export interface ApprovedWrite {
  server: string;
  tool: string;
  arguments: Record<string, unknown>;
}

/** After an approved turn: did the model execute exactly what the user approved? */
export interface WriteAudit {
  approved: ApprovedWrite;
  executed: Array<{ server: string; tool: string; input: unknown; matchesApproval: boolean }>;
}

export interface ChatDecision {
  toolUseId: string;
  approve: boolean;
}

export interface ChatRequestBody {
  /** Full API transcript so far (the browser keeps it; tokens are never part of it). */
  messages: BetaMessageParam[];
  /** A new user message ... */
  userText?: string;
  /** ... or the user's answer to a pending proposal. Exactly one of the two. */
  decision?: ChatDecision;
}

export interface McpServerInfo {
  name: string;
  label: string;
  url: string;
}

/** Newline-delimited JSON events streamed by POST /api/chat. */
export type ChatStreamEvent =
  | { type: "start"; model: string; tokenRefreshed: boolean; writeEnabled: { server: string; tool: string } | null }
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool_call"; id: string; server: string; name: string; input: unknown }
  | { type: "tool_result"; toolUseId: string; isError: boolean; text: string }
  | { type: "proposal"; proposal: Proposal }
  | {
      type: "done";
      /** Messages to append to the transcript: the user turn this request added, then the assistant turn(s). */
      newMessages: BetaMessageParam[];
      stopReason: BetaStopReason | null;
      usage: { inputTokens: number; outputTokens: number; cacheReadInputTokens: number };
      audit?: WriteAudit;
    }
  | { type: "error"; message: string; code?: string };
