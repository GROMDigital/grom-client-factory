/**
 * Task A2a round 2 — EVERY event a metric consumes must be trustworthy, entrant AND conversion.
 *
 * Round 1 scoped uncertainty to the subject but applied the trust checks only to the ENTRANT of an
 * edge, dropping two guarantees the journey-wide gate had enforced over every event: `isObserved`
 * on the population, and `hasProvingJoin` on each event. These tests pin the guarantee back on,
 * this time per subject rather than per account.
 *
 * F1, F2 and F3 are driven through the REAL chain — `normalizeEvidence` -> `buildEvidenceGraph` ->
 * `computeJourneyMetrics` — on the shipped weekly fixture, so no oracle here is derived from the
 * code under test. Every count is hand-stated in a comment beside the assertion that needs it.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { buildEvidenceGraph } from '../lib/evidence-graph.mjs';
import { buildWindows, computeJourneyMetrics } from '../lib/metrics.mjs';
import { buildMechanismPacket, nominateMechanisms } from '../lib/mechanisms.mjs';
import { normalizeEvidence } from '../lib/normalize.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const gromProfile = JSON.parse(readFileSync(join(here, '../profiles/grom-internal.v1.json'), 'utf8'));

function gromFixture() {
  return JSON.parse(readFileSync(
    join(here, 'fixtures/weekly/grom-dual-journey-portal-complete/input.json'),
    'utf8',
  ));
}

const GROM_WINDOWS = () => buildWindows({
  cutoff: '2026-07-20T10:00:00Z',
  timezone: 'UTC',
  maturityDays: 0,
});

function ref(character) {
  return `ev_${character.repeat(16)}`;
}

function contactRecord(nativeId, evidenceRef, extra = {}) {
  return {
    recordType: 'contact',
    nativeId,
    eventTime: '2026-07-13T01:00:00.000Z',
    evidenceRef,
    ...extra,
  };
}

function agencyEvent(nativeId, subjectNativeId, stage, eventTime, evidenceRef, extra = {}) {
  return {
    recordType: 'journey_event',
    nativeId,
    subjectNativeId,
    stage,
    journeyId: 'agency_new_business',
    journeyInstanceId: 'journey_agency_new_business',
    eventTime,
    evidenceRef,
    ...extra,
  };
}

function push(value, ...items) {
  value.collections[0].items.push(...items);
  value.collections[0].page.reportedCount += items.length;
  value.collections[0].page.collectedCount += items.length;
}

function realGraphFor(value) {
  const records = normalizeEvidence(value.collections, value.context);
  return buildEvidenceGraph({ records, context: value.context, profile: gromProfile });
}

function acquisitionContract(extra = {}) {
  return {
    edgeId: 'acquisition',
    journeyId: 'agency_new_business',
    journeyInstanceId: 'journey_agency_new_business',
    fromStage: 'enquiry',
    toStage: 'won',
    allowedLag: { amount: 2, unit: 'days' },
    reentryRule: extra.reentryRule ?? 'same_journey_instance',
    required: true,
    nativeMapping: 'MAPPED',
    eligibilityRule: extra.eligibilityRule ?? { minimumSample: 1 },
  };
}

function measureReal(graph, contract) {
  return computeJourneyMetrics({
    graph,
    metricContracts: { version: '1.0.0', edges: [contract] },
    windows: GROM_WINDOWS(),
  }).metrics.currentClosedWeek.acquisition;
}

/**
 * F1. The entrant/conversion match runs on `eventKey`, which under
 * `reentryRule: "new_journey_instance"` is the COHORT INSTANCE, not the subject. Round 1 keyed
 * exclusions by `subjectKey`, so a conversion belonging to a tainted subject was credited to a
 * clean entrant that shared its cohort instance. Eight of the ten shipped client edges use that
 * re-entry rule.
 */
