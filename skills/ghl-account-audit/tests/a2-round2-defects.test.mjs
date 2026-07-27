/**
 * TASK A2, ROUND 2 — the five defects an adversarial reviewer reproduced against the SHIPPED
 * profiles through the REAL chain, and the behaviour that replaces them.
 *
 * Every test here drives
 *   projectJourneyEvents -> normalizeEvidence -> buildEvidenceGraph -> buildWindows
 *   -> computeJourneyMetrics
 * over raw GHL-shaped payloads carrying the REAL allowlist action ids, using the SHIPPED profiles.
 * Nothing is hand-shaped into already-projected journey records and no contract is forged except
 * where a test is explicitly ABOUT a forged contract.
 *
 * The five:
 *
 * C1  `won_to_collected_revenue` is a TAUTOLOGY. `won` and `collected_revenue` are projected from
 *     the same opportunity record, under the same predicate, off the same event-time field, so the
 *     conversion always exists at the entrant's own instant and `numerator === denominator` in
 *     every possible account. A rate computed from it is a constant. The edge now declares
 *     `measure: "VALUE"` and publishes MONEY and the SUBJECT COUNT BEHIND IT — never a rate.
 * C2  `monetaryValue: 0` on a revenue stage was counted as a £0 collection with no disclosure. An
 *     unpriced won opportunity is the normal state of a GHL pipeline, so the reading is now
 *     PROFILE-DECLARED (`zeroAmountPolicy`), defaulting to unusable-and-disclosed.
 * H3  `eligible` was computed AFTER the maturity filter, so a cell could drop 39% of its window and
 *     still declare COMPLETE coverage. `eligible` is now the whole in-window entrant population and
 *     `immature` is carried beside it.
 * H4  A contact with two opportunities was dropped from EVERY metric, because the projector copied
 *     the opportunity's own id onto the derived CONTACT entity and the two entities then
 *     contradicted each other. Repeat treatment is the business model of the accounts this profile
 *     targets.
 * M5  The stage-coverage gate ran only inside `loadProjection`, and `lib/report.mjs` publishes off
 *     `loadMetricContracts`. An optional gate is not a gate.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { buildEvidenceGraph } from '../lib/evidence-graph.mjs';
import { projectJourneyEvents } from '../lib/journey-projection.mjs';
import { buildWindows, computeJourneyMetrics } from '../lib/metrics.mjs';
import { normalizeEvidence } from '../lib/normalize.mjs';
// A namespace import on purpose: M5 asserts on an export that did not exist before this round, and
// a named import would fail the WHOLE file rather than the one test that is about it.
import * as schemas from '../schemas/v1.mjs';

const { loadMetricContracts, loadProjection } = schemas;

const profilesUrl = new URL('../profiles/', import.meta.url);
const readProfile = (name) => JSON.parse(readFileSync(new URL(name, profilesUrl), 'utf8'));
const CLIENT_PROFILE = readProfile('client.v1.json');

const CONTEXT = Object.freeze({ locationId: 'LOC-A2-ROUND2' });

/**
 * Deliberately wider than the analysis cutoff at the far end: rule 8 suppresses an event outside
 * the envelope's APPLIED window, and the appointment fixture below carries `startTime`s a couple of
 * days past the last `dateAdded`. Nothing downstream reads this window as an analysis boundary —
 * `capturedAt` and the metric windows do that — so widening it only stops the projector discarding
 * rows the fixture needs.
 */
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

/** THE FULL REAL CHAIN, from raw payloads to metric cells. */
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
  dateAdded: '2026-05-01T09:00:00.000Z',
  ...overrides,
});

const wonOpportunity = (id, contactId, overrides = {}) => ({
  id,
  contactId,
  status: 'won',
  monetaryValue: 1000,
  lastStatusChangeAt: '2026-05-10T09:00:00.000Z',
  ...overrides,
});

// ===========================================================================
// C1 — the revenue edge is a tautology and must never publish a rate
// ===========================================================================

/**
 * The reviewer's exhaustive sweep, run through the real chain. Whatever the amount is or is not,
 * the ONE thing this cell may never do is publish a conversion rate: `won` and `collected_revenue`
 * come off the same record under the same predicate, so any rate it could compute is 1 by
 * construction and carries no information about the account.
 */
