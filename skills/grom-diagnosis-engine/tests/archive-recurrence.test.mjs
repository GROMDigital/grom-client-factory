/**
 * WEEK-OVER-WEEK, the only place in this system that can produce the word "fixed".
 *
 * Untested until an external review said so. Every test here is about NOT saying "fixed" when the
 * evidence does not support it, because that is the failure with a real cost: a client stops
 * looking at a problem that is still there.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareWeeks, joinable, nextSupersededPath, parseChangesMade } from '../lib/archive-recurrence.mjs';

function block(causeId, { status = 'NOT STARTED', did = '', print = null } = {}) {
  return [
    `### ${causeId}`,
    `**Status:** ${status}`,
    `**What was actually done:** ${did}`,
    ...(print === null ? [] : [`**fingerprint:** \`${print}\``]),
    '',
  ].join('\n');
}

test('a well-formed file parses into its blocks', () => {
  const claimed = parseChangesMade([
    '# Changes made',
    '',
    block('cause_aaa1', { status: 'DONE 2026-07-28', did: 'Turned off allowMultiple', print: 'deadbeef01' }),
    block('cause_bbb2', { print: 'feedface02' }),
  ].join('\n'));

  assert.equal(claimed.size, 2);
  assert.equal(claimed.get('cause_aaa1').status, 'DONE 2026-07-28');
  assert.equal(claimed.get('cause_aaa1').did, 'Turned off allowMultiple');
  assert.equal(claimed.get('cause_aaa1').print, 'deadbeef01');
  assert.equal(claimed.get('cause_bbb2').status, 'NOT STARTED', 'an unfilled status is not treated as done');
});

test('ONE missing fingerprint refuses the whole comparison', () => {
  /*
   * The exact defect an external review found. Nine good blocks made the file look modern, so the
   * old "did ANY block have a fingerprint" check passed, and the tenth DONE block — with no
   * fingerprint — matched nothing this week and was reported as FIXED.
   */
  const good = Array.from({ length: 9 }, (_, index) => block(`cause_0a0a0${index}`, {
    status: 'DONE', print: `aaaaaaaa0${index}`,
  }));
  const claimed = parseChangesMade([
    ...good,
    block('cause_faceface', { status: 'DONE 2026-07-28', did: 'Rewrote the SMS' }),
  ].join('\n'));

  assert.equal(joinable(claimed).ok, false);
  assert.equal(joinable(claimed).reason, 'MISSING_FINGERPRINT');

  const result = compareWeeks({ claimed, thisWeeksFingerprints: ['aaaaaaaa00'] });
  assert.equal(result.concluded, false);
  assert.deepEqual(result.gone, [], 'nothing may be called fixed');
  assert.deepEqual(result.stillHere, []);
  assert.deepEqual(result.acted, []);
});

test('two blocks sharing a fingerprint refuses the comparison', () => {
  const claimed = parseChangesMade([
    block('cause_aaa1', { status: 'DONE', print: 'deadbeef01' }),
    block('cause_bbb2', { status: 'DONE', print: 'deadbeef01' }),
  ].join('\n'));
  assert.equal(joinable(claimed).reason, 'DUPLICATE_FINGERPRINT');
  assert.equal(compareWeeks({ claimed, thisWeeksFingerprints: [] }).concluded, false);
});

test('a complete file sorts last week into fixed, still here, and gone on its own', () => {
  const claimed = parseChangesMade([
    block('cause_0fed0', { status: 'DONE 2026-07-28', did: 'Set stopOnResponse', print: 'aaaaaaaa01' }),
    block('cause_d1d0', { status: 'DONE 2026-07-28', did: 'Reworded the email', print: 'bbbbbbbb02' }),
    block('cause_e0e0', { status: 'NOT STARTED', print: 'cccccccc03' }),
    block('cause_d21f', { status: 'NOT STARTED', print: 'dddddddd04' }),
  ].join('\n'));

  // This week still finds `didnt` and `never`; the other two are absent.
  const result = compareWeeks({ claimed, thisWeeksFingerprints: ['bbbbbbbb02', 'cccccccc03'] });

  assert.equal(result.concluded, true);
  assert.deepEqual(result.gone.map(([id]) => id), ['cause_0fed0'], 'actioned and no longer found');
  assert.deepEqual(result.stillHere.map(([id]) => id), ['cause_d1d0'], 'actioned and still found');
  assert.deepEqual(
    result.untouchedGone.map(([id]) => id),
    ['cause_d21f'],
    'gone without anyone touching it is NOT a fix and is reported separately',
  );
});

