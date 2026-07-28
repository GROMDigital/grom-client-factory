/**
 * Regression tests for the defects two independent adversarial reviewers reproduced in the
 * Task A1 projector. One test per Critical and per Important, plus the cheap Minors.
 *
 * Every fixture count here is hand-stated. Nothing is read back from the code under test.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { buildEvidenceGraph } from '../lib/evidence-graph.mjs';
import { projectJourneyEvents } from '../lib/journey-projection.mjs';
import { buildWindows, computeJourneyMetrics } from '../lib/metrics.mjs';
import { normalizeEvidence } from '../lib/normalize.mjs';
import {
  ProjectionContractSchema,
  loadMetricContracts,
  loadProjection,
  loadPublicReadAllowlist,
  validateProjectionForProfile,
} from '../schemas/v1.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const clientProfile = JSON.parse(readFileSync(join(here, '../profiles/client.v1.json'), 'utf8'));
const clientProjection = loadProjection('client');
const allowlist = loadPublicReadAllowlist();

/** Hand-stated. Not read back from any profile the code under test consumes. */
const CONTEXT = Object.freeze({ locationId: 'LOC-DEFECT-1' });
const WINDOW = Object.freeze({ from: '2026-07-06T00:00:00.000Z', to: '2026-07-27T00:00:00.000Z' });
const CAPTURED_AT = '2026-07-20T01:00:00.000Z';
const CLIENT_JOURNEY_INSTANCE_ID = 'journey_client_sales';

/** The REAL allowlist action ids the public rail emits as `operationId` (public-ghl.mjs:555). */
const CONTACTS_ACTION = 'contacts.search';
const CONVERSATIONS_ACTION = 'conversations-v3__search-conversation';
const APPOINTMENTS_ACTION = 'calendars-v3__get-calendar-events';
const OPPORTUNITIES_ACTION = 'opportunities.list';

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
  boundLocationId = CONTEXT.locationId,
}) {
  const collection = {
    source: 'public_ghl',
    operationId,
    boundLocationId,
    requestedWindow: { ...WINDOW },
    appliedWindow: { ...WINDOW },
    capturedAt,
    items,
    page: { cursor: null, nextCursor, reportedCount, collectedCount, complete, truncated },
  };
  if (!complete) collection.incompleteReason = incompleteReason;
  return collection;
}

function project(collections, profile = clientProfile, projection = clientProjection) {
  return projectJourneyEvents({ collections, context: CONTEXT, profile, projection });
}

function allItems(envelopes) {
  return envelopes.flatMap(({ items }) => items);
}

function suppressionEntry(envelope, reason) {
  return envelope.projection.suppressed.find((value) => value.reason === reason) ?? null;
}

function suppressionCount(envelope, reason) {
  return suppressionEntry(envelope, reason)?.count ?? 0;
}

function patternMatchesLocally(pattern, text) {
  const literal = pattern
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'))
    .join('.*');
  return new RegExp(`^${literal}$`, 'u').test(text);
}

// ===========================================================================
// CRITICAL 1 — the projector must be able to emit ENTITY records, so the graph
// can build `identity_exact` edges and metrics can leave UNKNOWN.
// ===========================================================================

/** A realistic, coherent, multi-subject account week. All counts hand-stated below. */
function acceptanceCollections() {
  return [
    sourceCollection({
      operationId: CONTACTS_ACTION,
      items: [
        { id: 'c1', email: 'one@example.test', phone: '+44 20 7946 0001', dateAdded: '2026-07-13T08:00:00.000Z' },
        { id: 'c2', email: 'two@example.test', phone: '+44 20 7946 0002', dateAdded: '2026-07-13T09:00:00.000Z' },
        { id: 'c3', email: 'three@example.test', phone: '+44 20 7946 0003', dateAdded: '2026-07-14T08:00:00.000Z' },
      ],
      collectedCount: 3,
      reportedCount: 3,
    }),
    sourceCollection({
      operationId: CONVERSATIONS_ACTION,
      items: [
        { id: 'v1', contactId: 'c1', dateAdded: '2026-07-13T10:00:00.000Z' },
        { id: 'v2', contactId: 'c2', dateAdded: '2026-07-13T11:00:00.000Z' },
      ],
      collectedCount: 2,
      reportedCount: 2,
    }),
    sourceCollection({
      operationId: APPOINTMENTS_ACTION,
      items: [
        {
          id: 'a1',
          contactId: 'c1',
          appointmentStatus: 'showed',
          dateAdded: '2026-07-14T09:00:00.000Z',
          startTime: '2026-07-15T09:00:00.000Z',
        },
      ],
      collectedCount: 1,
      reportedCount: 1,
    }),
    sourceCollection({
      operationId: OPPORTUNITIES_ACTION,
      items: [
        {
          id: 'o1',
          contactId: 'c1',
          status: 'won',
          monetaryValue: 2500,
          lastStatusChangeAt: '2026-07-16T09:00:00.000Z',
        },
      ],
      collectedCount: 1,
      reportedCount: 1,
    }),
  ];
}

test('CRITICAL 1 — the projector emits entity records the evidence graph can key identities on', () => {
  const projected = project(acceptanceCollections());
  const entities = allItems(projected).filter(({ recordType }) => recordType === 'contact');
  // SCOPED to the contacts payload: every source now yields the subjects it can resolve, so the
  // whole-run entity count is no longer three. The original claim — three raw subjects in the
  // contacts payload, one entity record each — is asserted exactly, on that payload's envelope.
  const contactsEnvelope = projected.find(({ operationId }) => operationId === CONTACTS_ACTION);
  assert.equal(
    contactsEnvelope.items.filter(({ recordType }) => recordType === 'contact').length,
    3,
    'the shipped client projection must declare entity emission',
  );
  assert.ok(entities.length >= 3, 'the shipped client projection must declare entity emission');
  for (const entity of entities) {
    assert.equal(typeof entity.nativeId, 'string');
    assert.ok(entity.nativeId.length > 0);
  }
});

test('CRITICAL 1 — the REAL chain yields identity_exact edges and a genuinely OBSERVED metric', () => {
  const projected = project(acceptanceCollections());
  const records = normalizeEvidence(projected, CONTEXT);
  const graph = buildEvidenceGraph({ records, context: CONTEXT, profile: clientProfile });

  const identityEdges = graph.edges.filter(({ type }) => type === 'identity_exact');
  assert.ok(
    identityEdges.length > 0,
    `the graph must be able to prove identity joins, got edge types ${
      JSON.stringify([...new Set(graph.edges.map(({ type }) => type))])
    }`,
  );
  assert.equal(graph.conflicts.length, 0, JSON.stringify(graph.conflicts));
  assert.equal(graph.unresolvedJoins.length, 0, JSON.stringify(graph.unresolvedJoins));

  // A2 has not landed, so MAPPED is forced on a COPY. The shipped file is untouched.
  const shipped = loadMetricContracts('client');
  const mapped = {
    ...structuredClone(shipped),
    edges: structuredClone(shipped.edges)
      .filter(({ edgeId }) => edgeId === 'lead_created_to_first_engagement')
      .map((edge) => ({ ...edge, nativeMapping: 'MAPPED' })),
  };
  assert.equal(mapped.edges.length, 1, 'the edge under test must exist in the shipped contracts');

  const windows = buildWindows({
    cutoff: '2026-07-27T00:00:00.000Z',
    timezone: 'UTC',
    maturityDays: 1,
  });
  const { metrics } = computeJourneyMetrics({ graph, metricContracts: mapped, windows });

  const published = Object.values(metrics)
    .flatMap((byEdge) => Object.values(byEdge))
    .filter((metric) => metric.state === 'OBSERVED' && metric.denominator > 0);
  assert.ok(
    published.length > 0,
    `every metric was UNKNOWN or empty: ${JSON.stringify(metrics, null, 2)}`,
  );
  // Hand-stated from the fixture: 3 subjects created a lead, 2 of them were engaged inside the lag.
  const week = metrics.previousClosedWeek.lead_created_to_first_engagement;
  assert.equal(week.state, 'OBSERVED');
  assert.equal(week.denominator, 3);
  assert.equal(week.numerator, 2);
});

test('CRITICAL 1 — duplicate identity detection can now actually fire', () => {
  const projected = project([sourceCollection({
    operationId: CONTACTS_ACTION,
    items: [
      { id: 'c1', email: 'shared@example.test', dateAdded: '2026-07-13T08:00:00.000Z' },
      { id: 'c2', email: 'shared@example.test', dateAdded: '2026-07-13T09:00:00.000Z' },
    ],
    collectedCount: 2,
    reportedCount: 2,
  })]);
  const records = normalizeEvidence(projected, CONTEXT);
  const graph = buildEvidenceGraph({ records, context: CONTEXT, profile: clientProfile });
  assert.equal(
    graph.conflicts.filter(({ type }) => type === 'duplicate_identity_claim').length,
    1,
    'two native ids sharing one address must be reported as a duplicate identity claim',
  );
});

