import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import {
  createAuditKernel,
  mergeExactEvents,
  planWeeklyCollection,
} from '../lib/kernel.mjs';
import { enforcePublicOnlyPublication } from '../lib/modes/weekly.mjs';
import { openState } from '../lib/state.mjs';
import { sha256 } from '../lib/canonical.mjs';

const SOURCE = Object.freeze({
  sourceId: 'source-weekly',
  kind: 'private-content',
  sourceHash: 'a'.repeat(64),
});

function frozenInputs(overrides = {}) {
  const inventory = [SOURCE];
  return {
    locationId: 'L1',
    target: {
      targetKind: 'location',
      operatingProfile: 'client',
      locationId: 'L1',
    },
    cutoff: 1_750_032_000_000,
    timezone: 'Australia/Sydney',
    contextHash: 'context-1',
    coverageProfileHash: 'coverage-1',
    metricProfileHash: 'metric-1',
    rulesetHash: 'rules-1',
    codeHash: 'code-1',
    auditProfileHash: 'profile-1',
    providerToolProfileHash: 'provider-1',
    windowDefinitionsHash: 'windows-1',
    collectionBudgetHash: 'budget-1',
    capabilityManifestHashes: ['manifest-1'],
    capabilityProofIndexHash: 'proof-index-1',
    capabilityReceiptHashes: ['receipt-1'],
    capabilityAttestationHashes: ['attestation-1'],
    capabilityProofExpiries: [1_850_032_000_000],
    privateSourceInventory: inventory,
    privateSourceInventoryHash: sha256(inventory),
    ...overrides,
  };
}

