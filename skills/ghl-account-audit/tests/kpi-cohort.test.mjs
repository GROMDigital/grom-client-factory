import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { buildEvidenceGraph } from '../lib/evidence-graph.mjs';
import { buildWindows, computeJourneyMetrics } from '../lib/metrics.mjs';
import { normalizeEvidence } from '../lib/normalize.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const gromProfile = JSON.parse(readFileSync(join(here, '../profiles/grom-internal.v1.json'), 'utf8'));

function gromFixture() {
  return JSON.parse(readFileSync(
    join(here, 'fixtures/weekly/grom-dual-journey-portal-complete/input.json'),
    'utf8',
  ));
}

function freeze(value) {
  for (const child of Object.values(value)) {
    if (child && typeof child === 'object') freeze(child);
  }
  return Object.freeze(value);
}

function event(id, subjectRef, journeyInstanceId, stage, eventTime, extra = {}) {
  return {
    nodeId: `node_${id}`,
    type: 'journey_event',
    classification: 'OBSERVED',
    journeyId: extra.journeyId ?? 'client_sales',
    journeyInstanceId,
    subjectRef,
    cohortInstanceRef: extra.cohortInstanceRef ?? `${journeyInstanceId}:${subjectRef}`,
    stage,
    eventTime,
    capturedAt: extra.capturedAt ?? '2026-03-09T07:00:00Z',
    provenance: { completeness: 'COMPLETE' },
    evidenceRefs: [`ev_${id.padEnd(16, '0')}`],
    ...extra,
  };
}

function graph(nodes, extra = {}) {
  return freeze({
    nodes,
    edges: extra.edges ?? nodes.map((node) => ({
      type: 'identity_exact',
      fromNodeId: `entity_${node.subjectRef}`,
      toNodeId: node.nodeId,
      joinMethod: 'native_id',
      joinConfidence: 'exact',
    })),
    conflicts: extra.conflicts ?? [],
    unresolvedJoins: extra.unresolvedJoins ?? [],
  });
}

function contract(edgeId, fromStage, toStage, extra = {}) {
  return {
    edgeId,
    journeyId: extra.journeyId ?? 'client_sales',
    journeyInstanceId: extra.journeyInstanceId ?? 'journey_client_sales',
    fromStage,
    toStage,
    allowedLag: extra.allowedLag ?? { amount: 7, unit: 'days' },
    reentryRule: extra.reentryRule ?? 'same_journey_instance',
    required: extra.required ?? true,
    nativeMapping: extra.nativeMapping ?? 'MAPPED',
    eligibilityRule: { minimumSample: extra.minimumSample ?? 2 },
  };
}

test('closed account-local windows survive DST and separate flow, stock, trailing, and mature views', () => {
  const windows = buildWindows({
    cutoff: '2026-03-09T10:15:00-07:00',
    timezone: 'America/Los_Angeles',
    maturityDays: 14,
  });
  assert.deepEqual(windows.currentClosedWeek, {
    start: '2026-03-02T00:00:00-08:00[America/Los_Angeles]',
    end: '2026-03-09T00:00:00-07:00[America/Los_Angeles]',
    durationHours: 167,
  });
  assert.deepEqual(windows.previousClosedWeek, {
    start: '2026-02-23T00:00:00-08:00[America/Los_Angeles]',
    end: '2026-03-02T00:00:00-08:00[America/Los_Angeles]',
    durationHours: 168,
  });
  assert.equal(windows.trailing28Days.start, '2026-02-09T00:00:00-08:00[America/Los_Angeles]');
  assert.equal(windows.trailing28Days.end, windows.currentClosedWeek.end);
  assert.equal(windows.currentClosedWeek.durationHours, 167);
  assert.equal(windows.matureAsOf, '2026-02-23T00:00:00-08:00[America/Los_Angeles]');
});

