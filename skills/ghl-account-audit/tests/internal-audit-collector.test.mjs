/**
 * THE INTERNAL COLLECTION PHASE.
 *
 * The shapes the doubles below carry are the ones `tests/internal-audit-contract.test.mjs` proves
 * against the REAL audit server: an `{ok, code}` envelope, `isError: false` on a refusal, a
 * latching circuit, and per-tool contract versions. So a double here cannot invent a reply the
 * server would never send, which is the failure mode that has hidden three defects on this project.
 *
 * What is deliberately NOT asserted: the composites' success bodies. They have not been seen.
 * `readRosterIds` is tolerant on purpose and says so, and it is marked for narrowing the moment a
 * live reply exists.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createInternalAuditAdapter } from '../lib/adapters/internal-audit.mjs';
import {
  DEFAULT_BUDGETS,
  createInternalAuditCollector,
  readRosterIds,
} from '../lib/adapters/internal-audit-collector.mjs';
import { collectInternalEvidencePhase } from '../lib/modes/weekly.mjs';

const LOCATION = 'L1';
const WINDOW = Object.freeze({
  from: '2026-01-01T00:00:00.000Z',
  to: '2026-03-02T00:00:00.000Z',
});

function railFor(handlers) {
  const calls = [];
  const client = {
    calls,
    async listTools() { return { tools: [] }; },
    async callTool({ name, arguments: args }) {
      calls.push({ name, args });
      const handler = handlers[name];
      if (handler === undefined) throw new Error(`UNSTUBBED ${name}`);
      return typeof handler === 'function' ? handler(args, calls) : handler;
    },
    async close() {},
  };
  return {
    calls,
    rail: createInternalAuditAdapter({ client, expectedLocationId: LOCATION }),
  };
}

const okAuth = (seconds = 3600, agencySeconds = 3600) => ({
  structuredContent: {
    ok: true,
    data: {
      jwtClaims: { present: true, secondsRemaining: seconds },
      tokenIdClaims: { present: true, secondsRemaining: agencySeconds },
    },
  },
});

const okRoster = (ids, extra = {}) => ({
  structuredContent: {
    ok: true, boundLocationId: LOCATION, complete: true, data: { workflowIds: ids }, ...extra,
  },
});

const okDefinition = (workflowId) => ({
  structuredContent: { ok: true, boundLocationId: LOCATION, data: { workflowId, steps: [] } },
});

const okRuntime = (workflowId) => ({
  structuredContent: {
    ok: true, contractVersion: '2.0.0', boundLocationId: LOCATION, workflowId,
    complete: true, runtimeEvents: [],
  },
});

// ---------------------------------------------------------------------------

test('an expired credential stops before a single evidence call is spent', async () => {
  const { rail, calls } = railFor({
    auth_status: okAuth(-259_083),
    list_workflows_complete: () => { throw new Error('MUST NOT BE CALLED'); },
  });
  const collector = createInternalAuditCollector({ rail, boundLocationId: LOCATION });
  const evidence = await collector.collectAuditEvidence({ window: WINDOW });

  // Observed on the real server: the first read on a dead token returns TRANSPORT_FAILED and
  // latches the shared circuit, after which every later call on every tool answers CIRCUIT_OPEN.
  // `auth_status` makes no request, so this check is free and saves the whole run.
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'auth_status');
  assert.equal(evidence.complete, false);
  assert.deepEqual(evidence.limitations, ['CREDENTIAL_EXPIRED']);

  // And it is the exact shape the phase recognises as the auth boundary, so the run suspends
  // rather than quarantining.
  const phase = await collectInternalEvidencePhase({
    adapter: collector,
    target: { locationId: LOCATION },
    window: WINDOW,
    applicability: {},
    stepRosterRequests: {},
    publicEvidence: { scopes: [] },
    checkpoint: { schemaVersion: '1.0.0', phase: 'collecting_public' },
  });
  assert.equal(phase.phase, 'awaiting_internal_auth');
  assert.equal(phase.internalEvidence, null);
  // Nothing about the credential travels out of the boundary.
  assert.equal(JSON.stringify(phase).includes('tokenFile'), false);
});

test('definitions are read for every workflow and runtime only where asked', async () => {
  const { rail, calls } = railFor({
    auth_status: okAuth(),
    list_workflows_complete: okRoster(['w1', 'w2', 'w3']),
    get_workflow: (args) => okDefinition(args.workflowId),
    get_workflow_runtime_window: (args) => okRuntime(args.workflowId),
    get_ai_configuration_bundle: { structuredContent: { ok: true, contractVersion: '1.0.0', data: {} } },
  });
  const collector = createInternalAuditCollector({
    rail, boundLocationId: LOCATION, runtimeWorkflowIds: ['w2'],
  });
  const evidence = await collector.collectAuditEvidence({ window: WINDOW });

  assert.deepEqual(evidence.workflows.map(({ workflowId }) => workflowId), ['w1', 'w2', 'w3']);
  // Three cheap definition reads, exactly one expensive runtime read.
  assert.equal(calls.filter(({ name }) => name === 'get_workflow').length, 3);
  assert.equal(calls.filter(({ name }) => name === 'get_workflow_runtime_window').length, 1);

  // "We did not ask" is recorded as such, and is not the same fact as "we asked and got nothing".
  const [w1, w2] = evidence.workflows;
  assert.equal(w1.runtimeWindow, null);
  assert.equal(w1.runtimeCode, 'RUNTIME_NOT_REQUESTED');
  assert.ok(w2.runtimeWindow);
  assert.equal(w2.runtimeCode, null);

  assert.equal(evidence.complete, true);
  assert.deepEqual(evidence.limitations, []);

  // The runtime window is asked for with the CURRENT parameter names. The three retired ones are
  // refused by the server, not ignored, so sending one would fail the read outright.
  const runtimeArgs = calls.find(({ name }) => name === 'get_workflow_runtime_window').args;
  assert.equal(runtimeArgs.maxLogPages, DEFAULT_BUDGETS.maxLogPages);
  assert.equal(runtimeArgs.logPageSize, DEFAULT_BUDGETS.logPageSize);
  for (const retired of ['pageSize', 'maxLogPartitions', 'minPartitionMs']) {
    assert.equal(Object.hasOwn(runtimeArgs, retired), false, retired);
  }
  // And the window is half-open, which the server enforces before it builds a gateway.
  assert.ok(runtimeArgs.fromDate < runtimeArgs.toDate);
});

test('a latching code ends the walk instead of burning the rest of the account', async () => {
  const { rail, calls } = railFor({
    auth_status: okAuth(),
    list_workflows_complete: okRoster(['w1', 'w2', 'w3', 'w4']),
    get_workflow: (args) => (args.workflowId === 'w2'
      ? { structuredContent: { ok: false, code: 'RATE_LIMITED' } }
      : okDefinition(args.workflowId)),
    get_ai_configuration_bundle: () => { throw new Error('MUST NOT BE CALLED AFTER A LATCH'); },
  });
  const collector = createInternalAuditCollector({ rail, boundLocationId: LOCATION });
  const evidence = await collector.collectAuditEvidence({ window: WINDOW });

  // w1 read, w2 refused and latched, w3 and w4 never attempted. Nothing auto-retries after a
  // latch, so continuing would be waste that also destroys the partial.
  assert.equal(calls.filter(({ name }) => name === 'get_workflow').length, 2);
  assert.equal(evidence.latchedCode, 'RATE_LIMITED');
  assert.ok(evidence.limitations.includes('RATE_LIMITED'));
  assert.equal(evidence.complete, false);
  // The partial is CARRIED, not thrown away. A failed read is evidence.
  assert.ok(evidence.workflows.length >= 1);
});

test('an unreadable roster is never reported as an empty account', async () => {
  const { rail } = railFor({
    auth_status: okAuth(),
    // A success body in a shape this rail does not recognise. An empty account and an unread
    // roster are different facts, and confusing them would report a healthy account.
    list_workflows_complete: { structuredContent: { ok: true, boundLocationId: LOCATION, data: { somethingElse: 1 } } },
    get_ai_configuration_bundle: { structuredContent: { ok: true, contractVersion: '1.0.0', data: {} } },
  });
  const collector = createInternalAuditCollector({ rail, boundLocationId: LOCATION });
  const evidence = await collector.collectAuditEvidence({ window: WINDOW });
  assert.equal(evidence.complete, false);
  assert.ok(evidence.limitations.includes('ROSTER_SHAPE_UNREADABLE'));
  assert.deepEqual(evidence.workflows, []);

  // A genuinely, explicitly empty roster IS a real answer and must not be confused with the above.
  const { rail: emptyRail } = railFor({
    auth_status: okAuth(),
    list_workflows_complete: okRoster([]),
    get_ai_configuration_bundle: { structuredContent: { ok: true, contractVersion: '1.0.0', data: {} } },
  });
  const empty = await createInternalAuditCollector({ rail: emptyRail, boundLocationId: LOCATION })
    .collectAuditEvidence({ window: WINDOW });
  assert.equal(empty.limitations.includes('ROSTER_SHAPE_UNREADABLE'), false);
  assert.equal(empty.complete, true);
});

test('the AI surfaces are skipped and SAID SO when the agency token is dead', async () => {
  const { rail, calls } = railFor({
    // The location JWT is healthy; the elevated agency token-id expires independently.
    auth_status: okAuth(3600, -10),
    list_workflows_complete: okRoster(['w1']),
    get_workflow: (args) => okDefinition(args.workflowId),
    get_ai_configuration_bundle: () => { throw new Error('MUST NOT BE CALLED'); },
  });
  const evidence = await createInternalAuditCollector({ rail, boundLocationId: LOCATION })
    .collectAuditEvidence({ window: WINDOW });
  assert.equal(calls.some(({ name }) => name === 'get_ai_configuration_bundle'), false);
  assert.ok(evidence.limitations.includes('AGENCY_TOKEN_UNAVAILABLE'));
  assert.equal(evidence.aiConfiguration, null);
  // The workflow half still succeeded, so the run is partial and not failed.
  assert.equal(evidence.workflows.length, 1);
});

test('a dropped tail is disclosed rather than looking like a shorter account', async () => {
  const { rail } = railFor({
    auth_status: okAuth(),
    list_workflows_complete: okRoster(['w1', 'w2', 'w3', 'w4', 'w5']),
    get_workflow: (args) => okDefinition(args.workflowId),
    get_ai_configuration_bundle: { structuredContent: { ok: true, contractVersion: '1.0.0', data: {} } },
  });
  const evidence = await createInternalAuditCollector({
    rail, boundLocationId: LOCATION, budgets: { maxDefinitions: 2 },
  }).collectAuditEvidence({ window: WINDOW });
  assert.equal(evidence.workflows.length, 2);
  assert.ok(evidence.limitations.includes('DEFINITION_BUDGET_EXHAUSTED'));
  assert.equal(evidence.roster.reportedCount, 5);
  assert.equal(evidence.roster.readCount, 2);
  assert.equal(evidence.complete, false);
});

test('a runtime workflow id the roster does not contain is named, not silently ignored', async () => {
  const { rail, calls } = railFor({
    auth_status: okAuth(),
    list_workflows_complete: okRoster(['w1']),
    get_workflow: (args) => okDefinition(args.workflowId),
    get_workflow_runtime_window: (args) => okRuntime(args.workflowId),
    get_ai_configuration_bundle: { structuredContent: { ok: true, contractVersion: '1.0.0', data: {} } },
  });
  const evidence = await createInternalAuditCollector({
    rail, boundLocationId: LOCATION, runtimeWorkflowIds: ['w1', 'deleted-workflow'],
  }).collectAuditEvidence({ window: WINDOW });
  assert.ok(evidence.limitations.includes('RUNTIME_WORKFLOW_NOT_IN_ROSTER'));
  // And the one that DOES exist is still read, because a stale config entry must not cost the
  // account its runtime evidence.
  assert.equal(calls.filter(({ name }) => name === 'get_workflow_runtime_window').length, 1);
});

test('capabilityCoverage is EMPTY, on purpose, and that keeps the run honestly partial', async () => {
  const { rail } = railFor({
    auth_status: okAuth(),
    list_workflows_complete: okRoster(['w1']),
    get_workflow: (args) => okDefinition(args.workflowId),
    get_ai_configuration_bundle: { structuredContent: { ok: true, contractVersion: '1.0.0', data: {} } },
  });
  const evidence = await createInternalAuditCollector({ rail, boundLocationId: LOCATION })
    .collectAuditEvidence({ window: WINDOW });

  /*
   * The plugin's own documentation states the audit composites have never been run live and no
   * capability receipt exists, and the kernel machine-enforces "no receipt, no Full audit". So a
   * run on this rail is `complete_partial` by design, and that is correct: for an internal tool the
   * Full designation is compliance ceremony and the findings come out either way.
   *
   * Manufacturing a coverage row here to satisfy the gate would forge the one record that says
   * whether anything was ever proven. This test exists so nobody does it later by accident.
   */
  assert.deepEqual(evidence.capabilityCoverage, []);
});

test('readRosterIds is deduplicated, ordered, and honest about being unreadable', () => {
  assert.deepEqual(readRosterIds({ data: { workflowIds: ['b', 'a', 'b'] } }), { ids: ['a', 'b'], readable: true });
  assert.deepEqual(readRosterIds({ data: { workflows: [{ id: 'x' }] } }), { ids: ['x'], readable: true });
  assert.deepEqual(readRosterIds({ data: { roster: [{ workflowId: 'y' }] } }), { ids: ['y'], readable: true });
  assert.deepEqual(readRosterIds({ data: { workflowIds: [] } }), { ids: [], readable: true });
  assert.deepEqual(readRosterIds({ data: { nope: 1 } }), { ids: [], readable: false });
  assert.deepEqual(readRosterIds(null), { ids: [], readable: false });
});
