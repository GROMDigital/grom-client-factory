/**
 * Task A2a — subject-scoped uncertainty and the trailing 90-day window.
 *
 * Every expectation in this file is HAND-STATED from the fixture, never read back from the code
 * under test. Each fixture is small enough to count by eye, and the count is written in a comment
 * next to the assertion that depends on it.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { buildEvidenceGraph } from '../lib/evidence-graph.mjs';
import { buildWindows, computeJourneyMetrics } from '../lib/metrics.mjs';
import { normalizeEvidence } from '../lib/normalize.mjs';
import { MetricContractsSchema, loadMetricContracts } from '../schemas/v1.mjs';

const here = dirname(fileURLToPath(import.meta.url));

const CUTOFF = '2026-03-09T10:15:00-07:00';
const ZONE = 'America/Los_Angeles';

/** Inside `currentClosedWeek` (2026-03-02 -> 2026-03-09 local) and mature at a 1-day lag. */
const LEAD_AT = '2026-03-03T09:00:00-08:00';
const ENGAGED_AT = '2026-03-03T15:00:00-08:00';

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

/** 16 characters after the prefix, matching the pseudonymous subject shape used elsewhere. */
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

function identityEdges(nodes) {
  return nodes
    .filter(({ nodeId }) => !nodeId.startsWith('node_untrusted'))
    .map((item) => ({
      type: 'identity_exact',
      fromNodeId: `entity_${item.subjectRef}`,
      toNodeId: item.nodeId,
      joinMethod: 'native_id',
      joinConfidence: 'exact',
    }));
}

function graph(nodes, extra = {}) {
  return freeze({
    nodes,
    edges: [...identityEdges(nodes), ...(extra.edges ?? [])],
    conflicts: extra.conflicts ?? [],
    unresolvedJoins: extra.unresolvedJoins ?? [],
  });
}

function contract(extra = {}) {
  return {
    edgeId: 'engagement',
    journeyId: 'client_sales',
    journeyInstanceId: 'journey_client_sales',
    fromStage: extra.fromStage ?? 'lead_created',
    toStage: extra.toStage ?? 'first_engagement',
    allowedLag: extra.allowedLag ?? { amount: 1, unit: 'days' },
    reentryRule: 'same_journey_instance',
    required: true,
    nativeMapping: extra.nativeMapping ?? 'MAPPED',
    eligibilityRule: extra.eligibilityRule ?? { minimumSample: 1, minimumCoverage: 0.5 },
  };
}

function measure(builtGraph, edgeContract, windowName = 'currentClosedWeek', built = windows()) {
  return computeJourneyMetrics({
    graph: builtGraph,
    metricContracts: { version: '1.0.0', edges: [edgeContract] },
    windows: built,
  }).metrics[windowName][edgeContract.edgeId];
}

/**
 * Ten subjects enter `lead_created` inside the closed week. Subjects 0-6 (SEVEN of them) also
 * reach `first_engagement` within the one-day lag; subjects 7, 8 and 9 do not.
 */
function tenSubjects() {
  const nodes = [];
  for (let index = 0; index < 10; index += 1) {
    nodes.push(lead(index));
    if (index <= 6) nodes.push(engaged(index));
  }
  return nodes;
}

test('one tainted subject of ten is excluded, and the metric is measured over the other nine', () => {
  // Subject 0 is a converter, so excluding it drops the numerator from 7 to 6 and the
  // denominator from 10 to 9. Hand-stated: 10 leads, 7 engagements, 1 tainted converter.
  const metric = measure(
    graph(tenSubjects(), {
      conflicts: [{
        conflictId: 'conflict_duplicate_identity',
        type: 'duplicate_identity_claim',
        nodeIds: [entityId(0)],
      }],
    }),
    contract(),
  );
  assert.equal(metric.state, 'OBSERVED');
  assert.equal(metric.eligible, 10);
  assert.equal(metric.denominator, 9);
  assert.equal(metric.numerator, 6);
  assert.equal(metric.rate, 6 / 9);
  assert.equal(metric.excluded, 1);
  assert.deepEqual(metric.exclusions, { IDENTITY_CONFLICT: 1 });
  assert.equal(metric.coverageRatio, 0.9);
  assert.equal(metric.coverage, 'INCOMPLETE');
  assert.equal(metric.reasonCode, null);
});

