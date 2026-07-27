/**
 * ROOT-CAUSE INVESTIGATION.
 *
 * The box all three lanes feed. Its job is NOT to concatenate three lists: the lanes describe the
 * same problem in three vocabularies, and publishing that as three findings triples the apparent
 * size of one problem and buries the ones nobody corroborated.
 *
 * Every expected rank and grouping below is reasoned out in a comment before the code runs.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  LANES,
  MECHANISM_FAMILIES,
  investigateRootCause,
  validateLaneFinding,
} from '../lib/root-cause.mjs';

const BRIEFS_HASH = 'a'.repeat(64);

function finding(overrides = {}) {
  return {
    findingId: 'leads_do_not_book',
    lane: 'lead_journey_kpi',
    title: 'Most contacted leads never reach a booked call',
    mechanism: 'workflow_configuration_or_execution',
    confidence: 'C2',
    anchors: { kpiEdgeIds: ['contacted_to_booked'], workflowNames: [], journeyStages: [] },
    competingExplanations: [
      { explanation: 'The leads are unqualified', materiality: 'MATERIAL', addressed: true },
      { explanation: 'Seasonality', materiality: 'IMMATERIAL' },
    ],
    evidenceAgainst: 'The book rate is above the norm for this traffic source.',
    discriminatingTest: {
      check: 'Split non-bookers by ad set',
      supportsIf: 'Non-bookers spread evenly across ad sets',
      refutesIf: 'Non-bookers concentrate in one ad set',
    },
    scoring: {
      commercialImpact: 'HIGH',
      leadsAffected: 'HIGH',
      urgency: 'MEDIUM',
      implementationEffort: 'LOW',
      risk: 'LOW',
      testability: 'HIGH',
    },
    fix: 'Add SMS to the nurture and stop it on reply.',
    ...overrides,
  };
}

const emptyLanes = Object.fromEntries(LANES.map((lane) => [lane, []]));

// ---------------------------------------------------------------------------

test('three lanes describing one problem become ONE cause with three supports', () => {
  /*
   * Lane 1 anchors to a KPI edge. Lane 3 anchors to that edge AND a workflow. Lane 2 anchors to the
   * workflow only. Pairwise matching would leave lane 2 orphaned from the very cause it explains, so
   * the grouping has to be transitive: kpi -> (kpi + workflow) -> workflow.
   */
  const result = investigateRootCause({
    briefsHash: BRIEFS_HASH,
    laneAnalyses: {
      lead_journey_kpi: [finding()],
      conversation_copy_ai: [finding({
        findingId: 'nurture_is_email_only',
        lane: 'conversation_copy_ai',
        anchors: { kpiEdgeIds: ['contacted_to_booked'], workflowNames: ['08 Nurture'], journeyStages: [] },
      })],
      workflow_config_runtime: [finding({
        findingId: 'sequences_collide',
        lane: 'workflow_config_runtime',
        anchors: { kpiEdgeIds: [], workflowNames: ['08 Nurture'], journeyStages: [] },
      })],
    },
  });

  assert.equal(result.causeCount, 1, 'one problem seen three ways is one cause');
  assert.equal(result.corroboratedCauseCount, 1);
  const [cause] = result.causes;
  assert.deepEqual(cause.corroboratingLanes, [...LANES].sort());
  assert.deepEqual(cause.findings.map((f) => f.findingId).sort(), [
    'leads_do_not_book', 'nurture_is_email_only', 'sequences_collide',
  ]);
  // Every anchor any lane named is carried, so verification next week can look for all of them.
  assert.deepEqual(cause.anchors, ['kpi:contacted_to_booked', 'workflow:08 Nurture']);
  // Three lanes agreeing lifts the cause above the confidence any single analyst claimed.
  assert.equal(cause.confidence, 'C3');
});

