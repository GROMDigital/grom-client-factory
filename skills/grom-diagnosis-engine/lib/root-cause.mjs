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

const ROOT_CAUSE_SCHEMA = '1.1.0';

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
  /*
   * SAFETY IS WEIGHTED LIKE COMMERCIAL IMPACT, and the first live four-stage run is why.
   *
   * It found an active voice agent carrying another company's script and a webhook secret in a field
   * the model can read, and RANKED IT 21 OF 22. Correctly, by the rules as they stood: every
   * criterion here asked how much money the problem costs, a credential or a compliance exposure
   * costs none directly, so it scored LOW impact and sank. The same run found all four AI agents
   * dodging "are you a bot" and one instructed to deny it outright, which in the UK is a regulatory
   * question rather than a conversion one, and it landed at 12.
   *
   * A backlog that buries those under copy tweaks is telling the reader something false about
   * priority. So a finding may now declare `safetyOrCompliance`, and it is weighted equally with
   * money, because a business does not trade one off against the other.
   *
   * OPTIONAL, defaulting to NONE. Making it required would have invalidated every finding of the run
   * that exposed the gap, and a finding that simply has no safety dimension is the normal case.
   */
  safetyOrCompliance: 5,
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
  /*
   * SAY WHICH RULE WAS BROKEN. The first live four-stage run lost a real finding here -- twelve paid
   * enquiries never contacted at all -- to an id of SIXTY-FIVE characters, one over the limit. The
   * message said "must be a short snake_case slug", so the obvious reading was that the characters
   * were wrong when the length was the only problem. A refusal nobody can act on costs the same as a
   * bug.
   */
  if (typeof finding.findingId !== 'string') fail('findingId missing');
  if (finding.findingId.length > 64) {
    fail(`findingId is ${finding.findingId.length} characters, limit is 64`);
  }
  if (!/^[a-z][a-z0-9_]{2,63}$/u.test(finding.findingId)) {
    fail('findingId must be lower-case letters, digits and underscores, starting with a letter');
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
  /*
   * OPTIONAL, but not optional to get right. Absent means the finding has no safety or compliance
   * dimension, which is the normal case and scores zero. PRESENT AND MISSPELLED would also score
   * zero, silently, which is how a credential exposure ends up ranked below a copy tweak for a second
   * time. So a value that is there must be a real band.
   */
  if (scoring.safetyOrCompliance !== undefined && band(scoring.safetyOrCompliance) === null) {
    fail('scoring.safetyOrCompliance, when given, must be NONE/LOW/MEDIUM/HIGH/CRITICAL');
  }
  if (typeof finding.fix !== 'string' || finding.fix.trim().length === 0) fail('fix is required');
  return finding;
}

/**
 * Everything a finding points at. Used for DISPLAY and for the cause id, never for merging.
 */
function anchorKeys(finding) {
  const keys = [];
  for (const edgeId of finding.anchors.kpiEdgeIds ?? []) keys.push(`kpi:${edgeId}`);
  for (const name of finding.anchors.workflowNames ?? []) keys.push(`workflow:${name}`);
  for (const stage of finding.anchors.journeyStages ?? []) keys.push(`stage:${stage}`);
  return [...new Set(keys)].sort(byteOrder);
}

/**
 * ---------------------------------------------------------------------------------------------
 * WHAT MAY BE MERGED ON: ONLY A DISCRIMINATING ANCHOR.
 *
 * The first real run merged all 24 findings into ONE cause with 35 anchors and 7 contested
 * mechanisms, which is worthless. The grouping was transitive over every anchor, and the anchors it
 * chained through were not evidence of a shared cause at all:
 *
 *     stage:conversation          in 14 of 24 findings
 *     stage:attended              in 11
 *     stage:enquiry               in 11
 *     kpi:contacted_to_qualified  in 11
 *     workflow:001 - FB Lead Form in 10
 *
 * Any transitive closure over a graph with bridges that common yields a single component. That is
 * arithmetic, not a tuning problem.
 *
 * The principle: AN ANCHOR SHARED BY MOST FINDINGS CARRIES NO CORROBORATION INFORMATION. Two lanes
 * both mentioning `stage:conversation` on an account whose whole funnel is conversations tells you
 * nothing; two lanes both naming `workflow:05 No-Show Recovery` tells you a great deal. So:
 *
 *   1. JOURNEY STAGES ARE NEVER MERGE KEYS. There are about six of them for a whole account, so
 *      every stage is a hub by construction. They stay on the cause as context.
 *   2. A KPI EDGE OR WORKFLOW IS A MERGE KEY ONLY IF IT IS RARE. An anchor naming more than a
 *      quarter of the findings is a theme, not a thing.
 *
 * Transitivity is KEPT, because the case it was built for is real: lane 1 anchors to a KPI edge,
 * lane 3 to that edge AND a workflow, lane 2 to the workflow only, and pairwise matching would
 * orphan lane 2 from the cause it explains. Transitivity over rare anchors chains a genuine story;
 * transitivity over hubs chains everything to everything.
 * ---------------------------------------------------------------------------------------------
 */
