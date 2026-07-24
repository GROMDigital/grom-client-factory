import { randomBytes } from 'node:crypto';
import { sha256 } from './canonical.mjs';

const HASH = /^[a-f0-9]{64}$/u;
const NONCE = /^[a-f0-9]{32}$/u;
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
const REQUEST_KEYS = [
  'schemaVersion', 'runId', 'sampleHash', 'packetHash', 'promptHash', 'rubricHash',
  'modelPolicyHash', 'codeHash', 'evidenceSetHash', 'cutoff', 'grants', 'nonce',
  'requestId', 'requestHash',
];
const RESPONSE_KEYS = [
  'requestId', 'nonce', 'requestHash', 'runId', 'sampleHash', 'packetHash',
  'promptHash', 'rubricHash', 'modelPolicyHash', 'codeHash', 'evidenceSetHash',
  'reviewedAt', 'usage', 'reviewer', 'judgments',
];
const JUDGMENT_KEYS = [
  'interactionRef', 'evidenceRefs', 'transcriptAvailability', 'state', 'scores',
  'counterevidence', 'uncertainty', 'safetyFlags',
];
const REQUESTS = new Map();

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

function validateSerializedRequest(request) {
  if (
    !exactKeys(request, REQUEST_KEYS)
    || request.schemaVersion !== '1.0.0'
    || !NONCE.test(request.nonce)
    || request.requestId !== `review_${request.nonce}`
    || !ensureHash(request.requestHash)
    || !Array.isArray(request.grants)
  ) throw codedError('REVIEW_REQUEST_UNTRUSTED');
  const { requestHash, ...sealed } = request;
  if (sha256(sealed) !== requestHash) throw codedError('REVIEW_REQUEST_UNTRUSTED');
}

function requestState(request) {
  validateSerializedRequest(request);
  const state = REQUESTS.get(request.requestId);
  if (!state || state.requestHash !== request.requestHash || state.nonce !== request.nonce) {
    throw codedError('REVIEW_REQUEST_UNTRUSTED');
  }
  return state;
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
    || modelPolicy.maxJudgments < sample.selections.length
    || !Number.isInteger(modelPolicy.maxOutputTokens)
    || modelPolicy.maxOutputTokens < 1
    || !Array.isArray(modelPolicy.allowedTools)
    || modelPolicy.allowedTools.length !== 0
  ) throw codedError('REVIEW_REQUEST_INVALID', TypeError);
  const { sampleHash: declaredSampleHash, ...sampleBody } = sample;
  if (sha256(sampleBody) !== declaredSampleHash) throw codedError('REVIEW_SAMPLE_HASH_MISMATCH');

  const selectionByEvidence = new Map();
  const interactionEvidence = new Map();
  for (const selection of sample.selections) {
    if (
      !plain(selection)
      || !INTERACTION_REF.test(selection.interactionRef)
      || !Array.isArray(selection.evidenceRefs)
      || selection.evidenceRefs.length === 0
      || !selection.evidenceRefs.every((ref) => EVIDENCE_REF.test(ref))
      || interactionEvidence.has(selection.interactionRef)
    ) throw codedError('REVIEW_REQUEST_INVALID', TypeError);
    const refs = new Set(selection.evidenceRefs);
    interactionEvidence.set(selection.interactionRef, refs);
    for (const ref of refs) {
      if (selectionByEvidence.has(ref)) throw codedError('REVIEW_REQUEST_INVALID');
      selectionByEvidence.set(ref, selection.interactionRef);
    }
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
  const nonce = randomBytes(16).toString('hex');
  const sealedGrants = grants.map((grant) => ({
    ...grant,
    interactionRef: selectionByEvidence.get(grant.evidenceRef),
  }));
  const sealed = {
    schemaVersion: '1.0.0',
    runId: run.runId,
    sampleHash: sample.sampleHash,
    packetHash: run.packetHash,
    promptHash,
    rubricHash,
    modelPolicyHash,
    codeHash: run.codeHash,
    evidenceSetHash: sha256(evidenceRefs),
    cutoff: run.cutoff,
    grants: sealedGrants,
    nonce,
    requestId: `review_${nonce}`,
  };
  const request = deepFreeze({ ...sealed, requestHash: sha256(sealed) });
  REQUESTS.set(request.requestId, {
    requestHash: request.requestHash,
    nonce,
    consumedResponse: false,
    grants: new Map(sealedGrants.map((grant) => [grant.grantRef, {
      ...grant,
      status: 'UNREAD',
      transcriptAvailability: null,
    }])),
    interactionEvidence,
    interactionRefs: new Set(interactionEvidence.keys()),
    modelPolicy: structuredClone(modelPolicy),
  });
  return request;
}

function unavailableRead(grant, transcriptAvailability, reasonCode) {
  grant.status = 'CONSUMED';
  grant.transcriptAvailability = transcriptAvailability;
  return deepFreeze({
    state: 'NOT_REVIEWABLE',
    transcriptAvailability,
    evidenceRef: grant.evidenceRef,
    reasonCode,
  });
}

