import { canonicalJson, sha256 } from '../canonical.mjs';

export function codedError(code, ErrorType = Error) {
  return Object.assign(new ErrorType(code), { code });
}

export function cloneJson(value, code = 'COLLECTION_VALUE_INVALID') {
  try {
    return JSON.parse(canonicalJson(value));
  } catch {
    throw codedError(code, TypeError);
  }
}

export function deepFreezeJson(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreezeJson(nested);
    Object.freeze(value);
  }
  return value;
}

export function isIsoTimestamp(value) {
  if (typeof value !== 'string') return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

export function validateCollectionWindow(value, code = 'COLLECTION_WINDOW_INVALID') {
  if (
    !value
    || typeof value !== 'object'
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
    || Object.keys(value).sort().join(',') !== 'from,to'
    || !isIsoTimestamp(value.from)
    || !isIsoTimestamp(value.to)
    || Date.parse(value.from) >= Date.parse(value.to)
  ) throw codedError(code, TypeError);
  return deepFreezeJson(cloneJson(value, code));
}

export function assertWindowWithin(applied, requested, code = 'WINDOW_SCOPE_MISMATCH') {
  if (
    Date.parse(applied.from) < Date.parse(requested.from)
    || Date.parse(applied.to) > Date.parse(requested.to)
  ) throw codedError(code);
  return true;
}

export function capturedAt(runtime = {}) {
  const value = typeof runtime.now === 'function' ? runtime.now() : Date.now();
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw codedError('COLLECTION_CLOCK_INVALID', TypeError);
  return date.toISOString();
}

function inventorySourceId(source, operationId) {
  return `${source}.${sha256({ operationId, source }).slice(0, 32)}`;
}

function privatePayload(value, root = false) {
  if (typeof value === 'number') return { $number: JSON.stringify(value) };
  if (Array.isArray(value)) return { $array: value.map((entry) => privatePayload(entry)) };
  if (value && typeof value === 'object') {
    const encoded = Object.fromEntries(Object.entries(value).map(([key, nested]) => [
      key,
      privatePayload(nested),
    ]));
    return root ? encoded : { $object: encoded };
  }
  return value;
}

function assertTerminalCollection(collection) {
  if (
    !collection
    || typeof collection !== 'object'
    || !collection.page
    || collection.page.complete !== true
    || collection.page.truncated !== false
    || collection.page.nextCursor !== null
    || !Array.isArray(collection.items)
    || collection.page.collectedCount !== collection.items.length
    || collection.page.reportedCount !== collection.page.collectedCount
    || Object.hasOwn(collection, 'incompleteReason')
  ) throw codedError('PRIVATE_SOURCE_INVENTORY_NOT_TERMINAL');
}

export function buildPrivateSourceEnvelope(collection) {
  assertTerminalCollection(collection);
  const source = cloneJson(collection, 'PRIVATE_SOURCE_COLLECTION_INVALID');
  const envelope = {
    sourceId: inventorySourceId(source.source, source.operationId),
    kind: 'private-content',
    payload: privatePayload(source, true),
  };
  return deepFreezeJson(envelope);
}

export function authorizeTerminalCollection(collection) {
  assertTerminalCollection(collection);
  const source = deepFreezeJson(cloneJson(collection));
  const privateSourceEnvelope = buildPrivateSourceEnvelope(source);
  const privateSourceInventory = [{
    sourceId: privateSourceEnvelope.sourceId,
    kind: privateSourceEnvelope.kind,
    sourceHash: sha256({ schemaVersion: '1.0.0', source: privateSourceEnvelope }),
  }].sort((left, right) => left.sourceId.localeCompare(right.sourceId));
  return deepFreezeJson({
    ...collection,
    privateSourceEnvelope,
    privateSourceInventory,
  });
}

export function completeCollection({
  source,
  operationId,
  boundLocationId,
  requestedWindow,
  appliedWindow,
  capturedAt: captured,
  items,
  cursor = null,
  reportedCount,
}) {
  const collection = {
    source,
    operationId,
    boundLocationId,
    requestedWindow: cloneJson(requestedWindow),
    appliedWindow: cloneJson(appliedWindow),
    capturedAt: captured,
    items: cloneJson(items),
    page: {
      cursor,
      nextCursor: null,
      reportedCount,
      collectedCount: items.length,
      complete: true,
      truncated: false,
    },
  };
  return authorizeTerminalCollection(collection);
}

export function incompleteCollection({
  source,
  operationId,
  boundLocationId,
  requestedWindow,
  appliedWindow,
  capturedAt: captured,
  items,
  cursor = null,
  nextCursor = null,
  reportedCount,
  reason,
  truncated = false,
}) {
  return deepFreezeJson({
    source,
    operationId,
    boundLocationId,
    requestedWindow: cloneJson(requestedWindow),
    appliedWindow: cloneJson(appliedWindow),
    capturedAt: captured,
    items: cloneJson(items),
    page: {
      cursor,
      nextCursor,
      reportedCount,
      collectedCount: items.length,
      complete: false,
      truncated,
    },
    incompleteReason: reason,
  });
}
