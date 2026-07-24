import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  CoverageProfileSchema,
  MetricContractsSchema,
  PublicCatalogSnapshotSchema,
  assertAllowedPublicAction,
  loadCollectionBudgets,
  loadMetricContracts,
  loadProfile,
  loadPublicReadAllowlist,
  snapshotHash,
} from '../schemas/v1.mjs';
import { generatePublicAllowlist, generatedAllowlistText } from '../scripts/generate-public-allowlist.mjs';

const profilesUrl = new URL('../profiles/', import.meta.url);
const readJson = (name) => JSON.parse(readFileSync(new URL(name, profilesUrl), 'utf8'));

test('golden client and Grom profiles preserve scope and separate denominators', () => {
  const client = loadProfile('client');
  const grom = loadProfile('grom_internal');
  assert.deepEqual(client.excludedCapabilities, [
    'courses', 'lessons', 'course_offers', 'course_progress', 'memberships',
    'communities', 'assessments', 'certificates', 'course_credentials',
  ]);
  assert.deepEqual(grom.journeys.map(({ journeyId }) => journeyId), [
    'agency_new_business', 'client_onboarding',
  ]);
  assert.notEqual(grom.journeys[0].denominator, grom.journeys[1].denominator);
  assert.equal(CoverageProfileSchema.parse(client).profileId, 'client');
});

test('every versioned metric edge conforms and unmapped required edges are UNKNOWN', () => {
  for (const profileId of ['client', 'grom_internal']) {
    const metrics = loadMetricContracts(profileId);
    assert.equal(MetricContractsSchema.parse(metrics).version, '1.0.0');
    assert.ok(metrics.edges.length > 0);
    for (const edge of metrics.edges) {
      assert.equal(edge.nativeMapping, 'UNKNOWN');
      assert.ok(edge.edgeId.length > 0);
      assert.ok(edge.journeyId.length > 0);
      assert.ok(edge.dispositions.includes('unknown'));
    }
  }
  const invalid = structuredClone(loadMetricContracts('client').edges[0]);
  invalid.nativeMapping = 'UNMAPPED';
  assert.throws(() => MetricContractsSchema.parse({
    profileId: 'client', version: '1.0.0', edges: [invalid],
  }));
});

test('Grom contracts keep acquisition and onboarding denominators separate', () => {
  const edges = loadMetricContracts('grom_internal').edges;
  const acquisition = edges.filter(({ journeyId }) => journeyId === 'agency_new_business');
  const onboarding = edges.filter(({ journeyId }) => journeyId === 'client_onboarding');
  assert.ok(acquisition.length > 0);
  assert.ok(onboarding.length > 0);
  assert.ok(acquisition.every(({ fromStage }) => fromStage !== 'won_or_paid'));
  assert.equal(onboarding[0].fromStage, 'won_or_paid');
});

test('collection budgets cap every required collection dimension and checkpoint incomplete scopes', () => {
  const budgets = loadCollectionBudgets();
  assert.equal(budgets.exhaustionPolicy, 'checkpoint_scope_incomplete');
  for (const budget of Object.values(budgets.capabilities)) {
    assert.ok(budget.maximumPages > 0);
    assert.ok(budget.maximumRecords > 0);
    assert.ok(budget.maximumResponseBytes > 0);
    assert.ok(budget.requestTimeoutMs > 0);
    assert.ok(budget.retryCount >= 0);
    assert.ok(budget.maximumTotalRetryDelayMs >= 0);
    assert.ok(budget.wallClockMs > 0);
  }
});

test('catalog snapshot hash and checked-in generated allowlist are exact', () => {
  const snapshot = readJson('public-catalog-snapshot.v1.json');
  const allowlist = loadPublicReadAllowlist();
  assert.equal(snapshotHash(snapshot), snapshot.canonicalSha256);
  assert.deepEqual(generatePublicAllowlist(snapshot), allowlist);
  assert.equal(readFileSync(new URL('public-read-allowlist.v1.json', profilesUrl), 'utf8'), generatedAllowlistText(snapshot));
});

test('catalog rejects hash drift, duplicate action IDs, and approvals without provenance', () => {
  const snapshot = readJson('public-catalog-snapshot.v1.json');
  const drifted = structuredClone(snapshot);
  drifted.candidates[0].normalizedPath = '/different';
  assert.notEqual(snapshotHash(drifted), snapshot.canonicalSha256);
  assert.throws(() => generatePublicAllowlist(drifted), /CATALOG_SNAPSHOT_HASH_MISMATCH/);

  const duplicate = structuredClone(snapshot);
  duplicate.candidates.push(structuredClone(duplicate.candidates[0]));
  duplicate.canonicalSha256 = snapshotHash(duplicate);
  assert.throws(() => PublicCatalogSnapshotSchema.parse(duplicate));

  const missingProvenance = structuredClone(snapshot);
  missingProvenance.candidates[0].approval = undefined;
  missingProvenance.canonicalSha256 = snapshotHash(missingProvenance);
  assert.throws(() => PublicCatalogSnapshotSchema.parse(missingProvenance));
});

test('public action matching binds every tuple field and the catalog snapshot hash', () => {
  const allowlist = loadPublicReadAllowlist();
  const action = {
    ...allowlist.actions[0],
    sourceSnapshotHash: allowlist.sourceSnapshotHash,
  };
  assert.equal(assertAllowedPublicAction(allowlist, action), true);
  for (const [field, replacement] of [
    ['method', 'GET'],
    ['normalizedPath', '/contacts/other'],
    ['category', 'payments'],
    ['risk', 'write'],
    ['sourceSnapshotHash', 'a'.repeat(64)],
  ]) {
    assert.throws(() => assertAllowedPublicAction(allowlist, { ...action, [field]: replacement }), /PUBLIC_ACTION_NOT_ALLOWED/);
  }
});
