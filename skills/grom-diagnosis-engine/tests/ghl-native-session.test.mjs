/**
 * THE GHL-NATIVE SESSION — the seam that finally lets a run reach a real sub-account.
 *
 * Every test in this file is HERMETIC. No socket is opened, no process is spawned and no
 * GoHighLevel account is contacted: the MCP SDK's own `fetch` seam is replaced by a double that
 * answers JSON-RPC in memory, so the SDK client, the streamable-HTTP transport, `connectMcp`, the
 * translator, the bounded adapter, the vault and the publisher all run for real while the wire
 * does not exist. The credential is a canary string that appears nowhere but the double's own
 * captured request headers, and the last test in the file walks every byte the run wrote to disk
 * to prove it stayed there.
 */
import assert from 'node:assert/strict';
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
import { join } from 'node:path';
import { test } from 'node:test';
import { runAuditCli } from '../cli/audit.mjs';
import { sha256 } from '../lib/canonical.mjs';
import {
  DEFAULT_GHL_CREDENTIAL_HEADER_NAME,
  GHL_NATIVE_TRANSPORT_KIND,
  assertGhlNativeUrl,
  createGhlNativeConnect,
  validateGhlNativeTransport,
} from '../lib/adapters/ghl-native-session.mjs';
import { validatePublicConfig } from '../lib/local-runtime.mjs';
import { auditPaths } from '../lib/paths.mjs';
import { openState } from '../lib/state.mjs';
import { loadPublicReadAllowlist } from '../schemas/v1.mjs';

const allowlist = loadPublicReadAllowlist();
const SNAPSHOT_HASH = allowlist.sourceSnapshotHash;
const ALLOWLIST_HASH = sha256(allowlist);
const MANIFEST_HASH = 'a'.repeat(64);
const CUTOFF = 1_750_032_000_000;
const IN_WINDOW = new Date(CUTOFF - 86_400_000).toISOString();
const VAULT_KEY_REFERENCE = 'test-only:key';
/** The real worker this rail was built for. It is NEVER contacted; the fetch seam answers. */
const WORKER_URL = 'https://ghl-mcp-server.xanderjohnrazonroque.workers.dev/mcp';
const TOKEN_ENVIRONMENT_NAME = 'GHL_NATIVE_SESSION_TEST_TOKEN';
/** Deliberately unmistakable. Every leak assertion in this file searches for this exact string. */
const TOKEN_CANARY = 'ghl-native-token-canary-8f3c1d';

function frozenInputs() {
  return {
    locationId: 'L1',
    target: { targetKind: 'location', operatingProfile: 'client', locationId: 'L1' },
    cutoff: CUTOFF,
    timezone: 'Europe/London',
    contextHash: 'context-native-1',
    coverageProfileHash: 'coverage-native-1',
    metricProfileHash: 'metric-native-1',
    rulesetHash: 'rules-native-1',
    codeHash: 'code-native-1',
    auditProfileHash: 'profile-native-1',
    providerToolProfileHash: 'provider-native-1',
    windowDefinitionsHash: 'windows-native-1',
    collectionBudgetHash: 'budget-native-1',
    capabilityManifestHashes: ['manifest-native-1'],
    capabilityProofIndexHash: 'proof-index-native-1',
    capabilityReceiptHashes: ['receipt-native-1'],
    capabilityAttestationHashes: ['attestation-native-1'],
    capabilityProofExpiries: [1_850_032_000_000],
  };
}

function nativeConfig(overrides = {}) {
  return {
    schemaVersion: '1.0.0',
    adapterKind: 'ghl_public',
    runId: 'run_native_1',
    providerId: 'grom-ghl-mcp',
    expectedLocationId: 'L1',
    capabilityManifestHash: MANIFEST_HASH,
    publicCatalogSnapshotHash: SNAPSHOT_HASH,
    publicReadAllowlistHash: ALLOWLIST_HASH,
    credentialRef: { kind: 'environment', name: TOKEN_ENVIRONMENT_NAME },
    transport: { kind: GHL_NATIVE_TRANSPORT_KIND, url: WORKER_URL },
    capabilities: [
      { operationId: 'contacts-weekly', actionId: 'contacts.search' },
      { operationId: 'opportunities-weekly', actionId: 'opportunities.list' },
    ],
    cutoff: CUTOFF,
    timezone: 'Europe/London',
    frozenInputs: frozenInputs(),
    context: { safe: 'context' },
    reviews: [],
    ...overrides,
  };
}

