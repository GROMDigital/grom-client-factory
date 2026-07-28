/**
 * TASK A2 - `nativeMapping` flipped to MAPPED, and the evidence that it produces a real number.
 *
 * Three things are proved here, in order:
 *
 * 1. THE FLIP. Exactly the edges the shipped projection can emit BOTH stages for are MAPPED, and
 *    exactly the edges declared `unmeasurableEdges[]` are left UNKNOWN. Both sets are hand-listed
 *    below, not derived from the files under test, so a projection that quietly stops emitting a
 *    stage cannot quietly re-grade an edge.
 *
 * 2. THE GATE. `validateProjectionForProfile` refuses to let a declared-unmeasurable edge be
 *    flipped, and TOLERATES a measurable edge left UNKNOWN. The asymmetry is deliberate and is
 *    stated at the test that asserts it.
 *
 * 3. THE HEADLINE. The FULL real chain -
 *      projectJourneyEvents -> normalizeEvidence -> buildEvidenceGraph -> buildWindows
 *      -> computeJourneyMetrics
 *    over a realistic multi-subject GHL fixture of raw payloads carrying the REAL allowlist action
 *    ids, using the SHIPPED profiles, with nothing forced and nothing cloned. The expected table is
 *    HAND-STATED from the fixture; every count below can be recomputed by reading the fixture.
 *
 * The fixture deliberately contains the two real-world conditions that used to blank every metric
 * on every account: a DUPLICATE EMAIL shared by two contacts, and a STRING `monetaryValue` on a won
 * opportunity. Both now cost exactly the subjects they touch, and both are visible in `exclusions`.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { buildEvidenceGraph } from '../lib/evidence-graph.mjs';
import { projectJourneyEvents } from '../lib/journey-projection.mjs';
import { DEFAULT_COVERAGE_FLOOR, buildWindows, computeJourneyMetrics } from '../lib/metrics.mjs';
import { normalizeEvidence } from '../lib/normalize.mjs';
import {
  loadMetricContracts,
  loadProjection,
  validateProjectionForProfile,
} from '../schemas/v1.mjs';

const profilesUrl = new URL('../profiles/', import.meta.url);
const readProfile = (name) => JSON.parse(readFileSync(new URL(name, profilesUrl), 'utf8'));

const CLIENT_PROFILE = readProfile('client.v1.json');
const GROM_PROFILE = readProfile('grom-internal.v1.json');

// ===========================================================================
// 1. THE FLIP
// ===========================================================================

/**
 * HAND-LISTED, from reading `profiles/*-projection.v1.json` and asking of each metric edge: does
 * some source declare an event at its `fromStage` AND some source declare an event at its
 * `toStage`? Nothing here is read back from the metric contracts.
 *
 * client emitted stages: lead_created, first_engagement, booked, showed, no_show, cancelled,
 * opportunity_outcome, won, collected_revenue.
 * grom_internal emitted stages: enquiry, contacted, strategy_call, showed, decision, won,
 * collected_revenue.
 */
const EXPECTED_MAPPED = Object.freeze({
  client: Object.freeze([
    'booked_to_cancelled',
    'booked_to_no_show',
    'booked_to_showed',
    'lead_created_to_first_engagement',
    // THE MATURITY LADDER. One measurement, three maturities, three edge ids, because `edgeId` is
    // the result key under `metrics.metrics[window]`. The unsuffixed id is the 90-day/settled one.
    'showed_to_opportunity_outcome',
    'showed_to_opportunity_outcome_30d',
    'showed_to_opportunity_outcome_60d',
    'won_to_collected_revenue',
  ]),
  grom_internal: Object.freeze([
    'enquiry_to_contacted',
    'showed_to_decision',
    'showed_to_decision_30d',
    'showed_to_decision_60d',
    'strategy_call_to_showed',
    'won_to_collected_revenue',
  ]),
});

/**
 * The edges that stay UNKNOWN. None of these can be derived from public GHL data: GHL has no
 * public notion of "qualified", no public link from a cancelled appointment to the appointment that
 * replaced it, no "closed" or "reactivated" stage, and the whole `client_onboarding` journey lives
 * in the portal and the delivery process rather than in the CRM. Inventing a mapping for any of
 * them would produce a confident wrong number, which is strictly worse than UNKNOWN.
 */
const EXPECTED_UNKNOWN = Object.freeze({
  client: Object.freeze([
    'cancelled_to_rebooked',
    'closed_to_reactivated',
    'first_engagement_to_qualified',
    'qualified_to_booked',
  ]),
  grom_internal: Object.freeze([
    'activation_to_assets_requested',
    'assets_complete_to_strategy_approved',
    'assets_requested_to_assets_complete',
    'build_to_qa',
    'client_approval_to_launch',
    'contacted_to_qualified',
    'handoff_to_activation',
    'launch_to_first_value',
    'qa_to_client_approval',
    'qualified_to_strategy_call',
    'strategy_approved_to_build',
    'won_to_internal_handoff',
  ]),
});

const sorted = (values) => [...values].sort();

test('A2 - exactly the projection-provable edges are MAPPED in both shipped profiles', () => {
  for (const profileId of ['client', 'grom_internal']) {
    const contracts = loadMetricContracts(profileId);
    const mapped = contracts.edges
      .filter(({ nativeMapping }) => nativeMapping === 'MAPPED')
      .map(({ edgeId }) => edgeId);
    const unknown = contracts.edges
      .filter(({ nativeMapping }) => nativeMapping === 'UNKNOWN')
      .map(({ edgeId }) => edgeId);
    assert.deepEqual(sorted(mapped), [...EXPECTED_MAPPED[profileId]], `${profileId} MAPPED set`);
    assert.deepEqual(sorted(unknown), [...EXPECTED_UNKNOWN[profileId]], `${profileId} UNKNOWN set`);
    assert.equal(
      mapped.length + unknown.length,
      contracts.edges.length,
      `${profileId} has an edge that is neither MAPPED nor UNKNOWN`,
    );
  }
  // 8 of 12 for client, 6 of 18 for Grom. Stated as literals so a silent drift is a test failure
  // rather than a quiet re-grade. The maturity ladder added two MAPPED edges to each profile and
  // took nothing away: it declares the SAME measurement twice more, at a shorter lag over a
  // shorter lookback, so the unmeasurable set is untouched.
  assert.equal(EXPECTED_MAPPED.client.length, 8);
  assert.equal(EXPECTED_UNKNOWN.client.length, 4);
  assert.equal(EXPECTED_MAPPED.grom_internal.length, 6);
  assert.equal(EXPECTED_UNKNOWN.grom_internal.length, 12);
});

test('A2 - the UNKNOWN set is exactly the projection unmeasurableEdges declaration', () => {
  for (const profileId of ['client', 'grom_internal']) {
    const projection = loadProjection(profileId);
    assert.deepEqual(
      sorted(projection.unmeasurableEdges),
      [...EXPECTED_UNKNOWN[profileId]],
      `${profileId} unmeasurableEdges must match the edges left UNKNOWN`,
    );
  }
});

