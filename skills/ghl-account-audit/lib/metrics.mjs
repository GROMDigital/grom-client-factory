import { Temporal } from '@js-temporal/polyfill';

const UNKNOWN = Object.freeze({
  state: 'UNKNOWN',
  numerator: null,
  denominator: null,
  rate: null,
  reasonCode: 'MISSING_REQUIRED_EVIDENCE',
});

function codedError(code, ErrorType = Error) {
  return Object.assign(new ErrorType(code), { code });
}

function deepFreeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function assertDeepFrozen(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  if (!Object.isFrozen(value)) throw codedError('METRICS_GRAPH_NOT_FROZEN', TypeError);
  seen.add(value);
  for (const child of Object.values(value)) assertDeepFrozen(child, seen);
}

function zoned(value, timezone) {
  try {
    return Temporal.Instant.from(value).toZonedDateTimeISO(timezone);
  } catch {
    try {
      return Temporal.ZonedDateTime.from(value).withTimeZone(timezone);
    } catch {
      throw codedError('METRICS_TIME_INVALID', TypeError);
    }
  }
}

function windowOf(start, end) {
  return {
    start: start.toString(),
    end: end.toString(),
    durationHours: Number(end.epochNanoseconds - start.epochNanoseconds) / 3.6e12,
  };
}

export function buildWindows({ cutoff, timezone, maturityDays }) {
  if (
    typeof cutoff !== 'string'
    || typeof timezone !== 'string'
    || !Number.isInteger(maturityDays)
    || maturityDays < 0
  ) throw codedError('METRICS_WINDOW_INVALID', TypeError);
  let localCutoff;
  try {
    localCutoff = zoned(cutoff, timezone);
  } catch {
    throw codedError('METRICS_WINDOW_INVALID', TypeError);
  }
  const currentEnd = localCutoff
    .subtract({ days: localCutoff.dayOfWeek - 1 })
    .startOfDay();
  const currentStart = currentEnd.subtract({ weeks: 1 });
  const previousStart = currentStart.subtract({ weeks: 1 });
  const trailingStart = currentEnd.subtract({ days: 28 });
  const longTrailingStart = currentEnd.subtract({ days: 90 });
  const matureAsOf = currentEnd.subtract({ days: maturityDays });
  return deepFreeze({
    timezone,
    cutoff: localCutoff.toString(),
    currentClosedWeek: windowOf(currentStart, currentEnd),
    previousClosedWeek: windowOf(previousStart, currentStart),
    trailing28Days: windowOf(trailingStart, currentEnd),
    /**
     * Anchored to the SAME closed-week Monday boundary as every other window, then counted back
     * 90 calendar days in account-local time. `durationHours` is therefore real elapsed hours
     * (2159 or 2161 across a DST transition), never a constant 2160.
     *
     * It exists because two shipped edges allow more lag (90 days for `showed_to_decision`,
     * 60 for `won_to_collected_revenue`) than the longest window could ever mature.
     */
    trailing90Days: windowOf(longTrailingStart, currentEnd),
    matureAsOf: matureAsOf.toString(),
    maturityDays,
  });
}

function instant(value) {
  try {
    return Temporal.Instant.from(value);
  } catch {
    throw codedError('METRICS_EVENT_TIME_INVALID', TypeError);
  }
}

function inside(eventTime, window) {
  const value = instant(eventTime);
  return Temporal.Instant.compare(value, instant(window.start)) >= 0
    && Temporal.Instant.compare(value, instant(window.end)) < 0;
}

function lagDuration(allowedLag) {
  if (
    !allowedLag
    || !Number.isFinite(allowedLag.amount)
    || allowedLag.amount < 0
    || !['minutes', 'hours', 'days', 'weeks'].includes(allowedLag.unit)
  ) throw codedError('METRICS_CONTRACT_INVALID', TypeError);
  return Temporal.Duration.from({ [allowedLag.unit]: allowedLag.amount });
}

function addLag(eventTime, allowedLag, window) {
  const duration = lagDuration(allowedLag);
  const timeZoneId = Temporal.ZonedDateTime.from(window.start).timeZoneId;
  return instant(eventTime).toZonedDateTimeISO(timeZoneId).add(duration).toInstant();
}

function subjectKey(node) {
  if (node.organizationNativeId && (node.opportunityNativeId || node.projectNativeId)) {
    return `${node.journeyInstanceId}:organization:${node.organizationNativeId}:commercial:${
      node.opportunityNativeId ?? node.projectNativeId
    }`;
  }
  const subject = node.subjectRef
    ?? node.subjectNativeId
    ?? node.organizationNativeId
    ?? node.nodeId;
  return `${node.journeyInstanceId}:${subject}`;
}