async function withProject(run) {
  const projectRoot = realpathSync(mkdtempSync(join(tmpdir(), 'ghl-native-')));
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

/**
 * A GoHighLevel MCP worker, in memory, behind the SDK's `fetch` seam.
 *
 * It answers a real streamable-HTTP MCP handshake (`initialize`, `notifications/initialized`,
 * `tools/call`) and records the headers of EVERY request, which is how the credential assertions
 * below can be made without a wire.
 */
function fetchDouble(handlers, { failWith = null } = {}) {
  const observed = { requests: [], headers: [], urls: [] };
  const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
  const impl = async (url, init) => {
    observed.urls.push(String(url));
    observed.headers.push(Object.fromEntries(new Headers(init?.headers ?? {}).entries()));
    if (failWith !== null) throw failWith;
    if (init?.method !== 'POST') {
      // No SSE stream at GET, no session teardown at DELETE. Both are spec-legal 405s.
      return new Response(null, { status: 405 });
    }
    const message = JSON.parse(String(init.body));
    observed.requests.push(message);
    if (message.method === 'initialize') {
      return json({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          protocolVersion: message.params.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: 'ghl-mcp-double', version: '0.0.0' },
        },
      });
    }
    if (message.method === 'notifications/initialized') {
      return new Response(null, { status: 202 });
    }
    if (message.method === 'tools/call') {
      // `action_id`, because that is the argument the real worker's zod requires. This double is
      // the WIRE, so it must enforce the wire's contract; dispatching on whatever key it was
      // handed is what let a broken request name stay green all the way to a live run.
      const { action_id: action, params } = message.params.arguments;
      const handler = handlers[action];
      if (!handler) throw new Error(`UNEXPECTED_UPSTREAM:${action}`);
      return json({
        jsonrpc: '2.0',
        id: message.id,
        result: { content: [{ type: 'text', text: JSON.stringify(handler(params)) }] },
      });
    }
    throw new Error(`UNEXPECTED_METHOD:${message.method}`);
  };
  return { observed, fetch: impl };
}

function collectStdout() {
  const chunks = [];
  return { chunks, write(chunk) { chunks.push(String(chunk)); return true; } };
}

