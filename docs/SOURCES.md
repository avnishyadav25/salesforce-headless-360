# Sources

What the code relies on, where it was verified, and what could not be verified. Checked on **2026-09-30**.
`developer.salesforce.com/docs` and `/blogs` returned HTTP 403 to automated fetches, so Salesforce facts come from
live endpoint probes, Salesforce's official GitHub repositories, and cross-checked secondary sources.

## Anthropic: MCP connector (Messages API)

Source: [MCP connector](https://platform.claude.com/docs/en/agents-and-tools/mcp-connector) (fetched in full).

| Fact | Used in |
| --- | --- |
| Beta header **`mcp-client-2025-11-20`**. The older `mcp-client-2025-04-04` is deprecated. A newer optional `mcp-client-2026-09-15` adds `mcp_tool_listing` blocks and pinned tool lists. | `lib/config.ts` (`ANTHROPIC_MCP_BETA`), `lib/anthropic.ts` |
| `mcp_servers[]` entry: `type: "url"` (only value), `url` (must start with `https://`), `name` (unique, referenced by exactly one toolset), optional `authorization_token` (OAuth bearer token). | `buildMcpServers()` |
| `tools[]` entry `{ type: "mcp_toolset", mcp_server_name, default_config?, configs?, cache_control? }`; per-tool config `{ enabled (default true), defer_loading (default false) }`; precedence `configs` > `default_config` > defaults. | `buildMcpToolsets()` |
| Validation: every server in `mcp_servers` must be referenced by exactly one toolset; a tool name in `configs` that the server does not have only logs a backend warning (no error). | Write-tool denylist can list names safely |
| Docs recommend the denylist pattern "when you want a human confirmation step before state changes". | Approval design |
| Response blocks: `mcp_tool_use` `{ type, id, name, server_name, input }` and `mcp_tool_result` `{ type, tool_use_id, is_error, content: [{ type: "text", text }] }`. | `lib/chat.ts` `emitBlock()` |
| Limitations: only MCP **tools** are supported (not prompts/resources); servers must be public over HTTP (Streamable HTTP or SSE). Available on Claude API, Claude Platform on AWS and Microsoft Foundry; **not** on Amazon Bedrock or Google Cloud. Not ZDR-eligible. | README prerequisites and security notes |
| Auth: "API consumers are expected to handle the OAuth flow and obtain the access token prior to making the API call, and to refresh the token as needed." | `ensureFreshSession()` |
| Multiple servers in one request, each with its own toolset. | Two servers |

SDK: `@anthropic-ai/sdk` **0.129.0** type definitions (`node_modules/@anthropic-ai/sdk/resources/beta/messages/messages.d.ts`)
confirm `BetaRequestMCPServerURLDefinition`, `BetaMCPToolset.configs`, `BetaMCPToolUseBlock`, `BetaMCPToolResultBlock`,
`BetaTool.eager_input_streaming`, `BetaThinkingConfigAdaptive.display`, the `betas` param (sent as `anthropic-beta`),
and `client.beta.messages.stream()` tracking `input_json_delta` for `mcp_tool_use`. The test
`tests/anthropic.test.ts` asserts the header and body on the wire.

SDK behaviour the Day 10 brief relies on, read from the same package (`client.js`, `lib/BetaMessageStream.js`,
`internal/utils/sleep.js`, `internal/utils/log.js`):

| Fact | Used in |
| --- | --- |
| `maxRetries` defaults to 2 and can be set per request (`options.maxRetries ?? this.maxRetries`). `shouldRetry` retries 408, 409, 429 and every status >= 500 (so 529 overloaded) unless `x-should-retry` says otherwise, plus connection errors. Backoff is 0.5 s doubling to 8 s with jitter, or `retry-after-ms` / `retry-after`. | `BRIEF_MAX_RETRIES` in `lib/brief.ts`, `runTurn({ maxRetries })` |
| `timeout` (default 10 minutes) applies per attempt, and timed-out attempts are retried. | Overall deadline via `AbortController` instead |
| An aborted `signal` ends the request with `APIUserAbortError`; an abort during a retry wait wakes it early and the next attempt throws the same error. The stream's `finalMessage()` rejects with it. | `runBrief` maps it to `BriefTimeoutError` (504) |
| At log level `debug` (`ANTHROPIC_LOG=debug`) the SDK logs request options including the body and redacts only auth headers; the body carries `mcp_servers[].authorization_token`. | README security note: leave `ANTHROPIC_LOG` unset |

Model: [Claude Sonnet 5.5](https://platform.claude.com/docs/en/models/sonnet-5-5/overview), API ID **`claude-sonnet-5-5`**, the current Sonnet (Claude Sonnet 5 is marked legacy on its [model page](https://platform.claude.com/docs/en/models/sonnet-5/overview), retirement not sooner than 2027-06-30). Adaptive thinking; non-default `temperature`/`top_p`/`top_k` return 400. Set `ANTHROPIC_MODEL` to switch.

## Salesforce: hosted MCP servers

### Live probes (no credentials)

RFC 9728 protected-resource metadata, fetched with `curl`:

```text
GET https://api.salesforce.com/.well-known/oauth-protected-resource/platform/mcp/v1/platform/sobject-all
{ "resource": "https://api.salesforce.com/platform/mcp/v1/platform/sobject-all",
  "authorization_servers": ["https://login.salesforce.com"],
  "scopes_supported": ["mcp_api", "refresh_token"] }

.../platform/mcp/v1/sandbox/platform/sobject-all          -> authorization_servers ["https://test.salesforce.com"]
.../platform/mcp/v1/custom/HeadlessAssistantTools       -> ["https://login.salesforce.com"], same scopes
.../platform/mcp/v1/sandbox/custom/HeadlessAssistantTools -> ["https://test.salesforce.com"]
.../platform/mcp/v1/d/acme-dev-ed/develop/platform/sobject-all -> ["https://acme-dev-ed.develop.my.salesforce.com"]
```

(The metadata endpoint answers for any server name, so it confirms the URL grammar and auth server, not that a
given server exists.)

MCP endpoint without a token: `POST https://api.salesforce.com/platform/mcp/v1/platform/sobject-all` returns
`401 {"errors":[{"message":"JWT Token is required"}]}`; with a non-JWT bearer, `401 {"errors":[{"message":"Invalid token"}]}`.

OpenID configuration, [`https://login.salesforce.com/.well-known/openid-configuration`](https://login.salesforce.com/.well-known/openid-configuration):
`authorization_endpoint` `https://login.salesforce.com/services/oauth2/authorize`, `token_endpoint`
`.../services/oauth2/token`, `revocation_endpoint` `.../services/oauth2/revoke`, `code_challenge_methods_supported`
`["S256"]`, `grant_types_supported` `["authorization_code", "refresh_token"]`, `token_endpoint_auth_methods_supported`
`client_secret_post`, `client_secret_basic`, `private_key_jwt`; `scopes_supported` includes `mcp_api`, `refresh_token`,
`api`, `sfap_api`.

API versions, [`https://na1.salesforce.com/services/data/`](https://na1.salesforce.com/services/data/): latest is
**67.0 "Summer '26"** (used for `sourceApiVersion` and all metadata).

### Salesforce's official wiki: [forcedotcom/mcp-hosted](https://github.com/forcedotcom/mcp-hosted/wiki)

| Fact | Page |
| --- | --- |
| ECA only (Connected Apps not supported). Minimal setup: callback URL; scopes **`mcp_api`** and **`refresh_token`**; **Require PKCE**; **Issue JWT-based access tokens for named users**; all other flow checkboxes off. Web apps can additionally require a secret for the Web Server and Refresh Token flows. Refresh token expiry + rotation, permission-set pre-authorization, IP restrictions as hardening. ECA changes take up to 30 minutes. No Dynamic Client Registration. | [Configuring an External Client App](https://github.com/forcedotcom/mcp-hosted/wiki/Configuring-an-External-Client-App) |
| Beta to GA: URL `v1-beta.2` to `v1`; scopes `api sfap_api refresh_token einstein_gpt_api` replaced by `mcp_api refresh_token`; per-server activation in **Setup > API Catalog > MCP Servers**, disabled by default. | [FAQ](https://github.com/forcedotcom/mcp-hosted/wiki/FAQ), [Security and Permissions](https://github.com/forcedotcom/mcp-hosted/wiki/Security-and-Permissions) |
| Tools run with the authenticated user's CRUD, FLS and sharing; auth code flow only; PKCE required; JWT access tokens required. | [Security and Permissions](https://github.com/forcedotcom/mcp-hosted/wiki/Security-and-Permissions) |
| URL patterns: `https://api.salesforce.com/platform/mcp/v1/{servername}`, sandbox `.../v1/sandbox/{servername}`, My Domain `.../v1/d/{mydomain}/develop/{servername}` (DE), `.../d/{mydomain}--{sandbox}/sandbox/...`, `.../d/{mydomain}/scratch/...`; example `.../v1/d/dky00000fejyf2au-dev-ed/develop/platform/sobject-all`. Whether `/d/` applies to custom servers was "being confirmed with engineering". | [Connecting Your MCP Client](https://github.com/forcedotcom/mcp-hosted/wiki/Connecting-Your-MCP-Client) |
| ECAs cannot be created in scratch orgs; server activation takes up to 2 minutes; tool calls consume API quota; `mcp-remote` unsupported. | [Known Limitations](https://github.com/forcedotcom/mcp-hosted/wiki/Known-Limitations) |
| `sobject-all` tool names seen in Postman: `describeGlobal`, `getUserInfo`, `soqlQuery`, `getObjectSchema`, `getRelatedRecords`, `listRecentSobjectRecords`, `find`. | [Testing and Debugging with Postman](https://github.com/forcedotcom/mcp-hosted/wiki/Testing-and-Debugging-with-Postman) |

### Custom Apex as a hosted MCP tool

Blog: [Expose Custom Apex as a Hosted MCP Tool for Agents](https://developer.salesforce.com/blogs/2026/05/expose-custom-apex-as-a-hosted-mcp-tool-for-agents)
(May 13, 2026; 403 to automated fetch). Its source repo was read in full:
[msrivastav13/headless-apex-mcp-tool](https://github.com/msrivastav13/headless-apex-mcp-tool) (commit `a5dd57c`, 2026-05-11).

| Fact | Used in |
| --- | --- |
| Apex exposed via `@InvocableMethod` with `@InvocableVariable(description=...)` request/result classes; class, method and types are `global` ("required for MCP tool discovery"); queries use `WITH USER_MODE`. | `AccountHealthTool`, `CreateFollowUpTaskTool` |
| `McpServerDefinition` metadata in `force-app/main/default/mcpServerDefinitions/<Name>.mcpServerDefinition-meta.xml`: `description`, `masterLabel`, and `tools[]` with `apiDefinition { apiIdentifier: aa:apex-<Class>, apiSource: API_CATALOG, operation: <Class> }`, `descriptionOverride`, `toolName`, `toolTitle`. | `HeadlessAssistantTools.mcpServerDefinition-meta.xml` |
| Setup UI alternative: **Setup > Integration > Salesforce MCP Servers**, custom server, tool backing type **Apex Action**. | salesforce/README.md fallback |
| Custom server URL: `https://api.salesforce.com/platform/mcp/v1/custom/<NAME>`; sandbox/scratch `.../v1/sandbox/custom/<NAME>`; copy it from the server's Authentication Details. | `.env.example` |
| ECA: scopes `mcp_api` + `refresh_token`, JWT-based tokens for named users, PKCE, everything else unchecked. | README |
| Deploy: `sf project deploy start --source-dir .../classes --source-dir .../mcpServerDefinitions`. | salesforce/README.md |

Metadata registry: [source-deploy-retrieve `metadataRegistry.json`](https://github.com/forcedotcom/source-deploy-retrieve/blob/main/src/registry/metadataRegistry.json)
lists `McpServerDefinition` (directory `mcpServerDefinitions`, suffix `mcpServerDefinition`). The locally installed
Salesforce CLI 2.83.7 does not know the type, hence the "update the CLI" note.

### Cross-checks (secondary)

- [LibreChat: Salesforce MCP](https://www.librechat.ai/docs/mcp_servers/salesforce): production and sandbox URLs for
  `sobject-reads`, `sobject-mutations`, `sobject-deletes`, `sobject-all`; scopes `mcp_api refresh_token`; PKCE and JWT
  settings; authorize/token endpoints on login and test.
- [anthropics/claude-ai-mcp#251](https://github.com/anthropics/claude-ai-mcp/issues/251): same ECA settings
  (`mcp_api`, `refresh_token`, PKCE, JWT, secrets off), `http://localhost` callbacks accepted; a claude.ai connector
  issue with a `GET` probe returning 405 (claude.ai broker, not the Messages API).
- [anthropics/claude-ai-mcp#908](https://github.com/anthropics/claude-ai-mcp/issues/908): tool names `getUserInfo`,
  `getObjectSchema`, `soqlQuery`, `find`, `listRecentSobjectRecords`, `updateSobjectRecord`.
- [Gearset: flowAccesses](https://gearset.com/blog/what-is-the-salesforce-metadata-flowaccesses/): permission set
  `<flowAccesses><enabled/><flow/></flowAccesses>` shape.

## Not verified (configurable, marked "verify in your org")

| Item | Why | How the code copes |
| --- | --- | --- |
| `sobject-all` write tool names `createSobjectRecord`, `updateSobjectRecord`, `updateRelatedRecord`, `deleteSobjectRecord`, `deleteRelatedRecord` | Listed on Salesforce's `sobject-all` guide (https://developer.salesforce.com/docs/platform/hosted-mcp-servers/guide/sobject-all.html), checked for the blog series on 2026-09-30: 11 tools, of which these 5 change data. `sobject-deletes` also exposes the two delete tools. | `SF_MCP_SOBJECT_WRITE_TOOLS`; unknown names in `configs` are harmless (warning only). |
| Exact Setup menu path for activation | Wiki says Setup > API Catalog > MCP Servers; other guides show Setup > Integrations > MCP Servers or Quick Find "MCP". | README says to use Quick Find "MCP". |
| `/d/<mydomain>/` URLs for custom servers | The official wiki says it is being confirmed. | URLs are env vars. |
| Whether one access token works for both servers (audience binding) | No source says tokens are per-resource; the documented flows request no `resource` parameter. | Optional `SF_OAUTH_RESOURCE` (RFC 8707). |
| Flow-backed tool metadata in `McpServerDefinition` | No source for the `apiIdentifier` of a Flow. | Flow deployed; add it as a tool in the Setup UI. |
| Claims inside Salesforce JWT access tokens (`exp`, username) | No token to inspect. | `exp` used when present; otherwise `SF_TOKEN_MAX_AGE_SECONDS`; name falls back to the user Id from the identity URL. |
| Whether the Messages API MCP connector hits the same `GET` 405 issue as the claude.ai broker (#251) | Needs a live org. | Troubleshooting row. |
| Apex behaviour | No org to deploy to; classes were parsed with the Apex parser (`prettier-plugin-apex`/jorje) but not compiled. | Tests written for a default Developer Edition org. |
