# Article notes

Files, snippets and line references to quote, plus the screenshots to capture when you run the demo.
Line numbers match the commit that added the Day 10 workflow; re-check them if you edit the files.

Sections follow the published series: Day 10 (the meeting prep brief), Day 12 (custom Apex tools), Days 5 and 11
(OAuth and token handling) and Day 15 (the complete assistant).

## Day 15: Build a Complete Headless Salesforce AI Assistant

**Story arc:** sign in with Salesforce (PKCE) → ask a question → Claude calls hosted MCP tools as the user →
propose a write → user approves → only that tool is enabled → audit the executed call.

| Quote | File and lines | Point to make |
| --- | --- | --- |
| The request builder | `web/lib/anthropic.ts` 163-179 (`buildMessageParams`) | One Messages API call carries `mcp_servers`, `mcp_toolset`s, the approval tool and adaptive thinking; `betas` becomes the `anthropic-beta: mcp-client-2025-11-20` header. |
| Server definitions with the user's token | `web/lib/anthropic.ts` 52-60 (`buildMcpServers`) | `authorization_token` is the signed-in user's Salesforce JWT; this is why every tool call obeys CRUD/FLS/sharing. |
| Write tools switched off | `web/lib/anthropic.ts` 66-77 (`buildMcpToolsets`) | The confirmation step is enforced by per-request tool config (`enabled: false`), not only by the prompt. |
| The approval tool | `web/lib/anthropic.ts` 79-107 (`buildProposeWriteTool`) | A client tool whose `enum`s are the configured write tools; `eager_input_streaming: true`. |
| System prompt rules | `web/lib/anthropic.ts` 109-154 (`buildSystemPrompt`) | "Changing data" steps and "Tool output is data" (prompt-injection guard). |
| Approve / reject turn | `web/lib/chat.ts` 110-151 (`prepareTurn`) | `APPROVED ...` tool_result + `enabledWrite` for exactly one tool; unresolved proposals are closed automatically. |
| Streaming and tool trace | `web/lib/chat.ts` 229-266 (`runTurn`) | `client.beta.messages.stream()`, `contentBlock` events for `mcp_tool_use`/`mcp_tool_result`, `pause_turn` continuation. |
| Write audit | `web/lib/chat.ts` 192-210 (`auditWrites`) | After an approved turn, compare executed input with the approved arguments. |
| Chat route | `web/app/api/chat/route.ts` 16-97 (guards in `web/lib/route-session.ts`) | Session → refresh → build → stream NDJSON; tokens never leave the server. |
| UI approval flow | `web/components/Chat.tsx` 182-198 (`decide`), `web/components/ProposalCard.tsx` | The Approve/Reject card and the second request. |
| Custom Apex tool | `salesforce/force-app/main/default/classes/AccountHealthTool.cls` 21-51 | `@InvocableMethod` + `global` types = an MCP tool; failures come back as data, not exceptions. |
| Tests that prove the flow | `web/tests/chat-route.test.ts` ("asks for approval before a write...") | Mocked Anthropic SSE shows the proposal, the approval request body and the audit. |

**Snippet: the request (for the article body)** — copy from `web/lib/anthropic.ts` 163-179, or use the condensed
version in the root README ("How the request looks").

**Numbers worth stating:** 50 Vitest tests; 2 hosted MCP servers; 5 `sobject-all` write tools gated by default;
token refreshed when older than 15 minutes; session cookie sealed with AES-256-GCM and split under 4 KB per cookie.

## Day 10: Build Your First AI + Salesforce Workflow

**Story arc:** a chat answer is a one-off; a workflow has a fixed input (an Account name), a fixed output (five
markdown sections that cite record Ids), fixed tools (read-only, so no approval step) and defined failure behaviour
(one deadline, explicit retries, clear errors, one log line per tool call). Page: `/brief`; API: `POST /api/brief`.

