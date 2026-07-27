import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { buildEvidenceGraph } from '../lib/evidence-graph.mjs';
import { projectJourneyEvents } from '../lib/journey-projection.mjs';
import { normalizeEvidence } from '../lib/normalize.mjs';
import {
  ProjectionContractSchema,
  loadProjection,
  validateProjectionForProfile,
} from '../schemas/v1.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const clientProfile = JSON.parse(readFileSync(join(here, '../profiles/client.v1.json'), 'utf8'));
const clientProjection = loadProjection('client');

/** Hand-stated, not read back from the profile the projector uses. */
const CLIENT_JOURNEY_ID = 'client_sales';
const CLIENT_JOURNEY_INSTANCE_ID = 'journey_client_sales';
const CONTEXT = Object.freeze({ locationId: 'LOC-CLIENT-1' });
const WINDOW = Object.freeze({ from: '2026-07-13T00:00:00.000Z', to: '2026-07-20T00:00:00.000Z' });
const CAPTURED_AT = '2026-07-20T01:00:00.000Z';

/**
 * Every count on a source envelope is passed in by the test, never derived from `items`. An earlier
 * agent on this project built a fixture whose declared totals were computed from the rows it was
 * about to serve, so its reconciliation could not fail. These are independent inputs.
 */
function sourceCollection({
  operationId,
  items,
  collectedCount,
  reportedCount,
  complete = true,
  incompleteReason,
  truncated = false,
  nextCursor = null,
  capturedAt = CAPTURED_AT,
}) {
  const collection = {
    source: 'public_ghl',
    operationId,
    boundLocationId: CONTEXT.locationId,
    requestedWindow: { ...WINDOW },
    appliedWindow: { ...WINDOW },
    capturedAt,
    items,
    page: {
      cursor: null,
      nextCursor,
      reportedCount,
      collectedCount,
      complete,
      truncated,
    },
  };
  if (!complete) collection.incompleteReason = incompleteReason;
  return collection;
}

function project(collections, profile = clientProfile, projection = clientProjection) {
  return projectJourneyEvents({
    collections,
    context: CONTEXT,
    profile,
    projection,
  });
}

function rawOpportunity(overrides = {}) {
  return {
    id: 'opp-1',
    contactId: 'contact-1',
    status: 'won',
    monetaryValue: 1200.5,
    lastStatusChangeAt: '2026-07-15T09:00:00.000Z',
    updatedAt: '2026-07-15T09:00:00.000Z',
    ...overrides,
  };
}

function rawContact(overrides = {}) {
  return {
    id: 'contact-1',
    email: 'Lead@Example.TEST',
    phone: '+44 20 7946 0000',
    dateAdded: '2026-07-13T08:00:00.000Z',
    ...overrides,
  };
}

function opportunityCollection(opportunity) {
  return sourceCollection({
    operationId: 'opportunities.list',
    items: [opportunity],
    collectedCount: 1,
    reportedCount: 1,
  });
}

function allItems(envelopes) {
  return envelopes.flatMap(({ items }) => items);
}

function suppressionCount(envelope, reason) {
  const entry = envelope.projection.suppressed.find((value) => value.reason === reason);
  return entry ? entry.count : 0;
}

function annotationCount(envelope, code) {
  const entry = envelope.projection.annotations.find((value) => value.code === code);
  return entry ? entry.count : 0;
}

// ---------------------------------------------------------------------------
// 1. Revenue never silently reads as zero
// ---------------------------------------------------------------------------

const REVENUE_STAGE = 'collected_revenue';

const NON_FINITE_REVENUES = [
  ['a string an engine wrote', { monetaryValue: '1200.50' }],
  ['null', { monetaryValue: null }],
  ['undefined', { monetaryValue: undefined }],
  ['an absent field', { monetaryValue: undefined, $delete: 'monetaryValue' }],
  ['NaN', { monetaryValue: Number.NaN }],
  ['a negative number', { monetaryValue: -50 }],
];

for (const [label, overrides] of NON_FINITE_REVENUES) {
  test(`revenue that is ${label} yields UNKNOWN with a reason and never a zero amount`, () => {
    const opportunity = rawOpportunity(overrides);
    if (overrides.$delete) delete opportunity[overrides.$delete];
    delete opportunity.$delete;

    const projected = project([opportunityCollection(opportunity)]);
    const revenueEvents = allItems(projected).filter(({ stage }) => stage === REVENUE_STAGE);
    assert.equal(revenueEvents.length, 1, 'the revenue event is still emitted, never dropped silently');
    const [revenue] = revenueEvents;
    assert.equal(revenue.classification, 'UNKNOWN');
    assert.equal(Object.hasOwn(revenue, 'revenueAmount'), false, 'no revenueAmount key at all');
    assert.ok(
      revenue.projectionReasons.includes('REVENUE_NOT_FINITE'),
      `a reason is recorded on the item: ${JSON.stringify(revenue.projectionReasons)}`,
    );
    assert.equal(annotationCount(projected[0], 'REVENUE_NOT_FINITE'), 1);

    const records = normalizeEvidence(projected, CONTEXT);
    const normalized = records.filter(({ stage }) => stage === REVENUE_STAGE);
    assert.equal(normalized.length, 1);
    assert.equal(normalized[0].classification, 'UNKNOWN');
    assert.equal(Object.hasOwn(normalized[0], 'revenueAmount'), false);
  });
}

