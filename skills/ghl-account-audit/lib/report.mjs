import { canonicalJson, sha256 } from './canonical.mjs';
import { selectConversationSample } from './sampling.mjs';
import { assertNoExecutionMaterial } from './publication-safety.mjs';
import { compileProposal } from './proposals.mjs';
import {
  buildMechanismPacket,
  nominateMechanisms,
  reconcileExpertReviews,
  replayMechanismReview,
} from './mechanisms.mjs';
import { loadMetricContracts, loadProfile } from '../schemas/v1.mjs';

const VERDICTS = new Set(['PASS', 'WATCH', 'FAIL', 'UNKNOWN']);
const PRIVATE_OR_EXECUTION = /(?:https?:\/\/|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|Bearer\s+\S+|raw_[a-f0-9]{16,64}|\b(?:GET|POST|PUT|PATCH|DELETE)\s+(?:\/|https?:\/\/)|raw[_ -]?request|tools?\/call|authorization|credential|cookie)/iu;
const REVENUE_PROMISE = /(?:guarantee|will produce|will generate)[^\n]{0,80}(?:revenue|sales|\$|£|€)/iu;
const BROAD_PARTIAL_CLAIM = /(?:account-wide top leak|total account impact|all systems passed|account-wide pass|cleared missing capability)/iu;
const FORBIDDEN_PUBLIC_KEY = /^(?:transcripts?|messages?|messageBody|raw.*|vault.*|keyRef(?:erence)?|authorization|cookie|credential|email|phone|firstName|lastName|fullName)$/iu;

function codedError(code, ErrorType = Error) {
  return Object.assign(new ErrorType(code), { code });
}

function deepFreeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function assertPublishable(value, key = '', seen = new WeakSet()) {
  if (FORBIDDEN_PUBLIC_KEY.test(key)) {
    throw codedError('VERIFIER_PRIVACY_FAILURE_COMPILER_KEY');
  }
  if (typeof value === 'string') {
    if (PRIVATE_OR_EXECUTION.test(value)) {
      throw codedError('VERIFIER_PRIVACY_FAILURE_COMPILER_VALUE');
    }
    return;
  }
  if (value === null || ['boolean', 'number'].includes(typeof value)) return;
  if (!value || typeof value !== 'object' || seen.has(value)) {
    throw codedError('VERIFIER_INPUT_INVALID_COMPILER_VALUE', TypeError);
  }
  seen.add(value);
  try {
    for (const [childKey, child] of Object.entries(value)) {
      assertPublishable(child, childKey, seen);
    }
  } finally {
    seen.delete(value);
  }
}

function allFindings(findings) {
  if (
    !findings
    || !Array.isArray(findings.criticalIssues)
    || !Array.isArray(findings.promoted)
    || !Array.isArray(findings.backlog)
  ) throw codedError('REPORT_CLAIM_UNRESOLVED_FINDINGS_INPUT', TypeError);
  const result = [
    ...findings.criticalIssues.map((finding) => ({ ...finding, publicationLane: 'critical' })),
    ...findings.promoted.map((finding) => ({ ...finding, publicationLane: 'commercial' })),
    ...findings.backlog.map((finding) => ({ ...finding, publicationLane: 'backlog' })),
  ];
  const ids = result.map(({ findingId }) => findingId);
  if (ids.some((id) => typeof id !== 'string') || new Set(ids).size !== ids.length) {
    throw codedError('REPORT_CLAIM_UNRESOLVED_FINDING');
  }
  return result;
}

function validateEvidenceManifest(evidenceManifest) {
  if (!Array.isArray(evidenceManifest)) {
    throw codedError('REPORT_CLAIM_UNRESOLVED_EVIDENCE_MANIFEST', TypeError);
  }
  const refs = new Set();
  for (const record of evidenceManifest) {
    if (
      !record
      || typeof record !== 'object'
      || typeof record.evidenceRef !== 'string'
      || refs.has(record.evidenceRef)
      || record.classification !== 'OBSERVED'
      || record.provenance?.completeness !== 'COMPLETE'
      || !/^[a-f0-9]{64}$/u.test(record.sanitizedPayloadHash ?? '')
      || Object.keys(record).some((key) => /raw|vault|private/i.test(key))
    ) throw codedError('REPORT_CLAIM_UNRESOLVED_EVIDENCE_MANIFEST');
    refs.add(record.evidenceRef);
  }
  return refs;
}

