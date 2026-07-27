/**
 * SURFACE OBSERVATIONS.
 *
 * Every expected number below is hand-counted from the fixture rows, stated before the code runs.
 * The fixture rows are shaped on REAL rows captured from Grom's own UK sub-account, with every
 * value replaced -- the structure is the part that has to be real, and the values are the part that
 * must never enter this repository.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { computeSurfaceObservations, findObservation } from '../lib/observations.mjs';
import { loadProjection } from '../schemas/v1.mjs';

const CUTOFF_MS = Date.parse('2026-03-02T00:00:00.000Z');

function collection(operationId, items, { complete = true } = {}) {
  return {
    source: 'public_ghl',
    operationId,
    boundLocationId: 'L1',
    requestedWindow: { from: '2025-12-02T00:00:00.000Z', to: '2026-03-02T00:00:00.000Z' },
    appliedWindow: { from: '2025-12-02T00:00:00.000Z', to: '2026-03-02T00:00:00.000Z' },
    capturedAt: '2026-03-02T07:00:00.000Z',
    items,
    page: {
      cursor: null,
      nextCursor: complete ? null : 'more',
      reportedCount: items.length,
      collectedCount: items.length,
      complete,
      truncated: false,
    },
  };
}

const projection = loadProjection('grom_internal');

function computeFor(collections) {
  return computeSurfaceObservations({ collections, projection, cutoffMs: CUTOFF_MS });
}

// ---------------------------------------------------------------------------

test('a distribution counts every row, including the ones with nothing there', () => {
  /*
   * Five conversations: three end outbound, one inbound, one has no direction at all. So
   * `outbound: 3, inbound: 1, __absent__: 1`, and the three counts must sum to the five rows,
   * because a row that said nothing is still a row.
   */
  const surfaces = computeFor([collection('conversations-v3__search-conversation', [
    { id: 'v1', lastMessageDirection: 'outbound', lastOutboundMessageAction: 'automated' },
    { id: 'v2', lastMessageDirection: 'outbound', lastOutboundMessageAction: 'automated' },
    { id: 'v3', lastMessageDirection: 'outbound', lastOutboundMessageAction: 'manual' },
    { id: 'v4', lastMessageDirection: 'inbound' },
    { id: 'v5' },
  ])]);

  const direction = findObservation(surfaces, 'conversations', 'last_message_direction');
  assert.deepEqual(direction.values, { outbound: 3, inbound: 1, __absent__: 1 });
  assert.equal(direction.rows, 5);
  assert.equal(
    Object.values(direction.values).reduce((total, count) => total + count, 0),
    5,
    'a row that said nothing is still a row',
  );

  const action = findObservation(surfaces, 'conversations', 'last_outbound_action');
  assert.deepEqual(action.values, { automated: 2, __absent__: 2, manual: 1 });
});

test('a value that is not a short scalar is COUNTED and never carried', () => {
  /*
   * LOCK 1, and it is the one that matters. A declaration is data, so somebody will eventually
   * point one at a field that turns out to hold an email, an address or a message body. When that
   * happens the count must survive and the content must not.
   */
  const surfaces = computeFor([collection('contacts.search', [
    { id: 'c1', source: 'Facebook' },
    { id: 'c2', source: 'someone@example.test' },
    { id: 'c3', source: 'https://example.test/landing?utm=x' },
    { id: 'c4', source: '1 Somewhere Street, Bristol' },
    { id: 'c5', source: '   ' },
  ])]);
  const mix = findObservation(surfaces, 'contacts', 'source_mix');
  assert.deepEqual(mix.values, { __unsafe__: 3, Facebook: 1, __absent__: 1 });

  const serialised = JSON.stringify(surfaces);
  for (const leak of ['someone@example.test', 'example.test', 'Somewhere Street', 'Bristol']) {
    assert.equal(serialised.includes(leak), false, `${leak} escaped the boundary`);
  }
});

test('overflow past the distinct cap is bucketed, never dropped', () => {
  // LOCK 2. A silently truncated distribution reads as a tidier account than the real one.
  /*
   * 30 rows: 6 of `bulk`, 2 of `pair`, and 22 singletons. That is 24 distinct values.
   *
   * With a cap of 3, the three kept buckets are `bulk` (6), `pair` (2) and ONE of the singletons,
   * so the overflow is the remaining 21 singletons. Counting it as 22 is the easy mistake, and
   * making it here first is why the arithmetic is spelled out.
   */
  const items = Array.from({ length: 30 }, (unused, index) => ({
    id: `c${index}`,
    source: index < 6 ? 'bulk' : index < 8 ? 'pair' : `one${index}`,
  }));
  const surfaces = computeSurfaceObservations({
    collections: [collection('contacts.search', items)],
    projection: {
      sources: [{
        sourceId: 's', capability: 'contacts', evidenceSource: 'public_ghl',
        operationIdPattern: 'contacts.search',
        observations: [{
          observationId: 'source_mix', kind: 'distribution', path: 'source', maxDistinct: 3,
        }],
      }],
    },
    cutoffMs: CUTOFF_MS,
  });
  const mix = findObservation(surfaces, 'contacts', 'source_mix');
  assert.equal(mix.distinct, 24, 'the true distinct count is reported even when truncated');
  assert.equal(mix.values.bulk, 6);
  assert.equal(mix.values.pair, 2);
  assert.equal(mix.values.__other__, 21);
  assert.equal(mix.values.__other___distinct, 21);
  assert.equal(
    Object.entries(mix.values)
      .filter(([key]) => key !== '__other___distinct')
      .reduce((total, [, count]) => total + count, 0),
    30,
    'the counts must still sum to every row',
  );
});