test('a finite revenue value produces an OBSERVED revenue event carrying the exact amount', () => {
  const projected = project([opportunityCollection(rawOpportunity({ monetaryValue: 1200.5 }))]);
  const revenue = allItems(projected).find(({ stage }) => stage === REVENUE_STAGE);
  assert.equal(revenue.revenueAmount, 1200.5);
  assert.equal(Object.hasOwn(revenue, 'classification'), false, 'no downgrade is asserted');
  assert.equal(annotationCount(projected[0], 'REVENUE_NOT_FINITE'), 0);

  const records = normalizeEvidence(projected, CONTEXT);
  const normalized = records.find(({ stage }) => stage === REVENUE_STAGE);
  assert.equal(normalized.classification, 'OBSERVED');
  assert.equal(normalized.revenueAmount, 1200.5);
});

/**
 * TASK A2 ROUND 2 — THIS ASSERTION WAS INVERTED, DELIBERATELY, AND THE ORIGINAL IS QUOTED BELOW.
 *
 * It read:
 *
 *   test('a revenue value of exactly zero is OBSERVED, because zero collected is a real answer', () => {
 *     const projected = project([opportunityCollection(rawOpportunity({ monetaryValue: 0 }))]);
 *     const revenue = allItems(projected).find(({ stage }) => stage === REVENUE_STAGE);
 *     assert.equal(revenue.revenueAmount, 0);
 *     assert.equal(Object.hasOwn(revenue, 'classification'), false);
 *     const normalized = normalizeEvidence(projected, CONTEXT).find(({ stage }) => stage === REVENUE_STAGE);
 *     assert.equal(normalized.classification, 'OBSERVED');
 *   });
 *
 * "Zero collected is a real answer" is defensible in the abstract and wrong for a closed commercial
 * record on this platform, where the amount field is routinely left unfilled. Executed against the
 * shipped profile: five closed records, one priced at 12000 and four left at zero, published as
 * `OBSERVED 5/5, value 12000, excluded 0, coverage COMPLETE`. Four of the five contributed nothing
 * and NOTHING WAS DISCLOSED, because a never-filled amount and a genuine zero were indistinguishable.
 *
 * The reading is now PROFILE-DECLARED (`zeroAmountPolicy`) rather than hardcoded either way. Both
 * readings are proved: the default below, and the opt-in one in the test after it.
 *
 * ==========================================================================================
 * TASK A2 ROUND 3 — THE SAME TEST CHANGED A SECOND TIME, IN THE SAME SESSION. FLAGGED LOUDLY.
 *
 * The round-2 version, which stood for the length of one review round, read:
 *
 *   test('by default a revenue value of exactly zero is UNUSABLE, and is disclosed as such', () => {
 *     const projected = project([opportunityCollection(rawOpportunity({ monetaryValue: 0 }))]);
 *     const revenue = allItems(projected).find(({ stage }) => stage === REVENUE_STAGE);
 *     assert.equal(Object.hasOwn(revenue, 'revenueAmount'), false, 'never a fabricated zero amount');
 *     assert.equal(revenue.classification, 'UNKNOWN');
 *     assert.deepEqual(revenue.projectionReasons, ['REVENUE_ZERO_ON_OUTCOME_STAGE']);
 *     assert.equal(annotationCount(projected[0], 'REVENUE_ZERO_ON_OUTCOME_STAGE'), 1);
 *     const normalized = normalizeEvidence(projected, CONTEXT).find(({ stage }) => stage === REVENUE_STAGE);
 *     assert.equal(normalized.classification, 'UNKNOWN');
 *   });
 *
 * WHAT IS UNCHANGED, and is the whole point of both versions: a zero is not read as an amount, and
 * no fabricated zero collection reaches the output.
 *
 * WHAT CHANGED: WHERE the unusability lands. Emitting an UNKNOWN-classified event puts the
 * uncertainty on the SUBJECT — `metrics.mjs` taints every event of a subject that carries a
 * non-observed row — so a single unfilled amount field removed that subject from every appointment
 * metric as well. Measured A/B at one unpriced record in three: the appointment attendance edge
 * went `OBSERVED 7/14 coverage 1.000` -> `UNKNOWN COVERAGE_BELOW_FLOOR coverage 0.688`, and 6 of 10
 * OBSERVED cells in the run vanished, none of them about money. The unknown AMOUNT now suppresses
 * the AMOUNT-BEARING EVENT and nothing else.
 * ==========================================================================================
 */