test('each taint cause independently excludes only its own subject', () => {
  const cases = [
    {
      cause: 'NON_OBSERVED_EVIDENCE',
      // Subject 3 acquires a second, untrustworthy engagement record.
      build: () => graph([
        ...tenSubjects(),
        node('untrusted3', 3, 'first_engagement', ENGAGED_AT, {
          provenance: { completeness: 'INCOMPLETE' },
        }),
      ]),
    },
    {
      cause: 'UNRESOLVED_JOIN',
      build: () => graph(tenSubjects(), {
        unresolvedJoins: [{ unresolvedId: 'unresolved_1', recordNodeId: 'node_lead3' }],
      }),
    },
    {
      cause: 'IDENTITY_CONFLICT',
      build: () => graph(tenSubjects(), {
        conflicts: [{ conflictId: 'conflict_1', nodeIds: [entityId(3)] }],
      }),
    },
    {
      cause: 'INFERRED_MATCH',
      build: () => graph(tenSubjects(), {
        edges: [{
          type: 'inferred_match',
          fromNodeId: entityId(3),
          toNodeId: 'node_lead3',
          joinMethod: 'fuzzy',
          joinConfidence: 'probable',
        }],
      }),
    },
    {
      cause: 'UNPROVEN_JOIN',
      // Subject 3's events are joined to nothing, so nothing proves they are subject 3's.
      build: () => {
        const nodes = tenSubjects();
        return freeze({
          nodes,
          edges: identityEdges(nodes).filter(({ toNodeId }) => !toNodeId.endsWith('3')),
          conflicts: [],
          unresolvedJoins: [],
        });
      },
    },
  ];
  for (const { cause, build } of cases) {
    const metric = measure(build(), contract());
    // Subject 3 is a converter, so its exclusion costs one numerator and one denominator.
    assert.equal(metric.state, 'OBSERVED', cause);
    assert.equal(metric.eligible, 10, cause);
    assert.equal(metric.denominator, 9, cause);
    assert.equal(metric.numerator, 6, cause);
    assert.equal(metric.excluded, 1, cause);
    assert.deepEqual(metric.exclusions, { [cause]: 1 }, cause);
    assert.equal(metric.coverageRatio, 0.9, cause);
  }
});

test('a subject with no usable event time is counted as excluded, never dropped in silence', () => {
  // THREE measurable subjects, plus a FOURTH whose only entry event carries no event time and so
  // cannot be ruled into or out of any window.
  const nodes = [
    lead(0), engaged(0), lead(1), engaged(1), lead(2),
    { ...lead(3), eventTime: null },
  ];
  const metric = measure(graph(nodes), contract());
  assert.equal(metric.state, 'OBSERVED');
  assert.equal(metric.eligible, 4);
  assert.equal(metric.denominator, 3);
  assert.equal(metric.numerator, 2);
  assert.equal(metric.excluded, 1);
  assert.deepEqual(metric.exclusions, { UNPLACEABLE_EVENT_TIME: 1 });
  assert.equal(metric.coverageRatio, 0.75);
  assert.equal(metric.coverage, 'INCOMPLETE');
});

test('a metric whose subjects are all tainted is UNKNOWN, never a confident zero', () => {
  // THREE subjects, all three named by one duplicate-identity conflict.
  const nodes = [lead(0), lead(1), lead(2)];
  const metric = measure(
    graph(nodes, {
      conflicts: [{
        conflictId: 'conflict_all',
        nodeIds: [entityId(0), entityId(1), entityId(2)],
      }],
    }),
    contract({ eligibilityRule: { minimumSample: 1, minimumCoverage: 0 } }),
  );
  assert.equal(metric.state, 'UNKNOWN');
  assert.equal(metric.numerator, null);
  assert.equal(metric.denominator, null);
  assert.equal(metric.rate, null);
  assert.equal(metric.reasonCode, 'ALL_SUBJECTS_EXCLUDED');
  assert.equal(metric.eligible, 3);
  assert.equal(metric.excluded, 3);
  assert.deepEqual(metric.exclusions, { IDENTITY_CONFLICT: 3 });
  assert.equal(metric.coverageRatio, 0);
  assert.equal(metric.coverage, 'INCOMPLETE');
  assert.equal(metric.rankEligible, false);
});

