/**
 * ROOT-CAUSE INVESTIGATION — the box all three lanes feed.
 *
 * `PRODUCT-SPEC.md`: the three lanes converge on ONE investigation, and that investigation is where
 * causes are established rather than symptoms listed. This module is that box.
 *
 * ---------------------------------------------------------------------------------------------
 * WHY IT IS NOT A CONCATENATION OF THREE LISTS.
 *
 * The lanes look at the same account through different windows, so they will describe the same
 * problem three times in three vocabularies:
 *
 *   lane 1  "71% of contacted leads never book"          a number
 *   lane 3  "the nurture is 12 emails, no SMS, on Meta lead-form traffic"   a copy judgement
 *   lane 2  "two sequences run in parallel and one never stops on reply"    a configuration fact
 *
 * Published as three findings that is noise, and worse, it triples the apparent size of one problem
 * and buries the ones nobody corroborated. Published as one cause with three independent supports it
 * is the strongest statement this system can make, because three lanes that cannot see each other's
 * work arrived at the same place.
 *
 * CORROBORATION IS THEREFORE THE PRIMARY OPERATION HERE, and it is done on what the findings ANCHOR
 * to -- the KPI edge, the workflow, the journey stage -- never on the words they use. Matching on
 * prose would let two analysts phrase the same thing differently and both survive.
 * ---------------------------------------------------------------------------------------------
 *
 * WHAT THIS MODULE REFUSES TO DO.
 *
 * It does not invent findings, soften them, or decide whether one is true. A lane analyst's verdict
 * is its own. This box establishes RELATIONSHIPS between findings and a RANK over them, both
 * deterministically, so the same lane outputs always produce the same ranked causes -- the kernel
 * byte-compares this and `lib/report.mjs` re-derives the ordering from sealed inputs.
 *
 * It also never promotes anything on its own. `lib/mechanisms.mjs` adjudicates, and promotion needs
 * `C2`/`C3`, a rank-eligible metric, no unresolved material alternative, and a validated expert
 * review returning `SUPPORTS`. This module's output is an INPUT to that.
 */
import { canonicalJson, sha256 } from './canonical.mjs';

const ROOT_CAUSE_SCHEMA = '1.0.0';

/** The nine rival families `lib/mechanisms.mjs` fixes. A lane finding must name exactly one. */
export const MECHANISM_FAMILIES = Object.freeze([
  'calendar_capacity_or_timezone',
  'delivery_failure',
  'duplicates_tests_or_legacy_imports',
  'historical_configuration_drift',
  'offer_or_pricing',
  'ownership_or_handoff',
  'source_or_lead_quality_mix',
  'stage_or_disposition_data_quality',
  'workflow_configuration_or_execution',
]);

export const LANES = Object.freeze(['lead_journey_kpi', 'workflow_config_runtime', 'conversation_copy_ai']);
export const CONFIDENCE = Object.freeze(['C0', 'C1', 'C2', 'C3']);

/**
 * THE SEVEN RANKING CRITERIA, verbatim from the spec, as the weights that order the backlog.
 *
 * Weights, not a formula a reader has to reverse-engineer. Commercial impact dominates because the
 * question the product answers is where the account is losing money. Evidence strength is second
 * because a big number we cannot support is how a tool loses its credibility in one week.
 *
 * `implementationEffort`, `risk` and `reversibility` are COSTS and enter negatively: a cheap,
 * low-risk, testable change of moderate impact should outrank an expensive risky one of similar
 * impact, because the first can actually be done this week and verified next week.
 */
export const RANKING_WEIGHTS = Object.freeze({
  commercialImpact: 5,
  evidenceStrength: 4,
  leadsAffected: 3,
  urgency: 2,
  testability: 2,
  implementationEffort: -2,
  risk: -2,
});

const BAND_SCORES = Object.freeze({ NONE: 0, LOW: 1, MEDIUM: 2, HIGH: 3, CRITICAL: 4 });
const CONFIDENCE_SCORES = Object.freeze({ C0: 0, C1: 1, C2: 3, C3: 4 });

/**
 * EVIDENCE STRENGTH BACK TO A CONFIDENCE LABEL, stated as a table rather than left as an array
 * index.
 *
 * The first version of this did `CONFIDENCE[Math.min(3, strength)]`, which is NOT the inverse of
 * `CONFIDENCE_SCORES` -- it mapped a strength of 2 to `C2`, while `C2`'s own score is 3. So two
 * lanes agreeing at `C1` silently reached `C2`, and `C2` is the promotion threshold. Corroboration
 * would have been quietly making findings promotable on its own.
 *
 * The table below is deliberately conservative: corroboration is worth roughly one step and cannot
 * on its own carry a pair of `C1` findings to promotable. Two independent lanes agreeing at `C1` is
 * better than one, and it is still not "well supported". Three of them is.
 */
