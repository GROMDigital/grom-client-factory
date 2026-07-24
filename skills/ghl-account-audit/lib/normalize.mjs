import { canonicalJson, sha256 } from './canonical.mjs';

function codedError(code, ErrorType = Error) {
  return Object.assign(new ErrorType(code), { code });
}

function isPlainObject(value) {
  return Boolean(
    value
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
  );
}

function clone(value, code = 'EVIDENCE_VALUE_INVALID') {
  try {
    return JSON.parse(canonicalJson(value));
  } catch {
    throw codedError(code, TypeError);
  }
}

function isCanonicalTimestamp(value) {
  if (typeof value !== 'string') return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function assertLocation(value, locationId, seen = new WeakSet()) {
  if (!value || typeof value !== 'object') return;
  if (seen.has(value)) throw codedError('EVIDENCE_VALUE_INVALID', TypeError);
  seen.add(value);
  try {
    for (const [key, nested] of Object.entries(value)) {
      const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/gu, '');
      if (
        ['boundlocationid', 'ghllocationid', 'locationid'].includes(normalizedKey)
        && nested !== locationId
      ) throw codedError('EVIDENCE_LOCATION_MISMATCH');
      assertLocation(nested, locationId, seen);
    }
  } finally {
    seen.delete(value);
  }
}

function assertWindow(window, code) {
  if (
    !isPlainObject(window)
    || Object.keys(window).sort().join(',') !== 'from,to'
    || typeof window.from !== 'string'
    || typeof window.to !== 'string'
    || !isCanonicalTimestamp(window.from)
    || !isCanonicalTimestamp(window.to)
    || Date.parse(window.from) >= Date.parse(window.to)
  ) throw codedError(code, TypeError);
}

function validateCollection(collection, locationId) {
  if (
    !isPlainObject(collection)
    || typeof collection.source !== 'string'
    || collection.source.length === 0
    || typeof collection.operationId !== 'string'
    || collection.operationId.length === 0
    || collection.boundLocationId !== locationId
    || !isCanonicalTimestamp(collection.capturedAt)
    || !Array.isArray(collection.items)
    || !isPlainObject(collection.page)
    || typeof collection.page.complete !== 'boolean'
    || typeof collection.page.truncated !== 'boolean'
    || !Number.isInteger(collection.page.collectedCount)
    || collection.page.collectedCount !== collection.items.length
    || !Number.isInteger(collection.page.reportedCount)
  ) throw codedError(
    collection?.boundLocationId !== locationId
      ? 'EVIDENCE_LOCATION_MISMATCH'
      : 'EVIDENCE_COLLECTION_INVALID',
    TypeError,
  );
  assertWindow(collection.requestedWindow, 'EVIDENCE_COLLECTION_INVALID');
  assertWindow(collection.appliedWindow, 'EVIDENCE_COLLECTION_INVALID');
  if (
    Date.parse(collection.appliedWindow.from) < Date.parse(collection.requestedWindow.from)
    || Date.parse(collection.appliedWindow.to) > Date.parse(collection.requestedWindow.to)
  ) throw codedError('EVIDENCE_WINDOW_MISMATCH');
  if (
    collection.page.complete
    && (
      collection.page.truncated
      || collection.page.nextCursor !== null
      || collection.page.reportedCount !== collection.items.length
      || Object.hasOwn(collection, 'incompleteReason')
    )
  ) throw codedError('EVIDENCE_COLLECTION_INVALID');
  if (!collection.page.complete && typeof collection.incompleteReason !== 'string') {
    throw codedError('EVIDENCE_COLLECTION_INVALID');
  }
}

