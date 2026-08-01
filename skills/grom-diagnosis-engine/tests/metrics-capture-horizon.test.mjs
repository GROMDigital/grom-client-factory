/**
 * THE TWO CLOCKS — regression cover for the defect that emptied the first live run.
 *
 * WHAT HAPPENED. `run_937bffa1` collected Grom's UK sub-account read-only on 2026-07-27 and
 * projected 1,099 journey events into a 1,287-node graph with zero suppressions and zero
 * unresolved joins. Every metric cell in every window then reported `eligible: 0`, `cohorts` was
 * `{}` for all six windows and `currentStock` was `{}`. The four MAPPED edges read
 * `NO_ELIGIBLE_POPULATION`, which is indistinguishable, in a published report, from an agency that
 * generated no business at all.
 *
 * THE CAUSE. `computeEdge`, `cohortCounts` and `stockFor` each refused a node whose `capturedAt`
 * was past `windows.cutoff`. That is a sound no-lookahead rule on the COLLECTION clock — the graph
 * may be assembled from several collections via the `priorWatermark` merge path — but it was being
 * measured against the EVENT clock. `planWeeklyCollection` seals `cutoff` as the closed-week Monday
 * and `kernel.mjs` uses it as the collection window's `to`, so a run necessarily collects AFTER its
 * own cutoff: on this run, cutoff 2026-07-26T23:00Z against a capture at 2026-07-27T06:12Z, a gap
 * of 7h12m. Every node in the graph carried the collection's `capturedAt`, so the rule discarded
 * one hundred per cent of the evidence, silently, in every window.
 *
 * WHY NOTHING CAUGHT IT. Every fixture authored `capturedAt` at or before its cutoff — a
 * collection cannot do that, because the week has to close before you can read it. The doubles
 * agreed with the assumption instead of testing it.
 *
 * SO THE ORACLE HERE IS NOT THE ENGINE. The fixture below is a DECLARED TABLE of ten synthetic
 * subjects with the answer written down beside each one, in GHL's real wire shapes (conversation
 * timestamps as epoch-millisecond NUMBERS, appointments carrying both `appointmentStatus` and
 * GHL's misspelled `appoinmentStatus`, opportunities with ISO `lastStatusChangeAt` and a numeric
 * `monetaryValue`) and with entirely synthetic identities. Every expected number below is counted
 * off THAT TABLE by hand and stated as a literal, so the assertions cannot agree with the engine
 * by construction. And, as on every real run, the collections are captured AFTER the cutoff.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { buildEvidenceGraph } from '../lib/evidence-graph.mjs';
import { buildWindows, computeJourneyMetrics } from '../lib/metrics.mjs';
import { projectJourneyEvents } from '../lib/journey-projection.mjs';
import { normalizeEvidence } from '../lib/normalize.mjs';
import {
  loadMetricContracts, loadProfile, loadProjection, validateProjectionForProfile,
} from '../schemas/v1.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const PROFILE = loadProfile('grom_internal');
const PROJECTION = loadProjection('grom_internal');
const CONTRACTS = loadMetricContracts('grom_internal');
validateProjectionForProfile(PROFILE, PROJECTION, CONTRACTS);

const LOCATION_ID = 'loc00000000000000000000';
const TIMEZONE = 'Europe/London';

/** The run's SEALED cutoff: Monday 2026-07-27 00:00 Europe/London, the boundary closing 20-27 Jul. */
const CUTOFF = '2026-07-26T23:00:00.000Z';
/** When the run actually read the account. 7h12m after the cutoff, as on the live run. */
const CAPTURED_AT = '2026-07-27T06:12:45.385Z';
const COLLECTION_FROM = '2026-04-27T23:00:00.000Z';

const epoch = (iso) => Date.parse(iso);

