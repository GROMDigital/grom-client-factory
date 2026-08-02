/**
 * WHY A DELIVERY OPERATION COULD NOT SAY HOW LONG ITS OWN PHASES TAKE.
 *
 * Found on the 2026-07-27 Grom UK run. Ten `client_onboarding` edges sat at `nativeMapping:
 * UNKNOWN` and the profile told every analyst that everything from the internal handoff onward
 * "will always read as unmeasurable here, because the work happens in a portal we cannot see".
 *
 * That reasoning is right about whether a client APPROVED something and wrong about WHEN THE CARD
 * MOVED — and the second is the number a delivery operation actually needs. Three separate
 * single-workflow reviewers objected to it independently, each as an aside, which is exactly the
 * pattern the lane exists to surface. The cost was concrete: three delivery emails promise "we'll
 * come back to you" with no timeframe and none could be given one, because nobody knew how long
 * the phase took.
 *
 * The evidence was already arriving. Every delivery phase is a stage change on one pipeline, every
 * one of those stage changes already triggers a published workflow, and that workflow's enrollment
 * log already lands on every run. What was missing was that enrollments never reached the
 * projector, the rows were stripped to an instant with no subject on them, and the trigger — the
 * only thing that says WHICH phase a workflow marks — was hashed and thrown away.
 *
 * This file pins the parts that would fail silently if any of them regressed: an edge that reads
 * UNKNOWN publishes nothing at all, so nothing goes red, and the account simply goes back to being
 * told its delivery is unknowable.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DELIVERY_PHASE_OPERATION_ID,
  bindWorkflowsToStages,
  deliveryPhaseCollections,
  indexPipelineStages,
  normalizeStageName,
} from '../lib/delivery-phases.mjs';
import { loadMetricContracts, loadProjection } from '../schemas/v1.mjs';

const deliverySource = () => {
  const projection = loadProjection('grom_internal');
  const source = projection.sources.find((s) => s.sourceId === 'grom_delivery_phases');
  assert.ok(source, 'the delivery-phase source must exist, or no phase entry projects at all');
  return source;
};

const deliveryEdges = () => loadMetricContracts('grom_internal')
  .edges.filter((edge) => edge.journeyId === 'client_onboarding');

// ---------------------------------------------------------------------------
// The contract
// ---------------------------------------------------------------------------

test('every delivery edge is MAPPED, and none is still declared unmeasurable', () => {
  const projection = loadProjection('grom_internal');
  const declaredUnmeasurable = new Set(projection.unmeasurableEdges);
  const edges = deliveryEdges();

  assert.equal(edges.length, 10, 'eight main rungs plus the two revision loops');
  for (const edge of edges) {
    assert.equal(edge.nativeMapping, 'MAPPED', `${edge.edgeId} must be MAPPED`);
    // 🔴 The regression that matters. An UNKNOWN edge publishes NOTHING — no cell, no zero, no
    // warning — so putting one of these back on this list is completely silent at run time.
    assert.ok(
      !declaredUnmeasurable.has(edge.edgeId),
      `${edge.edgeId} is back on unmeasurableEdges and will silently publish nothing`,
    );
  }
});

test('every stage the delivery edges name is actually projectable', () => {
  const stages = new Set(deliverySource().events.map((event) => event.stage));
  for (const edge of deliveryEdges()) {
    // Both ends, not just the entry. An edge whose toStage nothing emits does not read UNKNOWN:
    // `metrics.mjs` publishes it as a confident zero over a real denominator, which is the one
    // outcome worse than admitting the gap.
    assert.ok(stages.has(edge.fromStage), `${edge.edgeId}: nothing emits "${edge.fromStage}"`);
    assert.ok(stages.has(edge.toStage), `${edge.edgeId}: nothing emits "${edge.toStage}"`);
  }
});

test('the MAIN LINE is a chain: each rung starts where the last one ended', () => {
  // Scoped to the main line on purpose. The two revision edges branch OFF a "sent" stage rather
  // than continuing from it — a revision is the client sending work back — so including them here
  // would assert a chain the delivery process does not have.
  const main = deliveryEdges().filter((e) => !e.edgeId.endsWith('_to_revision'));
  assert.equal(main.length, 8);
  for (let i = 1; i < main.length; i += 1) {
    assert.equal(
      main[i].fromStage,
      main[i - 1].toStage,
      `${main[i].edgeId} does not continue from ${main[i - 1].edgeId} — the ladder has a gap`,
    );
  }
});

test('🔴 every stage name the contract binds is a name the PIPELINE actually uses', () => {
  // The defect this pins: the first cut took two of these from the WORKFLOW name rather than the
  // STAGE name — "onboarding ready" for a stage called "Onboarding Form Sent", and "submitted for
  // review" for one called "Submitted - Awaiting Review". Neither could ever match, and a stage that
  // never matches produces no event, no error, and an edge that reads as permanently unmeasured.
  // Names verified against the live Onboarding pipeline 2026-08-02.
  const live = [
    'onboarding form sent', 'access in progress', 'submitted - awaiting review',
    'strategy in progress', 'strategy sent', 'strategy revision', 'creative in progress',
    'creative sent', 'creative revision', 'build in progress', 'live',
  ];
  const bound = deliverySource().events.map((e) => e.when.value);
  assert.deepEqual([...bound].sort(), [...live].sort());
});

test('the revision loops are observable, not folded into the phase they branch off', () => {
  const stages = new Set(deliverySource().events.map((e) => e.stage));
  assert.ok(stages.has('strategy_revision'));
  assert.ok(stages.has('creative_revision'));
  const loops = deliveryEdges().filter((e) => e.edgeId.endsWith('_to_revision'));
  assert.equal(loops.length, 2);
  // A revision branches off the SENT stage. Getting this backwards would measure the wrong thing.
  assert.deepEqual(loops.map((e) => [e.fromStage, e.toStage]), [
    ['strategy_sent', 'strategy_revision'],
    ['creative_sent', 'creative_revision'],
  ]);
});

test('the contract binds phases by stage NAME, never by an account-specific id', () => {
  const source = deliverySource();
  for (const event of source.events) {
    assert.equal(event.when.field, 'deliveryStageName', `${event.eventId} must key on the name`);
    // Grom AU and Grom UK share no workflow, pipeline or stage ids, and they run the same
    // standardised build under the same stage names. An id in here would measure one account and
    // silently measure nothing on the other.
    // A real stage label may hold a hyphen or an ampersand ("Submitted - Awaiting Review"), so the
    // test is not a charset whitelist. What it rules out is an ID: every GHL pipeline, stage and
    // workflow id contains digits, and no stage name in this pipeline does.
    assert.doesNotMatch(
      event.when.value,
      /\d/u,
      `${event.eventId} binds "${event.when.value}", which contains a digit and looks like an id`,
    );
    assert.equal(normalizeStageName(event.when.value), event.when.value,
      `${event.eventId} binds a name the normalizer would not produce, so it can never match`);
  }
});

test('the delivery source can prove its own events', () => {
  const source = deliverySource();
  // `evidence-graph.mjs` proves an event exactly two ways, and a source with neither leaves every
  // event unprovable — which blanks the edge for EVERY subject, not just the unprovable one.
  assert.deepEqual(source.identity.subjectNativeId, ['contactId']);
  assert.equal(source.entities.length, 1);
  assert.equal(source.entities[0].recordType, 'contact');
});

// ---------------------------------------------------------------------------
// The derivation
// ---------------------------------------------------------------------------

const PIPELINES = [{
  id: 'PIPE1',
  stages: [
    { id: 'STAGE_0', name: 'Onboarding Form Sent' },
    { id: 'STAGE_A', name: 'Creative In Progress' },
    { id: 'STAGE_B', name: '  Creative   Sent  ' },
  ],
}];

const workflow = (workflowId, stageIds, rows) => ({
  workflowId,
  definition: { triggers: stageIds.map((stageId) => ({ type: 'pipeline_stage_updated', stageId })) },
  runtime: { enrollments: { complete: true, rows } },
});

const evidenceFor = (workflows, pipelines = PIPELINES, opportunities = null) => deliveryPhaseCollections({
  internalEvidence: { boundLocationId: 'LOC1', capturedAt: '2026-07-27T00:00:00.000Z', workflows },
  publicEvidence: {
    boundLocationId: 'LOC1',
    scopes: [
      { operationId: 'opportunities-v3__get-pipelines', items: pipelines },
      ...(opportunities === null ? [] : [{ operationId: 'opportunities.list', items: opportunities }]),
    ],
  },
});

test('a stage name is matched the way a human reads it, not byte for byte', () => {
  // Builder labels are typed by hand and drift in case and spacing between accounts and renames.
  assert.equal(normalizeStageName('  Creative   Sent  '), 'creative sent');
  assert.equal(normalizeStageName('CREATIVE SENT'), 'creative sent');
  assert.equal(normalizeStageName('   '), null);
  assert.equal(normalizeStageName(null), null);
});

test('an enrollment becomes a phase entry, carrying its subject and its instant', () => {
  const [collection] = evidenceFor([
    workflow('WF_A', ['STAGE_A'], [{ contactId: 'C1', createdAt: '2026-07-01T00:00:00.000Z' }]),
    workflow('WF_B', ['STAGE_B'], [{ contactId: 'C1', createdAt: '2026-07-09T00:00:00.000Z' }]),
  ]);
  assert.equal(collection.operationId, DELIVERY_PHASE_OPERATION_ID);
  assert.equal(collection.source, 'internal_ghl');
  assert.equal(collection.page.complete, true);
  assert.deepEqual(collection.items, [
    {
      contactId: 'C1',
      enteredAt: '2026-07-01T00:00:00.000Z',
      deliveryStageName: 'creative in progress',
      evidenceOrigin: 'enrollment_log',
      workflowId: 'WF_A',
    },
    {
      contactId: 'C1',
      enteredAt: '2026-07-09T00:00:00.000Z',
      deliveryStageName: 'creative sent',
      evidenceOrigin: 'enrollment_log',
      workflowId: 'WF_B',
    },
  ]);
});

test('🔴 a workflow triggering on TWO stages is refused, never resolved to the first', () => {
  // An enrollment row says a subject entered THE WORKFLOW, not which trigger admitted them. Taking
  // the first would invent a phase entry that may never have happened.
  const [collection] = evidenceFor([
    workflow('WF_BOTH', ['STAGE_A', 'STAGE_B'], [{ contactId: 'C1', createdAt: '2026-07-01T00:00:00.000Z' }]),
    workflow('WF_B', ['STAGE_B'], [{ contactId: 'C1', createdAt: '2026-07-09T00:00:00.000Z' }]),
  ]);
  assert.deepEqual(collection.items.map((i) => i.workflowId), ['WF_B']);
  assert.equal(collection.page.complete, false);
  assert.equal(collection.incompleteReason, 'DELIVERY_PHASE_TRIGGER_AMBIGUOUS');
});

test('a workflow whose enrollment log is missing is a HOLE, not a phase nobody entered', () => {
  const missing = workflow('WF_A', ['STAGE_A'], []);
  delete missing.runtime.enrollments;
  const [collection] = evidenceFor([
    missing,
    workflow('WF_B', ['STAGE_B'], [{ contactId: 'C1', createdAt: '2026-07-09T00:00:00.000Z' }]),
  ]);
  assert.equal(collection.page.complete, false);
  assert.equal(collection.incompleteReason, 'DELIVERY_PHASE_ENROLLMENTS_MISSING');
});

test('a row with no contact is dropped rather than carried as a partial entry', () => {
  // The bare `inbound_webhook` workflows on this account enroll with no contact at all, so this is
  // the normal state of a whole class of workflow rather than a rare defect.
  const [collection] = evidenceFor([
    workflow('WF_A', ['STAGE_A'], [
      { createdAt: '2026-07-01T00:00:00.000Z' },
      { contactId: 'C2', createdAt: '2026-07-02T00:00:00.000Z' },
      { contactId: 'C3' },
    ]),
  ]);
  assert.deepEqual(collection.items.map((i) => i.contactId), ['C2']);
});

test('🔴 the all-time enrollment TOTAL is never read as the population of the rows', () => {
  // The totals are `scope: workflow_all_time`; the rows are `windowScoped: true`. They legitimately
  // disagree — 5 against 3, 159 against 112 — because they are different endpoints counting
  // different things. A builder that trusted the total would emit phase entries it does not hold.
  const wf = workflow('WF_A', ['STAGE_A'], [{ contactId: 'C1', createdAt: '2026-07-01T00:00:00.000Z' }]);
  wf.runtime.enrollments.windowScoped = true;
  wf.runtime.enrollmentTotals = { total: 159, finished: 140, scope: 'workflow_all_time' };
  const [collection] = evidenceFor([wf]);
  assert.equal(collection.items.length, 1, 'one row held is one entry emitted, whatever stats say');
  assert.equal(collection.page.reportedCount, 1);
});

test('no pipelines read means no envelope at all, not an empty one', () => {
  // "The account exposed no pipelines" and "this run never read pipelines" are different facts. An
  // empty envelope asserts the run looked and found nothing, which would publish a delivery ladder
  // nobody ever climbed.
  assert.deepEqual(deliveryPhaseCollections({
    internalEvidence: { workflows: [workflow('WF_A', ['STAGE_A'], [])] },
    publicEvidence: { scopes: [] },
  }), []);
  assert.deepEqual(deliveryPhaseCollections({ internalEvidence: null, publicEvidence: {} }), []);
});

test('a trigger pointing at a deleted stage names no phase and does not conflict with a real one', () => {
  const stageIndex = indexPipelineStages(PIPELINES);
  const { bound, ambiguous } = bindWorkflowsToStages([
    workflow('WF_A', ['STAGE_GONE', 'STAGE_A'], []),
  ], stageIndex);
  assert.deepEqual(ambiguous, []);
  assert.equal(bound.get('WF_A'), 'creative in progress');
});

test('phase entries come out in a deterministic order', () => {
  // The kernel byte-compares the measurement on resume, and the order workflows arrive in is the
  // adapter's, not this module's to depend on.
  const rows = (ids) => ids.map((n) => ({ contactId: n, createdAt: `2026-07-0${n[1]}T00:00:00.000Z` }));
  const forward = evidenceFor([
    workflow('WF_A', ['STAGE_A'], rows(['C3', 'C1', 'C2'])),
    workflow('WF_B', ['STAGE_B'], rows(['C2'])),
  ]);
  const reversed = evidenceFor([
    workflow('WF_B', ['STAGE_B'], rows(['C2'])),
    workflow('WF_A', ['STAGE_A'], rows(['C1', 'C2', 'C3'])),
  ]);
  assert.deepEqual(forward[0].items, reversed[0].items);
});

// ---------------------------------------------------------------------------
// The first rung, which no enrollment log can supply
// ---------------------------------------------------------------------------

test('the first rung is dated from the opportunity, because 01 has no stage trigger', () => {
  // `01 Onboarding Ready` fires on `opportunity_created`, not a stage change — the opportunity is
  // created INTO the first stage by the contract-signed handoff, so there is no earlier stage to
  // move from. Without this path the first rung is permanently unmeasured.
  const [collection] = evidenceFor(
    [workflow('WF_A', ['STAGE_A'], [{ contactId: 'C1', createdAt: '2026-07-05T00:00:00.000Z' }])],
    PIPELINES,
    [{ id: 'OPP1', contactId: 'C1', pipelineId: 'PIPE1', dateAdded: '2026-07-01T00:00:00.000Z' }],
  );
  const first = collection.items.filter((i) => i.deliveryStageName === 'onboarding form sent');
  assert.deepEqual(first, [{
    contactId: 'C1',
    enteredAt: '2026-07-01T00:00:00.000Z',
    deliveryStageName: 'onboarding form sent',
    evidenceOrigin: 'opportunity_created',
    workflowId: null,
  }]);
});

test('every row says which rail it came from', () => {
  // The one place two rails are combined. A row that cannot say where it came from cannot be
  // audited, and the two have different reliability: an enrollment log OBSERVED the entry, while an
  // opportunity ASSUMES it was created into the first stage.
  const [collection] = evidenceFor(
    [workflow('WF_A', ['STAGE_A'], [{ contactId: 'C1', createdAt: '2026-07-05T00:00:00.000Z' }])],
    PIPELINES,
    [{ id: 'OPP1', contactId: 'C1', pipelineId: 'PIPE1', dateAdded: '2026-07-01T00:00:00.000Z' }],
  );
  assert.deepEqual(
    [...new Set(collection.items.map((i) => i.evidenceOrigin))].sort(),
    ['enrollment_log', 'opportunity_created'],
  );
});

test('an opportunity in a pipeline with no delivery workflow contributes no first rung', () => {
  // Which pipeline is the delivery one is DERIVED from where the stage-triggered workflows point.
  // A sales opportunity must never be dated into the delivery journey.
  const [collection] = evidenceFor(
    [workflow('WF_A', ['STAGE_A'], [{ contactId: 'C1', createdAt: '2026-07-05T00:00:00.000Z' }])],
    PIPELINES,
    [{ id: 'OPP2', contactId: 'C9', pipelineId: 'SALES_PIPE', dateAdded: '2026-07-01T00:00:00.000Z' }],
  );
  assert.equal(collection.items.filter((i) => i.contactId === 'C9').length, 0);
});

test('no opportunities scope means no first rung, and the other rungs still stand', () => {
  const [collection] = evidenceFor(
    [workflow('WF_A', ['STAGE_A'], [{ contactId: 'C1', createdAt: '2026-07-05T00:00:00.000Z' }])],
  );
  assert.equal(collection.items.every((i) => i.evidenceOrigin === 'enrollment_log'), true);
  assert.equal(collection.items.length, 1);
});
