/**
 * THE INTERNAL AUDIT RAIL.
 *
 * Two kinds of test here, and the split is the point.
 *
 * PART 1 drives the REAL audit server out of the installed plugin. Test doubles that agreed with
 * our own assumptions have hidden three separate defects on this project, including one where
 * every upstream call was being rejected while 661 tests passed. So every claim this repo makes
 * about what that server says is checked against the server. These tests SKIP when the plugin is
 * not installed, and fail loudly when it is installed and the shape has moved.
 *
 * PART 2 tests this repo's own logic with doubles, which is legitimate: the shapes the doubles
 * carry are the ones Part 1 proves, so a double cannot quietly invent a reply the server would
 * never send.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  EXPECTED_CONTRACT_VERSIONS,
  createInternalAuditAdapter,
  readEnvelope,
  normalizeForEvidence,
} from '../lib/adapters/internal-audit.mjs';
import {
  INTERNAL_AUDIT_TOOLS,
  assertAuditServerPath,
  createInternalAuditConnect,
  discoverAuditServerPaths,
  validateInternalAuditTransport,
} from '../lib/adapters/internal-audit-session.mjs';

const LOCATION = 'yoQVVJFp6wyjxcxilA2H';
const [INSTALLED_SERVER] = discoverAuditServerPaths();

// ---------------------------------------------------------------------------
// PART 1 — against the real server
// ---------------------------------------------------------------------------

/**
 * A token file is required to LAUNCH the server (it validates the path), but every assertion below
 * is about a refusal the server makes locally, before any request, so none of them needs the token
 * to be valid. That is deliberate: it makes the contract checkable on a machine whose GHL session
 * expired, which is the normal state of affairs.
 */
const TOKEN_FILE = process.env.GHL_AUDIT_TEST_TOKEN_FILE ?? null;
const LIVE = INSTALLED_SERVER !== undefined && TOKEN_FILE !== null;

test('the installed plugin ships an audit server and nothing else may be launched', {
  skip: INSTALLED_SERVER === undefined ? 'uxie-ghl-factory plugin not installed' : false,
}, () => {
  assert.equal(assertAuditServerPath(INSTALLED_SERVER).endsWith('/dist/audit-server.mjs'), true);

  // The write server sits in the same directory. It must be unlaunchable, because an auditor that
  // could reach it would be one configuration mistake away from mutating a client's account.
  assert.throws(
    () => assertAuditServerPath(INSTALLED_SERVER.replace('audit-server.mjs', 'server.mjs')),
    { code: 'INTERNAL_AUDIT_SERVER_NOT_AUDIT_PROFILE' },
  );
  // And a correctly named file outside the plugin cache is still refused, so the name alone is
  // never sufficient authority to execute something.
  assert.throws(
    () => assertAuditServerPath('/tmp/audit-server.mjs'),
    { code: 'INTERNAL_AUDIT_SERVER_PATH_OUTSIDE_CACHE' },
  );
});

test('the real audit server publishes exactly the six tools this repo declares', {
  skip: LIVE ? false : 'needs GHL_AUDIT_TEST_TOKEN_FILE and the installed plugin',
}, async () => {
  const client = await createInternalAuditConnect({
    serverPath: INSTALLED_SERVER,
    tokenFilePath: TOKEN_FILE,
  })();
  try {
    const listed = await client.listTools();
    assert.deepEqual(
      listed.tools.map(({ name }) => name).sort(),
      [...INTERNAL_AUDIT_TOOLS],
      'the audit registry moved; this repo\'s permitted-tool set must move with it',
    );
    // Every tool this repo version-checks must actually exist on the server.
    for (const tool of Object.keys(EXPECTED_CONTRACT_VERSIONS)) {
      assert.ok(
        listed.tools.some(({ name }) => name === tool),
        `${tool} is version-checked here but absent from the server`,
      );
    }
  } finally {
    await client.close();
  }
});

