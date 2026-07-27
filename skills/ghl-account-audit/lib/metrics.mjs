import { Temporal } from '@js-temporal/polyfill';
import { DEFAULT_REPORTING_WINDOWS, WINDOW_NAMES } from './window-names.mjs';

export { DEFAULT_REPORTING_WINDOWS, WINDOW_NAMES };

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

/**
 * THE TWO CLOCKS, WHICH ARE NOT THE SAME CLOCK.
 *
 * `cutoff` is an EVENT-TIME boundary: the instant the reported week closes. `planWeeklyCollection`
 * seals it as the closed-week Monday and `kernel.mjs` uses it as the collection window's `to`, so
 * it is ALWAYS IN THE PAST at the moment the run executes.
 *
 * `capturedThrough` is a COLLECTION-TIME boundary: the last instant at which any evidence in the
 * graph was actually read from the provider. Every real run collects AFTER the week it reports on
 * has closed, so `capturedThrough > cutoff` is not an edge case — it is the only thing that ever
 * happens. On the first live run (Grom UK, `run_937bffa1`) the gap was 7h12m: cutoff
 * 2026-07-26T23:00Z, capture 2026-07-27T06:12Z.
 *
 * The two were one value until 2026-07-27, and `computeEdge`, `cohortCounts` and `stockFor` all
 * refuse a node whose `capturedAt` is past the analysis boundary — a genuine no-lookahead rule for
 * a graph assembled from SEVERAL collections (the `priorWatermark` merge path), where `capturedAt`
 * really does vary per node. Compared against the EVENT boundary instead, that rule discards one
 * hundred per cent of every real run's evidence, silently, and reports the account as empty:
 * 1,099 projected events and a 1,287-node graph produced `eligible: 0` in every cell of every
 * window, `cohorts: {}` and `currentStock: {}`, with the entirely plausible-looking reason code
 * `NO_ELIGIBLE_POPULATION`.
 *
 * Every fixture hid it by authoring `capturedAt` at or before the cutoff, which a collection
 * cannot do. `capturedThrough` therefore DEFAULTS to `cutoff` — so a caller that says nothing
 * keeps byte-identical behaviour — and `computeJourneyMetrics` refuses outright, rather than
 * reporting zero, when the horizon it was given predates every piece of evidence it was handed.
 */