function normalizeItem(item, provenance, index) {
  if (!isPlainObject(item) || typeof item.recordType !== 'string' || item.recordType.length === 0) {
    throw codedError('EVIDENCE_RECORD_INVALID', TypeError);
  }
  if (
    (Object.hasOwn(item, 'eventTime') && !isCanonicalTimestamp(item.eventTime))
    || (Object.hasOwn(item, 'evidenceRef') && (
      typeof item.evidenceRef !== 'string' || !/^ev_[a-f0-9]{16,64}$/u.test(item.evidenceRef)
    ))
    || (Object.hasOwn(item, 'definitionHash') && !/^[a-f0-9]{64}$/u.test(item.definitionHash))
    || (
      Object.hasOwn(item, 'effectiveDefinitionHash')
      && !/^[a-f0-9]{64}$/u.test(item.effectiveDefinitionHash)
    )
  ) throw codedError('EVIDENCE_RECORD_INVALID', TypeError);
  const eventTypes = new Set([
    'journey_event',
    'portal_milestone',
    'workflow_execution',
    'handoff',
  ]);
  if (eventTypes.has(item.recordType) && !isCanonicalTimestamp(item.eventTime)) {
    throw codedError('EVIDENCE_RECORD_INVALID', TypeError);
  }
  if (
    ['journey_event', 'portal_milestone'].includes(item.recordType)
    && (
      typeof item.journeyId !== 'string'
      || item.journeyId.length === 0
      || typeof item.journeyInstanceId !== 'string'
      || item.journeyInstanceId.length === 0
    )
  ) throw codedError('EVIDENCE_RECORD_INVALID', TypeError);
  if (
    item.recordType === 'handoff'
    && (
      typeof item.fromJourneyId !== 'string'
      || item.fromJourneyId.length === 0
      || typeof item.toJourneyId !== 'string'
      || item.toJourneyId.length === 0
      || item.fromJourneyId === item.toJourneyId
    )
  ) throw codedError('EVIDENCE_RECORD_INVALID', TypeError);
  if (
    item.recordType === 'workflow_execution'
    && (typeof item.workflowNativeId !== 'string' || item.workflowNativeId.length === 0)
  ) throw codedError('EVIDENCE_RECORD_INVALID', TypeError);
  for (const field of [
    'nativeId',
    'subjectNativeId',
    'organizationNativeId',
    'opportunityNativeId',
    'projectNativeId',
    'workflowNativeId',
    'normalizedEmail',
    'normalizedPhone',
  ]) {
    if (Object.hasOwn(item, field) && (typeof item[field] !== 'string' || item[field].length === 0)) {
      throw codedError('EVIDENCE_RECORD_INVALID', TypeError);
    }
  }
  if (
    Object.hasOwn(item, 'classification')
    && !['OBSERVED', 'UNKNOWN', 'NOT_APPLICABLE'].includes(item.classification)
  ) throw codedError('EVIDENCE_RECORD_INVALID', TypeError);
  const sourceItem = clone(item, 'EVIDENCE_RECORD_INVALID');
  const evidenceRef = typeof sourceItem.evidenceRef === 'string'
    ? sourceItem.evidenceRef
    : `ev_${sha256({ provenance, index, sourceItem }).slice(0, 32)}`;
  const canonical = {
    ...sourceItem,
    evidenceRef,
    source: provenance.source,
    operationId: provenance.operationId,
    boundLocationId: provenance.boundLocationId,
    requestedWindow: provenance.requestedWindow,
    appliedWindow: provenance.appliedWindow,
    capturedAt: provenance.capturedAt,
    classification: provenance.completeness === 'COMPLETE'
      ? (sourceItem.classification ?? 'OBSERVED')
      : 'UNKNOWN',
    provenance,
  };
  canonical.recordId = `record_${sha256(canonical).slice(0, 32)}`;
  return canonical;
}

export function normalizeEvidence(records, context) {
  if (
    !Array.isArray(records)
    || records.length === 0
    || !isPlainObject(context)
    || typeof context.locationId !== 'string'
    || context.locationId.length === 0
  ) throw codedError('EVIDENCE_NORMALIZATION_INPUT_INVALID', TypeError);

  const normalized = [];
  for (const collection of records) {
    validateCollection(collection, context.locationId);
    const provenance = Object.freeze({
      source: collection.source,
      operationId: collection.operationId,
      boundLocationId: collection.boundLocationId,
      requestedWindow: clone(collection.requestedWindow),
      appliedWindow: clone(collection.appliedWindow),
      capturedAt: collection.capturedAt,
      completeness: collection.page.complete ? 'COMPLETE' : 'INCOMPLETE',
      incompleteReason: collection.page.complete ? null : collection.incompleteReason,
    });
    assertLocation(collection.items, context.locationId);
    if (collection.items.length === 0 && !collection.page.complete) {
      normalized.push(normalizeItem({
        recordType: 'collection_status',
        status: 'UNKNOWN',
        reason: collection.incompleteReason,
      }, provenance, 0));
      continue;
    }
    collection.items.forEach((item, index) => {
      normalized.push(normalizeItem(item, provenance, index));
    });
  }
  normalized.sort((left, right) => left.recordId.localeCompare(right.recordId));
  return Object.freeze(normalized.map((record) => Object.freeze(record)));
}