test('a conversion belonging to a tainted subject cannot be credited to a clean entrant', () => {
  const value = gromFixture();
  // The shipped won event is re-attributed to contact-2, which shares an email address with
  // contact-3 and is therefore named by a duplicate-identity conflict. It keeps cohort_a, the
  // cohort instance contact-1's clean enquiry entered under.
  const enquiry = value.collections[0].items.find(({ nativeId }) => nativeId === 'event-enquiry');
  const won = value.collections[0].items.find(({ nativeId }) => nativeId === 'event-won');
  enquiry.cohortInstanceRef = 'cohort_a';
  won.cohortInstanceRef = 'cohort_a';
  won.subjectNativeId = 'contact-2';
  push(
    value,
    contactRecord('contact-2', ref('a'), { normalizedEmail: 'dupe@example.test' }),
    contactRecord('contact-3', ref('b'), { normalizedEmail: 'dupe@example.test' }),
    contactRecord('contact-4', ref('c')),
    agencyEvent('event-enquiry-4', 'contact-4', 'enquiry', '2026-07-13T02:30:00.000Z', ref('d'), {
      cohortInstanceRef: 'cohort_b',
    }),
  );
  const graph = realGraphFor(value);
  // Hand-stated: ONE duplicate-identity conflict, over the two contact entities that share
  // dupe@example.test. The graph itself flags the evidence the won event rests on.
  assert.equal(graph.conflicts.length, 1);
  assert.equal(graph.conflicts[0].type, 'duplicate_identity_claim');

  // TWO enquiries enter the closed week (cohort_a and cohort_b). The only won event is the
  // tainted one, so nothing trustworthy converted.
  const permissive = measureReal(graph, acquisitionContract({
    reentryRule: 'new_journey_instance',
    eligibilityRule: { minimumSample: 1, minimumCoverage: 0.5 },
  }));
  assert.equal(permissive.state, 'OBSERVED');
  assert.equal(permissive.eligible, 2);
  assert.equal(permissive.denominator, 1);
  assert.equal(permissive.numerator, 0);
  assert.equal(permissive.excluded, 1);
  assert.deepEqual(permissive.exclusions, { IDENTITY_CONFLICT: 1 });
  assert.equal(permissive.coverageRatio, 0.5);
  assert.equal(permissive.coverage, 'INCOMPLETE');

  // At the documented default floor the same graph is not measurable at all, and says so.
  const guarded = measureReal(graph, acquisitionContract({ reentryRule: 'new_journey_instance' }));
  assert.equal(guarded.state, 'UNKNOWN');
  assert.equal(guarded.reasonCode, 'COVERAGE_BELOW_FLOOR');
  assert.equal(guarded.rate, null);
});

/**
 * F2. The baseline gate returned UNKNOWN when ANY event lacked a proving identity join. Round 1
 * consulted `hasProvingJoin` only through the entrant, so a conversion naming a contact that was
 * never collected was credited.
 */
test('a conversion with no proving identity join cannot be credited to its entrant', () => {
  const value = gromFixture();
  const enquiry = value.collections[0].items.find(({ nativeId }) => nativeId === 'event-enquiry');
  const won = value.collections[0].items.find(({ nativeId }) => nativeId === 'event-won');
  enquiry.cohortInstanceRef = 'cohort_a';
  won.cohortInstanceRef = 'cohort_a';
  // contact-9 is never collected, so no identity edge can ever prove this event is contact-9's.
  won.subjectNativeId = 'contact-9';
  push(
    value,
    contactRecord('contact-4', ref('c')),
    agencyEvent('event-enquiry-4', 'contact-4', 'enquiry', '2026-07-13T02:30:00.000Z', ref('d'), {
      cohortInstanceRef: 'cohort_b',
    }),
  );
  const graph = realGraphFor(value);
  const wonNode = graph.nodes.find(({ evidenceRefs }) => evidenceRefs.includes('ev_6666666666666666'));
  // Hand-stated: no `identity_exact` edge terminates on the won event, because its subject was
  // never collected and it carries no organisation, email or phone to fall back on.
  assert.equal(
    graph.edges.filter(({ type, toNodeId }) => (
      type === 'identity_exact' && toNodeId === wonNode.nodeId
    )).length,
    0,
  );
  assert.equal(graph.conflicts.length, 0);

  const permissive = measureReal(graph, acquisitionContract({
    reentryRule: 'new_journey_instance',
    eligibilityRule: { minimumSample: 1, minimumCoverage: 0.5 },
  }));
  // TWO enquiries, one of which has an unprovable conversion and is therefore not measurable.
  assert.equal(permissive.state, 'OBSERVED');
  assert.equal(permissive.eligible, 2);
  assert.equal(permissive.denominator, 1);
  assert.equal(permissive.numerator, 0);
  assert.equal(permissive.excluded, 1);
  assert.deepEqual(permissive.exclusions, { UNPROVEN_JOIN: 1 });
  assert.equal(permissive.coverageRatio, 0.5);

  const guarded = measureReal(graph, acquisitionContract({ reentryRule: 'new_journey_instance' }));
  assert.equal(guarded.state, 'UNKNOWN');
  assert.equal(guarded.reasonCode, 'COVERAGE_BELOW_FLOOR');
});

