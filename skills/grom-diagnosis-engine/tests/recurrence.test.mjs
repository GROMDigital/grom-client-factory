/**
 * WEEK OVER WEEK.
 *
 * `lib/memory.mjs` shipped built, tested and with zero callers, so every run was the first run. These
 * tests hold the properties that make the join trustworthy rather than merely present:
 *
 *  - identity survives an expert rephrasing itself, because it is derived from the problem and not
 *    from any name anyone gave it;
 *  - a problem that vanishes is reported ABSENT and never "fixed", because nothing has verified it;
 *  - a near miss is SHOWN rather than silently matched, because a wrong match across weeks is worse
 *    than an unmatched pair;
 *  - a ledger that cannot be read never costs the account its report.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  causeFingerprint,
  compareToHistory,
  readCanonicalHistory,
  readObservations,
  recordRun,
} from '../lib/recurrence.mjs';
import { auditPaths } from '../lib/paths.mjs';

const LOCATION = 'yoQVVJFp6wyjxcxilA2H';
const WEEK_ONE = '2026-07-20T23:00:00.000Z';
const WEEK_TWO = '2026-07-27T23:00:00.000Z';

function project() {
  const root = mkdtempSync(join(tmpdir(), 'audit-recurrence-'));
  const paths = auditPaths(root, LOCATION);
  mkdirSync(paths.root, { recursive: true });
  mkdirSync(paths.weekly, { recursive: true });
  return paths;
}

function cause(causeId, { mechanisms = ['ownership_or_handoff'], anchors = ['kpi:enquiry_to_contacted', 'workflow:05 No-Show Recovery'] } = {}) {
  return {
    causeId,
    mechanisms,
    anchors,
    confidence: 'C2',
    rankScore: 42,
    findings: [{ title: 'a problem' }],
  };
}

const investigationOf = (...causes) => ({ causes, causeCount: causes.length });

// ---------------------------------------------------------------------------

test('identity comes from the problem, not from what anyone called it', () => {
  /*
   * THE WHOLE DIFFICULTY. Every run, three experts invent their own ids: last week's
   * `no_sms_on_lead_form_traffic` is this week's `lead_form_leads_never_texted`, and `causeId` hashes
   * the finding ids so it moves too. A fingerprint that moves reports every recurring problem as new.
   */
  const lastWeek = cause('cause_aaaa');
  const thisWeek = cause('cause_zzzz');
  assert.equal(causeFingerprint(lastWeek), causeFingerprint(thisWeek));

  // Anchor ORDER must not matter either, since nothing guarantees two experts list them alike.
  const shuffled = cause('cause_bbbb', { anchors: ['workflow:05 No-Show Recovery', 'kpi:enquiry_to_contacted'] });
  assert.equal(causeFingerprint(shuffled), causeFingerprint(lastWeek));

  // A different mechanism at the same anchors is a different problem.
  const other = cause('cause_cccc', { mechanisms: ['delivery_failure'] });
  assert.notEqual(causeFingerprint(other), causeFingerprint(lastWeek));
});

test('journey stages do not affect identity', () => {
  // They are near-universal, so including them would make every problem look like every other.
  const withStage = cause('cause_a', { anchors: ['kpi:enquiry_to_contacted', 'workflow:05 No-Show Recovery', 'stage:conversation'] });
  const without = cause('cause_a');
  assert.equal(causeFingerprint(withStage), causeFingerprint(without));
});

test('two weeks: the same problem reads RECURRING, and a genuinely new one reads NEW', () => {
  const paths = project();

  // Week one: two problems, recorded.
  const first = investigationOf(cause('cause_week1_a'), cause('cause_week1_b', { mechanisms: ['delivery_failure'] }));
  recordRun({ paths, runId: 'run_week_one', investigation: first, occurredAt: WEEK_ONE });

  // Week two: the first problem again under a different id, plus something new.
  const second = investigationOf(
    cause('cause_week2_renamed'),
    cause('cause_week2_new', { anchors: ['kpi:showed_to_decision'], mechanisms: ['offer_or_pricing'] }),
  );
  const observations = readObservations({ paths });
  const comparison = compareToHistory({ investigation: second, observations, runId: 'run_week_two' });

  assert.equal(comparison.priorRunCount, 1);
  assert.equal(comparison.recurringCount, 1);
  assert.equal(comparison.newCount, 1);

  const recurring = comparison.causes.find(({ status }) => status === 'RECURRING');
  assert.equal(recurring.causeId, 'cause_week2_renamed');
  assert.equal(recurring.firstSeenAt, WEEK_ONE);
  assert.equal(recurring.priorRuns, 1);
});

