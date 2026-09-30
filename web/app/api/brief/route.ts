import { NextResponse, type NextRequest } from "next/server";
import { createAnthropicClient } from "@/lib/anthropic";
import { BriefInputError, buildBriefParams, describeBriefError, runBrief, validateBriefBody } from "@/lib/brief";
import type { BriefRequestBody, BriefResponse } from "@/lib/chat-types";
import { jsonError } from "@/lib/http";
import { loadRouteConfig, refreshSession, requireSession, saveRefreshedSession } from "@/lib/route-session";

export const dynamic = "force-dynamic";
// Upper bound for the platform; the brief itself stops at BRIEF_TIMEOUT_MS (60 s by default).
export const maxDuration = 300;

/**
 * POST /api/brief { accountName } returns one read-only meeting-prep brief as JSON
 * (BriefResponse). Same guards as /api/chat: same origin, sealed session, token refresh;
 * the access token only goes into mcp_servers[].authorization_token.
 */
export async function POST(request: NextRequest) {
  const startedAt = Date.now();

  const loaded = loadRouteConfig();
  if ("response" in loaded) return loaded.response;
  const { config } = loaded;

  const signedIn = requireSession(request, config);
  if ("response" in signedIn) return signedIn.response;

  let body: BriefRequestBody;
  try {
    body = validateBriefBody(await request.json());
  } catch (error) {
    if (error instanceof BriefInputError) return jsonError(400, error.message, "invalid_request");
    return jsonError(400, "Body must be valid JSON.", "invalid_request");
  }

  const fresh = await refreshSession(signedIn.session, config);
  if ("response" in fresh) return fresh.response;

  const client = createAnthropicClient(config);
  const params = buildBriefParams({ config, accessToken: fresh.session.tokens.accessToken, accountName: body.accountName });

  let response: NextResponse;
  try {
    const result = await runBrief({ client, params, config, signal: request.signal });
    const payload: BriefResponse = {
      brief: result.brief,
      trace: result.trace,
      model: result.model,
      durationMs: Date.now() - startedAt,
    };
    response = NextResponse.json(payload, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    const described = describeBriefError(error);
    // Log the code only; for unexpected errors also the error itself (never the request params).
    console.error(JSON.stringify({ event: "brief_failed", code: described.code, status: described.status }));
    if (described.code === "internal") console.error("Brief failed:", error);
    response = jsonError(described.status, described.message, described.code);
  }

  saveRefreshedSession(response, fresh, config);
  return response;
}