async function runNativeCli({ projectRoot, configPath, publicRuntime }) {
  const stdout = collectStdout();
  const result = await runAuditCli({
    argv: [
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

/** Sets the credential in the process environment for the duration of one run, then removes it. */
async function withEnvironmentToken(run) {
  const previous = Object.hasOwn(process.env, TOKEN_ENVIRONMENT_NAME)
    ? process.env[TOKEN_ENVIRONMENT_NAME]
    : undefined;
  process.env[TOKEN_ENVIRONMENT_NAME] = TOKEN_CANARY;
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env[TOKEN_ENVIRONMENT_NAME];
    else process.env[TOKEN_ENVIRONMENT_NAME] = previous;
  }
}

function walkFiles(root, found = []) {
  for (const entry of readdirSync(root)) {
    const pathname = join(root, entry);
    if (statSync(pathname).isDirectory()) walkFiles(pathname, found);
    else found.push(pathname);
  }
  return found;
}

const contactsHandler = () => ({
  contacts: [{ id: 'c1', locationId: 'L1', dateAdded: IN_WINDOW }],
  total: 1,
});
const opportunitiesHandler = () => ({
  opportunities: [{ id: 'o1', locationId: 'L1', dateAdded: IN_WINDOW, monetaryValue: 4500 }],
  meta: { total: 1 },
});

// ---------------------------------------------------------------------------
// The transport record
// ---------------------------------------------------------------------------

test('the native transport defaults its credential header to X-GHL-Token', () => {
  assert.equal(DEFAULT_GHL_CREDENTIAL_HEADER_NAME, 'X-GHL-Token');
  assert.deepEqual(
    { ...validateGhlNativeTransport({ kind: GHL_NATIVE_TRANSPORT_KIND, url: WORKER_URL }) },
    {
      kind: GHL_NATIVE_TRANSPORT_KIND,
      url: WORKER_URL,
      credentialHeaderName: 'X-GHL-Token',
    },
  );
  assert.equal(
    validateGhlNativeTransport({
      kind: GHL_NATIVE_TRANSPORT_KIND,
      url: WORKER_URL,
      credentialHeaderName: 'X-Location-Token',
    }).credentialHeaderName,
    'X-Location-Token',
  );
});

test('the native transport refuses a header that is not a plain credential header', () => {
  for (const credentialHeaderName of [
    'Authorization',
    'authorization',
    'Cookie',
    'Set-Cookie',
    'Proxy-Authorization',
    'Transfer-Encoding',
    'X GHL Token',
    'X-GHL-Token: extra',
    '',
    '1-leading-digit',
    'x'.repeat(65),
    null,
    123,
  ]) {
    assert.throws(
      () => validateGhlNativeTransport({
        kind: GHL_NATIVE_TRANSPORT_KIND,
        url: WORKER_URL,
        credentialHeaderName,
      }),
      /MCP_TRANSPORT_INVALID/u,
      `header ${String(credentialHeaderName)} must be refused`,
    );
  }
});

test('the native transport validates its URL exactly as mcp-transport does', () => {
  // Accepted: https anywhere, http on loopback only.
  assert.equal(assertGhlNativeUrl(WORKER_URL), WORKER_URL);
  assert.equal(assertGhlNativeUrl('http://localhost:8787/mcp'), 'http://localhost:8787/mcp');
  assert.equal(assertGhlNativeUrl('http://127.0.0.1:8787/mcp'), 'http://127.0.0.1:8787/mcp');
  for (const url of [
    'http://ghl-mcp-server.example.test/mcp',
    'https://user:pass@ghl-mcp-server.example.test/mcp',
    'https://ghl-mcp-server.example.test/mcp?token=leaked',
    'https://ghl-mcp-server.example.test/mcp#fragment',
    'ftp://ghl-mcp-server.example.test/mcp',
    'not-a-url',
    '',
    null,
  ]) {
    assert.throws(
      () => assertGhlNativeUrl(url),
      /MCP_TRANSPORT_INVALID/u,
      `url ${String(url)} must be refused`,
    );
  }
});

test('the native transport record has room for exactly three keys and no secret', () => {
  for (const transport of [
    { kind: GHL_NATIVE_TRANSPORT_KIND, url: WORKER_URL, token: TOKEN_CANARY },
    { kind: GHL_NATIVE_TRANSPORT_KIND, url: WORKER_URL, headers: { 'X-GHL-Token': TOKEN_CANARY } },
    { kind: GHL_NATIVE_TRANSPORT_KIND, url: WORKER_URL, connect: () => {} },
    { kind: GHL_NATIVE_TRANSPORT_KIND, url: WORKER_URL, fetch: () => {} },
    { kind: GHL_NATIVE_TRANSPORT_KIND },
    { kind: 'streamable-http', url: WORKER_URL },
    null,
  ]) {
    assert.throws(() => validateGhlNativeTransport(transport), /MCP_TRANSPORT_INVALID/u);
  }
  // And a provider configuration carrying one of those is refused at PREFLIGHT, by code, so it
  // never becomes a connect attempt.
  assert.throws(
    () => validatePublicConfig(nativeConfig({
      transport: { kind: GHL_NATIVE_TRANSPORT_KIND, url: WORKER_URL, token: TOKEN_CANARY },
    })),
    /AUDIT_PREFLIGHT_FAILED_PROVIDER_CONFIG/u,
  );
});

test('a native transport with no credential reference is refused before any connect', () => {
  assert.throws(
    () => validatePublicConfig(nativeConfig({ credentialRef: null })),
    /AUDIT_PREFLIGHT_FAILED_PROVIDER_CONFIG/u,
  );
  // The same configuration on the pre-existing kind is still accepted, so nothing that worked
  // before has been narrowed.
  assert.doesNotThrow(() => validatePublicConfig(nativeConfig({
    credentialRef: null,
    transport: { kind: 'streamable-http', url: WORKER_URL },
  })));
});

// ---------------------------------------------------------------------------
// The connect itself
// ---------------------------------------------------------------------------

test('the credential travels in the configured header and never as Authorization', async () => {
  const server = fetchDouble({});
  const connect = createGhlNativeConnect({ url: WORKER_URL, fetch: server.fetch });
  const client = await connect({ kind: 'streamable-http', url: WORKER_URL, credential: TOKEN_CANARY });
  try {
    assert.ok(server.observed.headers.length >= 1);
    for (const headers of server.observed.headers) {
      assert.equal(headers['x-ghl-token'], TOKEN_CANARY);
      assert.equal(Object.hasOwn(headers, 'authorization'), false);
      assert.equal(Object.hasOwn(headers, 'cookie'), false);
    }
    for (const url of server.observed.urls) assert.equal(url, WORKER_URL);
  } finally {
    await client.close();
  }
});

test('a renamed credential header is the only header the credential appears in', async () => {
  const server = fetchDouble({});
  const connect = createGhlNativeConnect({
    url: WORKER_URL,
    credentialHeaderName: 'X-Location-Token',
    fetch: server.fetch,
  });
  const client = await connect({ kind: 'streamable-http', url: WORKER_URL, credential: TOKEN_CANARY });
  try {
    for (const headers of server.observed.headers) {
      assert.equal(headers['x-location-token'], TOKEN_CANARY);
      assert.equal(Object.hasOwn(headers, 'x-ghl-token'), false);
      assert.deepEqual(
        Object.entries(headers).filter(([, value]) => String(value).includes(TOKEN_CANARY)),
        [['x-location-token', TOKEN_CANARY]],
        'the credential may appear in exactly one header',
      );
    }
  } finally {
    await client.close();
  }
});

test('the connect refuses to be pointed anywhere but the URL it was built for', async () => {
  const server = fetchDouble({});
  const connect = createGhlNativeConnect({ url: WORKER_URL, fetch: server.fetch });
  for (const options of [
    { kind: 'streamable-http', url: 'https://elsewhere.example.test/mcp', credential: TOKEN_CANARY },
    { kind: 'stdio', url: WORKER_URL, credential: TOKEN_CANARY },
    { kind: 'streamable-http', url: `${WORKER_URL}?token=${TOKEN_CANARY}`, credential: TOKEN_CANARY },
    null,
  ]) {
    await assert.rejects(() => connect(options), /MCP_TRANSPORT_INVALID/u);
  }
  assert.equal(server.observed.urls.length, 0, 'a refused connect may not touch the wire');
});

test('a session with no credential fails closed rather than binding to no account', async () => {
  const server = fetchDouble({});
  const connect = createGhlNativeConnect({ url: WORKER_URL, fetch: server.fetch });
  for (const credential of [null, undefined, '']) {
    await assert.rejects(
      () => connect({ kind: 'streamable-http', url: WORKER_URL, credential }),
      /GHL_NATIVE_CREDENTIAL_REQUIRED/u,
    );
  }
  assert.equal(server.observed.urls.length, 0);
});

test('the delegate speaks this repo callTool(request, options) convention, not the SDK three-arg one', async () => {
  const server = fetchDouble({
    'contacts-v3__search-contacts-advanced': () => ({ contacts: [{ id: 'c1' }], total: 1 }),
  });
  const connect = createGhlNativeConnect({ url: WORKER_URL, fetch: server.fetch });
  const delegate = await connect({
    kind: 'streamable-http',
    url: WORKER_URL,
    credential: TOKEN_CANARY,
  });
  try {
    // Every caller in this repo passes `{ signal, timeout }` SECOND. The SDK client's second
    // positional is its RESULT SCHEMA, so handing the raw client back makes the reply fail
    // validation with `v3Schema.safeParse is not a function` AFTER the account has been read.
    const response = await delegate.callTool(
      {
        name: 'execute_action',
        // The delegate is a RAW GHL MCP client, so its arguments are the worker's own:
        // `action_id`, never `action`.
        arguments: {
          action_id: 'contacts-v3__search-contacts-advanced',
          params: { locationId: 'L1' },
        },
      },
      { timeout: 5_000 },
    );
    assert.deepEqual(
      JSON.parse(response.content[0].text),
      { contacts: [{ id: 'c1' }], total: 1 },
    );
  } finally {
    await delegate.close();
  }
});

test('the session module contains no logging surface at all', () => {
  const source = readFileSync(
    new URL('../lib/adapters/ghl-native-session.mjs', import.meta.url),
    'utf8',
  );
  for (const forbidden of ['console.', 'process.stdout', 'process.stderr', 'process.env']) {
    assert.equal(
      source.includes(forbidden),
      false,
      `${forbidden} must not appear in a module that handles a credential`,
    );
  }
});

test('a transport failure never carries the credential in its error', async () => {
  const failure = new Error('ECONNREFUSED ghl-mcp-server.xanderjohnrazonroque.workers.dev');
  const server = fetchDouble({}, { failWith: failure });
  const connect = createGhlNativeConnect({ url: WORKER_URL, fetch: server.fetch });
  await assert.rejects(
    () => connect({ kind: 'streamable-http', url: WORKER_URL, credential: TOKEN_CANARY }),
    (error) => {
      assert.equal(String(error?.message ?? '').includes(TOKEN_CANARY), false);
      assert.equal(String(error?.stack ?? '').includes(TOKEN_CANARY), false);
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// The composition root
// ---------------------------------------------------------------------------

test('a configuration declaring the native transport collects end to end with no host binding', async () => withProject(async ({ projectRoot, writeConfig }) => {
  const server = fetchDouble({
    'contacts-v3__search-contacts-advanced': contactsHandler,
    'opportunities-v3__search-opportunity': opportunitiesHandler,
  });
  const { result, stdout } = await withEnvironmentToken(() => runNativeCli({
    projectRoot,
    configPath: writeConfig(nativeConfig()),
    // NO `ghlNativeConnect` and NO `transportConnect`: the only host binding is the wire double,
    // which stands in for the network. Everything else is what `node dist/audit-cli.mjs run`
    // does on its own.
    publicRuntime: { runtime: { ghlNativeFetch: server.fetch } },
  }));

  assert.equal(result.status, 'complete_partial');
  assert.equal(result.runId, 'run_native_1');
  assert.ok(result.publicationId);

  // A real MCP handshake happened, and the reads that followed were GHL-NATIVE, not our generic
  // request shape — i.e. the translator sat between the adapter and this session.
  assert.deepEqual(
    server.observed.requests.map(({ method }) => method),
    ['initialize', 'notifications/initialized', 'tools/call', 'tools/call'],
  );
  const toolCalls = server.observed.requests.filter(({ method }) => method === 'tools/call');
  assert.deepEqual(
    // `action_id` is the worker's required argument name; see `tests/ghl-wire-contract.test.mjs`.
    toolCalls.map(({ params }) => params.arguments.action_id).sort(),
    ['contacts-v3__search-contacts-advanced', 'opportunities-v3__search-opportunity'],
  );
  for (const call of toolCalls) {
    assert.equal(call.params.name, 'execute_action');
    assert.equal(call.params.arguments.params.locationId, 'L1');
    assert.equal(Object.hasOwn(call.params.arguments, 'confirm'), false);
    assert.equal(Object.hasOwn(call.params.arguments.params, 'fromDate'), false);
  }

  // EVERY request on the session — handshake and reads alike — carried the credential in
  // `X-GHL-Token`, and none of them carried an Authorization header.
  assert.ok(server.observed.headers.length >= 4);
  for (const headers of server.observed.headers) {
    assert.equal(headers['x-ghl-token'], TOKEN_CANARY);
    assert.equal(Object.hasOwn(headers, 'authorization'), false);
  }
  for (const url of server.observed.urls) assert.equal(url, WORKER_URL);

  // And it reached the account bindings the run is sealed with.
  const state = openState({ projectRoot, locationId: 'L1' });
  try {
    assert.equal(state.getRun('run_native_1').frozenInputs.privateSourceInventory.length, 2);
  } finally {
    state.close();
  }
  assert.equal(stdout.includes(TOKEN_CANARY), false);
}));

test('the credential never reaches stdout, state, raw evidence or a publication', async () => withProject(async ({ projectRoot, writeConfig }) => {
  const server = fetchDouble({
    'contacts-v3__search-contacts-advanced': contactsHandler,
    'opportunities-v3__search-opportunity': opportunitiesHandler,
  });
  const configPath = writeConfig(nativeConfig());
  const { stdout } = await withEnvironmentToken(() => runNativeCli({
    projectRoot,
    configPath,
    publicRuntime: { runtime: { ghlNativeFetch: server.fetch } },
  }));

  assert.equal(stdout.includes(TOKEN_CANARY), false);
  assert.equal(stdout.includes(TOKEN_ENVIRONMENT_NAME), false);

  // The configuration a human writes carries a REFERENCE and a header NAME. It cannot carry a
  // token, and it does not.
  const onDisk = readFileSync(configPath, 'utf8');
  assert.equal(onDisk.includes(TOKEN_CANARY), false);
  assert.match(onDisk, /"credentialRef":\{"kind":"environment"/u);

  // Everything the run wrote: state database, checkpoints, sealed raw pages, publication.
  const files = walkFiles(join(projectRoot, 'audits'));
  assert.ok(files.length > 0);
  for (const pathname of files) {
    const contents = readFileSync(pathname, 'latin1');
    assert.equal(contents.includes(TOKEN_CANARY), false, `credential leaked into ${pathname}`);
    assert.equal(
      contents.includes(TOKEN_ENVIRONMENT_NAME),
      false,
      `credential reference leaked into ${pathname}`,
    );
  }
  // Raw pages exist and are sealed, so "no leak" is not "nothing was written".
  assert.ok(readdirSync(auditPaths(projectRoot, 'L1').privateRaw).length > 0);
}));

test('an injected host session still wins over the configuration-built default', async () => withProject(async ({ projectRoot, writeConfig }) => {
  const server = fetchDouble({});
  const injected = { connects: 0, closes: 0, requests: [] };
  const { result } = await withEnvironmentToken(() => runNativeCli({
    projectRoot,
    configPath: writeConfig(nativeConfig()),
    publicRuntime: {
      runtime: { ghlNativeFetch: server.fetch },
      ghlNativeConnect: async () => {
        injected.connects += 1;
        return {
          async callTool(request) {
            // An injected `ghlNativeConnect` sits BELOW the translator, so it receives the
            // worker's dialect (`action_id`), exactly as the configuration-built session does.
            injected.requests.push(request.arguments.action_id);
            const handler = {
              'contacts-v3__search-contacts-advanced': contactsHandler,
              'opportunities-v3__search-opportunity': opportunitiesHandler,
            }[request.arguments.action_id];
            return { structuredContent: handler(request.arguments.params) };
          },
          async close() {
            injected.closes += 1;
          },
        };
      },
    },
  }));
  assert.equal(result.status, 'complete_partial');
  assert.equal(injected.connects, 1);
  assert.equal(injected.closes, 1);
  assert.equal(injected.requests.length, 2);
  assert.equal(
    server.observed.urls.length,
    0,
    'the configuration-built session must not be constructed when the host injects one',
  );
}));

test('declaring a native server while injecting a normalised one is refused before any request', async () => withProject(async ({ projectRoot, writeConfig }) => {
  const server = fetchDouble({});
  await assert.rejects(
    () => withEnvironmentToken(() => runNativeCli({
      projectRoot,
      configPath: writeConfig(nativeConfig()),
      publicRuntime: {
        runtime: { ghlNativeFetch: server.fetch },
        transportConnect: async () => ({ async callTool() {}, async close() {} }),
      },
    })),
    (error) => {
      assert.equal(error.code, 'AUDIT_PREFLIGHT_FAILED_PROVIDER_CONFIG');
      return true;
    },
  );
  assert.equal(server.observed.urls.length, 0);
}));

test('an untranslatable capability on a native configuration never opens a session', async () => withProject(async ({ projectRoot, writeConfig }) => {
  const server = fetchDouble({});
  await assert.rejects(
    () => withEnvironmentToken(() => runNativeCli({
      projectRoot,
      configPath: writeConfig(nativeConfig({
        capabilities: [
          { operationId: 'contacts-weekly', actionId: 'contacts.search' },
          { operationId: 'payments-weekly', actionId: 'payments-v3__list-orders' },
        ],
      })),
      publicRuntime: { runtime: { ghlNativeFetch: server.fetch } },
    })),
    (error) => {
      assert.equal(error.code, 'AUDIT_PREFLIGHT_FAILED_PUBLIC_CAPABILITY_NOT_TRANSLATED');
      assert.deepEqual(error.actionIds, ['payments-v3__list-orders']);
      return true;
    },
  );
  assert.equal(server.observed.urls.length, 0);
}));

test('a missing environment credential fails the run without naming the variable', async () => withProject(async ({ projectRoot, writeConfig }) => {
  const server = fetchDouble({});
  const previous = process.env[TOKEN_ENVIRONMENT_NAME];
  delete process.env[TOKEN_ENVIRONMENT_NAME];
  try {
    await assert.rejects(
      () => runNativeCli({
        projectRoot,
        configPath: writeConfig(nativeConfig()),
        publicRuntime: { runtime: { ghlNativeFetch: server.fetch } },
      }),
      (error) => {
        assert.equal(error.code, 'CREDENTIAL_RESOLUTION_FAILED');
        assert.equal(String(error.message).includes(TOKEN_ENVIRONMENT_NAME), false);
        return true;
      },
    );
  } finally {
    if (previous !== undefined) process.env[TOKEN_ENVIRONMENT_NAME] = previous;
  }
  assert.equal(server.observed.urls.length, 0, 'no session is opened without a credential');
}));

test('the UK sub-account configuration this rail was built for is valid as written', () => {
  const uk = nativeConfig({
    runId: 'run_uk_shakedown_1',
    expectedLocationId: 'yoQVVJFp6wyjxcxilA2H',
    credentialRef: { kind: 'environment', name: 'GROM_UK_GHL_MCP_TOKEN' },
    frozenInputs: {
      ...frozenInputs(),
      locationId: 'yoQVVJFp6wyjxcxilA2H',
      target: {
        targetKind: 'location',
        operatingProfile: 'client',
        locationId: 'yoQVVJFp6wyjxcxilA2H',
      },
    },
  });
  assert.doesNotThrow(() => validatePublicConfig(uk));
  assert.equal(uk.transport.kind, GHL_NATIVE_TRANSPORT_KIND);
  assert.equal(uk.transport.url, WORKER_URL);
  // No header name is declared, so the default applies and it is the one the worker wants.
  assert.equal(
    validateGhlNativeTransport(uk.transport).credentialHeaderName,
    'X-GHL-Token',
  );
  assert.equal(JSON.stringify(uk).includes(TOKEN_CANARY), false);
});