// ===========================================================================
// CRITICAL 2 — the shipped source patterns must route real endpoints, and a
// pattern that routes nothing (or routes across categories) must be refused.
// ===========================================================================

test('CRITICAL 2 — every shipped source pattern matches at least one real allowlist action', () => {
  for (const profileId of ['client', 'grom_internal']) {
    const projection = loadProjection(profileId);
    for (const source of projection.sources) {
      const matched = allowlist.actions.filter(
        ({ actionId }) => patternMatchesLocally(source.operationIdPattern, actionId),
      );
      assert.ok(
        matched.length > 0,
        `${profileId}/${source.sourceId} pattern "${source.operationIdPattern}" matches no allowlist action`,
      );
      const categories = [...new Set(matched.map(({ category }) => category))];
      assert.equal(
        categories.length,
        1,
        `${profileId}/${source.sourceId} spans allowlist categories ${JSON.stringify(categories)}`,
      );
    }
  }
});

test('CRITICAL 2 — the real payload actions each route to exactly one shipped source', () => {
  const payloadActions = [
    CONTACTS_ACTION,
    CONVERSATIONS_ACTION,
    APPOINTMENTS_ACTION,
    OPPORTUNITIES_ACTION,
  ];
  for (const actionId of payloadActions) {
    assert.ok(
      allowlist.actions.some((action) => action.actionId === actionId),
      `${actionId} must exist in the public read allowlist`,
    );
    const matched = clientProjection.sources.filter(
      (source) => patternMatchesLocally(source.operationIdPattern, actionId),
    );
    assert.equal(matched.length, 1, `${actionId} must route to exactly one source`);
  }
});

test('CRITICAL 2 — pipeline definitions are never read as opportunity journey evidence', () => {
  const projected = project([sourceCollection({
    operationId: 'opportunities-v3__get-pipelines',
    items: [{ id: 'pipeline-1', name: 'Sales', stages: [{ id: 's1', name: 'New' }] }],
    collectedCount: 1,
    reportedCount: 1,
  })]);
  assert.equal(
    projected[0].items.filter(({ recordType }) => recordType === 'journey_event').length,
    0,
    'a pipeline definition payload must not project into journey events',
  );
  assert.equal(projected[0].projection.sourceId, null);
});

test('CRITICAL 2 — a projection whose pattern matches zero allowlist actions is refused', () => {
  const orphan = structuredClone(clientProjection);
  orphan.sources[0].operationIdPattern = 'this-endpoint-does-not-exist';
  assert.throws(
    () => validateProjectionForProfile(clientProfile, orphan),
    /PROJECTION_SOURCE_MATCHES_NO_ACTION/,
  );
});

test('CRITICAL 2 — a projection whose pattern spans allowlist categories is refused', () => {
  const spanning = structuredClone(clientProjection);
  // `contacts*` matches contacts.search (contacts) AND
  // contacts-v3__get-appointments-for-contact (appointments).
  spanning.sources[0].operationIdPattern = 'contacts*';
  assert.throws(
    () => validateProjectionForProfile(clientProfile, spanning),
    /PROJECTION_SOURCE_SPANS_CATEGORIES/,
  );
});

// ===========================================================================
// CRITICAL 3 — suppression from a COMPLETE envelope must survive normalizeEvidence.
// ===========================================================================

test('CRITICAL 3 — records suppressed out of a COMPLETE envelope leave a downstream trace', () => {
  // Forty genuinely won opportunities that the identity declaration cannot resolve.
  const dropped = Array.from({ length: 40 }, (_, index) => ({
    id: `orphan-${index}`,
    status: 'won',
    monetaryValue: 2500,
    lastStatusChangeAt: '2026-07-15T09:00:00.000Z',
  }));
  const noIdentity = structuredClone(clientProjection);
  for (const source of noIdentity.sources) {
    if (source.capability !== 'opportunities') continue;
    // The one wrong identity path from the reviewer's reproduction.
    source.identity = { subjectNativeId: ['ownerId'] };
  }

  const projected = project(
    [sourceCollection({
      operationId: OPPORTUNITIES_ACTION,
      items: dropped,
      collectedCount: 40,
      reportedCount: 40,
    })],
    clientProfile,
    noIdentity,
  );
  const payload = projected.find(({ projection }) => projection.inputItemCount === 40);
  assert.equal(payload.items.filter(({ recordType }) => recordType === 'journey_event').length, 0);
  assert.equal(payload.page.complete, true, 'the source envelope really was complete');
  assert.equal(suppressionCount(payload, 'IDENTITY_UNRESOLVED'), 40);

  const records = normalizeEvidence(projected, CONTEXT);
  const trace = records.filter((record) => (
    typeof record.reason === 'string' && record.reason.includes('IDENTITY_UNRESOLVED')
  ));
  assert.equal(trace.length, 1, `no suppression survived normalizeEvidence: ${
    JSON.stringify(records.map(({ recordType }) => recordType))
  }`);
  assert.equal(trace[0].suppressedCount, 40, 'the number of dropped records must survive too');

  const graph = buildEvidenceGraph({ records, context: CONTEXT, profile: clientProfile });
  assert.ok(
    graph.unresolvedJoins.some(({ reason }) => (
      typeof reason === 'string' && reason.includes('IDENTITY_UNRESOLVED')
    )),
    `the graph must carry the suppression: ${JSON.stringify(graph.unresolvedJoins)}`,
  );
});

test('CRITICAL 3 — the suppression trace does not by itself blank an unrelated journey', () => {
  // The deliberate trade-off: the marker is a collection-level signal, not an UNKNOWN-classified
  // journey record, so it reaches `unresolvedJoins` without escalating the whole journey.
  const collections = acceptanceCollections();
  collections.push(sourceCollection({
    operationId: OPPORTUNITIES_ACTION,
    items: [{ id: 'no-identity-here', status: 'won', monetaryValue: 10 }],
    collectedCount: 1,
    reportedCount: 1,
    capturedAt: '2026-07-20T02:00:00.000Z',
  }));
  const projected = project(collections);
  const records = normalizeEvidence(projected, CONTEXT);
  const graph = buildEvidenceGraph({ records, context: CONTEXT, profile: clientProfile });
  assert.ok(graph.unresolvedJoins.length > 0, 'the suppression is visible');
  const shipped = loadMetricContracts('client');
  const mapped = {
    ...structuredClone(shipped),
    edges: structuredClone(shipped.edges)
      .filter(({ edgeId }) => edgeId === 'lead_created_to_first_engagement')
      .map((edge) => ({ ...edge, nativeMapping: 'MAPPED' })),
  };
  const windows = buildWindows({
    cutoff: '2026-07-27T00:00:00.000Z',
    timezone: 'UTC',
    maturityDays: 1,
  });
  const { metrics } = computeJourneyMetrics({ graph, metricContracts: mapped, windows });
  assert.equal(metrics.previousClosedWeek.lead_created_to_first_engagement.state, 'OBSERVED');
});

// ===========================================================================
// CRITICAL 4a — the item sort must be a byte comparison with a total-order tiebreak.
// ===========================================================================

const COLLATION_IGNORABLE = Object.freeze([
  ['soft hyphen', '­'],
  ['zero width space', '​'],
  ['byte order mark', '﻿'],
  ['zero width non joiner', '‌'],
]);

for (const [label, character] of COLLATION_IGNORABLE) {
  test(`CRITICAL 4a — input order cannot leak through a ${label} in a sorted field`, () => {
    const collections = [sourceCollection({
      operationId: CONTACTS_ACTION,
      items: [
        { id: 'c1', email: `lead${character}@example.test`, dateAdded: '2026-07-13T08:00:00.000Z' },
        { id: 'c1', email: 'lead@example.test', dateAdded: '2026-07-13T08:00:00.000Z' },
      ],
      collectedCount: 2,
      reportedCount: 2,
    })];
    const forward = project(structuredClone(collections));
    const reversedInput = structuredClone(collections);
    for (const collection of reversedInput) collection.items.reverse();
    const reversed = project(reversedInput);
    assert.equal(JSON.stringify(forward), JSON.stringify(reversed));
  });
}

// ===========================================================================
// CRITICAL 4b — no host-timezone-dependent or magnitude-guessed instants.
// ===========================================================================