const HUB_ANCHOR_SHARE = 0.25;

function mergeCandidates(finding) {
  const keys = [];
  for (const edgeId of finding.anchors.kpiEdgeIds ?? []) keys.push(`kpi:${edgeId}`);
  for (const name of finding.anchors.workflowNames ?? []) keys.push(`workflow:${name}`);
  return [...new Set(keys)].sort(byteOrder);
}

/**
 * The anchors too common to mean anything. Never fewer than 3 findings, so a small run cannot
 * accidentally class a genuinely shared anchor as a hub: with 4 findings the cap is 3, not 1.
 */
export function hubAnchors(findings) {
  const frequency = new Map();
  for (const finding of findings) {
    for (const key of mergeCandidates(finding)) frequency.set(key, (frequency.get(key) ?? 0) + 1);
  }
  const cap = Math.max(3, Math.ceil(findings.length * HUB_ANCHOR_SHARE));
  return new Set([...frequency.entries()]
    .filter(([, count]) => count > cap)
    .map(([key]) => key));
}

/**
 * One pass of transitive union-find over the supplied merge keys.
 */
function componentsBy(findings, keysFor) {
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
    for (const key of [`finding:${finding.findingId}`, ...keysFor(finding)]) {
      if (!parent.has(key)) parent.set(key, key);
    }
  }
  for (const finding of findings) {
    for (const key of keysFor(finding)) union(`finding:${finding.findingId}`, key);
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
 * Group findings into CAUSES by shared DISCRIMINATING anchors, transitively, RE-SPLITTING any group
 * that is still too big to be one cause.
 *
 * The global hub filter alone was not enough, and the real data showed it: excluding the five
 * account-wide anchors took 24 findings from ONE cause to five, but the largest still held 18,
 * chained together through anchors that were individually uncommon. That is transitivity's failure
 * mode -- A shares x with B, B shares y with C, and nothing in the pairwise test ever sees the
 * chain.
 *
 * So the rule is applied RECURSIVELY and locally: a group holding most of the findings is not a
 * cause, whatever its anchors say. Promote that group's OWN most common anchor to a hub and split
 * again. Each pass strictly shrinks the anchor set, so it terminates; when a group runs out of
 * anchors to split on, its members separate into individual causes, which is the honest answer for
 * findings that share nothing specific.
 */
function groupByAnchor(findings) {
  const limit = Math.max(3, Math.ceil(findings.length * HUB_ANCHOR_SHARE));
  const hubs = hubAnchors(findings);

  const split = (group, excluded) => {
    const keysFor = (finding) => mergeCandidates(finding).filter((key) => !excluded.has(key));
    const components = componentsBy(group, keysFor);
    return components.flatMap((component) => {
      if (component.length <= limit) return [component];
      // This component's own most common anchor is what is holding it together. Take it out and
      // look again. Ties break on byte order so the same findings always split the same way.
      const frequency = new Map();
      for (const finding of component) {
        for (const key of keysFor(finding)) frequency.set(key, (frequency.get(key) ?? 0) + 1);
      }
      if (frequency.size === 0) return component.map((finding) => [finding]);
      const [worst] = [...frequency.entries()]
        .sort((left, right) => right[1] - left[1] || byteOrder(left[0], right[0]));
      return split(component, new Set([...excluded, worst[0]]));
    });
  };

  /*
   * A shared account object proves relationship, not mechanism identity. Price copy and workflow
   * execution can both fail on the same nurture workflow; combining them creates one package whose
   * evidence supports two different interventions. Split by mechanism first, then retain the
   * relationship explicitly after cause ids exist.
   */
  const byMechanism = new Map();
  for (const finding of findings) {
    if (!byMechanism.has(finding.mechanism)) byMechanism.set(finding.mechanism, []);
    byMechanism.get(finding.mechanism).push(finding);
  }
  const separated = [...byMechanism.entries()]
    .sort(([left], [right]) => byteOrder(left, right))
    .flatMap(([, group]) => split(group, hubs));
  return mergeByOverlap(separated, limit);
}

/**
 * SECOND PASS: MERGE TWO CAUSES THAT ARE OBVIOUSLY THE SAME PROBLEM.
 *
 * The hub filter fixed one failure and created its mirror image. Measured on the first live run of
 * the four-stage chain: 28 findings became 22 causes, and three of them were "nothing in this account
 * reacts when a lead replies", filed independently by all three lanes.
 *
 * WHY THEY DID NOT MERGE. Each named 6, 13 and 10 workflows and up to 8 KPI edges. Anchoring that
 * broadly means every anchor they share is, by definition, common -- so `hubAnchors` excluded ALL of
 * them and left the three findings with nothing to merge on. The hub rule exists to stop a common
 * anchor dragging an unrelated NARROW finding into a cause. It misfires when BOTH findings are broad,
 * which is exactly what an account-wide lane produces.
 *
 * So rarity is the wrong test on its own. Two findings that overlap across most of their anchors are
 * about the same thing whether or not those anchors are individually popular, and the mechanism
 * family is what stops that becoming "everything at the conversation stage is one cause": the three
 * reply findings all named `ownership_or_handoff`, while the two "announces a final message and then
 * sends more" findings named `workflow_configuration_or_execution` and stay separate, correctly.
 *
 * The size guard is kept. A merge that would push a cause past the same limit `split` enforces is
 * refused, so this can never rebuild the single blob the hub filter was written to prevent.
 */
/*
 * TWO THRESHOLDS, BOTH REQUIRED, and the measurements that forced that.
 *
 * Taken from the 27 accepted findings of the first live four-stage run, comparing pairs that plainly
 * ARE one problem against pairs that plainly are not:
 *
 *                                              containment   jaccard
 *   MERGE  "nobody reacts to a reply" x2             0.94       0.68
 *   MERGE  "announces a final message, sends more"   0.90       0.75
 *   KEEP   AI agents deny being a bot / no reply     1.00       0.24
 *   KEEP   offer missing / nurture hypocrisy         0.83       0.38
 *   KEEP   appointment outcomes / unasked question   0.67       0.43
 *
 * NEITHER MEASURE SEPARATES THEM ALONE. Containment says merge the bot finding with the reply
 * finding, because the smaller one's three anchors all appear in the larger one's thirteen. Jaccard
 * puts a pair that must merge (0.43) exactly level with a pair that must not (0.43). Requiring both
 * separates cleanly, with the closest wrong merge two thresholds away from qualifying.
 *
 * JOURNEY STAGES ARE EXCLUDED FROM BOTH. Every finding on this account names `conversation` and
 * `attended`, so including stages pushed unrelated pairs to 0.75 containment and collapsed 27
 * findings into 7 causes, several of them holding seven unrelated problems. Stages are context, and
 * `groupByAnchor` already refuses them as merge keys for the same reason.
 *
 * THIS IS DELIBERATELY CONSERVATIVE. It merges the pairs no reader would accept as separate and
 * leaves genuinely arguable ones alone: one of the three reply findings stays its own cause because
 * it is framed differently enough that the numbers cannot tell. Judging THOSE is the running-order
 * expert's job, not arithmetic's. A false merge hides a real problem, which is worse than a duplicate
 * a reader can see and dismiss.
 */
const OVERLAP_MERGE_CONTAINMENT = 0.85;
const OVERLAP_MERGE_JACCARD = 0.6;

/** The DISCRIMINATING anchors only. Stages are excluded, for the reason above. */
function allAnchors(finding) {
  return new Set([
    ...(finding.anchors.kpiEdgeIds ?? []).map((id) => `kpi:${id}`),
    ...(finding.anchors.workflowNames ?? []).map((name) => `workflow:${name}`),
  ]);
}

function saysSameThing(left, right) {
  if (left.mechanism !== right.mechanism) return false;
  const a = allAnchors(left);
  const b = allAnchors(right);
  if (a.size === 0 || b.size === 0) return false;
  let shared = 0;
  for (const key of a) if (b.has(key)) shared += 1;
  const containment = shared / Math.min(a.size, b.size);
  const jaccard = shared / new Set([...a, ...b]).size;
  return containment >= OVERLAP_MERGE_CONTAINMENT && jaccard >= OVERLAP_MERGE_JACCARD;
}

function mergeByOverlap(causes, limit) {
  const merged = causes.map((group) => [...group]);
  let changed = true;
  while (changed) {
    changed = false;
    outer: for (let i = 0; i < merged.length; i += 1) {
      for (let j = i + 1; j < merged.length; j += 1) {
        if (merged[i].length + merged[j].length > limit) continue;
        const same = merged[i].some((left) => merged[j].some((right) => saysSameThing(left, right)));
        if (!same) continue;
        merged[i] = [...merged[i], ...merged[j]];
        merged.splice(j, 1);
        changed = true;
        break outer;
      }
    }
  }
  return merged;
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

  /*
   * `+ 0` IS LOAD-BEARING. A `NONE` band scores 0, and a negative weight turns that into NEGATIVE
   * ZERO, which `lib/canonical.mjs` refuses outright (`Object.is(value, -0)` -> unsupported). So a
   * cause whose effort or risk is NONE crashed the whole investigation at the final hash.
   *
   * Latent since this module was written and unreachable until now: the first real run produced one
   * enormous cause whose worst-of aggregate was never NONE. The moment grouping started producing
   * small, honest causes, the first one with no implementation effort took the run down. Adding 0
   * normalises -0 to 0 and leaves every other value untouched.
   */
  const parts = {
    commercialImpact: best('commercialImpact') * RANKING_WEIGHTS.commercialImpact + 0,
    // Absent means NONE, so a finding with no safety dimension scores exactly as it did before.
    safetyOrCompliance: best('safetyOrCompliance') * RANKING_WEIGHTS.safetyOrCompliance + 0,
    evidenceStrength: evidenceStrength * RANKING_WEIGHTS.evidenceStrength + 0,
    leadsAffected: best('leadsAffected') * RANKING_WEIGHTS.leadsAffected + 0,
    urgency: best('urgency') * RANKING_WEIGHTS.urgency + 0,
    testability: best('testability') * RANKING_WEIGHTS.testability + 0,
    implementationEffort: worst('implementationEffort') * RANKING_WEIGHTS.implementationEffort + 0,
    risk: worst('risk') * RANKING_WEIGHTS.risk + 0,
  };
  const score = Object.values(parts).reduce((total, value) => total + value, 0)
    - Math.min(unresolvedMaterial, 3) * 2 + 0;
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
    const confidence = confidenceForStrength(scored.evidenceStrength);
    return {
      /*
       * Content-derived, so the same cause carries the same id across weeks and the verification
       * loop can ask "did last week's cause improve".
       *
       * The FINDING IDS are part of the identity as well as the anchors, and they have to be. Once
       * grouping started re-splitting oversized components, two distinct causes could hold
       * identical anchor sets -- several findings all naming one hub edge and nothing else each
       * become their own cause -- and an id derived from anchors alone collided. Two causes then
       * wrote to the same solution-package filename with different content and the write-once guard
       * stopped the run, which is the guard doing its job on a real defect.
       *
       * Cross-week stability is preserved: an analyst's `findingId` is a slug describing the
       * problem, so a cause that recurs unchanged still hashes the same.
       */
      causeId: `cause_${sha256({
        anchors: [...new Set(ordered.flatMap(anchorKeys))].sort(byteOrder),
        findingIds: ordered.map((entry) => entry.findingId).sort(byteOrder),
      }).slice(0, 24)}`,
      anchors: [...new Set(ordered.flatMap(anchorKeys))].sort(byteOrder),
      // The family the lanes agree on, or every family they named when they disagree. A disagreement
      // is information, not something to average away.
      mechanisms: [...new Set(ordered.map((finding) => finding.mechanism))].sort(byteOrder),
      mechanismContested: new Set(ordered.map((finding) => finding.mechanism)).size > 1,
      relatedCauseIds: [],
      corroboratingLanes: scored.corroboratingLanes,
      confidence,
      unresolvedMaterialAlternatives: scored.unresolvedMaterial,
      // C3 means the evidence is strong enough for a monitored implementation whose acceptance test
      // can still refute it. At C1/C2, an open material alternative can change the intervention and
      // must be settled before the account is touched.
      implementationStatus: scored.unresolvedMaterial > 0 && confidence !== 'C3'
        ? 'VERIFY_FIRST'
        : 'READY_TO_IMPLEMENT',
      verificationChecks: ordered.map((finding) => finding.discriminatingTest),
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

  for (const cause of causes) {
    const anchors = new Set(cause.anchors.filter((anchor) => (
      anchor.startsWith('kpi:') || anchor.startsWith('workflow:')
    )));
    cause.relatedCauseIds = causes
      .filter((other) => (
        other.causeId !== cause.causeId
        && !other.mechanisms.some((mechanism) => cause.mechanisms.includes(mechanism))
        && other.anchors.some((anchor) => anchors.has(anchor))
      ))
      .map((other) => other.causeId)
      .sort(byteOrder);
  }

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