test('adjacent-stage metrics use mature flow cohorts, deduplicate re-entry and late events, and keep stock separate', () => {
  const windows = buildWindows({
    cutoff: '2026-03-09T10:15:00-07:00',
    timezone: 'America/Los_Angeles',
    maturityDays: 0,
  });
  const nodes = [
    event('a', 'psn_aaaaaaaaaaaaaaaa', 'journey_client_sales', 'lead_created', '2026-03-02T09:00:00-08:00'),
    event('b', 'psn_aaaaaaaaaaaaaaaa', 'journey_client_sales', 'lead_created', '2026-03-02T10:00:00-08:00'),
    event('c', 'psn_aaaaaaaaaaaaaaaa', 'journey_client_sales', 'first_engagement', '2026-03-02T12:00:00-08:00'),
    event('d', 'psn_bbbbbbbbbbbbbbbb', 'journey_client_sales', 'lead_created', '2026-03-03T09:00:00-08:00'),
    event('e', 'psn_bbbbbbbbbbbbbbbb', 'journey_client_sales', 'first_engagement', '2026-03-04T09:00:00-08:00', {
      capturedAt: '2026-03-10T09:00:00Z',
    }),
    event('f', 'psn_cccccccccccccccc', 'journey_client_sales', 'lead_created', '2026-03-08T09:00:00-07:00'),
    event('g', 'psn_stockstockstock1', 'journey_client_sales', 'first_engagement', '2026-02-01T09:00:00-08:00'),
  ];
  const result = computeJourneyMetrics({
    graph: graph(nodes),
    metricContracts: {
      version: '1.0.0',
      edges: [contract('first_engagement', 'lead_created', 'first_engagement', {
        allowedLag: { amount: 2, unit: 'days' },
      })],
    },
    windows,
  });
  const metric = result.metrics.currentClosedWeek.first_engagement;
  assert.deepEqual(metric, {
    state: 'OBSERVED',
    numerator: 1,
    denominator: 2,
    rate: 0.5,
    eligible: 2,
    threshold: 2,
    rankEligible: true,
    window: windows.currentClosedWeek,
    coverage: 'COMPLETE',
    reasonCode: null,
  });
  assert.equal(result.currentStock.journey_client_sales.first_engagement, 2);
  assert.equal(result.cohorts.currentClosedWeek.journey_client_sales, 3);
});

test('maturityDays globally excludes immature cohorts before rates can be proven', () => {
  const nodes = [
    event('m1', 'psn_maturitymaturity', 'journey_client_sales', 'lead_created', '2026-03-02T09:00:00-08:00'),
    event('m2', 'psn_maturitymaturity', 'journey_client_sales', 'first_engagement', '2026-03-02T10:00:00-08:00'),
  ];
  const metricContracts = {
    version: '1.0.0',
    edges: [contract('engagement', 'lead_created', 'first_engagement', {
      allowedLag: { amount: 1, unit: 'days' },
      minimumSample: 1,
    })],
  };
  const mature = computeJourneyMetrics({
    graph: graph(nodes),
    metricContracts,
    windows: buildWindows({
      cutoff: '2026-03-09T10:00:00-07:00',
      timezone: 'America/Los_Angeles',
      maturityDays: 0,
    }),
  }).metrics.currentClosedWeek.engagement;
  const immature = computeJourneyMetrics({
    graph: graph(nodes),
    metricContracts,
    windows: buildWindows({
      cutoff: '2026-03-09T10:00:00-07:00',
      timezone: 'America/Los_Angeles',
      maturityDays: 14,
    }),
  }).metrics.currentClosedWeek.engagement;
  assert.deepEqual([mature.state, mature.numerator, mature.denominator], ['OBSERVED', 1, 1]);
  assert.deepEqual(
    [immature.state, immature.numerator, immature.denominator, immature.reasonCode],
    ['UNKNOWN', null, null, 'IMMATURE_COHORT'],
  );
});