const AMBIGUOUS_INSTANTS = Object.freeze([
  ['a zone-free ISO datetime', '2026-07-15T09:00:00', 'EVENT_TIME_ZONE_UNSPECIFIED'],
  ['a zone-free space separated datetime', '2026-07-15 09:00:00', 'EVENT_TIME_ZONE_UNSPECIFIED'],
  ['a zone-free datetime with millis', '2026-07-15T09:00:00.000', 'EVENT_TIME_ZONE_UNSPECIFIED'],
  ['an epoch in seconds', 1783987200, 'EVENT_TIME_EPOCH_AMBIGUOUS'],
  ['the epoch itself', 0, 'EVENT_TIME_EPOCH_AMBIGUOUS'],
  ['a negative epoch', -1000, 'EVENT_TIME_EPOCH_AMBIGUOUS'],
  ['an epoch in seconds as text', '1783987200', 'EVENT_TIME_EPOCH_AMBIGUOUS'],
]);

for (const [label, value, reason] of AMBIGUOUS_INSTANTS) {
  test(`CRITICAL 4b — ${label} is refused rather than guessed, and counted`, () => {
    const projected = project([sourceCollection({
      operationId: CONTACTS_ACTION,
      items: [{ id: 'c-ambiguous', email: 'amb@example.test', dateAdded: value }],
      collectedCount: 1,
      reportedCount: 1,
    })]);
    const payload = projected.find(({ projection }) => projection.inputItemCount === 1);
    assert.equal(
      payload.items.filter(({ recordType }) => recordType === 'journey_event').length,
      0,
      `${JSON.stringify(value)} must not produce an event`,
    );
    assert.equal(suppressionCount(payload, reason), 1);
  });
}

test('CRITICAL 4b — accepted instants are identical whatever the host timezone claims', () => {
  // TZ is read at Date construction time, so flipping it inside the process is a real probe.
  const originalTz = process.env.TZ;
  const observed = [];
  try {
    for (const zone of ['UTC', 'Australia/Sydney', 'America/Los_Angeles']) {
      process.env.TZ = zone;
      const projected = project([sourceCollection({
        operationId: CONTACTS_ACTION,
        items: [
          { id: 'c-zulu', email: 'a@example.test', dateAdded: '2026-07-15T09:00:00.000Z' },
          { id: 'c-offset', email: 'b@example.test', dateAdded: '2026-07-15T19:00:00+10:00' },
          { id: 'c-millis', email: 'c@example.test', dateAdded: 1783987200000 },
        ],
        collectedCount: 3,
        reportedCount: 3,
      })]);
      observed.push(JSON.stringify(
        allItems(projected)
          .filter(({ recordType }) => recordType === 'journey_event')
          .map(({ nativeId, eventTime }) => [nativeId, eventTime])
          .sort(),
      ));
    }
  } finally {
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  }
  assert.equal(new Set(observed).size, 1, observed.join('\n'));
  // Hand-stated: both spellings name the same instant, and 1783987200000 is 2026-07-14T00:00:00Z.
  assert.ok(observed[0].includes('2026-07-15T09:00:00.000Z'));
  assert.ok(observed[0].includes('2026-07-14T00:00:00.000Z'));
});

// ===========================================================================
// IMPORTANT 5 — an invalid source envelope is refused, never repaired.
// ===========================================================================

test('IMPORTANT 5 — a complete envelope carrying resume state is refused, not rewritten', () => {
  const laundered = sourceCollection({
    operationId: OPPORTUNITIES_ACTION,
    items: [
      { id: 'o1', contactId: 'c1', status: 'won', monetaryValue: 10, lastStatusChangeAt: '2026-07-15T09:00:00.000Z' },
      { id: 'o2', contactId: 'c2', status: 'won', monetaryValue: 10, lastStatusChangeAt: '2026-07-15T09:00:00.000Z' },
    ],
    collectedCount: 2,
    reportedCount: 4000,
    complete: true,
    truncated: true,
    nextCursor: 'page-2',
  });
  assert.throws(() => project([laundered]), /PROJECTION_SOURCE_COLLECTION_INCOHERENT/);
});

test('IMPORTANT 5 — a complete envelope carrying an incompleteReason is refused', () => {
  const laundered = sourceCollection({
    operationId: OPPORTUNITIES_ACTION,
    items: [{ id: 'o1', contactId: 'c1', status: 'won', monetaryValue: 10, lastStatusChangeAt: '2026-07-15T09:00:00.000Z' }],
    collectedCount: 1,
    reportedCount: 1,
  });
  laundered.incompleteReason = 'BUDGET_MAXIMUM_PAGES';
  assert.throws(() => project([laundered]), /PROJECTION_SOURCE_COLLECTION_INCOHERENT/);
});

test('IMPORTANT 5 — an envelope whose collectedCount contradicts its rows is refused', () => {
  const miscounted = sourceCollection({
    operationId: OPPORTUNITIES_ACTION,
    items: [{ id: 'o1', contactId: 'c1', status: 'won', monetaryValue: 10, lastStatusChangeAt: '2026-07-15T09:00:00.000Z' }],
    collectedCount: 7,
    reportedCount: 7,
  });
  assert.throws(() => project([miscounted]), /PROJECTION_SOURCE_COLLECTION_INCOHERENT/);
});

// ===========================================================================
// IMPORTANT 6 — suppression counts are per record, carry their unit, and reconcile.
// ===========================================================================

test('IMPORTANT 6 — a collection matching no source counts every dropped record, not one', () => {
  const rows = Array.from({ length: 500 }, (_, index) => ({ id: `row-${index}` }));
  const projected = project([sourceCollection({
    operationId: 'payments-v3__list-orders',
    items: rows,
    collectedCount: 500,
    reportedCount: 500,
  })]);
  const payload = projected.find(({ projection }) => projection.inputItemCount === 500);
  assert.equal(suppressionCount(payload, 'COLLECTION_MATCHED_NO_PROJECTION_SOURCE'), 500);
});

test('IMPORTANT 6 — every suppression entry declares its unit and the record units reconcile', () => {
  const projected = project([
    sourceCollection({
      operationId: CONTACTS_ACTION,
      items: [
        { id: 'c-good', email: 'good@example.test', dateAdded: '2026-07-13T08:00:00.000Z' },
        { id: 'c-bad-time', email: 'bad@example.test', dateAdded: 'sometime last tuesday' },
        { email: '   ', phone: '   ', dateAdded: '2026-07-13T08:00:00.000Z' },
        'not an object at all',
      ],
      collectedCount: 4,
      reportedCount: 4,
    }),
    sourceCollection({
      operationId: CONVERSATIONS_ACTION,
      items: [
        { id: 'v1', contactId: 'c-good', dateAdded: '2026-07-13T10:00:00.000Z' },
        { id: 'v2', contactId: 'c-good', dateAdded: '2026-07-13T11:00:00.000Z' },
      ],
      collectedCount: 2,
      reportedCount: 2,
    }),
  ]);
  for (const envelope of projected) {
    let recordUnits = 0;
    for (const entry of envelope.projection.suppressed) {
      assert.ok(['record', 'emission'].includes(entry.unit), JSON.stringify(entry));
      if (entry.unit === 'record') recordUnits += entry.count;
    }
    assert.equal(
      envelope.projection.recordsWithEmissions + recordUnits,
      envelope.projection.inputItemCount,
      `record-unit suppressions must reconcile against inputItemCount: ${
        JSON.stringify(envelope.projection)
      }`,
    );
  }
});

// ===========================================================================
// IMPORTANT 7 — stages a metric edge consumes but the projection cannot emit
// must be declared unmeasurable, never silently published as a confident zero.
// ===========================================================================

test('IMPORTANT 7 — every unemittable metric edge is declared unmeasurable in the shipped data', () => {
  for (const profileId of ['client', 'grom_internal']) {
    const projection = loadProjection(profileId);
    const contracts = loadMetricContracts(profileId);
    const emitted = new Set(projection.sources.flatMap(
      (source) => (source.events ?? []).map(({ stage }) => stage),
    ));
    const declared = new Set(projection.unmeasurableEdges);
    for (const edge of contracts.edges) {
      const measurable = emitted.has(edge.fromStage) && emitted.has(edge.toStage);
      assert.equal(
        declared.has(edge.edgeId),
        !measurable,
        `${profileId}/${edge.edgeId}: measurable=${measurable} declared=${declared.has(edge.edgeId)}`,
      );
    }
  }
  // Hand-stated from the shipped files, independently of the loop above.
  assert.deepEqual([...loadProjection('client').unmeasurableEdges].sort(), [
    'cancelled_to_rebooked',
    'closed_to_reactivated',
    'first_engagement_to_qualified',
    'qualified_to_booked',
  ]);
});

test('IMPORTANT 7 — an unemittable edge that is NOT declared unmeasurable is refused', () => {
  const projection = structuredClone(clientProjection);
  projection.unmeasurableEdges = projection.unmeasurableEdges
    .filter((edgeId) => edgeId !== 'qualified_to_booked');
  assert.throws(
    () => validateProjectionForProfile(clientProfile, projection, loadMetricContracts('client')),
    /PROJECTION_EDGE_UNMEASURABLE_UNDECLARED/,
  );
});

