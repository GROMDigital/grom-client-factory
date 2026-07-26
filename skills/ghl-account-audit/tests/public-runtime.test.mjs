/**
 * The PUBLIC composition root.
 *
 * Task 4 shipped `createPublicGhlAdapter` and `connectMcp` fully tested and bound to nothing:
 * `cli/audit.mjs` built a kernel only for `adapterKind: 'local_fixture'`, so the delivered CLI
 * could replay a fixture and could not audit an account. Task 9's own acceptance gate exercised
 * `replay` only, which is why an offline gate could not detect it.
 *
 * Every test here proves the wiring WITHOUT a network call: the transport is the injected
 * `transport.connect` seam that `tests/adapters.test.mjs` established, and the delegate it returns
 * is a hermetic double. No test in this file opens a socket, spawns a process, reads an
 * environment credential, or touches a real GHL account.
 */
import assert from 'node:assert/strict';
import { createDecipheriv } from 'node:crypto';
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { test } from 'node:test';
import { runAuditCli } from '../cli/audit.mjs';
import { canonicalJson, sha256 } from '../lib/canonical.mjs';
import {
  createLocalAuditKernel,
  createPublicAuditKernel,
  publicProviderDescriptor,
  validatePublicConfig,
} from '../lib/local-runtime.mjs';
import { auditPaths } from '../lib/paths.mjs';
import { openState } from '../lib/state.mjs';
import { loadPublicReadAllowlist } from '../schemas/v1.mjs';

const allowlist = loadPublicReadAllowlist();
const SNAPSHOT_HASH = allowlist.sourceSnapshotHash;
const ALLOWLIST_HASH = sha256(allowlist);
const MANIFEST_HASH = '8'.repeat(64);
const CUTOFF = 1_750_032_000_000;
const DAY_MS = 86_400_000;
const EXPECTED_WINDOW = Object.freeze({
  from: new Date(CUTOFF - 90 * DAY_MS).toISOString(),
  to: new Date(CUTOFF).toISOString(),
});
const CREDENTIAL_VALUE = 'private-token-canary';
const ITEM_CANARY = 'CONTACT-CANARY-1';
const VAULT_KEY_REFERENCE = 'test-only:key';
// `localKeyMaterial` derives the vault's 64-byte layout for the hermetic reference exactly as
// `lib/vault.mjs` splits a key file: 32 bytes of 0x31 then 32 bytes of 0x32.
const PHASE_ENCRYPTION_KEY = Buffer.alloc(32, 0x31);

function frozenInputsWithoutInventory(overrides = {}) {
  return {
    locationId: 'L1',
    target: {
      targetKind: 'location',
      operatingProfile: 'client',
      locationId: 'L1',
    },
    cutoff: CUTOFF,
    timezone: 'Australia/Sydney',
    contextHash: 'context-public-1',
    coverageProfileHash: 'coverage-public-1',
    metricProfileHash: 'metric-public-1',
    rulesetHash: 'rules-public-1',
    codeHash: 'code-public-1',
    auditProfileHash: 'profile-public-1',
    providerToolProfileHash: 'provider-public-1',
    windowDefinitionsHash: 'windows-public-1',
    collectionBudgetHash: 'budget-public-1',
    capabilityManifestHashes: ['manifest-public-1'],
    capabilityProofIndexHash: 'proof-index-public-1',
    capabilityReceiptHashes: ['receipt-public-1'],
    capabilityAttestationHashes: ['attestation-public-1'],
    capabilityProofExpiries: [1_850_032_000_000],
    ...overrides,
  };
}

function publicConfig(overrides = {}) {
  return {
    schemaVersion: '1.0.0',
    adapterKind: 'ghl_public',
    runId: 'run_public_1',
    providerId: 'fixture-provider',
    expectedLocationId: 'L1',
    capabilityManifestHash: MANIFEST_HASH,
    publicCatalogSnapshotHash: SNAPSHOT_HASH,
    publicReadAllowlistHash: ALLOWLIST_HASH,
    credentialRef: { kind: 'environment', name: 'FIXTURE_TOKEN' },
    transport: {
      kind: 'streamable-http',
      url: 'https://mcp.invalid.example.test',
    },
    capabilities: [
      { operationId: 'contacts-weekly', actionId: 'contacts.search' },
      { operationId: 'opportunities-weekly', actionId: 'opportunities.list' },
    ],
    cutoff: CUTOFF,
    timezone: 'Australia/Sydney',
    frozenInputs: frozenInputsWithoutInventory(),
    context: { safe: 'context' },
    reviews: [],
    ...overrides,
  };
}