test('a problem that stops appearing is ABSENT, never fixed', () => {
  /*
   * It can vanish because somebody fixed it, because an expert framed it differently, because its
   * finding was refused this week, or because the evidence moved. Only a verification settles it and
   * nothing writes one yet, so the report must not claim credit.
   */
  const paths = project();
  recordRun({
    paths,
    runId: 'run_week_one',
    investigation: investigationOf(cause('cause_gone'), cause('cause_stays', { mechanisms: ['offer_or_pricing'] })),
    occurredAt: WEEK_ONE,
  });

  const comparison = compareToHistory({
    investigation: investigationOf(cause('cause_stays_renamed', { mechanisms: ['offer_or_pricing'] })),
    observations: readObservations({ paths }),
    runId: 'run_week_two',
  });

  assert.equal(comparison.absent.length, 1);
  assert.equal(comparison.absent[0].firstSeenAt, WEEK_ONE);
  assert.equal(comparison.absent[0].priorRuns, 1);
  // And the survivor is correctly recurring rather than counted as gone.
  assert.equal(comparison.recurringCount, 1);
});

test('a weak near miss is REPORTED, not matched', () => {
  /*
   * Two shared anchors is under the floor: too few concrete objects in common to call it the same
   * problem, however high the ratio looks. It is reported with its overlap so the reader decides.
   */
  const paths = project();
  recordRun({
    paths,
    runId: 'run_week_one',
    investigation: investigationOf(cause('cause_a', {
      anchors: ['kpi:enquiry_to_contacted', 'workflow:05 No-Show Recovery', 'workflow:06 Cancellation Recovery'],
    })),
    occurredAt: WEEK_ONE,
  });

  // Same mechanism, two anchors of three still shared: 0.67 overlap, above the near-match threshold.
  const comparison = compareToHistory({
    investigation: investigationOf(cause('cause_b', {
      anchors: ['kpi:enquiry_to_contacted', 'workflow:05 No-Show Recovery RENAMED', 'workflow:06 Cancellation Recovery'],
    })),
    observations: readObservations({ paths }),
    runId: 'run_week_two',
  });

  const [only] = comparison.causes;
  assert.equal(only.status, 'NEW', 'two shared anchors is under the floor');
  assert.equal(only.nearMatches.length, 1);
  assert.ok(only.nearMatches[0].anchorOverlap >= 0.6);
});

test('a strong overlap reads LIKELY_RECURRING, and shows the number behind it', () => {
  /*
   * THE FAILURE THIS EXISTS TO FIX. Measured on Grom UK 2026-07-29: two runs of the SAME closed week
   * over the same evidence produced 20 causes and 14, and exact matching paired NONE of them, because
   * experts group findings and label mechanisms differently every run. A test that fails every time
   * is not conservative, it just reports every problem as brand new for ever.
   *
   * So a strong overlap is reported as a probable match, WITH its evidence, and never silently
   * promoted to the certainty an exact fingerprint carries.
   */
  const paths = project();
  const anchors = [
    'kpi:enquiry_to_contacted',
    'workflow:05 No-Show Recovery',
    'workflow:06 Cancellation Recovery',
    'workflow:02 Booking Confirmation + Reminders',
  ];
  recordRun({ paths, runId: 'run_week_one', investigation: investigationOf(cause('cause_a', { anchors })), occurredAt: WEEK_ONE });

  // Same four objects, plus one more the experts added this week, and a DIFFERENT mechanism label.
  const comparison = compareToHistory({
    investigation: investigationOf(cause('cause_b', {
      mechanisms: ['stage_or_disposition_data_quality'],
      anchors: [...anchors, 'workflow:03 Reschedule Handler'],
    })),
    observations: readObservations({ paths }),
    runId: 'run_week_two',
  });

  const [only] = comparison.causes;
  assert.equal(only.status, 'LIKELY_RECURRING');
  assert.equal(only.matchedOn, 'anchor_overlap');
  assert.equal(only.firstSeenAt, WEEK_ONE);
  assert.equal(only.match.sharedAnchors, 4);
  assert.equal(only.match.similarity, 0.8);
  // The label disagreed and it still matched, because the anchors are account objects and the label
  // is one expert's opinion about them. The disagreement is REPORTED rather than used as a veto.
  assert.equal(only.match.mechanismAgreement, false);
  assert.equal(comparison.likelyRecurringCount, 1);
  // And it is not simultaneously reported as gone.
  assert.equal(comparison.absent.length, 0);
});

