import { sha256 } from './canonical.mjs';

const HASH = /^[a-f0-9]{64}$/u;
const EVIDENCE_REF = /^ev_[a-f0-9]{16,64}$/u;
const INTERACTION_REF = /^obj_[a-f0-9]{16,64}$/u;
const ACTOR_REF = /^actor_[a-f0-9]{16,64}$/u;
const GRANT_REF = /^grant_[a-f0-9]{16,64}$/u;
const SCORE_KEYS = new Set([
  'intentRecognition',
  'accuracyAndRelevance',
  'qualification',
  'objectionHandling',
  'bookingBehavior',
  'nextActionClarity',
  'handoffQuality',
  'toneAndCompliance',
  'unresolvedCustomerEffort',
]);
const REQUESTS = new WeakMap();

function codedError(code, ErrorType = Error) {
  return Object.assign(new ErrorType(code), { code });
}

function plain(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
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

function ensureHash(value) {
  return typeof value === 'string' && HASH.test(value);
}

function inputHash(value, idKey, contentKey) {
  if (!plain(value) || typeof value[idKey] !== 'string' || typeof value[contentKey] !== 'string') {
    throw codedError('REVIEW_REQUEST_INVALID', TypeError);
  }
  return sha256(value);
}

export function createConversationReviewRequest({
  run,
  sample,
  vaultGrants,
  rubric,
  prompt,
  modelPolicy,
}) {
  if (
    !plain(run)
    || typeof run.runId !== 'string'
    || !ensureHash(run.packetHash)
    || !ensureHash(run.codeHash)
    || !iso(run.cutoff)
    || !plain(sample)
    || !ensureHash(sample.sampleHash)
    || !Array.isArray(sample.selections)
    || !Array.isArray(vaultGrants)
    || !exactKeys(modelPolicy, [
      'policyId', 'provider', 'model', 'maxJudgments', 'maxOutputTokens', 'allowedTools',
    ])
    || typeof modelPolicy.policyId !== 'string'
    || typeof modelPolicy.provider !== 'string'
    || typeof modelPolicy.model !== 'string'
    || !Number.isInteger(modelPolicy.maxJudgments)
    || modelPolicy.maxJudgments < 0
    || !Number.isInteger(modelPolicy.maxOutputTokens)
    || modelPolicy.maxOutputTokens < 1
    || !Array.isArray(modelPolicy.allowedTools)
    || modelPolicy.allowedTools.length !== 0
  ) throw codedError('REVIEW_REQUEST_INVALID', TypeError);
  const { sampleHash: declaredSampleHash, ...sampleBody } = sample;
  if (sha256(sampleBody) !== declaredSampleHash) {
    throw codedError('REVIEW_SAMPLE_HASH_MISMATCH');
  }
  const selectionByEvidence = new Map();
  for (const selection of sample.selections) {
    if (
      !plain(selection)
      || !INTERACTION_REF.test(selection.interactionRef)
      || !Array.isArray(selection.evidenceRefs)
      || !selection.evidenceRefs.every((ref) => EVIDENCE_REF.test(ref))
    ) throw codedError('REVIEW_REQUEST_INVALID', TypeError);
    for (const ref of selection.evidenceRefs) selectionByEvidence.set(ref, selection.interactionRef);
  }
  const grants = vaultGrants.map((grant) => {
    if (
      !exactKeys(grant, ['grantRef', 'evidenceRef', 'expiresAt', 'readOnce'])
      || !GRANT_REF.test(grant.grantRef)
      || !EVIDENCE_REF.test(grant.evidenceRef)
      || !selectionByEvidence.has(grant.evidenceRef)
      || !iso(grant.expiresAt)
      || grant.readOnce !== true
    ) throw codedError('REVIEW_GRANT_INVALID', TypeError);
    return { ...grant };
  }).sort((left, right) => left.grantRef.localeCompare(right.grantRef));
  if (
    new Set(grants.map(({ grantRef }) => grantRef)).size !== grants.length
    || new Set(grants.map(({ evidenceRef }) => evidenceRef)).size !== grants.length
    || grants.length !== selectionByEvidence.size
  ) throw codedError('REVIEW_GRANT_INVALID');

  const promptHash = inputHash(prompt, 'promptId', 'content');
  const rubricHash = inputHash(rubric, 'rubricId', 'content');
  const modelPolicyHash = sha256(modelPolicy);
  const evidenceRefs = [...selectionByEvidence.keys()].sort();
  const evidenceSetHash = sha256(evidenceRefs);
  const body = {
    schemaVersion: '1.0.0',
    runId: run.runId,
    sampleHash: sample.sampleHash,
    packetHash: run.packetHash,
    promptHash,
    rubricHash,
    modelPolicyHash,
    codeHash: run.codeHash,
    evidenceSetHash,
    cutoff: run.cutoff,
    grants,
  };
  const requestHash = sha256(body);
  const request = deepFreeze({
    ...body,
    requestId: `review_${requestHash.slice(0, 32)}`,
    requestHash,
  });
  REQUESTS.set(request, {
    consumedResponse: false,
    consumedGrants: new Set(),
    evidenceRefs: new Set(evidenceRefs),
    interactionRefs: new Set(sample.selections.map(({ interactionRef }) => interactionRef)),
    interactionEvidence: new Map(sample.selections.map(({ interactionRef, evidenceRefs: refs }) => (
      [interactionRef, new Set(refs)]
    ))),
    modelPolicy: structuredClone(modelPolicy),
  });
  return request;
}

export function readSelectedEvidence({
  request,
  grantRef,
  now,
  readEvidence,
}) {
  const state = REQUESTS.get(request);
  if (!state) throw codedError('REVIEW_REQUEST_UNTRUSTED');
  const grant = request.grants.find((candidate) => candidate.grantRef === grantRef);
  if (!grant) throw codedError('REVIEW_GRANT_UNREFERENCED');
  if (!iso(now)) throw codedError('REVIEW_TIME_INVALID', TypeError);
  if (Date.parse(now) >= Date.parse(grant.expiresAt)) throw codedError('REVIEW_GRANT_EXPIRED');
  if (state.consumedGrants.has(grantRef)) throw codedError('REVIEW_GRANT_CONSUMED');
  if (typeof readEvidence !== 'function') throw codedError('REVIEW_READER_INVALID', TypeError);
  const value = readEvidence({
    grantRef: grant.grantRef,
    evidenceRef: grant.evidenceRef,
    requestHash: request.requestHash,
  });
  state.consumedGrants.add(grantRef);
  return value;
}

const RESPONSE_KEYS = [
  'requestId', 'requestHash', 'runId', 'sampleHash', 'packetHash', 'promptHash',
  'rubricHash', 'modelPolicyHash', 'codeHash', 'evidenceSetHash', 'reviewedAt',
  'usage', 'reviewer', 'judgments',
];
const JUDGMENT_KEYS = [
  'interactionRef', 'evidenceRefs', 'transcriptAvailability', 'state', 'scores',
  'counterevidence', 'uncertainty', 'safetyFlags',
];

function validateJudgment(judgment, state) {
  const assignedEvidence = state.interactionEvidence.get(judgment?.interactionRef);
  if (
    !exactKeys(judgment, JUDGMENT_KEYS)
    || !INTERACTION_REF.test(judgment.interactionRef)
    || !state.interactionRefs.has(judgment.interactionRef)
    || !Array.isArray(judgment.evidenceRefs)
    || judgment.evidenceRefs.length === 0
    || !judgment.evidenceRefs.every((ref) => (
      EVIDENCE_REF.test(ref) && assignedEvidence?.has(ref)
    ))
    || !Array.isArray(judgment.counterevidence)
    || !judgment.counterevidence.every((ref) => (
      EVIDENCE_REF.test(ref) && assignedEvidence?.has(ref)
    ))
    || !['AVAILABLE', 'MISSING', 'EXPIRED'].includes(judgment.transcriptAvailability)
    || !['REVIEWED', 'NOT_REVIEWABLE'].includes(judgment.state)
    || !['low', 'medium', 'high'].includes(judgment.uncertainty)
    || !Array.isArray(judgment.safetyFlags)
    || !judgment.safetyFlags.every((flag) => typeof flag === 'string')
  ) throw codedError('REVIEW_RESPONSE_UNREFERENCED');
  if (judgment.state === 'NOT_REVIEWABLE') {
    if (judgment.transcriptAvailability === 'AVAILABLE' || judgment.scores !== null) {
      throw codedError('REVIEW_RESPONSE_INVALID');
    }
  } else if (
    judgment.transcriptAvailability !== 'AVAILABLE'
    || !plain(judgment.scores)
    || Object.keys(judgment.scores).length === 0
    || Object.keys(judgment.scores).some((key) => !SCORE_KEYS.has(key))
    || Object.values(judgment.scores).some((score) => (
      !Number.isInteger(score) || score < 1 || score > 5
    ))
  ) throw codedError('REVIEW_RESPONSE_INVALID');
}

export function ingestConversationReview({ request, response }) {
  const state = REQUESTS.get(request);
  if (!state) throw codedError('REVIEW_REQUEST_UNTRUSTED');
  if (state.consumedResponse) throw codedError('REVIEW_RESPONSE_REPLAYED');
  if (!exactKeys(response, RESPONSE_KEYS)) throw codedError('REVIEW_RESPONSE_INVALID');
  const bindings = [
    'requestId', 'requestHash', 'runId', 'sampleHash', 'packetHash', 'promptHash',
    'rubricHash', 'modelPolicyHash', 'codeHash', 'evidenceSetHash',
  ];
  if (bindings.some((key) => response[key] !== request[key])) {
    throw codedError('REVIEW_RESPONSE_MISMATCH');
  }
  if (!iso(response.reviewedAt)) throw codedError('REVIEW_RESPONSE_INVALID');
  if (request.grants.some(({ expiresAt }) => Date.parse(response.reviewedAt) >= Date.parse(expiresAt))) {
    throw codedError('REVIEW_RESPONSE_STALE');
  }
  if (
    !exactKeys(response.usage, ['outputTokens'])
    || !Number.isInteger(response.usage.outputTokens)
    || response.usage.outputTokens < 0
    || response.usage.outputTokens > state.modelPolicy.maxOutputTokens
  ) throw codedError('REVIEW_RESPONSE_OVER_BUDGET');
  if (
    !exactKeys(response.reviewer, ['kind', 'provider', 'model', 'reviewerRef'])
    || !['model', 'human'].includes(response.reviewer.kind)
    || typeof response.reviewer.provider !== 'string'
    || typeof response.reviewer.model !== 'string'
    || !ACTOR_REF.test(response.reviewer.reviewerRef)
    || response.reviewer.provider !== state.modelPolicy.provider
    || response.reviewer.model !== state.modelPolicy.model
    || !Array.isArray(response.judgments)
    || response.judgments.length > state.modelPolicy.maxJudgments
  ) throw codedError('REVIEW_RESPONSE_INVALID');
  for (const judgment of response.judgments) validateJudgment(judgment, state);
  if (new Set(response.judgments.map(({ interactionRef }) => interactionRef)).size !== response.judgments.length) {
    throw codedError('REVIEW_RESPONSE_INVALID');
  }
  const output = deepFreeze({
    schemaVersion: '1.0.0',
    kind: 'SUBJECTIVE_CONVERSATION_REVIEW',
    requestHash: request.requestHash,
    runId: request.runId,
    sampleHash: request.sampleHash,
    reviewedAt: response.reviewedAt,
    reviewer: structuredClone(response.reviewer),
    judgments: structuredClone(response.judgments),
  });
  state.consumedResponse = true;
  return output;
}
