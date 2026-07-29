/**
 * THE INTERNAL COLLECTION PHASE.
 *
 * The shapes the doubles below carry are the ones `tests/internal-audit-contract.test.mjs` proves
 * against the REAL audit server: an `{ok, code}` envelope, `isError: false` on a refusal, a
 * latching circuit, and per-tool contract versions. So a double here cannot invent a reply the
 * server would never send, which is the failure mode that has hidden three defects on this project.
 *
 * As of the first live internal read (2026-07-27) the composites' SUCCESS shapes below are real and
 * no longer guesses. Getting them wrong was not hypothetical: every one of these tests passed
 * against the wrong shape, and the account is what corrected them.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createInternalAuditAdapter } from '../lib/adapters/internal-audit.mjs';
import {
  DEFAULT_BUDGETS,
  createInternalAuditCollector,
  readRosterIds,
} from '../lib/adapters/internal-audit-collector.mjs';
import {
  collectInternalEvidencePhase,
  currentClosedWeekWindow,
} from '../lib/modes/weekly.mjs';

const LOCATION = 'L1';
const WINDOW = Object.freeze({
  from: '2026-01-01T00:00:00.000Z',
  to: '2026-03-02T00:00:00.000Z',
});

test('the transcript window is the closed account-local week, not the public history horizon', () => {
  assert.deepEqual(
    currentClosedWeekWindow({
      cutoff: '2026-10-05T00:00:00.000Z',
      timezone: 'Australia/Sydney',
    }),
    {
      from: '2026-09-27T14:00:00.000Z',
      to: '2026-10-04T13:00:00.000Z',
    },
    'the DST transition belongs in the real seven-day account-local week',
  );
});

test('the internal phase carries a separate conversation window without narrowing workflow runtime', async () => {
  const conversationWindow = Object.freeze({
    from: '2026-02-23T00:00:00.000Z',
    to: '2026-03-02T00:00:00.000Z',
  });
  let received = null;
  const internalEvidence = {
    schemaVersion: '1.0.0',
    boundLocationId: LOCATION,
    complete: true,
    limitations: [],
    workflows: [],
  };
  await collectInternalEvidencePhase({
    adapter: {
      async collectAuditEvidence(request) {
        received = request;
        return internalEvidence;
      },
    },
    target: { locationId: LOCATION },
    window: WINDOW,
    conversationWindow,
    applicability: {},
    stepRosterRequests: {},
    publicEvidence: { scopes: [] },
    checkpoint: { schemaVersion: '1.0.0', phase: 'collecting_public' },
  });

  assert.deepEqual(received.window, WINDOW, 'workflow runtime keeps the broader governed window');
  assert.deepEqual(received.conversationWindow, conversationWindow, 'transcripts get the closed week');
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

/*
 * THE SHAPES BELOW ARE THE REAL ONES, and they were WRONG here until 2026-07-27 when the first
 * live internal read landed. Three corrections, each of which would have failed on the account:
 *
 *   1. Everything is under `data`. `complete`, `boundLocationId` and `contractVersion` are
 *      `data.*`, not top level. The adapter read the top level only and threw
 *      INTERNAL_AUDIT_CONTRACT_MISMATCH on a perfectly good reply.
 *   2. A roster row identifies itself with `_id`. Not `id`, not `workflowId`.
 *   3. `list_workflows_complete` carries NO `contractVersion` at all.
 */
const okAiBundle = {
  structuredContent: {
    ok: true,
    data: { contractVersion: '1.0.0', boundLocationId: LOCATION, complete: true, warnings: [], components: {} },
  },
};

const okRoster = (ids, extra = {}) => ({
  structuredContent: {
    ok: true,
    data: {
      boundLocationId: LOCATION,
      complete: true,
      reportedTotal: ids.length,
      uniqueCount: ids.length,
      warnings: [],
      workflows: ids.map((id) => ({ _id: id, locationId: LOCATION, name: `wf ${id}`, status: 'published' })),
      ...extra,
    },
  },
});

/*
 * `export_workflow`, because `get_workflow` returns a seven-field summary with NO steps. The step
 * graph is `data.workflow.workflowData.templates[]` -- 37 steps on the workflow probed live.
 */
const okDefinition = (workflowId) => ({
  structuredContent: {
    ok: true,
    data: {
      workflow: {
        _id: workflowId,
        locationId: LOCATION,
        name: `wf ${workflowId}`,
        status: 'published',
        allowMultiple: true,
        timezone: 'contact',
        stopOnResponse: false,
        workflowData: { templates: [{ id: 's1', type: 'wait', next: [], name: 'Wait' }] },
      },
      triggers: [{ id: 't1', type: 'facebook_lead_gen' }],
      stickyNotes: [],
    },
  },
});

const okRuntime = (workflowId) => ({
  structuredContent: {
    ok: true,
    data: {
      contractVersion: '2.0.0',
      boundLocationId: LOCATION,
      workflowId,
      complete: true,
      truncated: false,
      warnings: [],
      runtimeEvents: [],
      observedEventTypes: { byType: {}, byStatus: {} },
    },
  },
});

