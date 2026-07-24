# Internal MCP Audit-Read Profile Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a dedicated, structurally read-only internal MCP entry point that returns a complete, evidence-qualified workflow runtime window for the weekly whole-account auditor.

**Architecture:** Preserve the existing full MCP server and its callers. Add a separate audit tool registry, gateway policy, shared limiter, composite workflow-runtime collector, capability manifest, stdio entry point, and committed bundle. The audit server exposes typed GET-only reads, never `raw_request`, `set_token_file`, confirmation fields, or mutations.

**Tech Stack:** Node.js 24.13.0, ESM, `node:test`, `@modelcontextprotocol/sdk` 1.29.0, Zod 4.4.3, esbuild 0.28.1.

## Global Constraints

- Implementation repository: `/Volumes/Xander SSD/Vibe Code/Misc/ghl-plugin`.
- Server directory: `plugins/uxie-ghl-factory/mcp-internal`.
- Current observed baseline: clean `main` at `c0566c6`.
- Current test floor: `npm test` passes 168 tests.
- Commit `2a8e989` already added date/contact/event filters, enrollment pagination, contacts-at-step, and enrollment totals.
- Do not discard or duplicate that work.
- The YAML at `/Users/uxie/Downloads/api-1 latest.yaml` is a capability specification, not runtime proof.
- The YAML does not document a normal execution-log cursor. Do not invent `action=next` for `/workflows/logs/v2`.
- Preserve the existing full server, normal `stdio.mjs`, tool contracts, gateway response shape, and committed `dist/server.mjs`.
- The audit server is a separate entry point with a separate tool registry and bundle.
- The audit profile exposes no `raw_request`, `set_token_file`, write, confirmation, membership, course, or community tool.
- A `429`, `403`, location mismatch, saturated time slice, cursor loop, total mismatch, or page-budget exhaustion must fail closed.
- Never print credentials. Authentication continues to come from the configured token file path.
- No live account call is authorized until Task 7 receives explicit user approval.
- Never push, publish, or bump a version from this plan.
- Git identity is unresolved for execution: the remote and current config are `uxieee`, but the work is for Grom operations. Before the first internal-repository commit, stop and ask the user which identity and git auth/token to use.

## Remaining Current-State Gaps

- `get_workflow_logs` reads only one execution-log response.
- `list_workflows` reads one offset page and does not reconcile the reported total.
- Enrollment cursor forwarding omits `referenceSequence`.
- `list_account_entities` converts failed or malformed AI reads to empty arrays and cannot support audit absence claims.
- No completeness-aware Conversation AI, Voice AI, or Agent Studio discovery-plus-detail contract exists.
- No unified runtime-window/completeness contract exists.
- No response location-validation layer exists.
- Throttling is created per gateway, not shared across the audit process.
- The normal stdio server still exposes writes and `raw_request`.
- No dedicated audit manifest, bundle, or real protocol proof exists.

---

### Task 1: Add the exact structural audit tool profile

**Files:**

- Create: `plugins/uxie-ghl-factory/mcp-internal/core/audit-profile.mjs`
- Create: `plugins/uxie-ghl-factory/mcp-internal/test/audit-profile.test.mjs`

**Interfaces:**

```js
export const AUDIT_TOOL_NAMES
export function toolsForProfile(profile, tools = TOOLS)
```

- [ ] **Step 1: Write the failing exact-registry test**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TOOLS } from '../core/tools.mjs';
import { AUDIT_TOOL_NAMES, toolsForProfile } from '../core/audit-profile.mjs';

const runtimeTool = {
  name: 'get_workflow_runtime_window',
  capabilities: [{ method: 'GET', path: '/workflows/logs/v2' }],
  inputSchema: {},
  handler() {},
};
const rosterTool = {
  name: 'list_workflows_complete',
  capabilities: [{ method: 'GET', path: '/workflow/{loc}/list' }],
  inputSchema: {},
  handler() {},
};
const aiTool = {
  name: 'get_ai_configuration_bundle',
  capabilities: [{ method: 'GET', path: '/voice-ai/agents/{agentId}' }],
  inputSchema: {},
  handler() {},
};
const futureTools = [...TOOLS, runtimeTool, rosterTool, aiTool];