function eventKey(node, reentryRule = 'new_journey_instance') {
  return reentryRule === 'new_journey_instance'
    ? node.cohortInstanceRef ?? subjectKey(node)
    : subjectKey(node);
}

function isObserved(node) {
  return node.classification === 'OBSERVED'
    && node.provenance?.completeness === 'COMPLETE'
    && typeof node.eventTime === 'string';
}

function stageOf(node) {
  return node.stage ?? node.milestone;
}

function sortEvents(left, right) {
  return Temporal.Instant.compare(instant(left.eventTime), instant(right.eventTime))
    || left.nodeId.localeCompare(right.nodeId);
}

/**
 * THE COVERAGE FLOOR.
 *
 * The share of an edge's eligible population that must actually be measurable before a rate is
 * reported at all. Below it the metric is UNKNOWN with `COVERAGE_BELOW_FLOOR` rather than a number
 * computed from a rump of the account.
 *
 * The operative value is DATA, declared per edge as `eligibilityRule.minimumCoverage` or per
 * profile as `metricContracts.coverageFloor`. This constant is only the documented fallback for a
 * contract that declares neither, and it is deliberately NOT zero: an absent declaration must not
 * silently disable the guard. 0.8 is the default because a fifth of the population is the most
 * that can be lost before "the rate on this account" stops being an honest description of the
 * number, while still tolerating the handful of duplicate identities and half-mapped records that
 * every real GHL account carries.
 *
 * A declaration that is present but not a number in [0, 1] is a contract bug and throws.
 */
export const DEFAULT_COVERAGE_FLOOR = 0.8;

/**
 * Why a subject was dropped from an edge's denominator. Ordered MOST to LEAST specific: a subject
 * with several causes is reported under the earliest one, so the same graph always yields the same
 * counts regardless of the order the causes were discovered in.
 */
const EXCLUSION_REASONS = Object.freeze([
  'NON_METRIC_EVENT_TYPE',
  'NON_OBSERVED_EVIDENCE',
  'UNRESOLVED_JOIN',
  'IDENTITY_CONFLICT',
  'INFERRED_MATCH',
  'UNPROVEN_JOIN',
  'UNPLACEABLE_EVENT_TIME',
]);

/**
 * THE ONLY NODE TYPES A METRIC MAY COUNT.
 *
 * `evidence-graph.mjs` builds journey semantics — journey-instance validation, cohort instances,
 * `preceded` progression — for exactly these two record types, and `journey-projection.mjs` emits
 * exactly `journey_event`. A row of any other type that happens to carry a `stage` is a CLAIM to
 * be a journey event that nothing in the chain has checked.
 *
 * Such a row is still SEEN by the population scan below, which matches on stage and not on type,
 * so it must be excluded explicitly and counted. Filtering it out silently would hide it; trusting
 * it would invent an entrant.
 */
const METRIC_EVENT_TYPES = Object.freeze(['journey_event', 'portal_milestone']);

/**
 * THE TAINT CLOSURE'S EDGE POLICY, stated per edge type rather than inherited.
 *
 * The closure below walks out from the metric-bearing nodes to find which subjects a conflict or
 * an unresolved join is really about. Getting the edge set wrong is silent in both directions, so
 * the policy is a DENY list and not an allow list: every edge type is traversed EXCEPT the ones
 * that fail the property below. An edge type that reaches a graph without appearing here at all
 * therefore defaults to being traversed. Failing toward more taint costs coverage, which the
 * metric reports; failing toward less costs correctness, which nothing downstream can detect.
 *
 * THE PROPERTY, which decides membership: does this edge type ORIGINATE AT A NODE THAT MANY
 * SUBJECTS SHARE? An edge that runs from a workflow definition, an attribution source or any other
 * account-level descriptor says nothing about whose identity is whose, and traversing it merges
 * every subject the descriptor ever touched into one blast radius — the account-wide blackout this
 * file exists to remove. `SHARED_ORIGIN` is that class; `IDENTITY` is everything whose endpoints
 * are the same subject's own rows.
 *
 * The classification is by NAME because the from-node's own type is not reliably present: a graph
 * may name a definition node that was never collected, and an unresolvable lookup would silently
 * re-admit the very edge this list exists to refuse. It is therefore kept EXHAUSTIVE against
 * `evidence-graph.mjs`'s `EDGE_TYPES`, and `tests/metrics-population.test.mjs` fails if a type is
 * added there without being classified here.
 *
 * Per type:
 * - `identity_exact`, `inferred_match` — the identity joins themselves. Traversed; `inferred_match`
 *   additionally taints on sight.
 * - `preceded` — one subject's own events in order. The handoff variant joins two journey-instance
 *   descriptors, which own no subject and so contribute nothing either way.
 * - `contradicts` — two claims that disagree ABOUT THE SAME THING; that is what makes them a
 *   contradiction. Traversed, which is also the safe direction for a type with no emitting site.
 * - `configured_to_trigger`, `enrolled_in`, `execution_emitted` — the workflow chain
 *   (`mechanisms.mjs` `chainProof`). All three run from a workflow-DEFINITION node, which is shared
 *   by every contact the workflow ever touched.
 * - `attributed_by_source` — runs from a source/campaign descriptor, shared by every subject
 *   attributed to it.
 * - `intended_by` — runs from the configured intent (a definition-shaped descriptor), shared by
 *   every execution that realises it.
 *
 * The last two have no emitting site in `buildEvidenceGraph` yet, so they are classified from the
 * origin their names denote; whoever adds the emitting site must confirm the origin is still
 * shared. That is the same review the exhaustiveness test forces for any new type.
 */