async function withProject(callback) {
  const projectRoot = mkdtempSync(join(tmpdir(), 'ghl-weekly-'));
  try {
    return await callback(projectRoot);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
}

test('first public-only run requests a mature baseline and has no movement labels', () => {
  const plan = planWeeklyCollection({
    cutoff: '2026-07-20T00:00:00.000Z',
    timezone: 'Australia/Sydney',
    salesCycleDays: 60,
    providerAvailableFrom: '2026-06-01T00:00:00.000Z',
  });
  assert.equal(plan.mode, 'first');
  assert.equal(plan.requestedHistoryDays, 120);
  assert.equal(plan.appliedHistoryDays < plan.requestedHistoryDays, true);
  assert.ok(plan.limitations.includes('PROVIDER_HISTORY_SHORTER_THAN_REQUESTED'));
  const output = enforcePublicOnlyPublication({
    diff: { state: 'FIRST_BASELINE', transitions: [] },
    coverage: { state: 'complete_partial', limitations: [] },
    findings: [],
  });
  assert.equal(output.status, 'complete_partial');
  assert.doesNotMatch(JSON.stringify(output), /IMPROVING|REGRESSED|RESOLVED/u);
});

test('later run refetches a 72 hour overlap and deduplicates exact late events', () => {
  const plan = planWeeklyCollection({
    cutoff: '2026-07-20T00:00:00.000Z',
    timezone: 'Australia/Sydney',
    priorWatermark: '2026-07-18T00:00:00.000Z',
    lateArrivalHours: 24,
  });
  assert.equal(plan.mode, 'later');
  assert.equal(plan.collectionStart, '2026-07-15T00:00:00.000Z');
  const left = [
    { nativeEventId: 'event-2', occurredAt: '2026-07-17T00:00:00.000Z', value: 2 },
    { nativeEventId: 'event-1', occurredAt: '2026-07-17T00:00:00.000Z', value: 1 },
  ];
  const right = [
    structuredClone(left[0]),
    { nativeEventId: 'event-3', occurredAt: '2026-07-17T00:00:00.000Z', value: 3 },
  ];
  assert.deepEqual(
    mergeExactEvents({ priorEvents: left, collectedEvents: right }),
    mergeExactEvents({ priorEvents: [...left].reverse(), collectedEvents: [...right].reverse() }),
  );
  assert.equal(mergeExactEvents({ priorEvents: left, collectedEvents: right }).length, 3);
});

test('discovery is sealed before prior finding memory is loaded', async () => {
  await withProject(async (projectRoot) => {
    const calls = [];
    const kernel = createAuditKernel({
      clock: () => 1_750_032_000_000,
      idFactory: () => 'run_order',
      keyResolver: () => ({
        encryptionKey: Buffer.alloc(32, 1),
        pseudonymKey: Buffer.alloc(32, 2),
      }),
      stateStore: { open: openState },
      adapters: {
        collectContext: async () => ({ context: 'safe' }),
        collectPublic: async () => ({ events: [] }),
      },
      analyzer: {
        freezeInputs: () => frozenInputs(),
        normalize: async () => (calls.push('normalize'), { graph: 'safe' }),
        discover: async () => (calls.push('discover'), { findings: [] }),
        falsify: async () => (calls.push('falsify'), { packets: [] }),
        loadMemory: async () => (calls.push('memory'), { events: [] }),
        compile: async () => ({ status: 'complete_partial', payload: 'safe' }),
      },
      verifier: async () => ({ result: 'pass' }),
      publisher: async () => ({ publicationId: 'pub_order' }),
    });
    await kernel.start({
      mode: 'weekly',
      target: frozenInputs().target,
      projectRoot,
      cutoff: frozenInputs().cutoff,
      providerId: 'provider',
      profile: 'client',
      providerConfig: {},
      vaultKeyReference: 'opaque-ref',
    });
    assert.deepEqual(calls, ['normalize', 'discover', 'falsify', 'memory']);
  });
});

test('public-only publication is partial and never replaces latest full', () => {
  const result = enforcePublicOnlyPublication({
    coverage: { state: 'complete_full', limitations: [] },
    diff: { state: 'COMPARABLE', transitions: [] },
    findings: [{ scope: 'account_wide', verdict: 'PASS', impact: 100 }],
    latestFull: { publicationId: 'full-1' },
  });
  assert.equal(result.status, 'complete_partial');
  assert.deepEqual(result.latestFull, { publicationId: 'full-1' });
  assert.ok(result.coverage.limitations.includes('INTERNAL_WORKFLOW_DEFINITION_MISSING'));
  assert.ok(result.coverage.limitations.includes('INTERNAL_WORKFLOW_RUNTIME_MISSING'));
  assert.equal(result.findings[0].scope, 'public_comparable_subset');
  assert.equal(result.findings[0].impact, null);
  assert.equal(result.findings[0].verdict, 'UNKNOWN');
});

test('resume is byte equivalent and publication intent is exactly once', () => withProject((projectRoot) => {
  const state = openState({ projectRoot, locationId: 'L1' });
  try {
    state.createRun({ runId: 'run-once', frozenInputs: frozenInputs(), now: 1 });
    const first = state.preparePublicationIntent({
      runId: 'run-once',
      revisionHash: 'b'.repeat(64),
      publicationId: 'pub-once',
      now: 2,
    });
    const retry = state.preparePublicationIntent({
      runId: 'run-once',
      revisionHash: 'b'.repeat(64),
      publicationId: 'pub-other',
      now: 3,
    });
    assert.deepEqual(retry, first);
    state.markPublicationIntentPublished({
      runId: 'run-once',
      revisionHash: 'b'.repeat(64),
      manifestHash: 'c'.repeat(64),
      publicationRoot: 'd'.repeat(64),
      now: 4,
    });
    assert.equal(state.getPublicationIntent('run-once', 'b'.repeat(64)).status, 'published');
  } finally {
    state.close();
  }
}));

test('changed frozen inputs create a distinct run without touching the old run', async () => {
  await withProject(async (projectRoot) => {
    let version = frozenInputs();
    let ids = ['run-old', 'run-new'];
    const kernel = createAuditKernel({
      clock: () => 1_750_032_000_000,
      idFactory: () => ids.shift(),
      keyResolver: () => ({
        encryptionKey: Buffer.alloc(32, 3),
        pseudonymKey: Buffer.alloc(32, 4),
      }),
      stateStore: { open: openState },
      adapters: {
        collectContext: async () => ({}),
        collectPublic: async () => ({ events: [] }),
      },
      analyzer: {
        freezeInputs: () => version,
        normalize: async () => ({}),
        discover: async () => ({}),
        falsify: async () => ({ packets: [] }),
        loadMemory: async () => ({}),
        compile: async () => ({ status: 'complete_partial' }),
      },
      verifier: async () => ({ result: 'pass' }),
      publisher: async () => ({ publicationId: 'pub' }),
    });
    await kernel.start({
      mode: 'weekly',
      target: frozenInputs().target,
      projectRoot,
      cutoff: frozenInputs().cutoff,
      providerId: 'provider',
      profile: 'client',
      providerConfig: {},
      vaultKeyReference: 'opaque-ref',
    });
    version = frozenInputs({ codeHash: 'code-2' });
    const result = await kernel.resume({
      projectRoot,
      locationId: 'L1',
      runId: 'run-old',
      vaultKeyReference: 'opaque-ref',
    });
    assert.equal(result.status, 'RESUME_INPUT_MISMATCH');
    assert.equal(result.oldRunId, 'run-old');
    assert.equal(result.newRunId, 'run-new');
    const state = openState({ projectRoot, locationId: 'L1' });
    try {
      assert.equal(state.listCheckpoints('run-old').length > 0, true);
      assert.equal(state.listCheckpoints('run-new').length > 0, true);
    } finally {
      state.close();
    }
  });
});

test('review requests survive process restart and valid responses consume once', () => withProject((projectRoot) => {
  let state = openState({ projectRoot, locationId: 'L1' });
  state.createRun({ runId: 'run-review', frozenInputs: frozenInputs(), now: 1 });
  state.saveReviewRequest({
    runId: 'run-review',
    kind: 'conversation',
    request: { requestId: 'review_1', nonce: 'a'.repeat(32), requestHash: 'b'.repeat(64) },
    validatorState: { safe: true },
    sealedRelativePath: 'private/checkpoints/run-review/review_1.json',
    createdAt: 2,
    deadline: 20,
    grants: [{ grantRef: 'grant_1', evidenceRef: 'ev_1' }],
  });
  state.close();
  state = openState({ projectRoot, locationId: 'L1' });
  try {
    assert.equal(state.getReviewRequest('review_1').status, 'pending');
    const result = state.consumeReviewRequest({
      requestId: 'review_1',
      responseHash: 'c'.repeat(64),
      resultHash: sha256({ safe: true }),
      result: { safe: true },
      consumedAt: 3,
    });
    assert.equal(result.status, 'consumed');
    assert.throws(() => state.consumeReviewRequest({
      requestId: 'review_1',
      responseHash: 'c'.repeat(64),
      resultHash: sha256({ safe: true }),
      result: { safe: true },
      consumedAt: 4,
    }), /REVIEW_RESPONSE_REPLAYED/u);
  } finally {
    state.close();
  }
}));

test('invalid review responses are atomic and leave awaiting checkpoint unchanged', () => withProject((projectRoot) => {
  const state = openState({ projectRoot, locationId: 'L1' });
  try {
    state.createRun({ runId: 'run-invalid-review', frozenInputs: frozenInputs(), now: 1 });
    state.saveCheckpoint({
      runId: 'run-invalid-review',
      phase: 'awaiting_model_review',
      inputHash: 'a',
      outputHash: 'b',
      payload: { status: 'awaiting_model_review' },
    });
    state.saveReviewRequest({
      runId: 'run-invalid-review',
      kind: 'mechanism',
      request: { requestId: 'mechanism_1', nonceRef: 'nonce_1', requestHash: 'c'.repeat(64) },
      validatorState: { safe: true },
      sealedRelativePath: 'private/checkpoints/run-invalid-review/mechanism_1.json',
      createdAt: 2,
      deadline: 20,
      grants: [],
    });
    const before = JSON.stringify(state.getReviewRequest('mechanism_1'));
    assert.throws(() => state.validateAndConsumeReviewRequest({
      requestId: 'mechanism_1',
      response: { unsafe: true },
      consumedAt: 3,
      validate: () => { throw Object.assign(new Error('REVIEW_RESPONSE_MISMATCH'), { code: 'REVIEW_RESPONSE_MISMATCH' }); },
    }), /REVIEW_RESPONSE_MISMATCH/u);
    assert.equal(JSON.stringify(state.getReviewRequest('mechanism_1')), before);
    assert.equal(state.getCheckpoint({
      runId: 'run-invalid-review',
      phase: 'awaiting_model_review',
    }).payload.status, 'awaiting_model_review');
  } finally {
    state.close();
  }
}));

test('missing or invalid vault reference fails before run state', async () => {
  await withProject(async (projectRoot) => {
    const kernel = createAuditKernel({
      clock: () => 1,
      idFactory: () => 'never-created',
      keyResolver: () => { throw Object.assign(new Error('AUDIT_PREFLIGHT_FAILED'), { code: 'AUDIT_PREFLIGHT_FAILED' }); },
      stateStore: { open: openState },
      adapters: {},
      analyzer: {},
      verifier: () => {},
      publisher: () => {},
    });
    await assert.rejects(() => kernel.start({
      mode: 'weekly',
      target: frozenInputs().target,
      projectRoot,
      cutoff: frozenInputs().cutoff,
      providerId: 'provider',
      profile: 'client',
      providerConfig: {},
      vaultKeyReference: 'sensitive-reference',
    }), /AUDIT_PREFLIGHT_FAILED/u);
    assert.equal(existsSync(join(projectRoot, 'audits')), false);
  });
});

test('integrity failure quarantines and publishes nothing', async () => {
  await withProject(async (projectRoot) => {
    let published = 0;
    const kernel = createAuditKernel({
      clock: () => 1_750_032_000_000,
      idFactory: () => 'run-quarantine',
      keyResolver: () => ({
        encryptionKey: Buffer.alloc(32, 5),
        pseudonymKey: Buffer.alloc(32, 6),
      }),
      stateStore: { open: openState },
      adapters: {
        collectContext: async () => ({}),
        collectPublic: async () => ({ trace: { method: 'POST' } }),
      },
      analyzer: { freezeInputs: () => frozenInputs() },
      verifier: async () => ({ result: 'pass' }),
      publisher: async () => { published += 1; },
    });
    await assert.rejects(() => kernel.start({
      mode: 'weekly',
      target: frozenInputs().target,
      projectRoot,
      cutoff: frozenInputs().cutoff,
      providerId: 'provider',
      profile: 'client',
      providerConfig: {},
      vaultKeyReference: 'opaque-ref',
    }), /AUDIT_INTEGRITY_FAILURE|AUDIT_QUARANTINED/u);
    assert.equal(published, 0);
  });
});

test('first partial and later superseding revision use distinct immutable publications', () => withProject((projectRoot) => {
  const state = openState({ projectRoot, locationId: 'L1' });
  try {
    state.createRun({ runId: 'run-revisions', frozenInputs: frozenInputs(), now: 1 });
    const first = state.preparePublicationIntent({
      runId: 'run-revisions',
      revisionHash: '1'.repeat(64),
      publicationId: 'pub-1',
      now: 2,
    });
    const second = state.preparePublicationIntent({
      runId: 'run-revisions',
      revisionHash: '2'.repeat(64),
      publicationId: 'pub-2',
      now: 3,
    });
    assert.notEqual(first.publicationId, second.publicationId);
    assert.equal(state.listPublicationIntents('run-revisions').length, 2);
  } finally {
    state.close();
  }
}));

test('bundled CLI replays without node_modules and emits only safe status paths', () => withProject((outputRoot) => {
  const root = new URL('..', import.meta.url).pathname;
  const cli = join(root, 'dist', 'audit-cli.mjs');
  const fixture = join(root, 'tests', 'fixtures', 'weekly', 'client-partial-pagination');
  const result = spawnSync(process.execPath, [cli, 'replay', '--fixture', fixture, '--output', outputRoot], {
    cwd: tmpdir(),
    env: { PATH: process.env.PATH },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  const status = JSON.parse(result.stdout);
  assert.equal(status.status, 'complete_partial');
  const combined = `${result.stdout}\n${result.stderr}`;
  for (const canary of [
    'credential_supersecret',
    'sensitive-key-reference',
    'person@example.com',
    '+15551234567',
    'private transcript',
    'hidden prompt',
  ]) assert.equal(combined.includes(canary), false);
  assert.equal(readFileSync(join(outputRoot, status.publicationPath, 'coverage.json'), 'utf8').includes('complete_partial'), true);
}));
