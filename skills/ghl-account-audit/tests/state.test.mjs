import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { canonicalJson, sha256 } from '../lib/canonical.mjs';
import { auditPaths } from '../lib/paths.mjs';
import { openState } from '../lib/state.mjs';

const frozenInputs = Object.freeze({
  locationId: 'L1',
  cutoff: 1000,
  timezone: 'Australia/Sydney',
  contextHash: 'a',
  coverageProfileHash: 'b',
  rulesetHash: 'c',
  codeHash: 'code-1',
  auditProfileHash: 'profile-1',
  providerToolProfileHash: 'provider-1',
  windowDefinitionsHash: 'windows-1',
  collectionBudgetHash: 'budget-1',
  capabilityProofIndexHash: 'proof-index-1',
  capabilityReceiptHashes: ['receipt-1'],
  capabilityAttestationHashes: ['attestation-1'],
  capabilityProofExpiries: [2000],
  capabilityManifestHashes: ['d'],
  target: { accountId: 'account-1' },
});

function openFixtureState() {
  const projectRoot = mkdtempSync(join(tmpdir(), 'ghl-audit-state-'));
  const state = openState({ projectRoot, locationId: 'L1' });
  return {
    state,
    projectRoot,
    [Symbol.dispose]() {
      state.close();
      rmSync(projectRoot, { recursive: true, force: true });
    },
  };
}

function withFixture(callback) {
  const fixture = openFixtureState();
  try {
    callback(fixture);
  } finally {
    fixture[Symbol.dispose]();
  }
}

test('canonical JSON sorts object keys while preserving array order', () => {
  assert.equal(canonicalJson({ z: [2, { b: 1, a: 0 }], a: true }), '{"a":true,"z":[2,{"a":0,"b":1}]}');
  assert.equal(sha256({ b: 1, a: 2 }), sha256({ a: 2, b: 1 }));
  assert.notEqual(sha256([1, 2]), sha256([2, 1]));
});

test('audit paths are frozen, location-bound, and traversal-safe', () => {
  const paths = auditPaths('/tmp/project', 'L1');
  assert.ok(Object.isFrozen(paths));
  assert.equal(paths.root, '/tmp/project/audits/ghl/L1');
  assert.equal(paths.weekly, '/tmp/project/audits/ghl/L1/weekly');
  assert.equal(paths.memoryEvents, '/tmp/project/audits/ghl/L1/memory/events');
  assert.equal(paths.privateRaw, '/tmp/project/audits/ghl/L1/private/raw');
  assert.equal(paths.privateLogs, '/tmp/project/audits/ghl/L1/private/logs');
  assert.equal(paths.privateCheckpoints, '/tmp/project/audits/ghl/L1/private/checkpoints');
  assert.equal(paths.stateDb, '/tmp/project/audits/ghl/L1/.state/auditor.sqlite');
  for (const locationId of ['', ' ', '..', 'a/../b', 'a/b', 'a\\b']) {
    assert.throws(() => auditPaths('/tmp/project', locationId), /INVALID_LOCATION_ID/);
  }
});

test('one active lease is allowed per location', () => withFixture(({ state }) => {
  state.acquireLease({ runId: 'r1', now: 1000, ttlMs: 60000 });
  assert.throws(
    () => state.acquireLease({ runId: 'r2', now: 1001, ttlMs: 60000 }),
    /LEASE_HELD/,
  );
  state.acquireLease({ runId: 'r2', now: 61000, ttlMs: 60000 });
}));

test('runs are idempotent only for identical frozen inputs', () => withFixture(({ state }) => {
  state.createRun({ runId: 'r1', frozenInputs, now: 1000 });
  state.createRun({ runId: 'r1', frozenInputs: { ...frozenInputs }, now: 2000 });
  assert.throws(
    () => state.createRun({ runId: 'r1', frozenInputs: { ...frozenInputs, cutoff: 2000 } }),
    /RUN_ID_COLLISION/,
  );
}));

test('run state survives closing and reopening the location database', () => withFixture(({ state, projectRoot }) => {
  state.createRun({ runId: 'r1', frozenInputs, now: 1000 });
  state.close();
  const reopened = openState({ projectRoot, locationId: 'L1' });
  try {
    assert.equal(reopened.assertResumeInputs('r1', frozenInputs).frozenInputsHash, sha256(frozenInputs));
  } finally {
    reopened.close();
  }
}));

test('resume rejects changed frozen inputs', () => withFixture(({ state }) => {
  state.createRun({ runId: 'r1', frozenInputs });
  assert.throws(() => state.assertResumeInputs('r1', {
    ...frozenInputs,
    cutoff: 2000,
  }), /RESUME_INPUT_MISMATCH/);
}));

test('proof resume mutations reject and create no checkpoint under the old run', () => withFixture(({ state }) => {
  state.createRun({ runId: 'r1', frozenInputs });

  for (const [name, changedInputs] of [
    ['proof index', { ...frozenInputs, capabilityProofIndexHash: 'proof-index-2' }],
    ['applicable receipt', { ...frozenInputs, capabilityReceiptHashes: ['receipt-2'] }],
    ['referenced attestation', { ...frozenInputs, capabilityAttestationHashes: ['attestation-2'] }],
    ['proof expiry', { ...frozenInputs, capabilityProofExpiries: [2001] }],
  ]) {
    assert.throws(
      () => state.assertResumeInputs('r1', changedInputs),
      new RegExp(`RESUME_INPUT_MISMATCH`, 'u'),
      name,
    );
    assert.equal(state.getCheckpoint({ runId: 'r1', phase: name }), undefined);
  }
}));

test('checkpoints are atomically idempotent and cannot be overwritten', () => withFixture(({ state }) => {
  state.createRun({ runId: 'r1', frozenInputs });
  const checkpoint = {
    runId: 'r1',
    phase: 'contacts',
    inputHash: 'input-1',
    outputHash: 'output-1',
    payload: { cursor: 'next', records: ['a'] },
  };
  state.saveCheckpoint(checkpoint);
  state.saveCheckpoint({ ...checkpoint, payload: { records: ['a'], cursor: 'next' } });
  assert.deepEqual(state.getCheckpoint({ runId: 'r1', phase: 'contacts' }), checkpoint);
  assert.throws(
    () => state.saveCheckpoint({ ...checkpoint, outputHash: 'output-2' }),
    /CHECKPOINT_CONFLICT/,
  );
}));