test('A2 - the shipped profile, projection and contracts validate together as shipped', () => {
  for (const [profileId, profile] of [['client', CLIENT_PROFILE], ['grom_internal', GROM_PROFILE]]) {
    assert.doesNotThrow(() => validateProjectionForProfile(
      profile,
      loadProjection(profileId),
      loadMetricContracts(profileId),
    ), `${profileId} must validate as shipped`);
  }
});

// ===========================================================================
// 2. THE GATE
// ===========================================================================

test('A2 - flipping a declared-unmeasurable edge to MAPPED is REFUSED, edge by edge', () => {
  for (const [profileId, profile] of [['client', CLIENT_PROFILE], ['grom_internal', GROM_PROFILE]]) {
    const projection = loadProjection(profileId);
    for (const edgeId of EXPECTED_UNKNOWN[profileId]) {
      const forged = structuredClone(loadMetricContracts(profileId));
      const edge = forged.edges.find((candidate) => candidate.edgeId === edgeId);
      assert.ok(edge, `${profileId}/${edgeId} must exist in the shipped contracts`);
      edge.nativeMapping = 'MAPPED';
      assert.throws(
        () => validateProjectionForProfile(profile, projection, forged),
        new RegExp(`PROJECTION_UNMEASURABLE_EDGE_MAPPED:${edgeId}$`),
        `${profileId}/${edgeId} must not be flippable`,
      );
    }
  }
});

/**
 * THE ASYMMETRY, STATED.
 *
 * The validator refuses MAPPED-on-unmeasurable but TOLERATES UNKNOWN-on-measurable, and that is
 * correct rather than an oversight. `nativeMapping` is a CLAIM that the projector proves this edge.
 * Refusing to make the claim costs coverage — the edge reads UNKNOWN and the report says so — and
 * cannot produce a wrong number. Making the claim falsely produces a confident zero over a real
 * denominator, which nothing downstream can detect. Only the direction that can lie is forbidden.
 *
 * The practical consequence, asserted below: the pre-A2 state of these files (every edge UNKNOWN)
 * is still a VALID configuration. That is what makes A2 a deliberate, reversible act rather than
 * something the schema forced.
 */
test('A2 - a measurable edge left UNKNOWN is TOLERATED, and only under-claims', () => {
  const projection = loadProjection('client');
  const preA2 = structuredClone(loadMetricContracts('client'));
  for (const edge of preA2.edges) edge.nativeMapping = 'UNKNOWN';
  assert.doesNotThrow(
    () => validateProjectionForProfile(CLIENT_PROFILE, projection, preA2),
    'leaving a measurable edge UNKNOWN must remain a valid configuration',
  );

  // On the very data that measures 7 of 10 below, the unflipped contract reports nothing at all -
  // it cannot report a wrong number, only no number.
  const { metrics } = computeJourneyMetrics({
    graph: clientGraph(),
    metricContracts: preA2,
    windows: WINDOWS,
  });
  const unflipped = metrics.previousClosedWeek.lead_created_to_first_engagement;
  assert.equal(unflipped.state, 'UNKNOWN');
  assert.equal(unflipped.numerator, null);
  assert.equal(unflipped.denominator, null);
  assert.equal(unflipped.eligible, null);
  assert.equal(unflipped.reasonCode, 'MISSING_REQUIRED_EVIDENCE');
});

// ===========================================================================
// 3. THE COVERAGE FLOOR, DECLARED DELIBERATELY
// ===========================================================================

/**
 * DECISION: profile-wide `coverageFloor`, no per-edge `minimumCoverage`.
 *
 * Why profile-wide. In both shipped projections every stage of every MAPPED edge is resolved
 * through the SAME contact identity graph, so the thing that costs coverage - a duplicate email or
 * phone, an unresolved join, an unproven join - is a property of the ACCOUNT's data hygiene and not
 * of the individual edge. A per-edge floor would encode a distinction the shipped projections do
 * not have, across 26 numbers that must then be kept consistent by hand.
 *
 * Why not a stricter floor on the revenue edge, which is the obvious candidate. `metrics.mjs`
 * already guards revenue with a rule strictly stronger and better targeted than any floor: if ANY
 * matched conversion carries an unusable amount the whole edge returns UNKNOWN with
 * `INVALID_REVENUE_EVIDENCE`. Stacking a higher coverage floor on top would suppress revenue
 * reporting without adding any correctness the existing guard does not already provide.
 *
 * Why declare 0.8 explicitly when that is already `DEFAULT_COVERAGE_FLOOR`. Because otherwise the
 * operative floor for every shipped account is decided in `lib/metrics.mjs`, and a future change to
 * that constant would silently re-grade every account's history. Declaring it in the profile pins
 * the value the shipped edges were validated at, and makes the number visible where the rest of the
 * account's semantics live.
 */
test('A2 - both shipped profiles declare the coverage floor as profile data', () => {
  for (const profileId of ['client', 'grom_internal']) {
    const contracts = loadMetricContracts(profileId);
    assert.equal(contracts.coverageFloor, 0.8, `${profileId} must declare a profile coverage floor`);
    for (const edge of contracts.edges) {
      assert.equal(
        Object.hasOwn(edge.eligibilityRule, 'minimumCoverage'),
        false,
        `${profileId}/${edge.edgeId} must not override the profile floor`,
      );
    }
  }
  // The declared value happens to equal the code fallback today. That is the point of declaring
  // it: the two are now free to diverge without silently re-grading a shipped account.
  assert.equal(DEFAULT_COVERAGE_FLOOR, 0.8);
});

test('A2 - the declared floor governs, and is not decoration', () => {
  const strict = structuredClone(loadMetricContracts('client'));
  strict.coverageFloor = 0.95;
  const { metrics } = computeJourneyMetrics({
    graph: clientGraph(),
    metricContracts: strict,
    windows: WINDOWS,
  });
  // Hand-stated: this cell measures 10 of 12 eligible, a coverage of 0.8333..., which clears a
  // floor of 0.8 and does not clear 0.95.
  const raised = metrics.previousClosedWeek.lead_created_to_first_engagement;
  assert.equal(raised.state, 'UNKNOWN');
  assert.equal(raised.reasonCode, 'COVERAGE_BELOW_FLOOR');
  assert.equal(raised.eligible, 12);
  assert.equal(raised.excluded, 2);
  assert.equal(raised.coverageFloor, 0.95);

  const shipped = computeJourneyMetrics({
    graph: clientGraph(),
    metricContracts: loadMetricContracts('client'),
    windows: WINDOWS,
  }).metrics.previousClosedWeek.lead_created_to_first_engagement;
  assert.equal(shipped.state, 'OBSERVED');
  assert.equal(shipped.coverageFloor, 0.8);
});

// ===========================================================================
// 4. THE FIXTURE - raw GHL payloads under the REAL allowlist action ids
// ===========================================================================

const CONTEXT = Object.freeze({ locationId: 'LOC-A2-EVIDENCE' });
const GROM_CONTEXT = Object.freeze({ locationId: 'LOC-A2-EVIDENCE-GROM' });

/** Wide enough to carry every fixture event; nothing here is suppressed as out-of-window. */
const APPLIED_WINDOW = Object.freeze({
  from: '2026-04-01T00:00:00.000Z',
  to: '2026-07-27T00:00:00.000Z',
});
const CAPTURED_AT = '2026-07-27T00:00:00.000Z';