/*
 * TASK A2 ROUND 3 — the `reasonCode` expectation is now PER LABEL, and the round-2 line it replaces
 * was, for every label alike:
 *
 *   assert.equal(cell.reasonCode, 'RATE_NOT_DERIVABLE');
 *
 * `RATE_NOT_DERIVABLE` says "there were subjects and a rate is the wrong question for them". On the
 * four labels where the amount field holds something that is not a usable amount, the revenue event
 * is emitted UNKNOWN and the ONLY subject in the account is genuinely untrustworthy, so the honest
 * code is `ALL_SUBJECTS_EXCLUDED` — a fact about the account rather than about the contract. What
 * the sweep is FOR is unchanged and is asserted identically for all seven: no rate, no numerator,
 * no denominator, whatever the amount is or is not.
 */
const AMOUNT_SWEEP = Object.freeze([
  ['priced', { monetaryValue: 2400 }, 'RATE_NOT_DERIVABLE'],
  // Suppressed as an unfilled amount: the subject stays trusted, it simply contributes no money.
  ['zero', { monetaryValue: 0 }, 'RATE_NOT_DERIVABLE'],
  ['string', { monetaryValue: '2400' }, 'ALL_SUBJECTS_EXCLUDED'],
  ['null', { monetaryValue: null }, 'ALL_SUBJECTS_EXCLUDED'],
  ['missing', {}, 'ALL_SUBJECTS_EXCLUDED'],
  ['negative', { monetaryValue: -50 }, 'ALL_SUBJECTS_EXCLUDED'],
  ['float', { monetaryValue: 2400.5 }, 'RATE_NOT_DERIVABLE'],
]);

for (const [label, overrides, reasonCode] of AMOUNT_SWEEP) {
  test(`C1 — a won opportunity priced ${label} never yields a collection RATE`, () => {
    const raw = wonOpportunity('op-sweep', 'c001', overrides);
    if (label === 'missing') delete raw.monetaryValue;
    const { metrics } = measure({
      contacts: [contact(1)],
      opportunities: [raw],
    });
    const cell = metrics.trailing90Days.won_to_collected_revenue;
    assert.equal(cell.rate, null, `${label}: a rate was published for a tautological edge`);
    assert.equal(cell.numerator, null, `${label}: a numerator was published`);
    assert.equal(cell.denominator, null, `${label}: a denominator was published as a rate basis`);
    assert.equal(cell.state, 'UNKNOWN', `${label}: the CONVERSION is not observable`);
    assert.equal(cell.reasonCode, reasonCode, `${label}: the cause must be named, not shrugged at`);
  });
}

test('C1 — the revenue edge publishes MONEY and the subject count behind it, and nothing else', () => {
  const { metrics } = measure({
    contacts: [1, 2, 3].map((index) => contact(index)),
    opportunities: [
      wonOpportunity('op-1', 'c001', { monetaryValue: 2400 }),
      wonOpportunity('op-2', 'c002', { monetaryValue: 1800 }),
      wonOpportunity('op-3', 'c003', { monetaryValue: 3200 }),
    ],
  });
  const cell = metrics.trailing90Days.won_to_collected_revenue;
  assert.equal(cell.value, 2400 + 1800 + 3200);
  assert.equal(cell.valueSubjects, 3);
  assert.equal(cell.eligible, 3);
  assert.equal(cell.excluded, 0);
  assert.equal(cell.rate, null);
  assert.equal(cell.rankEligible, false, 'a value measure can never be ranked as a rate');
});

test('C1 — the contract declares the value measure as DATA, in both shipped profiles', () => {
  for (const profileId of ['client', 'grom_internal']) {
    const contracts = loadMetricContracts(profileId);
    const revenue = contracts.edges.find(({ edgeId }) => edgeId === 'won_to_collected_revenue');
    assert.ok(revenue, `${profileId} must declare the revenue edge`);
    assert.equal(revenue.measure, 'VALUE', `${profileId} revenue edge must be a VALUE measure`);
    assert.equal(revenue.nativeMapping, 'MAPPED', `${profileId} revenue edge stays mapped`);
    for (const edge of contracts.edges) {
      if (edge.edgeId === 'won_to_collected_revenue') continue;
      assert.notEqual(edge.measure, 'VALUE', `${profileId}/${edge.edgeId} is a rate edge`);
    }
  }
});