test('by default a revenue value of exactly zero suppresses the AMOUNT and nothing else', () => {
  const projected = project([opportunityCollection(rawOpportunity({ monetaryValue: 0 }))]);
  const revenue = allItems(projected).find(({ stage }) => stage === REVENUE_STAGE);
  assert.equal(revenue, undefined, 'no fabricated zero amount, and no tainting UNKNOWN event');
  // Counted, never silent, and at emission unit: the row's other events are untouched.
  assert.equal(suppressionCount(projected[0], 'REVENUE_ZERO_ON_OUTCOME_STAGE'), 1);
  assert.equal(annotationCount(projected[0], 'REVENUE_ZERO_ON_OUTCOME_STAGE'), 0);
  const normalized = normalizeEvidence(projected, CONTEXT);
  assert.equal(normalized.some(({ stage }) => stage === REVENUE_STAGE), false);
  assert.equal(
    normalized.some(({ classification }) => classification === 'UNKNOWN'),
    false,
    'the subject stays fully trusted for every other edge',
  );
});

test('an account where zero IS a real answer declares it, and then zero is OBSERVED', () => {
  const permissive = structuredClone(clientProjection);
  permissive.zeroAmountPolicy = 'OBSERVED';
  const projected = project(
    [opportunityCollection(rawOpportunity({ monetaryValue: 0 }))],
    clientProfile,
    permissive,
  );
  const revenue = allItems(projected).find(({ stage }) => stage === REVENUE_STAGE);
  assert.equal(revenue.revenueAmount, 0);
  assert.equal(Object.hasOwn(revenue, 'classification'), false);
  const normalized = normalizeEvidence(projected, CONTEXT).find(({ stage }) => stage === REVENUE_STAGE);
  assert.equal(normalized.classification, 'OBSERVED');
});

// ---------------------------------------------------------------------------
// 2. journeyInstanceId comes from the coverage profile
// ---------------------------------------------------------------------------

test('journeyInstanceId is the profile-declared instance and never anything the raw record carries', () => {
  const forged = rawOpportunity({
    journeyId: 'forged_journey',
    journeyInstanceId: 'journey_forged_by_the_account',
  });
  const projected = project([opportunityCollection(forged)]);
  // SCOPED, not weakened: entity records are journey-less by construction, which the end-to-end
  // test below already states. Every source now yields the subjects its payload carries, so this
  // claim is about the JOURNEY EVENTS, exactly as it always was.
  const items = allItems(projected).filter(({ recordType }) => recordType === 'journey_event');
  assert.ok(items.length > 0);
  for (const item of items) {
    assert.equal(item.journeyId, CLIENT_JOURNEY_ID);
    assert.equal(item.journeyInstanceId, CLIENT_JOURNEY_INSTANCE_ID);
  }
});

test('a projection naming a journey the coverage profile does not declare is refused', () => {
  const undeclared = structuredClone(clientProjection);
  undeclared.sources[0].events[0].journeyId = 'a_journey_the_profile_never_declared';
  assert.throws(
    () => validateProjectionForProfile(clientProfile, undeclared),
    /PROJECTION_JOURNEY_UNDECLARED/,
  );
  assert.throws(
    () => project([sourceCollection({
      operationId: 'contacts.search',
      items: [rawContact()],
      collectedCount: 1,
      reportedCount: 1,
    })], clientProfile, undeclared),
    /PROJECTION_JOURNEY_UNKNOWN/,
  );
});

// ---------------------------------------------------------------------------
// 3. End to end through the real downstream
// ---------------------------------------------------------------------------

test('projected output survives normalizeEvidence and buildEvidenceGraph without JOURNEY_INSTANCE_INVALID', () => {
  const projected = project([
    sourceCollection({
      operationId: 'contacts.search',
      items: [rawContact(), rawContact({ id: 'contact-2', email: 'second@example.test', phone: '+44 20 7946 0001' })],
      collectedCount: 2,
      reportedCount: 2,
    }),
    sourceCollection({
      operationId: 'opportunities.list',
      items: [rawOpportunity()],
      collectedCount: 1,
      reportedCount: 1,
    }),
  ]);
  const records = normalizeEvidence(projected, CONTEXT);
  let graph = null;
  assert.doesNotThrow(() => {
    graph = buildEvidenceGraph({ records, context: CONTEXT, profile: clientProfile });
  });
  const instance = graph.nodes.find(({ type }) => type === 'journey_instance');
  assert.equal(instance.journeyInstanceId, CLIENT_JOURNEY_INSTANCE_ID);
  const journeyRecords = records.filter(({ recordType }) => recordType === 'journey_event');
  assert.ok(journeyRecords.length > 0, 'the fixture must produce journey events to assert on');
  assert.equal(
    journeyRecords.every(({ journeyInstanceId }) => (
      journeyInstanceId === CLIENT_JOURNEY_INSTANCE_ID
    )),
    true,
  );
  // Entity records are journey-less by construction; they must never carry a journey instance.
  assert.equal(
    records.filter(({ recordType }) => recordType !== 'journey_event')
      .every(({ journeyInstanceId }) => journeyInstanceId === undefined),
    true,
  );
});

