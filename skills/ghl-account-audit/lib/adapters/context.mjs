import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { canonicalJson, sha256 } from '../canonical.mjs';
import {
  capturedAt,
  cloneJson,
  codedError,
  completeCollection,
  isIsoTimestamp,
  validateCollectionWindow,
} from './collection.mjs';

const SAFE_ID = /^[a-z0-9][a-z0-9_.:-]{0,127}$/u;

function isPlainObject(value) {
  return Boolean(
    value
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
  );
}

function assertNestedLocation(value, expectedLocationId) {
  if (!value || typeof value !== 'object') return;
  for (const [key, nested] of Object.entries(value)) {
    const normalized = key.toLowerCase().replace(/[^a-z0-9]/gu, '');
    if (
      ['boundlocationid', 'ghllocationid', 'locationid'].includes(normalized)
      && nested !== expectedLocationId
    ) throw codedError('LOCATION_MISMATCH');
    assertNestedLocation(nested, expectedLocationId);
  }
}

function checkedFile(root, path) {
  if (typeof path !== 'string' || path.length === 0 || isAbsolute(path)) {
    throw codedError('CONTEXT_PATH_INVALID', TypeError);
  }
  const candidate = resolve(root, path);
  const lexical = relative(root, candidate);
  if (lexical === '..' || lexical.startsWith(`..${sep}`) || isAbsolute(lexical)) {
    throw codedError('CONTEXT_PATH_INVALID', TypeError);
  }
  let actual;
  let descriptor;
  try {
    if (lstatSync(candidate).isSymbolicLink()) throw codedError('CONTEXT_PATH_INVALID');
    actual = realpathSync(candidate);
    descriptor = openSync(actual, constants.O_RDONLY | constants.O_NOFOLLOW);
    const identity = fstatSync(descriptor);
    if (!identity.isFile()) throw codedError('CONTEXT_PATH_INVALID');
    const bytes = readFileSync(descriptor);
    return {
      path: actual,
      device: identity.dev,
      inode: identity.ino,
      bytesHash: sha256([...bytes]),
    };
  } catch (error) {
    if (error?.code === 'CONTEXT_PATH_INVALID') throw error;
    throw codedError('CONTEXT_PATH_INVALID');
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function validateProfile(projectRoot, profile) {
  if (
    !isPlainObject(profile)
    || typeof profile.expectedLocationId !== 'string'
    || profile.expectedLocationId.length === 0
    || !Array.isArray(profile.sources)
    || profile.sources.length === 0
  ) throw codedError('CONTEXT_PROFILE_INVALID', TypeError);
  const root = realpathSync(projectRoot);
  const sourceIds = new Set();
  const sources = profile.sources.map((source) => {
    if (
      !isPlainObject(source)
      || Object.keys(source).sort().join(',') !== 'authority,path,sourceId'
      || typeof source.sourceId !== 'string'
      || !SAFE_ID.test(source.sourceId)
      || sourceIds.has(source.sourceId)
      || typeof source.authority !== 'string'
      || !SAFE_ID.test(source.authority)
    ) throw codedError('CONTEXT_PROFILE_INVALID', TypeError);
    sourceIds.add(source.sourceId);
    const checked = checkedFile(root, source.path);
    const physical = relative(root, checked.path);
    if (physical === '..' || physical.startsWith(`..${sep}`) || isAbsolute(physical)) {
      throw codedError('CONTEXT_PATH_INVALID');
    }
    return Object.freeze({
      sourceId: source.sourceId,
      authority: source.authority,
      ...checked,
    });
  });
  return Object.freeze({
    root,
    expectedLocationId: profile.expectedLocationId,
    sources: Object.freeze(sources),
  });
}

function readSource(source, expectedLocationId) {
  let value;
  let bytes;
  let descriptor;
  try {
    descriptor = openSync(source.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const identity = fstatSync(descriptor);
    if (
      !identity.isFile()
      || identity.dev !== source.device
      || identity.ino !== source.inode
    ) throw codedError('CONTEXT_SOURCE_CHANGED');
    bytes = readFileSync(descriptor);
    if (sha256([...bytes]) !== source.bytesHash) throw codedError('CONTEXT_SOURCE_CHANGED');
    value = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    if (error?.code === 'CONTEXT_SOURCE_CHANGED') throw error;
    throw codedError('CONTEXT_SOURCE_INVALID');
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  if (
    !isPlainObject(value)
    || value.locationId !== expectedLocationId
    || !isIsoTimestamp(value.capturedAt)
    || !isPlainObject(value.values)
  ) {
    if (value?.locationId !== expectedLocationId) throw codedError('LOCATION_MISMATCH');
    throw codedError('CONTEXT_SOURCE_INVALID');
  }
  assertNestedLocation(value.values, expectedLocationId);
  return cloneJson(value, 'CONTEXT_SOURCE_INVALID');
}

export function createContextAdapter({ projectRoot, profile, runtime = {} } = {}) {
  let pinned;
  try {
    pinned = validateProfile(projectRoot, profile);
  } catch (error) {
    if (error?.code) throw error;
    throw codedError('CONTEXT_PROFILE_INVALID', TypeError);
  }

  return Object.freeze({
    async collect({ capability, window, cursor = null, signal } = {}) {
      if (
        !isPlainObject(capability)
        || typeof capability.operationId !== 'string'
        || capability.operationId.length === 0
        || cursor !== null
      ) throw codedError('CONTEXT_CAPABILITY_INVALID', TypeError);
      if (signal?.aborted) throw codedError('COLLECTION_ABORTED');
      const requestedWindow = validateCollectionWindow(window);
      const assertions = new Map();
      for (const source of pinned.sources) {
        if (signal?.aborted) throw codedError('COLLECTION_ABORTED');
        const document = readSource(source, pinned.expectedLocationId);
        for (const [key, value] of Object.entries(document.values)) {
          const record = {
            recordType: 'authority_assertion',
            key,
            value,
            authority: source.authority,
            sourceId: source.sourceId,
            capturedAt: document.capturedAt,
          };
          const records = assertions.get(key) ?? [];
          records.push(record);
          assertions.set(key, records);
        }
      }
      if (signal?.aborted) throw codedError('COLLECTION_ABORTED');
      const items = [];
      for (const key of [...assertions.keys()].sort()) {
        const records = assertions.get(key).sort((left, right) => (
          left.authority.localeCompare(right.authority)
          || left.sourceId.localeCompare(right.sourceId)
        ));
        const distinct = new Set(records.map(({ value }) => canonicalJson(value)));
        if (distinct.size > 1) {
          items.push({
            recordType: 'authority_conflict',
            key,
            assertions: records.map(({ authority, sourceId, capturedAt: at, value }) => ({
              authority,
              sourceId,
              capturedAt: at,
              value,
            })),
          });
        } else {
          items.push(...records);
        }
      }
      return completeCollection({
        source: 'context',
        operationId: capability.operationId,
        boundLocationId: pinned.expectedLocationId,
        requestedWindow,
        appliedWindow: requestedWindow,
        capturedAt: capturedAt(runtime),
        items,
        cursor,
        reportedCount: items.length,
      });
    },
  });
}