export const EDGE_IDENTITY_POLICY = Object.freeze({
  attributed_by_source: 'SHARED_ORIGIN',
  configured_to_trigger: 'SHARED_ORIGIN',
  contradicts: 'IDENTITY',
  enrolled_in: 'SHARED_ORIGIN',
  execution_emitted: 'SHARED_ORIGIN',
  identity_exact: 'IDENTITY',
  inferred_match: 'IDENTITY',
  intended_by: 'SHARED_ORIGIN',
  preceded: 'IDENTITY',
});

function carriesIdentity(type) {
  return EDGE_IDENTITY_POLICY[type] !== 'SHARED_ORIGIN';
}

/** Every window `computeJourneyMetrics` will report on, in report order. */
const WINDOW_NAMES = Object.freeze([
  'currentClosedWeek',
  'previousClosedWeek',
  'trailing28Days',
  'trailing90Days',
]);

function coverageFloorFor(contract, profileFloor) {
  const rule = contract.eligibilityRule;
  // `hasOwn`, not `??`: an explicit `null` is a BROKEN declaration and must fail loudly rather
  // than fall through to the default as though nothing had been declared.
  const declared = rule && typeof rule === 'object' && Object.hasOwn(rule, 'minimumCoverage')
    ? rule.minimumCoverage
    : profileFloor;
  if (declared === undefined) return DEFAULT_COVERAGE_FLOOR;
  if (typeof declared !== 'number' || !Number.isFinite(declared) || declared < 0 || declared > 1) {
    throw codedError('METRICS_CONTRACT_INVALID', TypeError);
  }
  return declared;
}

function emptyCounts() {
  return {
    eligible: null, excluded: null, exclusions: {}, coverageRatio: null,
  };
}

function unknownMetric(
  window,
  threshold,
  coverageFloor,
  reasonCode = 'MISSING_REQUIRED_EVIDENCE',
  counts = emptyCounts(),
) {
  return {
    ...UNKNOWN,
    reasonCode,
    eligible: counts.eligible,
    excluded: counts.excluded,
    exclusions: counts.exclusions,
    threshold,
    rankEligible: false,
    window,
    coverage: 'INCOMPLETE',
    coverageRatio: counts.coverageRatio,
    coverageFloor,
    ...floorDisclosure(coverageFloor),
  };
}

/**
 * A floor of 0 admits ANY coverage, which is the one value that turns the guard off. The doc
 * comment on `DEFAULT_COVERAGE_FLOOR` promises an ABSENT declaration cannot do that; a declared 0
 * still can, so it is never allowed to be silent. The key is emitted only when the guard is off,
 * so a normally-guarded metric keeps the shape everything downstream already byte-compares.
 */
function floorDisclosure(coverageFloor) {
  return coverageFloor === 0 ? { coverageFloorDisabled: true } : {};
}

function placeable(value) {
  if (typeof value !== 'string') return null;
  try {
    return Temporal.Instant.from(value);
  } catch {
    return null;
  }
}

/**
 * Which SUBJECTS does a node id speak for? Seeded from the metric-bearing nodes themselves, then
 * closed over identity edges to a fixed point, so a conflict or an unresolved join that names a
 * contact entity or a raw record resolves to the subjects behind it. A fixed point rather than one
 * pass because the answer must not depend on the order the edges happen to appear in.
 */