/**
 * F3. The population scan matched by STAGE with no `isObserved` and no type filter, while taint
 * seeding covered only `journey_event`/`portal_milestone`. A stage-bearing row of any other type
 * therefore entered the denominator and could never acquire a taint.
 */
test('untrusted stage-bearing rows are counted as excluded, never admitted uncounted', () => {
  const value = gromFixture();
  push(
    value,
    contactRecord('contact-4', ref('c')),
    agencyEvent('event-enquiry-4', 'contact-4', 'enquiry', '2026-07-13T02:30:00.000Z', ref('d')),
    agencyEvent('event-won-4', 'contact-4', 'won', '2026-07-14T02:30:00.000Z', ref('e')),
  );
  // A SEPARATE, TRUNCATED collection of opportunity rows. `normalize.mjs` forces these to
  // classification UNKNOWN with INCOMPLETE provenance, and they carry a journey stage.
  value.collections.push({
    source: 'internal_ghl',
    operationId: 'opportunities-weekly',
    boundLocationId: 'GROM',
    requestedWindow: { from: '2026-07-13T00:00:00.000Z', to: '2026-07-20T00:00:00.000Z' },
    appliedWindow: { from: '2026-07-13T00:00:00.000Z', to: '2026-07-20T00:00:00.000Z' },
    capturedAt: '2026-07-20T01:10:00.000Z',
    incompleteReason: 'PAGE_LIMIT_REACHED',
    items: [
      {
        recordType: 'opportunity',
        nativeId: 'opportunity-7',
        subjectNativeId: 'contact-7',
        stage: 'enquiry',
        journeyId: 'agency_new_business',
        journeyInstanceId: 'journey_agency_new_business',
        eventTime: '2026-07-13T03:00:00.000Z',
        evidenceRef: ref('7'),
      },
      {
        recordType: 'opportunity',
        nativeId: 'opportunity-8',
        subjectNativeId: 'contact-8',
        stage: 'enquiry',
        journeyId: 'agency_new_business',
        journeyInstanceId: 'journey_agency_new_business',
        eventTime: '2026-07-13T03:30:00.000Z',
        evidenceRef: ref('8'),
      },
    ],
    page: {
      cursor: null,
      nextCursor: 'cursor-2',
      reportedCount: 40,
      collectedCount: 2,
      complete: false,
      truncated: true,
    },
  });
  const graph = realGraphFor(value);
  // Hand-stated: no conflicts, and ONE unresolved join per incomplete opportunity row.
  assert.equal(graph.conflicts.length, 0);
  assert.equal(
    graph.unresolvedJoins.filter(({ reason }) => reason === 'INCOMPLETE_EVIDENCE').length,
    2,
  );

  const permissive = measureReal(graph, acquisitionContract({
    eligibilityRule: { minimumSample: 1, minimumCoverage: 0.5 },
  }));
  // FOUR rows claim the entry stage: two trustworthy journey events (both won) and two
  // untrustworthy opportunity rows. The rate is 2/2 over what could be measured, and the two
  // dropped rows are visible on the metric.
  assert.equal(permissive.state, 'OBSERVED');
  assert.equal(permissive.eligible, 4);
  assert.equal(permissive.denominator, 2);
  assert.equal(permissive.numerator, 2);
  assert.equal(permissive.rate, 1);
  assert.equal(permissive.excluded, 2);
  assert.deepEqual(permissive.exclusions, { NON_METRIC_EVENT_TYPE: 2 });
  assert.equal(permissive.coverageRatio, 0.5);
  assert.equal(permissive.coverage, 'INCOMPLETE');

  // Round 1 reported 2/4 at full confidence and COMPLETE coverage: an unearned number, a false
  // understatement of the rate and an overstatement of coverage at once.
  assert.notEqual(permissive.rate, 0.5);

  const guarded = measureReal(graph, acquisitionContract());
  assert.equal(guarded.state, 'UNKNOWN');
  assert.equal(guarded.reasonCode, 'COVERAGE_BELOW_FLOOR');
  assert.equal(guarded.eligible, 4);
  assert.equal(guarded.excluded, 2);
  assert.notEqual(guarded.coverage, 'COMPLETE');
});

