// RED contract tests for the strict internal audit MCP adapter (Task 11).
//
// Nothing here may import product code that does not exist yet apart from the module under
// test itself. The suite MUST fail on the missing `createInternalGhlAdapter` import, not on a
// malformed fixture.
//
// Conventions inherited from tests/adapters.test.mjs:
//   - flat top-level `test()` only; `describe`/`it` are used ZERO times in this suite
//   - errors are asserted by CODE REGEX, never by message text
//   - doubles are hand-rolled closures with an injected mutable call log; no mocking library
//
// SPLIT ERROR MODEL. On the internal server, policy violations THROW with `error.code` and
// response failures RETURN `{ok:false, code, failureClass}`. Both arrival shapes are modelled
// here: a `responses` entry that is an `Error` instance rejects; one that is an `{ok:false}`
// body resolves. A suite that only covers `ok:false` misses half the contract.
//
// ANTI-ORACLE RULE. Declared totals, reported page counts, roster sizes and coverage
// denominators are INDEPENDENT literal fixture inputs. Neither the fixtures nor these builders
// derive them from the rows actually served, so a declared total is free to disagree with the
// evidence — and the `liar-*` scenarios make it do exactly that.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { canonicalJson, sha256 } from '../lib/canonical.mjs';
// `sealFrozenInputs` is the R7-C1 host-seal minter: `analyzer.freezeInputs` is injected, so the
// kernel accepts an anchoring claim only when it arrives MAC'd with the run's own key material.
import { createAuditKernel, sealFrozenInputs } from '../lib/kernel.mjs';
import { openState } from '../lib/state.mjs';
// NAMESPACE import on purpose. Tests 12-15 and 18 need weekly-mode exports that do not exist
// yet; a NAMED import of a missing export is a link-time SyntaxError that would kill all
// nineteen tests at once and would also displace the required RED failure (the missing
// `lib/adapters/internal-ghl.mjs` module). A namespace import degrades to `undefined`, so each
// test fails on its own assertion instead.
import * as weeklyMode from '../lib/modes/weekly.mjs';
import { createInternalGhlAdapter } from '../lib/adapters/internal-ghl.mjs';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const HERE = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => JSON.parse(readFileSync(join(HERE, 'fixtures', 'internal', name), 'utf8'));

const MANIFEST = fixture('audit-capability-manifest.json');
const TOOLS_LIST = fixture('audit-tools-list.json');
const ROSTERS = fixture('roster-scenarios.json');
const RUNTIME = fixture('runtime-window-scenarios.json');
const DEFINITIONS = fixture('workflow-definitions.json');
const HISTORY = fixture('definition-history-scenarios.json');
const AI_BUNDLES = fixture('ai-bundle-scenarios.json');

// ---------------------------------------------------------------------------
// Internal-format hashing. `sha256:`-PREFIXED, recursive key sort, raw bytes for strings.
// This is byte-for-byte the internal repo's core/audit-proof.mjs; the weekly repo's own
// `sha256()` returns BARE hex and the two must never be conflated.
// ---------------------------------------------------------------------------

const canonical = (value) => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
};

const sha256Of = (value) => `sha256:${createHash('sha256').update(
  typeof value === 'string' ? value : JSON.stringify(canonical(value)),
).digest('hex')}`;

const attestationHashOf = (attestation) => {
  const { attestationHash: _omitted, ...rest } = attestation;
  return sha256Of(rest);
};

// ---------------------------------------------------------------------------
// Identities derived from the checked-in artefacts
// ---------------------------------------------------------------------------

const AUDIT_TOOL_NAMES = Object.freeze(TOOLS_LIST.tools.map((tool) => tool.name));
const TOOL_PROFILE_HASH = sha256Of([...AUDIT_TOOL_NAMES]);
const MANIFEST_HASH = sha256Of(MANIFEST);
// The bundle is a build artefact whose hash changes on every rebuild and is checked in nowhere,
// so a stand-in string is the only honest fixture value. What matters is that the SAME value
// travels through the attestation, the proof index and the adapter.
const BUNDLE_HASH = sha256Of('dist/audit-server.mjs stand-in');

// capabilityDescriptorHash is computed over the manifest capability row with `tool` stripped.
// It has to be: `workflow_detail`, `workflow_triggers` and `workflow_sticky_notes` each appear
// under several tools, so a `tool`-inclusive hash would be ambiguous per capabilityId. The
// stripped rows for a repeated id are byte-identical (verified against the checked-in manifest).
const DESCRIPTORS_BY_ID = (() => {
  const map = new Map();
  for (const row of MANIFEST.capabilities) {
    const { tool: _tool, ...descriptor } = row;
    map.set(descriptor.capabilityId, descriptor);
  }
  return map;
})();
const capabilityDescriptorHash = (capabilityId) => sha256Of(DESCRIPTORS_BY_ID.get(capabilityId));

const APPLICABLE_CAPABILITIES = Object.freeze([...DESCRIPTORS_BY_ID.keys()]);

// Live values published by each composite; see the contract reference §6.4.
const ROSTER_CAPABILITY_VERSION = 'sha256:5412de8667dc438bb0fb6913b5c76d0dff9fc1a5fe448679d1b8b05f4d8cb567';
const RUNTIME_CAPABILITY_VERSION = 'sha256:d5e5accaaf5d6f4c329ac5dcbb32f47fb1daa7dda6493653f75cf8e89cf39222';
const AI_CAPABILITY_VERSION = 'sha256:c789962561b6268a362810e24d3c8544af34cec4b5ed8f450d8617bbe9d816c0';

const LOCATION_ID = 'L1';
const COMPANY_ID = 'CO1';
const NOW_ISO = '2026-07-20T00:10:00.000Z';
const WINDOW = Object.freeze({ from: RUNTIME.window.fromIso, to: RUNTIME.window.toIso });
const TARGET = Object.freeze({ locationId: LOCATION_ID, companyId: COMPANY_ID });

// ---------------------------------------------------------------------------
// Proof-chain builders. Every hash is RECOMPUTED here, so corrupting one field genuinely
// breaks the chain instead of being waved through.
// ---------------------------------------------------------------------------

function makeAttestation(over = {}) {
  const base = {
    schemaVersion: '1.0',
    targetHash: sha256Of('pseudonymous-canary-target'),
    approvedWindows: [{ fromDate: RUNTIME.window.fromDate, toDate: RUNTIME.window.toDate }],
    callTraceHashes: [sha256Of('call-trace')],
    responseHashes: [sha256Of('response-set')],
    effectiveLogPageSize: 20,
    reconciliations: { roster: 'ok', runtime: 'ok', ai: 'ok' },
    toolProfileHash: TOOL_PROFILE_HASH,
    capabilityManifestHash: MANIFEST_HASH,
    bundleHash: BUNDLE_HASH,
    approver: 'a named human',
    provenAt: '2026-07-18T00:00:00.000Z',
    expiresAt: '2026-07-26T00:00:00.000Z',
    attestationHash: '',
    ...over,
  };
  // Hash LAST, over the object with its own hash field omitted.
  base.attestationHash = Object.hasOwn(over, 'attestationHash')
    ? over.attestationHash
    : attestationHashOf(base);
  return base;
}

function makeReceipt(capabilityId, attestation, over = {}) {
  return {
    capabilityId,
    attestationHash: attestation.attestationHash,
    capabilityDescriptorHash: capabilityDescriptorHash(capabilityId),
    provenAt: attestation.provenAt,
    expiresAt: attestation.expiresAt,
    proofClass: 'live_runtime',
    ...over,
  };
}

function makeProofIndex({
  capabilityIds = APPLICABLE_CAPABILITIES,
  attestation = makeAttestation(),
  extraAttestations = [],
  receiptOverrides = {},
  extraReceipts = [],
  indexOverrides = {},
  manifest = MANIFEST,
  bundleHash = BUNDLE_HASH,
} = {}) {
  const receipts = capabilityIds.map(
    (id) => makeReceipt(id, attestation, receiptOverrides[id] ?? {}),
  );
  const attestations = { [attestation.attestationHash]: attestation };
  for (const extra of extraAttestations) attestations[extra.attestationHash] = extra;
  return {
    index: { schemaVersion: '1.0', receipts: [...receipts, ...extraReceipts], ...indexOverrides },
    attestations,
    manifest,
    bundleHash,
  };
}

// ---------------------------------------------------------------------------
// The hermetic MCP client double
// ---------------------------------------------------------------------------

const EVIDENCE_TOOLS = new Set([
  'list_workflows_complete',
  'get_workflow',
  'export_workflow',
  'get_workflow_runtime_window',
  'get_ai_configuration_bundle',
]);

const evidenceCalls = (calls) => calls.filter((entry) => EVIDENCE_TOOLS.has(entry.name));
const callsFor = (calls, name) => calls.filter((entry) => entry.name === name);

const textResult = (body) => ({ content: [{ type: 'text', text: JSON.stringify(body, null, 2) }] });
const okBody = (data) => ({ ok: true, data });
const failBody = (code) => ({
  ok: false,
  code,
  detail: 'redacted for the fixture',
  remediation: 'redacted for the fixture',
});
const thrownFailure = (code) => Object.assign(new Error(code), { code });

/**
 * `responses` maps a tool name to one of:
 *   - a parsed body object (`{ok:true,data}` / `{ok:false,code,...}`), wrapped in the text envelope
 *   - an `Error` instance, which REJECTS (the throwing half of the split error model)
 *   - a `{content:[...]}` envelope, returned verbatim (for malformed-transport cases)
 *   - a function `(request, options, calls) => any of the above`
 *   - an array of the above, consumed one per call to that tool, last entry repeating
 * `responses.default` answers any tool without its own entry.
 */
function fakeAuditMcpClient({ toolsList = TOOLS_LIST, responses = {}, calls = [] } = {}) {
  const resolveResponse = async (name, request, options) => {
    let response = Object.hasOwn(responses, name) ? responses[name] : responses.default;
    if (response === undefined) throw thrownFailure('FIXTURE_RESPONSE_MISSING');
    if (Array.isArray(response)) {
      const index = callsFor(calls, name).length - 1;
      response = response[Math.min(Math.max(index, 0), response.length - 1)];
    }
    if (typeof response === 'function') response = await response(request, options, calls);
    if (response instanceof Error) throw response;
    if (response && typeof response === 'object' && Array.isArray(response.content)) return response;
    return textResult(response);
  };
  return {
    calls,
    // `tools/list`-style listing call.
    async listTools(options) {
      calls.push({ name: 'tools/list', arguments: null, options: options ?? null });
      if (toolsList instanceof Error) throw toolsList;
      if (typeof toolsList === 'function') return toolsList();
      return structuredClone(toolsList);
    },
    async callTool(request, options) {
      const name = request?.name;
      calls.push({
        name,
        arguments: request?.arguments === undefined ? null : structuredClone(request.arguments),
        options: options ?? null,
      });
      if (name === 'tools/list') {
        if (toolsList instanceof Error) throw toolsList;
        return textResult(okBody(structuredClone(toolsList)));
      }
      return resolveResponse(name, request, options);
    },
  };
}

// ---------------------------------------------------------------------------
// Response-body builders. Structural boilerplate only — never a count.
// ---------------------------------------------------------------------------

function route(capabilityId, appliedPath, { status = 200, ok = true, failureClass = null, capturedAt = '2026-07-20T00:05:00.000Z', host = 'backend', appliedQuery = {} } = {}) {
  return { capabilityId, host, appliedPath, appliedQuery, status, ok, failureClass, capturedAt };
}

function rosterBody(scenarioName, over = {}) {
  const scenario = ROSTERS[scenarioName];
  assert.ok(scenario, `unknown roster scenario ${scenarioName}`);
  const pageCount = Math.max(scenario.pagination.fetched, 1);
  return {
    appliedQueries: Array.from({ length: pageCount }, (_unused, index) => ({
      capabilityId: 'workflow_roster_list',
      query: {
        type: 'workflow',
        limit: '100',
        offset: String(index * 100),
        sortBy: 'name',
        sortOrder: 'asc',
        includeCustomObjects: 'true',
        includeObjectiveBuilder: 'true',
      },
    })),
    boundLocationId: LOCATION_ID,
    capabilityVersion: ROSTER_CAPABILITY_VERSION,
    capturedAt: '2026-07-20T00:05:00.000Z',
    complete: scenario.complete,
    locationBinding: { bindingMethod: 'native', quarantined: false, conflicts: [], inspectionIncomplete: false },
    pagination: scenario.pagination,
    rateLimit: { limited: false, retryAfterMs: null },
    reportedTotal: scenario.reportedTotal,
    sourceRoutes: Array.from({ length: pageCount }, () => route('workflow_roster_list', `/workflow/${LOCATION_ID}/list`)),
    terminalReason: scenario.terminalReason,
    totalHistory: scenario.totalHistory,
    truncated: !scenario.complete,
    uniqueCount: scenario.uniqueCount,
    uniqueProgress: scenario.uniqueProgress,
    warnings: scenario.warnings,
    workflows: scenario.workflows,
    ...over,
  };
}

function definitionBlock(definitionRef, validity) {
  const definition = DEFINITIONS[definitionRef];
  assert.ok(definition, `unknown definition ${definitionRef}`);
  return {
    workflow: definition.workflow,
    triggers: definition.triggers,
    stickyNotes: definition.stickyNotes,
    version: definition.version,
    hashAlgorithm: 'sha256',
    canonicalHash: definition.canonicalHash,
    capturedAt: definition.capturedAt,
    validity: validity ?? {
      effectiveFrom: null,
      effectiveTo: null,
      source: null,
      provenEffectiveInterval: false,
      appliesToRequestedWindow: 'unproven',
    },
  };
}

function exportBody(definitionRef) {
  const definition = DEFINITIONS[definitionRef];
  assert.ok(definition, `unknown definition ${definitionRef}`);
  return {
    workflow: definition.workflow,
    triggers: definition.triggers,
    stickyNotes: definition.stickyNotes,
  };
}

function runtimeBody(scenarioName, {
  workflowId = 'WF1',
  definitionRef = workflowId,
  validity,
  events,
  stepIds = [],
  over = {},
} = {}) {
  const scenario = RUNTIME[scenarioName];
  assert.ok(scenario, `unknown runtime scenario ${scenarioName}`);
  const windows = scenario.windowOverride ?? {
    requestedWindow: { fromDate: RUNTIME.window.fromDate, toDate: RUNTIME.window.toDate, boundaries: '[)' },
    appliedWindow: {
      fromDate: RUNTIME.window.fromDate - RUNTIME.window.expansionMs,
      toDate: RUNTIME.window.toDate,
      queryBoundaries: 'upstream-defined',
      analyticalFilter: '[)',
      expansionMs: RUNTIME.window.expansionMs,
    },
  };
  const enrollmentQuery = { action: 'first', limit: '20', fromDate: String(RUNTIME.window.fromDate), toDate: String(RUNTIME.window.toDate) };
  if (scenario.enrollmentCursor) Object.assign(enrollmentQuery, scenario.enrollmentCursor);
  return {
    contractVersion: '1.0.0',
    boundLocationId: LOCATION_ID,
    workflowId,
    requestedWindow: windows.requestedWindow,
    appliedWindow: windows.appliedWindow,
    appliedQueries: [
      { capabilityId: 'workflow_execution_logs', query: { fromDate: String(RUNTIME.window.fromDate - RUNTIME.window.expansionMs), toDate: String(RUNTIME.window.toDate), limit: '20' } },
      { capabilityId: 'workflow_enrollment_search', query: enrollmentQuery },
    ],
    filters: { contactId: null, eventTypes: [], stepIds },
    workflowDefinition: definitionBlock(definitionRef, validity),
    runtimeEvents: events ?? scenario.runtimeEvents,
    enrollments: scenario.enrollments,
    perStepCounts: scenario.perStepCounts,
    stepRosters: scenario.stepRosters,
    enrollmentTotals: scenario.enrollmentTotals,
    componentCompleteness: scenario.componentCompleteness,
    pagination: scenario.pagination,
    rateLimit: scenario.rateLimit,
    locationBinding: { bindingMethod: 'native', quarantined: false, conflicts: [], inspectionIncomplete: false },
    sourceRoutes: [
      route('workflow_detail', `/workflow/${LOCATION_ID}/${workflowId}`),
      route('workflow_execution_logs', '/workflows/logs/v2', {
        status: scenario.sourceRouteStatus ?? 200,
        ok: (scenario.sourceRouteFailureClass ?? null) === null,
        failureClass: scenario.sourceRouteFailureClass ?? null,
      }),
    ],
    capabilityVersion: RUNTIME_CAPABILITY_VERSION,
    capturedAt: '2026-07-20T00:05:00.000Z',
    configurationBinding: {
      definitionGovernedRuntimeEvents: 'unproven',
      provenBy: null,
      publishableAsGoverning: false,
      detail: 'The audit rail exposes no workflow version-history capability, so nothing here proves the captured definition was in force during the requested window.',
    },
    complete: scenario.complete,
    truncated: !scenario.complete,
    warnings: scenario.warnings,
    ...over,
  };
}

function aiBody(scenarioName, over = {}) {
  const scenario = AI_BUNDLES[scenarioName];
  assert.ok(scenario, `unknown ai bundle scenario ${scenarioName}`);
  return {
    appliedQueries: [{ capabilityId: 'conversation_ai_agent_discovery', component: 'conversation_ai', query: { locationId: LOCATION_ID } }],
    boundLocationId: LOCATION_ID,
    capabilityVersion: AI_CAPABILITY_VERSION,
    capturedAt: '2026-07-20T00:06:00.000Z',
    companyId: COMPANY_ID,
    complete: scenario.complete,
    components: scenario.components,
    contractVersion: '1.0.0',
    locationBinding: { bindingMethod: 'native', quarantined: false, conflicts: [], inspectionIncomplete: false },
    rateLimit: scenario.rateLimit,
    truncated: !scenario.complete,
    warnings: scenario.warnings,
    ...over,
  };
}

function authBody() {
  return okBody({
    tokenFile: '<configured>',
    jwtClaims: { present: true, uid: 'u-1', companyId: COMPANY_ID, exp: 4102444800, secondsRemaining: 3600 },
    tokenIdClaims: { present: true, issuer: 'ghl', role: 'admin', scope: 'read', exp: 4102444800, secondsRemaining: 3600 },
    engine: '0.1.0',
  });
}

function evidenceResponses({
  roster = 'one-page',
  rosterOver = {},
  runtimeByWorkflow = { WF1: 'complete-no-step-rosters', WF2: 'complete-no-step-rosters' },
  runtimeOptions = {},
  runtimeOver = {},
  exportByWorkflow = {},
  ai = 'complete',
  aiOver = {},
  overrides = {},
} = {}) {
  return {
    auth_status: authBody(),
    list_workflows_complete: okBody(rosterBody(roster, rosterOver)),
    export_workflow: (request) => {
      const id = request.arguments.workflowId;
      const override = exportByWorkflow[id];
      if (override !== undefined) return override;
      return okBody(exportBody(id));
    },
    get_workflow_runtime_window: (request) => {
      const id = request.arguments.workflowId;
      const scenarioName = runtimeByWorkflow[id];
      if (scenarioName === undefined) return failBody('HTTP_404');
      if (scenarioName instanceof Error) return scenarioName;
      if (typeof scenarioName === 'object') return scenarioName;
      return okBody(runtimeBody(scenarioName, {
        workflowId: id,
        stepIds: request.arguments.stepIds ?? [],
        ...(runtimeOptions[id] ?? {}),
        over: { ...(runtimeOptions[id]?.over ?? {}), ...runtimeOver },
      }));
    },
    get_ai_configuration_bundle: okBody(aiBody(ai, aiOver)),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Adapter construction + result accessors
// ---------------------------------------------------------------------------

// `omit` deletes a constructor key outright, which is the only way to model an ABSENT option:
// a destructuring default would silently reinstate it for `undefined`.
function makeAdapter({
  client,
  toolsList,
  responses = evidenceResponses(),
  calls = [],
  expectedContractVersion = '1.0.0',
  expectedLocationId = LOCATION_ID,
  expectedToolProfileHash = TOOL_PROFILE_HASH,
  capabilityProofIndex = makeProofIndex(),
  runtime = { now: () => Date.parse(NOW_ISO) },
  omit = [],
} = {}) {
  const options = {
    client: client ?? fakeAuditMcpClient({ toolsList, responses, calls }),
    expectedContractVersion,
    expectedLocationId,
    expectedToolProfileHash,
    capabilityProofIndex,
    runtime,
  };
  for (const key of omit) delete options[key];
  return createInternalGhlAdapter(options);
}

function collectFor(options = {}, request = {}) {
  const calls = options.calls ?? [];
  const adapter = makeAdapter({ ...options, calls });
  return {
    calls,
    result: adapter.collectAuditEvidence({
      target: TARGET,
      window: WINDOW,
      applicability: { capabilityIds: APPLICABLE_CAPABILITIES },
      stepRosterRequests: {},
      ...request,
    }),
  };
}

const CODE_PATTERN = /^(INTERNAL_AUDIT_[A-Z0-9_]+|AUDIT_INTEGRITY_FAILURE|AUDIT_QUARANTINED)$/u;

function codesOf(value, seen = new Set(), out = []) {
  if (typeof value === 'string') {
    if (CODE_PATTERN.test(value)) out.push(value);
    return out;
  }
  if (!value || typeof value !== 'object' || seen.has(value)) return out;
  seen.add(value);
  for (const nested of Object.values(value)) codesOf(nested, seen, out);
  return out;
}

const hasCode = (result, pattern) => codesOf(result).some((code) => pattern.test(code));

function coverageFor(result, capabilityId) {
  const coverage = result.capabilityCoverage;
  assert.ok(coverage, 'capabilityCoverage missing');
  const entry = Array.isArray(coverage)
    ? coverage.find((row) => row.capabilityId === capabilityId)
    : coverage[capabilityId];
  assert.ok(entry, `no capability coverage for ${capabilityId}`);
  return entry;
}

function workflowRecord(result, workflowId) {
  const list = Array.isArray(result.workflows)
    ? result.workflows
    : Object.values(result.workflows ?? {});
  const found = list.find((entry) => entry.workflowId === workflowId || entry.id === workflowId);
  assert.ok(found, `no workflow record for ${workflowId}`);
  return found;
}

const runtimeEventsOf = (record) => record.runtime?.events ?? record.events ?? record.runtimeEvents ?? [];

function eventRecord(record, eventId) {
  const found = runtimeEventsOf(record).find((entry) => entry.id === eventId);
  assert.ok(found, `no runtime event ${eventId}`);
  return found;
}

// ===========================================================================
// 1
// ===========================================================================

test('audit handshake accepts only the exact structural read-only registry', async () => {
  const calls = [];
  const adapter = makeAdapter({ calls });
  assert.equal(typeof adapter.collect, 'function');
  assert.equal(typeof adapter.collectAuditEvidence, 'function');

  const result = await adapter.collectAuditEvidence({
    target: TARGET,
    window: WINDOW,
    applicability: { capabilityIds: APPLICABLE_CAPABILITIES },
    stepRosterRequests: {},
  });
  assert.equal(result.source, 'internal_ghl');
  // The listing is the FIRST thing on the wire, before any evidence call.
  assert.equal(calls[0].name, 'tools/list');
  assert.ok(evidenceCalls(calls).length > 0);
  // Only the six registered names may ever be dispatched.
  for (const entry of calls) {
    assert.ok(
      entry.name === 'tools/list' || AUDIT_TOOL_NAMES.includes(entry.name),
      `unregistered tool dispatched: ${entry.name}`,
    );
  }
  // Legitimate descriptions contain the ordinary English words "trigger" and "publish". The
  // read-only token scan must therefore be scoped to TOOL NAMES and SCHEMA KEYS, never to
  // free-text metadata, or the honest registry rejects itself.
  const descriptions = TOOLS_LIST.tools.map((tool) => tool.description).join(' ');
  assert.match(descriptions, /trigger/u);
  assert.match(descriptions, /publish/u);

  const withTools = (tools) => ({ tools });
  const clone = () => structuredClone(TOOLS_LIST.tools);
  const named = (name) => ({ name, description: 'fixture', inputSchema: { type: 'object', properties: {} } });

  const rejections = [
    ['missing tool', withTools(clone().filter((tool) => tool.name !== 'export_workflow'))],
    ['duplicate tool', withTools([...clone(), clone().find((tool) => tool.name === 'get_workflow')])],
    ['extra tool', withTools([...clone(), named('list_account_entities')])],
    ['raw surface', withTools([...clone(), named('raw_request')])],
    ['token-setting surface', withTools([...clone(), named('set_token_file')])],
    ['write surface', withTools([...clone(), named('write_workflow_note')])],
    ['send surface', withTools([...clone(), named('send_message')])],
    ['publish surface', withTools([...clone(), named('publish_workflow')])],
    ['trigger surface', withTools([...clone(), named('trigger_workflow')])],
    ['fast-forward surface', withTools([...clone(), named('fast_forward_contacts')])],
    ['delete surface', withTools([...clone(), named('delete_workflow')])],
    ['remove surface', withTools([...clone(), named('remove_contact_tag')])],
    ['confirm surface', withTools([...clone(), named('confirm_action')])],
    ['course surface', withTools([...clone(), named('build_course')])],
    ['community surface', withTools([...clone(), named('list_communities')])],
    ['membership surface', withTools([...clone(), named('list_memberships')])],
    ['empty registry', withTools([])],
    ['missing tools array', {}],
    ['confirm in input schema', (() => {
      const tools = clone();
      const target = tools.find((tool) => tool.name === 'get_workflow');
      target.inputSchema.properties.confirm = { type: 'boolean' };
      return withTools(tools);
    })()],
    ['raw_request in input schema', (() => {
      const tools = clone();
      const target = tools.find((tool) => tool.name === 'export_workflow');
      target.inputSchema.properties.raw_request = { type: 'object' };
      return withTools(tools);
    })()],
    ['descriptors escape hatch in input schema', (() => {
      const tools = clone();
      const target = tools.find((tool) => tool.name === 'list_workflows_complete');
      target.inputSchema.properties.descriptors = { type: 'array' };
      return withTools(tools);
    })()],
    ['non-object input schema', (() => {
      const tools = clone();
      tools.find((tool) => tool.name === 'auth_status').inputSchema = { type: 'string' };
      return withTools(tools);
    })()],
  ];

  for (const [label, toolsList] of rejections) {
    const log = [];
    await assert.rejects(
      () => collectFor({ toolsList, calls: log }).result,
      /INTERNAL_AUDIT_HANDSHAKE_INVALID|INTERNAL_AUDIT_READ_ONLY_VIOLATION/u,
      label,
    );
    assert.equal(evidenceCalls(log).length, 0, `${label} reached an evidence call`);
  }

  // Reordering keeps the same six names but changes the profile hash, so it is refused too.
  const reordered = [...clone()].reverse();
  const reorderedCalls = [];
  await assert.rejects(
    () => collectFor({ toolsList: { tools: reordered }, calls: reorderedCalls }).result,
    /INTERNAL_AUDIT_HANDSHAKE_INVALID|INTERNAL_AUDIT_PROFILE_MISMATCH/u,
  );
  assert.equal(evidenceCalls(reorderedCalls).length, 0);
});

// ===========================================================================
// 2
// ===========================================================================

test('contract profile manifest and bundle must match the offline gate', async () => {
  // Positive: the exact gate passes, and the roster body legitimately carries NO
  // contractVersion (only the runtime window and the AI bundle publish one) — an adapter
  // that demanded it everywhere would reject honest evidence.
  const baseline = await collectFor().result;
  assert.equal(baseline.contractVersion, '1.0.0');
  assert.equal(baseline.toolProfileHash, TOOL_PROFILE_HASH);
  assert.equal(baseline.capabilityManifestHash, MANIFEST_HASH);
  assert.equal(baseline.bundleHash, BUNDLE_HASH);
  assert.equal(Object.hasOwn(rosterBody('one-page'), 'contractVersion'), false);

  // Contract-version drift, on both carriers.
  const versionCases = [
    ['runtime below', { runtimeOver: { contractVersion: '0.9.0' } }],
    ['runtime above', { runtimeOver: { contractVersion: '1.1.0' } }],
    ['runtime truncated', { runtimeOver: { contractVersion: '1.0' } }],
    ['runtime malformed', { runtimeOver: { contractVersion: 100 } }],
    ['runtime null', { runtimeOver: { contractVersion: null } }],
    ['ai below', { aiOver: { contractVersion: '0.9.9' } }],
    ['ai above', { aiOver: { contractVersion: '2.0.0' } }],
  ];
  for (const [label, options] of versionCases) {
    await assert.rejects(
      () => collectFor({ responses: evidenceResponses(options) }).result,
      /INTERNAL_AUDIT_CONTRACT_UNSUPPORTED/u,
      label,
    );
  }
  // A missing contractVersion on a carrier that must publish one.
  const missingRuntimeVersion = evidenceResponses();
  const innerRuntime = missingRuntimeVersion.get_workflow_runtime_window;
  missingRuntimeVersion.get_workflow_runtime_window = (request) => {
    const body = innerRuntime(request);
    delete body.data.contractVersion;
    return body;
  };
  await assert.rejects(
    () => collectFor({ responses: missingRuntimeVersion }).result,
    /INTERNAL_AUDIT_CONTRACT_UNSUPPORTED/u,
  );

  // Profile, manifest and bundle are all decided BEFORE any evidence call.
  const preDispatch = [
    ['wrong expected profile hash', { expectedToolProfileHash: sha256Of('not-the-audit-profile') }, /INTERNAL_AUDIT_PROFILE_MISMATCH/u],
    ['malformed expected profile hash', { expectedToolProfileHash: 'sha256:zzzz' }, /INTERNAL_AUDIT_PROFILE_MISMATCH/u],
    ['null expected profile hash', { expectedToolProfileHash: null }, /INTERNAL_AUDIT_PROFILE_MISMATCH/u],
    ['omitted expected profile hash', { omit: ['expectedToolProfileHash'] }, /INTERNAL_AUDIT_PROFILE_MISMATCH/u],
    ['manifest profile changed', { capabilityProofIndex: makeProofIndex({ manifest: { ...MANIFEST, profile: 'full' } }) }, /INTERNAL_AUDIT_MANIFEST_INVALID/u],
    ['manifest proof model changed', { capabilityProofIndex: makeProofIndex({ manifest: { ...MANIFEST, proofModel: 'trust_me_v1' } }) }, /INTERNAL_AUDIT_MANIFEST_INVALID/u],
    ['manifest schema version changed', { capabilityProofIndex: makeProofIndex({ manifest: { ...MANIFEST, schemaVersion: '2.0' } }) }, /INTERNAL_AUDIT_MANIFEST_INVALID/u],
    ['manifest self-hash broken', { capabilityProofIndex: makeProofIndex({ manifest: { ...MANIFEST, manifestHash: sha256Of('forged') } }) }, /INTERNAL_AUDIT_MANIFEST_INVALID/u],
    ['manifest tools drifted', { capabilityProofIndex: makeProofIndex({ manifest: { ...MANIFEST, tools: MANIFEST.tools.slice(0, 5) } }) }, /INTERNAL_AUDIT_MANIFEST_INVALID|INTERNAL_AUDIT_PROFILE_MISMATCH/u],
    ['manifest descriptor dropped', { capabilityProofIndex: makeProofIndex({ manifest: { ...MANIFEST, capabilities: MANIFEST.capabilities.slice(1) } }) }, /INTERNAL_AUDIT_MANIFEST_INVALID/u],
    ['manifest absent', { capabilityProofIndex: makeProofIndex({ manifest: null }) }, /INTERNAL_AUDIT_MANIFEST_INVALID/u],
    ['bundle hash absent', { capabilityProofIndex: makeProofIndex({ bundleHash: null }) }, /INTERNAL_AUDIT_MANIFEST_INVALID/u],
    ['bundle hash malformed', { capabilityProofIndex: makeProofIndex({ bundleHash: 'not-a-digest' }) }, /INTERNAL_AUDIT_MANIFEST_INVALID/u],
    ['expected contract version null', { expectedContractVersion: null }, /INTERNAL_AUDIT_CONTRACT_UNSUPPORTED/u],
    ['expected contract version omitted', { omit: ['expectedContractVersion'] }, /INTERNAL_AUDIT_CONTRACT_UNSUPPORTED/u],
    ['expected contract version wrong', { expectedContractVersion: '1.0.1' }, /INTERNAL_AUDIT_CONTRACT_UNSUPPORTED/u],
  ];
  for (const [label, options, pattern] of preDispatch) {
    const calls = [];
    await assert.rejects(() => collectFor({ ...options, calls }).result, pattern, label);
    assert.equal(evidenceCalls(calls).length, 0, `${label} reached an evidence call`);
  }

  // The manifest fixture is a genuine integrity anchor: its checked-in self-omitting hash
  // recomputes, so a mutated manifest cannot slip through by luck.
  const { manifestHash, ...withoutSelfHash } = MANIFEST;
  assert.equal(sha256Of(withoutSelfHash), manifestHash);
  assert.equal(manifestHash, 'sha256:5f41aaae210dc32573c8b569a0b04032436c5f10b99c1cb9ff29bf4d271f2407');
});

// ===========================================================================
// 3
// ===========================================================================

test('every applicable capability requires an unexpired live runtime receipt', async () => {
  const eligible = await collectFor().result;
  assert.equal(eligible.complete, true);
  for (const capabilityId of APPLICABLE_CAPABILITIES) {
    const coverage = coverageFor(eligible, capabilityId);
    assert.equal(coverage.applicable, true, capabilityId);
    assert.equal(coverage.proven, true, capabilityId);
    assert.equal(coverage.proofClass, 'live_runtime', capabilityId);
  }
  assert.equal(hasCode(eligible, /INTERNAL_AUDIT_(PROOF|CAPABILITY)_/u), false);

  const subject = 'workflow_roster_list';
  const sibling = 'workflow_execution_logs';
  const validAttestation = makeAttestation();

  // Corrupting a bound field must genuinely break the chain, not be waved through.
  const tampered = { ...validAttestation, bundleHash: sha256Of('a different bundle') };
  assert.notEqual(attestationHashOf(tampered), tampered.attestationHash);

  const cases = [
    ['missing receipt', makeProofIndex({
      capabilityIds: APPLICABLE_CAPABILITIES.filter((id) => id !== subject),
    })],
    // Applicable, but the canary never exercised it. Extra receipts for other capabilities
    // are not a substitute.
    ['unexercised capability', makeProofIndex({
      capabilityIds: APPLICABLE_CAPABILITIES.filter((id) => id !== subject),
      extraReceipts: [{
        capabilityId: 'workflow_roster_list_v2',
        attestationHash: validAttestation.attestationHash,
        capabilityDescriptorHash: capabilityDescriptorHash(subject),
        provenAt: validAttestation.provenAt,
        expiresAt: validAttestation.expiresAt,
        proofClass: 'live_runtime',
      }],
    })],
    ['expired receipt', makeProofIndex({
      attestation: makeAttestation({ provenAt: '2026-06-20T00:00:00.000Z', expiresAt: '2026-07-19T00:00:00.000Z' }),
    })],
    ['receipt expiring exactly now', makeProofIndex({
      attestation: makeAttestation({ provenAt: '2026-07-01T00:00:00.000Z', expiresAt: NOW_ISO }),
    })],
    ['future-dated receipt', makeProofIndex({
      attestation: makeAttestation({ provenAt: '2026-08-01T00:00:00.000Z', expiresAt: '2026-08-20T00:00:00.000Z' }),
    })],
    ['duplicate receipt', makeProofIndex({
      extraReceipts: [makeReceipt(subject, validAttestation, { proofClass: 'offline_contract' })],
    })],
    ['conflicting duplicate receipt', makeProofIndex({
      extraReceipts: [makeReceipt(subject, validAttestation, { expiresAt: '2026-09-01T00:00:00.000Z' })],
    })],
    ['wrong manifest hash', makeProofIndex({
      attestation: makeAttestation({ capabilityManifestHash: sha256Of('another manifest') }),
    })],
    ['wrong profile hash', makeProofIndex({
      attestation: makeAttestation({ toolProfileHash: sha256Of('another profile') }),
    })],
    ['wrong bundle hash', makeProofIndex({
      attestation: makeAttestation({ bundleHash: sha256Of('another bundle') }),
    })],
    ['wrong descriptor hash', makeProofIndex({
      receiptOverrides: { [subject]: { capabilityDescriptorHash: sha256Of('another descriptor') } },
    })],
    ['descriptor hash borrowed from a sibling', makeProofIndex({
      receiptOverrides: { [subject]: { capabilityDescriptorHash: capabilityDescriptorHash(sibling) } },
    })],
    ['unresolvable attestation', makeProofIndex({
      receiptOverrides: { [subject]: { attestationHash: sha256Of('no such attestation') } },
    })],
    ['tampered attestation', makeProofIndex({
      attestation: makeAttestation({ approver: 'someone else', attestationHash: validAttestation.attestationHash }),
    })],
    ['attestation field set drifted', makeProofIndex({
      attestation: (() => {
        const drifted = makeAttestation();
        delete drifted.reconciliations;
        return drifted;
      })(),
    })],
    ['attestation validity longer than the thirty day ceiling', makeProofIndex({
      attestation: makeAttestation({ provenAt: '2026-05-01T00:00:00.000Z', expiresAt: '2026-07-26T00:00:00.000Z' }),
    })],
    ['offline contract proof class', makeProofIndex({
      receiptOverrides: { [subject]: { proofClass: 'offline_contract' } },
    })],
    ['fixture-only proof class', makeProofIndex({
      receiptOverrides: { [subject]: { proofClass: 'fixture_only' } },
    })],
    ['no proof index at all', null],
    ['empty proof index', makeProofIndex({ capabilityIds: [] })],
    ['non-canonical index schema version', makeProofIndex({ indexOverrides: { schemaVersion: '2.0' } })],
    ['non-canonical index receipts', makeProofIndex({ indexOverrides: { receipts: { [subject]: 'proven' } } })],
    ['index is an array', { index: [], attestations: {}, manifest: MANIFEST, bundleHash: BUNDLE_HASH }],
    ['index is a string', { index: 'trust me', attestations: {}, manifest: MANIFEST, bundleHash: BUNDLE_HASH }],
    ['attestation store missing', { ...makeProofIndex(), attestations: null }],
  ];

  for (const [label, capabilityProofIndex] of cases) {
    const result = await collectFor({ capabilityProofIndex }).result;
    assert.equal(result.complete, false, `${label} should force Partial`);
    assert.ok(
      hasCode(result, /INTERNAL_AUDIT_PROOF_INVALID|INTERNAL_AUDIT_PROOF_EXPIRED|INTERNAL_AUDIT_CAPABILITY_UNPROVEN/u),
      `${label} produced no proof-family code`,
    );
    assert.equal(coverageFor(result, subject).proven, false, label);
  }

  // A receipt for one capability never proves a sibling, and a discovery receipt never proves
  // a detail route.
  const discoveryOnly = await collectFor({
    capabilityProofIndex: makeProofIndex({
      capabilityIds: APPLICABLE_CAPABILITIES.filter((id) => id !== 'conversation_ai_agent_detail'),
    }),
  }).result;
  assert.equal(coverageFor(discoveryOnly, 'conversation_ai_agent_discovery').proven, true);
  assert.equal(coverageFor(discoveryOnly, 'conversation_ai_agent_detail').proven, false);
  assert.equal(discoveryOnly.complete, false);

  // Unknown applicability is not a silent pass.
  const unknownApplicability = await collectFor({}, {
    applicability: { capabilityIds: [...APPLICABLE_CAPABILITIES, 'workflow_time_travel'] },
  }).result;
  assert.equal(unknownApplicability.complete, false);
  assert.ok(hasCode(unknownApplicability, /INTERNAL_AUDIT_CAPABILITY_UNPROVEN|INTERNAL_AUDIT_PROOF_INVALID/u));
});

// ===========================================================================
// 4
// ===========================================================================

test('canary target is provenance and current location binds independently', async () => {
  // A canary run against a DIFFERENT pseudonymous target still supports a valid receipt.
  const foreignTargetHash = sha256Of('a completely different pseudonymous account');
  const { result, calls } = collectFor({
    capabilityProofIndex: makeProofIndex({
      attestation: makeAttestation({ targetHash: foreignTargetHash }),
    }),
  });
  const resolved = await result;
  assert.equal(resolved.complete, true);
  assert.equal(coverageFor(resolved, 'workflow_roster_list').proven, true);
  assert.equal(resolved.boundLocationId, LOCATION_ID);

  // Provenance is never echoed as authorization, and never substituted for the location.
  const serialized = canonicalJson(resolved);
  assert.equal(serialized.includes(foreignTargetHash), false, 'canary target hash leaked into the result');

  // Every request the adapter issues binds the requested location.
  for (const entry of evidenceCalls(calls)) {
    assert.equal(entry.arguments.locationId, LOCATION_ID, entry.name);
  }

  // Every returned identity must equal it too. Each of these quarantines.
  const identityCases = [
    ['roster identity drift', { rosterOver: { boundLocationId: 'L2' } }],
    ['roster identity unresolved', { rosterOver: { boundLocationId: null } }],
    ['roster quarantined', { rosterOver: { locationBinding: { bindingMethod: 'mixed', quarantined: true, conflicts: [{ capabilityId: 'workflow_roster_list' }], inspectionIncomplete: false } } }],
    ['runtime identity drift', { runtimeOver: { boundLocationId: 'L2' } }],
    ['runtime identity unresolved', { runtimeOver: { boundLocationId: null } }],
    ['runtime quarantined', { runtimeOver: { locationBinding: { bindingMethod: 'mixed', quarantined: true, conflicts: [{ capabilityId: 'workflow_execution_logs' }], inspectionIncomplete: false } } }],
    ['ai identity drift', { aiOver: { boundLocationId: 'L2' } }],
    ['ai identity unresolved', { aiOver: { boundLocationId: null } }],
    ['ai quarantined', { aiOver: { locationBinding: { bindingMethod: 'mixed', quarantined: true, conflicts: [{ capabilityId: 'voice_ai_agent_discovery' }], inspectionIncomplete: false } } }],
  ];
  for (const [label, options] of identityCases) {
    await assert.rejects(
      () => collectFor({ responses: evidenceResponses(options) }).result,
      /INTERNAL_AUDIT_LOCATION_MISMATCH|AUDIT_QUARANTINED/u,
      label,
    );
  }

  // A run bound to a location the evidence never mentions is a mismatch, not a pass. The
  // canary target hash is not an alternative authorization for it.
  await assert.rejects(
    () => collectFor({
      expectedLocationId: 'L9',
      capabilityProofIndex: makeProofIndex({ attestation: makeAttestation({ targetHash: sha256Of('L9') }) }),
    }).result,
    /INTERNAL_AUDIT_LOCATION_MISMATCH|AUDIT_QUARANTINED/u,
  );

  // A blank, null or omitted expected location can never be resolved from the proof chain.
  for (const [label, options] of [
    ['blank', { expectedLocationId: '' }],
    ['null', { expectedLocationId: null }],
    ['omitted', { omit: ['expectedLocationId'] }],
  ]) {
    const log = [];
    await assert.rejects(
      () => collectFor({ ...options, calls: log }).result,
      /INTERNAL_AUDIT_LOCATION_MISMATCH|AUDIT_QUARANTINED/u,
      label,
    );
    assert.equal(evidenceCalls(log).length, 0, label);
  }
});

// ===========================================================================
// 5
// ===========================================================================

test('workflow roster reconciles terminal offset traversal', async () => {
  const reconciling = ['one-page', 'three-page', 'zero-total', 'reordered-duplicate', 'stable-total', 'exact-retry'];
  for (const name of reconciling) {
    const scenario = ROSTERS[name];
    assert.equal(scenario.expect, 'complete', `${name} fixture drifted`);
    const identified = scenario.workflows.filter((row) => typeof row.id === 'string');
    const ids = [...new Set(identified.map((row) => row.id))];
    const runtimeByWorkflow = Object.fromEntries(ids.map((id) => [id, 'complete-no-step-rosters']));
    const { result, calls } = collectFor({
      responses: evidenceResponses({ roster: name, runtimeByWorkflow }),
    });
    const resolved = await result;
    assert.equal(resolved.workflowRoster.complete, true, name);
    assert.equal(resolved.workflowRoster.sealed, true, name);
    assert.equal(resolved.workflowRoster.reportedTotal, scenario.reportedTotal, name);
    assert.equal(resolved.workflowRoster.terminalReason, scenario.terminalReason, name);
    assert.deepEqual([...resolved.workflowRoster.workflowIds].sort(), [...ids].sort(), name);
    assert.equal(hasCode(resolved, /INTERNAL_AUDIT_ROSTER_INCOMPLETE/u), false, name);
    // The sealed roster drives the child fan-out exactly.
    assert.equal(callsFor(calls, 'get_workflow_runtime_window').length, ids.length, name);
  }

  const failing = [
    'changed-total',
    'conflicting-duplicates',
    'missing-ids',
    'zero-progress',
    'premature-empty-page',
    'count-mismatch',
    'page-budget-exhausted',
    // ANTI-ORACLE: the server declares complete:true while its own independent ledger fields
    // contradict each other. A reconciliation supplied by the response cannot fail; the
    // adapter has to do the arithmetic itself.
    'liar-complete-count-mismatch',
    'liar-complete-rows-short-of-unique-count',
    'liar-complete-progress-ledger-short',
    'liar-complete-with-warnings',
  ];
  for (const name of failing) {
    assert.equal(ROSTERS[name].expect, 'incomplete', `${name} fixture drifted`);
    const { result, calls } = collectFor({ responses: evidenceResponses({ roster: name }) });
    const resolved = await result;
    assert.equal(resolved.complete, false, name);
    assert.equal(resolved.workflowRoster.complete, false, name);
    assert.notEqual(resolved.workflowRoster.sealed, true, name);
    assert.ok(hasCode(resolved, /INTERNAL_AUDIT_ROSTER_INCOMPLETE/u), `${name} produced no roster code`);
    // An unsealed roster may not fan out; an unsealed roster is also never fabricated empty.
    assert.equal(callsFor(calls, 'get_workflow_runtime_window').length, 0, name);
    assert.equal(callsFor(calls, 'export_workflow').length, 0, name);
    assert.notEqual(resolved.workflowRoster.workflowIds, undefined, name);
  }

  // A zero roster is Complete ONLY on a schema-valid terminal response that proves total zero.
  const emptyTerminal = await collectFor({
    responses: evidenceResponses({ roster: 'zero-total', runtimeByWorkflow: {} }),
  }).result;
  assert.equal(emptyTerminal.workflowRoster.complete, true);
  assert.deepEqual(emptyTerminal.workflowRoster.workflowIds, []);

  // `workflows: null` means "no page was ever read" and must never be read as an empty roster.
  const neverRead = await collectFor({
    responses: evidenceResponses({
      roster: 'zero-total',
      rosterOver: { workflows: null, complete: false, truncated: true, terminalReason: null, warnings: [{ code: 'ROSTER_PAGE_READ_FAILED', component: 'workflow_roster', detail: 'redacted', detailSamples: [], occurrences: 1 }] },
    }),
  }).result;
  assert.equal(neverRead.workflowRoster.complete, false);
  assert.ok(hasCode(neverRead, /INTERNAL_AUDIT_ROSTER_INCOMPLETE/u));

  // The throwing half of the split error model, and the returning half.
  for (const [label, response] of [
    ['thrown circuit', thrownFailure('CIRCUIT_OPEN')],
    ['thrown transport failure', thrownFailure('TRANSPORT_FAILED')],
    ['returned circuit', failBody('CIRCUIT_OPEN')],
    ['returned auth rejection', failBody('TOKEN_EXPIRED')],
    ['returned rate limit', failBody('RATE_LIMITED')],
    ['returned validation failure', failBody('VALIDATION_FAILED')],
  ]) {
    const { result, calls } = collectFor({
      responses: evidenceResponses({ overrides: { list_workflows_complete: response } }),
    });
    const resolved = await result;
    assert.equal(resolved.complete, false, label);
    assert.ok(hasCode(resolved, /INTERNAL_AUDIT_ROSTER_INCOMPLETE/u), label);
    assert.equal(callsFor(calls, 'get_workflow_runtime_window').length, 0, label);
  }
});

// ===========================================================================
// 6
// ===========================================================================

test('every roster workflow receives definition and runtime coverage', async () => {
  const { result, calls } = collectFor({
    responses: evidenceResponses({ roster: 'one-page' }),
  });
  const resolved = await result;
  assert.equal(resolved.complete, true);

  // The roster is SEALED before any child call.
  const rosterIndex = calls.findIndex((entry) => entry.name === 'list_workflows_complete');
  assert.ok(rosterIndex >= 0);
  for (const [index, entry] of calls.entries()) {
    if (entry.name === 'export_workflow' || entry.name === 'get_workflow_runtime_window') {
      assert.ok(index > rosterIndex, 'a child call preceded the roster seal');
    }
  }

  // Exact call set per unique applicable workflow.
  for (const workflowId of ['WF1', 'WF2']) {
    const forWorkflow = calls.filter((entry) => entry.arguments?.workflowId === workflowId);
    assert.deepEqual(
      [...new Set(forWorkflow.map((entry) => entry.name))].sort(),
      ['export_workflow', 'get_workflow_runtime_window'],
      workflowId,
    );
    assert.equal(callsFor(forWorkflow, 'export_workflow').length, 1, workflowId);
    assert.equal(callsFor(forWorkflow, 'get_workflow_runtime_window').length, 1, workflowId);
    const record = workflowRecord(resolved, workflowId);
    assert.equal(record.complete, true, workflowId);
    assert.equal(record.definition.version, DEFINITIONS[workflowId].version, workflowId);
    assert.equal(record.definition.definitionHash, DEFINITIONS[workflowId].canonicalHash, workflowId);
    assert.equal(typeof record.definition.capturedAt, 'string', workflowId);
    assert.ok(Array.isArray(record.definition.sourceRoutes), workflowId);
  }

  // Non-applicable workflows are never fetched, but are still recorded from the sealed roster.
  const narrowed = collectFor({
    responses: evidenceResponses({
      roster: 'three-page',
      runtimeByWorkflow: {
        WF1: 'complete-no-step-rosters',
        WF3: 'complete-no-step-rosters',
        WF5: 'complete-no-step-rosters',
      },
    }),
  }, { applicability: { capabilityIds: APPLICABLE_CAPABILITIES, workflowIds: ['WF1', 'WF3', 'WF5'] } });
  const narrowedResult = await narrowed.result;
  assert.deepEqual(
    [...new Set(callsFor(narrowed.calls, 'get_workflow_runtime_window').map((entry) => entry.arguments.workflowId))].sort(),
    ['WF1', 'WF3', 'WF5'],
  );
  assert.equal(callsFor(narrowed.calls, 'export_workflow').length, 3);
  assert.deepEqual([...narrowedResult.workflowRoster.workflowIds].sort(), ['WF1', 'WF2', 'WF3', 'WF4', 'WF5']);
  for (const workflowId of ['WF2', 'WF4']) {
    assert.equal(workflowRecord(narrowedResult, workflowId).applicable, false, workflowId);
  }

  // One missing definition, one missing runtime, and the thrown half of each. Complete
  // evidence from the sibling workflow survives every time.
  const partials = [
    ['definition returns a failure', { exportByWorkflow: { WF2: failBody('HTTP_404') } }, /INTERNAL_AUDIT_WORKFLOW_INCOMPLETE/u],
    ['definition throws', { exportByWorkflow: { WF2: thrownFailure('TRANSPORT_FAILED') } }, /INTERNAL_AUDIT_WORKFLOW_INCOMPLETE/u],
    ['runtime returns a failure', { runtimeByWorkflow: { WF1: 'complete-no-step-rosters', WF2: failBody('HTTP_403') } }, /INTERNAL_AUDIT_RUNTIME_INCOMPLETE|INTERNAL_AUDIT_WORKFLOW_INCOMPLETE/u],
    ['runtime throws', { runtimeByWorkflow: { WF1: 'complete-no-step-rosters', WF2: thrownFailure('CIRCUIT_OPEN') } }, /INTERNAL_AUDIT_RUNTIME_INCOMPLETE|INTERNAL_AUDIT_WORKFLOW_INCOMPLETE/u],
    ['runtime absent entirely', { runtimeByWorkflow: { WF1: 'complete-no-step-rosters' } }, /INTERNAL_AUDIT_RUNTIME_INCOMPLETE|INTERNAL_AUDIT_WORKFLOW_INCOMPLETE/u],
  ];
  for (const [label, options, pattern] of partials) {
    const partial = await collectFor({ responses: evidenceResponses(options) }).result;
    assert.equal(partial.complete, false, label);
    assert.ok(hasCode(partial, pattern), label);
    assert.equal(workflowRecord(partial, 'WF2').complete, false, label);
    assert.equal(workflowRecord(partial, 'WF1').complete, true, `${label} erased sibling evidence`);
    // The roster is not retroactively emptied by a child failure.
    assert.deepEqual([...partial.workflowRoster.workflowIds].sort(), ['WF1', 'WF2'], label);
  }

  // The definition the runtime window hashed must be the definition that was exported.
  const crossed = await collectFor({
    responses: evidenceResponses({
      runtimeOptions: { WF2: { definitionRef: 'WF1_V5' } },
    }),
  }).result;
  assert.equal(crossed.complete, false);
  assert.ok(hasCode(crossed, /INTERNAL_AUDIT_WORKFLOW_INCOMPLETE|AUDIT_INTEGRITY_FAILURE/u));

  // A definition whose declared canonical hash disagrees with its own payload is corrupt.
  const forgedHash = await collectFor({
    responses: evidenceResponses({
      runtimeOver: { workflowDefinition: { ...definitionBlock('WF1'), canonicalHash: '0'.repeat(64) } },
    }),
  }).result;
  assert.equal(forgedHash.complete, false);
  assert.ok(hasCode(forgedHash, /INTERNAL_AUDIT_WORKFLOW_INCOMPLETE|AUDIT_INTEGRITY_FAILURE/u));
});

// ===========================================================================
// 7
// ===========================================================================

test('runtime windows reconcile partitions enrollments totals and step rosters', async () => {
  const scenario = RUNTIME.complete;
  const { result, calls } = collectFor({
    responses: evidenceResponses({
      runtimeByWorkflow: { WF1: 'complete', WF2: 'complete-no-step-rosters' },
    }),
  }, { stepRosterRequests: { WF1: ['S1'] } });
  const resolved = await result;
  assert.equal(resolved.complete, true);

  // The window the adapter asked for, in epoch milliseconds, half-open.
  const runtimeCall = callsFor(calls, 'get_workflow_runtime_window').find((entry) => entry.arguments.workflowId === 'WF1');
  assert.equal(runtimeCall.arguments.fromDate, Date.parse(WINDOW.from));
  assert.equal(runtimeCall.arguments.toDate, Date.parse(WINDOW.to));
  assert.deepEqual(runtimeCall.arguments.stepIds, ['S1']);
  assert.equal(runtimeCall.arguments.locationId, LOCATION_ID);

  const record = workflowRecord(resolved, 'WF1');
  const runtime = record.runtime;
  assert.equal(record.complete, true);
  assert.deepEqual(runtime.requestedWindow, { fromDate: RUNTIME.window.fromDate, toDate: RUNTIME.window.toDate, boundaries: '[)' });
  assert.equal(runtime.appliedWindow.fromDate, RUNTIME.window.fromDate - RUNTIME.window.expansionMs);
  assert.equal(runtime.appliedWindow.toDate, RUNTIME.window.toDate);
  assert.equal(runtime.appliedWindow.expansionMs, RUNTIME.window.expansionMs);
  assert.equal(runtime.appliedWindow.analyticalFilter, '[)');
  assert.deepEqual(runtime.pagination, scenario.pagination);
  assert.deepEqual(runtime.perStepCounts, scenario.perStepCounts);
  // Controller decision D10 (round-3 finding R3-1): `stepRosters[].contacts[].id` is a contact
  // identifier and is now pseudonymised rather than echoed, so a byte-for-byte comparison against
  // the raw fixture is no longer the right assertion. Compare every other roster field exactly,
  // then assert the contact ids are pseudonyms of the right shape and cardinality. This is
  // STRICTLY STRONGER than the original: it still pins the whole roster ledger, and additionally
  // proves the raw contact id never survives.
  assert.deepEqual(
    runtime.stepRosters.map(({ contacts, ...rest }) => rest),
    scenario.stepRosters.map(({ contacts, ...rest }) => rest),
  );
  for (const [rosterIndex, roster] of runtime.stepRosters.entries()) {
    const fixtureContacts = scenario.stepRosters[rosterIndex].contacts;
    assert.equal(roster.contacts.length, fixtureContacts.length);
    for (const [contactIndex, contact] of roster.contacts.entries()) {
      assert.deepEqual(Object.keys(contact), ['id']);
      assert.match(contact.id, /^psn_[a-f0-9]{32}$/u);
      assert.notEqual(contact.id, fixtureContacts[contactIndex].id);
    }
  }
  assert.deepEqual(runtime.enrollmentTotals, scenario.enrollmentTotals);
  assert.deepEqual(runtime.componentCompleteness, scenario.componentCompleteness);
  assert.equal(runtime.capabilityVersion, RUNTIME_CAPABILITY_VERSION);
  assert.equal(runtime.boundLocationId, LOCATION_ID);
  assert.equal(typeof runtime.capturedAt, 'string');
  assert.ok(Array.isArray(runtime.sourceRoutes) && runtime.sourceRoutes.length > 0);
  for (const sourceRoute of runtime.sourceRoutes) {
    assert.ok(DESCRIPTORS_BY_ID.has(sourceRoute.capabilityId), sourceRoute.capabilityId);
  }
  // The enrollment cursor tuple survives intact, `referenceSequence` included.
  assert.deepEqual(runtime.enrollmentCursor ?? runtime.enrollments?.cursor, scenario.enrollmentCursor);
  assert.equal(runtime.enrollments.rows.length, scenario.enrollments.rows.length);
  assert.equal(runtimeEventsOf(record).length, scenario.runtimeEvents.length);

  // Every failing shape, including the ones the server itself declares Complete.
  const failing = [
    'declared-incomplete',
    'truncated',
    'saturated',
    'cursor-loop',
    'enrollment-budget-exhausted',
    'enrollment-total-mismatch',
    'rate-limited',
    'entitlement-refused',
    'step-roster-unsealed',
    'liar-complete-rows-exceed-total',
    'liar-complete-enrollments-without-totals',
    'liar-complete-with-warnings',
    'liar-complete-rate-limited',
    'liar-complete-step-roster-incomplete',
    'liar-window-expansion',
    'liar-window-wrong-request',
    'liar-half-open-violation',
  ];
  for (const name of failing) {
    assert.equal(RUNTIME[name].expect, 'incomplete', `${name} fixture drifted`);
    const stepRosterRequests = name === 'step-roster-unsealed'
      ? { WF1: ['S9'] }
      : (name === 'liar-complete-step-roster-incomplete' ? { WF1: ['S1', 'S2'] } : {});
    const partial = await collectFor({
      responses: evidenceResponses({
        runtimeByWorkflow: { WF1: name, WF2: 'complete-no-step-rosters' },
      }),
    }, { stepRosterRequests }).result;
    assert.equal(partial.complete, false, name);
    assert.equal(workflowRecord(partial, 'WF1').complete, false, name);
    assert.ok(
      hasCode(partial, /INTERNAL_AUDIT_RUNTIME_INCOMPLETE|INTERNAL_AUDIT_WORKFLOW_INCOMPLETE|AUDIT_INTEGRITY_FAILURE/u),
      `${name} produced no runtime code`,
    );
    // Never Complete, and never allowed to erase the sibling workflow's evidence.
    assert.equal(workflowRecord(partial, 'WF2').complete, true, name);
  }

  // Top-level failures, both arrival shapes.
  for (const [label, response] of [
    ['returned 403', failBody('HTTP_403')],
    ['returned 429', failBody('RATE_LIMITED')],
    ['returned circuit open', failBody('CIRCUIT_OPEN')],
    ['returned invalid window', failBody('INVALID_RUNTIME_WINDOW')],
    ['thrown circuit open', thrownFailure('CIRCUIT_OPEN')],
    ['thrown engine abort', thrownFailure('ENGINE_ABORT')],
  ]) {
    const partial = await collectFor({
      responses: evidenceResponses({
        runtimeByWorkflow: { WF1: response, WF2: 'complete-no-step-rosters' },
      }),
    }).result;
    assert.equal(partial.complete, false, label);
    assert.ok(hasCode(partial, /INTERNAL_AUDIT_RUNTIME_INCOMPLETE|INTERNAL_AUDIT_WORKFLOW_INCOMPLETE/u), label);
    // `error.partial` is an in-process contract on the server; it never reaches the wire, so
    // a CIRCUIT_OPEN body carries no salvageable evidence and must not be invented.
    assert.equal(workflowRecord(partial, 'WF1').runtime, null, label);
  }
});

// ===========================================================================
// 8
// ===========================================================================

test('historical events bind only to an effective definition', async () => {
  const scenarioNames = Object.keys(HISTORY).filter(
    (key) => !['note', 'window', 'hashes'].includes(key),
  );
  // All five cases the brief demands, plus the interval gap, must be present.
  assert.deepEqual(scenarioNames.sort(), [
    'change-after-window',
    'change-inside-window',
    'event-on-effective-boundary',
    'gap-between-version-intervals',
    'no-version-history-source',
    'overlapping-version-intervals',
  ]);

  for (const name of scenarioNames) {
    const scenario = HISTORY[name];
    const definitionRef = scenario.currentDefinitionRef;
    const currentHash = DEFINITIONS[definitionRef].canonicalHash;
    const events = scenario.events.map((event) => ({
      id: event.id,
      timestamp: event.timestamp,
      timestampField: 'startedExecutionAt',
      unreadableTimestampFields: [],
      event: { _id: event.id },
    }));

    const partial = await collectFor({
      responses: evidenceResponses({
        runtimeByWorkflow: { WF1: 'complete-no-step-rosters', WF2: 'complete-no-step-rosters' },
        runtimeOptions: {
          WF1: { definitionRef, validity: scenario.validity, events },
        },
        exportByWorkflow: { WF1: okBody(exportBody(definitionRef)) },
      }),
    }).result;

    const record = workflowRecord(partial, 'WF1');
    // The current definition hash is preserved separately, whatever the binding verdict.
    assert.equal(record.definition.definitionHash, currentHash, name);
    assert.equal(record.configurationBinding.currentDefinitionHash, currentHash, name);

    for (const expected of scenario.events) {
      const bound = eventRecord(record, expected.id);
      // The event is RETAINED as observed runtime evidence in every case.
      assert.equal(bound.id, expected.id, `${name}/${expected.id}`);
      assert.equal(bound.timestamp, expected.timestamp, `${name}/${expected.id}`);
      assert.equal(
        bound.workflowDefinitionHash,
        expected.expectedDefinitionHash,
        `${name}/${expected.id} bound the wrong definition`,
      );
      assert.equal(
        bound.supportsDirectMechanismProof,
        expected.expectedCausalProof,
        `${name}/${expected.id} causal eligibility`,
      );
    }

    if (scenario.expect === 'unbound') {
      // Nothing may claim the captured definition governed these events, and no C3 direct
      // mechanism proof may rest on them. Configuration-to-execution stops at correlation.
      assert.equal(record.configurationBinding.publishableAsGoverning, false, name);
      assert.notEqual(record.configurationBinding.definitionGovernedRuntimeEvents, 'proven', name);
      assert.equal(record.configurationBinding.provenBy, null, name);
      assert.ok(
        typeof record.configurationBinding.limitation === 'string'
          && record.configurationBinding.limitation.length > 0,
        `${name} lost the limitation`,
      );
      for (const expected of scenario.events) {
        assert.equal(eventRecord(record, expected.id).workflowDefinitionHash, null, name);
      }
    }
  }

  // The only shape reachable against today's server: validity is all-null, so every event in
  // the window is retained with a null definition hash.
  const live = HISTORY['no-version-history-source'];
  assert.equal(live.validity.source, null);
  assert.equal(live.validity.provenEffectiveInterval, false);
  assert.equal(live.events.every((event) => event.expectedDefinitionHash === null), true);
});

// ---- tests 9-16 appended by the second RED author ----
//
// Everything below reuses the harness above: `fixture`, `sha256Of`, `makeAttestation`,
// `makeProofIndex`, `fakeAuditMcpClient`, `rosterBody`/`runtimeBody`/`aiBody`,
// `evidenceResponses`, `makeAdapter`, `collectFor`, `hasCode`, `coverageFor`,
// `workflowRecord`, `eventRecord`. No parallel harness is introduced; `ai-bundle-scenarios.json`
// was extended in place with the surfaces test 9 needs, and `merge-scenarios.json` is a new
// fixture that follows the same ANTI-ORACLE discipline (every declared count is a hand-typed
// literal, never derived from the rows it travels with).

const MERGE = fixture('merge-scenarios.json');
const CANARIES = MERGE.canaries;
const COVERAGE_POLICY = MERGE.coveragePolicy;

// The exact ten machine gates of the brief's `complete_full` eligibility section, in order.
const FULL_ELIGIBILITY_GATES = Object.freeze([
  'capability_coverage',
  'live_runtime_receipts',
  'workflow_roster_and_coverage',
  'ai_discovery_and_details',
  'reconciliation',
  'snapshot_skew',
  'read_only_trace',
  'claim_support',
  'privacy_scan',
  'verifier',
]);

const REQUIRED_WINDOWS = Object.freeze([
  Object.freeze({ windowId: 'analytical', from: WINDOW.from, to: WINDOW.to }),
]);

const EXPECTED_IDENTITIES = Object.freeze({
  contractVersion: '1.0.0',
  locationId: LOCATION_ID,
  toolProfileHash: TOOL_PROFILE_HASH,
  capabilityManifestHash: MANIFEST_HASH,
  bundleHash: BUNDLE_HASH,
});

// Surfaces the audit rail must never request or return. The onboarding portal adapter stays
// the only portal evidence source.
const EXCLUDED_PORTAL_TOKENS = Object.freeze([
  'course', 'courses', 'lesson', 'lessons', 'offer', 'offers',
  'membership', 'memberships', 'community', 'communities',
  'assessment', 'assessments', 'certificate', 'certificates', 'credential',
]);

// ---------------------------------------------------------------------------
// Shared helpers for tests 9-19
// ---------------------------------------------------------------------------

function requireExport(name) {
  const value = weeklyMode[name];
  assert.equal(
    typeof value,
    'function',
    `lib/modes/weekly.mjs must export ${name}() — see the RED report's implementation contract`,
  );
  return value;
}

const scan = (value) => JSON.stringify(value ?? null);

function assertNoCanary(value, label) {
  const serialized = scan(value);
  for (const [name, canary] of Object.entries(CANARIES)) {
    if (name === 'note') continue;
    assert.equal(serialized.includes(canary), false, `${label} leaked the ${name} canary`);
  }
}

function assertDeeplyFrozen(value, path = '$', seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  assert.equal(Object.isFrozen(value), true, `${path} is not frozen`);
  if (Array.isArray(value)) {
    value.forEach((child, index) => assertDeeplyFrozen(child, `${path}[${index}]`, seen));
  } else {
    for (const [key, child] of Object.entries(value)) {
      assertDeeplyFrozen(child, `${path}.${key}`, seen);
    }
  }
}

// A local restatement of the kernel's private `assertSafeCollected` (lib/kernel.mjs:84-97).
// It is not exported, so the oracle lives here rather than being imported.
const WRITE_VERBS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function assertNoWriteOrRawTrace(value, label, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  for (const [key, child] of Object.entries(value)) {
    const normalized = key.toLowerCase().replaceAll(/[^a-z]/gu, '');
    assert.equal(
      ['rawrequest', 'mutationtool', 'authorization', 'cookie'].includes(normalized),
      false,
      `${label} carries a ${key} field`,
    );
    assert.equal(
      normalized === 'method' && WRITE_VERBS.has(String(child).toUpperCase()),
      false,
      `${label} carries a write method`,
    );
    assertNoWriteOrRawTrace(child, label, seen);
  }
  seen.delete(value);
}

// Public-rail Task 4 envelope. `reportedCount` is the fixture's INDEPENDENT declared literal;
// `collectedCount` is what lib/adapters/collection.mjs stamps from the rows. The two are free
// to disagree, and `liar-complete-count-mismatch` makes them.
function publicEnvelope(name, { table = 'envelopes', items, operationId, boundLocationId } = {}) {
  const spec = MERGE[table][name];
  assert.ok(spec, `unknown public envelope scenario ${table}/${name}`);
  const rows = structuredClone(items ?? MERGE.publicItems.baseline);
  const envelope = {
    source: 'public_ghl',
    operationId: operationId ?? `public-${table}-${name}`,
    boundLocationId: boundLocationId ?? spec.boundLocationId ?? LOCATION_ID,
    requestedWindow: { ...MERGE.requestedWindow },
    appliedWindow: { ...MERGE.requestedWindow },
    capturedAt: spec.capturedAt,
    items: rows,
    page: {
      cursor: null,
      nextCursor: null,
      reportedCount: spec.declaredReportedCount,
      collectedCount: rows.length,
      complete: spec.complete,
      truncated: !spec.complete,
    },
  };
  if (!spec.complete) envelope.incompleteReason = spec.incompleteReason;
  return envelope;
}

const PUBLIC_CHECKPOINT = Object.freeze({
  schemaVersion: '1.0.0',
  phase: 'collecting_public',
  cursor: null,
  collectedOperationIds: Object.freeze(['public-envelopes-baseline']),
});

async function mergeFor({
  publicName = 'baseline',
  publicEvidence,
  internalEvidence,
  refresh,
  refreshCalls = [],
  coveragePolicy = COVERAGE_POLICY,
  checkpoint = PUBLIC_CHECKPOINT,
  now = NOW_ISO,
} = {}) {
  const mergeInternalEvidence = requireExport('mergeInternalEvidence');
  const envelopes = publicEvidence ?? [publicEnvelope(publicName)];
  const refreshPublicEvidence = async (request) => {
    refreshCalls.push(structuredClone(request ?? null));
    if (refresh === undefined) throw thrownFailure('PUBLIC_REFRESH_NOT_EXPECTED');
    if (refresh instanceof Error) throw refresh;
    if (typeof refresh === 'function') return refresh(request);
    return publicEnvelope(refresh, { table: 'refreshes', operationId: `public-refresh-${refresh}` });
  };
  return {
    refreshCalls,
    envelopes,
    result: await mergeInternalEvidence({
      publicEvidence: structuredClone(envelopes),
      internalEvidence,
      coveragePolicy,
      checkpoint: structuredClone(checkpoint),
      refreshPublicEvidence,
      runtime: { now: () => Date.parse(now) },
    }),
  };
}

function entitiesOf(result) {
  const list = Array.isArray(result.entities) ? result.entities : Object.values(result.entities ?? {});
  assert.ok(Array.isArray(list), 'merge result exposes no entities');
  return list;
}

function entityFor(result, kind, nativeId) {
  const found = entitiesOf(result).find(
    (entry) => entry.kind === kind && entry.nativeId === nativeId,
  );
  assert.ok(found, `no merged entity for ${kind}:${nativeId}`);
  return found;
}

const mergeIdentity = (result) => canonicalJson({
  status: result.status,
  entities: entitiesOf(result),
  conflicts: result.conflicts,
  limitations: result.limitations,
});

function gateFor(decision, gateId) {
  const list = Array.isArray(decision.gates) ? decision.gates : Object.values(decision.gates ?? {});
  const found = list.find((entry) => entry.id === gateId || entry.gateId === gateId);
  assert.ok(found, `no eligibility gate ${gateId}`);
  return found;
}

const limitationCodes = (decision) => (decision.limitations ?? []).map(
  (entry) => (typeof entry === 'string' ? entry : entry.code),
);

function withTempState(callback) {
  const projectRoot = mkdtempSync(join(tmpdir(), 'ghl-internal-adapter-'));
  const state = openState({ projectRoot, locationId: LOCATION_ID });
  try {
    return callback({ state, projectRoot });
  } finally {
    state.close();
    rmSync(projectRoot, { recursive: true, force: true });
  }
}

// Mirrors the frozen-input builder used by tests/state.test.mjs and tests/replay-resume.test.mjs.
const RESUME_SOURCE = Object.freeze({
  sourceId: 'source-internal',
  kind: 'private-content',
  sourceHash: 'b'.repeat(64),
});

function resumeFrozenInputs(overrides = {}) {
  const inventory = [RESUME_SOURCE];
  return {
    locationId: LOCATION_ID,
    target: {
      targetKind: 'location',
      operatingProfile: 'client',
      locationId: LOCATION_ID,
    },
    cutoff: Date.parse(NOW_ISO),
    timezone: 'Australia/Sydney',
    contextHash: 'context-1',
    coverageProfileHash: 'coverage-1',
    metricProfileHash: 'metric-1',
    rulesetHash: 'rules-1',
    codeHash: 'code-1',
    auditProfileHash: 'profile-1',
    providerToolProfileHash: TOOL_PROFILE_HASH,
    windowDefinitionsHash: 'windows-1',
    collectionBudgetHash: 'budget-1',
    capabilityManifestHashes: [MANIFEST_HASH],
    capabilityProofIndexHash: 'proof-index-1',
    capabilityReceiptHashes: ['receipt-1'],
    capabilityAttestationHashes: ['attestation-1'],
    capabilityProofExpiries: [Date.parse('2026-07-26T00:00:00.000Z')],
    privateSourceInventory: inventory,
    privateSourceInventoryHash: sha256(inventory),
    ...overrides,
  };
}

function readAllBytes(root, out = []) {
  for (const entry of readdirSync(root)) {
    const pathname = join(root, entry);
    if (statSync(pathname).isDirectory()) readAllBytes(pathname, out);
    else out.push(readFileSync(pathname));
  }
  return out;
}

// ===========================================================================
// 9
// ===========================================================================

test('all applicable AI surfaces require terminal discovery and details', async () => {
  // Every one of the three enumerated surfaces applicable, discovered and detailed.
  const { result, calls } = collectFor({
    responses: evidenceResponses({ ai: 'all-surfaces-complete' }),
  });
  const resolved = await result;
  assert.equal(resolved.complete, true);

  const surfaces = ['conversation_ai', 'voice_ai', 'agent_studio'];
  const componentFor = (value, surface) => {
    const bundle = value.aiConfiguration;
    assert.ok(bundle, 'aiConfiguration missing');
    const components = Array.isArray(bundle.components)
      ? bundle.components.find((entry) => entry.component === surface || entry.surface === surface)
      : bundle.components?.[surface];
    assert.ok(components, `no AI component for ${surface}`);
    return components;
  };
  for (const surface of surfaces) {
    const component = componentFor(resolved, surface);
    assert.equal(component.applicable, true, surface);
    assert.equal(component.complete, true, surface);
    assert.equal(component.discoveryTerminal, true, surface);
  }
  assert.equal(hasCode(resolved, /INTERNAL_AUDIT_AI_INCOMPLETE/u), false);

  // The bundle is asked for with the bound location AND the typed companyId Agent Studio needs.
  const bundleCall = callsFor(calls, 'get_ai_configuration_bundle').at(0);
  assert.ok(bundleCall, 'the AI bundle was never requested');
  assert.equal(bundleCall.arguments.locationId, LOCATION_ID);
  assert.equal(bundleCall.arguments.companyId, COMPANY_ID);

  // Portal surfaces are never REQUESTED and never RETURNED.
  const requested = scan(calls).toLowerCase();
  const returned = scan(resolved).toLowerCase();
  for (const token of EXCLUDED_PORTAL_TOKENS) {
    assert.equal(requested.includes(`"${token}"`), false, `${token} was requested`);
    assert.equal(returned.includes(`"${token}"`), false, `${token} was returned`);
  }

  // A terminal, schema-valid, EMPTY discovery on every surface is Complete.
  const empty = await collectFor({ responses: evidenceResponses({ ai: 'terminal-empty' }) }).result;
  assert.equal(empty.complete, true);
  for (const surface of surfaces) {
    const component = componentFor(empty, surface);
    assert.equal(component.complete, true, surface);
    assert.equal(component.discoveryTerminal, true, surface);
    assert.deepEqual(component.items ?? [], [], surface);
    assert.equal(component.detailDenominator, 0, surface);
  }

  // A confirmed Voice tombstone needs BOTH signals. It is RETAINED as discovery evidence and
  // EXCLUDED from the detail denominator.
  const tombstoned = await collectFor({
    responses: evidenceResponses({ ai: 'voice-tombstone-confirmed' }),
  }).result;
  assert.equal(tombstoned.complete, true);
  const voice = componentFor(tombstoned, 'voice_ai');
  assert.equal(voice.complete, true);
  assert.equal(voice.detailDenominator, 1, 'the tombstone was counted in the denominator');
  const discovered = (voice.items ?? []).map((entry) => entry.id).sort();
  assert.deepEqual(discovered, ['VA1', 'VA2'], 'the tombstone was dropped from discovery');
  const tombstone = (voice.items ?? []).find((entry) => entry.id === 'VA2');
  assert.equal(tombstone.applicable, false);
  assert.equal(tombstone.tombstoneProven, true);
  assert.equal(tombstone.detailRequired, false);

  // ONE deletion signal alone never proves non-applicability.
  for (const name of ['voice-tombstone-deleted-only', 'voice-tombstone-inactive-only']) {
    assert.equal(AI_BUNDLES[name].expect, 'incomplete', `${name} fixture drifted`);
    const partial = await collectFor({ responses: evidenceResponses({ ai: name }) }).result;
    assert.equal(partial.complete, false, name);
    assert.equal(componentFor(partial, 'voice_ai').complete, false, name);
    assert.ok(hasCode(partial, /INTERNAL_AUDIT_AI_INCOMPLETE/u), name);
    // Sibling surfaces keep their complete evidence.
    assert.equal(componentFor(partial, 'conversation_ai').complete, true, name);
  }

  // Every remaining Partial trigger the brief enumerates.
  const partialCases = [
    ['unknown applicability', { ai: 'unknown-applicability' }, 'conversation_ai'],
    ['failed component', { ai: 'failed-component' }, 'voice_ai'],
    ['malformed success', { ai: 'malformed-success' }, 'conversation_ai'],
    ['missing detail', { ai: 'missing-detail' }, 'conversation_ai'],
    ['incomplete pagination', { ai: 'incomplete-pagination' }, 'agent_studio'],
    // ANTI-ORACLE: declared coverage numbers actively disagree with the served rows while the
    // body still claims complete:true.
    ['liar voice denominator', { ai: 'liar-complete-voice-denominator' }, 'voice_ai'],
    ['liar agent studio total', { ai: 'liar-complete-agent-studio-total' }, 'agent_studio'],
    ['liar conversation denominator', { ai: 'liar-complete-detail-denominator' }, 'conversation_ai'],
  ];
  for (const [label, options, surface] of partialCases) {
    const partial = await collectFor({ responses: evidenceResponses(options) }).result;
    assert.equal(partial.complete, false, label);
    assert.equal(componentFor(partial, surface).complete, false, label);
    assert.ok(hasCode(partial, /INTERNAL_AUDIT_AI_INCOMPLETE/u), `${label} produced no AI code`);
    // Never converted to an empty healthy array.
    assert.notEqual(componentFor(partial, surface).applicable, false, label);
  }

  // A wrong-location AI identity is a location failure, not a soft Partial.
  await assert.rejects(
    () => collectFor({ responses: evidenceResponses({ ai: 'wrong-location-identity' }) }).result,
    /INTERNAL_AUDIT_LOCATION_MISMATCH|AUDIT_QUARANTINED|INTERNAL_AUDIT_AI_INCOMPLETE/u,
  );

  // Missing company context while Agent Studio is applicable.
  const noCompany = await collectFor({
    responses: evidenceResponses({ ai: 'all-surfaces-complete', aiOver: { companyId: null } }),
  }).result;
  assert.equal(noCompany.complete, false);
  assert.equal(componentFor(noCompany, 'agent_studio').complete, false);
  assert.ok(hasCode(noCompany, /INTERNAL_AUDIT_AI_INCOMPLETE/u));

  // An unproven DETAIL route cannot be laundered by a proven DISCOVERY route.
  const unprovenDetail = await collectFor({
    responses: evidenceResponses({ ai: 'all-surfaces-complete' }),
    capabilityProofIndex: makeProofIndex({
      capabilityIds: APPLICABLE_CAPABILITIES.filter((id) => id !== 'voice_ai_agent_detail'),
    }),
  }).result;
  assert.equal(unprovenDetail.complete, false);
  assert.equal(coverageFor(unprovenDetail, 'voice_ai_agent_discovery').proven, true);
  assert.equal(coverageFor(unprovenDetail, 'voice_ai_agent_detail').proven, false);
  assert.equal(componentFor(unprovenDetail, 'voice_ai').complete, false);

  // A server that volunteers portal surfaces is refused; nothing about them is returned.
  const excluded = await collectFor({
    responses: evidenceResponses({ ai: 'excluded-portal-surfaces' }),
  }).result;
  assert.equal(excluded.complete, false);
  assert.ok(hasCode(excluded, /INTERNAL_AUDIT_AI_INCOMPLETE|INTERNAL_AUDIT_MANIFEST_INVALID|INTERNAL_AUDIT_READ_ONLY_VIOLATION/u));
  const excludedSerialized = scan(excluded).toLowerCase();
  for (const token of EXCLUDED_PORTAL_TOKENS) {
    assert.equal(excludedSerialized.includes(`"${token}"`), false, token);
  }

  // Discovery/detail failures never take the whole bundle to a hard failure state either: the
  // full three-surface set is always enumerated, even when a surface is Partial.
  for (const value of [empty, noCompany, unprovenDetail]) {
    for (const surface of surfaces) componentFor(value, surface);
  }
});

// ===========================================================================
// 10
// ===========================================================================

test('public and internal evidence merge preserves provenance and conflicts', async () => {
  requireExport('mergeInternalEvidence');
  const internal = await collectFor({
    responses: evidenceResponses({
      runtimeOptions: {
        WF1: { events: MERGE.internalRuntimeEvents['contradicting-contact-outcome'] },
      },
    }),
  }).result;
  assert.equal(internal.complete, true);

  const first = await mergeFor({ internalEvidence: internal });
  assert.equal(first.result.status, 'COMPLETE');
  assert.equal(first.refreshCalls.length, 0, 'a within-policy merge refreshed anyway');

  // Determinism under input reordering. The rails, the envelope order and the row order inside
  // each envelope are all shuffled; the canonical merge product must be byte-identical.
  const shuffled = [
    publicEnvelope('baseline', {
      operationId: 'public-envelopes-baseline',
      items: [...MERGE.publicItems.baseline].reverse(),
    }),
  ];
  const second = await mergeFor({ internalEvidence: internal, publicEvidence: shuffled });
  assert.equal(
    mergeIdentity(second.result),
    mergeIdentity(first.result),
    'merge output moved when only the input order changed',
  );

  // Rail provenance and capture metadata survive on a natively joined entity.
  const wf1 = entityFor(first.result, 'workflow', 'WF1');
  assert.equal(wf1.joinBasis, 'provider_native_id');
  assert.deepEqual([...wf1.rails].sort(), ['internal', 'public']);
  const provenanceFor = (entity, rail) => {
    const found = (entity.provenance ?? []).find((entry) => entry.rail === rail);
    assert.ok(found, `no ${rail} provenance`);
    return found;
  };
  const publicProvenance = provenanceFor(wf1, 'public');
  assert.equal(publicProvenance.source, 'public_ghl');
  assert.equal(publicProvenance.operationId, 'public-envelopes-baseline');
  assert.equal(publicProvenance.capturedAt, MERGE.envelopes.baseline.capturedAt);
  assert.deepEqual(publicProvenance.requestedWindow, MERGE.requestedWindow);
  assert.deepEqual(publicProvenance.appliedWindow, MERGE.requestedWindow);
  const internalProvenance = provenanceFor(wf1, 'internal');
  assert.equal(internalProvenance.source, 'internal_ghl');
  assert.equal(internalProvenance.operationId, internal.operationId);
  assert.equal(internalProvenance.capturedAt, internal.capturedAt);

  // Internal evidence MAY add workflow, runtime and configuration facts.
  assert.equal(wf1.internalFacts.definition.definitionHash, DEFINITIONS.WF1.canonicalHash);
  assert.notEqual(wf1.internalFacts.runtime, null);
  assert.notEqual(wf1.internalFacts.configurationBinding, undefined);

  // Fuzzy identity NEVER proves a join. The decoy row shares WF2's display name, status and a
  // capture timestamp but carries no native ID, so it stays its own unjoined entity.
  const workflowEntities = entitiesOf(first.result).filter((entry) => entry.kind === 'workflow');
  assert.equal(workflowEntities.length, 3, 'a fuzzy row was folded into a native entity');
  const unjoined = workflowEntities.filter((entry) => entry.joinBasis !== 'provider_native_id');
  assert.equal(unjoined.length, 1);
  assert.equal(unjoined[0].nativeId, null);
  assert.equal(unjoined[0].joinBasis, 'unjoined');
  assert.deepEqual(unjoined[0].rails, ['public']);
  const wf2 = entityFor(first.result, 'workflow', 'WF2');
  assert.deepEqual([...wf2.rails].sort(), ['internal', 'public']);
  assert.equal((wf2.provenance ?? []).filter((entry) => entry.rail === 'public').length, 1);

  // A native public/internal contradiction stays an EXPLICIT conflict. Public says WF1 is a
  // draft; the internal roster says it is published. Neither wins.
  assert.deepEqual(wf1.fields.status, {
    state: 'CONFLICT',
    publicValue: 'draft',
    internalValue: 'published',
  });
  assert.ok(
    (first.result.conflicts ?? []).some(
      (entry) => entry.nativeId === 'WF1' && entry.field === 'status' && entry.resolution === 'conflict',
    ),
    'the native status contradiction was resolved last-write-wins',
  );

  // Internal evidence may NOT overwrite public contacts, appointments, opportunities, messages
  // or outcomes. The internal runtime event claims CT1 was a no-show; public says booked.
  const contact = entityFor(first.result, 'contact', 'CT1');
  assert.deepEqual(contact.fields.outcome, {
    state: 'CONFLICT',
    publicValue: 'booked',
    internalValue: 'no_show',
  });
  assert.ok(
    (first.result.conflicts ?? []).some(
      (entry) => entry.nativeId === 'CT1'
        && entry.field === 'outcome'
        && entry.publicOwnedDomain === true,
    ),
    'an internal write into a public-owned domain was not flagged',
  );
  for (const [kind, nativeId, field, value] of [
    ['appointment', 'AP1', 'state', 'showed'],
    ['opportunity', 'OP1', 'stage', 'won'],
    ['message', 'MSG1', 'direction', 'inbound'],
  ]) {
    assert.equal(entityFor(first.result, kind, nativeId).fields[field], value, `${kind} was overwritten`);
  }

  // Each rail is checked INDEPENDENTLY before anything merges. A public envelope whose own
  // ledger contradicts itself is never merged, however healthy the internal rail is.
  const liar = await mergeFor({
    internalEvidence: internal,
    publicName: 'liar-complete-count-mismatch',
  });
  assert.notEqual(liar.result.status, 'COMPLETE');
  assert.ok(
    limitationCodes(liar.result).some((code) => /PUBLIC|RECONCIL|INCOMPLETE/u.test(code)),
    'a self-contradicting public envelope merged anyway',
  );

  // A public envelope bound to another location is an integrity conflict, not a soft partial.
  const foreign = await mergeFor({
    internalEvidence: internal,
    publicEvidence: [publicEnvelope('baseline', { boundLocationId: 'L2' })],
  });
  assert.equal(foreign.result.status, 'QUARANTINED');

  // No public rail at all cannot be silently treated as agreement.
  const noPublic = await mergeFor({ internalEvidence: internal, publicEvidence: [] });
  assert.notEqual(noPublic.result.status, 'COMPLETE');

  // Neither rail's raw evidence is discarded by merging.
  assert.deepEqual(first.result.publicEvidence, first.envelopes);
  assert.equal(first.result.internalEvidence.operationId, internal.operationId);
  assertDeeplyFrozen(first.result, 'merge');
});

// ===========================================================================
// 11
// ===========================================================================

test('snapshot skew refreshes public evidence without moving the cutoff', async () => {
  requireExport('mergeInternalEvidence');
  const internal = await collectFor().result;
  const cutoff = COVERAGE_POLICY.analyticalCutoff;

  // Within policy: merge immediately, never call the refresh.
  const within = await mergeFor({ internalEvidence: internal, publicName: 'skew-within-policy' });
  assert.equal(within.result.status, 'COMPLETE');
  assert.equal(within.result.skew.withinPolicy, true);
  assert.equal(within.result.skew.refreshed, false);
  assert.equal(within.refreshCalls.length, 0, 'a within-policy snapshot was refreshed');
  assert.equal(within.result.analyticalCutoff, cutoff);

  // Above policy with a complete, location-bound refresh: EXACTLY one refresh call.
  const refreshed = await mergeFor({
    internalEvidence: internal,
    publicName: 'skew-above-policy',
    refresh: 'complete',
  });
  assert.equal(refreshed.refreshCalls.length, 1, 'the approved public refresh was not called once');
  assert.equal(refreshed.result.status, 'COMPLETE');
  assert.equal(refreshed.result.skew.refreshed, true);
  assert.equal(refreshed.result.skew.withinPolicy, true);
  assert.equal(refreshed.result.analyticalCutoff, cutoff, 'the analytical cutoff moved');
  // The bounded refresh asks for the SAME window; it never widens the collection.
  assert.deepEqual(refreshed.refreshCalls[0].requestedWindow, MERGE.requestedWindow);
  assert.match(String(refreshed.refreshCalls[0].reason), /SKEW/u);

  // Every failing refresh preserves the already collected public evidence AND the checkpoint,
  // and forces Partial with PUBLIC_INTERNAL_SNAPSHOT_SKEW. The cutoff never moves.
  const failures = [
    ['incomplete refresh', 'incomplete'],
    ['rate-limited refresh', 'rate-limited'],
    ['wrong-location refresh', 'wrong-location'],
    ['stale refresh', 'stale'],
    ['refresh throws', thrownFailure('RATE_LIMITED')],
  ];
  for (const [label, refresh] of failures) {
    const attempt = await mergeFor({
      internalEvidence: internal,
      publicName: 'skew-above-policy',
      refresh,
    });
    assert.equal(attempt.refreshCalls.length, 1, `${label} did not call the refresh exactly once`);
    assert.notEqual(attempt.result.status, 'COMPLETE', label);
    assert.ok(
      limitationCodes(attempt.result).includes('PUBLIC_INTERNAL_SNAPSHOT_SKEW'),
      `${label} lost the skew limitation`,
    );
    assert.equal(attempt.result.skew.withinPolicy, false, label);
    assert.equal(attempt.result.analyticalCutoff, cutoff, `${label} moved the analytical cutoff`);
    // The already collected evidence and the checkpoint survive byte-identically.
    assert.deepEqual(attempt.result.publicEvidence, attempt.envelopes, `${label} discarded public evidence`);
    assert.deepEqual(attempt.result.checkpoint, PUBLIC_CHECKPOINT, `${label} discarded the checkpoint`);
    // The bad refreshed snapshot is never mixed in.
    assert.equal(
      scan(attempt.result.publicEvidence).includes('public-refresh-'),
      false,
      `${label} mixed an incompatible snapshot`,
    );
  }

  // A location-mismatched refresh is additionally an integrity problem, not merely stale data.
  const wrongLocation = await mergeFor({
    internalEvidence: internal,
    publicName: 'skew-above-policy',
    refresh: 'wrong-location',
  });
  assert.ok(
    ['PARTIAL', 'QUARANTINED'].includes(wrongLocation.result.status),
    'a cross-location refresh was accepted',
  );
});

// ===========================================================================
// 12
// ===========================================================================

test('expired internal auth checkpoints after public evidence', async () => {
  const collectInternalEvidencePhase = requireExport('collectInternalEvidencePhase');
  const envelopes = [publicEnvelope('baseline')];

  const run = async ({ responses, calls = [] }) => {
    const adapter = makeAdapter({ responses, calls });
    return {
      calls,
      result: await collectInternalEvidencePhase({
        adapter,
        target: TARGET,
        window: WINDOW,
        applicability: { capabilityIds: APPLICABLE_CAPABILITIES },
        stepRosterRequests: {},
        publicEvidence: structuredClone(envelopes),
        checkpoint: structuredClone(PUBLIC_CHECKPOINT),
      }),
    };
  };

  // Healthy credentials proceed into the internal collection phase.
  const healthy = await run({ responses: evidenceResponses() });
  assert.equal(healthy.result.phase, 'collecting_internal');
  assert.equal(healthy.result.internalEvidence.source, 'internal_ghl');
  assert.ok(evidenceCalls(healthy.calls).length > 0);
  assert.deepEqual(healthy.result.publicEvidence, envelopes);

  // Every credential state the brief enumerates. All four checkpoint at awaiting_internal_auth.
  const credentialCases = [
    ['missing credential', okBody({
      tokenFile: null,
      jwtClaims: { present: false, uid: null, companyId: null, exp: null, secondsRemaining: null },
      tokenIdClaims: { present: false, issuer: null, role: null, scope: null, exp: null, secondsRemaining: null },
      engine: '0.1.0',
    })],
    ['short-lived credential', okBody({
      // Planted canaries: a short-lived credential must not be described by echoing it.
      tokenFile: CANARIES.privatePath,
      jwtClaims: { present: true, uid: 'u-1', companyId: COMPANY_ID, exp: 4102444800, secondsRemaining: 30 },
      tokenIdClaims: { present: true, issuer: 'ghl', role: 'admin', scope: 'read', exp: 4102444800, secondsRemaining: 30 },
      engine: '0.1.0',
      keyReference: CANARIES.keyReference,
    })],
    ['expired credential', failBody('TOKEN_EXPIRED')],
    ['rejected credential', failBody('UNAUTHORIZED')],
    ['rejected credential (thrown)', thrownFailure('TOKEN_EXPIRED')],
  ];

  const checkpointBytes = new Map();
  for (const [label, auth] of credentialCases) {
    const attempt = await run({
      responses: evidenceResponses({ overrides: { auth_status: auth } }),
    });
    const { result, calls } = attempt;
    assert.equal(result.phase, 'awaiting_internal_auth', label);
    assert.equal(result.internalEvidence, null, label);
    // Public evidence and the public checkpoint are durably preserved.
    assert.deepEqual(result.publicEvidence, envelopes, `${label} lost public evidence`);
    assert.deepEqual(result.checkpoint, PUBLIC_CHECKPOINT, `${label} lost the public checkpoint`);
    assert.ok(hasCode(result, /INTERNAL_AUDIT_AUTH_REQUIRED/u), `${label} produced no auth code`);
    // NO internal evidence call follows the auth boundary.
    assert.equal(evidenceCalls(calls).length, 0, `${label} collected evidence anyway`);
    // Nothing credential-shaped escapes into the safe output.
    assertNoCanary(result, label);
    assertNoWriteOrRawTrace(result, label);
    assert.equal(scan(result).toLowerCase().includes('bearer '), false, label);
    // The checkpoint is stable across identical runs.
    const repeat = await run({ responses: evidenceResponses({ overrides: { auth_status: auth } }) });
    assert.equal(
      canonicalJson(repeat.result.checkpoint),
      canonicalJson(result.checkpoint),
      `${label} produced an unstable checkpoint`,
    );
    checkpointBytes.set(label, canonicalJson(result.checkpoint));
  }
  assert.equal(checkpointBytes.size, credentialCases.length);

  // A successful auth_status is not, on its own, capability proof or complete evidence.
  const authOnly = await run({
    responses: evidenceResponses({
      overrides: { list_workflows_complete: failBody('TOKEN_EXPIRED') },
    }),
  });
  assert.notEqual(authOnly.result.internalEvidence, null);
  assert.equal(authOnly.result.internalEvidence.complete, false);

  // Internal auth is resolved only AFTER public evidence exists to preserve.
  await assert.rejects(
    () => collectInternalEvidencePhase({
      adapter: makeAdapter({}),
      target: TARGET,
      window: WINDOW,
      applicability: { capabilityIds: APPLICABLE_CAPABILITIES },
      stepRosterRequests: {},
      checkpoint: structuredClone(PUBLIC_CHECKPOINT),
    }),
    /INTERNAL_AUDIT_|AUDIT_INTEGRITY_FAILURE/u,
  );
});

// ===========================================================================
// 13
// ===========================================================================

test('offline contract proof never enables full publication', async () => {
  const evaluateFullEligibility = requireExport('evaluateFullEligibility');

  // Every internal fixture PASSES. Only the proof class is offline.
  const offlineProof = makeProofIndex({
    receiptOverrides: Object.fromEntries(
      APPLICABLE_CAPABILITIES.map((id) => [id, { proofClass: 'offline_contract' }]),
    ),
  });
  const internal = await collectFor({
    responses: evidenceResponses({ ai: 'all-surfaces-complete' }),
    capabilityProofIndex: offlineProof,
  }).result;

  // The evidence itself reconciles: the roster is sealed and the workflows are covered. The
  // ONLY thing missing is a live_runtime receipt.
  assert.equal(internal.workflowRoster.complete, true);
  assert.equal(workflowRecord(internal, 'WF1').complete, true);
  assert.equal(workflowRecord(internal, 'WF2').complete, true);
  assert.equal(internal.complete, false, 'offline proof produced a Complete internal result');
  for (const capabilityId of APPLICABLE_CAPABILITIES) {
    assert.equal(coverageFor(internal, capabilityId).proven, false, capabilityId);
    assert.notEqual(coverageFor(internal, capabilityId).proofClass, 'live_runtime', capabilityId);
  }

  const merged = await mergeFor({ internalEvidence: internal });
  const decision = await evaluateFullEligibility({
    internalEvidence: internal,
    merge: merged.result,
    trace: MERGE.traces.clean,
    claimSupport: MERGE.claimSupport.eligible,
    privacyScan: { passed: true },
    verification: { passed: true },
    requiredWindows: REQUIRED_WINDOWS,
    expected: EXPECTED_IDENTITIES,
  });

  assert.equal(decision.status, 'complete_partial');
  assert.equal(decision.eligible, false);
  assert.ok(decision.failedGates.includes('live_runtime_receipts'));
  assert.equal(gateFor(decision, 'live_runtime_receipts').passed, false);

  // The missing-live-proof limitation NAMES the affected capabilities and the claims they block.
  const limitation = (decision.limitations ?? []).find(
    (entry) => /CAPABILITY_UNPROVEN|PROOF_INVALID|LIVE_PROOF/u.test(entry.code ?? ''),
  );
  assert.ok(limitation, 'no explicit missing-live-proof limitation');
  assert.ok(Array.isArray(limitation.capabilityIds), 'the limitation names no capabilities');
  for (const capabilityId of ['workflow_roster_list', 'workflow_execution_logs', 'conversation_ai_agent_detail']) {
    assert.ok(limitation.capabilityIds.includes(capabilityId), `${capabilityId} unnamed`);
  }
  assert.ok(Array.isArray(limitation.claimIds), 'the limitation names no claims');
  assert.deepEqual([...limitation.claimIds].sort(), ['C1', 'C2']);

  // A documented endpoint, an installed adapter and a passing offline bundle change nothing.
  assert.notEqual(decision.status, 'complete_full');
  assert.equal(decision.publishesFindings, true, 'an honest complete_partial still publishes');
});

// ===========================================================================
// 14
// ===========================================================================

test('full eligibility requires all ten machine gates', async () => {
  const evaluateFullEligibility = requireExport('evaluateFullEligibility');
  const enforcePublicOnlyPublication = requireExport('enforcePublicOnlyPublication');

  // ---------------------------------------------------------------------
  // CONTRACT TEST, NOT OBSERVED LIVE PROOF.
  //
  // Every `live_runtime` receipt below is SYNTHETIC: it is minted by this file's
  // `makeAttestation`/`makeReceipt` builders against local fixtures. No GHL account was
  // contacted, no canary was run, and nothing here is evidence that the live rail works. This
  // block proves only that the eligibility function's ten gates CAN all be satisfied and that
  // failing any one of them takes the run out of Full. A real `complete_full` still requires a
  // separately human-gated, short-lived live canary.
  // ---------------------------------------------------------------------
  const SYNTHETIC_LIVE_RUNTIME_RECEIPTS = true;
  assert.equal(SYNTHETIC_LIVE_RUNTIME_RECEIPTS, true);
  assert.equal(makeAttestation().targetHash, sha256Of('pseudonymous-canary-target'));

  const healthyInternal = await collectFor({
    responses: evidenceResponses({ ai: 'all-surfaces-complete' }),
  }).result;
  assert.equal(healthyInternal.complete, true);
  const healthyMerge = (await mergeFor({ internalEvidence: healthyInternal })).result;
  assert.equal(healthyMerge.status, 'COMPLETE');

  // Finding R2-M1: every decision under test NAMES the run it describes, and every publication
  // gate below states that same run. An unbound decision can never lift the clamp.
  const RUN = { runId: 'run_ten_gates', frozenInputsHash: 'd'.repeat(64) };
  const baseInputs = {
    internalEvidence: healthyInternal,
    merge: healthyMerge,
    trace: MERGE.traces.clean,
    claimSupport: MERGE.claimSupport.eligible,
    privacyScan: { passed: true },
    verification: { passed: true },
    requiredWindows: REQUIRED_WINDOWS,
    expected: EXPECTED_IDENTITIES,
    // Decision D11: the run's SEALED frozen inputs are the only thing that can anchor an
    // identity, so every decision under test is genuinely sealed rather than self-vouched.
    frozenInputs: r3FrozenInputs(),
    // Finding R7-C1: and the host states that IT authenticated this exact anchor block, so the
    // control's Full decision is properly provenanced rather than merely asserted.
    frozenInputProvenance: anchorProvenanceFor(r3FrozenInputs()),
    run: RUN,
  };
  const evaluate = (overrides = {}) => evaluateFullEligibility({ ...baseInputs, ...overrides });

  const full = await evaluate();
  assert.equal(full.status, 'complete_full');
  assert.equal(full.eligible, true);
  assert.deepEqual(full.failedGates, []);
  assert.deepEqual(
    (Array.isArray(full.gates) ? full.gates : Object.values(full.gates)).map(
      (gate) => gate.id ?? gate.gateId,
    ),
    [...FULL_ELIGIBILITY_GATES],
    'the ten machine gates are not all reported, in order',
  );
  for (const gateId of FULL_ELIGIBILITY_GATES) assert.equal(gateFor(full, gateId).passed, true, gateId);
  assertDeeplyFrozen(full, 'eligibility');

  // Gate 1 — capability coverage COMPLETE for every REQUIRED window.
  const missingWindow = await evaluate({
    requiredWindows: [
      ...REQUIRED_WINDOWS,
      { windowId: 'prior_quarter', from: '2026-04-13T00:00:00.000Z', to: '2026-07-13T00:00:00.000Z' },
    ],
  });
  assert.equal(missingWindow.status, 'complete_partial');
  assert.equal(gateFor(missingWindow, 'capability_coverage').passed, false);

  // Gate 2 — unexpired live_runtime receipt chain.
  const expiredInternal = await collectFor({
    capabilityProofIndex: makeProofIndex({
      attestation: makeAttestation({
        provenAt: '2026-06-20T00:00:00.000Z',
        expiresAt: '2026-07-19T00:00:00.000Z',
      }),
    }),
  }).result;
  const expired = await evaluate({
    internalEvidence: expiredInternal,
    merge: (await mergeFor({ internalEvidence: expiredInternal })).result,
  });
  assert.equal(expired.status, 'complete_partial');
  assert.equal(gateFor(expired, 'live_runtime_receipts').passed, false);

  // Gate 3 — sealed roster plus complete per-workflow definition and runtime.
  for (const [label, options] of [
    ['unsealed roster', { roster: 'changed-total' }],
    ['missing definition', { exportByWorkflow: { WF2: failBody('HTTP_404') } }],
    ['missing runtime', { runtimeByWorkflow: { WF1: 'complete-no-step-rosters' } }],
  ]) {
    const internal = await collectFor({ responses: evidenceResponses(options) }).result;
    const decision = await evaluate({
      internalEvidence: internal,
      merge: (await mergeFor({ internalEvidence: internal })).result,
    });
    assert.equal(decision.status, 'complete_partial', label);
    assert.equal(gateFor(decision, 'workflow_roster_and_coverage').passed, false, label);
  }

  // Gate 4 — terminal AI discovery plus complete required details.
  const aiPartialInternal = await collectFor({
    responses: evidenceResponses({ ai: 'missing-detail' }),
  }).result;
  const aiPartial = await evaluate({
    internalEvidence: aiPartialInternal,
    merge: (await mergeFor({ internalEvidence: aiPartialInternal })).result,
  });
  assert.equal(aiPartial.status, 'complete_partial');
  assert.equal(gateFor(aiPartial, 'ai_discovery_and_details').passed, false);

  // Gate 5 — window/page/partition/total/roster/route/freshness/location reconciliation.
  const unreconciledInternal = await collectFor({
    responses: evidenceResponses({
      runtimeByWorkflow: { WF1: 'truncated', WF2: 'complete-no-step-rosters' },
    }),
  }).result;
  const unreconciled = await evaluate({
    internalEvidence: unreconciledInternal,
    merge: (await mergeFor({ internalEvidence: unreconciledInternal })).result,
  });
  assert.equal(unreconciled.status, 'complete_partial');
  assert.equal(gateFor(unreconciled, 'reconciliation').passed, false);

  // Gate 6 — snapshot skew within policy after any required refresh.
  const skewed = await evaluate({
    merge: (await mergeFor({
      internalEvidence: healthyInternal,
      publicName: 'skew-above-policy',
      refresh: 'incomplete',
    })).result,
  });
  assert.equal(skewed.status, 'complete_partial');
  assert.equal(gateFor(skewed, 'snapshot_skew').passed, false);

  // Gate 7 — zero write, raw, confirmation, cross-location or unregistered-tool trace.
  // These are integrity failures, so they QUARANTINE rather than degrade to Partial.
  for (const traceName of [
    'write-attempt',
    'raw-attempt',
    'confirmation-attempt',
    'cross-location',
    'unregistered-tool',
  ]) {
    const decision = await evaluate({ trace: MERGE.traces[traceName] });
    assert.equal(decision.status, 'quarantined', traceName);
    assert.equal(gateFor(decision, 'read_only_trace').passed, false, traceName);
    assert.equal(decision.publishesFindings, false, traceName);
    assert.equal(decision.publishesSolutionPacks, false, traceName);
  }

  // Gate 8 — no stale, incomplete, ambiguous or inferred-only claim support.
  for (const supportName of ['inferred-only', 'stale']) {
    const decision = await evaluate({ claimSupport: MERGE.claimSupport[supportName] });
    assert.equal(decision.status, 'complete_partial', supportName);
    assert.equal(gateFor(decision, 'claim_support').passed, false, supportName);
  }

  // Gate 9 — privacy scanning passes. The brief lists privacy in neither the Partial nor the
  // quarantine discriminator, so this asserts only the invariant both readings share: it can
  // never be Full and it can never publish.
  const privacyFailed = await evaluate({ privacyScan: { passed: false, code: 'PUBLICATION_NOT_SANITIZED' } });
  assert.notEqual(privacyFailed.status, 'complete_full');
  assert.equal(privacyFailed.eligible, false);
  assert.equal(gateFor(privacyFailed, 'privacy_scan').passed, false);
  assert.equal(privacyFailed.publishesFindings, false);

  // Gate 10 — the existing independent Task 8 verifier passes inside the trusted atomic gate.
  const verifierFailed = await evaluate({ verification: { passed: false, code: 'AUDIT_VERIFY_FAILED' } });
  assert.equal(verifierFailed.status, 'quarantined');
  assert.equal(gateFor(verifierFailed, 'verifier').passed, false);

  // The remaining quarantine discriminators: location mismatch and manifest/hash mismatch.
  const locationConflicted = await evaluate({
    merge: (await mergeFor({
      internalEvidence: healthyInternal,
      publicEvidence: [publicEnvelope('baseline', { boundLocationId: 'L2' })],
    })).result,
  });
  assert.equal(locationConflicted.status, 'quarantined');

  const hashDrifted = await evaluate({
    internalEvidence: {
      ...structuredClone(healthyInternal),
      capabilityManifestHash: sha256Of('a manifest this run never sealed'),
    },
  });
  assert.equal(hashDrifted.status, 'quarantined');

  const locationDrifted = await evaluate({
    internalEvidence: { ...structuredClone(healthyInternal), boundLocationId: 'L2' },
  });
  assert.equal(locationDrifted.status, 'quarantined');

  // Trustworthy MISSING evidence is Partial, never quarantine. Proven above for gates 1-6 and 8.
  for (const partialDecision of [missingWindow, expired, aiPartial, unreconciled, skewed]) {
    assert.equal(partialDecision.status, 'complete_partial');
    assert.notEqual(partialDecision.status, 'quarantined');
  }

  // ---------------------------------------------------------------------
  // The publication gate honours the decision in both directions.
  // ---------------------------------------------------------------------
  const publishable = {
    coverage: { state: 'complete_full', limitations: [] },
    diff: { state: 'COMPARABLE', transitions: [] },
    findings: [{ id: 'F1', scope: 'account_wide', verdict: 'PASS', impact: 12 }],
    solutionPacks: [{ id: 'SP1', findingId: 'F1' }],
    latestFull: { publicationId: 'full-1' },
  };

  // A validated eligible decision LIFTS the public-only clamp.
  const published = enforcePublicOnlyPublication(publishable, {
    fullEligibility: full,
    expectedRun: RUN,
  });
  assert.equal(published.status, 'complete_full');
  assert.equal(published.findings[0].scope, 'account_wide', 'the clamp was still applied');
  assert.equal(
    (published.coverage.limitations ?? []).includes('INTERNAL_WORKFLOW_DEFINITION_MISSING'),
    false,
  );

  // blocked, failed and quarantined runs publish NO findings and NO solution packs — whether
  // the gate refuses the decision outright or clears the payload.
  const quarantined = await evaluate({ trace: MERGE.traces['write-attempt'] });
  for (const status of ['blocked', 'failed', 'quarantined']) {
    let output = null;
    try {
      output = enforcePublicOnlyPublication(publishable, {
        fullEligibility: { ...structuredClone(quarantined), status },
        expectedRun: RUN,
      });
    } catch (error) {
      assert.match(String(error.code ?? error.message), CODE_PATTERN, status);
      continue;
    }
    assert.notEqual(output.status, 'complete_full', status);
    assert.deepEqual(output.findings, [], status);
    assert.deepEqual(output.solutionPacks, [], status);
  }
});

// ===========================================================================
// 15
// ===========================================================================

// The exact bytes the approved Task 10 `enforcePublicOnlyPublication` produces. Recorded from
// the approved base so a behavioural drift shows up as a byte diff, not a soft assertion.
const TASK10_LEGACY_INPUT = Object.freeze({
  coverage: { state: 'complete_full', limitations: ['PROVIDER_HISTORY_SHORTER_THAN_REQUESTED'] },
  diff: { state: 'IMPROVING', transitions: [{ state: 'REGRESSED' }, { state: 'COMPARABLE' }] },
  findings: [{ id: 'F1', scope: 'account_wide', verdict: 'PASS', impact: 100, totalImpact: 5 }],
  latestFull: { publicationId: 'full-1' },
});
const TASK10_LEGACY_BYTES = '{"coverage":{"limitations":["INTERNAL_WORKFLOW_DEFINITION_MISSING","INTERNAL_WORKFLOW_RUNTIME_MISSING","PROVIDER_HISTORY_SHORTER_THAN_REQUESTED"],"scope":"public_comparable_subset","state":"complete_partial"},"diff":{"state":"IMPROVING","transitions":[{"state":"REGRESSED"},{"state":"COMPARABLE"}]},"findings":[{"id":"F1","impact":null,"scope":"public_comparable_subset","totalImpact":null,"verdict":"UNKNOWN"}],"latestFull":{"publicationId":"full-1"},"status":"complete_partial"}';
const TASK10_LEGACY_FIRST_BASELINE_BYTES = '{"coverage":{"limitations":["INTERNAL_WORKFLOW_DEFINITION_MISSING","INTERNAL_WORKFLOW_RUNTIME_MISSING","PROVIDER_HISTORY_SHORTER_THAN_REQUESTED"],"scope":"public_comparable_subset","state":"complete_partial"},"diff":{"state":"NOT_COMPARABLE","transitions":[{"state":"COMPARABLE"}]},"findings":[{"id":"F1","impact":null,"scope":"public_comparable_subset","totalImpact":null,"verdict":"UNKNOWN"}],"latestFull":{"publicationId":"full-1"},"status":"complete_partial"}';

const TASK10_TRUSTED_INPUT = Object.freeze({
  manifestInput: { schemaVersion: '1.0.0', runId: 'run-bytes', status: 'complete_partial' },
  projections: { memory: [] },
  payloadArtifacts: {
    'coverage.json': {
      state: 'complete_partial',
      limitations: ['INTERNAL_WORKFLOW_DEFINITION_MISSING', 'INTERNAL_WORKFLOW_RUNTIME_MISSING'],
    },
    'metrics-and-findings.json': {
      sealedInputs: { run: { status: 'complete_partial' } },
      findings: [],
    },
    'REPORT.md': '# Scoped public comparable subset\n',
  },
});
const TASK10_TRUSTED_BYTES = '{"manifestInput":{"runId":"run-bytes","schemaVersion":"1.0.0","status":"complete_partial"},"payloadArtifacts":{"REPORT.md":"# Scoped public comparable subset\\n","coverage.json":{"limitations":["INTERNAL_WORKFLOW_DEFINITION_MISSING","INTERNAL_WORKFLOW_RUNTIME_MISSING"],"state":"complete_partial"},"metrics-and-findings.json":{"findings":[],"sealedInputs":{"run":{"status":"complete_partial"}}}},"projections":{"memory":[]},"status":"complete_partial"}';

test('public-only weekly behavior remains byte compatible', async () => {
  const enforcePublicOnlyPublication = requireExport('enforcePublicOnlyPublication');
  const collectInternalEvidencePhase = requireExport('collectInternalEvidencePhase');
  const evaluateFullEligibility = requireExport('evaluateFullEligibility');

  // No internal adapter: the final Task 9 public-only path, byte for byte.
  assert.equal(
    canonicalJson(enforcePublicOnlyPublication(structuredClone(TASK10_LEGACY_INPUT))),
    TASK10_LEGACY_BYTES,
  );
  assert.equal(
    canonicalJson(enforcePublicOnlyPublication(
      structuredClone(TASK10_LEGACY_INPUT),
      { firstBaseline: true },
    )),
    TASK10_LEGACY_FIRST_BASELINE_BYTES,
  );
  assert.equal(
    canonicalJson(enforcePublicOnlyPublication(structuredClone(TASK10_TRUSTED_INPUT))),
    TASK10_TRUSTED_BYTES,
  );

  // Output remains complete_partial and latestFull is never replaced.
  const output = enforcePublicOnlyPublication(structuredClone(TASK10_LEGACY_INPUT));
  assert.equal(output.status, 'complete_partial');
  assert.deepEqual(output.latestFull, TASK10_LEGACY_INPUT.latestFull);

  // Missing workflow evidence cannot be cleared, however healthy the rest of the run looks.
  for (const limitation of ['INTERNAL_WORKFLOW_DEFINITION_MISSING', 'INTERNAL_WORKFLOW_RUNTIME_MISSING']) {
    assert.ok(output.coverage.limitations.includes(limitation), limitation);
  }
  const clearedAttempt = enforcePublicOnlyPublication({
    ...structuredClone(TASK10_LEGACY_INPUT),
    coverage: { state: 'complete_full', limitations: [] },
  });
  for (const limitation of ['INTERNAL_WORKFLOW_DEFINITION_MISSING', 'INTERNAL_WORKFLOW_RUNTIME_MISSING']) {
    assert.ok(clearedAttempt.coverage.limitations.includes(limitation), `cleared ${limitation}`);
  }

  // With no internal adapter the phase machine never enters an internal phase and never calls out.
  const envelopes = [publicEnvelope('baseline')];
  const noAdapter = await collectInternalEvidencePhase({
    adapter: null,
    target: TARGET,
    window: WINDOW,
    applicability: { capabilityIds: APPLICABLE_CAPABILITIES },
    stepRosterRequests: {},
    publicEvidence: structuredClone(envelopes),
    checkpoint: structuredClone(PUBLIC_CHECKPOINT),
  });
  assert.equal(noAdapter.internalEvidence, null);
  assert.notEqual(noAdapter.phase, 'collecting_internal');
  assert.notEqual(noAdapter.phase, 'awaiting_internal_auth');
  assert.deepEqual(noAdapter.publicEvidence, envelopes);
  assert.deepEqual(noAdapter.checkpoint, PUBLIC_CHECKPOINT);
  for (const limitation of ['INTERNAL_WORKFLOW_DEFINITION_MISSING', 'INTERNAL_WORKFLOW_RUNTIME_MISSING']) {
    assert.ok((noAdapter.limitations ?? []).includes(limitation), limitation);
  }

  // And the eligibility decision for a public-only run is complete_partial with the same two
  // limitations, which a healthy-looking merge cannot argue away.
  const publicOnlyMerge = (await mergeFor({ internalEvidence: null })).result;
  const decision = await evaluateFullEligibility({
    internalEvidence: null,
    merge: publicOnlyMerge,
    trace: MERGE.traces.clean,
    claimSupport: MERGE.claimSupport.eligible,
    privacyScan: { passed: true },
    verification: { passed: true },
    requiredWindows: REQUIRED_WINDOWS,
    expected: EXPECTED_IDENTITIES,
  });
  assert.equal(decision.status, 'complete_partial');
  assert.equal(decision.eligible, false);
  for (const gateId of ['live_runtime_receipts', 'workflow_roster_and_coverage', 'ai_discovery_and_details']) {
    assert.equal(gateFor(decision, gateId).passed, false, gateId);
  }
  const codes = limitationCodes(decision);
  for (const limitation of ['INTERNAL_WORKFLOW_DEFINITION_MISSING', 'INTERNAL_WORKFLOW_RUNTIME_MISSING']) {
    assert.ok(codes.includes(limitation), limitation);
  }
});

// ===========================================================================
// 16
// ===========================================================================

test('internal collection is bounded immutable resumable and private safe', async () => {
  // ---- bounded: every boundary RETURNS a stable checkpoint -------------------
  const boundaries = [
    ['abort signal', { request: { signal: AbortSignal.abort() } }],
    ['deadline', { options: { runtime: { now: () => Date.parse(NOW_ISO), deadlineAt: Date.parse(NOW_ISO) } } }],
    ['tool-call budget', { options: { runtime: { now: () => Date.parse(NOW_ISO), budget: { toolCalls: 2 } } } }],
    ['auth boundary', { options: { responses: evidenceResponses({ overrides: { auth_status: failBody('TOKEN_EXPIRED') } }) } }],
  ];
  for (const [label, { options = {}, request = {} }] of boundaries) {
    const first = collectFor(options, request);
    const firstResult = await first.result;
    assert.equal(firstResult.complete, false, label);
    assert.notEqual(firstResult.checkpoint, null, `${label} returned no checkpoint`);
    assert.notEqual(firstResult.checkpoint, undefined, `${label} returned no checkpoint`);
    assert.ok(
      hasCode(firstResult, /INTERNAL_AUDIT_/u),
      `${label} produced no coded reason`,
    );
    // Same input, same checkpoint bytes.
    const second = await collectFor(options, request).result;
    assert.equal(
      canonicalJson(second.checkpoint),
      canonicalJson(firstResult.checkpoint),
      `${label} produced an unstable checkpoint`,
    );
    assertDeeplyFrozen(firstResult, `${label} result`);
  }

  // A budget-bounded run stops issuing calls once the budget is gone.
  const bounded = collectFor({
    runtime: { now: () => Date.parse(NOW_ISO), budget: { toolCalls: 2 } },
  });
  await bounded.result;
  assert.ok(bounded.calls.length <= 3, `budget ignored: ${bounded.calls.length} calls`);

  // ---- immutable: the whole object graph, arrays included -------------------
  const healthy = await collectFor({ responses: evidenceResponses({ ai: 'all-surfaces-complete' }) }).result;
  assert.equal(healthy.complete, true);
  assertDeeplyFrozen(healthy, 'result');
  assert.equal(Object.isFrozen(healthy.workflows), true);
  assert.equal(Object.isFrozen(healthy.sourceRoutes), true);
  assert.equal(Object.isFrozen(healthy.trace), true);
  // JSON-safe: canonicalJson refuses anything it cannot represent.
  assert.equal(typeof canonicalJson(healthy), 'string');

  // ---- private safe: canaries planted on every carrier ----------------------
  const cannaryResponses = evidenceResponses({
    ai: 'all-surfaces-complete',
    rosterOver: {
      workflows: [
        { id: 'WF1', name: CANARIES.pii, status: 'published', version: 4 },
        { id: 'WF2', name: CANARIES.transcript, status: 'published', version: 2 },
      ],
      warnings: [],
    },
    runtimeOver: {
      warnings: [{
        code: 'RUNTIME_NOTE',
        component: 'workflow_execution_logs',
        detail: CANARIES.rawRequest,
        detailSamples: [CANARIES.privatePath],
        occurrences: 1,
      }],
    },
    aiOver: {
      warnings: [{
        code: 'AI_NOTE',
        component: 'conversation_ai',
        detail: CANARIES.keyReference,
        detailSamples: [CANARIES.authorization],
        occurrences: 1,
      }],
    },
    overrides: {
      auth_status: okBody({
        tokenFile: CANARIES.privatePath,
        jwtClaims: { present: true, uid: 'u-1', companyId: COMPANY_ID, exp: 4102444800, secondsRemaining: 3600 },
        tokenIdClaims: { present: true, issuer: 'ghl', role: 'admin', scope: 'read', exp: 4102444800, secondsRemaining: 3600 },
        engine: '0.1.0',
        authorization: CANARIES.authorization,
      }),
    },
  });
  const canaried = await collectFor({ responses: cannaryResponses }).result;
  assertNoCanary(canaried, 'result');
  assertNoCanary(canaried.checkpoint, 'checkpoint');
  assertNoCanary(canaried.trace, 'trace');
  assertNoCanary(canaried.capabilityCoverage, 'capabilityCoverage');
  assertNoWriteOrRawTrace(canaried, 'result');
  assertNoWriteOrRawTrace(canaried.trace, 'trace');

  // The same object, once it is a publication input, still carries nothing private.
  const eligibility = {
    status: 'complete_partial',
    internalEvidence: canaried,
    checkpoint: canaried.checkpoint,
  };
  assertNoCanary(eligibility, 'publication input');

  // ---- private safe: nothing reaches the SQLite fixture ---------------------
  withTempState(({ state, projectRoot }) => {
    const inputs = resumeFrozenInputs();
    state.createRun({ runId: 'run_internal_canary', frozenInputs: inputs, now: inputs.cutoff });
    state.saveCheckpoint({
      runId: 'run_internal_canary',
      phase: 'collecting_internal',
      inputHash: sha256(inputs),
      outputHash: sha256(canaried.checkpoint ?? null),
      payload: JSON.parse(canonicalJson(canaried.checkpoint ?? null)),
    });
    const bytes = Buffer.concat(readAllBytes(projectRoot));
    for (const [name, canary] of Object.entries(CANARIES)) {
      if (name === 'note') continue;
      assert.equal(bytes.includes(canary), false, `${name} canary reached the SQLite fixture`);
    }
  });
});

// ===========================================================================
// 17 — controller decision D1
// ===========================================================================

// The approved Task 10 phase order. `lib/kernel.mjs:151-160` bakes `PHASES.indexOf(phase)` into
// the on-disk checkpoint filename and `:479-490` refuses any other pathname, so these indices
// are an on-disk contract, not an implementation detail.
const APPROVED_TASK10_PHASES = Object.freeze([
  'queued',
  'preflight',
  'collecting_context',
  'collecting_public',
  'normalizing',
  'analyzing',
  'loading_memory',
  'planning_reviews',
  'awaiting_model_review',
  'prioritizing',
  'compiling',
  'verifying',
  'persisting',
  'complete_partial',
]);
const APPROVED_TASK10_CHECKPOINT_FILENAMES = Object.freeze([
  '00-queued.json',
  '01-preflight.json',
  '02-collecting_context.json',
  '03-collecting_public.json',
  '04-normalizing.json',
  '05-analyzing.json',
  '06-loading_memory.json',
  '07-planning_reviews.json',
  '08-awaiting_model_review.json',
  '09-prioritizing.json',
  '10-compiling.json',
  '11-verifying.json',
  '12-persisting.json',
  '13-complete_partial.json',
]);

test('appended internal phases preserve every existing checkpoint path', () => {
  // `PHASES` is module-private; the kernel publishes it as `phases` on the frozen handle.
  const kernel = createAuditKernel({
    clock: () => Date.parse(NOW_ISO),
    idFactory: () => 'run_phase_probe',
    keyResolver: () => ({
      encryptionKey: Buffer.alloc(32, 1),
      pseudonymKey: Buffer.alloc(32, 2),
    }),
    stateStore: { open: openState },
    adapters: {},
    analyzer: {},
    verifier: async () => ({ result: 'pass' }),
    publisher: async () => ({ publicationId: 'pub_phase_probe' }),
  });
  const phases = kernel.phases;
  assert.ok(Array.isArray(phases));
  assert.equal(Object.isFrozen(phases), true);
  assert.equal(new Set(phases).size, phases.length, 'PHASES contains a duplicate');

  // Every pre-existing phase keeps its approved Task 10 index.
  for (const [index, name] of APPROVED_TASK10_PHASES.entries()) {
    assert.equal(phases.indexOf(name), index, `${name} was renumbered`);
  }

  // The two internal phases are APPENDED, never inserted.
  for (const name of ['awaiting_internal_auth', 'collecting_internal']) {
    const index = phases.indexOf(name);
    assert.notEqual(index, -1, `${name} is absent from PHASES (indexOf -1 poisons the filename)`);
    assert.ok(index >= 14, `${name} was inserted at ${index} instead of appended`);
  }

  // The derived checkpoint filename for every pre-existing phase is byte-identical to today's.
  const filenameFor = (phase) => `${String(phases.indexOf(phase)).padStart(2, '0')}-${phase.replaceAll(/[^a-z0-9_-]/gu, '_')}.json`;
  assert.deepEqual(
    APPROVED_TASK10_PHASES.map(filenameFor),
    [...APPROVED_TASK10_CHECKPOINT_FILENAMES],
  );

  // The new phases produce their own, non-colliding, two-digit paths.
  const newFilenames = ['awaiting_internal_auth', 'collecting_internal'].map(filenameFor);
  for (const filename of newFilenames) {
    assert.match(filename, /^\d{2}-[a-z_]+\.json$/u);
    assert.equal(APPROVED_TASK10_CHECKPOINT_FILENAMES.includes(filename), false, filename);
  }
  assert.equal(new Set(newFilenames).size, 2);
});

// ===========================================================================
// 18 — controller decision D2
// ===========================================================================

test('public-only enforcement is byte identical without an eligibility decision', () => {
  const enforcePublicOnlyPublication = requireExport('enforcePublicOnlyPublication');

  // Today's exact argument shapes, with and without `firstBaseline`, on both carriers.
  const byteCases = [
    ['legacy, no options', [structuredClone(TASK10_LEGACY_INPUT)], TASK10_LEGACY_BYTES],
    ['legacy, empty options', [structuredClone(TASK10_LEGACY_INPUT), {}], TASK10_LEGACY_BYTES],
    ['legacy, firstBaseline false', [structuredClone(TASK10_LEGACY_INPUT), { firstBaseline: false }], TASK10_LEGACY_BYTES],
    ['legacy, firstBaseline true', [structuredClone(TASK10_LEGACY_INPUT), { firstBaseline: true }], TASK10_LEGACY_FIRST_BASELINE_BYTES],
    ['trusted, no options', [structuredClone(TASK10_TRUSTED_INPUT)], TASK10_TRUSTED_BYTES],
    ['trusted, empty options', [structuredClone(TASK10_TRUSTED_INPUT), {}], TASK10_TRUSTED_BYTES],
    ['trusted, firstBaseline true', [structuredClone(TASK10_TRUSTED_INPUT), { firstBaseline: true }], TASK10_TRUSTED_BYTES],
  ];
  for (const [label, args, expected] of byteCases) {
    assert.equal(canonicalJson(enforcePublicOnlyPublication(...args)), expected, label);
  }

  // The zero-argument default survives too.
  assert.equal(enforcePublicOnlyPublication().status, 'complete_partial');

  // The Task 10 clamps stay in force with no decision supplied.
  assert.throws(
    () => enforcePublicOnlyPublication({
      ...structuredClone(TASK10_TRUSTED_INPUT),
      manifestInput: { schemaVersion: '1.0.0', runId: 'run-bytes', status: 'complete_full' },
    }),
    /AUDIT_INTEGRITY_FAILURE_PUBLIC_SCOPE/u,
  );
  assert.throws(
    () => enforcePublicOnlyPublication({
      ...structuredClone(TASK10_TRUSTED_INPUT),
      payloadArtifacts: {
        ...structuredClone(TASK10_TRUSTED_INPUT.payloadArtifacts),
        'scope.json': { scope: 'complete_full' },
      },
    }),
    /AUDIT_INTEGRITY_FAILURE_PUBLIC_SCOPE/u,
  );

  // An INVALID or unvalidated eligibility decision can never lift the clamp.
  const passingGates = FULL_ELIGIBILITY_GATES.map((id) => ({ id, passed: true }));
  const invalidDecisions = [
    ['bare status object', { status: 'complete_full' }],
    ['status plus eligible flag only', { status: 'complete_full', eligible: true }],
    ['no gates reported', { status: 'complete_full', eligible: true, gates: [], failedGates: [] }],
    ['status disagrees with eligible', { status: 'complete_full', eligible: false, gates: passingGates, failedGates: [] }],
    ['failedGates disagrees with gates', {
      status: 'complete_full',
      eligible: true,
      gates: passingGates.map((gate, index) => (index === 4 ? { ...gate, passed: false } : gate)),
      failedGates: [],
    }],
    ['gate list truncated', {
      status: 'complete_full',
      eligible: true,
      gates: passingGates.slice(0, 9),
      failedGates: [],
    }],
    ['plain string', 'complete_full'],
    ['boolean true', true],
    ['array', [{ status: 'complete_full' }]],
    ['null prototype object', Object.assign(Object.create(null), { status: 'complete_full', eligible: true, gates: passingGates, failedGates: [] })],
  ];
  for (const [label, fullEligibility] of invalidDecisions) {
    let status = null;
    try {
      status = enforcePublicOnlyPublication(
        structuredClone(TASK10_LEGACY_INPUT),
        { fullEligibility },
      ).status;
    } catch (error) {
      assert.match(String(error.code ?? error.message), /AUDIT_INTEGRITY_FAILURE|INTERNAL_AUDIT_/u, label);
      continue;
    }
    assert.notEqual(status, 'complete_full', `${label} lifted the clamp`);
    assert.equal(status, 'complete_partial', label);
  }

  // An explicitly absent decision is exactly the no-decision case, byte for byte.
  for (const absent of [undefined, null]) {
    assert.equal(
      canonicalJson(enforcePublicOnlyPublication(
        structuredClone(TASK10_LEGACY_INPUT),
        { firstBaseline: false, fullEligibility: absent },
      )),
      TASK10_LEGACY_BYTES,
      String(absent),
    );
  }
});

// ===========================================================================
// 19 — controller decision D3
// ===========================================================================

test('changing only the bundle hash invalidates the frozen proof chain', () => {
  const attestation = makeAttestation();
  const changed = makeAttestation({ bundleHash: sha256Of('a rebuilt audit bundle') });

  // ONLY bundleHash differs; every other bound field is byte-identical.
  const withoutBundle = (value) => {
    const { attestationHash: _hash, bundleHash: _bundle, ...rest } = value;
    return canonicalJson(rest);
  };
  assert.equal(withoutBundle(changed), withoutBundle(attestation));
  assert.notEqual(changed.bundleHash, attestation.bundleHash);

  // The recomputed attestation hash therefore differs. The bundle hash is frozen TRANSITIVELY:
  // the immutable attestation binds it, so no separate FROZEN_INPUT_FIELDS slot is needed.
  assert.notEqual(changed.attestationHash, attestation.attestationHash);
  assert.equal(attestationHashOf(changed), changed.attestationHash);
  assert.equal(attestationHashOf(attestation), attestation.attestationHash);

  withTempState(({ state }) => {
    const hashes = Object.freeze([attestation.attestationHash]);
    assert.equal(Object.isFrozen(hashes), true);
    const inputs = resumeFrozenInputs({ capabilityAttestationHashes: hashes });
    state.createRun({ runId: 'run_bundle_freeze', frozenInputs: inputs, now: inputs.cutoff });

    // The same inputs resume the same logical run.
    assert.equal(state.assertResumeInputs('run_bundle_freeze', inputs).runId, 'run_bundle_freeze');

    // Changing only the bundle hash changes the attestation hash, so the frozen inputs differ,
    // so sha256(frozenInputs) differs, so the resume is a DISTINCT logical run.
    const drifted = resumeFrozenInputs({
      capabilityAttestationHashes: Object.freeze([changed.attestationHash]),
    });
    assert.notEqual(canonicalJson(drifted), canonicalJson(inputs));
    assert.notEqual(sha256(drifted), sha256(inputs));
    assert.throws(
      () => state.assertResumeInputs('run_bundle_freeze', drifted),
      /RESUME_INPUT_MISMATCH/u,
    );

    // D3: FROZEN_INPUT_FIELDS stays a CLOSED exact-match list. Adding a bundle-hash slot is
    // rejected outright, which is why the transitive freeze is the only available guarantee.
    assert.throws(
      () => state.assertResumeInputs('run_bundle_freeze', { ...inputs, bundleHash: BUNDLE_HASH }),
      /INVALID_FROZEN_INPUTS/u,
    );
    assert.throws(
      () => state.assertResumeInputs('run_bundle_freeze', { ...inputs, capabilityBundleHashes: [BUNDLE_HASH] }),
      /INVALID_FROZEN_INPUTS/u,
    );

    // The proof-chain fields the brief names are all already present and all already frozen.
    for (const field of [
      'providerToolProfileHash',
      'capabilityManifestHashes',
      'capabilityProofIndexHash',
      'capabilityReceiptHashes',
      'capabilityAttestationHashes',
      'capabilityProofExpiries',
    ]) {
      // Drift each field in its own declared type so the failure is RESUME_INPUT_MISMATCH
      // (the hash moved) and never INVALID_FROZEN_INPUTS (the shape broke).
      const driftValue = () => {
        if (field === 'capabilityProofExpiries') return [...inputs[field], inputs[field][0] + 1];
        if (Array.isArray(inputs[field])) return [...inputs[field], 'drift'];
        return `${inputs[field]}-drift`;
      };
      const mutated = resumeFrozenInputs({
        capabilityAttestationHashes: hashes,
        [field]: driftValue(),
      });
      assert.throws(
        () => state.assertResumeInputs('run_bundle_freeze', mutated),
        /RESUME_INPUT_MISMATCH/u,
        field,
      );
    }
  });
});

// ===========================================================================
// 20-26 — adversarial review round 1, adapter findings C3 C4 I2 I5 I6 M4 M5
// ===========================================================================
//
// Everything below is APPENDED. No test, assertion or fixture above was weakened, deleted or
// altered. The harness above is reused verbatim; only the constructor pins of finding C4 need
// a local builder, because `makeAdapter` destructures a closed option list that predates them.

const AI_ONLY_CAPABILITIES = Object.freeze([
  'conversation_ai_agent_discovery',
  'conversation_ai_agent_detail',
  'voice_ai_agent_discovery',
  'voice_ai_agent_detail',
  'agent_studio_agent_discovery',
  'agent_studio_agent_detail',
]);

/** Constructs the adapter directly so options outside `makeAdapter`'s list can be passed. */
function adapterWith(extra = {}, { responses = evidenceResponses(), calls = [] } = {}) {
  return createInternalGhlAdapter({
    client: fakeAuditMcpClient({ responses, calls }),
    expectedContractVersion: '1.0.0',
    expectedLocationId: LOCATION_ID,
    expectedToolProfileHash: TOOL_PROFILE_HASH,
    capabilityProofIndex: makeProofIndex(),
    runtime: { now: () => Date.parse(NOW_ISO) },
    ...extra,
  });
}

function collectWith(extra = {}, options = {}, request = {}) {
  return adapterWith(extra, options).collectAuditEvidence({
    target: TARGET,
    window: WINDOW,
    applicability: { capabilityIds: APPLICABLE_CAPABILITIES },
    stepRosterRequests: {},
    ...request,
  });
}

/** Re-self-hashes a mutated manifest so it is INTERNALLY consistent — the C4 attack shape. */
function reselfHashed(manifest) {
  const { manifestHash: _dropped, ...withoutSelfHash } = manifest;
  return { ...withoutSelfHash, manifestHash: sha256Of(withoutSelfHash) };
}

// ===========================================================================
// 20 — C3
// ===========================================================================

test('exercised capabilities without a receipt cannot be complete', async () => {
  // The caller declares only the six AI capabilities and holds receipts only for those. The run
  // still exercises the roster, definition and execution-log routes, which have NO receipt.
  const declared = [...AI_ONLY_CAPABILITIES];
  const understated = await collectFor({
    capabilityProofIndex: makeProofIndex({ capabilityIds: declared }),
  }, { applicability: { capabilityIds: declared } }).result;

  assert.equal(
    understated.complete,
    false,
    'a declared set that omitted an exercised capability licensed a complete result',
  );
  for (const capabilityId of ['workflow_roster_list', 'workflow_detail', 'workflow_execution_logs']) {
    const entry = coverageFor(understated, capabilityId);
    assert.equal(entry.exercised, true, `${capabilityId} was exercised but not named as such`);
    assert.equal(entry.proven, false, `${capabilityId} was exercised with no live receipt`);
  }
  assert.ok(
    hasCode(understated, /INTERNAL_AUDIT_CAPABILITY_UNPROVEN/u),
    'no capability-unproven code was raised for the exercised routes',
  );
  // The reconciliation ADDS the exercised set; it never erases an honest declared receipt.
  assert.equal(coverageFor(understated, 'conversation_ai_agent_discovery').proven, true);

  // The exercised ledger is the response's own source routes, so an undeclared capability that
  // DOES hold a receipt is proven rather than assumed guilty.
  const receiptedButUndeclared = await collectFor({
    capabilityProofIndex: makeProofIndex(),
  }, { applicability: { capabilityIds: declared } }).result;
  assert.equal(coverageFor(receiptedButUndeclared, 'workflow_roster_list').proven, true);
  assert.equal(coverageFor(receiptedButUndeclared, 'workflow_roster_list').exercised, true);
  assert.equal(receiptedButUndeclared.complete, true);

  // Control: declaring and receipting everything is still complete, and the exercised routes
  // are marked as exercised.
  const healthy = await collectFor().result;
  assert.equal(healthy.complete, true);
  assert.equal(coverageFor(healthy, 'workflow_execution_logs').exercised, true);
  // A capability that is applicable and receipted but was never exercised is not a failure.
  assert.equal(coverageFor(healthy, 'workflow_enroll_stats').exercised, false);
});

// ===========================================================================
// 21 — C4
// ===========================================================================

test('pinned manifest and bundle hashes are rejected before evidence collection', async () => {
  // Pinned and correct: the run proceeds and records that both identities were anchored
  // OUTSIDE the untrusted proof index.
  const pinned = await collectWith({
    expectedCapabilityManifestHash: MANIFEST_HASH,
    expectedBundleHash: BUNDLE_HASH,
  });
  assert.equal(pinned.complete, true);
  assert.equal(pinned.capabilityProofAnchor.manifestPinned, true);
  assert.equal(pinned.capabilityProofAnchor.bundlePinned, true);

  const unpinned = await collectWith();
  assert.equal(unpinned.capabilityProofAnchor.manifestPinned, false);
  assert.equal(unpinned.capabilityProofAnchor.bundlePinned, false);

  // The review's attack: a locally rebuilt manifest, a bundle hash for a bundle that never
  // existed, and a self-minted attestation approved by "nobody". It is internally consistent,
  // so only an EXTERNAL pin can refuse it.
  const forgedManifest = reselfHashed({
    ...MANIFEST,
    capabilities: [...MANIFEST.capabilities, {
      tool: 'get_workflow',
      capabilityId: 'workflow_time_travel',
      host: 'backend',
      authRail: 'backend',
      method: 'GET',
      normalizedPath: '/workflow/{locationId}/{workflowId}/history',
      pathBindings: { locationId: 'locationId', workflowId: 'workflowId' },
      queryBindings: {},
      requiredQueryKeys: [],
      optionalQueryKeys: [],
      repeatableQueryKeys: [],
      fixedQueryValues: {},
      allowedQueryValues: {},
      numericQueryBounds: {},
      locationBinding: 'path',
      sealedBy: null,
    }],
  });
  const forgedBundleHash = sha256Of('a bundle that never existed');
  const forgedIndex = makeProofIndex({
    manifest: forgedManifest,
    bundleHash: forgedBundleHash,
    attestation: makeAttestation({
      capabilityManifestHash: sha256Of(forgedManifest),
      bundleHash: forgedBundleHash,
      approver: 'nobody',
    }),
  });

  const rejected = [
    ['self-certifying rebuilt manifest and invented bundle', {
      capabilityProofIndex: forgedIndex,
      expectedCapabilityManifestHash: MANIFEST_HASH,
      expectedBundleHash: BUNDLE_HASH,
    }],
    ['manifest pin points at another manifest', {
      expectedCapabilityManifestHash: sha256Of('a locally rebuilt manifest'),
    }],
    ['manifest pin malformed', { expectedCapabilityManifestHash: 'sha256:zzzz' }],
    ['manifest pin null', { expectedCapabilityManifestHash: null }],
    ['manifest pin is bare hex', {
      expectedCapabilityManifestHash: MANIFEST_HASH.replace('sha256:', ''),
    }],
    ['bundle pin points at a bundle that never existed', {
      expectedBundleHash: sha256Of('a bundle that never existed'),
    }],
    ['bundle pin malformed', { expectedBundleHash: 'not-a-digest' }],
    ['bundle pin null', { expectedBundleHash: null }],
    ['pins with no proof index at all', {
      capabilityProofIndex: null,
      expectedCapabilityManifestHash: MANIFEST_HASH,
      expectedBundleHash: BUNDLE_HASH,
    }],
    ['proof index carries an unknown top-level key', {
      capabilityProofIndex: { ...makeProofIndex(), trustMe: true },
    }],
  ];
  for (const [label, extra] of rejected) {
    const calls = [];
    await assert.rejects(
      () => collectWith(extra, { calls }),
      /INTERNAL_AUDIT_MANIFEST_INVALID/u,
      label,
    );
    assert.equal(evidenceCalls(calls).length, 0, `${label} reached an evidence call`);
    assert.equal(calls.length, 0, `${label} dispatched before the pins were checked`);
  }

  // The same pins guard the bounded entry point.
  await assert.rejects(
    () => adapterWith({ expectedBundleHash: sha256Of('another bundle') })
      .collect({ capability: { capabilityId: 'workflow_roster_list' }, window: WINDOW }),
    /INTERNAL_AUDIT_MANIFEST_INVALID/u,
  );
});

// ===========================================================================
// 22 — I2
// ===========================================================================

const HISTORY_EVENTS = Object.freeze([Object.freeze({
  id: 'E_LATE',
  timestamp: 1784365200000,
  timestampField: 'startedExecutionAt',
  unreadableTimestampFields: [],
  event: { _id: 'E_LATE' },
})]);

function historyRun(validity, options = {}) {
  return collectFor({
    responses: evidenceResponses({
      runtimeOptions: {
        WF1: { definitionRef: 'WF1_V5', validity, events: [...HISTORY_EVENTS] },
      },
      exportByWorkflow: { WF1: okBody(exportBody('WF1_V5')) },
    }),
    ...options,
  }).result;
}

test('historical binding cannot be enabled by a wire declared flag', async () => {
  const currentHash = DEFINITIONS.WF1_V5.canonicalHash;
  assert.equal(currentHash, HISTORY.hashes.v5, 'fixture drift: WF1_V5 is not the v5 definition');
  const provenLooking = HISTORY['change-inside-window'].validity;

  // 1. `canonicalHash` is a DIGEST, not whatever string the wire sent.
  const notAHash = await historyRun({
    ...provenLooking,
    versionHistory: [{
      version: 5,
      canonicalHash: 'I AM NOT A HASH',
      effectiveFrom: '2026-07-01T00:00:00.000Z',
      effectiveTo: null,
    }],
  });
  let record = workflowRecord(notAHash, 'WF1');
  assert.equal(eventRecord(record, 'E_LATE').workflowDefinitionHash, null);
  assert.equal(eventRecord(record, 'E_LATE').supportsDirectMechanismProof, false);
  assert.equal(record.configurationBinding.publishableAsGoverning, false);
  assert.equal(JSON.stringify(notAHash).includes('I AM NOT A HASH'), false);
  // The limitation and the current-definition hash are preserved separately, as always.
  assert.equal(record.configurationBinding.currentDefinitionHash, currentHash);
  assert.equal(record.definition.definitionHash, currentHash);
  assert.ok(record.configurationBinding.limitation.length > 0);

  // 2. A well-formed history that never mentions the definition this adapter independently
  //    verified is evidence about some other workflow.
  const foreign = await historyRun({
    ...provenLooking,
    versionHistory: [{
      version: 9,
      canonicalHash: sha256({ some: 'other workflow entirely' }),
      effectiveFrom: '2026-07-01T00:00:00.000Z',
      effectiveTo: null,
    }],
  });
  record = workflowRecord(foreign, 'WF1');
  assert.equal(eventRecord(record, 'E_LATE').workflowDefinitionHash, null);
  assert.equal(eventRecord(record, 'E_LATE').supportsDirectMechanismProof, false);
  assert.equal(record.configurationBinding.publishableAsGoverning, false);

  // 3. One malformed interval invalidates the WHOLE history rather than narrowing it.
  const partlyMalformed = await historyRun({
    ...provenLooking,
    versionHistory: [
      ...provenLooking.versionHistory,
      { version: 6, canonicalHash: HISTORY.hashes.v4, effectiveFrom: 'not a date', effectiveTo: null },
    ],
  });
  assert.equal(
    eventRecord(workflowRecord(partlyMalformed, 'WF1'), 'E_LATE').workflowDefinitionHash,
    null,
  );

  // 4. The governing capability must hold a valid live receipt. `validity.versionHistory` rides
  //    on the definition rail, so an unreceipted definition capability proves nothing.
  const unreceipted = await historyRun(provenLooking, {
    capabilityProofIndex: makeProofIndex({
      capabilityIds: APPLICABLE_CAPABILITIES.filter((id) => id !== 'workflow_detail'),
    }),
  });
  record = workflowRecord(unreceipted, 'WF1');
  assert.equal(eventRecord(record, 'E_LATE').workflowDefinitionHash, null);
  assert.equal(record.configurationBinding.publishableAsGoverning, false);

  // 5. THE CEILING. Even when every interval check passes, the composite's own
  //    `configurationBinding` is authoritative and is never overridden upward. Today the server
  //    hard-codes it to `unproven` because no version-history capability exists.
  const ceiling = await historyRun(provenLooking);
  record = workflowRecord(ceiling, 'WF1');
  assert.equal(record.configurationBinding.definitionGovernedRuntimeEvents, 'unproven');
  assert.equal(record.configurationBinding.publishableAsGoverning, false);
  assert.equal(record.configurationBinding.provenBy, null);
  assert.ok(
    typeof record.configurationBinding.limitation === 'string'
      && record.configurationBinding.limitation.length > 0,
    'the limitation was dropped while the composite still said unproven',
  );
  // The typed interval evidence itself is retained — the ceiling caps the CONCLUSION.
  assert.equal(eventRecord(record, 'E_LATE').workflowDefinitionHash, HISTORY.hashes.v5);
});

// ===========================================================================
// 23 — I5
// ===========================================================================

test('definition evidence requires positive location binding', async () => {
  // A foreign location tagged in a shape the old deep scan walked straight past.
  for (const [label, tagged] of [
    ['bare string location', { ...exportBody('WF1'), location: 'L2' }],
    ['subaccount alias', { ...exportBody('WF1'), subaccountId: 'L2' }],
    ['ghl location alias', { ...exportBody('WF1'), ghlLocation: 'L2' }],
  ]) {
    await assert.rejects(
      () => collectFor({
        responses: evidenceResponses({ exportByWorkflow: { WF1: okBody(tagged) } }),
      }).result,
      /INTERNAL_AUDIT_LOCATION_MISMATCH/u,
      label,
    );
  }

  // With no sealed manifest there is no descriptor to bind the definition route against, and
  // an unbindable route is UNKNOWN — never assent.
  const unsealed = await collectFor({ capabilityProofIndex: null }).result;
  let record = workflowRecord(unsealed, 'WF1');
  assert.equal(record.complete, false, 'definition evidence was accepted with no sealed binding');
  assert.equal(record.definition, null);
  assert.ok(hasCode(unsealed, /INTERNAL_AUDIT_WORKFLOW_INCOMPLETE/u));

  // A sealed manifest whose primary definition descriptor declares no location binding is the
  // same silence, and is refused the same way.
  const unboundManifest = reselfHashed({
    ...MANIFEST,
    capabilities: MANIFEST.capabilities.map((row) => (
      row.capabilityId === 'workflow_detail' ? { ...row, locationBinding: null } : row
    )),
  });
  const unbound = await collectFor({
    capabilityProofIndex: makeProofIndex({ manifest: unboundManifest }),
  }).result;
  record = workflowRecord(unbound, 'WF1');
  assert.equal(record.complete, false, 'an unbound definition descriptor still read as assent');
  assert.equal(record.definition, null);

  // Control: the sealed gate binds, and the healthy run is unaffected.
  const healthy = await collectFor().result;
  assert.equal(workflowRecord(healthy, 'WF1').complete, true);
  assert.equal(healthy.complete, true);
});

// ===========================================================================
// 24 — I6 (privacy)
// ===========================================================================

// Canaries planted in EXACTLY the wire sub-objects the review proved were copied verbatim.
const PROJECTION_CANARIES = Object.freeze({
  bearerToken: 'CANARY-BEARER-eyJhbGciOiJIUzI1NiJ9.PROJECTION.LEAK',
  credentialPath: '/Users/canary/.grom-factory-projection.json',
  tokenId: 'CANARY-TOKEN-ID-77',
  appliedPath: '/CANARY/applied/path?token=CANARY-QUERY-STRING',
  enrollmentName: 'Canary Projection Patient',
  eventContactEmail: 'canary.projection@example.com',
  eventMessageBody: 'CANARY MESSAGE BODY: the patient said she would call back on Tuesday',
  stepContactEmail: 'canary.step-roster@example.com',
  perStepContactEmail: 'canary.per-step@example.com',
  filterNote: 'CANARY FILTER NOTE',
});

function canariedRoute(capabilityId) {
  return {
    ...route(capabilityId, PROJECTION_CANARIES.appliedPath, {
      appliedQuery: { tokenId: PROJECTION_CANARIES.tokenId },
    }),
    bearerToken: PROJECTION_CANARIES.bearerToken,
    credentialPath: PROJECTION_CANARIES.credentialPath,
  };
}

test('wire sub objects are projected not copied', async () => {
  const scenario = RUNTIME.complete;
  const canariedRuntime = {
    filters: {
      contactId: null,
      eventTypes: [],
      stepIds: ['S1'],
      rawRequest: PROJECTION_CANARIES.filterNote,
    },
    enrollments: {
      ...scenario.enrollments,
      rows: scenario.enrollments.rows.map((row) => ({
        ...row,
        name: PROJECTION_CANARIES.enrollmentName,
      })),
    },
    enrollmentTotals: {
      ...scenario.enrollmentTotals,
      credentialPath: PROJECTION_CANARIES.credentialPath,
    },
    perStepCounts: scenario.perStepCounts.map((entry) => ({
      ...entry,
      contactEmail: PROJECTION_CANARIES.perStepContactEmail,
    })),
    stepRosters: scenario.stepRosters.map((roster) => ({
      ...roster,
      contacts: roster.contacts.map((contact) => ({
        ...contact,
        email: PROJECTION_CANARIES.stepContactEmail,
      })),
    })),
    runtimeEvents: scenario.runtimeEvents.map((event) => ({
      ...event,
      event: {
        ...event.event,
        contactEmail: PROJECTION_CANARIES.eventContactEmail,
        messageBody: PROJECTION_CANARIES.eventMessageBody,
      },
    })),
    sourceRoutes: [canariedRoute('workflow_detail'), canariedRoute('workflow_execution_logs')],
  };

  const { result, calls } = collectFor({
    responses: evidenceResponses({
      ai: 'all-surfaces-complete',
      rosterOver: { sourceRoutes: [canariedRoute('workflow_roster_list')] },
      runtimeByWorkflow: { WF1: 'complete', WF2: 'complete-no-step-rosters' },
      runtimeOptions: { WF1: { over: canariedRuntime } },
    }),
  }, { stepRosterRequests: { WF1: ['S1'] } });
  const resolved = await result;

  // The whole point of this finding: the leak happened on the HEALTHY path, so the result must
  // stay complete while carrying none of the canaries.
  assert.equal(resolved.complete, true, 'the canaried run stopped being healthy');
  for (const [name, canary] of Object.entries(PROJECTION_CANARIES)) {
    assert.equal(
      JSON.stringify(resolved).includes(canary),
      false,
      `${name} escaped a healthy complete result`,
    );
    assert.equal(
      JSON.stringify(resolved.checkpoint).includes(canary),
      false,
      `${name} escaped into the checkpoint`,
    );
    assert.equal(
      JSON.stringify(resolved.trace).includes(canary),
      false,
      `${name} escaped into the trace`,
    );
  }
  // Nothing private travelled outbound either.
  assert.equal(JSON.stringify(calls).includes(PROJECTION_CANARIES.tokenId), false);

  // The evidence the audit actually needs still survives the projection.
  const runtime = workflowRecord(resolved, 'WF1').runtime;
  assert.deepEqual(runtime.perStepCounts, scenario.perStepCounts);
  // Controller decision D10 (round-3 finding R3-1): `stepRosters[].contacts[].id` is a contact
  // identifier and is now pseudonymised rather than echoed, so a byte-for-byte comparison against
  // the raw fixture is no longer the right assertion. Compare every other roster field exactly,
  // then assert the contact ids are pseudonyms of the right shape and cardinality. This is
  // STRICTLY STRONGER than the original: it still pins the whole roster ledger, and additionally
  // proves the raw contact id never survives.
  assert.deepEqual(
    runtime.stepRosters.map(({ contacts, ...rest }) => rest),
    scenario.stepRosters.map(({ contacts, ...rest }) => rest),
  );
  for (const [rosterIndex, roster] of runtime.stepRosters.entries()) {
    const fixtureContacts = scenario.stepRosters[rosterIndex].contacts;
    assert.equal(roster.contacts.length, fixtureContacts.length);
    for (const [contactIndex, contact] of roster.contacts.entries()) {
      assert.deepEqual(Object.keys(contact), ['id']);
      assert.match(contact.id, /^psn_[a-f0-9]{32}$/u);
      assert.notEqual(contact.id, fixtureContacts[contactIndex].id);
    }
  }
  assert.deepEqual(runtime.enrollmentTotals, scenario.enrollmentTotals);
  assert.equal(runtime.enrollments.rows.length, scenario.enrollments.rows.length);
  assert.equal(runtime.events.length, scenario.runtimeEvents.length);
  assert.equal(runtime.events[0].event.stepId, scenario.runtimeEvents[0].event.stepId);
  assert.ok(runtime.sourceRoutes.length > 0);
  for (const sourceRoute of [...runtime.sourceRoutes, ...resolved.sourceRoutes]) {
    assert.equal(Object.hasOwn(sourceRoute, 'appliedQuery'), false);
    assert.equal(Object.hasOwn(sourceRoute, 'bearerToken'), false);
    assert.equal(Object.hasOwn(sourceRoute, 'credentialPath'), false);
    // The retained path is the SEALED manifest constant, not the wire string.
    assert.equal(
      sourceRoute.appliedPath,
      DESCRIPTORS_BY_ID.get(sourceRoute.capabilityId).normalizedPath,
    );
  }
});

// ===========================================================================
// 25 — M4
// ===========================================================================

test('bounded collect evaluates capability proofs', async () => {
  const request = { capability: { capabilityId: 'workflow_roster_list' }, window: WINDOW };

  const proven = await makeAdapter().collect(request);
  assert.equal(proven.page.complete, true);
  assert.equal(Object.hasOwn(proven, 'incompleteReason'), false);

  const unproven = [
    ['no proof index at all', null],
    ['missing receipt', makeProofIndex({
      capabilityIds: APPLICABLE_CAPABILITIES.filter((id) => id !== 'workflow_roster_list'),
    })],
    ['offline contract proof class', makeProofIndex({
      receiptOverrides: { workflow_roster_list: { proofClass: 'offline_contract' } },
    })],
    ['fixture-only proof class', makeProofIndex({
      receiptOverrides: { workflow_roster_list: { proofClass: 'fixture_only' } },
    })],
    ['expired receipt', makeProofIndex({
      attestation: makeAttestation({
        provenAt: '2026-06-20T00:00:00.000Z',
        expiresAt: '2026-07-19T00:00:00.000Z',
      }),
    })],
    ['wrong bundle hash', makeProofIndex({
      attestation: makeAttestation({ bundleHash: sha256Of('another bundle') }),
    })],
  ];
  for (const [label, capabilityProofIndex] of unproven) {
    const calls = [];
    const result = await makeAdapter({ capabilityProofIndex, calls }).collect(request);
    assert.equal(result.page.complete, false, label);
    assert.equal(result.page.truncated, true, label);
    assert.ok(
      /^INTERNAL_AUDIT_(PROOF_INVALID|PROOF_EXPIRED|CAPABILITY_UNPROVEN)$/u.test(
        result.incompleteReason,
      ),
      `${label} produced no proof-family reason: ${result.incompleteReason}`,
    );
    // The proof state is applied BEFORE the evidence call, exactly as in the composite.
    assert.equal(evidenceCalls(calls).length, 0, `${label} collected evidence anyway`);
  }
});

// ===========================================================================
// 26 — M5
// ===========================================================================

test('version history source and hashes are validated not echoed', async () => {
  const provenLooking = HISTORY['change-inside-window'].validity;
  const sourceCanary = 'CANARY SOURCE </script> vault://grom/audit/LEAK';

  const echoed = await historyRun({ ...provenLooking, source: sourceCanary });
  let record = workflowRecord(echoed, 'WF1');
  assert.equal(
    JSON.stringify(echoed).includes('CANARY SOURCE'),
    false,
    'an unvalidated wire source string was echoed into the result',
  );
  assert.equal(record.configurationBinding.provenBy, null);
  // An unvalidated source proves no interval either.
  assert.equal(eventRecord(record, 'E_LATE').workflowDefinitionHash, null);

  for (const [label, source] of [
    ['numeric source', 42],
    ['empty source', ''],
    ['spaced source', 'workflow version history'],
    ['uppercase source', 'WORKFLOW_VERSION_HISTORY'],
    ['overlong source', `w${'o'.repeat(80)}`],
  ]) {
    const result = await historyRun({ ...provenLooking, source });
    record = workflowRecord(result, 'WF1');
    assert.equal(record.configurationBinding.provenBy, null, label);
    assert.equal(eventRecord(record, 'E_LATE').workflowDefinitionHash, null, label);
  }

  for (const [label, canonicalHash] of [
    ['prefixed digest', `sha256:${HISTORY.hashes.v5}`],
    ['uppercase digest', HISTORY.hashes.v5.toUpperCase()],
    ['short digest', HISTORY.hashes.v5.slice(0, 32)],
    ['numeric digest', 5],
  ]) {
    const result = await historyRun({
      ...provenLooking,
      versionHistory: [{
        version: 5,
        canonicalHash,
        effectiveFrom: '2026-07-01T00:00:00.000Z',
        effectiveTo: null,
      }],
    });
    assert.equal(
      eventRecord(workflowRecord(result, 'WF1'), 'E_LATE').workflowDefinitionHash,
      null,
      label,
    );
  }
});

// ===========================================================================
// Round-1 adversarial-review fixes. Tests 20-32, one per finding.
//
// Every test below was verified RED by surgically reverting exactly one fix in
// `lib/modes/weekly.mjs` / `lib/kernel.mjs`, running only that test with
// `--test-name-pattern`, observing a failure, and restoring the fix.
// ===========================================================================

// ---------------------------------------------------------------------------
// Shared kernel harness for the checkpoint-identity and integration tests.
// ---------------------------------------------------------------------------

const KERNEL_CUTOFF = Date.parse(NOW_ISO);

function kernelFrozenInputs(overrides = {}) {
  return resumeFrozenInputs({ cutoff: KERNEL_CUTOFF, ...overrides });
}

async function withProjectRoot(callback) {
  const projectRoot = mkdtempSync(join(tmpdir(), 'ghl-internal-kernel-'));
  try {
    return await callback(projectRoot);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
}

function makeKernel({
  runId = 'run_wired',
  adapters = {},
  analyzer = {},
  verifier = async () => ({ result: 'pass' }),
  publisher = async () => ({ publicationId: 'pub_wired' }),
  faultInjector,
} = {}) {
  return createAuditKernel({
    clock: () => KERNEL_CUTOFF,
    idFactory: () => runId,
    keyResolver: () => ({
      encryptionKey: Buffer.alloc(32, 1),
      pseudonymKey: Buffer.alloc(32, 2),
    }),
    stateStore: { open: openState },
    adapters: {
      collectContext: async () => ({ context: 'safe' }),
      collectPublic: async () => ({ events: [] }),
      ...adapters,
    },
    analyzer: {
      freezeInputs: () => kernelFrozenInputs(),
      normalize: async () => ({ graph: 'safe' }),
      discover: async () => ({ findings: [] }),
      falsify: async () => ({ packets: [] }),
      loadMemory: async () => ({ events: [] }),
      compile: async () => ({ status: 'complete_partial', findings: [] }),
      ...analyzer,
    },
    verifier,
    publisher,
    faultInjector,
  });
}

const startArgs = (projectRoot, providerConfig = {}) => ({
  mode: 'weekly',
  target: kernelFrozenInputs().target,
  projectRoot,
  cutoff: KERNEL_CUTOFF,
  providerId: 'provider',
  profile: 'client',
  providerConfig,
  vaultKeyReference: 'opaque-ref',
});

// ===========================================================================
// 20 — finding C1
// ===========================================================================

test('full eligibility refuses absent incomplete or malformed public evidence', async () => {
  const evaluateFullEligibility = requireExport('evaluateFullEligibility');
  const healthyInternal = await collectFor({
    responses: evidenceResponses({ ai: 'all-surfaces-complete' }),
  }).result;
  assert.equal(healthyInternal.complete, true);

  const baseInputs = {
    internalEvidence: healthyInternal,
    trace: MERGE.traces.clean,
    claimSupport: MERGE.claimSupport.eligible,
    privacyScan: { passed: true },
    verification: { passed: true },
    requiredWindows: REQUIRED_WINDOWS,
    expected: EXPECTED_IDENTITIES,
    // Decision D11: only the run's SEALED frozen inputs anchor an identity.
    frozenInputs: r3FrozenInputs(),
    // Finding R7-C1: and only a host-authenticated anchor block anchors at all.
    frozenInputProvenance: anchorProvenanceFor(r3FrozenInputs()),
  };

  // Control: with a COMPLETE public rail every gate is satisfiable.
  const healthy = await evaluateFullEligibility({
    ...baseInputs,
    merge: (await mergeFor({ internalEvidence: healthyInternal })).result,
  });
  assert.equal(healthy.status, 'complete_full');

  // 1. ABSENT public evidence. The internal rail is untouched and perfect.
  const absent = (await mergeFor({ internalEvidence: healthyInternal, publicEvidence: [] })).result;
  assert.notEqual(absent.status, 'COMPLETE');
  const absentDecision = await evaluateFullEligibility({ ...baseInputs, merge: absent });
  assert.notEqual(absentDecision.status, 'complete_full', 'zero public evidence published Full');
  assert.equal(absentDecision.status, 'complete_partial');
  assert.equal(gateFor(absentDecision, 'capability_coverage').passed, false);
  assert.equal(gateFor(absentDecision, 'reconciliation').passed, false);

  // 2. MALFORMED public evidence (no page, no items).
  const malformed = (await mergeFor({
    internalEvidence: healthyInternal,
    publicEvidence: [{ source: 'public_ghl', boundLocationId: LOCATION_ID, capturedAt: NOW_ISO }],
  })).result;
  assert.ok(limitationCodes(malformed).includes('PUBLIC_EVIDENCE_MALFORMED'));
  const malformedDecision = await evaluateFullEligibility({ ...baseInputs, merge: malformed });
  assert.notEqual(malformedDecision.status, 'complete_full', 'malformed public evidence published Full');
  assert.equal(gateFor(malformedDecision, 'reconciliation').passed, false);

  // 3. INCOMPLETE public evidence (a truncated page that still claims a healthy count).
  const truncated = publicEnvelope('baseline');
  truncated.page.complete = false;
  truncated.page.truncated = true;
  const incomplete = (await mergeFor({
    internalEvidence: healthyInternal,
    publicEvidence: [truncated],
  })).result;
  assert.ok(limitationCodes(incomplete).includes('PUBLIC_EVIDENCE_INCOMPLETE'));
  const incompleteDecision = await evaluateFullEligibility({ ...baseInputs, merge: incomplete });
  assert.notEqual(incompleteDecision.status, 'complete_full', 'incomplete public evidence published Full');
  assert.equal(gateFor(incompleteDecision, 'reconciliation').passed, false);

  // 4. No merge product at all cannot be read as agreement.
  const noMerge = await evaluateFullEligibility({ ...baseInputs, merge: null });
  assert.notEqual(noMerge.status, 'complete_full', 'a missing merge published Full');
  assert.equal(gateFor(noMerge, 'reconciliation').passed, false);
});

// ===========================================================================
// 21 — finding C2
// ===========================================================================

test('unmeasurable snapshot skew is never treated as zero skew', async () => {
  const evaluateFullEligibility = requireExport('evaluateFullEligibility');
  const healthyInternal = await collectFor({
    responses: evidenceResponses({ ai: 'all-surfaces-complete' }),
  }).result;

  // Internal evidence with NO trusted capture timestamp: the skew is unmeasurable.
  const untimed = { ...structuredClone(healthyInternal), capturedAt: null };
  const merged = (await mergeFor({ internalEvidence: untimed })).result;
  assert.equal(merged.skew.observedMs, null, 'unmeasurable skew was reported as a number');
  assert.equal(merged.skew.withinPolicy, false, 'unmeasurable skew satisfied the policy');
  assert.ok(limitationCodes(merged).includes('PUBLIC_INTERNAL_SNAPSHOT_SKEW'));
  assert.notEqual(merged.status, 'COMPLETE');

  const decision = await evaluateFullEligibility({
    internalEvidence: untimed,
    merge: merged,
    trace: MERGE.traces.clean,
    claimSupport: MERGE.claimSupport.eligible,
    privacyScan: { passed: true },
    verification: { passed: true },
    requiredWindows: REQUIRED_WINDOWS,
    expected: EXPECTED_IDENTITIES,
  });
  assert.notEqual(decision.status, 'complete_full', 'unmeasurable skew published Full');
  assert.equal(gateFor(decision, 'snapshot_skew').passed, false);

  // And with zero public evidence on top of it, still never Full.
  const emptyPublic = (await mergeFor({ internalEvidence: untimed, publicEvidence: [] })).result;
  assert.equal(emptyPublic.skew.withinPolicy, false);
});

// ===========================================================================
// 22 — finding C5
// ===========================================================================

test('a task 10 normalizing checkpoint resumes without quarantine', async () => {
  await withProjectRoot(async (projectRoot) => {
    const runId = 'run_c5_resume';
    let seen = null;
    const analyzer = {
      normalize: async ({ context, publicEvidence, collectionPlan }) => {
        seen = { context, publicEvidence, collectionPlan };
        return { graph: 'safe' };
      },
    };

    // Interrupt the run immediately AFTER the normalizing checkpoint is durably written.
    const interrupted = makeKernel({
      runId,
      analyzer,
      faultInjector: async ({ phase }) => {
        if (phase === 'normalizing') throw new Error('interrupted after normalizing');
      },
    });
    await assert.rejects(() => interrupted.start(startArgs(projectRoot)));

    // The stored input hash is byte-identical to the APPROVED TASK 10 SHAPE: three keys, no
    // `internalHash`. This is the independent oracle — it is computed here, not read back.
    const task10Input = {
      contextHash: sha256(seen.context),
      publicHash: sha256(seen.publicEvidence),
      collectionPlan: seen.collectionPlan,
    };
    const state = openState({ projectRoot, locationId: LOCATION_ID });
    let storedInputHash;
    try {
      const checkpoint = state.getCheckpoint({ runId, phase: 'normalizing' });
      assert.ok(checkpoint, 'no normalizing checkpoint was written');
      storedInputHash = checkpoint.inputHash;
    } finally {
      state.close();
    }
    assert.equal(
      storedInputHash,
      sha256(task10Input),
      'the normalizing checkpoint input drifted from the approved Task 10 shape',
    );
    assert.notEqual(
      storedInputHash,
      sha256({ ...task10Input, internalHash: sha256(null) }),
      'the run with no internal evidence still carried an internalHash',
    );

    // CROSS-VERSION RESUME: a fresh kernel picks the run up and finishes it honestly.
    const resumed = await makeKernel({ runId, analyzer }).resume({
      projectRoot,
      locationId: LOCATION_ID,
      runId,
      vaultKeyReference: 'opaque-ref',
    });
    assert.equal(resumed.status, 'complete_partial', 'the resumed run did not complete');
    assert.notEqual(resumed.status, 'quarantined');
  });
});

// ===========================================================================
// 23 — finding I1
// ===========================================================================

test('same rail contradictions are recorded not resolved by arrival order', async () => {
  const internal = await collectFor().result;

  // TWO public rows for the SAME native id that disagree on `status`.
  const contradicting = [
    { kind: 'workflow', nativeId: 'WF9', name: 'Nine', status: 'draft' },
    { kind: 'workflow', nativeId: 'WF9', name: 'Nine', status: 'published' },
  ];
  const forward = (await mergeFor({
    internalEvidence: internal,
    publicEvidence: [publicEnvelope('baseline', { items: contradicting })],
  })).result;
  const reversed = (await mergeFor({
    internalEvidence: internal,
    publicEvidence: [publicEnvelope('baseline', { items: [...contradicting].reverse() })],
  })).result;

  assert.equal(
    mergeIdentity(reversed),
    mergeIdentity(forward),
    'a same-rail contradiction resolved by arrival order',
  );
  const wf9 = entityFor(forward, 'workflow', 'WF9');
  assert.notEqual(wf9.fields.status, 'draft', 'the first arrival silently won');
  assert.notEqual(wf9.fields.status, 'published', 'the last arrival silently won');
  assert.equal(wf9.fields.status?.state, 'CONFLICT');
  assert.ok(
    (forward.conflicts ?? []).some(
      (entry) => entry.nativeId === 'WF9' && entry.field === 'status' && entry.resolution === 'conflict',
    ),
    'no conflict was recorded for the same-rail contradiction',
  );

  // The same holds for the INTERNAL rail: two records for one workflow id that disagree.
  const twoRecords = {
    ...structuredClone(internal),
    workflows: [
      { workflowId: 'WF7', status: 'published', complete: true, definition: { a: 1 }, runtime: null },
      { workflowId: 'WF7', status: 'draft', complete: true, definition: { a: 2 }, runtime: null },
    ],
  };
  const internalForward = (await mergeFor({ internalEvidence: twoRecords })).result;
  const internalReversed = (await mergeFor({
    internalEvidence: {
      ...structuredClone(twoRecords),
      workflows: [...twoRecords.workflows].reverse(),
    },
  })).result;
  assert.equal(
    mergeIdentity(internalReversed),
    mergeIdentity(internalForward),
    'an internal same-rail contradiction resolved by arrival order',
  );
  const wf7 = entityFor(internalForward, 'workflow', 'WF7');
  assert.equal(wf7.internalFacts.definition?.state, 'CONTRADICTORY');
  assert.ok(
    (internalForward.conflicts ?? []).some(
      (entry) => entry.nativeId === 'WF7' && entry.field === 'internalFacts.definition',
    ),
    'no conflict was recorded for the contradicting internal definitions',
  );
});

// ===========================================================================
// 24 — finding I3
// ===========================================================================

test('an inherited gate property cannot open the full clamp', () => {
  const enforcePublicOnlyPublication = requireExport('enforcePublicOnlyPublication');
  const publishable = {
    coverage: { state: 'complete_full', limitations: [] },
    diff: { state: 'COMPARABLE', transitions: [] },
    findings: [{ id: 'F1', scope: 'account_wide', verdict: 'PASS', impact: 12, totalImpact: 100000 }],
    latestFull: null,
  };

  // Prototype pollution: `typeof gate.passed` used to read the INHERITED property.
  const polluted = [
    ['gate passed inherited', 'passed', true],
    ['gate id inherited', 'id', 'capability_coverage'],
    ['decision eligible inherited', 'eligible', true],
    ['decision status inherited', 'status', 'complete_full'],
  ];
  for (const [label, key, value] of polluted) {
    // eslint-disable-next-line no-extend-native
    Object.defineProperty(Object.prototype, key, {
      value,
      configurable: true,
      enumerable: false,
      writable: true,
    });
    try {
      const decision = {
        status: 'complete_full',
        eligible: true,
        gates: FULL_ELIGIBILITY_GATES.map((id) => ({ id })),
        failedGates: [],
      };
      let output = null;
      try {
        output = enforcePublicOnlyPublication(structuredClone(publishable), {
          fullEligibility: decision,
        });
      } catch (error) {
        assert.match(String(error.code ?? error.message), /AUDIT_INTEGRITY_FAILURE/u, label);
        continue;
      }
      assert.notEqual(output.status, 'complete_full', `${label} lifted the clamp`);
      assert.equal(output.findings[0].scope, 'public_comparable_subset', label);
      assert.equal(output.findings[0].verdict, 'UNKNOWN', label);
      assert.equal(output.findings[0].totalImpact, null, label);
    } finally {
      delete Object.prototype[key];
    }
  }

  // The decision must also NAME the run it describes when the caller states one.
  const evaluateFullEligibility = requireExport('evaluateFullEligibility');
  return (async () => {
    const healthyInternal = await collectFor({
      responses: evidenceResponses({ ai: 'all-surfaces-complete' }),
    }).result;
    const bound = await evaluateFullEligibility({
      internalEvidence: healthyInternal,
      merge: (await mergeFor({ internalEvidence: healthyInternal })).result,
      trace: MERGE.traces.clean,
      claimSupport: MERGE.claimSupport.eligible,
      privacyScan: { passed: true },
      verification: { passed: true },
      requiredWindows: REQUIRED_WINDOWS,
      expected: EXPECTED_IDENTITIES,
      // Decision D11: only the run's SEALED frozen inputs anchor an identity.
      frozenInputs: r3FrozenInputs(),
      // Finding R7-C1: and only a host-authenticated anchor block anchors at all.
      frozenInputProvenance: anchorProvenanceFor(r3FrozenInputs()),
      run: { runId: 'run_a', frozenInputsHash: 'a'.repeat(64) },
    });
    assert.equal(bound.status, 'complete_full');
    assert.equal(bound.runId, 'run_a');
    assert.equal(bound.frozenInputsHash, 'a'.repeat(64));

    // The right run lifts the clamp.
    assert.equal(
      enforcePublicOnlyPublication(structuredClone(publishable), {
        fullEligibility: bound,
        expectedRun: { runId: 'run_a', frozenInputsHash: 'a'.repeat(64) },
      }).status,
      'complete_full',
    );
    // Another run's decision does not.
    for (const wrong of [
      { runId: 'run_b', frozenInputsHash: 'a'.repeat(64) },
      { runId: 'run_a', frozenInputsHash: 'b'.repeat(64) },
    ]) {
      assert.equal(
        enforcePublicOnlyPublication(structuredClone(publishable), {
          fullEligibility: bound,
          expectedRun: wrong,
        }).status,
        'complete_partial',
        canonicalJson(wrong),
      );
    }
  })();
});

// ===========================================================================
// 25 — finding I4
// ===========================================================================

test('internal integrity codes quarantine instead of failing', async () => {
  const quarantining = [
    'AUDIT_QUARANTINED',
    'INTERNAL_AUDIT_LOCATION_MISMATCH',
    'INTERNAL_AUDIT_MANIFEST_INVALID',
    'INTERNAL_AUDIT_PROFILE_MISMATCH',
    'INTERNAL_AUDIT_READ_ONLY_VIOLATION',
  ];
  for (const code of quarantining) {
    await withProjectRoot(async (projectRoot) => {
      const runId = 'run_i4';
      const kernel = makeKernel({
        runId,
        analyzer: {
          normalize: async () => {
            throw Object.assign(new Error(code), { code });
          },
        },
      });
      await assert.rejects(() => kernel.start(startArgs(projectRoot)), (error) => {
        assert.match(String(error.code), /^AUDIT_QUARANTINED$/u, code);
        return true;
      });
      const state = openState({ projectRoot, locationId: LOCATION_ID });
      try {
        assert.equal(state.getRun(runId).status, 'quarantined', `${code} landed in failed`);
      } finally {
        state.close();
      }
    });
  }

  // A genuinely non-integrity error still fails rather than quarantining.
  await withProjectRoot(async (projectRoot) => {
    const runId = 'run_i4_failed';
    const kernel = makeKernel({
      runId,
      analyzer: {
        normalize: async () => {
          throw Object.assign(new Error('PROVIDER_RATE_LIMITED'), { code: 'PROVIDER_RATE_LIMITED' });
        },
      },
    });
    await assert.rejects(() => kernel.start(startArgs(projectRoot)));
    const state = openState({ projectRoot, locationId: LOCATION_ID });
    try {
      assert.equal(state.getRun(runId).status, 'failed');
    } finally {
      state.close();
    }
  });
});

// ===========================================================================
// 26 — finding I7
// ===========================================================================

test('the internal evidence integration is wired into a real kernel run', async () => {
  const evaluateFullEligibility = requireExport('evaluateFullEligibility');

  // The realistic proof state: an OFFLINE-only proof index, exactly what the checked-in offline
  // gate can produce. No live canary was run, so no `live_runtime` receipt exists.
  const offlineProof = makeProofIndex({
    receiptOverrides: Object.fromEntries(
      APPLICABLE_CAPABILITIES.map((id) => [id, { proofClass: 'offline_contract' }]),
    ),
  });

  await withProjectRoot(async (projectRoot) => {
    const runId = 'run_i7';
    const normalizeArgs = [];
    const publisherArgs = [];
    const kernel = makeKernel({
      runId,
      adapters: {
        collectInternal: async () => makeAdapter({ capabilityProofIndex: offlineProof }),
      },
      analyzer: {
        normalize: async (input) => {
          normalizeArgs.push(input);
          return { graph: 'safe' };
        },
      },
      publisher: async (input) => {
        publisherArgs.push(input);
        return { publicationId: 'pub_i7' };
      },
    });
    const result = await kernel.start(startArgs(projectRoot));

    // 1. The internal evidence and the merge product REACH normalization.
    assert.equal(normalizeArgs.length, 1);
    assert.notEqual(normalizeArgs[0].internalEvidence, null, 'internalEvidence never reached normalize');
    assert.notEqual(normalizeArgs[0].internalEvidence, undefined, 'internalEvidence never reached normalize');
    assert.equal(normalizeArgs[0].internalEvidence.source, 'internal_ghl');
    assert.ok(normalizeArgs[0].merge, 'the merge product never reached normalize');
    assert.ok(['COMPLETE', 'PARTIAL', 'QUARANTINED'].includes(normalizeArgs[0].merge.status));

    // 2. The run still publishes complete_partial, and the manifest status is DERIVED from the
    //    decision rather than hardcoded.
    assert.equal(result.status, 'complete_partial');
    assert.equal(publisherArgs.length, 1);

    // 3. The internal collection phase really ran and was checkpointed.
    const state = openState({ projectRoot, locationId: LOCATION_ID });
    try {
      assert.ok(
        state.getCheckpoint({ runId, phase: 'collecting_internal' }),
        'the collecting_internal phase never checkpointed',
      );
    } finally {
      state.close();
    }

    // 4. `complete_full` is unreachable for the RIGHT reason: gate 2 has no unexpired
    //    live_runtime receipt to satisfy it. The SAME evidence, evaluated directly, names it.
    const internal = await collectFor({ capabilityProofIndex: offlineProof }).result;
    const decision = await evaluateFullEligibility({
      internalEvidence: internal,
      merge: (await mergeFor({ internalEvidence: internal })).result,
      trace: MERGE.traces.clean,
      claimSupport: MERGE.claimSupport.eligible,
      privacyScan: { passed: true },
      verification: { passed: true },
      requiredWindows: REQUIRED_WINDOWS,
      expected: EXPECTED_IDENTITIES,
      run: { runId, frozenInputsHash: sha256(kernelFrozenInputs()) },
    });
    assert.equal(decision.status, 'complete_partial');
    assert.ok(
      decision.failedGates.includes('live_runtime_receipts'),
      'gate 2 is not the reason Full is unreachable',
    );
  });

  // 5. The decision is genuinely CONSUMED, not computed and dropped: a private canary in the
  //    compiled payload fails the privacy gate and quarantines the run (decision D4).
  await withProjectRoot(async (projectRoot) => {
    const runId = 'run_i7_privacy';
    const compile = async () => ({
      status: 'complete_partial',
      findings: [{ id: 'F1', transcript: CANARIES.transcript }],
    });
    const kernel = makeKernel({
      runId,
      adapters: {
        collectInternal: async () => makeAdapter({ capabilityProofIndex: offlineProof }),
      },
      analyzer: { compile },
    });
    await assert.rejects(() => kernel.start(startArgs(projectRoot)), /AUDIT_QUARANTINED/u);
    const state = openState({ projectRoot, locationId: LOCATION_ID });
    try {
      assert.equal(state.getRun(runId).status, 'quarantined');
    } finally {
      state.close();
    }

    // The very same payload on the PUBLIC-ONLY path is untouched by the internal integration.
    await withProjectRoot(async (publicRoot) => {
      const publicOnly = await makeKernel({
        runId: 'run_i7_public_only',
        analyzer: { compile },
      }).start(startArgs(publicRoot));
      assert.equal(publicOnly.status, 'complete_partial');
    });
  });
});

// ===========================================================================
// 27 — finding I8
// ===========================================================================

test('full publication substitutes rather than skips the sanitizers', async () => {
  const enforcePublicOnlyPublication = requireExport('enforcePublicOnlyPublication');
  const evaluateFullEligibility = requireExport('evaluateFullEligibility');
  const healthyInternal = await collectFor({
    responses: evidenceResponses({ ai: 'all-surfaces-complete' }),
  }).result;
  // Finding R2-M1: the decision NAMES its run, and every publication gate below states that
  // same run. An unbound decision can never lift the clamp.
  const RUN = { runId: 'run_substitutes', frozenInputsHash: 'e'.repeat(64) };
  const full = await evaluateFullEligibility({
    internalEvidence: healthyInternal,
    merge: (await mergeFor({ internalEvidence: healthyInternal })).result,
    trace: MERGE.traces.clean,
    claimSupport: MERGE.claimSupport.eligible,
    privacyScan: { passed: true },
    verification: { passed: true },
    requiredWindows: REQUIRED_WINDOWS,
    expected: EXPECTED_IDENTITIES,
    // Decision D11: only the run's SEALED frozen inputs anchor an identity.
    frozenInputs: r3FrozenInputs(),
    // Finding R7-C1: and only a host-authenticated anchor block anchors at all.
    frozenInputProvenance: anchorProvenanceFor(r3FrozenInputs()),
    run: RUN,
  });
  assert.equal(full.status, 'complete_full', 'the Full decision under test is not eligible');

  // A Full run may keep account-wide scope, PASS verdicts and measured impact.
  const clean = enforcePublicOnlyPublication({
    coverage: { state: 'complete_full', limitations: [] },
    diff: { state: 'COMPARABLE', transitions: [] },
    findings: [{ id: 'F1', scope: 'account_wide', verdict: 'PASS', impact: 12 }],
    latestFull: null,
  }, { fullEligibility: full, expectedRun: RUN });
  assert.equal(clean.status, 'complete_full');
  assert.equal(clean.findings[0].scope, 'account_wide');

  // But it may NEVER publish private content, at any scope.
  const leaks = [
    ['transcript canary', { id: 'F1', scope: 'account_wide', transcript: CANARIES.transcript }],
    ['raw contact email key', { id: 'F1', scope: 'account_wide', email: 'patient@example.com' }],
    ['email in free text', { id: 'F1', scope: 'account_wide', evidence: `contacted ${CANARIES.pii}` }],
    ['bearer token', { id: 'F1', scope: 'account_wide', note: CANARIES.authorization }],
    ['vault key reference', { id: 'F1', scope: 'account_wide', note: CANARIES.keyReference }],
    ['raw request line', { id: 'F1', scope: 'account_wide', note: CANARIES.rawRequest }],
  ];
  for (const [label, finding] of leaks) {
    assert.throws(
      () => enforcePublicOnlyPublication({
        coverage: { state: 'complete_full', limitations: [] },
        diff: { state: 'COMPARABLE', transitions: [] },
        findings: [finding],
        latestFull: null,
      }, { fullEligibility: full, expectedRun: RUN }),
      /AUDIT_INTEGRITY_FAILURE/u,
      `${label} was published at Full scope`,
    );
  }

  // Nor a claim whose support is stale, inferred-only or ambiguous.
  for (const support of ['inferred_only', 'stale', 'ambiguous']) {
    assert.throws(
      () => enforcePublicOnlyPublication({
        coverage: { state: 'complete_full', limitations: [] },
        diff: { state: 'COMPARABLE', transitions: [] },
        findings: [{ id: 'F1', scope: 'account_wide', support }],
        latestFull: null,
      }, { fullEligibility: full, expectedRun: RUN }),
      /AUDIT_INTEGRITY_FAILURE/u,
      support,
    );
  }

  // The trusted-publication carrier gets the same substitutes.
  assert.throws(
    () => enforcePublicOnlyPublication({
      manifestInput: { schemaVersion: '1.0.0', runId: 'run-full', status: 'complete_full' },
      projections: { memory: [] },
      payloadArtifacts: {
        'coverage.json': { state: 'complete_full', limitations: [] },
        'metrics-and-findings.json': {
          sealedInputs: { run: { status: 'complete_full' } },
          findings: [{ id: 'F1', transcript: CANARIES.transcript }],
        },
        'REPORT.md': '# Account-wide audit\n',
      },
    }, { fullEligibility: full, expectedRun: RUN }),
    /AUDIT_INTEGRITY_FAILURE/u,
    'a trusted Full payload published a transcript canary',
  );
});

// ===========================================================================
// 28 — finding M1
// ===========================================================================

test('a non integer declared count fails the public recount', async () => {
  const internal = await collectFor().result;
  const declarations = [
    ['string total', '9999'],
    ['float total', 7.5],
    ['null total', null],
    ['NaN total', Number.NaN],
    ['boolean total', true],
  ];
  for (const [label, declared] of declarations) {
    const envelope = publicEnvelope('baseline');
    envelope.page.reportedCount = declared;
    const merged = (await mergeFor({
      internalEvidence: internal,
      publicEvidence: [envelope],
    })).result;
    assert.ok(
      limitationCodes(merged).includes('PUBLIC_EVIDENCE_RECONCILIATION_FAILED'),
      `${label} skipped the anti-oracle recount`,
    );
    assert.notEqual(merged.status, 'COMPLETE', label);
  }

  // The honest integer declaration still reconciles.
  const honest = (await mergeFor({ internalEvidence: internal })).result;
  assert.equal(honest.status, 'COMPLETE');
});

// ===========================================================================
// 29 — finding M2
// ===========================================================================

test('an empty read only trace cannot satisfy the read only gate', async () => {
  const evaluateFullEligibility = requireExport('evaluateFullEligibility');
  const healthyInternal = await collectFor({
    responses: evidenceResponses({ ai: 'all-surfaces-complete' }),
  }).result;
  const baseInputs = {
    internalEvidence: healthyInternal,
    merge: (await mergeFor({ internalEvidence: healthyInternal })).result,
    claimSupport: MERGE.claimSupport.eligible,
    privacyScan: { passed: true },
    verification: { passed: true },
    requiredWindows: REQUIRED_WINDOWS,
    expected: EXPECTED_IDENTITIES,
  };
  for (const [label, trace] of [['empty array', []], ['null', null], ['absent', undefined]]) {
    const decision = await evaluateFullEligibility({ ...baseInputs, trace });
    assert.equal(gateFor(decision, 'read_only_trace').passed, false, `${label} passed gate 7`);
    assert.notEqual(decision.status, 'complete_full', label);
    // Missing evidence is Partial, not quarantine — only a VIOLATION quarantines.
    assert.equal(decision.status, 'complete_partial', label);
  }
  // A trace that actually contains a violation still quarantines.
  const violating = await evaluateFullEligibility({
    ...baseInputs,
    trace: MERGE.traces['write-attempt'],
  });
  assert.equal(violating.status, 'quarantined');
});

// ===========================================================================
// 30 — finding M3
// ===========================================================================

test('the bounded public refresh is at most once per logical run', async () => {
  const internal = await collectFor().result;

  // First attempt in this logical run: the refresh is called exactly once.
  const first = await mergeFor({
    internalEvidence: internal,
    publicName: 'skew-above-policy',
    refresh: 'incomplete',
  });
  assert.equal(first.refreshCalls.length, 1);
  assert.ok(first.result.publicRefreshLedger, 'no durable refresh mark was published');
  assert.equal(first.result.publicRefreshLedger.attempted, true);
  assert.equal(first.result.publicRefreshLedger.attemptedThisCall, true);

  // The SAME logical run, resumed with the ledger it already produced: no second refresh.
  const mergeInternalEvidence = requireExport('mergeInternalEvidence');
  const refreshCalls = [];
  const second = await mergeInternalEvidence({
    publicEvidence: [publicEnvelope('skew-above-policy')],
    internalEvidence: internal,
    coveragePolicy: COVERAGE_POLICY,
    checkpoint: structuredClone(PUBLIC_CHECKPOINT),
    refreshPublicEvidence: async (request) => {
      refreshCalls.push(request);
      return publicEnvelope('complete', { table: 'refreshes' });
    },
    refreshLedger: { attempted: true },
    runtime: { now: () => Date.parse(NOW_ISO) },
  });
  assert.equal(refreshCalls.length, 0, 'the bounded refresh was spent twice in one logical run');
  assert.equal(second.publicRefreshLedger.alreadyAttempted, true);
  assert.equal(second.skew.refreshed, false);
  assert.ok(limitationCodes(second).includes('PUBLIC_INTERNAL_SNAPSHOT_SKEW'));
  assert.notEqual(second.status, 'COMPLETE');

  // A durable checkpoint mark works the same way.
  const checkpointCalls = [];
  const third = await mergeInternalEvidence({
    publicEvidence: [publicEnvelope('skew-above-policy')],
    internalEvidence: internal,
    coveragePolicy: COVERAGE_POLICY,
    checkpoint: { ...structuredClone(PUBLIC_CHECKPOINT), publicRefreshAttempted: true },
    refreshPublicEvidence: async (request) => {
      checkpointCalls.push(request);
      return publicEnvelope('complete', { table: 'refreshes' });
    },
    runtime: { now: () => Date.parse(NOW_ISO) },
  });
  assert.equal(checkpointCalls.length, 0, 'a durable refresh mark was ignored');
  assert.equal(third.publicRefreshLedger.alreadyAttempted, true);
});

// ===========================================================================
// 31 — controller decision D7
// ===========================================================================

test('unpinned internal proof identities can never support full', async () => {
  const evaluateFullEligibility = requireExport('evaluateFullEligibility');
  const healthyInternal = await collectFor({
    responses: evidenceResponses({ ai: 'all-surfaces-complete' }),
  }).result;
  assert.equal(healthyInternal.complete, true);
  assert.ok(healthyInternal.capabilityProofAnchor, 'the adapter published no proof anchor');
  assert.equal(healthyInternal.capabilityProofAnchor.manifestPinned, false);
  assert.equal(healthyInternal.capabilityProofAnchor.bundlePinned, false);

  const merge = (await mergeFor({ internalEvidence: healthyInternal })).result;
  const baseInputs = {
    internalEvidence: healthyInternal,
    merge,
    trace: MERGE.traces.clean,
    claimSupport: MERGE.claimSupport.eligible,
    privacyScan: { passed: true },
    verification: { passed: true },
    requiredWindows: REQUIRED_WINDOWS,
  };

  // With NO independent anchor for the manifest or the bundle, Full is impossible however
  // healthy everything else is. Unpinned evidence may only ever support complete_partial.
  const unanchored = [
    ['no expected identities at all', { locationId: LOCATION_ID }],
    ['manifest anchored, bundle not', {
      locationId: LOCATION_ID,
      toolProfileHash: TOOL_PROFILE_HASH,
      capabilityManifestHash: MANIFEST_HASH,
    }],
    ['bundle anchored, manifest not', {
      locationId: LOCATION_ID,
      toolProfileHash: TOOL_PROFILE_HASH,
      bundleHash: BUNDLE_HASH,
    }],
  ];
  for (const [label, expected] of unanchored) {
    const decision = await evaluateFullEligibility({ ...baseInputs, expected });
    assert.notEqual(decision.status, 'complete_full', `${label} reached Full unpinned`);
    assert.equal(decision.status, 'complete_partial', label);
    assert.equal(gateFor(decision, 'live_runtime_receipts').passed, false, label);
    assert.ok(
      limitationCodes(decision).includes('INTERNAL_AUDIT_PROOF_UNANCHORED'),
      `${label} named no anchoring limitation`,
    );
  }

  // Evidence with the anchor block stripped entirely is likewise never Full.
  const { capabilityProofAnchor: _dropped, ...noAnchor } = structuredClone(healthyInternal);
  const strippedDecision = await evaluateFullEligibility({
    ...baseInputs,
    internalEvidence: noAnchor,
    expected: EXPECTED_IDENTITIES,
  });
  assert.notEqual(strippedDecision.status, 'complete_full', 'evidence with no anchor reached Full');
  assert.equal(gateFor(strippedDecision, 'live_runtime_receipts').passed, false);

  // An adapter-pinned run whose identities the run SEALED at creation reaches Full without any
  // caller-supplied expectation. Decision D11: the pin flags anchor nothing on their own — the
  // sealed frozen inputs do — so the decision that reaches Full is genuinely sealed.
  const pinned = await collectWith({
    expectedCapabilityManifestHash: MANIFEST_HASH,
    expectedBundleHash: BUNDLE_HASH,
  }, { responses: evidenceResponses({ ai: 'all-surfaces-complete' }) });
  assert.equal(pinned.capabilityProofAnchor.manifestPinned, true);
  assert.equal(pinned.capabilityProofAnchor.bundlePinned, true);
  const pinnedDecision = await evaluateFullEligibility({
    ...baseInputs,
    internalEvidence: pinned,
    merge: (await mergeFor({ internalEvidence: pinned })).result,
    expected: { locationId: LOCATION_ID },
    frozenInputs: r3FrozenInputs(),
    // Finding R7-C1: and only a host-authenticated anchor block anchors at all.
    frozenInputProvenance: anchorProvenanceFor(r3FrozenInputs()),
  });
  assert.equal(pinnedDecision.status, 'complete_full');
  assert.equal(gateFor(pinnedDecision, 'live_runtime_receipts').passed, true);
});

// ===========================================================================
// 32 — finding M6
// ===========================================================================

test('the checked in bundle carries the task 11 symbols', () => {
  const bundle = readFileSync(join(HERE, '..', 'dist', 'audit-cli.mjs'), 'utf8');
  for (const symbol of [
    'mergeInternalEvidence',
    'evaluateFullEligibility',
    'collectInternalEvidencePhase',
    'scanPublicationPrivacy',
    'capabilityProofAnchor',
    'INTERNAL_AUDIT_PROOF_UNANCHORED',
  ]) {
    assert.ok(bundle.includes(symbol), `dist/audit-cli.mjs is stale: ${symbol} is missing`);
  }
});


// ===========================================================================
// 40 — R2-C4 (privacy): the allow list constrains key NAMES; it must also
// constrain VALUES. Round 1 stopped unexpected keys; unbounded private free
// text under an EXPECTED key still reached a healthy complete result, the
// checkpoint and the publisher input.
// ===========================================================================

// Planted under keys the projection deliberately RETAINS. 'status', 'terminalReason',
// 'enrollmentTotals.source'/'.scope' and 'filters.contactId' are all raw upstream GHL row
// fields (core/audit-configuration.mjs pushes the raw row), so they are attacker-influenced.
const VALUE_CANARIES = Object.freeze({
  transcript: 'QCANARY Hi Jane Doe, this is Dr Smith re your Botox consult on Tuesday',
  privatePath: '/Users/uxie/.codex/QCANARY-private/audit-token-file.json',
  phone: '+61400QCANARY9',
  scopeProse: 'QCANARY scope: every contact of jane.doe@example.com since March',
});

function assertNoValueCanary(value, label, only = Object.keys(VALUE_CANARIES)) {
  const encoded = JSON.stringify(value ?? null);
  for (const name of only) {
    assert.equal(
      encoded.includes(VALUE_CANARIES[name]),
      false,
      name + ' escaped into ' + label,
    );
  }
}

test('retained values are grammar checked not passed through', async () => {
  // ---- the healthy path: expected keys, private values ----------------------
  const canaried = collectFor({
    responses: evidenceResponses({
      rosterOver: {
        workflows: [
          { id: 'WF1', name: '01 Meta Lead Intake', status: VALUE_CANARIES.privatePath, version: 4 },
          { id: 'WF2', name: '02 Nurture', status: 'published', version: 2 },
        ],
      },
      runtimeOver: {
        filters: { contactId: VALUE_CANARIES.phone, eventTypes: [], stepIds: [] },
        enrollmentTotals: {
          total: 0,
          finished: 0,
          source: VALUE_CANARIES.transcript,
          scope: VALUE_CANARIES.scopeProse,
        },
      },
    }),
  });
  const resolved = await canaried.result;

  // The finding is about the HEALTHY path: the run must stay complete and carry none of it.
  assert.equal(resolved.complete, true, 'the canaried run stopped being healthy');
  assertNoValueCanary(resolved, 'a healthy complete result');
  assertNoValueCanary(resolved.checkpoint, 'the checkpoint');
  assertNoValueCanary(resolved.trace, 'the trace');
  assertNoValueCanary(resolved.capabilityCoverage, 'capabilityCoverage');
  // The same object once it is a publication input.
  assertNoValueCanary(
    { status: 'complete_partial', internalEvidence: resolved, checkpoint: resolved.checkpoint },
    'the publication input',
  );

  // Dropped, not coerced into some other private shape.
  assert.equal(workflowRecord(resolved, 'WF1').status, null, 'a private path survived as a status');
  assert.equal(workflowRecord(resolved, 'WF2').status, 'published', 'an honest status was dropped');
  const runtime = workflowRecord(resolved, 'WF1').runtime;
  assert.notEqual(runtime.filters.contactId, VALUE_CANARIES.phone);
  assert.notEqual(runtime.enrollmentTotals.source, VALUE_CANARIES.transcript);
  assert.notEqual(runtime.enrollmentTotals.scope, VALUE_CANARIES.scopeProse);
  // The ledger arithmetic the audit actually consumes still survives the grammar.
  assert.equal(runtime.enrollmentTotals.total, 0);

  // ---- the terminal reason: a machine token, never prose --------------------
  const proseTerminal = await collectFor({
    responses: evidenceResponses({ rosterOver: { terminalReason: VALUE_CANARIES.transcript } }),
  }).result;
  assertNoValueCanary(proseTerminal, 'the roster result');
  assertNoValueCanary(proseTerminal.checkpoint, 'the roster checkpoint');
  assertNoValueCanary(proseTerminal.trace, 'the roster trace');
  assert.notEqual(proseTerminal.workflowRoster.terminalReason, VALUE_CANARIES.transcript);
  assert.equal(proseTerminal.complete, false, 'an unreadable terminal reason sealed the roster');

  // ---- the bounded door leaks the same way ---------------------------------
  const page = await makeAdapter({
    responses: evidenceResponses({
      rosterOver: {
        workflows: [
          { id: 'WF1', name: '01 Meta Lead Intake', status: VALUE_CANARIES.privatePath, version: 4 },
          { id: 'WF2', name: '02 Nurture', status: 'published', version: 2 },
        ],
      },
    }),
  }).collect({ capability: { capabilityId: 'workflow_roster_list' }, window: WINDOW });
  assert.equal(page.page.complete, true, 'the bounded collect stopped being healthy');
  assertNoValueCanary(page, 'the bounded collection envelope', ['privatePath']);
  const canariedItem = page.items.find((item) => item.workflowId === 'WF1');
  assert.ok(canariedItem, 'the bounded collect dropped the row entirely');
  assert.equal(canariedItem.status, null, 'a private path survived into collect() items');
});

// ===========================================================================
// 41 — R2-C2 (adapter half): 'applicability.workflowIds' is a REQUEST, and the
// SEALED ROSTER is the denominator. A roster member that was never read may
// not report itself complete, and the composite may not assert a completeness
// it does not have.
// ===========================================================================

test('an unread roster member never reports itself complete', async () => {
  const narrowed = await collectFor({
    responses: evidenceResponses({
      runtimeByWorkflow: { WF1: 'complete-no-step-rosters' },
    }),
  }, {
    applicability: { capabilityIds: APPLICABLE_CAPABILITIES, workflowIds: ['WF1'] },
  }).result;

  // Both roster members are still recorded; the roster is never retroactively narrowed.
  assert.deepEqual([...narrowed.workflowRoster.workflowIds].sort(), ['WF1', 'WF2']);
  const unread = workflowRecord(narrowed, 'WF2');
  assert.equal(unread.applicable, false);
  assert.notEqual(unread.complete, true, 'a workflow that was never read declared itself complete');
  assert.equal(unread.definition, null);
  assert.equal(unread.runtime, null);

  // The composite must not claim completeness over a denominator it only half read.
  assert.equal(narrowed.complete, false, 'one of two roster workflows read still reported complete');
  assert.ok(
    hasCode(narrowed, /INTERNAL_AUDIT_WORKFLOW_INCOMPLETE/u),
    'the unread roster member raised no code the gate can see',
  );
  assert.ok(
    narrowed.warnings.some((entry) => entry.component === 'WF2'),
    'the unread roster member was never named in the warnings',
  );

  // ...and it is reconciled explicitly, the C3 reconciliation mirrored onto the workflow axis.
  const coverage = narrowed.workflowCoverage;
  assert.ok(coverage, 'no workflow coverage was reported at all');
  assert.equal(coverage.rosterTotal, 2);
  assert.equal(coverage.reviewed, 1);
  assert.deepEqual(coverage.notReviewed, ['WF2']);
  assert.equal(coverage.reconciled, false);
  assert.equal(narrowed.checkpoint.rosterReconciled, false);
  assert.deepEqual(narrowed.checkpoint.collectedWorkflowIds, ['WF1']);

  // Control: reading the WHOLE sealed roster reconciles and stays complete.
  const whole = await collectFor().result;
  assert.equal(whole.complete, true);
  assert.equal(whole.workflowCoverage.reconciled, true);
  assert.deepEqual(whole.workflowCoverage.notReviewed, []);
  assert.equal(whole.workflowCoverage.reviewed, 2);
  assert.equal(whole.workflowCoverage.complete, 2);
});

// ===========================================================================
// 42 — R2-I5: a non-boolean 'component.applicable' is UNKNOWN, and unknown is
// 'null'. Copying it verbatim carried an arbitrary nested wire object into the
// result through the 'ai_applicability_unknown' path.
// ===========================================================================

test('a non boolean ai applicability is nulled not copied', async () => {
  const applicabilityCanary = {
    bearerToken: 'CANARY-APPLICABILITY-eyJhbGciOiJIUzI1NiJ9.LEAK',
    contactEmail: 'canary.applicability@example.com',
    transcript: 'CANARY APPLICABILITY TRANSCRIPT: she asked to reschedule to Friday',
  };
  const components = structuredClone(AI_BUNDLES['all-surfaces-complete'].components);
  components.conversation_ai.applicable = applicabilityCanary;

  const resolved = await collectFor({
    responses: evidenceResponses({ ai: 'all-surfaces-complete', aiOver: { components } }),
  }).result;

  const component = resolved.aiConfiguration.components.conversation_ai;
  assert.equal(component.applicable, null, 'a non boolean applicability was copied verbatim');
  assert.notEqual(component.complete, true);
  assert.ok(hasCode(resolved, /INTERNAL_AUDIT_AI_INCOMPLETE/u));
  for (const [name, canary] of Object.entries(applicabilityCanary)) {
    assert.equal(JSON.stringify(resolved).includes(canary), false, name + ' escaped the result');
    assert.equal(JSON.stringify(resolved.checkpoint).includes(canary), false, name + ' escaped the checkpoint');
  }

  // A genuine boolean still travels, in both states.
  const declaredFalse = structuredClone(AI_BUNDLES['all-surfaces-complete'].components);
  declaredFalse.conversation_ai.applicable = false;
  const withFalse = await collectFor({
    responses: evidenceResponses({ ai: 'all-surfaces-complete', aiOver: { components: declaredFalse } }),
  }).result;
  assert.equal(withFalse.aiConfiguration.components.conversation_ai.applicable, false);
  const healthyAi = await collectFor({
    responses: evidenceResponses({ ai: 'all-surfaces-complete' }),
  }).result;
  assert.equal(healthyAi.aiConfiguration.components.conversation_ai.applicable, true);
});

// ===========================================================================
// 43 — R2-I6: roster row identity is the SERVER's vocabulary, not the
// fixtures'. 'core/audit-configuration.mjs' idOf() reads '_id' first, 'id'
// second, unwraps one BSON wrapper and String()-coerces, over the RAW GHL row.
// ===========================================================================

const RAW_ROSTER_ROWS = fixture('roster-raw-row-shapes.json');

test('roster rows are identified with the servers own id vocabulary', async () => {
  const layer = (name) => {
    const scenario = RAW_ROSTER_ROWS[name];
    assert.ok(scenario, 'unknown raw roster scenario ' + name);
    return {
      workflows: scenario.workflows,
      reportedTotal: scenario.reportedTotal,
      uniqueCount: scenario.uniqueCount,
      uniqueProgress: scenario.uniqueProgress,
      totalHistory: scenario.totalHistory,
      pagination: scenario.pagination,
    };
  };

  // '_id'-only and '{$oid}'-wrapped rows are the LIVE shape, and they must seal and collect.
  for (const name of ['underscore-id', 'oid-wrapped-id', 'unreadable-underscore-falls-back-to-id']) {
    const scenario = RAW_ROSTER_ROWS[name];
    assert.equal(scenario.expect, 'complete', name + ' fixture drifted');
    const { result, calls } = collectFor({
      responses: evidenceResponses({ rosterOver: layer(name) }),
    });
    const resolved = await result;
    assert.equal(resolved.workflowRoster.sealed, true, name + ' never sealed');
    assert.deepEqual([...resolved.workflowRoster.workflowIds].sort(), [...scenario.ids].sort(), name);
    assert.equal(hasCode(resolved, /INTERNAL_AUDIT_ROSTER_INCOMPLETE/u), false, name);
    assert.equal(resolved.complete, true, name + ' collected nothing');
    assert.deepEqual(
      [...new Set(callsFor(calls, 'get_workflow_runtime_window').map((entry) => entry.arguments.workflowId))].sort(),
      [...scenario.ids].sort(),
      name + ' addressed the wrong workflow',
    );
  }

  // A numeric id is String()-coerced, exactly as the server coerces it.
  const numeric = RAW_ROSTER_ROWS['numeric-id'];
  const numericRun = collectFor({
    responses: evidenceResponses({
      rosterOver: layer('numeric-id'),
      exportByWorkflow: Object.fromEntries(numeric.ids.map((id) => [id, failBody('HTTP_404')])),
    }),
  });
  const numericResult = await numericRun.result;
  assert.equal(numericResult.workflowRoster.sealed, true, 'a numeric _id never sealed');
  assert.deepEqual([...numericResult.workflowRoster.workflowIds].sort(), [...numeric.ids].sort());
  assert.deepEqual(
    [...new Set(callsFor(numericRun.calls, 'export_workflow').map((entry) => entry.arguments.workflowId))].sort(),
    [...numeric.ids].sort(),
  );

  // One row serialized three ways is ONE row, not three sharing an id.
  const triple = RAW_ROSTER_ROWS['one-row-three-serializations'];
  const tripleResult = await collectFor({
    responses: evidenceResponses({
      rosterOver: layer('one-row-three-serializations'),
      exportByWorkflow: Object.fromEntries(triple.ids.map((id) => [id, failBody('HTTP_404')])),
    }),
  }).result;
  assert.equal(tripleResult.workflowRoster.sealed, true, 'the deduped roster never sealed');
  assert.deepEqual(tripleResult.workflowRoster.workflowIds, [...triple.ids]);

  // Fail closed on what the server itself refuses to call an id.
  for (const name of ['empty-string-id-is-not-an-id', 'free-text-id-is-not-an-id']) {
    assert.equal(RAW_ROSTER_ROWS[name].expect, 'incomplete', name + ' fixture drifted');
    const { result, calls } = collectFor({
      responses: evidenceResponses({ rosterOver: layer(name) }),
    });
    const rejected = await result;
    assert.notEqual(rejected.workflowRoster.sealed, true, name);
    assert.ok(hasCode(rejected, /INTERNAL_AUDIT_ROSTER_INCOMPLETE/u), name);
    assert.equal(callsFor(calls, 'export_workflow').length, 0, name);
    assert.equal(
      JSON.stringify(rejected).includes('QCANARY'),
      false,
      name + ' echoed an unreadable id',
    );
  }
});

// ===========================================================================
// 44 — R2-M6: 'projectRoute' echoed 'route.capabilityId' before it was
// validated against the sealed manifest.
// ===========================================================================

test('an unsealed route capability id is never echoed', async () => {
  const ROGUE = 'QCANARY_capability_for_jane.doe@example.com';
  const rogueRoute = {
    capabilityId: ROGUE,
    host: 'backend',
    appliedPath: '/QCANARY/rogue/path',
    appliedQuery: { tokenId: 'QCANARY-TOKEN' },
    status: 200,
    ok: true,
    failureClass: null,
    capturedAt: '2026-07-20T00:05:00.000Z',
  };

  const resolved = await collectFor({
    responses: evidenceResponses({
      rosterOver: {
        sourceRoutes: [route('workflow_roster_list', '/workflow/' + LOCATION_ID + '/list'), rogueRoute],
      },
    }),
  }).result;

  // Nothing the wire invented is repeated anywhere — not as a value, not as an object KEY.
  assert.equal(JSON.stringify(resolved).includes(ROGUE), false, 'an unsealed capability id was echoed');
  assert.equal(JSON.stringify(resolved).includes('QCANARY'), false, 'a rogue route survived projection');
  assert.equal(Object.hasOwn(resolved.capabilityCoverage, ROGUE), false);
  for (const entry of resolved.sourceRoutes) {
    assert.ok(
      entry.capabilityId === null || DESCRIPTORS_BY_ID.has(entry.capabilityId),
      'a projected route named a capability the sealed manifest does not know',
    );
  }

  // Dropping the NAME never softens the reconciliation: exercising an unsealed route still
  // fails the run closed.
  assert.equal(resolved.complete, false, 'an unsealed exercised route was waved through');
  assert.ok(hasCode(resolved, /INTERNAL_AUDIT_CAPABILITY_UNPROVEN|INTERNAL_AUDIT_ROSTER_INCOMPLETE/u));

  // Control: a sealed id is still echoed, and still resolves to its descriptor.
  const healthy = await collectFor().result;
  assert.equal(healthy.complete, true);
  assert.ok(healthy.sourceRoutes.length > 0);
  for (const entry of healthy.sourceRoutes) {
    assert.ok(DESCRIPTORS_BY_ID.has(entry.capabilityId), entry.capabilityId);
  }
});

// ===========================================================================
// Round-2 adversarial-review fixes — one appended test per finding.
//
// Every test below was verified RED by surgically reverting exactly one fix in
// `lib/modes/weekly.mjs`, `lib/kernel.mjs` or `lib/local-runtime.mjs`, running only that test
// with `--test-name-pattern`, observing the failure, and restoring the fix.
// ===========================================================================

/** The ten-gate inputs every round-2 eligibility test starts from. */
async function healthyEligibilityInputs(options = {}) {
  const internalEvidence = await collectFor({
    responses: evidenceResponses({ ai: 'all-surfaces-complete' }),
    ...options,
  }).result;
  return {
    internalEvidence,
    merge: (await mergeFor({ internalEvidence })).result,
    trace: MERGE.traces.clean,
    claimSupport: MERGE.claimSupport.eligible,
    privacyScan: { passed: true },
    verification: { passed: true },
    requiredWindows: REQUIRED_WINDOWS,
    expected: EXPECTED_IDENTITIES,
    // Decision D11: the run's SEALED frozen inputs are the ONLY thing that can anchor an
    // identity, so a healthy base must seal the identities it is about to claim. Every caller
    // that needs an UNSEALED base overrides this key explicitly.
    frozenInputs: r3FrozenInputs(),
    // Finding R7-C1: and sealing them is not enough — the host must also state that IT
    // authenticated this exact anchor block, because `analyzer.freezeInputs` is injected and an
    // anchor block that merely arrives is a claim. A healthy base is genuinely provenanced.
    // Every caller that needs an UNPROVENANCED base overrides or drops this key explicitly.
    frozenInputProvenance: anchorProvenanceFor(r3FrozenInputs()),
  };
}

// ===========================================================================
// 33 — R2-C1
// ===========================================================================

test('the internal rail cannot change a public only terminal status', async () => {
  // The SHIPPED verifier's contract (`lib/local-runtime.mjs`): it passes only on the CLAMPED
  // publication input, because the two INTERNAL_LIMITATIONS are injected by
  // `enforcePublicOnlyPublication`. Running it a second time mid-`compiling`, on the PRE-clamp
  // analyzer output, therefore FAILED — and a verifier failure is a quarantine discriminator.
  const compile = async () => ({
    status: 'complete_partial',
    coverage: { state: 'complete_partial', scope: 'public_comparable_subset', limitations: [] },
    diff: { state: 'FIRST_BASELINE', transitions: [] },
    findings: [],
  });
  const offlineProof = makeProofIndex({
    receiptOverrides: Object.fromEntries(
      APPLICABLE_CAPABILITIES.map((id) => [id, { proofClass: 'offline_contract' }]),
    ),
  });

  const runWith = async (rail) => withProjectRoot(async (projectRoot) => {
    const runId = `run_r2c1_${rail ? 'on' : 'off'}`;
    const verifierInputs = [];
    const kernel = makeKernel({
      runId,
      analyzer: { compile },
      adapters: rail
        ? { collectInternal: async () => makeAdapter({ capabilityProofIndex: offlineProof }) }
        : {},
      verifier: async ({ compiled }) => {
        verifierInputs.push(compiled);
        const limitations = new Set(compiled?.coverage?.limitations ?? []);
        return {
          result: compiled?.status === 'complete_partial'
            && limitations.has('INTERNAL_WORKFLOW_DEFINITION_MISSING')
            && limitations.has('INTERNAL_WORKFLOW_RUNTIME_MISSING')
            ? 'pass'
            : 'fail',
        };
      },
    });
    let status;
    try {
      status = (await kernel.start(startArgs(projectRoot))).status;
    } catch (error) {
      status = `THREW:${error?.code ?? error?.message}`;
    }
    const state = openState({ projectRoot, locationId: LOCATION_ID });
    let persisted;
    try {
      persisted = state.getRun(runId).status;
    } finally {
      state.close();
    }
    return { status, persisted, verifierCalls: verifierInputs.length };
  });

  const off = await runWith(false);
  const on = await runWith(true);

  assert.equal(off.status, 'complete_partial', 'the public-only control did not complete');
  assert.equal(
    on.status,
    off.status,
    'switching the internal rail ON changed a public-only run\'s terminal status',
  );
  assert.equal(on.persisted, off.persisted, 'the PERSISTED run status diverged with the rail on');
  assert.equal(on.persisted, 'complete_partial');
  assert.equal(
    on.verifierCalls,
    off.verifierCalls,
    'the rail invoked the verifier a second time, outside the trusted publication gate',
  );
});

// ===========================================================================
// 34 — R2-C2 (the gate half)
// ===========================================================================

test('gate three reconciles the sealed roster against the workflows actually read', async () => {
  const evaluateFullEligibility = requireExport('evaluateFullEligibility');
  const base = await healthyEligibilityInputs();
  const control = await evaluateFullEligibility(base);
  assert.equal(control.status, 'complete_full', 'the control run is not Full');

  const rosterIds = [...base.internalEvidence.workflowRoster.workflowIds];
  assert.ok(rosterIds.length >= 2, 'the fixture roster is too small to under-read');
  const unread = rosterIds[rosterIds.length - 1];

  // 1. The adapter's "excluded by the caller's applicability" shape: sealed on the roster,
  //    never read, yet self-declared `complete: true`.
  const excluded = structuredClone(base.internalEvidence);
  excluded.workflows = excluded.workflows.map((entry) => (entry.workflowId === unread
    ? {
        ...entry,
        applicable: false,
        complete: true,
        definition: null,
        runtime: null,
        configurationBinding: null,
        incompleteReason: null,
      }
    : entry));

  // 2. The same roster member simply absent from the workflow records.
  const absent = structuredClone(base.internalEvidence);
  absent.workflows = absent.workflows.filter((entry) => entry.workflowId !== unread);

  for (const [label, internalEvidence] of [
    ['excluded roster member', excluded],
    ['absent roster member', absent],
  ]) {
    const decision = await evaluateFullEligibility({
      ...base,
      internalEvidence,
      merge: (await mergeFor({ internalEvidence })).result,
    });
    assert.notEqual(
      decision.status,
      'complete_full',
      `${label}: an unread roster workflow was counted as covered`,
    );
    assert.equal(
      gateFor(decision, 'workflow_roster_and_coverage').passed,
      false,
      label,
    );
    for (const code of ['INTERNAL_WORKFLOW_DEFINITION_MISSING', 'INTERNAL_WORKFLOW_RUNTIME_MISSING']) {
      assert.ok(limitationCodes(decision).includes(code), `${label}: ${code} unnamed`);
    }
  }
});

// ===========================================================================
// 35 — R2-C3
// ===========================================================================

test('a page declaring neither count fails the anti oracle recount', async () => {
  const evaluateFullEligibility = requireExport('evaluateFullEligibility');
  const base = await healthyEligibilityInputs();

  const cases = [
    ['declares neither count', 'PUBLIC_EVIDENCE_RECONCILIATION_FAILED', (envelope) => {
      delete envelope.page.reportedCount;
      delete envelope.page.collectedCount;
    }],
    ['declares neither count over zero rows', 'PUBLIC_EVIDENCE_RECONCILIATION_FAILED', (envelope) => {
      envelope.items = [];
      delete envelope.page.reportedCount;
      delete envelope.page.collectedCount;
    }],
    ['a next cursor while claiming complete', 'PUBLIC_EVIDENCE_INCOMPLETE', (envelope) => {
      envelope.page.nextCursor = 'cursor-2';
    }],
  ];
  for (const [label, expectedCode, mutate] of cases) {
    const envelope = publicEnvelope('baseline');
    mutate(envelope);
    const merged = (await mergeFor({
      internalEvidence: base.internalEvidence,
      publicEvidence: [envelope],
    })).result;
    assert.ok(limitationCodes(merged).includes(expectedCode), `${label}: ${expectedCode} unnamed`);
    assert.notEqual(merged.status, 'COMPLETE', label);
    const decision = await evaluateFullEligibility({ ...base, merge: merged });
    assert.notEqual(decision.status, 'complete_full', `${label} published Full`);
    assert.equal(gateFor(decision, 'reconciliation').passed, false, label);
  }

  // The honest page still reconciles, so the recount did not simply start refusing everything.
  assert.equal((await mergeFor({ internalEvidence: base.internalEvidence })).result.status, 'COMPLETE');
});

// ===========================================================================
// 36 — R2-I1
// ===========================================================================

test('resume answers the internal phase from its checkpoint before collecting', async () => {
  await withProjectRoot(async (projectRoot) => {
    const runId = 'run_r2i1_resume';
    const offlineProof = makeProofIndex({
      receiptOverrides: Object.fromEntries(
        APPLICABLE_CAPABILITIES.map((id) => [id, { proofClass: 'offline_contract' }]),
      ),
    });
    let adapterBuilds = 0;
    const adapters = {
      collectInternal: async () => {
        adapterBuilds += 1;
        // The credential lapses after the first collection — D5's 300 s threshold makes this
        // the NORMAL case on any resume, not an edge case.
        return adapterBuilds === 1
          ? makeAdapter({ capabilityProofIndex: offlineProof })
          : {
              collectAuditEvidence: async () => ({
                checkpoint: {
                  schemaVersion: '1.0.0',
                  phase: 'awaiting_internal_auth',
                  reason: 'INTERNAL_AUDIT_AUTH_REQUIRED',
                },
              }),
            };
      },
    };

    // Interrupt immediately AFTER the internal evidence is durably checkpointed.
    await assert.rejects(() => makeKernel({
      runId,
      adapters,
      faultInjector: async ({ phase }) => {
        if (phase === 'collecting_internal') throw new Error('interrupted after collecting_internal');
      },
    }).start(startArgs(projectRoot)));
    assert.equal(adapterBuilds, 1);

    const state = openState({ projectRoot, locationId: LOCATION_ID });
    try {
      assert.ok(
        state.getCheckpoint({ runId, phase: 'collecting_internal' }),
        'the internal evidence was never checkpointed',
      );
    } finally {
      state.close();
    }

    const resumed = await makeKernel({ runId, adapters }).resume({
      projectRoot,
      locationId: LOCATION_ID,
      runId,
      vaultKeyReference: 'opaque-ref',
    });
    assert.equal(
      resumed.status,
      'complete_partial',
      'a run with durable internal evidence was thrown back to awaiting_internal_auth',
    );
    assert.equal(
      adapterBuilds,
      1,
      'the adapter was re-invoked on resume even though the checkpoint had the answer',
    );
  });
});

// ===========================================================================
// 37 — R2-I2
// ===========================================================================

test('a task 10 normalizing checkpoint resumes with the internal rail on', async () => {
  await withProjectRoot(async (projectRoot) => {
    const runId = 'run_r2i2_resume';
    const offlineProof = makeProofIndex({
      receiptOverrides: Object.fromEntries(
        APPLICABLE_CAPABILITIES.map((id) => [id, { proofClass: 'offline_contract' }]),
      ),
    });

    // A run checkpointed by a kernel with NO internal rail — the approved Task 10 input shape.
    await assert.rejects(() => makeKernel({
      runId,
      faultInjector: async ({ phase }) => {
        if (phase === 'normalizing') throw new Error('interrupted after normalizing');
      },
    }).start(startArgs(projectRoot)));

    const state = openState({ projectRoot, locationId: LOCATION_ID });
    try {
      assert.ok(state.getCheckpoint({ runId, phase: 'normalizing' }), 'nothing was checkpointed');
    } finally {
      state.close();
    }

    // Resumed by the deployment this task exists to enable: the SAME run, a kernel WITH a rail.
    const resumed = await makeKernel({
      runId,
      adapters: {
        collectInternal: async () => makeAdapter({ capabilityProofIndex: offlineProof }),
      },
    }).resume({
      projectRoot,
      locationId: LOCATION_ID,
      runId,
      vaultKeyReference: 'opaque-ref',
    });
    assert.notEqual(resumed.status, 'quarantined', 'enabling the rail quarantined an existing run');
    assert.equal(resumed.status, 'complete_partial');

    const after = openState({ projectRoot, locationId: LOCATION_ID });
    try {
      assert.equal(after.getRun(runId).status, 'complete_partial');
    } finally {
      after.close();
    }
  });
});

// ===========================================================================
// 38 — R2-I3
// ===========================================================================

test('provenance identity is total under envelope permutation', async () => {
  const internal = await collectFor().result;

  const permutationCase = async (label, build) => {
    const [first, second] = build();
    const forward = (await mergeFor({
      internalEvidence: internal,
      publicEvidence: [first, second],
    })).result;
    const reversed = (await mergeFor({
      internalEvidence: internal,
      publicEvidence: [second, first],
    })).result;
    assert.equal(
      mergeIdentity(reversed),
      mergeIdentity(forward),
      `${label}: the merge is not byte-identical under envelope permutation`,
    );
    const stamps = entityFor(forward, 'workflow', 'WF1').provenance
      .filter((entry) => entry.rail === 'public')
      .map((entry) => entry.capturedAt)
      .sort();
    assert.deepEqual(
      stamps,
      ['2026-07-20T00:04:00.000Z', '2026-07-20T00:05:00.000Z'],
      `${label}: one envelope's capturedAt was silently discarded`,
    );
  };

  await permutationCase('shared operationId', () => {
    const first = publicEnvelope('baseline', { operationId: 'shared-operation' });
    const second = publicEnvelope('baseline', { operationId: 'shared-operation' });
    second.capturedAt = '2026-07-20T00:04:00.000Z';
    second.appliedWindow = { ...second.appliedWindow, to: '2026-07-19T23:59:00.000Z' };
    return [first, second];
  });

  await permutationCase('absent operationId', () => {
    const first = publicEnvelope('baseline');
    const second = publicEnvelope('baseline');
    delete first.operationId;
    delete second.operationId;
    second.capturedAt = '2026-07-20T00:04:00.000Z';
    second.appliedWindow = { ...second.appliedWindow, to: '2026-07-19T23:59:00.000Z' };
    return [first, second];
  });
});

// ===========================================================================
// 39 — R2-I4
// ===========================================================================

test('an unvalidatable eligibility decision fails closed instead of publishing', async () => {
  const enforcePublicOnlyPublication = requireExport('enforcePublicOnlyPublication');
  const evaluateFullEligibility = requireExport('evaluateFullEligibility');
  const publishable = {
    coverage: { state: 'complete_full', limitations: [] },
    diff: { state: 'COMPARABLE', transitions: [] },
    findings: [{ id: 'F1', scope: 'account_wide' }],
    solutionPacks: [{ id: 'SP1', findingId: 'F1' }],
    latestFull: null,
  };

  // The exact shape the sibling used to hand over: quarantined, ineligible, ZERO failed gates.
  const inconsistent = {
    status: 'quarantined',
    eligible: false,
    gates: FULL_ELIGIBILITY_GATES.map((id) => ({ id, passed: true })),
    failedGates: [],
  };
  assert.throws(
    () => enforcePublicOnlyPublication(structuredClone(publishable), {
      fullEligibility: inconsistent,
    }),
    /AUDIT_INTEGRITY_FAILURE/u,
    'a quarantine decision the guard could not validate still published',
  );

  // And the sibling can no longer MINT that shape: identity and location mismatch are real
  // failed gates, so every quarantine decision is internally consistent.
  const base = await healthyEligibilityInputs();
  const drifted = await evaluateFullEligibility({
    ...base,
    internalEvidence: {
      ...structuredClone(base.internalEvidence),
      capabilityManifestHash: sha256Of('a manifest this run never sealed'),
    },
  });
  assert.equal(drifted.status, 'quarantined');
  assert.notDeepEqual(drifted.failedGates, [], 'an identity mismatch failed no gate');
  assert.equal(gateFor(drifted, 'live_runtime_receipts').passed, false);

  const misplaced = await evaluateFullEligibility({
    ...base,
    internalEvidence: { ...structuredClone(base.internalEvidence), boundLocationId: 'L2' },
  });
  assert.equal(misplaced.status, 'quarantined');
  assert.notDeepEqual(misplaced.failedGates, [], 'a location mismatch failed no gate');
  assert.equal(gateFor(misplaced, 'reconciliation').passed, false);

  // Round-tripped through the guard, a real quarantine decision publishes nothing.
  for (const decision of [drifted, misplaced]) {
    let output = null;
    try {
      output = enforcePublicOnlyPublication(structuredClone(publishable), {
        fullEligibility: decision,
      });
    } catch (error) {
      assert.match(String(error.code ?? error.message), CODE_PATTERN);
      continue;
    }
    assert.notEqual(output.status, 'complete_full');
    assert.deepEqual(output.findings, []);
    assert.deepEqual(output.solutionPacks, []);
  }
});

// ===========================================================================
// 40 — R2-M1
// ===========================================================================

test('a run bound decision cannot be consumed without its run', async () => {
  const enforcePublicOnlyPublication = requireExport('enforcePublicOnlyPublication');
  const evaluateFullEligibility = requireExport('evaluateFullEligibility');
  const publishable = {
    coverage: { state: 'complete_full', limitations: [] },
    diff: { state: 'COMPARABLE', transitions: [] },
    findings: [{ id: 'F1', scope: 'account_wide' }],
    latestFull: null,
  };
  const run = { runId: 'run_r2m1', frozenInputsHash: 'c'.repeat(64) };
  const bound = await evaluateFullEligibility({ ...(await healthyEligibilityInputs()), run });
  assert.equal(bound.status, 'complete_full');
  assert.equal(bound.runId, run.runId);

  // Control: with its own run stated, the decision lifts the clamp.
  assert.equal(
    enforcePublicOnlyPublication(structuredClone(publishable), {
      fullEligibility: bound,
      expectedRun: run,
    }).status,
    'complete_full',
  );

  // Omitting `expectedRun` may no longer DISABLE the binding a decision carries.
  for (const [label, options] of [
    ['no expectedRun at all', { fullEligibility: bound }],
    ['expectedRun null', { fullEligibility: bound, expectedRun: null }],
    ['expectedRun undefined', { fullEligibility: bound, expectedRun: undefined }],
  ]) {
    let status = null;
    try {
      status = enforcePublicOnlyPublication(structuredClone(publishable), options).status;
    } catch (error) {
      assert.match(String(error.code ?? error.message), CODE_PATTERN, label);
      continue;
    }
    assert.notEqual(status, 'complete_full', `${label} consumed a bound decision unbound`);
    assert.equal(status, 'complete_partial', label);
  }
});

// ===========================================================================
// 41 — R2-M2
// ===========================================================================

test('a claim declaring no supporting capability cannot satisfy gate eight', async () => {
  const evaluateFullEligibility = requireExport('evaluateFullEligibility');
  const base = await healthyEligibilityInputs();
  assert.equal((await evaluateFullEligibility(base)).status, 'complete_full');

  const proven = [...APPLICABLE_CAPABILITIES].slice(0, 1);
  for (const [label, claimSupport] of [
    ['no dependency key', [{ claimId: 'C1', support: 'direct_evidence' }]],
    ['empty dependency list', [{ claimId: 'C1', support: 'direct_evidence', dependsOnCapabilityIds: [] }]],
    ['non-string dependencies', [{ claimId: 'C1', support: 'direct_evidence', dependsOnCapabilityIds: [7] }]],
    ['no claim id', [{ support: 'direct_evidence', dependsOnCapabilityIds: proven }]],
    ['a non record among the claims', [...MERGE.claimSupport.eligible, 'C3']],
  ]) {
    const decision = await evaluateFullEligibility({ ...base, claimSupport });
    assert.equal(gateFor(decision, 'claim_support').passed, false, `${label} passed gate 8`);
    assert.notEqual(decision.status, 'complete_full', label);
    assert.equal(decision.status, 'complete_partial', label);
  }
});

// ===========================================================================
// 42 — R2-M3
// ===========================================================================

test('every publishing terminal phase is revision addressable', () => {
  const source = readFileSync(join(HERE, '..', 'lib', 'kernel.mjs'), 'utf8');
  const block = source.match(/const REVISION_PHASES = new Set\(\[([\s\S]*?)\]\);/u);
  assert.ok(block, 'REVISION_PHASES is no longer a literal set');
  const revisionPhases = [...block[1].matchAll(/'([a-z_]+)'/gu)].map(([, name]) => name);
  const kernel = createAuditKernel({
    clock: () => 0,
    idFactory: () => 'run_phase_probe',
    keyResolver: () => ({ encryptionKey: Buffer.alloc(32), pseudonymKey: Buffer.alloc(32) }),
    adapters: {},
    analyzer: { freezeInputs: () => ({}) },
    verifier: async () => ({ result: 'pass' }),
    publisher: async () => ({}),
  });
  for (const terminal of ['complete_partial', 'complete_full']) {
    assert.ok(kernel.phases.includes(terminal), `${terminal} is not a storage phase`);
    assert.ok(
      revisionPhases.includes(terminal),
      `${terminal} would collide on a second revision of the same run`,
    );
  }
});

// ===========================================================================
// 43 — R2-M4
// ===========================================================================

test('the shipped composition root constructs the internal rail from configuration', async () => {
  const { createLocalAuditKernel, localProviderDescriptor } = await import('../lib/local-runtime.mjs');
  const { writeFileSync } = await import('node:fs');
  const localConfig = (internalRail) => ({
    schemaVersion: '1.0.0',
    adapterKind: 'local_fixture',
    providerId: 'provider',
    cutoff: KERNEL_CUTOFF,
    timezone: 'Australia/Sydney',
    // Finding R4-C1: the composition root's "every declared identity must also be SEALED" rule
    // is mandatory rather than opt-out, so this run seals both internal-rail identity digests.
    // Additive only — the run is otherwise byte-identical to the one this test always drove.
    frozenInputs: kernelFrozenInputs({
      capabilityManifestHashes: [MANIFEST_HASH, BUNDLE_HASH],
    }),
    context: { context: 'safe' },
    publicEvidence: { events: [] },
    reviews: [],
    ...(internalRail ? { internalRail } : {}),
  });
  const runLocal = async (internalRail, runId) => withProjectRoot(async (projectRoot) => {
    const providerConfig = localConfig(internalRail);
    // The shipped CLI's own path: a project-file descriptor, exactly as `cli/audit.mjs` builds.
    const providerConfigPath = join(projectRoot, 'provider-config.json');
    writeFileSync(providerConfigPath, `${JSON.stringify(providerConfig)}\n`, { mode: 0o600 });
    const result = await createLocalAuditKernel({ initialRunId: runId }).start({
      mode: 'weekly',
      target: kernelFrozenInputs().target,
      projectRoot,
      cutoff: providerConfig.cutoff,
      providerId: providerConfig.providerId,
      profile: 'client',
      providerConfig,
      providerDescriptor: localProviderDescriptor({
        projectRoot,
        providerConfigPath,
        config: providerConfig,
      }),
      vaultKeyReference: 'test-only:key',
    });
    const state = openState({ projectRoot, locationId: LOCATION_ID });
    try {
      return {
        status: result.status,
        internalCheckpoint: state.getCheckpoint({ runId, phase: 'awaiting_internal_auth' }) !== undefined,
      };
    } finally {
      state.close();
    }
  });

  // Unconfigured: the rail is OFF and the shipped runtime behaves exactly as before.
  const unconfigured = await runLocal(null, 'run_r2m4_off');
  assert.equal(unconfigured.status, 'complete_partial');
  assert.equal(unconfigured.internalCheckpoint, false, 'an unconfigured run built an internal rail');

  // Configured: construction is driven ENTIRELY by the provider configuration. The transport is
  // an offline replay of recorded bodies — no live call, no credential read, no network.
  const configured = await runLocal({
    adapterKind: 'internal_ghl',
    contractVersion: '1.0.0',
    locationId: LOCATION_ID,
    toolProfileHash: TOOL_PROFILE_HASH,
    // Finding R4-C1: stating which manifest and which bundle this rail is running is MANDATORY.
    capabilityManifestHash: MANIFEST_HASH,
    bundleHash: BUNDLE_HASH,
    capabilityProofIndex: makeProofIndex(),
    transport: {
      kind: 'inline_responses',
      toolsList: TOOLS_LIST,
      responses: { auth_status: { ok: false, code: 'INTERNAL_AUDIT_AUTH_REQUIRED' } },
    },
  }, 'run_r2m4_on');
  assert.equal(
    configured.status,
    'awaiting_internal_auth',
    'the shipped composition root never constructed the internal adapter',
  );
  assert.equal(configured.internalCheckpoint, true);
});

// ===========================================================================
// 44 — R2-M5
// ===========================================================================

test('a trace entry with no location binding cannot satisfy the read only gate', async () => {
  const evaluateFullEligibility = requireExport('evaluateFullEligibility');
  const base = await healthyEligibilityInputs();
  assert.equal(gateFor(await evaluateFullEligibility(base), 'read_only_trace').passed, true);

  const clean = structuredClone(MERGE.traces.clean);
  const unbound = [
    ['every entry unbound', clean.map(({ boundLocationId: _dropped, ...rest }) => rest)],
    ['every entry null bound', clean.map((entry) => ({ ...entry, boundLocationId: null }))],
    ['every entry empty bound', clean.map((entry) => ({ ...entry, boundLocationId: '' }))],
    ['one entry unbound', [
      clean[0],
      ...clean.slice(1).map(({ boundLocationId: _dropped, ...rest }) => rest),
    ]],
  ];
  for (const [label, trace] of unbound) {
    const decision = await evaluateFullEligibility({ ...base, trace });
    assert.equal(
      gateFor(decision, 'read_only_trace').passed,
      false,
      `${label} skipped the cross-location check`,
    );
    assert.notEqual(decision.status, 'complete_full', label);
    // Absent binding is UNKNOWN — missing evidence (Partial), not a demonstrated violation.
    assert.equal(decision.status, 'complete_partial', label);
  }

  // A trace that really does name another location still quarantines.
  const crossed = await evaluateFullEligibility({ ...base, trace: MERGE.traces['cross-location'] });
  assert.equal(crossed.status, 'quarantined');
});

// ===========================================================================
// 45 — R2-M1, residual half
// ===========================================================================

test('an unbound eligibility decision can never lift the clamp', async () => {
  const enforcePublicOnlyPublication = requireExport('enforcePublicOnlyPublication');
  const evaluateFullEligibility = requireExport('evaluateFullEligibility');
  const publishable = {
    coverage: { state: 'complete_full', limitations: [] },
    diff: { state: 'COMPARABLE', transitions: [] },
    findings: [{ id: 'F1', scope: 'account_wide', verdict: 'PASS', impact: 12, totalImpact: 100000 }],
    latestFull: null,
  };
  const run = { runId: 'run_m1_residual', frozenInputsHash: 'f'.repeat(64) };
  const other = { runId: 'run_m1_other', frozenInputsHash: '9'.repeat(64) };
  const base = await healthyEligibilityInputs();

  // Control. The ONLY shape that lifts the clamp is a decision that NAMES this run, consumed
  // together with this run. Without this passing the rest of the test proves nothing.
  const bound = await evaluateFullEligibility({ ...base, run });
  assert.equal(bound.status, 'complete_full');
  assert.equal(bound.runId, run.runId);
  assert.equal(bound.frozenInputsHash, run.frozenInputsHash);
  assert.equal(
    enforcePublicOnlyPublication(structuredClone(publishable), {
      fullEligibility: bound,
      expectedRun: run,
    }).status,
    'complete_full',
    'the control decision never lifted the clamp',
  );

  // The sibling cannot mint a HALF binding. A run named without its frozen inputs — or the
  // reverse, or either as an empty string — is retained as NO binding at all, so it lands in
  // the unbound case below instead of half-satisfying the check.
  for (const partial of [
    { runId: run.runId },
    { frozenInputsHash: run.frozenInputsHash },
    { runId: run.runId, frozenInputsHash: '' },
    { runId: '', frozenInputsHash: run.frozenInputsHash },
  ]) {
    const half = await evaluateFullEligibility({ ...base, run: partial });
    assert.equal(half.status, 'complete_full', canonicalJson(partial));
    assert.equal(half.runId, null, canonicalJson(partial));
    assert.equal(half.frozenInputsHash, null, canonicalJson(partial));
  }

  const withoutRunId = structuredClone(bound);
  delete withoutRunId.runId;
  const whollyAbsent = structuredClone(bound);
  delete whollyAbsent.runId;
  delete whollyAbsent.frozenInputsHash;
  const mintedUnbound = await evaluateFullEligibility(base);
  assert.equal(mintedUnbound.status, 'complete_full');
  assert.equal(mintedUnbound.runId, null, 'the unbound mint under test is not unbound');
  const crossBound = await evaluateFullEligibility({ ...base, run: other });

  // Every unbound or cross-bound decision. Each is the CONTROL with only its binding changed,
  // so the sole difference from a publishing Full run is the run binding.
  const cases = [
    ['runId null', { fullEligibility: { ...structuredClone(bound), runId: null }, expectedRun: run }],
    ['runId null, no expectedRun', { fullEligibility: { ...structuredClone(bound), runId: null } }],
    ['runId absent', { fullEligibility: withoutRunId, expectedRun: run }],
    ['runId empty string', { fullEligibility: { ...structuredClone(bound), runId: '' } }],
    ['frozenInputsHash null', {
      fullEligibility: { ...structuredClone(bound), frozenInputsHash: null },
      expectedRun: run,
    }],
    ['frozenInputsHash null, no expectedRun', {
      fullEligibility: { ...structuredClone(bound), frozenInputsHash: null },
    }],
    ['frozenInputsHash empty string', {
      fullEligibility: { ...structuredClone(bound), frozenInputsHash: '' },
    }],
    ['both null', {
      fullEligibility: { ...structuredClone(bound), runId: null, frozenInputsHash: null },
      expectedRun: run,
    }],
    ['both null, no expectedRun', {
      fullEligibility: { ...structuredClone(bound), runId: null, frozenInputsHash: null },
    }],
    ['both null, expectedRun null', {
      fullEligibility: { ...structuredClone(bound), runId: null, frozenInputsHash: null },
      expectedRun: null,
    }],
    ['both absent, no expectedRun', { fullEligibility: whollyAbsent }],
    ['a wholly unbound MINTED decision, no expectedRun', { fullEligibility: mintedUnbound }],
    ['a wholly unbound MINTED decision, expectedRun stated', {
      fullEligibility: mintedUnbound,
      expectedRun: run,
    }],
    ['bound to a DIFFERENT run', { fullEligibility: crossBound, expectedRun: run }],
    ['bound to a run, expectedRun absent', { fullEligibility: bound }],
  ];
  for (const [label, options] of cases) {
    let output = null;
    try {
      output = enforcePublicOnlyPublication(structuredClone(publishable), options);
    } catch (error) {
      assert.match(String(error.code ?? error.message), /^AUDIT_INTEGRITY_FAILURE/u, label);
      continue;
    }
    assert.notEqual(output.status, 'complete_full', `${label} lifted the clamp`);
    assert.equal(output.status, 'complete_partial', label);
    // The clamp was really applied, not merely the label.
    assert.equal(output.findings[0].scope, 'public_comparable_subset', label);
    assert.equal(output.findings[0].verdict, 'UNKNOWN', label);
    assert.equal(output.findings[0].totalImpact, null, label);
    for (const code of ['INTERNAL_WORKFLOW_DEFINITION_MISSING', 'INTERNAL_WORKFLOW_RUNTIME_MISSING']) {
      assert.ok(output.coverage.limitations.includes(code), `${label}: ${code}`);
    }
  }

  // The trusted-publication carrier is closed to the same inputs: an unbound Full decision can
  // never reach the Full substitutes, so a Full-labelled trusted payload fails closed.
  const trusted = {
    manifestInput: { schemaVersion: '1.0.0', runId: run.runId, status: 'complete_full' },
    projections: { memory: [] },
    payloadArtifacts: {
      'coverage.json': { state: 'complete_full', limitations: [] },
      'metrics-and-findings.json': { sealedInputs: { run: { status: 'complete_full' } }, findings: [] },
      'REPORT.md': '# Account-wide audit\n',
    },
  };
  for (const [label, options] of [
    ['unbound minted decision', { fullEligibility: mintedUnbound, expectedRun: run }],
    ['both null', {
      fullEligibility: { ...structuredClone(bound), runId: null, frozenInputsHash: null },
      expectedRun: run,
    }],
  ]) {
    assert.throws(
      () => enforcePublicOnlyPublication(structuredClone(trusted), options),
      /AUDIT_INTEGRITY_FAILURE/u,
      `${label} published a Full trusted payload unbound`,
    );
  }

  // Guard against over-tightening: an unbound decision may still SUPPRESS. Refusing to publish
  // is never the unsafe direction, and the Task 10 non-publishing path depends on it.
  const quarantined = await evaluateFullEligibility({
    ...base,
    internalEvidence: { ...structuredClone(base.internalEvidence), boundLocationId: 'L2' },
  });
  assert.equal(quarantined.status, 'quarantined');
  assert.equal(quarantined.runId, null);
  const suppressed = enforcePublicOnlyPublication(
    { ...structuredClone(publishable), solutionPacks: [{ id: 'SP1', findingId: 'F1' }] },
    { fullEligibility: quarantined },
  );
  assert.equal(suppressed.status, 'quarantined');
  assert.deepEqual(suppressed.findings, []);
  assert.deepEqual(suppressed.solutionPacks, []);
});

// ===========================================================================
// 50 — R3-1 (privacy, FOURTH attempt at this class): the retention grammars
// were still a GUESS. `OPAQUE_ID`/`BOUNDED_TOKEN`/`PROVENANCE_TOKEN` each
// admitted 64 characters of `[A-Za-z0-9_-]`, which is a legible private
// sentence, and the demonstrated payloads reached a HEALTHY `complete: true`
// result. The fix binds every retained value to the SERVER'S OWN vocabulary
// (an enum where the server has a closed set) and PSEUDONYMISES the contact
// ledgers instead of echoing them.
// ===========================================================================

const R3_PAYLOADS = Object.freeze({
  // --- the reviewer's five, verbatim ---------------------------------------
  statusSentence: 'jane-doe-cancelled-botox-she-said-she-is-pregnant',
  bareMsisdn: '447911123456',
  sourceSentence: 'patient_jane_doe_hiv_positive_do_not_call_work',
  namedMsisdnId: 'jane-doe-447911123456',
  scopeSentence: 'every_contact_of_jane_doe_since_march',
  // --- five more of my own, one per encoding class -------------------------
  // 1. a phone number in a THIRD encoding (dotted, no `+`, no space)
  dottedPhone: '44.7911.123456',
  // 2. a person's name, separator-joined, inside the old 64-char budget
  personName: 'Jane-Doe-Smith',
  // 3. a date of birth, snake-joined so `PROVENANCE_TOKEN` used to accept it
  dateOfBirth: 'dob_1984_03_11',
  // 4. a short credential
  shortCredential: 'pw-hunter2-Tuesday',
  // 5. a private sentence about a named patient
  privateSentence: 'she_said_she_is_pregnant_do_not_call',
});

const R3_NAMES = Object.freeze(Object.keys(R3_PAYLOADS));

function assertNoR3Payload(value, label, only = R3_NAMES) {
  const encoded = JSON.stringify(value ?? null);
  for (const name of only) {
    assert.equal(
      encoded.includes(R3_PAYLOADS[name]),
      false,
      `${name} ("${R3_PAYLOADS[name]}") escaped into ${label}`,
    );
  }
}

const IS_PSEUDONYM = /^psn_[a-f0-9]{32}$/u;

test('retained values are bound to the servers vocabularies not to a wide grammar', async () => {
  const scenario = RUNTIME.complete;

  // Every payload is planted under a key the projection deliberately RETAINS, in both an ID
  // position and a TOKEN position, so nothing here is a special case of the reported five.
  const canariedRuntime = {
    filters: {
      // the reviewer's payload 2 — `filters` is a request echo, so this is a pure lie
      contactId: R3_PAYLOADS.bareMsisdn,
      eventTypes: [R3_PAYLOADS.privateSentence, R3_PAYLOADS.personName],
      stepIds: ['S1', R3_PAYLOADS.dateOfBirth],
    },
    enrollments: {
      ...scenario.enrollments,
      // the reviewer's payload 4, plus a dotted phone and a credential
      rows: [
        { _id: R3_PAYLOADS.bareMsisdn, createdAt: '2026-07-14T09:00:00.000Z' },
      ],
    },
    enrollmentTotals: {
      total: 12,
      finished: 9,
      // the reviewer's payloads 3 and (scope) 5
      source: R3_PAYLOADS.sourceSentence,
      scope: R3_PAYLOADS.scopeSentence,
    },
    stepRosters: scenario.stepRosters.map((roster) => ({
      ...roster,
      // the reviewer's payload 5
      contacts: [{ id: R3_PAYLOADS.namedMsisdnId }],
    })),
    runtimeEvents: scenario.runtimeEvents.map((event) => ({
      ...event,
      timestampField: R3_PAYLOADS.privateSentence,
      event: {
        ...event.event,
        eventType: R3_PAYLOADS.personName,
        status: R3_PAYLOADS.shortCredential,
        outcome: R3_PAYLOADS.dateOfBirth,
        contactId: R3_PAYLOADS.dottedPhone,
      },
    })),
    appliedWindow: {
      fromDate: RUNTIME.window.fromDate - RUNTIME.window.expansionMs,
      toDate: RUNTIME.window.toDate,
      queryBoundaries: R3_PAYLOADS.privateSentence,
      analyticalFilter: '[)',
      expansionMs: RUNTIME.window.expansionMs,
    },
  };

  const { result } = collectFor({
    responses: evidenceResponses({
      rosterOver: {
        workflows: [
          // the reviewer's payload 1
          { id: 'WF1', name: '01 Meta Lead Intake', status: R3_PAYLOADS.statusSentence, version: 4 },
          { id: 'WF2', name: '02 Nurture', status: R3_PAYLOADS.personName, version: 2 },
        ],
      },
      runtimeByWorkflow: { WF1: 'complete', WF2: 'complete-no-step-rosters' },
      runtimeOptions: { WF1: { over: canariedRuntime } },
    }),
  }, { stepRosterRequests: { WF1: ['S1'] } });
  const resolved = await result;

  // The finding is about the HEALTHY path. The run must stay complete AND carry none of it.
  assert.equal(resolved.complete, true, 'the canaried run stopped being healthy');
  assertNoR3Payload(resolved, 'a healthy complete result');
  assertNoR3Payload(resolved.checkpoint, 'the checkpoint');
  assertNoR3Payload(resolved.trace, 'the trace');
  assertNoR3Payload(resolved.capabilityCoverage, 'capabilityCoverage');
  assertNoR3Payload(resolved.sourceRoutes, 'the run source routes');

  // It also has to stay out of the publication input and out of the host's merge product.
  assertNoR3Payload(
    { status: 'complete_partial', internalEvidence: resolved, checkpoint: resolved.checkpoint },
    'the publication input',
  );
  const merged = await mergeFor({ internalEvidence: resolved });
  assertNoR3Payload(merged.result, 'the merge product');

  // Dropped, not coerced into some other private shape.
  const record = workflowRecord(resolved, 'WF1');
  assert.equal(record.status, null, 'a sentence survived as a workflow status');
  assert.equal(
    workflowRecord(resolved, 'WF2').status,
    null,
    'a name survived as a workflow status',
  );
  const runtime = record.runtime;
  assert.equal(runtime.filters.contactId, null, 'a request echo carried a contact identifier');
  assert.deepEqual(runtime.filters.eventTypes, [], 'a request echo carried unrequested filters');
  assert.deepEqual(runtime.filters.stepIds, ['S1'], 'the step filter is not the requested set');
  assert.equal(Object.hasOwn(runtime.enrollmentTotals, 'source'), false);
  assert.equal(Object.hasOwn(runtime.enrollmentTotals, 'scope'), false);
  assert.equal(Object.hasOwn(runtime.appliedWindow, 'queryBoundaries'), false);
  assert.equal(runtime.events[0].timestampField, null, 'a sentence survived as a timestamp field');
  for (const key of ['eventType', 'status', 'outcome', 'contactId']) {
    assert.equal(
      Object.hasOwn(runtime.events[0].event, key),
      false,
      `${key} retained an out-of-vocabulary value`,
    );
  }

  // The two contact LEDGERS are pseudonymised rather than echoed, and the arithmetic the
  // audit actually consumes still survives.
  assert.equal(runtime.enrollments.rows.length, 1);
  assert.match(runtime.enrollments.rows[0]._id, IS_PSEUDONYM, 'an enrollment row id was echoed');
  assert.equal(runtime.enrollments.rows[0].createdAt, '2026-07-14T09:00:00.000Z');
  assert.equal(runtime.stepRosters[0].contacts.length, 1);
  assert.match(runtime.stepRosters[0].contacts[0].id, IS_PSEUDONYM, 'a roster contact id was echoed');
  assert.equal(runtime.enrollmentTotals.total, 12);
  assert.equal(runtime.stepRosters[0].total, 1);

  // A pseudonym is STABLE, which is the whole reason it can replace the raw id: the same
  // contact seen twice in one run still joins to itself.
  const twice = await collectFor({
    responses: evidenceResponses({
      runtimeByWorkflow: { WF1: 'complete', WF2: 'complete-no-step-rosters' },
      runtimeOptions: {
        WF1: {
          over: {
            ...canariedRuntime,
            stepRosters: scenario.stepRosters.map((roster) => ({
              ...roster,
              contacts: [{ id: R3_PAYLOADS.namedMsisdnId }],
            })),
          },
        },
      },
    }),
  }, { stepRosterRequests: { WF1: ['S1'] } }).result;
  const sameRun = workflowRecord(twice, 'WF1').runtime;
  assert.equal(
    sameRun.stepRosters[0].contacts[0].id,
    sameRun.stepRosters[0].contacts[0].id,
    'a pseudonym is not stable within its own run',
  );

  // --- the bounded door leaks the same way ---------------------------------
  const page = await makeAdapter({
    responses: evidenceResponses({
      rosterOver: {
        workflows: [
          { id: 'WF1', name: '01 Meta Lead Intake', status: R3_PAYLOADS.statusSentence, version: 4 },
          { id: 'WF2', name: '02 Nurture', status: R3_PAYLOADS.personName, version: 2 },
        ],
      },
    }),
  }).collect({ capability: { capabilityId: 'workflow_roster_list' }, window: WINDOW });
  assert.equal(page.page.complete, true, 'the bounded collect stopped being healthy');
  assertNoR3Payload(page, 'the bounded collection envelope');
  assertNoR3Payload(page.items, "collect()'s items");
  for (const item of page.items) assert.equal(item.status, null);

  // --- the roster terminal reason is the servers ONE emitted value ----------
  for (const payload of [R3_PAYLOADS.sourceSentence, R3_PAYLOADS.privateSentence, 'roster_walked_out']) {
    const proseTerminal = await collectFor({
      responses: evidenceResponses({ rosterOver: { terminalReason: payload } }),
    }).result;
    assert.equal(proseTerminal.complete, false, 'an out-of-vocabulary terminal reason sealed the roster');
    assert.notEqual(proseTerminal.workflowRoster.terminalReason, payload);
    assert.equal(JSON.stringify(proseTerminal).includes(payload), false, payload);
  }
});

// ===========================================================================
// 51 — R3-2: `sourceRoutes[].host` / `.appliedPath` are read off the MANIFEST,
// which the brief declares UNTRUSTED, and were retained on `isNonEmptyString`
// alone. Both are closed vocabularies in the real manifest.
// ===========================================================================

const R3_ROUTE_CANARIES = Object.freeze({
  host: 'https://exfil.example.com',
  path: '/PCANARY/Users/uxie/.grom-factory.json?token=SECRET',
});

test('a poisoned manifest cannot put a path or a host into a source route', async () => {
  const target = 'workflow_roster_list';
  const poisoned = reselfHashed({
    ...MANIFEST,
    capabilities: MANIFEST.capabilities.map((row) => (row.capabilityId === target
      ? { ...row, host: R3_ROUTE_CANARIES.host, normalizedPath: R3_ROUTE_CANARIES.path }
      : row)),
  });
  const poisonedDescriptor = (() => {
    const row = poisoned.capabilities.find((entry) => entry.capabilityId === target);
    const { tool: _tool, ...descriptor } = row;
    return descriptor;
  })();
  const attestation = makeAttestation({ capabilityManifestHash: sha256Of(poisoned) });

  const resolved = await collectFor({
    capabilityProofIndex: makeProofIndex({
      manifest: poisoned,
      attestation,
      receiptOverrides: {
        [target]: { capabilityDescriptorHash: sha256Of(poisonedDescriptor) },
      },
    }),
  }).result;

  for (const canary of Object.values(R3_ROUTE_CANARIES)) {
    assert.equal(
      JSON.stringify(resolved).includes(canary),
      false,
      `a poisoned manifest value reached the result: ${canary}`,
    );
    assert.equal(JSON.stringify(resolved.checkpoint).includes(canary), false, canary);
  }
  const poisonedRoutes = resolved.sourceRoutes.filter((row) => row.capabilityId === target);
  assert.ok(poisonedRoutes.length > 0, 'the roster route was never recorded');
  for (const row of poisonedRoutes) {
    assert.equal(row.host, null, 'a poisoned host was retained');
    assert.equal(row.appliedPath, null, 'a poisoned path was retained');
  }
  // The honest descriptors around it still project normally.
  for (const row of resolved.sourceRoutes.filter((entry) => entry.capabilityId !== target)) {
    if (row.capabilityId === null) continue;
    assert.ok(['backend', 'services'].includes(row.host), row.capabilityId);
    assert.equal(row.appliedPath, DESCRIPTORS_BY_ID.get(row.capabilityId).normalizedPath);
  }
});

// ===========================================================================
// 52 — R3-3: `capabilityCoverage` map KEYS were config-controlled free text
// filtered only by a token grammar. `finish()` is already careful that only a
// SEALED id may become a key for wire-sourced ids; config must be consistent.
// ===========================================================================

test('a declared capability id is never a coverage key unless it is sealed', async () => {
  const freeText = 'workflow_jane_doe_is_pregnant_do_not_call';
  const declared = [...APPLICABLE_CAPABILITIES, freeText, 'workflow_time_travel'];

  for (const capabilityProofIndex of [makeProofIndex(), null]) {
    const label = capabilityProofIndex === null ? 'with no manifest' : 'with a sealed manifest';
    const resolved = await collectFor({ capabilityProofIndex }, {
      applicability: { capabilityIds: declared },
    }).result;

    const keys = Object.keys(resolved.capabilityCoverage);
    assert.equal(keys.includes(freeText), false, `free text became a coverage key ${label}`);
    assert.equal(
      keys.includes('workflow_time_travel'),
      false,
      `an unsealed id became a coverage key ${label}`,
    );
    assert.equal(
      JSON.stringify(resolved).includes(freeText),
      false,
      `free text was echoed somewhere else ${label}`,
    );
    assert.equal(JSON.stringify(resolved.checkpoint).includes(freeText), false, label);
    // Never silently: an unsealed declaration is reported and fails the run closed.
    assert.equal(resolved.complete, false, `an unsealed declaration published complete ${label}`);
    assert.ok(
      hasCode(resolved, /INTERNAL_AUDIT_CAPABILITY_UNPROVEN/u),
      `no capability code was raised ${label}`,
    );
    // The sealed ids the caller honestly declared are untouched.
    assert.ok(keys.includes('workflow_roster_list'), `a sealed declaration was dropped ${label}`);
  }
});

// ===========================================================================
// 53 — `definitionLocationBinding` was the LAST id reader not on the server's
// own `idOf` vocabulary: it read `workflow._id ?? workflow.id` with no
// `{$oid}` unwrap, so a live export whose id arrives BSON-wrapped or numeric
// could never bind, and the binding failed closed for a reason that has
// nothing to do with the location.
// ===========================================================================

test('definition identity binding uses the servers own id vocabulary', async () => {
  const base = DEFINITIONS.WF1;
  const shapes = [
    ['bson wrapped', { $oid: 'WF1' }, 'WF1'],
    ['numeric', 7, '7'],
    ['numeric string', '7', '7'],
  ];

  for (const [label, rawId, workflowId] of shapes) {
    const workflow = { ...base.workflow, _id: rawId };
    const triple = { workflow, triggers: base.triggers, stickyNotes: base.stickyNotes };
    // The definition composite publishes BARE hex for definition hashes.
    const canonicalHash = sha256Of(triple).slice('sha256:'.length);
    const definitionOver = {
      workflowDefinition: {
        ...base,
        workflow,
        hashAlgorithm: 'sha256',
        canonicalHash,
        validity: {
          effectiveFrom: null,
          effectiveTo: null,
          source: null,
          provenEffectiveInterval: false,
          appliesToRequestedWindow: 'unproven',
        },
      },
    };

    const resolved = await collectFor({
      responses: evidenceResponses({
        rosterOver: {
          workflows: [
            { _id: rawId, name: '01 Meta Lead Intake', status: 'published', version: 4 },
            { id: 'WF2', name: '02 Nurture', status: 'published', version: 2 },
          ],
        },
        exportByWorkflow: { [workflowId]: okBody(triple) },
        runtimeByWorkflow: { [workflowId]: 'complete-no-step-rosters', WF2: 'complete-no-step-rosters' },
        runtimeOptions: { [workflowId]: { definitionRef: 'WF1', over: definitionOver } },
      }),
    }).result;

    const record = workflowRecord(resolved, workflowId);
    assert.notEqual(
      record.incompleteReason,
      'definition_identity_unbound',
      `${label} could not bind its own definition`,
    );
    assert.equal(record.complete, true, `${label} did not complete`);
  }

  // Guard against over-loosening: a MISMATCHED id in any of those shapes still fails closed.
  const wrong = { ...base.workflow, _id: { $oid: 'WF9' } };
  const wrongTriple = { workflow: wrong, triggers: base.triggers, stickyNotes: base.stickyNotes };
  const refused = await collectFor({
    responses: evidenceResponses({ exportByWorkflow: { WF1: okBody(wrongTriple) } }),
  }).result;
  assert.equal(workflowRecord(refused, 'WF1').incompleteReason, 'definition_identity_unbound');
  assert.equal(refused.complete, false);
});

// ===========================================================================
// Round-3 adversarial-review fixes. One test per finding, appended.
//
// Every test below was verified RED by surgically reverting exactly one fix in
// `lib/modes/weekly.mjs` / `lib/kernel.mjs` / `lib/local-runtime.mjs`, running
// only that test with `--test-name-pattern`, observing a failure, and restoring
// the fix. No existing test, assertion or fixture was altered.
// ===========================================================================

// ---------------------------------------------------------------------------
// 51 — R3-C1: a public page that under-declares or contradicts itself
// ---------------------------------------------------------------------------

test('a self describing public page cannot under declare or contradict itself', async () => {
  const evaluateFullEligibility = requireExport('evaluateFullEligibility');
  const base = await healthyEligibilityInputs();

  // CONTROL. The honest page still reaches Full, so nothing below is "everything now fails".
  const control = await evaluateFullEligibility({ ...base, frozenInputs: r3FrozenInputs() });
  assert.equal(control.status, 'complete_full', 'the honest control page no longer reaches Full');

  const oneRow = [structuredClone(MERGE.publicItems.baseline[0])];
  const cases = [
    // The six the reviewer demonstrated reaching complete_full with ZERO limitations.
    ['three NULL rows declared 3', (envelope) => {
      envelope.items = [null, null, null];
      envelope.page.reportedCount = 3;
      envelope.page.collectedCount = 3;
    }],
    ['zero rows declared 0', (envelope) => {
      envelope.items = [];
      envelope.page.reportedCount = 0;
      envelope.page.collectedCount = 0;
    }],
    ['page.total 999 against 1 served', (envelope) => {
      envelope.items = structuredClone(oneRow);
      envelope.page.reportedCount = 1;
      envelope.page.collectedCount = 1;
      envelope.page.total = 999;
    }],
    ['hasMore true beside complete true', (envelope) => {
      envelope.page.hasMore = true;
    }],
    ['a next page token', (envelope) => {
      envelope.page.nextPageToken = 'token-2';
    }],
    ['truncated 1, not true', (envelope) => {
      envelope.page.truncated = 1;
    }],
    // Three more of the same class, found by asking what else a page can carry.
    ['a declared count as a string', (envelope) => {
      envelope.page.reportedCount = '7';
    }],
    ['a row that is not a row', (envelope) => {
      envelope.items = [...structuredClone(MERGE.publicItems.baseline.slice(0, 6)), 'WF3'];
    }],
    ['rows outstanding', (envelope) => {
      envelope.page.remaining = 2;
    }],
    ['complete 1, not true', (envelope) => {
      envelope.page.complete = 1;
    }],
    ['an envelope level count that disagrees', (envelope) => {
      envelope.totalRecords = 12;
    }],
    ['an envelope level continuation link', (envelope) => {
      envelope.nextPageUrl = 'opaque-continuation';
    }],
  ];

  for (const [label, mutate] of cases) {
    const envelope = publicEnvelope('baseline');
    mutate(envelope);
    const merged = (await mergeFor({
      internalEvidence: base.internalEvidence,
      publicEvidence: [envelope],
    })).result;
    assert.notEqual(merged.status, 'COMPLETE', `${label}: the merge reported COMPLETE`);
    assert.ok(merged.limitations.length > 0, `${label}: the merge named ZERO limitations`);
    const decision = await evaluateFullEligibility({
      ...base,
      merge: merged,
      frozenInputs: r3FrozenInputs(),
    });
    assert.notEqual(decision.status, 'complete_full', `${label} published Full`);
    assert.equal(gateFor(decision, 'reconciliation').passed, false, label);
    assert.ok(decision.limitations.length > 0, `${label}: the decision named ZERO limitations`);
  }
});

// ---------------------------------------------------------------------------
// 52 — R3-C2: anchoring is the SEALED frozen inputs, and nothing else
// ---------------------------------------------------------------------------

// The identities decision D3 seals at run creation. `capabilityManifestHashes` carries both
// internal-rail identity digests; `capabilityAttestationHashes` is the sealed proof chain that
// binds the bundle. Nothing here is readable or writable by the evidence.
/**
 * Finding R7-C1. The provenance token the kernel emits after a host seal verified against the
 * run's own vault key material — bound to the anchor block it authenticated by the product's own
 * `frozenInputAnchorDigest`, so it can never license a different one. The MAC half of the seal
 * is exercised end to end against the REAL kernel by the appended R7 test; here, where the
 * caller IS the host, this is the value that arrives at `evaluateFullEligibility`.
 */
function anchorProvenanceFor(frozenInputs) {
  const digest = weeklyMode.frozenInputAnchorDigest;
  assert.equal(
    typeof digest,
    'function',
    'lib/modes/weekly.mjs must export frozenInputAnchorDigest()',
  );
  return { authenticated: true, method: 'host_key_mac', anchorDigest: digest(frozenInputs) };
}

function r3FrozenInputs(overrides = {}) {
  return resumeFrozenInputs({
    cutoff: Date.parse(WINDOW.to),
    target: {
      targetKind: 'location',
      operatingProfile: 'client',
      locationId: LOCATION_ID,
      companyId: COMPANY_ID,
    },
    capabilityManifestHashes: [MANIFEST_HASH, BUNDLE_HASH],
    capabilityAttestationHashes: [makeAttestation().attestationHash],
    ...overrides,
  });
}

// A wholly self-minted proof chain: a locally REBUILT manifest (a duplicated, byte-identical
// capability row changes the document identity but no descriptor, so every receipt still
// verifies), a bundle hash for a bundle that never existed, and an attestation minted by
// "nobody" that binds both. It is internally perfect — and the run sealed none of it.
const R3_REBUILT_MANIFEST = (() => {
  const rebuilt = structuredClone(MANIFEST);
  rebuilt.capabilities = [...rebuilt.capabilities, structuredClone(rebuilt.capabilities[0])];
  const { manifestHash: _omitted, ...rest } = rebuilt;
  rebuilt.manifestHash = sha256Of(rest);
  return Object.freeze(rebuilt);
})();
const R3_FORGED_MANIFEST_HASH = sha256Of(R3_REBUILT_MANIFEST);
const R3_FORGED_BUNDLE_HASH = sha256Of('a bundle that never existed');
const r3SelfMintedProofIndex = () => makeProofIndex({
  manifest: R3_REBUILT_MANIFEST,
  bundleHash: R3_FORGED_BUNDLE_HASH,
  attestation: makeAttestation({
    capabilityManifestHash: R3_FORGED_MANIFEST_HASH,
    bundleHash: R3_FORGED_BUNDLE_HASH,
    approver: 'nobody',
  }),
});

test('only the sealed frozen inputs can anchor a proof identity', async () => {
  const evaluateFullEligibility = requireExport('evaluateFullEligibility');
  const base = await healthyEligibilityInputs();

  // CONTROL: sealed inputs that really do seal this run's three identities.
  const sealed = await evaluateFullEligibility({ ...base, frozenInputs: r3FrozenInputs() });
  assert.equal(sealed.status, 'complete_full', 'sealed identities no longer reach Full');
  assert.equal(gateFor(sealed, 'live_runtime_receipts').passed, true);

  // An ADAPTER-pinned run — D7's first anchor — is no longer anchored by its pin, because the
  // pin is minted by the same actor, from the same configuration record, as the proof index.
  const pinned = await collectWith({
    expectedCapabilityManifestHash: MANIFEST_HASH,
    expectedBundleHash: BUNDLE_HASH,
  }, { responses: evidenceResponses({ ai: 'all-surfaces-complete' }) });
  assert.equal(pinned.capabilityProofAnchor.manifestPinned, true);
  assert.equal(pinned.capabilityProofAnchor.bundlePinned, true);

  const unsealedCases = [
    ['the manifest identity is not sealed', {
      capabilityManifestHashes: [sha256Of('some other manifest'), BUNDLE_HASH],
    }],
    ['the bundle identity is not sealed', { capabilityManifestHashes: [MANIFEST_HASH] }],
    ['the tool profile is not sealed', {
      providerToolProfileHash: sha256Of('some other tool profile'),
    }],
    ['no proof chain was sealed at run creation', { capabilityAttestationHashes: [] }],
  ];
  for (const [label, overrides] of unsealedCases) {
    for (const [variant, internalEvidence, merge, expected] of [
      ['unpinned', base.internalEvidence, base.merge, EXPECTED_IDENTITIES],
      ['adapter pinned', pinned, (await mergeFor({ internalEvidence: pinned })).result, { locationId: LOCATION_ID }],
    ]) {
      const decision = await evaluateFullEligibility({
        ...base,
        internalEvidence,
        merge,
        expected,
        frozenInputs: r3FrozenInputs(overrides),
      });
      assert.notEqual(
        decision.status,
        'complete_full',
        `${label} (${variant}) reached Full without a sealed anchor`,
      );
      assert.equal(gateFor(decision, 'live_runtime_receipts').passed, false, `${label} (${variant})`);
      assert.ok(
        limitationCodes(decision).includes('INTERNAL_AUDIT_PROOF_UNANCHORED'),
        `${label} (${variant}) named no anchoring limitation`,
      );
    }
  }

  // The self-minted chain: internally perfect, 16/16 proven live, and sealed by nothing.
  const selfMinted = await collectFor({
    responses: evidenceResponses({ ai: 'all-surfaces-complete' }),
    capabilityProofIndex: r3SelfMintedProofIndex(),
  }).result;
  assert.equal(selfMinted.complete, true, 'the self-minted attack evidence is not healthy');
  assert.equal(selfMinted.capabilityManifestHash, R3_FORGED_MANIFEST_HASH);
  assert.equal(selfMinted.bundleHash, R3_FORGED_BUNDLE_HASH);
  for (const capabilityId of APPLICABLE_CAPABILITIES) {
    assert.equal(coverageFor(selfMinted, capabilityId).proven, true, capabilityId);
    assert.equal(coverageFor(selfMinted, capabilityId).proofClass, 'live_runtime', capabilityId);
  }

  // The caller RESTATING what the evidence claims — D7's second anchor — proves nothing either.
  const restated = await evaluateFullEligibility({
    ...base,
    internalEvidence: selfMinted,
    merge: (await mergeFor({ internalEvidence: selfMinted })).result,
    expected: {
      contractVersion: '1.0.0',
      locationId: LOCATION_ID,
      toolProfileHash: TOOL_PROFILE_HASH,
      capabilityManifestHash: R3_FORGED_MANIFEST_HASH,
      bundleHash: R3_FORGED_BUNDLE_HASH,
    },
    frozenInputs: r3FrozenInputs(),
  });
  assert.notEqual(restated.status, 'complete_full', 'a self-minted chain reached Full');
  assert.equal(restated.status, 'complete_partial');
  assert.equal(gateFor(restated, 'live_runtime_receipts').passed, false);
  assert.ok(limitationCodes(restated).includes('INTERNAL_AUDIT_PROOF_UNANCHORED'));
});

// ---------------------------------------------------------------------------
// 53 — R3-C2, driven end to end through the REAL kernel
// ---------------------------------------------------------------------------

const R3_FULL_CUTOFF = Date.parse(WINDOW.to);

/**
 * Finding R7-C1. The run's key material, minted FRESH on every call: the kernel zeroes the
 * buffers `keyResolver` hands it, so a shared instance would be all zeroes by the time the host
 * seal is minted.
 */
const R3_FULL_KEYS = () => ({
  encryptionKey: Buffer.alloc(32, 1),
  pseudonymKey: Buffer.alloc(32, 2),
});

function r3FullKernel({
  runId,
  proofIndex = makeProofIndex(),
  frozenInputs = r3FrozenInputs(),
  internalIdentities = EXPECTED_IDENTITIES,
  publisherArgs = [],
  // ---- finding R7-C1 knobs. Every default reproduces the pre-R7 harness exactly. ----------
  // `hostSeal` decides whether the injected analyzer authenticates its anchoring claim at all;
  // `sealKeys` and `sealedAnchors` let a caller mint a seal that does not verify, or one minted
  // over a DIFFERENT anchor block than the frozen inputs actually carry.
  hostSeal = true,
  sealKeys = null,
  sealedAnchors = null,
  // The status the compiled payload LABELS itself with. The publication guard requires the
  // label and the eligibility decision to agree, so an honest partial harness proves the
  // decision was not Full and a Full-labelled one proves it was.
  payloadStatus = 'complete_full',
} = {}) {
  const kernel = createAuditKernel({
    clock: () => R3_FULL_CUTOFF,
    idFactory: () => runId,
    keyResolver: () => R3_FULL_KEYS(),
    stateStore: { open: openState },
    adapters: {
      // The analytical window is driven to the fixture's exact `[from, to)` through the
      // governed baseline's watermark: `2026-07-16T00:00Z` less the 72 h late-arrival overlap
      // is `2026-07-13T00:00Z`, and the cutoff is `2026-07-20T00:00Z`.
      getGovernedBaseline: async () => ({
        governedVerified: true,
        publicationId: 'baseline_r3c2',
        watermark: '2026-07-16T00:00:00.000Z',
      }),
      collectContext: async () => ({ context: 'safe' }),
      collectPublic: async () => [publicEnvelope('baseline')],
      collectInternal: async () => makeAdapter({
        capabilityProofIndex: proofIndex,
        responses: evidenceResponses({ ai: 'all-surfaces-complete' }),
      }),
    },
    analyzer: {
      // Finding R7-C1: the host authenticates the anchoring half it is handing over, with the
      // run's own key material. Without the seal the kernel has no statement of provenance, no
      // identity is anchored, and this harness's Full CONTROL could never be Full — so the
      // negative cases below it would stop meaning anything.
      freezeInputs: () => {
        const inputs = structuredClone(frozenInputs);
        if (!hostSeal) return inputs;
        return {
          ...sealFrozenInputs({
            frozenInputs: sealedAnchors === null ? inputs : structuredClone(sealedAnchors),
            keys: sealKeys === null ? R3_FULL_KEYS() : sealKeys(),
          }),
          frozenInputs: inputs,
        };
      },
      normalize: async () => ({ graph: 'safe' }),
      discover: async () => ({ findings: [] }),
      falsify: async () => ({ packets: [] }),
      loadMemory: async () => ({ events: [] }),
      describeClaimSupport: async () => structuredClone(MERGE.claimSupport.eligible),
      // A Full-labelled TRUSTED payload, exactly as the reviewer's attack drove it. When the
      // decision is not Full the publication guard must refuse it rather than publish.
      compile: async () => ({
        manifestInput: { schemaVersion: '1.0.0', runId, status: payloadStatus },
        projections: { memory: [] },
        payloadArtifacts: {
          'coverage.json': payloadStatus === 'complete_full'
            ? { state: 'complete_full', limitations: [] }
            : {
                state: 'complete_partial',
                limitations: [
                  'INTERNAL_WORKFLOW_DEFINITION_MISSING',
                  'INTERNAL_WORKFLOW_RUNTIME_MISSING',
                ],
              },
          'metrics-and-findings.json': {
            sealedInputs: { run: { status: payloadStatus } },
            findings: [],
          },
          'REPORT.md': '# Weekly audit\n',
        },
      }),
    },
    verifier: async () => ({ result: 'pass' }),
    // The trusted carrier's publisher contract: it verifies INSIDE the atomic gate and attests.
    publisher: async (input) => {
      publisherArgs.push(input);
      return {
        publicationId: input.runManifest?.publicationId ?? `pub_${runId}`,
        attestation: { verifierVersion: '1.0.0', result: 'pass' },
        manifestHash: sha256(input.runManifest ?? null),
        publicationRoot: sha256(input.payloadArtifacts ?? null),
      };
    },
  });
  return {
    kernel,
    publisherArgs,
    start: (projectRoot) => {
      const providerConfig = {
        lateArrivalHours: 72,
        coveragePolicy: structuredClone(COVERAGE_POLICY),
        internalApplicability: { capabilityIds: [...APPLICABLE_CAPABILITIES] },
        internalIdentities,
      };
      return kernel.start({
        mode: 'weekly',
        target: structuredClone(frozenInputs.target),
        projectRoot,
        cutoff: frozenInputs.cutoff,
        providerId: 'provider',
        profile: 'client',
        providerConfig,
        // A project-file descriptor, so the ISO timestamps in the coverage policy are never
        // copied into the durable run invocation (`assertSafeInvocationValue` reads a date as a
        // possible phone number). The run still executes from `providerConfig` directly.
        providerDescriptor: {
          kind: 'project_file',
          configHash: sha256(providerConfig),
          relativePath: 'provider-config.json',
        },
        vaultKeyReference: 'opaque-ref',
      });
    },
  };
}

test('a self minted proof chain cannot reach full through the real kernel', async () => {
  // 1. CONTROL — with the identities SEALED in the frozen inputs the whole path is alive:
  //    a real kernel run reaches `complete_full` and the publisher sees it. `complete_full` is
  //    unreachable in production for the RIGHT reasons, not because the path is dead.
  await withProjectRoot(async (projectRoot) => {
    const harness = r3FullKernel({ runId: 'run_r3c2_sealed' });
    const result = await harness.start(projectRoot);
    assert.equal(result.status, 'complete_full', 'the sealed control run never reached Full');
    assert.equal(harness.publisherArgs.length, 1);
    assert.equal(harness.publisherArgs[0].runManifest.status, 'complete_full');
    assert.equal(
      harness.publisherArgs[0].payloadArtifacts['coverage.json'].state,
      'complete_full',
    );
  });

  // 2. THE ATTACK — the same run, with a wholly self-minted proof chain and a provider config
  //    that RESTATES the forged identities. Every identity the evidence declares is one the run
  //    never sealed, so gate 2 fails and the Full-labelled payload is refused: no publication,
  //    no findings, no solution packs.
  await withProjectRoot(async (projectRoot) => {
    const harness = r3FullKernel({
      runId: 'run_r3c2_self_minted',
      proofIndex: r3SelfMintedProofIndex(),
      internalIdentities: {
        contractVersion: '1.0.0',
        toolProfileHash: TOOL_PROFILE_HASH,
        capabilityManifestHash: R3_FORGED_MANIFEST_HASH,
        bundleHash: R3_FORGED_BUNDLE_HASH,
      },
    });
    await assert.rejects(
      () => harness.start(projectRoot),
      /AUDIT_INTEGRITY_FAILURE|AUDIT_QUARANTINED/u,
      'a self-minted proof chain published through the real kernel',
    );
    assert.deepEqual(harness.publisherArgs, [], 'the publisher saw a self-minted Full run');
    const state = openState({ projectRoot, locationId: LOCATION_ID });
    try {
      assert.equal(state.getRun('run_r3c2_self_minted').status, 'quarantined');
    } finally {
      state.close();
    }
  });

  // 3. The attack ALSO fails when the forged identities are sealed nowhere and the caller
  //    supplies no expectation at all — the adapter pin is the only anchor left, and it is not
  //    an anchor any more.
  await withProjectRoot(async (projectRoot) => {
    const harness = r3FullKernel({
      runId: 'run_r3c2_unstated',
      proofIndex: r3SelfMintedProofIndex(),
      internalIdentities: {},
    });
    await assert.rejects(() => harness.start(projectRoot), /AUDIT_INTEGRITY_FAILURE|AUDIT_QUARANTINED/u);
    assert.deepEqual(harness.publisherArgs, []);
  });
});

// ---------------------------------------------------------------------------
// 54 — R3-I1: a rail ROLLBACK must resume, not quarantine
// ---------------------------------------------------------------------------

test('disabling the internal rail resumes an in flight run instead of quarantining it', async () => {
  await withProjectRoot(async (projectRoot) => {
    const runId = 'run_r3i1_rollback';
    const offlineProof = makeProofIndex({
      receiptOverrides: Object.fromEntries(
        APPLICABLE_CAPABILITIES.map((id) => [id, { proofClass: 'offline_contract' }]),
      ),
    });
    const railOn = {
      collectInternal: async () => makeAdapter({ capabilityProofIndex: offlineProof }),
    };

    // A run checkpointed WITH the rail: its `normalizing` input carries the internal hashes.
    await assert.rejects(() => makeKernel({
      runId,
      adapters: railOn,
      faultInjector: async ({ phase }) => {
        if (phase === 'normalizing') throw new Error('interrupted after normalizing');
      },
    }).start(startArgs(projectRoot)));

    const state = openState({ projectRoot, locationId: LOCATION_ID });
    try {
      assert.ok(state.getCheckpoint({ runId, phase: 'collecting_internal' }), 'no internal checkpoint');
      assert.ok(state.getCheckpoint({ runId, phase: 'normalizing' }), 'nothing was checkpointed');
    } finally {
      state.close();
    }

    // Resumed by a kernel with NO internal rail — a rollback of the deployment this task
    // enables. It must RESUME. A governance quarantine here would convert every in-flight run
    // into a quarantine the moment the rail is switched off.
    const resumed = await makeKernel({ runId }).resume({
      projectRoot,
      locationId: LOCATION_ID,
      runId,
      vaultKeyReference: 'opaque-ref',
    });
    assert.equal(
      resumed.status,
      'complete_partial',
      'disabling the rail quarantined an in-flight run',
    );

    // And the rollback is not achieved by throwing the internal evidence away: the durable
    // answer is restored, so the phase input still reconciles.
    const after = openState({ projectRoot, locationId: LOCATION_ID });
    try {
      assert.notEqual(after.getRun(runId).status, 'quarantined');
    } finally {
      after.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 55 — R3-I2: gate 8 and capabilities this run never exercised
// ---------------------------------------------------------------------------

test('a claim resting on a capability this run never exercised cannot satisfy gate eight', async () => {
  const evaluateFullEligibility = requireExport('evaluateFullEligibility');
  const base = await healthyEligibilityInputs();
  const frozenInputs = r3FrozenInputs();

  // The capability is PROVEN live and applicable — it was simply never used by this run.
  const unexercised = coverageFor(base.internalEvidence, 'workflow_triggers');
  assert.equal(unexercised.proven, true, 'the fixture no longer proves workflow_triggers');
  assert.equal(unexercised.exercised, false, 'workflow_triggers is exercised after all');

  const control = await evaluateFullEligibility({ ...base, frozenInputs });
  assert.equal(control.status, 'complete_full');
  assert.equal(gateFor(control, 'claim_support').passed, true);

  const cases = [
    ['a never-exercised capability', 'workflow_triggers'],
    ['a capability in no coverage row at all', 'a_capability_this_run_never_heard_of'],
  ];
  for (const [label, capabilityId] of cases) {
    const decision = await evaluateFullEligibility({
      ...base,
      frozenInputs,
      claimSupport: [
        { claimId: 'C9', support: 'direct_evidence', dependsOnCapabilityIds: [capabilityId] },
      ],
    });
    assert.notEqual(decision.status, 'complete_full', `${label} published Full`);
    assert.equal(decision.status, 'complete_partial', label);
    assert.equal(gateFor(decision, 'claim_support').passed, false, label);
    const limitation = (decision.limitations ?? []).find(
      (entry) => entry.code === 'CLAIM_SUPPORT_INSUFFICIENT',
    );
    assert.ok(limitation, `${label}: no claim-support limitation`);
    assert.ok(limitation.claimIds.includes('C9'), `${label}: the blocked claim is unnamed`);
  }

  // A claim resting on an exercised, proven capability still passes: the gate did not simply
  // start refusing every claim.
  const stillEligible = await evaluateFullEligibility({
    ...base,
    frozenInputs,
    claimSupport: [
      { claimId: 'C1', support: 'direct_evidence', dependsOnCapabilityIds: ['workflow_roster_list'] },
    ],
  });
  assert.equal(stillEligible.status, 'complete_full');
});

// ---------------------------------------------------------------------------
// 56 — R3-I3: gate 3 recounts the roster's own declared total
// ---------------------------------------------------------------------------

test('gate three recounts the rosters own declared total', async () => {
  const evaluateFullEligibility = requireExport('evaluateFullEligibility');
  const base = await healthyEligibilityInputs();
  const frozenInputs = r3FrozenInputs();
  assert.equal(base.internalEvidence.workflowRoster.reportedTotal, 2);

  const lyingRosters = [
    ['reportedTotal 99 against 2 listed ids', { reportedTotal: 99 }],
    ['reportedTotal 1 against 2 listed ids', { reportedTotal: 1 }],
    ['reportedTotal as a string', { reportedTotal: '2' }],
    ['an extra declared total that disagrees', { collectedCount: 7 }],
  ];
  for (const [label, over] of lyingRosters) {
    const internalEvidence = structuredClone(base.internalEvidence);
    Object.assign(internalEvidence.workflowRoster, over);
    const decision = await evaluateFullEligibility({ ...base, internalEvidence, frozenInputs });
    assert.notEqual(decision.status, 'complete_full', `${label} published Full`);
    assert.equal(gateFor(decision, 'workflow_roster_and_coverage').passed, false, label);
  }

  // The honest roster still reconciles.
  const control = await evaluateFullEligibility({ ...base, frozenInputs });
  assert.equal(gateFor(control, 'workflow_roster_and_coverage').passed, true);
  assert.equal(control.status, 'complete_full');
});

// ---------------------------------------------------------------------------
// 57 — R3-M1: gate 7 must be able to tell that evidence was actually fetched
// ---------------------------------------------------------------------------

test('a handshake only or failing trace cannot satisfy the read only gate', async () => {
  const evaluateFullEligibility = requireExport('evaluateFullEligibility');
  const base = await healthyEligibilityInputs();
  const frozenInputs = r3FrozenInputs();
  const entry = (over) => ({
    tool: 'list_workflows_complete',
    capabilityId: null,
    status: 200,
    ok: true,
    boundLocationId: LOCATION_ID,
    ...over,
  });

  const traces = [
    ['only the tools/list handshake', [entry({ tool: 'tools/list' })]],
    ['only a credential probe', [entry({ tool: 'auth_status' })]],
    ['handshake plus credential probe', [entry({ tool: 'tools/list' }), entry({ tool: 'auth_status' })]],
    ['an evidence call that failed', [entry({ tool: 'tools/list' }), entry({ ok: false, status: null })]],
    ['an evidence call that 500ed', [entry({ tool: 'tools/list' }), entry({ status: 500 })]],
    ['an outcome that is not stated', [entry({ tool: 'tools/list' }), entry({ ok: 'yes' })]],
    ['a status that is not a status', [entry({ tool: 'tools/list' }), entry({ status: '200' })]],
  ];
  for (const [label, trace] of traces) {
    const decision = await evaluateFullEligibility({ ...base, trace, frozenInputs });
    assert.equal(gateFor(decision, 'read_only_trace').passed, false, label);
    assert.notEqual(decision.status, 'complete_full', `${label} published Full`);
    // Missing evidence is Partial. Only a demonstrated violation quarantines.
    assert.equal(decision.status, 'complete_partial', label);
  }

  // A trace that really does record a successful evidence call still passes, and the REAL
  // adapter's own trace is one of them.
  for (const [label, trace] of [
    ['the clean fixture', MERGE.traces.clean],
    ['the adapter trace', base.internalEvidence.trace],
  ]) {
    const decision = await evaluateFullEligibility({ ...base, trace, frozenInputs });
    assert.equal(gateFor(decision, 'read_only_trace').passed, true, label);
  }

  // A demonstrated write attempt is still a quarantine, not a soft Partial.
  const violating = await evaluateFullEligibility({
    ...base,
    trace: MERGE.traces['write-attempt'],
    frozenInputs,
  });
  assert.equal(violating.status, 'quarantined');
});

// ---------------------------------------------------------------------------
// 58 — R3-M2: the decision validator is exact-field
// ---------------------------------------------------------------------------

test('an eligibility decision carrying unknown fields fails closed', async () => {
  const enforcePublicOnlyPublication = requireExport('enforcePublicOnlyPublication');
  const evaluateFullEligibility = requireExport('evaluateFullEligibility');
  const run = { runId: 'run_r3m2', frozenInputsHash: 'e'.repeat(64) };
  const bound = await evaluateFullEligibility({
    ...(await healthyEligibilityInputs()),
    frozenInputs: r3FrozenInputs(),
    run,
  });
  assert.equal(bound.status, 'complete_full', 'the control decision is not eligible');
  const publishable = {
    coverage: { state: 'complete_full', limitations: [] },
    diff: { state: 'COMPARABLE', transitions: [] },
    findings: [{ id: 'F1', scope: 'account_wide', verdict: 'PASS', impact: 12, totalImpact: 100000 }],
    latestFull: null,
  };

  // CONTROL: the exact shape this module mints still lifts the clamp.
  assert.equal(
    enforcePublicOnlyPublication(structuredClone(publishable), {
      fullEligibility: bound,
      expectedRun: run,
    }).status,
    'complete_full',
  );

  const drifted = [
    ['an unknown decision key', { ...structuredClone(bound), overriddenBy: 'operator' }],
    ['an unknown decision key holding a note', { ...structuredClone(bound), note: 'looks fine' }],
    ['an unknown gate key', {
      ...structuredClone(bound),
      gates: structuredClone(bound).gates.map(
        (gate, index) => (index === 0 ? { ...gate, waived: true } : gate),
      ),
    }],
    ['a missing decision field', (() => {
      const value = structuredClone(bound);
      delete value.limitations;
      return value;
    })()],
    ['a missing gate field', {
      ...structuredClone(bound),
      gates: structuredClone(bound).gates.map(
        (gate, index) => (index === 3 ? { id: gate.id } : gate),
      ),
    }],
  ];
  for (const [label, fullEligibility] of drifted) {
    let output = null;
    try {
      output = enforcePublicOnlyPublication(structuredClone(publishable), {
        fullEligibility,
        expectedRun: run,
      });
    } catch (error) {
      assert.match(String(error.code ?? error.message), /AUDIT_INTEGRITY_FAILURE/u, label);
      continue;
    }
    assert.notEqual(output.status, 'complete_full', `${label} lifted the clamp`);
    assert.equal(output.findings[0].scope, 'public_comparable_subset', label);
  }
});

// ---------------------------------------------------------------------------
// 59 — R3-4: a symlinked DIRECTORY cannot escape the project root
// ---------------------------------------------------------------------------

test('a symlinked directory cannot escape the project root', async () => {
  const { createLocalAuditKernel, localProviderDescriptor } = await import('../lib/local-runtime.mjs');
  const { mkdirSync, symlinkSync, writeFileSync } = await import('node:fs');
  await withProjectRoot(async (projectRoot) => {
    const outside = mkdtempSync(join(tmpdir(), 'ghl-outside-'));
    try {
      const config = {
        schemaVersion: '1.0.0',
        adapterKind: 'local_fixture',
        providerId: 'provider',
        cutoff: KERNEL_CUTOFF,
        timezone: 'Australia/Sydney',
        frozenInputs: kernelFrozenInputs(),
        context: { context: 'outside the project root' },
        publicEvidence: { events: [] },
        reviews: [],
      };
      const bytes = `${JSON.stringify(config)}\n`;
      writeFileSync(join(outside, 'provider-config.json'), bytes, { mode: 0o600 });
      mkdirSync(join(projectRoot, 'nested'), { recursive: true });
      writeFileSync(join(projectRoot, 'nested', 'provider-config.json'), bytes, { mode: 0o600 });
      // Only the MIDDLE component is a symlink, so `O_NOFOLLOW` on the final component sees a
      // perfectly ordinary regular file and the lexical containment check sees a path that
      // starts with the project root.
      symlinkSync(outside, join(projectRoot, 'nested', 'link'), 'dir');

      // 1. The descriptor cannot even be MINTED for an escaping path.
      assert.throws(
        () => localProviderDescriptor({
          projectRoot,
          providerConfigPath: join(projectRoot, 'nested', 'link', 'provider-config.json'),
          config,
        }),
        /AUDIT_PREFLIGHT_FAILED_PROVIDER_CONFIG/u,
        'a descriptor was minted for a path outside the project root',
      );

      // 2. And the LOADER refuses it too, which is the path a resume actually takes. The run is
      //    created with the escaping descriptor (creation never opens the file), then resumed.
      const escapeRun = 'run_r34_escape';
      const startWith = (runId, relativePath) => createLocalAuditKernel({ initialRunId: runId }).start({
        mode: 'weekly',
        target: kernelFrozenInputs().target,
        projectRoot,
        cutoff: config.cutoff,
        providerId: config.providerId,
        profile: 'client',
        providerConfig: config,
        providerDescriptor: {
          kind: 'project_file',
          configHash: sha256(config),
          relativePath,
        },
        vaultKeyReference: 'test-only:key',
      });
      const resumeWith = (runId) => createLocalAuditKernel().resume({
        projectRoot,
        locationId: LOCATION_ID,
        runId,
        vaultKeyReference: 'test-only:key',
      });

      assert.equal(
        (await startWith(escapeRun, 'nested/link/provider-config.json')).status,
        'complete_partial',
      );
      await assert.rejects(
        () => resumeWith(escapeRun),
        /AUDIT_PREFLIGHT_FAILED_PROVIDER_CONFIG/u,
        'a symlinked directory escaped the project root',
      );

      // 3. The same bytes at a REAL path inside the project are still read, so the fix did not
      //    simply stop reading configuration.
      const insideRun = 'run_r34_inside';
      assert.equal(
        (await startWith(insideRun, 'nested/provider-config.json')).status,
        'complete_partial',
      );
      let resumedError = null;
      try {
        await resumeWith(insideRun);
      } catch (error) {
        resumedError = String(error?.code ?? error);
      }
      assert.doesNotMatch(
        String(resumedError),
        /AUDIT_PREFLIGHT_FAILED_PROVIDER_CONFIG/u,
        'a configuration genuinely inside the project root was refused',
      );
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 60 — R3-C2 residual / decision D11: the LIBRARY path is closed too
// ---------------------------------------------------------------------------

test('an unsealed library call can never anchor an identity', async () => {
  const evaluateFullEligibility = requireExport('evaluateFullEligibility');
  const base = await healthyEligibilityInputs();

  // Decision D7 left two anchoring channels alive for any host that calls
  // `evaluateFullEligibility` directly rather than through the kernel: the adapter's
  // `capabilityProofAnchor` pin flags, and a caller-supplied `expected.<hash>` compared against
  // the evidence's OWN self-declared identity field. Both are minted by the same actor as the
  // proof index they vouch for — R3-C2's exact circularity. D11 REMOVES them: the run's sealed
  // frozen inputs are the only anchor, so an unsealed library call is always Partial.

  // The evidence a host would present. `pinned` is offered BOTH pin flags by the adapter.
  const pinned = await collectWith({
    expectedCapabilityManifestHash: MANIFEST_HASH,
    expectedBundleHash: BUNDLE_HASH,
  }, { responses: evidenceResponses({ ai: 'all-surfaces-complete' }) });
  assert.equal(pinned.capabilityProofAnchor.manifestPinned, true, 'the pin channel was not offered');
  assert.equal(pinned.capabilityProofAnchor.bundlePinned, true, 'the pin channel was not offered');
  assert.equal(base.internalEvidence.capabilityProofAnchor.manifestPinned, false);
  const evidences = [
    ['adapter unpinned', base.internalEvidence, base.merge],
    ['adapter pinned', pinned, (await mergeFor({ internalEvidence: pinned })).result],
  ];

  // The caller's `expected` block. `EXPECTED_IDENTITIES` restates, digest for digest, exactly
  // what this evidence declares about itself — D7's second channel, exercised at full strength.
  for (const [evidenceLabel, internalEvidence, merge] of evidences) {
    assert.equal(internalEvidence.toolProfileHash, EXPECTED_IDENTITIES.toolProfileHash, evidenceLabel);
    assert.equal(
      internalEvidence.capabilityManifestHash,
      EXPECTED_IDENTITIES.capabilityManifestHash,
      evidenceLabel,
    );
    assert.equal(internalEvidence.bundleHash, EXPECTED_IDENTITIES.bundleHash, evidenceLabel);
  }
  const expectations = [
    ['caller restates the evidence own digests', EXPECTED_IDENTITIES],
    ['caller states no digests', { locationId: LOCATION_ID }],
  ];

  // Every way a host can fail to seal: never passing the key, passing null, passing an empty
  // record, and sealing a DIFFERENT run's identities.
  const OTHER_PROFILE = sha256Of('a tool profile this run never sealed');
  const OTHER_MANIFEST = sha256Of('a manifest this run never sealed');
  const OTHER_ATTESTATION = sha256Of('an attestation this run never sealed');
  const unsealed = [
    ['frozenInputs absent', undefined],
    ['frozenInputs null', null],
    ['frozenInputs empty', {}],
    ['frozenInputs seal a different tool profile', r3FrozenInputs({
      providerToolProfileHash: OTHER_PROFILE,
    })],
    ['frozenInputs seal a different manifest and bundle', r3FrozenInputs({
      capabilityManifestHashes: [OTHER_MANIFEST],
      capabilityAttestationHashes: [OTHER_ATTESTATION],
    })],
    ['frozenInputs seal nothing at all', r3FrozenInputs({
      providerToolProfileHash: OTHER_PROFILE,
      capabilityManifestHashes: [OTHER_MANIFEST],
      capabilityAttestationHashes: [OTHER_ATTESTATION],
    })],
  ];

  for (const [evidenceLabel, internalEvidence, merge] of evidences) {
    // CONTROL: the very same call, SEALED, is Full. Every case below therefore differs from a
    // Full run in exactly one respect — the sealing — so the path is refused, never dead.
    const control = await evaluateFullEligibility({
      ...base,
      internalEvidence,
      merge,
      expected: { locationId: LOCATION_ID },
      frozenInputs: r3FrozenInputs(),
    });
    assert.equal(control.status, 'complete_full', `${evidenceLabel}: the sealed control is not Full`);
    // Controller decision D13, closing the R4-C1 residual. This control passes `expected:
    // {locationId}` — no digests at all — so before round 5 its Full rested on SLOT DISCIPLINE
    // alone: three sealed digests restated by evidence that could have been produced from a
    // wholly self-minted chain. It is now anchored by GENUINE SEALED PROVENANCE, and that is
    // asserted rather than assumed: the adapter validated the attestation DOCUMENT (its
    // self-omitting preimage, and its binding to this run's three identities), published the
    // hash it accepted, and that hash is the one the run sealed — the single value in the whole
    // chain an outsider cannot produce a preimage for.
    assert.deepEqual(
      internalEvidence.governingAttestationHashes,
      [makeAttestation().attestationHash],
      `${evidenceLabel}: the control carries no adapter-validated governing attestation`,
    );
    assert.deepEqual(
      r3FrozenInputs().capabilityAttestationHashes,
      internalEvidence.governingAttestationHashes,
      `${evidenceLabel}: the governing attestation is not the one the run sealed`,
    );

    for (const [expectedLabel, expected] of expectations) {
      for (const [sealLabel, frozenInputs] of unsealed) {
        const label = `${evidenceLabel} / ${expectedLabel} / ${sealLabel}`;
        const inputs = {
          ...base, internalEvidence, merge, expected, frozenInputs,
        };
        // "Absent" means the key is genuinely not present, not present-and-undefined.
        if (frozenInputs === undefined) delete inputs.frozenInputs;
        const decision = await evaluateFullEligibility(inputs);
        assert.notEqual(decision.status, 'complete_full', `${label} reached Full unsealed`);
        assert.equal(decision.eligible, false, label);
        assert.equal(decision.status, 'complete_partial', label);
        assert.equal(gateFor(decision, 'live_runtime_receipts').passed, false, label);
        assert.ok(decision.failedGates.includes('live_runtime_receipts'), label);
        assert.ok(
          limitationCodes(decision).includes('INTERNAL_AUDIT_PROOF_UNANCHORED'),
          `${label} named no anchoring limitation`,
        );
      }
    }
  }
});

// ===========================================================================
// Round-4 adversarial-review fixes — one appended test per finding.
//
// Every test below was verified RED by surgically reverting exactly one fix in
// `lib/modes/weekly.mjs` or `lib/local-runtime.mjs`, running only that test with
// `--test-name-pattern`, observing the failure, and restoring the fix.
// No existing test, assertion or fixture was weakened, deleted or reordered.
// ===========================================================================

// ---------------------------------------------------------------------------
// 61 — R4-C2: the page/envelope classifier is an ALLOW-LIST, not an enumeration
// ---------------------------------------------------------------------------

test('an unrecognised self description key can never be published as complete', async () => {
  const evaluateFullEligibility = requireExport('evaluateFullEligibility');
  const base = await healthyEligibilityInputs();

  // CONTROL. The honest envelope still reaches Full, so nothing below is "everything fails".
  const control = await evaluateFullEligibility({ ...base, frozenInputs: r3FrozenInputs() });
  assert.equal(control.status, 'complete_full', 'the honest control envelope no longer reaches Full');

  const cases = [
    // ---- the five the round-4 reviewer demonstrated reaching Full with ZERO limitations ----
    ['a NESTED pagination record', (envelope) => {
      envelope.page.pagination = { hasMore: true, nextCursor: 'MORE' };
    }],
    ['an endCursor', (envelope) => { envelope.page.endCursor = 'MORE'; }],
    ['an after cursor', (envelope) => { envelope.page.after = 'MORE'; }],
    ['a lastEvaluatedKey', (envelope) => { envelope.page.lastEvaluatedKey = { pk: 'MORE' }; }],
    ['an offset', (envelope) => { envelope.page.offset = 25; }],
    ['a pageTotal demoted to a container count', (envelope) => { envelope.page.pageTotal = 999; }],
    ['a hits count', (envelope) => { envelope.page.hits = 999; }],
    ['a numFound count', (envelope) => { envelope.page.numFound = 999; }],
    ['contentless rows padding the count', (envelope) => {
      envelope.items = [{}];
      envelope.page.reportedCount = 1;
      envelope.page.collectedCount = 1;
    }],
    // ---- four more of the same class, of my own devising ----
    ['a vendor extension nobody taught the auditor', (envelope) => {
      envelope.page._meta = { scrollId: 'MORE' };
    }],
    ['a nested continuation on the ENVELOPE, not the page', (envelope) => {
      envelope.appliedWindow.continuation = { nextCursor: 'MORE' };
    }],
    ['structure hidden under a known scalar key', (envelope) => {
      envelope.page.cursor = { nextCursor: 'MORE' };
    }],
    ['rows whose every field is empty', (envelope) => {
      envelope.items = envelope.items.map(() => ({ kind: null, nativeId: '', name: null }));
    }],
    ['a nested record under a known count key', (envelope) => {
      envelope.page.reportedCount = { value: 7 };
    }],
  ];

  for (const [label, mutate] of cases) {
    const envelope = publicEnvelope('baseline');
    mutate(envelope);
    const merged = (await mergeFor({
      internalEvidence: base.internalEvidence,
      publicEvidence: [envelope],
    })).result;
    assert.notEqual(merged.status, 'COMPLETE', `${label}: the merge reported COMPLETE`);
    assert.ok(merged.limitations.length > 0, `${label}: the merge named ZERO limitations`);
    const decision = await evaluateFullEligibility({
      ...base,
      merge: merged,
      frozenInputs: r3FrozenInputs(),
    });
    assert.notEqual(decision.status, 'complete_full', `${label} published Full`);
    assert.equal(gateFor(decision, 'reconciliation').passed, false, label);
    assert.ok(decision.limitations.length > 0, `${label}: the decision named ZERO limitations`);
  }
});

// ---------------------------------------------------------------------------
// 62 — R4-C2: the SEALED ROSTER is defended by the same allow-list
// ---------------------------------------------------------------------------

test('an unrecognised key on the sealed roster can never be published as covered', async () => {
  const evaluateFullEligibility = requireExport('evaluateFullEligibility');
  const base = await healthyEligibilityInputs();

  const rosterCase = async (label, mutate) => {
    const internalEvidence = structuredClone(base.internalEvidence);
    mutate(internalEvidence.workflowRoster);
    const decision = await evaluateFullEligibility({
      ...base,
      internalEvidence,
      merge: (await mergeFor({ internalEvidence })).result,
      frozenInputs: r3FrozenInputs(),
    });
    assert.equal(
      gateFor(decision, 'workflow_roster_and_coverage').passed,
      false,
      `${label}: gate 3 still passed`,
    );
    assert.notEqual(decision.status, 'complete_full', `${label} published Full`);
  };

  // The two the reviewer demonstrated at the adapter/publication trust boundary.
  await rosterCase('a nested pagination record', (roster) => {
    roster.pagination = { hasMore: true, nextCursor: 'MORE' };
  });
  await rosterCase('a pageTotal and a hits count', (roster) => {
    roster.pageTotal = 999;
    roster.hits = 999;
  });
  // Four more of the same class.
  await rosterCase('a cursor the auditor never learned', (roster) => {
    roster.nextPageToken = 'MORE';
  });
  await rosterCase('a vendor extension', (roster) => {
    roster._meta = { truncatedAt: 1 };
  });
  await rosterCase('structure hidden under a known scalar key', (roster) => {
    roster.terminalReason = { reason: 'budget', hasMore: true };
  });
  await rosterCase('a second declared total that disagrees', (roster) => {
    roster.reportedTotal = 999;
  });

  // CONTROL: the untouched roster still passes gate 3, so this is a refusal, not a dead gate.
  const control = await evaluateFullEligibility({ ...base, frozenInputs: r3FrozenInputs() });
  assert.equal(gateFor(control, 'workflow_roster_and_coverage').passed, true);
  assert.equal(control.status, 'complete_full');
});

// ---------------------------------------------------------------------------
// 63 — R4-C1: an identity may never be anchored by ANOTHER identity's sealed value
// ---------------------------------------------------------------------------

test('a bundle identity borrowed from another sealed namespace anchors nothing', async () => {
  const evaluateFullEligibility = requireExport('evaluateFullEligibility');
  const base = await healthyEligibilityInputs();
  const sealedInputs = r3FrozenInputs();

  // CONTROL: the honest run, whose bundle digest has a sealed slot of its own, is still Full.
  const control = await evaluateFullEligibility({ ...base, frozenInputs: sealedInputs });
  assert.equal(control.status, 'complete_full', 'the honest sealed control no longer reaches Full');

  // Everything an attacker can COMPUTE or read out of the sealed inputs. The manifest and the
  // tool profile are public derivable constants; the proof-chain digests are sealed values the
  // run really does carry — and not one of them is a bundle IDENTITY.
  const borrowed = [
    ['the public manifest digest (round 4s headline attack)', MANIFEST_HASH],
    ['the public tool-profile digest', TOOL_PROFILE_HASH],
    ['a sealed attestation hash (the DECOY variant)', sealedInputs.capabilityAttestationHashes[0]],
    ['a sealed receipt hash', sealedInputs.capabilityReceiptHashes[0]],
    ['the sealed proof-index hash', sealedInputs.capabilityProofIndexHash],
  ];

  for (const [label, borrowedDigest] of borrowed) {
    const internalEvidence = {
      ...structuredClone(base.internalEvidence),
      bundleHash: borrowedDigest,
    };
    const decision = await evaluateFullEligibility({
      ...base,
      internalEvidence,
      merge: (await mergeFor({ internalEvidence })).result,
      expected: { locationId: LOCATION_ID },
      frozenInputs: sealedInputs,
    });
    assert.notEqual(decision.status, 'complete_full', `${label} anchored a bundle identity`);
    assert.equal(gateFor(decision, 'live_runtime_receipts').passed, false, label);
    assert.ok(
      limitationCodes(decision).includes('INTERNAL_AUDIT_PROOF_UNANCHORED'),
      `${label} named no anchoring limitation`,
    );
  }

  // The same rule the other way round: a MANIFEST identity borrowed from the proof-chain
  // namespace, and a tool profile borrowed from the manifest set, anchor nothing either.
  for (const [label, over] of [
    ['a manifest identity taken from the attestation namespace', {
      capabilityManifestHash: sealedInputs.capabilityAttestationHashes[0],
    }],
    ['a manifest identity equal to the bundle identity', { capabilityManifestHash: BUNDLE_HASH }],
    ['a tool profile equal to the manifest identity', { toolProfileHash: MANIFEST_HASH }],
  ]) {
    const internalEvidence = { ...structuredClone(base.internalEvidence), ...over };
    const decision = await evaluateFullEligibility({
      ...base,
      internalEvidence,
      merge: (await mergeFor({ internalEvidence })).result,
      expected: { locationId: LOCATION_ID },
      frozenInputs: sealedInputs,
    });
    assert.notEqual(decision.status, 'complete_full', `${label} anchored an identity`);
    assert.equal(gateFor(decision, 'live_runtime_receipts').passed, false, label);
  }
});

// ---------------------------------------------------------------------------
// 64 — R4-C1: when the proof chain IS supplied, the sealed attestation must
//      carry the identities, and a decoy nobody validated must not do it
// ---------------------------------------------------------------------------

test('only a sealed attestation a receipt validated can carry the bundle identity', async () => {
  const evaluateFullEligibility = requireExport('evaluateFullEligibility');
  const base = await healthyEligibilityInputs();
  const attestation = makeAttestation();
  const sealedInputs = r3FrozenInputs();

  // CONTROL: the run supplies the chain PREIMAGE, and the sealed attestation binds all three
  // identities. This is the only path a genuine live canary can produce, and it is Full.
  const anchored = await evaluateFullEligibility({
    ...base,
    expected: { ...EXPECTED_IDENTITIES, capabilityProofIndex: makeProofIndex() },
    frozenInputs: sealedInputs,
  });
  assert.equal(anchored.status, 'complete_full', 'a sealed, validated attestation did not anchor');

  const refused = [
    // A chain whose attestation the run never sealed: forged, so its hash is not a sealed one.
    ['an attestation the run never sealed', makeProofIndex({
      attestation: makeAttestation({ approver: 'nobody' }),
    })],
    // A DECOY: sealed hash, but referenced by no receipt, so nobody ever validated it.
    ['a sealed attestation no receipt references', (() => {
      const chain = makeProofIndex({ attestation: makeAttestation({ approver: 'nobody' }) });
      chain.attestations[attestation.attestationHash] = attestation;
      return chain;
    })()],
    // The preimage does not hash to the sealed hash it is filed under.
    ['an attestation whose document does not hash to its sealed hash', (() => {
      const chain = makeProofIndex();
      chain.attestations[attestation.attestationHash] = {
        ...attestation,
        bundleHash: MANIFEST_HASH,
      };
      return chain;
    })()],
    // Sealed, referenced, self-consistent — and binds a DIFFERENT bundle.
    ['a sealed attestation binding a different bundle', (() => {
      const other = makeAttestation({ bundleHash: sha256Of('some other bundle') });
      const chain = makeProofIndex({ attestation: other });
      return chain;
    })()],
    // No human approved it.
    ['an attestation with no approver', (() => {
      const chain = makeProofIndex();
      chain.attestations[attestation.attestationHash] = { ...attestation, approver: '' };
      return chain;
    })()],
    // An offline receipt is not a live-runtime validation.
    ['a chain whose receipts are all offline', makeProofIndex({
      receiptOverrides: Object.fromEntries(
        APPLICABLE_CAPABILITIES.map((id) => [id, { proofClass: 'offline_contract' }]),
      ),
    })],
    // The chain is present but structurally empty: offering it and having it rejected is
    // strictly worse evidence than offering nothing.
    ['an empty chain', { index: { schemaVersion: '1.0', receipts: [] }, attestations: {} }],
  ];

  for (const [label, capabilityProofIndex] of refused) {
    const decision = await evaluateFullEligibility({
      ...base,
      expected: { ...EXPECTED_IDENTITIES, capabilityProofIndex },
      frozenInputs: sealedInputs,
    });
    assert.notEqual(decision.status, 'complete_full', `${label} anchored the identities`);
    assert.equal(gateFor(decision, 'live_runtime_receipts').passed, false, label);
    assert.ok(
      limitationCodes(decision).includes('INTERNAL_AUDIT_PROOF_UNANCHORED'),
      `${label} named no anchoring limitation`,
    );
  }
});

// ---------------------------------------------------------------------------
// 65 — R4-C1: the composition-root identity check is MANDATORY, not opt-out
// ---------------------------------------------------------------------------

test('the composition root refuses a rail that will not state its sealed identities', async () => {
  const { createLocalAuditKernel, localProviderDescriptor } = await import('../lib/local-runtime.mjs');
  const { writeFileSync } = await import('node:fs');

  const railBase = {
    adapterKind: 'internal_ghl',
    contractVersion: '1.0.0',
    locationId: LOCATION_ID,
    toolProfileHash: TOOL_PROFILE_HASH,
    capabilityManifestHash: MANIFEST_HASH,
    bundleHash: BUNDLE_HASH,
    capabilityProofIndex: makeProofIndex(),
    transport: {
      kind: 'inline_responses',
      toolsList: TOOLS_LIST,
      responses: { auth_status: { ok: false, code: 'INTERNAL_AUDIT_AUTH_REQUIRED' } },
    },
  };
  const sealedFrozen = kernelFrozenInputs({
    capabilityManifestHashes: [MANIFEST_HASH, BUNDLE_HASH],
  });

  const runLocal = async (internalRail, frozenInputs, runId) => withProjectRoot(async (projectRoot) => {
    const providerConfig = {
      schemaVersion: '1.0.0',
      adapterKind: 'local_fixture',
      providerId: 'provider',
      cutoff: KERNEL_CUTOFF,
      timezone: 'Australia/Sydney',
      frozenInputs,
      context: { context: 'safe' },
      publicEvidence: { events: [] },
      reviews: [],
      internalRail,
    };
    const providerConfigPath = join(projectRoot, 'provider-config.json');
    writeFileSync(providerConfigPath, `${JSON.stringify(providerConfig)}\n`, { mode: 0o600 });
    return createLocalAuditKernel({ initialRunId: runId }).start({
      mode: 'weekly',
      target: frozenInputs.target,
      projectRoot,
      cutoff: providerConfig.cutoff,
      providerId: providerConfig.providerId,
      profile: 'client',
      providerConfig,
      providerDescriptor: localProviderDescriptor({
        projectRoot,
        providerConfigPath,
        config: providerConfig,
      }),
      vaultKeyReference: 'test-only:key',
    });
  });

  // CONTROL: fully stated and fully sealed, the rail is built and the run reaches the internal
  // auth boundary — so every refusal below is a refusal, not a dead composition root.
  const control = await runLocal(railBase, sealedFrozen, 'run_r4c1_ok');
  assert.equal(control.status, 'awaiting_internal_auth', 'the sealed control rail was not built');

  const refusals = [
    ['no bundleHash at all', (() => {
      const { bundleHash: _dropped, ...rail } = railBase;
      return [rail, sealedFrozen];
    })()],
    ['no capabilityManifestHash at all', (() => {
      const { capabilityManifestHash: _dropped, ...rail } = railBase;
      return [rail, sealedFrozen];
    })()],
    ['neither identity stated', (() => {
      const { bundleHash: _b, capabilityManifestHash: _m, ...rail } = railBase;
      return [rail, sealedFrozen];
    })()],
    ['a bundle borrowed from the manifest identity', [
      { ...railBase, bundleHash: MANIFEST_HASH }, sealedFrozen,
    ]],
    ['a bundle borrowed from the attestation namespace', [
      { ...railBase, bundleHash: sealedFrozen.capabilityAttestationHashes[0] },
      { ...sealedFrozen, capabilityManifestHashes: [
        MANIFEST_HASH, sealedFrozen.capabilityAttestationHashes[0],
      ] },
    ]],
    ['a bundle the run never sealed', [
      { ...railBase, bundleHash: sha256Of('a bundle that never existed') }, sealedFrozen,
    ]],
    ['frozen inputs that seal a DIFFERENT tool profile', [
      railBase,
      { ...sealedFrozen, providerToolProfileHash: sha256Of('another tool profile') },
    ]],
  ];

  for (const [label, [rail, frozenInputs]] of refusals) {
    await assert.rejects(
      () => runLocal(rail, frozenInputs, `run_r4c1_${sha256Of(label).slice(7, 19)}`),
      /AUDIT_PREFLIGHT_FAILED_PROVIDER_CONFIG|AUDIT_INTEGRITY_FAILURE|AUDIT_QUARANTINED/u,
      `${label}: the composition root built the rail anyway`,
    );
  }
});

// ===========================================================================
// ROUND 5 — external-contract sweep. One test per canary blocker / silent drop.
// Every expectation below is derived from the internal MCP server source, cited inline.
// APPENDED ONLY: nothing above this line is altered.
// ===========================================================================

/**
 * The same construction `makeAdapter` performs, but with the constructor options open so a test
 * can pass `pseudonymKey` (R4-I2). It exists rather than widening `makeAdapter` because this
 * suite is append-only.
 */
function round5Adapter({ responses = evidenceResponses(), calls = [], adapterOptions = {} } = {}) {
  return createInternalGhlAdapter({
    client: fakeAuditMcpClient({ responses, calls }),
    expectedContractVersion: '1.0.0',
    expectedLocationId: LOCATION_ID,
    expectedToolProfileHash: TOOL_PROFILE_HASH,
    capabilityProofIndex: makeProofIndex(),
    runtime: { now: () => Date.parse(NOW_ISO) },
    ...adapterOptions,
  });
}

const round5Collect = (options = {}, request = {}) => round5Adapter(options).collectAuditEvidence({
  target: TARGET,
  window: WINDOW,
  applicability: { capabilityIds: APPLICABLE_CAPABILITIES },
  stepRosterRequests: {},
  ...request,
});

const RUNTIME_EVENT = (over = {}) => ({
  id: 'E1',
  timestamp: RUNTIME.window.fromDate + 1000,
  timestampField: 'startedExecutionAt',
  unreadableTimestampFields: [],
  event: { _id: 'E1', stepId: 'S1' },
  ...over,
});

// ---------------------------------------------------------------------------
// BLOCKER B — logPartitions terminality is the FULL BINARY TREE identity, not equality.
// core/workflow-runtime-window.mjs:998-999 (terminal++ only on a short page, LOG_PAGE_SIZE=20
// at :88), :1014-1016 (a saturated partition splits into two children), :961 (attempted++ on
// every visit), :1022 (one walk per requested eventType, and this adapter requests none).
// ---------------------------------------------------------------------------

test('a split log partition walk is terminal, and a flat equal ledger on a split walk is not', async () => {
  const ledger = (logPartitions) => ({
    logPartitions,
    enrollmentPages: { fetched: 1, exhausted: false, budget: 200 },
    stepRosterPages: { fetched: 0, exhausted: false, budget: 200 },
  });

  // One split: root + two short children. 3 nodes, 2 leaves — 2*2-1 === 3.
  const split = await round5Collect({
    responses: evidenceResponses({
      runtimeOver: { pagination: ledger({ attempted: 3, terminal: 2, exhausted: false, budget: 256 }) },
    }),
  });
  assert.equal(split.complete, true, 'a workflow with more than 20 log rows returned Partial');
  assert.equal(workflowRecord(split, 'WF1').complete, true);
  assert.equal(workflowRecord(split, 'WF1').runtime.pagination.logPartitions.terminal, 2);

  // Two splits down one side: 5 nodes, 3 leaves — 2*3-1 === 5.
  const deeper = await round5Collect({
    responses: evidenceResponses({
      runtimeOver: { pagination: ledger({ attempted: 5, terminal: 3, exhausted: false, budget: 256 }) },
    }),
  });
  assert.equal(deeper.complete, true);

  // The single-partition case the old rule was written for still passes.
  const flat = await round5Collect({
    responses: evidenceResponses({
      runtimeOver: { pagination: ledger({ attempted: 1, terminal: 1, exhausted: false, budget: 256 }) },
    }),
  });
  assert.equal(flat.complete, true);

  // STRICTLY STRONGER than the rule it replaces: a ledger claiming every visited partition was
  // terminal is impossible on a walk that visited more than one, and is now refused.
  for (const impossible of [
    { attempted: 3, terminal: 3, exhausted: false, budget: 256 },
    { attempted: 2, terminal: 2, exhausted: false, budget: 256 },
    { attempted: 4, terminal: 2, exhausted: false, budget: 256 },
    { attempted: 0, terminal: 0, exhausted: false, budget: 256 },
  ]) {
    const bad = await round5Collect({
      responses: evidenceResponses({ runtimeOver: { pagination: ledger(impossible) } }),
    });
    assert.equal(bad.complete, false, JSON.stringify(impossible));
    assert.equal(
      workflowRecord(bad, 'WF1').incompleteReason,
      'runtime_log_partitions_incomplete',
      JSON.stringify(impossible),
    );
  }
});

// ---------------------------------------------------------------------------
// BLOCKER C — an ABSENT AI total is legal. core/audit-configuration.mjs:427-430 (readTotal
// returns null for an absent or non-numeric root total), :1279-1286 (reconciled=true anyway),
// :1230-1236 (whether GHL emits `total` on these routes is UNVERIFIED).
// ---------------------------------------------------------------------------

test('an AI surface that reports no total at all is complete, including on an empty account', async () => {
  const withNullTotals = (scenarioName) => {
    const components = structuredClone(AI_BUNDLES[scenarioName].components);
    for (const component of Object.values(components)) component.totalHistory = [null];
    return components;
  };

  // Zero agents and no total: `null !== 0` used to fail this outright.
  const empty = await round5Collect({
    responses: evidenceResponses({ ai: 'terminal-empty', aiOver: { components: withNullTotals('terminal-empty') } }),
  });
  assert.equal(empty.complete, true, 'an account with no AI agents and no total returned Partial');
  for (const surface of ['conversation_ai', 'voice_ai', 'agent_studio']) {
    const component = empty.aiConfiguration.components[surface];
    assert.equal(component.complete, true, surface);
    assert.equal(component.reason, null, surface);
    // The unknown is DECLARED rather than implied.
    assert.equal(component.reportedTotal, null, surface);
  }

  // Agents present and no total: same verdict.
  const populated = await round5Collect({
    responses: evidenceResponses({ ai: 'complete', aiOver: { components: withNullTotals('complete') } }),
  });
  assert.equal(populated.complete, true);
  assert.equal(populated.aiConfiguration.components.conversation_ai.reportedTotal, null);

  // A total that IS present must still agree with the rows served.
  const lying = structuredClone(AI_BUNDLES.complete.components);
  lying.conversation_ai.totalHistory = [7];
  const disagreeing = await round5Collect({
    responses: evidenceResponses({ ai: 'complete', aiOver: { components: lying } }),
  });
  assert.equal(disagreeing.complete, false, 'a present total that disagrees was accepted');
  assert.equal(disagreeing.aiConfiguration.components.conversation_ai.reason, 'ai_total_mismatch');
  // And the honest reconciled total is still published when one arrived.
  const healthy = await round5Collect({ responses: evidenceResponses({ ai: 'complete' }) });
  assert.equal(healthy.aiConfiguration.components.conversation_ai.reportedTotal, 1);
});

// ---------------------------------------------------------------------------
// BLOCKER D — the tombstone rule is scoped to voice_ai. core/audit-configuration.mjs:215
// (tombstonesApply on voice_ai only) and :1212 (tombstone = tombstonesApply && grade).
// ---------------------------------------------------------------------------

test('a soft deleted row on a surface the server does not tombstone is an ordinary agent', async () => {
  // `complete` carries no Agent Studio row, so that surface borrows the scenario that does.
  for (const [surface, base] of [
    ['conversation_ai', 'complete'],
    ['agent_studio', 'voice-tombstone-confirmed'],
  ]) {
    const components = structuredClone(AI_BUNDLES[base].components);
    const component = components[surface];
    // Both deletion signals, on a surface whose descriptor carries no `tombstonesApply`. The
    // server therefore publishes `tombstone: false` and counts the row in the denominator.
    component.items[0].row.isDeleted = true;
    component.items[0].row.agentStatus = 'INACTIVE';
    component.items[0].tombstone = false;

    const resolved = await round5Collect({
      responses: evidenceResponses({ ai: base, aiOver: { components } }),
    });
    assert.equal(resolved.complete, true, `${surface} failed on a scoped-out tombstone`);
    const projected = resolved.aiConfiguration.components[surface];
    assert.equal(projected.reason, null, surface);
    assert.equal(projected.complete, true, surface);
    assert.equal(projected.items[0].tombstoneProven, false, surface);
    assert.equal(projected.items[0].detailRequired, true, surface);
    assert.equal(projected.detailDenominator, 1, surface);
  }

  // voice_ai keeps the rule, in BOTH directions.
  const confirmed = await round5Collect({ responses: evidenceResponses({ ai: 'voice-tombstone-confirmed' }) });
  assert.equal(confirmed.complete, true);
  const voice = confirmed.aiConfiguration.components.voice_ai;
  assert.equal(voice.items[1].tombstoneProven, true, 'voice_ai stopped recognising its own tombstone');
  assert.equal(voice.items[1].detailRequired, false);

  // A voice row the server calls a tombstone on ONE signal is still a contradiction.
  const halfSignalled = await round5Collect({ responses: evidenceResponses({ ai: 'voice-tombstone-deleted-only' }) });
  assert.equal(halfSignalled.complete, false);
  assert.equal(halfSignalled.aiConfiguration.components.voice_ai.reason, 'ai_tombstone_unproven');
});

// ---------------------------------------------------------------------------
// BLOCKER E — pre-scrub hash vs post-scrub bytes. The server hashes the UNSCRUBBED triple at
// core/workflow-runtime-window.mjs:854 and then scrubs the whole result through
// core/tools.mjs:1038 -> core/errors.mjs:168 `ok()` -> `scrubSecrets` (:148-165), whose four
// replacement paths all leave the literal `<redacted>` behind (:108-131).
// ---------------------------------------------------------------------------

test('a definition the server scrubbed after hashing is verified against the export, not failed', async () => {
  const buildDefinition = (mutate) => {
    const source = structuredClone(DEFINITIONS.WF1);
    mutate(source.workflow);
    return source;
  };
  const scenarioFor = (source) => ({
    runtimeByWorkflow: { WF1: 'complete-no-step-rosters', WF2: 'complete-no-step-rosters' },
    runtimeOptions: {
      WF1: {
        over: {
          workflowDefinition: {
            workflow: source.workflow,
            triggers: source.triggers,
            stickyNotes: source.stickyNotes,
            version: source.version,
            hashAlgorithm: 'sha256',
            // The PRE-scrub digest, exactly as the server computed it before `ok()` ran.
            canonicalHash: DEFINITIONS.WF1.canonicalHash,
            capturedAt: source.capturedAt,
            validity: {
              effectiveFrom: null,
              effectiveTo: null,
              source: null,
              provenEffectiveInterval: false,
              appliesToRequestedWindow: 'unproven',
            },
          },
        },
      },
    },
    // The export route is scrubbed by the SAME function over the SAME upstream content.
    exportByWorkflow: {
      WF1: okBody({
        workflow: source.workflow,
        triggers: source.triggers,
        stickyNotes: source.stickyNotes,
      }),
    },
  });

  // A webhook step whose Authorization header the server replaced. The declared digest can
  // never be reproduced from these bytes, and that is not the workflow's fault.
  const scrubbed = buildDefinition((workflow) => {
    workflow.workflowData.templates[0].headers = { Authorization: '<redacted>' };
  });
  const resolved = await round5Collect({ responses: evidenceResponses(scenarioFor(scrubbed)) });
  assert.equal(resolved.complete, true, 'a scrubbed webhook step failed the whole workflow');
  const record = workflowRecord(resolved, 'WF1');
  assert.equal(record.complete, true);
  assert.equal(record.definition.hashVerification, 'scrub_explained');
  // The server's own digest is still what the artefact publishes — it is the stable identity.
  assert.equal(record.definition.definitionHash, DEFINITIONS.WF1.canonicalHash);

  // An unscrubbed run still reports the STRONGER verdict, so the two are distinguishable.
  const exact = await round5Collect({ responses: evidenceResponses() });
  assert.equal(workflowRecord(exact, 'WF1').definition.hashVerification, 'exact');

  // A real mismatch with no scrub sentinel anywhere still fails, exactly as before.
  const tampered = buildDefinition((workflow) => {
    workflow.workflowData.templates[0].headers = { Authorization: 'left in the clear' };
  });
  const rejected = await round5Collect({ responses: evidenceResponses(scenarioFor(tampered)) });
  assert.equal(rejected.complete, false, 'an unexplained hash mismatch was accepted');
  assert.equal(workflowRecord(rejected, 'WF1').incompleteReason, 'definition_hash_mismatch');

  // And a scrubbed block whose two independent reads DISAGREE is still refused: the sentinel
  // buys an alternative verification, never a free pass.
  const divergentExport = buildDefinition((workflow) => {
    workflow.workflowData.templates[0].headers = { Authorization: '<redacted>' };
  });
  const divergent = evidenceResponses(scenarioFor(scrubbed));
  divergent.export_workflow = (request) => (request.arguments.workflowId === 'WF1'
    ? okBody({
      workflow: { ...divergentExport.workflow, name: 'a different workflow entirely' },
      triggers: divergentExport.triggers,
      stickyNotes: divergentExport.stickyNotes,
    })
    : okBody(exportBody(request.arguments.workflowId)));
  const mismatched = await round5Collect({ responses: divergent });
  assert.equal(mismatched.complete, false, 'a scrubbed block with disagreeing reads was accepted');
  assert.equal(workflowRecord(mismatched, 'WF1').incompleteReason, 'definition_export_mismatch');
});

// ---------------------------------------------------------------------------
// BLOCKER F — a COMPLETE step roster may carry `total: null`.
// core/workflow-runtime-window.mjs:1180 (complete starts true), :1216-1217 (total set only
// from a finite totalCount), :1236-1237 (a short page with no total is terminal on its own).
// ---------------------------------------------------------------------------

test('a step roster the upstream gave no total for is still complete', async () => {
  const resolved = await round5Collect({
    responses: evidenceResponses({
      runtimeByWorkflow: { WF1: 'complete', WF2: 'complete-no-step-rosters' },
      runtimeOptions: {
        WF1: {
          over: {
            stepRosters: [
              { stepId: 'S1', contacts: [{ id: 'C1' }], total: null, complete: true, pages: 1 },
            ],
          },
        },
      },
    }),
  }, { stepRosterRequests: { WF1: ['S1'] } });
  assert.equal(resolved.complete, true, 'an unreadable totalCount failed a complete roster');
  const roster = workflowRecord(resolved, 'WF1').runtime.stepRosters[0];
  assert.equal(roster.total, null, 'the honest null was coerced');
  assert.equal(roster.complete, true);

  // A reported total that the rows exceed is still a contradiction.
  const overrun = await round5Collect({
    responses: evidenceResponses({
      runtimeByWorkflow: { WF1: 'complete', WF2: 'complete-no-step-rosters' },
      runtimeOptions: {
        WF1: {
          over: {
            stepRosters: [
              { stepId: 'S1', contacts: [{ id: 'C1' }, { id: 'C2' }], total: 1, complete: true, pages: 1 },
            ],
          },
        },
      },
    }),
  }, { stepRosterRequests: { WF1: ['S1'] } });
  assert.equal(overrun.complete, false);
  assert.equal(workflowRecord(overrun, 'WF1').incompleteReason, 'runtime_step_roster_total_mismatch');
});

// ---------------------------------------------------------------------------
// SILENT DROP 1 — `added_to_workflow` is "the ONLY proof a trigger fired"
// (core/tools.mjs:974, repeated at :1705 and :1916) and was discarded by the 24-character /
// one-separator token bound.
// ---------------------------------------------------------------------------

test('the trigger firing vocabulary survives and an unrecognised token is named rather than vanishing', async () => {
  const events = [
    RUNTIME_EVENT({ id: 'E1', event: { _id: 'E1', stepId: 'S1', eventType: 'added_to_workflow' } }),
    RUNTIME_EVENT({
      id: 'E2',
      timestamp: RUNTIME.window.fromDate + 2000,
      event: { _id: 'E2', stepId: 'S2', eventType: 'waiting_on_action', status: 'sent' },
    }),
    RUNTIME_EVENT({
      id: 'E3',
      timestamp: RUNTIME.window.fromDate + 3000,
      event: { _id: 'E3', stepId: 'S3', eventType: 'action_skipped_by_filter' },
    }),
    RUNTIME_EVENT({
      id: 'E4',
      timestamp: RUNTIME.window.fromDate + 4000,
      event: {
        _id: 'E4',
        stepId: 'S1',
        eventType: R3_PAYLOADS.privateSentence,
        outcome: R3_PAYLOADS.personName,
      },
    }),
  ];
  const resolved = await round5Collect({
    responses: evidenceResponses({
      runtimeOptions: { WF1: { events } },
    }),
  });
  assert.equal(resolved.complete, true);
  const record = workflowRecord(resolved, 'WF1');

  assert.equal(
    eventRecord(record, 'E1').event.eventType,
    'added_to_workflow',
    'the audit still cannot see a trigger firing',
  );
  assert.equal(eventRecord(record, 'E2').event.eventType, 'waiting_on_action');
  assert.equal(eventRecord(record, 'E2').event.status, 'sent', 'the narrow token grammar regressed');
  assert.equal(eventRecord(record, 'E3').event.eventType, 'action_skipped_by_filter');
  for (const id of ['E1', 'E2', 'E3']) {
    assert.equal(
      Object.hasOwn(eventRecord(record, id).event, 'unrecognisedFields'),
      false,
      `${id} was bucketed despite being in vocabulary`,
    );
  }

  // The private payloads are still refused — the vocabulary widened, the grammar did not.
  const bucketed = eventRecord(record, 'E4').event;
  assert.equal(Object.hasOwn(bucketed, 'eventType'), false, 'a private sentence survived');
  assert.equal(Object.hasOwn(bucketed, 'outcome'), false, 'a person name survived');
  // ...but the drop is no longer silent.
  assert.deepEqual(bucketed.unrecognisedFields, ['eventType', 'outcome']);
  assertNoR3Payload(resolved, 'the widened event vocabulary');

  // The bucket is a FIELD-NAME list, never a synthetic value in a claim field, so the
  // public/internal contradiction detector cannot be fed an outcome that never happened.
  assert.equal(JSON.stringify(resolved).includes('"outcome":"unrecognised"'), false);
  assert.equal(JSON.stringify(resolved).includes('"status":"unrecognised"'), false);
});

// ---------------------------------------------------------------------------
// SILENT DROP 2 + 3 — the enrollment cursor. Page one is always `action:'first'` with no
// cursor keys (core/workflow-runtime-window.mjs:1074-1086, cursor assigned at :1085 only when
// non-null, `action='next'` at :1147); every cursor value is String()-coerced at :1326-1329.
// ---------------------------------------------------------------------------

test('the enrollment cursor is read from the page that carried one and an epoch is kept as an instant', async () => {
  const appliedQueries = (cursor) => ([
    { capabilityId: 'workflow_execution_logs', query: { limit: '20' } },
    {
      capabilityId: 'workflow_enrollment_search',
      // Page one, exactly as the server emits it: no cursor key of any kind.
      query: { action: 'first', limit: '20', fromDate: String(RUNTIME.window.fromDate), toDate: String(RUNTIME.window.toDate) },
    },
    {
      capabilityId: 'workflow_enrollment_search',
      query: { action: 'next', limit: '20', ...cursor },
    },
  ]);

  const isoCursor = await round5Collect({
    responses: evidenceResponses({
      runtimeOver: {
        appliedQueries: appliedQueries({
          referenceId: 'EN9',
          referenceCreatedAt: '2026-07-14T09:00:00.000Z',
          referenceSid: 'SID9',
          referenceSequence: '4',
        }),
      },
    }),
  });
  assert.equal(isoCursor.complete, true);
  assert.deepEqual(
    workflowRecord(isoCursor, 'WF1').runtime.enrollmentCursor,
    {
      referenceId: 'EN9',
      referenceCreatedAt: '2026-07-14T09:00:00.000Z',
      referenceSid: 'SID9',
      referenceSequence: '4',
    },
    'the cursor tuple is still never captured',
  );

  // A 13-digit epoch, String()-coerced by the server. It is retained AS AN INSTANT, so the
  // evidence survives and no bare digit run reaches the artefact.
  const epochMs = Date.parse('2026-07-14T09:00:00.000Z');
  const epochCursor = await round5Collect({
    responses: evidenceResponses({
      runtimeOver: {
        appliedQueries: appliedQueries({ referenceId: 'EN9', referenceCreatedAt: String(epochMs) }),
      },
    }),
  });
  const captured = workflowRecord(epochCursor, 'WF1').runtime.enrollmentCursor;
  assert.equal(captured.referenceCreatedAt, '2026-07-14T09:00:00.000Z');
  assert.equal(JSON.stringify(epochCursor).includes(String(epochMs)), false, 'a bare digit run was echoed');

  // A walk that never paged still reports no cursor rather than inventing one.
  const singlePage = await round5Collect({
    responses: evidenceResponses({
      runtimeOver: {
        appliedQueries: [
          {
            capabilityId: 'workflow_enrollment_search',
            query: { action: 'first', limit: '20' },
          },
        ],
      },
    }),
  });
  assert.equal(workflowRecord(singlePage, 'WF1').runtime.enrollmentCursor, null);
});

// ---------------------------------------------------------------------------
// SILENT DROP 4 — `enrollmentTotals.source` is nullable.
// core/workflow-runtime-window.mjs:1271/:1279/:1284 leave `statsSource` null when neither
// totals route returned a usable total, and :1289 assigns it straight through.
// ---------------------------------------------------------------------------

test('an enrollment totals source of null is retained rather than dropped to an absent key', async () => {
  const resolved = await round5Collect({
    responses: evidenceResponses({
      runtimeByWorkflow: { WF1: 'complete', WF2: 'complete-no-step-rosters' },
      runtimeOptions: {
        WF1: {
          over: {
            enrollmentTotals: { total: 12, finished: 9, source: null, scope: 'workflow_all_time' },
          },
        },
      },
    }),
  });
  assert.equal(resolved.complete, true);
  const totals = workflowRecord(resolved, 'WF1').runtime.enrollmentTotals;
  assert.equal(Object.hasOwn(totals, 'source'), true, 'no usable source is indistinguishable from an absent key');
  assert.equal(totals.source, null);
  assert.equal(totals.scope, 'workflow_all_time');

  // A real source still travels, and a sentence in that position is still refused.
  const healthy = await round5Collect({
    responses: evidenceResponses({ runtimeByWorkflow: { WF1: 'complete', WF2: 'complete-no-step-rosters' } }),
  });
  assert.equal(
    workflowRecord(healthy, 'WF1').runtime.enrollmentTotals.source,
    'workflow_enroll_stats_cache',
  );
});

// ---------------------------------------------------------------------------
// R4-I1 — the roster row's `status` case. core/audit-capabilities.mjs:84 is a REQUEST-side
// allow list; the response vocabulary's case is undetermined and the two live samples disagree
// (core/tools.mjs:1899 lower case round trip vs tests/fixtures/legacy/workflow-capture/
// workflow.json:5 `"PUBLISHED"`).
// ---------------------------------------------------------------------------

test('an upper case workflow status reads instead of silently becoming null', async () => {
  const captured = JSON.parse(readFileSync(
    join(HERE, 'fixtures', 'legacy', 'workflow-capture', 'workflow.json'),
    'utf8',
  ));
  assert.equal(captured.status, 'PUBLISHED', 'the live capture fixture drifted');

  const resolved = await round5Collect({
    responses: evidenceResponses({
      rosterOver: {
        workflows: [
          { id: 'WF1', name: '01 Meta Lead Intake', status: captured.status, version: 4 },
          { id: 'WF2', name: '02 Nurture', status: 'Draft', version: 2 },
        ],
      },
    }),
  });
  assert.equal(resolved.complete, true);
  assert.equal(workflowRecord(resolved, 'WF1').status, 'published', 'every live status became null');
  assert.equal(workflowRecord(resolved, 'WF2').status, 'draft');

  // The lower-case form the publish round trip compares against still reads.
  const lower = await round5Collect({ responses: evidenceResponses() });
  assert.equal(workflowRecord(lower, 'WF1').status, 'published');

  // The vocabulary is unchanged: only the CASE widened. A private path in this field is still
  // dropped to null rather than bucketed into a value a reader could mistake for a status.
  const poisoned = await round5Collect({
    responses: evidenceResponses({
      rosterOver: {
        workflows: [
          { id: 'WF1', name: '01 Meta Lead Intake', status: '/Users/uxie/.ghl/token.json', version: 4 },
          { id: 'WF2', name: '02 Nurture', status: 'ARCHIVED_BY_JANE_DOE', version: 2 },
        ],
      },
    }),
  });
  assert.equal(workflowRecord(poisoned, 'WF1').status, null);
  assert.equal(workflowRecord(poisoned, 'WF2').status, null);
  assert.equal(JSON.stringify(poisoned).includes('token.json'), false);
});

// ---------------------------------------------------------------------------
// R4-I2 — the pseudonym key contract.
// ---------------------------------------------------------------------------

test('an injected pseudonym key makes the run reproducible and its absence is declared', async () => {
  const responsesFor = () => evidenceResponses({
    runtimeByWorkflow: { WF1: 'complete', WF2: 'complete-no-step-rosters' },
  });
  const rowIdOf = (result) => workflowRecord(result, 'WF1').runtime.enrollments.rows[0]._id;

  const key = Buffer.alloc(32, 7);
  const first = await round5Collect({ responses: responsesFor(), adapterOptions: { pseudonymKey: key } });
  const second = await round5Collect({
    responses: responsesFor(),
    adapterOptions: { pseudonymKey: Buffer.from(key) },
  });
  assert.equal(first.complete, true);
  assert.match(rowIdOf(first), /^psn_[a-f0-9]{32}$/u);
  assert.equal(rowIdOf(first), rowIdOf(second), 'two runs over identical bytes disagreed');
  // Whole-artefact reproducibility, which is what the kernel hashes into its checkpoint input.
  assert.equal(sha256(first), sha256(second), 'the internal evidence artefact is not reproducible');
  assert.deepEqual(first.pseudonymBinding, { keySource: 'injected', stableAcrossRuns: true });

  // A different key pseudonymises differently, so the value really is keyed.
  const other = await round5Collect({
    responses: responsesFor(),
    adapterOptions: { pseudonymKey: Buffer.alloc(32, 9) },
  });
  assert.notEqual(rowIdOf(first), rowIdOf(other));

  // With no key the adapter still runs, but says so: an ephemeral run cannot be joined to
  // last week's, and a consumer must be able to see that rather than assume it.
  const ephemeral = await round5Collect({ responses: responsesFor() });
  assert.deepEqual(ephemeral.pseudonymBinding, { keySource: 'ephemeral', stableAcrossRuns: false });
  const ephemeralAgain = await round5Collect({ responses: responsesFor() });
  assert.notEqual(rowIdOf(ephemeral), rowIdOf(ephemeralAgain));

  // A key that is PRESENT but too weak is a caller error, never a silent downgrade to random.
  for (const weak of ['short', Buffer.alloc(16, 1), 42, {}]) {
    assert.throws(
      () => round5Adapter({ adapterOptions: { pseudonymKey: weak } }),
      /INTERNAL_AUDIT_REQUEST_INVALID/u,
      JSON.stringify(String(weak)),
    );
  }
  // The key itself never reaches the artefact.
  assert.equal(JSON.stringify(first).includes(key.toString('hex')), false);
  assert.equal(JSON.stringify(first).includes(key.toString('utf8')), false);
});

// ---------------------------------------------------------------------------
// R4-I3 — the undeclared gap above 15 digits. A 16+ digit all-numeric value is PAN-length and
// is seen by neither PRIVATE_VALUE_PATTERNS nor artifacts.mjs `PHONE`.
// ---------------------------------------------------------------------------

test('a bare digit run longer than fifteen digits is refused in every id position', async () => {
  const PAN = '4539578763621486';       // 16 digits — a Luhn-valid test PAN
  const LONGER = '453957876362148612';  // 18 digits
  assert.equal(PAN.length, 16);

  const events = [
    RUNTIME_EVENT({ id: 'E1', event: { _id: 'E1', stepId: 'S1', contactId: PAN } }),
    RUNTIME_EVENT({
      id: 'E2',
      timestamp: RUNTIME.window.fromDate + 2000,
      event: { _id: LONGER, stepId: PAN },
    }),
  ];
  const resolved = await round5Collect({
    responses: evidenceResponses({ runtimeOptions: { WF1: { events } } }),
  });
  assert.equal(resolved.complete, true);
  const record = workflowRecord(resolved, 'WF1');
  assert.equal(Object.hasOwn(eventRecord(record, 'E1').event, 'contactId'), false, 'a PAN reached a healthy result');
  assert.equal(Object.hasOwn(eventRecord(record, 'E2').event, '_id'), false);
  assert.equal(Object.hasOwn(eventRecord(record, 'E2').event, 'stepId'), false);
  const encoded = JSON.stringify(resolved);
  for (const digits of [PAN, LONGER]) {
    assert.equal(encoded.includes(digits), false, `${digits} escaped into the result`);
  }

  // The declared id vocabulary is otherwise untouched: hex ObjectIds, nanoids, qualified forms
  // and UUIDs all still read.
  const stillValid = await round5Collect({
    responses: evidenceResponses({
      runtimeOptions: {
        WF1: {
          events: [
            RUNTIME_EVENT({
              id: 'E1',
              event: {
                _id: '68a1f2c4b9d3e17a2c4f8b91',
                stepId: 'WF1_V5',
                contactId: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
              },
            }),
          ],
        },
      },
    }),
  });
  const kept = eventRecord(workflowRecord(stillValid, 'WF1'), 'E1').event;
  assert.equal(kept._id, '68a1f2c4b9d3e17a2c4f8b91');
  assert.equal(kept.stepId, 'WF1_V5');
  assert.equal(kept.contactId, '3f2504e0-4f89-11d3-9a0c-0305e82c3301');
});

// ---------------------------------------------------------------------------
// 66 — R4-C1 driven end to end through the REAL kernel
// ---------------------------------------------------------------------------

test('a chain built only from public constants cannot reach full through the real kernel', async () => {
  // Round 4's exact attack: the REAL checked-in manifest, the six PUBLIC tool names, receipts
  // and an attestation minted here with `approver: 'nobody'`, and
  // `capabilityProofIndex.bundleHash = MANIFEST_HASH` — every value an outsider can compute.
  // The run seals only what an honest operator would know.
  const borrowedBundleChain = makeProofIndex({
    bundleHash: MANIFEST_HASH,
    attestation: makeAttestation({ bundleHash: MANIFEST_HASH, approver: 'nobody' }),
  });

  // 1. CONTROL — the honest chain still publishes Full end to end, so the path is alive.
  await withProjectRoot(async (projectRoot) => {
    const harness = r3FullKernel({ runId: 'run_r4c1_control' });
    const result = await harness.start(projectRoot);
    assert.equal(result.status, 'complete_full', 'the honest control run never reached Full');
    assert.equal(harness.publisherArgs.length, 1);
    assert.equal(
      harness.publisherArgs[0].payloadArtifacts['coverage.json'].state,
      'complete_full',
    );
  });

  // 2. THE ATTACK — the bundle identity is the manifest digest, a public derivable constant
  //    that the run really did seal, but as the MANIFEST identity. It anchors nothing.
  for (const [label, internalIdentities] of [
    ['caller restates the borrowed identities', {
      contractVersion: '1.0.0',
      toolProfileHash: TOOL_PROFILE_HASH,
      capabilityManifestHash: MANIFEST_HASH,
      bundleHash: MANIFEST_HASH,
    }],
    ['caller states nothing', {}],
  ]) {
    await withProjectRoot(async (projectRoot) => {
      const runId = `run_r4c1_${sha256Of(label).slice(7, 19)}`;
      const harness = r3FullKernel({
        runId,
        proofIndex: borrowedBundleChain,
        internalIdentities,
      });
      await assert.rejects(
        () => harness.start(projectRoot),
        /AUDIT_INTEGRITY_FAILURE|AUDIT_QUARANTINED/u,
        `${label}: a borrowed bundle identity published through the real kernel`,
      );
      assert.deepEqual(harness.publisherArgs, [], `${label}: the publisher saw a Full run`);
      const state = openState({ projectRoot, locationId: LOCATION_ID });
      try {
        assert.equal(state.getRun(runId).status, 'quarantined', label);
      } finally {
        state.close();
      }
    });
  }
});

// ===========================================================================
// ROUND 5 — R4-C1 RESIDUAL. Slot discipline is not proof of a canary.
//
// Layers 1 (namespace separation) and 2 (own sealed slot + distinctness) are unconditional and
// closed both demonstrated attacks, but neither is PROVENANCE: the manifest digest is checked
// in, the tool-profile digest is the digest of six public tool names, and the bundle digest is
// a build artefact an honest operator seals. An attacker who knows all three could mint a chain
// binding exactly those, withhold the proof-chain document at the gate, and anchor by slot
// discipline alone — because layer 3 engaged only when a document happened to arrive.
//
// Layer 3 is unconditional now, and the preimage relation is checked where the document
// actually lives: the adapter publishes `governingAttestationHashes`, the hashes
// `attestationIsSound` ACCEPTED, and the gate requires one of them to be SEALED.
// APPENDED ONLY: nothing above this line is altered.
// ===========================================================================

/** A chain that is internally perfect and binds the three HONEST, public identities. */
const r5MintedHonestChain = () => makeProofIndex({
  attestation: makeAttestation({
    approver: 'nobody',
    targetHash: sha256Of('a canary that never ran'),
  }),
});

// ---------------------------------------------------------------------------
// 67 — R4-C1 residual: an identity is anchored by SEALED PROVENANCE or not at all
// ---------------------------------------------------------------------------

test('slot discipline alone can never anchor an identity', async () => {
  const evaluateFullEligibility = requireExport('evaluateFullEligibility');
  const sealedInputs = r3FrozenInputs();
  const honestAttestation = makeAttestation();
  assert.deepEqual(
    sealedInputs.capabilityAttestationHashes,
    [honestAttestation.attestationHash],
    'the run seals exactly the honest canary attestation',
  );

  const evidenceFor = (capabilityProofIndex) => collectFor({
    responses: evidenceResponses({ ai: 'all-surfaces-complete' }),
    capabilityProofIndex,
  }).result;
  const base = await healthyEligibilityInputs();
  const decideOn = async (internalEvidence, over = {}) => evaluateFullEligibility({
    ...base,
    internalEvidence,
    merge: (await mergeFor({ internalEvidence })).result,
    expected: { locationId: LOCATION_ID },
    frozenInputs: sealedInputs,
    ...over,
  });

  // ---- THE CONTROL: a genuine sealed governing attestation ----------------
  // The honest run NAMES the attestation the adapter validated, that hash is the one the run
  // sealed, and the decision is Full. Every refusal below therefore differs from a Full run in
  // exactly one respect — the provenance — so the path is refused, never dead.
  const honestEvidence = await evidenceFor(makeProofIndex());
  assert.deepEqual(
    honestEvidence.governingAttestationHashes,
    [honestAttestation.attestationHash],
    'the adapter did not publish the attestation it accepted',
  );
  const control = await decideOn(honestEvidence);
  assert.equal(control.status, 'complete_full', 'a genuine sealed governing attestation is not Full');
  assert.equal(gateFor(control, 'live_runtime_receipts').passed, true);
  assert.equal(limitationCodes(control).includes('INTERNAL_AUDIT_PROOF_UNANCHORED'), false);
  // The same run with the DOCUMENT also supplied is Full too: the stronger reading agrees.
  const withDocument = await decideOn(honestEvidence, {
    expected: { ...EXPECTED_IDENTITIES, capabilityProofIndex: makeProofIndex() },
  });
  assert.equal(withDocument.status, 'complete_full', 'the document path disagreed with the seal');

  // ---- THE RESIDUAL: honest identities, self-minted chain, NO document ----
  const mintedEvidence = await evidenceFor(r5MintedHonestChain());
  // It is otherwise a perfectly healthy run: complete, 16/16 proven live, and every identity it
  // declares is BYTE-IDENTICAL to one this run sealed, so layers 1 and 2 are fully satisfied.
  assert.equal(mintedEvidence.complete, true, 'the residual attack evidence is not healthy');
  assert.equal(mintedEvidence.toolProfileHash, TOOL_PROFILE_HASH);
  assert.equal(mintedEvidence.capabilityManifestHash, MANIFEST_HASH);
  assert.equal(mintedEvidence.bundleHash, BUNDLE_HASH);
  assert.equal(sealedInputs.providerToolProfileHash, TOOL_PROFILE_HASH);
  assert.ok(sealedInputs.capabilityManifestHashes.includes(MANIFEST_HASH));
  assert.ok(sealedInputs.capabilityManifestHashes.includes(BUNDLE_HASH));
  for (const capabilityId of APPLICABLE_CAPABILITIES) {
    assert.equal(coverageFor(mintedEvidence, capabilityId).proven, true, capabilityId);
    assert.equal(coverageFor(mintedEvidence, capabilityId).proofClass, 'live_runtime', capabilityId);
  }
  // And the one thing it cannot produce: an attestation whose hash the run sealed.
  assert.equal(mintedEvidence.governingAttestationHashes.length, 1);
  assert.equal(
    sealedInputs.capabilityAttestationHashes.includes(mintedEvidence.governingAttestationHashes[0]),
    false,
    'the minted attestation hash was somehow sealed',
  );

  const refusals = [
    // 1. The residual itself: honest identities, a chain minted here, no document offered.
    ['a self-minted chain with no document supplied', mintedEvidence, {}],
    // 2. The same evidence, now also RESTATING the honest digests. Restating proves nothing.
    ['a self-minted chain whose identities the caller restates', mintedEvidence, {
      expected: EXPECTED_IDENTITIES,
    }],
    // 3. The document offered as well — held to the stronger reading, still refused.
    ['a self-minted chain offered at the gate', mintedEvidence, {
      expected: { ...EXPECTED_IDENTITIES, capabilityProofIndex: r5MintedHonestChain() },
    }],
    // 4. An honest chain whose attestations this run never sealed.
    ['a chain whose attestations are unsealed', honestEvidence, {
      frozenInputs: r3FrozenInputs({
        capabilityAttestationHashes: [sha256Of('an attestation this run never sealed')],
      }),
    }],
    // 5. An attestation that binds DIFFERENT identities is never accepted by the adapter, so it
    //    never becomes a governing hash: the binding is enforced where the document lives.
    ['a governing attestation binding a different bundle', await evidenceFor(makeProofIndex({
      attestation: makeAttestation({ bundleHash: sha256Of('some other bundle') }),
    })), {}],
    ['a governing attestation binding a different tool profile', await evidenceFor(makeProofIndex({
      attestation: makeAttestation({ toolProfileHash: sha256Of('another tool profile') }),
    })), {}],
    // 6. The attestation is sealed, present and internally perfect — and the only receipts that
    //    reference it are OFFLINE contract proofs, so nothing validated it as live.
    ['an attestation referenced only by an offline receipt', await evidenceFor(makeProofIndex({
      receiptOverrides: Object.fromEntries(
        APPLICABLE_CAPABILITIES.map((id) => [id, { proofClass: 'offline_contract' }]),
      ),
    })), {}],
    // 7. An artefact that simply CLAIMS a governing set it never earned. The published list can
    //    only ever SUBTRACT: an unsealed hash contributes nothing, and an absent one anchors
    //    nothing, because the sealed digest is the value an outsider cannot find a preimage for.
    ['an artefact claiming an unsealed governing hash', {
      ...structuredClone(honestEvidence),
      governingAttestationHashes: [sha256Of('a hash the run never sealed')],
    }, {}],
    ['an artefact claiming no governing attestation at all', {
      ...structuredClone(honestEvidence),
      governingAttestationHashes: [],
    }, {}],
    ['an artefact with the governing key missing entirely', (() => {
      const { governingAttestationHashes: _dropped, ...rest } = structuredClone(honestEvidence);
      return rest;
    })(), {}],
  ];

  for (const [label, internalEvidence, over] of refusals) {
    const decision = await decideOn(internalEvidence, over);
    assert.notEqual(decision.status, 'complete_full', label + ' anchored by slot discipline alone');
    assert.equal(decision.eligible, false, label);
    assert.equal(gateFor(decision, 'live_runtime_receipts').passed, false, label);
    assert.ok(decision.failedGates.includes('live_runtime_receipts'), label);
    assert.ok(
      limitationCodes(decision).includes('INTERNAL_AUDIT_PROOF_UNANCHORED'),
      label + ' named no anchoring limitation',
    );
  }

  // A chain whose receipts are all offline is read perfectly well — it simply governs nothing.
  const offlineEvidence = await evidenceFor(makeProofIndex({
    receiptOverrides: Object.fromEntries(
      APPLICABLE_CAPABILITIES.map((id) => [id, { proofClass: 'offline_contract' }]),
    ),
  }));
  assert.deepEqual(offlineEvidence.governingAttestationHashes, []);
});

// ---------------------------------------------------------------------------
// 68 — R4-C1 residual, driven end to end through the REAL kernel
// ---------------------------------------------------------------------------

test('a minted chain binding the honest identities cannot reach full through the real kernel', async () => {
  // 1. CONTROL — the honest chain still publishes Full end to end, so the path is alive.
  await withProjectRoot(async (projectRoot) => {
    const harness = r3FullKernel({ runId: 'run_r5c1_control' });
    const result = await harness.start(projectRoot);
    assert.equal(result.status, 'complete_full', 'the honest control run never reached Full');
    assert.equal(harness.publisherArgs.length, 1);
    assert.equal(harness.publisherArgs[0].runManifest.status, 'complete_full');
    assert.equal(
      harness.publisherArgs[0].payloadArtifacts['coverage.json'].state,
      'complete_full',
    );
  });

  // 2. THE RESIDUAL ATTACK — every identity is the honest, PUBLIC one and every one of them is
  //    genuinely sealed; only the PROVENANCE is minted here, and no document is offered.
  for (const [label, internalIdentities] of [
    ['caller restates the honest identities', EXPECTED_IDENTITIES],
    ['caller states nothing', {}],
  ]) {
    await withProjectRoot(async (projectRoot) => {
      const runId = 'run_r5c1_' + sha256Of(label).slice(7, 19);
      const harness = r3FullKernel({
        runId,
        proofIndex: r5MintedHonestChain(),
        internalIdentities,
      });
      await assert.rejects(
        () => harness.start(projectRoot),
        /AUDIT_INTEGRITY_FAILURE|AUDIT_QUARANTINED/u,
        label + ': a minted chain published through the real kernel',
      );
      assert.deepEqual(harness.publisherArgs, [], label + ': the publisher saw a Full run');
      const state = openState({ projectRoot, locationId: LOCATION_ID });
      try {
        assert.equal(state.getRun(runId).status, 'quarantined', label);
      } finally {
        state.close();
      }
    });
  }
});

// ---------------------------------------------------------------------------
// 69 — R4-I2, the composition-root half: the SHIPPED runtime forwards the vault
//      pseudonym key, so the internal evidence artefact is reproducible and the
//      two pseudonymised ledgers can be joined across runs.
// ---------------------------------------------------------------------------

test('the shipped local runtime forwards the vault pseudonym key', async () => {
  const { createLocalAuditKernel, localProviderDescriptor } = await import('../lib/local-runtime.mjs');
  const { writeFileSync: writeConfig } = await import('node:fs');

  const railFor = () => ({
    adapterKind: 'internal_ghl',
    contractVersion: '1.0.0',
    locationId: LOCATION_ID,
    toolProfileHash: TOOL_PROFILE_HASH,
    capabilityManifestHash: MANIFEST_HASH,
    bundleHash: BUNDLE_HASH,
    capabilityProofIndex: makeProofIndex(),
    transport: { kind: 'host_injected' },
  });
  const frozenInputs = kernelFrozenInputs({
    capabilityManifestHashes: [MANIFEST_HASH, BUNDLE_HASH],
  });

  // The clock is frozen for the whole comparison, so `capturedAt` is identical in every run and
  // the ONLY thing that can still differ between two collections over byte-identical fixtures is
  // the pseudonym key. Before this wiring the adapter minted `randomBytes(32)` per instance.
  const realNow = Date.now;
  const collectingInternalHash = async (runId, enrollmentRowId) => withProjectRoot(async (projectRoot) => {
    const providerConfig = {
      schemaVersion: '1.0.0',
      adapterKind: 'local_fixture',
      providerId: 'provider',
      cutoff: KERNEL_CUTOFF,
      timezone: 'Australia/Sydney',
      frozenInputs,
      context: { context: 'safe' },
      publicEvidence: { events: [] },
      reviews: [],
      internalRail: railFor(),
    };
    const providerConfigPath = join(projectRoot, 'provider-config.json');
    writeConfig(providerConfigPath, `${JSON.stringify(providerConfig)}\n`, { mode: 0o600 });
    const internalClient = fakeAuditMcpClient({
      responses: evidenceResponses({
        ai: 'all-surfaces-complete',
        runtimeByWorkflow: { WF1: 'complete', WF2: 'complete-no-step-rosters' },
        runtimeOptions: {
          WF1: {
            over: {
              enrollments: {
                ...RUNTIME.complete.enrollments,
                rows: [{ _id: enrollmentRowId, createdAt: '2026-07-14T09:00:00.000Z' }],
              },
            },
          },
        },
      }),
      calls: [],
    });
    await createLocalAuditKernel({ initialRunId: runId, internalClient }).start({
      mode: 'weekly',
      target: frozenInputs.target,
      projectRoot,
      cutoff: providerConfig.cutoff,
      providerId: providerConfig.providerId,
      profile: 'client',
      providerConfig,
      providerDescriptor: localProviderDescriptor({
        projectRoot,
        providerConfigPath,
        config: providerConfig,
      }),
      vaultKeyReference: 'test-only:key',
    });
    const state = openState({ projectRoot, locationId: LOCATION_ID });
    try {
      const checkpoint = state.getCheckpoint({ runId, phase: 'collecting_internal' });
      assert.ok(checkpoint, 'the shipped runtime never collected internal evidence');
      return checkpoint.outputHash;
    } finally {
      state.close();
    }
  });

  try {
    Date.now = () => KERNEL_CUTOFF;
    const first = await collectingInternalHash('run_r4i2_first', '68a1f2c4b9d3e17a2c4f8b91');
    const second = await collectingInternalHash('run_r4i2_second', '68a1f2c4b9d3e17a2c4f8b91');
    // NON-VACUITY: the hash really does cover the PSEUDONYMISED ledger, so equality above is a
    // statement about the key rather than about a hash that never saw a pseudonym.
    const different = await collectingInternalHash('run_r4i2_other', '68a1f2c4b9d3e17a2c4f8b92');
    assert.notEqual(
      first,
      different,
      'the collected-evidence hash does not cover the pseudonymised enrollment ledger at all',
    );
    assert.equal(
      first,
      second,
      'two shipped runs over identical fixtures produced different evidence: the pseudonym key is still per instance',
    );
  } finally {
    Date.now = realNow;
  }
});

// ===========================================================================
// ROUND 6 — one appended test per finding. APPENDED ONLY: nothing above this
// line is altered. Each test was verified RED by surgically reverting exactly
// its own fix and running it alone with `--test-name-pattern`.
// ===========================================================================

// ---------------------------------------------------------------------------
// 70 — R6-C1. The specs are DERIVED FROM THE PRODUCERS' REAL OUTPUT.
//
// The round-5 inversion claimed the three allow-lists "are exactly the records
// `collection.mjs` and the adapter's `workflowRoster` emit". They were written from the
// producers' SOURCE AS READ, and `authorizeTerminalCollection` adds two keys AFTER the object
// literal that was read, so every honest run failed closed. None of the 346 tests caught it
// because every one of them hand-builds its envelopes.
//
// This test is the durable fix: it runs the REAL producers and diffs their REAL key sets
// against the exported specs, in BOTH directions, so the specs can never drift again.
// ---------------------------------------------------------------------------

test('the public rail specs are derived from what the real producers really emit', async () => {
  const { completeCollection, incompleteCollection } = await import('../lib/adapters/collection.mjs');
  const specs = weeklyMode.SELF_DESCRIPTION_SPECS;
  assert.ok(
    specs && typeof specs === 'object',
    'lib/modes/weekly.mjs must export SELF_DESCRIPTION_SPECS so the specs can be diffed against the producers',
  );

  const items = structuredClone(MERGE.publicItems.baseline);
  const base = {
    source: 'public_ghl',
    operationId: 'public-r6c1-producer',
    boundLocationId: LOCATION_ID,
    requestedWindow: { ...MERGE.requestedWindow },
    appliedWindow: { ...MERGE.requestedWindow },
    capturedAt: MERGE.envelopes.baseline.capturedAt,
    items,
    // Stated independently of the rows, as the anti-oracle discipline requires. It happens to
    // agree here because this is the HONEST producer path.
    reportedCount: items.length,
  };
  const complete = completeCollection({ ...base });
  const incomplete = incompleteCollection({
    ...base,
    reason: 'budget_exhausted',
    nextCursor: 'cursor-2',
    truncated: true,
  });
  const sealedRoster = (await collectFor().result).workflowRoster;
  assert.equal(sealedRoster.sealed, true, 'the roster producer did not seal');

  // ---- direction 1: every key a producer EMITS must have a meaning ---------
  const envelopeKeys = [...new Set([
    ...Object.keys(complete).filter((key) => key !== 'page'),
    ...Object.keys(incomplete).filter((key) => key !== 'page'),
  ])].sort();
  assert.deepEqual(
    envelopeKeys.filter((key) => !Object.hasOwn(specs.envelope, key)),
    [],
    'the REAL producer emits envelope keys the allow-list calls UNKNOWN, so every honest run fails closed',
  );
  // The two keys `authorizeTerminalCollection` adds to EVERY authorized collection — the exact
  // omission R6-C1 named. Pinned by name so a future edit cannot quietly drop them again.
  assert.ok(Object.hasOwn(complete, 'privateSourceEnvelope'));
  assert.ok(Object.hasOwn(complete, 'privateSourceInventory'));

  const pageKeys = [...new Set([
    ...Object.keys(complete.page),
    ...Object.keys(incomplete.page),
  ])].sort();
  assert.deepEqual(pageKeys.filter((key) => !Object.hasOwn(specs.page, key)), []);
  assert.deepEqual(
    Object.keys(sealedRoster).filter((key) => !Object.hasOwn(specs.roster, key)),
    [],
    'the REAL sealed roster carries keys ROSTER_SPEC calls UNKNOWN',
  );
  for (const window of [complete.requestedWindow, complete.appliedWindow]) {
    assert.deepEqual(Object.keys(window).filter((key) => !Object.hasOwn(specs.window, key)), []);
  }

  // ---- direction 2: a spec key no producer emits is PINNED -----------------
  // Defensive keys are allowed, but only deliberately: this assertion forces anyone adding one
  // to say so out loud, and it fails the moment a producer stops emitting something.
  assert.deepEqual(
    Object.keys(specs.envelope).filter((key) => !envelopeKeys.includes(key)).sort(),
    [],
  );
  assert.deepEqual(
    Object.keys(specs.page).filter((key) => !pageKeys.includes(key)).sort(),
    ['incompleteReason'],
    'PAGE_SPEC defensive keys changed; the producers no longer match the spec',
  );
  assert.deepEqual(
    Object.keys(specs.roster).filter((key) => !Object.hasOwn(sealedRoster, key)).sort(),
    [],
  );

  // ---- end to end: the REAL producer's envelope MERGES and PUBLISHES ------
  const eligibilityBase = await healthyEligibilityInputs();
  const internalEvidence = eligibilityBase.internalEvidence;
  assert.equal(internalEvidence.complete, true);
  const merged = (await mergeFor({ internalEvidence, publicEvidence: [complete] })).result;
  assert.equal(
    merged.status,
    'COMPLETE',
    'a genuine completeCollection envelope does not merge COMPLETE, so every honest run is quarantined',
  );
  assert.deepEqual(merged.limitations, []);
  // ...and the run built on the real producer's output is still able to publish Full, so the
  // fix restored an honest run rather than merely renaming its failure.
  const decision = await requireExport('evaluateFullEligibility')({
    ...eligibilityBase,
    merge: merged,
  });
  assert.equal(decision.status, 'complete_full');
  for (const gateId of FULL_ELIGIBILITY_GATES) {
    assert.equal(gateFor(decision, gateId).passed, true, gateId);
  }

  // And the genuine INCOMPLETE producer is honestly incomplete rather than malformed.
  const partial = (await mergeFor({ internalEvidence, publicEvidence: [incomplete] })).result;
  assert.equal(partial.status, 'PARTIAL');
  assert.ok(partial.limitations.includes('PUBLIC_EVIDENCE_INCOMPLETE'));
  assert.ok(
    !partial.limitations.includes('PUBLIC_EVIDENCE_MALFORMED'),
    'the real incomplete producer is reported as malformed rather than incomplete',
  );
});

// ---------------------------------------------------------------------------
// 71 — R6-C2. Substantiveness is RECURSIVE, so there is no level left to pad at.
// ---------------------------------------------------------------------------

test('padding a page with contentless rows at any depth can never be COMPLETE', async () => {
  const internalEvidence = await collectFor({
    responses: evidenceResponses({ ai: 'all-surfaces-complete' }),
  }).result;
  const rows = structuredClone(MERGE.publicItems.baseline);
  assert.ok(rows.length >= 3, 'the baseline row set is too small to drop rows from');

  // CONTROL: the unpadded envelope merges COMPLETE, so every refusal below is a refusal.
  const honest = (await mergeFor({ internalEvidence })).result;
  assert.equal(honest.status, 'COMPLETE');

  // Each pad replaces THREE real rows. Every declared count still reconciles perfectly — the
  // response's own arithmetic is impeccable — and the rows are simply not there.
  const padded = (pad) => [...rows.slice(0, rows.length - 3), pad, pad, pad];
  const contentless = [
    ['an empty object', {}],
    ['a null leaf', { x: null }],
    ['a single space', { x: ' ' }],
    ['whitespace only', { x: '\t\n  ' }],
    ['an empty string', { x: '' }],
    ['a nested null', { x: { y: null } }],
    ['a nested empty array', { x: [null] }],
    ['three levels of nothing', { x: { y: { z: [] } } }],
    ['an array of empty records', { x: [{ y: '' }, {}] }],
    ['a mix of every empty form', { a: null, b: ' ', c: [], d: {}, e: [{ f: null }] }],
  ];
  for (const [label, pad] of contentless) {
    const result = (await mergeFor({
      internalEvidence,
      publicEvidence: [publicEnvelope('baseline', { items: padded(pad) })],
    })).result;
    assert.notEqual(result.status, 'COMPLETE', `${label} padded a page into a COMPLETE rail`);
    assert.ok(
      result.limitations.includes('PUBLIC_EVIDENCE_MALFORMED'),
      `${label} produced no limitation at all`,
    );
  }

  // `0` and `false` ARE meaningful observations and must NOT be treated as padding, at any
  // depth. Without this half the fix would be a different defect.
  for (const [label, row] of [
    ['a zero count', { count: 0 }],
    ['a false flag', { enabled: false }],
    ['a nested zero', { totals: { sent: 0 } }],
    ['a nested false', { flags: [{ enabled: false }] }],
  ]) {
    const result = (await mergeFor({
      internalEvidence,
      publicEvidence: [publicEnvelope('baseline', { items: padded(row) })],
    })).result;
    assert.equal(result.status, 'COMPLETE', `${label} was discarded as padding`);
  }
});

// ---------------------------------------------------------------------------
// 72 — R6-C3. The trust root is no longer a sibling of the thing it anchors.
// ---------------------------------------------------------------------------

/** The anchor values `lib/local-runtime.mjs` uses when a rail authenticated NOTHING. */
const R6_UNSEALED_ANCHOR = Object.freeze({
  providerToolProfileHash: 'unsealed:no-independent-frozen-input-seal',
  capabilityManifestHashes: [],
  capabilityProofIndexHash: 'unsealed:no-independent-frozen-input-seal',
  capabilityReceiptHashes: [],
  capabilityAttestationHashes: [],
  capabilityProofExpiries: [],
});

test('a config that writes both halves of its own seal cannot anchor anything', async () => {
  const {
    createLocalAuditKernel,
    localProviderDescriptor,
    mintFrozenInputSeal,
  } = await import('../lib/local-runtime.mjs');
  const { writeFileSync: writeJson } = await import('node:fs');
  const evaluateFullEligibility = requireExport('evaluateFullEligibility');

  // The forger's configuration: it mints the chain AND seals the hash of the attestation it
  // just minted, because both live in the one record `loadProjectConfig` returns.
  const forgedFrozen = kernelFrozenInputs({
    capabilityManifestHashes: [MANIFEST_HASH, BUNDLE_HASH],
    capabilityAttestationHashes: [makeAttestation().attestationHash],
  });
  const railBase = () => ({
    adapterKind: 'internal_ghl',
    contractVersion: '1.0.0',
    locationId: LOCATION_ID,
    toolProfileHash: TOOL_PROFILE_HASH,
    capabilityManifestHash: MANIFEST_HASH,
    bundleHash: BUNDLE_HASH,
    capabilityProofIndex: makeProofIndex(),
    transport: {
      kind: 'inline_responses',
      toolsList: TOOLS_LIST,
      responses: { auth_status: { ok: false, code: 'INTERNAL_AUDIT_AUTH_REQUIRED' } },
    },
  });
  // Deliberately NOT byte-identical to the configuration's own anchor block: one field differs,
  // so "the run sealed the seal" and "the run sealed the config" are distinguishable answers.
  const sealAnchors = {
    providerToolProfileHash: TOOL_PROFILE_HASH,
    capabilityManifestHashes: [MANIFEST_HASH, BUNDLE_HASH],
    capabilityProofIndexHash: 'proof-index-1',
    capabilityReceiptHashes: ['receipt-minted-by-the-live-canary'],
    capabilityAttestationHashes: [makeAttestation().attestationHash],
    capabilityProofExpiries: [Date.parse('2026-07-26T00:00:00.000Z')],
  };

  const runLocal = async ({
    runId,
    seal,
    sealFile = 'audit-seal.json',
    declaration,
    candidates = [],
  }) => (
    withProjectRoot(async (projectRoot) => {
      const providerConfig = {
        schemaVersion: '1.0.0',
        adapterKind: 'local_fixture',
        providerId: 'provider',
        cutoff: KERNEL_CUTOFF,
        timezone: 'Australia/Sydney',
        frozenInputs: forgedFrozen,
        context: { context: 'safe' },
        publicEvidence: { events: [] },
        reviews: [],
        internalRail: railBase(),
        ...(declaration === undefined
          ? (seal ? { frozenInputSeal: { kind: 'project_file', relativePath: sealFile } } : {})
          : { frozenInputSeal: declaration }),
      };
      if (seal) writeJson(join(projectRoot, sealFile), `${JSON.stringify(seal)}\n`, { mode: 0o600 });
      const providerConfigPath = join(projectRoot, 'provider-config.json');
      writeJson(providerConfigPath, `${JSON.stringify(providerConfig)}\n`, { mode: 0o600 });
      const result = await createLocalAuditKernel({ initialRunId: runId }).start({
        mode: 'weekly',
        target: forgedFrozen.target,
        projectRoot,
        cutoff: providerConfig.cutoff,
        providerId: providerConfig.providerId,
        profile: 'client',
        providerConfig,
        providerDescriptor: localProviderDescriptor({
          projectRoot,
          providerConfigPath,
          config: providerConfig,
        }),
        vaultKeyReference: 'test-only:key',
      });
      const state = openState({ projectRoot, locationId: LOCATION_ID });
      try {
        // Answered HERE, while the state handle is open: `assertResumeInputs` is the run's own
        // durable statement of what it sealed, so it is the honest way to read the anchors back.
        const sealed = new Map(candidates.map(([label, candidate]) => {
          try {
            state.assertResumeInputs(runId, candidate);
            return [label, true];
          } catch (error) {
            assert.equal(error?.code, 'RESUME_INPUT_MISMATCH', label);
            return [label, false];
          }
        }));
        return { status: result.status, sealed };
      } finally {
        state.close();
      }
    })
  );

  // 1. THE ATTACK. One actor writes both halves. The run still executes — absent authentication
  //    is missing evidence, not an integrity failure — but it seals NONE of the forger's anchors.
  const forged = await runLocal({
    runId: 'run_r6c3_forged',
    candidates: [
      ['config', forgedFrozen],
      ['unsealed', { ...forgedFrozen, ...R6_UNSEALED_ANCHOR }],
    ],
  });
  assert.equal(forged.status, 'awaiting_internal_auth');
  assert.equal(
    forged.sealed.get('config'),
    false,
    'the run sealed the anchors the forger wrote next to its own proof chain',
  );
  assert.equal(
    forged.sealed.get('unsealed'),
    true,
    'the unauthenticated run did not fall back to the unsealed anchor',
  );

  // 2. NON-VACUITY. Those same forged inputs WOULD have published Full — that is the defect —
  //    and the unsealed anchor the run actually holds cannot.
  const base = await healthyEligibilityInputs();
  const wouldHaveBeenFull = await evaluateFullEligibility({
    ...base,
    frozenInputs: r3FrozenInputs(),
  });
  assert.equal(wouldHaveBeenFull.status, 'complete_full');
  const unanchored = await evaluateFullEligibility({
    ...base,
    frozenInputs: { ...r3FrozenInputs(), ...R6_UNSEALED_ANCHOR },
  });
  assert.equal(unanchored.status, 'complete_partial');
  assert.equal(gateFor(unanchored, 'live_runtime_receipts').passed, false);
  assert.ok(limitationCodes(unanchored).includes('INTERNAL_AUDIT_PROOF_UNANCHORED'));

  // 3. CONTROL. An INDEPENDENTLY authenticated seal — a separate document, MAC'd with vault key
  //    material the configuration does not contain — really does anchor.
  const honestSeal = mintFrozenInputSeal({
    locationId: LOCATION_ID,
    anchors: sealAnchors,
    canaryTargetHashes: [makeAttestation().targetHash],
    vaultKeyReference: 'test-only:key',
  });
  const sealed = await runLocal({
    runId: 'run_r6c3_sealed',
    seal: honestSeal,
    candidates: [
      ['seal', { ...forgedFrozen, ...sealAnchors }],
      ['config', forgedFrozen],
    ],
  });
  assert.equal(sealed.status, 'awaiting_internal_auth', 'the authenticated seal was refused');
  assert.equal(
    sealed.sealed.get('seal'),
    true,
    'the run did not take its anchors from the independent seal',
  );
  assert.equal(sealed.sealed.get('config'), false);

  // 4. Every way of faking the independent seal fails PREFLIGHT, loudly.
  const refusals = [
    ['a forged MAC', { ...honestSeal, mac: 'a'.repeat(64) }, {}],
    ['no MAC at all', (() => {
      const { mac: _dropped, ...rest } = honestSeal;
      return rest;
    })(), {}],
    ['anchors edited after minting', {
      ...honestSeal,
      anchors: {
        ...honestSeal.anchors,
        capabilityAttestationHashes: [sha256Of('an attestation the canary never made')],
      },
    }, {}],
    ['a seal minted for another location', mintFrozenInputSeal({
      locationId: 'L2',
      anchors: sealAnchors,
      canaryTargetHashes: [makeAttestation().targetHash],
      vaultKeyReference: 'test-only:key',
    }), {}],
    ['proof-chain material smuggled into the seal', {
      ...honestSeal,
      capabilityProofIndex: makeProofIndex(),
    }, {}],
    ['a seal declaration pointing at the provider config itself', honestSeal, {
      declaration: { kind: 'project_file', relativePath: 'provider-config.json' },
    }],
    ['a seal declaration escaping the project root', honestSeal, {
      declaration: { kind: 'project_file', relativePath: '../outside-seal.json' },
    }],
  ];
  for (const [label, seal, extra] of refusals) {
    await assert.rejects(
      () => runLocal({
        runId: `run_r6c3_${sha256Of(label).slice(7, 19)}`,
        seal,
        ...extra,
      }),
      /AUDIT_PREFLIGHT_FAILED|AUDIT_INTEGRITY_FAILURE|AUDIT_QUARANTINED/u,
      `${label}: the composition root accepted it`,
    );
  }
});

// ---------------------------------------------------------------------------
// 73 — R6-I1. The merge reads the SHIPPED public-evidence shape.
// ---------------------------------------------------------------------------

test('the merge reads every real public evidence shape and names an unreadable one', async () => {
  const internalEvidence = await collectFor({
    responses: evidenceResponses({ ai: 'all-surfaces-complete' }),
  }).result;
  const envelope = publicEnvelope('baseline');

  // Shapes that genuinely CARRY envelopes. The shipped composition root rejects arrays outright
  // (`lib/local-runtime.mjs` requires a plain object), so all but the first are the real ones.
  for (const [label, publicEvidence] of [
    ['the harness array', [envelope]],
    ['a record with an envelopes list', { envelopes: [envelope] }],
    ['a record that IS one envelope', envelope],
    ['the Task-10 kernel record carrying envelopes', { events: [envelope] }],
  ]) {
    const result = (await mergeFor({ internalEvidence, publicEvidence })).result;
    assert.equal(result.status, 'COMPLETE', `${label} was not read as public evidence`);
    assert.deepEqual(result.limitations, [], label);
    // The evidence is CARRIED, not silently dropped on the way out.
    assert.equal(result.publicEvidence.length, 1, label);
    assert.ok(result.entities.length > 0, `${label} contributed no entities`);
  }

  // An empty ledger is honestly ABSENT — that is missing evidence, not a shape error.
  const empty = (await mergeFor({ internalEvidence, publicEvidence: { events: [] } })).result;
  assert.ok(empty.limitations.includes('PUBLIC_EVIDENCE_MISSING'));
  assert.ok(!empty.limitations.includes('PUBLIC_EVIDENCE_MALFORMED'));

  // A shape the auditor cannot read is a SHAPE ERROR stated out loud, never a claim that
  // nothing was collected. Reporting collected evidence as MISSING is a false statement.
  for (const [label, publicEvidence] of [
    ['a raw event ledger', {
      events: [{ nativeEventId: 'e1', occurredAt: NOW_ISO, kind: 'lead_created' }],
    }],
    ['a record of something else entirely', { pages: [{ rows: [] }] }],
    ['a bare string', 'not evidence'],
    ['a number', 7],
  ]) {
    const result = (await mergeFor({ internalEvidence, publicEvidence })).result;
    assert.equal(result.status, 'PARTIAL', label);
    assert.ok(
      result.limitations.includes('PUBLIC_EVIDENCE_MALFORMED'),
      `${label} raised no shape error`,
    );
    assert.ok(
      !result.limitations.includes('PUBLIC_EVIDENCE_MISSING'),
      `${label} was reported as MISSING, which is a false statement about collected evidence`,
    );
  }
});

// ---------------------------------------------------------------------------
// 74 — R6-I2. `targetHash` is compared with the run's explicit canary SCOPE.
//
// Reasoning, recorded: location binding stays independent — the target hash is still never
// compared with, substituted for, or treated as authorization for this location. What it now
// does is scope the PROOF: a canary attestation supports only the accounts an authenticated,
// per-location seal names. The alternative ("the run's own target hash must match") was
// rejected because the canary target is a server-minted pseudonym this adapter cannot
// reproduce, so requiring equality would fail every real run for a structural reason.
// ---------------------------------------------------------------------------

test('a canary attestation supports only the accounts its scope names', async () => {
  const honestTarget = makeAttestation().targetHash;
  const otherTarget = sha256Of('a canary that ran against a different account');

  // CONTROL: no scope declared is the pre-existing library behaviour.
  const unscoped = await round5Collect();
  assert.equal(unscoped.complete, true);
  assert.ok(unscoped.governingAttestationHashes.length > 0);

  // Scoped to THIS account: identical evidence, identical governing set.
  const scoped = await round5Collect({
    adapterOptions: { authorizedCanaryTargetHashes: [otherTarget, honestTarget] },
  });
  assert.equal(scoped.complete, true, 'an authorized canary was refused');
  assert.deepEqual(scoped.governingAttestationHashes, unscoped.governingAttestationHashes);

  // The C4 attack: the attestation is perfect, unexpired, live and sound — and it was minted
  // for another account. One canary may no longer anchor every account that seals its hash.
  for (const [label, authorized] of [
    ['a scope naming only another account', [otherTarget]],
    ['a scope naming no account at all', []],
  ]) {
    const refused = await round5Collect({
      adapterOptions: { authorizedCanaryTargetHashes: authorized },
    });
    assert.deepEqual(
      refused.governingAttestationHashes,
      [],
      `${label}: an out-of-scope canary still governed`,
    );
    assert.equal(refused.complete, false, label);
    assert.ok(hasCode(refused, /INTERNAL_AUDIT_CAPABILITY/u), label);
  }

  // An attestation carrying no target at all cannot be in any scope.
  const untargeted = await round5Collect({
    responses: evidenceResponses(),
    adapterOptions: { authorizedCanaryTargetHashes: [honestTarget] },
    calls: [],
  });
  assert.ok(untargeted.governingAttestationHashes.length > 0, 'control drifted');
  const blankTarget = createInternalGhlAdapter({
    client: fakeAuditMcpClient({ responses: evidenceResponses(), calls: [] }),
    expectedContractVersion: '1.0.0',
    expectedLocationId: LOCATION_ID,
    expectedToolProfileHash: TOOL_PROFILE_HASH,
    capabilityProofIndex: makeProofIndex({ attestation: makeAttestation({ targetHash: '' }) }),
    runtime: { now: () => Date.parse(NOW_ISO) },
    authorizedCanaryTargetHashes: [honestTarget],
  });
  const blank = await blankTarget.collectAuditEvidence({
    target: TARGET,
    window: WINDOW,
    applicability: { capabilityIds: APPLICABLE_CAPABILITIES },
    stepRosterRequests: {},
  });
  assert.deepEqual(blank.governingAttestationHashes, []);

  // A malformed scope is a CALLER error, never a silent degradation to "unscoped".
  for (const declared of ['everything', 42, [''], [null], [{}]]) {
    assert.throws(
      () => round5Adapter({ adapterOptions: { authorizedCanaryTargetHashes: declared } }),
      /INTERNAL_AUDIT/u,
      `a malformed scope ${JSON.stringify(declared)} was accepted`,
    );
  }
});

// ---------------------------------------------------------------------------
// 75 — R6-I2, the composition-root half: the scope reaches the adapter, and it
//      comes from the AUTHENTICATED seal rather than from the rail record.
// ---------------------------------------------------------------------------

test('the shipped runtime scopes the canary from the authenticated seal', async () => {
  const {
    createLocalAuditKernel,
    localProviderDescriptor,
    mintFrozenInputSeal,
  } = await import('../lib/local-runtime.mjs');
  const { writeFileSync: writeJson } = await import('node:fs');

  const frozenInputs = kernelFrozenInputs({
    capabilityManifestHashes: [MANIFEST_HASH, BUNDLE_HASH],
  });
  const sealAnchors = {
    providerToolProfileHash: TOOL_PROFILE_HASH,
    capabilityManifestHashes: [MANIFEST_HASH, BUNDLE_HASH],
    capabilityProofIndexHash: 'proof-index-1',
    capabilityReceiptHashes: ['receipt-1'],
    capabilityAttestationHashes: [makeAttestation().attestationHash],
    capabilityProofExpiries: [Date.parse('2026-07-26T00:00:00.000Z')],
  };

  const realNow = Date.now;
  const internalEvidenceHash = async (runId, canaryTargetHashes) => withProjectRoot(async (projectRoot) => {
    const seal = mintFrozenInputSeal({
      locationId: LOCATION_ID,
      anchors: sealAnchors,
      canaryTargetHashes,
      vaultKeyReference: 'test-only:key',
    });
    writeJson(join(projectRoot, 'audit-seal.json'), `${JSON.stringify(seal)}\n`, { mode: 0o600 });
    const providerConfig = {
      schemaVersion: '1.0.0',
      adapterKind: 'local_fixture',
      providerId: 'provider',
      cutoff: KERNEL_CUTOFF,
      timezone: 'Australia/Sydney',
      frozenInputs,
      context: { context: 'safe' },
      publicEvidence: { events: [] },
      reviews: [],
      internalRail: {
        adapterKind: 'internal_ghl',
        contractVersion: '1.0.0',
        locationId: LOCATION_ID,
        toolProfileHash: TOOL_PROFILE_HASH,
        capabilityManifestHash: MANIFEST_HASH,
        bundleHash: BUNDLE_HASH,
        capabilityProofIndex: makeProofIndex(),
        transport: { kind: 'host_injected' },
      },
      frozenInputSeal: { kind: 'project_file', relativePath: 'audit-seal.json' },
    };
    const providerConfigPath = join(projectRoot, 'provider-config.json');
    writeJson(providerConfigPath, `${JSON.stringify(providerConfig)}\n`, { mode: 0o600 });
    const internalClient = fakeAuditMcpClient({
      responses: evidenceResponses({ ai: 'all-surfaces-complete' }),
      calls: [],
    });
    await createLocalAuditKernel({ initialRunId: runId, internalClient }).start({
      mode: 'weekly',
      target: frozenInputs.target,
      projectRoot,
      cutoff: providerConfig.cutoff,
      providerId: providerConfig.providerId,
      profile: 'client',
      providerConfig,
      providerDescriptor: localProviderDescriptor({
        projectRoot,
        providerConfigPath,
        config: providerConfig,
      }),
      vaultKeyReference: 'test-only:key',
    });
    const state = openState({ projectRoot, locationId: LOCATION_ID });
    try {
      const checkpoint = state.getCheckpoint({ runId, phase: 'collecting_internal' });
      assert.ok(checkpoint, 'the shipped runtime never collected internal evidence');
      return checkpoint.outputHash;
    } finally {
      state.close();
    }
  });

  try {
    // The clock is frozen so the ONLY thing that can differ between the two runs is the scope.
    Date.now = () => KERNEL_CUTOFF;
    const inScope = await internalEvidenceHash('run_r6i2_in', [makeAttestation().targetHash]);
    const sameScope = await internalEvidenceHash('run_r6i2_same', [makeAttestation().targetHash]);
    const outOfScope = await internalEvidenceHash('run_r6i2_out', [sha256Of('another account')]);
    assert.equal(inScope, sameScope, 'the run is not reproducible, so the comparison below is meaningless');
    assert.notEqual(
      inScope,
      outOfScope,
      'the seal\'s canary scope never reached the adapter: an out-of-scope canary produced identical evidence',
    );
  } finally {
    Date.now = realNow;
  }
});

// ---------------------------------------------------------------------------
// 76 — R6-M1. `scrub_explained` now CONSTRAINS a claim instead of labelling one.
// ---------------------------------------------------------------------------

test('a scrub explained definition cannot support a direct mechanism claim', async () => {
  const scenario = HISTORY['change-inside-window'];
  const provenComposite = {
    definitionGovernedRuntimeEvents: 'proven',
    provenBy: 'workflow_version_history',
    publishableAsGoverning: true,
    detail: 'the composite ceiling, raised so this test isolates the hash verdict',
  };
  const events = scenario.events.map((event) => ({
    id: event.id,
    timestamp: event.timestamp,
    timestampField: 'startedExecutionAt',
    unreadableTimestampFields: [],
    event: { _id: event.id },
  }));
  const definitionRef = scenario.currentDefinitionRef;

  const runWith = async ({ scrub }) => {
    const source = structuredClone(DEFINITIONS[definitionRef]);
    if (scrub) source.workflow.workflowData.templates[0].headers = { Authorization: '<redacted>' };
    return collectFor({
      responses: evidenceResponses({
        runtimeByWorkflow: { WF1: 'complete-no-step-rosters', WF2: 'complete-no-step-rosters' },
        runtimeOptions: {
          WF1: {
            over: {
              configurationBinding: provenComposite,
              runtimeEvents: events,
              workflowDefinition: {
                workflow: source.workflow,
                triggers: source.triggers,
                stickyNotes: source.stickyNotes,
                version: source.version,
                hashAlgorithm: 'sha256',
                // The PRE-scrub digest either way: it is the server's stable identity.
                canonicalHash: DEFINITIONS[definitionRef].canonicalHash,
                capturedAt: source.capturedAt,
                validity: structuredClone(scenario.validity),
              },
            },
          },
        },
        // The export route was scrubbed by the same function over the same content.
        exportByWorkflow: {
          WF1: okBody({
            workflow: source.workflow,
            triggers: source.triggers,
            stickyNotes: source.stickyNotes,
          }),
        },
      }),
    }).result;
  };

  // CONTROL — an EXACTLY verified definition supports the direct causal claim.
  const exact = workflowRecord(await runWith({ scrub: false }), 'WF1');
  assert.equal(exact.definition.hashVerification, 'exact');
  assert.equal(exact.configurationBinding.publishableAsGoverning, true, 'the control never proved anything');
  assert.equal(exact.configurationBinding.definitionGovernedRuntimeEvents, 'proven');
  for (const event of scenario.events) {
    assert.equal(eventRecord(exact, event.id).supportsDirectMechanismProof, true, event.id);
  }

  // THE FIX — identical in every other respect, and the weaker verdict now costs something.
  const scrubbed = workflowRecord(await runWith({ scrub: true }), 'WF1');
  assert.equal(scrubbed.definition.hashVerification, 'scrub_explained');
  assert.equal(
    scrubbed.configurationBinding.publishableAsGoverning,
    false,
    'a scrub-explained definition still published a governing claim',
  );
  assert.notEqual(scrubbed.configurationBinding.definitionGovernedRuntimeEvents, 'proven');
  assert.equal(scrubbed.configurationBinding.provenBy, null);
  for (const event of scenario.events) {
    const bound = eventRecord(scrubbed, event.id);
    assert.equal(
      bound.supportsDirectMechanismProof,
      false,
      `${event.id} rested a direct mechanism proof on a definition nobody verified exactly`,
    );
    assert.equal(bound.workflowDefinitionHash, null, event.id);
  }
  // The evidence itself is still RETAINED and still honest — the weaker verdict narrows what
  // may be claimed, it does not discard what was observed.
  assert.equal(scrubbed.definition.definitionHash, DEFINITIONS[definitionRef].canonicalHash);
  assert.equal(scrubbed.complete, true);
});

// ---------------------------------------------------------------------------
// 76 — R7-C1. The library path is bound too: a host cannot seal its own anchors.
// ---------------------------------------------------------------------------

test('a self sealed library host can never anchor an identity', async () => {
  const evaluateFullEligibility = requireExport('evaluateFullEligibility');

  // Round 6 closed the SHIPPED half: `lib/local-runtime.mjs` takes its anchors from a separate
  // project file, realpath-compared against the provider configuration and MAC'd with the run's
  // vault key material. The kernel itself was still unbound — `analyzer.freezeInputs` is
  // INJECTED, its return value was accepted whole, and `evaluateFullEligibility` had no channel
  // to state how it had been authenticated. A library host supplying its own analyzer therefore
  // went on sealing its own forgery and reaching `complete_full` through the real kernel.
  //
  // Everything below is ONE harness with ONE knob: whether the anchoring claim arrives with a
  // seal the run's own key material can verify. The evidence, the proof chain, the frozen
  // inputs and the compiled payload are identical in every case.

  const runKernel = async (options) => withProjectRoot(async (projectRoot) => {
    const harness = r3FullKernel(options);
    let result = null;
    let failure = null;
    try {
      result = await harness.start(projectRoot);
    } catch (error) {
      failure = error;
    }
    const state = openState({ projectRoot, locationId: LOCATION_ID });
    let durable = null;
    try {
      durable = state.getRun(options.runId);
    } catch {
      durable = null;
    } finally {
      state.close();
    }
    return { result, failure, durable, publisherArgs: harness.publisherArgs };
  });

  // ---- 1. CONTROL: a genuinely authenticated seal DOES reach Full ------------------------
  // Minted with the same key material `keyResolver` resolves for the run. Without this the
  // whole test would be vacuous — every case below would be Partial for want of a live path.
  const control = await runKernel({ runId: 'run_r7c1_sealed' });
  assert.equal(control.failure, null, 'the genuinely sealed control run failed');
  assert.equal(control.result.status, 'complete_full', 'a host-authenticated seal did not anchor');
  assert.equal(control.publisherArgs.length, 1);
  assert.equal(control.publisherArgs[0].runManifest.status, 'complete_full');
  assert.equal(control.durable.status, 'complete_full');

  // ---- 2. NO SEAL AT ALL: honest-but-limited, never corrupt ------------------------------
  // The same analyzer, returning the same anchors PLAIN. This is the round-6 attack rebuilt on
  // the library path: the host writes the proof chain and the anchors that vouch for it, and
  // there is now no run-key statement that anything authenticated them.
  const unsealed = await runKernel({
    runId: 'run_r7c1_unsealed',
    hostSeal: false,
    // An HONEST payload. The publication guard requires the compiled label and the eligibility
    // decision to agree, so a run that completes `complete_partial` on a partial-labelled
    // payload is a run whose decision was NOT Full.
    payloadStatus: 'complete_partial',
  });
  assert.equal(unsealed.failure, null, 'an unsealed run was refused instead of degraded');
  assert.equal(
    unsealed.result.status,
    'complete_partial',
    'an unprovenanced anchoring claim still reached Full through the real kernel',
  );
  // NOT a quarantine. Absent authentication is missing evidence, not corrupt evidence.
  assert.equal(unsealed.durable.status, 'complete_partial');
  assert.notEqual(unsealed.durable.status, 'quarantined');
  // The publisher ran — the run is honest — but it never published Full.
  assert.equal(unsealed.publisherArgs.length, 1);
  assert.equal(unsealed.publisherArgs[0].runManifest.status, 'complete_partial');
  assert.equal(
    unsealed.publisherArgs[0].payloadArtifacts['coverage.json'].state,
    'complete_partial',
  );

  // A Full-LABELLED payload on the same unsealed run is refused outright rather than published,
  // so the clamp is not merely a relabelling.
  const overclaimed = await runKernel({ runId: 'run_r7c1_overclaim', hostSeal: false });
  assert.match(
    String(overclaimed.failure?.code ?? ''),
    /AUDIT_QUARANTINED/u,
    'a Full-labelled payload on an unanchored run was published',
  );
  assert.deepEqual(overclaimed.publisherArgs, []);

  // ---- 3. A SEAL THAT DOES NOT VERIFY against the run's key material ---------------------
  // The host mints a structurally perfect seal with key material that is not the run's. Refused
  // at PREFLIGHT — the R2-M4 precedent that a DECLARED authentication which does not verify is
  // refused loudly rather than silently degraded — which is strictly stronger than the Partial
  // that an absent seal earns. No run, no publication, no Full.
  const wrongKeys = await runKernel({
    runId: 'run_r7c1_wrong_key',
    sealKeys: () => ({ encryptionKey: Buffer.alloc(32, 9), pseudonymKey: Buffer.alloc(32, 8) }),
  });
  assert.match(
    String(wrongKeys.failure?.code ?? ''),
    /AUDIT_PREFLIGHT_FAILED_FROZEN_INPUT_SEAL/u,
    'a seal minted with foreign key material was accepted',
  );
  assert.deepEqual(wrongKeys.publisherArgs, []);
  assert.equal(wrongKeys.durable, null, 'a run was created on an unverifiable seal');

  // ---- 4. A SEAL VERIFYING DIFFERENT ANCHORS ---------------------------------------------
  // 4a. Through the kernel: the MAC is genuine and made with the run's own key material, but it
  //     was minted over a DIFFERENT anchor block than the frozen inputs actually carry. A seal
  //     for one anchor block can never license another, so this is refused exactly as a forged
  //     MAC is. Only ONE anchoring field differs, so the refusal is about the binding and not
  //     about the shape.
  const otherAnchors = r3FrozenInputs({
    capabilityAttestationHashes: [sha256Of('an attestation this canary never made')],
  });
  const shiftedAnchors = await runKernel({
    runId: 'run_r7c1_shifted',
    sealedAnchors: otherAnchors,
  });
  assert.match(
    String(shiftedAnchors.failure?.code ?? ''),
    /AUDIT_PREFLIGHT_FAILED_FROZEN_INPUT_SEAL/u,
    'a seal minted over another anchor block authenticated these anchors',
  );
  assert.deepEqual(shiftedAnchors.publisherArgs, []);
  assert.equal(shiftedAnchors.durable, null);

  // 4b. At the gate, where a library host calls `evaluateFullEligibility` directly: a provenance
  //     token that authenticates a DIFFERENT anchor block anchors nothing, and the run is capped
  //     at `complete_partial` with gate 2 failed. Degraded, never quarantined.
  const base = await healthyEligibilityInputs();
  const anchored = await evaluateFullEligibility(base);
  assert.equal(anchored.status, 'complete_full', 'the gate-level control is not Full');
  assert.equal(gateFor(anchored, 'live_runtime_receipts').passed, true);

  const unprovenanced = [
    ['no provenance at all', undefined],
    ['a null provenance', null],
    ['a bare assertion with no binding', { authenticated: true, method: 'host_key_mac' }],
    ['a provenance for another anchor block', anchorProvenanceFor(otherAnchors)],
    ['a provenance naming another method', {
      ...anchorProvenanceFor(r3FrozenInputs()),
      method: 'trust_me',
    }],
    ['a provenance that authenticates nothing', {
      ...anchorProvenanceFor(r3FrozenInputs()),
      authenticated: false,
    }],
  ];
  for (const [label, frozenInputProvenance] of unprovenanced) {
    const decision = await evaluateFullEligibility({ ...base, frozenInputProvenance });
    assert.equal(decision.status, 'complete_partial', `${label} reached Full`);
    assert.notEqual(decision.status, 'quarantined', `${label} quarantined an honest run`);
    assert.equal(gateFor(decision, 'live_runtime_receipts').passed, false, label);
    assert.ok(
      limitationCodes(decision).includes('INTERNAL_AUDIT_PROOF_UNANCHORED'),
      `${label} named no anchoring limitation`,
    );
  }

  // An INHERITED provenance never authenticates anything either (finding I3's class).
  const digest = weeklyMode.frozenInputAnchorDigest(r3FrozenInputs());
  for (const [key, value] of [
    ['authenticated', true],
    ['method', 'host_key_mac'],
    ['anchorDigest', digest],
  ]) {
    // eslint-disable-next-line no-extend-native
    Object.defineProperty(Object.prototype, key, {
      value,
      configurable: true,
      enumerable: false,
      writable: true,
    });
    try {
      const decision = await evaluateFullEligibility({
        ...base,
        frozenInputProvenance: Object.fromEntries(
          Object.entries(anchorProvenanceFor(r3FrozenInputs())).filter(([name]) => name !== key),
        ),
      });
      assert.equal(decision.status, 'complete_partial', `an inherited ${key} authenticated`);
      assert.equal(gateFor(decision, 'live_runtime_receipts').passed, false, key);
    } finally {
      delete Object.prototype[key];
    }
  }
});
