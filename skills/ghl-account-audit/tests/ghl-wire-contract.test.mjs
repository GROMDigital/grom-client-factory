/**
 * THE OUTGOING REQUEST, PINNED AGAINST THE REAL WORKER CONTRACT.
 *
 * A live run against a real GoHighLevel MCP worker failed before it read a single record. The
 * worker answered with its OWN zod validation error:
 *
 *     { "code": "invalid_type", "path": ["action_id"],
 *       "message": "Invalid input: expected string, received undefined" }
 *
 * The worker's `execute_action` tool requires `arguments.action_id`. Everything in this repo sent
 * `arguments.action`. Every upstream call was therefore rejected before it began, and the whole
 * suite was green while it happened — because every hermetic double in the suite dispatched on
 * whatever key it was handed and answered with a canned body. The doubles WERE the contract, so
 * they agreed with us instead of with the server.
 *
 * This file exists to make that impossible. Its oracle is not a response double: it is a
 * REPRODUCTION OF THE WORKER'S OWN ARGUMENT VALIDATION, written from the live error above, and it
 * runs BEFORE any canned body is chosen. A request the real worker would reject fails here even if
 * the response we would have returned was perfect.
 *
 * Nothing here opens a socket, spawns a process or contacts an account.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { describeFailure, runAuditCli } from '../cli/audit.mjs';
import { sha256 } from '../lib/canonical.mjs';
import { GHL_NATIVE_TRANSPORT_KIND } from '../lib/adapters/ghl-native-session.mjs';
import {
  createGhlTranslatingConnect,
  upstreamToolRequest,
} from '../lib/adapters/ghl-public-translator.mjs';
import { connectMcp } from '../lib/adapters/mcp-transport.mjs';
import { createPublicGhlAdapter } from '../lib/adapters/public-ghl.mjs';
import { loadPublicReadAllowlist } from '../schemas/v1.mjs';

const allowlist = loadPublicReadAllowlist();
const SNAPSHOT_HASH = allowlist.sourceSnapshotHash;
const ALLOWLIST_HASH = sha256(allowlist);
const MANIFEST_HASH = 'c'.repeat(64);
const LOCATION_ID = 'L1';
const DAY_MS = 86_400_000;
const CUTOFF = 1_750_032_000_000;
/** Exactly one calendar chunk wide, so the chunk grid is a single deterministic request. */
const WINDOW = Object.freeze({
  from: new Date(CUTOFF - 7 * DAY_MS).toISOString(),
  to: new Date(CUTOFF).toISOString(),
});
const FROM_MS = Date.parse(WINDOW.from);
const TO_MS = Date.parse(WINDOW.to);
const VAULT_KEY_REFERENCE = 'test-only:key';
const WORKER_URL = 'https://ghl-mcp-server.xanderjohnrazonroque.workers.dev/mcp';
const TOKEN_ENVIRONMENT_NAME = 'GHL_WIRE_CONTRACT_TEST_TOKEN';

// ---------------------------------------------------------------------------
// THE ORACLE — the worker's own argument validation, not ours
// ---------------------------------------------------------------------------

/**
 * The `execute_action` argument contract, as the live worker enforces it.
 *
 * `action_id` is REQUIRED and must be a string — that is the exact failure the live run hit.
 * `params` is the endpoint's own parameter object. The remaining keys are the worker's documented
 * response-shaping and safety channels; we send NONE of them, and anything outside this set is an
 * argument the worker was never asked to accept.
 */
const WORKER_OPTIONAL_ARGUMENT_KEYS = Object.freeze([
  'result_filter',
  'result_fields',
  'result_offset',
  'result_limit',
  'dry_run',
  'confirm',
]);

/**
 * Returns the zod-shaped issues the real worker would raise, or `[]` when it would accept. The
 * `action_id` issue is copied verbatim from the live failure so a regression reproduces the exact
 * message an operator saw.
 */