test('the real server REFUSES the retired parameters, and does it in the body not isError', {
  skip: LIVE ? false : 'needs GHL_AUDIT_TEST_TOKEN_FILE and the installed plugin',
}, async () => {
  const client = await createInternalAuditConnect({
    serverPath: INSTALLED_SERVER,
    tokenFilePath: TOKEN_FILE,
  })();
  try {
    for (const retired of ['pageSize', 'maxLogPartitions', 'minPartitionMs']) {
      const reply = await client.callTool({
        name: 'get_workflow_runtime_window',
        arguments: {
          locationId: LOCATION, workflowId: 'w', fromDate: 1, toDate: 2, [retired]: 1,
        },
      });
      // THE OBSERVATION THAT MATTERS. MCP reports success; the refusal is in the body. An adapter
      // branching on `isError` would read this as a good read.
      assert.equal(reply.isError === true, false, `${retired}: isError must not be the channel`);
      const body = readEnvelope(reply);
      assert.equal(body.ok, false, retired);
      assert.equal(body.code, 'VALIDATION_FAILED', retired);
    }
    // And the window rule, refused before any gateway is built.
    const window = readEnvelope(await client.callTool({
      name: 'get_workflow_runtime_window',
      arguments: { locationId: LOCATION, workflowId: 'w', fromDate: 5, toDate: 5 },
    }));
    assert.equal(window.ok, false);
    assert.equal(window.code, 'INVALID_RUNTIME_WINDOW');
  } finally {
    await client.close();
  }
});

test('this repo cannot call a tool outside the audit six, whatever the server would allow', {
  skip: LIVE ? false : 'needs GHL_AUDIT_TEST_TOKEN_FILE and the installed plugin',
}, async () => {
  const client = await createInternalAuditConnect({
    serverPath: INSTALLED_SERVER,
    tokenFilePath: TOKEN_FILE,
  })();
  try {
    for (const forbidden of ['raw_request', 'edit_workflow', 'publish_workflow', 'set_token_file']) {
      await assert.rejects(
        () => client.callTool({ name: forbidden, arguments: {} }),
        { code: 'INTERNAL_AUDIT_TOOL_NOT_PERMITTED' },
        forbidden,
      );
    }
  } finally {
    await client.close();
  }
});

// ---------------------------------------------------------------------------
// PART 2 — this repo's logic, on the shapes Part 1 proves
// ---------------------------------------------------------------------------

function doubleClient(replies) {
  const calls = [];
  return {
    calls,
    async listTools() { return { tools: INTERNAL_AUDIT_TOOLS.map((name) => ({ name })) }; },
    async callTool({ name, arguments: args }) {
      calls.push({ name, args });
      const reply = replies[name];
      if (reply === undefined) throw new Error(`UNSTUBBED ${name}`);
      return typeof reply === 'function' ? reply(args, calls.length) : reply;
    },
    async close() {},
  };
}

const authOk = (secondsRemaining, tokenIdSeconds = secondsRemaining) => ({
  structuredContent: {
    ok: true,
    data: {
      jwtClaims: { present: true, secondsRemaining },
      tokenIdClaims: { present: true, secondsRemaining: tokenIdSeconds },
    },
  },
});

test('a refusal carrying isError:false is read as a failure, never as data', async () => {
  const adapter = createInternalAuditAdapter({
    client: doubleClient({
      list_workflows_complete: {
        isError: false,
        structuredContent: {
          ok: false,
          code: 'VALIDATION_FAILED',
          detail: 'tool arguments contain unsupported fields',
        },
      },
    }),
    expectedLocationId: LOCATION,
  });
  const result = await adapter.roster();
  assert.equal(result.ok, false);
  assert.equal(result.code, 'VALIDATION_FAILED');
  assert.equal(result.data, null);
  // `detail` echoes request context back and this value reaches the publication boundary.
  assert.equal(Object.hasOwn(result, 'detail'), false);
});

test('a body with no `ok` at all is refused rather than guessed at', async () => {
  const adapter = createInternalAuditAdapter({
    client: doubleClient({ get_workflow: { structuredContent: { workflow: { id: 'w' } } } }),
    expectedLocationId: LOCATION,
  });
  await assert.rejects(() => adapter.definition('w'), { code: 'INTERNAL_AUDIT_RESPONSE_UNREADABLE' });
});

test('a latching code stops the run dead instead of burning the rest of the budget', async () => {
  const client = doubleClient({
    list_workflows_complete: { structuredContent: { ok: false, code: 'CIRCUIT_OPEN' } },
    get_workflow: { structuredContent: { ok: true, boundLocationId: LOCATION } },
    get_workflow_runtime_window: { structuredContent: { ok: true, contractVersion: '2.0.0' } },
  });
  const adapter = createInternalAuditAdapter({ client, expectedLocationId: LOCATION });

  const first = await adapter.roster();
  assert.equal(first.latching, true);
  assert.equal(adapter.latchedCode(), 'CIRCUIT_OPEN');

  // Observed on the real server: an expired credential returned TRANSPORT_FAILED and the very next
  // call on a DIFFERENT tool returned CIRCUIT_OPEN. Nothing auto-retries after a latch, so calling
  // again is waste that also destroys the partial.
  const second = await adapter.definition('w');
  assert.equal(second.ok, false);
  assert.equal(second.code, 'CIRCUIT_OPEN');
  assert.equal(client.calls.length, 1, 'nothing may be spent after a latch');
});