function subjectOwners(graph, subjectNodes) {
  const owners = new Map();
  const add = (nodeId, key) => {
    const current = owners.get(nodeId);
    if (current) {
      if (current.has(key)) return false;
      current.add(key);
      return true;
    }
    owners.set(nodeId, new Set([key]));
    return true;
  };
  for (const node of subjectNodes) add(node.nodeId, subjectKey(node));
  const identityEdges = graph.edges.filter(({ type }) => carriesIdentity(type));
  let changed = true;
  while (changed) {
    changed = false;
    for (const { fromNodeId, toNodeId } of identityEdges) {
      for (const key of [...(owners.get(fromNodeId) ?? [])]) {
        if (add(toNodeId, key)) changed = true;
      }
      for (const key of [...(owners.get(toNodeId) ?? [])]) {
        if (add(fromNodeId, key)) changed = true;
      }
    }
  }
  return owners;
}

/**
 * Per-SUBJECT uncertainty, replacing the journey-wide gate this function grew out of.
 *
 * `evidence-graph.mjs` forces every journey event onto the profile's single declared instance, so
 * a journey-scoped gate is an account-scoped gate: two duplicate email addresses used to blank
 * every metric in every window. Here each cause is attributed to the subjects it actually touches.
 *
 * An item that names no node, no evidence ref and no journey instance attributes to NOBODY. That
 * is deliberate: a truncated collection is a SCOPE limitation, already carried by `coverage.json`
 * and the report's material limitations, and blanking every rate for it double-counts the same
 * fact. An item that names a journey instance and nothing more still taints that whole journey,
 * because its blast radius genuinely is the journey.
 */
function taintedSubjects(graph, nodes) {
  // Seeded from everything `computeEdge`'s population scan can SEE, not only from the types it
  // trusts. The scan matches on stage, so a stage-bearing row of another type reaches it; if that
  // row were not a seed here it could never acquire a taint, could never be attributed a
  // conflict or an unresolved join, and would enter the denominator unchallenged.
  const subjectNodes = nodes.filter(isMetricCandidate);
  const owners = subjectOwners(graph, subjectNodes);
  const byJourney = new Map();
  const byEvidenceRef = new Map();
  const tainted = new Map();
  const mark = (key, reason) => tainted.set(key, moreSpecific(tainted.get(key), reason));
  for (const node of subjectNodes) {
    const key = subjectKey(node);
    const journey = byJourney.get(node.journeyInstanceId) ?? new Set();
    journey.add(key);
    byJourney.set(node.journeyInstanceId, journey);
    for (const ref of node.evidenceRefs ?? []) {
      const refSubjects = byEvidenceRef.get(ref) ?? new Set();
      refSubjects.add(key);
      byEvidenceRef.set(ref, refSubjects);
    }
    if (!isObserved(node)) mark(key, 'NON_OBSERVED_EVIDENCE');
  }
  const attribute = (item, reason) => {
    const keys = new Set();
    if (typeof item.journeyInstanceId === 'string') {
      for (const key of byJourney.get(item.journeyInstanceId) ?? []) keys.add(key);
    }
    const named = [
      ...(typeof item.recordNodeId === 'string' ? [item.recordNodeId] : []),
      ...(Array.isArray(item.nodeIds) ? item.nodeIds : []),
    ];
    for (const nodeId of named) {
      for (const key of owners.get(nodeId) ?? []) keys.add(key);
    }
    for (const ref of Array.isArray(item.evidenceRefs) ? item.evidenceRefs : []) {
      for (const key of byEvidenceRef.get(ref) ?? []) keys.add(key);
    }
    for (const key of keys) mark(key, reason);
  };
  for (const item of graph.unresolvedJoins) attribute(item, 'UNRESOLVED_JOIN');
  for (const item of graph.conflicts) attribute(item, 'IDENTITY_CONFLICT');
  for (const { type, fromNodeId, toNodeId } of graph.edges) {
    if (type !== 'inferred_match') continue;
    for (const nodeId of [fromNodeId, toNodeId]) {
      for (const key of owners.get(nodeId) ?? []) mark(key, 'INFERRED_MATCH');
    }
  }
  return tainted;
}

function hasProvingJoin(graph, nodeId) {
  return graph.edges.some(({ type, toNodeId, joinMethod, joinConfidence }) => (
    type === 'identity_exact'
      && toNodeId === nodeId
      && ['native_id', 'deterministic_composite'].includes(joinMethod)
      && joinConfidence === 'exact'
  ));
}

/**
 * Anything the population scan can see: a node the graph treats as a journey event, OR any other
 * node that claims a journey instance AND a stage. See `METRIC_EVENT_TYPES` — the second half is
 * seen but never trusted.
 */
function isMetricCandidate(node) {
  return METRIC_EVENT_TYPES.includes(node.type)
    || (typeof node.journeyInstanceId === 'string' && typeof stageOf(node) === 'string');
}

