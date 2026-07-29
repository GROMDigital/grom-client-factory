import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  CoverageProfileSchema,
  MetricContractsSchema,
  PublicCatalogSnapshotSchema,
  PublicReadAllowlistSchema,
  assertAllowedPublicAction,
  loadCollectionBudgets,
  loadMetricContracts,
  loadProfile,
  loadPublicReadAllowlist,
  snapshotHash,
  validateMetricContractsForProfile,
} from '../schemas/v1.mjs';
import { generatePublicAllowlist, generatedAllowlistText } from '../scripts/generate-public-allowlist.mjs';

const profilesUrl = new URL('../profiles/', import.meta.url);
const readJson = (name) => JSON.parse(readFileSync(new URL(name, profilesUrl), 'utf8'));

test('golden client and Grom profiles preserve scope and separate journey instances', () => {
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
  assert.deepEqual(grom.journeys.map(({ journeyInstanceId }) => journeyInstanceId), [
    'journey_agency_new_business', 'journey_client_onboarding',
  ]);
  assert.equal(CoverageProfileSchema.parse(client).profileId, 'client');
});

test('journey instance identifiers are required, unique, and bound to their journey contracts', () => {
  const grom = loadProfile('grom_internal');
  const missing = structuredClone(grom);
  delete missing.journeys[0].journeyInstanceId;
  assert.throws(() => CoverageProfileSchema.parse(missing));

  const duplicate = structuredClone(grom);
  duplicate.journeys[1].journeyInstanceId = duplicate.journeys[0].journeyInstanceId;
  assert.throws(() => CoverageProfileSchema.parse(duplicate));

  const crossJourney = structuredClone(loadMetricContracts('grom_internal'));
  const missingEdgeInstance = structuredClone(crossJourney);
  delete missingEdgeInstance.edges[0].journeyInstanceId;
  assert.throws(() => MetricContractsSchema.parse(missingEdgeInstance));

  const onboarding = crossJourney.edges.find(({ journeyId }) => journeyId === 'client_onboarding');
  onboarding.journeyInstanceId = grom.journeys[0].journeyInstanceId;
  assert.throws(() => validateMetricContractsForProfile(grom, crossJourney), /JOURNEY_INSTANCE_MISMATCH/);
});