test('the contract version is checked PER TOOL, because the server versions them separately', async () => {
  // Proven from the server's own exported constants: the runtime window is 2.0.0 and the AI bundle
  // is still 1.0.0, so one shared supported-versions list is necessarily wrong about one of them.
  assert.equal(EXPECTED_CONTRACT_VERSIONS.get_workflow_runtime_window, '2.0.0');
  assert.equal(EXPECTED_CONTRACT_VERSIONS.get_ai_configuration_bundle, '1.0.0');

  const adapter = createInternalAuditAdapter({
    client: doubleClient({
      get_workflow_runtime_window: { structuredContent: { ok: true, contractVersion: '2.0.0', boundLocationId: LOCATION } },
      get_ai_configuration_bundle: { structuredContent: { ok: true, contractVersion: '1.0.0' } },
    }),
    expectedLocationId: LOCATION,
  });
  assert.equal((await adapter.runtimeWindow({ workflowId: 'w', fromDate: 1, toDate: 2 })).ok, true);
  assert.equal((await adapter.aiBundle({})).ok, true);

  const stale = createInternalAuditAdapter({
    client: doubleClient({
      get_workflow_runtime_window: { structuredContent: { ok: true, contractVersion: '1.0.0' } },
    }),
    expectedLocationId: LOCATION,
  });
  await assert.rejects(
    () => stale.runtimeWindow({ workflowId: 'w', fromDate: 1, toDate: 2 }),
    { code: 'INTERNAL_AUDIT_CONTRACT_MISMATCH' },
  );
});

test('evidence bound to another sub-account is refused, at the top level and nested', async () => {
  for (const body of [
    { ok: true, contractVersion: '2.0.0', boundLocationId: 'SOMEONE_ELSE' },
    { ok: true, contractVersion: '2.0.0', data: { boundLocationId: 'SOMEONE_ELSE' } },
  ]) {
    const adapter = createInternalAuditAdapter({
      client: doubleClient({ get_workflow_runtime_window: { structuredContent: body } }),
      expectedLocationId: LOCATION,
    });
    await assert.rejects(
      () => adapter.runtimeWindow({ workflowId: 'w', fromDate: 1, toDate: 2 }),
      { code: 'INTERNAL_AUDIT_LOCATION_MISMATCH' },
      JSON.stringify(body),
    );
  }
});

test('the credential is preflighted, and an expired one is named as such', async () => {
  const expired = createInternalAuditAdapter({
    client: doubleClient({ auth_status: authOk(-259_083) }),
    expectedLocationId: LOCATION,
  });
  const state = await expired.credentialState();
  assert.equal(state.usable, false);
  assert.equal(state.reason, 'CREDENTIAL_EXPIRED');

  // Nearly expired is also unusable, because a token that dies mid-run latches the circuit and
  // destroys the partial. That is worse than not starting.
  const expiring = createInternalAuditAdapter({
    client: doubleClient({ auth_status: authOk(120) }),
    expectedLocationId: LOCATION,
  });
  assert.equal((await expiring.credentialState()).reason, 'CREDENTIAL_EXPIRING');

  // The elevated agency token expires independently, so a run can honestly skip the AI surfaces
  // alone rather than failing whole or claiming an empty agent list.
  const healthy = createInternalAuditAdapter({
    client: doubleClient({ auth_status: authOk(3600, -10) }),
    expectedLocationId: LOCATION,
  });
  const mixed = await healthy.credentialState();
  assert.equal(mixed.usable, true);
  assert.equal(mixed.agencyTokenUsable, false);
});