test('presence distinguishes a real zero from a missing value, and refuses a stringified number', () => {
  /*
   * Six opportunities. `monetaryValue` is declared `requirePositiveNumber`, so:
   *   1200      counts
   *   0         does NOT -- an unpriced won opportunity is the normal state on a GHL pipeline
   *   '900'     does NOT -- and this is the important one
   *   null      does not
   *   absent    does not
   *   -50       does not
   * So present 1, absent 5.
   *
   * The string case has to agree with the projector, which refuses to read a stringified amount as
   * a number. If this counted it as present, the detector would report that the account has values
   * on deals the measurement layer says it cannot price -- a system contradicting itself about the
   * same row.
   */
  const surfaces = computeFor([collection('opportunities.list', [
    { id: 'o1', monetaryValue: 1200 },
    { id: 'o2', monetaryValue: 0 },
    { id: 'o3', monetaryValue: '900' },
    { id: 'o4', monetaryValue: null },
    { id: 'o5' },
    { id: 'o6', monetaryValue: -50 },
  ])]);
  const value = findObservation(surfaces, 'opportunities', 'has_monetary_value');
  assert.equal(value.present, 1);
  assert.equal(value.absent, 5);
});

test('stale_status reads the SEALED cutoff, never the wall clock', () => {
  /*
   * Four appointments in an unresolved state:
   *   a1 started before the cutoff        -> stale
   *   a2 started before the cutoff        -> stale
   *   a3 starts AFTER the cutoff          -> not stale, it has not happened yet
   *   a4 has an unreadable start time     -> neither, and said so
   * Plus a5, which is resolved and so not in state at all.
   */
  const surfaces = computeFor([collection('calendars-v3__get-calendar-events', [
    { id: 'a1', appointmentStatus: 'confirmed', startTime: '2026-02-20T10:00:00.000Z' },
    { id: 'a2', appointmentStatus: 'new', startTime: '2026-01-15T10:00:00.000Z' },
    { id: 'a3', appointmentStatus: 'confirmed', startTime: '2026-03-10T10:00:00.000Z' },
    { id: 'a4', appointmentStatus: 'confirmed', startTime: 'not a date' },
    { id: 'a5', appointmentStatus: 'showed', startTime: '2026-02-01T10:00:00.000Z' },
  ])]);
  const stale = findObservation(surfaces, 'appointments', 'unresolved_past_appointments');
  assert.equal(stale.inState, 4);
  assert.equal(stale.stale, 2);
  assert.equal(stale.unreadableTime, 1);

  // THE DISCRIMINATOR. The same rows against a cutoff before all of them must go to zero. If this
  // read `Date.now()` instead, both cutoffs would give the same answer and the assertion above
  // would be passing for a reason that has nothing to do with the seal.
  const early = computeSurfaceObservations({
    collections: [collection('calendars-v3__get-calendar-events', [
      { id: 'a1', appointmentStatus: 'confirmed', startTime: '2026-02-20T10:00:00.000Z' },
    ])],
    projection,
    cutoffMs: Date.parse('2026-01-01T00:00:00.000Z'),
  });
  assert.equal(findObservation(early, 'appointments', 'unresolved_past_appointments').stale, 0);
});

test('an empty surface and an absent one are different facts', () => {
  // A detector that read "no conversations observed" as "everybody replied" would be worse than
  // useless, so a declared surface with nothing collected is reported, not omitted.
  const surfaces = computeFor([collection('contacts.search', [{ id: 'c1', source: 'Facebook' }])]);
  const conversations = surfaces.find((entry) => entry.capability === 'conversations');
  assert.ok(conversations, 'a declared surface must be reported even with nothing collected');
  assert.equal(conversations.collected, 0);
  assert.equal(conversations.rows, 0);
  assert.equal(conversations.complete, false, 'nothing collected is not a complete surface');
  assert.equal(findObservation(surfaces, 'conversations', 'last_message_direction').rows, 0);
});

test('a truncated surface says so, because a ratio over part of it is not the account ratio', () => {
  const surfaces = computeFor([
    collection('conversations-v3__search-conversation', [
      { id: 'v1', lastMessageDirection: 'outbound' },
    ], { complete: false }),
  ]);
  const conversations = surfaces.find((entry) => entry.capability === 'conversations');
  assert.equal(conversations.rows, 1);
  assert.equal(conversations.complete, false);
});

test('the same collections always yield the same observations, whatever order they arrive in', () => {
  const contacts = collection('contacts.search', [
    { id: 'c1', source: 'Facebook' }, { id: 'c2', source: 'Instagram' },
  ]);
  const conversations = collection('conversations-v3__search-conversation', [
    { id: 'v1', lastMessageDirection: 'inbound' },
  ]);
  assert.equal(
    JSON.stringify(computeFor([contacts, conversations])),
    JSON.stringify(computeFor([conversations, contacts])),
    'the kernel byte-compares this output on resume',
  );
});

test('a path that lands inside an array is not guessed at', () => {
  // Answering it with the first element would be a guess about which element the author meant, and
  // a wrong guess here is a silently wrong count rather than an error.
  const surfaces = computeSurfaceObservations({
    collections: [collection('contacts.search', [{ id: 'c1', tags: ['a', 'b'] }])],
    projection: {
      sources: [{
        sourceId: 's', capability: 'contacts', evidenceSource: 'public_ghl',
        operationIdPattern: 'contacts.search',
        observations: [{ observationId: 'tag_mix', kind: 'distribution', path: 'tags.0' }],
      }],
    },
    cutoffMs: CUTOFF_MS,
  });
  assert.deepEqual(findObservation(surfaces, 'contacts', 'tag_mix').values, { __absent__: 1 });
});