test('the coverage floor is read from the metric contract, not from a constant', () => {
  // FOUR of ten subjects tainted -> six of ten measurable -> coverage 0.6.
  const tainted = graph(tenSubjects(), {
    conflicts: [{
      conflictId: 'conflict_four',
      nodeIds: [entityId(0), entityId(1), entityId(7), entityId(8)],
    }],
  });
  const permissive = measure(tainted, contract({
    eligibilityRule: { minimumSample: 1, minimumCoverage: 0.5 },
  }));
  assert.equal(permissive.state, 'OBSERVED');
  assert.equal(permissive.denominator, 6);
  assert.equal(permissive.eligible, 10);
  assert.equal(permissive.numerator, 5); // subjects 2-6 converted; 0 and 1 were excluded.
  assert.equal(permissive.coverageRatio, 0.6);
  assert.equal(permissive.coverageFloor, 0.5);

  const strict = measure(tainted, contract({
    eligibilityRule: { minimumSample: 1, minimumCoverage: 0.75 },
  }));
  assert.equal(strict.state, 'UNKNOWN');
  assert.equal(strict.reasonCode, 'COVERAGE_BELOW_FLOOR');
  assert.equal(strict.numerator, null);
  assert.equal(strict.denominator, null);
  assert.equal(strict.rate, null);
  assert.equal(strict.eligible, 10);
  assert.equal(strict.excluded, 4);
  assert.equal(strict.coverageRatio, 0.6);
  assert.equal(strict.coverageFloor, 0.75);
});

test('an absent floor declaration adopts the documented default instead of disabling the guard', () => {
  const tainted = graph(tenSubjects(), {
    conflicts: [{
      conflictId: 'conflict_four',
      nodeIds: [entityId(0), entityId(1), entityId(7), entityId(8)],
    }],
  });
  const undeclared = measure(tainted, contract({ eligibilityRule: { minimumSample: 1 } }));
  // Coverage 0.6 is below the documented 0.8 default, so the guard still fires.
  assert.equal(undeclared.state, 'UNKNOWN');
  assert.equal(undeclared.reasonCode, 'COVERAGE_BELOW_FLOOR');
  assert.equal(undeclared.coverageFloor, 0.8);

  const emptyRule = measure(tainted, contract({ eligibilityRule: {} }));
  assert.equal(emptyRule.coverageFloor, 0.8);
  assert.equal(emptyRule.state, 'UNKNOWN');

  const profileDefault = computeJourneyMetrics({
    graph: tainted,
    metricContracts: {
      version: '1.0.0',
      coverageFloor: 0.5,
      edges: [contract({ eligibilityRule: { minimumSample: 1 } })],
    },
    windows: windows(),
  }).metrics.currentClosedWeek.engagement;
  assert.equal(profileDefault.coverageFloor, 0.5);
  assert.equal(profileDefault.state, 'OBSERVED');

  for (const invalid of [1.5, -0.1, 'high', null]) {
    assert.throws(
      () => measure(tainted, contract({
        eligibilityRule: { minimumSample: 1, minimumCoverage: invalid },
      })),
      /METRICS_CONTRACT_INVALID/,
      String(invalid),
    );
  }
});

