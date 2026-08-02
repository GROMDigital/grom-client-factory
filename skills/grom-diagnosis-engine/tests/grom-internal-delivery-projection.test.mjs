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

  assert.equal(edges.length, 8, 'one edge per rung of the delivery ladder');
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

test('the ladder is a chain: each rung starts where the last one ended', () => {
  const edges = deliveryEdges();
  for (let i = 1; i < edges.length; i += 1) {
    assert.equal(
      edges[i].fromStage,
      edges[i - 1].toStage,
      `${edges[i].edgeId} does not continue from ${edges[i - 1].edgeId} — the ladder has a gap`,
    );
  }
});

test('the contract binds phases by stage NAME, never by an account-specific id', () => {
  const source = deliverySource();
  for (const event of source.events) {
    assert.equal(event.when.field, 'deliveryStageName', `${event.eventId} must key on the name`);
    // Grom AU and Grom UK share no workflow, pipeline or stage ids, and they run the same
    // standardised build under the same stage names. An id in here would measure one account and
    // silently measure nothing on the other.
    assert.match(
      event.when.value,
      /^[a-z][a-z ]*$/u,
      `${event.eventId} binds "${event.when.value}", which looks like an id, not a stage name`,
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
    { id: 'STAGE_A', name: 'Creative In Progress' },
    { id: 'STAGE_B', name: '  Creative   Sent  ' },
  ],
}];

const workflow = (workflowId, stageIds, rows) => ({
  workflowId,
  definition: { triggers: stageIds.map((stageId) => ({ type: 'pipeline_stage_updated', stageId })) },
  runtime: { enrollments: { complete: true, rows } },
});

const evidenceFor = (workflows, pipelines = PIPELINES) => deliveryPhaseCollections({
  internalEvidence: { boundLocationId: 'LOC1', capturedAt: '2026-07-27T00:00:00.000Z', workflows },
  publicEvidence: {
    boundLocationId: 'LOC1',
    scopes: [{ operationId: 'opportunities-v3__get-pipelines', items: pipelines }],
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
      workflowId: 'WF_A',
    },
    {
      contactId: 'C1',
      enteredAt: '2026-07-09T00:00:00.000Z',
      deliveryStageName: 'creative sent',
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