// ---------------------------------------------------------------------------
// 4. Canonical event time
// ---------------------------------------------------------------------------

test('epoch millis, offset-bearing ISO and sub-second timestamps all canonicalize', () => {
  // 2026-07-14T00:00:00.000Z in epoch milliseconds, stated independently of any code here.
  const epochMillis = 1783987200000;
  const projected = project([sourceCollection({
    operationId: 'contacts.search',
    items: [
      rawContact({ id: 'contact-epoch', dateAdded: epochMillis }),
      rawContact({ id: 'contact-offset', dateAdded: '2026-07-15T10:00:00+00:00' }),
      rawContact({ id: 'contact-subsecond', dateAdded: '2026-07-16T10:00:00.123456Z' }),
    ],
    collectedCount: 3,
    reportedCount: 3,
  })]);
  const byNativeId = new Map(allItems(projected)
    .filter(({ recordType }) => recordType === 'journey_event')
    .map((item) => [item.nativeId, item]));
  assert.equal(byNativeId.get('contact-epoch').eventTime, '2026-07-14T00:00:00.000Z');
  assert.equal(byNativeId.get('contact-offset').eventTime, '2026-07-15T10:00:00.000Z');
  assert.equal(byNativeId.get('contact-subsecond').eventTime, '2026-07-16T10:00:00.123Z');
  for (const item of byNativeId.values()) {
    assert.equal(new Date(Date.parse(item.eventTime)).toISOString(), item.eventTime);
  }
});

test('an unparseable event time suppresses the event with a counted reason and never falls back to capturedAt', () => {
  const projected = project([sourceCollection({
    operationId: 'contacts.search',
    items: [
      rawContact({ id: 'contact-good', dateAdded: '2026-07-13T08:00:00.000Z' }),
      rawContact({ id: 'contact-bad', dateAdded: 'sometime last tuesday' }),
    ],
    collectedCount: 2,
    reportedCount: 2,
  })]);
  const [envelope] = projected;
  const journeyEvents = envelope.items.filter(({ recordType }) => recordType === 'journey_event');
  // Only the good contact yields a journey event; the bad timestamp suppresses the other.
  assert.equal(journeyEvents.length, 1);
  assert.equal(journeyEvents[0].nativeId, 'contact-good');
  assert.equal(suppressionCount(envelope, 'EVENT_TIME_UNPARSEABLE'), 1);
  // Identity is independent of the event time, so BOTH contacts must still yield an entity.
  // Losing the entity would silently destroy the identity join for that subject.
  assert.deepEqual(
    envelope.items
      .filter(({ recordType }) => recordType !== 'journey_event')
      .map(({ nativeId }) => nativeId)
      .sort(),
    ['contact-bad', 'contact-good'],
  );
  assert.notEqual(journeyEvents[0].eventTime, CAPTURED_AT);
  assert.equal(envelope.items.some(({ eventTime }) => eventTime === CAPTURED_AT), false);
  assert.doesNotThrow(() => normalizeEvidence(projected, CONTEXT));
});

// ---------------------------------------------------------------------------
// 5. Identity or nothing
// ---------------------------------------------------------------------------

test('a record with no usable identity is suppressed with a counted reason', () => {
  const projected = project([sourceCollection({
    operationId: 'opportunities.list',
    items: [{
      status: 'won',
      monetaryValue: 500,
      lastStatusChangeAt: '2026-07-15T09:00:00.000Z',
    }],
    collectedCount: 1,
    reportedCount: 1,
  })]);
  const [envelope] = projected;
  assert.equal(envelope.items.length, 0);
  assert.equal(suppressionCount(envelope, 'IDENTITY_UNRESOLVED'), 1);
  assert.equal(envelope.page.collectedCount, 0);
  assert.equal(envelope.page.reportedCount, 0);
});

// ---------------------------------------------------------------------------
// 6. Envelope counts under fan-out
// ---------------------------------------------------------------------------

test('one won opportunity fans out to three events and the envelope counts stay consistent', () => {
  const projected = project([opportunityCollection(rawOpportunity())]);
  assert.equal(projected.length, 1);
  const [envelope] = projected;
  // Hand-stated from profiles/client-projection.v1.json: opportunity_outcome, won, collected_revenue.
  assert.deepEqual(
    envelope.items
      .filter(({ recordType }) => recordType === 'journey_event')
      .map(({ stage }) => stage)
      .sort(),
    ['collected_revenue', 'opportunity_outcome', 'won'],
  );
  // Hand-stated: the three events above PLUS the one subject the payload carries. Every source
  // that can resolve a subject now yields it, so an opportunity row is evidence of the subject as
  // well as of what happened to it.
  assert.equal(envelope.items.length, 1 + 3);
  assert.equal(envelope.page.collectedCount, 1 + 3);
  assert.equal(envelope.page.reportedCount, 1 + 3);
  assert.equal(envelope.page.complete, true);
  assert.equal(envelope.page.truncated, false);
  assert.equal(envelope.page.nextCursor, null);
  assert.equal(Object.hasOwn(envelope, 'incompleteReason'), false);
  assert.equal(envelope.capturedAt, CAPTURED_AT);
  assert.deepEqual(envelope.requestedWindow, { ...WINDOW });
  assert.deepEqual(envelope.appliedWindow, { ...WINDOW });
  assert.equal(envelope.boundLocationId, CONTEXT.locationId);
  assert.doesNotThrow(() => normalizeEvidence(projected, CONTEXT));
});