/* ------------------------------------------------------------------------- */
/* F4, F5, F7, F8 and the contract-consistency items                          */
/* ------------------------------------------------------------------------- */

const CUTOFF = '2026-03-09T10:15:00-07:00';
const ZONE = 'America/Los_Angeles';
/** Inside `currentClosedWeek` (2026-03-02 -> 2026-03-09 local) and mature at a one-day lag. */
const LEAD_AT = '2026-03-03T09:00:00-08:00';
const ENGAGED_AT = '2026-03-03T15:00:00-08:00';
/** Inside `previousClosedWeek` (2026-02-23 -> 2026-03-02 local). */
const PRIOR_LEAD_AT = '2026-02-24T09:00:00-08:00';

function freeze(value) {
  for (const child of Object.values(value)) {
    if (child && typeof child === 'object') freeze(child);
  }
  return Object.freeze(value);
}

function localWindows() {
  return buildWindows({ cutoff: CUTOFF, timezone: ZONE, maturityDays: 0 });
}

function subjectRef(index) {
  return `psn_subject00000000${index}`;
}

function entityId(index) {
  return `entity_${subjectRef(index)}`;
}

function node(id, index, stage, eventTime, extra = {}) {
  return {
    nodeId: `node_${id}`,
    type: 'journey_event',
    classification: 'OBSERVED',
    journeyId: 'client_sales',
    journeyInstanceId: 'journey_client_sales',
    subjectRef: subjectRef(index),
    stage,
    eventTime,
    capturedAt: '2026-03-09T07:00:00Z',
    provenance: { completeness: 'COMPLETE' },
    evidenceRefs: [`ev_${id.padEnd(16, '0')}`],
    ...extra,
  };
}

function identityEdges(nodes) {
  return nodes.map((item) => ({
    type: 'identity_exact',
    fromNodeId: `entity_${item.subjectRef}`,
    toNodeId: item.nodeId,
    joinMethod: 'native_id',
    joinConfidence: 'exact',
  }));
}

function localGraph(nodes, extra = {}) {
  return freeze({
    nodes,
    edges: [...identityEdges(nodes), ...(extra.edges ?? [])],
    conflicts: extra.conflicts ?? [],
    unresolvedJoins: extra.unresolvedJoins ?? [],
  });
}

function localContract(extra = {}) {
  return {
    edgeId: 'engagement',
    journeyId: 'client_sales',
    journeyInstanceId: 'journey_client_sales',
    fromStage: 'lead_created',
    toStage: 'first_engagement',
    allowedLag: { amount: 1, unit: 'days' },
    reentryRule: 'same_journey_instance',
    required: true,
    nativeMapping: 'MAPPED',
    eligibilityRule: extra.eligibilityRule ?? { minimumSample: 1 },
  };
}

function measureLocal(graph, contract, windowName = 'currentClosedWeek') {
  return computeJourneyMetrics({
    graph,
    metricContracts: { version: '1.0.0', edges: [contract] },
    windows: localWindows(),
  }).metrics[windowName][contract.edgeId];
}

/**
 * F5. `unplaceable` was gathered from every from-stage node in the graph, while the `placed` set
 * that suppressed it only knew about subjects that entered THIS window. A subject placed in one
 * window was therefore counted as unplaceable in every other one.
 */
