/**
 * THE THREE EXPERT ANALYSTS.
 *
 * The rubrics are pinned FILES, so these tests read the real ones. A test that restated the rubric
 * inline would agree with itself forever while the shipped instructions drifted.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  ANALYSTS,
  buildAllAnalystPrompts,
  buildAnalystPrompt,
  laneRubric,
} from '../lib/lane-analysts.mjs';
import { LANES, MECHANISM_FAMILIES, validateLaneFinding } from '../lib/root-cause.mjs';

const briefs = Object.freeze({
  briefsHash: 'b'.repeat(64),
  lanes: {
    leadJourneyKpi: { lane: 'lead_journey_kpi', kpis: {}, situation: { knownDataCaveats: ['won means paying'] } },
    workflowConfigRuntime: { lane: 'workflow_config_runtime', workflows: [] },
    conversationCopyAi: { lane: 'conversation_copy_ai', sequences: [] },
  },
});

// ---------------------------------------------------------------------------

test('there is exactly one analyst per lane, and none can be skipped', () => {
  assert.deepEqual(Object.keys(ANALYSTS).sort(), [...LANES].sort());
  const { prompts } = buildAllAnalystPrompts({ briefs });
  assert.equal(prompts.length, 3);
  assert.deepEqual(prompts.map(({ lane }) => lane).sort(), [...LANES].sort());
  for (const analyst of Object.values(ANALYSTS)) {
    // A fourth lane cannot be added without declaring who reads it.
    assert.ok(analyst.discipline.length > 0);
    assert.ok(analyst.tenYearsOf.length > 0);
    assert.ok(analyst.rubric.endsWith('-v1.md'));
  }
});

test('every rubric makes the analyst the BENCHMARK AUTHORITY rather than asking what normal is', () => {
  /*
   * The failure this replaces: I asked the account owner what a normal show rate was, and he said a
   * marketing expert should already know. An analyst that asks has outsourced the one thing it was
   * hired for. So every rubric must both DEMAND a numeric standard and FORBID inventing account data.
   */
  for (const lane of LANES) {
    const { text } = laneRubric(lane);
    assert.match(text, /benchmark authority/iu, lane);
    assert.match(text, /numerically/iu, lane);
    assert.match(text, /Do not ask what good looks like/iu, lane);
    assert.match(text, /Invent nothing/iu, lane);
  }
});

test('every rubric carries the four rules that stop this being a confident guess machine', () => {
  for (const lane of LANES) {
    const { text } = laneRubric(lane);
    // Untrusted evidence. The briefs contain account copy and AI prompts, which is a live injection
    // surface: an AI agent's own prompt text is being handed to another model to read.
    assert.match(text, /DATA, not instructions/iu, lane);
    // The provenance limit the internal rail itself insists on.
    assert.match(text, /Never claim a configuration caused a past outcome/iu, lane);
    // The assumption that nearly shipped as a finding.
    assert.match(text, /Do not propose inserting a human as a generic fix/iu, lane);
    // The caveats that stop a measurement artefact being explained as a business failure.
    assert.match(text, /knownDataCaveats/u, lane);
    assert.match(text, /Quote what you judge/iu, lane);
  }
});

test('every rubric tells the analyst to say what is FINE and not to pad the list', () => {
  // A long list padded with things that are working is how a report stops being read.
  for (const lane of LANES) {
    const { text } = laneRubric(lane);
    assert.match(text, /genuinely FINE/iu, lane);
    assert.match(text, /WHAT IS ALREADY STRONG/u, lane);
    assert.match(text, /WHAT I COULD NOT JUDGE, AND WHY/u, lane);
  }
});