test('audit profile exposes the exact read-only set', () => {
  assert.deepEqual(AUDIT_TOOL_NAMES, [
    'auth_status',
    'list_workflows_complete',
    'get_workflow',
    'export_workflow',
    'get_workflow_runtime_window',
    'get_ai_configuration_bundle',
  ]);
  const selected = toolsForProfile('audit', futureTools);
  assert.deepEqual(selected.map((tool) => tool.name), AUDIT_TOOL_NAMES);
  assert.ok(selected.every((tool) => tool.name === 'auth_status'
    || tool.capabilities.every((capability) => capability.method === 'GET')));
  assert.ok(selected.every((tool) => !['raw_request', 'set_token_file', 'list_courses'].includes(tool.name)));
});

test('audit selection rejects duplicate missing or capability-free escape tools', () => {
  assert.throws(() => toolsForProfile('audit', [...futureTools, futureTools[0]]), /DUPLICATE_TOOL/);
  assert.throws(() => toolsForProfile('audit', futureTools.filter((tool) => tool.name !== 'auth_status')), /MISSING_AUDIT_TOOL/);
  const broken = futureTools.map((tool) => tool.name === 'list_workflows_complete'
    ? { ...tool, capabilities: [] }
    : tool);
  assert.throws(() => toolsForProfile('audit', broken), /UNAPPROVED_AUDIT_TOOL/);
});
```

- [ ] **Step 2: Run and confirm missing-module failure**

```bash
cd "/Volumes/Xander SSD/Vibe Code/Misc/ghl-plugin/plugins/uxie-ghl-factory/mcp-internal"
node --test test/audit-profile.test.mjs
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement an explicit selector**

```js
import { TOOLS } from './tools.mjs';

export const AUDIT_TOOL_NAMES = Object.freeze([
  'auth_status',
  'list_workflows_complete',
  'get_workflow',
  'export_workflow',
  'get_workflow_runtime_window',
  'get_ai_configuration_bundle',
]);

export function toolsForProfile(profile, tools = TOOLS) {
  if (profile !== 'audit') throw new Error('UNKNOWN_TOOL_PROFILE');
  const byName = new Map();
  for (const tool of tools) {
    if (byName.has(tool.name)) throw new Error('DUPLICATE_TOOL');
    byName.set(tool.name, tool);
  }
  const selected = AUDIT_TOOL_NAMES.map((name) => {
    const tool = byName.get(name);
    if (!tool) throw new Error(`MISSING_AUDIT_TOOL:${name}`);
    return tool;
  });
  for (const tool of selected) {
    if (tool.name === 'auth_status') continue;
    if (tool.capabilities.length === 0) throw new Error(`UNAPPROVED_AUDIT_TOOL:${tool.name}`);
    if (tool.capabilities.some((capability) => capability.method !== 'GET')) {
      throw new Error(`UNAPPROVED_AUDIT_TOOL:${tool.name}`);
    }
  }
  return selected;
}
```

Do not add a temporary dead tool to `TOOLS`. The test uses the `runtimeTool` fixture above; Task 3 adds the real tool only when its handler and contract exist.

- [ ] **Step 4: Run targeted tests**

```bash
node --test test/audit-profile.test.mjs test/tools.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Stop for identity confirmation, then commit**

Before running these commands, ask the user:

1. Which git identity should this `uxieee` repository use for this Grom-driven feature?
2. What git auth/token should be used for later push operations?

After explicit confirmation:

```bash
git add plugins/uxie-ghl-factory/mcp-internal/core/audit-profile.mjs \
  plugins/uxie-ghl-factory/mcp-internal/test/audit-profile.test.mjs
