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
  const matureAsOf = currentEnd.subtract({ days: maturityDays });
  return deepFreeze({
    timezone,
    cutoff: localCutoff.toString(),
    currentClosedWeek: windowOf(currentStart, currentEnd),
    previousClosedWeek: windowOf(previousStart, currentStart),
    trailing28Days: windowOf(trailingStart, currentEnd),
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

function unknownMetric(window, threshold, reasonCode = 'MISSING_REQUIRED_EVIDENCE') {
  return {
    ...UNKNOWN,
    reasonCode,
    eligible: null,
    threshold,
    rankEligible: false,
    window,
    coverage: 'INCOMPLETE',
  };
}

function journeyHasUncertainty(graph, journeyInstanceId, nodes) {
  const metricEvidenceNodes = nodes.filter(({ type }) => (
    ['journey_event', 'portal_milestone'].includes(type)
  ));
  if (metricEvidenceNodes.some((node) => (
    node.journeyInstanceId === journeyInstanceId
      && (!isObserved(node) || node.classification !== 'OBSERVED')
  ))) return true;
  const journeyNodes = nodes
    .filter(({ journeyInstanceId: value }) => value === journeyInstanceId)
    .map(({ nodeId }) => nodeId);
  const nodeIds = new Set(journeyNodes);
  for (const edge of graph.edges) {
    if (nodeIds.has(edge.fromNodeId)) nodeIds.add(edge.toNodeId);
    if (nodeIds.has(edge.toNodeId)) nodeIds.add(edge.fromNodeId);
  }
  const evidenceRefs = new Set(nodes
    .filter(({ journeyInstanceId: value }) => value === journeyInstanceId)
    .flatMap((node) => node.evidenceRefs ?? []));
  const relevant = (item) => (
    item.journeyInstanceId === journeyInstanceId
      || item.recordNodeId && nodeIds.has(item.recordNodeId)
      || Array.isArray(item.nodeIds) && item.nodeIds.some((id) => nodeIds.has(id))
      || Array.isArray(item.evidenceRefs)
        && item.evidenceRefs.some((ref) => evidenceRefs.has(ref))
  );
  if (graph.unresolvedJoins.some(relevant)) return true;
  if (graph.conflicts.some(relevant)) return true;
  return graph.edges.some(({ type, fromNodeId, toNodeId }) => (
    type === 'inferred_match'
      && (nodeIds.has(fromNodeId) || nodeIds.has(toNodeId))
  ));
}

function hasProvingJoin(graph, nodeId) {
  return graph.edges.some(({ type, toNodeId, joinMethod, joinConfidence }) => (
    type === 'identity_exact'
      && toNodeId === nodeId
      && ['native_id', 'deterministic_composite'].includes(joinMethod)
      && joinConfidence === 'exact'
  ));
}

function computeEdge(graph, nodes, contract, window, analysisCutoff, matureAsOf) {
  const configuredThreshold = contract.eligibilityRule?.minimumSample;
  const threshold = Number.isInteger(configuredThreshold) && configuredThreshold >= 0
    ? configuredThreshold
    : 0;
  if (
    contract.nativeMapping !== 'MAPPED'
    || journeyHasUncertainty(graph, contract.journeyInstanceId, nodes)
  ) return unknownMetric(window, threshold);

  const events = nodes
    .filter((node) => (
      node.journeyInstanceId === contract.journeyInstanceId
        && node.journeyId === contract.journeyId
        && isObserved(node)
        && Temporal.Instant.compare(
          instant(node.capturedAt ?? node.eventTime),
          instant(analysisCutoff),
        ) <= 0
    ))
    .sort(sortEvents);
  if (events.some(({ nodeId }) => !hasProvingJoin(graph, nodeId))) {
    return unknownMetric(window, threshold);
  }
  if (
    contract.reentryRule === 'new_journey_instance'
    && events.some((node) => (
      [contract.fromStage, contract.toStage].includes(stageOf(node))
        && typeof node.cohortInstanceRef !== 'string'
    ))
  ) return unknownMetric(window, threshold, 'MISSING_COHORT_INSTANCE');
  const fromByKey = new Map();
  for (const node of events) {
    if (stageOf(node) !== contract.fromStage || !inside(node.eventTime, window)) continue;
    const key = eventKey(node, contract.reentryRule);
    if (!fromByKey.has(key)) fromByKey.set(key, node);
  }
  const mature = [];
  for (const [key, node] of fromByKey) {
    const maturity = addLag(node.eventTime, contract.allowedLag, window);
    if (
      Temporal.Instant.compare(instant(node.eventTime), instant(matureAsOf)) < 0
      && Temporal.Instant.compare(maturity, instant(analysisCutoff)) <= 0
    ) mature.push([key, node]);
  }
  if (fromByKey.size > 0 && mature.length === 0) {
    const globallyImmature = [...fromByKey.values()].every((node) => (
      Temporal.Instant.compare(instant(node.eventTime), instant(matureAsOf)) >= 0
    ));
    return unknownMetric(
      window,
      threshold,
      globallyImmature ? 'IMMATURE_COHORT' : 'MISSING_REQUIRED_EVIDENCE',
    );
  }

  let numerator = 0;
  let value = 0;
  for (const [key, from] of mature) {
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
      numerator += 1;
      if (Number.isFinite(to.revenueAmount)) value += to.revenueAmount;
    }
  }
  const denominator = mature.length;
  const result = {
    state: 'OBSERVED',
    numerator,
    denominator,
    rate: denominator === 0 ? null : numerator / denominator,
    eligible: denominator,
    threshold,
    rankEligible: denominator >= threshold,
    window,
    coverage: 'COMPLETE',
    reasonCode: denominator === 0 ? 'NO_ELIGIBLE_POPULATION' : null,
  };
  if (contract.toStage === 'collected_revenue' || value !== 0) result.value = value;
  return result;
}

function stockFor(nodes, end, analysisCutoff) {
  const latest = new Map();
  for (const node of nodes.filter((candidate) => (
    isObserved(candidate)
      && ['journey_event', 'portal_milestone'].includes(candidate.type)
  )).sort(sortEvents)) {
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

function cohortCounts(nodes, contracts, window, analysisCutoff) {
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
  for (const node of nodes.filter(isObserved).filter(({ eventTime, capturedAt }) => (
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
  const namedWindows = {
    currentClosedWeek: windows.currentClosedWeek,
    previousClosedWeek: windows.previousClosedWeek,
    trailing28Days: windows.trailing28Days,
  };
  const metrics = {};
  const cohorts = {};
  for (const [name, window] of Object.entries(namedWindows)) {
    metrics[name] = {};
    for (const contract of metricContracts.edges) {
      metrics[name][contract.edgeId] = computeEdge(
        graph,
        graph.nodes,
        contract,
        window,
        windows.cutoff,
        windows.matureAsOf,
      );
    }
    cohorts[name] = cohortCounts(
      graph.nodes,
      metricContracts.edges,
      window,
      windows.cutoff,
    );
  }
  return deepFreeze({
    metrics,
    cohorts,
    currentStock: stockFor(
      graph.nodes,
      windows.currentClosedWeek.end,
      windows.cutoff,
    ),
  });
}