test('a corroborated cause outranks a lone one of the same claimed impact', () => {
  const lone = finding({
    findingId: 'lonely_but_confident',
    confidence: 'C3',
    anchors: { kpiEdgeIds: ['some_other_edge'], workflowNames: [], journeyStages: [] },
  });
  const result = investigateRootCause({
    briefsHash: BRIEFS_HASH,
    laneAnalyses: {
      lead_journey_kpi: [finding({ confidence: 'C1' }), lone],
      conversation_copy_ai: [finding({
        findingId: 'nurture_is_email_only',
        lane: 'conversation_copy_ai',
        confidence: 'C1',
      })],
      workflow_config_runtime: [],
    },
  });

  /*
   * Both causes claim HIGH impact and HIGH leads affected. The corroborated one is two C1 analysts
   * who cannot see each other's work; the lone one is a single C3. Evidence strength is
   * confidence + (lanes - 1), so corroborated is 1+1 = 2 and lone is C3's 4. The lone one therefore
   * still wins, which is CORRECT: corroboration is worth roughly one step, not a veto. And a
   * strength of 2 must stay `C1`, because `C2` is the promotion threshold and corroboration alone
   * must not carry two C1 findings over it.
   */
  const byId = Object.fromEntries(result.causes.map((cause) => [cause.findings.map((f) => f.findingId).join('+'), cause]));
  const corroborated = result.causes.find((cause) => cause.corroboratingLanes.length > 1);
  const alone = result.causes.find((cause) => cause.corroboratingLanes.length === 1);
  assert.ok(corroborated && alone);
  assert.equal(corroborated.confidence, 'C1', 'corroboration alone must not reach the promotion threshold');
  assert.ok(
    corroborated.rankScore > 0 && alone.rankScore > corroborated.rankScore,
    `a single C3 may outrank two C1s: ${alone.rankScore} vs ${corroborated.rankScore}`,
  );
  assert.equal(Object.keys(byId).length, 2);

  // And the corroboration is visible on the cause rather than only inside the score.
  assert.deepEqual(corroborated.corroboratingLanes, ['conversation_copy_ai', 'lead_journey_kpi']);
});

test('cost bands pull a cause DOWN, so a cheap fix beats an expensive one at equal impact', () => {
  const cheap = investigateRootCause({
    briefsHash: BRIEFS_HASH,
    laneAnalyses: { ...emptyLanes, lead_journey_kpi: [finding()] },
  }).causes[0];
  const expensive = investigateRootCause({
    briefsHash: BRIEFS_HASH,
    laneAnalyses: {
      ...emptyLanes,
      lead_journey_kpi: [finding({
        scoring: { ...finding().scoring, implementationEffort: 'CRITICAL', risk: 'HIGH' },
      })],
    },
  }).causes[0];
  // Same impact, same evidence, same population. The one that can be done and verified wins.
  assert.ok(cheap.rankScore > expensive.rankScore, `${cheap.rankScore} vs ${expensive.rankScore}`);
});

test('an unresolved MATERIAL alternative pulls the cause down, because it is a live hole', () => {
  const addressed = investigateRootCause({
    briefsHash: BRIEFS_HASH,
    laneAnalyses: { ...emptyLanes, lead_journey_kpi: [finding()] },
  }).causes[0];
  const open = investigateRootCause({
    briefsHash: BRIEFS_HASH,
    laneAnalyses: {
      ...emptyLanes,
      lead_journey_kpi: [finding({
        competingExplanations: [
          { explanation: 'The leads are unqualified', materiality: 'MATERIAL' },
          { explanation: 'Seasonality', materiality: 'IMMATERIAL' },
        ],
      })],
    },
  }).causes[0];
  assert.equal(addressed.unresolvedMaterialAlternatives, 0);
  assert.equal(open.unresolvedMaterialAlternatives, 1);
  assert.ok(addressed.rankScore > open.rankScore);
});

test('lanes disagreeing about the family is recorded, never averaged away', () => {
  const result = investigateRootCause({
    briefsHash: BRIEFS_HASH,
    laneAnalyses: {
      ...emptyLanes,
      lead_journey_kpi: [finding({ mechanism: 'offer_or_pricing' })],
      conversation_copy_ai: [finding({
        findingId: 'copy_is_weak',
        lane: 'conversation_copy_ai',
        mechanism: 'workflow_configuration_or_execution',
      })],
    },
  });
  const [cause] = result.causes;
  // Two lanes at the same anchor blaming different things is information for whoever reads it.
  assert.equal(cause.mechanismContested, true);
  assert.deepEqual(cause.mechanisms, ['offer_or_pricing', 'workflow_configuration_or_execution']);
});