/**
 * THE GENERAL GATE, not a special case for this one edge. An edge is tautological whenever some
 * source emits BOTH its stages from the same record, under an identical predicate, off an identical
 * event-time reading. Declaring such an edge MAPPED as a RATE is the defect; the gate refuses it
 * for any profile, present or future.
 */
test('C1 — a MAPPED tautological edge that still claims to be a RATE is REFUSED', () => {
  const projection = loadProjection('client');
  const forged = structuredClone(loadMetricContracts('client'));
  const revenue = forged.edges.find(({ edgeId }) => edgeId === 'won_to_collected_revenue');
  delete revenue.measure;
  assert.throws(
    () => schemas.validateProjectionForProfile(CLIENT_PROFILE, projection, forged),
    /PROJECTION_EDGE_TAUTOLOGICAL:won_to_collected_revenue/,
  );
});

// ===========================================================================
// C2 — a zero amount on a revenue stage is a PROFILE-DECLARED reading
// ===========================================================================

/*
 * TASK A2 ROUND 3 — EDITED, and the round-2 body it replaces read:
 *
 *   const revenue = items.find(({ stage }) => stage === 'collected_revenue');
 *   assert.ok(revenue, 'the revenue event is still emitted, never dropped silently');
 *   assert.equal(revenue.classification, 'UNKNOWN');
 *   assert.equal(Object.hasOwn(revenue, 'revenueAmount'), false, 'no fabricated zero amount');
 *   assert.deepEqual(revenue.projectionReasons, ['REVENUE_ZERO_ON_OUTCOME_STAGE']);
 *
 * "Still emitted, never dropped silently" was aimed at the right thing — nothing may vanish without
 * a count — and reached for the wrong instrument. An UNKNOWN event is not a quiet disclosure: the
 * metric layer treats a non-observed row as a reason to distrust the SUBJECT, so it removed that
 * contact from every appointment metric too. The event is now suppressed, and the disclosure moves
 * to the suppression tally, where it is counted just as loudly and taints nothing.
 */
test('C2 — by default a zero amount on a revenue stage is UNUSABLE and disclosed', () => {
  const { projected } = measure({
    contacts: [contact(1)],
    opportunities: [wonOpportunity('op-zero', 'c001', { monetaryValue: 0 })],
  });
  const items = projected.flatMap(({ items: rows }) => rows);
  assert.equal(
    items.some(({ stage }) => stage === 'collected_revenue'),
    false,
    'no fabricated zero amount, and no subject-tainting UNKNOWN event either',
  );
  const suppressed = projected
    .flatMap(({ projection }) => projection.suppressed ?? [])
    .find(({ reason }) => reason === 'REVENUE_ZERO_ON_OUTCOME_STAGE');
  assert.ok(suppressed, 'never dropped silently');
  assert.equal(suppressed.count, 1);
  assert.equal(suppressed.unit, 'emission', 'the EVENT is dropped, never the record');
});

test('C2 — a profile may DECLARE that zero is a real collection, and then it is OBSERVED', () => {
  const permissive = structuredClone(loadProjection('client'));
  permissive.zeroAmountPolicy = 'OBSERVED';
  const { projected } = measure({
    contacts: [contact(1)],
    opportunities: [wonOpportunity('op-zero', 'c001', { monetaryValue: 0 })],
    projection: permissive,
  });
  const revenue = projected
    .flatMap(({ items }) => items)
    .find(({ stage }) => stage === 'collected_revenue');
  assert.equal(revenue.revenueAmount, 0);
  assert.equal(Object.hasOwn(revenue, 'classification'), false, 'no downgrade under this policy');
});