test('a likely-recurring descendant prevents LAST-WEEK from calling an actioned cause fixed', () => {
  const claimed = parseChangesMade(block('cause_0fed0', {
    status: 'DONE 2026-07-28',
    did: 'Changed the nurture handoff',
    print: 'aaaaaaaa01',
  }));

  const result = compareWeeks({
    claimed,
    thisWeeksFingerprints: ['bbbbbbbb02'],
    recurrence: {
      causes: [{
        fingerprint: 'bbbbbbbb02',
        status: 'LIKELY_RECURRING',
        matchedFingerprint: 'aaaaaaaa01',
      }],
    },
  });

  assert.equal(result.concluded, true);
  assert.deepEqual(result.gone, [], 'a probable descendant is not evidence that the problem was fixed');
  assert.deepEqual(result.stillHere.map(([id]) => id), ['cause_0fed0']);
  assert.deepEqual(result.stillHereLikely.map(([id]) => id), ['cause_0fed0']);
});

test('an empty file concludes nothing, and says so differently', () => {
  const claimed = parseChangesMade('# Changes made\n\nnothing recorded\n');
  assert.equal(claimed.size, 0);
  assert.equal(joinable(claimed).reason, 'EMPTY');
  assert.equal(compareWeeks({ claimed, thisWeeksFingerprints: ['aaaaaaaa01'] }).concluded, false);
});

test('a malformed fingerprint is treated as missing, not parsed loosely', () => {
  for (const bad of ['NOT-A-HASH', 'zzzz', 'abc']) {
    const claimed = parseChangesMade(block('cause_aaa1', { status: 'DONE', print: bad }));
    assert.equal(
      joinable(claimed).ok,
      false,
      `${bad} must not pass as a fingerprint`,
    );
  }
});

// ---------------------------------------------------------------------------
// Superseding an already-filed week
// ---------------------------------------------------------------------------

test('an already-filed week is moved aside to a numbered folder, never written over', () => {
  const taken = new Set();
  const exists = (path) => taken.has(path);

  assert.equal(nextSupersededPath('/x/2026-07-27', exists), '/x/2026-07-27.superseded-1');

  taken.add('/x/2026-07-27.superseded-1');
  assert.equal(nextSupersededPath('/x/2026-07-27', exists), '/x/2026-07-27.superseded-2');

  taken.add('/x/2026-07-27.superseded-2');
  taken.add('/x/2026-07-27.superseded-3');
  assert.equal(
    nextSupersededPath('/x/2026-07-27', exists),
    '/x/2026-07-27.superseded-4',
    'it must skip every taken ordinal, not just the first',
  );
});

test('superseding never returns a path that already exists', () => {
  /*
   * The whole point: the returned path is renamed ONTO, so handing back an existing directory
   * would destroy a previous diagnosis. Two runs of the same closed week is the normal case, not
   * an edge case, so this is the guarantee that matters.
   */
  const taken = new Set(['/x/w.superseded-1', '/x/w.superseded-2', '/x/w.superseded-3']);
  const chosen = nextSupersededPath('/x/w', (p) => taken.has(p));
  assert.equal(taken.has(chosen), false);
});

test('a runaway caller is refused rather than looping forever', () => {
  assert.throws(() => nextSupersededPath('/x/w', () => true), /ARCHIVE_SUPERSEDE_EXHAUSTED/u);
  assert.throws(() => nextSupersededPath('', () => false), TypeError);
});
