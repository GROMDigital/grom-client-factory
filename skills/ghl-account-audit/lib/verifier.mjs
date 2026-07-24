import {
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import {
  isAbsolute,
  join,
  normalize,
  relative,
  sep,
} from 'node:path';
import { canonicalJson, sha256 } from './canonical.mjs';
import { computeJourneyMetrics } from './metrics.mjs';
import { compileProposal, renderProposalProjections } from './proposals.mjs';
import { selectConversationSample } from './sampling.mjs';
import { assertNoExecutionMaterial } from './publication-safety.mjs';
import {
  buildMechanismPacket,
  nominateMechanisms,
  reconcileExpertReviews,
  replayMechanismReview,
} from './mechanisms.mjs';

const PRIVATE_PATTERN = /(?:[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|Bearer\s+\S+|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*|raw_[a-f0-9]{16,64}|https?:\/\/[^\s"'<>]*[?&](?:token|code|signature|key|secret|auth)=)/iu;
const WRITE_PATTERN = /(?:\b(?:GET|POST|PUT|PATCH|DELETE)\s+[/:]|\braw[_ -]?request\b|\btools?\/call\b|\bconfirm\s*[:=]|\bcurl\b|\bwget\b)/iu;
const BROAD_PARTIAL_CLAIM = /(?:account-wide top leak|total account impact|all systems passed|account-wide pass|cleared missing capability)/iu;
const REVENUE_PROMISE = /(?:guarantee|will produce|will generate)[^\n]{0,80}(?:revenue|sales|\$|£|€)/iu;
const VERDICTS = new Set(['PASS', 'WATCH', 'FAIL', 'UNKNOWN']);

function codedError(code, ErrorType = Error) {
  return Object.assign(new ErrorType(code), { code });
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function comparePacketBindings(left, right) {
  return compareText(left.packetId, right.packetId)
    || compareText(left.findingId, right.findingId);
}

function mechanismReviewOrder(envelope) {
  const response = envelope?.response;
  if (
    typeof response?.requestHash !== 'string'
    || typeof response?.requestId !== 'string'
    || !Array.isArray(response.packetHashes)
    || !response.packetHashes.every((packet) => typeof packet?.packetId === 'string')
  ) return null;
  return {
    requestHash: response.requestHash,
    requestId: response.requestId,
    packetIds: response.packetHashes.map(({ packetId }) => packetId).sort(compareText),
  };
}

function compareMechanismReviewEnvelopes(left, right) {
  return compareText(left.order.requestHash, right.order.requestHash)
    || compareText(left.order.requestId, right.order.requestId)
    || compareText(canonicalJson(left.order.packetIds), canonicalJson(right.order.packetIds));
}

function mechanismReviewEnvelopeId(order) {
  return `review_${sha256(order).slice(0, 32)}`;
}

function assertCanonicalMechanismOrder(sealed) {
  if (sealed.packetBindings.every((binding) => (
    typeof binding?.packetId === 'string'
    && typeof binding?.findingId === 'string'
  ))) {
    const canonicalBindings = [...sealed.packetBindings].sort(comparePacketBindings);
    if (canonicalJson(sealed.packetBindings) !== canonicalJson(canonicalBindings)) {
      throw codedError('VERIFIER_INPUT_NONCANONICAL_MECHANISM_ORDER');
    }
  }
  const reviewEntries = sealed.reviewEnvelopes.map((envelope) => ({
    envelope,
    order: mechanismReviewOrder(envelope),
  }));
  if (reviewEntries.every(({ order }) => order !== null)) {
    const canonicalReviews = [...reviewEntries].sort(compareMechanismReviewEnvelopes);
    if (
      canonicalJson(sealed.reviewEnvelopes)
      !== canonicalJson(canonicalReviews.map(({ envelope }) => envelope))
    ) throw codedError('VERIFIER_INPUT_NONCANONICAL_MECHANISM_ORDER');
    if (reviewEntries.some(({ envelope, order }) => (
      envelope.envelopeId !== mechanismReviewEnvelopeId(order)
    ))) throw codedError('VERIFIER_DETERMINISTIC_MISMATCH_MECHANISM_REVIEWS');
  }
}

function deepFreeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function within(parent, child) {
  const part = relative(parent, child);
  return part === ''
    || (!isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`));
}

function safePath(name) {
  return typeof name === 'string'
    && name.length > 0
    && !isAbsolute(name)
    && !name.includes('\\')
    && !name.includes('\0')
    && normalize(name) === name
    && !name.split(sep).some((part) => !part || part === '.' || part === '..');
}

function listFiles(directory, prefix = '', output = []) {
  for (const name of readdirSync(directory).sort()) {
    const path = join(directory, name);
    const relativeName = prefix ? `${prefix}/${name}` : name;
    const metadata = lstatSync(path);
    if (metadata.isSymbolicLink()) throw codedError('VERIFIER_INPUT_INVALID_SYMLINK');
    if (metadata.isDirectory()) listFiles(path, relativeName, output);
    else if (metadata.isFile()) output.push(relativeName);
    else throw codedError('VERIFIER_INPUT_INVALID_FILE_TYPE');
  }
  return output;
}

function byteHash(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function canonicalJsonFile(bytes, code = 'VERIFIER_INPUT_INVALID_NON_CANONICAL_JSON') {
  try {
    const value = JSON.parse(bytes.toString('utf8'));
    if (!bytes.equals(Buffer.from(`${canonicalJson(value)}\n`, 'utf8'))) throw new Error();
    return value;
  } catch {
    throw codedError(code);
  }
}

function canonicalJsonl(bytes) {
  const text = bytes.toString('utf8');
  if (!text.endsWith('\n')) throw codedError('VERIFIER_INPUT_INVALID_NON_CANONICAL_JSONL');
  const lines = text.slice(0, -1).split('\n').filter((line) => line.length > 0);
  try {
    return lines.map((line) => {
      const value = JSON.parse(line);
      if (canonicalJson(value) !== line) throw new Error();
      return value;
    });
  } catch {
    throw codedError('VERIFIER_INPUT_INVALID_NON_CANONICAL_JSONL');
  }
}

function snapshot(directory, files) {
  return files.map((name) => {
    const metadata = statSync(join(directory, name));
    return {
      name,
      dev: metadata.dev,
      ino: metadata.ino,
      size: metadata.size,
      mtimeMs: metadata.mtimeMs,
      ctimeMs: metadata.ctimeMs,
    };
  });
}

function assertSameSnapshot(left, right) {
  if (canonicalJson(left) !== canonicalJson(right)) {
    throw codedError('VERIFIER_WRITE_TRACE_RACE');
  }
}

function recomputeSampleHash(sample) {
  const { sampleHash: _sampleHash, conversationReview: _conversationReview, ...body } = sample;
  return sha256(body);
}

function validateSampleStructure(sample) {
  if (
    !Array.isArray(sample.selections)
    || sample.actualSampleCount !== sample.selections.length
    || !Number.isInteger(sample.universeCount)
    || sample.universeCount < sample.selections.length
    || new Set(sample.selections.map(({ interactionRef }) => interactionRef)).size
      !== sample.selections.length
  ) throw codedError('VERIFIER_DETERMINISTIC_MISMATCH_SAMPLE_MEMBERSHIP');
  if (sample.mode === 'CENSUS' && (
    sample.universeCount !== sample.selections.length
    || sample.selections.some(({ inclusionProbability }) => inclusionProbability !== 1)
  )) throw codedError('VERIFIER_DETERMINISTIC_MISMATCH_SAMPLE_MEMBERSHIP');
  if (sample.mode === 'STRATIFIED_SAMPLE' && (
    sample.selections.some(({ inclusionProbability }) => (
      !Number.isFinite(inclusionProbability)
      || inclusionProbability <= 0
      || inclusionProbability > 1
    ))
    || sample.actualSampleCount < sample.mandatoryCount
  )) throw codedError('VERIFIER_DETERMINISTIC_MISMATCH_SAMPLE_MEMBERSHIP');
}

function rebuildSample(sample, universe) {
  if (
    !universe
    || !Array.isArray(universe.interactions)
    || universe.seed !== sample.seed
    || universe.universeHash !== sha256(universe.interactions)
    || !Number.isInteger(universe.censusThreshold)
    || !Number.isInteger(universe.maxSample)
  ) throw codedError('VERIFIER_INPUT_INVALID_SAMPLING_UNIVERSE');
  let rebuilt;
  try {
    rebuilt = selectConversationSample({
      interactions: universe.interactions,
      seed: universe.seed,
      censusThreshold: universe.censusThreshold,
      maxSample: universe.maxSample,
    });
  } catch {
    throw codedError('VERIFIER_INPUT_INVALID_SAMPLING_UNIVERSE');
  }
  const { conversationReview: _conversationReview, ...publicSample } = sample;
  if (canonicalJson(rebuilt) !== canonicalJson(publicSample)) {
    throw codedError('VERIFIER_DETERMINISTIC_MISMATCH_SAMPLE_MEMBERSHIP');
  }
}

function validateFindingFormulas(findings) {
  for (const finding of findings) {
    const priority = finding.priorityInputs ?? {};
    if (
      Object.hasOwn(priority, 'promotionEligibility')
      && priority.promotionEligibility !== (
        finding.promotionEligible ? 'ELIGIBLE' : 'INELIGIBLE'
      )
    ) throw codedError('VERIFIER_DETERMINISTIC_MISMATCH_FINDING_ELIGIBILITY');
    if (
      Object.hasOwn(priority, 'coverageScope')
      && priority.coverageScope !== finding.coverageScope
    ) throw codedError('VERIFIER_DETERMINISTIC_MISMATCH_COVERAGE_CLASS');
    if (
      finding.impactRange
      && priority.commercialValue
      && canonicalJson(finding.impactRange) !== canonicalJson(priority.commercialValue)
    ) throw codedError('VERIFIER_DETERMINISTIC_MISMATCH_IMPACT_RANGE');
    if (
      Number.isFinite(finding.denominator?.value)
      && Number.isFinite(finding.denominator?.numerator)
      && Object.hasOwn(priority, 'excessObservedLoss')
      && priority.excessObservedLoss !== Math.max(
        0,
        finding.denominator.value - finding.denominator.numerator,
      )
    ) throw codedError('VERIFIER_DETERMINISTIC_MISMATCH_IMPACT_FORMULA');
  }
}

function proposalEligibility(directory, fileNames, evidenceRefs, findingIds) {
  const proposalPaths = fileNames.filter((name) => name.endsWith('/proposal.json')).sort();
  const result = [];
  for (const path of proposalPaths) {
    const proposal = canonicalJsonFile(readFileSync(join(directory, path)));
    const base = path.slice(0, -'/proposal.json'.length);
    const readmePath = `${base}/README.md`;
    const acceptancePath = `${base}/acceptance-tests.md`;
    if (!fileNames.includes(readmePath) || !fileNames.includes(acceptancePath)) {
      throw codedError('VERIFIER_INPUT_INVALID_PROPOSAL_FILE_SET');
    }
    let projections;
    try {
      projections = renderProposalProjections(proposal);
    } catch {
      throw codedError('VERIFIER_DETERMINISTIC_MISMATCH_PROPOSAL_SCHEMA');
    }
    if (
      readFileSync(join(directory, readmePath), 'utf8') !== projections.readme
      || readFileSync(join(directory, acceptancePath), 'utf8') !== projections.acceptanceTests
    ) throw codedError('VERIFIER_DETERMINISTIC_MISMATCH_PROPOSAL_PROJECTION');
    const { packHash, ...body } = proposal;
    if (
      proposal.mode !== 'PROPOSAL_ONLY'
      || proposal.executable !== false
      || proposal.approvalRequired !== true
      || packHash !== sha256(body)
      || !findingIds.has(proposal.findingId)
      || !proposal.evidenceRefs.every((ref) => evidenceRefs.has(ref))
    ) throw codedError('VERIFIER_DETERMINISTIC_MISMATCH_PROPOSAL_ELIGIBILITY');
    result.push({
      findingId: proposal.findingId,
      solutionId: proposal.solutionId,
      proposalHash: sha256(proposal),
      eligible: true,
    });
  }
  return result.sort((left, right) => left.solutionId.localeCompare(right.solutionId));
}

function rebuildProposals(directory, fileNames, sealed) {
  if (
    !sealed
    || !Array.isArray(sealed.proposals)
    || sealed.commitment !== sha256(sealed.proposals)
  ) throw codedError('VERIFIER_INPUT_INVALID_PROPOSAL_RECONSTRUCTION');
  const proposalPaths = fileNames.filter((name) => name.endsWith('/proposal.json')).sort();
  if (proposalPaths.length !== sealed.proposals.length) {
    throw codedError('VERIFIER_DETERMINISTIC_MISMATCH_PROPOSAL_ELIGIBILITY');
  }
  for (const input of sealed.proposals) {
    const frozenInput = deepFreeze(input);
    let rebuilt;
    try {
      rebuilt = compileProposal({
        finding: frozenInput.finding,
        currentObjects: frozenInput.currentObjects,
        evidenceCutoff: frozenInput.evidenceCutoff,
      });
    } catch {
      throw codedError('VERIFIER_DETERMINISTIC_MISMATCH_PROPOSAL_ELIGIBILITY');
    }
    const path = `solution-packs/${input.solutionId}/proposal.json`;
    if (
      !proposalPaths.includes(path)
      || rebuilt.proposalHash !== input.expectedProposalHash
      || canonicalJson(canonicalJsonFile(readFileSync(join(directory, path))))
        !== canonicalJson(rebuilt.proposal)
    ) throw codedError('VERIFIER_DETERMINISTIC_MISMATCH_PROPOSAL_RECOMPILE');
  }
}

function rebuildMechanisms(sealed, machine) {
  if (
    !sealed
    || !sealed.primary
    || !Array.isArray(sealed.packets)
    || !Array.isArray(sealed.packetBindings)
    || !Array.isArray(sealed.reviewEnvelopes)
    || !sealed.reconciliation
  ) {
    throw codedError('VERIFIER_INPUT_INVALID_TASK7_MECHANISM_INPUTS');
  }
  const { commitment, ...body } = sealed;
  if (commitment !== sha256(body)) {
    throw codedError('VERIFIER_INPUT_INVALID_TASK7_MECHANISM_INPUTS');
  }
  assertCanonicalMechanismOrder(sealed);
  const primary = deepFreeze(sealed.primary);
  if (
    canonicalJson(primary.graph) !== canonicalJson(machine.sealedInputs?.graph)
    || canonicalJson(primary.metrics) !== canonicalJson(machine.metrics)
    || canonicalJson(primary.coverage) !== canonicalJson(
      machine.sealedInputs?.mechanismCoverage,
    )
  ) throw codedError('VERIFIER_DETERMINISTIC_MISMATCH_MECHANISM_PRIMARY_INPUTS');
  let packets;
  let reviews;
  let reconciled;
  try {
    packets = nominateMechanisms({
      ...primary,
      maxCandidates: sealed.maxCandidates,
    }).map((candidate) => buildMechanismPacket(candidate));
    if (canonicalJson(packets) !== canonicalJson(sealed.packets)) {
      throw codedError('VERIFIER_DETERMINISTIC_MISMATCH_MECHANISM_PACKETS');
    }
    reviews = sealed.reviewEnvelopes.map((envelope) => {
      if (
        envelope.requestInputsHash !== sha256(envelope.requestInputs)
        || envelope.responseHash !== sha256(envelope.response)
      ) throw codedError('VERIFIER_DETERMINISTIC_MISMATCH_MECHANISM_REVIEWS');
      deepFreeze(envelope.requestInputs);
      deepFreeze(envelope.response);
      const review = replayMechanismReview({
        requestInputs: envelope.requestInputs,
        response: envelope.response,
      });
      if (review.validationHash !== envelope.validationHash) {
        throw codedError('VERIFIER_DETERMINISTIC_MISMATCH_MECHANISM_REVIEWS');
      }
      return review;
    });
    const reviewedPacketIds = reviews.flatMap(({ packetHashes }) => (
      packetHashes.map(({ packetId }) => packetId)
    ));
    if (
      reviewedPacketIds.length > 3
      || new Set(reviewedPacketIds).size !== reviewedPacketIds.length
    ) throw codedError('VERIFIER_DETERMINISTIC_MISMATCH_MECHANISM_REVIEWS');
    reconciled = reconcileExpertReviews({
      packets,
      reviews,
      maxPromoted: sealed.maxPromoted,
    });
  } catch {
    throw codedError('VERIFIER_DETERMINISTIC_MISMATCH_MECHANISM_RECONSTRUCTION');
  }
  const packetById = new Map(packets.map((packet) => [packet.packetId, packet]));
  const bindingByPacket = new Map();
  const bindingByFinding = new Map();
  for (const binding of sealed.packetBindings) {
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
    ) throw codedError('VERIFIER_DETERMINISTIC_MISMATCH_MECHANISM_BINDINGS');
    bindingByPacket.set(binding.packetId, binding);
    bindingByFinding.set(binding.findingId, binding);
  }
  if (bindingByPacket.size !== packets.length) {
    throw codedError('VERIFIER_DETERMINISTIC_MISMATCH_MECHANISM_BINDINGS');
  }
  const findingFor = (packet) => bindingByPacket.get(packet.packetId)?.findingId;
  const reconstruction = {
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
  if (canonicalJson(reconstruction) !== canonicalJson(sealed.reconciliation)) {
    throw codedError('VERIFIER_DETERMINISTIC_MISMATCH_MECHANISM_RECONSTRUCTION');
  }
  const findings = machine.findings;
  if (findings.some((finding) => (
    bindingByFinding.has(finding.findingId)
    && finding.mechanismPacketId !== bindingByFinding.get(finding.findingId).packetId
  ))) throw codedError('VERIFIER_DETERMINISTIC_MISMATCH_MECHANISM_BINDINGS');
  const laneIds = (lane) => findings
    .filter(({ publicationLane }) => publicationLane === lane)
    .map(({ findingId }) => findingId)
    .filter((findingId) => bindingByFinding.has(findingId))
    .sort();
  if (
    canonicalJson([...reconstruction.criticalFindingIds].sort()) !== canonicalJson(laneIds('critical'))
    || canonicalJson([...reconstruction.promotedFindingIds].sort()) !== canonicalJson(laneIds('commercial'))
    || canonicalJson([...reconstruction.backlogFindingIds].sort()) !== canonicalJson(laneIds('backlog'))
  ) throw codedError('VERIFIER_DETERMINISTIC_MISMATCH_MECHANISM_RECONCILIATION');
  return reconstruction;
}

function validateClaims(machine, evidence, report, coverage) {
  const findings = new Map(machine.findings.map((finding) => [finding.findingId, finding]));
  const evidenceRefs = new Set(evidence.map(({ evidenceRef }) => evidenceRef));
  if (findings.size !== machine.findings.length) {
    throw codedError('VERIFIER_DETERMINISTIC_MISMATCH_FINDING_DEDUPE');
  }
  for (const finding of findings.values()) {
    if (
      !finding.verdicts
      || !Object.values(finding.verdicts).every((value) => VERDICTS.has(value))
      || Object.keys(finding.verdicts).sort().join('|')
        !== ['configuration', 'execution', 'experience', 'outcome'].sort().join('|')
    ) throw codedError('VERIFIER_DETERMINISTIC_MISMATCH_VERDICT');
    if (
      coverage.state === 'complete_partial'
      && finding.coverageScope === 'account_wide'
    ) throw codedError('VERIFIER_SCOPE_VIOLATION_ACCOUNT_WIDE_FINDING');
  }
  for (const claim of machine.claims) {
    const finding = findings.get(claim.findingId);
    if (
      !finding
      || !Array.isArray(claim.evidenceRefs)
      || claim.evidenceRefs.length === 0
      || claim.evidenceRefs.some((ref) => (
        !evidenceRefs.has(ref) || !finding.evidenceRefs.includes(ref)
      ))
      || !report.includes(`[claim:${claim.claimId}; evidence:${claim.evidenceRefs.join(',')}]`)
    ) throw codedError('VERIFIER_DETERMINISTIC_MISMATCH_CLAIM_LINK');
    if (claim.causalBasis === 'SUBJECTIVE_ONLY' || REVENUE_PROMISE.test(claim.text)) {
      throw codedError('VERIFIER_SCOPE_VIOLATION_CAUSAL_CLAIM');
    }
  }
  if (coverage.state === 'complete_partial' && BROAD_PARTIAL_CLAIM.test(report)) {
    throw codedError('VERIFIER_SCOPE_VIOLATION_PARTIAL_REPORT');
  }
  return { findings, evidenceRefs };
}

function validateReview(sample, evidenceRefs) {
  const review = sample.conversationReview;
  if (!review || !Array.isArray(review.judgments)) {
    throw codedError('VERIFIER_INPUT_INVALID_REVIEW');
  }
  const selected = new Set((sample.selections ?? []).map(({ interactionRef }) => interactionRef));
  for (const judgment of review.judgments) {
    if (
      !selected.has(judgment.interactionRef)
      || !Array.isArray(judgment.evidenceRefs)
      || judgment.evidenceRefs.some((ref) => !evidenceRefs.has(ref))
    ) throw codedError('VERIFIER_DETERMINISTIC_MISMATCH_REVIEW_BINDING');
  }
}

function validateBytes(directory, files) {
  for (const name of files) {
    const bytes = readFileSync(join(directory, name));
    const text = bytes.toString('utf8');
    if (PRIVATE_PATTERN.test(text)) throw codedError('VERIFIER_PRIVACY_FAILURE_CANARY');
    if (WRITE_PATTERN.test(text)) throw codedError('VERIFIER_WRITE_TRACE');
    if (name !== 'REPORT.md' && name.endsWith('.json')) {
      const value = canonicalJsonFile(bytes);
      try {
        assertNoExecutionMaterial(value, {
          code: 'VERIFIER_WRITE_TRACE_EXECUTION_MATERIAL',
        });
      } catch (error) {
        if (error?.code?.startsWith('VERIFIER_')) throw error;
        throw codedError('VERIFIER_WRITE_TRACE_EXECUTION_MATERIAL');
      }
    } else if (name.endsWith('.md')) {
      try {
        assertNoExecutionMaterial(text, {
          code: 'VERIFIER_WRITE_TRACE_EXECUTION_MATERIAL',
        });
      } catch (error) {
        if (error?.code?.startsWith('VERIFIER_')) throw error;
        throw codedError('VERIFIER_WRITE_TRACE_EXECUTION_MATERIAL');
      }
    }
    if (name.endsWith('.jsonl')) canonicalJsonl(bytes);
  }
}

export function verifyPublication({ publicationDir } = {}) {
  if (typeof publicationDir !== 'string' || publicationDir.length === 0) {
    throw codedError('VERIFIER_INPUT_INVALID_DIRECTORY', TypeError);
  }
  let root;
  try {
    const metadata = lstatSync(publicationDir);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new Error();
    root = realpathSync(publicationDir);
  } catch {
    throw codedError('VERIFIER_INPUT_INVALID_DIRECTORY');
  }
  const files = listFiles(root).sort();
  if (!files.includes('run-manifest.json') || files.includes('verifier-attestation.json')) {
    throw codedError('VERIFIER_INPUT_INVALID_FILE_SET');
  }
  const before = snapshot(root, files);
  const manifestBytes = readFileSync(join(root, 'run-manifest.json'));
  const manifest = canonicalJsonFile(manifestBytes);
  if (!Array.isArray(manifest.payloadArtifacts)) {
    throw codedError('VERIFIER_INPUT_INVALID_MANIFEST');
  }
  const declared = manifest.payloadArtifacts.map(({ path, sha256: hash }) => {
    if (!safePath(path) || !/^[a-f0-9]{64}$/u.test(hash ?? '')) {
      throw codedError('VERIFIER_INPUT_INVALID_MANIFEST');
    }
    const resolved = realpathSync(join(root, path));
    if (!within(root, resolved)) throw codedError('VERIFIER_INPUT_INVALID_PATH_ESCAPE');
    return path;
  }).sort();
  if (new Set(declared).size !== declared.length) {
    throw codedError('VERIFIER_INPUT_INVALID_MANIFEST');
  }
  const expectedFiles = [...declared, 'run-manifest.json'].sort();
  if (canonicalJson(files) !== canonicalJson(expectedFiles)) {
    throw codedError('VERIFIER_INPUT_INVALID_EXTRA_OR_MISSING_FILE');
  }
  const hashes = {};
  for (const { path, sha256: expectedHash } of manifest.payloadArtifacts) {
    const actualHash = byteHash(readFileSync(join(root, path)));
    if (actualHash !== expectedHash) {
      throw codedError('VERIFIER_DETERMINISTIC_MISMATCH_PAYLOAD_HASH');
    }
    hashes[path] = actualHash;
  }
  if (manifest.publicationRoot !== sha256(hashes)) {
    throw codedError('VERIFIER_DETERMINISTIC_MISMATCH_ROOT');
  }
  validateBytes(root, declared);
  for (const required of [
    'REPORT.md',
    'coverage.json',
    'freshness.json',
    'diff.json',
    'metrics-and-findings.json',
    'conversation-sample.json',
    'evidence-manifest.jsonl',
    'evidence/sanitized/sampling-universe.json',
    'evidence/sanitized/proposal-verification.json',
    'evidence/sanitized/mechanism-verification.json',
  ]) {
    if (!declared.includes(required)) throw codedError('VERIFIER_INPUT_INVALID_MISSING_REQUIRED');
  }
  const report = readFileSync(join(root, 'REPORT.md'), 'utf8');
  const coverage = canonicalJsonFile(readFileSync(join(root, 'coverage.json')));
  const machine = canonicalJsonFile(readFileSync(join(root, 'metrics-and-findings.json')));
  const sample = canonicalJsonFile(readFileSync(join(root, 'conversation-sample.json')));
  const samplingUniverse = canonicalJsonFile(readFileSync(
    join(root, 'evidence/sanitized/sampling-universe.json'),
  ));
  const proposalVerification = canonicalJsonFile(readFileSync(
    join(root, 'evidence/sanitized/proposal-verification.json'),
  ));
  const mechanismVerification = canonicalJsonFile(readFileSync(
    join(root, 'evidence/sanitized/mechanism-verification.json'),
  ));
  const evidence = canonicalJsonl(readFileSync(join(root, 'evidence-manifest.jsonl')));
  const { findings, evidenceRefs } = validateClaims(machine, evidence, report, coverage);
  const {
    payloadArtifacts: _payloadArtifacts,
    publicationRoot: _publicationRoot,
    ...manifestInput
  } = manifest;
  if (canonicalJson(manifestInput) !== canonicalJson(machine.sealedInputs?.run)) {
    throw codedError('VERIFIER_DETERMINISTIC_MISMATCH_MANIFEST');
  }
  const sealedGraph = deepFreeze(machine.sealedInputs?.graph);
  const sealedMetricContracts = deepFreeze(machine.sealedInputs?.metricContracts);
  const sealedWindows = deepFreeze(machine.sealedInputs?.windows);
  let rebuiltMetrics;
  try {
    rebuiltMetrics = computeJourneyMetrics({
      graph: sealedGraph,
      metricContracts: sealedMetricContracts,
      windows: sealedWindows,
    });
  } catch {
    throw codedError('VERIFIER_INPUT_INVALID_DETERMINISTIC_INPUTS');
  }
  if (canonicalJson(rebuiltMetrics) !== canonicalJson(machine.metrics)) {
    throw codedError('VERIFIER_DETERMINISTIC_MISMATCH_METRICS');
  }
  validateSampleStructure(sample);
  rebuildSample(sample, samplingUniverse);
  rebuildProposals(root, declared, proposalVerification);
  const rebuiltMechanisms = rebuildMechanisms(mechanismVerification, machine);
  validateFindingFormulas(machine.findings);
  validateReview(sample, evidenceRefs);
  const expectedVerification = {
    coverageClass: coverage.state,
    metricHash: sha256(machine.metrics),
    cohortHash: sha256(machine.metrics.cohorts ?? {}),
    sampleHash: recomputeSampleHash(sample),
    priorityOrder: rebuiltMechanisms.priorityFindingIds,
    overlapDedupe: [...new Set(machine.findings.map(({ fingerprint, findingId }) => (
      fingerprint ?? findingId
    )))].sort(),
    proposalEligibility: proposalEligibility(root, declared, evidenceRefs, new Set(findings.keys())),
    claimsHash: sha256(machine.claims),
  };
  if (canonicalJson(machine.verification) !== canonicalJson(expectedVerification)) {
    throw codedError('VERIFIER_DETERMINISTIC_MISMATCH_RECOMPUTE');
  }
  assertSameSnapshot(before, snapshot(root, files));
  return deepFreeze({
    schemaVersion: '1.0.0',
    verifierVersion: '1.0.0',
    result: 'pass',
    manifestHash: sha256(manifest),
    publicationRoot: manifest.publicationRoot,
    checks: [
      'closed_file_set',
      'canonical_bytes',
      'payload_hashes',
      'publication_root',
      'coverage_scope',
      'sample_membership_hash',
      'finding_priority',
      'proposal_eligibility',
      'claim_provenance',
      'privacy_and_write_trace',
      'stable_read_snapshot',
    ],
  });
}