export function buildWindows({ cutoff, timezone, maturityDays, capturedThrough }) {
  if (
    typeof cutoff !== 'string'
    || typeof timezone !== 'string'
    || !Number.isInteger(maturityDays)
    || maturityDays < 0
    || (capturedThrough !== undefined && typeof capturedThrough !== 'string')
  ) throw codedError('METRICS_WINDOW_INVALID', TypeError);
  let localCutoff;
  try {
    localCutoff = zoned(cutoff, timezone);
  } catch {
    throw codedError('METRICS_WINDOW_INVALID', TypeError);
  }
  let localCapturedThrough = localCutoff;
  if (capturedThrough !== undefined) {
    try {
      localCapturedThrough = zoned(capturedThrough, timezone);
    } catch {
      throw codedError('METRICS_WINDOW_INVALID', TypeError);
    }
  }
  const currentEnd = localCutoff
    .subtract({ days: localCutoff.dayOfWeek - 1 })
    .startOfDay();
  const currentStart = currentEnd.subtract({ weeks: 1 });
  const previousStart = currentStart.subtract({ weeks: 1 });
  const trailingStart = currentEnd.subtract({ days: 28 });
  const midTrailingStart = currentEnd.subtract({ days: 60 });
  const longTrailingStart = currentEnd.subtract({ days: 90 });
  const settledTrailingStart = currentEnd.subtract({ days: 180 });
  const matureAsOf = currentEnd.subtract({ days: maturityDays });
  return deepFreeze({
    timezone,
    cutoff: localCutoff.toString(),
    currentClosedWeek: windowOf(currentStart, currentEnd),
    previousClosedWeek: windowOf(previousStart, currentStart),
    trailing28Days: windowOf(trailingStart, currentEnd),
    /*
     * THE MATURITY LADDER — 60 / 90 / 180, decided by Xander on 2026-07-27.
     *
     * A window no longer than an edge's `allowedLag` can almost never mature anybody: only a
     * subject entering on the window's very first instant has had the whole lag elapse by the
     * cutoff. `showed_to_opportunity_outcome` allows 90 days and the longest window was 90 days, so
     * over 52 simulated weekly runs it reported nothing at all in the weeks the cutoff landed on
     * the closed-week Monday, and where it did fire it averaged a denominator of 1 to 2 against the
     * ~23 subjects that actually qualified for the window.
     *
     * The fix is not to shorten the lag, which would silently drop slow-closing deals — a real
     * share of a clinic's revenue. It is to report the SAME measurement at three maturities, each
     * over a lookback roughly DOUBLE its lag, so roughly half of every window can mature:
     *
     *   allowed lag 30 days -> trailing 60 days   reacts fast; says whether a recent change works
     *   allowed lag 60 days -> trailing 90 days   the middle read
     *   allowed lag 90 days -> trailing 180 days  the true settled number, too slow to attribute
     *
     * All three are needed. The 90/180 number is the honest one but it moves too slowly to credit
     * or blame anything done this month; the 30/60 number moves within weeks but under-counts deals
     * that close late. A single long window would hide recent movement entirely, which is the
     * failure this ladder exists to prevent.
     *
     * Every one of them is anchored to the SAME closed-week Monday boundary as every other window
     * and then counted back in account-local calendar days, so `durationHours` is real elapsed
     * hours (e.g. 2159 or 2161 for the 90-day window across a DST transition), never a constant.
     */
    trailing60Days: windowOf(midTrailingStart, currentEnd),
    trailing90Days: windowOf(longTrailingStart, currentEnd),
    trailing180Days: windowOf(settledTrailingStart, currentEnd),
    matureAsOf: matureAsOf.toString(),
    maturityDays,
    // The COLLECTION boundary, kept beside the EVENT boundary rather than folded into it. It plays
    // no part in placing any window — every window above is anchored to the closed-week Monday and
    // is byte-identical whether this is declared or not — and exists only so the no-lookahead rule
    // can be applied to the clock it is actually about.
    capturedThrough: localCapturedThrough.toString(),
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

/**
 * WHICH WINDOWS DOES THIS EDGE REPORT ON?
 *
 * Declared as profile DATA (`MetricEdgeSchema.reportingWindows`), because the answer is a property
 * of the edge's lag and not of the engine. Before the maturity ladder every edge was computed over
 * every window, which is why a 90-day-lag edge was published over a 90-day window it could never
 * mature and a 2-day-lag edge was published over the same one it had long since saturated.
 *
 * ABSENT means `DEFAULT_REPORTING_WINDOWS` — the exact window set that existed before this change,
 * so an edge written before it keeps byte-identical behaviour and the two new windows are opt-in.
 *
 * Validated HERE as well as in `MetricEdgeSchema`, on the same principle as `minimumSample` and
 * `minimumCoverage`: a contract that reached the engine with a broken declaration bypassed the
 * schema, and degrading it to "report everywhere" would turn "this contract is wrong" into a set of
 * numbers nobody asked for.
 */
function reportingWindowsFor(contract) {
  const declared = contract.reportingWindows;
  if (declared === undefined) return DEFAULT_REPORTING_WINDOWS;
  if (
    !Array.isArray(declared)
    || declared.length === 0
    || new Set(declared).size !== declared.length
    || declared.some((name) => !WINDOW_NAMES.includes(name))
  ) throw codedError('METRICS_CONTRACT_INVALID', TypeError);
  return declared;
}

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
    eligible: null,
    excluded: null,
    immature: null,
    exclusions: {},
    coverageRatio: null,
    maturityRatio: null,
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
    immature: counts.immature,
    exclusions: counts.exclusions,
    threshold,
    rankEligible: false,
    window,
    coverage: 'INCOMPLETE',
    coverageRatio: counts.coverageRatio,
    maturityRatio: counts.maturityRatio,
    coverageFloor,
    ...floorDisclosure(coverageFloor),
  };
}

/**
 * COMPLETE means NOTHING WAS DROPPED, and it has to mean that for BOTH reasons a subject can be
 * dropped. Before task A2 round 2 it only saw `excluded`, so a cell that measured 17 of 28 in-window
 * entrants — 39% of its window silently absent because their lag had not elapsed — still declared
 * complete coverage over an `eligible` of 17.
 */
function coverageLabel(excluded, immature) {
  return excluded === 0 && immature === 0 ? 'COMPLETE' : 'INCOMPLETE';
}

/**
 * WHY A VALUE CELL CARRIES NO RATE, named by cause. `RATE_NOT_DERIVABLE` is a statement about the
 * QUESTION and presumes there were subjects to ask it of; when there were none, or when trust
 * refused all of them, the honest cause is the population and not the question. Task A2 round 3:
 * a VALUE cell whose every subject was excluded reported `RATE_NOT_DERIVABLE`, which reads as a
 * design choice rather than as the account problem it actually is.
 */
function emptyValueReason(eligible, excluded) {
  if (eligible === 0) return 'NO_ELIGIBLE_POPULATION';
  if (excluded === eligible) return 'ALL_SUBJECTS_EXCLUDED';
  return 'RATE_NOT_DERIVABLE';
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
 * THE POPULATION SPLIT, over the WHOLE in-window entrant set.
 *
 * Task A2 round 2. This used to be handed only the entrants that had already MATURED, so `eligible`
 * described the maturable rump of the window rather than the window. Measured on 28 appointments
 * booked one per day across `trailing28Days` with a 14-day lag: the cell reported
 * `eligible 17, excluded 0, coverage COMPLETE` while 11 of the 28 entrants had been dropped without
 * a word — and the 0.8 floor, whose whole rationale is that a fifth of the population is the most
 * that can be lost, never engaged because it could not see the loss.
 *
 * THE THREE-WAY PARTITION, `eligible = excluded + immature + denominator`, which holds exactly ON
 * AN OBSERVED CELL. It is a statement about `countsFor`'s own three buckets and stays true of them
 * always; what it cannot claim is that the PUBLISHED cell exhibits it, because `denominator` is
 * published as `null` on an UNKNOWN cell and on a VALUE cell, both of which publish `eligible`,
 * `excluded` and `immature` as real numbers. On those cells the readable partition is
 * `eligible = excluded + immature + (subjects that were measurable)`, and the last term is simply
 * not surfaced under that name.
 *
 * - EXCLUDED — the evidence for this subject cannot be trusted. Decided FIRST, ahead of maturity,
 *   because it is a property of the evidence and not of time: waiting for a conflicted subject to
 *   mature would not produce an answer.
 * - IMMATURE — trustworthy, but the edge's allowed lag has not elapsed, so no method could answer
 *   for it yet. Not lost, merely not yet answerable.
 * - DENOMINATOR — trustworthy and answerable, the only rows a rate is computed over.
 *
 * TWO RATIOS, because the two ignorances are not the same thing and one number cannot carry both:
 *
 * - `coverageRatio = denominator / (eligible - immature)` — the TRUST ratio, over the answerable
 *   population. This is the one THE FLOOR GOVERNS, and that is a deliberate decision. The floor's
 *   stated rationale is that a rate stops being an honest description of the account once too much
 *   of the population is lost; an immature entrant is not lost, it is a row for which no answer
 *   exists yet by any means, and folding it in would make the floor fire on the CALENDAR rather
 *   than on the data. Concretely: `trailing28Days` can mature only 50% of its window for a 14-day
 *   lag, so a combined ratio would put every appointment edge of every account permanently under
 *   the floor — the all-UNKNOWN failure task A2a exists to have removed.
 * - `maturityRatio = (eligible - immature) / eligible` — the ANSWERABLE share of the window,
 *   published beside it. This is the number that says "half of this window cannot be spoken for
 *   yet", and `coverage` goes INCOMPLETE whenever it is below 1, so no cell can ever again declare
 *   complete coverage while dropping a large share of its window.
 */
function countsFor(keyed, matureKeys, exclusionByKey, unplaceable, placed) {
  const tally = {};
  const bump = (reason) => { tally[reason] = (tally[reason] ?? 0) + 1; };
  const measurable = [];
  let immature = 0;
  for (const [key, node] of keyed) {
    const reason = exclusionByKey.get(key);
    if (reason) {
      bump(reason);
      continue;
    }
    if (!matureKeys.has(key)) {
      immature += 1;
      continue;
    }
    measurable.push([key, node]);
  }
  let eligible = keyed.length;
  for (const key of [...unplaceable].sort()) {
    // No usable event time anywhere, so this key cannot be ruled INTO or OUT OF any window.
    // Omitting it would overstate coverage, so it is counted — once per window, because nothing
    // in the evidence places it in one window rather than another. It is EXCLUDED, never immature:
    // an event time that cannot be read will not become readable by waiting.
    if (placed.has(key)) continue;
    eligible += 1;
    bump('UNPLACEABLE_EVENT_TIME');
  }
  const denominator = measurable.length;
  const answerable = eligible - immature;
  return {
    measurable,
    counts: {
      eligible,
      excluded: answerable - denominator,
      immature,
      answerable,
      exclusions: Object.fromEntries(EXCLUSION_REASONS
        .filter((reason) => tally[reason])
        .map((reason) => [reason, tally[reason]])),
      coverageRatio: answerable === 0 ? null : denominator / answerable,
      maturityRatio: eligible === 0 ? null : answerable / eligible,
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
  captureHorizon,
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
  // NO LOOKAHEAD, ON THE COLLECTION CLOCK. `capturedAt` says when a row was READ, never when the
  // thing it describes happened, so it is compared against the run's capture horizon and NOT
  // against the week boundary the metric reports on. See `buildWindows`.
  const visible = (node) => {
    const captured = placeable(node.capturedAt ?? node.eventTime);
    return !captured || Temporal.Instant.compare(captured, instant(captureHorizon)) <= 0;
  };
  // Conversions are drawn from the countable population, the same set the entrants come from.
  // Nothing changes for a measurable key — an untrustworthy conversion already excluded its own
  // key below — but the two halves of the rate now read from ONE decision instead of two.
  const events = journeyNodes
    .filter((node) => (
      population.isCountable(node)
        && Temporal.Instant.compare(
          instant(node.capturedAt ?? node.eventTime),
          instant(captureHorizon),
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
  const isRevenueMetric = contract.toStage === 'collected_revenue'
    || contract.edgeId.toLowerCase().includes('revenue');
  const isValueMeasure = contract.measure === 'VALUE';

  /*
   * MATURITY IS NOW A LABEL ON THE POPULATION, NOT A FILTER IN FRONT OF IT.
   *
   * `countsFor` is handed EVERY in-window entrant together with the set that matured, so `eligible`
   * describes the window and `immature` says how much of it cannot be spoken for yet. Before this
   * round the mature subset was passed in as though it were the population, which is how a cell
   * could drop 39% of its window and still print `coverage: COMPLETE`.
   *
   * A VALUE MEASURE HAS NOTHING TO WAIT FOR, so every one of its entrants is mature at its own
   * instant. This is the SAME premise `measure: "VALUE"` and `tautologicalStagePairs` are built on,
   * stated once more where it decides something: a VALUE edge is declared only where both stages
   * come off the same record under the same predicate and the same event-time reading, so the
   * amount is known at the moment the entrant exists. Nothing about it can become truer by waiting,
   * and no later evidence can revise it, because there is no later evidence — there is one row.
   *
   * Task A2 round 3. Left as an ordinary lag-driven split, `won_to_collected_revenue`'s leftover
   * 60-day `allowedLag` — correct while it was a rate, meaningless once it was not — deleted the
   * account's money: a window no longer than 60 days matured NOBODY, so the weekly and 28-day
   * revenue figures were structurally `null`, and the 90-day figure carried only the wins closed
   * more than 60 days before the cutoff. Measured on a hand-summed three-win account:
   * `null / null / 8000` against a true `450 / 2450 / 10450`.
   *
   * `allowedLag` is deliberately NOT set to zero to achieve this. It still governs the conversion
   * deadline below, where it is a genuine statement about the contract; forcing it to zero would
   * bury the exemption in a magic number in a profile file, where the next reader would have to
   * rediscover the reason. If a VALUE edge ever DOES have a genuine waiting period — an amount
   * settled by a later record, from a source the entrant's row does not contain — then it is not
   * this kind of edge at all: the two stages would no longer be the same record under the same
   * predicate, so `tautologicalStagePairs` would stop calling it a tautology and it would have to
   * be justified as a RATE, with maturity restored, rather than declared VALUE.
   */
  const matureKeys = new Set();
  for (const [key, node] of entrants) {
    if (isValueMeasure) {
      matureKeys.add(key);
      continue;
    }
    const maturity = addLag(node.eventTime, contract.allowedLag, window);
    if (
      Temporal.Instant.compare(instant(node.eventTime), instant(matureAsOf)) < 0
      && Temporal.Instant.compare(maturity, instant(analysisCutoff)) <= 0
    ) matureKeys.add(key);
  }

  const { measurable, counts } = countsFor(
    entrants,
    matureKeys,
    exclusionByKey,
    unplaceable,
    placed,
  );
  const {
    eligible, excluded, immature, answerable, exclusions, coverageRatio, maturityRatio,
  } = counts;
  const denominator = measurable.length;

  /*
   * WHY NOTHING WAS MEASURED, named by cause rather than by shrug.
   *
   * An edge blocked purely by its allowed lag used to report `MISSING_REQUIRED_EVIDENCE`, the same
   * code an entirely unmapped edge reports, because `IMMATURE_COHORT` demanded that EVERY entrant be
   * newer than `matureAsOf` — a condition the lag-blocked case never satisfies. The population split
   * above answers the question directly: if trust refused everybody the cause is exclusion, and
   * otherwise the only thing left standing between the entrants and an answer is time.
   */
  const emptyReason = () => {
    if (eligible === 0) return 'NO_ELIGIBLE_POPULATION';
    if (excluded === eligible) return 'ALL_SUBJECTS_EXCLUDED';
    return 'IMMATURE_COHORT';
  };

  if (!isValueMeasure) {
    if (eligible > 0 && denominator === 0) {
      return unknownMetric(window, threshold, coverageFloor, emptyReason(), counts);
    }
    if (answerable > 0 && coverageRatio < coverageFloor) {
      return unknownMetric(window, threshold, coverageFloor, 'COVERAGE_BELOW_FLOOR', counts);
    }
  }

  let numerator = 0;
  let value = 0;
  let valueSubjects = 0;
  for (const [key, from] of measurable) {
    const fromTime = instant(from.eventTime);
    const deadline = addLag(from.eventTime, contract.allowedLag, window);
    const to = events.find((candidate) => (
      eventKey(candidate, contract.reentryRule) === key
        && stageOf(candidate) === contract.toStage
        && Temporal.Instant.compare(instant(candidate.eventTime), fromTime) >= 0
        && Temporal.Instant.compare(instant(candidate.eventTime), deadline) <= 0
        // The COLLECTION clock again — `events` is already filtered on it, and the redundancy is
        // kept so a future caller of `events.find` cannot reintroduce the lookahead by accident.
        // The EVENT clock is enforced above by `deadline`, which for a measurable entrant can
        // never exceed `analysisCutoff`: `matureKeys` admits a key only when its whole allowed lag
        // has elapsed by the cutoff, and `deadline` IS the entrant plus that same lag.
        && Temporal.Instant.compare(
          instant(candidate.capturedAt ?? candidate.eventTime),
          instant(captureHorizon),
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
      if (Number.isFinite(to.revenueAmount)) {
        value += to.revenueAmount;
        valueSubjects += 1;
      }
    }
  }

  /*
   * A VALUE MEASURE PUBLISHES MONEY, AND NEVER A RATE.
   *
   * `won` and `collected_revenue` are projected from the SAME opportunity record under the SAME
   * predicate off the SAME event-time field, so the conversion exists at the entrant's own instant
   * for every entrant that exists at all: `numerator === denominator` in every probe, including an
   * exhaustive sweep over priced / zero / string / null / missing / negative / float amounts. The
   * rate is the constant 1 and the only informative things in the cell are the AMOUNT and the
   * POPULATION BEHIND IT.
   *
   * `numerator`, `denominator` and `rate` are therefore all null and `state` is UNKNOWN — the
   * CONVERSION genuinely is unknown, and a collection rate is not derivable from opportunity data
   * alone. That is also exactly the shape `mechanisms.mjs:939-942` requires of a non-OBSERVED
   * metric, so nothing downstream can pick the constant up and re-publish it as a measurement.
   *
   * What IS published: `value`, the amount, on the revenue basis the profile declares
   * (`opportunity_monetary_value` for both shipped profiles — the standing owner decision); and
   * `valueSubjects`, how many subjects it was summed over, so the amount is never read as covering
   * a population it does not. The coverage floor deliberately does NOT suppress this: the floor
   * guards a RATE against being computed over a rump, and there is no rate here. Suppressing the
   * amount would delete the account's money over a rule aimed at something else, while `excluded`,
   * `immature` and `coverageRatio` already say exactly how much of the window it covers.
   *
   * THE REASON CODE NAMES THE CAUSE, on the same rule as the rate path. `RATE_NOT_DERIVABLE` says
   * "there were subjects, and a rate is simply not the right question for them". It is the wrong
   * answer when there were no subjects (`NO_ELIGIBLE_POPULATION`) and equally wrong when trust
   * refused every one of them (`ALL_SUBJECTS_EXCLUDED`) — in that case the cell reports no money
   * for a reason a reader can act on, rather than one that sounds like a design choice.
   */
  if (isValueMeasure) {
    return {
      ...UNKNOWN,
      reasonCode: emptyValueReason(eligible, excluded),
      value: valueSubjects === 0 ? null : value,
      valueSubjects,
      eligible,
      excluded,
      immature,
      exclusions,
      threshold,
      // A value can never satisfy a RATE sample threshold, and claiming it could would let a
      // constant back into the ranking by the side door.
      rankEligible: false,
      window,
      coverage: coverageLabel(excluded, immature),
      coverageRatio,
      maturityRatio,
      coverageFloor,
      ...floorDisclosure(coverageFloor),
    };
  }

  const result = {
    state: 'OBSERVED',
    numerator,
    denominator,
    rate: denominator === 0 ? null : numerator / denominator,
    eligible,
    excluded,
    immature,
    exclusions,
    threshold,
    rankEligible: denominator >= threshold,
    window,
    // `denominator === 0` here can only mean `eligible === 0`: a collapsed denominator was
    // returned as UNKNOWN above, so this zero is a measured zero and never a false one.
    coverage: coverageLabel(excluded, immature),
    coverageRatio,
    maturityRatio,
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
function stockFor(population, end, captureHorizon) {
  const latest = new Map();
  for (const node of [...population.countable].sort(sortEvents)) {
    // The EVENT clock: nothing dated at or after the week's close belongs to this week's stock.
    if (Temporal.Instant.compare(instant(node.eventTime), instant(end)) >= 0) continue;
    // The COLLECTION clock, separately. See `buildWindows`.
    if (Temporal.Instant.compare(
      instant(node.capturedAt ?? node.eventTime),
      instant(captureHorizon),
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
function cohortCounts(population, contracts, window, captureHorizon) {
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
    // The EVENT clock places the entrant in the window; the COLLECTION clock decides whether this
    // run had read it yet. See `buildWindows`.
    inside(eventTime, window)
      && Temporal.Instant.compare(
        instant(capturedAt ?? eventTime),
        instant(captureHorizon),
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
  /*
   * WHICH WINDOWS THIS RUN REPORTS ON, and which edges appear in each. Resolved once, in a fixed
   * order, so a sealed run replays to exactly the same keys.
   *
   * THE WINDOW SET is the DEFAULT set plus every window some edge declares, intersected with the
   * windows the caller actually built.
   *
   * - The default set is the report's SPINE and is present whenever it is built, even if it ends up
   *   empty. `report.mjs` reads `metrics.cohorts.currentClosedWeek` directly, and "this week
   *   reported nothing" is a fact worth publishing rather than a key worth deleting. It is also the
   *   behaviour every contract had before this change, including one with no edges at all.
   * - A window OUTSIDE the default set appears only because an edge asked for it. That is what
   *   keeps a run whose contracts never mention the 180-day lookback from publishing a
   *   `trailing180Days` key nobody can interpret.
   *
   * `reportingWindowsFor` is called before the loop, so a broken declaration throws whatever
   * windows this particular run happens to have built.
   */
  const windowsByEdge = metricContracts.edges.map(
    (contract) => [contract, new Set(reportingWindowsFor(contract))],
  );
  const reported = new Set(DEFAULT_REPORTING_WINDOWS);
  for (const [, declared] of windowsByEdge) for (const name of declared) reported.add(name);
  const namedWindows = WINDOW_NAMES
    .filter((name) => windows[name] && reported.has(name))
    .map((name) => [
      name,
      windows[name],
      windowsByEdge.filter(([, declared]) => declared.has(name)).map(([contract]) => contract),
    ]);
  // Decided ONCE, here, and handed to every surface below. Nothing downstream sees the raw node
  // list, so no surface can answer "may I count this row?" differently from any other.
  const population = metricPopulation(graph);
  /*
   * THE CAPTURE HORIZON, and the refusal that stops it lying.
   *
   * Defaulting to `windows.cutoff` keeps a caller that declares nothing byte-identical to what it
   * got before `capturedThrough` existed. That default is also exactly the mistake that produced
   * an all-zero first live run, so it may not be allowed to fail QUIETLY a second time.
   *
   * THE REFUSAL: if this graph carries metric-bearing evidence at all, and EVERY piece of it was
   * captured after the horizon, then no cell, no cohort and no stock count can be anything but
   * zero — and a zero produced this way is indistinguishable, in the published report, from an
   * account that genuinely did nothing. That is a configuration error about the two clocks, so it
   * throws in the same voice as a broken contract rather than returning a number.
   *
   * It cannot fire on a genuinely quiet account: an account with no metric-bearing evidence has
   * nothing to drop, and a single row inside the horizon is enough to make the run answerable.
   */
  const captureHorizon = windows.capturedThrough ?? windows.cutoff;
  const horizon = instant(captureHorizon);
  // `population.all`, not the raw node list: "which rows does a metric even SEE" is decided in
  // exactly one place, and this refusal is no more entitled to re-answer it than any other surface.
  const candidates = population.all.filter(isMetricCandidate);
  if (
    candidates.length > 0
    && candidates.every((node) => {
      const captured = placeable(node.capturedAt ?? node.eventTime);
      return captured !== null && Temporal.Instant.compare(captured, horizon) > 0;
    })
  ) throw codedError('METRICS_CAPTURE_HORIZON_PRECEDES_EVIDENCE', TypeError);
  const metrics = {};
  const cohorts = {};
  for (const [name, window, edges] of namedWindows) {
    metrics[name] = {};
    for (const contract of edges) {
      metrics[name][contract.edgeId] = computeEdge(
        population,
        contract,
        window,
        windows.cutoff,
        windows.matureAsOf,
        metricContracts.coverageFloor,
        captureHorizon,
      );
    }
    // The entry cohort printed beside a window's rates must describe THAT window's rates, so it is
    // derived from the edges reporting in it and not from every edge in the contract. A window
    // reporting only the settled outcome edge would otherwise advertise a cohort built from root
    // stages no cell in it consumes.
    cohorts[name] = cohortCounts(
      population,
      edges,
      window,
      captureHorizon,
    );
  }
  return deepFreeze({
    metrics,
    cohorts,
    currentStock: stockFor(
      population,
      windows.currentClosedWeek.end,
      captureHorizon,
    ),
  });
}