test('C2 — four unpriced wins beside one priced win are disclosed, not counted as £0 collections', () => {
  const { metrics } = measure({
    contacts: [1, 2, 3, 4, 5].map((index) => contact(index)),
    opportunities: [
      wonOpportunity('op-1', 'c001', { monetaryValue: 12000 }),
      wonOpportunity('op-2', 'c002', { monetaryValue: 0 }),
      wonOpportunity('op-3', 'c003', { monetaryValue: 0 }),
      wonOpportunity('op-4', 'c004', { monetaryValue: 0 }),
      wonOpportunity('op-5', 'c005', { monetaryValue: 0 }),
    ],
  });
  /*
   * TASK A2 ROUND 3 — the four DISCLOSURE lines changed, and the round-2 ones read:
   *
   *   assert.equal(cell.excluded, 4);
   *   assert.deepEqual(cell.exclusions, { NON_OBSERVED_EVIDENCE: 4 });
   *   assert.equal(cell.coverage, 'INCOMPLETE');
   *   assert.equal(cell.coverageRatio, 0.2);
   *
   * Those describe four EXCLUDED SUBJECTS — untrustworthy people — when the account contains four
   * perfectly ordinary wins with an empty amount box. Excluding them is what also removed them from
   * every appointment metric. The disclosure that the money covers one win in five now lives where
   * it belongs, in `valueSubjects` against `eligible`, which is asserted above and unchanged.
   *
   * The money assertions, which are what this test is named for, are IDENTICAL: 12000 over one
   * subject, and never 12000 over five.
   */
  const cell = metrics.trailing90Days.won_to_collected_revenue;
  assert.equal(cell.value, 12000);
  assert.equal(cell.valueSubjects, 1, 'one win carried a usable amount');
  assert.equal(cell.eligible, 5);
  assert.equal(cell.excluded, 0, 'an empty amount box is not an untrustworthy subject');
  assert.deepEqual(cell.exclusions, {});
  assert.equal(cell.coverage, 'COMPLETE', 'every one of the five wins was seen and trusted');
  assert.equal(cell.coverageRatio, 1);
});

// ===========================================================================
// H3 — `eligible` is the whole in-window population, and immaturity is visible
// ===========================================================================

/**
 * 28 appointments, one per day across `trailing28Days`, half of them showed.
 *
 * `booked_to_showed` allows 14 days of lag, so with a 2026-07-27 cutoff only the entrants booked on
 * or before 2026-07-12 can possibly have an answer. That is 14 of the 28. The other 14 are not
 * lost — they are simply not yet answerable — and the cell may not pretend they were never there.
 */
const APPOINTMENT_DAYS = 28;
const APPOINTMENT_CONTACTS = Array.from({ length: APPOINTMENT_DAYS }, (_unused, index) => (
  contact(100 + index, { dateAdded: '2026-06-01T09:00:00.000Z' })
));
const APPOINTMENTS = Array.from({ length: APPOINTMENT_DAYS }, (_unused, index) => {
  const booked = new Date(Date.UTC(2026, 5, 29, 9) + index * 86_400_000);
  const start = new Date(booked.getTime() + 2 * 86_400_000);
  return {
    id: `ap${String(index).padStart(3, '0')}`,
    contactId: `c${String(100 + index).padStart(3, '0')}`,
    // Half showed, alternating, so the true rate over the whole window is exactly 0.5.
    appointmentStatus: index % 2 === 0 ? 'showed' : 'confirmed',
    dateAdded: booked.toISOString(),
    startTime: start.toISOString(),
  };
});

test('H3 — a cell may not declare COMPLETE coverage while its window is half unanswerable', () => {
  const { metrics } = measure({
    contacts: APPOINTMENT_CONTACTS,
    appointments: APPOINTMENTS,
  });
  const cell = metrics.trailing28Days.booked_to_showed;
  assert.equal(cell.eligible, 28, 'eligible must be the whole in-window entrant population');
  assert.equal(cell.immature, 14, 'the unanswerable share must be counted, not dropped');
  assert.equal(cell.denominator, 14);
  assert.equal(cell.excluded, 0);
  assert.equal(
    cell.eligible,
    cell.excluded + cell.immature + cell.denominator,
    'the population must partition exactly',
  );
  assert.equal(cell.coverage, 'INCOMPLETE');
  assert.equal(cell.maturityRatio, 0.5);
  // The floor governs TRUST over the answerable population, which is untouched here.
  assert.equal(cell.coverageRatio, 1);
  assert.equal(cell.state, 'OBSERVED');
  assert.equal(cell.numerator, 7);
});

test('H3 — an edge blocked only by its lag says IMMATURE_COHORT, not MISSING_REQUIRED_EVIDENCE', () => {
  const { metrics } = measure({
    contacts: APPOINTMENT_CONTACTS,
    appointments: APPOINTMENTS,
  });
  // Every entrant in the closed week is inside the 14-day lag, so nothing can have matured.
  const cell = metrics.currentClosedWeek.booked_to_showed;
  assert.equal(cell.state, 'UNKNOWN');
  assert.equal(cell.reasonCode, 'IMMATURE_COHORT');
  assert.equal(cell.eligible, 7);
  assert.equal(cell.immature, 7);
  assert.equal(cell.coverage, 'INCOMPLETE');
});