test('exclusion counts live on the metric itself and survive serialization', () => {
  const result = computeJourneyMetrics({
    graph: graph(tenSubjects(), {
      conflicts: [{ conflictId: 'conflict_one', nodeIds: [entityId(0)] }],
    }),
    metricContracts: { version: '1.0.0', edges: [contract()] },
    windows: windows(),
  });
  // The envelope gains nothing: a later stage that keeps only known envelope keys cannot
  // silently drop the exclusion counts, because they are not on the envelope.
  assert.deepEqual(Object.keys(result).sort(), ['cohorts', 'currentStock', 'metrics']);
  const roundTripped = JSON.parse(JSON.stringify(result)).metrics.currentClosedWeek.engagement;
  assert.equal(roundTripped.eligible, 10);
  assert.equal(roundTripped.denominator, 9);
  assert.equal(roundTripped.excluded, 1);
  assert.deepEqual(roundTripped.exclusions, { IDENTITY_CONFLICT: 1 });
  assert.equal(roundTripped.coverageRatio, 0.9);
});

test('a measured genuine zero is distinguishable from a population that could not be measured', () => {
  // THREE untainted subjects, none of whom engaged.
  const measured = measure(graph([lead(0), lead(1), lead(2)]), contract());
  assert.equal(measured.state, 'OBSERVED');
  assert.equal(measured.numerator, 0);
  assert.equal(measured.denominator, 3);
  assert.equal(measured.rate, 0);
  assert.equal(measured.eligible, 3);
  assert.equal(measured.excluded, 0);
  assert.deepEqual(measured.exclusions, {});
  assert.equal(measured.coverage, 'COMPLETE');
  assert.equal(measured.coverageRatio, 1);
  assert.equal(measured.reasonCode, null);

  const unmeasurable = measure(
    graph([lead(0), lead(1), lead(2)], {
      conflicts: [{
        conflictId: 'conflict_all',
        nodeIds: [entityId(0), entityId(1), entityId(2)],
      }],
    }),
    contract({ eligibilityRule: { minimumSample: 1, minimumCoverage: 0 } }),
  );
  assert.notEqual(unmeasurable.state, measured.state);
  assert.equal(unmeasurable.rate, null);
  assert.notEqual(unmeasurable.reasonCode, measured.reasonCode);
});

test('trailing90Days is anchored to the same closed-week Monday and measures real elapsed hours', () => {
  const built = windows();
  assert.equal(built.trailing90Days.end, built.currentClosedWeek.end);
  assert.equal(built.trailing90Days.end, '2026-03-09T00:00:00-07:00[America/Los_Angeles]');
  // 2026-03-09 minus 90 calendar days, at account-local start of day.
  assert.equal(built.trailing90Days.start, '2025-12-09T00:00:00-08:00[America/Los_Angeles]');
  // 90 days spanning ONE spring-forward transition is 2160 - 1 elapsed hours.
  assert.equal(built.trailing90Days.durationHours, 2159);
  assert.equal(built.trailing28Days.durationHours, 671); // 672 - 1, same transition.

  const sydney = buildWindows({
    cutoff: '2026-04-13T09:00:00+10:00',
    timezone: 'Australia/Sydney',
    maturityDays: 0,
  });
  assert.equal(sydney.trailing90Days.end, '2026-04-13T00:00:00+10:00[Australia/Sydney]');
  assert.equal(sydney.trailing90Days.start, '2026-01-13T00:00:00+11:00[Australia/Sydney]');
  // 90 days spanning ONE fall-back transition is 2160 + 1 elapsed hours.
  assert.equal(sydney.trailing90Days.durationHours, 2161);
});