/*
 * THE DECLARED TABLE. Ten subjects; the rightmost columns ARE the expected answers.
 *
 *   contactedWithinLag   the enquiry -> contacted edge allows 2 days
 *   showedWithinLag      the strategy_call -> showed edge allows 14 days
 *   decisionWithinLag    the showed -> decision edge allows 30 days
 */
const SUBJECTS = [
  {
    id: 'c01',
    enquiryAt: '2026-05-25T09:00:00.000Z',
    conversationAt: '2026-05-25T10:00:00.000Z', // +1h
    appointment: { bookedAt: '2026-06-01T10:00:00.000Z', startsAt: '2026-06-10T10:00:00.000Z', status: 'showed' },
    opportunity: { status: 'won', decidedAt: '2026-06-20T12:00:00.000Z', monetaryValue: 4800 },
    contactedWithinLag: true,
    showedWithinLag: true,
    decisionWithinLag: true,
  },
  {
    id: 'c02',
    enquiryAt: '2026-05-25T10:00:00.000Z',
    conversationAt: '2026-05-25T13:00:00.000Z', // +3h
    appointment: { bookedAt: '2026-06-01T11:00:00.000Z', startsAt: '2026-06-10T11:00:00.000Z', status: 'showed' },
    opportunity: { status: 'lost', decidedAt: '2026-06-21T12:00:00.000Z', monetaryValue: 0 },
    contactedWithinLag: true,
    showedWithinLag: true,
    decisionWithinLag: true,
  },
  {
    id: 'c03',
    enquiryAt: '2026-05-25T11:00:00.000Z',
    conversationAt: '2026-05-26T07:00:00.000Z', // +20h
    appointment: { bookedAt: '2026-06-01T12:00:00.000Z', startsAt: '2026-06-10T12:00:00.000Z', status: 'showed' },
    opportunity: { status: 'open', decidedAt: '2026-06-19T12:00:00.000Z', monetaryValue: 0 },
    contactedWithinLag: true,
    showedWithinLag: true,
    decisionWithinLag: false, // still open: `open` is not one of won/lost/abandoned
  },
  {
    id: 'c04',
    enquiryAt: '2026-05-25T12:00:00.000Z',
    conversationAt: '2026-05-27T04:00:00.000Z', // +40h, inside 2 days
    appointment: { bookedAt: '2026-06-01T13:00:00.000Z', startsAt: '2026-06-10T13:00:00.000Z', status: 'noshow' },
    opportunity: { status: 'open', decidedAt: '2026-06-19T12:00:00.000Z', monetaryValue: 0 },
    contactedWithinLag: true,
    showedWithinLag: false,
    decisionWithinLag: false,
  },
  {
    id: 'c05',
    enquiryAt: '2026-05-25T13:00:00.000Z',
    conversationAt: '2026-05-27T12:00:00.000Z', // +47h, inside 2 days
    appointment: { bookedAt: '2026-06-01T14:00:00.000Z', startsAt: '2026-06-10T14:00:00.000Z', status: 'confirmed' },
    opportunity: { status: 'open', decidedAt: '2026-06-19T12:00:00.000Z', monetaryValue: 0 },
    contactedWithinLag: true,
    showedWithinLag: false, // never dispositioned; `confirmed` is not `showed`
    decisionWithinLag: false,
  },
  {
    id: 'c06',
    enquiryAt: '2026-05-25T14:00:00.000Z',
    conversationAt: '2026-05-25T16:00:00.000Z', // +2h
    appointment: null,
    opportunity: { status: 'open', decidedAt: '2026-06-19T12:00:00.000Z', monetaryValue: 0 },
    contactedWithinLag: true,
    showedWithinLag: null,
    decisionWithinLag: null,
  },
  {
    id: 'c07',
    enquiryAt: '2026-05-25T15:00:00.000Z',
    conversationAt: '2026-05-25T20:00:00.000Z', // +5h
    appointment: null,
    opportunity: { status: 'lost', decidedAt: '2026-06-22T12:00:00.000Z', monetaryValue: 0 },
    contactedWithinLag: true,
    showedWithinLag: null,
    decisionWithinLag: null, // lost without ever booking: never an entrant to showed -> decision
  },
  {
    id: 'c08',
    enquiryAt: '2026-05-25T16:00:00.000Z',
    conversationAt: '2026-05-30T16:00:00.000Z', // +5 DAYS, outside the 2-day lag
    appointment: null,
    opportunity: null,
    contactedWithinLag: false,
    showedWithinLag: null,
    decisionWithinLag: null,
  },
  {
    id: 'c09',
    enquiryAt: '2026-05-25T17:00:00.000Z',
    conversationAt: null,
    appointment: null,
    opportunity: null,
    contactedWithinLag: false,
    showedWithinLag: null,
    decisionWithinLag: null,
  },
  {
    id: 'c10',
    enquiryAt: '2026-05-25T18:00:00.000Z',
    conversationAt: null,
    appointment: null,
    opportunity: null,
    contactedWithinLag: false,
    showedWithinLag: null,
    decisionWithinLag: null,
  },
];