function normalizeFindings(findings, eligibleEvidence, coverage) {
  const claims = [];
  const normalized = allFindings(findings).map((finding) => {
    if (
      !finding.verdicts
      || Object.keys(finding.verdicts).sort().join('|')
        !== ['configuration', 'execution', 'experience', 'outcome'].sort().join('|')
      || !Object.values(finding.verdicts).every((value) => VERDICTS.has(value))
    ) throw codedError('REPORT_CLAIM_UNRESOLVED_VERDICT');
    if (
      !Array.isArray(finding.evidenceRefs)
      || finding.evidenceRefs.length === 0
      || finding.evidenceRefs.some((ref) => !eligibleEvidence.has(ref))
    ) throw codedError('REPORT_CLAIM_UNRESOLVED_EVIDENCE');
    if (coverage.state === 'complete_partial' && finding.coverageScope === 'account_wide') {
      throw codedError('VERIFIER_SCOPE_VIOLATION_ACCOUNT_WIDE_FINDING');
    }
    if (
      coverage.state === 'complete_partial'
      && BROAD_PARTIAL_CLAIM.test(`${finding.title ?? ''} ${finding.summary ?? ''}`)
    ) throw codedError('VERIFIER_SCOPE_VIOLATION_BROAD_CLAIM');
    const findingClaims = finding.publicationLane === 'backlog' ? [] : (finding.claims ?? []);
    for (const claim of findingClaims) {
      if (
        typeof claim.claimId !== 'string'
        || typeof claim.text !== 'string'
        || !Array.isArray(claim.evidenceRefs)
        || claim.evidenceRefs.length === 0
        || claim.evidenceRefs.some((ref) => (
          !finding.evidenceRefs.includes(ref) || !eligibleEvidence.has(ref)
        ))
      ) throw codedError('REPORT_CLAIM_UNRESOLVED_EVIDENCE');
      if (
        claim.causalBasis === 'SUBJECTIVE_ONLY'
        || REVENUE_PROMISE.test(claim.text)
      ) throw codedError('REPORT_CLAIM_UNRESOLVED_CAUSAL');
      claims.push({
        claimId: claim.claimId,
        findingId: finding.findingId,
        text: claim.text,
        evidenceRefs: [...new Set(claim.evidenceRefs)].sort(),
        causalBasis: claim.causalBasis,
      });
    }
    return structuredClone(finding);
  });
  if (new Set(claims.map(({ claimId }) => claimId)).size !== claims.length) {
    throw codedError('REPORT_CLAIM_UNRESOLVED_DUPLICATE');
  }
  return {
    findings: normalized.sort((left, right) => left.findingId.localeCompare(right.findingId)),
    claims: claims.sort((left, right) => left.claimId.localeCompare(right.claimId)),
  };
}