// ---------------------------------------------------------------------------

test('an expired credential stops before a single evidence call is spent', async () => {
  const { rail, calls } = railFor({
    auth_status: okAuth(-259_083),
    list_workflows_complete: () => { throw new Error('MUST NOT BE CALLED'); },
  });
  const collector = createInternalAuditCollector({ rail, boundLocationId: LOCATION, runtimeWorkflowIds: [] });
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
    export_workflow: (args) => okDefinition(args.workflowId),
    get_workflow_runtime_window: (args) => okRuntime(args.workflowId),
    get_ai_configuration_bundle: okAiBundle,
  });
  const collector = createInternalAuditCollector({
    rail, boundLocationId: LOCATION, runtimeWorkflowIds: ['w2'],
  });
  const evidence = await collector.collectAuditEvidence({ window: WINDOW });

  assert.deepEqual(evidence.workflows.map(({ workflowId }) => workflowId), ['w1', 'w2', 'w3']);
  // Three cheap definition reads, exactly one expensive runtime read.
  assert.equal(calls.filter(({ name }) => name === 'export_workflow').length, 3);
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
    export_workflow: (args) => (args.workflowId === 'w2'
      ? { structuredContent: { ok: false, code: 'RATE_LIMITED' } }
      : okDefinition(args.workflowId)),
    get_ai_configuration_bundle: () => { throw new Error('MUST NOT BE CALLED AFTER A LATCH'); },
  });
  const collector = createInternalAuditCollector({ rail, boundLocationId: LOCATION, runtimeWorkflowIds: [] });
  const evidence = await collector.collectAuditEvidence({ window: WINDOW });

  // w1 read, w2 refused and latched, w3 and w4 never attempted. Nothing auto-retries after a
  // latch, so continuing would be waste that also destroys the partial.
  assert.equal(calls.filter(({ name }) => name === 'export_workflow').length, 2);
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
    list_workflows_complete: { structuredContent: { ok: true, data: { boundLocationId: LOCATION, somethingElse: 1 } } },
    get_ai_configuration_bundle: okAiBundle,
  });
  const collector = createInternalAuditCollector({ rail, boundLocationId: LOCATION, runtimeWorkflowIds: [] });
  const evidence = await collector.collectAuditEvidence({ window: WINDOW });
  assert.equal(evidence.complete, false);
  assert.ok(evidence.limitations.includes('ROSTER_SHAPE_UNREADABLE'));
  assert.deepEqual(evidence.workflows, []);

  // A genuinely, explicitly empty roster IS a real answer and must not be confused with the above.
  const { rail: emptyRail } = railFor({
    auth_status: okAuth(),
    list_workflows_complete: okRoster([]),
    get_ai_configuration_bundle: okAiBundle,
  });
  const empty = await createInternalAuditCollector({ rail: emptyRail, boundLocationId: LOCATION })
    .collectAuditEvidence({ window: WINDOW });
  assert.equal(empty.limitations.includes('ROSTER_SHAPE_UNREADABLE'), false);
  assert.equal(empty.complete, true);
});

test('a stale-looking agency token is TRIED, because the check would be a forecast', async () => {
  /*
   * This used to assert the opposite, and the opposite cost a live run both of its AI agents.
   *
   * The freshness check is taken at preflight and the AI bundle is read LAST, after every workflow,
   * so gating on it forecasts a credential's state minutes into the future. On Grom UK 2026-07-29 a
   * run whose location JWT still had half an hour left skipped the entire AI surface on that
   * forecast, and the copy lane read `available: false` on an account whose AI books more
   * appointments than any other route.
   *
   * Trying it is safe because it is last: everything else is already collected.
   */
  const { rail, calls } = railFor({
    // The location JWT is healthy; the elevated agency token-id looks expired.
    auth_status: okAuth(3600, -10),
    list_workflows_complete: okRoster(['w1']),
    export_workflow: (args) => okDefinition(args.workflowId),
    get_ai_configuration_bundle: okAiBundle,
  });
  const evidence = await createInternalAuditCollector({ rail, boundLocationId: LOCATION, runtimeWorkflowIds: [] })
    .collectAuditEvidence({ window: WINDOW });

  assert.equal(calls.some(({ name }) => name === 'get_ai_configuration_bundle'), true);
  assert.notEqual(evidence.aiConfiguration, null);
  assert.equal(evidence.limitations.includes('AGENCY_TOKEN_UNAVAILABLE'), false);
});

