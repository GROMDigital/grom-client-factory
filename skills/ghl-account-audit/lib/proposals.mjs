import { canonicalJson, sha256 } from './canonical.mjs';
import { ProposalSchema } from '../schemas/v1.mjs';
import { assertNoExecutionMaterial } from './publication-safety.mjs';

const HASH = /^[a-f0-9]{64}$/u;
const OBJECT_REF = /^obj_[a-f0-9]{16,64}$/u;
const MERGE_FIELD = /^\{\{[a-z][a-z0-9_.]*\}\}$/u;
const SOLUTION_TYPES = new Set([
  'workflow_logic',
  'copy',
  'wait_timing',
  'conversation_ai',
  'voice_ai',
  'operating_process',
]);
const ELIGIBLE_STATES = new Set(['PROMOTED', 'CRITICAL']);

function codedError(code, ErrorType = Error) {
  return Object.assign(new ErrorType(code), { code });
}

function deepFreeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function plain(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function stableId(prefix, value) {
  return `${prefix}_${sha256(value).slice(0, 32)}`;
}

function sortedUnique(values) {
  return [...new Set(values)].sort();
}

function assertDeepFrozen(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  if (!Object.isFrozen(value)) throw codedError('PROPOSAL_INVALID_INPUT_NOT_FROZEN', TypeError);
  seen.add(value);
  for (const child of Object.values(value)) assertDeepFrozen(child, seen);
}

function objectIndex(currentObjects) {
  if (!Array.isArray(currentObjects)) {
    throw codedError('PROPOSAL_INVALID_CURRENT_OBJECTS', TypeError);
  }
  assertDeepFrozen(currentObjects);
  const result = new Map();
  for (const object of currentObjects) {
    if (
      !plain(object)
      || !OBJECT_REF.test(object.objectRef ?? '')
      || typeof object.objectType !== 'string'
      || (!Number.isFinite(object.capturedVersion)
        && (typeof object.capturedVersion !== 'string' || object.capturedVersion.length === 0))
      || !HASH.test(object.capturedHash ?? '')
      || result.has(object.objectRef)
    ) throw codedError('PROPOSAL_INVALID_CURRENT_OBJECTS', TypeError);
    result.set(object.objectRef, object);
  }
  return result;
}

function validateObjectBinding(binding, objects) {
  const current = objects.get(binding.objectId);
  if (!current) throw codedError('PROPOSAL_UNRESOLVED_REFERENCE_OBJECT');
  if (current.objectType !== binding.objectType) {
    throw codedError('PROPOSAL_UNRESOLVED_REFERENCE_OBJECT_TYPE');
  }
  if (current.capturedVersion !== binding.capturedVersion) {
    throw codedError('PROPOSAL_STALE_OBJECT_VERSION');
  }
  if (current.capturedHash !== binding.capturedHash) {
    throw codedError('PROPOSAL_STALE_OBJECT_HASH');
  }
  return current;
}

function validateMergeFields(changeSet, boundObjects) {
  if (changeSet.solutionType !== 'copy') return;
  const known = new Set(boundObjects.flatMap(({ mergeFields }) => mergeFields ?? []));
  for (const field of changeSet.mergeFields) {
    if (!MERGE_FIELD.test(field) || !known.has(field)) {
      throw codedError('PROPOSAL_UNRESOLVED_REFERENCE_MERGE_FIELD');
    }
    if (
      typeof changeSet.fallbacks?.[field] !== 'string'
      || changeSet.fallbacks[field].trim().length === 0
    ) throw codedError('PROPOSAL_UNRESOLVED_REFERENCE_FALLBACK');
  }
  if (Object.keys(changeSet.fallbacks ?? {}).some((field) => !changeSet.mergeFields.includes(field))) {
    throw codedError('PROPOSAL_UNRESOLVED_REFERENCE_FALLBACK');
  }
}

function validateVariantReferences(changeSet, objects) {
  if (changeSet.solutionType === 'workflow_logic') {
    const workflow = objects.get(changeSet.workflowId);
    if (!workflow) throw codedError('PROPOSAL_UNRESOLVED_REFERENCE_WORKFLOW');
    if (workflow.capturedVersion !== changeSet.capturedVersion) {
      throw codedError('PROPOSAL_STALE_OBJECT_VERSION');
    }
    if (workflow.capturedHash !== changeSet.capturedHash) {
      throw codedError('PROPOSAL_STALE_OBJECT_HASH');
    }
    if (!Array.isArray(changeSet.exits) || changeSet.exits.length === 0) {
      throw codedError('PROPOSAL_UNRESOLVED_REFERENCE_EXIT');
    }
    for (const ref of [
      ...(changeSet.references?.calendars ?? []),
      ...(changeSet.references?.agents ?? []),
    ]) {
      if (!objects.has(ref)) throw codedError('PROPOSAL_UNRESOLVED_REFERENCE_OBJECT');
    }
  }
  if (['conversation_ai', 'voice_ai'].includes(changeSet.solutionType)) {
    const agent = objects.get(changeSet.agentId);
    if (!agent) throw codedError('PROPOSAL_UNRESOLVED_REFERENCE_AGENT');
    if (agent.capturedVersion !== changeSet.capturedVersion) {
      throw codedError('PROPOSAL_STALE_OBJECT_VERSION');
    }
    if (agent.capturedHash !== changeSet.capturedHash) {
      throw codedError('PROPOSAL_STALE_OBJECT_HASH');
    }
  }
  if (changeSet.solutionType === 'wait_timing' && !objects.has(changeSet.businessCalendar)) {
    throw codedError('PROPOSAL_UNRESOLVED_REFERENCE_CALENDAR');
  }
}

export function findingFingerprint(finding) {
  if (
    !plain(finding)
    || typeof finding.target !== 'string'
    || typeof finding.journeyId !== 'string'
    || typeof finding.mechanismClass !== 'string'
    || !Array.isArray(finding.affectedObjectRefs)
    || !finding.affectedObjectRefs.every((ref) => OBJECT_REF.test(ref))
  ) throw codedError('PROPOSAL_INVALID_FINDING_IDENTITY', TypeError);
  return stableId('fingerprint', {
    target: finding.target,
    journeyId: finding.journeyId,
    mechanismClass: finding.mechanismClass,
    affectedObjectRefs: sortedUnique(finding.affectedObjectRefs),
  });
}

function assertEligibility(finding, evidenceCutoff) {
  const confidenceEligible = finding.critical === true
    ? ['C1', 'C2', 'C3'].includes(finding.mechanismConfidence)
    : ['C2', 'C3'].includes(finding.mechanismConfidence);
  if (
    !ELIGIBLE_STATES.has(finding.state)
    || finding.critical !== true && finding.promotionEligible !== true
    || !confidenceEligible
    || finding.evidenceEligible !== true
    || !Array.isArray(finding.evidenceRefs)
    || finding.evidenceRefs.length === 0
  ) throw codedError('PROPOSAL_INELIGIBLE_FINDING');
  if (
    typeof evidenceCutoff !== 'string'
    || !Number.isFinite(Date.parse(evidenceCutoff))
    || finding.evidenceCutoff !== evidenceCutoff
  ) throw codedError('PROPOSAL_INELIGIBLE_EVIDENCE_CUTOFF');
  if (!plain(finding.proposedSolution)) {
    throw codedError('PROPOSAL_INELIGIBLE_SOLUTION_DRAFT_MISSING');
  }
}

function renderReadme(proposal) {
  const affected = proposal.objectRefs.map(({ objectId, capturedVersion }) => (
    `- ${objectId} at captured version ${capturedVersion}`
  )).join('\n');
  const dependencies = proposal.dependencies.length
    ? proposal.dependencies.map((item) => `- ${item}`).join('\n')
    : '- None';
  return [
    `# ${proposal.solutionId}`,
    '',
    'Status: proposal only. Human approval is required.',
    '',
    `Solution type: ${proposal.changeSet.solutionType}`,
    `Finding: ${proposal.findingId}`,
    `Evidence cutoff: ${proposal.evidenceCutoff}`,
    '',
    '## Affected objects',
    '',
    affected,
    '',
    '## Dependencies',
    '',
    dependencies,
    '',
    '## Blast radius',
    '',
    proposal.blastRadius,
    '',
    '## Expected result',
    '',
    `${proposal.expectedResult.lower ?? 'unknown'} to ${proposal.expectedResult.upper ?? 'unknown'} ${proposal.expectedResult.unit} (${proposal.expectedResult.basis})`,
    '',
    '## Rollout',
    '',
    `Defined in proposal.json: ${canonicalJson(proposal.rollout)}`,
    '',
    '## Rollback',
    '',
    `Defined in proposal.json: ${canonicalJson(proposal.rollback)}`,
    '',
  ].join('\n');
}

function renderAcceptanceTests(proposal) {
  return [
    '# Acceptance tests',
    '',
    ...proposal.acceptanceTests.map((test, index) => `${index + 1}. ${test}`),
    '',
    '## Monitoring',
    '',
    ...proposal.monitoring.map((item) => `- ${item}`),
    '',
    '## Guardrails',
    '',
    ...proposal.guardrails.map((item) => `- ${item}`),
    '',
  ].join('\n');
}

export function renderProposalProjections(proposal) {
  const parsed = ProposalSchema.safeParse(proposal);
  if (!parsed.success) throw codedError('PROPOSAL_INVALID_SCHEMA');
  const readme = renderReadme(proposal);
  const acceptanceTests = renderAcceptanceTests(proposal);
  assertNoExecutionMaterial({ readme, acceptanceTests });
  return deepFreeze({ readme, acceptanceTests });
}

export function compileProposal({ finding, currentObjects, evidenceCutoff } = {}) {
  try {
    assertDeepFrozen(finding);
    const objects = objectIndex(currentObjects);
    assertEligibility(finding, evidenceCutoff);
    const draft = finding.proposedSolution;
    if (!SOLUTION_TYPES.has(draft.solutionType)) {
      throw codedError('PROPOSAL_INVALID_SOLUTION_TYPE');
    }
    if (!Array.isArray(draft.objectRefs) || draft.objectRefs.length === 0) {
      throw codedError('PROPOSAL_UNRESOLVED_REFERENCE_OBJECT');
    }
    const objectRefs = [...draft.objectRefs]
      .map((binding) => ({ ...binding }))
      .sort((left, right) => left.objectId.localeCompare(right.objectId));
    const boundObjects = objectRefs.map((binding) => validateObjectBinding(binding, objects));
    const boundRefs = new Set(objectRefs.map(({ objectId }) => objectId));
    if (finding.affectedObjectRefs.some((ref) => !boundRefs.has(ref))) {
      throw codedError('PROPOSAL_UNRESOLVED_REFERENCE_AFFECTED_OBJECT');
    }
    const dependencies = sortedUnique(draft.dependencies ?? []);
    for (const dependency of dependencies) {
      if (!objects.has(dependency)) {
        throw codedError('PROPOSAL_UNRESOLVED_REFERENCE_DEPENDENCY');
      }
    }
    validateMergeFields(draft.changeSet, boundObjects);
    validateVariantReferences(draft.changeSet, objects);
    if (
      ['workflow_logic', 'conversation_ai', 'voice_ai'].includes(draft.solutionType)
      && !boundRefs.has(
        draft.solutionType === 'workflow_logic'
          ? draft.changeSet.workflowId
          : draft.changeSet.agentId,
      )
    ) throw codedError('PROPOSAL_UNRESOLVED_REFERENCE_CHANGE_TARGET');
    const fingerprint = findingFingerprint(finding);
    const solutionId = stableId('solution', {
      findingId: finding.findingId,
      fingerprint,
      solutionType: draft.solutionType,
    });
    const body = {
      mode: 'PROPOSAL_ONLY',
      executable: false,
      approvalRequired: true,
      solutionId,
      findingId: finding.findingId,
      findingFingerprint: fingerprint,
      objectRefs,
      changeSet: structuredClone(draft.changeSet),
      prerequisites: sortedUnique(draft.prerequisites ?? []),
      dependencies,
      blastRadius: draft.blastRadius,
      owner: draft.owner,
      acceptanceTests: sortedUnique(draft.acceptanceTests ?? []),
      monitoring: sortedUnique(draft.monitoring ?? []),
      rollout: structuredClone(draft.rollout),
      rollback: structuredClone(draft.rollback),
      guardrails: sortedUnique(draft.guardrails ?? []),
      expectedResult: structuredClone(draft.expectedResult),
      evidenceRefs: sortedUnique(finding.evidenceRefs),
      evidenceCutoff,
    };
    assertNoExecutionMaterial(body);
    const packHash = sha256(body);
    const proposal = { ...body, packHash };
    const parsed = ProposalSchema.safeParse(proposal);
    if (!parsed.success) throw codedError('PROPOSAL_INVALID_SCHEMA');
    const proposalHash = sha256(proposal);
    const { readme, acceptanceTests } = renderProposalProjections(proposal);
    const base = `solution-packs/${solutionId}`;
    const payloadArtifacts = {
      [`${base}/README.md`]: readme,
      [`${base}/proposal.json`]: proposal,
      [`${base}/acceptance-tests.md`]: acceptanceTests,
    };
    return deepFreeze({
      proposal,
      proposalHash,
      readme,
      acceptanceTests,
      payloadArtifacts,
    });
  } catch (error) {
    if (typeof error?.code === 'string' && error.code.startsWith('PROPOSAL_')) throw error;
    throw codedError('PROPOSAL_INVALID_INPUT', TypeError);
  }
}

export function proposalApprovalIsCurrent({ proposal, receipt } = {}) {
  if (!plain(proposal) || !plain(receipt)) return false;
  return receipt.type === 'approval_receipt'
    && receipt.solutionId === proposal.solutionId
    && receipt.proposalHash === sha256(proposal);
}
