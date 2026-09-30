# Article notes

Files, snippets and line references to quote, plus the screenshots to capture when you run the demo.
Line numbers refer to the initial commits of this repo; re-check them if you edit the files.

I don't have the series outline for Days 10 and 12, so their sections below are grouped by the topic each one most
likely covers (custom Apex as a hosted MCP tool; calling hosted MCP from the Claude API securely). Move items
between them to match your plan.

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
| Streaming and tool trace | `web/lib/chat.ts` 227-264 (`runTurn`) | `client.beta.messages.stream()`, `contentBlock` events for `mcp_tool_use`/`mcp_tool_result`, `pause_turn` continuation. |
| Write audit | `web/lib/chat.ts` 192-210 (`auditWrites`) | After an approved turn, compare executed input with the approved arguments. |
| Chat route | `web/app/api/chat/route.ts` 18-119 | Session → refresh → build → stream NDJSON; tokens never leave the server. |
| UI approval flow | `web/components/Chat.tsx` 182-198 (`decide`), `web/components/ProposalCard.tsx` | The Approve/Reject card and the second request. |
| Custom Apex tool | `salesforce/force-app/main/default/classes/AccountHealthTool.cls` 21-51 | `@InvocableMethod` + `global` types = an MCP tool; failures come back as data, not exceptions. |
| Tests that prove the flow | `web/tests/chat-route.test.ts` ("asks for approval before a write...") | Mocked Anthropic SSE shows the proposal, the approval request body and the audit. |

**Snippet: the request (for the article body)** — copy from `web/lib/anthropic.ts` 163-179, or use the condensed
version in the root README ("How the request looks").

**Numbers worth stating:** 39 Vitest tests; 2 hosted MCP servers; 4 `sobject-all` write tools gated by default;
token refreshed when older than 15 minutes; session cookie sealed with AES-256-GCM and split under 4 KB per cookie.

## Day 10 (suggested): Custom Apex as a hosted MCP tool

| Quote | File and lines | Point to make |
| --- | --- | --- |
| Invocable method | `AccountHealthTool.cls` 21-51 | Label and description become the tool's metadata; write them for an LLM reader. |
| Request/result types | `AccountHealthTool.cls` 339-411 | `@InvocableVariable(description=...)` fields become the MCP input/output schema; `global` + no-arg constructors. |
| User-mode queries | `AccountHealthTool.cls` 80-87 (resolve), 164-225 (`loadMetrics`) | `WITH USER_MODE` everywhere; bulk-safe, one query per object. |
| Scoring | `AccountHealthTool.cls` 283-310 (`score`, `status`) | Business logic stays deterministic in Apex; the model only chooses when to call it. |
| Validated write tool | `CreateFollowUpTaskTool.cls` 32-110 | Validation, visibility check, idempotency (existing open task), `Database.insert(..., AccessLevel.USER_MODE)`. |
| Dynamic but safe SOQL | `CreateFollowUpTaskTool.cls` 183-208 (`findVisibleTargets`) | Object name from the schema, Ids as binds, `Database.queryWithBinds(..., AccessLevel.USER_MODE)`. |
| MCP server definition | `salesforce/force-app/main/default/mcpServerDefinitions/Headless_Assistant_Tools.mcpServerDefinition-meta.xml` 1-25 | `aa:apex-<Class>` + `API_CATALOG` + `toolName`; deploy it like any metadata. |
| Declarative equivalent | `salesforce/force-app/main/default/flows/Create_Follow_Up_Task_Flow.flow-meta.xml` | Same outcome as a Flow; add it to the server in Setup as a Flow tool. |
| Least-privilege permission set | `salesforce/force-app/main/default/permissionsets/Headless_Assistant_User.permissionset-meta.xml` | Class access, Flow access, API Enabled, Edit Tasks, read on 3 objects. |
| Apex tests | `AccountHealthToolTest.cls` 48-75, 170-186; `CreateFollowUpTaskToolTest.cls` 77-108, 133-151 | `Test.startTest()`, `Assert.*`, and `System.runAs` a Minimum Access user to show permissions apply. |

## Day 12 (suggested): Secure OAuth + calling hosted MCP from the Claude API

| Quote | File and lines | Point to make |
| --- | --- | --- |
| PKCE helpers | `web/lib/pkce.ts` 11-40 | RFC 7636 S256; test vector in `web/tests/pkce.test.ts`. |
| Authorize URL | `web/lib/salesforce-oauth.ts` 41-54 | `scope=mcp_api refresh_token` (GA scopes; beta used `api sfap_api ...`). |
| Code exchange | `web/lib/salesforce-oauth.ts` 89-101 and `web/app/api/auth/salesforce/callback/route.ts` 37-44 | State checked in constant time; verifier single-use. |
| Short-lived token before it leaves the server | `web/lib/salesforce-oauth.ts` 168-207 (`needsRefresh`, `ensureFreshSession`) | Refresh near JWT `exp` or after 15 minutes, because the token is sent to Anthropic's API. |
| Encrypted cookie session | `web/lib/session.ts` 60-89 (`seal`/`unseal`), 161-176 (`writeSession`) | AES-256-GCM, HKDF key, purpose-bound AAD, absolute expiry, chunking for large JWTs. |
| Logout | `web/app/api/auth/salesforce/logout/route.ts` | POST-only, revokes the refresh token. |
| Discovering the auth server | README "Activate the hosted MCP servers" (`curl .../.well-known/oauth-protected-resource/...`) | The MCP URL tells you which login host and scopes to use. |

## Screenshots to capture

1. **Setup > API Catalog > MCP Servers** with `platform/sobject-all` and `Headless_Assistant_Tools` active.
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