test('real Task 5 graph proves Grom metrics and current stock without descriptor-node contamination', () => {
  const value = gromFixture();
  const records = normalizeEvidence(value.collections, value.context);
  const realGraph = buildEvidenceGraph({ records, context: value.context, profile: gromProfile });
  const windows = buildWindows({
    cutoff: '2026-07-20T10:00:00Z',
    timezone: 'UTC',
    maturityDays: 0,
  });
  const metricContracts = {
    version: '1.0.0',
    edges: [
      contract('grom_acquisition', 'enquiry', 'won', {
        journeyId: 'agency_new_business',
        journeyInstanceId: 'journey_agency_new_business',
        allowedLag: { amount: 2, unit: 'days' },
        minimumSample: 1,
      }),
      contract('grom_onboarding', 'onboarding_started', 'assets_confirmed', {
        journeyId: 'client_onboarding',
        journeyInstanceId: 'journey_client_onboarding',
        allowedLag: { amount: 2, unit: 'days' },
        minimumSample: 1,
      }),
    ],
  };
  const result = computeJourneyMetrics({ graph: realGraph, metricContracts, windows });
  assert.deepEqual(
    [result.metrics.currentClosedWeek.grom_acquisition.state,
      result.metrics.currentClosedWeek.grom_acquisition.numerator,
      result.metrics.currentClosedWeek.grom_acquisition.denominator],
    ['OBSERVED', 1, 1],
  );
  assert.deepEqual(
    [result.metrics.currentClosedWeek.grom_onboarding.state,
      result.metrics.currentClosedWeek.grom_onboarding.numerator,
      result.metrics.currentClosedWeek.grom_onboarding.denominator],
    ['OBSERVED', 1, 1],
  );
  assert.deepEqual(result.currentStock, {
    journey_agency_new_business: { won: 1 },
    journey_client_onboarding: { assets_confirmed: 1 },
  });
});

test('real Task 5 graph preserves explicit cohort instances for re-entry deduplication', () => {
  const value = gromFixture();
  for (const item of value.collections[0].items) {
    if (item.journeyId === 'agency_new_business' && ['enquiry', 'won'].includes(item.stage)) {
      item.cohortInstanceRef = 'cohort_acquisition_one';
    }
  }
  const reentry = value.collections[0].items
    .filter(({ journeyId, stage }) => (
      journeyId === 'agency_new_business' && ['enquiry', 'won'].includes(stage)
    ))
    .map((item, index) => ({
      ...item,
      nativeId: `${item.nativeId}-reentry`,
      evidenceRef: `ev_${index ? 'dddddddddddddddd' : 'cccccccccccccccc'}`,
      cohortInstanceRef: 'cohort_acquisition_two',
      eventTime: index
        ? '2026-07-16T03:00:00.000Z'
        : '2026-07-16T02:00:00.000Z',
    }));
  const reopenedDuplicate = {
    ...reentry.find(({ stage }) => stage === 'won'),
    nativeId: 'event-won-reentry-reopened',
    evidenceRef: 'ev_eeeeeeeeeeeeeeee',
    eventTime: '2026-07-16T04:00:00.000Z',
  };
  value.collections[0].items.push(...reentry, reopenedDuplicate);
  value.collections[0].page.reportedCount += reentry.length + 1;
  value.collections[0].page.collectedCount += reentry.length + 1;
  const records = normalizeEvidence(value.collections, value.context);
  const realGraph = buildEvidenceGraph({ records, context: value.context, profile: gromProfile });
  const eventNodes = realGraph.nodes.filter(({ type, journeyInstanceId }) => (
    type === 'journey_event' && journeyInstanceId === 'journey_agency_new_business'
  ));
  assert.deepEqual(
    [...new Set(eventNodes.map(({ cohortInstanceRef }) => cohortInstanceRef))].sort(),
    ['cohort_acquisition_one', 'cohort_acquisition_two'],
  );
  const baseContract = {
    ...contract('reentry', 'enquiry', 'won', {
      journeyId: 'agency_new_business',
      journeyInstanceId: 'journey_agency_new_business',
      allowedLag: { amount: 2, unit: 'days' },
      minimumSample: 1,
    }),
  };
  const windows = buildWindows({
    cutoff: '2026-07-20T10:00:00Z',
    timezone: 'UTC',
    maturityDays: 0,
  });
  const newInstance = computeJourneyMetrics({
    graph: realGraph,
    metricContracts: {
      version: '1.0.0',
      edges: [{ ...baseContract, reentryRule: 'new_journey_instance' }],
    },
    windows,
  }).metrics.currentClosedWeek.reentry;
  const sameInstance = computeJourneyMetrics({
    graph: realGraph,
    metricContracts: {
      version: '1.0.0',
      edges: [{ ...baseContract, reentryRule: 'same_journey_instance' }],
    },
    windows,
  }).metrics.currentClosedWeek.reentry;
  assert.deepEqual([newInstance.numerator, newInstance.denominator], [2, 2]);
  assert.deepEqual([sameInstance.numerator, sameInstance.denominator], [1, 1]);

  const noExplicitValue = gromFixture();
  const noExplicitRecords = normalizeEvidence(noExplicitValue.collections, noExplicitValue.context);
  const noExplicitGraph = buildEvidenceGraph({
    records: noExplicitRecords,
    context: noExplicitValue.context,
    profile: gromProfile,
  });
  const missingContract = computeJourneyMetrics({
    graph: noExplicitGraph,
    metricContracts: {
      version: '1.0.0',
      edges: [{ ...baseContract, reentryRule: 'new_journey_instance' }],
    },
    windows,
  }).metrics.currentClosedWeek.reentry;
  assert.deepEqual(
    [missingContract.state, missingContract.reasonCode],
    ['UNKNOWN', 'MISSING_COHORT_INSTANCE'],
  );
});