test('a 60-day-lag edge is measurable in trailing90Days where trailing28Days has no population', () => {
  // ONE subject, entering 70 days before the closed-week boundary and converting 5 days later.
  const nodes = [
    node('lag_from', 0, 'won', '2025-12-29T09:00:00-08:00'),
    node('lag_to', 0, 'collected_revenue', '2026-01-03T09:00:00-08:00', { revenueAmount: 400 }),
  ];
  const longLag = contract({
    fromStage: 'won',
    toStage: 'collected_revenue',
    allowedLag: { amount: 60, unit: 'days' },
  });
  const built = windows();
  const built90 = measure(graph(nodes), longLag, 'trailing90Days', built);
  assert.equal(built90.state, 'OBSERVED');
  assert.equal(built90.eligible, 1);
  assert.equal(built90.denominator, 1);
  assert.equal(built90.numerator, 1);
  assert.equal(built90.value, 400);
  assert.equal(built90.coverageRatio, 1);

  const built28 = measure(graph(nodes), longLag, 'trailing28Days', built);
  assert.equal(built28.state, 'OBSERVED');
  assert.equal(built28.eligible, 0);
  assert.equal(built28.denominator, 0);
  assert.equal(built28.rate, null);
  assert.equal(built28.reasonCode, 'NO_ELIGIBLE_POPULATION');

  const result = computeJourneyMetrics({
    graph: graph(nodes),
    metricContracts: { version: '1.0.0', edges: [longLag] },
    windows: built,
  });
  assert.deepEqual(
    Object.keys(result.metrics).sort(),
    ['currentClosedWeek', 'previousClosedWeek', 'trailing28Days', 'trailing90Days'],
  );
  assert.deepEqual(
    Object.keys(result.cohorts).sort(),
    ['currentClosedWeek', 'previousClosedWeek', 'trailing28Days', 'trailing90Days'],
  );
});

test('the same inputs produce byte-identical output regardless of node and edge order', () => {
  const conflicts = [{ conflictId: 'conflict_one', nodeIds: [entityId(0)] }];
  const forward = computeJourneyMetrics({
    graph: graph(tenSubjects(), { conflicts }),
    metricContracts: { version: '1.0.0', edges: [contract()] },
    windows: windows(),
  });
  const reversedNodes = [...tenSubjects()].reverse();
  const reversedGraph = freeze({
    nodes: reversedNodes,
    edges: [...identityEdges(reversedNodes)].reverse(),
    conflicts,
    unresolvedJoins: [],
  });
  const reversed = computeJourneyMetrics({
    graph: reversedGraph,
    metricContracts: { version: '1.0.0', edges: [contract()] },
    windows: windows(),
  });
  assert.equal(JSON.stringify(forward), JSON.stringify(reversed));
  // Every timestamp in the output carries the account zone, never the host zone.
  assert.match(
    JSON.stringify(forward.metrics.currentClosedWeek.engagement.window),
    /America\/Los_Angeles/,
  );
});