test('a subject placed in another window is not re-counted as unplaceable here', () => {
  // THREE subjects enter this closed week and TWO of them engage. A FOURTH subject entered the
  // PREVIOUS closed week and additionally carries one entry row with no usable event time.
  const nodes = [
    node('lead0', 0, 'lead_created', LEAD_AT),
    node('engaged0', 0, 'first_engagement', ENGAGED_AT),
    node('lead1', 1, 'lead_created', LEAD_AT),
    node('engaged1', 1, 'first_engagement', ENGAGED_AT),
    node('lead2', 2, 'lead_created', LEAD_AT),
    node('lead3prior', 3, 'lead_created', PRIOR_LEAD_AT),
    { ...node('lead3broken', 3, 'lead_created', LEAD_AT), eventTime: null },
  ];
  const current = measureLocal(localGraph(nodes), localContract());
  assert.equal(current.state, 'OBSERVED');
  assert.equal(current.eligible, 3);
  assert.equal(current.denominator, 3);
  assert.equal(current.numerator, 2);
  assert.equal(current.excluded, 0);
  assert.deepEqual(current.exclusions, {});
  assert.equal(current.coverageRatio, 1);
  assert.equal(current.coverage, 'COMPLETE');

  // Subject 3's untrustworthy row is charged ONCE, to the window its subject actually entered,
  // instead of to every window in the run.
  const previous = measureLocal(localGraph(nodes), localContract(), 'previousClosedWeek');
  assert.equal(previous.state, 'UNKNOWN');
  assert.equal(previous.reasonCode, 'ALL_SUBJECTS_EXCLUDED');
  assert.equal(previous.eligible, 1);
  assert.equal(previous.excluded, 1);
  assert.deepEqual(previous.exclusions, { NON_OBSERVED_EVIDENCE: 1 });

  // A subject with NO placeable entry row anywhere is still counted, in every window, because
  // nothing places it in one rather than another.
  const orphan = [
    node('lead0', 0, 'lead_created', LEAD_AT),
    node('engaged0', 0, 'first_engagement', ENGAGED_AT),
    { ...node('lead9', 9, 'lead_created', LEAD_AT), eventTime: null },
  ];
  const withOrphan = measureLocal(
    localGraph(orphan),
    localContract({ eligibilityRule: { minimumSample: 1, minimumCoverage: 0.5 } }),
  );
  assert.equal(withOrphan.eligible, 2);
  assert.equal(withOrphan.denominator, 1);
  assert.deepEqual(withOrphan.exclusions, { UNPLACEABLE_EVENT_TIME: 1 });
});

/**
 * F7. The taint closure's edge policy must be a stated decision, not an accident of which types
 * happened to exist when it was written: an edge type added later that carries identity must
 * default to being traversed.
 */
test('the taint closure traverses every edge type except the ones proven not to carry identity', () => {
  // TEN subjects enter, SEVEN of them engage.
  const nodes = [];
  for (let index = 0; index < 10; index += 1) {
    nodes.push(node(`lead${index}`, index, 'lead_created', LEAD_AT));
    if (index <= 6) nodes.push(node(`engaged${index}`, index, 'first_engagement', ENGAGED_AT));
  }
  const permissive = { minimumSample: 1, minimumCoverage: 0.5 };

  // An edge type this file has never seen, reaching subject 3's identity through a bridge node
  // that a conflict names. Failing toward MORE taint is the only safe default.
  const future = measureLocal(
    localGraph(nodes, {
      edges: [{
        type: 'identity_probabilistic_v2',
        fromNodeId: entityId(3),
        toNodeId: 'node_bridge',
        joinMethod: 'future',
        joinConfidence: 'probable',
      }],
      conflicts: [{ conflictId: 'conflict_bridge', nodeIds: ['node_bridge'] }],
    }),
    localContract({ eligibilityRule: permissive }),
  );
  assert.equal(future.eligible, 10);
  assert.equal(future.denominator, 9);
  assert.equal(future.numerator, 6); // subject 3 converted, so its exclusion costs a numerator.
  assert.deepEqual(future.exclusions, { IDENTITY_CONFLICT: 1 });

  // `execution_emitted` is the stated exception: a workflow-definition node is shared by every
  // contact it ever touched, so traversing it would merge unrelated subjects.
  const shared = measureLocal(
    localGraph(nodes, {
      edges: [{
        type: 'execution_emitted',
        fromNodeId: 'node_workflow_definition',
        toNodeId: entityId(3),
        joinMethod: 'workflow_definition_hash',
        joinConfidence: 'exact',
      }],
      conflicts: [{ conflictId: 'conflict_definition', nodeIds: ['node_workflow_definition'] }],
    }),
    localContract({ eligibilityRule: permissive }),
  );
  assert.equal(shared.eligible, 10);
  assert.equal(shared.denominator, 10);
  assert.deepEqual(shared.exclusions, {});
});