/**
 * IS THIS EVENT FIT TO BE COUNTED? Applied to EVERY event an edge consumes — the entrant and the
 * conversion alike — because a rate built on a conversion nobody can vouch for is exactly as
 * unearned as one built on an entrant nobody can vouch for.
 *
 * The journey-wide gate this replaced enforced `isObserved` over the population and
 * `hasProvingJoin` over every event, then blanked the whole account when either failed. Both
 * guarantees survive here; only their blast radius changed, from the account to the one key the
 * failing event belongs to. Returns `null` when the event is trustworthy.
 */
function untrustedReason(graph, node, tainted) {
  if (!METRIC_EVENT_TYPES.includes(node.type)) return 'NON_METRIC_EVENT_TYPE';
  if (!isObserved(node)) return 'NON_OBSERVED_EVIDENCE';
  const subjectTaint = tainted.get(subjectKey(node));
  if (subjectTaint) return subjectTaint;
  return hasProvingJoin(graph, node.nodeId) ? null : 'UNPROVEN_JOIN';
}

/** The most specific of two exclusion reasons, so counts never depend on discovery order. */
function moreSpecific(current, reason) {
  return current === undefined
    || EXCLUSION_REASONS.indexOf(reason) < EXCLUSION_REASONS.indexOf(current)
    ? reason
    : current;
}

/**
 * THE ONE PLACE THAT DECIDES WHICH NODES A METRIC MAY COUNT.
 *
 * "A row participates in a metric without passing the trust predicate" escaped review twice,
 * because the question was re-answered, differently, at every call site: `computeEdge` filtered on
 * type, `isObserved` and taint; `cohortCounts` on type and `isObserved`; `stockFor` on a hardcoded
 * type list and `isObserved`. Two of the three therefore counted rows the third had refused, and
 * the report printed one beside the other.
 *
 * It is now answered once, here, and the three consumers are handed this object INSTEAD of the
 * node list. They have no other handle on `graph.nodes`, so a fourth consumer cannot quietly
 * bypass the predicate: it must ask this population, and its answer will agree with everyone
 * else's by construction.
 *
 * - `all` is everything the population scan can SEE, trusted or not. It exists only so exclusions
 *   can be COUNTED — an untrustworthy row must never be silently dropped.
 * - `countable` is the only set any surface may add to a published number.
 * - `reasonFor` is why a row is not countable, and throws for a node the graph never contained,
 *   because a fabricated row has no trust answer at all.
 */
function metricPopulation(graph) {
  const all = graph.nodes;
  const tainted = taintedSubjects(graph, all);
  const reasons = new Map();
  for (const node of all) reasons.set(node.nodeId, untrustedReason(graph, node, tainted));
  return Object.freeze({
    all,
    countable: Object.freeze(all.filter((node) => reasons.get(node.nodeId) === null)),
    reasonFor(node) {
      if (!reasons.has(node.nodeId)) throw codedError('METRICS_POPULATION_UNKNOWN_NODE', TypeError);
      return reasons.get(node.nodeId);
    },
    isCountable(node) {
      return reasons.get(node.nodeId) === null;
    },
  });
}

/**
 * The eligible/measurable split for one keyed set of entrants, plus the keys nothing could place
 * in any window. Shared by the normal path and by the immaturity early return, so a window that
 * measured nothing still reports the population it could not measure.
 */
function countsFor(keyed, exclusionByKey, unplaceable, placed) {
  const tally = {};
  const bump = (reason) => { tally[reason] = (tally[reason] ?? 0) + 1; };
  const measurable = [];
  for (const [key, node] of keyed) {
    const reason = exclusionByKey.get(key);
    if (reason) bump(reason);
    else measurable.push([key, node]);
  }
  let eligible = keyed.length;
  for (const key of [...unplaceable].sort()) {
    // No usable event time anywhere, so this key cannot be ruled INTO or OUT OF any window.
    // Omitting it would overstate coverage, so it is counted — once per window, because nothing
    // in the evidence places it in one window rather than another.
    if (placed.has(key)) continue;
    eligible += 1;
    bump('UNPLACEABLE_EVENT_TIME');
  }
  const denominator = measurable.length;
  return {
    measurable,
    counts: {
      eligible,
      excluded: eligible - denominator,
      exclusions: Object.fromEntries(EXCLUSION_REASONS
        .filter((reason) => tally[reason])
        .map((reason) => [reason, tally[reason]])),
      coverageRatio: eligible === 0 ? null : denominator / eligible,
    },
  };
}