test('two duplicate email addresses no longer black out the real chain', () => {
  const value = JSON.parse(readFileSync(
    join(here, 'fixtures/weekly/grom-dual-journey-portal-complete/input.json'),
    'utf8',
  ));
  const profile = JSON.parse(readFileSync(
    join(here, '../profiles/grom-internal.v1.json'),
    'utf8',
  ));
  const ref = (character) => `ev_${character.repeat(16)}`;
  // The shipped fixture's only contact acquires an email address, and a SECOND contact claims the
  // same one. A THIRD contact is clean. All three enquire and all three are won inside the week.
  value.collections[0].items[0].normalizedEmail = 'dupe@example.test';
  const journeyEvent = (nativeId, subjectNativeId, stage, eventTime, evidenceRef) => ({
    recordType: 'journey_event',
    nativeId,
    subjectNativeId,
    stage,
    journeyId: 'agency_new_business',
    journeyInstanceId: 'journey_agency_new_business',
    eventTime,
    evidenceRef,
  });
  const added = [
    {
      recordType: 'contact',
      nativeId: 'contact-2',
      normalizedEmail: 'dupe@example.test',
      eventTime: '2026-07-13T01:10:00.000Z',
      evidenceRef: ref('a'),
    },
    journeyEvent('event-enquiry-2', 'contact-2', 'enquiry', '2026-07-13T02:10:00.000Z', ref('b')),
    journeyEvent('event-won-2', 'contact-2', 'won', '2026-07-14T02:10:00.000Z', ref('c')),
    {
      recordType: 'contact',
      nativeId: 'contact-3',
      normalizedEmail: 'clean@example.test',
      eventTime: '2026-07-13T01:20:00.000Z',
      evidenceRef: ref('d'),
    },
    journeyEvent('event-enquiry-3', 'contact-3', 'enquiry', '2026-07-13T02:20:00.000Z', ref('e')),
    journeyEvent('event-won-3', 'contact-3', 'won', '2026-07-14T02:20:00.000Z', ref('f')),
  ];
  value.collections[0].items.push(...added);
  value.collections[0].page.reportedCount += added.length;
  value.collections[0].page.collectedCount += added.length;
  const records = normalizeEvidence(value.collections, value.context);
  const realGraph = buildEvidenceGraph({ records, context: value.context, profile });
  // Hand-stated: ONE duplicate-identity conflict, naming the two contact entities that share
  // an email address.
  assert.equal(realGraph.conflicts.length, 1);
  assert.equal(realGraph.conflicts[0].type, 'duplicate_identity_claim');
  assert.equal(realGraph.conflicts[0].nodeIds.length, 2);

  const metric = computeJourneyMetrics({
    graph: realGraph,
    metricContracts: {
      version: '1.0.0',
      edges: [{
        edgeId: 'acquisition',
        journeyId: 'agency_new_business',
        journeyInstanceId: 'journey_agency_new_business',
        fromStage: 'enquiry',
        toStage: 'won',
        allowedLag: { amount: 2, unit: 'days' },
        reentryRule: 'same_journey_instance',
        required: true,
        nativeMapping: 'MAPPED',
        eligibilityRule: { minimumSample: 1, minimumCoverage: 0.3 },
      }],
    },
    windows: buildWindows({ cutoff: '2026-07-20T10:00:00Z', timezone: 'UTC', maturityDays: 0 }),
  }).metrics.currentClosedWeek.acquisition;
  // Three enquiries, two of them tainted by the shared email address, the third measured and won.
  assert.equal(metric.state, 'OBSERVED');
  assert.equal(metric.eligible, 3);
  assert.equal(metric.denominator, 1);
  assert.equal(metric.numerator, 1);
  assert.equal(metric.rate, 1);
  assert.equal(metric.excluded, 2);
  assert.deepEqual(metric.exclusions, { IDENTITY_CONFLICT: 2 });
  assert.equal(metric.coverage, 'INCOMPLETE');
  assert.equal(metric.coverageRatio, 1 / 3);
});

test('the coverage floor is declarable in the metric contracts and validated there', () => {
  const shipped = structuredClone(loadMetricContracts('client'));
  shipped.coverageFloor = 0.75;
  shipped.edges[0].eligibilityRule = { minimumSample: 3, minimumCoverage: 0.9 };
  assert.equal(MetricContractsSchema.parse(shipped).coverageFloor, 0.75);

  for (const invalid of [1.5, -0.1, 'high', null]) {
    const broken = structuredClone(loadMetricContracts('client'));
    broken.edges[0].eligibilityRule = { minimumCoverage: invalid };
    assert.throws(() => MetricContractsSchema.parse(broken), String(invalid));
  }
  const brokenProfileFloor = structuredClone(loadMetricContracts('client'));
  brokenProfileFloor.coverageFloor = 2;
  assert.throws(() => MetricContractsSchema.parse(brokenProfileFloor));
  const brokenSample = structuredClone(loadMetricContracts('client'));
  brokenSample.edges[0].eligibilityRule = { minimumSample: -2 };
  assert.throws(() => MetricContractsSchema.parse(brokenSample));
});

test('computed metrics stay deep-frozen and the frozen input graph is never mutated', () => {
  const built = graph(tenSubjects(), {
    conflicts: [{ conflictId: 'conflict_one', nodeIds: [entityId(0)] }],
  });
  const before = JSON.stringify(built);
  const result = computeJourneyMetrics({
    graph: built,
    metricContracts: { version: '1.0.0', edges: [contract()] },
    windows: windows(),
  });
  assert.equal(JSON.stringify(built), before);
  assert.ok(Object.isFrozen(result.metrics.currentClosedWeek.engagement));
  assert.ok(Object.isFrozen(result.metrics.currentClosedWeek.engagement.exclusions));
});