function solutionArtifacts(solutionPacks, findings, evidenceRefs) {
  if (!Array.isArray(solutionPacks)) throw codedError('PROPOSAL_INVALID_PACKS', TypeError);
  const commercial = solutionPacks.filter(({ finding }) => finding?.critical !== true);
  const roots = new Set(commercial.map(({ proposal }) => proposal?.findingFingerprint));
  if (roots.size > 3) throw codedError('PROPOSAL_INELIGIBLE_PACK_LIMIT');
  const eligibleFindings = new Map(findings
    .filter(({ publicationLane }) => ['critical', 'commercial'].includes(publicationLane))
    .map((finding) => [finding.findingId, finding]));
  const artifacts = {};
  const eligibility = [];
  const verifierInputs = [];
  for (const pack of solutionPacks) {
    if (
      !pack.verificationInputs
      || !pack.verificationInputs.finding
      || !Array.isArray(pack.verificationInputs.currentObjects)
      || typeof pack.verificationInputs.evidenceCutoff !== 'string'
    ) throw codedError('PROPOSAL_INELIGIBLE_VERIFICATION_INPUTS');
    let rebuilt;
    try {
      rebuilt = compileProposal(pack.verificationInputs);
    } catch {
      throw codedError('PROPOSAL_INELIGIBLE_RECOMPILE');
    }
    if (
      !pack
      || !pack.proposal
      || pack.proposal.mode !== 'PROPOSAL_ONLY'
      || pack.proposal.executable !== false
      || pack.proposal.approvalRequired !== true
      || !eligibleFindings.has(pack.proposal.findingId)
      || pack.proposal.evidenceRefs.some((ref) => !evidenceRefs.has(ref))
      || pack.proposal.packHash !== sha256((({ packHash: _ignored, ...body }) => body)(pack.proposal))
      || pack.proposalHash !== sha256(pack.proposal)
      || canonicalJson(rebuilt.proposal) !== canonicalJson(pack.proposal)
      || rebuilt.readme !== pack.readme
      || rebuilt.acceptanceTests !== pack.acceptanceTests
    ) throw codedError('PROPOSAL_INELIGIBLE_PUBLICATION_PACK');
    for (const [path, value] of Object.entries(pack.payloadArtifacts)) {
      if (Object.hasOwn(artifacts, path)) throw codedError('PROPOSAL_INVALID_PACK_PATH');
      artifacts[path] = value;
    }
    const eligibleFinding = eligibleFindings.get(pack.proposal.findingId);
    if (
      eligibleFinding.publicationLane === 'commercial'
      && eligibleFinding.promotionEligible !== true
      || eligibleFinding.publicationLane === 'critical'
        && eligibleFinding.critical !== true
    ) throw codedError('PROPOSAL_INELIGIBLE_FINDING_LANE');
    eligibility.push({
      findingId: pack.proposal.findingId,
      solutionId: pack.proposal.solutionId,
      proposalHash: pack.proposalHash,
      eligible: true,
    });
    verifierInputs.push({
      solutionId: pack.proposal.solutionId,
      finding: pack.verificationInputs.finding,
      currentObjects: pack.verificationInputs.currentObjects,
      evidenceCutoff: pack.verificationInputs.evidenceCutoff,
      expectedProposalHash: pack.proposalHash,
    });
  }
  return {
    artifacts,
    eligibility: eligibility.sort((left, right) => left.solutionId.localeCompare(right.solutionId)),
    verifierInputs: verifierInputs.sort((left, right) => left.solutionId.localeCompare(right.solutionId)),
  };
}