test('every versioned metric edge conforms', () => {
  for (const profileId of ['client', 'grom_internal']) {
    const metrics = loadMetricContracts(profileId);
    assert.equal(MetricContractsSchema.parse(metrics).version, '1.0.0');
    assert.ok(metrics.edges.length > 0);
    for (const edge of metrics.edges) {
      // The blanket `nativeMapping === 'UNKNOWN'` assertion that stood here was invalidated by
      // Task A2, which mapped the edges the shipped projection genuinely proves. The MAPPED /
      // UNKNOWN partition is now pinned edge by edge, hand-stated, in
      // `tests/metrics-native-mapping.test.mjs`, together with the rule that an edge declared in
      // the projection's `unmeasurableEdges[]` may never be mapped. That is a strictly stronger
      // guard than the blanket assertion, which only held while nothing was mapped at all.
      assert.ok(['MAPPED', 'UNKNOWN'].includes(edge.nativeMapping));
      assert.ok(edge.edgeId.length > 0);
      assert.ok(edge.journeyId.length > 0);
      assert.ok(edge.journeyInstanceId.length > 0);
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

test('Grom Hana caveat preserves attribution and keeps the GHL send path auditable', () => {
  const grom = loadProfile('grom_internal');
  const hana = grom.situation.knownDataCaveats.find((caveat) => caveat.includes('Hana'));
  assert.ok(hana, 'the Grom account facts must retain the Hana evidence boundary');
  assert.match(hana, /Owner confirmed 2026-07-28/u);
  assert.match(hana, /2026-07-29 GHL reread/u);
  assert.match(hana, /UK GROM Daily Update - Hana/u);
  assert.match(hana, /GHL workflow itself is IN SCOPE/u);
  assert.match(hana, /Portal conversations.*outside this audit/u);
  assert.match(hana, /actual portal-supplied subject and body cannot be judged from GHL alone/u);
  assert.doesNotMatch(hana, /Do not treat the absence of Hana activity inside GHL/u);
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

test('catalog rejects hash drift, duplicate action IDs, approval gaps, and approved writes', () => {
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

  const approvedWrite = structuredClone(snapshot);
  const writeCandidate = approvedWrite.candidates.find(({ risk }) => risk === 'write');
  writeCandidate.approvedSemanticRead = true;
  writeCandidate.approval = {
    provenance: 'reviewed search_actions catalog entry',
    reviewedAt: '2026-07-24T00:00:00.000Z',
    reviewedBy: 'grom-audit-contract',
  };
  approvedWrite.canonicalSha256 = snapshotHash(approvedWrite);
  assert.throws(() => PublicCatalogSnapshotSchema.parse(approvedWrite));
});

test('public action matching binds every tuple field and the catalog snapshot hash', () => {
  const allowlist = loadPublicReadAllowlist();
  const invalidAllowlist = structuredClone(allowlist);
  invalidAllowlist.actions[0].risk = 'write';
  assert.throws(() => PublicReadAllowlistSchema.parse(invalidAllowlist));
  const action = {
    ...allowlist.actions[0],
    sourceSnapshotHash: allowlist.sourceSnapshotHash,
  };
  assert.equal(assertAllowedPublicAction(allowlist, action), true);
  for (const [field, replacement] of [
    ['method', 'PATCH'],
    ['normalizedPath', '/contacts/other'],
    ['category', 'payments'],
    ['risk', 'write'],
    ['sourceSnapshotHash', 'a'.repeat(64)],
  ]) {
    assert.notEqual(action[field], replacement, `replacement for ${field} must differ from the fixture tuple`);
    assert.throws(() => assertAllowedPublicAction(allowlist, { ...action, [field]: replacement }), /PUBLIC_ACTION_NOT_ALLOWED/);
  }
});

/*
 * ONE CLINIC'S FACTS MUST NEVER REACH ANOTHER CLINIC'S AUDIT.
 *
 * `client` is a template shared by every clinic. For one run SK Skin's name and its six caveats sat
 * inside that shared file, which worked only because it was the only approved client account. A
 * caveat is an instruction about how to read evidence -- "nobody marks attendance here, so a zero
 * show rate is a recording gap" -- and inherited by an account where it is false it is worse than no
 * caveat at all, because it tells an expert to explain away a real defect.
 *
 * These assertions are written against the SHIPPED profiles rather than a fixture on purpose. A
 * fixture would agree with whatever the loader does; the thing worth pinning is that the file a real
 * run reads has not had one account's facts pasted into it.
 */
test('an account overlay names one account and never leaks into another', () => {
  const shared = loadProfile('client');
  assert.equal(shared.situation.accountName, undefined, 'the shared clinic template must not name an account');

  const skskin = loadProfile('client', 'uOsyigLIC8glCrwSNCne');
  assert.equal(skskin.situation.accountName, 'SK Skin and Body Health');

  // An account with no overlay file gets the template untouched, which is the regression that matters.
  const unknown = loadProfile('client', 'SJRURxzgbPTVBNLhqEZi');
  assert.deepEqual(unknown.situation, shared.situation);
  assert.equal(unknown.situation.accountName, undefined);
});

test('account caveats ADD to the shared ones and cannot silently drop them', () => {
  const shared = loadProfile('client');
  const skskin = loadProfile('client', 'uOsyigLIC8glCrwSNCne');
  for (const caveat of shared.situation.knownDataCaveats) {
    assert.ok(skskin.situation.knownDataCaveats.includes(caveat), 'a shared caveat went missing under an overlay');
  }
  assert.ok(
    skskin.situation.knownDataCaveats.length > shared.situation.knownDataCaveats.length,
    'the overlay contributed nothing',
  );
  // The benchmark targets are the template's job and an overlay has no business restating them.
  assert.deepEqual(skskin.situation.targets, shared.situation.targets);
});

test('an overlay cannot be reached by a traversing location id, and cannot claim another profile', () => {
  const shared = loadProfile('client');
  for (const hostile of ['../../etc/passwd', '../grom-internal', '..', '', 'a/b']) {
    assert.deepEqual(
      loadProfile('client', hostile).situation,
      shared.situation,
      `a location id of ${JSON.stringify(hostile)} must not select a file`,
    );
  }
});