function computeEdge(
  population,
  contract,
  window,
  analysisCutoff,
  matureAsOf,
  profileFloor,
) {
  const rule = contract.eligibilityRule;
  const configuredThreshold = rule?.minimumSample;
  // Consistent with `EligibilityRuleSchema`, which hard-rejects the same values. A contract that
  // reached here with a broken `minimumSample` bypassed the schema, and degrading it to a
  // threshold of 0 would turn "this contract is wrong" into "every rate ranks".
  if (
    rule && typeof rule === 'object' && Object.hasOwn(rule, 'minimumSample')
    && (!Number.isInteger(configuredThreshold) || configuredThreshold < 0)
  ) throw codedError('METRICS_CONTRACT_INVALID', TypeError);
  const threshold = Number.isInteger(configuredThreshold) && configuredThreshold >= 0
    ? configuredThreshold
    : 0;
  const coverageFloor = coverageFloorFor(contract, profileFloor);
  if (contract.nativeMapping !== 'MAPPED') return unknownMetric(window, threshold, coverageFloor);

  const journeyNodes = population.all.filter((node) => (
    node.journeyInstanceId === contract.journeyInstanceId
      && node.journeyId === contract.journeyId
  ));
  const visible = (node) => {
    const captured = placeable(node.capturedAt ?? node.eventTime);
    return !captured || Temporal.Instant.compare(captured, instant(analysisCutoff)) <= 0;
  };
  // Conversions are drawn from the countable population, the same set the entrants come from.
  // Nothing changes for a measurable key — an untrustworthy conversion already excluded its own
  // key below — but the two halves of the rate now read from ONE decision instead of two.
  const events = journeyNodes
    .filter((node) => (
      population.isCountable(node)
        && Temporal.Instant.compare(
          instant(node.capturedAt ?? node.eventTime),
          instant(analysisCutoff),
        ) <= 0
    ))
    .sort(sortEvents);
  if (
    contract.reentryRule === 'new_journey_instance'
    && events.some((node) => (
      [contract.fromStage, contract.toStage].includes(stageOf(node))
        && typeof node.cohortInstanceRef !== 'string'
    ))
  ) return unknownMetric(window, threshold, coverageFloor, 'MISSING_COHORT_INSTANCE');

  /*
   * TRUST, DECIDED PER EVENT AND RECORDED AGAINST THE KEY THE METRIC GROUPS BY.
   *
   * `computeEdge` matches an entrant to its conversion on `eventKey`, which under
   * `reentryRule: "new_journey_instance"` is the COHORT INSTANCE and not the subject — and eight
   * of the ten shipped client edges use that rule. Recording exclusions against anything else
   * (round 1 used `subjectKey`) lets an untrustworthy CONVERSION be credited to a trustworthy
   * entrant, because the two keys need not agree.
   *
   * Every row this edge could consume is checked: entrants at `fromStage` and conversions at
   * `toStage`, whatever their type and whether or not they are observed. Rows at other stages
   * belong to other edges and are left to them.
   */
  const consumedStages = [contract.fromStage, contract.toStage];
  const participants = journeyNodes
    .filter((node) => consumedStages.includes(stageOf(node)) && visible(node));
  const exclusionByKey = new Map();
  for (const node of participants) {
    const reason = population.reasonFor(node);
    if (!reason) continue;
    const key = eventKey(node, contract.reentryRule);
    exclusionByKey.set(key, moreSpecific(exclusionByKey.get(key), reason));
  }

  // THE ELIGIBLE POPULATION, trusted or not. Untrusted entrants are counted here and dropped
  // below, so an audit that measured a fraction of the account cannot look like one that
  // measured all of it.
  const fromByKey = new Map();
  const unplaceable = new Set();
  // Window-INDEPENDENT, unlike the entrant map: a key with a usable entry time anywhere has been
  // placed, and must not be re-counted as unplaceable by every OTHER window's metric.
  const placed = new Set();
  for (const node of participants) {
    if (stageOf(node) !== contract.fromStage) continue;
    const key = eventKey(node, contract.reentryRule);
    if (!placeable(node.eventTime)) {
      unplaceable.add(key);
      continue;
    }
    placed.add(key);
    if (!inside(node.eventTime, window)) continue;
    const prior = fromByKey.get(key);
    if (!prior || sortEvents(node, prior) < 0) fromByKey.set(key, node);
  }
  const entrants = [...fromByKey.entries()].sort(([, left], [, right]) => sortEvents(left, right));
  const mature = [];
  for (const [key, node] of entrants) {
    const maturity = addLag(node.eventTime, contract.allowedLag, window);
    if (
      Temporal.Instant.compare(instant(node.eventTime), instant(matureAsOf)) < 0
      && Temporal.Instant.compare(maturity, instant(analysisCutoff)) <= 0
    ) mature.push([key, node]);
  }
  if (entrants.length > 0 && mature.length === 0) {
    /*
     * NOTHING MATURED, BUT THE POPULATION IS STILL KNOWN.
     *
     * This return used to discard the counts it had already established, leaving `eligible`,
     * `excluded` and `exclusions` empty. No unearned number could hide in an UNKNOWN, but three
     * things followed: the reasonCode blamed missing evidence for what was really an exclusion,
     * `PARTIAL_SUBJECT_COVERAGE` could not fire downstream, and the report's coverage disclosure —
     * which keys off `excluded` — announced full coverage for a window in which every subject was
     * conflicted. The counts are carried through instead, over the ENTRANTS, since maturity is
     * what stopped them being measured and not trust.
     */
    const { counts: earlyCounts } = countsFor(entrants, exclusionByKey, unplaceable, placed);
    const globallyImmature = entrants.every(([, node]) => (
      Temporal.Instant.compare(instant(node.eventTime), instant(matureAsOf)) >= 0
    ));
    // When trust refused EVERY entrant, the cohort's age is beside the point: waiting for it to
    // mature would not have produced a rate. The exclusion is the honest cause.
    const allExcluded = earlyCounts.eligible > 0
      && earlyCounts.excluded === earlyCounts.eligible;
    let reasonCode = 'MISSING_REQUIRED_EVIDENCE';
    if (allExcluded) reasonCode = 'ALL_SUBJECTS_EXCLUDED';
    else if (globallyImmature) reasonCode = 'IMMATURE_COHORT';
    return unknownMetric(window, threshold, coverageFloor, reasonCode, earlyCounts);
  }

  const { measurable, counts } = countsFor(mature, exclusionByKey, unplaceable, placed);
  const {
    eligible, excluded, exclusions, coverageRatio,
  } = counts;
  const denominator = measurable.length;
  if (eligible > 0 && denominator === 0) {
    return unknownMetric(window, threshold, coverageFloor, 'ALL_SUBJECTS_EXCLUDED', counts);
  }
  if (eligible > 0 && coverageRatio < coverageFloor) {
    return unknownMetric(window, threshold, coverageFloor, 'COVERAGE_BELOW_FLOOR', counts);
  }

  let numerator = 0;
  let value = 0;
  const isRevenueMetric = contract.toStage === 'collected_revenue'
    || contract.edgeId.toLowerCase().includes('revenue');
  for (const [key, from] of measurable) {
    const fromTime = instant(from.eventTime);
    const deadline = addLag(from.eventTime, contract.allowedLag, window);
    const to = events.find((candidate) => (
      eventKey(candidate, contract.reentryRule) === key
        && stageOf(candidate) === contract.toStage
        && Temporal.Instant.compare(instant(candidate.eventTime), fromTime) >= 0
        && Temporal.Instant.compare(instant(candidate.eventTime), deadline) <= 0
        && Temporal.Instant.compare(
          instant(candidate.capturedAt ?? candidate.eventTime),
          instant(analysisCutoff),
        ) <= 0
    ));
    if (to) {
      if (
        isRevenueMetric
        && (!Number.isFinite(to.revenueAmount) || to.revenueAmount < 0)
      ) {
        return unknownMetric(
          window,
          threshold,
          coverageFloor,
          'INVALID_REVENUE_EVIDENCE',
          counts,
        );
      }
      numerator += 1;
      if (Number.isFinite(to.revenueAmount)) value += to.revenueAmount;
    }
  }
  const result = {
    state: 'OBSERVED',
    numerator,
    denominator,
    rate: denominator === 0 ? null : numerator / denominator,
    eligible,
    excluded,
    exclusions,
    threshold,
    rankEligible: denominator >= threshold,
    window,
    // `denominator === 0` here can only mean `eligible === 0`: a collapsed denominator was
    // returned as UNKNOWN above, so this zero is a measured zero and never a false one.
    coverage: excluded === 0 ? 'COMPLETE' : 'INCOMPLETE',
    coverageRatio,
    coverageFloor,
    ...floorDisclosure(coverageFloor),
    reasonCode: denominator === 0 ? 'NO_ELIGIBLE_POPULATION' : null,
  };
  if (isRevenueMetric || value !== 0) result.value = denominator === 0 ? null : value;
  return result;
}