test('IMPORTANT 7 — an edge declared unmeasurable can never be flipped to MAPPED', () => {
  const contracts = structuredClone(loadMetricContracts('client'));
  for (const edge of contracts.edges) {
    if (edge.edgeId === 'qualified_to_booked') edge.nativeMapping = 'MAPPED';
  }
  assert.throws(
    () => validateProjectionForProfile(clientProfile, clientProjection, contracts),
    /PROJECTION_UNMEASURABLE_EDGE_MAPPED/,
  );
});

test('IMPORTANT 7 — declaring a genuinely measurable edge unmeasurable is refused', () => {
  const projection = structuredClone(clientProjection);
  projection.unmeasurableEdges = [...projection.unmeasurableEdges, 'booked_to_showed'];
  assert.throws(
    () => validateProjectionForProfile(clientProfile, projection, loadMetricContracts('client')),
    /PROJECTION_EDGE_MEASURABLE_DECLARED_UNMEASURABLE/,
  );
});

// ===========================================================================
// IMPORTANT 8 — the schema layer must not block a third account profile.
// ===========================================================================

const THIRD_PROFILE = Object.freeze({
  profileId: 'third_account',
  version: '1.0.0',
  targetKind: 'location',
  excludedCapabilities: [],
  journeys: [{
    journeyId: 'trial_to_paid',
    journeyInstanceId: 'journey_trial_to_paid',
    entryRule: 'trial_started',
    denominator: 'trial_started',
    outcomes: ['activated', 'subscribed'],
  }],
});

function thirdProjection() {
  return {
    profileId: 'third_account',
    version: '1.0.0',
    revenueBasis: 'payments',
    suppressionSignal: { recordType: 'collection_status' },
    unmeasurableEdges: [],
    unprojectedActions: allowlist.actions
      .filter(({ actionId }) => ![CONTACTS_ACTION, CONVERSATIONS_ACTION].includes(actionId))
      .map(({ actionId }) => ({ actionId, reason: 'not read by this account profile' })),
    sources: [
      {
        sourceId: 'third_signups',
        capability: 'contacts',
        evidenceSource: 'public_ghl',
        operationIdPattern: CONTACTS_ACTION,
        identity: { nativeId: ['id'], subjectNativeId: ['id'], normalizedEmail: ['email'] },
        entities: [{ entityId: 'third_subject', recordType: 'contact', when: { kind: 'always' } }],
        events: [{
          eventId: 'third_trial_started',
          stage: 'trial_started',
          journeyId: 'trial_to_paid',
          eventTimeField: ['dateAdded'],
          when: { kind: 'always' },
          cohortFrom: ['id'],
        }],
      },
      {
        sourceId: 'third_activation',
        capability: 'conversations',
        evidenceSource: 'public_ghl',
        operationIdPattern: CONVERSATIONS_ACTION,
        identity: { subjectNativeId: ['contactId'] },
        // FIXTURE, not an assertion: a source that emits events must now also declare the subjects
        // its payload yields, or nothing it emits can ever be proven.
        entities: [{ entityId: 'third_activation_subject', recordType: 'contact', when: { kind: 'always' } }],
        events: [{
          eventId: 'third_activated',
          stage: 'activated',
          journeyId: 'trial_to_paid',
          eventTimeField: ['dateAdded'],
          when: { kind: 'first_of_kind' },
          cohortFrom: ['contactId'],
        }],
      },
    ],
  };
}

test('IMPORTANT 8 — a third account profile is accepted as JSON, with no code change', () => {
  const projection = thirdProjection();
  assert.doesNotThrow(() => ProjectionContractSchema.parse(projection));
  const validated = validateProjectionForProfile(THIRD_PROFILE, projection, {
    profileId: 'third_account',
    version: '1.0.0',
    edges: [{
      edgeId: 'trial_started_to_activated',
      journeyId: 'trial_to_paid',
      journeyInstanceId: 'journey_trial_to_paid',
      fromStage: 'trial_started',
      toStage: 'activated',
      eligibilityRule: {},
      fromEventFields: [],
      toEventFields: [],
      allowedLag: { amount: 7, unit: 'days' },
      maturityRule: {},
      dispositions: ['activated', 'not_activated', 'unknown'],
      reentryRule: 'new_journey_instance',
      outcomeRule: {},
      required: true,
      nativeMapping: 'UNKNOWN',
    }],
  });
  assert.equal(validated.profileId, 'third_account');

  const projected = projectJourneyEvents({
    collections: [sourceCollection({
      operationId: CONTACTS_ACTION,
      items: [{ id: 't1', email: 'trial@example.test', dateAdded: '2026-07-13T08:00:00.000Z' }],
      collectedCount: 1,
      reportedCount: 1,
    })],
    context: CONTEXT,
    profile: THIRD_PROFILE,
    projection,
  });
  const stages = allItems(projected)
    .filter(({ recordType }) => recordType === 'journey_event')
    .map(({ stage, journeyInstanceId }) => `${stage}@${journeyInstanceId}`);
  assert.deepEqual(stages, ['trial_started@journey_trial_to_paid']);
});

test('IMPORTANT 8 — the revenue basis vocabulary is open enough for a third profile but still closed', () => {
  const projection = thirdProjection();
  assert.equal(ProjectionContractSchema.parse(projection).revenueBasis, 'payments');
  assert.throws(() => ProjectionContractSchema.parse({
    ...projection,
    revenueBasis: 'whatever_the_account_felt_like',
  }));
});

// ===========================================================================
// MINOR — ambiguous and dead contract shapes.
// ===========================================================================

test('MINOR — a catch-all operationIdPattern is refused', () => {
  const greedy = structuredClone(clientProjection);
  greedy.sources[0].operationIdPattern = '*';
  assert.throws(
    () => validateProjectionForProfile(clientProfile, greedy),
    /PROJECTION_SOURCE_SPANS_CATEGORIES/,
  );
});

test('MINOR — two sources matching the same action are refused rather than silently ranked', () => {
  const duplicated = structuredClone(clientProjection);
  duplicated.sources.push({
    ...structuredClone(duplicated.sources[0]),
    sourceId: 'client_contacts_again',
    // A DIFFERENT pattern string that nevertheless matches the same allowlist action, so the
    // duplicate has to be caught by routing rather than by string equality.
    operationIdPattern: 'contacts.*',
    events: structuredClone(duplicated.sources[0].events)
      .map((event) => ({ ...event, eventId: `${event.eventId}_again`, stage: 'a_second_stage' })),
  });
  assert.throws(
    () => validateProjectionForProfile(clientProfile, duplicated),
    /PROJECTION_ACTION_MULTIPLY_MATCHED/,
  );
});

test('MINOR — two events emitting the same stage are refused', () => {
  const collided = structuredClone(clientProjection);
  const opportunities = collided.sources.find(({ capability }) => capability === 'opportunities');
  const contacts = collided.sources.find(({ capability }) => capability === 'contacts');
  opportunities.events[0].stage = contacts.events[0].stage;
  assert.throws(() => ProjectionContractSchema.parse(collided), /stage/iu);
});

test('MINOR — an allowlist action neither projected nor explicitly excluded is refused', () => {
  const partial = structuredClone(clientProjection);
  partial.unprojectedActions = partial.unprojectedActions.slice(1);
  assert.throws(
    () => validateProjectionForProfile(clientProfile, partial),
    /PROJECTION_ACTION_UNCLASSIFIED/,
  );
});

test('MINOR — a revenue amount may only be read on a declared journey outcome stage', () => {
  const misplaced = structuredClone(clientProjection);
  const appointments = misplaced.sources.find(({ capability }) => capability === 'appointments');
  appointments.events[0].revenueFrom = ['monetaryValue'];
  assert.throws(
    () => validateProjectionForProfile(clientProfile, misplaced),
    /PROJECTION_REVENUE_STAGE_NOT_AN_OUTCOME/,
  );
});

// ===========================================================================
// Location binding still holds for the new record kinds.
// ===========================================================================

test('entity records never carry a nested foreign location id', () => {
  const projected = project([sourceCollection({
    operationId: CONTACTS_ACTION,
    items: [{
      id: 'c1',
      email: 'one@example.test',
      dateAdded: '2026-07-13T08:00:00.000Z',
      locationId: 'SOME-OTHER-LOCATION',
      customFields: [{ ghlLocationId: 'SOME-OTHER-LOCATION' }],
    }],
    collectedCount: 1,
    reportedCount: 1,
  })]);
  assert.equal(JSON.stringify(projected).includes('SOME-OTHER-LOCATION'), false);
  assert.doesNotThrow(() => normalizeEvidence(projected, CONTEXT));
  assert.equal(
    allItems(projected).filter(({ recordType }) => recordType === 'contact').length,
    1,
  );
});

