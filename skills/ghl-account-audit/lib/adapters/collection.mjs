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

export function capturedAt(runtime = {}) {
  const value = typeof runtime.now === 'function' ? runtime.now() : Date.now();
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw codedError('COLLECTION_CLOCK_INVALID', TypeError);
  return date.toISOString();
}

function inventorySourceId(source, operationId) {
  return `${source}.${sha256({ operationId, source }).slice(0, 32)}`;
}

export function authorizeTerminalCollection(collection) {
  if (
    collection.page.complete !== true
    || collection.page.truncated !== false
    || collection.page.nextCursor !== null
    || collection.page.collectedCount !== collection.items.length
    || collection.page.reportedCount !== collection.page.collectedCount
    || Object.hasOwn(collection, 'incompleteReason')
  ) throw codedError('PRIVATE_SOURCE_INVENTORY_NOT_TERMINAL');
  const source = cloneJson(collection);
  const privateSourceInventory = [{
    sourceId: inventorySourceId(source.source, source.operationId),
    kind: 'private-content',
    sourceHash: sha256({ schemaVersion: '1.0.0', source }),
  }].sort((left, right) => left.sourceId.localeCompare(right.sourceId));
  return Object.freeze({
    ...collection,
    privateSourceInventory: Object.freeze(privateSourceInventory.map(Object.freeze)),
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
  return Object.freeze({
    source,
    operationId,
    boundLocationId,
    requestedWindow: cloneJson(requestedWindow),
    appliedWindow: cloneJson(appliedWindow),
    capturedAt: captured,
    items: cloneJson(items),
    page: Object.freeze({
      cursor,
      nextCursor,
      reportedCount,
      collectedCount: items.length,
      complete: false,
      truncated,
    }),
    incompleteReason: reason,
  });
}
