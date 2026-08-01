/**
 * REBOOKING GHOSTS, and the blended-rate warning that travels beside them.
 *
 * The defect this file pins was found on the 2026-07-31 Grom UK backlog session. The engine's
 * joined outcome was already RIGHT — `latest` keeps the most recent appointment per contact — but
 * the discarded originals are still in the evidence, and a lane counting appointment RECORDS reads
 * every one of them as a booking nobody worked.
 *
 * Staff rebook by CREATING a second appointment instead of moving the first. Nothing cancels the
 * original, so it sits at `confirmed` forever and is indistinguishable from an ignored booking.
 * The run reported 21 unresolved appointments. The true figure was 4: one was in the future, 9 were
 * these ghosts, 7 had been worked by hand.
 *
 * The same run published a single 90-day show rate of 39.5% while the months underneath it were
 * 26.9% and 58.8% — the rate had more than doubled and the blended figure hid it, so the finding
 * described a problem that was already resolving.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildOutcomeIndex } from '../lib/conversation-outcomes.mjs';
import { buildAnalysisBriefs } from '../lib/analysis-brief.mjs';
import { loadProfile } from '../schemas/v1.mjs';

const profile = loadProfile('grom_internal');
const measurement = Object.freeze({
  profileId: 'grom_internal',
  collectionWindow: { from: '2026-07-20T00:00:00.000Z', to: '2026-07-27T00:00:00.000Z' },
  collectionMode: 'first',
  collection: [],
  projection: [],
  unmeasurableEdges: [],
  surfaceObservations: [],
  graph: { nodes: [], edges: [], conflicts: [], unresolvedJoins: [] },
  windows: { timezone: 'Australia/Sydney' },
  metrics: { metrics: {} },
});

function briefFor(outcomeCoverage) {
  const { lanes } = buildAnalysisBriefs({
    measurement,
    profile,
    internal: {
      complete: true,
      limitations: [],
      workflows: [],
      conversationTranscripts: {
        schemaVersion: '1.0.0',
        complete: true,
        limitations: [],
        universeCount: 2,
        messageCount: 4,
        sampledCount: 2,
        droppedForSizeCount: 0,
        droppedFlaggedCount: 0,
        elidedThreadCount: 0,
        unparsedMessageCount: 0,
        mandatoryGuaranteeHeld: true,
        outcomeCoverage,
        sample: { mode: 'CENSUS', mandatoryCount: 0 },
        transcripts: [],
      },
    },
  });
  return lanes.conversationCopyAi.conversations;
}

/** Two appointments for ONE contact is the rebooking shape; `startTime` orders them. */
const appointment = (id, contactId, appointmentStatus, startTime) => ({
  id,
  contactId,
  calendarId: 'cal1',
  startTime,
  appointmentStatus,
});

const evidenceOf = (records) => ({
  scopes: [{ actionId: 'calendars-v3__get-calendar-events', items: records }],
});

test('a rebooked contact leaves ONE live appointment and one counted ghost', () => {
  // Aty's real shape: booked for the afternoon, rebooked the same day for the following week,
  // and the original was never touched again.
  const { coverage } = buildOutcomeIndex(evidenceOf([
    appointment('a1', 'aty', 'confirmed', '2026-06-07T17:30:00+01:00'),
    appointment('a2', 'aty', 'confirmed', '2026-06-14T11:00:00+01:00'),
  ]));

  assert.equal(coverage.appointmentsSeen, 2, 'both records are still in the evidence');
  assert.equal(coverage.supersededAppointments, 1, 'and exactly one of them is a ghost');
});

test('distinct contacts are never counted as superseding each other', () => {
  const { coverage } = buildOutcomeIndex(evidenceOf([
    appointment('a1', 'c1', 'confirmed', '2026-06-07T17:30:00+01:00'),
    appointment('a2', 'c2', 'confirmed', '2026-06-08T17:30:00+01:00'),
    appointment('a3', 'c3', 'confirmed', '2026-06-09T17:30:00+01:00'),
  ]));
  assert.equal(coverage.supersededAppointments, 0);
});

test('a contact rebooked twice yields two ghosts, not one', () => {
  const { coverage } = buildOutcomeIndex(evidenceOf([
    appointment('a1', 'c1', 'confirmed', '2026-06-01T10:00:00+01:00'),
    appointment('a2', 'c1', 'confirmed', '2026-06-08T10:00:00+01:00'),
    appointment('a3', 'c1', 'confirmed', '2026-06-15T10:00:00+01:00'),
  ]));
  assert.equal(coverage.appointmentsSeen, 3);
  assert.equal(coverage.supersededAppointments, 2);
});

test('the brief SAYS the ghost count in prose, and says to subtract it', () => {
  const brief = briefFor({
    joined: true,
    appointmentsSeen: 20,
    appointmentStatusesRecorded: 20,
    attendanceDispositionsRecorded: 17,
    supersededAppointments: 9,
    threadsTotal: 3,
    threadsWithOutcome: 3,
  });

  assert.match(brief.howToReadThis, /SUPERSEDED APPOINTMENTS: 9 of 20/);
  assert.match(brief.howToReadThis, /rebooking ghosts/);
  // The two instructions that would have prevented the wrong finding.
  assert.match(brief.howToReadThis, /Subtract them before counting anything/);
  assert.match(brief.howToReadThis, /show-rate denominator/);
});

test('an account with no rebooking says nothing about ghosts', () => {
  const brief = briefFor({
    joined: true,
    appointmentsSeen: 12,
    appointmentStatusesRecorded: 12,
    attendanceDispositionsRecorded: 12,
    supersededAppointments: 0,
    threadsTotal: 3,
    threadsWithOutcome: 3,
  });
  assert.doesNotMatch(brief.howToReadThis, /SUPERSEDED/);
});

test('the brief warns that any rate it can compute is an average of the window', () => {
  const brief = briefFor({
    joined: true,
    appointmentsSeen: 64,
    appointmentStatusesRecorded: 64,
    attendanceDispositionsRecorded: 43,
    supersededAppointments: 0,
    threadsTotal: 3,
    threadsWithOutcome: 3,
  });

  assert.match(brief.howToReadThis, /BLENDED RATES/);
  assert.match(brief.howToReadThis, /split it by month/);
  // The precise failure: a blended number reads as the current state.
  assert.match(brief.howToReadThis, /reads as current/);
});

test('with no appointments at all, neither caveat is claimed', () => {
  const brief = briefFor({
    joined: true,
    appointmentsSeen: 0,
    appointmentStatusesRecorded: 0,
    attendanceDispositionsRecorded: 0,
    supersededAppointments: 0,
    threadsTotal: 1,
    threadsWithOutcome: 0,
  });
  assert.doesNotMatch(brief.howToReadThis, /SUPERSEDED/);
  assert.doesNotMatch(brief.howToReadThis, /BLENDED RATES/);
});