async function withProject(run) {
  const projectRoot = realpathSync(mkdtempSync(join(tmpdir(), 'public-runtime-')));
  try {
    return await run({
      projectRoot,
      writeConfig(config) {
        const pathname = join(projectRoot, 'provider.json');
        writeFileSync(pathname, `${JSON.stringify(config)}\n`);
        return pathname;
      },
    });
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
}

/** A page body as the provider would return it, echoing the window the request asked for. */
function page({
  locationId = 'L1',
  cursor = null,
  nextCursor = null,
  items,
  reportedCount,
  complete = nextCursor === null,
  truncated = false,
  params,
}) {
  return {
    locationId,
    appliedWindow: { from: params.fromDate, to: params.toDate },
    items,
    page: {
      cursor,
      nextCursor,
      reportedCount,
      complete,
      truncated,
    },
  };
}

/** A two-page scope that terminates honestly. */
function terminalHandler(prefix, { locationId = 'L1' } = {}) {
  return (params) => (params.cursor === null
    ? page({
        locationId,
        cursor: null,
        nextCursor: `${prefix}-c1`,
        items: [{ id: `${prefix}-1` }],
        reportedCount: 2,
        params,
      })
    : page({
        locationId,
        cursor: `${prefix}-c1`,
        nextCursor: null,
        items: [{ id: `${prefix}-2` }],
        reportedCount: 2,
        params,
      }));
}

/** A scope that never terminates, so the versioned page budget has to stop it. */
function unboundedHandler(prefix) {
  let issued = 0;
  return (params) => {
    issued += 1;
    return page({
      cursor: params.cursor,
      nextCursor: `${prefix}-c${issued}`,
      items: [{ id: `${prefix}-${issued}` }],
      reportedCount: 1_000,
      complete: false,
      params,
    });
  };
}

function hermeticTransport(handlers) {
  const observed = {
    connects: 0,
    connectOptions: [],
    dispatches: [],
    closes: 0,
  };
  return {
    observed,
    async connect(options) {
      observed.connects += 1;
      observed.connectOptions.push(structuredClone(options));
      return {
        async callTool(request) {
          observed.dispatches.push(structuredClone(request));
          const handler = handlers[request.arguments.action];
          if (!handler) throw new Error('UNEXPECTED_ACTION');
          return { structuredContent: handler(request.arguments.params) };
        },
        async close() {
          observed.closes += 1;
        },
      };
    },
  };
}

function collectStdout() {
  const chunks = [];
  return {
    chunks,
    write(chunk) {
      chunks.push(String(chunk));
      return true;
    },
  };
}

async function runPublicCli({
  projectRoot,
  configPath,
  publicRuntime,
  argv,
}) {
  const stdout = collectStdout();
  const result = await runAuditCli({
    argv: argv ?? [
      'run',
      '--mode', 'weekly',
      '--project', projectRoot,
      '--location', 'L1',
      '--profile', 'client',
      '--provider-config', configPath,
      '--vault-key-ref', VAULT_KEY_REFERENCE,
    ],
    stdout,
    publicRuntime,
  });
  return { result, stdout: stdout.chunks.join('') };
}

function readRun(projectRoot, runId) {
  const state = openState({ projectRoot, locationId: 'L1' });
  try {
    return state.getRun(runId);
  } finally {
    state.close();
  }
}

/**
 * Reads back what the run actually checkpointed for `collecting_public`. The phase artefact is
 * AES-256-GCM under the run's vault key with the phase identity as AAD, so decrypting it here is
 * the only honest way to assert what the composition root handed the kernel.
 */
function decryptPhaseArtifact(projectRoot, runId, filename) {
  const paths = auditPaths(projectRoot, 'L1');
  const envelope = JSON.parse(readFileSync(
    join(paths.privateCheckpoints, runId, 'phases', filename),
    'utf8',
  ));
  const decipher = createDecipheriv(
    'aes-256-gcm',
    PHASE_ENCRYPTION_KEY,
    Buffer.from(envelope.iv, 'base64'),
  );
  decipher.setAAD(Buffer.from(canonicalJson({
    schemaVersion: '1.0.0',
    runId: envelope.runId,
    phase: envelope.phase,
    inputHash: envelope.inputHash,
  }), 'utf8'));
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  return JSON.parse(Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8'));
}

function walkFiles(root, found = []) {
  for (const entry of readdirSync(root)) {
    const pathname = join(root, entry);
    if (statSync(pathname).isDirectory()) walkFiles(pathname, found);
    else found.push(pathname);
  }
  return found;
}

test('public rail collects a real sub-account through the injected transport and publishes', async () => withProject(async ({ projectRoot, writeConfig }) => {
  const transport = hermeticTransport({
    'contacts.search': terminalHandler('contact'),
    'opportunities.list': terminalHandler('opportunity'),
  });
  const resolvedReferences = [];
  const { result, stdout } = await runPublicCli({
    projectRoot,
    configPath: writeConfig(publicConfig()),
    publicRuntime: {
      transportConnect: transport.connect,
      credentialResolver: async (reference) => {
        resolvedReferences.push(structuredClone(reference));
        return CREDENTIAL_VALUE;
      },
    },
  });

  assert.equal(result.status, 'complete_partial');
  assert.equal(result.runId, 'run_public_1');
  assert.ok(result.publicationId);

  // One connection, four dispatches (two pages for each of two capabilities), one close.
  assert.equal(transport.observed.connects, 1);
  assert.equal(transport.observed.dispatches.length, 4);
  assert.equal(transport.observed.closes, 1);
  assert.deepEqual(resolvedReferences, [{ kind: 'environment', name: 'FIXTURE_TOKEN' }]);

  // Every dispatch is an allowlisted read, bound to one location, over the DERIVED window.
  for (const dispatch of transport.observed.dispatches) {
    assert.equal(dispatch.name, 'execute_action');
    assert.equal(dispatch.arguments.params.locationId, 'L1');
    assert.equal(dispatch.arguments.params.fromDate, EXPECTED_WINDOW.from);
    assert.equal(dispatch.arguments.params.toDate, EXPECTED_WINDOW.to);
    assert.equal(Object.hasOwn(dispatch.arguments, 'confirm'), false);
    assert.equal(Object.hasOwn(dispatch.arguments, 'raw_request'), false);
  }
  assert.deepEqual(
    [...new Set(transport.observed.dispatches.map(({ arguments: args }) => args.action))].sort(),
    ['contacts.search', 'opportunities.list'],
  );

  // The status line is the only thing the CLI prints.
  assert.deepEqual(JSON.parse(stdout), result);
}));

test('privateSourceInventoryHash is derived from the collected envelopes before createRun', async () => withProject(async ({ projectRoot, writeConfig }) => {
  const transport = hermeticTransport({
    'contacts.search': terminalHandler('contact'),
    'opportunities.list': terminalHandler('opportunity'),
  });
  await runPublicCli({
    projectRoot,
    configPath: writeConfig(publicConfig()),
    publicRuntime: {
      transportConnect: transport.connect,
      credentialResolver: async () => CREDENTIAL_VALUE,
    },
  });

  const { frozenInputs } = readRun(projectRoot, 'run_public_1');
  const inventory = frozenInputs.privateSourceInventory;
  assert.equal(inventory.length, 2);
  assert.equal(frozenInputs.privateSourceInventoryHash, sha256(inventory));
  assert.deepEqual(
    [...inventory].sort((left, right) => (left.sourceId < right.sourceId ? -1 : 1)),
    inventory,
    'inventory must already be sorted by sourceId',
  );

  // The sourceIds are the ones `lib/adapters/collection.mjs` mints for these operations.
  const expectedIds = ['contacts-weekly', 'opportunities-weekly'].map((operationId) => (
    `public_ghl.${sha256({ operationId, source: 'public_ghl' }).slice(0, 32)}`
  )).sort();
  assert.deepEqual(inventory.map(({ sourceId }) => sourceId).sort(), expectedIds);

  // And every sourceHash is the hash of the envelope the collection actually produced, read back
  // out of the encrypted `collecting_public` phase artefact.
  const evidence = decryptPhaseArtifact(projectRoot, 'run_public_1', '03-collecting_public.json');
  assert.equal(evidence.privateSourceEnvelopes.length, 2);
  const byId = new Map(inventory.map((entry) => [entry.sourceId, entry]));
  for (const envelope of evidence.privateSourceEnvelopes) {
    const entry = byId.get(envelope.sourceId);
    assert.ok(entry, `envelope ${envelope.sourceId} is not in the sealed inventory`);
    assert.equal(entry.kind, 'private-content');
    assert.equal(entry.sourceHash, sha256({ schemaVersion: '1.0.0', source: envelope }));
  }
  assert.equal(evidence.boundLocationId, 'L1');
  assert.deepEqual(evidence.collectionWindow, { from: EXPECTED_WINDOW.from, to: EXPECTED_WINDOW.to });
  assert.deepEqual(evidence.scopes.map(({ status }) => status), ['complete', 'complete']);
}));

test('a budget-exhausted scope is complete_partial with a checkpoint and never throws', async () => withProject(async ({ projectRoot, writeConfig }) => {
  const transport = hermeticTransport({
    'contacts.search': unboundedHandler('contact'),
    'opportunities.list': terminalHandler('opportunity'),
  });
  const { result } = await runPublicCli({
    projectRoot,
    configPath: writeConfig(publicConfig()),
    publicRuntime: {
      transportConnect: transport.connect,
      credentialResolver: async () => CREDENTIAL_VALUE,
    },
  });
  assert.equal(result.status, 'complete_partial');

  // `profiles/collection-budgets.v1.json` allows 100 contact pages; the 100th ends the scope.
  const contactDispatches = transport.observed.dispatches.filter(
    ({ arguments: args }) => args.action === 'contacts.search',
  );
  assert.equal(contactDispatches.length, 100);

  const evidence = decryptPhaseArtifact(projectRoot, 'run_public_1', '03-collecting_public.json');
  const contacts = evidence.scopes.find(({ operationId }) => operationId === 'contacts-weekly');
  assert.equal(contacts.status, 'complete_partial');
  assert.equal(contacts.incompleteReason, 'BUDGET_MAXIMUM_PAGES');
  assert.equal(contacts.page.complete, false);
  assert.ok(typeof contacts.page.nextCursor === 'string');
  assert.deepEqual(evidence.limitations, [{
    operationId: 'contacts-weekly',
    reason: 'BUDGET_MAXIMUM_PAGES',
    resumeCursor: contacts.page.nextCursor,
  }]);

  // The checkpoint is durable, scoped, and carries the resume cursor.
  assert.equal(evidence.scopeCheckpoints.length, 1);
  const [checkpoint] = evidence.scopeCheckpoints;
  assert.equal(checkpoint.source, 'public_ghl');
  assert.equal(checkpoint.operationId, 'contacts-weekly');
  assert.equal(checkpoint.boundLocationId, 'L1');
  assert.equal(checkpoint.reason, 'BUDGET_MAXIMUM_PAGES');
  assert.equal(checkpoint.resumeCursor, contacts.page.nextCursor);
  assert.equal(checkpoint.pageCount, 100);
  assert.equal(checkpoint.pageArtifactsHash, sha256(checkpoint.pageArtifacts));

  // An incomplete scope is NOT an authority: only the terminal one is in the sealed inventory.
  const { frozenInputs } = readRun(projectRoot, 'run_public_1');
  assert.equal(frozenInputs.privateSourceInventory.length, 1);
  assert.equal(
    frozenInputs.privateSourceInventory[0].sourceId,
    `public_ghl.${sha256({ operationId: 'opportunities-weekly', source: 'public_ghl' }).slice(0, 32)}`,
  );
}));

test('a run with no terminal scope fails closed before any run row exists', async () => withProject(async ({ projectRoot, writeConfig }) => {
  const transport = hermeticTransport({
    'contacts.search': unboundedHandler('contact'),
    'opportunities.list': unboundedHandler('opportunity'),
  });
  await assert.rejects(
    runPublicCli({
      projectRoot,
      configPath: writeConfig(publicConfig()),
      publicRuntime: {
        transportConnect: transport.connect,
        credentialResolver: async () => CREDENTIAL_VALUE,
      },
    }),
    /AUDIT_PREFLIGHT_FAILED_PRIVATE_SOURCE_INVENTORY/,
  );
  const state = openState({ projectRoot, locationId: 'L1' });
  try {
    assert.throws(() => state.getRun('run_public_1'), /RUN_NOT_FOUND/);
  } finally {
    state.close();
  }
}));

test('a response bound to another location stops the run and creates none', async () => withProject(async ({ projectRoot, writeConfig }) => {
  const transport = hermeticTransport({
    'contacts.search': terminalHandler('contact', { locationId: 'L2' }),
    'opportunities.list': terminalHandler('opportunity'),
  });
  await assert.rejects(
    runPublicCli({
      projectRoot,
      configPath: writeConfig(publicConfig()),
      publicRuntime: {
        transportConnect: transport.connect,
        credentialResolver: async () => CREDENTIAL_VALUE,
      },
    }),
    /LOCATION_MISMATCH/,
  );
  const state = openState({ projectRoot, locationId: 'L1' });
  try {
    assert.throws(() => state.getRun('run_public_1'), /RUN_NOT_FOUND/);
  } finally {
    state.close();
  }
}));

test('an action outside the trusted allowlist is refused before any transport connect', async () => withProject(async ({ projectRoot, writeConfig }) => {
  const transport = hermeticTransport({});
  await assert.rejects(
    runPublicCli({
      projectRoot,
      configPath: writeConfig(publicConfig({
        capabilities: [{ operationId: 'forged', actionId: 'contacts-v3__create-contact' }],
      })),
      publicRuntime: {
        transportConnect: transport.connect,
        credentialResolver: async () => CREDENTIAL_VALUE,
      },
    }),
    /AUDIT_PREFLIGHT_FAILED_PUBLIC_CAPABILITY/,
  );
  assert.equal(transport.observed.connects, 0);
}));

test('trusted policy drift is refused before any transport connect', async () => withProject(async ({ projectRoot, writeConfig }) => {
  for (const field of ['publicCatalogSnapshotHash', 'publicReadAllowlistHash']) {
    const transport = hermeticTransport({});
    await assert.rejects(
      runPublicCli({
        projectRoot,
        configPath: writeConfig(publicConfig({ [field]: '0'.repeat(64) })),
        publicRuntime: {
          transportConnect: transport.connect,
          credentialResolver: async () => CREDENTIAL_VALUE,
        },
      }),
      /AUDIT_PREFLIGHT_FAILED_PUBLIC_POLICY/,
    );
    assert.equal(transport.observed.connects, 0);
  }
}));

test('an already-aborted signal stops collection before the first connect', async () => withProject(async ({ projectRoot, writeConfig }) => {
  const transport = hermeticTransport({
    'contacts.search': terminalHandler('contact'),
    'opportunities.list': terminalHandler('opportunity'),
  });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    runPublicCli({
      projectRoot,
      configPath: writeConfig(publicConfig()),
      publicRuntime: {
        transportConnect: transport.connect,
        credentialResolver: async () => CREDENTIAL_VALUE,
        signal: controller.signal,
      },
    }),
    /COLLECTION_ABORTED/,
  );
  assert.equal(transport.observed.connects, 0);
}));

test('the credential reference never becomes a value in state, checkpoints, or publications', async () => withProject(async ({ projectRoot, writeConfig }) => {
  const transport = hermeticTransport({
    'contacts.search': terminalHandler('contact'),
    'opportunities.list': terminalHandler('opportunity'),
  });
  const { stdout } = await runPublicCli({
    projectRoot,
    configPath: writeConfig(publicConfig()),
    publicRuntime: {
      transportConnect: transport.connect,
      credentialResolver: async () => CREDENTIAL_VALUE,
    },
  });
  assert.equal(stdout.includes(CREDENTIAL_VALUE), false);
  assert.equal(stdout.includes('FIXTURE_TOKEN'), false);

  // The credential VALUE reached the transport and stopped there.
  assert.equal(transport.observed.connectOptions.length, 1);
  assert.equal(transport.observed.connectOptions[0].credential, CREDENTIAL_VALUE);
  assert.equal(
    JSON.stringify(transport.observed.dispatches).includes(CREDENTIAL_VALUE),
    false,
  );

  for (const pathname of walkFiles(join(projectRoot, 'audits'))) {
    const contents = readFileSync(pathname, 'utf8');
    assert.equal(
      contents.includes(CREDENTIAL_VALUE),
      false,
      `credential value leaked into ${pathname}`,
    );
    assert.equal(
      contents.includes('FIXTURE_TOKEN'),
      false,
      `credential reference leaked into ${pathname}`,
    );
  }
}));

test('raw pages are sealed into the vault encrypted, not written in the clear', async () => withProject(async ({ projectRoot, writeConfig }) => {
  const transport = hermeticTransport({
    'contacts.search': (params) => page({
      cursor: null,
      nextCursor: null,
      items: [{ id: ITEM_CANARY }],
      reportedCount: 1,
      params,
    }),
    'opportunities.list': terminalHandler('opportunity'),
  });
  await runPublicCli({
    projectRoot,
    configPath: writeConfig(publicConfig()),
    publicRuntime: {
      transportConnect: transport.connect,
      credentialResolver: async () => CREDENTIAL_VALUE,
    },
  });

  const rawRoot = auditPaths(projectRoot, 'L1').privateRaw;
  const sealed = readdirSync(rawRoot);
  assert.equal(sealed.length, 3, 'one sealed page per collected page');
  for (const name of sealed) {
    assert.match(name, /^raw_[a-f0-9]{32}\.json$/u);
    const record = JSON.parse(readFileSync(join(rawRoot, name), 'utf8'));
    assert.equal(record.source, 'public_ghl');
    assert.equal(record.algorithm, 'aes-256-gcm');
    assert.equal(record.deletionState, 'active');
    assert.match(record.expiresAt, /^\d{4}-\d{2}-\d{2}T/u);
    assert.equal(
      readFileSync(join(rawRoot, name), 'utf8').includes(ITEM_CANARY),
      false,
      'a sealed page must not contain its plaintext',
    );
  }
}));

test('resume selects the public composition root from the durable invocation', async () => withProject(async ({ projectRoot, writeConfig }) => {
  const requestBody = {
    schemaVersion: '1.0.0',
    requestId: 'req_public_resume_1',
    nonceRef: 'nonce_public_resume_1',
    runId: 'run_public_1',
    kind: 'conversation',
  };
  const configPath = writeConfig(publicConfig({
    reviews: [{
      kind: 'conversation',
      request: { ...requestBody, requestHash: sha256(requestBody) },
      validatorState: { schemaVersion: '1.0.0', consumed: false },
      grants: [],
      createdAt: CUTOFF,
      deadline: CUTOFF + 3_600_000,
    }],
  }));
  const transport = hermeticTransport({
    'contacts.search': terminalHandler('contact'),
    'opportunities.list': terminalHandler('opportunity'),
  });
  const publicRuntime = {
    transportConnect: transport.connect,
    credentialResolver: async () => CREDENTIAL_VALUE,
  };
  const first = await runPublicCli({ projectRoot, configPath, publicRuntime });
  assert.deepEqual(first.result, {
    status: 'awaiting_model_review',
    runId: 'run_public_1',
  });

  // A resume names only project, location and run id. Choosing the local kernel here would fail
  // the provider-config validator, which is exactly the hole this branch closes.
  const resumed = await runPublicCli({
    projectRoot,
    configPath,
    publicRuntime,
    argv: [
      'resume',
      '--project', projectRoot,
      '--location', 'L1',
      '--run-id', 'run_public_1',
      '--vault-key-ref', VAULT_KEY_REFERENCE,
    ],
  });
  assert.deepEqual(resumed.result, {
    status: 'awaiting_model_review',
    runId: 'run_public_1',
  });
  // The resume adopted the inventory the run was sealed with, so it opened NO second connection
  // and re-read nothing from the account. Re-collecting could never resume: envelopes carry
  // `capturedAt`, so a second collection always produces a different privateSourceInventoryHash
  // and the kernel would restart the run instead of resuming it.
  assert.equal(transport.observed.connects, 1);
  assert.equal(transport.observed.dispatches.length, 4);
  assert.equal(readRun(projectRoot, 'run_public_1').status, 'awaiting_model_review');
}));

test('a resume never inherits a sealed authority for a changed configuration', async () => withProject(async ({ projectRoot, writeConfig }) => {
  const requestBody = {
    schemaVersion: '1.0.0',
    requestId: 'req_public_resume_2',
    nonceRef: 'nonce_public_resume_2',
    runId: 'run_public_1',
    kind: 'conversation',
  };
  const review = {
    kind: 'conversation',
    request: { ...requestBody, requestHash: sha256(requestBody) },
    validatorState: { schemaVersion: '1.0.0', consumed: false },
    grants: [],
    createdAt: CUTOFF,
    deadline: CUTOFF + 3_600_000,
  };
  const configPath = writeConfig(publicConfig({ reviews: [review] }));
  const transport = hermeticTransport({
    'contacts.search': terminalHandler('contact'),
    'opportunities.list': terminalHandler('opportunity'),
  });
  const publicRuntime = {
    transportConnect: transport.connect,
    credentialResolver: async () => CREDENTIAL_VALUE,
  };
  const first = await runPublicCli({ projectRoot, configPath, publicRuntime });
  assert.equal(first.result.status, 'awaiting_model_review');

  // The audit is now a different audit: a different window changes the evidence it is entitled
  // to claim, so the sealed inventory must NOT be adopted.
  writeConfig(publicConfig({ reviews: [review], salesCycleDays: 120 }));
  const resumed = await runPublicCli({
    projectRoot,
    configPath,
    publicRuntime,
    argv: [
      'resume',
      '--project', projectRoot,
      '--location', 'L1',
      '--run-id', 'run_public_1',
      '--vault-key-ref', VAULT_KEY_REFERENCE,
    ],
  });
  assert.match(resumed.result.status, /^RESUME_INPUT_MISMATCH/u);
  assert.equal(resumed.result.oldRunId, 'run_public_1');
  assert.equal(resumed.result.runId, undefined);
  // The restart re-collected rather than inheriting.
  assert.equal(transport.observed.connects, 2);
}));

test('the two composition roots refuse each other configuration', async () => withProject(async ({ projectRoot, writeConfig }) => {
  const config = publicConfig();
  const configPath = writeConfig(config);
  await assert.rejects(
    createLocalAuditKernel().start({
      mode: 'weekly',
      target: { targetKind: 'location', operatingProfile: 'client', locationId: 'L1' },
      projectRoot,
      cutoff: CUTOFF,
      providerId: config.providerId,
      profile: 'client',
      providerConfig: config,
      vaultKeyReference: VAULT_KEY_REFERENCE,
    }),
    /AUDIT_PREFLIGHT_FAILED_PROVIDER_CONFIG/,
  );
  assert.throws(
    () => publicProviderDescriptor({
      projectRoot,
      providerConfigPath: configPath,
      config: { ...config, adapterKind: 'local_fixture' },
    }),
    /AUDIT_PREFLIGHT_FAILED_PROVIDER_CONFIG/,
  );
}));

test('a configuration may not declare the inventory it has not collected', () => {
  assert.throws(
    () => validatePublicConfig(publicConfig({
      frozenInputs: {
        ...frozenInputsWithoutInventory(),
        privateSourceInventory: [{
          sourceId: 'forged',
          kind: 'private-content',
          sourceHash: 'a'.repeat(64),
        }],
      },
    })),
    /AUDIT_PREFLIGHT_FAILED_PROVIDER_CONFIG/,
  );
  assert.throws(
    () => validatePublicConfig(publicConfig({
      frozenInputs: {
        ...frozenInputsWithoutInventory(),
        privateSourceInventoryHash: 'b'.repeat(64),
      },
    })),
    /AUDIT_PREFLIGHT_FAILED_PROVIDER_CONFIG/,
  );
});

test('a configuration is refused when it strays from the exact provider shape', () => {
  const cases = [
    { adapterKind: 'local_fixture' },
    { schemaVersion: '2.0.0' },
    { capabilities: [] },
    { capabilities: [{ operationId: 'a', actionId: 'contacts.search', method: 'POST' }] },
    {
      capabilities: [
        { operationId: 'same', actionId: 'contacts.search' },
        { operationId: 'same', actionId: 'opportunities.list' },
      ],
    },
    { capabilityManifestHash: 'not-a-hash' },
    { credentialRef: 'raw-secret-value' },
    { expectedLocationId: 'L2' },
    { transport: { kind: 'websocket', url: 'wss://example.test' } },
    { transport: { kind: 'streamable-http', url: 'https://x.test', connect: 'nope' } },
    { transport: { kind: 'stdio', command: 'node', args: [1] } },
    { cutoff: CUTOFF + 1 },
    { timezone: 'Europe/London' },
    { rawEvidenceRetentionDays: 400 },
    { salesCycleDays: 0 },
    { providerAvailableFrom: 'not-a-timestamp' },
    { extraKey: true },
  ];
  for (const override of cases) {
    assert.throws(
      () => validatePublicConfig(publicConfig(override)),
      /AUDIT_PREFLIGHT_FAILED_PROVIDER_CONFIG/,
      canonicalJson(override),
    );
  }
  // And the shape an operator must actually write is accepted.
  assert.equal(validatePublicConfig(publicConfig()).adapterKind, 'ghl_public');
});

test('an unusable vault key reference fails before any collection', async () => withProject(async ({ projectRoot, writeConfig }) => {
  const transport = hermeticTransport({
    'contacts.search': terminalHandler('contact'),
    'opportunities.list': terminalHandler('opportunity'),
  });
  await assert.rejects(
    runPublicCli({
      projectRoot,
      configPath: writeConfig(publicConfig()),
      publicRuntime: {
        transportConnect: transport.connect,
        credentialResolver: async () => CREDENTIAL_VALUE,
      },
      argv: [
        'run',
        '--mode', 'weekly',
        '--project', projectRoot,
        '--location', 'L1',
        '--profile', 'client',
        '--provider-config', join(projectRoot, 'provider.json'),
        '--vault-key-ref', 'not-a-supported-reference',
      ],
    }),
    /AUDIT_PREFLIGHT_FAILED_VAULT_REFERENCE/,
  );
  assert.equal(transport.observed.connects, 0);
}));

test('the bundled marketplace CLI reaches the public branch without node_modules', async () => withProject(async ({ projectRoot, writeConfig }) => {
  // Regression pin. Binding the public adapter pulls `@modelcontextprotocol/sdk` — and through
  // its stdio transport, the CommonJS `cross-spawn` — into `dist/audit-cli.mjs`, where esbuild
  // rewrites `require('child_process')` into a shim that THROWS at module init. That killed every
  // bundled command, the offline `local_fixture` run included, and no source-level test could see
  // it. This spawns the bundle and asserts it fails on the AUDIT code rather than on the loader.
  const configPath = writeConfig(publicConfig({
    credentialRef: null,
    capabilities: [{ operationId: 'forged', actionId: 'contacts-v3__create-contact' }],
  }));
  const bundle = join(import.meta.dirname, '..', 'dist', 'audit-cli.mjs');
  const spawned = spawnSync(process.execPath, [
    bundle,
    'run',
    '--mode', 'weekly',
    '--project', projectRoot,
    '--location', 'L1',
    '--profile', 'client',
    '--provider-config', configPath,
    '--vault-key-ref', VAULT_KEY_REFERENCE,
  ], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.equal(spawned.status, 1);
  assert.equal(spawned.stdout, '');
  assert.equal(spawned.stderr.trim(), 'AUDIT_PREFLIGHT_FAILED_PUBLIC_CAPABILITY');
}));

test('the public kernel exposes the same phase contract as the offline one', () => {
  const kernel = createPublicAuditKernel({ initialRunId: 'run_public_contract' });
  assert.deepEqual(kernel.phases, createLocalAuditKernel().phases);
  assert.deepEqual(kernel.terminalStates, createLocalAuditKernel().terminalStates);
});
