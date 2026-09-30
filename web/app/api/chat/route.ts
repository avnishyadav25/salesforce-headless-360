import { NextResponse, type NextRequest } from "next/server";
import { buildMessageParams, createAnthropicClient } from "@/lib/anthropic";
import type { ChatRequestBody, ChatStreamEvent } from "@/lib/chat-types";
import { auditWrites, ChatInputError, describeError, prepareTurn, runTurn, validateChatBody, type PreparedTurn } from "@/lib/chat";
import { ConfigError, loadConfig } from "@/lib/config";
import { isSameOrigin, jsonError } from "@/lib/http";
import { ensureFreshSession, ReauthenticationRequired } from "@/lib/salesforce-oauth";
import { clearSession, readSession, writeSession } from "@/lib/session";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * POST /api/chat streams newline-delimited JSON (ChatStreamEvent) back to the browser.
 * The Salesforce access token is read from the encrypted session here and only placed
 * in the Anthropic request's mcp_servers[].authorization_token; the browser never sees it.
 */
export async function POST(request: NextRequest) {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    return jsonError(500, error instanceof ConfigError ? error.message : "Configuration error.", "config");
  }

  if (!isSameOrigin(request)) {
    return jsonError(403, "Cross-origin requests are not allowed.", "forbidden");
  }

  const session = readSession(request.cookies, config.sessionSecret);
  if (!session) {
    return jsonError(401, "Sign in with Salesforce first.", "not_signed_in");
  }

  let body: ChatRequestBody;
  let prepared: PreparedTurn;
  try {
    body = validateChatBody(await request.json());
    prepared = prepareTurn(body, config);
  } catch (error) {
    if (error instanceof ChatInputError) return jsonError(error.status, error.message, "invalid_request");
    return jsonError(400, "Body must be valid JSON.", "invalid_request");
  }

  let fresh;
  try {
    fresh = await ensureFreshSession(session, config);
  } catch (error) {
    if (error instanceof ReauthenticationRequired) {
      const response = jsonError(401, error.message, "reauth_required");
      clearSession(response, config.secureCookies);
      return response;
    }
    return jsonError(502, "Could not reach Salesforce to refresh the session.", "salesforce_unreachable");
  }

  const client = createAnthropicClient(config);
  const params = buildMessageParams({
    config,
    accessToken: fresh.session.tokens.accessToken,
    messages: prepared.messages,
    enabledWrite: prepared.enabledWrite,
  });

  const encoder = new TextEncoder();
  let closed = false;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (event: ChatStreamEvent) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        } catch {
          closed = true; // the browser went away
        }
      };
      emit({
        type: "start",
        model: config.anthropic.model,
        tokenRefreshed: fresh.refreshed,
        writeEnabled: prepared.enabledWrite ? { server: prepared.enabledWrite.server, tool: prepared.enabledWrite.tool } : null,
      });
      try {
        const result = await runTurn({ client, params, config, emit, signal: request.signal });
        emit({
          type: "done",
          newMessages: [prepared.appended, ...result.assistantMessages],
          stopReason: result.final.stop_reason,
          usage: result.usage,
          audit: prepared.enabledWrite ? auditWrites(result.assistantMessages, prepared.enabledWrite, config) : undefined,
        });
      } catch (error) {
        const described = describeError(error);
        if (described.code === "internal") console.error("Chat turn failed:", error);
        emit({ type: "error", ...described });
      } finally {
        if (!closed) {
          closed = true;
          controller.close();
        }
      }
    },
    cancel() {
      closed = true;
    },
  });

  const response = new NextResponse(stream, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-store",
      "x-accel-buffering": "no",
    },
  });
  if (fresh.refreshed) {
    writeSession(response, fresh.session, { secret: config.sessionSecret, secure: config.secureCookies });
  }
  return response;
}
