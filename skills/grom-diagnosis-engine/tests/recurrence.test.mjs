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

test('a near miss is REPORTED, not silently matched', () => {
  /*
   * Renaming a workflow changes the fingerprint. Loosening identity to absorb that would let the
   * report claim a problem is recurring when it may be a different one, so the overlap is stated and
   * the reader decides.
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
  assert.equal(only.status, 'NEW', 'a near miss must NOT be promoted to a match');
  assert.equal(only.nearMatches.length, 1);
  assert.ok(only.nearMatches[0].anchorOverlap >= 0.6);
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
