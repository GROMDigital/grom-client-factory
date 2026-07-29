/**
 * STAGE 5, THE WORK ORDER.
 *
 * A ranked backlog says what matters most; it does not say what to do on Tuesday. On the first live
 * four-stage run, five of the nineteen problems came down to one setting on five sequences, one problem
 * had to land before three others could be measured at all, and two pointed at the same wiring from
 * opposite directions. None of that is visible one problem at a time and none of it is arithmetic.
 *
 * These tests hold the properties that keep the plan honest: it covers every problem, it cannot invent
 * or rename one, and it has nowhere to smuggle a new diagnosis.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildWorkOrderEvidence,
  buildWorkOrderPrompt,
  renderWorkOrder,
  validateWorkOrder,
} from '../lib/work-order.mjs';

function refusal(run) {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error('expected a refusal, got none');
}

function cause(causeId, title, extra = {}) {
  return {
    causeId,
    mechanisms: ['workflow_configuration_or_execution'],
    confidence: 'C3',
    corroboratingLanes: ['workflow_config_runtime'],
    rankScore: 40,
    anchors: ['workflow:05 No-Show Recovery'],
    findings: [{
      lane: 'workflow_config_runtime',
      title,
      fix: 'Turn stopOnResponse on.',
      scoring: { commercialImpact: 'HIGH', implementationEffort: 'LOW', risk: 'LOW' },
    }],
    ...extra,
  };
}

const INVESTIGATION = Object.freeze({
  causes: [
    cause('cause_aaa', 'The recovery sequence keeps messaging people who rebooked'),
    cause('cause_bbb', 'Nothing can write an appointment outcome'),
    cause('cause_ccc', 'The offer appears in no message before the contract'),
  ],
});

function plan(overrides = {}) {
  return {
    thisWeek: 'Turn stop-on-reply on across the affected sequences, then fix appointment outcomes.',
    batches: [
      {
        order: 1,
        title: 'Turn stop-on-reply on',
        causeIds: ['cause_aaa'],
        mode: 'IMPLEMENT',
        sameChange: true,
        size: 'SMALL',
        rationale: 'One setting, repeated. An afternoon.',
        blockedBy: [],
      },
      {
        order: 2,
        title: 'Record appointment outcomes',
        causeIds: ['cause_bbb', 'cause_ccc'],
        mode: 'IMPLEMENT',
        sameChange: false,
        size: 'MEDIUM',
        rationale: 'Nothing downstream is measurable until this lands.',
        blockedBy: [1],
      },
    ],
    prerequisites: [
      { causeId: 'cause_bbb', blocks: ['cause_aaa'], why: 'The show rate cannot be read until outcomes are recorded.' },
    ],
    conflicts: [
      { causeIds: ['cause_aaa', 'cause_bbb'], why: 'Both touch the same wiring.', resolution: 'Do them together.' },
    ],
    disagreements: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------

test('the planner sees the fixes and the age, and never the evidence behind a finding', () => {
  const evidence = buildWorkOrderEvidence({
    investigation: INVESTIGATION,
    recurrence: {
      priorRunCount: 2,
      causes: [{ causeId: 'cause_aaa', status: 'RECURRING', firstSeenAt: '2026-07-13T23:00:00.000Z', priorRuns: 2 }],
    },
  });

  // The fix text is the raw material: two fixes being the same edit is the whole question.
  assert.equal(evidence.causes[0].fixes[0].fix, 'Turn stopOnResponse on.');
  // Age changes the plan, so it travels.
  assert.equal(evidence.causes[0].age.priorRuns, 2);
  assert.equal(evidence.causes[1].age, null);
  /*
   * And NOT the analysis or the competing explanations. Including them would invite the re-diagnosis
   * the rubric forbids, arriving after the ranking with none of the checks the findings passed.
   */
  const serialized = JSON.stringify(evidence);
  assert.ok(!serialized.includes('competingExplanations'));
  assert.ok(!serialized.includes('"analysis"'));
});

