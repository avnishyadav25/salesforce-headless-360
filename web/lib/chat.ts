/**
 * One chat turn: validate the browser's request, add the new user message (or the
 * answer to a pending write proposal), stream Claude's reply, and describe what the
 * MCP tools did.
 */
import Anthropic from "@anthropic-ai/sdk";
import type {
  BetaContentBlock,
  BetaContentBlockParam,
  BetaMessage,
  BetaMessageParam,
  BetaMessageStreamParams,
  BetaToolResultBlockParam,
  BetaToolUseBlockParam,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { AppConfig } from "./config";
import { isWriteTool, PROPOSE_WRITE_TOOL, serverNames } from "./anthropic";
import type { ApprovedWrite, ChatRequestBody, ChatStreamEvent, Proposal, WriteAudit } from "./chat-types";

export const MAX_MESSAGES = 200;
export const MAX_USER_TEXT = 4000;
export const MAX_PAUSE_CONTINUATIONS = 3;
const MAX_TRACE_TEXT = 20_000;

export class ChatInputError extends Error {
  constructor(message: string, public readonly status = 400) {
    super(message);
    this.name = "ChatInputError";
  }
}

// ---------------------------------------------------------------------------
// Request validation and turn preparation
// ---------------------------------------------------------------------------

export function validateChatBody(raw: unknown): ChatRequestBody {
  if (!raw || typeof raw !== "object") throw new ChatInputError("Body must be a JSON object.");
  const body = raw as Record<string, unknown>;

  const messages = body.messages ?? [];
  if (!Array.isArray(messages) || messages.length > MAX_MESSAGES) {
    throw new ChatInputError(`messages must be an array of at most ${MAX_MESSAGES} items.`);
  }
  for (const message of messages) {
    const candidate = message as { role?: unknown; content?: unknown } | null;
    const roleOk = candidate?.role === "user" || candidate?.role === "assistant";
    const contentOk = typeof candidate?.content === "string" || Array.isArray(candidate?.content);
    if (!roleOk || !contentOk) throw new ChatInputError("Each message needs a user/assistant role and content.");
  }

  const hasText = typeof body.userText === "string";
  const hasDecision = body.decision !== undefined;
  if (hasText === hasDecision) throw new ChatInputError("Send exactly one of userText or decision.");

  if (hasText) {
    const userText = (body.userText as string).trim();
    if (!userText) throw new ChatInputError("userText is empty.");
    if (userText.length > MAX_USER_TEXT) throw new ChatInputError(`userText is longer than ${MAX_USER_TEXT} characters.`);
    return { messages: messages as BetaMessageParam[], userText };
  }

  const decision = body.decision as { toolUseId?: unknown; approve?: unknown } | null;
  if (!decision || typeof decision.toolUseId !== "string" || typeof decision.approve !== "boolean") {
    throw new ChatInputError("decision needs toolUseId (string) and approve (boolean).");
  }
  return { messages: messages as BetaMessageParam[], decision: { toolUseId: decision.toolUseId, approve: decision.approve } };
}

/** Client-side tool_use blocks in the last assistant message still waiting for a tool_result. */
export function pendingToolUses(messages: BetaMessageParam[]): BetaToolUseBlockParam[] {
  const last = messages.at(-1);
  if (!last || last.role !== "assistant" || typeof last.content === "string") return [];
  return last.content.filter((block): block is BetaToolUseBlockParam => block.type === "tool_use");
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function parseProposal(block: { id: string; input: unknown }, config: AppConfig): Proposal {
  const input = asRecord(block.input);
  const server = typeof input.server === "string" ? input.server : "";
  const tool = typeof input.tool === "string" ? input.tool : "";
  const summary = typeof input.summary === "string" ? input.summary.trim() : "";
  const proposal: Proposal = { toolUseId: block.id, server, tool, arguments: asRecord(input.arguments), summary };

  if (!serverNames(config).includes(server)) {
    proposal.problem = `Unknown MCP server "${server}".`;
  } else if (!isWriteTool(config, server, tool)) {
    proposal.problem = `"${tool}" is not a configured write tool on ${server}.`;
  } else if (!summary) {
    proposal.problem = "The proposal has no summary.";
  }
  return proposal;
}

function toolResult(toolUseId: string, content: string, isError = false): BetaToolResultBlockParam {
  return { type: "tool_result", tool_use_id: toolUseId, content, ...(isError ? { is_error: true } : {}) };
}

export interface PreparedTurn {
  /** Full transcript to send to Claude. */
  messages: BetaMessageParam[];
  /** The user message this request appended (returned to the browser for its transcript). */
  appended: BetaMessageParam;
  /** Set only when the user approved a valid proposal. */
  enabledWrite?: ApprovedWrite;
}

export function prepareTurn(body: ChatRequestBody, config: AppConfig): PreparedTurn {
  const pending = pendingToolUses(body.messages);
  const content: BetaContentBlockParam[] = [];
  let enabledWrite: ApprovedWrite | undefined;

  if (body.decision) {
    const decision = body.decision;
    const target = pending.find((block) => block.id === decision.toolUseId && block.name === PROPOSE_WRITE_TOOL);
    if (!target) throw new ChatInputError("There is no pending proposal with that id.", 409);

    const proposal = parseProposal(target, config);
    if (!decision.approve) {
      content.push(toolResult(target.id, "REJECTED by the user. Do not make this change. Acknowledge briefly."));
    } else if (proposal.problem) {
      content.push(
        toolResult(target.id, `NOT APPROVED: ${proposal.problem} Propose a valid change or explain why it cannot be done.`, true),
      );
    } else {
      enabledWrite = { server: proposal.server, tool: proposal.tool, arguments: proposal.arguments };
      content.push(
        toolResult(
          target.id,
          `APPROVED by the user. Call ${proposal.tool} on ${proposal.server} now, exactly once, with exactly these ` +
            `arguments: ${JSON.stringify(proposal.arguments)}. Then report the outcome.`,
        ),
      );
    }
    for (const block of pending) {
      if (block.id !== target.id) {
        content.push(toolResult(block.id, "NOT APPROVED: only one change can be approved at a time. Propose it again if still needed."));
      }
    }
  } else {
    for (const block of pending) {
      content.push(toolResult(block.id, "NOT APPROVED: the user sent a new message instead of approving this change."));
    }
    content.push({ type: "text", text: body.userText ?? "" });
  }

  const appended: BetaMessageParam = { role: "user", content };
  return { messages: [...body.messages, appended], appended, enabledWrite };
}

// ---------------------------------------------------------------------------
// Streaming one turn
// ---------------------------------------------------------------------------

function flattenToolResult(content: string | Array<{ type: string; text?: string }>): string {
  const text = typeof content === "string" ? content : content.map((part) => part.text ?? `[${part.type}]`).join("\n");
  return text.length > MAX_TRACE_TEXT ? `${text.slice(0, MAX_TRACE_TEXT)}\n... (truncated for display)` : text;
}

function emitBlock(block: BetaContentBlock, emit: (event: ChatStreamEvent) => void): void {
  switch (block.type) {
    case "mcp_tool_use":
      emit({ type: "tool_call", id: block.id, server: block.server_name, name: block.name, input: block.input });
      break;
    case "mcp_tool_result":
      emit({ type: "tool_result", toolUseId: block.tool_use_id, isError: block.is_error, text: flattenToolResult(block.content) });
      break;
    case "thinking":
      if (block.thinking) emit({ type: "thinking", text: block.thinking });
      break;
    default:
      break;
  }
}

/** Plain JSON copy of response blocks, safe to send back as the next request's history. */
function toParamContent(content: BetaContentBlock[]): BetaContentBlockParam[] {
  return JSON.parse(JSON.stringify(content)) as BetaContentBlockParam[];
}

export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function auditWrites(messages: BetaMessageParam[], approved: ApprovedWrite, config: AppConfig): WriteAudit {
  const executed: WriteAudit["executed"] = [];
  for (const message of messages) {
    if (typeof message.content === "string") continue;
    for (const block of message.content) {
      if (block.type !== "mcp_tool_use" || !isWriteTool(config, block.server_name, block.name)) continue;
      executed.push({
        server: block.server_name,
        tool: block.name,
        input: block.input,
        matchesApproval:
          block.server_name === approved.server &&
          block.name === approved.tool &&
          stableStringify(block.input) === stableStringify(approved.arguments),
      });
    }
  }
  return { approved, executed };
}

export interface RunTurnInput {
  client: Anthropic;
  params: BetaMessageStreamParams;
  config: AppConfig;
  emit: (event: ChatStreamEvent) => void;
  signal?: AbortSignal;
  /** Per-request override of the client's retry count (the SDK retries 408/409/429/5xx). */
  maxRetries?: number;
}

export interface TurnResult {
  assistantMessages: BetaMessageParam[];
  final: BetaMessage;
  proposals: Proposal[];
  usage: { inputTokens: number; outputTokens: number; cacheReadInputTokens: number };
}

export async function runTurn({ client, params, config, emit, signal, maxRetries }: RunTurnInput): Promise<TurnResult> {
  const assistantMessages: BetaMessageParam[] = [];
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0 };
  let messages = params.messages;
  let final: BetaMessage | undefined;

  for (let attempt = 0; attempt <= MAX_PAUSE_CONTINUATIONS; attempt += 1) {
    const stream = client.beta.messages.stream({ ...params, messages }, { signal, maxRetries });
    stream.on("text", (delta) => emit({ type: "text", text: delta }));
    stream.on("contentBlock", (block) => emitBlock(block, emit));
    final = await stream.finalMessage();

    usage.inputTokens += final.usage.input_tokens;
    usage.outputTokens += final.usage.output_tokens;
    usage.cacheReadInputTokens += final.usage.cache_read_input_tokens ?? 0;

    const assistant: BetaMessageParam = { role: "assistant", content: toParamContent(final.content) };
    assistantMessages.push(assistant);

    // The server-side tool loop can pause a long turn; sending the partial turn back resumes it.
    if (final.stop_reason !== "pause_turn") break;
    messages = [...messages, assistant];
  }

  const proposals: Proposal[] = [];
  const lastAssistant = assistantMessages.at(-1);
  if (final?.stop_reason === "tool_use" && lastAssistant) {
    for (const block of pendingToolUses([lastAssistant])) {
      if (block.name !== PROPOSE_WRITE_TOOL) continue;
      const proposal = parseProposal(block, config);
      proposals.push(proposal);
      emit({ type: "proposal", proposal });
    }
  }

  if (!final) throw new Error("No response from the model.");
  return { assistantMessages, final, proposals, usage };
}

export function describeError(error: unknown): { message: string; code: string } {
  if (error instanceof Anthropic.APIUserAbortError) return { message: "Request cancelled.", code: "aborted" };
  if (error instanceof Anthropic.AuthenticationError) {
    return { message: "Anthropic rejected the API key. Check ANTHROPIC_API_KEY.", code: "anthropic_auth" };
  }
  if (error instanceof Anthropic.RateLimitError) {
    return { message: "The Anthropic API is rate limiting this key. Try again shortly.", code: "rate_limited" };
  }
  if (error instanceof Anthropic.BadRequestError) {
    // MCP connection problems (bad URL, rejected token, server not activated) surface here.
    return { message: `The Anthropic API rejected the request: ${error.message}`, code: "bad_request" };
  }
  if (error instanceof Anthropic.APIError) {
    return { message: `Anthropic API error${error.status ? ` ${error.status}` : ""}: ${error.message}`, code: "anthropic_error" };
  }
  if (error instanceof Anthropic.AnthropicError) {
    return { message: error.message, code: "anthropic_client" };
  }
  return { message: "Unexpected server error. See the server log.", code: "internal" };
}
