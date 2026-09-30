# Salesforce metadata: custom MCP tools

SFDX project (API 67.0, Summer '26) with the business logic the assistant calls through a
custom Salesforce Hosted MCP server.

| Path | What it is |
| --- | --- |
| `classes/AccountHealthTool.cls` | `@InvocableMethod` **Get Account Health**: open pipeline, weighted pipeline, closing-soon deals, open/high-priority cases, days since last activity, 0-100 score, status, summary. |
| `classes/CreateFollowUpTaskTool.cls` | `@InvocableMethod` **Create Follow-Up Task**: validates input, checks record visibility, creates the Task in user mode, returns the existing open task instead of a duplicate. |
| `classes/*Test.cls`, `classes/TestUsers.cls` | Apex tests (`@IsTest`, `Test.startTest()`, `Assert`), including a restricted-user test for each tool. |
| `flows/Create_Follow_Up_Task_Flow.flow-meta.xml` | Autolaunched Flow: the declarative equivalent of the task tool. |
| `permissionsets/Headless_Assistant_User.permissionset-meta.xml` | Apex class access, Flow access, API Enabled, Edit Tasks, read on Account/Opportunity/Case. |
| `mcpServerDefinitions/Headless_Assistant_Tools.mcpServerDefinition-meta.xml` | Custom hosted MCP server exposing the two Apex actions as `getAccountHealth` and `createFollowUpTask`. |

Both tools run `with sharing`, query `WITH USER_MODE` and insert with `AccessLevel.USER_MODE`, so the
signed-in user's CRUD, field-level security and sharing apply. The classes and their request/result
types are `global`, as in Salesforce's own sample for hosted Apex tools.

## Deploy

Use a current Salesforce CLI. Older CLIs do not know the `McpServerDefinition` type
(2.83 fails with "did you mean .licenseDefinition-meta.xml"); run `sf update` first.

```bash
cd salesforce
sf org login web --alias headless360 --set-default        # Developer Edition org

# 1. Apex, Flow and permission set (runs the Apex tests in a production/DE org)
sf project deploy start \
  --source-dir force-app/main/default/classes \
  --source-dir force-app/main/default/flows \
  --source-dir force-app/main/default/permissionsets \
  --test-level RunSpecifiedTests \
  --tests AccountHealthToolTest --tests CreateFollowUpTaskToolTest \
  --target-org headless360

# 2. The custom hosted MCP server (needs hosted MCP servers enabled in the org)
sf project deploy start --source-dir force-app/main/default/mcpServerDefinitions --target-org headless360

# Or everything in one go from the manifest
sf project deploy start --manifest manifest/package.xml --test-level RunLocalTests --target-org headless360

# Give yourself (or other users) the permission set
sf org assign permset --name Headless_Assistant_User --target-org headless360
```

## Demo data

Two demo accounts give the tools and the series walkthroughs predictable results. Run this only in a Developer Edition or sandbox org:

```bash
sf apex run --file scripts/apex/seed-demo-data.apex --target-org headless360     # Acme (Demo), Globex (Demo)
sf apex run --file scripts/apex/remove-demo-data.apex --target-org headless360   # removes them and their tasks
```

`Acme (Demo)` has a large deal closing soon, an open high-priority case and no activity for 40 days, so
`getAccountHealth` should rate it Watch or At Risk. `Globex (Demo)` should come out Healthy. The seed script
skips an account that already exists.

## Test

```bash
sf apex run test --class-names AccountHealthToolTest --class-names CreateFollowUpTaskToolTest \
  --code-coverage --result-format human --wait 10 --target-org headless360
```

The tests create their own data. The two `respectsTheCallersAccess` tests create a user on the
**Minimum Access - Salesforce** profile and skip themselves if the org has no such profile.

## Verify in your org

- **MCP server definition.** The `apiIdentifier` format (`aa:apex-<ClassName>`, `apiSource` `API_CATALOG`,
  `operation` = class name) follows Salesforce's sample repo for the May 2026 blog post. If the deploy is
  rejected, create the server in Setup instead: **Setup > MCP Servers** (Quick Find "MCP") > New custom
  server `Headless_Assistant_Tools`, then add two tools with backing type **Apex Action**:
  *Get Account Health* as `getAccountHealth` and *Create Follow-Up Task* as `createFollowUpTask`.
- **Flow as a tool.** The Flow is deployed but not added to the server definition, because the metadata
  format for Flow-backed tools is not documented anywhere reachable. Add it in the Setup UI if you want it
  (tool type Flow, name for example `createFollowUpTaskFlow`) and add that name to
  `SF_MCP_CUSTOM_WRITE_TOOLS` in the web app so it is gated behind approval too.
- **Flow status.** Production and Developer Edition orgs may deploy flows as inactive unless
  "Deploy processes and flows as active" is enabled in Process Automation Settings. Activate it in Flow
  Builder if needed.
- **Picklist values.** Tests assume the default values: Opportunity stages `Prospecting` and `Closed Won`,
  Case status `New`/`Closed`, Task status `Not Started`/`Completed`, Task priority `High`/`Normal`/`Low`.