function workerArgumentIssues(argumentsValue) {
  const issues = [];
  if (
    !argumentsValue
    || typeof argumentsValue !== 'object'
    || Array.isArray(argumentsValue)
  ) {
    return [{
      code: 'invalid_type',
      path: [],
      message: 'Invalid input: expected object, received undefined',
    }];
  }
  if (typeof argumentsValue.action_id !== 'string') {
    issues.push({
      code: 'invalid_type',
      path: ['action_id'],
      message: `Invalid input: expected string, received ${
        argumentsValue.action_id === undefined ? 'undefined' : typeof argumentsValue.action_id
      }`,
    });
  }
  if (
    !argumentsValue.params
    || typeof argumentsValue.params !== 'object'
    || Array.isArray(argumentsValue.params)
  ) {
    issues.push({
      code: 'invalid_type',
      path: ['params'],
      message: 'Invalid input: expected object, received undefined',
    });
  }
  for (const key of Object.keys(argumentsValue)) {
    if (key === 'action_id' || key === 'params') continue;
    if (WORKER_OPTIONAL_ARGUMENT_KEYS.includes(key)) continue;
    issues.push({
      code: 'unrecognized_keys',
      path: [key],
      message: `Unrecognized key: "${key}"`,
    });
  }
  return issues;
}

/**
 * The worker's TOOL-LEVEL error reply, verbatim in shape: a text content block that is not the
 * normal payload, `isError: true`, and NO `structuredContent` at all. This is the reply the live
 * run actually received and could not name.
 */
function toolErrorReply(issues) {
  return {
    content: [{ type: 'text', text: JSON.stringify(issues, null, 2) }],
    isError: true,
  };
}

function assertWorkerWouldAccept(argumentsValue, label) {
  assert.deepEqual(workerArgumentIssues(argumentsValue), [], label);
}

// ---------------------------------------------------------------------------
// A raw GHL MCP client double that VALIDATES before it answers
// ---------------------------------------------------------------------------

function workerEnvelope(data) {
  return {
    structuredContent: {
      action: { id: 'x', method: 'GET', path: '/x', summary: 's', category: 'c', risk: { kinds: ['read'] } },
      status: 200,
      ok: true,
      data,
      note: null,
      filter: null,
      pagination: null,
      error: null,
    },
  };
}

/** Minimal, terminal bodies. They end each walk in ONE request so the pinned request is the request. */
const BODIES = Object.freeze({
  'contacts-v3__search-contacts-advanced': { contacts: [], total: 0, traceId: 't-1' },
  'opportunities-v3__search-opportunity': { opportunities: [], meta: { total: 0 }, traceId: 't-2' },
  'opportunities-v3__get-pipelines': { pipelines: [], traceId: 't-3' },
  'conversations-v3__search-conversation': { conversations: [], total: 0, traceId: 't-4' },
  'conversations-v3__export-messages-by-location': { messages: [], nextCursor: null, traceId: 't-5' },
  'calendars-v3__get-calendars': {
    calendars: [{ id: 'cal-1', locationId: LOCATION_ID }],
    traceId: 't-6',
  },
  'calendars-v3__get-calendar-events': { events: [], traceId: 't-7' },
});

/**
 * Drives one translated scope and returns every `execute_action` ARGUMENT object that reached the
 * raw client. The double refuses exactly what the worker refuses, before it looks at any body.
 */
async function captureWire(actionId, { from = WINDOW.from, to = WINDOW.to } = {}) {
  const wire = [];
  const connect = async () => ({
    async callTool(request) {
      assert.equal(request?.name, 'execute_action');
      wire.push(structuredClone(request.arguments));
      const issues = workerArgumentIssues(request.arguments);
      if (issues.length > 0) return toolErrorReply(issues);
      const body = BODIES[request.arguments.action_id];
      if (!body) throw new Error(`UNEXPECTED_UPSTREAM:${request.arguments.action_id}`);
      return workerEnvelope(structuredClone(body));
    },
    async close() {},
  });
  const delegate = await createGhlTranslatingConnect({ connect })({ kind: 'stdio' });
  const result = await delegate.callTool({
    name: 'execute_action',
    arguments: {
      action: actionId,
      params: { locationId: LOCATION_ID, fromDate: from, toDate: to, cursor: null },
    },
  });
  return { wire, body: result.structuredContent };
}

// ---------------------------------------------------------------------------
// The oracle itself
// ---------------------------------------------------------------------------