function sealMechanisms(findings, graph, metrics, mechanismReview) {
  const eligible = findings.filter(({ publicationLane }) => (
    ['critical', 'commercial'].includes(publicationLane)
  ));
  if (
    !mechanismReview
    || typeof mechanismReview !== 'object'
    || Array.isArray(mechanismReview)
    || !mechanismReview.coverage
    || !Number.isInteger(mechanismReview.maxCandidates)
    || !Number.isInteger(mechanismReview.maxPromoted)
    || !Array.isArray(mechanismReview.packetBindings)
    || !Array.isArray(mechanismReview.reviewEnvelopes)
  ) throw codedError('VERIFIER_INPUT_INVALID_TASK7_MECHANISM_INPUTS');
  const primary = {
    graph: structuredClone(graph),
    metrics: structuredClone(metrics),
    coverage: structuredClone(mechanismReview.coverage),
  };
  deepFreeze(primary);
  let packets;
  let validatedReviews;
  let reconciled;
  try {
    packets = nominateMechanisms({
      ...primary,
      maxCandidates: mechanismReview.maxCandidates,
    }).map((candidate) => buildMechanismPacket(candidate));
    validatedReviews = mechanismReview.reviewEnvelopes.map((envelope) => (
      replayMechanismReview({
        requestInputs: envelope.requestInputs,
        response: envelope.response,
      })
    ));
    const reviewedPacketIds = validatedReviews.flatMap(({ packetHashes }) => (
      packetHashes.map(({ packetId }) => packetId)
    ));
    if (
      reviewedPacketIds.length > 3
      || new Set(reviewedPacketIds).size !== reviewedPacketIds.length
    ) throw codedError('MECHANISM_REVIEW_OVER_BUDGET');
    reconciled = reconcileExpertReviews({
      packets,
      reviews: validatedReviews,
      maxPromoted: mechanismReview.maxPromoted,
    });
  } catch {
    throw codedError('VERIFIER_INPUT_INVALID_TASK7_MECHANISM_INPUTS');
  }
  const packetById = new Map(packets.map((packet) => [packet.packetId, packet]));
  const bindingByPacket = new Map();
  const bindingByFinding = new Map();
  for (const binding of mechanismReview.packetBindings) {
    if (
      !binding
      || typeof binding !== 'object'
      || Array.isArray(binding)
      || Object.keys(binding).sort().join('|') !== [
        'findingId', 'packetHash', 'packetId',
      ].sort().join('|')
      || !packetById.has(binding.packetId)
      || packetById.get(binding.packetId).packetHash !== binding.packetHash
      || bindingByPacket.has(binding.packetId)
      || bindingByFinding.has(binding.findingId)
    ) throw codedError('VERIFIER_INPUT_INVALID_TASK7_MECHANISM_INPUTS');
    bindingByPacket.set(binding.packetId, binding);
    bindingByFinding.set(binding.findingId, binding);
  }
  if (
    bindingByPacket.size !== packets.length
    || eligible.some((finding) => (
      finding.mechanismPacketId !== bindingByFinding.get(finding.findingId)?.packetId
    ))
  ) throw codedError('VERIFIER_INPUT_INVALID_TASK7_MECHANISM_INPUTS');
  const findingFor = (packet) => bindingByPacket.get(packet.packetId)?.findingId;
  const reconciliation = {
    criticalPacketIds: reconciled.criticalIssues.map(({ packetId }) => packetId),
    promotedPacketIds: reconciled.promoted.map(({ packetId }) => packetId),
    backlogPacketIds: reconciled.backlog.map(({ packetId }) => packetId),
    criticalFindingIds: reconciled.criticalIssues.map(findingFor),
    promotedFindingIds: reconciled.promoted.map(findingFor),
    backlogFindingIds: reconciled.backlog.map(findingFor),
    priorityFindingIds: [
      ...reconciled.criticalIssues,
      ...reconciled.promoted,
    ].map(findingFor),
  };
  const laneIds = (lane) => findings
    .filter(({ publicationLane }) => publicationLane === lane)
    .map(({ findingId }) => findingId)
    .filter((findingId) => bindingByFinding.has(findingId))
    .sort();
  if (
    canonicalJson([...reconciliation.criticalFindingIds].sort()) !== canonicalJson(laneIds('critical'))
    || canonicalJson([...reconciliation.promotedFindingIds].sort()) !== canonicalJson(laneIds('commercial'))
    || canonicalJson([...reconciliation.backlogFindingIds].sort()) !== canonicalJson(laneIds('backlog'))
  ) throw codedError('VERIFIER_DETERMINISTIC_MISMATCH_MECHANISM_RECONCILIATION');
  const reviewEnvelopes = mechanismReview.reviewEnvelopes.map((envelope, index) => ({
    envelopeId: `review_${String(index + 1).padStart(4, '0')}`,
    requestInputs: structuredClone(envelope.requestInputs),
    requestInputsHash: sha256(envelope.requestInputs),
    response: structuredClone(envelope.response),
    responseHash: sha256(envelope.response),
    validationHash: validatedReviews[index].validationHash,
  }));
  const body = {
    schemaVersion: '1.0.0',
    primary,
    maxCandidates: mechanismReview.maxCandidates,
    maxPromoted: mechanismReview.maxPromoted,
    packets,
    packetBindings: mechanismReview.packetBindings,
    reviewEnvelopes,
    reconciliation,
  };
  return { ...body, commitment: sha256(body) };
}

function reportFinding(finding) {
  const citations = (finding.claims ?? [])
    .map(({ claimId, evidenceRefs }) => `[claim:${claimId}; evidence:${evidenceRefs.join(',')}]`)
    .join(' ');
  return [
    `### ${finding.title ?? finding.findingId}`,
    '',
    finding.summary ?? 'No summary was supplied.',
    citations ? ` ${citations}` : '',
    '',
  ].join('\n');
}

function verdictTable(findings) {
  const lines = [
    '| Finding | Configuration | Execution | Experience | Outcome |',
    '| --- | --- | --- | --- | --- |',
  ];
  for (const finding of findings) {
    lines.push(`| ${finding.findingId} | ${finding.verdicts.configuration} | ${finding.verdicts.execution} | ${finding.verdicts.experience} | ${finding.verdicts.outcome} |`);
  }
  if (findings.length === 0) lines.push('| None | UNKNOWN | UNKNOWN | UNKNOWN | UNKNOWN |');
  return lines.join('\n');
}

