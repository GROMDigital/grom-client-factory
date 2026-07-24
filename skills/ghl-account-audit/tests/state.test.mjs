import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { canonicalJson, sha256 } from '../lib/canonical.mjs';
import { auditPaths } from '../lib/paths.mjs';
import { openState } from '../lib/state.mjs';

const expectedPrivateSource = Object.freeze({
  sourceId: 'expected-source',
  kind: 'private-content',
  payload: Object.freeze({ marker: 'expected-source-marker' }),
});
const privateSourceInventory = Object.freeze([Object.freeze({
  sourceId: expectedPrivateSource.sourceId,
  kind: expectedPrivateSource.kind,
  sourceHash: sha256({ schemaVersion: '1.0.0', source: expectedPrivateSource }),
})]);
const frozenInputs = Object.freeze({
  locationId: 'L1',
  cutoff: 1000,
  timezone: 'Australia/Sydney',
  contextHash: 'a',
  coverageProfileHash: 'b',
  metricProfileHash: 'metric-1',
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
  capabilityManifestHashes: ['manifest-1'],
  privateSourceInventory,
  privateSourceInventoryHash: sha256(privateSourceInventory),
  target: {
    targetKind: 'location',
    operatingProfile: 'client',
    locationId: 'L1',
  },
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

test('canonical JSON rejects values that JSON.stringify would erase or alias', () => {
  const cycle = {};
  cycle.self = cycle;
  const sparse = [];
  sparse[1] = 'present';
  const withHiddenValue = { visible: true };
  Object.defineProperty(withHiddenValue, 'hidden', { value: true });
  class Example {}

  for (const value of [
    undefined,
    Number.NaN,
    Infinity,
    -Infinity,
    -0,
    () => {},
    Symbol('value'),
    1n,
    new Date(),
    new Map(),
    new Set(),
    new Example(),
    sparse,
    cycle,
    { nested: undefined },
    [() => {}],
    withHiddenValue,
  ]) {
    assert.throws(() => canonicalJson(value), /CANONICAL_JSON_UNSUPPORTED/);
  }
  assert.throws(() => sha256({ nested: undefined }), /CANONICAL_JSON_UNSUPPORTED/);
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

test('state opening refuses a location symlink before writing outside the audit root', () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'ghl-audit-path-'));
  const external = mkdtempSync(join(tmpdir(), 'ghl-audit-external-'));
  const locationPath = join(projectRoot, 'audits', 'ghl', 'L1');
  try {
    mkdirSync(join(projectRoot, 'audits', 'ghl'), { recursive: true });
    symlinkSync(external, locationPath, 'dir');
    assert.throws(
      () => openState({ projectRoot, locationId: 'L1' }),
      /AUDIT_PATH_SYMLINK/,
    );
    assert.equal(existsSync(join(external, '.state', 'auditor.sqlite')), false);
    assert.deepEqual(readdirSync(external), []);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
    rmSync(external, { recursive: true, force: true });
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

test('createRun rejects omitted, unknown, and invalid frozen-input fields', () => withFixture(({ state }) => {
  for (const field of Object.keys(frozenInputs)) {
    const incomplete = { ...frozenInputs };
    delete incomplete[field];
    assert.throws(
      () => state.createRun({ runId: `missing-${field}`, frozenInputs: incomplete }),
      /INVALID_FROZEN_INPUTS/,
      field,
    );
  }
  assert.throws(
    () => state.createRun({ runId: 'unknown', frozenInputs: { ...frozenInputs, unexpected: true } }),
    /INVALID_FROZEN_INPUTS/,
  );
  assert.throws(
    () => state.createRun({ runId: 'invalid', frozenInputs: { ...frozenInputs, cutoff: Number.NaN } }),
    /INVALID_FROZEN_INPUTS/,
  );
  assert.throws(
    () => state.createRun({
      runId: 'invalid-target',
      frozenInputs: { ...frozenInputs, target: { ...frozenInputs.target, extra: true } },
    }),
    /INVALID_FROZEN_INPUTS/,
  );
}));

test('run state durably authorizes one exact terminal private-source inventory', () => withFixture(({ state }) => {
  state.createRun({ runId: 'inventory-run', frozenInputs, now: 1000 });
  const authority = state.getAuthorizedPrivateSourceInventory('inventory-run');
  assert.equal(authority.sourceInventoryHash, sha256(privateSourceInventory));
  assert.deepEqual(authority.sourceInventory, privateSourceInventory);
  assert.equal(Object.isFrozen(authority.sourceInventory), true);
  assert.throws(() => {
    authority.sourceInventory[0].sourceId = 'narrowed-source';
  }, TypeError);

  const invalidInventories = [
    {
      ...frozenInputs,
      privateSourceInventory: [],
      privateSourceInventoryHash: sha256([]),
    },
    {
      ...frozenInputs,
      privateSourceInventoryHash: '0'.repeat(64),
    },
    {
      ...frozenInputs,
      privateSourceInventory: [
        { ...privateSourceInventory[0], sourceId: 'z-source' },
        { ...privateSourceInventory[0], sourceId: 'a-source' },
      ],
      privateSourceInventoryHash: sha256([
        { ...privateSourceInventory[0], sourceId: 'z-source' },
        { ...privateSourceInventory[0], sourceId: 'a-source' },
      ]),
    },
  ];
  for (const [index, invalid] of invalidInventories.entries()) {
    assert.throws(
      () => state.createRun({
        runId: `invalid-inventory-${index}`,
        frozenInputs: invalid,
      }),
      /INVALID_FROZEN_INPUTS/u,
    );
  }
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
  assert.throws(
    () => state.assertResumeInputs('r1', { ...frozenInputs, unexpected: true }),
    /INVALID_FROZEN_INPUTS/,
  );
  for (const field of ['metricProfileHash', 'target']) {
    const incomplete = { ...frozenInputs };
    delete incomplete[field];
    assert.throws(
      () => state.assertResumeInputs('r1', incomplete),
      /INVALID_FROZEN_INPUTS/,
      field,
    );
  }
}));

test('proof resume mutations leave the old run and checkpoint set unchanged', () => withFixture(({ state }) => {
  state.createRun({ runId: 'r1', frozenInputs });
  state.saveCheckpoint({
    runId: 'r1',
    phase: 'proof-inputs',
    inputHash: 'input-1',
    outputHash: 'output-1',
    payload: { receipts: ['receipt-1'] },
  });
  const oldState = canonicalJson({
    run: state.assertResumeInputs('r1', frozenInputs),
    checkpoints: state.listCheckpoints('r1'),
  });

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
    assert.equal(canonicalJson({
      run: state.assertResumeInputs('r1', frozenInputs),
      checkpoints: state.listCheckpoints('r1'),
    }), oldState);
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