git commit -m "feat(mcp-internal): add strict audit-only tool profile"
```

Do not push.

---

### Task 2: Enforce audit routes, location binding, and one shared limiter

**Files:**

- Create: `plugins/uxie-ghl-factory/mcp-internal/core/audit-capabilities.mjs`
- Create: `plugins/uxie-ghl-factory/mcp-internal/core/audit-gateway.mjs`
- Create: `plugins/uxie-ghl-factory/mcp-internal/test/audit-capabilities.test.mjs`
- Create: `plugins/uxie-ghl-factory/mcp-internal/test/audit-gateway.test.mjs`
- Modify: `plugins/uxie-ghl-factory/mcp-internal/core/gateway.mjs`
- Modify: `plugins/uxie-ghl-factory/mcp-internal/core/errors.mjs`

**Interfaces:**

```js
makeAuditLimiter({ minimumDelayMs, jitterMs, sleepImpl, randomImpl, nowImpl })
makeAuditCircuit()
makeAuditGateway({ gateway, locationId, limiter, circuit })
auditGateway.callCapability({ capabilityId, typedBindings, query })
gateway.callWithMeta(method, path, body, options)
```

- [ ] **Step 1: Write failing policy adversaries**

Test:

- Non-GET methods
- Absolute URLs and host overrides
- Encoded traversal
- Unknown paths
- Unknown, missing, and duplicate query keys
- Wrong and duplicate `locationId` values
- Wrong workflow, workflow-array, step, company, and agent bindings before fetch
- Concurrent calls respecting global spacing
- Numeric and HTTP-date `Retry-After`
- `403`, `429`, and `isLocationRateLimited`
- Open circuit making no additional fetch
- Existing `gateway.call()` staying exactly `{status, ok, json}`
- Exact current `details-by-step` shape using `currentStepId` and fixed `showTotalCount=true`
- Exact enrollment-cache shape using the literal `workflowIds[]` query key
- `/voice-ai/agents/simple` resolving to the discovery capability ID, never the `{agentId}` detail capability

- [ ] **Step 2: Run and confirm failure**

```bash
node --test test/audit-gateway.test.mjs test/gateway.test.mjs
```

Expected: FAIL because `audit-gateway.mjs` is missing.

- [ ] **Step 3: Implement the exact semantic capability policy**

Define the canonical descriptors in `core/audit-capabilities.mjs`. The audit gateway compiles its matcher directly from this module, and Task 5 generates the checked-in capability manifest from the same descriptors. Never generate runtime policy from a later artifact. Each descriptor binds:

```js
{
  capabilityId,
  host: 'backend' | 'services',
  authRail: 'backend' | 'ai',
  method: 'GET',
  normalizedPath,
  pathBindings,
  queryBindings,
  requiredQueryKeys,
  optionalQueryKeys,
  fixedQueryValues,
  allowedQueryValues,
  numericQueryBounds,
  locationBinding: 'path' | 'query' | 'request_scope'
}
```

The initial descriptor set is exact:

```text
backend GET /workflow/{locationId}/list
  required: type, limit, offset, sortBy, sortOrder, includeCustomObjects, includeObjectiveBuilder
  optional: status, search
  fixed: type=workflow, sortBy=name, sortOrder=asc, includeCustomObjects=true, includeObjectiveBuilder=true
  allowed: status=published|draft
  bounds: 1<=limit<=100, 0<=offset
backend GET /workflow/{locationId}/{workflowId}
  required: includeScheduledPauseInfo
  fixed: includeScheduledPauseInfo=true
backend GET /workflow/{locationId}/trigger
  required: workflowId
backend GET /workflows/sticky-notes-all
  required: workflowId, locationId
backend GET /workflows/logs/v2
  required: workflowId, locationId, limit, fromDate, toDate
  optional: contactId, eventType
  fixed: limit=20
backend GET /workflows/status/search/count-per-step
  required: workflowId, locationId
backend GET /workflows/status/search/workflow-with-filter
  required: workflowId, locationId, action, limit
  optional: contactId, fromDate, toDate, eventType, referenceId, referenceCreatedAt, referenceSid, referenceSequence
  allowed: action=first|next
  fixed: limit=20
backend GET /workflows/status/search/details-by-step
  required: workflowId, locationId, currentStepId, skip, limit, showTotalCount
  fixed: showTotalCount=true
  bounds: 1<=limit<=50, 0<=skip
backend GET /workflows/status/search/enroll-stats-cache
  required: workflowIds[], locationId
backend GET /workflows/status/enroll-stats
  required: workflowId, locationId
services GET /voice-ai/agents/simple
  required: locationId
services GET /voice-ai/agents/{agentId}
  required: locationId
services GET /ai-employees/agents
  required: locationId
services GET /ai-employees/employees/{agentId}
  required: locationId
services GET /agent-studio/agents/agents-with-folders
  required: locationId, agencyId, productId, page, pageSize, groupBy, sortBy, sortOrder
  fixed: productId=superagent, groupBy=foldersFirst, sortBy=lastUpdated, sortOrder=desc
  binding: agencyId must equal the typed companyId supplied to the composite
  bounds: 1<=page, 1<=pageSize<=100