// ---- THE ANSWERS, counted off the table above by hand ---------------------------------------
const ENQUIRIES = 10;                 // every row is a contact
const CONTACTED_IN_LAG = 7;           // c01..c07; c08 is 5 days late; c09/c10 never
const APPOINTMENTS = 5;               // c01..c05
const SHOWED_IN_LAG = 3;              // c01, c02, c03
const SHOWED_ENTRANTS = 3;            // the same three, as entrants to showed -> decision
const DECISIONS_IN_LAG = 2;           // c01 won, c02 lost; c03 still open
const WON = 1;                        // c01
const WON_VALUE = 4800;               // c01's monetaryValue

function contactItem(subject, index) {
  return {
    id: `cid${String(index).padStart(20, '0')}`,
    locationId: LOCATION_ID,
    contactName: `Subject ${subject.id}`,
    firstName: 'Subject',
    lastName: subject.id,
    email: `${subject.id}@example.invalid`,
    phone: `+1555000${String(index).padStart(4, '0')}`,
    source: 'paid social',
    type: 'lead',
    tags: [],
    dateAdded: subject.enquiryAt,
    dateUpdated: subject.enquiryAt,
  };
}

function conversationItem(subject, index) {
  if (subject.conversationAt === null) return null;
  return {
    id: `conv${String(index).padStart(19, '0')}`,
    locationId: LOCATION_ID,
    contactId: `cid${String(index).padStart(20, '0')}`,
    contactName: `Subject ${subject.id}`,
    email: `${subject.id}@example.invalid`,
    phone: `+1555000${String(index).padStart(4, '0')}`,
    type: 'TYPE_PHONE',
    // GHL returns conversation timestamps as epoch MILLISECONDS, not ISO strings.
    dateAdded: epoch(subject.conversationAt),
    dateUpdated: epoch(subject.conversationAt),
    lastMessageDate: epoch(subject.conversationAt),
    lastMessageDirection: 'outbound',
    lastMessageType: 'TYPE_SMS',
    lastMessageBody: 'redacted',
    unreadCount: 0,
  };
}

function appointmentItem(subject, index) {
  if (subject.appointment === null) return null;
  return {
    id: `appt${String(index).padStart(19, '0')}`,
    locationId: LOCATION_ID,
    calendarId: 'cal0000000000000000000',
    contactId: `cid${String(index).padStart(20, '0')}`,
    title: 'Strategy call',
    // Both spellings ship on the live payload; the projection reads the correct one.
    appointmentStatus: subject.appointment.status,
    appoinmentStatus: subject.appointment.status,
    dateAdded: subject.appointment.bookedAt,
    dateUpdated: subject.appointment.startsAt,
    startTime: subject.appointment.startsAt,
    endTime: subject.appointment.startsAt,
    deleted: false,
    isRecurring: false,
    assignedResources: [],
  };
}

