/**
 * WHY GROM'S OWN SHOW RATE READ "CANNOT BE MEASURED" ON AN ACCOUNT THAT MEASURES IT.
 *
 * Found 2026-07-31. The 2026-07-27 Grom UK run told the account its show rate was unmeasurable
 * while 43 of its 64 appointments already carried an attendance outcome. Nothing was wrong with the
 * arithmetic, the edge, or the data.
 *
 * `grom-internal-metrics.v1.json` declares `strategy_call_to_showed` with dispositions
 * `showed | no_show | cancelled | unknown`, and the edge is `nativeMapping: MAPPED`. But the
 * PROJECTION only ever emitted two appointment events: one for every appointment, and one for
 * `showed`. There was no event for a no-show and none for a cancellation, so a recorded no-show
 * projected to nothing and was indistinguishable from an appointment nobody had resolved yet.
 *
 * An edge whose only observable disposition is the success case cannot produce a rate: it has a
 * numerator and no denominator. The client profile (`client-projection.v1.json`) had carried all
 * four appointment events since it was written; only Grom's own profile was short.
 *
 * This file pins the four events so the omission cannot come back quietly.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadProjection, loadMetricContracts } from '../schemas/v1.mjs';

const appointmentEvents = (profileId, sourceId) => {
  const projection = loadProjection(profileId);
  const source = projection.sources.find((s) => s.sourceId === sourceId);
  assert.ok(source, `${profileId} must declare the ${sourceId} source`);
  return new Map(source.events.map((e) => [e.eventId, e]));
};

test('Grom projects an attendance DISPOSITION, not just the success case', () => {
  const events = appointmentEvents('grom_internal', 'grom_appointments');

  // The success case was never the problem.
  assert.ok(events.has('appointment_showed'), 'showed');
  // 🔴 These two are the fix. Without a no-show event there is no denominator, and the engine
  // correctly reported that it could not compute a rate.
  assert.ok(events.has('appointment_no_show'), 'no_show must project, or the rate is unmeasurable');
  assert.ok(events.has('appointment_cancelled'), 'cancelled must project, or it silently counts as unresolved');
});

test('the no-show event matches BOTH spellings GHL ships', () => {
  const events = appointmentEvents('grom_internal', 'grom_appointments');
  const when = events.get('appointment_no_show').when;
  assert.equal(when.kind, 'field_in');
  assert.equal(when.field, 'appointmentStatus');
  // GHL is inconsistent about the separator; matching only one loses roughly half the no-shows,
  // which would look like a show rate that improved.
  assert.deepEqual([...when.values].sort(), ['no_show', 'noshow']);
});

test('every disposition the metric edge promises is actually projectable', () => {
  const contracts = loadMetricContracts('grom_internal');
  const edge = contracts.edges.find((e) => e.edgeId === 'strategy_call_to_showed');
  assert.ok(edge, 'the show-rate edge must exist');

  const stages = new Set([...appointmentEvents('grom_internal', 'grom_appointments').values()]
    .map((e) => e.stage));

  // `unknown` is the absence of an observation and is never projected; the rest must be.
  for (const disposition of edge.dispositions.filter((d) => d !== 'unknown')) {
    assert.ok(
      stages.has(disposition),
      `edge promises "${disposition}" but no projection event produces that stage`,
    );
  }
});

test('Grom now matches the client profile it was always meant to mirror', () => {
  const grom = appointmentEvents('grom_internal', 'grom_appointments');
  const client = appointmentEvents('client', 'client_appointments');

  const dispositionStages = (events) => new Set([...events.values()]
    .map((e) => e.stage)
    .filter((s) => s === 'showed' || s === 'no_show' || s === 'cancelled'));

  assert.deepEqual(
    [...dispositionStages(grom)].sort(),
    [...dispositionStages(client)].sort(),
    'the agency should measure its own funnel at least as well as it measures a client one',
  );
});
