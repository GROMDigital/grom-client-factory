import {
  ingestConversationReview,
  readSelectedEvidence,
} from '../lib/review-bridge.mjs';

export function reviewConversations({
  request,
  now,
  readEvidence,
  fixtureResponse,
}) {
  if (!fixtureResponse) throw Object.assign(new Error('REVIEW_FIXTURE_REQUIRED'), {
    code: 'REVIEW_FIXTURE_REQUIRED',
  });
  for (const { grantRef } of request.grants) {
    readSelectedEvidence({ request, grantRef, now, readEvidence });
  }
  return ingestConversationReview({ request, response: fixtureResponse });
}