/**
 * WHERE THE ACCOUNT IS SITTING RIGHT NOW, over the countable population only.
 *
 * Placing a subject at a stage is a claim about that subject, and an untrustworthy row is exactly
 * a row that cannot support one: a duplicate identity, an unresolved join or an unproven join
 * leaves it unknown WHOSE stage this is. Such a subject is therefore OMITTED rather than counted
 * at its apparent stage — counting it would assert a position nothing proved, and inventing a
 * pseudo-stage for it would put a non-stage key into a map every consumer reads as stage counts.
 *
 * The omission is not silent: the same rows are counted, per reason, in `exclusions` on every
 * metric that consumed them, which is the channel the report and `mechanisms.mjs` already read.
 */
function stockFor(population, end, analysisCutoff) {
  const latest = new Map();
  for (const node of [...population.countable].sort(sortEvents)) {
    if (Temporal.Instant.compare(instant(node.eventTime), instant(end)) >= 0) continue;
    if (Temporal.Instant.compare(
      instant(node.capturedAt ?? node.eventTime),
      instant(analysisCutoff),
    ) > 0) continue;
    latest.set(subjectKey(node), node);
  }
  const counts = {};
  for (const node of latest.values()) {
    const stage = stageOf(node);
    const journey = counts[node.journeyInstanceId] ?? {};
    journey[stage] = (journey[stage] ?? 0) + 1;
    counts[node.journeyInstanceId] = journey;
  }
  return counts;
}

