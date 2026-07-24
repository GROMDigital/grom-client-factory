import { canonicalJson, sha256 } from './canonical.mjs';

const FAMILIES = Object.freeze([
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
const CONFIDENCE = new Set(['C0', 'C1', 'C2', 'C3']);
const FALSIFICATION_STATES = new Set([
  'RULED_OUT', 'SUPPORTED', 'INCONCLUSIVE', 'NOT_APPLICABLE',
]);
const CRITICAL_CLASSES = new Set([
  'PRIVACY_OR_COMPLIANCE_EXPOSURE',
  'MATERIAL_DELIVERABILITY_FAILURE',
  'MASS_MISDELIVERY_OR_MISROUTING',
  'ACTIVE_REVENUE_LOSS_AUTOMATION',
  'BROKEN_PAYMENT_OR_APPOINTMENT_PATH',
  'DESTRUCTIVE_CONFIGURATION_RISK',
  'ACCOUNT_WIDE_OUTAGE_OR_ACCESS_FAILURE',
]);
const VERDICTS = new Set(['SUPPORTS', 'CHALLENGES', 'INCONCLUSIVE']);
const UNCERTAINTY = new Set(['LOW', 'MEDIUM', 'HIGH']);
const SAFETY_FLAGS = new Set([
  'PROMPT_INJECTION_IGNORED',
  'UNTRUSTED_EVIDENCE_INSTRUCTION',
  'PII_WITHHELD',
  'EVIDENCE_CONFLICT',
  'SUPPLEMENTAL_READ_REQUIRED',
]);
const HASH = /^[a-f0-9]{64}$/u;
const OPAQUE = /^[a-z][a-z0-9]*_[A-Za-z0-9][A-Za-z0-9_.:-]{2,127}$/u;
const EVIDENCE = /^ev_[A-Za-z0-9][A-Za-z0-9_.:-]{2,127}$/u;
const REQUEST_KEYS = Object.freeze([
  'schemaVersion', 'requestId', 'requestHash', 'nonceRef', 'runId', 'cutoff',
  'reviewDeadline', 'codeHash', 'packets', 'packetSetHash', 'evidenceSetHash',
  'rubric', 'promptId', 'promptHash', 'modelPolicy', 'modelPolicyHash',
]);
const RESPONSE_KEYS = Object.freeze([
  'schemaVersion', 'requestId', 'requestHash', 'nonceRef', 'runId', 'codeHash',
  'packetSetHash', 'packetHashes', 'rubricHash', 'promptHash', 'modelPolicyHash',
  'evidenceSetHash', 'reviewedAt', 'reviewer', 'usage', 'reviews',
]);
const REVIEW_KEYS = Object.freeze([
  'packetId', 'verdict', 'reasoningCodes', 'supportingEvidenceRefs',
  'counterEvidenceRefs', 'competingExplanationCodes', 'uncertainty',
  'safetyFlags', 'supplementalReadDescriptorIds',
]);
const REQUEST_STATES = new Map();
const NONCE_STATES = new Map();
const VALIDATED_REVIEWS = new Map();

function codedError(code, ErrorType = Error) {
  return Object.assign(new ErrorType(code), { code });
}

function plain(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function exactKeys(value, keys) {
  return plain(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

function iso(value) {
  return typeof value === 'string'
    && Number.isFinite(Date.parse(value))
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value);
}

function deepFreeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function assertDeepFrozen(value, code = 'MECHANISM_INPUT_INVALID', seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  if (!Object.isFrozen(value)) throw codedError(code, TypeError);
  seen.add(value);
  for (const child of Object.values(value)) assertDeepFrozen(child, code, seen);
}

function strings(values, pattern = OPAQUE) {
  if (!Array.isArray(values) || !values.every((value) => (
    typeof value === 'string' && pattern.test(value)
  ))) throw codedError('MECHANISM_INPUT_INVALID', TypeError);
  return [...new Set(values)].sort();
}

function stable(prefix, value) {
  return `${prefix}_${sha256(value).slice(0, 32)}`;
}

function safeCode(value) {
  return typeof value === 'string'
    && /^[A-Z][A-Z0-9_]{1,127}$/u.test(value);
}

function safeDescriptorText(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 4096) return false;
  return !/(?:https?:\/\/|\b(?:GET|POST|PUT|PATCH|DELETE)\b|authorization|credential|password|secret|cookie|confirm\s*:|raw[_ -]?request|request body|tool (?:call|instruction)|execute\b)/iu
    .test(value);
}

function sortedUniqueCodes(values) {
  if (!Array.isArray(values) || !values.every(safeCode)) {
    throw codedError('MECHANISM_PACKET_INVALID', TypeError);
  }
  return [...new Set(values)].sort();
}

function coverageContract(coverage) {
  if (
    !exactKeys(coverage, [
      'state', 'comparableSubsets', 'capabilityStates', 'limits', 'edgeScopes',
    ])
    || !['complete_full', 'complete_partial'].includes(coverage.state)
    || !Array.isArray(coverage.comparableSubsets)
    || !Array.isArray(coverage.capabilityStates)
    || !Array.isArray(coverage.limits)
    || !coverage.limits.every((limit) => typeof limit === 'string')
    || !Array.isArray(coverage.edgeScopes)
  ) throw codedError('MECHANISM_INPUT_INVALID', TypeError);
  for (const subset of coverage.comparableSubsets) {
    if (
      !exactKeys(subset, ['subsetId', 'journeyInstanceIds', 'metricIds'])
      || !OPAQUE.test(subset.subsetId)
    ) throw codedError('MECHANISM_INPUT_INVALID', TypeError);
    strings(subset.journeyInstanceIds);
    if (!Array.isArray(subset.metricIds) || !subset.metricIds.every((id) => (
      typeof id === 'string' && id.length > 0
    ))) throw codedError('MECHANISM_INPUT_INVALID', TypeError);
  }
  for (const capability of coverage.capabilityStates) {
    if (
      !exactKeys(capability, ['capabilityId', 'state'])
      || typeof capability.capabilityId !== 'string'
      || !['COMPLETE', 'PARTIAL', 'MISSING', 'NOT_APPLICABLE'].includes(capability.state)
    ) throw codedError('MECHANISM_INPUT_INVALID', TypeError);
  }
  const inconsistent = coverage.state === 'complete_full'
    && coverage.capabilityStates.some(({ state }) => ['PARTIAL', 'MISSING'].includes(state));
  return {
    effectiveState: inconsistent ? 'complete_partial' : coverage.state,
    inconsistent,
  };
}

function canonicalFalsification(values, overallCoverage) {
  if (!Array.isArray(values)) throw codedError('MECHANISM_INPUT_INVALID', TypeError);
  const byFamily = new Map();
  for (const value of values) {
    if (
      !exactKeys(value, ['family', 'state', 'evidenceRefs', 'reasonCode'])
      || !FAMILIES.includes(value.family)
      || !FALSIFICATION_STATES.has(value.state)
      || !safeCode(value.reasonCode)
      || byFamily.has(value.family)
    ) throw codedError('MECHANISM_INPUT_INVALID', TypeError);
    const evidenceRefs = strings(value.evidenceRefs, EVIDENCE);
    if (
      ['RULED_OUT', 'SUPPORTED'].includes(value.state) && evidenceRefs.length === 0
      || value.state === 'NOT_APPLICABLE' && value.reasonCode === 'CAPABILITY_INCOMPLETE'
    ) throw codedError('MECHANISM_INPUT_INVALID');
    byFamily.set(value.family, { ...value, evidenceRefs });
  }
  return FAMILIES.map((family) => byFamily.get(family) ?? {
    family,
    state: 'INCONCLUSIVE',
    evidenceRefs: [],
    reasonCode: overallCoverage === 'complete_partial'
      ? 'CAPABILITY_INCOMPLETE'
      : 'DETERMINISTIC_TEST_MISSING',
  });
}

function validateScope(scope, coverage) {
  const keys = [
    'metricId', 'journeyId', 'journeyInstanceId', 'symptomCode',
    'localizedEdgeIds', 'comparatorIds', 'mechanismClass', 'affectedObjectRefs',
    'predictionCode', 'supportingEvidenceRefs', 'counterEvidenceRefs',
    'competingExplanations', 'falsificationResults', 'discriminatingTest',
    'repeatSegmentIds', 'critical', 'criticalClass', 'severityBand',
    'commercialValue', 'recoverabilityBand', 'recurrenceBand', 'timeToValueBand',
    'reversibilityBand', 'effortBand', 'dependencyBurden', 'operationalRiskBand',
    'supplementalReadAllowlist', 'sealedPath',
  ];
  if (
    !exactKeys(scope, keys)
    || typeof scope.metricId !== 'string'
    || !/^[a-z][a-z0-9_.:-]{1,127}$/u.test(scope.metricId)
    || !OPAQUE.test(scope.journeyId)
    || !OPAQUE.test(scope.journeyInstanceId)
    || !safeCode(scope.symptomCode)
    || !safeCode(scope.predictionCode)
    || !safeCode(scope.mechanismClass.toUpperCase())
    || typeof scope.critical !== 'boolean'
    || scope.critical && !CRITICAL_CLASSES.has(scope.criticalClass)
    || !scope.critical && scope.criticalClass !== null
    || !['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'UNKNOWN'].includes(scope.severityBand)
    || !plain(scope.commercialValue)
    || !exactKeys(scope.commercialValue, ['kind', 'lower', 'upper'])
    || !['MEASURED', 'BOUNDED', 'UNKNOWN'].includes(scope.commercialValue.kind)
    || !Array.isArray(scope.competingExplanations)
    || !Array.isArray(scope.repeatSegmentIds)
    || !Array.isArray(scope.supplementalReadAllowlist)
    || !exactKeys(scope.sealedPath, ['pathRef', 'relativePath'])
    || !OPAQUE.test(scope.sealedPath.pathRef)
    || typeof scope.sealedPath.relativePath !== 'string'
    || scope.sealedPath.relativePath.startsWith('/')
    || scope.sealedPath.relativePath.includes('..')
  ) throw codedError('MECHANISM_INPUT_INVALID', TypeError);
  if (
    scope.commercialValue.kind === 'UNKNOWN'
      ? scope.commercialValue.lower !== null || scope.commercialValue.upper !== null
      : !Number.isFinite(scope.commercialValue.lower)
        || !Number.isFinite(scope.commercialValue.upper)
        || scope.commercialValue.lower < 0
        || scope.commercialValue.upper < scope.commercialValue.lower
  ) throw codedError('MECHANISM_INPUT_INVALID', TypeError);
  const bandKeys = [
    'recoverabilityBand', 'recurrenceBand', 'timeToValueBand', 'reversibilityBand',
    'effortBand', 'dependencyBurden', 'operationalRiskBand',
  ];
  if (!bandKeys.every((key) => safeCode(scope[key]))) {
    throw codedError('MECHANISM_INPUT_INVALID', TypeError);
  }
  for (const explanation of scope.competingExplanations) {
    if (
      !exactKeys(explanation, ['code', 'material', 'addressed'])
      || !safeCode(explanation.code)
      || typeof explanation.material !== 'boolean'
      || typeof explanation.addressed !== 'boolean'
    ) throw codedError('MECHANISM_INPUT_INVALID', TypeError);
  }
  for (const descriptor of scope.supplementalReadAllowlist) {
    if (
      !exactKeys(descriptor, ['descriptorId', 'capabilityId', 'objectRef'])
      || !OPAQUE.test(descriptor.descriptorId)
      || !/^[a-z][a-z0-9_.:-]{1,127}$/u.test(descriptor.capabilityId)
      || !OPAQUE.test(descriptor.objectRef)
    ) throw codedError('MECHANISM_INPUT_INVALID', TypeError);
  }
  if (
    new Set(scope.supplementalReadAllowlist.map(({ descriptorId }) => descriptorId)).size
      !== scope.supplementalReadAllowlist.length
    || new Set(scope.competingExplanations.map(({ code }) => code)).size
      !== scope.competingExplanations.length
    || new Set(scope.repeatSegmentIds).size !== scope.repeatSegmentIds.length
    || !scope.repeatSegmentIds.every((id) => OPAQUE.test(id))
  ) throw codedError('MECHANISM_INPUT_INVALID');
  if (
    !exactKeys(scope.discriminatingTest, [
      'testId', 'strongestAlternativeCode', 'expectedObservationCodes', 'decisionRuleCodes',
    ])
    || !OPAQUE.test(scope.discriminatingTest.testId)
    || !safeCode(scope.discriminatingTest.strongestAlternativeCode)
    || !Array.isArray(scope.discriminatingTest.expectedObservationCodes)
    || !Array.isArray(scope.discriminatingTest.decisionRuleCodes)
  ) throw codedError('MECHANISM_INPUT_INVALID', TypeError);
  canonicalFalsification(scope.falsificationResults, coverage.state);
}

function exactOperationalEdge(edge) {
  return plain(edge)
    && ['native_id', 'deterministic_composite', 'workflow_definition_hash']
      .includes(edge.joinMethod)
    && edge.joinConfidence === 'exact'
    && HASH.test(edge.workflowDefinitionHash ?? '')
    && Array.isArray(edge.evidenceRefs)
    && edge.evidenceRefs.length > 0;
}

function relevantGraphDoubt(graph, edges, scope) {
  const nodeIds = new Set(edges.flatMap(({ fromNodeId, toNodeId }) => [fromNodeId, toNodeId]));
  const evidenceRefs = new Set(edges.flatMap(({ evidenceRefs: refs }) => refs ?? []));
  const relevant = (item) => (
    item.journeyInstanceId === scope.journeyInstanceId
      || item.recordNodeId && nodeIds.has(item.recordNodeId)
      || Array.isArray(item.nodeIds) && item.nodeIds.some((id) => nodeIds.has(id))
      || Array.isArray(item.evidenceRefs)
        && item.evidenceRefs.some((ref) => evidenceRefs.has(ref))
  );
  return graph.conflicts.some(relevant) || graph.unresolvedJoins.some(relevant);
}

function chainProof(edges, supportingRefs) {
  const configured = edges.filter(({ type }) => type === 'configured_to_trigger');
  const enrolled = edges.filter(({ type }) => type === 'enrolled_in');
  const executed = edges.filter(({ type }) => type === 'execution_emitted');
  for (const configuration of configured) {
    for (const enrollment of enrolled) {
      if (configuration.toNodeId !== enrollment.fromNodeId) continue;
      for (const execution of executed) {
        if (
          enrollment.toNodeId !== execution.fromNodeId
          || ![configuration, enrollment, execution].every(exactOperationalEdge)
          || new Set([
            configuration.workflowDefinitionHash,
            enrollment.workflowDefinitionHash,
            execution.workflowDefinitionHash,
          ]).size !== 1
          || ![configuration, enrollment, execution].every((edge) => (
            edge.evidenceRefs.some((ref) => supportingRefs.has(ref))
          ))
        ) continue;
        return [configuration, enrollment, execution];
      }
    }
  }
  return [];
}

function repeatedSegmentProof(graph, edges, supportingRefs) {
  const segments = new Map();
  for (const edge of edges.filter(({ type }) => type === 'execution_emitted')) {
    if (!exactOperationalEdge(edge) || !edge.evidenceRefs.some((ref) => supportingRefs.has(ref))) {
      continue;
    }
    const node = graph.nodes.find(({ nodeId }) => nodeId === edge.toNodeId);
    if (
      node?.classification !== 'OBSERVED'
      || node.provenance?.completeness !== 'COMPLETE'
      || !edge.evidenceRefs.some((ref) => (
        supportingRefs.has(ref) && node.evidenceRefs?.includes(ref)
      ))
    ) continue;
    const rawSegmentId = node.cohortInstanceRef
      ?? node.opportunityNativeId
      ?? node.projectNativeId
      ?? node.subjectNativeId;
    if (typeof rawSegmentId !== 'string' || rawSegmentId.length === 0) continue;
    const segmentId = stable('segment', {
      journeyInstanceId: node.journeyInstanceId,
      rawSegmentId,
    });
    const current = segments.get(segmentId) ?? [];
    current.push(edge);
    segments.set(segmentId, current);
  }
  return [...segments].sort(([left], [right]) => left.localeCompare(right));
}

function confidenceProof({
  metric,
  scope,
  graph,
  falsificationResults,
  supportingEvidenceRefs,
  coverageConsistent,
}) {
  const associationObserved = metric.state === 'OBSERVED'
    && Number.isFinite(metric.denominator)
    && metric.denominator > 0
    && supportingEvidenceRefs.length > 0;
  const localized = new Set(scope.localizedEdgeIds);
  const edges = graph.edges.filter(({ edgeId }) => localized.has(edgeId));
  const supportingRefs = new Set(supportingEvidenceRefs);
  const directChain = chainProof(edges, supportingRefs);
  const repeatedSegments = repeatedSegmentProof(graph, edges, supportingRefs);
  const graphConflictFree = !relevantGraphDoubt(graph, edges, scope);
  const predictedFailureObserved = associationObserved
    && Number.isFinite(metric.numerator)
    && metric.numerator < metric.denominator
    && edges.filter(({ type }) => type === 'execution_emitted').some((edge) => (
      edge.evidenceRefs.some((ref) => supportingRefs.has(ref))
    ));
  const supportingEvidenceBound = directChain.length === 3
    || repeatedSegments.length >= 2;
  const basis = {
    version: 'mechanism-confidence-v1',
    associationObserved,
    directChainEdgeIds: directChain.map(({ edgeId }) => edgeId).sort(),
    repeatedSegmentIds: repeatedSegments.map(([segmentId]) => segmentId).sort(),
    proofEvidenceRefs: [...new Set([
      ...directChain,
      ...repeatedSegments.flatMap(([, segmentEdges]) => segmentEdges),
    ].flatMap(({ evidenceRefs: refs }) => refs)
      .filter((ref) => supportingRefs.has(ref)))].sort(),
    predictedFailureObserved,
    supportingEvidenceBound,
    graphConflictFree,
    coverageConsistent,
  };
  return {
    basis,
    confidence: confidenceFromFacts({
      basis,
      falsificationResults,
      competingExplanations: scope.competingExplanations,
    }),
  };
}

function confidenceFromFacts({ basis, falsificationResults, competingExplanations }) {
  if (!basis.associationObserved) return 'C0';
  const unresolvedAlternative = competingExplanations.some(({ material, addressed }) => (
    material && !addressed
  )) || falsificationResults.some(({ state }) => state === 'INCONCLUSIVE');
  if (
    unresolvedAlternative
    || !basis.graphConflictFree
    || !basis.coverageConsistent
  ) return 'C1';
  if (
    basis.directChainEdgeIds.length === 3
    && basis.predictedFailureObserved
    && basis.supportingEvidenceBound
    && basis.proofEvidenceRefs.length > 0
  ) return 'C3';
  if (
    basis.repeatedSegmentIds.length >= 2
    && basis.predictedFailureObserved
    && basis.supportingEvidenceBound
    && basis.proofEvidenceRefs.length >= 2
  ) return 'C2';
  return 'C1';
}

function denominatorFor(graph, scope, metric) {
  const journey = graph.nodes.find((node) => (
    node.type === 'journey_instance'
      && node.journeyInstanceId === scope.journeyInstanceId
  ));
  return {
    kind: journey?.denominator ?? 'UNKNOWN',
    value: metric.denominator,
    numerator: metric.numerator,
    rate: metric.rate,
    metricState: metric.state,
    metricId: scope.metricId,
  };
}

function validComparators(graph, scope) {
  const requested = new Set(scope.comparatorIds);
  return graph.nodes.filter((node) => (
    node.journeyInstanceId === scope.journeyInstanceId
      && ['converted', 'completed', 'collected_revenue', 'campaign_launch_ready']
        .includes(node.stage ?? node.milestone)
      && node.classification === 'OBSERVED'
      && node.provenance?.completeness === 'COMPLETE'
  )).sort((left, right) => (
    Number(!requested.has(left.nodeId)) - Number(!requested.has(right.nodeId))
      || (Date.parse(right.eventTime ?? '') || 0) - (Date.parse(left.eventTime ?? '') || 0)
      || left.nodeId.localeCompare(right.nodeId)
  )).slice(0, 3).map(({ nodeId }) => nodeId).sort();
}

function eligibleEvidence(graph) {
  return new Set(graph.nodes.filter((node) => (
    node.classification === 'OBSERVED'
      && node.provenance?.completeness === 'COMPLETE'
  )).flatMap(({ evidenceRefs }) => evidenceRefs ?? []));
}

function coverageFor(coverage, scope, effectiveState) {
  if (effectiveState === 'complete_full') {
    return { state: 'complete_full', scope: 'account_wide', subsetId: null };
  }
  const subset = coverage.comparableSubsets.find((candidate) => (
    candidate.journeyInstanceIds.includes(scope.journeyInstanceId)
      && candidate.metricIds.includes(scope.metricId)
  ));
  return {
    state: 'complete_partial',
    scope: subset ? 'comparable_subset' : 'unranked_partial',
    subsetId: subset?.subsetId ?? null,
  };
}

function priorityFor({
  critical,
  promotionEligible,
  candidateCoverage,
  scope,
  metric,
  confidence,
  fingerprint,
  candidateId,
}) {
  const value = candidateCoverage.scope === 'account_wide'
    ? structuredClone(scope.commercialValue)
    : { kind: 'UNKNOWN', lower: null, upper: null };
  return {
    tupleVersion: 'mechanism-priority-v1',
    lane: critical ? 'CRITICAL_OVERRIDE' : 'COMMERCIAL',
    promotionEligibility: promotionEligible ? 'ELIGIBLE' : 'INELIGIBLE',
    coverageScope: candidateCoverage.scope,
    severityBand: scope.severityBand,
    mechanismConfidence: confidence,
    eligibleAffectedVolume: metric.eligible ?? null,
    excessObservedLoss: metric.denominator === null || metric.numerator === null
      ? null
      : Math.max(0, metric.denominator - metric.numerator),
    commercialValue: value,
    recoverabilityBand: scope.recoverabilityBand,
    recurrenceBand: scope.recurrenceBand,
    timeToValueBand: scope.timeToValueBand,
    reversibilityBand: scope.reversibilityBand,
    effortBand: scope.effortBand,
    dependencyBurden: scope.dependencyBurden,
    operationalRiskBand: scope.operationalRiskBand,
    rootMechanismFingerprint: fingerprint,
    candidateId,
  };
}

function limitationCodes({
  coverage, candidateCoverage, comparators, metric, confidence, scope,
}) {
  const codes = [];
  if (comparators.length === 0) codes.push('NO_VALID_COMPARATOR');
  if (coverage.state === 'complete_partial') codes.push('ACCOUNT_WIDE_RANKING_FORBIDDEN');
  if (candidateCoverage.scope === 'unranked_partial') codes.push('NO_COMPLETE_COMPARABLE_SUBSET');
  if (coverage.capabilityStates.some(({ state }) => state === 'MISSING')) {
    codes.push('CAPABILITY_MISSING');
  }
  if (metric.state === 'UNKNOWN') codes.push('METRIC_UNKNOWN');
  if (!metric.rankEligible) codes.push('RATE_THRESHOLD_NOT_MET');
  if (confidence === 'C1') codes.push('CAUSAL_PROOF_INCOMPLETE');
  if (confidence === 'C0') codes.push('REQUIRED_EVIDENCE_MISSING');
  if (scope.competingExplanations.some(({ material, addressed }) => material && !addressed)) {
    codes.push('MATERIAL_ALTERNATIVE_UNRESOLVED');
  }
  return [...new Set(codes)].sort();
}

const descendingBand = Object.freeze({
  CRITICAL: 0,
  HIGH: 1,
  MEDIUM: 2,
  LOW: 3,
  UNKNOWN: 4,
  C3: 0,
  C2: 1,
  C1: 2,
  C0: 3,
  ELIGIBLE: 0,
  INELIGIBLE: 1,
  account_wide: 0,
  comparable_subset: 1,
  unranked_partial: 2,
});

function numericDescending(left, right) {
  const l = left === null || left === undefined ? Number.NEGATIVE_INFINITY : left;
  const r = right === null || right === undefined ? Number.NEGATIVE_INFINITY : right;
  return r - l;
}

function compareCandidates(left, right) {
  const a = left.priorityInputs;
  const b = right.priorityInputs;
  return Number(!left.critical) - Number(!right.critical)
    || (descendingBand[a.promotionEligibility] ?? 99) - (descendingBand[b.promotionEligibility] ?? 99)
    || (descendingBand[a.coverageScope] ?? 99) - (descendingBand[b.coverageScope] ?? 99)
    || (descendingBand[a.severityBand] ?? 99) - (descendingBand[b.severityBand] ?? 99)
    || (descendingBand[a.mechanismConfidence] ?? 99)
      - (descendingBand[b.mechanismConfidence] ?? 99)
    || numericDescending(a.eligibleAffectedVolume, b.eligibleAffectedVolume)
    || numericDescending(a.excessObservedLoss, b.excessObservedLoss)
    || numericDescending(a.commercialValue.upper, b.commercialValue.upper)
    || a.recoverabilityBand.localeCompare(b.recoverabilityBand)
    || a.recurrenceBand.localeCompare(b.recurrenceBand)
    || a.timeToValueBand.localeCompare(b.timeToValueBand)
    || a.reversibilityBand.localeCompare(b.reversibilityBand)
    || a.effortBand.localeCompare(b.effortBand)
    || a.dependencyBurden.localeCompare(b.dependencyBurden)
    || a.operationalRiskBand.localeCompare(b.operationalRiskBand)
    || left.candidateMechanism.rootMechanismFingerprint.localeCompare(
      right.candidateMechanism.rootMechanismFingerprint,
    )
    || left.candidateId.localeCompare(right.candidateId);
}

export function nominateMechanisms({
  graph,
  metrics,
  coverage,
  maxCandidates = 5,
}) {
  if (
    !plain(graph)
    || !Array.isArray(graph.nodes)
    || !Array.isArray(graph.edges)
    || !Array.isArray(graph.conflicts)
    || !Array.isArray(graph.unresolvedJoins)
    || !plain(metrics)
    || !plain(metrics.metrics)
    || !plain(metrics.metrics.currentClosedWeek)
    || !Number.isInteger(maxCandidates)
    || maxCandidates < 0
    || maxCandidates > 5
  ) throw codedError('MECHANISM_INPUT_INVALID', TypeError);
  assertDeepFrozen(graph);
  assertDeepFrozen(metrics);
  assertDeepFrozen(coverage);
  const coverageState = coverageContract(coverage);

  const candidates = [];
  const seenMetricIds = new Set();
  for (const scope of [...coverage.edgeScopes].sort((left, right) => (
    left.metricId.localeCompare(right.metricId)
      || left.journeyInstanceId.localeCompare(right.journeyInstanceId)
  ))) {
    validateScope(scope, coverage);
    if (seenMetricIds.has(scope.metricId)) throw codedError('MECHANISM_INPUT_INVALID');
    seenMetricIds.add(scope.metricId);
    const metric = metrics.metrics.currentClosedWeek[scope.metricId];
    if (
      !plain(metric)
      || !['OBSERVED', 'UNKNOWN', 'NOT_APPLICABLE'].includes(metric.state)
      || typeof metric.rankEligible !== 'boolean'
    ) throw codedError('MECHANISM_INPUT_INVALID', TypeError);
    const eligibleEvidenceRefs = eligibleEvidence(graph);
    let rejectedEvidence = false;
    const falsificationResults = canonicalFalsification(
      scope.falsificationResults,
      coverageState.effectiveState,
    ).map((result) => {
      const evidenceRefs = result.evidenceRefs.filter((ref) => eligibleEvidenceRefs.has(ref));
      if (evidenceRefs.length === result.evidenceRefs.length) return result;
      rejectedEvidence = true;
      return {
        family: result.family,
        state: 'INCONCLUSIVE',
        evidenceRefs,
        reasonCode: 'EVIDENCE_INELIGIBLE',
      };
    });
    const declaredSupporting = strings(scope.supportingEvidenceRefs, EVIDENCE);
    const supportingEvidenceRefs = declaredSupporting.filter((ref) => (
      eligibleEvidenceRefs.has(ref)
    ));
    const declaredCounter = strings(scope.counterEvidenceRefs, EVIDENCE);
    const counterEvidenceRefs = declaredCounter.filter((ref) => eligibleEvidenceRefs.has(ref));
    rejectedEvidence ||= supportingEvidenceRefs.length !== declaredSupporting.length
      || counterEvidenceRefs.length !== declaredCounter.length;
    const confidence = confidenceProof({
      metric,
      scope,
      graph,
      falsificationResults,
      supportingEvidenceRefs,
      coverageConsistent: !coverageState.inconsistent,
    });
    const mechanismConfidence = confidence.confidence;
    const candidateCoverage = coverageFor(
      coverage,
      scope,
      coverageState.effectiveState,
    );
    const comparators = validComparators(graph, scope);
    const affectedObjectRefs = strings(scope.affectedObjectRefs);
    const targetRef = graph.nodes.find((node) => (
      node.type === 'journey_instance'
        && node.journeyInstanceId === scope.journeyInstanceId
    ))?.nodeId ?? `target_${sha256(scope.journeyInstanceId).slice(0, 16)}`;
    const rootMechanismFingerprint = stable('root', {
      targetRef,
      journeyId: scope.journeyId,
      journeyInstanceId: scope.journeyInstanceId,
      mechanismClass: scope.mechanismClass,
      affectedObjectRefs,
    });
    const critical = scope.critical
      && metric.state === 'OBSERVED'
      && supportingEvidenceRefs.length > 0;
    const reviewEligible = mechanismConfidence !== 'C0'
      && candidateCoverage.scope !== 'unranked_partial';
    const promotionEligible = !critical
      && reviewEligible
      && metric.rankEligible
      && ['C2', 'C3'].includes(mechanismConfidence)
      && !falsificationResults.some(({ state }) => state === 'INCONCLUSIVE')
      && !scope.competingExplanations.some(({ material, addressed }) => (
        material && !addressed
      ));
    const identity = {
      target: targetRef,
      journeyId: scope.journeyId,
      journeyInstanceId: scope.journeyInstanceId,
      metricId: scope.metricId,
      mechanismClass: scope.mechanismClass,
      affectedObjectRefs,
    };
    const candidateId = stable('candidate', identity);
    const priorityInputs = priorityFor({
      critical,
      promotionEligible,
      candidateCoverage,
      scope,
      metric,
      confidence: mechanismConfidence,
      fingerprint: rootMechanismFingerprint,
      candidateId,
    });
    const limitation = limitationCodes({
      coverage,
      candidateCoverage,
      comparators,
      metric,
      confidence: mechanismConfidence,
      scope,
    });
    if (rejectedEvidence) limitation.push('EVIDENCE_INELIGIBLE');
    if (coverageState.inconsistent) limitation.push('COVERAGE_STATE_INCONSISTENT');
    const candidateMechanism = {
      mechanismClass: scope.mechanismClass,
      affectedObjectRefs,
      rootMechanismFingerprint,
    };
    candidates.push({
      candidateId,
      symptom: {
        code: scope.symptomCode,
        metricId: scope.metricId,
        state: metric.state,
      },
      denominator: denominatorFor(graph, scope, metric),
      journeyInstanceIds: [scope.journeyInstanceId],
      localizedEdgeIds: strings(scope.localizedEdgeIds),
      comparatorIds: comparators,
      candidateMechanism,
      prediction: { code: scope.predictionCode },
      supportingEvidenceRefs,
      counterEvidenceRefs,
      competingExplanations: [...scope.competingExplanations]
        .map((item) => ({ ...item }))
        .sort((left, right) => left.code.localeCompare(right.code)),
      falsificationResults,
      discriminatingTest: {
        testId: scope.discriminatingTest.testId,
        strongestAlternativeCode: scope.discriminatingTest.strongestAlternativeCode,
        expectedObservationCodes: sortedUniqueCodes(
          scope.discriminatingTest.expectedObservationCodes,
        ),
        decisionRuleCodes: sortedUniqueCodes(scope.discriminatingTest.decisionRuleCodes),
      },
      coverage: candidateCoverage,
      mechanismConfidence,
      confidenceBasis: confidence.basis,
      eligibility: {
        rankEligible: metric.rankEligible,
        threshold: metric.threshold ?? null,
        eligibleAffectedVolume: metric.eligible ?? null,
      },
      critical,
      criticalClass: critical ? scope.criticalClass : null,
      priorityInputs,
      reviewEligible,
      promotionEligible,
      limitationCodes: [...new Set(limitation)].sort(),
      supplementalReadAllowlist: [...scope.supplementalReadAllowlist]
        .map((item) => ({ ...item }))
        .sort((left, right) => left.descriptorId.localeCompare(right.descriptorId)),
      sealedPath: { ...scope.sealedPath },
    });
  }
  return deepFreeze(candidates.sort(compareCandidates).slice(0, maxCandidates));
}

function packetBody(candidate) {
  const keys = [
    'candidateId', 'symptom', 'denominator', 'journeyInstanceIds',
    'localizedEdgeIds', 'comparatorIds', 'candidateMechanism', 'prediction',
    'supportingEvidenceRefs', 'counterEvidenceRefs', 'competingExplanations',
    'falsificationResults', 'discriminatingTest', 'coverage',
    'mechanismConfidence', 'confidenceBasis', 'eligibility', 'critical',
    'criticalClass', 'priorityInputs',
    'reviewEligible', 'promotionEligible', 'limitationCodes',
    'supplementalReadAllowlist', 'sealedPath',
  ];
  if (!exactKeys(candidate, keys) || !CONFIDENCE.has(candidate.mechanismConfidence)) {
    throw codedError('MECHANISM_PACKET_INVALID', TypeError);
  }
  const basisKeys = [
    'version', 'associationObserved', 'directChainEdgeIds', 'repeatedSegmentIds',
    'proofEvidenceRefs', 'predictedFailureObserved', 'supportingEvidenceBound',
    'graphConflictFree', 'coverageConsistent',
  ];
  if (
    !exactKeys(candidate.confidenceBasis, basisKeys)
    || candidate.confidenceBasis.version !== 'mechanism-confidence-v1'
    || ![
      'associationObserved', 'predictedFailureObserved', 'supportingEvidenceBound',
      'graphConflictFree', 'coverageConsistent',
    ].every((key) => typeof candidate.confidenceBasis[key] === 'boolean')
    || !exactKeys(candidate.eligibility, [
      'rankEligible', 'threshold', 'eligibleAffectedVolume',
    ])
    || typeof candidate.eligibility.rankEligible !== 'boolean'
    || candidate.eligibility.threshold !== null
      && (!Number.isInteger(candidate.eligibility.threshold)
        || candidate.eligibility.threshold < 0)
    || candidate.eligibility.eligibleAffectedVolume !== null
      && (!Number.isFinite(candidate.eligibility.eligibleAffectedVolume)
        || candidate.eligibility.eligibleAffectedVolume < 0)
    || !exactKeys(candidate.coverage, ['state', 'scope', 'subsetId'])
    || !['complete_full', 'complete_partial'].includes(candidate.coverage.state)
    || !['account_wide', 'comparable_subset', 'unranked_partial']
      .includes(candidate.coverage.scope)
    || typeof candidate.reviewEligible !== 'boolean'
    || typeof candidate.promotionEligible !== 'boolean'
  ) throw codedError('MECHANISM_PACKET_INVALID', TypeError);
  for (const key of [
    'directChainEdgeIds', 'repeatedSegmentIds', 'proofEvidenceRefs',
  ]) {
    const canonical = strings(
      candidate.confidenceBasis[key],
      key === 'proofEvidenceRefs' ? EVIDENCE : OPAQUE,
    );
    if (canonicalJson(canonical) !== canonicalJson(candidate.confidenceBasis[key])) {
      throw codedError('MECHANISM_PACKET_INVALID');
    }
  }
  if (
    !exactKeys(candidate.denominator, [
      'kind', 'value', 'numerator', 'rate', 'metricState', 'metricId',
    ])
    || typeof candidate.denominator.kind !== 'string'
    || typeof candidate.denominator.metricId !== 'string'
    || candidate.symptom?.metricId !== candidate.denominator.metricId
    || candidate.symptom?.state !== candidate.denominator.metricState
    || !['OBSERVED', 'UNKNOWN', 'NOT_APPLICABLE'].includes(
      candidate.denominator.metricState,
    )
    || candidate.denominator.metricState === 'OBSERVED' && (
      !Number.isInteger(candidate.denominator.value)
        || candidate.denominator.value < 0
        || !Number.isInteger(candidate.denominator.numerator)
        || candidate.denominator.numerator < 0
        || candidate.denominator.numerator > candidate.denominator.value
        || candidate.denominator.rate !== (
          candidate.denominator.value === 0
            ? null
            : candidate.denominator.numerator / candidate.denominator.value
        )
    )
    || candidate.denominator.metricState !== 'OBSERVED' && (
      candidate.denominator.value !== null
        || candidate.denominator.numerator !== null
        || candidate.denominator.rate !== null
    )
  ) throw codedError('MECHANISM_PACKET_INVALID', TypeError);
  const expectedConfidence = confidenceFromFacts({
    basis: candidate.confidenceBasis,
    falsificationResults: candidate.falsificationResults,
    competingExplanations: candidate.competingExplanations,
  });
  const expectedReviewEligible = expectedConfidence !== 'C0'
    && candidate.coverage.scope !== 'unranked_partial';
  const expectedPromotionEligible = !candidate.critical
    && expectedReviewEligible
    && candidate.eligibility.rankEligible
    && ['C2', 'C3'].includes(expectedConfidence)
    && !candidate.falsificationResults.some(({ state }) => state === 'INCONCLUSIVE')
    && !candidate.competingExplanations.some(({ material, addressed }) => (
      material && !addressed
    ));
  if (
    candidate.mechanismConfidence !== expectedConfidence
    || candidate.reviewEligible !== expectedReviewEligible
    || candidate.promotionEligible !== expectedPromotionEligible
    || candidate.priorityInputs.mechanismConfidence !== expectedConfidence
    || candidate.priorityInputs.promotionEligibility !== (
      expectedPromotionEligible ? 'ELIGIBLE' : 'INELIGIBLE'
    )
    || candidate.priorityInputs.candidateId !== candidate.candidateId
    || candidate.priorityInputs.rootMechanismFingerprint
      !== candidate.candidateMechanism.rootMechanismFingerprint
    || candidate.priorityInputs.coverageScope !== candidate.coverage.scope
    || candidate.priorityInputs.eligibleAffectedVolume
      !== candidate.eligibility.eligibleAffectedVolume
    || candidate.eligibility.eligibleAffectedVolume !== (
      candidate.denominator.metricState === 'OBSERVED'
        ? candidate.denominator.value
        : null
    )
    || candidate.priorityInputs.excessObservedLoss !== (
      candidate.denominator.metricState === 'OBSERVED'
        ? Math.max(0, candidate.denominator.value - candidate.denominator.numerator)
        : null
    )
    || candidate.confidenceBasis.associationObserved !== (
      candidate.denominator.metricState === 'OBSERVED'
        && Number.isFinite(candidate.denominator.value)
        && candidate.denominator.value > 0
        && candidate.supportingEvidenceRefs.length > 0
    )
    || candidate.confidenceBasis.predictedFailureObserved && !(
      Number.isFinite(candidate.denominator.numerator)
        && Number.isFinite(candidate.denominator.value)
        && candidate.denominator.numerator < candidate.denominator.value
    )
    || candidate.confidenceBasis.supportingEvidenceBound !== (
      candidate.confidenceBasis.directChainEdgeIds.length === 3
        || candidate.confidenceBasis.repeatedSegmentIds.length >= 2
    )
    || candidate.confidenceBasis.proofEvidenceRefs.some((ref) => (
      !candidate.supportingEvidenceRefs.includes(ref)
    ))
    || candidate.coverage.scope === 'account_wide'
      && (!candidate.confidenceBasis.coverageConsistent
        || candidate.coverage.state !== 'complete_full')
    || candidate.coverage.scope !== 'account_wide'
      && candidate.priorityInputs.commercialValue.kind !== 'UNKNOWN'
  ) throw codedError('MECHANISM_PACKET_INVALID');
  const discriminatingText = canonicalJson(candidate.discriminatingTest);
  if (!safeDescriptorText(discriminatingText)) {
    throw codedError('MECHANISM_PACKET_INVALID');
  }
  const canonical = {
    candidateId: candidate.candidateId,
    packetId: stable('packet', { candidateId: candidate.candidateId }),
    symptom: structuredClone(candidate.symptom),
    denominator: structuredClone(candidate.denominator),
    journeyInstanceIds: strings(candidate.journeyInstanceIds),
    localizedEdgeIds: strings(candidate.localizedEdgeIds),
    comparatorIds: strings(candidate.comparatorIds),
    candidateMechanism: {
      mechanismClass: candidate.candidateMechanism.mechanismClass,
      affectedObjectRefs: strings(candidate.candidateMechanism.affectedObjectRefs),
      rootMechanismFingerprint: candidate.candidateMechanism.rootMechanismFingerprint,
    },
    prediction: structuredClone(candidate.prediction),
    supportingEvidenceRefs: strings(candidate.supportingEvidenceRefs, EVIDENCE),
    counterEvidenceRefs: strings(candidate.counterEvidenceRefs, EVIDENCE),
    competingExplanations: [...candidate.competingExplanations]
      .map((item) => structuredClone(item))
      .sort((left, right) => left.code.localeCompare(right.code)),
    falsificationResults: canonicalFalsification(
      candidate.falsificationResults,
      candidate.coverage.state,
    ),
    discriminatingTest: {
      ...structuredClone(candidate.discriminatingTest),
      expectedObservationCodes: sortedUniqueCodes(
        candidate.discriminatingTest.expectedObservationCodes,
      ),
      decisionRuleCodes: sortedUniqueCodes(candidate.discriminatingTest.decisionRuleCodes),
    },
    coverage: structuredClone(candidate.coverage),
    mechanismConfidence: candidate.mechanismConfidence,
    confidenceBasis: structuredClone(candidate.confidenceBasis),
    eligibility: structuredClone(candidate.eligibility),
    rootMechanismFingerprint: candidate.candidateMechanism.rootMechanismFingerprint,
    critical: candidate.critical,
    criticalClass: candidate.criticalClass,
    priorityInputs: structuredClone(candidate.priorityInputs),
    reviewEligible: candidate.reviewEligible,
    promotionEligible: candidate.promotionEligible,
    limitationCodes: sortedUniqueCodes(candidate.limitationCodes),
    supplementalReadAllowlist: [...candidate.supplementalReadAllowlist]
      .map((item) => structuredClone(item))
      .sort((left, right) => left.descriptorId.localeCompare(right.descriptorId)),
    sealedPath: structuredClone(candidate.sealedPath),
  };
  return canonical;
}

export function buildMechanismPacket(candidate) {
  try {
    assertDeepFrozen(candidate, 'MECHANISM_PACKET_INVALID');
    const body = packetBody(candidate);
    return deepFreeze({ ...body, packetHash: sha256(body) });
  } catch (error) {
    if (error?.code === 'MECHANISM_PACKET_INVALID') throw error;
    throw codedError('MECHANISM_PACKET_INVALID', TypeError);
  }
}

function validatePacket(packet) {
  assertDeepFrozen(packet, 'MECHANISM_PACKET_INVALID');
  const packetKeys = [
    'candidateId', 'packetId', 'symptom', 'denominator', 'journeyInstanceIds',
    'localizedEdgeIds', 'comparatorIds', 'candidateMechanism', 'prediction',
    'supportingEvidenceRefs', 'counterEvidenceRefs', 'competingExplanations',
    'falsificationResults', 'discriminatingTest', 'coverage',
    'mechanismConfidence', 'confidenceBasis', 'eligibility',
    'rootMechanismFingerprint', 'critical', 'criticalClass', 'priorityInputs',
    'reviewEligible', 'promotionEligible', 'limitationCodes',
    'supplementalReadAllowlist', 'sealedPath', 'packetHash',
  ];
  if (
    !exactKeys(packet, packetKeys)
    || !HASH.test(packet.packetHash ?? '')
    || packet.rootMechanismFingerprint
      !== packet.candidateMechanism?.rootMechanismFingerprint
  ) {
    throw codedError('MECHANISM_PACKET_INVALID', TypeError);
  }
  const { packetHash, ...body } = packet;
  if (sha256(body) !== packetHash) throw codedError('MECHANISM_PACKET_INVALID');
  const candidate = deepFreeze({
    candidateId: packet.candidateId,
    symptom: structuredClone(packet.symptom),
    denominator: structuredClone(packet.denominator),
    journeyInstanceIds: structuredClone(packet.journeyInstanceIds),
    localizedEdgeIds: structuredClone(packet.localizedEdgeIds),
    comparatorIds: structuredClone(packet.comparatorIds),
    candidateMechanism: structuredClone(packet.candidateMechanism),
    prediction: structuredClone(packet.prediction),
    supportingEvidenceRefs: structuredClone(packet.supportingEvidenceRefs),
    counterEvidenceRefs: structuredClone(packet.counterEvidenceRefs),
    competingExplanations: structuredClone(packet.competingExplanations),
    falsificationResults: structuredClone(packet.falsificationResults),
    discriminatingTest: structuredClone(packet.discriminatingTest),
    coverage: structuredClone(packet.coverage),
    mechanismConfidence: packet.mechanismConfidence,
    confidenceBasis: structuredClone(packet.confidenceBasis),
    eligibility: structuredClone(packet.eligibility),
    critical: packet.critical,
    criticalClass: packet.criticalClass,
    priorityInputs: structuredClone(packet.priorityInputs),
    reviewEligible: packet.reviewEligible,
    promotionEligible: packet.promotionEligible,
    limitationCodes: structuredClone(packet.limitationCodes),
    supplementalReadAllowlist: structuredClone(packet.supplementalReadAllowlist),
    sealedPath: structuredClone(packet.sealedPath),
  });
  let rebuilt;
  try {
    rebuilt = packetBody(candidate);
  } catch {
    throw codedError('MECHANISM_PACKET_INVALID');
  }
  if (canonicalJson(rebuilt) !== canonicalJson(body)) {
    throw codedError('MECHANISM_PACKET_INVALID');
  }
  return packet;
}

function sealedInput(value, idKeys, contentKey, pathRequired = false) {
  if (!plain(value) || !idKeys.every((key) => typeof value[key] === 'string')) {
    throw codedError('MECHANISM_REVIEW_REQUEST_INVALID', TypeError);
  }
  if (typeof value[contentKey] !== 'string') {
    throw codedError('MECHANISM_REVIEW_REQUEST_INVALID', TypeError);
  }
  if (
    pathRequired
    && (
      !exactKeys(value.sealedPath, ['pathRef', 'relativePath'])
      || !OPAQUE.test(value.sealedPath.pathRef)
      || value.sealedPath.relativePath.startsWith('/')
      || value.sealedPath.relativePath.includes('..')
    )
  ) throw codedError('MECHANISM_REVIEW_REQUEST_INVALID', TypeError);
  return sha256(value);
}

function validateModelPolicy(policy) {
  if (
    !exactKeys(policy, [
      'policyId', 'provider', 'model', 'maxOutputTokens', 'allowedTools',
    ])
    || typeof policy.policyId !== 'string'
    || typeof policy.provider !== 'string'
    || typeof policy.model !== 'string'
    || !Number.isInteger(policy.maxOutputTokens)
    || policy.maxOutputTokens < 1
    || !Array.isArray(policy.allowedTools)
    || policy.allowedTools.length !== 0
  ) throw codedError('MECHANISM_REVIEW_REQUEST_INVALID', TypeError);
}

function validateSerializedRequest(request) {
  if (
    !exactKeys(request, REQUEST_KEYS)
    || request.schemaVersion !== '1.0.0'
    || !OPAQUE.test(request.requestId)
    || !OPAQUE.test(request.nonceRef)
    || !HASH.test(request.requestHash)
    || !HASH.test(request.codeHash)
    || !HASH.test(request.packetSetHash)
    || !HASH.test(request.evidenceSetHash)
    || !HASH.test(request.promptHash)
    || !HASH.test(request.modelPolicyHash)
    || !iso(request.cutoff)
    || !iso(request.reviewDeadline)
    || !Array.isArray(request.packets)
    || request.packets.length > 3
  ) throw codedError('MECHANISM_REVIEW_REQUEST_INVALID', TypeError);
  const { requestHash, ...body } = request;
  if (sha256(body) !== requestHash) throw codedError('MECHANISM_REVIEW_MISMATCH');
}

export function createMechanismReviewRequest({
  run,
  packets,
  rubric,
  prompt,
  modelPolicy,
}) {
  if (
    !exactKeys(run, ['runId', 'cutoff', 'reviewDeadline', 'codeHash', 'nonceRef'])
    || typeof run.runId !== 'string'
    || !iso(run.cutoff)
    || !iso(run.reviewDeadline)
    || Date.parse(run.reviewDeadline) <= Date.parse(run.cutoff)
    || !HASH.test(run.codeHash)
    || !OPAQUE.test(run.nonceRef)
    || !Array.isArray(packets)
    || packets.length < 1
    || packets.length > 3
  ) throw codedError('MECHANISM_REVIEW_REQUEST_INVALID', TypeError);
  validateModelPolicy(modelPolicy);
  const packetIds = new Set();
  const sealedPackets = packets.map((packet) => {
    validatePacket(packet);
    if (!packet.reviewEligible || packetIds.has(packet.packetId)) {
      throw codedError('MECHANISM_REVIEW_REQUEST_INVALID');
    }
    packetIds.add(packet.packetId);
    return {
      packetId: packet.packetId,
      sealedPath: structuredClone(packet.sealedPath),
      packetHash: packet.packetHash,
      eligibleEvidenceRefs: [...new Set([
        ...packet.supportingEvidenceRefs,
        ...packet.counterEvidenceRefs,
        ...packet.falsificationResults.flatMap(({ evidenceRefs }) => evidenceRefs),
      ])].sort(),
      supplementalReadDescriptorIds: packet.supplementalReadAllowlist
        .map(({ descriptorId }) => descriptorId).sort(),
      supplementalReadAllowlistHash: sha256(packet.supplementalReadAllowlist),
      supplementalReadBudget: 10,
    };
  }).sort((left, right) => left.packetId.localeCompare(right.packetId));
  const rubricHash = sealedInput(
    rubric,
    ['rubricId', 'version'],
    'content',
    true,
  );
  const promptHash = sealedInput(prompt, ['promptId'], 'content');
  const modelPolicyHash = sha256(modelPolicy);
  const packetSetHash = sha256(sealedPackets.map(({ packetId, packetHash }) => ({
    packetId, packetHash,
  })));
  const evidenceRefs = [...new Set(sealedPackets.flatMap((packet) => (
    packet.eligibleEvidenceRefs
  )))].sort();
  const body = {
    schemaVersion: '1.0.0',
    requestId: stable('mreview', {
      runId: run.runId,
      nonceRef: run.nonceRef,
      packetSetHash,
    }),
    nonceRef: run.nonceRef,
    runId: run.runId,
    cutoff: run.cutoff,
    reviewDeadline: run.reviewDeadline,
    codeHash: run.codeHash,
    packets: sealedPackets,
    packetSetHash,
    evidenceSetHash: sha256(evidenceRefs),
    rubric: {
      rubricId: rubric.rubricId,
      version: rubric.version,
      sealedPath: structuredClone(rubric.sealedPath),
      hash: rubricHash,
    },
    promptId: prompt.promptId,
    promptHash,
    modelPolicy: {
      policyId: modelPolicy.policyId,
      allowedTools: [],
    },
    modelPolicyHash,
  };
  const request = deepFreeze({ ...body, requestHash: sha256(body) });
  if (NONCE_STATES.has(request.nonceRef) || REQUEST_STATES.has(request.requestId)) {
    throw codedError('MECHANISM_REVIEW_REPLAYED');
  }
  REQUEST_STATES.set(request.requestId, {
    requestHash: request.requestHash,
    nonceRef: request.nonceRef,
    consumed: false,
    modelPolicy: structuredClone(modelPolicy),
    packetEvidence: new Map(sealedPackets.map((packet) => [
      packet.packetId,
      new Set(packet.eligibleEvidenceRefs),
    ])),
    supplemental: new Map(sealedPackets.map((packet) => [
      packet.packetId,
      new Set(packet.supplementalReadDescriptorIds),
    ])),
  });
  NONCE_STATES.set(request.nonceRef, request.requestId);
  return request;
}

function requestState(request) {
  validateSerializedRequest(request);
  const state = REQUEST_STATES.get(request.requestId);
  if (
    !state
    || state.requestHash !== request.requestHash
    || state.nonceRef !== request.nonceRef
  ) throw codedError('MECHANISM_REVIEW_MISMATCH');
  return state;
}

function mismatch(response, request) {
  const fields = [
    'requestId', 'requestHash', 'nonceRef', 'runId', 'codeHash', 'packetSetHash',
    'promptHash', 'modelPolicyHash', 'evidenceSetHash',
  ];
  return fields.some((field) => response[field] !== request[field])
    || response.rubricHash !== request.rubric.hash
    || canonicalJson(response.packetHashes) !== canonicalJson(
      request.packets.map(({ packetId, packetHash }) => ({ packetId, packetHash })),
    );
}

function validateReview(review, request, state) {
  if (!exactKeys(review, REVIEW_KEYS)) {
    throw codedError('MECHANISM_REVIEW_UNSAFE_OUTPUT');
  }
  const packet = request.packets.find(({ packetId }) => packetId === review.packetId);
  if (!packet) throw codedError('MECHANISM_REVIEW_MISMATCH');
  if (
    !VERDICTS.has(review.verdict)
    || !Array.isArray(review.reasoningCodes)
    || !review.reasoningCodes.every(safeCode)
    || !Array.isArray(review.competingExplanationCodes)
    || !review.competingExplanationCodes.every(safeCode)
    || !UNCERTAINTY.has(review.uncertainty)
    || !Array.isArray(review.safetyFlags)
    || !review.safetyFlags.every((flag) => SAFETY_FLAGS.has(flag))
  ) throw codedError('MECHANISM_REVIEW_UNSAFE_OUTPUT');
  const evidence = state.packetEvidence.get(review.packetId);
  for (const refs of [review.supportingEvidenceRefs, review.counterEvidenceRefs]) {
    if (!Array.isArray(refs) || refs.some((ref) => !evidence.has(ref))) {
      throw codedError('MECHANISM_REVIEW_EVIDENCE_INELIGIBLE');
    }
  }
  if (
    !Array.isArray(review.supplementalReadDescriptorIds)
    || review.supplementalReadDescriptorIds.length > 10
  ) throw codedError('MECHANISM_REVIEW_OVER_BUDGET');
  if (
    new Set(review.supplementalReadDescriptorIds).size
      !== review.supplementalReadDescriptorIds.length
    || new Set(review.supportingEvidenceRefs).size !== review.supportingEvidenceRefs.length
    || new Set(review.counterEvidenceRefs).size !== review.counterEvidenceRefs.length
  ) throw codedError('MECHANISM_REVIEW_UNSAFE_OUTPUT');
  const supplemental = state.supplemental.get(review.packetId);
  if (review.supplementalReadDescriptorIds.some((id) => !supplemental.has(id))) {
    throw codedError('MECHANISM_REVIEW_SUPPLEMENTAL_INELIGIBLE');
  }
}

export function ingestMechanismReview({ request, response }) {
  const state = requestState(request);
  if (state.consumed) throw codedError('MECHANISM_REVIEW_REPLAYED');
  if (!exactKeys(response, RESPONSE_KEYS)) {
    throw codedError('MECHANISM_REVIEW_UNSAFE_OUTPUT');
  }
  if (
    response.schemaVersion !== '1.0.0'
    || mismatch(response, request)
    || !exactKeys(response.reviewer, [
      'kind', 'provider', 'model', 'reviewerRef',
    ])
    || response.reviewer.kind !== 'model'
    || response.reviewer.provider !== state.modelPolicy.provider
    || response.reviewer.model !== state.modelPolicy.model
    || !OPAQUE.test(response.reviewer.reviewerRef)
  ) throw codedError('MECHANISM_REVIEW_MISMATCH');
  if (
    !iso(response.reviewedAt)
    || Date.parse(response.reviewedAt) < Date.parse(request.cutoff)
    || Date.parse(response.reviewedAt) > Date.parse(request.reviewDeadline)
  ) throw codedError('MECHANISM_REVIEW_STALE');
  if (
    !exactKeys(response.usage, ['outputTokens'])
    || !Number.isInteger(response.usage.outputTokens)
    || response.usage.outputTokens < 0
    || response.usage.outputTokens > state.modelPolicy.maxOutputTokens
  ) throw codedError('MECHANISM_REVIEW_OVER_BUDGET');
  if (
    !Array.isArray(response.reviews)
    || response.reviews.length !== request.packets.length
    || new Set(response.reviews.map(({ packetId }) => packetId)).size !== response.reviews.length
  ) throw codedError('MECHANISM_REVIEW_MISMATCH');
  for (const review of response.reviews) validateReview(review, request, state);

  const result = deepFreeze({
    kind: 'VALIDATED_MECHANISM_REVIEW',
    requestId: request.requestId,
    requestHash: request.requestHash,
    nonceRef: request.nonceRef,
    runId: request.runId,
    codeHash: request.codeHash,
    packetSetHash: request.packetSetHash,
    packetHashes: structuredClone(response.packetHashes),
    reviewedAt: response.reviewedAt,
    reviewer: structuredClone(response.reviewer),
    usage: structuredClone(response.usage),
    reviews: [...response.reviews]
      .map((review) => structuredClone(review))
      .sort((left, right) => left.packetId.localeCompare(right.packetId)),
    validationHash: sha256(response),
  });
  state.consumed = true;
  VALIDATED_REVIEWS.set(result.validationHash, {
    packetHashes: sha256(result.packetHashes),
    reviews: sha256(result.reviews),
  });
  return result;
}

function validatedReviewMap(reviews, packets) {
  const packetHashes = new Map(packets.map(({ packetId, packetHash }) => (
    [packetId, packetHash]
  )));
  const result = new Map();
  for (const reviewSet of reviews) {
    if (
      !plain(reviewSet)
      || reviewSet.kind !== 'VALIDATED_MECHANISM_REVIEW'
      || !HASH.test(reviewSet.validationHash ?? '')
      || !Array.isArray(reviewSet.packetHashes)
      || !Array.isArray(reviewSet.reviews)
    ) throw codedError('MECHANISM_REVIEW_MISMATCH');
    const validation = VALIDATED_REVIEWS.get(reviewSet.validationHash);
    if (
      !validation
      || validation.packetHashes !== sha256(reviewSet.packetHashes)
      || validation.reviews !== sha256(reviewSet.reviews)
    ) throw codedError('MECHANISM_REVIEW_MISMATCH');
    for (const binding of reviewSet.packetHashes) {
      if (packetHashes.get(binding.packetId) !== binding.packetHash) {
        throw codedError('MECHANISM_REVIEW_MISMATCH');
      }
    }
    for (const review of reviewSet.reviews) {
      if (result.has(review.packetId)) throw codedError('MECHANISM_REVIEW_MISMATCH');
      result.set(review.packetId, review);
    }
  }
  return result;
}

export function reconcileExpertReviews({
  packets,
  reviews,
  maxPromoted = 3,
}) {
  if (
    !Array.isArray(packets)
    || !Array.isArray(reviews)
    || !Number.isInteger(maxPromoted)
    || maxPromoted < 0
    || maxPromoted > 3
  ) throw codedError('MECHANISM_INPUT_INVALID', TypeError);
  for (const packet of packets) validatePacket(packet);
  const ordered = [...packets].sort(compareCandidates);
  const reviewByPacket = validatedReviewMap(reviews, packets);
  const criticalIssues = ordered.filter(({ critical, supportingEvidenceRefs }) => (
    critical && supportingEvidenceRefs.length > 0
  ));
  const clusters = new Map();
  const backlog = [];
  for (const packet of ordered.filter(({ critical }) => !critical)) {
    const review = reviewByPacket.get(packet.packetId);
    if (
      !packet.promotionEligible
      || review?.verdict !== 'SUPPORTS'
    ) {
      backlog.push(packet);
      continue;
    }
    const root = packet.rootMechanismFingerprint;
    if (!clusters.has(root)) clusters.set(root, packet);
    else backlog.push(packet);
  }
  const promoted = [...clusters.values()].sort(compareCandidates).slice(0, maxPromoted);
  const promotedIds = new Set(promoted.map(({ packetId }) => packetId));
  for (const packet of clusters.values()) {
    if (!promotedIds.has(packet.packetId)) backlog.push(packet);
  }
  return deepFreeze({
    criticalIssues: [...criticalIssues],
    promoted,
    backlog: backlog.sort(compareCandidates),
  });
}
