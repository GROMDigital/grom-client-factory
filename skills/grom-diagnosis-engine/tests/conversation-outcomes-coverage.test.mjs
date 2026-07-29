/**
 * ATTENDANCE COVERAGE, which is the safety net that stops an expert reading an account that does
 * not RECORD outcomes as an account whose leads do not ATTEND.
 *
 * The defect this file pins was found on the 2026-07-29 SK Skin acceptance run:
 * `appointmentStatusesRecorded` counts `new`, `confirmed` and `cancelled`, which GHL and the
 * customer set by themselves, so it read 21 of 21 on an account where a human had recorded
 * attendance exactly once. The number meant to warn "nobody marks attendance here" was reporting
 * full marks. Only a hand-written account caveat saved that run.
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

/** The copy lane's `conversations` block, built through the real public path. */
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

const appointment = (contactId, appointmentStatus) => ({
  id: `appt-${contactId}`,
  contactId,
  calendarId: 'cal1',
  startTime: '2026-07-21T01:00:00+10:00',
  appointmentStatus,
});

const evidenceOf = (records) => ({
  scopes: [{ actionId: 'calendars-v3__get-calendar-events', items: records }],
});

test('scheduling states are NOT attendance, and the two are counted separately', () => {
  // The real SK Skin shape: every appointment carries a status, one carries an outcome.
  const { coverage } = buildOutcomeIndex(evidenceOf([
    appointment('c1', 'confirmed'),
    appointment('c2', 'confirmed'),
    appointment('c3', 'new'),
    appointment('c4', 'cancelled'),
    appointment('c5', 'noshow'),
  ]));

  assert.equal(coverage.appointmentsSeen, 5);
  // Every one carries a readable status. This is the number that used to be mistaken for coverage.
  assert.equal(coverage.appointmentStatusesRecorded, 5);
  // Exactly ONE says what actually happened to the person.
  assert.equal(coverage.attendanceDispositionsRecorded, 1);
});

test('an account nobody marks attendance on reports ZERO attendance dispositions', () => {
  const { coverage } = buildOutcomeIndex(evidenceOf([
    appointment('c1', 'confirmed'),
    appointment('c2', 'new'),
    appointment('c3', 'cancelled'),
  ]));
  assert.equal(coverage.appointmentStatusesRecorded, 3, 'all three statuses are readable');
  assert.equal(coverage.attendanceDispositionsRecorded, 0, 'and none of them is an outcome');
});

test('showed counts as attendance, not only no-show', () => {
  const { coverage } = buildOutcomeIndex(evidenceOf([
    appointment('c1', 'showed'),
    appointment('c2', 'no-show'),
    appointment('c3', 'confirmed'),
  ]));
  assert.equal(coverage.attendanceDispositionsRecorded, 2);
});

test('the brief SAYS the attendance limit in prose, because the field alone did not work', () => {
  const brief = briefFor({
    joined: true,
    appointmentsSeen: 21,
    appointmentStatusesRecorded: 21,
    attendanceDispositionsRecorded: 1,
    threadsTotal: 3,
    threadsWithOutcome: 3,
  });

  assert.match(brief.howToReadThis, /ATTENDANCE: 1 of 21/);
  assert.match(brief.howToReadThis, /RECORDING rate/);
  assert.match(brief.howToReadThis, /no\s+finding may say leads are failing to attend/);
  // And it must name the trap explicitly, since that field reads as full marks.
  assert.match(brief.howToReadThis, /appointmentStatusesRecorded/);
});

test('a fully recorded account gets NO attendance caveat, so the warning stays meaningful', () => {
  const brief = briefFor({
    joined: true,
    appointmentsSeen: 10,
    appointmentStatusesRecorded: 10,
    attendanceDispositionsRecorded: 10,
    threadsTotal: 2,
    threadsWithOutcome: 2,
  });
  assert.doesNotMatch(brief.howToReadThis, /ATTENDANCE:/);
});