test('no agency token at all is skipped and SAID SO, because there is nothing to try', async () => {
  const { rail, calls } = railFor({
    auth_status: {
      structuredContent: {
        ok: true,
        data: {
          jwtClaims: { present: true, secondsRemaining: 3600 },
          tokenIdClaims: { present: false, secondsRemaining: null },
        },
      },
    },
    list_workflows_complete: okRoster(['w1']),
    export_workflow: (args) => okDefinition(args.workflowId),
    get_ai_configuration_bundle: () => { throw new Error('MUST NOT BE CALLED'); },
  });
  const evidence = await createInternalAuditCollector({ rail, boundLocationId: LOCATION, runtimeWorkflowIds: [] })
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
    export_workflow: (args) => okDefinition(args.workflowId),
    get_ai_configuration_bundle: okAiBundle,
  });
  const evidence = await createInternalAuditCollector({
    rail, boundLocationId: LOCATION, runtimeWorkflowIds: [], budgets: { maxDefinitions: 2 },
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
    export_workflow: (args) => okDefinition(args.workflowId),
    get_workflow_runtime_window: (args) => okRuntime(args.workflowId),
    get_ai_configuration_bundle: okAiBundle,
  });
  const evidence = await createInternalAuditCollector({
    rail, boundLocationId: LOCATION, runtimeWorkflowIds: ['w1', 'deleted-workflow'],
  }).collectAuditEvidence({ window: WINDOW });
  assert.ok(evidence.limitations.includes('RUNTIME_WORKFLOW_NOT_IN_ROSTER'));
  // And the one that DOES exist is still read, because a stale config entry must not cost the
  // account its runtime evidence.
  assert.equal(calls.filter(({ name }) => name === 'get_workflow_runtime_window').length, 1);
});

test('runtime covers EVERY workflow when no subset is named', async () => {
  const { rail, calls } = railFor({
    auth_status: okAuth(),
    list_workflows_complete: okRoster(['w1', 'w2', 'w3']),
    export_workflow: (args) => okDefinition(args.workflowId),
    get_workflow_runtime_window: (args) => okRuntime(args.workflowId),
    get_ai_configuration_bundle: okAiBundle,
  });
  // No `runtimeWorkflowIds` at all. This is the shape every account had before 2026-07-29, and it
  // used to collect ZERO runtime windows while looking like a complete run.
  const evidence = await createInternalAuditCollector({
    rail, boundLocationId: LOCATION,
  }).collectAuditEvidence({ window: WINDOW });

  assert.equal(calls.filter(({ name }) => name === 'get_workflow_runtime_window').length, 3);
  for (const workflow of evidence.workflows) {
    assert.ok(workflow.runtimeWindow, `${workflow.workflowId} should have runtime`);
    assert.equal(workflow.runtimeCode, null);
  }
  assert.equal(evidence.complete, true);
  assert.deepEqual(evidence.limitations, []);
});

test('an explicit subset still wins, and an explicit empty list still means none', async () => {
  const base = {
    auth_status: okAuth(),
    list_workflows_complete: okRoster(['w1', 'w2', 'w3']),
    export_workflow: (args) => okDefinition(args.workflowId),
    get_workflow_runtime_window: (args) => okRuntime(args.workflowId),
    get_ai_configuration_bundle: okAiBundle,
  };

  const subset = railFor(base);
  await createInternalAuditCollector({
    rail: subset.rail, boundLocationId: LOCATION, runtimeWorkflowIds: ['w2'],
  }).collectAuditEvidence({ window: WINDOW });
  assert.equal(subset.calls.filter(({ name }) => name === 'get_workflow_runtime_window').length, 1);

  const none = railFor(base);
  const evidence = await createInternalAuditCollector({
    rail: none.rail, boundLocationId: LOCATION, runtimeWorkflowIds: [],
  }).collectAuditEvidence({ window: WINDOW });
  assert.equal(none.calls.filter(({ name }) => name === 'get_workflow_runtime_window').length, 0);
  // Opting out stays sayable, and stays distinguishable from asking and getting nothing.
  assert.equal(evidence.workflows[0].runtimeCode, 'RUNTIME_NOT_REQUESTED');
});

test('covering all workflows is still bounded, and truncation is disclosed', async () => {
  const { rail, calls } = railFor({
    auth_status: okAuth(),
    list_workflows_complete: okRoster(['w1', 'w2', 'w3']),
    export_workflow: (args) => okDefinition(args.workflowId),
    get_workflow_runtime_window: (args) => okRuntime(args.workflowId),
    get_ai_configuration_bundle: okAiBundle,
  });
  const evidence = await createInternalAuditCollector({
    rail, boundLocationId: LOCATION, budgets: { maxRuntimeWindows: 2 },
  }).collectAuditEvidence({ window: WINDOW });

  assert.equal(calls.filter(({ name }) => name === 'get_workflow_runtime_window').length, 2);
  assert.ok(evidence.limitations.includes('RUNTIME_BUDGET_EXHAUSTED'));
});

test('capabilityCoverage is EMPTY, on purpose, and that keeps the run honestly partial', async () => {
  const { rail } = railFor({
    auth_status: okAuth(),
    list_workflows_complete: okRoster(['w1']),
    export_workflow: (args) => okDefinition(args.workflowId),
    get_ai_configuration_bundle: okAiBundle,
  });
  const evidence = await createInternalAuditCollector({ rail, boundLocationId: LOCATION, runtimeWorkflowIds: [] })
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