test('a small problem sitting inside a big one is NOT called recurring', () => {
  /*
   * Why the decision is symmetric. Most problems in one account point at the same busy workflows, so
   * a genuinely new small problem is often FULLY contained in a large old one. Containment alone
   * scores that 100%: replayed against the real history it matched 14 of 14, which is right for two
   * runs of one week and far too eager for a real one.
   */
  const paths = project();
  recordRun({
    paths,
    runId: 'run_week_one',
    investigation: investigationOf(cause('cause_big', {
      anchors: [
        'kpi:enquiry_to_contacted', 'kpi:strategy_call_to_showed', 'kpi:showed_to_decision',
        'workflow:01 Onboarding Ready', 'workflow:02 Access In Progress', 'workflow:03 Strategy In Progress',
        'workflow:04 Strategy Sent', 'workflow:05 No-Show Recovery', 'workflow:06 Cancellation Recovery',
      ],
    })),
    occurredAt: WEEK_ONE,
  });

  const comparison = compareToHistory({
    investigation: investigationOf(cause('cause_small', {
      anchors: ['workflow:05 No-Show Recovery', 'workflow:06 Cancellation Recovery', 'kpi:enquiry_to_contacted'],
    })),
    observations: readObservations({ paths }),
    runId: 'run_week_two',
  });

  const [only] = comparison.causes;
  // Every anchor it has is in the older problem, so containment is 1.0 and it is still not a match.
  assert.equal(only.nearMatches[0].anchorOverlap, 1);
  assert.equal(only.status, 'NEW');
});

test('two problems cannot both claim the same ancestor, whatever order they arrive in', () => {
  /*
   * Both halves matter. If two causes claim one earlier problem then at least one is wrong, and the
   * absent list starts contradicting the table above it. And the assignment must not depend on the
   * order the experts' causes happened to be grouped, because these artefacts are hashed and
   * byte-compared: an order-dependent answer is a correctness bug, not an aesthetic one.
   */
  const paths = project();
  const shared = [
    'kpi:enquiry_to_contacted',
    'workflow:05 No-Show Recovery',
    'workflow:06 Cancellation Recovery',
    'workflow:02 Booking Confirmation + Reminders',
  ];
  recordRun({ paths, runId: 'run_week_one', investigation: investigationOf(cause('ancestor', { anchors: shared })), occurredAt: WEEK_ONE });

  // Same objects, different family label, so the fingerprint differs and it competes on similarity
  // rather than matching exactly.
  const near = cause('cause_near', { mechanisms: ['stage_or_disposition_data_quality'], anchors: shared });
  const weaker = cause('cause_weaker', { anchors: [...shared.slice(0, 3), 'workflow:10 Live', 'workflow:07 Send Contract'] });
  const observations = readObservations({ paths });

  const forwards = compareToHistory({ investigation: investigationOf(near, weaker), observations, runId: 'run_week_two' });
  const backwards = compareToHistory({ investigation: investigationOf(weaker, near), observations, runId: 'run_week_two' });

  const claimed = forwards.causes.filter((entry) => entry.matchedFingerprint !== undefined);
  assert.equal(claimed.length, 1, 'exactly one cause may inherit the ancestor');
  assert.equal(claimed[0].causeId, 'cause_near', 'and it must be the stronger match');

  const shape = (result) => result.causes
    .map((entry) => `${entry.causeId}:${entry.status}:${entry.matchedFingerprint ?? ''}`)
    .sort()
    .join('|');
  assert.equal(shape(forwards), shape(backwards), 'the answer must not depend on cause order');
});

test('matching maximises the number of defensible ancestors before taking the strongest single pair', () => {
  /*
   * Greedy strength-first matching loses a real continuation here. `flexible` can use either old
   * cause, while `constrained` can only use the first. Taking the perfect flexible-to-first pair
   * leaves constrained NEW even though a complete two-pair assignment exists.
   */
  const paths = project();
  const shared = ['kpi:a', 'workflow:a', 'workflow:b'];
  recordRun({
    paths,
    runId: 'run_week_one',
    investigation: investigationOf(
      cause('old_first', { anchors: [...shared, 'workflow:c', 'workflow:d'] }),
      cause('old_second', { anchors: [...shared, 'workflow:e', 'workflow:f'] }),
    ),
    occurredAt: WEEK_ONE,
  });

  const flexible = cause('flexible', {
    mechanisms: ['delivery_failure'],
    anchors: [...shared, 'workflow:c', 'workflow:d', 'workflow:e', 'workflow:f'],
  });
  const constrained = cause('constrained', {
    mechanisms: ['stage_or_disposition_data_quality'],
    anchors: [...shared, 'workflow:c', 'workflow:d'],
  });
  const observations = readObservations({ paths });

  const comparison = compareToHistory({
    investigation: investigationOf(flexible, constrained),
    observations,
    runId: 'run_week_two',
    currentOccurredAt: WEEK_TWO,
  });

  assert.equal(comparison.likelyRecurringCount, 2);
  assert.equal(
    new Set(comparison.causes.map((entry) => entry.matchedFingerprint)).size,
    2,
    'each current cause must receive a distinct defensible ancestor',
  );
});