services GET /agent-studio/super-agent/agents/{agentId}
  required: locationId
```

Path variables accept one decoded segment only and are validated against the tool's typed IDs. Reject absolute URLs, alternate hosts, encoded separators or traversal, unknown paths, unknown query keys, missing keys, unexpected repeated keys, wrong fixed values, and any location value that does not equal the bound location. Use `URLSearchParams.getAll()` so duplicate values cannot bypass validation. A new route or query key requires a manifest revision, tests, and audit-profile hash change.

Composite handlers call `callCapability`, not a raw path method. `typedBindings` carries the current typed `locationId`, `workflowId`, `stepId`, `companyId`, and discovery-derived `agentId` as applicable. Descriptor `queryBindings` require `workflowId` to equal the typed workflow, `workflowIds[]` to contain exactly that workflow, `currentStepId` to equal the typed step, `agencyId` to equal the typed company, and detail path IDs to be members of the sealed discovery result. Binding mismatch is rejected before fetch. When returned records contain workflow, step, company, agent, or location identity, a conflict quarantines the collection; absence records request-scope binding and never overrides a native conflict.

The matcher evaluates all descriptors, prefers the unique match with the greatest number of static path segments, and rejects unresolved ties as `AMBIGUOUS_CAPABILITY`. This guarantees `/voice-ai/agents/simple` traces the discovery capability ID rather than treating `simple` as an `{agentId}`. Capability receipts are minted only from these resolved trace IDs.

`audit-capabilities.test.mjs` canonicalizes the descriptor module and asserts exact equality with the generated manifest rows once Task 5 creates that artifact. Before Task 5, it validates descriptor uniqueness and schema. Task 5 upgrades the test to a build-and-diff gate so gateway policy and manifest cannot drift.

Add `callWithMeta` without changing `call`:

```js
{
  status,
  ok,
  json,
  retryAfterMs,
  capturedAt
}
```

One limiter and circuit are created by the audit stdio process and shared across every audit gateway. Do not auto-retry after an opened circuit; return stable metadata for checkpoint/resume.

- [ ] **Step 4: Run targeted and full tests**

```bash
node --test test/audit-gateway.test.mjs test/gateway.test.mjs
npm test
```

Expected: all 168 existing tests plus new tests PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/uxie-ghl-factory/mcp-internal/core \
  plugins/uxie-ghl-factory/mcp-internal/test/audit-gateway.test.mjs
git commit -m "feat(mcp-internal): enforce audit gateway policy and shared limits"
```

---

### Task 3: Build the complete workflow runtime-window collector

**Files:**

- Create: `plugins/uxie-ghl-factory/mcp-internal/core/workflow-runtime-window.mjs`
- Create: `plugins/uxie-ghl-factory/mcp-internal/test/workflow-runtime-window.test.mjs`
- Create fixtures under: `plugins/uxie-ghl-factory/mcp-internal/test/fixtures/runtime-window/`
- Modify: `plugins/uxie-ghl-factory/mcp-internal/core/tools.mjs`
- Modify: `plugins/uxie-ghl-factory/mcp-internal/core/errors.mjs`

**Tool schema:**

```js
{
  locationId: z.string(),
  workflowId: z.string(),
  fromDate: z.number().int().nonnegative(),
  toDate: z.number().int().positive(),
  contactId: z.string().optional(),
  eventTypes: z.array(z.string()).max(20).default([]),
  stepIds: z.array(z.string()).max(20).default([]),
  pageSize: z.literal(20).default(20),
  maxLogPartitions: z.number().int().min(1).max(2048).default(256),
  minPartitionMs: z.number().int().min(1).default(1000),
  maxEnrollmentPages: z.number().int().min(1).max(1000).default(200),
  maxStepRosterPages: z.number().int().min(1).max(1000).default(200)
}
```

Reject `fromDate >= toDate` before gateway construction.

- [ ] **Step 1: Write failing fixtures and collector tests**

Fixtures must cover:

- Empty and short execution windows
- A saturated window that splits into complete subwindows
- Repeated and reordered rows
- Conflicting duplicate IDs
- Saturation at `minPartitionMs`
- Missing event timestamp in an unsaturated partition
- Missing event timestamp in a saturated partition
- Partition-budget exhaustion
- Multiple event-type streams
- One-page and three-page enrollments
- Missing or repeated enrollment cursor
- `referenceSequence` forwarding
- Enrollment total mismatch
- Rate-limited enrollment page
- Step roster pagination
- Stats cache fallback
- Returned record with conflicting `locationId`
- Returned record without a `locationId`

- [ ] **Step 2: Run and confirm failure**

```bash
node --test test/workflow-runtime-window.test.mjs
```

Expected: FAIL with missing collector.

- [ ] **Step 3: Implement execution-log completeness without inventing a cursor**

Use half-open analytical windows `[fromDate, toDate)`. The initial effective page size is exactly 20, matching the currently observed and documented contract. Do not accept a caller-selected larger value. Increasing it requires a new manifest revision and a live canary that reconciles the larger size against the proven 20-row collector.

For `/workflows/logs/v2`:

1. Query a one-millisecond expanded range, `Math.max(0, fromDate - 1)` through `toDate`, then locally retain events whose timestamp is `>= fromDate && < toDate`.
2. If returned rows are fewer than `pageSize`, mark that partition terminal.
3. If rows equal `pageSize`, split the time range at its integer midpoint with a one-millisecond overlap.
4. Recurse until every partition is terminal.
5. Deduplicate by `_id || id` and canonical content hash.
6. A conflicting duplicate, saturated `minPartitionMs`, any returned event without a parseable timestamp, rate limit, or partition-budget exhaustion yields `complete:false` and `truncated:true`.

Parse event time in this order: `startedExecutionAt`, `createdAt`, then `updatedAt`. Record which field supplied each timestamp. An event with no parseable time may be retained as evidence but always makes the requested window incomplete because local `[fromDate, toDate)` membership cannot be proven.

Do not send `action`, `referenceId`, or another undocumented cursor to the log endpoint.

For enrollment history, retain the existing `action=first/next` walk and forward the complete available cursor tuple: `referenceId`, `referenceCreatedAt`, `referenceSid`, and `referenceSequence`. Detect repeated cursor tuples and zero unique progress.

For every returned record:

- If `locationId` is present, it must equal the bound location.
- If `workflowId` is present, it must equal the typed workflow.
- If `stepId` or `currentStepId` is present in a requested step roster, it must equal the typed step for that call.
- If absent, record `bindingMethod: "request_scope"`.
- A conflicting location, workflow, or step identity quarantines, not Partial.

Also collect:

- Workflow body, triggers, sticky notes, version, canonical SHA-256 hash, capture time, and explicit definition-validity metadata. Unless a version-history source proves an effective interval, return `effectiveFrom: null` and do not claim the current definition applied to historical events.
- Per-step counts
- Requested step rosters
- Cached enrollment totals with legacy fallback
- Exact source routes and captured times

Return:

```js
{
  contractVersion: '1.0.0',
  boundLocationId,
  workflowId,
  requestedWindow: { fromDate, toDate, boundaries: '[)' },
  appliedWindow: {
    fromDate: Math.max(0, fromDate - 1),
    toDate,
    queryBoundaries: 'upstream-defined',
    analyticalFilter: '[)',
    expansionMs: 1
  },
  appliedQueries,
  filters,
  workflowDefinition,
  runtimeEvents,
  enrollments,
  perStepCounts,
  stepRosters,
  enrollmentTotals,
  pagination,
  rateLimit,
  locationBinding,
  sourceRoutes,
  capabilityVersion,
  capturedAt,
  complete,
  truncated,
  warnings
}
```

- [ ] **Step 4: Run the collector and regression suites**

```bash
node --test test/workflow-runtime-window.test.mjs test/read-tools.test.mjs
npm test
```

Expected: all tests PASS and the original `get_workflow_logs` shape remains backward-compatible.

- [ ] **Step 5: Commit**

```bash
git add plugins/uxie-ghl-factory/mcp-internal/core \
  plugins/uxie-ghl-factory/mcp-internal/test
git commit -m "feat(mcp-internal): add complete workflow runtime window"
```

---

### Task 4: Add complete workflow-roster and AI-configuration composites

**Files:**