test('real Task 5 graph preserves collected revenue and rejects missing, negative, or nonfinite amounts', () => {
  const value = gromFixture();
  const revenueEvent = {
    recordType: 'journey_event',
    nativeId: 'event-collected-revenue',
    subjectNativeId: 'contact-1',
    stage: 'collected_revenue',
    journeyId: 'agency_new_business',
    journeyInstanceId: 'journey_agency_new_business',
    eventTime: '2026-07-15T02:00:00.000Z',
    evidenceRef: 'ev_f0f0f0f0f0f0f0f0',
    revenueAmount: 2500,
  };
  value.collections[0].items.push(revenueEvent);
  value.collections[0].page.reportedCount += 1;
  value.collections[0].page.collectedCount += 1;
  const records = normalizeEvidence(value.collections, value.context);
  const realGraph = buildEvidenceGraph({ records, context: value.context, profile: gromProfile });
  const revenueNode = realGraph.nodes.find(({ evidenceRefs }) => (
    evidenceRefs.includes(revenueEvent.evidenceRef)
  ));
  assert.equal(revenueNode.revenueAmount, 2500);
  const revenueMetric = computeJourneyMetrics({
    graph: realGraph,
    metricContracts: {
      version: '1.0.0',
      edges: [contract('revenue', 'won', 'collected_revenue', {
        journeyId: 'agency_new_business',
        journeyInstanceId: 'journey_agency_new_business',
        allowedLag: { amount: 2, unit: 'days' },
        minimumSample: 1,
      })],
    },
    windows: buildWindows({
      cutoff: '2026-07-20T10:00:00Z',
      timezone: 'UTC',
      maturityDays: 0,
    }),
  }).metrics.currentClosedWeek.revenue;
  assert.deepEqual(
    [revenueMetric.state, revenueMetric.numerator, revenueMetric.denominator, revenueMetric.value],
    ['OBSERVED', 1, 1, 2500],
  );

  for (const invalidAmount of [undefined, -1, Number.POSITIVE_INFINITY]) {
    const invalid = gromFixture();
    invalid.collections[0].items.push({
      ...revenueEvent,
      ...(invalidAmount === undefined ? {} : { revenueAmount: invalidAmount }),
    });
    if (invalidAmount === undefined) {
      delete invalid.collections[0].items.at(-1).revenueAmount;
    }
    invalid.collections[0].page.reportedCount += 1;
    invalid.collections[0].page.collectedCount += 1;
    assert.throws(
      () => normalizeEvidence(invalid.collections, invalid.context),
      /EVIDENCE_RECORD_INVALID/,
    );
  }
});

