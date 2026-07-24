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
import { canonicalJson } from '../canonical.mjs';
import {
  capturedAt,
  cloneJson,
  codedError,
  completeCollection,
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
    return {
      path: actual,
      device: identity.dev,
      inode: identity.ino,
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
  let descriptor;
  try {
    descriptor = openSync(source.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const identity = fstatSync(descriptor);
    if (
      !identity.isFile()
      || identity.dev !== source.device
      || identity.ino !== source.inode
    ) throw codedError('CONTEXT_SOURCE_CHANGED');
    value = JSON.parse(readFileSync(descriptor, 'utf8'));
  } catch (error) {
    if (error?.code === 'CONTEXT_SOURCE_CHANGED') throw error;
    throw codedError('CONTEXT_SOURCE_INVALID');
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  if (
    !isPlainObject(value)
    || value.locationId !== expectedLocationId
    || typeof value.capturedAt !== 'string'
    || !isPlainObject(value.values)
  ) {
    if (value?.locationId !== expectedLocationId) throw codedError('LOCATION_MISMATCH');
    throw codedError('CONTEXT_SOURCE_INVALID');
  }
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
    async collect({ capability, window, cursor = null } = {}) {
      if (
        !isPlainObject(capability)
        || typeof capability.operationId !== 'string'
        || capability.operationId.length === 0
        || cursor !== null
      ) throw codedError('CONTEXT_CAPABILITY_INVALID', TypeError);
      const requestedWindow = cloneJson(window, 'COLLECTION_WINDOW_INVALID');
      const assertions = new Map();
      for (const source of pinned.sources) {
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
