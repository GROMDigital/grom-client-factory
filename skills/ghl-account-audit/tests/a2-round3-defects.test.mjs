/**
 * TASK A2, ROUND 3 — the five defects a reviewer reproduced against the SHIPPED profiles by
 * EXECUTION through the real chain, and the behaviour that replaces them. All five are about MONEY.
 *
 * C1  `won_to_collected_revenue` is `measure: "VALUE"`, which bypasses the rate guards, but it kept
 *     `allowedLag: {60, days}` from when it was a rate — so a win contributed money only 60 days
 *     after it happened. Weekly and 28-day windows could therefore mature NOBODY, ever, and the
 *     90-day window was short by whatever closed inside the last 60 days. A VALUE measure has
 *     nothing to wait for: the amount is known at the entrant's own instant.
 * H2  `zeroAmountPolicy: UNUSABLE` emitted an UNKNOWN-classified `collected_revenue` event, which
 *     tainted the whole subject and removed it from EVERY edge, appointment edges included. An
 *     unknown AMOUNT must suppress the AMOUNT, not the subject's appointment history.
 * H3  Every ladder edge was unreachable from the finding layer, because `nominateMechanisms` and
 *     the grom scorecard both read `currentClosedWeek` and nothing else — and the ladder edges
 *     report in `trailing60Days` / `trailing90Days` / `trailing180Days`.
 * M4  The tautology gate compared predicates BYTE-wise inside one source, and was bypassed three
 *     ways: `field_in` versus `field_equals`, a padded `eventTimeField`, and the same records split
 *     across two sources.
 * L5  The money never reached the human report: a VALUE cell rendered as `unknown/unknown`.
 *
 * EVERY MONEY FIGURE BELOW IS HAND-SUMMED FROM THE RAW FIXTURE ROWS, stated in a comment beside the
 * rows themselves, and never taken from anything the code produced.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { sha256 } from '../lib/canonical.mjs';
import { buildEvidenceGraph } from '../lib/evidence-graph.mjs';
import { projectJourneyEvents } from '../lib/journey-projection.mjs';
import { nominateMechanisms } from '../lib/mechanisms.mjs';
import { buildWindows, computeJourneyMetrics } from '../lib/metrics.mjs';
import { normalizeEvidence } from '../lib/normalize.mjs';
import { compilePublicationArtifacts } from '../lib/report.mjs';
import * as schemas from '../schemas/v1.mjs';

const { assertMetricStageCoverage, loadMetricContracts, loadProjection } = schemas;

const profilesUrl = new URL('../profiles/', import.meta.url);
const readProfile = (name) => JSON.parse(readFileSync(new URL(name, profilesUrl), 'utf8'));
const CLIENT_PROFILE = readProfile('client.v1.json');

const CONTEXT = Object.freeze({ locationId: 'LOC-A2-ROUND3' });
const APPLIED_WINDOW = Object.freeze({
  from: '2026-01-01T00:00:00.000Z',
  to: '2026-08-31T00:00:00.000Z',
});
const CAPTURED_AT = '2026-07-27T00:00:00.000Z';

const CONTACTS_ACTION = 'contacts.search';
const CONVERSATIONS_ACTION = 'conversations-v3__search-conversation';
const APPOINTMENTS_ACTION = 'calendars-v3__get-calendar-events';
const OPPORTUNITIES_ACTION = 'opportunities.list';

/**
 * 2026-07-27 is a Monday, so with `timezone: 'UTC'`:
 *   currentClosedWeek  [2026-07-20, 2026-07-27)
 *   previousClosedWeek [2026-07-13, 2026-07-20)
 *   trailing28Days     [2026-06-29, 2026-07-27)
 *   trailing90Days     [2026-04-28, 2026-07-27)
 *   matureAsOf          2026-07-26   (maturityDays: 1)
 */
const CUTOFF = '2026-07-27T00:00:00.000Z';
const WINDOWS = buildWindows({ cutoff: CUTOFF, timezone: 'UTC', maturityDays: 1 });