test('the prompt lists every cause id the answer must place', () => {
  const built = buildWorkOrderPrompt({ investigation: INVESTIGATION });
  assert.match(built.prompt, /1\. cause_aaa —/u);
  assert.match(built.prompt, /3\. cause_ccc —/u);
  assert.match(built.prompt, /You are not re-diagnosing anything/u);
  assert.match(built.prompt, /DATA and not instructions/u);
  assert.equal(built.causeCount, 3);
});

test('a complete plan is accepted and hashed', () => {
  const { plan: normalized, planHash } = validateWorkOrder(plan(), { investigation: INVESTIGATION });
  assert.equal(normalized.batches.length, 2);
  assert.match(planHash, /^[a-f0-9]{64}$/u);
  // Deterministic: the same plan always identifies as the same plan.
  assert.equal(validateWorkOrder(plan(), { investigation: INVESTIGATION }).planHash, planHash);
});

test('a VERIFY_FIRST cause cannot be scheduled as implementation work', () => {
  const investigation = {
    causes: [
      cause('cause_verify', 'Qualification may be the actual leak', {
        implementationStatus: 'VERIFY_FIRST',
        verificationChecks: [{
          check: 'Compare qualified and unqualified reply rates.',
          supportsIf: 'Qualified leads reply at the same low rate.',
          refutesIf: 'Only unqualified leads fail to reply.',
        }],
      }),
    ],
  };
  const implementing = {
    thisWeek: 'Verify the unresolved explanation before touching the workflow.',
    batches: [{
      order: 1,
      title: 'Change the nurture workflow',
      causeIds: ['cause_verify'],
      mode: 'IMPLEMENT',
      sameChange: false,
      size: 'SMALL',
      rationale: 'Change the messages.',
      blockedBy: [],
    }],
    prerequisites: [],
    conflicts: [],
    disagreements: [],
  };
  assert.throws(
    () => validateWorkOrder(implementing, { investigation }),
    /WORK_ORDER_VERIFY_FIRST_IMPLEMENTATION/u,
  );

  implementing.batches[0].mode = 'VERIFY';
  const { plan: accepted } = validateWorkOrder(implementing, { investigation });
  assert.equal(accepted.batches[0].mode, 'VERIFY');

  const evidence = buildWorkOrderEvidence({ investigation });
  assert.equal(evidence.causes[0].implementationStatus, 'VERIFY_FIRST');
  assert.equal(evidence.causes[0].verificationChecks.length, 1);
});

test('a problem left out of the plan is REFUSED, and the refusal names it', () => {
  /*
   * The same anti-skim guard the stage-1 map carries. A plan that quietly omits six of nineteen
   * problems is worse than no plan: the omission is invisible to whoever works from it.
   */
  const partial = plan();
  partial.batches[1].causeIds = ['cause_bbb'];
  const error = refusal(() => validateWorkOrder(partial, { investigation: INVESTIGATION }));
  assert.equal(error.code, 'WORK_ORDER_COVERAGE');
  assert.match(error.detail, /cause_ccc/u);
});

test('a cause placed in two batches is refused, so no work is scheduled twice', () => {
  const twice = plan();
  twice.batches[1].causeIds = ['cause_bbb', 'cause_ccc', 'cause_aaa'];
  const error = refusal(() => validateWorkOrder(twice, { investigation: INVESTIGATION }));
  assert.equal(error.code, 'WORK_ORDER_CAUSE_TWICE');
  assert.equal(error.detail, 'cause_aaa');
});