/**
 * THE ENTRY COHORT THE REPORT PRINTS BESIDE THE RATE, over the countable population only.
 *
 * This number appears as "- Denominator: N" and "Entry cohort: N" (`report.mjs`) immediately next
 * to "measured D of E eligible". It used to be built from every observed journey row, including
 * the ones the rate itself had judged unfit, so a reader comparing the two was shown a cohort the
 * metric would refuse to measure and given no way to tell.
 *
 * Untrusted entrants are OMITTED here rather than reported as a second number: the cohort's job is
 * to say what the printed rate was computed over, and any second number in this map would be
 * indistinguishable from a journey instance to every consumer (it is keyed by journey instance and
 * sealed as `cohortHash`). What was dropped is not lost — it is carried, per reason, on each
 * metric's `eligible`/`excluded`/`exclusions`, which the same report renders in the same breath.
 */
function cohortCounts(population, contracts, window, analysisCutoff) {
  const stagesByJourney = new Map();
  for (const contract of contracts) {
    const current = stagesByJourney.get(contract.journeyInstanceId) ?? {
      from: new Set(),
      to: new Set(),
    };
    current.from.add(contract.fromStage);
    current.to.add(contract.toStage);
    stagesByJourney.set(contract.journeyInstanceId, current);
  }
  const entriesByJourney = new Map([...stagesByJourney].map(([journey, stages]) => {
    const roots = [...stages.from].filter((stage) => !stages.to.has(stage));
    return [journey, new Set(roots.length > 0 ? roots : stages.from)];
  }));
  const byJourney = new Map();
  for (const node of population.countable.filter(({ eventTime, capturedAt }) => (
    inside(eventTime, window)
      && Temporal.Instant.compare(
        instant(capturedAt ?? eventTime),
        instant(analysisCutoff),
      ) <= 0
  ))) {
    const key = node.journeyInstanceId;
    if (!entriesByJourney.get(key)?.has(stageOf(node))) continue;
    const subjects = byJourney.get(key) ?? new Set();
    subjects.add(eventKey(node));
    byJourney.set(key, subjects);
  }
  return Object.fromEntries([...byJourney].sort(([a], [b]) => a.localeCompare(b))
    .map(([key, values]) => [key, values.size]));
}

export function computeJourneyMetrics({ graph, metricContracts, windows }) {
  if (
    !graph
    || !Array.isArray(graph.nodes)
    || !Array.isArray(graph.edges)
    || !Array.isArray(graph.conflicts)
    || !Array.isArray(graph.unresolvedJoins)
    || !metricContracts
    || !Array.isArray(metricContracts.edges)
    || !windows?.currentClosedWeek
  ) throw codedError('METRICS_INPUT_INVALID', TypeError);
  assertDeepFrozen(graph);
  // Reported in this fixed order, and only for the windows the caller actually built, so a sealed
  // window set from an earlier run replays to the same keys.
  const namedWindows = WINDOW_NAMES
    .filter((name) => windows[name])
    .map((name) => [name, windows[name]]);
  // Decided ONCE, here, and handed to every surface below. Nothing downstream sees the raw node
  // list, so no surface can answer "may I count this row?" differently from any other.
  const population = metricPopulation(graph);
  const metrics = {};
  const cohorts = {};
  for (const [name, window] of namedWindows) {
    metrics[name] = {};
    for (const contract of metricContracts.edges) {
      metrics[name][contract.edgeId] = computeEdge(
        population,
        contract,
        window,
        windows.cutoff,
        windows.matureAsOf,
        metricContracts.coverageFloor,
      );
    }
    cohorts[name] = cohortCounts(
      population,
      metricContracts.edges,
      window,
      windows.cutoff,
    );
  }
  return deepFreeze({
    metrics,
    cohorts,
    currentStock: stockFor(
      population,
      windows.currentClosedWeek.end,
      windows.cutoff,
    ),
  });
}