function opportunityItem(subject, index) {
  if (subject.opportunity === null) return null;
  return {
    id: `opp${String(index).padStart(20, '0')}`,
    locationId: LOCATION_ID,
    contactId: `cid${String(index).padStart(20, '0')}`,
    name: `Subject ${subject.id}`,
    status: subject.opportunity.status,
    monetaryValue: subject.opportunity.monetaryValue,
    pipelineId: 'pipe000000000000000000',
    pipelineStageId: 'stage00000000000000000',
    pipelineStageUId: 'stageu0000000000000000',
    source: 'paid social',
    createdAt: subject.enquiryAt,
    updatedAt: subject.opportunity.decidedAt,
    lastStageChangeAt: subject.opportunity.decidedAt,
    lastStatusChangeAt: subject.opportunity.decidedAt,
    lostReasonId: null,
    contact: {
      id: `cid${String(index).padStart(20, '0')}`,
      email: `${subject.id}@example.invalid`,
      phone: `+1555000${String(index).padStart(4, '0')}`,
    },
    customFields: [],
    relations: [],
    attributions: [],
  };
}

function scope(operationId, items, capturedAt) {
  return {
    source: 'public_ghl',
    operationId,
    boundLocationId: LOCATION_ID,
    requestedWindow: { from: COLLECTION_FROM, to: CUTOFF },
    appliedWindow: { from: COLLECTION_FROM, to: CUTOFF },
    capturedAt,
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

/** The four public reads the shipped `grom_internal` projection declares, captured AFTER the cutoff. */
function collections({ contactsCapturedAt = CAPTURED_AT } = {}) {
  const compact = (fn) => SUBJECTS.map((subject, index) => fn(subject, index + 1)).filter(Boolean);
  return [
    scope('contacts.search', compact(contactItem), contactsCapturedAt),
    scope('conversations-v3__search-conversation', compact(conversationItem), CAPTURED_AT),
    scope('calendars-v3__get-calendar-events', compact(appointmentItem), CAPTURED_AT),
    scope('opportunities.list', compact(opportunityItem), CAPTURED_AT),
  ];
}

function buildGraph(options) {
  const context = { locationId: LOCATION_ID };
  const projected = projectJourneyEvents({
    collections: collections(options),
    context,
    profile: PROFILE,
    projection: PROJECTION,
  });
  return {
    graph: buildEvidenceGraph({
      records: normalizeEvidence(projected, context),
      context,
      profile: PROFILE,
    }),
    projected,
  };
}

function windows({ capturedThrough } = {}) {
  return buildWindows({
    cutoff: CUTOFF, timezone: TIMEZONE, maturityDays: 0, ...(capturedThrough ? { capturedThrough } : {}),
  });
}

test('the capture horizon does not move any window', () => {
  const withoutHorizon = windows();
  const withHorizon = windows({ capturedThrough: CAPTURED_AT });
  for (const name of [
    'currentClosedWeek', 'previousClosedWeek', 'trailing28Days',
    'trailing60Days', 'trailing90Days', 'trailing180Days',
  ]) {
    assert.deepEqual(
      withHorizon[name],
      withoutHorizon[name],
      `${name} must be decided by the EVENT cutoff alone`,
    );
  }
  assert.equal(withHorizon.cutoff, withoutHorizon.cutoff);
  assert.equal(withHorizon.matureAsOf, withoutHorizon.matureAsOf);
  // Undeclared, it degrades to the cutoff — which is exactly the value that produced the all-zero
  // run, and which the refusal below now makes impossible to publish.
  assert.equal(withoutHorizon.capturedThrough, withoutHorizon.cutoff);
  assert.equal(withHorizon.capturedThrough, '2026-07-27T07:12:45.385+01:00[Europe/London]');
});

test('a run captured after its own cutoff measures the account it collected', () => {
  const { graph, projected } = buildGraph();

  // The chain up to the metric layer was never in doubt on the live run, and is not here either.
  assert.equal(
    projected.reduce((total, envelope) => total + envelope.projection.emittedCount, 0) > 0,
    true,
  );
  assert.equal(graph.conflicts.length, 0, 'the synthetic identities are unambiguous');
  assert.equal(graph.unresolvedJoins.length, 0);

  const result = computeJourneyMetrics({
    graph,
    metricContracts: CONTRACTS,
    windows: windows({ capturedThrough: CAPTURED_AT }),
  });

  // ---- enquiry -> contacted, 2-day lag. Every subject entered in May, so nothing is immature.
  const contacted = result.metrics.trailing90Days.enquiry_to_contacted;
  assert.equal(contacted.state, 'OBSERVED');
  assert.equal(contacted.eligible, ENQUIRIES);
  assert.equal(contacted.excluded, 0);
  assert.equal(contacted.immature, 0);
  assert.equal(contacted.denominator, ENQUIRIES);
  assert.equal(contacted.numerator, CONTACTED_IN_LAG);
  assert.equal(contacted.rate, CONTACTED_IN_LAG / ENQUIRIES);
  assert.equal(
    contacted.eligible,
    contacted.excluded + contacted.immature + contacted.denominator,
    'the population must partition exactly',
  );

  // ---- strategy_call -> showed, 14-day lag.
  const showed = result.metrics.trailing90Days.strategy_call_to_showed;
  assert.equal(showed.state, 'OBSERVED');
  assert.equal(showed.eligible, APPOINTMENTS);
  assert.equal(showed.denominator, APPOINTMENTS);
  assert.equal(showed.numerator, SHOWED_IN_LAG);

  // ---- showed -> decision, 30-day lag, reported over the 60-day lookback.
  const decision = result.metrics.trailing60Days.showed_to_decision_30d;
  assert.equal(decision.state, 'OBSERVED');
  assert.equal(decision.eligible, SHOWED_ENTRANTS);
  assert.equal(decision.denominator, SHOWED_ENTRANTS);
  assert.equal(decision.numerator, DECISIONS_IN_LAG);

  // ---- won -> collected_revenue is a VALUE measure: it publishes money, never a rate.
  const revenue = result.metrics.trailing90Days.won_to_collected_revenue;
  assert.equal(revenue.state, 'UNKNOWN');
  assert.equal(revenue.rate, null);
  assert.equal(revenue.value, WON_VALUE);
  assert.equal(revenue.valueSubjects, WON);
  assert.equal(revenue.eligible, WON);

  // ---- the cohort: entrants at the journey's ROOT stages, which are `enquiry` and `won`.
  assert.equal(
    result.cohorts.trailing90Days.journey_agency_new_business,
    ENQUIRIES + WON,
    'ten enquiries plus the one win, which is a root stage of no edge that consumes it',
  );

  // ---- the stock: every subject placed at its own latest event, ten subjects in all.
  const stock = result.currentStock.journey_agency_new_business;
  const placed = Object.values(stock).reduce((total, count) => total + count, 0);
  assert.equal(placed, SUBJECTS.length);
  assert.equal(stock.enquiry, 2, 'c09 and c10 were never contacted');
  assert.equal(stock.contacted, 2, 'c06 and c08 got no further');
  /*
   * 🔴 CHANGED 2026-07-31 and the old expectation was the bug, not the baseline.
   *
   * This used to assert `strategy_call === 2` with the comment "c04 no-showed and c05 was never
   * dispositioned" — the assertion itself recorded that a RECORDED no-show and an UNRESOLVED
   * appointment were being parked at the same stage, indistinguishable. That is precisely why the
   * agency's own show rate reported as unmeasurable: the projection emitted no `no_show` event, so
   * the edge had a numerator and no denominator.
   *
   * `appointment_no_show` now projects, so c04 (`noshow`) separates from c05 (`confirmed`).
   */
  assert.equal(stock.strategy_call, 1, 'only c05, whose appointment was never dispositioned');
  assert.equal(stock.no_show, 1, 'c04 no-showed, and that is now an observable disposition');
  assert.equal(stock.showed, 1, 'c03 showed and is still open');
  // c01's `decision`, `won` and `collected_revenue` all come off ONE record at ONE instant, so
  // which of the three it lands on is a tie-break and not a fact about the account. The three
  // stages together must therefore hold exactly the subjects that reached a decision: c01 (won),
  // c02 (lost after showing) and c07 (lost without ever booking a call).
  assert.equal(
    (stock.decision ?? 0) + (stock.won ?? 0) + (stock.collected_revenue ?? 0),
    3,
    'c01, c02 and c07 all reached a decision',
  );
});

test('a capture horizon that predates every piece of evidence is refused, not reported as zero', () => {
  const { graph } = buildGraph();
  // THE EXACT SHAPE OF THE LIVE DEFECT: the horizon left at the run's sealed cutoff, which every
  // collection necessarily post-dates. Before this was a refusal it returned a complete, sealed,
  // publishable report saying the agency had produced nothing.
  assert.throws(
    () => computeJourneyMetrics({ graph, metricContracts: CONTRACTS, windows: windows() }),
    (error) => error.code === 'METRICS_CAPTURE_HORIZON_PRECEDES_EVIDENCE',
  );
});

test('the refusal fires only when EVERY piece of evidence is beyond the horizon', () => {
  // One of the four reads captured before the cutoff, the other three after — the shape of a graph
  // merged across collections, which is the case the capture rule exists for.
  const { graph } = buildGraph({ contactsCapturedAt: '2026-07-20T06:00:00.000Z' });
  const result = computeJourneyMetrics({
    graph,
    metricContracts: CONTRACTS,
    windows: windows(),
  });
  const contacted = result.metrics.trailing90Days.enquiry_to_contacted;
  // The enquiries are visible; the conversations that would convert them are not yet read, so the
  // rate is an honest zero over a real population rather than a blank cell.
  assert.equal(contacted.state, 'OBSERVED');
  assert.equal(contacted.eligible, ENQUIRIES);
  assert.equal(contacted.numerator, 0);
  assert.equal(result.cohorts.trailing90Days.journey_agency_new_business, ENQUIRIES);
});

test('an account with no metric-bearing evidence at all is measured, not refused', () => {
  const context = { locationId: LOCATION_ID };
  const empty = [
    scope('contacts.search', [], CAPTURED_AT),
    scope('conversations-v3__search-conversation', [], CAPTURED_AT),
    scope('calendars-v3__get-calendar-events', [], CAPTURED_AT),
    scope('opportunities.list', [], CAPTURED_AT),
  ];
  const graph = buildEvidenceGraph({
    records: normalizeEvidence(
      projectJourneyEvents({
        collections: empty, context, profile: PROFILE, projection: PROJECTION,
      }),
      context,
    ),
    context,
    profile: PROFILE,
  });
  const result = computeJourneyMetrics({ graph, metricContracts: CONTRACTS, windows: windows() });
  assert.deepEqual(result.currentStock, {});
  assert.equal(result.metrics.trailing90Days.enquiry_to_contacted.eligible, 0);
  assert.equal(
    result.metrics.trailing90Days.enquiry_to_contacted.reasonCode,
    'NO_ELIGIBLE_POPULATION',
    'the reason code that was wrong for the live run is right for an account that really is empty',
  );
});

test('the live-run capture gap is a structural property of a weekly run, not an accident', () => {
  // `planWeeklyCollection` makes the collection window END at the run's sealed cutoff, so the
  // collection can only ever happen afterwards. This is asserted against the shipped planner so a
  // future change that decoupled the two would have to come here and say so.
  const source = readFileSync(join(here, '../lib/kernel.mjs'), 'utf8');
  assert.match(
    source,
    /to: new Date\(collectionPlan\.cutoff\)\.toISOString\(\)/u,
    'the collection window ends at the cutoff, so capturedAt always exceeds it',
  );
});