function gromJourneyCatalog(run) {
  if (run.target?.operatingProfile !== 'grom_internal') return null;
  let profile;
  let contracts;
  try {
    profile = loadProfile(run.target.operatingProfile);
    contracts = loadMetricContracts(run.target.operatingProfile);
  } catch {
    throw codedError('REPORT_CLAIM_UNRESOLVED_GROM_PROFILE');
  }
  const descriptor = (journeyId, label) => {
    const journey = profile.journeys.find((item) => item.journeyId === journeyId);
    if (!journey) throw codedError('REPORT_CLAIM_UNRESOLVED_GROM_PROFILE');
    return {
      label,
      journeyId: journey.journeyId,
      journeyInstanceId: journey.journeyInstanceId,
      metricIds: contracts.edges
        .filter((edge) => edge.journeyId === journey.journeyId)
        .map(({ edgeId }) => edgeId)
        .sort(),
    };
  };
  return {
    acquisition: descriptor('agency_new_business', 'Acquisition / new business'),
    onboarding: descriptor('client_onboarding', 'Onboarding'),
  };
}

function gromScorecards(run, metrics, journeys) {
  if (run.target?.operatingProfile !== 'grom_internal') return '';
  const currentCohorts = metrics.cohorts?.currentClosedWeek ?? {};
  const scorecard = (journey) => [
    `### ${journey.label} scorecard`,
    '',
    `- Journey ID: ${journey.journeyInstanceId}`,
    `- Denominator: ${currentCohorts[journey.journeyInstanceId] ?? 0}`,
    `- Clock and KPIs: ${journey.label.toLowerCase()} only`,
    '',
  ];
  return [
    ...scorecard(journeys.acquisition),
    ...scorecard(journeys.onboarding),
  ].join('\n');
}

function gromJourneyFindings(findings, journey) {
  return findings.filter((finding) => (
    finding.journeyId === journey.journeyId
    || finding.journeyInstanceId === journey.journeyInstanceId
    || finding.journeyInstanceIds?.includes(journey.journeyInstanceId)
  ));
}

function assertExactGromFindingPartition(findings, journeys) {
  const descriptors = [journeys.acquisition, journeys.onboarding];
  for (const finding of findings) {
    const matches = descriptors.filter((journey) => (
      gromJourneyFindings([finding], journey).length === 1
    ));
    if (matches.length !== 1) {
      throw codedError('REPORT_CLAIM_UNRESOLVED_GROM_FINDING_JOURNEY');
    }
  }
}

function splitGrom(label, findings, journeys, render) {
  const acquisition = gromJourneyFindings(findings, journeys.acquisition);
  const onboarding = gromJourneyFindings(findings, journeys.onboarding);
  return [
    `### ${journeys.acquisition.label} ${label}`,
    '',
    render(acquisition, journeys.acquisition),
    '',
    `### ${journeys.onboarding.label} ${label}`,
    '',
    render(onboarding, journeys.onboarding),
  ].join('\n');
}