test('the account content reaches the analyst WHOLE, with nothing redacted', () => {
  /*
   * The inverse of the test that used to live here. PII redaction was removed on 2026-07-28: this
   * is an internal tool reading accounts we administer, so redacting the operator's own data
   * protects nobody, and the first full live run showed the real cost. Any URL in a string
   * replaced the WHOLE string, so 14 of 81 email bodies reached the copywriter as `[redacted]` and
   * it had to reason around a hole we manufactured. A hole in the evidence is indistinguishable
   * from a hole in the account.
   */
  const out = normalizeForEvidence({
    id: 'contact-1',
    firstName: 'Firstname',
    email: 'someone@example.test',
    phone: '+447000000000',
    notes: 'reach me at hidden@example.test',
    address: { line1: '1 Somewhere', postalCode: 'AB1 2CD' },
    // The case that actually mattered: marketing copy with a link in it.
    emailBody: 'Hi {{contact.first_name}}, book here: https://grom.example/book',
    tags: ['lead', 'bristol'],
    monetaryValue: 0,
    dnd: false,
  });

  assert.equal(out.firstName, 'Firstname');
  assert.equal(out.email, 'someone@example.test');
  assert.equal(out.phone, '+447000000000');
  assert.equal(out.notes, 'reach me at hidden@example.test');
  assert.deepEqual(out.address, { line1: '1 Somewhere', postalCode: 'AB1 2CD' });
  assert.match(out.emailBody, /book here: https:\/\/grom\.example\/book/u);
  assert.ok(!JSON.stringify(out).includes('[redacted]'));

  // And the structural pass still carries everything else through unchanged.
  assert.deepEqual(out.tags, ['lead', 'bristol']);
  assert.equal(out.monetaryValue, 0);
  assert.equal(out.dnd, false);
});

test('a provider transport record carries three keys and none of them is a secret', () => {
  assert.throws(
    () => validateInternalAuditTransport({
      kind: 'ghl-internal-audit-stdio',
      serverPath: INSTALLED_SERVER ?? '/nope/audit-server.mjs',
      tokenFilePath: '/nope/tok.txt',
      env: { GHL_TOKEN: 'secret' },
    }),
    { code: 'INTERNAL_AUDIT_TRANSPORT_INVALID' },
    'a fourth key must be refused outright, so a config can never carry a token or an argv',
  );
  assert.throws(
    () => validateInternalAuditTransport({ kind: 'streamable-http', serverPath: 'x', tokenFilePath: 'y' }),
    { code: 'INTERNAL_AUDIT_TRANSPORT_INVALID' },
  );
});

test('the account describing an outbound call is not us making one', () => {
  /*
   * `lib/kernel.mjs` refuses any collected object with an `authorization` key or a write-verb
   * `method`, and that rule is absolute on purpose. Grom UK's own configuration contains six such
   * shapes: three voice-AI actions, three custom actions, and the `01 Onboarding Ready`
   * custom_webhook step. Every live run with the internal rail on died on them right after
   * `collecting_internal` checkpointed, so no such run ever reached the briefs.
   */
  const scrubbed = normalizeForEvidence({
    workflow: {
      name: '01 Onboarding Ready',
      steps: [{
        type: 'custom_webhook',
        attributes: { method: 'POST', authorization: 'sk-live-abcdef123456', url: 'https://onboarding.example.test/hook' },
      }],
    },
    voice_ai: { actions: [{ apiDetails: { method: 'POST' } }, { apiDetails: { method: 'GET' } }] },
  });

  const step = scrubbed.workflow.steps[0].attributes;
  // The FACT survives, renamed to say whose request it is.
  assert.equal(step.configuredHttpMethod, 'POST');
  assert.equal(step.method, undefined);
  // The credential VALUE is gone; that it authenticates at all is kept.
  assert.equal(step.authorizationConfigured, true);
  assert.equal(step.authorization, undefined);
  assert.ok(!JSON.stringify(scrubbed).includes('sk-live-abcdef123456'));

  assert.equal(scrubbed.voice_ai.actions[0].apiDetails.configuredHttpMethod, 'POST');
  // A READ verb is untouched. Only the shapes the scanner refuses are renamed.
  assert.equal(scrubbed.voice_ai.actions[1].apiDetails.method, 'GET');
});

test('the scrubbed evidence passes the kernel safety scanner that used to quarantine it', () => {
  const WRITE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
  const violations = [];
  const walk = (value, path) => {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      const n = key.toLowerCase().replaceAll(/[^a-z]/gu, '');
      if (['rawrequest', 'mutationtool', 'authorization', 'cookie'].includes(n)) violations.push(`${path}.${key}`);
      if (n === 'method' && WRITE.has(String(child).toUpperCase())) violations.push(`${path}.${key}=${child}`);
      walk(child, `${path}.${key}`);
    }
  };
  walk(normalizeForEvidence({
    actions: [{ apiDetails: { method: 'DELETE', authorization: 'Bearer nope' } }],
    customActions: [{ apiDetails: { method: 'PUT' } }],
  }), 'root');
  assert.deepEqual(violations, []);
});