/** F8. A declared floor of zero disables the guard, so it must never be silent. */
test('a coverage floor of zero is declared on the metric and travels downstream', () => {
  const nodes = [];
  for (let index = 0; index < 10; index += 1) {
    nodes.push(node(`lead${index}`, index, 'lead_created', LEAD_AT));
    if (index <= 6) nodes.push(node(`engaged${index}`, index, 'first_engagement', ENGAGED_AT));
  }
  const graph = localGraph(nodes, {
    conflicts: [{
      conflictId: 'conflict_five',
      nodeIds: [entityId(0), entityId(1), entityId(2), entityId(7), entityId(8)],
    }],
  });
  const disabled = measureLocal(graph, localContract({
    eligibilityRule: { minimumSample: 1, minimumCoverage: 0 },
  }));
  assert.equal(disabled.state, 'OBSERVED');
  assert.equal(disabled.coverageFloor, 0);
  assert.equal(disabled.coverageFloorDisabled, true);
  assert.equal(disabled.coverageRatio, 0.5);

  const guarded = measureLocal(graph, localContract({
    eligibilityRule: { minimumSample: 1, minimumCoverage: 0.4 },
  }));
  assert.equal(guarded.coverageFloorDisabled, undefined);

  const profileWide = computeJourneyMetrics({
    graph,
    metricContracts: {
      version: '1.0.0',
      coverageFloor: 0,
      edges: [localContract({ eligibilityRule: { minimumSample: 1 } })],
    },
    windows: localWindows(),
  }).metrics.currentClosedWeek.engagement;
  assert.equal(profileWide.coverageFloorDisabled, true);
});

/** A contract whose `minimumSample` the schema rejects must not degrade quietly to zero here. */
test('an invalid minimumSample is a contract error, not a silent threshold of zero', () => {
  const nodes = [node('lead0', 0, 'lead_created', LEAD_AT)];
  for (const invalid of [-2, 1.5, '3', null]) {
    assert.throws(
      () => measureLocal(
        localGraph(nodes),
        localContract({ eligibilityRule: { minimumSample: invalid } }),
      ),
      /METRICS_CONTRACT_INVALID/,
      String(invalid),
    );
  }
  const absent = measureLocal(localGraph(nodes), localContract({ eligibilityRule: {} }));
  assert.equal(absent.threshold, 0);
});

/* ------------------------------------------------------------------------- */
/* F4 — exclusions must be visible downstream                                 */
/* ------------------------------------------------------------------------- */

const H = (character) => character.repeat(64);
const FAMILIES = [
  'calendar_capacity_or_timezone',
  'delivery_failure',
  'duplicates_tests_or_legacy_imports',
  'historical_configuration_drift',
  'offer_or_pricing',
  'ownership_or_handoff',
  'source_or_lead_quality_mix',
  'stage_or_disposition_data_quality',
  'workflow_configuration_or_execution',
];