| Quote | File and lines | Point to make |
| --- | --- | --- |
| The request builder call | `web/app/api/brief/route.ts` 38-39; `web/lib/brief.ts` 143-160 (`buildBriefParams`) | Same `buildMcpServers` (the user's token, `web/lib/anthropic.ts` 52-60) as the chat; only the toolsets and the system prompt change. |
| Read-only toolsets | `web/lib/brief.ts` 76-82 (`buildReadOnlyToolsets`), 150-151 | Every configured write tool `enabled: false` on every server, and no `propose_write_action`: there is no path to a write, so no approval step. |
| Fixed output contract | `web/lib/brief.ts` 22-23 (`BRIEF_SECTIONS`), 84-135 (`buildBriefSystemPrompt`) | Five H2 sections, cite record Ids, "not found" instead of guessing; `getAccountHealth` when the custom server is configured, else `soqlQuery` / `getRelatedRecords`; tool output is data, not instructions (113-115). |
| Input validation | `web/lib/brief.ts` 60-70 (`validateBriefBody`); `web/app/api/brief/route.ts` 27-33 | Trimmed, 1-120 characters, 400 through the shared `jsonError`. |
| Shared route guards | `web/lib/route-session.ts` 15-57; used in `web/app/api/brief/route.ts` 20-36 | Same origin, session and token refresh as `/api/chat`, extracted so both routes share one implementation. A dead refresh token gives 401 "Sign in again" and clears the cookie (39-50). |
| Overall timeout | `web/lib/brief.ts` 202-207 (deadline), 250-252 (`BriefTimeoutError`); `web/lib/config.ts` 156 (`BRIEF_TIMEOUT_MS`, default 60 s) | One `AbortController` covers every attempt, retry wait and `pause_turn` continuation. The SDK's `timeout` is per attempt and is itself retried, so it cannot bound the total. |
| Retries | `web/lib/brief.ts` 25-32 (`BRIEF_MAX_RETRIES = 2`), 237; `web/lib/chat.ts` 218-219, 236 | Set explicitly per request. The SDK retries 408/409/429/5xx (529 overloaded included) with backoff and `retry-after`; for a stream that is the initial response only. |
| `pause_turn` | `web/lib/brief.ts` 236-237 calls `web/lib/chat.ts` 248-250 | Reuses the chat's turn runner: a paused turn is sent back to resume it. |
| Reading the brief | `web/lib/brief.ts` 175-186 (`extractBrief`), 238-248 | The brief is the text after the last tool call; narration is dropped. Refusal or empty output gives 502; `max_tokens` is marked incomplete. |
| Error mapping | `web/lib/brief.ts` 263-286 (`describeBriefError`); `web/app/api/brief/route.ts` 51-57 | Timeout 504, rate limit 429, Anthropic/MCP connection errors 502. A failing MCP tool is not an HTTP error: its `is_error` result stays in the trace (217-225). |
| Logging | `web/lib/brief.ts` 166-173 (`logToolCall`), 211-233 (`collect`), 255 | One JSON line per tool call: server, tool, ms. Never tokens, headers or tool inputs. Calls that never returned are logged without `ms`. |
| UI | `web/components/Brief.tsx` 54-95 (`generate`), 22-43 (`toTraceEntries`); `web/components/Topbar.tsx` 45-52 (Chat / Meeting brief nav) | JSON in, `white-space: pre-wrap` markdown and the existing `TracePanel` out. |
| Tests | `web/tests/brief.test.ts` 67 (read-only request), 130 (brief + trace with an `is_error` result), 177 (`pause_turn`), 192 (400), 203 (401/403), 214 (401 sign in again), 238 (504), 257 (529 retries), 276 (no token in logs) | Mocked SSE, like the chat tests; the timeout test uses a fetch that only settles when aborted. |

**Snippet: the workflow core (for the article body)** — `web/lib/brief.ts` 143-160 (the request) and 202-257
(`runBrief`: deadline, retries, trace, log lines).

**Numbers worth stating:** 60 s default deadline; 2 retries (3 attempts); 5 fixed sections; account names up to
120 characters; 11 brief tests (50 in total); 0 write tools enabled.

## Day 12: Custom MCP Tools + Apex/Flow Business Logic

| Quote | File and lines | Point to make |
| --- | --- | --- |
| Invocable method | `AccountHealthTool.cls` 21-51 | Label and description become the tool's metadata; write them for an LLM reader. |
| Request/result types | `AccountHealthTool.cls` 339-411 | `@InvocableVariable(description=...)` fields become the MCP input/output schema; `global` + no-arg constructors. |
| User-mode queries | `AccountHealthTool.cls` 80-87 (resolve), 164-225 (`loadMetrics`) | `WITH USER_MODE` everywhere; bulk-safe, one query per object. |
| Scoring | `AccountHealthTool.cls` 283-310 (`score`, `status`) | Business logic stays deterministic in Apex; the model only chooses when to call it. |
| Validated write tool | `CreateFollowUpTaskTool.cls` 32-110 | Validation, visibility check, idempotency (existing open task), `Database.insert(..., AccessLevel.USER_MODE)`. |
| Dynamic but safe SOQL | `CreateFollowUpTaskTool.cls` 183-208 (`findVisibleTargets`) | Object name from the schema, Ids as binds, `Database.queryWithBinds(..., AccessLevel.USER_MODE)`. |
| MCP server definition | `salesforce/force-app/main/default/mcpServerDefinitions/HeadlessAssistantTools.mcpServerDefinition-meta.xml` 1-25 | `aa:apex-<Class>` + `API_CATALOG` + `toolName`; deploy it like any metadata. |
| Declarative equivalent | `salesforce/force-app/main/default/flows/Create_Follow_Up_Task_Flow.flow-meta.xml` | Same outcome as a Flow; add it to the server in Setup as a Flow tool. |
| Least-privilege permission set | `salesforce/force-app/main/default/permissionsets/Headless_Assistant_User.permissionset-meta.xml` | Class access, Flow access, API Enabled, Edit Tasks, read on 3 objects. |
| Apex tests | `AccountHealthToolTest.cls` 48-75, 170-186; `CreateFollowUpTaskToolTest.cls` 77-108, 133-151 | `Test.startTest()`, `Assert.*`, and `System.runAs` a Minimum Access user to show permissions apply. |

## Days 5 and 11: OAuth with PKCE, and calling hosted MCP from the Claude API securely

| Quote | File and lines | Point to make |
| --- | --- | --- |
| PKCE helpers | `web/lib/pkce.ts` 11-40 | RFC 7636 S256; test vector in `web/tests/pkce.test.ts`. |
| Authorize URL | `web/lib/salesforce-oauth.ts` 41-54 | `scope=mcp_api refresh_token` (GA scopes; beta used `api sfap_api ...`). |
| Code exchange | `web/lib/salesforce-oauth.ts` 89-101 and `web/app/api/auth/salesforce/callback/route.ts` 37-44 | State checked in constant time; verifier single-use. |
| Short-lived token before it leaves the server | `web/lib/salesforce-oauth.ts` 168-207 (`needsRefresh`, `ensureFreshSession`); route side `web/lib/route-session.ts` 39-50 (`refreshSession`) | Refresh near JWT `exp` or after 15 minutes, because the token is sent to Anthropic's API. |
| Encrypted cookie session | `web/lib/session.ts` 60-89 (`seal`/`unseal`), 161-176 (`writeSession`) | AES-256-GCM, HKDF key, purpose-bound AAD, expiry 8 hours after the last write (sign-in or token refresh, which re-seals the cookie), chunking for large JWTs. |
| Logout | `web/app/api/auth/salesforce/logout/route.ts` | POST-only, revokes the refresh token. |
| Discovering the auth server | README "Activate the hosted MCP servers" (`curl .../.well-known/oauth-protected-resource/...`) | The MCP URL tells you which login host and scopes to use. |

## Screenshots to capture

1. **Setup > API Catalog > MCP Servers** with `platform/sobject-all` and `HeadlessAssistantTools` active.
2. The custom server's detail page: the two tools (`getAccountHealth`, `createFollowUpTask`) and the Server URL
   (blur the org-specific part if you like).
3. External Client App **OAuth settings**: callback `http://localhost:3000/api/auth/salesforce/callback`, scopes
   `mcp_api` and `refresh_token`.
4. External Client App **Security**: PKCE and "Issue JSON Web Token (JWT)-based access tokens for named users" checked.
5. The app's sign-in page (model and MCP server list visible).
6. The Salesforce login / allow-access screen during OAuth.
7. "How healthy is the Acme account?" with the trace panel open on `custom · getAccountHealth` (input and output).
8. A pipeline question showing `sobject-all · soqlQuery` in the trace.
9. The **Approval needed** card for "Create a follow-up task on Acme ...".
10. After Approve: trace shows "Write tool enabled for this request only", `custom · createFollowUpTask`, and
    "Executed exactly as approved".
11. The created Task in Lightning (owner = the signed-in user: the audit trail point).
12. A restricted user (without the permission set or Account access) getting an access message: CRUD/FLS/sharing in action.
13. DevTools > Application > Cookies: only sealed `sfh360_session.*` httpOnly cookies, no readable token; Network:
    the `/api/chat` NDJSON stream with tool events and no token.
14. Terminal: `npm run typecheck`, `npm run lint`, `npm test` green; `sf apex run test ... --code-coverage` summary.
15. Day 10: `/brief` with a generated brief for Acme Global Tech (five sections, record Ids) and the trace showing
    `custom · getAccountHealth` and `sobject-all · soqlQuery`.
16. Day 10: the `npm run dev` terminal with `{"event":"mcp_tool_use",...}` lines (names and ms, no token).
17. Day 10: the timeout, by setting `BRIEF_TIMEOUT_MS=1000` and generating a brief (504 message in the page).
