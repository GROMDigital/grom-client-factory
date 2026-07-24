import { relative, resolve } from 'node:path';

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
  return pathFromParent === '' || (!pathFromParent.startsWith('..') && !pathFromParent.startsWith('/') && !pathFromParent.includes('..'));
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