function envelope(operationId, items) {
  return {
    source: 'public_ghl',
    operationId,
    boundLocationId: CONTEXT.locationId,
    requestedWindow: { ...APPLIED_WINDOW },
    appliedWindow: { ...APPLIED_WINDOW },
    capturedAt: CAPTURED_AT,
    items,
    page: {
      cursor: null,
      nextCursor: null,
      reportedCount: items.length,
      collectedCount: items.length,
      complete: true,
      truncated: false,
    },
  };
}

/** THE FULL REAL CHAIN, from raw GHL-shaped payloads to metric cells. */
function measure({
  contacts = [], conversations = [], appointments = [], opportunities = [],
  projection = loadProjection('client'),
  contracts = loadMetricContracts('client'),
}) {
  const projected = projectJourneyEvents({
    collections: [
      envelope(CONTACTS_ACTION, contacts),
      envelope(CONVERSATIONS_ACTION, conversations),
      envelope(APPOINTMENTS_ACTION, appointments),
      envelope(OPPORTUNITIES_ACTION, opportunities),
    ],
    context: CONTEXT,
    profile: CLIENT_PROFILE,
    projection,
  });
  const records = normalizeEvidence(projected, CONTEXT);
  const graph = buildEvidenceGraph({ records, context: CONTEXT, profile: CLIENT_PROFILE });
  const { metrics, cohorts } = computeJourneyMetrics({
    graph,
    metricContracts: contracts,
    windows: WINDOWS,
  });
  return {
    graph, metrics, cohorts, projected,
  };
}

const contact = (index, overrides = {}) => ({
  id: `c${String(index).padStart(3, '0')}`,
  email: `subject${index}@example.test`,
  phone: `+44 20 7946 ${String(1000 + index)}`,
  dateAdded: '2026-04-01T09:00:00.000Z',
  ...overrides,
});

const wonOpportunity = (id, contactId, monetaryValue, lastStatusChangeAt) => ({
  id,
  contactId,
  status: 'won',
  monetaryValue,
  lastStatusChangeAt,
});

// ===========================================================================
// C1 — a VALUE measure has nothing to wait for
// ===========================================================================

/*
 * THREE WINS, THREE CONTACTS, HAND-SUMMED FROM THESE ROWS AND NOTHING ELSE.
 *
 *   op-w  450  won 2026-07-22  -> inside currentClosedWeek, trailing28Days, trailing90Days
 *   op-m 2000  won 2026-07-05  -> inside                    trailing28Days, trailing90Days
 *   op-q 8000  won 2026-05-20  -> inside                                    trailing90Days
 *
 * TRUE TOTALS, added by hand:
 *   currentClosedWeek   450               = 450     over 1 subject
 *   trailing28Days      450 + 2000        = 2450    over 2 subjects
 *   trailing90Days      450 + 2000 + 8000 = 10450   over 3 subjects
 *
 * SHIPPED BEHAVIOUR, with the leftover 60-day lag: the first two windows mature nobody at all and
 * publish `value: null`, and the 90-day window publishes 8000 — 2450 short, 23% of the money — for
 * the single win old enough that 60 days had elapsed by the cutoff.
 */
const REVENUE_CONTACTS = [contact(1), contact(2), contact(3)];
const REVENUE_OPPORTUNITIES = [
  wonOpportunity('op-w', 'c001', 450, '2026-07-22T09:00:00.000Z'),
  wonOpportunity('op-m', 'c002', 2000, '2026-07-05T09:00:00.000Z'),
  wonOpportunity('op-q', 'c003', 8000, '2026-05-20T09:00:00.000Z'),
];

const REVENUE_TRUTH = Object.freeze({
  currentClosedWeek: { value: 450, valueSubjects: 1, eligible: 1 },
  trailing28Days: { value: 2450, valueSubjects: 2, eligible: 2 },
  trailing90Days: { value: 10450, valueSubjects: 3, eligible: 3 },
});

for (const [windowName, truth] of Object.entries(REVENUE_TRUTH)) {
  test(`C1 — ${windowName} publishes the hand-summed money, not a lag-delayed fraction`, () => {
    const { metrics } = measure({
      contacts: REVENUE_CONTACTS,
      opportunities: REVENUE_OPPORTUNITIES,
    });
    const cell = metrics[windowName].won_to_collected_revenue;
    assert.equal(cell.value, truth.value, `${windowName}: money must be the hand-summed total`);
    assert.equal(cell.valueSubjects, truth.valueSubjects);
    assert.equal(cell.eligible, truth.eligible);
    assert.equal(cell.excluded, 0);
    // A VALUE measure has nothing to wait for, so no entrant of one can ever be immature.
    assert.equal(cell.immature, 0, `${windowName}: a VALUE measure can have no immature entrant`);
    assert.equal(cell.maturityRatio, 1);
    assert.equal(cell.coverage, 'COMPLETE');
    assert.equal(cell.reasonCode, 'RATE_NOT_DERIVABLE');
  });
}