function renderReport({
  run,
  systemOverview,
  coverage,
  metrics,
  findings,
  conversationReview,
  memoryProjection,
  actionOrder,
}) {
  const partial = coverage.state === 'complete_partial';
  const grom = run.target?.operatingProfile === 'grom_internal';
  const gromJourneys = gromJourneyCatalog(run);
  if (grom) assertExactGromFindingPartition(findings, gromJourneys);
  const critical = findings.filter(({ publicationLane }) => publicationLane === 'critical');
  const commercial = findings
    .filter(({ publicationLane }) => publicationLane === 'commercial')
    .slice(0, 3);
  const working = findings.filter(({ verdicts }) => Object.values(verdicts).some((value) => value === 'PASS'));
  const sections = [
    '# Weekly whole-account audit',
    '',
    '## Run status, scope, cutoff, and material limitations',
    '',
    `- Status: ${run.status}`,
    `- Scope: ${partial ? 'complete comparable subset only' : 'complete account scope'}`,
    `- Cutoff: ${run.cutoff}`,
    `- Material limitations: ${(coverage.limitations ?? []).join(', ') || 'none recorded'}`,
    '',
    '## System overview and current operation',
    '',
    systemOverview.summary,
    '',
    gromScorecards(run, metrics, gromJourneys),
    '## Critical issues',
    '',
    grom
      ? splitGrom('critical issues', critical, gromJourneys, (items) => (
        items.length ? items.map(reportFinding).join('\n') : 'No eligible critical issue was found.'
      ))
      : critical.length ? critical.map(reportFinding).join('\n') : 'No eligible critical issue was found.',
    '',
    '## Commercial movement',
    '',
    grom
      ? splitGrom('commercial movement', findings, gromJourneys, (_items, journey) => {
        const cohort = metrics.cohorts?.currentClosedWeek?.[journey.journeyInstanceId] ?? 0;
        const kpis = Object.entries(metrics.metrics?.currentClosedWeek ?? {})
          .filter(([metricId]) => journey.metricIds.includes(metricId))
          .map(([id, metric]) => `${id}: ${metric.numerator ?? 'unknown'}/${metric.denominator ?? 'unknown'}`)
          .join(', ') || 'No complete KPI';
        return `Entry cohort: ${cohort}\n\nKPIs: ${kpis}`;
      })
      : 'Movement is reported from the sealed weekly metric outputs only.',
    '',
    '## What is working',
    '',
    grom
      ? splitGrom('working controls', working, gromJourneys, (items) => (
        items.length
          ? items.map(({ findingId }) => `- ${findingId}`).join('\n')
          : 'No broad pass is inferred from missing evidence.'
      ))
      : working.length ? working.map(({ findingId }) => `- ${findingId}`).join('\n') : 'No broad pass is inferred from missing evidence.',
    '',
    '## Commercial findings',
    '',
    grom
      ? splitGrom('commercial findings', commercial, gromJourneys, (items) => (
        items.length
          ? items.map(reportFinding).join('\n')
          : 'No eligible commercial finding was promoted.'
      ))
      : commercial.length ? commercial.map(reportFinding).join('\n') : 'No eligible commercial finding was promoted.',
    '',
    '## Conversation and Voice AI conclusions',
    '',
    `- Availability: ${conversationReview.availability ?? 'UNKNOWN'}`,
    `- Sanitized judgments: ${(conversationReview.judgments ?? []).length}`,
    '',
    '## Configuration/execution/experience/outcome matrix',
    '',
    grom
      ? splitGrom('verdict matrix', findings, gromJourneys, (items) => verdictTable(items))
      : verdictTable(findings),
    '',
    '## Recommended action order',
    '',
    grom
      ? splitGrom('recommended action order', findings, gromJourneys, (items) => (
        actionOrder.filter((id) => items.some(({ findingId }) => findingId === id))
          .map((id, index) => `${index + 1}. ${id}`).join('\n')
          || 'No action pack is eligible.'
      ))
      : actionOrder.map((id, index) => `${index + 1}. ${id}`).join('\n') || 'No action pack is eligible.',
    '',
    '## Week-over-week finding movement',
    '',
    grom
      ? splitGrom('finding movement', findings, gromJourneys, (items) => (
        items.map(({ findingId }) => `- ${findingId}: derived from immutable events`).join('\n')
          || 'No finding movement.'
      ))
      : 'Movement is derived from immutable finding events.',
    '',
    '## Backlog changes and next evidence required',
    '',
    `- Backlog entries: ${memoryProjection.json?.entries?.length ?? 0}`,
    '- Missing evidence remains NOT_REASSESSED until a later capture.',
    '',
  ];
  const report = sections.join('\n');
  if (PRIVATE_OR_EXECUTION.test(report)) throw codedError('VERIFIER_PRIVACY_FAILURE_REPORT');
  if (partial && BROAD_PARTIAL_CLAIM.test(report)) {
    throw codedError('VERIFIER_SCOPE_VIOLATION_REPORT');
  }
  return report;
}

function evidenceJsonl(evidenceManifest) {
  return `${[...evidenceManifest]
    .sort((left, right) => left.evidenceRef.localeCompare(right.evidenceRef))
    .map((record) => canonicalJson(record))
    .join('\n')}\n`;
}

function sealSampling(sample) {
  const verification = sample.verification;
  if (
    !verification
    || !Array.isArray(verification.interactions)
    || !Number.isInteger(verification.censusThreshold)
    || !Number.isInteger(verification.maxSample)
    || verification.universeHash !== sha256(verification.interactions)
  ) throw codedError('VERIFIER_INPUT_INVALID_SAMPLING_UNIVERSE');
  let rebuilt;
  try {
    rebuilt = selectConversationSample({
      interactions: verification.interactions,
      seed: sample.seed,
      censusThreshold: verification.censusThreshold,
      maxSample: verification.maxSample,
    });
  } catch {
    throw codedError('VERIFIER_INPUT_INVALID_SAMPLING_UNIVERSE');
  }
  const { verification: _verification, ...publicSample } = sample;
  if (canonicalJson(rebuilt) !== canonicalJson(publicSample)) {
    throw codedError('VERIFIER_DETERMINISTIC_MISMATCH_SAMPLE_MEMBERSHIP');
  }
  return {
    publicSample,
    sealedUniverse: {
      schemaVersion: '1.0.0',
      seed: sample.seed,
      censusThreshold: verification.censusThreshold,
      maxSample: verification.maxSample,
      universeHash: verification.universeHash,
      interactions: verification.interactions,
    },
  };
}