test('projected output is still deeply frozen once entity and signal records exist', () => {
  const projected = project(acceptanceCollections());
  assert.equal(Object.isFrozen(projected), true);
  for (const envelope of projected) {
    assert.equal(Object.isFrozen(envelope), true);
    assert.equal(Object.isFrozen(envelope.projection), true);
    for (const item of envelope.items) assert.equal(Object.isFrozen(item), true);
  }
});

test('reversing input order still yields byte-identical output with entities and signals', () => {
  const collections = acceptanceCollections();
  collections.push(sourceCollection({
    operationId: OPPORTUNITIES_ACTION,
    items: [{ id: 'no-identity', status: 'won', monetaryValue: 5 }],
    collectedCount: 1,
    reportedCount: 1,
    capturedAt: '2026-07-20T03:00:00.000Z',
  }));
  const forward = project(structuredClone(collections));
  const reversedInput = structuredClone(collections).reverse();
  for (const collection of reversedInput) collection.items.reverse();
  const reversed = project(reversedInput);
  assert.equal(JSON.stringify(forward), JSON.stringify(reversed));
});

// ###########################################################################
// ROUND 3 — defects two independent reviewers reproduced by EXECUTION against
// the round-2 projector. One test per defect, plus the mutation-surviving gaps.
// Every count below is hand-stated; nothing is read back from the code under test.
// ###########################################################################

/**
 * A deterministic permutation generator. No `Math.random`: the seed is the argument, so the same
 * call always shuffles the same way and a failure is reproducible from the seed alone.
 */
function seededShuffle(values, seed) {
  const output = [...values];
  let state = (seed >>> 0) || 1;
  const nextUnit = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
  for (let index = output.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(nextUnit() * (index + 1));
    const held = output[index];
    output[index] = output[swap];
    output[swap] = held;
  }
  return output;
}

/** Hand-stated from `metrics.mjs:190-197`, not imported: that function is not exported. */
function provingJoinExists(graph, nodeId) {
  return graph.edges.some(({ type, toNodeId, joinMethod, joinConfidence }) => (
    type === 'identity_exact'
      && toNodeId === nodeId
      && ['native_id', 'deterministic_composite'].includes(joinMethod)
      && joinConfidence === 'exact'
  ));
}

// ===========================================================================
// BLOCKER 1 — `first_of_kind` must resolve on CONTENT, never on input position.
// ===========================================================================

/** Two conversations for ONE subject sharing an instant to the millisecond. */
function tiedFirstOfKindCollections() {
  return [
    sourceCollection({
      operationId: CONTACTS_ACTION,
      items: [{ id: 'c1', email: 'one@example.test', dateAdded: '2026-07-13T08:00:00.000Z' }],
      collectedCount: 1,
      reportedCount: 1,
    }),
    sourceCollection({
      operationId: CONVERSATIONS_ACTION,
      items: [
        { id: 'v-alpha', contactId: 'c1', dateAdded: '2026-07-13T10:00:00.000Z' },
        { id: 'v-beta', contactId: 'c1', dateAdded: '2026-07-13T10:00:00.000Z' },
      ],
      collectedCount: 2,
      reportedCount: 2,
    }),
  ];
}

test('BLOCKER 1 — a first_of_kind tie is decided by content, so reversing the input cannot move it', () => {
  const forward = project(structuredClone(tiedFirstOfKindCollections()));
  const reversedInput = structuredClone(tiedFirstOfKindCollections()).reverse();
  for (const collection of reversedInput) collection.items.reverse();
  const reversed = project(reversedInput);
  assert.equal(
    JSON.stringify(forward),
    JSON.stringify(reversed),
    'a tie on eventTime must not be broken by the position of the row in the payload',
  );
  // Hand-stated: exactly one of the two tied conversations survives, in both directions.
  for (const projected of [forward, reversed]) {
    const survivors = allItems(projected)
      .filter(({ recordType, stage }) => recordType === 'journey_event' && stage === 'first_engagement')
      .map(({ nativeId }) => nativeId);
    assert.equal(survivors.length, 1, JSON.stringify(survivors));
  }
});

test('BLOCKER 1 — 400 deterministic permutations of a tied payload all produce the same bytes', () => {
  const baseline = JSON.stringify(project(structuredClone(tiedFirstOfKindCollections())));
  const violations = [];
  for (let seed = 1; seed <= 400; seed += 1) {
    const permuted = seededShuffle(structuredClone(tiedFirstOfKindCollections()), seed);
    for (const collection of permuted) {
      collection.items = seededShuffle(collection.items, seed * 31 + 7);
    }
    const observed = JSON.stringify(project(permuted));
    if (observed !== baseline) violations.push(seed);
  }
  assert.deepEqual(violations, [], `permutation seeds that changed the output: ${violations.join(',')}`);
});

// ===========================================================================
// BLOCKER 2 — every subject the payloads carry must be provable, and an
// unprovable subject must never be merely silent.
// ===========================================================================

/**
 * The extremely common shape: a subject created BEFORE the audit window, so the contacts payload
 * never carries it, whose appointment falls INSIDE the window.
 */
function subjectOnlyInAppointmentsCollections() {
  return [
    sourceCollection({
      operationId: CONTACTS_ACTION,
      items: [{ id: 'c1', email: 'one@example.test', dateAdded: '2026-07-13T08:00:00.000Z' }],
      collectedCount: 1,
      reportedCount: 1,
    }),
    sourceCollection({
      operationId: APPOINTMENTS_ACTION,
      items: [
        {
          id: 'a1',
          contactId: 'c1',
          appointmentStatus: 'showed',
          dateAdded: '2026-07-14T09:00:00.000Z',
          startTime: '2026-07-15T09:00:00.000Z',
        },
        {
          id: 'a9',
          contactId: 'c9',
          appointmentStatus: 'showed',
          dateAdded: '2026-07-14T10:00:00.000Z',
          startTime: '2026-07-15T10:00:00.000Z',
        },
      ],
      collectedCount: 2,
      reportedCount: 2,
    }),
  ];
}

test('BLOCKER 2 — every journey event the REAL chain emits carries a proving join', () => {
  const projected = project(subjectOnlyInAppointmentsCollections());
  const records = normalizeEvidence(projected, CONTEXT);
  const graph = buildEvidenceGraph({ records, context: CONTEXT, profile: clientProfile });

  const journeyNodes = graph.nodes.filter(({ type }) => type === 'journey_event');
  // Hand-stated: 1 lead_created + (booked, showed) for a1 + (booked, showed) for a9.
  assert.equal(journeyNodes.length, 5, JSON.stringify(journeyNodes.map(({ stage }) => stage)));
  const withoutProvingJoin = journeyNodes.filter(({ nodeId }) => !provingJoinExists(graph, nodeId));
  assert.deepEqual(
    withoutProvingJoin.map(({ stage, subjectNativeId }) => `${stage}:${subjectNativeId}`),
    [],
    'a subject that only ever appears in a non-contacts payload must still be provable',
  );
  assert.deepEqual(graph.unresolvedJoins, []);
  assert.deepEqual(graph.conflicts, []);
});

test('BLOCKER 2 — a subject reachable only through appointments still yields an OBSERVED metric', () => {
  const projected = project(subjectOnlyInAppointmentsCollections());
  const records = normalizeEvidence(projected, CONTEXT);
  const graph = buildEvidenceGraph({ records, context: CONTEXT, profile: clientProfile });
  const shipped = loadMetricContracts('client');
  // A2 has not landed, so MAPPED is forced on a COPY; the shipped file is untouched. The lag is
  // shortened on that same copy so the cohort is MATURE inside the fixture's cutoff — otherwise the
  // edge reads UNKNOWN for a maturity reason and says nothing about the join under test.
  const mapped = {
    ...structuredClone(shipped),
    edges: structuredClone(shipped.edges)
      .filter(({ edgeId }) => edgeId === 'booked_to_showed')
      .map((edge) => ({ ...edge, nativeMapping: 'MAPPED', allowedLag: { amount: 2, unit: 'days' } })),
  };
  assert.equal(mapped.edges.length, 1);
  const windows = buildWindows({ cutoff: '2026-07-27T00:00:00.000Z', timezone: 'UTC', maturityDays: 1 });
  const { metrics } = computeJourneyMetrics({ graph, metricContracts: mapped, windows });
  const week = metrics.previousClosedWeek.booked_to_showed;
  // Hand-stated: two subjects were booked inside the week, both of them were showed.
  assert.equal(week.state, 'OBSERVED', JSON.stringify(week));
  assert.equal(week.denominator, 2);
  assert.equal(week.numerator, 2);
});

