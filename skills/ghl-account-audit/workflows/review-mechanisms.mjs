import { ingestMechanismReview } from '../lib/mechanisms.mjs';

function freeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) freeze(child, seen);
  return Object.freeze(value);
}
export function reviewMechanisms({ request, fixtureResponse, callModel } = {}) {
  void callModel;
  if (fixtureResponse === undefined) {
    return freeze({
      state: 'awaiting_model_review',
      requestId: request?.requestId,
      requestHash: request?.requestHash,
      nonceRef: request?.nonceRef,
    });
  }
  return freeze({
    state: 'review_ingested',
    review: ingestMechanismReview({ request, response: fixtureResponse }),
  });
}