export async function readSelectedEvidence({
  request,
  grantRef,
  now,
  readEvidence,
}) {
  const state = requestState(request);
  const grant = state.grants.get(grantRef);
  if (!grant) throw codedError('REVIEW_GRANT_UNREFERENCED');
  if (!iso(now)) throw codedError('REVIEW_TIME_INVALID', TypeError);
  if (grant.status !== 'UNREAD') throw codedError('REVIEW_GRANT_CONSUMED');
  if (typeof readEvidence !== 'function') throw codedError('REVIEW_READER_INVALID', TypeError);
  if (Date.parse(now) >= Date.parse(grant.expiresAt)) {
    return unavailableRead(grant, 'EXPIRED', 'REVIEW_GRANT_EXPIRED');
  }
  grant.status = 'READING';
  try {
    const evidence = await readEvidence({
      grantRef: grant.grantRef,
      evidenceRef: grant.evidenceRef,
      requestHash: request.requestHash,
      nonce: request.nonce,
    });
    if (evidence === undefined || evidence === null) {
      return unavailableRead(grant, 'MISSING', 'REVIEW_EVIDENCE_MISSING');
    }
    grant.status = 'CONSUMED';
    grant.transcriptAvailability = 'AVAILABLE';
    return deepFreeze({
      state: 'AVAILABLE',
      transcriptAvailability: 'AVAILABLE',
      evidenceRef: grant.evidenceRef,
      evidence,
    });
  } catch {
    return unavailableRead(grant, 'MISSING', 'REVIEW_EVIDENCE_READ_FAILED');
  }
}

function validateJudgment(judgment, state) {
  const assignedEvidence = state.interactionEvidence.get(judgment?.interactionRef);
  if (
    !exactKeys(judgment, JUDGMENT_KEYS)
    || !INTERACTION_REF.test(judgment.interactionRef)
    || !state.interactionRefs.has(judgment.interactionRef)
    || !Array.isArray(judgment.evidenceRefs)
    || judgment.evidenceRefs.length === 0
    || !judgment.evidenceRefs.every((ref) => EVIDENCE_REF.test(ref) && assignedEvidence?.has(ref))
    || !Array.isArray(judgment.counterevidence)
    || !judgment.counterevidence.every((ref) => EVIDENCE_REF.test(ref) && assignedEvidence?.has(ref))
    || !['AVAILABLE', 'MISSING', 'EXPIRED'].includes(judgment.transcriptAvailability)
    || !['REVIEWED', 'NOT_REVIEWABLE'].includes(judgment.state)
    || !['low', 'medium', 'high'].includes(judgment.uncertainty)
    || !Array.isArray(judgment.safetyFlags)
    || !judgment.safetyFlags.every((flag) => typeof flag === 'string')
  ) throw codedError('REVIEW_RESPONSE_UNREFERENCED');

  const grants = [...state.grants.values()].filter(({ interactionRef }) => (
    interactionRef === judgment.interactionRef
  ));
  const expectedAvailability = grants.some(({ transcriptAvailability }) => (
    transcriptAvailability === 'EXPIRED'
  )) ? 'EXPIRED' : grants.some(({ transcriptAvailability }) => (
    transcriptAvailability === 'MISSING'
  )) ? 'MISSING' : 'AVAILABLE';
  if (judgment.transcriptAvailability !== expectedAvailability) {
    throw codedError('REVIEW_RESPONSE_MISMATCH');
  }
  if (judgment.state === 'NOT_REVIEWABLE') {
    if (expectedAvailability === 'AVAILABLE' || judgment.scores !== null) {
      throw codedError('REVIEW_RESPONSE_INVALID');
    }
  } else if (
    expectedAvailability !== 'AVAILABLE'
    || !plain(judgment.scores)
    || Object.keys(judgment.scores).length === 0
    || Object.keys(judgment.scores).some((key) => !SCORE_KEYS.has(key))
    || Object.values(judgment.scores).some((score) => (
      !Number.isInteger(score) || score < 1 || score > 5
    ))
  ) throw codedError('REVIEW_RESPONSE_INVALID');
}

export function ingestConversationReview({ request, response }) {
  const state = requestState(request);
  if (state.consumedResponse) throw codedError('REVIEW_RESPONSE_REPLAYED');
  if (!exactKeys(response, RESPONSE_KEYS)) throw codedError('REVIEW_RESPONSE_INVALID');
  const bindings = [
    'requestId', 'nonce', 'requestHash', 'runId', 'sampleHash', 'packetHash',
    'promptHash', 'rubricHash', 'modelPolicyHash', 'codeHash', 'evidenceSetHash',
  ];
  if (bindings.some((key) => response[key] !== request[key])) {
    throw codedError('REVIEW_RESPONSE_MISMATCH');
  }
  if (!iso(response.reviewedAt)) throw codedError('REVIEW_RESPONSE_INVALID');
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
  ) throw codedError('REVIEW_RESPONSE_INVALID');
  if ([...state.grants.values()].some(({ status }) => status !== 'CONSUMED')) {
    throw codedError('REVIEW_GRANTS_NOT_CONSUMED');
  }
  if (
    response.judgments.length !== state.interactionRefs.size
    || response.judgments.length > state.modelPolicy.maxJudgments
    || new Set(response.judgments.map(({ interactionRef }) => interactionRef)).size
      !== response.judgments.length
  ) throw codedError('REVIEW_RESPONSE_INCOMPLETE');
  for (const judgment of response.judgments) validateJudgment(judgment, state);
  for (const judgment of response.judgments.filter(({ state: value }) => value === 'REVIEWED')) {
    const expired = [...state.grants.values()].some((grant) => (
      grant.interactionRef === judgment.interactionRef
        && Date.parse(response.reviewedAt) >= Date.parse(grant.expiresAt)
    ));
    if (expired) throw codedError('REVIEW_RESPONSE_STALE');
  }
  const output = deepFreeze({
    schemaVersion: '1.0.0',
    kind: 'SUBJECTIVE_CONVERSATION_REVIEW',
    nonce: request.nonce,
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