test('the oracle reproduces the live failure for the shape this repo used to send', () => {
  assert.deepEqual(
    workerArgumentIssues({ action: 'contacts-v3__search-contacts-advanced', params: {} }),
    [
      {
        code: 'invalid_type',
        path: ['action_id'],
        message: 'Invalid input: expected string, received undefined',
      },
      { code: 'unrecognized_keys', path: ['action'], message: 'Unrecognized key: "action"' },
    ],
  );
  // The adapter's own `makeRequest` additionally carries a `policy` object. The worker never
  // declared one, so it is a second refusal on the same call.
  const withPolicy = workerArgumentIssues({
    action: 'contacts-v3__search-contacts-advanced',
    params: {},
    policy: { actionId: 'contacts-v3__search-contacts-advanced' },
  });
  assert.equal(withPolicy.some(({ path }) => path[0] === 'policy'), true);
});

// ---------------------------------------------------------------------------
// The envelope — every plan, every request
// ---------------------------------------------------------------------------

const TRANSLATED = Object.freeze([
  ['contacts.search', 'contacts-v3__search-contacts-advanced'],
  ['opportunities.list', 'opportunities-v3__search-opportunity'],
  ['opportunities-v3__get-pipelines', 'opportunities-v3__get-pipelines'],
  ['conversations-v3__search-conversation', 'conversations-v3__search-conversation'],
  ['conversations-v3__export-messages-by-location', 'conversations-v3__export-messages-by-location'],
  ['calendars-v3__get-calendars', 'calendars-v3__get-calendars'],
  ['calendars-v3__get-calendar-events', 'calendars-v3__get-calendar-events'],
]);

test('every translated plan sends action_id, as a string, on every upstream request', async () => {
  for (const [actionId] of TRANSLATED) {
    const { wire } = await captureWire(actionId);
    assert.equal(wire.length > 0, true, actionId);
    for (const [index, argumentsValue] of wire.entries()) {
      assertWorkerWouldAccept(argumentsValue, `${actionId}[${index}]`);
      assert.equal(typeof argumentsValue.action_id, 'string', `${actionId}[${index}]`);
      assert.equal(argumentsValue.action_id.length > 0, true, `${actionId}[${index}]`);
    }
  }
});

test('no upstream request carries a top-level argument the worker did not declare', async () => {
  for (const [actionId] of TRANSLATED) {
    const { wire } = await captureWire(actionId);
    for (const [index, argumentsValue] of wire.entries()) {
      assert.deepEqual(
        Object.keys(argumentsValue).sort(),
        ['action_id', 'params'],
        `${actionId}[${index}]`,
      );
    }
  }
});

test('the adapter dialect never reaches the wire: no `action`, no `policy`, no window keys', async () => {
  for (const [actionId] of TRANSLATED) {
    const { wire } = await captureWire(actionId);
    for (const argumentsValue of wire) {
      assert.equal(Object.hasOwn(argumentsValue, 'action'), false, actionId);
      assert.equal(Object.hasOwn(argumentsValue, 'policy'), false, actionId);
      // `fromDate` / `toDate` / `cursor` are OUR generic parameter names. No GHL endpoint has them.
      for (const key of ['fromDate', 'toDate', 'cursor']) {
        assert.equal(Object.hasOwn(argumentsValue.params, key), false, `${actionId}.${key}`);
      }
    }
  }
});

test('upstreamToolRequest is the single place the worker envelope is built', () => {
  assert.deepEqual(
    upstreamToolRequest('contacts-v3__search-contacts-advanced', { locationId: LOCATION_ID }),
    {
      name: 'execute_action',
      arguments: {
        action_id: 'contacts-v3__search-contacts-advanced',
        params: { locationId: LOCATION_ID },
      },
    },
  );
  for (const bad of [undefined, null, '', 42, {}]) {
    assert.throws(
      () => upstreamToolRequest(bad, { locationId: LOCATION_ID }),
      (error) => {
        assert.equal(error.code, 'GHL_TRANSLATION_REQUEST_INVALID');
        return true;
      },
    );
  }
  for (const bad of [undefined, null, 'params', []]) {
    assert.throws(
      () => upstreamToolRequest('contacts-v3__search-contacts-advanced', bad),
      (error) => {
        assert.equal(error.code, 'GHL_TRANSLATION_REQUEST_INVALID');
        return true;
      },
    );
  }
});