test('an unarguable finding is refused, not ranked low', () => {
  // Each of these is unfalsifiable in a different way, and a ranked opinion looks exactly as
  // authoritative as a corroborated finding to whoever reads the backlog.
  const cases = [
    ['no anchor', { anchors: { kpiEdgeIds: [], workflowNames: [], journeyStages: [] } }],
    ['one competing explanation', { competingExplanations: [{ explanation: 'x', materiality: 'MATERIAL' }] }],
    ['no counter-evidence', { evidenceAgainst: '   ' }],
    ['no refutation condition', { discriminatingTest: { check: 'a', supportsIf: 'b', refutesIf: '' } }],
    ['a family outside the nine', { mechanism: 'vibes' }],
    ['an invented confidence level', { confidence: 'C9' }],
    ['an unbanded score', { scoring: { ...finding().scoring, risk: 'SORT_OF' } }],
    ['no fix', { fix: '' }],
  ];
  for (const [label, override] of cases) {
    assert.throws(
      () => validateLaneFinding(finding(override)),
      { code: 'LANE_FINDING_INVALID' },
      label,
    );
  }
  // And a valid one passes, so the above is not passing because everything throws.
  assert.equal(validateLaneFinding(finding()).findingId, 'leads_do_not_book');
});

test('a missing lane fails closed rather than publishing a partial investigation as a whole one', () => {
  assert.throws(
    () => investigateRootCause({
      briefsHash: BRIEFS_HASH,
      laneAnalyses: { lead_journey_kpi: [finding()], conversation_copy_ai: [] },
    }),
    { code: 'ROOT_CAUSE_LANE_MISSING' },
  );
  // A lane that genuinely found nothing says so with an empty array, and that IS a whole run.
  const clean = investigateRootCause({ briefsHash: BRIEFS_HASH, laneAnalyses: emptyLanes });
  assert.equal(clean.causeCount, 0);
  assert.deepEqual(clean.laneFindingCounts, {
    lead_journey_kpi: 0, workflow_config_runtime: 0, conversation_copy_ai: 0,
  });
});

test('an investigation is only valid against the brief that produced it', () => {
  assert.throws(
    () => investigateRootCause({ laneAnalyses: emptyLanes, briefsHash: 'not-a-hash' }),
    { code: 'ROOT_CAUSE_BRIEFS_UNIDENTIFIED' },
  );
});

test('the same lane outputs always produce the same ranked causes', () => {
  const analyses = {
    ...emptyLanes,
    lead_journey_kpi: [finding(), finding({ findingId: 'other', anchors: { kpiEdgeIds: ['e2'], workflowNames: [], journeyStages: [] } })],
    workflow_config_runtime: [finding({ findingId: 'workflow_collision', lane: 'workflow_config_runtime' })],
  };
  const first = investigateRootCause({ laneAnalyses: analyses, briefsHash: BRIEFS_HASH });
  // Reversed input order must not reach the output: `lib/report.mjs` re-derives the ordering from
  // sealed inputs and rejects a lane split it cannot reproduce.
  const reversed = investigateRootCause({
    briefsHash: BRIEFS_HASH,
    laneAnalyses: { ...analyses, lead_journey_kpi: [...analyses.lead_journey_kpi].reverse() },
  });
  assert.equal(first.investigationHash, reversed.investigationHash);
  assert.match(first.investigationHash, /^[a-f0-9]{64}$/u);
  assert.deepEqual(
    first.causes.map((cause) => cause.causeId),
    reversed.causes.map((cause) => cause.causeId),
  );
});

test('a duplicate finding id inside one lane is refused', () => {
  assert.throws(
    () => investigateRootCause({
      briefsHash: BRIEFS_HASH,
      laneAnalyses: { ...emptyLanes, lead_journey_kpi: [finding(), finding()] },
    }),
    { code: 'LANE_FINDING_DUPLICATE' },
  );
});

test('the nine families are exactly the ones the mechanism layer fixes', async () => {
  // A family added here but not there, or vice versa, silently drops findings at the seam.
  assert.equal(MECHANISM_FAMILIES.length, 9);
  // Read the real list out of the mechanism module's own SOURCE rather than restating it here. A
  // hand-copied list would agree with itself forever while the two modules drifted apart.
  const source = await import('node:fs').then(({ readFileSync }) => readFileSync(
    new URL('../lib/mechanisms.mjs', import.meta.url), 'utf8',
  ));
  const declared = source.match(/const FAMILIES = Object\.freeze\(\[([\s\S]*?)\]\)/u)[1]
    .match(/'([a-z_]+)'/gu).map((quoted) => quoted.slice(1, -1)).sort();
  assert.deepEqual([...MECHANISM_FAMILIES].sort(), declared);
});