test('C1 — the weekly revenue figure is a number, which under a 60-day lag it never could be', () => {
  const { metrics } = measure({
    contacts: REVENUE_CONTACTS,
    opportunities: REVENUE_OPPORTUNITIES,
  });
  for (const windowName of ['currentClosedWeek', 'trailing28Days']) {
    assert.notEqual(
      metrics[windowName].won_to_collected_revenue.value,
      null,
      `${windowName}: a window no longer than the lag must not blank the money`,
    );
  }
});

// ===========================================================================
// H2 — an unknown AMOUNT suppresses the AMOUNT, never the subject
// ===========================================================================

/*
 * ONE ACCOUNT, TWO PRICINGS. Nine contacts, nine appointments, nine won opportunities.
 *
 * Appointments: booked 2026-05-01 + i days, start + 2 days, `showed` on even i.
 *   -> 9 booked, 5 showed. Hand-counted from the rows: 5/9.
 *
 * Opportunities: won 2026-05-20 + i hours, all inside `trailing90Days`.
 *   VARIANT A (mixed):  monetaryValue 0 on i in {0, 3, 6}, else 1000
 *                       -> 6 priced wins, hand-summed value 6 x 1000 = 6000
 *   VARIANT B (priced): monetaryValue 1000 on all nine
 *                       -> 9 priced wins, hand-summed value 9 x 1000 = 9000
 *
 * The two variants differ ONLY in the amount field. Every appointment cell must therefore be
 * byte-identical between them. Shipped, they are not: in A the three unpriced wins emit an
 * UNKNOWN `collected_revenue` event, which taints those three contacts out of `booked_to_showed`
 * as well, dropping its coverage to 6/9 = 0.667 and pushing the whole cell under the 0.8 floor.
 */
const AB_INDEXES = Array.from({ length: 9 }, (_unused, index) => index);
const AB_CONTACTS = AB_INDEXES.map((index) => contact(300 + index));
const AB_APPOINTMENTS = AB_INDEXES.map((index) => {
  const booked = new Date(Date.UTC(2026, 4, 1, 9) + index * 86_400_000);
  return {
    id: `ab-ap${index}`,
    contactId: `c${String(300 + index).padStart(3, '0')}`,
    appointmentStatus: index % 2 === 0 ? 'showed' : 'confirmed',
    dateAdded: booked.toISOString(),
    startTime: new Date(booked.getTime() + 2 * 86_400_000).toISOString(),
  };
});
const abOpportunities = (unpricedEveryThird) => AB_INDEXES.map((index) => wonOpportunity(
  `ab-op${index}`,
  `c${String(300 + index).padStart(3, '0')}`,
  unpricedEveryThird && index % 3 === 0 ? 0 : 1000,
  new Date(Date.UTC(2026, 4, 20, 9) + index * 3_600_000).toISOString(),
));

const abAccount = (unpricedEveryThird) => measure({
  contacts: AB_CONTACTS,
  appointments: AB_APPOINTMENTS,
  opportunities: abOpportunities(unpricedEveryThird),
});

test('H2 — unpriced wins change NOTHING about the appointment edges', () => {
  const mixed = abAccount(true).metrics;
  const priced = abAccount(false).metrics;
  for (const windowName of Object.keys(priced)) {
    for (const metricId of ['booked_to_showed', 'booked_to_no_show', 'booked_to_cancelled']) {
      assert.deepEqual(
        mixed[windowName][metricId],
        priced[windowName][metricId],
        `${metricId} (${windowName}) moved because an amount field was blank`,
      );
    }
  }
});