- Create: `plugins/uxie-ghl-factory/mcp-internal/core/audit-configuration.mjs`
- Create: `plugins/uxie-ghl-factory/mcp-internal/test/audit-configuration.test.mjs`
- Create fixtures under: `plugins/uxie-ghl-factory/mcp-internal/test/fixtures/audit-configuration/`
- Modify: `plugins/uxie-ghl-factory/mcp-internal/core/tools.mjs`

**Interfaces:**

```js
listWorkflowsComplete({ locationId, pageSize: 100, maxPages: 100 })
getAiConfigurationBundle({
  locationId,
  companyId,
  maxPages: 100
})
```

- [ ] **Step 1: Write failing completeness fixtures**

Workflow-roster fixtures cover one and three pages, duplicate IDs, reordered rows, changing reported totals, an empty intermediate page, zero unique progress, malformed rows, page-budget exhaustion, and a conflicting returned location.

AI fixtures cover Conversation AI, Voice AI, and Agent Studio discovery plus detail reads; multiple pages; one failed component; malformed success payloads; a list ID with missing detail; a wrong-location detail; missing `companyId` where required; a genuinely empty but terminal component; and a Voice row with `isDeleted:true` plus `agentStatus:"INACTIVE"`. Assert that a failed or malformed component is explicit `complete:false`, never an empty array. Assert the confirmed tombstone is retained as discovery evidence, excluded from the applicable-detail denominator, and causes no detail call. A row with only one deletion signal remains unknown and incomplete.

- [ ] **Step 2: Run and confirm failure**

```bash
node --test test/audit-configuration.test.mjs
```

Expected: FAIL with missing module and tools.

- [ ] **Step 3: Implement completeness-aware composites**

`list_workflows_complete` walks `/workflow/{locationId}/list` by offset until unique workflow count equals the stable reported total. It records every page, applied query, unique progress, total history, and terminal proof. Duplicate IDs with conflicting content, changing totals, zero progress before the total, missing IDs, location conflict, or page-budget exhaustion return `complete:false` and `truncated:true`.

`get_ai_configuration_bundle` always attempts the complete enumerated surface set `conversation_ai`, `voice_ai`, and `agent_studio`; callers cannot omit a surface. For each surface it:

1. Performs exact paginated discovery using the Task 2 capability descriptors.
2. Fetches the typed detail route for every discovered ID.
3. Verifies response identity and location binding.
4. Returns per-component `applicable`, `complete`, `items`, `pages`, `sourceRoutes`, and stable error metadata.

The Voice discovery route may return soft-deleted tombstones whose detail route is forbidden. Treat a row as a non-applicable tombstone only when the schema-valid row has both `isDeleted === true` and `agentStatus === "INACTIVE"`. Retain the row and its evidence reference, do not call its detail route, and exclude it from the detail denominator. Missing, conflicting, or unknown deletion fields do not qualify and keep the component incomplete.

Do not reuse `list_account_entities`; its best-effort empty fallbacks are forbidden in the audit profile. A malformed success, `403`, `404`, rate limit, missing detail, unavailable required company context, or pagination failure makes that component incomplete. An empty surface is complete only after a terminal, schema-valid discovery response.

Applicability is determined later by the weekly auditor's pinned coverage profile plus complete discovery evidence, never by an ad hoc caller list. `UNKNOWN` applicability forces Partial. Every capability applicable to the current run must have its own unexpired `live_runtime` receipt; proof of a list route does not prove an unexercised detail route.

- [ ] **Step 4: Run targeted and regression tests**

```bash
node --test test/audit-configuration.test.mjs test/read-tools.test.mjs test/tools.test.mjs
npm test
```

Expected: all tests PASS and the legacy `list_account_entities` behavior remains unchanged for the full server but absent from the audit profile.

- [ ] **Step 5: Commit**

```bash
git add plugins/uxie-ghl-factory/mcp-internal/core \
  plugins/uxie-ghl-factory/mcp-internal/test
git commit -m "feat(mcp-internal): add complete audit configuration reads"
```

---

### Task 5: Ship a dedicated audit stdio server, manifest, and bundle

**Files:**

