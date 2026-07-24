import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  PublicCatalogSnapshotSchema,
  PublicReadAllowlistSchema,
  snapshotHash,
} from '../schemas/v1.mjs';

const snapshotUrl = new URL('../profiles/public-catalog-snapshot.v1.json', import.meta.url);
const allowlistUrl = new URL('../profiles/public-read-allowlist.v1.json', import.meta.url);

export function generatePublicAllowlist(snapshot) {
  const parsed = PublicCatalogSnapshotSchema.parse(snapshot);
  const calculatedHash = snapshotHash(parsed);
  if (calculatedHash !== parsed.canonicalSha256) {
    throw new Error('CATALOG_SNAPSHOT_HASH_MISMATCH');
  }
  const actions = parsed.candidates
    .filter((candidate) => candidate.approvedSemanticRead === true)
    .map(({ actionId, method, normalizedPath, category, risk }) => ({ actionId, method, normalizedPath, category, risk }))
    .sort((left, right) => left.actionId.localeCompare(right.actionId));
  return PublicReadAllowlistSchema.parse({
    schemaVersion: parsed.schemaVersion,
    sourceCatalogRevision: parsed.catalogRevision,
    sourceSnapshotHash: calculatedHash,
    sourceServerIdentity: parsed.sourceServer.identity,
    actions,
  });
}

export function generatedAllowlistText(snapshot) {
  return `${JSON.stringify(generatePublicAllowlist(snapshot), null, 2)}\n`;
}

function main() {
  const snapshot = JSON.parse(readFileSync(snapshotUrl, 'utf8'));
  const expected = generatedAllowlistText(snapshot);
  const check = process.argv.includes('--check');
  if (check) {
    const actual = readFileSync(allowlistUrl, 'utf8');
    if (actual !== expected) throw new Error('PUBLIC_ALLOWLIST_OUT_OF_DATE');
    return;
  }
  writeFileSync(allowlistUrl, expected);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