test('H2 — the appointment edge is OBSERVED at full coverage on the mixed account', () => {
  const cell = abAccount(true).metrics.trailing90Days.booked_to_showed;
  assert.equal(cell.state, 'OBSERVED');
  // Hand-counted from the rows above: 9 booked, 5 of them showed.
  assert.equal(cell.numerator, 5);
  assert.equal(cell.denominator, 9);
  assert.equal(cell.eligible, 9);
  assert.equal(cell.excluded, 0, 'no subject may be excluded for an unfilled amount field');
  assert.deepEqual(cell.exclusions, {});
  assert.equal(cell.coverageRatio, 1);
});

test('H2 — the revenue edge sees fewer CONTRIBUTING subjects, and says so in its own counts', () => {
  const cell = abAccount(true).metrics.trailing90Days.won_to_collected_revenue;
  // Hand-summed: six wins at 1000 each. The three unpriced ones contribute nothing and are not
  // fabricated as zero collections.
  assert.equal(cell.value, 6000);
  assert.equal(cell.valueSubjects, 6);
  assert.equal(cell.eligible, 9, 'all nine wins are still eligible');
  assert.equal(cell.excluded, 0, 'an unfilled amount is not an untrustworthy subject');
});

test('H2 — the unpriced revenue EVENT is suppressed with a counted, disclosed reason', () => {
  const { projected } = measure({
    contacts: [contact(1)],
    opportunities: [wonOpportunity('op-zero', 'c001', 0, '2026-05-20T09:00:00.000Z')],
  });
  const items = projected.flatMap(({ items: rows }) => rows);
  assert.equal(
    items.some(({ stage }) => stage === 'collected_revenue'),
    false,
    'no UNKNOWN revenue event may be emitted for an unpriced win',
  );
  assert.equal(
    items.some(({ stage }) => stage === 'won'),
    true,
    'the WIN itself is untouched',
  );
  const suppressed = projected
    .flatMap(({ projection }) => projection.suppressed ?? [])
    .find(({ reason }) => reason === 'REVENUE_ZERO_ON_OUTCOME_STAGE');
  assert.ok(suppressed, 'the suppression must be counted, never silent');
  assert.equal(suppressed.unit, 'emission');
  assert.equal(suppressed.count, 1);
});

// ===========================================================================
// H3 — the finding layer can reach a ladder edge
// ===========================================================================

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

function freeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) freeze(child, seen);
  return Object.freeze(value);
}

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
      ...Array.from({ length: 109 }, (_unused, index) => ({
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

function mechanismScope(metricId, overrides = {}) {
  return {
    metricId,
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
      pathRef: `path_${sha256(metricId).slice(0, 16)}`,
      relativePath: `sealed/${sha256(metricId).slice(0, 16)}.json`,
    },
    ...overrides,
  };
}

const observedCell = {
  state: 'OBSERVED',
  numerator: 3,
  denominator: 12,
  rate: 0.25,
  eligible: 12,
  threshold: 5,
  rankEligible: true,
  window: { start: '2026-03-30T00:00:00Z', end: '2026-04-06T00:00:00Z' },
  coverage: 'COMPLETE',
  reasonCode: null,
};

function mechanismInputs(scope, metricsByWindow) {
  return freeze({
    graph: mechanismGraph(),
    metrics: {
      metrics: metricsByWindow,
      cohorts: { currentClosedWeek: {} },
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
  });
}

test('H3 — a scope may NAME the window it is about, and the ladder edge becomes reachable', () => {
  const candidates = nominateMechanisms(mechanismInputs(
    mechanismScope('showed_to_opportunity_outcome_60d', { metricWindow: 'trailing90Days' }),
    {
      currentClosedWeek: {},
      trailing90Days: { showed_to_opportunity_outcome_60d: observedCell },
    },
  ));
  assert.equal(candidates.length, 1, 'a ladder edge must produce a candidate');
  assert.equal(candidates[0].symptom.metricId, 'showed_to_opportunity_outcome_60d');
  assert.equal(candidates[0].symptom.state, 'OBSERVED', 'it reads the CELL, not an empty window');
});

test('H3 — a scope that names no window still reads currentClosedWeek, unchanged', () => {
  const candidates = nominateMechanisms(mechanismInputs(
    mechanismScope('lead_created_to_first_engagement'),
    {
      currentClosedWeek: { lead_created_to_first_engagement: observedCell },
      trailing90Days: {},
    },
  ));
  assert.equal(candidates.length, 1);
});

test('H3 — a scope naming a window this run never built is REFUSED, not silently defaulted', () => {
  assert.throws(
    () => nominateMechanisms(mechanismInputs(
      mechanismScope('lead_created_to_first_engagement', { metricWindow: 'trailing180Days' }),
      { currentClosedWeek: { lead_created_to_first_engagement: observedCell } },
    )),
    /MECHANISM_INPUT_INVALID/,
  );
});

test('H3 — a scope naming something that is not a window at all is REFUSED', () => {
  assert.throws(
    () => nominateMechanisms(mechanismInputs(
      mechanismScope('lead_created_to_first_engagement', { metricWindow: 'lastQuarter' }),
      { currentClosedWeek: { lead_created_to_first_engagement: observedCell } },
    )),
    /MECHANISM_INPUT_INVALID/,
  );
});

// ===========================================================================
// M4 — the tautology gate compares MEANING, not bytes
// ===========================================================================

/** The shipped client contract with the revenue edge demoted to a plain RATE. */
function forgedRateContracts() {
  const contracts = structuredClone(loadMetricContracts('client'));
  delete contracts.edges.find(({ edgeId }) => edgeId === 'won_to_collected_revenue').measure;
  return contracts;
}

const revenueEventOf = (projection) => projection.sources
  .find(({ sourceId }) => sourceId === 'client_opportunities')
  .events.find(({ stage }) => stage === 'collected_revenue');

test('M4 bypass 1 — field_in([won]) and field_equals(won) are the SAME predicate', () => {
  const projection = structuredClone(loadProjection('client'));
  const won = projection.sources
    .find(({ sourceId }) => sourceId === 'client_opportunities')
    .events.find(({ stage }) => stage === 'won');
  won.when = { kind: 'field_in', field: 'status', values: ['won'] };
  assert.throws(
    () => assertMetricStageCoverage(CLIENT_PROFILE, projection, forgedRateContracts()),
    /PROJECTION_EDGE_TAUTOLOGICAL:won_to_collected_revenue/,
  );
});

test('M4 bypass 2 — a padded eventTimeField does not make two readings different', () => {
  const projection = structuredClone(loadProjection('client'));
  revenueEventOf(projection).eventTimeField = [
    'lastStatusChangeAt',
    'updatedAt',
    'dateUpdated',
    'closedAt',
  ];
  assert.throws(
    () => assertMetricStageCoverage(CLIENT_PROFILE, projection, forgedRateContracts()),
    /PROJECTION_EDGE_TAUTOLOGICAL:won_to_collected_revenue/,
  );
});

test('M4 bypass 3 — the same records split across two sources are still one record', () => {
  const projection = structuredClone(loadProjection('client'));
  const opportunities = projection.sources
    .find(({ sourceId }) => sourceId === 'client_opportunities');
  const revenue = revenueEventOf(projection);
  opportunities.events = opportunities.events.filter(({ stage }) => stage !== 'collected_revenue');
  projection.sources.push({
    sourceId: 'client_opportunities_revenue',
    capability: 'opportunities',
    evidenceSource: 'public_ghl',
    operationIdPattern: 'opportunities-v3__search-opportunity',
    identity: structuredClone(opportunities.identity),
    events: [revenue],
  });
  assert.throws(
    () => assertMetricStageCoverage(CLIENT_PROFILE, projection, forgedRateContracts()),
    /PROJECTION_EDGE_TAUTOLOGICAL:won_to_collected_revenue/,
  );
});

test('M4 — a genuinely different predicate is still NOT a tautology', () => {
  // `opportunity_outcome` matches won/lost/abandoned and `won` matches only won, off the same
  // field and the same time reading. That is a real transition and must stay mappable.
  assert.doesNotThrow(
    () => assertMetricStageCoverage(
      CLIENT_PROFILE,
      loadProjection('client'),
      loadMetricContracts('client'),
    ),
  );
});

// ===========================================================================
// L5 — the money reaches the human report
// ===========================================================================

const REPORT_H = 'a'.repeat(64);
const REPORT_H2 = 'b'.repeat(64);
const REPORT_E1 = 'ev_1111111111111111';
const REPORT_E2 = 'ev_2222222222222222';

function deepFreeze(value) {
  for (const child of Object.values(value ?? {})) {
    if (child && typeof child === 'object' && !Object.isFrozen(child)) deepFreeze(child);
  }
  return Object.freeze(value);
}

const REPORT_SAMPLE_BODY = {
  schemaVersion: '1.0.0',
  seed: 'seed_1111111111111111',
  mode: 'CENSUS',
  universeCount: 0,
  requestedMaxSample: 50,
  actualSampleCount: 0,
  mandatoryCount: 0,
  mandatoryOverflowCount: 0,
  selections: [],
  populationPrevalence: 'CENSUS_ONLY',
  prevalenceScope: {
    kind: 'CENSUS',
    weightingRequiredForPopulationEstimate: false,
    uncertaintyRequiredForPopulationEstimate: false,
  },
};

function reportFor(metricsByWindow, operatingProfile = 'client') {
  const publication = {
    run: deepFreeze({
      schemaVersion: '1.0.0',
      runId: 'run-2026-W30',
      publicationId: 'pub-2026-W30',
      week: '2026-W30',
      target: { operatingProfile, locationId: 'L1' },
      status: 'complete_full',
      cutoff: '2026-07-20T00:00:00Z',
    }),
    systemOverview: deepFreeze({ summary: 'Lead capture enters a nurture workflow.' }),
    coverage: deepFreeze({ state: 'complete_full', limitations: [], comparableSubsets: [] }),
    freshness: deepFreeze({ cutoff: '2026-07-20T00:00:00Z', staleCapabilities: [] }),
    diff: deepFreeze({ changes: [] }),
    graph: deepFreeze({
      nodes: [], edges: [], conflicts: [], unresolvedJoins: [],
    }),
    metricContracts: deepFreeze({ profileId: 'client', version: '1.0.0', edges: [] }),
    windows: deepFreeze({
      cutoff: '2026-07-20T00:00:00Z',
      matureAsOf: '2026-07-13T00:00:00Z',
      currentClosedWeek: { start: '2026-07-06T00:00:00Z', end: '2026-07-13T00:00:00Z' },
      previousClosedWeek: { start: '2026-06-29T00:00:00Z', end: '2026-07-06T00:00:00Z' },
      trailing28Days: { start: '2026-06-15T00:00:00Z', end: '2026-07-13T00:00:00Z' },
    }),
    metrics: deepFreeze({
      metrics: metricsByWindow,
      cohorts: { currentClosedWeek: {}, previousClosedWeek: {}, trailing28Days: {} },
      currentStock: {},
    }),
    sample: deepFreeze({
      ...REPORT_SAMPLE_BODY,
      sampleHash: sha256(REPORT_SAMPLE_BODY),
      verification: {
        interactions: [],
        universeHash: sha256([]),
        censusThreshold: 50,
        maxSample: 50,
      },
    }),
    findings: deepFreeze({ criticalIssues: [], promoted: [], backlog: [] }),
    mechanismReview: deepFreeze({
      coverage: {
        state: 'complete_full',
        comparableSubsets: [],
        capabilityStates: [],
        limits: [],
        edgeScopes: [],
      },
      maxCandidates: 5,
      maxPromoted: 3,
      packetBindings: [],
      reviewEnvelopes: [],
    }),
    conversationReview: deepFreeze({ availability: 'NOT_REVIEWABLE', judgments: [] }),
    evidenceManifest: deepFreeze([
      {
        evidenceRef: REPORT_E1,
        classification: 'OBSERVED',
        provenance: { source: 'public_ghl', completeness: 'COMPLETE' },
        sanitizedPayloadHash: REPORT_H,
      },
      {
        evidenceRef: REPORT_E2,
        classification: 'OBSERVED',
        provenance: { source: 'internal_ghl', completeness: 'COMPLETE' },
        sanitizedPayloadHash: REPORT_H2,
      },
    ]),
    solutionPacks: deepFreeze([]),
    memoryProjection: deepFreeze({ json: { entries: [] }, markdown: '# Backlog\n' }),
  };
  return compilePublicationArtifacts(publication).payloadArtifacts['REPORT.md'];
}

const clientReport = (currentWeekMetrics) => reportFor({
  currentClosedWeek: currentWeekMetrics,
  previousClosedWeek: {},
  trailing28Days: {},
});

const rateCell = ({ numerator, denominator, eligible }) => ({
  state: 'OBSERVED',
  numerator,
  denominator,
  rate: numerator / denominator,
  eligible,
  excluded: 0,
  immature: 0,
  exclusions: {},
  threshold: 1,
  rankEligible: true,
  window: { start: '2026-07-06T00:00:00Z', end: '2026-07-13T00:00:00Z' },
  coverage: 'COMPLETE',
  coverageRatio: 1,
  maturityRatio: 1,
  coverageFloor: 0.8,
  reasonCode: null,
});

const valueCell = (overrides = {}) => ({
  state: 'UNKNOWN',
  numerator: null,
  denominator: null,
  rate: null,
  value: 10450,
  valueSubjects: 3,
  eligible: 3,
  excluded: 0,
  immature: 0,
  exclusions: {},
  threshold: 1,
  rankEligible: false,
  window: { start: '2026-07-06T00:00:00Z', end: '2026-07-13T00:00:00Z' },
  coverage: 'COMPLETE',
  coverageRatio: 1,
  maturityRatio: 1,
  coverageFloor: 0.8,
  reasonCode: 'RATE_NOT_DERIVABLE',
  ...overrides,
});

test('L5 — the account money is PRINTED, not computed and then thrown away', () => {
  const report = clientReport({ won_to_collected_revenue: valueCell() });
  assert.match(report, /won_to_collected_revenue/u);
  assert.match(report, /10450/u, 'the amount must appear in the human report');
  assert.match(report, /3 of 3/u, 'the population behind the amount must appear beside it');
});

test('L5 — a run with no value measure says so rather than printing a stray number', () => {
  const report = clientReport({});
  assert.match(report, /no value measure/u);
});

/**
 * The SECOND hardcoded `currentClosedWeek`, on the grom scorecard. A ladder edge reports only in
 * its own window, so reading the closed week alone did not print it as unknown — it dropped the KPI
 * off the scorecard entirely, which is the whole consultation-to-outcome measurement.
 */
test('H3 — the grom scorecard prints a ladder KPI, labelled with the window it came from', () => {
  const report = reportFor(
    {
      currentClosedWeek: {
        enquiry_to_contacted: rateCell({ numerator: 4, denominator: 9, eligible: 9 }),
      },
      trailing90Days: {
        showed_to_decision_60d: rateCell({ numerator: 2, denominator: 7, eligible: 7 }),
      },
    },
    'grom_internal',
  );
  assert.match(report, /enquiry_to_contacted: 4\/9/u, 'a closed-week KPI keeps its unlabelled form');
  assert.match(
    report,
    /showed_to_decision_60d \[trailing90Days\]: 2\/7/u,
    'a ladder KPI must reach the scorecard, and must say which window it is from',
  );
});

test('H3 — the grom scorecard prints the MONEY, not `unknown/unknown`', () => {
  const report = reportFor(
    { currentClosedWeek: {}, trailing90Days: { won_to_collected_revenue: valueCell() } },
    'grom_internal',
  );
  assert.match(report, /won_to_collected_revenue \[trailing90Days\]: 10450 over 3 of 3 subjects/u);
  assert.doesNotMatch(report, /won_to_collected_revenue[^\n]*unknown\/unknown/u);
});

test('L5 — a VALUE cell whose subjects were ALL excluded says ALL_SUBJECTS_EXCLUDED', () => {
  // A string `monetaryValue` is not a usable amount, so the revenue event is emitted UNKNOWN and
  // the subject is genuinely untrustworthy. One win, one excluded subject, nothing left to measure.
  const { metrics } = measure({
    contacts: [contact(1)],
    opportunities: [{
      id: 'op-string',
      contactId: 'c001',
      status: 'won',
      monetaryValue: '2400',
      lastStatusChangeAt: '2026-05-20T09:00:00.000Z',
    }],
  });
  const cell = metrics.trailing90Days.won_to_collected_revenue;
  assert.equal(cell.eligible, 1);
  assert.equal(cell.excluded, 1);
  assert.equal(cell.value, null);
  assert.equal(cell.reasonCode, 'ALL_SUBJECTS_EXCLUDED');
});