// ---------------------------------------------------------------------------
// 7. Incompleteness propagates and is never laundered
// ---------------------------------------------------------------------------

test('an incomplete source envelope yields an incomplete projected envelope with the same reason', () => {
  const projected = project([sourceCollection({
    operationId: 'opportunities.list',
    items: [rawOpportunity()],
    collectedCount: 1,
    reportedCount: 1,
    complete: false,
    incompleteReason: 'BUDGET_MAXIMUM_PAGES',
    truncated: true,
    nextCursor: 'opaque-resume-cursor',
  })]);
  const [envelope] = projected;
  assert.equal(envelope.page.complete, false);
  assert.equal(envelope.incompleteReason, 'BUDGET_MAXIMUM_PAGES');
  assert.equal(envelope.page.truncated, true);
  assert.equal(envelope.page.nextCursor, 'opaque-resume-cursor');
  assert.equal(envelope.page.collectedCount, envelope.items.length);
  assert.equal(projected.some(({ page }) => page.complete === true), false);

  const records = normalizeEvidence(projected, CONTEXT);
  assert.equal(records.every(({ classification }) => classification === 'UNKNOWN'), true);
  assert.equal(
    records.every(({ provenance }) => provenance.incompleteReason === 'BUDGET_MAXIMUM_PAGES'),
    true,
  );
});

test('an incomplete source envelope that projects to nothing still cannot become complete', () => {
  const projected = project([sourceCollection({
    operationId: 'opportunities.list',
    items: [{ status: 'won', monetaryValue: 10 }],
    collectedCount: 1,
    reportedCount: 1,
    complete: false,
    incompleteReason: 'GHL_UPSTREAM_TIMEOUT',
  })]);
  const [envelope] = projected;
  assert.equal(envelope.items.length, 0);
  assert.equal(envelope.page.complete, false);
  assert.equal(envelope.incompleteReason, 'GHL_UPSTREAM_TIMEOUT');
  const records = normalizeEvidence(projected, CONTEXT);
  assert.equal(records.length, 1);
  assert.equal(records[0].recordType, 'collection_status');
  assert.equal(records[0].reason, 'GHL_UPSTREAM_TIMEOUT');
});

test('a collection matching no projection source keeps its own completeness rather than vanishing', () => {
  const projected = project([sourceCollection({
    operationId: 'pipelines-configuration',
    items: [{ id: 'pipeline-1', name: 'Sales' }],
    collectedCount: 1,
    reportedCount: 1,
    complete: false,
    incompleteReason: 'GHL_RESPONSE_SHAPE_UNRECOGNISED',
  })]);
  assert.equal(projected.length, 1);
  const [envelope] = projected;
  assert.equal(envelope.items.length, 0);
  assert.equal(envelope.page.complete, false);
  assert.equal(envelope.incompleteReason, 'GHL_RESPONSE_SHAPE_UNRECOGNISED');
  assert.equal(suppressionCount(envelope, 'COLLECTION_MATCHED_NO_PROJECTION_SOURCE'), 1);
  assert.equal(envelope.projection.sourceId, null);
});

// ---------------------------------------------------------------------------
// 8. Determinism
// ---------------------------------------------------------------------------

test('reversing collection order and item order yields byte-identical output', () => {
  const collections = [
    sourceCollection({
      operationId: 'contacts.search',
      items: [
        rawContact({ id: 'contact-1' }),
        rawContact({ id: 'contact-2', dateAdded: '2026-07-13T09:00:00.000Z' }),
        rawContact({ id: 'contact-3', dateAdded: 1783987200000 }),
      ],
      collectedCount: 3,
      reportedCount: 3,
    }),
    sourceCollection({
      operationId: 'conversations-v3__search-conversation',
      items: [
        { id: 'conv-1', contactId: 'contact-1', dateAdded: '2026-07-13T10:00:00.000Z' },
        { id: 'conv-2', contactId: 'contact-1', dateAdded: '2026-07-14T10:00:00.000Z' },
        { id: 'conv-3', contactId: 'contact-2', dateAdded: '2026-07-14T11:00:00.000Z' },
      ],
      collectedCount: 3,
      reportedCount: 3,
    }),
    sourceCollection({
      operationId: 'opportunities.list',
      items: [
        rawOpportunity(),
        rawOpportunity({ id: 'opp-2', contactId: 'contact-2', status: 'lost', monetaryValue: '900' }),
      ],
      collectedCount: 2,
      reportedCount: 2,
    }),
  ];
  const forward = project(structuredClone(collections));
  const reversedInput = structuredClone(collections).reverse();
  for (const collection of reversedInput) collection.items.reverse();
  const reversed = project(reversedInput);
  assert.equal(JSON.stringify(forward), JSON.stringify(reversed));
});