test('versioned re-entry rules either preserve distinct cohort instances or deduplicate the subject', () => {
  const windows = buildWindows({
    cutoff: '2026-03-16T09:00:00-07:00',
    timezone: 'America/Los_Angeles',
    maturityDays: 0,
  });
  const subjectRef = 'psn_reentryreentry1';
  const nodes = [
    event('r1', subjectRef, 'journey_client_sales', 'lead_created', '2026-03-02T09:00:00-08:00', { cohortInstanceRef: 'cohort_one' }),
    event('r2', subjectRef, 'journey_client_sales', 'first_engagement', '2026-03-02T10:00:00-08:00', { cohortInstanceRef: 'cohort_one' }),
    event('r3', subjectRef, 'journey_client_sales', 'lead_created', '2026-03-03T09:00:00-08:00', { cohortInstanceRef: 'cohort_two' }),
    event('r4', subjectRef, 'journey_client_sales', 'first_engagement', '2026-03-03T10:00:00-08:00', { cohortInstanceRef: 'cohort_two' }),
  ];
  const contracts = [
    contract('new_instance', 'lead_created', 'first_engagement', {
      reentryRule: 'new_journey_instance',
      minimumSample: 1,
    }),
    contract('same_instance', 'lead_created', 'first_engagement', {
      reentryRule: 'same_journey_instance',
      minimumSample: 1,
    }),
  ];
  const metrics = computeJourneyMetrics({
    graph: graph(nodes),
    metricContracts: { version: '1.0.0', edges: contracts },
    windows,
  }).metrics.previousClosedWeek;
  assert.deepEqual([metrics.new_instance.numerator, metrics.new_instance.denominator], [2, 2]);
  assert.deepEqual([metrics.same_instance.numerator, metrics.same_instance.denominator], [1, 1]);
});

test('golden client metrics handle appointment outcomes, reopened opportunities, revenue, and reactivation exactly once', () => {
  const windows = buildWindows({
    cutoff: '2026-04-06T09:00:00-07:00',
    timezone: 'America/Los_Angeles',
    maturityDays: 0,
  });
  const stages = {
    p1: ['lead_created', 'first_engagement', 'qualified', 'booked', 'showed', 'opportunity_outcome', 'won', 'collected_revenue'],
    p2: ['lead_created', 'first_engagement', 'qualified', 'booked', 'no_show'],
    p3: ['lead_created', 'first_engagement', 'qualified', 'booked', 'cancelled', 'cancelled', 'rebooked'],
    p4: ['lead_created'],
    p5: ['closed', 'reactivated', 'reactivated'],
  };
  const nodes = [];
  let sequence = 0;
  for (const [person, personStages] of Object.entries(stages)) {
    for (const [index, stage] of personStages.entries()) {
      sequence += 1;
      nodes.push(event(String(sequence), `psn_${person.padEnd(16, person)}`, 'journey_client_sales', stage,
        `2026-03-30T${String(8 + index).padStart(2, '0')}:00:00-07:00`, {
          outcome: stage === 'opportunity_outcome' ? 'won' : undefined,
          revenueAmount: stage === 'collected_revenue' ? 1200 : undefined,
        }));
    }
  }
  nodes.push(event('reopen', 'psn_p1p1p1p1p1p1p1p1', 'journey_client_sales', 'opportunity_outcome',
    '2026-03-30T20:00:00-07:00', { outcome: 'won' }));
  const edges = [
    contract('first_engagement', 'lead_created', 'first_engagement'),
    contract('booking', 'qualified', 'booked'),
    contract('show', 'booked', 'showed'),
    contract('no_show', 'booked', 'no_show'),
    contract('cancellation', 'booked', 'cancelled'),
    contract('rebooking', 'cancelled', 'rebooked'),
    contract('opportunity_outcome', 'showed', 'opportunity_outcome'),
    contract('revenue', 'won', 'collected_revenue'),
    contract('reactivation', 'closed', 'reactivated'),
  ].map((edge) => ({ ...edge, allowedLag: { amount: 1, unit: 'days' } }));
  const metrics = computeJourneyMetrics({
    graph: graph(nodes),
    metricContracts: { version: '1.0.0', edges },
    windows,
  }).metrics.currentClosedWeek;
  assert.deepEqual(Object.fromEntries(edges.map(({ edgeId }) => [
    edgeId,
    [metrics[edgeId].numerator, metrics[edgeId].denominator],
  ])), {
    first_engagement: [3, 4],
    booking: [3, 3],
    show: [1, 3],
    no_show: [1, 3],
    cancellation: [1, 3],
    rebooking: [1, 1],
    opportunity_outcome: [1, 1],
    revenue: [1, 1],
    reactivation: [1, 1],
  });
  assert.equal(metrics.revenue.value, 1200);
});

