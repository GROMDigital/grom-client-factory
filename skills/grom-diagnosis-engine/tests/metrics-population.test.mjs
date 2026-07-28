/**
 * Task A2a round 3 — ONE population decides what every metric surface may count.
 *
 * Round 2 closed "a row participates in a metric without passing the trust predicate" for the
 * RATE only. Two other members of the same kind survived:
 *
 *   B1. `cohortCounts` and `stockFor` filtered on type and `isObserved` and never consulted the
 *       taint map, so the "Entry cohort" / "Denominator" the report prints beside a rate was built
 *       from rows the rate itself had judged unfit.
 *   B2. The taint closure's deny list named only `execution_emitted`, while `enrolled_in` and
 *       `configured_to_trigger` share its property exactly — they originate at a workflow
 *       DEFINITION node that every contact it ever touched shares — so one conflict naming one
 *       definition blacked out the whole account through a sibling edge type.
 *
 * Plus the immaturity early return, which discarded the counts it had already established.
 *
 * Every expectation below is HAND-STATED from a fixture small enough to count by eye, and the
 * count is written beside the assertion that depends on it.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { EDGE_IDENTITY_POLICY, buildWindows, computeJourneyMetrics } from '../lib/metrics.mjs';

const here = dirname(fileURLToPath(import.meta.url));

const CUTOFF = '2026-03-09T10:15:00-07:00';
const ZONE = 'America/Los_Angeles';
/** Inside `currentClosedWeek` (2026-03-02 -> 2026-03-09 local) and mature at a one-day lag. */
const LEAD_AT = '2026-03-03T09:00:00-08:00';
const ENGAGED_AT = '2026-03-03T15:00:00-08:00';
/** Inside `currentClosedWeek` but NOT mature at a two-day lag against the cutoff above. */
const LATE_LEAD_AT = '2026-03-08T12:00:00-07:00';

function freeze(value) {
  for (const child of Object.values(value)) {
    if (child && typeof child === 'object') freeze(child);
  }
  return Object.freeze(value);
}