function mechanismGraph() {
  const definitionHash = H('a');
  const edge = (index, type) => ({
    edgeId: `edge_${String(index).padStart(16, '0')}`,
    type,
    fromNodeId: `node_${String(index).padStart(16, '0')}`,
    toNodeId: `node_${String(index + 1).padStart(16, '0')}`,
    eventTime: '2026-04-01T00:00:00Z',
    capturedAt: '2026-04-02T00:00:00Z',
    evidenceRefs: [`ev_${String(index).padStart(16, '0')}`],
    joinMethod: 'native_id',
    joinConfidence: 'exact',
    workflowDefinitionHash: definitionHash,
  });
  return freeze({
    nodes: [
      {
        nodeId: 'journey_1111111111111111',
        type: 'journey_instance',
        journeyId: 'journey_client_sales',
        journeyInstanceId: 'journey_client_sales',
        denominator: 'new_leads',
        evidenceRefs: [],
      },
      {
        nodeId: 'node_success_11111111',
        type: 'journey_event',
        journeyId: 'journey_client_sales',
        journeyInstanceId: 'journey_client_sales',
        classification: 'OBSERVED',
        stage: 'converted',
        eventTime: '2026-04-01T00:00:00Z',
        capturedAt: '2026-04-02T00:00:00Z',
        provenance: { completeness: 'COMPLETE' },
        evidenceRefs: ['ev_9999999999999999'],
      },
      {
        nodeId: 'node_0000000000000004',
        type: 'workflow_execution',
        journeyId: 'journey_client_sales',
        journeyInstanceId: 'journey_client_sales',
        cohortInstanceRef: 'cohort_direct_failure',
        classification: 'OBSERVED',
        stage: 'execution_failure',
        eventTime: '2026-04-01T00:00:00Z',
        capturedAt: '2026-04-02T00:00:00Z',
        provenance: { completeness: 'COMPLETE' },
        evidenceRefs: ['ev_0000000000000003'],
      },
      ...Array.from({ length: 109 }, (_, index) => ({
        nodeId: `node_evidence_${String(index).padStart(8, '0')}`,
        type: 'evidence_fact',
        journeyId: 'journey_client_sales',
        journeyInstanceId: 'journey_client_sales',
        classification: 'OBSERVED',
        eventTime: '2026-04-01T00:00:00Z',
        capturedAt: '2026-04-02T00:00:00Z',
        provenance: { completeness: 'COMPLETE' },
        evidenceRefs: [`ev_${String(index).padStart(16, '0')}`],
      })),
    ],
    edges: [
      edge(1, 'configured_to_trigger'),
      edge(2, 'enrolled_in'),
      edge(3, 'execution_emitted'),
    ],
    conflicts: [],
    unresolvedJoins: [],
  });
}

function mechanismScope() {
  return {
    metricId: 'engagement_to_booking',
    journeyId: 'journey_client_sales',
    journeyInstanceId: 'journey_client_sales',
    symptomCode: 'OBSERVED_EDGE_LOSS',
    localizedEdgeIds: [
      'edge_0000000000000001',
      'edge_0000000000000002',
      'edge_0000000000000003',
    ],
    comparatorIds: ['node_success_11111111'],
    mechanismClass: 'workflow_configuration_or_execution',
    affectedObjectRefs: ['obj_1111111111111111'],
    predictionCode: 'EXECUTION_FAILURE_REPEATS',
    supportingEvidenceRefs: [
      'ev_0000000000000001',
      'ev_0000000000000002',
      'ev_0000000000000003',
    ],
    counterEvidenceRefs: [],
    competingExplanations: [{ code: 'SOURCE_MIX', material: true, addressed: true }],
    falsificationResults: FAMILIES.map((family, index) => ({
      family,
      state: 'RULED_OUT',
      evidenceRefs: [`ev_${String(100 + index).padStart(16, '0')}`],
      reasonCode: 'EXACT_NEGATIVE_CHECK',
    })),
    discriminatingTest: {
      testId: 'test_1111111111111111',
      strongestAlternativeCode: 'SOURCE_MIX',
      expectedObservationCodes: ['EXACT_RUNTIME_EVENT_PRESENT'],
      decisionRuleCodes: ['PRESENT_SUPPORTS_ABSENT_CHALLENGES'],
    },
    repeatSegmentIds: [],
    critical: false,
    criticalClass: null,
    severityBand: 'HIGH',
    commercialValue: { kind: 'BOUNDED', lower: 100, upper: 500 },
    recoverabilityBand: 'HIGH',
    recurrenceBand: 'WEEKLY',
    timeToValueBand: 'SHORT',
    reversibilityBand: 'HIGH',
    effortBand: 'LOW',
    dependencyBurden: 'LOW',
    operationalRiskBand: 'LOW',
    supplementalReadAllowlist: [{
      descriptorId: 'supp_1111111111111111',
      capabilityId: 'workflow_logs',
      objectRef: 'obj_1111111111111111',
    }],
    sealedPath: {
      pathRef: 'path_1111111111111111',
      relativePath: 'sealed/engagement_to_booking.json',
    },
  };
}