test('BLOCKER 2 — an event for a subject with no entity record is never merely silent', () => {
  const withoutEntities = structuredClone(clientProjection);
  for (const source of withoutEntities.sources) {
    if (source.capability === 'appointments') delete source.entities;
  }
  const projected = project(subjectOnlyInAppointmentsCollections(), clientProfile, withoutEntities);
  const appointments = projected.find(({ operationId }) => operationId === APPOINTMENTS_ACTION);
  const unprovable = appointments.items.filter(({ recordType }) => recordType === 'journey_event')
    .filter(({ subjectNativeId }) => subjectNativeId === 'c9');
  // Hand-stated: booked and showed, both for the subject no payload can key.
  assert.equal(unprovable.length, 2);
  for (const item of unprovable) {
    assert.equal(item.classification, 'UNKNOWN');
    assert.ok(
      item.projectionReasons.includes('SUBJECT_ENTITY_UNRESOLVED'),
      JSON.stringify(item.projectionReasons),
    );
  }
  assert.equal(
    appointments.projection.annotations.find(({ code }) => code === 'SUBJECT_ENTITY_UNRESOLVED')?.count,
    2,
  );
  // The subject the contacts payload DOES carry stays observed.
  assert.equal(
    appointments.items.filter(({ subjectNativeId, classification }) => (
      subjectNativeId === 'c1' && classification === 'UNKNOWN'
    )).length,
    0,
  );
  const records = normalizeEvidence(projected, CONTEXT);
  const graph = buildEvidenceGraph({ records, context: CONTEXT, profile: clientProfile });
  assert.ok(
    graph.unresolvedJoins.some(({ reason }) => reason === 'SOURCE_CLASSIFICATION_UNKNOWN'),
    `the unprovable subject must reach the graph: ${JSON.stringify(graph.unresolvedJoins)}`,
  );
});

test('BLOCKER 2 — every shipped source that can supply an identity declares its entities', () => {
  for (const profileId of ['client', 'grom_internal']) {
    const projection = loadProjection(profileId);
    for (const source of projection.sources) {
      if ((source.events ?? []).length === 0) continue;
      assert.ok(
        (source.entities ?? []).length > 0,
        `${profileId}/${source.sourceId} emits events but declares no entity, so its subjects cannot be proven`,
      );
      assert.ok(
        Array.isArray(source.identity.subjectNativeId) && source.identity.subjectNativeId.length > 0,
        `${profileId}/${source.sourceId}: an entity record is keyed on the SUBJECT's native id`,
      );
    }
  }
});

// ===========================================================================
// BLOCKER 3 — the stage-coverage gate cannot be skipped by calling with two arguments.
// ===========================================================================

test('BLOCKER 3 — validating a projection without metric contracts is refused, not silently skipped', () => {
  assert.throws(
    () => validateProjectionForProfile(clientProfile, clientProjection),
    /PROJECTION_METRIC_CONTRACTS_REQUIRED/,
  );
  assert.throws(
    () => validateProjectionForProfile(clientProfile, clientProjection, null),
    /PROJECTION_METRIC_CONTRACTS_REQUIRED/,
  );
  // The three-argument form still accepts the shipped pair.
  assert.equal(
    validateProjectionForProfile(clientProfile, clientProjection, loadMetricContracts('client')).profileId,
    'client',
  );
});

// ===========================================================================
// NARROW 4 — the routing rules apply to sources of EVERY evidenceSource.
// ===========================================================================

const INTERNAL_PROFILE = Object.freeze({
  profileId: 'internal_only',
  version: '1.0.0',
  targetKind: 'location',
  excludedCapabilities: [],
  journeys: [{
    journeyId: 'internal_delivery',
    journeyInstanceId: 'journey_internal_delivery',
    entryRule: 'work_started',
    denominator: 'work_started',
    outcomes: ['work_delivered'],
  }],
});

const INTERNAL_CONTRACTS = Object.freeze({
  profileId: 'internal_only',
  version: '1.0.0',
  edges: [{
    edgeId: 'work_started_to_work_delivered',
    journeyId: 'internal_delivery',
    journeyInstanceId: 'journey_internal_delivery',
    fromStage: 'work_started',
    toStage: 'work_delivered',
    eligibilityRule: {},
    fromEventFields: [],
    toEventFields: [],
    allowedLag: { amount: 30, unit: 'days' },
    maturityRule: {},
    dispositions: ['delivered', 'not_delivered', 'unknown'],
    reentryRule: 'new_journey_instance',
    outcomeRule: {},
    required: true,
    nativeMapping: 'UNKNOWN',
  }],
});

function internalSource(sourceId, pattern, events) {
  return {
    sourceId,
    capability: 'internal_delivery',
    evidenceSource: 'internal_ghl',
    operationIdPattern: pattern,
    identity: { nativeId: ['subjectId'], subjectNativeId: ['subjectId'] },
    entities: [{ entityId: `${sourceId}_entity`, recordType: 'contact', when: { kind: 'always' } }],
    events,
  };
}

function internalEvent(eventId, stage) {
  return {
    eventId,
    stage,
    journeyId: 'internal_delivery',
    eventTimeField: ['occurredAt'],
    when: { kind: 'always' },
    cohortFrom: ['subjectId'],
  };
}

function internalProjection({ sources, classifyAllPublicActions = true }) {
  return {
    profileId: 'internal_only',
    version: '1.0.0',
    revenueBasis: 'none',
    suppressionSignal: { recordType: 'collection_status' },
    unmeasurableEdges: [],
    unprojectedActions: classifyAllPublicActions
      ? allowlist.actions.map(({ actionId }) => ({ actionId, reason: 'this profile reads no public payload' }))
      : [],
    sources,
  };
}

test('NARROW 4 — an internal-only projection that classifies no public action is refused', () => {
  const projection = internalProjection({
    sources: [internalSource('internal_work', 'internal.work.events', [
      internalEvent('internal_started', 'work_started'),
      internalEvent('internal_delivered', 'work_delivered'),
    ])],
    classifyAllPublicActions: false,
  });
  assert.throws(
    () => validateProjectionForProfile(INTERNAL_PROFILE, projection, INTERNAL_CONTRACTS),
    /PROJECTION_ACTION_UNCLASSIFIED/,
  );
});

test('NARROW 4 — a catch-all pattern is refused on a NON-public source too', () => {
  const projection = internalProjection({
    sources: [internalSource('internal_work', '*', [
      internalEvent('internal_started', 'work_started'),
      internalEvent('internal_delivered', 'work_delivered'),
    ])],
  });
  assert.throws(
    () => validateProjectionForProfile(INTERNAL_PROFILE, projection, INTERNAL_CONTRACTS),
    /PROJECTION_SOURCE_PATTERN_CATCH_ALL/,
  );
  const allWildcards = internalProjection({
    sources: [internalSource('internal_work', '**', [
      internalEvent('internal_started', 'work_started'),
      internalEvent('internal_delivered', 'work_delivered'),
    ])],
  });
  assert.throws(
    () => validateProjectionForProfile(INTERNAL_PROFILE, allWildcards, INTERNAL_CONTRACTS),
    /PROJECTION_SOURCE_PATTERN_CATCH_ALL/,
  );
});

test('NARROW 4 — two NON-public sources whose patterns can both match one id are refused', () => {
  const projection = internalProjection({
    sources: [
      internalSource('internal_work', 'internal.work.*', [internalEvent('internal_started', 'work_started')]),
      internalSource('internal_delivery', 'internal.*.events', [internalEvent('internal_delivered', 'work_delivered')]),
    ],
  });
  assert.throws(
    () => validateProjectionForProfile(INTERNAL_PROFILE, projection, INTERNAL_CONTRACTS),
    /PROJECTION_SOURCE_PATTERNS_OVERLAP/,
  );
});

test('NARROW 4 — two NON-public sources with disjoint patterns are accepted', () => {
  const projection = internalProjection({
    sources: [
      internalSource('internal_work', 'internal.work.events', [internalEvent('internal_started', 'work_started')]),
      internalSource('internal_delivery', 'internal.delivery.events', [internalEvent('internal_delivered', 'work_delivered')]),
    ],
  });
  assert.equal(
    validateProjectionForProfile(INTERNAL_PROFILE, projection, INTERNAL_CONTRACTS).sources.length,
    2,
  );
});