/** The REAL allowlist action ids the public rail emits as `operationId`. */
const CONTACTS_ACTION = 'contacts.search';
const CONVERSATIONS_ACTION = 'conversations-v3__search-conversation';
const APPOINTMENTS_ACTION = 'calendars-v3__get-calendar-events';
const OPPORTUNITIES_ACTION = 'opportunities.list';

/**
 * HAND-STATED WINDOW ARITHMETIC. 2026-07-27 is a Monday, so with `timezone: 'UTC'`:
 *   currentClosedWeek  [2026-07-20, 2026-07-27)
 *   previousClosedWeek [2026-07-13, 2026-07-20)
 *   trailing28Days     [2026-06-29, 2026-07-27)
 *   trailing90Days     [2026-04-28, 2026-07-27)
 *   matureAsOf          2026-07-26 (maturityDays: 1)
 * `timezone` is passed explicitly, so every boundary above is fixed in UTC and the process TZ
 * cannot move it.
 */
const CUTOFF = '2026-07-27T00:00:00.000Z';
const WINDOWS = buildWindows({ cutoff: CUTOFF, timezone: 'UTC', maturityDays: 1 });

function envelope(operationId, items, boundLocationId = CONTEXT.locationId) {
  return {
    source: 'public_ghl',
    operationId,
    boundLocationId,
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

/*
 * FIVE COHORTS, each placed so that a particular window can actually mature it.
 *
 * A  12 leads in previousClosedWeek. Two of them, c11 and c12, share one email address.
 * E   5 leads in currentClosedWeek.
 * B   6 leads + 6 appointments in the first week of July, the only placement from which a
 *     14-day-lag appointment edge can mature by the cutoff (entrant + 14d <= 2026-07-27).
 * C   5 leads + 5 won opportunities in May, which matures the 60-day revenue edge on
 *     trailing90Days. One of them, op34, carries `monetaryValue` as a STRING.
 * D   2 appointments that showed at exactly 2026-04-28T00:00:00Z. See the note on
 *     `showed_to_opportunity_outcome` below for why that instant and no other.
 */
const CONTACTS = Object.freeze([
  // Cohort A - previousClosedWeek [2026-07-13, 2026-07-20)
  { id: 'c01', email: 'a01@example.test', phone: '+44 20 7946 0001', dateAdded: '2026-07-13T08:00:00.000Z' },
  { id: 'c02', email: 'a02@example.test', phone: '+44 20 7946 0002', dateAdded: '2026-07-13T09:00:00.000Z' },
  { id: 'c03', email: 'a03@example.test', phone: '+44 20 7946 0003', dateAdded: '2026-07-13T10:00:00.000Z' },
  { id: 'c04', email: 'a04@example.test', phone: '+44 20 7946 0004', dateAdded: '2026-07-14T08:00:00.000Z' },
  { id: 'c05', email: 'a05@example.test', phone: '+44 20 7946 0005', dateAdded: '2026-07-14T09:00:00.000Z' },
  { id: 'c06', email: 'a06@example.test', phone: '+44 20 7946 0006', dateAdded: '2026-07-15T08:00:00.000Z' },
  { id: 'c07', email: 'a07@example.test', phone: '+44 20 7946 0007', dateAdded: '2026-07-15T09:00:00.000Z' },
  { id: 'c08', email: 'a08@example.test', phone: '+44 20 7946 0008', dateAdded: '2026-07-16T08:00:00.000Z' },
  { id: 'c09', email: 'a09@example.test', phone: '+44 20 7946 0009', dateAdded: '2026-07-16T09:00:00.000Z' },
  { id: 'c10', email: 'a10@example.test', phone: '+44 20 7946 0010', dateAdded: '2026-07-17T08:00:00.000Z' },
  // THE DUPLICATE EMAIL. Two native ids, one address.
  { id: 'c11', email: 'dup@example.test', phone: '+44 20 7946 0011', dateAdded: '2026-07-17T09:00:00.000Z' },
  { id: 'c12', email: 'dup@example.test', phone: '+44 20 7946 0012', dateAdded: '2026-07-17T10:00:00.000Z' },
  // Cohort E - currentClosedWeek [2026-07-20, 2026-07-27)
  { id: 'c50', email: 'f50@example.test', phone: '+44 20 7946 0050', dateAdded: '2026-07-20T08:00:00.000Z' },
  { id: 'c51', email: 'f51@example.test', phone: '+44 20 7946 0051', dateAdded: '2026-07-20T09:00:00.000Z' },
  { id: 'c52', email: 'f52@example.test', phone: '+44 20 7946 0052', dateAdded: '2026-07-21T08:00:00.000Z' },
  { id: 'c53', email: 'f53@example.test', phone: '+44 20 7946 0053', dateAdded: '2026-07-21T09:00:00.000Z' },
  { id: 'c54', email: 'f54@example.test', phone: '+44 20 7946 0054', dateAdded: '2026-07-22T08:00:00.000Z' },
  // Cohort B - early July
  { id: 'c20', email: 'b20@example.test', phone: '+44 20 7946 0020', dateAdded: '2026-07-01T08:00:00.000Z' },
  { id: 'c21', email: 'b21@example.test', phone: '+44 20 7946 0021', dateAdded: '2026-07-01T09:00:00.000Z' },
  { id: 'c22', email: 'b22@example.test', phone: '+44 20 7946 0022', dateAdded: '2026-07-02T08:00:00.000Z' },
  { id: 'c23', email: 'b23@example.test', phone: '+44 20 7946 0023', dateAdded: '2026-07-02T09:00:00.000Z' },
  { id: 'c24', email: 'b24@example.test', phone: '+44 20 7946 0024', dateAdded: '2026-07-03T08:00:00.000Z' },
  { id: 'c25', email: 'b25@example.test', phone: '+44 20 7946 0025', dateAdded: '2026-07-03T09:00:00.000Z' },
  // Cohort C - May
  { id: 'c30', email: 'd30@example.test', phone: '+44 20 7946 0030', dateAdded: '2026-05-18T08:00:00.000Z' },
  { id: 'c31', email: 'd31@example.test', phone: '+44 20 7946 0031', dateAdded: '2026-05-18T09:00:00.000Z' },
  { id: 'c32', email: 'd32@example.test', phone: '+44 20 7946 0032', dateAdded: '2026-05-18T10:00:00.000Z' },
  { id: 'c33', email: 'd33@example.test', phone: '+44 20 7946 0033', dateAdded: '2026-05-18T11:00:00.000Z' },
  { id: 'c34', email: 'd34@example.test', phone: '+44 20 7946 0034', dateAdded: '2026-05-18T12:00:00.000Z' },
  // Cohort D - April, before the trailing90Days window opens
  { id: 'c40', email: 'e40@example.test', phone: '+44 20 7946 0040', dateAdded: '2026-04-20T08:00:00.000Z' },
  { id: 'c41', email: 'e41@example.test', phone: '+44 20 7946 0041', dateAdded: '2026-04-20T09:00:00.000Z' },
]);

const CONVERSATIONS = Object.freeze([
  // Cohort A: c01-c07 engaged inside the 2-day lag, c08 three days late, c09/c10 never.
  { id: 'v01', contactId: 'c01', dateAdded: '2026-07-13T12:00:00.000Z' },
  { id: 'v02', contactId: 'c02', dateAdded: '2026-07-13T13:00:00.000Z' },
  { id: 'v03', contactId: 'c03', dateAdded: '2026-07-14T10:00:00.000Z' },
  { id: 'v04', contactId: 'c04', dateAdded: '2026-07-15T08:00:00.000Z' },
  { id: 'v05', contactId: 'c05', dateAdded: '2026-07-15T09:00:00.000Z' },
  { id: 'v06', contactId: 'c06', dateAdded: '2026-07-16T08:00:00.000Z' },
  { id: 'v07', contactId: 'c07', dateAdded: '2026-07-16T09:00:00.000Z' },
  { id: 'v08', contactId: 'c08', dateAdded: '2026-07-19T08:00:00.000Z' },
  { id: 'v11', contactId: 'c11', dateAdded: '2026-07-17T12:00:00.000Z' },
  { id: 'v12', contactId: 'c12', dateAdded: '2026-07-17T13:00:00.000Z' },
  // Cohort E: c50-c52 engaged, c53/c54 never.
  { id: 'v50', contactId: 'c50', dateAdded: '2026-07-20T12:00:00.000Z' },
  { id: 'v51', contactId: 'c51', dateAdded: '2026-07-21T09:00:00.000Z' },
  { id: 'v52', contactId: 'c52', dateAdded: '2026-07-22T08:00:00.000Z' },
  // Cohort B: all six engaged inside the lag.
  { id: 'v20', contactId: 'c20', dateAdded: '2026-07-01T12:00:00.000Z' },
  { id: 'v21', contactId: 'c21', dateAdded: '2026-07-01T13:00:00.000Z' },
  { id: 'v22', contactId: 'c22', dateAdded: '2026-07-02T12:00:00.000Z' },
  { id: 'v23', contactId: 'c23', dateAdded: '2026-07-02T13:00:00.000Z' },
  { id: 'v24', contactId: 'c24', dateAdded: '2026-07-03T12:00:00.000Z' },
  { id: 'v25', contactId: 'c25', dateAdded: '2026-07-03T13:00:00.000Z' },
  // Cohorts C and D were never contacted through the CRM.
]);

const APPOINTMENTS = Object.freeze([
  // Cohort B: booked 2026-07-02..04, so entrant + 14 days lands on or before the cutoff.
  { id: 'ap20', contactId: 'c20', appointmentStatus: 'showed', dateAdded: '2026-07-02T09:00:00.000Z', startTime: '2026-07-06T09:00:00.000Z' },
  { id: 'ap21', contactId: 'c21', appointmentStatus: 'showed', dateAdded: '2026-07-02T10:00:00.000Z', startTime: '2026-07-07T10:00:00.000Z' },
  { id: 'ap22', contactId: 'c22', appointmentStatus: 'noshow', dateAdded: '2026-07-03T09:00:00.000Z', startTime: '2026-07-08T09:00:00.000Z' },
  { id: 'ap23', contactId: 'c23', appointmentStatus: 'cancelled', dateAdded: '2026-07-03T10:00:00.000Z', startTime: '2026-07-09T10:00:00.000Z' },
  { id: 'ap24', contactId: 'c24', appointmentStatus: 'confirmed', dateAdded: '2026-07-04T09:00:00.000Z', startTime: '2026-07-10T09:00:00.000Z' },
  { id: 'ap25', contactId: 'c25', appointmentStatus: 'showed', dateAdded: '2026-07-04T10:00:00.000Z', startTime: '2026-07-11T10:00:00.000Z' },
  // Cohort A: booked inside previousClosedWeek, which no 14-day-lag edge can mature by the cutoff.
  { id: 'ap01', contactId: 'c01', appointmentStatus: 'showed', dateAdded: '2026-07-14T09:00:00.000Z', startTime: '2026-07-16T09:00:00.000Z' },
  { id: 'ap11', contactId: 'c11', appointmentStatus: 'showed', dateAdded: '2026-07-18T09:00:00.000Z', startTime: '2026-07-19T09:00:00.000Z' },
  // Cohort D: showed at exactly the trailing90Days window start.
  { id: 'ap40', contactId: 'c40', appointmentStatus: 'showed', dateAdded: '2026-04-24T09:00:00.000Z', startTime: '2026-04-28T00:00:00.000Z' },
  { id: 'ap41', contactId: 'c41', appointmentStatus: 'showed', dateAdded: '2026-04-24T10:00:00.000Z', startTime: '2026-04-28T00:00:00.000Z' },
]);

const OPPORTUNITIES = Object.freeze([
  // Cohort C: won in May, which the 60-day revenue edge matures on trailing90Days.
  { id: 'op30', contactId: 'c30', status: 'won', monetaryValue: 2400, lastStatusChangeAt: '2026-05-20T09:00:00.000Z' },
  { id: 'op31', contactId: 'c31', status: 'won', monetaryValue: 1800, lastStatusChangeAt: '2026-05-20T10:00:00.000Z' },
  { id: 'op32', contactId: 'c32', status: 'won', monetaryValue: 3200, lastStatusChangeAt: '2026-05-21T09:00:00.000Z' },
  { id: 'op33', contactId: 'c33', status: 'won', monetaryValue: 1500, lastStatusChangeAt: '2026-05-21T10:00:00.000Z' },
  // THE STRING monetaryValue. GHL returns this shape in the wild.
  { id: 'op34', contactId: 'c34', status: 'won', monetaryValue: '2750', lastStatusChangeAt: '2026-05-22T09:00:00.000Z' },
  // Cohort D outcomes, both inside 90 days of the 2026-04-28 showed.
  { id: 'op40', contactId: 'c40', status: 'won', monetaryValue: 4100, lastStatusChangeAt: '2026-05-12T09:00:00.000Z' },
  { id: 'op41', contactId: 'c41', status: 'lost', monetaryValue: 0, lastStatusChangeAt: '2026-05-13T09:00:00.000Z' },
]);

function collectionsFor(locationId) {
  return [
    envelope(CONTACTS_ACTION, [...CONTACTS], locationId),
    envelope(CONVERSATIONS_ACTION, [...CONVERSATIONS], locationId),
    envelope(APPOINTMENTS_ACTION, [...APPOINTMENTS], locationId),
    envelope(OPPORTUNITIES_ACTION, [...OPPORTUNITIES], locationId),
  ];
}

/** THE FULL REAL CHAIN. No forcing, no hand-shaped journey records, no cloned contracts. */
function graphFor(profile, projectionId, context) {
  const projected = projectJourneyEvents({
    collections: collectionsFor(context.locationId),
    context,
    profile,
    projection: loadProjection(projectionId),
  });
  const records = normalizeEvidence(projected, context);
  return buildEvidenceGraph({ records, context, profile });
}

const clientGraph = () => graphFor(CLIENT_PROFILE, 'client', CONTEXT);
const gromGraph = () => graphFor(GROM_PROFILE, 'grom_internal', GROM_CONTEXT);

/** Exactly the fields this task reports on, in a fixed shape so a deep compare is exhaustive. */
function cell(metric) {
  const shape = {
    state: metric.state,
    numerator: metric.numerator,
    denominator: metric.denominator,
    rate: metric.rate,
    eligible: metric.eligible,
    excluded: metric.excluded,
    immature: metric.immature,
    exclusions: { ...metric.exclusions },
    coverageRatio: metric.coverageRatio,
    maturityRatio: metric.maturityRatio,
    coverage: metric.coverage,
    coverageFloor: metric.coverageFloor,
    reasonCode: metric.reasonCode,
  };
  if (Object.hasOwn(metric, 'value')) shape.value = metric.value;
  if (Object.hasOwn(metric, 'valueSubjects')) shape.valueSubjects = metric.valueSubjects;
  return shape;
}

/** An edge left UNKNOWN by declaration: short-circuited before any data is read. */
const UNMAPPED = Object.freeze({
  state: 'UNKNOWN',
  numerator: null,
  denominator: null,
  rate: null,
  eligible: null,
  excluded: null,
  immature: null,
  exclusions: {},
  coverageRatio: null,
  maturityRatio: null,
  coverage: 'INCOMPLETE',
  coverageFloor: 0.8,
  reasonCode: 'MISSING_REQUIRED_EVIDENCE',
});

/** A MAPPED edge with a genuinely empty entry cohort in this window. A measured zero, not a guess. */
const EMPTY = Object.freeze({
  state: 'OBSERVED',
  numerator: 0,
  denominator: 0,
  rate: null,
  eligible: 0,
  excluded: 0,
  immature: 0,
  exclusions: {},
  coverageRatio: null,
  maturityRatio: null,
  coverage: 'COMPLETE',
  coverageFloor: 0.8,
  reasonCode: 'NO_ELIGIBLE_POPULATION',
});

/** The VALUE-measure edge with no entrants at all. No money, and still no rate. */
const EMPTY_REVENUE = Object.freeze({
  state: 'UNKNOWN',
  numerator: null,
  denominator: null,
  rate: null,
  eligible: 0,
  excluded: 0,
  immature: 0,
  exclusions: {},
  coverageRatio: null,
  maturityRatio: null,
  coverage: 'COMPLETE',
  coverageFloor: 0.8,
  reasonCode: 'NO_ELIGIBLE_POPULATION',
  value: null,
  valueSubjects: 0,
});

/**
 * A MAPPED edge whose entrants exist but whose allowed lag has not elapsed by the cutoff.
 *
 * Round 2: `immature` is now carried explicitly, and the reason is `IMMATURE_COHORT` rather than
 * `MISSING_REQUIRED_EVIDENCE` — the latter is what an UNMAPPED edge reports, so the two used to be
 * indistinguishable. `coverageRatio` is over the ANSWERABLE population (`eligible - immature`), so
 * a window in which everything is either excluded or immature reports 0 over the excluded rump, and
 * one in which everything is immature reports null.
 */
function blockedByLag({
  eligible, excluded, immature, exclusions,
}) {
  const answerable = eligible - immature;
  return {
    state: 'UNKNOWN',
    numerator: null,
    denominator: null,
    rate: null,
    eligible,
    excluded,
    immature,
    exclusions,
    coverageRatio: answerable === 0 ? null : 0,
    maturityRatio: answerable / eligible,
    coverage: 'INCOMPLETE',
    coverageFloor: 0.8,
    reasonCode: 'IMMATURE_COHORT',
  };
}

function observed({
  numerator, denominator, eligible, excluded, immature = 0, exclusions = {}, value,
}) {
  const answerable = eligible - immature;
  const shape = {
    state: 'OBSERVED',
    numerator,
    denominator,
    rate: numerator / denominator,
    eligible,
    excluded,
    immature,
    exclusions,
    coverageRatio: denominator / answerable,
    maturityRatio: answerable / eligible,
    coverage: excluded === 0 && immature === 0 ? 'COMPLETE' : 'INCOMPLETE',
    coverageFloor: 0.8,
    reasonCode: null,
  };
  if (value !== undefined) shape.value = value;
  return shape;
}

/** A rate suppressed because too little of its ANSWERABLE population could be trusted. */
function belowFloor({
  eligible, excluded, immature, exclusions,
}) {
  const answerable = eligible - immature;
  return {
    state: 'UNKNOWN',
    numerator: null,
    denominator: null,
    rate: null,
    eligible,
    excluded,
    immature,
    exclusions,
    coverageRatio: (answerable - excluded) / answerable,
    maturityRatio: answerable / eligible,
    coverage: 'INCOMPLETE',
    coverageFloor: 0.8,
    reasonCode: 'COVERAGE_BELOW_FLOOR',
  };
}

/**
 * The VALUE measure: money and the subject count behind it, and NEVER a rate. `won` and
 * `collected_revenue` come off the same record under the same predicate, so any rate would be the
 * constant 1.
 */
function valueOnly({
  value, valueSubjects, eligible, excluded, immature = 0, exclusions = {},
}) {
  const answerable = eligible - immature;
  return {
    state: 'UNKNOWN',
    numerator: null,
    denominator: null,
    rate: null,
    eligible,
    excluded,
    immature,
    exclusions,
    coverageRatio: answerable === 0 ? null : valueSubjects / answerable,
    maturityRatio: answerable / eligible,
    coverage: excluded === 0 && immature === 0 ? 'COMPLETE' : 'INCOMPLETE',
    coverageFloor: 0.8,
    reasonCode: 'RATE_NOT_DERIVABLE',
    value,
    valueSubjects,
  };
}

/*
 * ===========================================================================
 * THE HAND-COMPUTED TABLE.
 *
 * Every number below was derived by reading the fixture, not by reading the code's output.
 * The two worked examples the task asked for are spelled out in full:
 *
 * (1) previousClosedWeek / lead_created_to_first_engagement, allowedLag 2 days.
 *     ENTRANTS: the contacts whose `dateAdded` falls in [2026-07-13, 2026-07-20) - c01..c12.
 *       That is 12. Every one matures, because 2026-07-17 + 2d = 2026-07-19 <= the 2026-07-27
 *       cutoff, and every one is before matureAsOf 2026-07-26.  => eligible 12
 *     EXCLUDED: c11 and c12 share dup@example.test, so the graph raises one
 *       `duplicate_identity_claim` naming both contact entities. Each is dropped from the
 *       denominator with IDENTITY_CONFLICT.  => excluded 2, denominator 10
 *     CONVERTED: a first_engagement within 2 days of the lead. c01 (+4h), c02 (+4h), c03 (+24h),
 *       c04 (+24h), c05 (+24h), c06 (+24h), c07 (+24h) = 7. c08's conversation is 2026-07-19,
 *       three days after its 2026-07-16 lead, so it is OUTSIDE the lag. c09 and c10 never
 *       engaged. c11/c12 did engage but are already excluded.  => numerator 7
 *     RESULT: OBSERVED 7/10, eligible 12, excluded 2, coverage 10/12 = 0.8333..., which clears
 *       the declared floor of 0.8.
 *
 * (2) trailing90Days / won_to_collected_revenue, allowedLag 60 days.
 *     ENTRANTS: opportunities with status `won` whose `lastStatusChangeAt` falls in
 *       [2026-04-28, 2026-07-27) - op30, op31, op32, op33, op34 (May 20-22) and op40 (May 12).
 *       op41 is `lost`, so it emits no `won`. That is 6, all mature: 2026-05-22 + 60d =
 *       2026-07-21 <= cutoff.  => eligible 6, immature 0
 *     EXCLUDED: op34 carries `monetaryValue: '2750'`, a string. The projector refuses to read an
 *       amount it cannot trust, so it emits the collected_revenue event as UNKNOWN rather than as
 *       an amount of zero. That makes the event non-observed, which taints its subject c34.
 *       => excluded 1 with NON_OBSERVED_EVIDENCE
 *     NO RATE IS PUBLISHED. Round 2: `won` and `collected_revenue` are read off the SAME record
 *       under the SAME predicate off the SAME event-time field, so EVERY entrant converts, at its
 *       own instant, in every possible account. The rate is the constant 1 and says nothing about
 *       the account. The edge declares `measure: "VALUE"` and publishes the money instead.
 *     VALUE: 2400 + 1800 + 3200 + 1500 + 4100 = 13000 over 5 subjects. The 2750 the string hid is
 *       NOT in it, and its absence is disclosed as excluded 1 of 6 eligible.
 *     RESULT: UNKNOWN/RATE_NOT_DERIVABLE, value 13000, valueSubjects 5, coverage 5/6 = 0.8333...
 *
 * A NOTE ON THE 90-DAY EDGE, which is worth keeping in front of a reader.
 * `showed_to_opportunity_outcome` allows 90 days of lag and the longest window is exactly 90 days
 * long, so the only entrants that both fall INSIDE trailing90Days and mature by the cutoff sit on
 * the single instant at the window start. Cohort D sits on it deliberately. Round 2 makes what that
 * costs VISIBLE rather than hiding it: 7 subjects showed inside the window, only 3 of them are
 * answerable at all, and of those 3 one is the duplicate-email subject - so the trust ratio is
 * 2/3 = 0.667 and the cell is refused by the floor. Before round 2 the same cell published
 * `OBSERVED 2/2, eligible 2, coverage COMPLETE`: a 100% rate over a rump of 2, with the other 5
 * subjects of the window silently absent. The window must be meaningfully LONGER than the lag it is
 * meant to mature; that is an owner decision and A2 still does not touch the lag values.
 *
 * THE OWNER DECISION LANDED (2026-07-27): the maturity ladder. The same measurement is now declared
 * three times - 30 days of lag over a trailing 60, 60 over a trailing 90, 90 over a trailing 180 -
 * and each declares the ONE window it reports on. So `showed_to_opportunity_outcome` no longer
 * appears in the closed weeks, in `trailing28Days` or in `trailing90Days` at all; those cells were
 * an edge published over a window that could not mature it.
 *
 * THIS FIXTURE DOES NOT EXERCISE THE LADDER, and the table below says so honestly. It carries seven
 * `showed` events in exactly two clumps - two at 2026-04-28 and five in July - so the same two
 * cohort-D subjects are the only ones old enough to mature against 30, 60 or 90 days of lag, and
 * all three rungs read the same. The ladder's PAYOFF is a property of subjects spread across time,
 * and is measured over 52 simulated weekly runs in `tests/metric-maturity-ladder.test.mjs`. What
 * this fixture pins is the WIRING: which edge lands in which window, with what population.
 * ===========================================================================
 */
const EXPECTED_CLIENT = Object.freeze({
  currentClosedWeek: {
    lead_created_to_first_engagement: observed({
      numerator: 3, denominator: 5, eligible: 5, excluded: 0,
    }),
    first_engagement_to_qualified: UNMAPPED,
    qualified_to_booked: UNMAPPED,
    booked_to_showed: EMPTY,
    booked_to_no_show: EMPTY,
    booked_to_cancelled: EMPTY,
    cancelled_to_rebooked: UNMAPPED,
    won_to_collected_revenue: EMPTY_REVENUE,
    closed_to_reactivated: UNMAPPED,
  },
  previousClosedWeek: {
    lead_created_to_first_engagement: observed({
      numerator: 7, denominator: 10, eligible: 12, excluded: 2,
      exclusions: { IDENTITY_CONFLICT: 2 },
    }),
    first_engagement_to_qualified: UNMAPPED,
    qualified_to_booked: UNMAPPED,
    // ap01 (c01) and ap11 (c11) are booked in this week; a 14-day lag cannot elapse by the cutoff.
    // ap11's subject is also the duplicate-email one, and exclusion is decided ahead of maturity,
    // so this window is one excluded entrant and one immature one.
    booked_to_showed: blockedByLag({
      eligible: 2, excluded: 1, immature: 1, exclusions: { IDENTITY_CONFLICT: 1 },
    }),
    booked_to_no_show: blockedByLag({
      eligible: 2, excluded: 1, immature: 1, exclusions: { IDENTITY_CONFLICT: 1 },
    }),
    booked_to_cancelled: blockedByLag({
      eligible: 2, excluded: 1, immature: 1, exclusions: { IDENTITY_CONFLICT: 1 },
    }),
    cancelled_to_rebooked: UNMAPPED,
    won_to_collected_revenue: EMPTY_REVENUE,
    closed_to_reactivated: UNMAPPED,
  },
  trailing28Days: {
    // Cohorts A (12) + B (6) + E (5) = 23 entrants; c11/c12 excluded; converted 7 + 6 + 3 = 16.
    lead_created_to_first_engagement: observed({
      numerator: 16, denominator: 21, eligible: 23, excluded: 2,
      exclusions: { IDENTITY_CONFLICT: 2 },
    }),
    first_engagement_to_qualified: UNMAPPED,
    qualified_to_booked: UNMAPPED,
    /*
     * EIGHT appointments enter this window, not six: cohort B's six from early July PLUS ap01 and
     * ap11, booked on 2026-07-14 and 2026-07-18. Round 2 makes them visible. ap11's subject is the
     * duplicate-email one (excluded); ap01 is trustworthy but inside its own 14-day lag (immature).
     * Before round 2 this cell reported `eligible 6, excluded 0, coverage COMPLETE` — two entrants
     * of eight dropped without a word.
     */
    booked_to_showed: observed({
      numerator: 3, denominator: 6, eligible: 8, excluded: 1, immature: 1,
      exclusions: { IDENTITY_CONFLICT: 1 },
    }),
    booked_to_no_show: observed({
      numerator: 1, denominator: 6, eligible: 8, excluded: 1, immature: 1,
      exclusions: { IDENTITY_CONFLICT: 1 },
    }),
    booked_to_cancelled: observed({
      numerator: 1, denominator: 6, eligible: 8, excluded: 1, immature: 1,
      exclusions: { IDENTITY_CONFLICT: 1 },
    }),
    cancelled_to_rebooked: UNMAPPED,
    won_to_collected_revenue: EMPTY_REVENUE,
    closed_to_reactivated: UNMAPPED,
  },
  /*
   * THE FAST RUNG. Only the 30-day-lag edge declares this window, so it is the only cell in it.
   * FIVE subjects showed inside [2026-05-28, 2026-07-27): c20 (07-06), c21 (07-07), c25 (07-11),
   * c01 (07-16) and c11 (07-19). Cohort D's two showed on 2026-04-28, before the window opens.
   * c11 is the duplicate-email subject and is excluded ahead of maturity; the remaining four all
   * showed in July, and July + 30 days is past the 2026-07-27 cutoff, so all four are immature.
   */
  trailing60Days: {
    showed_to_opportunity_outcome_30d: blockedByLag({
      eligible: 5, excluded: 1, immature: 4, exclusions: { IDENTITY_CONFLICT: 1 },
    }),
  },
  trailing90Days: {
    // Cohorts A (12) + B (6) + E (5) + C (5) = 28 entrants. Cohort D's leads are 2026-04-20,
    // before the window opens. Excluded: c11, c12 (duplicate email) and c34 (string amount).
    lead_created_to_first_engagement: observed({
      numerator: 16, denominator: 25, eligible: 28, excluded: 3,
      exclusions: { NON_OBSERVED_EVIDENCE: 1, IDENTITY_CONFLICT: 2 },
    }),
    first_engagement_to_qualified: UNMAPPED,
    qualified_to_booked: UNMAPPED,
    booked_to_showed: observed({
      numerator: 3, denominator: 6, eligible: 8, excluded: 1, immature: 1,
      exclusions: { IDENTITY_CONFLICT: 1 },
    }),
    booked_to_no_show: observed({
      numerator: 1, denominator: 6, eligible: 8, excluded: 1, immature: 1,
      exclusions: { IDENTITY_CONFLICT: 1 },
    }),
    booked_to_cancelled: observed({
      numerator: 1, denominator: 6, eligible: 8, excluded: 1, immature: 1,
      exclusions: { IDENTITY_CONFLICT: 1 },
    }),
    cancelled_to_rebooked: UNMAPPED,
    /*
     * THE MIDDLE RUNG, at 60 days of lag. SEVEN subjects showed inside [2026-04-28, 2026-07-27);
     * only cohort D's two, sitting exactly on the window start, are old enough for ANY of the three
     * lags to elapse by the cutoff. The other five are immature, except c11 which is excluded
     * outright. So the ANSWERABLE population is 3 and one of those 3 cannot be trusted: a trust
     * ratio of 2/3, below the declared 0.8 floor.
     *
     * Identical to the 90-day rung below because of how this fixture is SHAPED, not because the
     * two rungs are the same measurement — see the note above the table.
     */
    showed_to_opportunity_outcome_60d: belowFloor({
      eligible: 7, excluded: 1, immature: 4, exclusions: { IDENTITY_CONFLICT: 1 },
    }),
    won_to_collected_revenue: valueOnly({
      value: 13000, valueSubjects: 5, eligible: 6, excluded: 1,
      exclusions: { NON_OBSERVED_EVIDENCE: 1 },
    }),
    closed_to_reactivated: UNMAPPED,
  },
  /*
   * THE SETTLED RUNG. Only the 90-day-lag edge declares this window. The window opens 2026-01-28,
   * before every event in the fixture, so the entrant set is every `showed` in it: cohort D's two
   * plus the five July ones = 7. Cohort D matures (2026-04-28 + 90 days = 2026-07-27, exactly the
   * cutoff, and maturity is inclusive); the four trustworthy July subjects do not; c11 is excluded.
   */
  trailing180Days: {
    showed_to_opportunity_outcome: belowFloor({
      eligible: 7, excluded: 1, immature: 4, exclusions: { IDENTITY_CONFLICT: 1 },
    }),
  },
});

/** Same fixture, read through the Grom journey. Only its four MAPPED edges are listed. */
const EXPECTED_GROM = Object.freeze({
  currentClosedWeek: {
    enquiry_to_contacted: observed({ numerator: 3, denominator: 5, eligible: 5, excluded: 0 }),
    strategy_call_to_showed: EMPTY,
    won_to_collected_revenue: EMPTY_REVENUE,
  },
  previousClosedWeek: {
    enquiry_to_contacted: observed({
      numerator: 7, denominator: 10, eligible: 12, excluded: 2,
      exclusions: { IDENTITY_CONFLICT: 2 },
    }),
    strategy_call_to_showed: blockedByLag({
      eligible: 2, excluded: 1, immature: 1, exclusions: { IDENTITY_CONFLICT: 1 },
    }),
    won_to_collected_revenue: EMPTY_REVENUE,
  },
  trailing28Days: {
    enquiry_to_contacted: observed({
      numerator: 16, denominator: 21, eligible: 23, excluded: 2,
      exclusions: { IDENTITY_CONFLICT: 2 },
    }),
    strategy_call_to_showed: observed({
      numerator: 3, denominator: 6, eligible: 8, excluded: 1, immature: 1,
      exclusions: { IDENTITY_CONFLICT: 1 },
    }),
    won_to_collected_revenue: EMPTY_REVENUE,
  },
  /** The fast rung, same five July `showed` subjects and same arithmetic as the client profile. */
  trailing60Days: {
    showed_to_decision_30d: blockedByLag({
      eligible: 5, excluded: 1, immature: 4, exclusions: { IDENTITY_CONFLICT: 1 },
    }),
  },
  trailing90Days: {
    enquiry_to_contacted: observed({
      numerator: 16, denominator: 25, eligible: 28, excluded: 3,
      exclusions: { NON_OBSERVED_EVIDENCE: 1, IDENTITY_CONFLICT: 2 },
    }),
    strategy_call_to_showed: observed({
      numerator: 3, denominator: 6, eligible: 8, excluded: 1, immature: 1,
      exclusions: { IDENTITY_CONFLICT: 1 },
    }),
    showed_to_decision_60d: belowFloor({
      eligible: 7, excluded: 1, immature: 4, exclusions: { IDENTITY_CONFLICT: 1 },
    }),
    won_to_collected_revenue: valueOnly({
      value: 13000, valueSubjects: 5, eligible: 6, excluded: 1,
      exclusions: { NON_OBSERVED_EVIDENCE: 1 },
    }),
  },
  /** The settled rung, same seven `showed` subjects and same arithmetic as the client profile. */
  trailing180Days: {
    showed_to_decision: belowFloor({
      eligible: 7, excluded: 1, immature: 4, exclusions: { IDENTITY_CONFLICT: 1 },
    }),
  },
});

/**
 * THE SPINE — the window set every contract reports on, whether or not it declares anything. These
 * are the four windows that existed before the maturity ladder, and an edge with no
 * `reportingWindows` still reports on exactly them.
 */
const BASELINE_WINDOWS = [
  'currentClosedWeek',
  'previousClosedWeek',
  'trailing28Days',
  'trailing90Days',
];

/** Every window this run reports on, in report order: the spine plus the two ladder rungs. */
const WINDOW_NAMES = [
  'currentClosedWeek',
  'previousClosedWeek',
  'trailing28Days',
  'trailing60Days',
  'trailing90Days',
  'trailing180Days',
];

test('A2 headline - the real chain over a real fixture reports the hand-computed table', () => {
  const { metrics, cohorts } = computeJourneyMetrics({
    graph: clientGraph(),
    metricContracts: loadMetricContracts('client'),
    windows: WINDOWS,
  });
  assert.deepEqual(Object.keys(metrics), WINDOW_NAMES);
  for (const window of WINDOW_NAMES) {
    for (const [edgeId, expected] of Object.entries(EXPECTED_CLIENT[window])) {
      assert.deepEqual(
        cell(metrics[window][edgeId]),
        expected,
        `client / ${window} / ${edgeId}`,
      );
    }
    assert.deepEqual(
      Object.keys(metrics[window]).sort(),
      Object.keys(EXPECTED_CLIENT[window]).sort(),
      `client / ${window} must report exactly the edges that declare it`,
    );
  }

  /*
   * ENTRY COHORTS, hand-derived. `cohortCounts` counts trustworthy subjects whose event in the
   * window sits at a ROOT stage - a `fromStage` that is nothing's `toStage`. Across the ten client
   * edges those roots are lead_created, won and closed.
   *   currentClosedWeek  5 leads (cohort E), no wins.
   *   previousClosedWeek 12 leads minus the 2 duplicates = 10, no wins.
   *   trailing28Days     23 leads minus 2 = 21, no wins.
   *   trailing90Days     28 leads minus 3 = 25, plus 5 trustworthy wins (op30-33, op40) = 30.
   */
  assert.deepEqual(cohorts, {
    currentClosedWeek: { journey_client_sales: 5 },
    previousClosedWeek: { journey_client_sales: 10 },
    // A LADDER WINDOW'S COHORT IS ITS OWN. The only edge reporting in trailing60Days /
    // trailing180Days runs FROM `showed`, and `showed` is nothing's toStage among the edges
    // reporting there, so it is the root stage and the cohort counts trustworthy `showed`
    // subjects. Five showed inside the 60-day window and seven inside the 180-day one; ap11's
    // subject is the duplicate-email one and is not countable, so 4 and 6.
    trailing60Days: { journey_client_sales: 4 },
    trailing28Days: { journey_client_sales: 21 },
    trailing90Days: { journey_client_sales: 30 },
    trailing180Days: { journey_client_sales: 6 },
  });
});

test('A2 headline - the same fixture reports the hand-computed table for grom_internal', () => {
  const { metrics } = computeJourneyMetrics({
    graph: gromGraph(),
    metricContracts: loadMetricContracts('grom_internal'),
    windows: WINDOWS,
  });
  for (const window of WINDOW_NAMES) {
    for (const [edgeId, expected] of Object.entries(EXPECTED_GROM[window])) {
      assert.deepEqual(cell(metrics[window][edgeId]), expected, `grom / ${window} / ${edgeId}`);
    }
    if (!BASELINE_WINDOWS.includes(window)) {
      // A ladder window carries ONE cell: the single rung that declared it. Nothing else reaches
      // it, which is the whole point of declaring windows per edge.
      assert.equal(Object.keys(metrics[window]).length, 1, `grom / ${window}`);
      continue;
    }
    // Every edge NOT in the hand-stated table is one of the twelve declared unmeasurable.
    for (const edgeId of EXPECTED_UNKNOWN.grom_internal) {
      assert.deepEqual(cell(metrics[window][edgeId]), UNMAPPED, `grom / ${window} / ${edgeId}`);
    }
    // 18 declared edges minus the three outcome rungs, which each declare one window of their own,
    // plus the 60-day rung back again in the window it declares.
    assert.equal(
      Object.keys(metrics[window]).length,
      window === 'trailing90Days' ? 16 : 15,
      `grom / ${window}`,
    );
  }
});

test('A2 headline - the duplicate email costs two subjects and nothing else', () => {
  const graph = clientGraph();
  const duplicates = graph.conflicts.filter(({ type }) => type === 'duplicate_identity_claim');
  assert.equal(duplicates.length, 1, 'exactly one duplicate identity claim, for dup@example.test');
  assert.equal(duplicates[0].nodeIds.length, 2);
  // The blast radius is TWO subjects out of twelve in the week they appear, not the account.
  const week = computeJourneyMetrics({
    graph,
    metricContracts: loadMetricContracts('client'),
    windows: WINDOWS,
  }).metrics.previousClosedWeek.lead_created_to_first_engagement;
  assert.equal(week.state, 'OBSERVED');
  assert.equal(week.eligible, 12);
  assert.equal(week.excluded, 2);
  assert.deepEqual(week.exclusions, { IDENTITY_CONFLICT: 2 });
  assert.equal(week.coverage, 'INCOMPLETE');
});

test('A2 headline - a string monetaryValue costs one subject and never a fabricated zero', () => {
  const revenue = computeJourneyMetrics({
    graph: clientGraph(),
    metricContracts: loadMetricContracts('client'),
    windows: WINDOWS,
  }).metrics.trailing90Days.won_to_collected_revenue;
  // Round 2: a VALUE measure. The money is published; the tautological rate never is.
  assert.equal(revenue.state, 'UNKNOWN');
  assert.equal(revenue.reasonCode, 'RATE_NOT_DERIVABLE');
  assert.equal(revenue.rate, null);
  assert.equal(revenue.eligible, 6);
  assert.equal(revenue.excluded, 1);
  assert.equal(revenue.valueSubjects, 5);
  assert.deepEqual(revenue.exclusions, { NON_OBSERVED_EVIDENCE: 1 });
  // 2400 + 1800 + 3200 + 1500 + 4100. The string 2750 is absent, and is NOT counted as zero.
  assert.equal(revenue.value, 13000);
  assert.notEqual(revenue.value, 13000 + 2750);
});

test('A2 headline - the flip is what produces the numbers, and it produces no wrong ones', () => {
  const graph = clientGraph();
  const shipped = computeJourneyMetrics({
    graph,
    metricContracts: loadMetricContracts('client'),
    windows: WINDOWS,
  }).metrics;
  const measured = Object.values(shipped)
    .flatMap((byEdge) => Object.entries(byEdge))
    .filter(([, metric]) => metric.state === 'OBSERVED' && metric.denominator > 0);
  // Hand-counted from the table above: 1 + 1 + 3 + 3 = 8 rate cells carry a real denominator, plus
  // the two lead cells in the closed weeks = 10. Round 2 removed two that never should have been
  // there: the revenue cell, whose rate was the constant 1, and the 90-day outcome cell, which was
  // reporting 2/2 over a rump of a 7-subject window.
  assert.equal(measured.length, 10);
  // Every one of them belongs to a MAPPED edge. An UNKNOWN edge can never produce a number.
  for (const [edgeId] of measured) {
    assert.ok(
      EXPECTED_MAPPED.client.includes(edgeId),
      `${edgeId} produced a number without being MAPPED`,
    );
    assert.notEqual(edgeId, 'won_to_collected_revenue', 'a tautology may never publish a rate');
  }
  // The money is still reported, on its own terms, in the window that matures it.
  const revenue = shipped.trailing90Days.won_to_collected_revenue;
  assert.equal(revenue.value, 13000);
  assert.equal(revenue.rate, null);
});