function windows(overrides = {}) {
  return buildWindows({
    cutoff: overrides.cutoff ?? CUTOFF,
    timezone: overrides.timezone ?? ZONE,
    maturityDays: overrides.maturityDays ?? 0,
  });
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

function lead(index, extra = {}) {
  return node(`lead${index}`, index, 'lead_created', LEAD_AT, extra);
}

function engaged(index, extra = {}) {
  return node(`engaged${index}`, index, 'first_engagement', ENGAGED_AT, extra);
}

/**
 * `unjoined` drops the proving identity edge for one subject, which is the only way to reach
 * `UNPROVEN_JOIN` — every other subject keeps an exact native-id join.
 */
function graph(nodes, extra = {}) {
  const unjoined = extra.unjoined ?? new Set();
  return freeze({
    nodes,
    edges: [
      ...nodes
        .filter(({ subjectRef: ref }) => !unjoined.has(ref))
        .map((item) => ({
          type: 'identity_exact',
          fromNodeId: `entity_${item.subjectRef}`,
          toNodeId: item.nodeId,
          joinMethod: 'native_id',
          joinConfidence: 'exact',
        })),
      ...(extra.edges ?? []),
    ],
    conflicts: extra.conflicts ?? [],
    unresolvedJoins: extra.unresolvedJoins ?? [],
  });
}

function contract(extra = {}) {
  return {
    edgeId: 'engagement',
    journeyId: 'client_sales',
    journeyInstanceId: 'journey_client_sales',
    fromStage: 'lead_created',
    toStage: 'first_engagement',
    allowedLag: extra.allowedLag ?? { amount: 1, unit: 'days' },
    reentryRule: 'same_journey_instance',
    required: true,
    nativeMapping: 'MAPPED',
    eligibilityRule: extra.eligibilityRule ?? { minimumSample: 1, minimumCoverage: 0.5 },
  };
}

function run(builtGraph, edgeContract = contract(), built = windows()) {
  return computeJourneyMetrics({
    graph: builtGraph,
    metricContracts: { version: '1.0.0', edges: [edgeContract] },
    windows: built,
  });
}

/* ------------------------------------------------------------------------- */
/* BLOCKER 1 — cohorts and stock must obey the same trust predicate as the rate */
/* ------------------------------------------------------------------------- */

/** THREE subjects enter the closed week; subjects 0 and 1 engage, subject 2 does not. */
function threeSubjects() {
  return [lead(0), engaged(0), lead(1), engaged(1), lead(2)];
}

/**
 * Every distinct way `untrustedReason` can refuse subject 2. The rate already honours all five;
 * the cohort and the stock did not.
 */
const UNTRUSTWORTHY = [
  {
    reason: 'IDENTITY_CONFLICT',
    build: () => graph(threeSubjects(), {
      conflicts: [{ conflictId: 'conflict_two', nodeIds: [entityId(2)] }],
    }),
  },
  {
    reason: 'UNRESOLVED_JOIN',
    build: () => graph(threeSubjects(), {
      unresolvedJoins: [{ unresolvedId: 'unresolved_two', recordNodeId: 'node_lead2' }],
    }),
  },
  {
    reason: 'INFERRED_MATCH',
    build: () => graph(threeSubjects(), {
      edges: [{
        type: 'inferred_match',
        fromNodeId: entityId(2),
        toNodeId: 'node_lead2',
        joinMethod: 'fuzzy_candidate',
        joinConfidence: 'candidate',
      }],
    }),
  },
  {
    reason: 'UNPROVEN_JOIN',
    build: () => graph(threeSubjects(), { unjoined: new Set([subjectRef(2)]) }),
  },
  {
    reason: 'NON_OBSERVED_EVIDENCE',
    build: () => graph([
      lead(0), engaged(0), lead(1), engaged(1),
      lead(2, { provenance: { completeness: 'INCOMPLETE' } }),
    ]),
  },
];

test('the entry cohort and the current stock count only rows the metric itself would count', () => {
  // Control: nothing is untrustworthy. THREE entrants, TWO of whom engaged. The stock at the end
  // of the closed week is subject 2 sitting at lead_created and subjects 0 and 1 at engagement.
  const clean = run(graph(threeSubjects()));
  const cleanMetric = clean.metrics.currentClosedWeek.engagement;
  assert.equal(cleanMetric.eligible, 3);
  assert.equal(cleanMetric.denominator, 3);
  assert.equal(cleanMetric.numerator, 2);
  assert.equal(clean.cohorts.currentClosedWeek.journey_client_sales, 3);
  assert.deepEqual(clean.currentStock, {
    journey_client_sales: { first_engagement: 2, lead_created: 1 },
  });

  for (const { reason, build } of UNTRUSTWORTHY) {
    const result = run(build());
    const metric = result.metrics.currentClosedWeek.engagement;
    // The rate already drops subject 2 and says so.
    assert.equal(metric.eligible, 3, reason);
    assert.equal(metric.denominator, 2, reason);
    assert.equal(metric.numerator, 2, reason);
    assert.deepEqual(metric.exclusions, { [reason]: 1 }, reason);

    // The printed cohort must not contradict that: it counted the row the rate refused.
    assert.equal(result.cohorts.currentClosedWeek.journey_client_sales, 2, reason);
    // And neither may the stock place an untrustworthy subject at a stage.
    assert.deepEqual(result.currentStock, {
      journey_client_sales: { first_engagement: 2 },
    }, reason);
  }
});

/**
 * THE GUARD. This class escaped twice because "which rows may a metric count" was re-decided,
 * differently, at every call site. It is now decided once, in `metricPopulation`, and the three
 * consumers are handed that population instead of the raw node list. A future consumer that
 * reaches for `graph.nodes` again fails here.
 */
test('exactly one place decides which nodes a metric may count', () => {
  const source = readFileSync(join(here, '../lib/metrics.mjs'), 'utf8');
  // Prose references are written in backticks; only real reads count.
  const CODE_READ = /(?<!`)graph\.nodes(?!`)/gu;
  const reads = source.match(CODE_READ) ?? [];
  assert.equal(
    reads.length,
    2,
    'graph.nodes may be read only to validate the input and to build the metric population',
  );
  assert.match(source, /Array\.isArray\(graph\.nodes\)/u);

  const start = source.indexOf('function metricPopulation(');
  assert.ok(start > 0, 'metricPopulation is the single place');
  const body = source.slice(start, source.indexOf('\n}\n', start));
  assert.equal(
    (body.match(CODE_READ) ?? []).length,
    1,
    'the second read belongs to metricPopulation',
  );

  // Every consumer takes the population, so none of them can be handed an unfiltered node list.
  for (const consumer of ['computeEdge', 'stockFor', 'cohortCounts']) {
    assert.match(source, new RegExp(`function ${consumer}\\(\\s*population`, 'u'), consumer);
  }

  // A new metric SURFACE has to be added here too, which is the moment to route it through the
  // population as well.
  const result = run(graph(threeSubjects()));
  assert.deepEqual(Object.keys(result).sort(), ['cohorts', 'currentStock', 'metrics']);
});

/* ------------------------------------------------------------------------- */
/* BLOCKER 2 — the deny list covers the PROPERTY, not one name                */
/* ------------------------------------------------------------------------- */

/** TEN subjects enter; SEVEN of them engage. */
function tenSubjects() {
  const nodes = [];
  for (let index = 0; index < 10; index += 1) {
    nodes.push(lead(index));
    if (index <= 6) nodes.push(engaged(index));
  }
  return nodes;
}

function sharedDefinitionEdges(type, subjects) {
  return subjects.map((index) => ({
    type,
    fromNodeId: 'node_workflow_definition',
    toNodeId: entityId(index),
    joinMethod: 'workflow_definition_hash',
    joinConfidence: 'exact',
  }));
}

test('an edge type that originates at a shared definition node cannot taint the account', () => {
  const all = Array.from({ length: 10 }, (_, index) => index);
  // ONE conflict, naming ONE workflow-definition node that every subject's edge originates at.
  for (const type of ['enrolled_in', 'configured_to_trigger', 'execution_emitted']) {
    const account = run(graph(tenSubjects(), {
      edges: sharedDefinitionEdges(type, all),
      conflicts: [{ conflictId: 'conflict_definition', nodeIds: ['node_workflow_definition'] }],
    }));
    const metric = account.metrics.currentClosedWeek.engagement;
    // TEN eligible, all measurable, SEVEN converted. A workflow definition is shared by every
    // contact it ever touched, so it says nothing about any one subject's identity.
    assert.equal(metric.state, 'OBSERVED', type);
    assert.equal(metric.eligible, 10, type);
    assert.equal(metric.denominator, 10, type);
    assert.equal(metric.numerator, 7, type);
    assert.deepEqual(metric.exclusions, {}, type);
    assert.equal(account.cohorts.currentClosedWeek.journey_client_sales, 10, type);

    // The same shape over TWO subjects is likewise clean, where round 2 excluded exactly those two.
    const partial = run(graph(tenSubjects(), {
      edges: sharedDefinitionEdges(type, [0, 1]),
      conflicts: [{ conflictId: 'conflict_definition', nodeIds: ['node_workflow_definition'] }],
    })).metrics.currentClosedWeek.engagement;
    assert.equal(partial.denominator, 10, type);
    assert.deepEqual(partial.exclusions, {}, type);
  }
});

test('an identity-bearing edge type still taints, including one this file has never seen', () => {
  // The deny list stays a DENY list: an unknown future type defaults to being traversed, because
  // failing toward more taint costs coverage while failing toward less costs correctness.
  const future = run(graph(tenSubjects(), {
    edges: [{
      type: 'identity_probabilistic_v2',
      fromNodeId: entityId(3),
      toNodeId: 'node_bridge',
      joinMethod: 'future',
      joinConfidence: 'probable',
    }],
    conflicts: [{ conflictId: 'conflict_bridge', nodeIds: ['node_bridge'] }],
  })).metrics.currentClosedWeek.engagement;
  assert.equal(future.eligible, 10);
  assert.equal(future.denominator, 9);
  assert.deepEqual(future.exclusions, { IDENTITY_CONFLICT: 1 });

  // `identity_exact` and `preceded` both run between rows the same subject owns.
  const preceded = run(graph(tenSubjects(), {
    edges: [{
      type: 'preceded',
      fromNodeId: 'node_lead3',
      toNodeId: 'node_bridge',
      joinMethod: 'native_id',
      joinConfidence: 'exact',
    }],
    conflicts: [{ conflictId: 'conflict_bridge', nodeIds: ['node_bridge'] }],
  })).metrics.currentClosedWeek.engagement;
  assert.equal(preceded.denominator, 9);
  assert.deepEqual(preceded.exclusions, { IDENTITY_CONFLICT: 1 });
});

test('every edge type the graph builder declares is classified by the metric edge policy', () => {
  const source = readFileSync(join(here, '../lib/evidence-graph.mjs'), 'utf8');
  const start = source.indexOf('const EDGE_TYPES');
  assert.ok(start > 0);
  const block = source.slice(start, source.indexOf(']', start));
  const declared = [...block.matchAll(/'([a-z_]+)'/gu)].map(([, value]) => value).sort();
  // Hand-stated: `evidence-graph.mjs` declares NINE edge types today.
  assert.equal(declared.length, 9);
  assert.deepEqual(
    Object.keys(EDGE_IDENTITY_POLICY).sort(),
    declared,
    'a new edge type must be classified IDENTITY or SHARED_ORIGIN in metrics.mjs before it ships',
  );
  for (const [type, policy] of Object.entries(EDGE_IDENTITY_POLICY)) {
    assert.ok(['IDENTITY', 'SHARED_ORIGIN'].includes(policy), type);
  }
  // The three definition-scoped types are the ones the closure must not walk.
  assert.deepEqual(
    Object.entries(EDGE_IDENTITY_POLICY)
      .filter(([, policy]) => policy === 'SHARED_ORIGIN')
      .map(([type]) => type)
      .sort(),
    ['attributed_by_source', 'configured_to_trigger', 'enrolled_in', 'execution_emitted', 'intended_by'],
  );
});

/* ------------------------------------------------------------------------- */
/* The immaturity early return must carry its counts                          */
/* ------------------------------------------------------------------------- */

test('a window whose entrants were all excluded says so even when none of them matured', () => {
  // THREE entrants, one day before the cutoff, so at a two-day lag none of them can have matured.
  // All three are named by one identity conflict.
  const nodes = [
    node('lead0', 0, 'lead_created', LATE_LEAD_AT),
    node('lead1', 1, 'lead_created', LATE_LEAD_AT),
    node('lead2', 2, 'lead_created', LATE_LEAD_AT),
  ];
  const conflicted = run(
    graph(nodes, {
      conflicts: [{
        conflictId: 'conflict_all',
        nodeIds: [entityId(0), entityId(1), entityId(2)],
      }],
    }),
    contract({ allowedLag: { amount: 2, unit: 'days' } }),
  ).metrics.currentClosedWeek.engagement;
  assert.equal(conflicted.state, 'UNKNOWN');
  assert.equal(conflicted.rate, null);
  // No unearned number can hide in an UNKNOWN, but the counts must survive: they are the only
  // channel that reaches `PARTIAL_SUBJECT_COVERAGE` and the report's coverage disclosure.
  assert.equal(conflicted.eligible, 3);
  assert.equal(conflicted.excluded, 3);
  assert.deepEqual(conflicted.exclusions, { IDENTITY_CONFLICT: 3 });
  assert.equal(conflicted.coverageRatio, 0);
  assert.equal(conflicted.reasonCode, 'ALL_SUBJECTS_EXCLUDED');

  /*
   * TASK A2 ROUND 2 — TWO EDITED EXPECTATIONS, quoted verbatim:
   *
   *   assert.equal(trusted.reasonCode, 'MISSING_REQUIRED_EVIDENCE');
   *   assert.equal(partial.reasonCode, 'MISSING_REQUIRED_EVIDENCE');
   *
   * The comment above the first one already claimed the window "keeps the right-censoring
   * diagnosis" — but `MISSING_REQUIRED_EVIDENCE` is the same code an edge nothing has ever mapped
   * reports, so the diagnosis was not actually being kept, it was being erased. `IMMATURE_COHORT`
   * was the intended code and could never fire, because it required EVERY entrant to be newer than
   * `matureAsOf`, which a cohort blocked by its LAG does not satisfy. The cause is now decided from
   * the population split: exclusion when trust refused everybody, and otherwise time.
   */
  const trusted = run(
    graph(nodes),
    contract({ allowedLag: { amount: 2, unit: 'days' } }),
  ).metrics.currentClosedWeek.engagement;
  assert.equal(trusted.state, 'UNKNOWN');
  assert.equal(trusted.reasonCode, 'IMMATURE_COHORT');
  assert.equal(trusted.eligible, 3);
  assert.equal(trusted.excluded, 0);
  assert.equal(trusted.immature, 3);
  assert.deepEqual(trusted.exclusions, {});

  // One of three excluded: still not measurable, still not a full-coverage window. The remaining
  // two are immature rather than untrustworthy, so time is still the operative cause.
  const partial = run(
    graph(nodes, { conflicts: [{ conflictId: 'conflict_one', nodeIds: [entityId(2)] }] }),
    contract({ allowedLag: { amount: 2, unit: 'days' } }),
  ).metrics.currentClosedWeek.engagement;
  assert.equal(partial.state, 'UNKNOWN');
  assert.equal(partial.reasonCode, 'IMMATURE_COHORT');
  assert.equal(partial.eligible, 3);
  assert.equal(partial.excluded, 1);
  assert.equal(partial.immature, 2);
  assert.deepEqual(partial.exclusions, { IDENTITY_CONFLICT: 1 });
});

test('an immature cohort keeps its IMMATURE_COHORT diagnosis and gains its counts', () => {
  const nodes = [lead(0), lead(1)];
  const immature = run(
    graph(nodes),
    contract(),
    windows({ maturityDays: 14 }),
  ).metrics.currentClosedWeek.engagement;
  assert.equal(immature.state, 'UNKNOWN');
  assert.equal(immature.reasonCode, 'IMMATURE_COHORT');
  assert.equal(immature.numerator, null);
  assert.equal(immature.denominator, null);
  // TWO entrants, neither excluded: the window is young, not untrustworthy.
  assert.equal(immature.eligible, 2);
  assert.equal(immature.excluded, 0);
});
