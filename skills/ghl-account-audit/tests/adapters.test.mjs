import assert from 'node:assert/strict';
import {
  mkdtempSync,
  renameSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { canonicalJson, sha256 } from '../lib/canonical.mjs';
import { connectMcp } from '../lib/adapters/mcp-transport.mjs';
import { createContextAdapter } from '../lib/adapters/context.mjs';
import { createPortalExportAdapter } from '../lib/adapters/portal-export.mjs';
import { createPublicGhlAdapter } from '../lib/adapters/public-ghl.mjs';

const SNAPSHOT_HASH = '7'.repeat(64);
const MANIFEST_HASH = '8'.repeat(64);
const allowlist = Object.freeze({
  schemaVersion: '1.0.0',
  sourceCatalogRevision: 'fixture-1',
  sourceSnapshotHash: SNAPSHOT_HASH,
  sourceServerIdentity: 'fixture-public',
  actions: Object.freeze([
    Object.freeze({
      actionId: 'contacts.search',
      method: 'POST',
      normalizedPath: '/contacts/search',
      category: 'contacts',
      risk: 'read',
    }),
  ]),
});
const ALLOWLIST_HASH = sha256(allowlist);
const window = Object.freeze({
  from: '2026-07-13T00:00:00.000Z',
  to: '2026-07-20T00:00:00.000Z',
});
const approvedCapability = Object.freeze({
  operationId: 'contacts-weekly',
  actionId: 'contacts.search',
  method: 'POST',
  normalizedPath: '/contacts/search',
  category: 'contacts',
  risk: 'read',
  sourceSnapshotHash: SNAPSHOT_HASH,
  allowlistHash: ALLOWLIST_HASH,
  providerId: 'fixture-provider',
  capabilityManifestHash: MANIFEST_HASH,
});
const generousBudget = Object.freeze({
  maximumPages: 10,
  maximumRecords: 100,
  maximumResponseBytes: 100_000,
  requestTimeoutMs: 1_000,
  retryCount: 2,
  maximumTotalRetryDelayMs: 100,
  wallClockMs: 10_000,
});

function page({
  locationId = 'L1',
  cursor = null,
  nextCursor = null,
  items = [{ id: 'C1' }],
  reportedCount = items.length,
  complete = nextCursor === null,
  truncated = false,
  rateLimited = false,
  appliedWindow = window,
} = {}) {
  return {
    locationId,
    appliedWindow,
    items,
    rateLimited,
    page: {
      cursor,
      nextCursor,
      reportedCount,
      complete,
      truncated,
    },
  };
}

function fakeClient(responses, calls = []) {
  let index = 0;
  return {
    providerId: 'fixture-provider',
    capabilityManifestHash: MANIFEST_HASH,
    async callTool(request, options) {
      calls.push({ request, options });
      const response = responses[Math.min(index, responses.length - 1)];
      index += 1;
      if (response instanceof Error) throw response;
      if (typeof response === 'function') return response(request, options);
      return structuredClone(response);
    },
  };
}

function publicAdapter({
  responses = [page()],
  calls = [],
  budget = generousBudget,
  checkpointStore,
  runtime,
  client,
} = {}) {
  return createPublicGhlAdapter({
    client: client ?? fakeClient(responses, calls),
    allowlist,
    expectedLocationId: 'L1',
    budgets: {
      version: '1.0.0',
      exhaustionPolicy: 'checkpoint_scope_incomplete',
      capabilities: { contacts: budget },
    },
    checkpointStore,
    runtime,
  });
}

function assertCollectionShape(result) {
  for (const key of [
    'source',
    'operationId',
    'boundLocationId',
    'requestedWindow',
    'appliedWindow',
    'capturedAt',
    'items',
    'page',
  ]) assert.ok(Object.hasOwn(result, key), `missing ${key}`);
  assert.deepEqual(Object.keys(result.page).sort(), [
    'collectedCount',
    'complete',
    'cursor',
    'nextCursor',
    'reportedCount',
    'truncated',
  ]);
}

test('public adapter rejects an unlisted action before MCP dispatch', async () => {
  let calls = 0;
  const adapter = createPublicGhlAdapter({
    client: {
      providerId: 'fixture-provider',
      capabilityManifestHash: MANIFEST_HASH,
      callTool: async () => { calls += 1; },
    },
    allowlist,
    expectedLocationId: 'L1',
    budgets: {
      version: '1.0.0',
      exhaustionPolicy: 'checkpoint_scope_incomplete',
      capabilities: { contacts: generousBudget },
    },
  });
  await assert.rejects(
    adapter.collect({ capability: { actionId: 'contacts-v3__create-contact' }, window }),
    /ACTION_NOT_ALLOWED/,
  );
  assert.equal(calls, 0);
});

test('public adapter enforces every tuple and pinned hash before dispatch', async () => {
  for (const [field, replacement] of [
    ['method', 'GET'],
    ['normalizedPath', '/contacts/other'],
    ['category', 'opportunities'],
    ['risk', 'write'],
    ['sourceSnapshotHash', '1'.repeat(64)],
    ['allowlistHash', '2'.repeat(64)],
    ['providerId', 'other-provider'],
    ['capabilityManifestHash', '3'.repeat(64)],
  ]) {
    const calls = [];
    const adapter = publicAdapter({ calls });
    await assert.rejects(
      adapter.collect({
        capability: { ...approvedCapability, [field]: replacement },
        window,
      }),
      /ACTION_NOT_ALLOWED|ALLOWLIST_HASH_MISMATCH|PROVIDER_PIN_MISMATCH|CAPABILITY_MANIFEST_HASH_MISMATCH/,
    );
    assert.equal(calls.length, 0, field);
  }
});

test('explicitly allowlisted POST read dispatches execute_action without mutation fields', async () => {
  const calls = [];
  const result = await publicAdapter({ calls }).collect({
    capability: approvedCapability,
    window,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].request.name, 'execute_action');
  assert.equal(calls[0].request.arguments.action, 'contacts.search');
  assert.equal(calls[0].request.arguments.params.locationId, 'L1');
  assert.equal('confirm' in calls[0].request.arguments, false);
  assert.equal('raw_request' in calls[0].request.arguments, false);
  assert.equal(result.page.complete, true);
});

test('wrong-location and unresolved-location responses quarantine before success', async () => {
  const unresolved = page();
  delete unresolved.locationId;
  for (const response of [page({ locationId: 'L2' }), unresolved]) {
    const adapter = publicAdapter({ responses: [response] });
    await assert.rejects(
      adapter.collect({ capability: approvedCapability, window }),
      /LOCATION_MISMATCH/,
    );
  }
});

test('public adapter paginates to one terminal authoritative collection', async () => {
  const calls = [];
  const result = await publicAdapter({
    calls,
    responses: [
      page({
        nextCursor: 'C2',
        items: [{ id: 'C1' }],
        reportedCount: 2,
        complete: false,
      }),
      page({
        cursor: 'C2',
        items: [{ id: 'C2' }],
        reportedCount: 2,
      }),
    ],
  }).collect({ capability: approvedCapability, window, cursor: null });
  assertCollectionShape(result);
  assert.equal(result.source, 'public_ghl');
  assert.equal(result.boundLocationId, 'L1');
  assert.equal(result.page.reportedCount, 2);
  assert.equal(result.page.collectedCount, 2);
  assert.equal(result.page.complete, true);
  assert.equal(result.page.truncated, false);
  assert.deepEqual(result.items.map(({ id }) => id), ['C1', 'C2']);
  assert.equal(calls[1].request.arguments.params.cursor, 'C2');
  assert.equal(result.privateSourceInventory.length, 1);
  assert.match(result.privateSourceInventory[0].sourceHash, /^[a-f0-9]{64}$/u);
});

test('cursor loops, changing totals, rate limits, truncation, and missing terminal proof checkpoint incomplete', async () => {
  const thrownRateLimit = Object.assign(new Error('fixture 429'), { code: 429 });
  const cases = [
    {
      name: 'cursor',
      responses: [
        page({ nextCursor: 'again', reportedCount: 2, complete: false }),
        page({ cursor: 'again', nextCursor: 'again', reportedCount: 2, complete: false }),
      ],
      reason: 'CURSOR_LOOP',
    },
    {
      name: 'total',
      responses: [
        page({ nextCursor: 'next', reportedCount: 2, complete: false }),
        page({ cursor: 'next', reportedCount: 3 }),
      ],
      reason: 'REPORTED_COUNT_CHANGED',
    },
    { name: 'rate', responses: [page({ rateLimited: true })], reason: 'RATE_LIMITED' },
    { name: 'thrown-rate', responses: [thrownRateLimit], reason: 'RATE_LIMITED' },
    { name: 'truncated', responses: [page({ truncated: true })], reason: 'TRUNCATED' },
    {
      name: 'terminal',
      responses: [page({ complete: false, nextCursor: null })],
      reason: 'TERMINAL_PROOF_MISSING',
    },
  ];
  for (const fixture of cases) {
    const saved = [];
    const result = await publicAdapter({
      responses: fixture.responses,
      checkpointStore: { save: async (checkpoint) => saved.push(checkpoint) },
    }).collect({ capability: approvedCapability, window });
    assertCollectionShape(result);
    assert.equal(result.page.complete, false, fixture.name);
    assert.equal(result.incompleteReason, fixture.reason, fixture.name);
    assert.equal('privateSourceInventory' in result, false, fixture.name);
    assert.equal(saved.at(-1).reason, fixture.reason, fixture.name);
    assert.equal(saved.at(-1).resumeCursor, result.page.nextCursor, fixture.name);
  }
});

test('each collection budget independently checkpoints with a stable reason', async () => {
  const retryError = Object.assign(new Error('fixture retry'), {
    code: 'RETRYABLE',
    retryAfterMs: 6,
  });
  const cases = [
    {
      name: 'pages',
      budget: { ...generousBudget, maximumPages: 1 },
      responses: [page({ nextCursor: 'next', complete: false, reportedCount: 2 })],
      reason: 'BUDGET_MAXIMUM_PAGES',
    },
    {
      name: 'records',
      budget: { ...generousBudget, maximumRecords: 1 },
      responses: [page({ items: [{ id: '1' }, { id: '2' }], reportedCount: 2 })],
      reason: 'BUDGET_MAXIMUM_RECORDS',
    },
    {
      name: 'bytes',
      budget: { ...generousBudget, maximumResponseBytes: 10 },
      responses: [page()],
      reason: 'BUDGET_MAXIMUM_RESPONSE_BYTES',
    },
    {
      name: 'retries',
      budget: { ...generousBudget, retryCount: 0 },
      responses: [retryError],
      reason: 'BUDGET_RETRY_COUNT',
    },
    {
      name: 'retry-delay',
      budget: { ...generousBudget, maximumTotalRetryDelayMs: 5 },
      responses: [retryError],
      reason: 'BUDGET_TOTAL_RETRY_DELAY',
    },
  ];
  for (const fixture of cases) {
    const saved = [];
    const result = await publicAdapter({
      budget: fixture.budget,
      responses: fixture.responses,
      checkpointStore: { save: async (checkpoint) => saved.push(checkpoint) },
      runtime: { sleep: async () => {} },
    }).collect({ capability: approvedCapability, window });
    assert.equal(result.incompleteReason, fixture.reason, fixture.name);
    assert.equal(saved.length, 1, fixture.name);
    assert.equal('privateSourceInventory' in result, false, fixture.name);
  }
});

test('request timeout checkpoints without waiting on a live clock', async () => {
  const result = await publicAdapter({
    budget: { ...generousBudget, requestTimeoutMs: 5 },
    responses: [() => new Promise(() => {})],
    runtime: {
      setTimer(callback) {
        queueMicrotask(callback);
        return 1;
      },
      clearTimer() {},
    },
  }).collect({ capability: approvedCapability, window });
  assert.equal(result.incompleteReason, 'BUDGET_REQUEST_TIMEOUT');
  assert.equal(result.page.complete, false);
});

test('wall clock exhaustion checkpoints with a deterministic clock', async () => {
  let now = 0;
  const result = await publicAdapter({
    budget: { ...generousBudget, wallClockMs: 5 },
    responses: [() => {
      now = 6;
      return page();
    }],
    runtime: { now: () => now },
  }).collect({ capability: approvedCapability, window });
  assert.equal(result.incompleteReason, 'BUDGET_WALL_CLOCK');
  assert.equal(result.page.complete, false);
});

test('incomplete collection never mints inventory even when items were collected', async () => {
  const result = await publicAdapter({
    budget: { ...generousBudget, maximumPages: 1 },
    responses: [page({
      nextCursor: 'next',
      complete: false,
      reportedCount: 2,
      items: [{ id: 'private-contact' }],
    })],
  }).collect({ capability: approvedCapability, window });
  assert.equal(result.items.length, 1);
  assert.equal('privateSourceInventory' in result, false);
});

test('public adapter rejects malformed windows and cursors before dispatch', async () => {
  for (const request of [
    { capability: approvedCapability, window: null },
    { capability: approvedCapability, window: { from: window.from } },
    { capability: approvedCapability, window, cursor: { opaque: 'not-a-cursor' } },
  ]) {
    const calls = [];
    await assert.rejects(
      publicAdapter({ calls }).collect(request),
      /COLLECTION_WINDOW_INVALID|COLLECTION_CURSOR_INVALID/,
    );
    assert.equal(calls.length, 0);
  }
});

async function withProject(fn) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'audit-adapters-')));
  try {
    return await fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('context adapter preserves conflicting authority records', async () => withProject(async (root) => {
  writeFileSync(join(root, 'manifest.json'), `${canonicalJson({
    locationId: 'L1',
    capturedAt: '2026-07-20T00:00:00.000Z',
    values: { timezone: 'America/New_York', owner: 'ops' },
  })}\n`);
  writeFileSync(join(root, 'brief.json'), `${canonicalJson({
    locationId: 'L1',
    capturedAt: '2026-07-20T00:00:00.000Z',
    values: { timezone: 'Europe/London', niche: 'clinic' },
  })}\n`);
  const adapter = createContextAdapter({
    projectRoot: root,
    profile: {
      expectedLocationId: 'L1',
      sources: [
        { sourceId: 'manifest', authority: 'manifest', path: 'manifest.json' },
        { sourceId: 'brief', authority: 'client_brief', path: 'brief.json' },
      ],
    },
  });
  const result = await adapter.collect({
    capability: { operationId: 'context-baseline' },
    window,
  });
  assertCollectionShape(result);
  const conflict = result.items.find(({ recordType }) => recordType === 'authority_conflict');
  assert.equal(conflict.key, 'timezone');
  assert.deepEqual(conflict.assertions.map(({ authority }) => authority), [
    'client_brief',
    'manifest',
  ]);
  assert.equal(result.items.some(({ key, value }) => key === 'timezone' && value), false);
  assert.equal(result.page.complete, true);
  assert.equal(result.privateSourceInventory.length, 1);
}));

test('context adapter rejects path escapes and wrong-location files', async () => withProject(async (root) => {
  const outside = join(tmpdir(), `outside-${process.pid}.json`);
  writeFileSync(outside, `${canonicalJson({ locationId: 'L1', values: { x: 1 } })}\n`);
  try {
    assert.throws(() => createContextAdapter({
      projectRoot: root,
      profile: {
        expectedLocationId: 'L1',
        sources: [{ sourceId: 'outside', authority: 'bad', path: outside }],
      },
    }), /CONTEXT_PATH_INVALID/);
  } finally {
    rmSync(outside, { force: true });
  }

  writeFileSync(join(root, 'wrong.json'), `${canonicalJson({
    locationId: 'L2',
    capturedAt: '2026-07-20T00:00:00.000Z',
    values: { x: 1 },
  })}\n`);
  const adapter = createContextAdapter({
    projectRoot: root,
    profile: {
      expectedLocationId: 'L1',
      sources: [{ sourceId: 'wrong', authority: 'fixture', path: 'wrong.json' }],
    },
  });
  await assert.rejects(
    adapter.collect({ capability: { operationId: 'context' }, window }),
    /LOCATION_MISMATCH/,
  );
}));

test('context adapter rejects a source inode replaced after configuration', async () => withProject(async (root) => {
  const sourcePath = join(root, 'context.json');
  const replacementPath = join(root, 'replacement.json');
  const document = {
    locationId: 'L1',
    capturedAt: '2026-07-20T00:00:00.000Z',
    values: { timezone: 'UTC' },
  };
  writeFileSync(sourcePath, `${canonicalJson(document)}\n`);
  const adapter = createContextAdapter({
    projectRoot: root,
    profile: {
      expectedLocationId: 'L1',
      sources: [{ sourceId: 'context', authority: 'fixture', path: 'context.json' }],
    },
  });
  writeFileSync(replacementPath, `${canonicalJson(document)}\n`);
  renameSync(replacementPath, sourcePath);
  await assert.rejects(
    adapter.collect({ capability: { operationId: 'context' }, window }),
    /CONTEXT_SOURCE_CHANGED/,
  );
}));

function portalFixture(overrides = {}) {
  return {
    schemaVersion: '1.0.0',
    source: 'onboarding_portal',
    locationId: 'L1',
    operationId: 'portal-onboarding',
    requestedWindow: window,
    appliedWindow: window,
    capturedAt: '2026-07-20T00:00:00.000Z',
    items: [{ milestone: 'strategy_approved' }],
    page: {
      cursor: null,
      nextCursor: null,
      reportedCount: 1,
      collectedCount: 1,
      complete: true,
      truncated: false,
    },
    ...overrides,
  };
}

test('portal adapter accepts only a validated terminal local export', async () => withProject(async (root) => {
  const exportPath = join(root, 'portal-export.json');
  writeFileSync(exportPath, `${canonicalJson(portalFixture())}\n`, { mode: 0o400 });
  const result = await createPortalExportAdapter({
    exportPath,
    expectedLocationId: 'L1',
  }).collect({ capability: { operationId: 'portal-onboarding' }, window });
  assertCollectionShape(result);
  assert.equal(result.source, 'onboarding_portal');
  assert.equal(result.page.complete, true);
  assert.equal(result.privateSourceInventory.length, 1);
}));

test('portal adapter rejects DB, course, wrong-location, and incomplete export surfaces', async () => withProject(async (root) => {
  assert.throws(() => createPortalExportAdapter({
    exportPath: 'postgres://portal.internal/live',
    expectedLocationId: 'L1',
  }), /PORTAL_EXPORT_PATH_INVALID/);

  for (const [name, value, code] of [
    ['courses', portalFixture({ source: 'courses' }), /PORTAL_EXPORT_SOURCE_INVALID/],
    ['db-field', { ...portalFixture(), databaseUrl: 'postgres://private' }, /PORTAL_EXPORT_INVALID/],
    [
      'course-item',
      portalFixture({ items: [{ courseProgress: 'complete' }] }),
      /PORTAL_EXPORT_SURFACE_NOT_APPLICABLE/,
    ],
    ['location', portalFixture({ locationId: 'L2' }), /LOCATION_MISMATCH/],
    [
      'incomplete',
      portalFixture({ page: { ...portalFixture().page, complete: false } }),
      /PORTAL_EXPORT_INCOMPLETE/,
    ],
  ]) {
    const exportPath = join(root, `${name}.json`);
    writeFileSync(exportPath, `${canonicalJson(value)}\n`);
    const adapter = createPortalExportAdapter({ exportPath, expectedLocationId: 'L1' });
    await assert.rejects(
      adapter.collect({ capability: { operationId: 'portal-onboarding' }, window }),
      code,
    );
  }
}));

test('portal adapter rejects an export inode replaced after configuration', async () => withProject(async (root) => {
  const exportPath = join(root, 'portal-export.json');
  const replacementPath = join(root, 'replacement.json');
  const bytes = `${canonicalJson(portalFixture())}\n`;
  writeFileSync(exportPath, bytes);
  const adapter = createPortalExportAdapter({ exportPath, expectedLocationId: 'L1' });
  writeFileSync(replacementPath, bytes);
  renameSync(replacementPath, exportPath);
  await assert.rejects(
    adapter.collect({ capability: { operationId: 'portal-onboarding' }, window }),
    /PORTAL_EXPORT_CHANGED/,
  );
}));

test('terminal inventories are canonical, exact, sorted, and bind the complete envelope', async () => withProject(async (root) => {
  const exportPath = join(root, 'portal-export.json');
  writeFileSync(exportPath, `${canonicalJson(portalFixture())}\n`);
  const result = await createPortalExportAdapter({
    exportPath,
    expectedLocationId: 'L1',
  }).collect({ capability: { operationId: 'portal-onboarding' }, window });
  const sourceEnvelope = Object.fromEntries(
    Object.entries(result).filter(([key]) => key !== 'privateSourceInventory'),
  );
  assert.deepEqual(result.privateSourceInventory, [...result.privateSourceInventory].sort(
    (left, right) => left.sourceId.localeCompare(right.sourceId),
  ));
  assert.equal(
    result.privateSourceInventory[0].sourceHash,
    sha256({ schemaVersion: '1.0.0', source: sourceEnvelope }),
  );
  assert.deepEqual(Object.keys(result.privateSourceInventory[0]).sort(), [
    'kind',
    'sourceHash',
    'sourceId',
  ]);
}));

test('connectMcp resolves reference-only HTTP config and returns a restricted client', async () => {
  const resolved = [];
  const connected = [];
  const client = await connectMcp({
    providerConfig: {
      providerId: 'fixture-provider',
      capabilityManifestHash: MANIFEST_HASH,
      credentialRef: { kind: 'environment', name: 'FIXTURE_TOKEN' },
    },
    credentialResolver: async (reference) => {
      resolved.push(structuredClone(reference));
      return 'private-token';
    },
    transport: {
      kind: 'streamable-http',
      url: 'https://mcp.invalid.example.test',
      async connect(options) {
        connected.push(options);
        return {
          async callTool(request) {
            return { structuredContent: { request } };
          },
          async close() {},
        };
      },
    },
  });
  assert.deepEqual(resolved, [{ kind: 'environment', name: 'FIXTURE_TOKEN' }]);
  assert.equal(connected.length, 1);
  assert.equal(connected[0].credential, 'private-token');
  assert.equal(client.providerId, 'fixture-provider');
  assert.equal(client.capabilityManifestHash, MANIFEST_HASH);
  await assert.rejects(
    client.callTool({ name: 'raw_request', arguments: {} }),
    /TOOL_NOT_AVAILABLE/,
  );
  await assert.rejects(
    client.callTool({ name: 'execute_action', arguments: { confirm: true } }),
    /MUTATION_ARGUMENT_NOT_ALLOWED/,
  );
  assert.doesNotMatch(JSON.stringify(client), /FIXTURE_TOKEN|private-token|authorization/i);
  await client.close();
});

test('connectMcp supports explicit stdio command and argument arrays without credentials', async () => {
  const connected = [];
  const client = await connectMcp({
    providerConfig: {
      providerId: 'fixture-stdio',
      capabilityManifestHash: MANIFEST_HASH,
      credentialRef: null,
    },
    transport: {
      kind: 'stdio',
      command: '/usr/bin/false',
      args: ['--fixture'],
      async connect(options) {
        connected.push(options);
        return { async callTool() { return {}; }, async close() {} };
      },
    },
  });
  assert.deepEqual(connected, [{
    kind: 'stdio',
    command: '/usr/bin/false',
    args: ['--fixture'],
  }]);
  await client.close();
});

test('connectMcp rejects embedded secrets and redacts resolver/transport failures', async () => {
  await assert.rejects(
    connectMcp({
      providerConfig: {
        providerId: 'fixture',
        capabilityManifestHash: MANIFEST_HASH,
        credentialRef: { kind: 'environment', name: 'FIXTURE' },
        authorization: 'Bearer should-never-appear',
      },
      credentialResolver: async () => 'unused',
      transport: { kind: 'streamable-http', url: 'https://example.test' },
    }),
    (error) => error.message === 'PROVIDER_CONFIG_INVALID',
  );
  for (const mode of ['resolver', 'transport']) {
    const secret = `secret-${mode}`;
    await assert.rejects(
      connectMcp({
        providerConfig: {
          providerId: 'fixture',
          capabilityManifestHash: MANIFEST_HASH,
          credentialRef: { kind: 'secret-store', reference: 'vault/fixture' },
        },
        credentialResolver: async () => {
          if (mode === 'resolver') throw new Error(`failed vault/fixture ${secret}`);
          return secret;
        },
        transport: {
          kind: 'streamable-http',
          url: 'https://example.test',
          async connect() {
            throw new Error(`header Authorization vault/fixture ${secret}`);
          },
        },
      }),
      (error) => {
        assert.doesNotMatch(error.message, /vault\/fixture|secret-|authorization/i);
        return true;
      },
    );
  }
});

test('connectMcp rejects credentials embedded in HTTP URLs or stdio arguments', async () => {
  for (const transport of [
    { kind: 'streamable-http', url: 'https://user:password@example.test/mcp' },
    { kind: 'streamable-http', url: 'https://example.test/mcp?token=private' },
    { kind: 'stdio', command: '/usr/bin/false', args: ['--token=private'] },
    { kind: 'stdio', command: '/usr/bin/false', args: ['Bearer private'] },
  ]) {
    await assert.rejects(
      connectMcp({
        providerConfig: {
          providerId: 'fixture',
          capabilityManifestHash: MANIFEST_HASH,
          credentialRef: null,
        },
        transport,
      }),
      /MCP_TRANSPORT_INVALID/,
    );
  }
});

test('provider configuration is immutable and cannot smuggle secret-like nested fields', async () => {
  for (const forbidden of [
    { headers: { Authorization: 'x' } },
    { cookie: 'x' },
    { token: 'x' },
    { credentialRef: { kind: 'environment', name: 'FIXTURE', value: 'x' } },
  ]) {
    await assert.rejects(
      connectMcp({
        providerConfig: {
          providerId: 'fixture',
          capabilityManifestHash: MANIFEST_HASH,
          credentialRef: null,
          ...forbidden,
        },
        transport: {
          kind: 'stdio',
          command: '/usr/bin/false',
          args: [],
          async connect() {
            throw new Error('must not connect');
          },
        },
      }),
      /PROVIDER_CONFIG_INVALID/,
    );
  }
});
