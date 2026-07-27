import { canonicalJson, sha256 } from '../canonical.mjs';

export function codedError(code, ErrorType = Error) {
  return Object.assign(new ErrorType(code), { code });
}

/**
 * ---------------------------------------------------------------------------------------------
 * THE ONLY THING A FAILURE MAY CARRY ACROSS A LAYER.
 *
 * A live run failed with a bare `PUBLIC_COLLECTION_FAILED` and naming the cause took a capture
 * session and six probe rounds, because three layers each discarded the error beneath them. The
 * originating code now travels — and NOTHING else, ever.
 *
 * The bound is not decoration. The GHL MCP worker ECHOES REQUEST PARAMETERS into its error
 * channel, and a value attached here reaches `lib/kernel.mjs` `assertSafeCollected` and the
 * publication boundary. So a message, a payload, a parameter or a status body must not be able to
 * ride out on an error property: anything that is not an UPPER_SNAKE machine code of bounded
 * length is replaced with a constant that says exactly that.
 * ---------------------------------------------------------------------------------------------
 */
export const UPSTREAM_CODE_UNRECOGNISED = 'UPSTREAM_CODE_UNRECOGNISED';
const MACHINE_CODE = /^[A-Z][A-Z0-9_]{1,63}$/u;

export function isMachineCode(value) {
  return typeof value === 'string' && MACHINE_CODE.test(value);
}

export function boundedUpstreamCode(value) {
  return isMachineCode(value) ? value : UPSTREAM_CODE_UNRECOGNISED;
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

/**
 * ---------------------------------------------------------------------------------------------
 * THE INVERSE OF `completeCollection` / `incompleteCollection`.
 *
 * `collectPublicEvidence` does not checkpoint collection envelopes. It checkpoints a RECORD whose
 * `scopes[]` are each an envelope with `source` and `boundLocationId` hoisted to the parent (they
 * are the same for every scope, so repeating them per scope would be 12 chances to disagree), plus
 * three fields of the auditor's own bookkeeping, plus an `incompleteReason: null` that a COMPLETE
 * envelope may not carry at all.
 *
 * Two separate consumers have to turn that back into envelopes: the measurement chain, whose
 * projector validates them, and `mergeInternalEvidence`, whose rail check inspects them. They MUST
 * agree, so there is exactly one function and both call it. Two hand-rolled copies of this mapping
 * is precisely how one consumer ends up reconciling an envelope the other one rejects.
 *
 * WHY `status`, `actionId` AND `category` ARE DROPPED, which is the load-bearing decision here.
 *
 * `status` is a DERIVED restatement of `page.complete` — the collector sets it from exactly that
 * flag. Carrying it onto the envelope would give the envelope TWO places to claim completeness,
 * and the terminality check would then have to decide which one wins. That is how a
 * `complete_partial` scope gets read as terminal. `page` is the only self-description of
 * completeness an envelope has, and it stays that way. `actionId` and `category` describe OUR
 * call, not the account, and they are already recorded on the scope record itself.
 *
 * The alternative was to widen the envelope allow-list in `lib/modes/weekly.mjs` to name all three,
 * which would have meant giving `status` a completeness meaning in a spec whose whole purpose is
 * that nothing may relax terminality. Dropping them keeps that spec untouched.
 * ---------------------------------------------------------------------------------------------
 */
export function sourceCollectionsFromScopes(publicEvidence) {
  if (
    !publicEvidence
    || typeof publicEvidence !== 'object'
    || Array.isArray(publicEvidence)
    || !Array.isArray(publicEvidence.scopes)
  ) throw codedError('PUBLIC_EVIDENCE_SCOPES_INVALID', TypeError);
  return publicEvidence.scopes.map((scope) => {
    if (!scope || typeof scope !== 'object' || Array.isArray(scope) || !scope.page) {
      throw codedError('PUBLIC_EVIDENCE_SCOPES_INVALID', TypeError);
    }
    const collection = {
      source: publicEvidence.source,
      operationId: scope.operationId,
      boundLocationId: publicEvidence.boundLocationId,
      requestedWindow: { ...scope.requestedWindow },
      appliedWindow: { ...scope.appliedWindow },
      capturedAt: scope.capturedAt,
      items: scope.items,
      page: { ...scope.page },
    };
    if (collection.page.complete !== true) {
      // Incompleteness propagates and is never laundered. A scope that is partial without saying
      // why still says SOMETHING, and a generic reason is honest where silence reads as terminal.
      collection.incompleteReason = typeof scope.incompleteReason === 'string'
        && scope.incompleteReason.length > 0
        ? scope.incompleteReason
        : 'PUBLIC_SCOPE_INCOMPLETE';
    }
    return collection;
  });
}
