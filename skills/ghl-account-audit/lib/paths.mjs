import { lstatSync, mkdirSync, realpathSync } from 'node:fs';
import {
  basename,
  isAbsolute,
  relative,
  resolve,
  sep,
} from 'node:path';

function codedError(code) {
  return Object.assign(new Error(code), { code });
}

function invalidLocationId(locationId) {
  return typeof locationId !== 'string'
    || locationId.trim().length === 0
    || locationId.includes('..')
    || locationId.includes('/')
    || locationId.includes('\\')
    || locationId.includes('\0');
}

function isWithin(parent, child) {
  const pathFromParent = relative(parent, child);
  return pathFromParent === ''
    || (!isAbsolute(pathFromParent) && pathFromParent !== '..' && !pathFromParent.startsWith(`..${sep}`));
}

function lstatIfExists(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  }
}

function ensureDirectory(path, missingCode) {
  let entry = lstatIfExists(path);
  if (!entry) {
    mkdirSync(path);
    entry = lstatSync(path);
  }
  if (entry.isSymbolicLink()) throw codedError('AUDIT_PATH_SYMLINK');
  if (!entry.isDirectory()) throw codedError(missingCode);
}

function assertRealpathWithin(auditRoot, candidate) {
  if (!isWithin(auditRoot, realpathSync(candidate))) throw codedError('AUDIT_PATH_ESCAPE');
}

export function auditPaths(projectRoot, locationId) {
  if (typeof projectRoot !== 'string' || projectRoot.trim().length === 0) {
    throw new TypeError('INVALID_PROJECT_ROOT');
  }
  if (invalidLocationId(locationId)) throw new TypeError('INVALID_LOCATION_ID');

  const project = resolve(projectRoot);
  const auditRoot = resolve(project, 'audits', 'ghl');
  const root = resolve(auditRoot, locationId);
  if (!isWithin(auditRoot, root)) throw new TypeError('INVALID_LOCATION_ID');

  return Object.freeze({
    project,
    auditRoot,
    root,
    weekly: resolve(root, 'weekly'),
    memoryEvents: resolve(root, 'memory', 'events'),
    privateRaw: resolve(root, 'private', 'raw'),
    privateLogs: resolve(root, 'private', 'logs'),
    privateCheckpoints: resolve(root, 'private', 'checkpoints'),
    stateDir: resolve(root, '.state'),
    stateDb: resolve(root, '.state', 'auditor.sqlite'),
  });
}

export function validateAuditPaths(paths) {
  if (
    !paths
    || typeof paths !== 'object'
    || Array.isArray(paths)
    || typeof paths.project !== 'string'
    || typeof paths.root !== 'string'
  ) throw codedError('AUDIT_PATHS_INVALID');
  let expected;
  try {
    expected = auditPaths(paths.project, basename(paths.root));
  } catch {
    throw codedError('AUDIT_PATHS_INVALID');
  }
  if (
    Object.keys(paths).length !== Object.keys(expected).length
    || Object.entries(expected).some(([key, value]) => paths[key] !== value)
  ) throw codedError('AUDIT_PATHS_INVALID');
  return expected;
}

export function ensureAuditPaths(paths) {
  const projectEntry = lstatIfExists(paths.project);
  if (!projectEntry || !projectEntry.isDirectory()) throw codedError('INVALID_PROJECT_ROOT');
  if (projectEntry.isSymbolicLink()) throw codedError('AUDIT_PATH_SYMLINK');

  const auditContainer = resolve(paths.project, 'audits');
  const memory = resolve(paths.root, 'memory');
  const privateRoot = resolve(paths.root, 'private');
  const directories = [
    auditContainer,
    paths.auditRoot,
    paths.root,
    paths.weekly,
    memory,
    paths.memoryEvents,
    privateRoot,
    paths.privateRaw,
    paths.privateLogs,
    paths.privateCheckpoints,
    paths.stateDir,
  ];
  for (const directory of directories) ensureDirectory(directory, 'AUDIT_PATH_INVALID');

  const auditRoot = realpathSync(paths.auditRoot);
  for (const directory of directories.slice(1)) assertRealpathWithin(auditRoot, directory);

  const database = lstatIfExists(paths.stateDb);
  if (database?.isSymbolicLink()) throw codedError('AUDIT_PATH_SYMLINK');
  if (database && !database.isFile()) throw codedError('AUDIT_DATABASE_INVALID');
  return auditRoot;
}

export function verifyAuditDatabasePath(paths, auditRoot) {
  const database = lstatIfExists(paths.stateDb);
  if (!database) throw codedError('AUDIT_DATABASE_MISSING');
  if (database.isSymbolicLink()) throw codedError('AUDIT_PATH_SYMLINK');
  if (!database.isFile()) throw codedError('AUDIT_DATABASE_INVALID');
  assertRealpathWithin(auditRoot, paths.stateDb);
}