// ---------------------------------------------------------------------------
// The params — each one against a call that returned HTTP 200 on the live worker
// ---------------------------------------------------------------------------

test('contacts search sends exactly the confirmed-good live params', async () => {
  const { wire } = await captureWire('contacts.search');
  assert.equal(wire.length, 1);
  assert.deepEqual(wire[0].params, { locationId: LOCATION_ID, pageLimit: 100 });
});

test('opportunity search sends exactly the confirmed-good live params', async () => {
  const { wire } = await captureWire('opportunities.list');
  assert.equal(wire.length, 1);
  // `status: 'all'` is load-bearing and server-validated: without it won and lost opportunities —
  // i.e. every realised `monetaryValue` — could be excluded by an unstated default.
  assert.deepEqual(wire[0].params, { locationId: LOCATION_ID, limit: 100, status: 'all' });
});

test('conversation search sends exactly the confirmed-good live params, in epoch millis', async () => {
  const { wire } = await captureWire('conversations-v3__search-conversation');
  assert.equal(wire.length, 1);
  assert.deepEqual(wire[0].params, {
    locationId: LOCATION_ID,
    limit: 100,
    startDate: FROM_MS,
    endDate: TO_MS,
  });
  assert.equal(typeof wire[0].params.startDate, 'number');
  assert.equal(typeof wire[0].params.endDate, 'number');
});

test('calendar listing sends exactly the confirmed-good live params', async () => {
  const { wire } = await captureWire('calendars-v3__get-calendars');
  assert.equal(wire.length, 1);
  assert.deepEqual(wire[0].params, { locationId: LOCATION_ID });
});

test('calendar events resolve the parent, then send the confirmed-good per-chunk params', async () => {
  const { wire } = await captureWire('calendars-v3__get-calendar-events');
  assert.equal(wire.length, 2, 'one parent resolution, then one (calendar, chunk) read');
  assert.deepEqual(wire[0], {
    action_id: 'calendars-v3__get-calendars',
    params: { locationId: LOCATION_ID },
  });
  assert.deepEqual(wire[1].params, {
    locationId: LOCATION_ID,
    calendarId: 'cal-1',
    startTime: String(FROM_MS),
    endTime: String(TO_MS - 1),
  });
});

test('pipelines send the location alone', async () => {
  const { wire } = await captureWire('opportunities-v3__get-pipelines');
  assert.deepEqual(wire, [{
    action_id: 'opportunities-v3__get-pipelines',
    params: { locationId: LOCATION_ID },
  }]);
});

test('location-scoped message export sends its planned params and nothing generic', async () => {
  // NOT among the five calls confirmed live. The ENVELOPE is pinned like every other plan; the
  // params are pinned to what the plan states so a silent drift is visible, and they stay marked
  // as unconfirmed until a live probe says otherwise.
  const { wire } = await captureWire('conversations-v3__export-messages-by-location');
  assert.deepEqual(wire, [{
    action_id: 'conversations-v3__export-messages-by-location',
    params: {
      locationId: LOCATION_ID,
      limit: 100,
      sortBy: 'createdAt',
      sortOrder: 'desc',
    },
  }]);
});

// ---------------------------------------------------------------------------
// The tool-level refusal — the reply that had no shape we recognised
// ---------------------------------------------------------------------------

test('a tool-level error reply is an upstream refusal, not a shape surprise', async () => {
  const refusing = async () => ({
    async callTool() {
      return toolErrorReply(workerArgumentIssues({ params: {} }));
    },
    async close() {},
  });
  const delegate = await createGhlTranslatingConnect({ connect: refusing })({ kind: 'stdio' });
  await assert.rejects(
    delegate.callTool({
      name: 'execute_action',
      arguments: {
        action: 'contacts.search',
        params: { locationId: LOCATION_ID, fromDate: WINDOW.from, toDate: WINDOW.to, cursor: null },
      },
    }),
    (error) => {
      assert.equal(error.code, 'GHL_UPSTREAM_TOOL_REFUSED');
      // The worker echoes request parameters into its error channel, so NOTHING but the code may
      // travel: this value reaches `assertSafeCollected` and the publication boundary.
      assert.equal(error.message, 'GHL_UPSTREAM_TOOL_REFUSED');
      assert.equal(JSON.stringify(error), '{"code":"GHL_UPSTREAM_TOOL_REFUSED"}');
      return true;
    },
  );
});