- Create: `plugins/uxie-ghl-factory/mcp-internal/stdio-audit.mjs`
- Create: `plugins/uxie-ghl-factory/mcp-internal/audit-capability-manifest.json`
- Create: `plugins/uxie-ghl-factory/mcp-internal/test/audit-registration.test.mjs`
- Create: `plugins/uxie-ghl-factory/mcp-internal/dist/audit-server.mjs`
- Modify: `plugins/uxie-ghl-factory/mcp-internal/scripts/gen-manifest.mjs`
- Modify: `plugins/uxie-ghl-factory/mcp-internal/scripts/esbuild-config.mjs`
- Modify: `plugins/uxie-ghl-factory/mcp-internal/scripts/build.mjs`
- Modify: `plugins/uxie-ghl-factory/mcp-internal/test/bundle.test.mjs`
- Modify: `plugins/uxie-ghl-factory/mcp-internal/package.json`

**Interfaces:**

- `stdio-audit.mjs` always registers `toolsForProfile("audit")`.
- It creates one shared limiter and circuit.
- It has no environment switch to expose the full tool set.

- [ ] **Step 1: Write failing real-protocol tests**

Using a real `McpServer` and in-memory client, assert:

- `tools/list` exactly equals `AUDIT_TOOL_NAMES`.
- No tool has `confirm`.
- `tools/call get_workflow_runtime_window` returns the stable contract through a stub audit gateway.
- `tools/call list_workflows_complete` and `get_ai_configuration_bundle` preserve component completeness.
- Unknown credential-looking arguments remain scrubbed.

Using the committed child process, assert:

- `dist/audit-server.mjs` boots over stdio.
- `tools/list` contains no write, raw, course, or token-setting tools.
- `auth_status` works when the credential file is missing.
- Runtime collection returns `TOKEN_MISSING` before network access.

- [ ] **Step 2: Run and confirm failure**

```bash
node --test test/audit-registration.test.mjs test/bundle.test.mjs
```

Expected: FAIL because the audit entry point and bundle do not exist.

- [ ] **Step 3: Implement separate generation and bundling**

Generate:

```json
{
  "schemaVersion": "1.0",
  "profile": "audit",
  "proofModel": "external_capability_receipts_v1",
  "tools": [],
  "capabilities": [],
  "manifestHash": ""
}
```

Every capability row contains tool, host, method, normalized path, path and query bindings, required and optional query keys, fixed and allowed query values, numeric bounds, location-binding rule, and auth rail. The manifest hash covers the canonical manifest with `manifestHash` omitted. Generation fails if:

- A method is not `GET`.
- A host/rail pair is not exactly `backend/backend` or `services/ai`.
- A forbidden tool is present.
- A registered audit tool is absent from the manifest.
- A gateway descriptor and capability row differ.

Build both `dist/server.mjs` and `dist/audit-server.mjs`. Rebuild-and-diff tests must cover both.

- [ ] **Step 4: Run protocol and full tests**

```bash
npm run manifest
npm run build
node --test test/audit-registration.test.mjs test/bundle.test.mjs
npm test
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/uxie-ghl-factory/mcp-internal
git commit -m "feat(mcp-internal): ship audit-only stdio server"
```

---

### Task 6: Freeze documentation and the offline acceptance gate

**Files:**

- Modify: `plugins/uxie-ghl-factory/mcp-internal/tool-descriptions.json`
- Modify: `plugins/uxie-ghl-factory/mcp-internal/README.md`
- Modify: `plugins/uxie-ghl-factory/mcp-internal/test/readme-contract.test.mjs`
- Modify: `plugins/uxie-ghl-factory/mcp-internal/test/tools.test.mjs`

- [ ] **Step 1: Write failing documentation contract tests**

Require the runtime tool description to contain:

```text
proof: external-receipt-required
risk: read
live canary required before Full audit
```

Require README statements for:

- Exact runtime-window inputs and output
- Time-partition completeness and saturation behavior
- Short-lived elevated Bearer credential limitation
- Audit profile exclusions
- Credential refresh and partial-run behavior
- YAML-as-specification boundary
- Human-gated live-canary stop line

- [ ] **Step 2: Run and verify failure**

```bash
node --test test/readme-contract.test.mjs test/tools.test.mjs
```

Expected: FAIL until docs and descriptions are updated.

- [ ] **Step 3: Update the documentation without claiming live proof**