test('reruns of one closed week collapse to one canonical baseline and never become prior weeks', () => {
  const paths = project();
  recordRun({
    paths,
    runId: 'run_week_one_draft',
    investigation: investigationOf(cause('draft')),
    occurredAt: WEEK_ONE,
  });
  recordRun({
    paths,
    runId: 'run_week_one_final',
    investigation: investigationOf(cause('final', { mechanisms: ['delivery_failure'] })),
    occurredAt: WEEK_ONE,
  });

  const sameWeek = readCanonicalHistory({ paths, currentOccurredAt: WEEK_ONE });
  assert.equal(sameWeek.priorWeekCount, 0);
  assert.deepEqual(sameWeek.observations, []);

  const nextWeek = readCanonicalHistory({ paths, currentOccurredAt: WEEK_TWO });
  assert.equal(nextWeek.priorWeekCount, 1);
  assert.deepEqual(
    [...new Set(nextWeek.observations.map((event) => event.runId))],
    ['run_week_one_final'],
    'the latest successful rerun is the single canonical baseline for that closed week',
  );

  const comparison = compareToHistory({
    investigation: investigationOf(cause('next')),
    observations: nextWeek.observations,
    runId: 'run_week_two',
    currentOccurredAt: WEEK_TWO,
  });
  assert.equal(comparison.priorWeekCount, 1);
  assert.equal(comparison.priorRunCount, 1, 'legacy field remains an alias for canonical weeks');
});

test('a canonical quiet week still counts as history even though it has no finding events', () => {
  const paths = project();
  recordRun({
    paths,
    runId: 'run_quiet_week',
    investigation: investigationOf(),
    occurredAt: WEEK_ONE,
  });

  const history = readCanonicalHistory({ paths, currentOccurredAt: WEEK_TWO });
  assert.equal(history.priorWeekCount, 1);
  assert.deepEqual(history.observations, []);

  const comparison = compareToHistory({
    investigation: investigationOf(cause('new_after_quiet')),
    observations: history.observations,
    canonicalWeekCount: history.priorWeekCount,
    runId: 'run_week_two',
    currentOccurredAt: WEEK_TWO,
  });
  assert.equal(comparison.priorWeekCount, 1);
  assert.equal(comparison.newCount, 1);
});

test('this run cannot make its own causes look recurring', () => {
  // The ordering trap: record after comparing, or every problem is instantly its own history.
  const paths = project();
  const investigation = investigationOf(cause('cause_a'));
  recordRun({ paths, runId: 'run_one', investigation, occurredAt: WEEK_ONE });

  const comparison = compareToHistory({
    investigation,
    observations: readObservations({ paths }),
    runId: 'run_one',
  });
  assert.equal(comparison.priorRunCount, 0);
  assert.equal(comparison.newCount, 1);
  assert.equal(comparison.recurringCount, 0);
});

test('recording the same run twice is a no-op, not a second observation', () => {
  const paths = project();
  const investigation = investigationOf(cause('cause_a'));
  const first = recordRun({ paths, runId: 'run_one', investigation, occurredAt: WEEK_ONE });
  const again = recordRun({ paths, runId: 'run_one', investigation, occurredAt: WEEK_ONE });

  assert.equal(first.recorded[0].recovered, false);
  assert.equal(again.recorded[0].recovered, true, 'a replay must be recognised rather than duplicated');
  assert.equal(readObservations({ paths }).length, 1);
});

test('the timestamp comes from the run, so a replay cannot drift', () => {
  const paths = project();
  assert.throws(
    () => recordRun({ paths, runId: 'run_one', investigation: investigationOf(cause('cause_a')) }),
    /RECURRENCE_OCCURRED_AT_INVALID/u,
  );
  assert.throws(
    () => recordRun({ paths, runId: 'run_one', investigation: investigationOf(cause('cause_a')), occurredAt: 'last Tuesday' }),
    /RECURRENCE_OCCURRED_AT_INVALID/u,
  );
});

test('a first run says so, rather than presenting an empty comparison as no change', () => {
  const comparison = compareToHistory({
    investigation: investigationOf(cause('cause_a')),
    observations: [],
    runId: 'run_one',
  });
  assert.equal(comparison.priorRunCount, 0);
  assert.deepEqual(comparison.absent, []);
  assert.equal(comparison.causes[0].status, 'NEW');
});

test('an unreadable ledger returns no history rather than throwing', () => {
  // A run must still produce a report when the history is missing or corrupt.
  assert.deepEqual(readObservations({ paths: { memoryEvents: '/nonexistent/path/for/this/test' } }), []);
  assert.deepEqual(readObservations({}), []);
});