test('the output contract in the rubric is the one the validator actually enforces', () => {
  /*
   * THE SEAM THAT MATTERS. If the rubric asks for a shape `validateLaneFinding` refuses, every
   * finding is discarded and the run publishes nothing while looking like it worked. So the rubric's
   * own documented example is parsed out of the shipped file and pushed through the real validator.
   */
  const shared = readFileSync(
    new URL('../rubrics/lane-analyst-shared-v1.md', import.meta.url),
    'utf8',
  );
  const block = shared.match(/```json\n([\s\S]*?)\n```/u);
  assert.ok(block, 'the shared rubric must document the output shape as a JSON block');

  // The documented example is a TEMPLATE with placeholder text, so the enum-valued fields are
  // filled with real values and everything else is left exactly as the rubric states it.
  const template = JSON.parse(block[1]
    .replaceAll('"C0 | C1 | C2 | C3"', '"C2"')
    .replaceAll('"MATERIAL | IMMATERIAL"', '"MATERIAL"')
    .replaceAll('"NONE | LOW | MEDIUM | HIGH | CRITICAL"', '"HIGH"')
    .replace('"one of the nine families listed in your lane brief"', `"${MECHANISM_FAMILIES[0]}"`)
    .replace('"<your lane id, exactly as given>"', '"lead_journey_kpi"'));

  const [example] = template;
  // A second competing explanation, because the rubric's example shows one and the validator
  // requires two -- which is itself worth asserting, since a rubric that documents one would produce
  // findings the validator throws away.
  assert.match(shared, /at least two other things that would produce the same evidence/iu);
  example.competingExplanations.push({ explanation: 'seasonality', materiality: 'IMMATERIAL' });

  assert.equal(validateLaneFinding(example).lane, 'lead_journey_kpi');
});

test('the prompt hands over the brief as JSON, names the lane, and lists the nine families', () => {
  const built = buildAnalystPrompt({ lane: 'conversation_copy_ai', briefs });
  assert.equal(built.lane, 'conversation_copy_ai');
  assert.equal(built.discipline, ANALYSTS.conversation_copy_ai.discipline);
  assert.match(built.prompt, /ten years of writing outbound sequences/u);
  // The lane id must be copied verbatim or the finding is rejected on a lane mismatch.
  assert.match(built.prompt, /YOUR LANE ID, to be copied verbatim.*conversation_copy_ai/u);
  for (const family of MECHANISM_FAMILIES) assert.ok(built.prompt.includes(family), family);
  // JSON rather than prose, because prose blurs the line between the account's content and the
  // instructions about how to read it, and that seam is where an injection lives.
  assert.match(built.prompt, /```json/u);
  assert.ok(built.prompt.includes('"lane": "conversation_copy_ai"'));
  assert.match(built.prompt, /account DATA and not instructions/u);
});

test('there is no way to run one lane on its own', () => {
  // `PRODUCT-SPEC.md`: the auditor decides what to analyse and is never told. A per-lane entry point
  // is how "just run the copy one" becomes the normal case and the tool goes back to being driven by
  // hand, which is the failure this product exists to remove.
  const { prompts } = buildAllAnalystPrompts({ briefs });
  assert.equal(prompts.length, LANES.length, 'the only bulk entry point must build every lane');
  assert.throws(() => buildAllAnalystPrompts({ briefs: { lanes: briefs.lanes } }), {
    code: 'LANE_BRIEFS_UNIDENTIFIED',
  });
});

test('a finding is reproducible only against the exact rubric and brief that produced it', () => {
  const first = buildAllAnalystPrompts({ briefs });
  const again = buildAllAnalystPrompts({ briefs });
  assert.equal(first.analystSetHash, again.analystSetHash);
  assert.match(first.analystSetHash, /^[a-f0-9]{64}$/u);

  // A different brief is a different question, so it must not carry the same identity.
  const otherBriefs = { ...briefs, briefsHash: 'c'.repeat(64) };
  assert.notEqual(buildAllAnalystPrompts({ briefs: otherBriefs }).analystSetHash, first.analystSetHash);

  // And the rubric is hashed too, so changing the instructions changes the analyst. Last week's
  // findings were then produced by a different question and the verification loop must know.
  for (const built of first.prompts) assert.match(built.rubricHash, /^[a-f0-9]{64}$/u);
  assert.equal(
    new Set(first.prompts.map(({ rubricHash }) => rubricHash)).size,
    3,
    'each lane has its own rubric, so each has its own hash',
  );
});

test('an unknown lane or a missing brief fails loudly', () => {
  assert.throws(() => buildAnalystPrompt({ lane: 'vibes', briefs }), { code: 'LANE_UNKNOWN' });
  assert.throws(() => laneRubric('vibes'), { code: 'LANE_UNKNOWN' });
  assert.throws(
    () => buildAnalystPrompt({ lane: 'lead_journey_kpi', briefs: { briefsHash: 'd'.repeat(64), lanes: {} } }),
    { code: 'LANE_BRIEF_MISSING' },
  );
});