test('an isError reply is refused even when its text happens to parse as JSON', async () => {
  const refusing = async () => ({
    async callTool() {
      return { content: [{ type: 'text', text: '{"contacts":[]}' }], isError: true };
    },
    async close() {},
  });
  const delegate = await createGhlTranslatingConnect({ connect: refusing })({ kind: 'stdio' });
  await assert.rejects(
    delegate.callTool({
      name: 'execute_action',
      arguments: {
        action: 'contacts.search',
        params: { locationId: LOCATION_ID, fromDate: WINDOW.from, toDate: WINDOW.to, cursor: null },
      },
    }),
    (error) => {
      assert.equal(error.code, 'GHL_UPSTREAM_TOOL_REFUSED');
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// The diagnostic chain — a failed run must be able to name its own cause
// ---------------------------------------------------------------------------

function providerConfig() {
  return {
    providerId: 'wire-contract-provider',
    expectedLocationId: LOCATION_ID,
    capabilityManifestHash: MANIFEST_HASH,
    publicCatalogSnapshotHash: SNAPSHOT_HASH,
    publicReadAllowlistHash: ALLOWLIST_HASH,
    credentialRef: null,
  };
}

const approvedAction = allowlist.actions.find(({ risk }) => risk === 'read');
const approvedCapability = Object.freeze({
  operationId: 'wire-contract-scope',
  actionId: approvedAction.actionId,
  method: approvedAction.method,
  normalizedPath: approvedAction.normalizedPath,
  category: approvedAction.category,
  risk: approvedAction.risk,
  sourceSnapshotHash: SNAPSHOT_HASH,
  allowlistHash: ALLOWLIST_HASH,
  providerId: 'wire-contract-provider',
  capabilityManifestHash: MANIFEST_HASH,
});

async function clientThatFailsWith(failure) {
  return connectMcp({
    providerConfig: providerConfig(),
    transport: {
      kind: 'stdio',
      command: '/usr/bin/false',
      args: [],
      async connect() {
        return {
          async callTool() {
            throw failure;
          },
          async close() {},
        };
      },
    },
  });
}

test('connectMcp names the upstream code instead of swallowing it', async () => {
  const client = await clientThatFailsWith(
    Object.assign(new Error('GHL_UPSTREAM_TOOL_REFUSED'), { code: 'GHL_UPSTREAM_TOOL_REFUSED' }),
  );
  try {
    await assert.rejects(
      client.callTool({
        name: 'execute_action',
        arguments: {
          action: approvedCapability.actionId,
          policy: approvedCapability,
          params: { locationId: LOCATION_ID },
        },
      }),
      (error) => {
        assert.equal(error.code, 'MCP_TOOL_CALL_FAILED');
        assert.equal(error.upstreamCode, 'GHL_UPSTREAM_TOOL_REFUSED');
        return true;
      },
    );
  } finally {
    await client.close();
  }
});

test('an upstream code that is not a bounded machine code is replaced, never forwarded', async () => {
  // The worker echoes request parameters into its error channel. A message, a status body or a
  // parameter must never become the value that reaches the publication boundary.
  const leaky = [
    'locationId=abc123 rejected',
    'Invalid input: expected string, received undefined',
    { toString: () => 'OBJECT' },
    42,
    'a'.repeat(200),
    null,
  ];
  for (const code of leaky) {
    const client = await clientThatFailsWith(Object.assign(new Error('x'), { code }));
    try {
      await assert.rejects(
        client.callTool({
          name: 'execute_action',
          arguments: {
            action: approvedCapability.actionId,
            policy: approvedCapability,
            params: { locationId: LOCATION_ID },
          },
        }),
        (error) => {
          assert.equal(error.code, 'MCP_TOOL_CALL_FAILED');
          assert.equal(error.upstreamCode, 'UPSTREAM_CODE_UNRECOGNISED');
          return true;
        },
      );
    } finally {
      await client.close();
    }
  }
});

test('the public adapter carries the ORIGINATING code, not the transport it passed through', async () => {
  const client = await clientThatFailsWith(
    Object.assign(new Error('GHL_UPSTREAM_TOOL_REFUSED'), { code: 'GHL_UPSTREAM_TOOL_REFUSED' }),
  );
  const adapter = createPublicGhlAdapter({
    client,
    allowlist,
    expectedLocationId: LOCATION_ID,
    rawPageSink: { async sealPage() { throw new Error('never reached'); } },
  });
  try {
    await assert.rejects(
      adapter.collect({ capability: approvedCapability, window: WINDOW }),
      (error) => {
        assert.equal(error.code, 'PUBLIC_COLLECTION_FAILED');
        // NOT `MCP_TOOL_CALL_FAILED`: naming the layer the failure crossed is what cost a capture
        // session and six probe rounds. The originating code is what an operator can act on.
        assert.equal(error.upstreamCode, 'GHL_UPSTREAM_TOOL_REFUSED');
        assert.equal(error.message, 'PUBLIC_COLLECTION_FAILED');
        return true;
      },
    );
  } finally {
    await client.close();
  }
});

test('the CLI failure line names the cause, and only bounded codes', () => {
  assert.equal(
    describeFailure(Object.assign(new Error('x'), {
      code: 'PUBLIC_COLLECTION_FAILED',
      upstreamCode: 'GHL_UPSTREAM_TOOL_REFUSED',
    })),
    'PUBLIC_COLLECTION_FAILED upstream=GHL_UPSTREAM_TOOL_REFUSED',
  );
  assert.equal(
    describeFailure(Object.assign(new Error('x'), { code: 'AUDIT_QUARANTINED' })),
    'AUDIT_QUARANTINED',
  );
  assert.equal(describeFailure(undefined), 'AUDIT_COMMAND_INVALID');
  // A leaked message, parameter or status body can never become the printed line.
  assert.equal(
    describeFailure(Object.assign(new Error('x'), {
      code: 'PUBLIC_COLLECTION_FAILED',
      upstreamCode: 'locationId=abc123 rejected by the worker',
    })),
    'PUBLIC_COLLECTION_FAILED upstream=UPSTREAM_CODE_UNRECOGNISED',
  );
  assert.equal(
    describeFailure(Object.assign(new Error('x'), {
      code: 'not a bounded code at all',
      upstreamCode: 'GHL_UPSTREAM_TOOL_REFUSED',
    })),
    'AUDIT_COMMAND_INVALID upstream=GHL_UPSTREAM_TOOL_REFUSED',
  );
});

// ---------------------------------------------------------------------------
// The whole rail, over a JSON-RPC wire that validates like the worker
// ---------------------------------------------------------------------------

function frozenInputs() {
  return {
    locationId: LOCATION_ID,
    target: { targetKind: 'location', operatingProfile: 'client', locationId: LOCATION_ID },
    cutoff: CUTOFF,
    timezone: 'Europe/London',
    contextHash: 'context-wire-1',
    coverageProfileHash: 'coverage-wire-1',
    metricProfileHash: 'metric-wire-1',
    rulesetHash: 'rules-wire-1',
    codeHash: 'code-wire-1',
    auditProfileHash: 'profile-wire-1',
    providerToolProfileHash: 'provider-wire-1',
    windowDefinitionsHash: 'windows-wire-1',
    collectionBudgetHash: 'budget-wire-1',
    capabilityManifestHashes: ['manifest-wire-1'],
    capabilityProofIndexHash: 'proof-index-wire-1',
    capabilityReceiptHashes: ['receipt-wire-1'],
    capabilityAttestationHashes: ['attestation-wire-1'],
    capabilityProofExpiries: [1_850_032_000_000],
  };
}

/**
 * A GoHighLevel MCP worker behind the SDK's own `fetch` seam, which VALIDATES `tools/call`
 * arguments exactly as the live worker does before it answers. This is the closest thing to the
 * real wire that can exist offline: the SDK client, the streamable-HTTP transport, `connectMcp`,
 * the translator and the bounded adapter all run for real.
 */
function validatingFetchDouble() {
  const observed = { toolArguments: [], refusals: 0 };
  const json = (body) => new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
  const fetchImplementation = async (url, init) => {
    if (init?.method !== 'POST') return new Response(null, { status: 405 });
    const message = JSON.parse(String(init.body));
    if (message.method === 'initialize') {
      return json({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          protocolVersion: message.params.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: 'ghl-mcp-wire-double', version: '0.0.0' },
        },
      });
    }
    if (message.method === 'notifications/initialized') return new Response(null, { status: 202 });
    if (message.method !== 'tools/call') throw new Error(`UNEXPECTED_METHOD:${message.method}`);
    const argumentsValue = message.params.arguments;
    observed.toolArguments.push(structuredClone(argumentsValue));
    const issues = workerArgumentIssues(argumentsValue);
    if (issues.length > 0) {
      observed.refusals += 1;
      return json({ jsonrpc: '2.0', id: message.id, result: toolErrorReply(issues) });
    }
    const body = BODIES[argumentsValue.action_id];
    if (!body) throw new Error(`UNEXPECTED_UPSTREAM:${argumentsValue.action_id}`);
    return json({
      jsonrpc: '2.0',
      id: message.id,
      result: workerEnvelope({ ...structuredClone(body), locationId: LOCATION_ID }),
    });
  };
  return { observed, fetch: fetchImplementation };
}

test('the whole public rail clears a worker that enforces the real argument contract', async () => {
  const projectRoot = realpathSync(mkdtempSync(join(tmpdir(), 'ghl-wire-')));
  const previous = Object.hasOwn(process.env, TOKEN_ENVIRONMENT_NAME)
    ? process.env[TOKEN_ENVIRONMENT_NAME]
    : undefined;
  process.env[TOKEN_ENVIRONMENT_NAME] = 'wire-contract-token-canary';
  const server = validatingFetchDouble();
  try {
    const configPath = join(projectRoot, 'provider.json');
    writeFileSync(configPath, `${JSON.stringify({
      schemaVersion: '1.0.0',
      adapterKind: 'ghl_public',
      runId: 'run_wire_1',
      providerId: 'grom-ghl-mcp',
      expectedLocationId: LOCATION_ID,
      capabilityManifestHash: MANIFEST_HASH,
      publicCatalogSnapshotHash: SNAPSHOT_HASH,
      publicReadAllowlistHash: ALLOWLIST_HASH,
      credentialRef: { kind: 'environment', name: TOKEN_ENVIRONMENT_NAME },
      transport: { kind: GHL_NATIVE_TRANSPORT_KIND, url: WORKER_URL },
      capabilities: [
        { operationId: 'contacts-weekly', actionId: 'contacts.search' },
        { operationId: 'opportunities-weekly', actionId: 'opportunities.list' },
        { operationId: 'appointments-weekly', actionId: 'calendars-v3__get-calendar-events' },
      ],
      cutoff: CUTOFF,
      timezone: 'Europe/London',
      frozenInputs: frozenInputs(),
      context: { safe: 'context' },
      reviews: [],
    })}\n`);
    const stdout = { chunks: [], write(chunk) { this.chunks.push(String(chunk)); return true; } };
    const result = await runAuditCli({
      argv: [
        'run',
        '--mode', 'weekly',
        '--project', projectRoot,
        '--location', LOCATION_ID,
        '--profile', 'client',
        '--provider-config', configPath,
        '--vault-key-ref', VAULT_KEY_REFERENCE,
      ],
      stdout,
      publicRuntime: { runtime: { ghlNativeFetch: server.fetch } },
    });
    assert.equal(result.status, 'complete_partial');
    // The point of the whole file: the worker never refused a single call.
    assert.equal(server.observed.refusals, 0);
    assert.equal(server.observed.toolArguments.length > 0, true);
    for (const argumentsValue of server.observed.toolArguments) {
      assert.deepEqual(Object.keys(argumentsValue).sort(), ['action_id', 'params']);
      assert.equal(typeof argumentsValue.action_id, 'string');
      assert.equal(argumentsValue.params.locationId, LOCATION_ID);
    }
  } finally {
    if (previous === undefined) delete process.env[TOKEN_ENVIRONMENT_NAME];
    else process.env[TOKEN_ENVIRONMENT_NAME] = previous;
    rmSync(projectRoot, { recursive: true, force: true });
  }
});