const STRENGTH_TO_CONFIDENCE = Object.freeze(['C0', 'C1', 'C1', 'C2', 'C3']);

function confidenceForStrength(strength) {
  return STRENGTH_TO_CONFIDENCE[Math.max(0, Math.min(STRENGTH_TO_CONFIDENCE.length - 1, strength))];
}

function codedError(code, ErrorType = Error) {
  return Object.assign(new ErrorType(code), { code });
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function byteOrder(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function band(value) {
  return Object.hasOwn(BAND_SCORES, value) ? BAND_SCORES[value] : null;
}

/**
 * VALIDATE A LANE ANALYST'S OUTPUT BEFORE IT IS BELIEVED.
 *
 * A lane analysis is produced by a model, so it arrives as a claim and not as a fact. This is the
 * boundary where a claim becomes evidence, and it is strict on purpose: an unvalidated finding that
 * reaches the ranking gets a rank, and a ranked finding looks exactly as authoritative as a
 * corroborated one.
 *
 * The fields that are REQUIRED are the ones without which a finding cannot be argued with:
 * what it anchors to, the family, the confidence, the competing explanations, the evidence against
 * itself, and a discriminating test. A finding with no counter-evidence and no test is an opinion,
 * and this refuses opinions rather than ranking them low.
 */
export function validateLaneFinding(finding, { lane } = {}) {
  const fail = (detail) => {
    throw Object.assign(codedError('LANE_FINDING_INVALID'), { detail });
  };
  if (!isPlainObject(finding)) fail('not a record');
  if (typeof finding.findingId !== 'string' || !/^[a-z][a-z0-9_]{2,63}$/u.test(finding.findingId)) {
    fail('findingId must be a short snake_case slug');
  }
  if (lane !== undefined && finding.lane !== lane) fail('lane mismatch');
  if (!LANES.includes(finding.lane)) fail('unknown lane');
  if (typeof finding.title !== 'string' || finding.title.trim().length < 10) fail('title too short');
  if (!MECHANISM_FAMILIES.includes(finding.mechanism)) fail('mechanism must be one of the nine families');
  if (!CONFIDENCE.includes(finding.confidence)) fail('confidence must be C0..C3');

  // WHAT IT ANCHORS TO. This is what corroboration is computed on, so a finding that anchors to
  // nothing cannot be corroborated, cannot be verified next week, and is refused.
  const anchors = finding.anchors;
  if (!isPlainObject(anchors)) fail('anchors missing');
  const kpiEdgeIds = Array.isArray(anchors.kpiEdgeIds) ? anchors.kpiEdgeIds : [];
  const workflowNames = Array.isArray(anchors.workflowNames) ? anchors.workflowNames : [];
  const journeyStages = Array.isArray(anchors.journeyStages) ? anchors.journeyStages : [];
  if (kpiEdgeIds.length + workflowNames.length + journeyStages.length === 0) {
    fail('a finding must anchor to at least one KPI edge, workflow or journey stage');
  }

  // THE THINGS THAT MAKE IT ARGUABLE. Each is required because its absence is unfalsifiable.
  if (!Array.isArray(finding.competingExplanations) || finding.competingExplanations.length < 2) {
    fail('at least two competing explanations are required');
  }
  for (const alternative of finding.competingExplanations) {
    if (
      !isPlainObject(alternative)
      || typeof alternative.explanation !== 'string'
      || alternative.explanation.trim().length === 0
      || !['MATERIAL', 'IMMATERIAL'].includes(alternative.materiality)
    ) fail('each competing explanation needs an explanation and MATERIAL/IMMATERIAL');
  }
  if (typeof finding.evidenceAgainst !== 'string' || finding.evidenceAgainst.trim().length === 0) {
    fail('evidenceAgainst is required; "none in this evidence" with a reason is acceptable');
  }
  const test = finding.discriminatingTest;
  if (
    !isPlainObject(test)
    || typeof test.check !== 'string' || test.check.trim().length === 0
    || typeof test.supportsIf !== 'string' || test.supportsIf.trim().length === 0
    || typeof test.refutesIf !== 'string' || test.refutesIf.trim().length === 0
  ) fail('a discriminating test needs a check, a supportsIf and a refutesIf');

  // THE RANKING INPUTS. Bands rather than numbers, because a model asked for a currency figure on an
  // account whose deal values are 94% empty will invent one.
  const scoring = finding.scoring;
  if (!isPlainObject(scoring)) fail('scoring missing');
  for (const key of ['commercialImpact', 'leadsAffected', 'urgency', 'implementationEffort', 'risk', 'testability']) {
    if (band(scoring[key]) === null) fail(`scoring.${key} must be NONE/LOW/MEDIUM/HIGH/CRITICAL`);
  }
  if (typeof finding.fix !== 'string' || finding.fix.trim().length === 0) fail('fix is required');
  return finding;
}

/**
 * Two findings corroborate when they anchor to the same thing. Computed on anchors, never on prose:
 * matching on words would let two analysts phrase one problem differently and both survive as
 * separate findings, which is the exact failure this box exists to prevent.
 */
function anchorKeys(finding) {
  const keys = [];
  for (const edgeId of finding.anchors.kpiEdgeIds ?? []) keys.push(`kpi:${edgeId}`);
  for (const name of finding.anchors.workflowNames ?? []) keys.push(`workflow:${name}`);
  for (const stage of finding.anchors.journeyStages ?? []) keys.push(`stage:${stage}`);
  return [...new Set(keys)].sort(byteOrder);
}

/**
 * Group findings into CAUSES by shared anchors, transitively.
 *
 * Transitive on purpose: lane 1 anchors to a KPI edge, lane 3 anchors to that edge AND a workflow,
 * lane 2 anchors to the workflow only. Pairwise matching would leave lane 2 orphaned from the very
 * cause it explains. The whole point of this box is that the configuration fact and the number are
 * the same story.
 */
function groupByAnchor(findings) {
  const parent = new Map();
  const find = (key) => {
    let current = key;
    while (parent.get(current) !== current) current = parent.get(current);
    return current;
  };
  const union = (left, right) => {
    const a = find(left);
    const b = find(right);
    if (a !== b) parent.set(byteOrder(a, b) <= 0 ? b : a, byteOrder(a, b) <= 0 ? a : b);
  };
  for (const finding of findings) {
    for (const key of [`finding:${finding.findingId}`, ...anchorKeys(finding)]) {
      if (!parent.has(key)) parent.set(key, key);
    }
  }
  for (const finding of findings) {
    const own = `finding:${finding.findingId}`;
    for (const key of anchorKeys(finding)) union(own, key);
  }
  const groups = new Map();
  for (const finding of findings) {
    const root = find(`finding:${finding.findingId}`);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(finding);
  }
  return [...groups.values()];
}

/**
 * The score. Bands in, one number out, and the number is only ever used to ORDER -- it is never
 * published as a quantity, because "impact 23" means nothing to anybody.
 *
 * CORROBORATION IS PART OF EVIDENCE STRENGTH, not a separate bonus. Three lanes that cannot see each
 * other's work arriving at the same anchor is the strongest support available here, and a lone
 * finding at C1 with one lane behind it should not outrank a corroborated one just because its
 * author was more confident about it.
 */
function scoreCause(findings) {
  const lanes = new Set(findings.map((finding) => finding.lane));
  const best = (key) => Math.max(...findings.map((finding) => band(finding.scoring[key]) ?? 0));
  const worst = (key) => Math.max(...findings.map((finding) => band(finding.scoring[key]) ?? 0));
  const confidence = Math.max(...findings.map((finding) => CONFIDENCE_SCORES[finding.confidence]));
  // One lane is 0 extra, two is +1, three is +2. Capped, because corroboration cannot manufacture
  // impact -- it can only make us surer of the impact already claimed.
  const evidenceStrength = Math.min(4, confidence + (lanes.size - 1));
  // A MATERIAL alternative nobody resolved is a live hole in the argument and pulls the score down.
  const unresolvedMaterial = findings.reduce((total, finding) => total + finding.competingExplanations
    .filter((alternative) => alternative.materiality === 'MATERIAL' && alternative.addressed !== true)
    .length, 0);

  const parts = {
    commercialImpact: best('commercialImpact') * RANKING_WEIGHTS.commercialImpact,
    evidenceStrength: evidenceStrength * RANKING_WEIGHTS.evidenceStrength,
    leadsAffected: best('leadsAffected') * RANKING_WEIGHTS.leadsAffected,
    urgency: best('urgency') * RANKING_WEIGHTS.urgency,
    testability: best('testability') * RANKING_WEIGHTS.testability,
    implementationEffort: worst('implementationEffort') * RANKING_WEIGHTS.implementationEffort,
    risk: worst('risk') * RANKING_WEIGHTS.risk,
  };
  const score = Object.values(parts).reduce((total, value) => total + value, 0)
    - Math.min(unresolvedMaterial, 3) * 2;
  return { score, parts, evidenceStrength, unresolvedMaterial, corroboratingLanes: [...lanes].sort(byteOrder) };
}

/**
 * Run the investigation.
 *
 * `laneAnalyses` is `{ lead_journey_kpi: [...], workflow_config_runtime: [...],
 * conversation_copy_ai: [...] }`. A lane that produced nothing must say so with an empty array
 * rather than being absent, because a missing lane and a clean lane are different facts and this
 * refuses to guess which one happened.
 */
export function investigateRootCause({ laneAnalyses, briefsHash } = {}) {
  if (!isPlainObject(laneAnalyses)) throw codedError('ROOT_CAUSE_INPUT_INVALID', TypeError);
  for (const lane of LANES) {
    if (!Array.isArray(laneAnalyses[lane])) {
      // Fails closed. A lane silently absent would publish a partial investigation as a whole one.
      throw Object.assign(codedError('ROOT_CAUSE_LANE_MISSING'), { detail: lane });
    }
  }
  if (typeof briefsHash !== 'string' || !/^[a-f0-9]{64}$/u.test(briefsHash)) {
    // A finding is only reproducible against the exact brief that produced it.
    throw codedError('ROOT_CAUSE_BRIEFS_UNIDENTIFIED');
  }

  const findings = [];
  const seen = new Set();
  for (const lane of LANES) {
    for (const finding of laneAnalyses[lane]) {
      validateLaneFinding(finding, { lane });
      const key = `${lane}:${finding.findingId}`;
      if (seen.has(key)) throw Object.assign(codedError('LANE_FINDING_DUPLICATE'), { detail: key });
      seen.add(key);
      findings.push(finding);
    }
  }

  const causes = groupByAnchor(findings).map((group) => {
    const ordered = [...group].sort((left, right) => byteOrder(left.findingId, right.findingId));
    const scored = scoreCause(ordered);
    return {
      // Content-derived, so the same cause carries the same id across weeks and the verification
      // loop can ask "did last week's cause improve".
      causeId: `cause_${sha256({ anchors: [...new Set(ordered.flatMap(anchorKeys))].sort(byteOrder) }).slice(0, 24)}`,
      anchors: [...new Set(ordered.flatMap(anchorKeys))].sort(byteOrder),
      // The family the lanes agree on, or every family they named when they disagree. A disagreement
      // is information, not something to average away.
      mechanisms: [...new Set(ordered.map((finding) => finding.mechanism))].sort(byteOrder),
      mechanismContested: new Set(ordered.map((finding) => finding.mechanism)).size > 1,
      corroboratingLanes: scored.corroboratingLanes,
      confidence: confidenceForStrength(scored.evidenceStrength),
      unresolvedMaterialAlternatives: scored.unresolvedMaterial,
      rankScore: scored.score,
      rankParts: scored.parts,
      findings: ordered.map((finding) => ({
        findingId: finding.findingId,
        lane: finding.lane,
        title: finding.title,
        mechanism: finding.mechanism,
        confidence: finding.confidence,
        competingExplanations: finding.competingExplanations,
        evidenceAgainst: finding.evidenceAgainst,
        discriminatingTest: finding.discriminatingTest,
        scoring: finding.scoring,
        fix: finding.fix,
      })),
    };
  });

  // Rank descending, then by causeId so ties are stable across runs and machines.
  causes.sort((left, right) => right.rankScore - left.rankScore || byteOrder(left.causeId, right.causeId));

  return {
    schemaVersion: ROOT_CAUSE_SCHEMA,
    briefsHash,
    laneFindingCounts: Object.fromEntries(LANES.map((lane) => [lane, laneAnalyses[lane].length])),
    causeCount: causes.length,
    // How much of the investigation rests on more than one lane. The single most useful number about
    // an investigation's quality, and the one that says whether the lanes are actually converging.
    corroboratedCauseCount: causes.filter((cause) => cause.corroboratingLanes.length > 1).length,
    causes,
    investigationHash: sha256(canonicalJson(causes)),
  };
}
