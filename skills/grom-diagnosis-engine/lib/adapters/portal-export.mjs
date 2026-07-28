import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import { isAbsolute } from 'node:path';
import { canonicalJson, sha256 } from '../canonical.mjs';
import {
  cloneJson,
  codedError,
  completeCollection,
  assertWindowWithin,
  isIsoTimestamp,
  validateCollectionWindow,
} from './collection.mjs';

function isPlainObject(value) {
  return Boolean(
    value
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
  );
}

function validatePath(exportPath) {
  if (
    typeof exportPath !== 'string'
    || exportPath.length === 0
    || !isAbsolute(exportPath)
    || /^[a-z][a-z0-9+.-]*:/iu.test(exportPath)
  ) throw codedError('PORTAL_EXPORT_PATH_INVALID', TypeError);
  let descriptor;
  try {
    if (lstatSync(exportPath).isSymbolicLink()) throw codedError('PORTAL_EXPORT_PATH_INVALID');
    const actual = realpathSync(exportPath);
    descriptor = openSync(actual, constants.O_RDONLY | constants.O_NOFOLLOW);
    const identity = fstatSync(descriptor);
    if (!identity.isFile()) throw codedError('PORTAL_EXPORT_PATH_INVALID');
    const bytes = readFileSync(descriptor);
    return {
      path: actual,
      device: identity.dev,
      inode: identity.ino,
      bytesHash: sha256([...bytes]),
    };
  } catch (error) {
    if (error?.code === 'PORTAL_EXPORT_PATH_INVALID') throw error;
    throw codedError('PORTAL_EXPORT_PATH_INVALID');
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

const NOT_APPLICABLE_KEY = /course|lesson|membership|community|assessment|certificate/u;
const NOT_APPLICABLE_VALUE = /assessment|certificate|community|course|lesson|membership/u;
const PRIVATE_KEY = /authorization|cookie|credential|database|dbconnection|header|password|secret|token/u;
const PRIVATE_STRING = /(?:authorization|bearer)\s+|(?:postgres|postgresql|mysql|mongodb|redis|jdbc):\/\/|eyJ[a-zA-Z0-9_-]*\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+|[?&](?:access_?token|api_?key|password|secret|token)=|(?:^|\s)(?:ghp|sk)_[a-zA-Z0-9_-]{8,}/iu;
const PORTAL_ITEM_VALIDATORS = Object.freeze({
  '1.0.0': (item) => {
    if (
      canonicalJson(Object.keys(item).sort()) !== canonicalJson(['milestone', 'surface'])
      || item.surface !== 'onboarding_milestone'
      || typeof item.milestone !== 'string'
      || !/^[a-z][a-z0-9_]{0,63}$/u.test(item.milestone)
    ) throw codedError('PORTAL_EXPORT_ITEM_SCHEMA_INVALID');
  },
});

function validatePortalValue(value, expectedLocationId, stack = new WeakSet()) {
  if (
    value === null
    || typeof value === 'boolean'
    || (typeof value === 'number' && Number.isFinite(value))
  ) return;
  if (typeof value === 'string') {
    const normalized = value.toLowerCase().replace(/[^a-z0-9]/gu, '');
    if (NOT_APPLICABLE_VALUE.test(normalized)) {
      throw codedError('PORTAL_EXPORT_SURFACE_NOT_APPLICABLE');
    }
    if (PRIVATE_STRING.test(value)) throw codedError('PORTAL_EXPORT_PRIVATE_VALUE');
    return;
  }
  if (!value || typeof value !== 'object' || stack.has(value)) {
    throw codedError('PORTAL_EXPORT_INVALID');
  }
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype) {
    throw codedError('PORTAL_EXPORT_INVALID');
  }
  stack.add(value);
  try {
    for (const [key, nested] of Object.entries(value)) {
      const normalized = key.toLowerCase().replace(/[^a-z0-9]/gu, '');
      if (NOT_APPLICABLE_KEY.test(normalized)) {
        throw codedError('PORTAL_EXPORT_SURFACE_NOT_APPLICABLE');
      }
      if (PRIVATE_KEY.test(normalized)) throw codedError('PORTAL_EXPORT_PRIVATE_VALUE');
      if (
        ['boundlocationid', 'ghllocationid', 'locationid'].includes(normalized)
        && nested !== expectedLocationId
      ) throw codedError('LOCATION_MISMATCH');
      validatePortalValue(nested, expectedLocationId, stack);
    }
  } finally {
    stack.delete(value);
  }
}

function validatePortalItems(items, expectedLocationId, schemaVersion) {
  const validateItem = PORTAL_ITEM_VALIDATORS[schemaVersion];
  if (typeof validateItem !== 'function') throw codedError('PORTAL_EXPORT_INVALID');
  for (const item of items) {
    if (!isPlainObject(item) || Object.keys(item).length === 0) {
      throw codedError('PORTAL_EXPORT_INVALID');
    }
    validatePortalValue(item, expectedLocationId);
    validateItem(item);
  }
}

function validateExport(value, expectedLocationId) {
  const expectedKeys = [
    'appliedWindow',
    'capturedAt',
    'items',
    'locationId',
    'operationId',
    'page',
    'requestedWindow',
    'schemaVersion',
    'source',
  ];
  const expectedPageKeys = [
    'collectedCount',
    'complete',
    'cursor',
    'nextCursor',
    'reportedCount',
    'truncated',
  ];
  if (
    !isPlainObject(value)
    || canonicalJson(Object.keys(value).sort()) !== canonicalJson(expectedKeys)
    || value.schemaVersion !== '1.0.0'
    || value.source !== 'onboarding_portal'
    || typeof value.operationId !== 'string'
    || value.operationId.length === 0
    || !isIsoTimestamp(value.capturedAt)
    || !isPlainObject(value.requestedWindow)
    || !isPlainObject(value.appliedWindow)
    || !Array.isArray(value.items)
    || !isPlainObject(value.page)
    || canonicalJson(Object.keys(value.page).sort()) !== canonicalJson(expectedPageKeys)
  ) {
    if (value?.source !== 'onboarding_portal') throw codedError('PORTAL_EXPORT_SOURCE_INVALID');
    throw codedError('PORTAL_EXPORT_INVALID');
  }
  let requestedWindow;
  let appliedWindow;
  try {
    requestedWindow = validateCollectionWindow(value.requestedWindow, 'PORTAL_EXPORT_INVALID');
    appliedWindow = validateCollectionWindow(value.appliedWindow, 'PORTAL_EXPORT_INVALID');
  } catch (error) {
    if (error?.code === 'PORTAL_EXPORT_INVALID') throw error;
    throw codedError('PORTAL_EXPORT_INVALID');
  }
  validatePortalItems(value.items, expectedLocationId, value.schemaVersion);
  if (Date.parse(value.capturedAt) < Date.parse(appliedWindow.to)) {
    throw codedError('PORTAL_EXPORT_INVALID');
  }
  if (value.locationId !== expectedLocationId) throw codedError('LOCATION_MISMATCH');
  if (
    value.page.cursor !== null
    || value.page.nextCursor !== null
    || value.page.complete !== true
    || value.page.truncated !== false
    || value.page.reportedCount !== value.items.length
    || value.page.collectedCount !== value.items.length
  ) throw codedError('PORTAL_EXPORT_INCOMPLETE');
  return cloneJson({
    ...value,
    requestedWindow,
    appliedWindow,
  }, 'PORTAL_EXPORT_INVALID');
}

export function createPortalExportAdapter({ exportPath, expectedLocationId } = {}) {
  if (typeof expectedLocationId !== 'string' || expectedLocationId.length === 0) {
    throw codedError('PORTAL_EXPORT_CONFIG_INVALID', TypeError);
  }
  const pinned = validatePath(exportPath);

  return Object.freeze({
    async collect({ capability, window, cursor = null, signal } = {}) {
      if (
        !isPlainObject(capability)
        || typeof capability.operationId !== 'string'
        || capability.operationId.length === 0
        || cursor !== null
      ) throw codedError('PORTAL_EXPORT_CAPABILITY_INVALID', TypeError);
      if (signal?.aborted) throw codedError('COLLECTION_ABORTED');
      const requestedWindow = validateCollectionWindow(window);
      let bytes;
      let descriptor;
      try {
        descriptor = openSync(pinned.path, constants.O_RDONLY | constants.O_NOFOLLOW);
        const identity = fstatSync(descriptor);
        if (
          !identity.isFile()
          || identity.dev !== pinned.device
          || identity.ino !== pinned.inode
        ) throw codedError('PORTAL_EXPORT_CHANGED');
        bytes = readFileSync(descriptor);
      } catch (error) {
        if (error?.code === 'PORTAL_EXPORT_CHANGED') throw error;
        throw codedError('PORTAL_EXPORT_CHANGED');
      } finally {
        if (descriptor !== undefined) closeSync(descriptor);
      }
      if (sha256([...bytes]) !== pinned.bytesHash) throw codedError('PORTAL_EXPORT_CHANGED');
      if (signal?.aborted) throw codedError('COLLECTION_ABORTED');
      let value;
      try {
        value = JSON.parse(bytes.toString('utf8'));
      } catch {
        throw codedError('PORTAL_EXPORT_INVALID');
      }
      const exported = validateExport(value, expectedLocationId);
      if (
        exported.operationId !== capability.operationId
        || canonicalJson(exported.requestedWindow) !== canonicalJson(requestedWindow)
      ) throw codedError('PORTAL_EXPORT_SCOPE_MISMATCH');
      assertWindowWithin(
        exported.appliedWindow,
        exported.requestedWindow,
        'PORTAL_EXPORT_SCOPE_MISMATCH',
      );
      if (signal?.aborted) throw codedError('COLLECTION_ABORTED');
      return completeCollection({
        source: exported.source,
        operationId: exported.operationId,
        boundLocationId: expectedLocationId,
        requestedWindow: exported.requestedWindow,
        appliedWindow: exported.appliedWindow,
        capturedAt: exported.capturedAt,
        items: exported.items,
        cursor,
        reportedCount: exported.page.reportedCount,
      });
    },
  });
}