export function compilePublicationArtifacts(input = {}) {
  const {
    run,
    systemOverview,
    coverage,
    freshness,
    diff,
    graph,
    metricContracts,
    windows,
    metrics,
    sample,
    findings,
    mechanismReview,
    conversationReview,
    evidenceManifest,
    solutionPacks,
    memoryProjection,
  } = input;
  if (
    !run || !systemOverview || !coverage || !freshness || !diff || !graph
    || !metricContracts || !windows || !metrics || !sample || !findings
    || !conversationReview || !memoryProjection
  ) throw codedError('REPORT_CLAIM_UNRESOLVED_INPUT', TypeError);
  if (!['complete_full', 'complete_partial'].includes(run.status)) {
    throw codedError('VERIFIER_SCOPE_VIOLATION_RUN_STATUS');
  }
  if (coverage.state !== run.status) throw codedError('VERIFIER_SCOPE_VIOLATION_COVERAGE');
  const eligibleEvidence = validateEvidenceManifest(evidenceManifest);
  const sampling = sealSampling(sample);
  const normalized = normalizeFindings(findings, eligibleEvidence, coverage);
  const mechanismSeal = sealMechanisms(normalized.findings, graph, metrics, mechanismReview);
  const packs = solutionArtifacts(solutionPacks, normalized.findings, eligibleEvidence);
  const report = renderReport({
    run,
    systemOverview,
    coverage,
    metrics,
    findings: normalized.findings,
    conversationReview,
    memoryProjection,
    actionOrder: mechanismSeal.reconciliation.priorityFindingIds,
  });
  const verification = {
    coverageClass: coverage.state,
    metricHash: sha256(metrics),
    cohortHash: sha256(metrics.cohorts ?? {}),
    sampleHash: sampling.publicSample.sampleHash,
    priorityOrder: mechanismSeal.reconciliation.priorityFindingIds,
    overlapDedupe: [...new Set(normalized.findings.map(({ fingerprint, findingId }) => (
      fingerprint ?? findingId
    )))].sort(),
    proposalEligibility: packs.eligibility,
    claimsHash: sha256(normalized.claims),
  };
  const machine = {
    schemaVersion: '1.0.0',
    sealedInputs: {
      run,
      graph,
      metricContracts,
      windows,
      mechanismCoverage: mechanismSeal.primary.coverage,
    },
    metrics,
    findings: normalized.findings,
    claims: normalized.claims,
    verification,
  };
  const payloadArtifacts = {
    'REPORT.md': report,
    'coverage.json': coverage,
    'freshness.json': freshness,
    'diff.json': diff,
    'metrics-and-findings.json': machine,
    'conversation-sample.json': {
      ...sampling.publicSample,
      conversationReview: {
        availability: conversationReview.availability ?? 'UNKNOWN',
        judgments: conversationReview.judgments ?? [],
      },
    },
    'evidence/sanitized/sampling-universe.json': sampling.sealedUniverse,
    'evidence/sanitized/proposal-verification.json': {
      schemaVersion: '1.0.0',
      proposals: packs.verifierInputs,
      commitment: sha256(packs.verifierInputs),
    },
    'evidence/sanitized/mechanism-verification.json': mechanismSeal,
    'evidence-manifest.jsonl': evidenceJsonl(evidenceManifest),
    ...packs.artifacts,
  };
  const projections = {
    'BACKLOG.md': memoryProjection.markdown,
    'backlog.json': memoryProjection.json,
    'current-system-flow.mmd': systemOverview.flow
      ?? 'flowchart LR\n  Entry --> Follow_up --> Outcome\n',
  };
  assertPublishable(payloadArtifacts);
  assertPublishable(projections);
  assertNoExecutionMaterial(payloadArtifacts, {
    code: 'PROPOSAL_EXECUTION_MATERIAL_FORBIDDEN_PUBLICATION',
  });
  return deepFreeze({
    payloadArtifacts,
    projections,
    manifestInput: structuredClone(run),
  });
}
