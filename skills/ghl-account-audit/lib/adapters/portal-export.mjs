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

function containsNotApplicableSurface(value, stack = new WeakSet()) {
  if (!value || typeof value !== 'object') return false;
  if (stack.has(value)) return true;
  stack.add(value);
  try {
    return Object.entries(value).some(([key, nested]) => {
      const normalized = key.toLowerCase().replace(/[^a-z0-9]/gu, '');
      return /course|lesson|membership|community|assessment|certificate/u.test(normalized)
        || containsNotApplicableSurface(nested, stack);
    });
  } finally {
    stack.delete(value);
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
    || typeof value.capturedAt !== 'string'
    || !isPlainObject(value.requestedWindow)
    || !isPlainObject(value.appliedWindow)
    || !Array.isArray(value.items)
    || !isPlainObject(value.page)
    || canonicalJson(Object.keys(value.page).sort()) !== canonicalJson(expectedPageKeys)
  ) {
    if (value?.source !== 'onboarding_portal') throw codedError('PORTAL_EXPORT_SOURCE_INVALID');
    throw codedError('PORTAL_EXPORT_INVALID');
  }
  if (containsNotApplicableSurface(value.items)) {
    throw codedError('PORTAL_EXPORT_SURFACE_NOT_APPLICABLE');
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
  return cloneJson(value, 'PORTAL_EXPORT_INVALID');
}

export function createPortalExportAdapter({ exportPath, expectedLocationId } = {}) {
  if (typeof expectedLocationId !== 'string' || expectedLocationId.length === 0) {
    throw codedError('PORTAL_EXPORT_CONFIG_INVALID', TypeError);
  }
  const pinned = validatePath(exportPath);

  return Object.freeze({
    async collect({ capability, window, cursor = null } = {}) {
      if (
        !isPlainObject(capability)
        || typeof capability.operationId !== 'string'
        || capability.operationId.length === 0
        || cursor !== null
      ) throw codedError('PORTAL_EXPORT_CAPABILITY_INVALID', TypeError);
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
      let value;
      try {
        value = JSON.parse(bytes.toString('utf8'));
      } catch {
        throw codedError('PORTAL_EXPORT_INVALID');
      }
      const exported = validateExport(value, expectedLocationId);
      if (
        exported.operationId !== capability.operationId
        || canonicalJson(exported.requestedWindow) !== canonicalJson(window)
      ) throw codedError('PORTAL_EXPORT_SCOPE_MISMATCH');
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