test('NARROW 4 — a catch-all on an internal source of a MIXED profile is refused', () => {
  const mixed = structuredClone(clientProjection);
  mixed.sources.push({
    sourceId: 'client_internal_catch_all',
    capability: 'internal_delivery',
    evidenceSource: 'internal_ghl',
    operationIdPattern: '*',
    identity: { nativeId: ['subjectId'], subjectNativeId: ['subjectId'] },
    entities: [{ entityId: 'client_internal_entity', recordType: 'contact', when: { kind: 'always' } }],
  });
  assert.throws(
    () => validateProjectionForProfile(clientProfile, mixed, loadMetricContracts('client')),
    /PROJECTION_SOURCE_PATTERN_CATCH_ALL/,
  );
});

// ===========================================================================
// NARROW 5 — the window and the capture instant are VALIDATED, never rebuilt.
// ===========================================================================

for (const field of ['requestedWindow', 'appliedWindow']) {
  test(`NARROW 5 — a source ${field} carrying an extra key is refused, not quietly rebuilt`, () => {
    const laundered = sourceCollection({
      operationId: OPPORTUNITIES_ACTION,
      items: [{ id: 'o1', contactId: 'c1', status: 'won', monetaryValue: 10, lastStatusChangeAt: '2026-07-15T09:00:00.000Z' }],
      collectedCount: 1,
      reportedCount: 1,
    });
    laundered[field] = { ...WINDOW, timezone: 'Australia/Sydney' };
    // `normalize.mjs:55-65` refuses this shape as an INPUT, so the projector must refuse it too
    // rather than emitting a clean two-key window that normalisation then accepts.
    assert.throws(() => normalizeEvidence([laundered], CONTEXT), /EVIDENCE_COLLECTION_INVALID/);
    assert.throws(() => project([laundered]), /PROJECTION_SOURCE_COLLECTION_INVALID/);
  });

  test(`NARROW 5 — a source ${field} whose bounds are not canonical instants is refused`, () => {
    const collection = sourceCollection({
      operationId: OPPORTUNITIES_ACTION,
      items: [{ id: 'o1', contactId: 'c1', status: 'won', monetaryValue: 10, lastStatusChangeAt: '2026-07-15T09:00:00.000Z' }],
      collectedCount: 1,
      reportedCount: 1,
    });
    collection[field] = { from: '2026-07-06', to: '2026-07-27T00:00:00.000Z' };
    assert.throws(() => project([collection]), /PROJECTION_SOURCE_COLLECTION_INVALID/);
  });
}

test('NARROW 5 — an applied window wider than the requested window is refused', () => {
  const collection = sourceCollection({
    operationId: OPPORTUNITIES_ACTION,
    items: [{ id: 'o1', contactId: 'c1', status: 'won', monetaryValue: 10, lastStatusChangeAt: '2026-07-15T09:00:00.000Z' }],
    collectedCount: 1,
    reportedCount: 1,
  });
  collection.appliedWindow = { from: '2026-06-01T00:00:00.000Z', to: '2026-07-27T00:00:00.000Z' };
  assert.throws(() => normalizeEvidence([collection], CONTEXT), /EVIDENCE_WINDOW_MISMATCH/);
  assert.throws(() => project([collection]), /PROJECTION_WINDOW_MISMATCH/);
});

test('NARROW 5 — a capturedAt that is not a canonical instant is refused', () => {
  const collection = sourceCollection({
    operationId: OPPORTUNITIES_ACTION,
    items: [{ id: 'o1', contactId: 'c1', status: 'won', monetaryValue: 10, lastStatusChangeAt: '2026-07-15T09:00:00.000Z' }],
    collectedCount: 1,
    reportedCount: 1,
    capturedAt: '2026-07-20T01:00:00Z',
  });
  assert.throws(() => normalizeEvidence([collection], CONTEXT), /EVIDENCE_COLLECTION_INVALID/);
  assert.throws(() => project([collection]), /PROJECTION_SOURCE_COLLECTION_INVALID/);
});

// ===========================================================================
// F12 — an event outside the envelope's OWN applied window is suppressed.
// ===========================================================================

test('F12 — an event time outside the envelope applied window is suppressed with a counted reason', () => {
  const projected = project([sourceCollection({
    operationId: APPOINTMENTS_ACTION,
    items: [
      {
        id: 'a-inside',
        contactId: 'c1',
        dateAdded: '2026-07-14T09:00:00.000Z',
        startTime: '2026-07-15T09:00:00.000Z',
      },
      {
        id: 'a-outside',
        contactId: 'c2',
        dateAdded: '2025-07-04T09:00:00.000Z',
        startTime: '2025-07-04T09:00:00.000Z',
      },
    ],
    collectedCount: 2,
    reportedCount: 2,
  })]);
  const [envelope] = projected;
  const events = envelope.items.filter(({ recordType }) => recordType === 'journey_event');
  // Hand-stated: only the appointment inside 2026-07-06..2026-07-27 may be projected.
  assert.deepEqual(events.map(({ nativeId }) => nativeId), ['a-inside']);
  assert.equal(suppressionCount(envelope, 'EVENT_TIME_OUTSIDE_APPLIED_WINDOW'), 1);
  assert.equal(
    suppressionEntry(envelope, 'EVENT_TIME_OUTSIDE_APPLIED_WINDOW').unit,
    'emission',
  );
  // The subject itself is still evidence, so its entity record survives the suppressed event.
  assert.equal(envelope.items.filter(({ recordType }) => recordType === 'contact').length, 2);
});

// ===========================================================================
// TEST GAPS — each of these survived a mutation of the code it covers.
// ===========================================================================

test('F7 — a NON-ZERO UTC offset is applied with the right sign, to an exact instant', () => {
  const projected = project([sourceCollection({
    operationId: CONTACTS_ACTION,
    items: [
      // 19:00 at UTC+10 is 09:00Z the SAME day. Flipping the sign lands on 2026-07-16T05:00Z.
      { id: 'c-ahead', email: 'ahead@example.test', dateAdded: '2026-07-15T19:00:00+10:00' },
      // 23:00 at UTC-11 is 10:00Z the NEXT day. Flipping the sign lands on 2026-07-14T12:00Z.
      { id: 'c-behind', email: 'behind@example.test', dateAdded: '2026-07-14T23:00:00-11:00' },
      // A half-hour offset, so a whole-hour-only reading is observable too.
      { id: 'c-half', email: 'half@example.test', dateAdded: '2026-07-15T12:45:00+05:30' },
    ],
    collectedCount: 3,
    reportedCount: 3,
  })]);
  const byNativeId = new Map(allItems(projected)
    .filter(({ recordType }) => recordType === 'journey_event')
    .map((item) => [item.nativeId, item.eventTime]));
  assert.equal(byNativeId.get('c-ahead'), '2026-07-15T09:00:00.000Z');
  assert.equal(byNativeId.get('c-behind'), '2026-07-15T10:00:00.000Z');
  assert.equal(byNativeId.get('c-half'), '2026-07-15T07:15:00.000Z');
});

test('M17 — a native value that differs only in case still satisfies a contract predicate', () => {
  const projected = project([sourceCollection({
    operationId: APPOINTMENTS_ACTION,
    items: [
      {
        id: 'a-equals',
        contactId: 'c1',
        appointmentStatus: 'Showed',
        dateAdded: '2026-07-14T09:00:00.000Z',
        startTime: '2026-07-15T09:00:00.000Z',
      },
      {
        id: 'a-in',
        contactId: 'c2',
        appointmentStatus: '  NoShow  ',
        dateAdded: '2026-07-14T10:00:00.000Z',
        startTime: '2026-07-15T10:00:00.000Z',
      },
    ],
    collectedCount: 2,
    reportedCount: 2,
  })]);
  const stages = allItems(projected)
    .filter(({ recordType }) => recordType === 'journey_event')
    .map(({ stage }) => stage)
    .sort();
  // Hand-stated: both rows are booked, and their differently-cased native states still match.
  assert.deepEqual(stages, ['booked', 'booked', 'no_show', 'showed']);
});

test('M18 — two contract sources claiming one payload are refused at projection time', () => {
  const ambiguous = structuredClone(clientProjection);
  const contacts = ambiguous.sources.find(({ capability }) => capability === 'contacts');
  ambiguous.sources.push({
    ...structuredClone(contacts),
    sourceId: 'client_contacts_shadow',
    operationIdPattern: 'contacts.*',
    entities: [{ entityId: 'client_contact_entity_shadow', recordType: 'contact', when: { kind: 'always' } }],
    events: structuredClone(contacts.events).map((event) => ({
      ...event,
      eventId: `${event.eventId}_shadow`,
      stage: 'a_shadow_stage',
    })),
  });
  assert.throws(
    () => projectJourneyEvents({
      collections: [sourceCollection({
        operationId: CONTACTS_ACTION,
        items: [{ id: 'c1', email: 'one@example.test', dateAdded: '2026-07-13T08:00:00.000Z' }],
        collectedCount: 1,
        reportedCount: 1,
      })],
      context: CONTEXT,
      profile: clientProfile,
      projection: ambiguous,
    }),
    /PROJECTION_SOURCE_AMBIGUOUS/,
  );
});