test('first-of-kind keeps exactly one event per identity and counts the rest as suppressed', () => {
  const projected = project([sourceCollection({
    operationId: 'conversations-v3__search-conversation',
    items: [
      { id: 'conv-1', contactId: 'contact-1', dateAdded: '2026-07-14T10:00:00.000Z' },
      { id: 'conv-2', contactId: 'contact-1', dateAdded: '2026-07-13T10:00:00.000Z' },
      { id: 'conv-3', contactId: 'contact-2', dateAdded: '2026-07-14T11:00:00.000Z' },
    ],
    collectedCount: 3,
    reportedCount: 3,
  })]);
  const [envelope] = projected;
  // SCOPED to the journey events: the same rows also yield their subjects now, and a subject is
  // not a first-of-kind candidate. The claim — one surviving EVENT per identity — is unchanged.
  const events = envelope.items.filter(({ recordType }) => recordType === 'journey_event');
  assert.equal(events.length, 2);
  assert.deepEqual(
    events.map(({ nativeId }) => nativeId).sort(),
    ['conv-2', 'conv-3'],
    'the earliest event per identity survives',
  );
  assert.equal(suppressionCount(envelope, 'NOT_FIRST_OF_KIND'), 1);
});

test('every emitted stage and cohort reference conforms to the evidence patterns', () => {
  const projected = project([
    sourceCollection({
      operationId: 'contacts.search',
      items: [rawContact()],
      collectedCount: 1,
      reportedCount: 1,
    }),
    sourceCollection({
      operationId: 'calendars-v3__get-calendar-events',
      items: [
        { id: 'appt-1', contactId: 'contact-1', appointmentStatus: 'showed', dateAdded: '2026-07-14T09:00:00.000Z', startTime: '2026-07-15T09:00:00.000Z' },
        { id: 'appt-2', contactId: 'contact-2', appointmentStatus: 'noshow', dateAdded: '2026-07-14T09:30:00.000Z', startTime: '2026-07-15T09:30:00.000Z' },
        { id: 'appt-3', contactId: 'contact-3', appointmentStatus: 'cancelled', dateAdded: '2026-07-14T10:00:00.000Z', dateUpdated: '2026-07-14T12:00:00.000Z' },
      ],
      collectedCount: 3,
      reportedCount: 3,
    }),
    sourceCollection({
      operationId: 'opportunities.list',
      items: [rawOpportunity()],
      collectedCount: 1,
      reportedCount: 1,
    }),
  ]);
  const items = allItems(projected);
  // Hand-stated, one term per SOURCE ROW, each row yielding its subject and then its events:
  // contact (1 entity + 1 stage), appt-1 (1 entity + booked, showed), appt-2 (1 entity + booked,
  // no_show), appt-3 (1 entity + booked, cancelled), opportunity (1 entity + opportunity_outcome,
  // won, collected_revenue). The entity terms are new: every source that can resolve a subject now
  // emits it, which is what lets the graph prove a subject the contacts payload never carried.
  assert.equal(items.length, (1 + 1) + (1 + 2) + (1 + 2) + (1 + 2) + (1 + 3));
  const journeyEvents = items.filter(({ recordType }) => recordType === 'journey_event');
  assert.equal(journeyEvents.length, 1 + 2 + 2 + 2 + 3);
  for (const item of journeyEvents) {
    assert.match(item.stage, /^[a-z][a-z0-9_]{0,127}$/u);
    assert.match(item.cohortInstanceRef, /^cohort_[a-z0-9_]{1,120}$/u);
  }
  // Entity records carry identity, never a stage or a cohort.
  for (const item of items.filter(({ recordType }) => recordType !== 'journey_event')) {
    assert.equal(item.stage, undefined);
    assert.equal(item.cohortInstanceRef, undefined);
    assert.ok(item.nativeId, 'an entity record must carry a native id');
  }
});

test('evidence references derived from projected items are stable and well formed', () => {
  const collections = [sourceCollection({
    operationId: 'opportunities.list',
    items: [rawOpportunity(), rawOpportunity({ id: 'opp-2', contactId: 'contact-2' })],
    collectedCount: 2,
    reportedCount: 2,
  })];
  const forward = normalizeEvidence(project(structuredClone(collections)), CONTEXT);
  const reversedInput = structuredClone(collections);
  for (const collection of reversedInput) collection.items.reverse();
  const reversed = normalizeEvidence(project(reversedInput), CONTEXT);
  assert.deepEqual(
    forward.map(({ evidenceRef }) => evidenceRef),
    reversed.map(({ evidenceRef }) => evidenceRef),
  );
  for (const record of forward) assert.match(record.evidenceRef, /^ev_[a-f0-9]{16,64}$/u);
});