function mechanismMetric(overrides) {
  return {
    state: 'OBSERVED',
    numerator: 2,
    denominator: 8,
    rate: 0.25,
    eligible: 8,
    excluded: 0,
    exclusions: {},
    threshold: 5,
    rankEligible: true,
    window: { start: '2026-03-30T00:00:00Z', end: '2026-04-06T00:00:00Z' },
    coverage: 'COMPLETE',
    coverageRatio: 1,
    coverageFloor: 0.8,
    reasonCode: null,
    ...overrides,
  };
}

function nominateWith(metric) {
  const scope = mechanismScope();
  const metricMap = { [scope.metricId]: metric };
  return nominateMechanisms(freeze({
    graph: mechanismGraph(),
    metrics: {
      metrics: {
        currentClosedWeek: metricMap,
        previousClosedWeek: metricMap,
        trailing28Days: metricMap,
      },
      cohorts: { currentClosedWeek: {}, previousClosedWeek: {}, trailing28Days: {} },
      currentStock: {},
    },
    coverage: {
      state: 'complete_full',
      comparableSubsets: [],
      capabilityStates: [{ capabilityId: 'workflow_logs', state: 'COMPLETE' }],
      limits: [],
      edgeScopes: [scope],
    },
    maxCandidates: 5,
  }));
}

test('a finding built on part of the account is distinguishable from one built on all of it', () => {
  // TWO of ten subjects excluded: coverage 0.8, exactly at the documented floor, so the metric is
  // still OBSERVED and every other input to the candidate is identical to the control.
  const [partial] = nominateWith(mechanismMetric({
    eligible: 10,
    excluded: 2,
    exclusions: { IDENTITY_CONFLICT: 2 },
    coverage: 'INCOMPLETE',
    coverageRatio: 0.8,
  }));
  const [complete] = nominateWith(mechanismMetric());
  assert.ok(partial, 'partial candidate');
  assert.ok(complete, 'complete candidate');
  assert.notDeepEqual(partial.limitationCodes, complete.limitationCodes);
  assert.ok(partial.limitationCodes.includes('PARTIAL_SUBJECT_COVERAGE'));
  assert.ok(!complete.limitationCodes.includes('PARTIAL_SUBJECT_COVERAGE'));

  const packet = buildMechanismPacket(partial);
  assert.ok(packet.limitationCodes.includes('PARTIAL_SUBJECT_COVERAGE'));

  // A metric the coverage floor refused entirely says so too.
  const [belowFloor] = nominateWith(mechanismMetric({
    state: 'UNKNOWN',
    numerator: null,
    denominator: null,
    rate: null,
    eligible: 10,
    excluded: 6,
    exclusions: { IDENTITY_CONFLICT: 6 },
    coverage: 'INCOMPLETE',
    coverageRatio: 0.4,
    rankEligible: false,
    reasonCode: 'COVERAGE_BELOW_FLOOR',
  }));
  assert.ok(belowFloor.limitationCodes.includes('PARTIAL_SUBJECT_COVERAGE'));

  // A declared floor of zero is loud downstream as well as on the metric.
  const [floorOff] = nominateWith(mechanismMetric({
    eligible: 10,
    excluded: 2,
    exclusions: { IDENTITY_CONFLICT: 2 },
    coverage: 'INCOMPLETE',
    coverageRatio: 0.8,
    coverageFloor: 0,
    coverageFloorDisabled: true,
  }));
  assert.ok(floorOff.limitationCodes.includes('COVERAGE_FLOOR_DISABLED'));
  assert.ok(!complete.limitationCodes.includes('COVERAGE_FLOOR_DISABLED'));
});