test('M19 — a row with a usable identity that yields nothing is counted, and the counts reconcile', () => {
  const projected = project([sourceCollection({
    operationId: CONVERSATIONS_ACTION,
    items: [
      // A usable identity (so it is not dropped as identity-less), no SUBJECT native id to key an
      // entity on, and an event time nothing can place on a timeline. It yields NOTHING, loudly.
      { email: 'nothing@example.test', dateAdded: 'sometime last tuesday' },
    ],
    collectedCount: 1,
    reportedCount: 1,
  })]);
  const [envelope] = projected;
  assert.equal(envelope.items.length, 0);
  assert.equal(suppressionCount(envelope, 'RECORD_YIELDED_NO_EVENT'), 1);
  assert.equal(suppressionEntry(envelope, 'RECORD_YIELDED_NO_EVENT').unit, 'record');
  assert.equal(suppressionCount(envelope, 'ENTITY_NATIVE_ID_UNRESOLVED'), 1);
  assert.equal(suppressionEntry(envelope, 'ENTITY_NATIVE_ID_UNRESOLVED').unit, 'emission');
  assert.equal(suppressionCount(envelope, 'EVENT_TIME_UNPARSEABLE'), 1);
  assert.equal(envelope.projection.recordsWithEmissions, 0);
  const recordUnits = envelope.projection.suppressed
    .filter(({ unit }) => unit === 'record')
    .reduce((total, { count }) => total + count, 0);
  assert.equal(
    envelope.projection.recordsWithEmissions + recordUnits,
    envelope.projection.inputItemCount,
    JSON.stringify(envelope.projection),
  );
});

test('RECORD_NOT_AN_OBJECT — a row that is not an object is counted once, per record', () => {
  const projected = project([sourceCollection({
    operationId: CONTACTS_ACTION,
    items: ['not an object at all', 42, null, ['still not an object']],
    collectedCount: 4,
    reportedCount: 4,
  })]);
  const [envelope] = projected;
  assert.equal(envelope.items.length, 0);
  assert.equal(suppressionCount(envelope, 'RECORD_NOT_AN_OBJECT'), 4);
  assert.equal(suppressionEntry(envelope, 'RECORD_NOT_AN_OBJECT').unit, 'record');
  assert.equal(envelope.projection.recordsWithEmissions, 0);
});

/**
 * TASK A2 ROUND 2 — EDITED, AND THE ORIGINAL IS QUOTED IN FULL BELOW.
 *
 * It read:
 *
 *   test('M15 — a negative zero amount is folded, so canonicalisation cannot kill the run', () => {
 *     const projected = project([...one raw row with monetaryValue: -0...]);
 *     const revenue = allItems(projected).find(({ stage }) => stage === 'collected_revenue');
 *     assert.equal(revenue.revenueAmount, 0);
 *     assert.equal(Object.is(revenue.revenueAmount, -0), false, 'a negative zero must never reach the output');
 *     assert.equal(Object.hasOwn(revenue, 'classification'), false, 'zero collected is a real answer');
 *     const records = normalizeEvidence(projected, CONTEXT);
 *     const normalized = records.find(({ stage }) => stage === 'collected_revenue');
 *     assert.equal(normalized.classification, 'OBSERVED');
 *     assert.equal(normalized.revenueAmount, 0);
 *   });
 *
 * WHY IT HAD TO CHANGE. Its last three assertions are the SAME claim, in the same words
 * ('zero collected is a real answer'), as the A1 assertion task A2 round 2 was told to invert. Once
 * a zero amount on an outcome stage is unusable by default, a `-0` is unusable too — there is no
 * reading of the policy under which `-0` and `0` differ.
 *
 * WHAT IT STILL PROVES, which is what M15 exists for and is unchanged: `-0` never reaches the
 * output, and the folding that stops `canonicalJson` refusing the record still happens. The second
 * half asserts it in the ONE configuration where a zero can reach the output at all — a profile
 * that has declared zero to be a real answer — so the folding is exercised rather than assumed.
 *
 * TASK A2 ROUND 3 — EDITED AGAIN, SAME SESSION, and the round-2 first half is quoted here:
 *
 *   const revenue = allItems(projected).find(({ stage }) => stage === 'collected_revenue');
 *   assert.equal(Object.hasOwn(revenue, 'revenueAmount'), false);
 *   assert.equal(Object.is(revenue.revenueAmount, -0), false, ...);
 *   assert.equal(revenue.classification, 'UNKNOWN');
 *   assert.deepEqual(revenue.projectionReasons, ['REVENUE_ZERO_ON_OUTCOME_STAGE']);
 *   assert.equal(normalizeEvidence(projected, CONTEXT).filter(({ stage }) => stage === 'collected_revenue').length, 1);
 *
 * An UNKNOWN amount-bearing event taints its whole SUBJECT out of every metric, money or not, so
 * under the default policy the event is now SUPPRESSED rather than downgraded. Nothing M15 exists
 * for moves: `-0` still never reaches the output, and the folding is still exercised — in the
 * second half, under the declared policy, which is the only configuration in which a zero amount
 * reaches the output at all and therefore the only one where the folding can matter.
 */
test('M15 — a negative zero amount is folded, so canonicalisation cannot kill the run', () => {
  const rawRow = {
    id: 'o-negative-zero',
    contactId: 'c1',
    status: 'won',
    monetaryValue: -0,
    lastStatusChangeAt: '2026-07-15T09:00:00.000Z',
  };
  const collection = () => sourceCollection({
    operationId: OPPORTUNITIES_ACTION,
    items: [{ ...rawRow }],
    collectedCount: 1,
    reportedCount: 1,
  });

  // Default policy: a zero of either sign is an amount the account never supplied, so the
  // amount-bearing event does not exist and `-0` reaches nothing at all.
  const projected = project([collection()]);
  const revenue = allItems(projected).find(({ stage }) => stage === 'collected_revenue');
  assert.equal(revenue, undefined, 'a negative zero must never reach the output');
  // The run survives: a refused canonicalisation downstream would discard the whole record.
  assert.equal(normalizeEvidence(projected, CONTEXT).length > 0, true);

  // Declared policy: the amount reaches the output, and it is `0` and never `-0`.
  const permissive = structuredClone(clientProjection);
  permissive.zeroAmountPolicy = 'OBSERVED';
  const declared = project([collection()], clientProfile, permissive);
  const observedRevenue = allItems(declared).find(({ stage }) => stage === 'collected_revenue');
  assert.equal(observedRevenue.revenueAmount, 0);
  assert.equal(Object.is(observedRevenue.revenueAmount, -0), false);
  assert.equal(Object.hasOwn(observedRevenue, 'classification'), false);
  const normalized = normalizeEvidence(declared, CONTEXT).find(({ stage }) => stage === 'collected_revenue');
  assert.equal(normalized.classification, 'OBSERVED');
  assert.equal(normalized.revenueAmount, 0);
});

test('a contract still carrying the single-path revenue spelling is refused, not read as absent', () => {
  const stale = structuredClone(clientProjection);
  const opportunities = stale.sources.find(({ capability }) => capability === 'opportunities');
  const revenueEvent = opportunities.events.find((event) => Array.isArray(event.revenueFrom));
  assert.ok(revenueEvent, 'the shipped contract must declare an amount somewhere to mutate');
  revenueEvent.revenueFrom = revenueEvent.revenueFrom[0];
  assert.throws(() => ProjectionContractSchema.parse(stale));
  assert.throws(
    () => project(
      [sourceCollection({
        operationId: OPPORTUNITIES_ACTION,
        items: [{ id: 'o1', contactId: 'c1', status: 'won', monetaryValue: 10, lastStatusChangeAt: '2026-07-15T09:00:00.000Z' }],
        collectedCount: 1,
        reportedCount: 1,
      })],
      clientProfile,
      stale,
    ),
    /PROJECTION_CONTRACT_INVALID/,
  );
});

test('a window whose prototype is not Object.prototype is refused rather than spread into one', () => {
  const collection = sourceCollection({
    operationId: OPPORTUNITIES_ACTION,
    items: [{ id: 'o1', contactId: 'c1', status: 'won', monetaryValue: 10, lastStatusChangeAt: '2026-07-15T09:00:00.000Z' }],
    collectedCount: 1,
    reportedCount: 1,
  });
  collection.appliedWindow = Object.assign(Object.create(null), { ...WINDOW });
  assert.throws(() => normalizeEvidence([collection], CONTEXT), /EVIDENCE_COLLECTION_INVALID/);
  assert.throws(() => project([collection]), /PROJECTION_SOURCE_COLLECTION_INVALID/);
});