// ===========================================================================
// H4 — a repeat customer survives
// ===========================================================================

const REPEAT_CONTACTS = Array.from({ length: 20 }, (_unused, index) => contact(200 + index));
const REPEAT_OPPORTUNITIES = [
  ...REPEAT_CONTACTS.map((subject, index) => wonOpportunity(
    `op-a${index}`,
    subject.id,
    { lastStatusChangeAt: new Date(Date.UTC(2026, 4, 10, 9) + index * 3_600_000).toISOString() },
  )),
  // THREE REPEAT CUSTOMERS. A second course of treatment on the same contact is the business model
  // of the clinic accounts this profile targets, not an edge case.
  ...[0, 1, 2].map((index) => wonOpportunity(
    `op-b${index}`,
    REPEAT_CONTACTS[index].id,
    { lastStatusChangeAt: new Date(Date.UTC(2026, 4, 17, 9) + index * 3_600_000).toISOString() },
  )),
];

test('H4 — two opportunities on one contact raise no identity contradiction', () => {
  const { graph } = measure({
    contacts: REPEAT_CONTACTS,
    opportunities: REPEAT_OPPORTUNITIES,
  });
  const contradictions = graph.conflicts.filter(
    ({ type }) => type === 'contradictory_native_identity_claim',
  );
  assert.deepEqual(
    contradictions,
    [],
    `a repeat customer must not contradict itself: ${JSON.stringify(contradictions)}`,
  );
});

test('H4 — a repeat customer is dropped from NO metric, and its money is not lost', () => {
  const { metrics } = measure({
    contacts: REPEAT_CONTACTS,
    opportunities: REPEAT_OPPORTUNITIES,
  });
  const leads = metrics.trailing90Days.lead_created_to_first_engagement;
  assert.equal(leads.eligible, 20);
  assert.equal(leads.excluded, 0, 'no subject may be tainted by having bought twice');
  assert.deepEqual(leads.exclusions, {});

  const revenue = metrics.trailing90Days.won_to_collected_revenue;
  assert.equal(revenue.excluded, 0);
  assert.equal(revenue.valueSubjects, 23, 'every won opportunity counts, not one per contact');
  assert.equal(revenue.value, 23_000);
});

// ===========================================================================
// M5 — the stage-coverage gate is on the PUBLISHING path
// ===========================================================================

test('M5 — the gate is exported and refuses a contract that maps an unmeasurable edge', () => {
  const projection = loadProjection('client');
  const forged = structuredClone(loadMetricContracts('client'));
  forged.edges.find(({ edgeId }) => edgeId === 'cancelled_to_rebooked').nativeMapping = 'MAPPED';
  assert.equal(
    typeof schemas.assertMetricStageCoverage,
    'function',
    'the gate must be reachable on its own, not only from inside loadProjection',
  );
  assert.throws(
    () => schemas.assertMetricStageCoverage(CLIENT_PROFILE, projection, forged),
    /PROJECTION_UNMEASURABLE_EDGE_MAPPED:cancelled_to_rebooked/,
  );
  assert.doesNotThrow(
    () => schemas.assertMetricStageCoverage(
      CLIENT_PROFILE,
      projection,
      loadMetricContracts('client'),
    ),
    'the shipped combination must still pass the gate',
  );
});

/**
 * The WIRING, which is the actual defect: `lib/report.mjs:404` publishes off `loadMetricContracts`,
 * and that loader ran only `validateMetricContractsForProfile`. The two shipped profiles both pass
 * the gate, so no fixture can make the loader throw without mutating a shipped file on disk mid-run
 * — which would corrupt every other test file sharing this repo. The wiring is therefore asserted
 * against the source, which is exactly how this repo already proves that `journey-projection.mjs`
 * carries no account facts.
 */
test('M5 — loadMetricContracts itself runs the gate before returning MAPPED edges', () => {
  const source = readFileSync(new URL('../schemas/v1.mjs', import.meta.url), 'utf8');
  const body = source.slice(
    source.indexOf('export function loadMetricContracts'),
    source.indexOf('export function validateMetricContractsForProfile'),
  );
  assert.ok(body.length > 0, 'loadMetricContracts must still exist');
  assert.ok(
    body.includes('assertMetricStageCoverage'),
    `loadMetricContracts must run the stage-coverage gate:\n${body}`,
  );
});
