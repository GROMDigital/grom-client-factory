import { canonicalJson, sha256 } from '../canonical.mjs';
import {
  loadPublicCatalogSnapshot,
  loadPublicReadAllowlist,
} from '../../schemas/v1.mjs';

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

export function loadTrustedPublicReadPolicy() {
  const snapshot = loadPublicCatalogSnapshot();
  const allowlist = loadPublicReadAllowlist();
  const generatedActions = snapshot.candidates
    .filter((candidate) => candidate.approvedSemanticRead === true)
    .map(({ actionId, method, normalizedPath, category, risk }) => ({
      actionId,
      method,
      normalizedPath,
      category,
      risk,
    }))
    .sort((left, right) => left.actionId.localeCompare(right.actionId));
  if (
    allowlist.sourceCatalogRevision !== snapshot.catalogRevision
    || allowlist.sourceSnapshotHash !== snapshot.canonicalSha256
    || allowlist.sourceServerIdentity !== snapshot.sourceServer.identity
    || canonicalJson(allowlist.actions) !== canonicalJson(generatedActions)
  ) throw new Error('TRUSTED_ALLOWLIST_INVALID');
  const pinnedAllowlist = JSON.parse(canonicalJson(allowlist));
  return deepFreeze({
    allowlist: pinnedAllowlist,
    allowlistHash: sha256(pinnedAllowlist),
    snapshotHash: snapshot.canonicalSha256,
  });
}

export function assertTrustedAction(policy, capability) {
  if (
    !policy
    || !capability
    || typeof capability !== 'object'
    || Array.isArray(capability)
    || capability.sourceSnapshotHash !== policy.snapshotHash
    || capability.allowlistHash !== policy.allowlistHash
  ) throw new Error('ACTION_NOT_ALLOWED');
  const allowed = policy.allowlist.actions.some((entry) => (
    entry.actionId === capability.actionId
    && entry.method === capability.method
    && entry.normalizedPath === capability.normalizedPath
    && entry.category === capability.category
    && entry.risk === capability.risk
    && entry.risk === 'read'
  ));
  if (!allowed) throw new Error('ACTION_NOT_ALLOWED');
  return true;
}