test('Grom acquisition and onboarding milestones retain separate journey-instance denominators', () => {
  const windows = buildWindows({
    cutoff: '2026-04-06T09:00:00-07:00',
    timezone: 'America/Los_Angeles',
    maturityDays: 0,
  });
  const nodes = [
    event('ga1', 'psn_gromacquisition', 'journey_agency_new_business', 'enquiry', '2026-03-30T00:00:00-07:00', { journeyId: 'agency_new_business' }),
    event('ga2', 'psn_gromacquisition', 'journey_agency_new_business', 'contacted', '2026-03-30T01:00:00-07:00', { journeyId: 'agency_new_business' }),
    event('go1', 'psn_gromonboarding1', 'journey_client_onboarding', 'won_or_paid', '2026-03-30T00:00:00-07:00', { journeyId: 'client_onboarding' }),
    event('go2', 'psn_gromonboarding1', 'journey_client_onboarding', 'internal_handoff', '2026-03-30T01:00:00-07:00', { journeyId: 'client_onboarding' }),
    event('go3', 'psn_gromonboarding2', 'journey_client_onboarding', 'won_or_paid', '2026-03-30T02:00:00-07:00', { journeyId: 'client_onboarding' }),
  ];
  const metrics = computeJourneyMetrics({
    graph: graph(nodes),
    metricContracts: {
      version: '1.0.0',
      edges: [
        contract('acquisition_contacted', 'enquiry', 'contacted', {
          journeyId: 'agency_new_business',
          journeyInstanceId: 'journey_agency_new_business',
          minimumSample: 1,
        }),
        contract('onboarding_handoff', 'won_or_paid', 'internal_handoff', {
          journeyId: 'client_onboarding',
          journeyInstanceId: 'journey_client_onboarding',
          minimumSample: 1,
        }),
      ],
    },
    windows,
  }).metrics.currentClosedWeek;
  assert.deepEqual([metrics.acquisition_contacted.numerator, metrics.acquisition_contacted.denominator], [1, 1]);
  assert.deepEqual([metrics.onboarding_handoff.numerator, metrics.onboarding_handoff.denominator], [1, 2]);
});

test('right-censored, incomplete, unresolved, ambiguous, inferred, and unmapped evidence becomes UNKNOWN, not zero', () => {
  const windows = buildWindows({
    cutoff: '2026-03-09T10:15:00-07:00',
    timezone: 'America/Los_Angeles',
    maturityDays: 0,
  });
  const base = event('x', 'psn_xxxxxxxxxxxxxxxx', 'journey_client_sales', 'lead_created', '2026-03-08T12:00:00-07:00');
  const cases = [
    { graph: graph([base]), contract: contract('right_censored', 'lead_created', 'first_engagement', { allowedLag: { amount: 2, unit: 'days' } }) },
    { graph: graph([{ ...base, provenance: { completeness: 'INCOMPLETE' } }]), contract: contract('incomplete', 'lead_created', 'first_engagement') },
    { graph: graph([base], { unresolvedJoins: [{ journeyInstanceId: 'journey_client_sales' }] }), contract: contract('unresolved', 'lead_created', 'first_engagement') },
    { graph: graph([base], { conflicts: [{ journeyInstanceId: 'journey_client_sales' }] }), contract: contract('conflict', 'lead_created', 'first_engagement') },
    { graph: graph([base], { edges: [{ type: 'inferred_match', toNodeId: base.nodeId }] }), contract: contract('inferred', 'lead_created', 'first_engagement') },
    { graph: graph([base], { edges: [] }), contract: contract('unjoined', 'lead_created', 'first_engagement') },
    { graph: graph([base]), contract: contract('unmapped', 'lead_created', 'first_engagement', { nativeMapping: 'UNKNOWN' }) },
  ];
  for (const item of cases) {
    const metric = computeJourneyMetrics({
      graph: item.graph,
      metricContracts: { version: '1.0.0', edges: [item.contract] },
      windows,
    }).metrics.currentClosedWeek[item.contract.edgeId];
    assert.deepEqual({
      state: metric.state,
      numerator: metric.numerator,
      denominator: metric.denominator,
      rate: metric.rate,
      reasonCode: metric.reasonCode,
    }, {
      state: 'UNKNOWN',
      numerator: null,
      denominator: null,
      rate: null,
      reasonCode: 'MISSING_REQUIRED_EVIDENCE',
    });
  }
});
