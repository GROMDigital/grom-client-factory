import {
  ingestConversationReview,
  readSelectedEvidence,
} from '../lib/review-bridge.mjs';

export async function reviewConversations({
  request,
  now,
  readEvidence,
  fixtureResponse,
}) {
  if (!fixtureResponse) throw Object.assign(new Error('REVIEW_FIXTURE_REQUIRED'), {
    code: 'REVIEW_FIXTURE_REQUIRED',
  });
  const availabilityByInteraction = new Map();
  for (const { grantRef, interactionRef } of request.grants) {
    const result = await readSelectedEvidence({
      request,
      grantRef,
      now,
      readEvidence,
    });
    const current = availabilityByInteraction.get(interactionRef) ?? [];
    current.push(result.transcriptAvailability);
    availabilityByInteraction.set(interactionRef, current);
  }
  const response = structuredClone(fixtureResponse);
  response.judgments = response.judgments.map((judgment) => {
    const interactionAvailability = availabilityByInteraction.get(judgment.interactionRef) ?? [];
    const availability = interactionAvailability.includes('EXPIRED')
      ? 'EXPIRED'
      : interactionAvailability.includes('MISSING') ? 'MISSING' : 'AVAILABLE';
    if (availability === 'AVAILABLE') return judgment;
    return {
      interactionRef: judgment.interactionRef,
      evidenceRefs: judgment.evidenceRefs,
      transcriptAvailability: availability,
      state: 'NOT_REVIEWABLE',
      scores: null,
      counterevidence: [],
      uncertainty: 'high',
      safetyFlags: ['private_evidence_unavailable'],
    };
  });
  return ingestConversationReview({ request, response });
}