Keep composite tool descriptions invariant as `external-receipt-required`; never rewrite bundled descriptions after a canary. Keep the existing dated proof claims on already proven component endpoints. Explain that the composite completeness contract remains offline-proven until Task 7 and is resolved per capability from the external proof index. The absence of an unexpired external capability-proof receipt is machine-enforced and cannot support a Full audit.

- [ ] **Step 4: Run the offline gate**

```bash
npm run manifest
npm run build
npm test
git diff --check
git status --short
```

Expected: all tests PASS; only planned source, generated manifests, bundles, and docs are changed.

- [ ] **Step 5: Commit**

```bash
git add plugins/uxie-ghl-factory/mcp-internal
git commit -m "docs(mcp-internal): freeze audit runtime contract"
```

---

### Task 7: Human-gated live read-only canary

**Files:**

- Modify only after observed proof: `plugins/uxie-ghl-factory/mcp-internal/README.md`
- Create only after observed proof: `plugins/uxie-ghl-factory/mcp-internal/proof/audit-live-canary-<YYYY-MM-DD>.json`
- Create or update only after observed proof: `plugins/uxie-ghl-factory/mcp-internal/proof/audit-proof-index.json`
- Modify only after observed proof: proof ledger selected by the repository's existing convention

**Authorization gate:** Do not start this task from the plan alone. Obtain explicit user approval, a freshly captured credential file, exact location and workflow IDs, and an approved closed window.

- [ ] **Step 1: Prove the real audit registry before any runtime read**

Use only `dist/audit-server.mjs`. Call `tools/list` and preserve sanitized proof that the exact audit allowlist is present and no raw/write/course/token-setting tool exists.

- [ ] **Step 2: Run bounded read-only canaries**

Run:

- An empty or very small closed window
- A window requiring multiple log time partitions
- A complete multi-page workflow roster
- A complete enrollment walk
- One step roster
- Every applicable AI discovery and detail surface on the approved canary account

Every traced network call must be an allowlisted GET.

- [ ] **Step 3: Reconcile evidence**

Verify:

- Requested and applied windows
- Bound location
- Terminal log partitions
- Effective log page size 20 by reconciling dense 20-row partitions against smaller recursively split windows
- Workflow unique count against a stable reported total and definition/runtime coverage for every applicable workflow
- Terminal enrollment and roster pages
- Totals and unique counts
- AI discovery counts against successfully bound detail counts
- Sanitized samples against the GHL UI or an independently captured read-only response
- No raw PII, credentials, or full transcript in the proof ledger

- [ ] **Step 4: Exercise honest incompleteness**

Use an expired-auth or controlled safety-bound case. Confirm it produces incomplete/partial evidence and never Full.

- [ ] **Step 5: Record only observed proof**

Only after every check succeeds:

1. Write an immutable canary attestation containing the pseudonymous target hash as provenance only, approved windows, sanitized call-trace hashes, response hashes, effective page size, roster/enrollment/step/AI reconciliations, tool-profile hash, capability-manifest hash, the exact canaried bundle hash, approver, proof time, and an expiry no later than 30 days.
2. Add one proof-index entry per capability ID actually exercised. Each entry binds the immutable attestation hash, capability descriptor hash, `provenAt`, `expiresAt`, and observed proof class. Unexercised detail capabilities receive no receipt.
3. Verify the acyclic chain: canonical descriptors/profile to manifest hash, manifest to bundle hash, bundle and manifest to immutable canary attestation, and attestation hash to the separate proof index. The proof index is not bundled and neither the manifest nor bundle contains its hash.
4. Re-run offline `tools/list`, stdio, bundle, manifest, proof-index validation, and full tests without changing the canaried bundle. Any bundle-affecting change invalidates the attestation and requires a new bounded live canary before new receipts.

If any check fails, a capability receipt expires, or a bound descriptor/profile/manifest/bundle hash changes, that capability is only `offline_contract`. The weekly auditor must return Partial whenever a capability applicable to the run lacks an unexpired receipt.

Commit:

```bash
git add plugins/uxie-ghl-factory/mcp-internal
git commit -m "docs(mcp-internal): record live audit runtime proof"
```

Do not push.

## Manual Stop Lines

Stop for the user before:

1. Selecting the internal repository's git identity and auth/token.
2. Any live GHL call.
3. Any version bump, package publication, plugin release, push, or deployment.
4. Any change that would alter or remove the existing full MCP server.