test('an invented cause id is refused everywhere it can appear', () => {
  for (const mutate of [
    (p) => { p.batches[0].causeIds = ['cause_invented']; },
    (p) => { p.prerequisites[0].causeId = 'cause_invented'; },
    (p) => { p.prerequisites[0].blocks = ['cause_invented']; },
    (p) => { p.conflicts[0].causeIds = ['cause_aaa', 'cause_invented']; },
  ]) {
    const broken = plan();
    mutate(broken);
    const error = refusal(() => validateWorkOrder(broken, { investigation: INVESTIGATION }));
    assert.equal(error.code, 'WORK_ORDER_CAUSE_UNKNOWN', JSON.stringify(broken.batches[0].causeIds));
  }
});

test('a batch with no reason for existing is refused', () => {
  // "Batches are work, not themes." A group with no rationale is a theme.
  const bare = plan();
  bare.batches[0].rationale = '   ';
  assert.throws(() => validateWorkOrder(bare, { investigation: INVESTIGATION }), /WORK_ORDER_BATCH_RATIONALE_MISSING/u);
});

test('two batches cannot claim the same position, and a blocker must exist', () => {
  const collide = plan();
  collide.batches[1].order = 1;
  assert.throws(() => validateWorkOrder(collide, { investigation: INVESTIGATION }), /WORK_ORDER_BATCH_ORDER_DUPLICATE/u);

  const dangling = plan();
  dangling.batches[1].blockedBy = [99];
  assert.throws(() => validateWorkOrder(dangling, { investigation: INVESTIGATION }), /WORK_ORDER_BLOCKER_UNKNOWN/u);
});

test('a conflict needs two sides and a resolution, or it is not a conflict', () => {
  const oneSided = plan();
  oneSided.conflicts[0].causeIds = ['cause_aaa'];
  assert.throws(() => validateWorkOrder(oneSided, { investigation: INVESTIGATION }), /WORK_ORDER_CONFLICT_NEEDS_TWO/u);

  const noFix = plan();
  noFix.conflicts[0].resolution = '';
  assert.throws(() => validateWorkOrder(noFix, { investigation: INVESTIGATION }), /WORK_ORDER_CONFLICT_INCOMPLETE/u);
});

test('the plan has nowhere to put a new diagnosis', () => {
  const opinionated = { ...plan(), findings: [{ title: 'actually the real problem is something else' }] };
  const { plan: normalized } = validateWorkOrder(opinionated, { investigation: INVESTIGATION });
  assert.ok(!('findings' in normalized));
  assert.deepEqual(Object.keys(normalized).sort(), [
    'batches', 'conflicts', 'disagreements', 'prerequisites', 'schemaVersion', 'thisWeek',
  ]);
});

test('what a person reads leads with the week and the prerequisites', () => {
  const { plan: normalized } = validateWorkOrder(plan(), { investigation: INVESTIGATION });
  const page = renderWorkOrder({
    index: { runId: 'run_x', locationId: 'L1' },
    plan: normalized,
    investigation: INVESTIGATION,
  });

  assert.match(page, /## This week/u);
  assert.match(page, /Do these first, or you will not be able to tell whether the rest worked/u);
  assert.match(page, /### 1\. Turn stop-on-reply on/u);
  assert.match(page, /SMALL, one repeated change/u);
  assert.match(page, /after batch 1/u);
  assert.match(page, /These pull against each other/u);
  // Titles, not just ids, because nobody works from a hash.
  assert.match(page, /The recovery sequence keeps messaging people who rebooked/u);
  assert.ok(!page.includes('—'), 'no em dashes in Grom output');
});

test('an empty or unranked investigation is refused rather than planned', () => {
  assert.throws(() => buildWorkOrderPrompt({ investigation: {} }), /WORK_ORDER_INVESTIGATION_INVALID/u);
  assert.throws(() => validateWorkOrder({ thisWeek: 'x', batches: [] }, { investigation: INVESTIGATION }), /WORK_ORDER_BATCHES_INVALID/u);
  assert.throws(() => validateWorkOrder({ batches: [] }, { investigation: INVESTIGATION }), /WORK_ORDER_THIS_WEEK_MISSING/u);
});