// ---------------------------------------------------------------------------
// 9. Location binding
// ---------------------------------------------------------------------------

test('a nested foreign location id never leaks into a projected item', () => {
  const projected = project([opportunityCollection(rawOpportunity({
    locationId: 'SOME-OTHER-LOCATION',
    contact: { id: 'contact-9', email: 'Nested@Example.TEST', locationId: 'SOME-OTHER-LOCATION' },
    pipeline: { locationId: 'SOME-OTHER-LOCATION', stages: [{ ghlLocationId: 'SOME-OTHER-LOCATION' }] },
  }))]);
  const serialized = JSON.stringify(projected);
  assert.equal(serialized.includes('SOME-OTHER-LOCATION'), false);
  assert.doesNotThrow(() => normalizeEvidence(projected, CONTEXT));
  const items = allItems(projected);
  assert.ok(items.length > 0);
  for (const item of items) {
    for (const key of Object.keys(item)) {
      assert.equal(key.toLowerCase().replace(/[^a-z0-9]/gu, '').includes('locationid'), false);
    }
  }
});

test('a source collection bound to another location is refused outright', () => {
  const foreign = opportunityCollection(rawOpportunity());
  foreign.boundLocationId = 'SOME-OTHER-LOCATION';
  assert.throws(() => project([foreign]), /PROJECTION_LOCATION_MISMATCH/);
});

test('declared email and phone identity paths are normalized deterministically', () => {
  const projected = project([sourceCollection({
    operationId: 'contacts.search',
    items: [rawContact({ id: 'contact-norm', email: '  Lead@Example.TEST ', phone: '+44 (20) 7946-0000' })],
    collectedCount: 1,
    reportedCount: 1,
  })]);
  const [item] = allItems(projected);
  assert.equal(item.normalizedEmail, 'lead@example.test');
  assert.equal(item.normalizedPhone, '+442079460000');
});

// ---------------------------------------------------------------------------
// 10. The mapping is DATA, not code
// ---------------------------------------------------------------------------

const PROJECTOR_SOURCE = readFileSync(join(here, '../lib/journey-projection.mjs'), 'utf8');
const CLIENT_PROJECTION_TEXT = readFileSync(join(here, '../profiles/client-projection.v1.json'), 'utf8');
const GROM_PROJECTION_TEXT = readFileSync(join(here, '../profiles/grom-internal-projection.v1.json'), 'utf8');
const PROJECTION_DATA_TEXT = `${CLIENT_PROJECTION_TEXT}\n${GROM_PROJECTION_TEXT}`;

/** Stage names. Every one of these lives in the shipped projection DATA and in no line of code. */
const STAGE_WORDS = Object.freeze([
  'lead_created', 'first_engagement', 'booked', 'showed', 'no_show', 'cancelled',
  'opportunity_outcome', 'won', 'collected_revenue', 'enquiry', 'contacted',
  'strategy_call', 'decision',
]);
/** Stage names the shipped profiles do not use yet, which code still may never contain. */
const RESERVED_STAGE_WORDS = Object.freeze(['qualified', 'lost', 'rebooked', 'reactivated']);
/** Raw GHL field names and values. Also data-only. */
const ACCOUNT_LITERALS = Object.freeze([
  'monetaryValue', 'appointmentStatus', 'contactId', 'dateAdded', 'dateUpdated',
  'lastMessageDate', 'lastStatusChangeAt', 'noshow', 'abandoned', 'status',
  'opportunity_monetary_value', 'contacts-', 'opportunities-',
  'conversations-', 'appointments-',
]);
/**
 * A legal `revenueBasis` neither shipped profile selects today, so it cannot be part of the
 * not-vacuous check below, but the projector must still never name it.
 */
const UNUSED_REVENUE_BASIS = 'payments';

test('the projector contains no GHL-account-specific literal', () => {
  for (const word of [...STAGE_WORDS, ...RESERVED_STAGE_WORDS]) {
    assert.equal(
      new RegExp(`\\b${word}\\b`, 'iu').test(PROJECTOR_SOURCE),
      false,
      `lib/journey-projection.mjs must not contain the stage name "${word}"`,
    );
  }
  for (const literal of [...ACCOUNT_LITERALS, UNUSED_REVENUE_BASIS]) {
    assert.equal(
      PROJECTOR_SOURCE.includes(literal),
      false,
      `lib/journey-projection.mjs must not contain the account literal "${literal}"`,
    );
  }
});

test('the forbidden literals are not vacuous: they all live in the shipped projection data', () => {
  for (const word of STAGE_WORDS) {
    assert.equal(
      new RegExp(`\\b${word}\\b`, 'u').test(PROJECTION_DATA_TEXT),
      true,
      `"${word}" must actually appear in the shipped projection profiles`,
    );
  }
  for (const literal of ACCOUNT_LITERALS) {
    assert.equal(
      PROJECTION_DATA_TEXT.includes(literal),
      true,
      `"${literal}" must actually appear in the shipped projection profiles`,
    );
  }
});

// ---------------------------------------------------------------------------
// 11. The projection contract itself
// ---------------------------------------------------------------------------

test('both shipped projection contracts load, validate and declare their revenue basis', () => {
  for (const profileId of ['client', 'grom_internal']) {
    const projection = loadProjection(profileId);
    assert.equal(projection.version, '1.0.0');
    assert.equal(projection.profileId, profileId);
    assert.equal(projection.revenueBasis, 'opportunity_monetary_value');
    assert.ok(projection.sources.length > 0);
  }
  assert.throws(() => loadProjection('nope'), /UNKNOWN_PROJECTION_PROFILE/);
});

test('the projection contract is strict about stages, predicates, patterns and revenue basis', () => {
  const valid = structuredClone(clientProjection);
  assert.equal(ProjectionContractSchema.parse(valid).sources.length, valid.sources.length);

  const payments = structuredClone(valid);
  payments.revenueBasis = 'payments';
  assert.equal(ProjectionContractSchema.parse(payments).revenueBasis, 'payments');

  const badBasis = structuredClone(valid);
  badBasis.revenueBasis = 'whatever_the_account_felt_like';
  assert.throws(() => ProjectionContractSchema.parse(badBasis));

  const badStage = structuredClone(valid);
  badStage.sources[0].events[0].stage = 'Not A Stage';
  assert.throws(() => ProjectionContractSchema.parse(badStage));

  const badPredicate = structuredClone(valid);
  badPredicate.sources[0].events[0].when = { kind: 'javascript', body: 'return true' };
  assert.throws(() => ProjectionContractSchema.parse(badPredicate));

  const regexPattern = structuredClone(valid);
  regexPattern.sources[0].operationIdPattern = '^(a+)+$';
  assert.throws(() => ProjectionContractSchema.parse(regexPattern));

  const extraKey = structuredClone(valid);
  extraKey.sources[0].unexpected = true;
  assert.throws(() => ProjectionContractSchema.parse(extraKey));

  const unusableIdentity = structuredClone(valid);
  unusableIdentity.sources[0].identity = { nativeId: ['id'] };
  assert.throws(() => ProjectionContractSchema.parse(unusableIdentity));

  const mismatched = structuredClone(valid);
  mismatched.profileId = 'grom_internal';
  assert.throws(
    () => validateProjectionForProfile(clientProfile, mismatched),
    /PROFILE_PROJECTION_MISMATCH/,
  );
});

test('the projector reports the declared revenue basis rather than assuming one', () => {
  const projected = project([opportunityCollection(rawOpportunity())]);
  assert.equal(projected[0].projection.revenueBasis, 'opportunity_monetary_value');

  const paymentsBasis = structuredClone(clientProjection);
  paymentsBasis.revenueBasis = 'payments';
  const other = project([opportunityCollection(rawOpportunity())], clientProfile, paymentsBasis);
  assert.equal(other[0].projection.revenueBasis, 'payments');
});

test('projected output is deeply frozen', () => {
  const projected = project([opportunityCollection(rawOpportunity())]);
  assert.equal(Object.isFrozen(projected), true);
  assert.equal(Object.isFrozen(projected[0]), true);
  assert.equal(Object.isFrozen(projected[0].items[0]), true);
  assert.equal(Object.isFrozen(projected[0].page), true);
});

test('malformed projector input is refused with a coded error', () => {
  assert.throws(() => projectJourneyEvents({
    collections: [],
    context: CONTEXT,
    profile: clientProfile,
    projection: clientProjection,
  }), /PROJECTION_INPUT_INVALID/);
  assert.throws(() => projectJourneyEvents({
    collections: [opportunityCollection(rawOpportunity())],
    context: {},
    profile: clientProfile,
    projection: clientProjection,
  }), /PROJECTION_INPUT_INVALID/);
  assert.throws(() => projectJourneyEvents({
    collections: [opportunityCollection(rawOpportunity())],
    context: CONTEXT,
    profile: { journeys: 'no' },
    projection: clientProjection,
  }), /PROJECTION_INPUT_INVALID/);
  assert.throws(() => projectJourneyEvents({
    collections: [opportunityCollection(rawOpportunity())],
    context: CONTEXT,
    profile: clientProfile,
    projection: { sources: [] },
  }), /PROJECTION_INPUT_INVALID/);

  const incompleteWithoutReason = opportunityCollection(rawOpportunity());
  incompleteWithoutReason.page.complete = false;
  assert.throws(
    () => project([incompleteWithoutReason]),
    /PROJECTION_SOURCE_COLLECTION_INVALID/,
  );
});
