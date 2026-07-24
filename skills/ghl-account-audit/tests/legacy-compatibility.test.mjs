import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  collectBrowserWorkflowEvidence,
  resolveLegacyMode,
} from '../lib/adapters/legacy-capture.mjs';
import { runCaptureMode } from '../lib/modes/capture.mjs';
import { runVerifyMode } from '../lib/modes/verify.mjs';
import { runHarvestMode } from '../lib/modes/harvest.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILL = join(HERE, '..');
const REPO = join(SKILL, '..', '..');
const LEGACY_FIXTURE = join(HERE, 'fixtures', 'legacy', 'workflow-capture');
const DIRTY_FIXTURE = join(HERE, 'fixtures', 'capture-dirty.json');
const DATE = '2026-07-24';
const LOCATION = 'L1';
const OPTIONAL_WORKFLOW_FILES = [
  'sticky-notes.json',
  'step-counts.json',
  'trigger-catalog.json',
  'action-catalog.json',
  'pipelines.json',
  'custom-values.json',
  'workflow-settings.json',
];
const ALL_WORKFLOW_FILES = ['workflow.json', 'trigger.json', ...OPTIONAL_WORKFLOW_FILES];

function tempClient(name = 'client') {
  const root = mkdtempSync(join(tmpdir(), `legacy-audit-${name}-`));
  writeFileSync(join(root, '.gitignore'), 'node_modules/\n', 'utf8');
  return root;
}

function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function workflowBody(locationId = LOCATION) {
  return JSON.parse(readFileSync(join(LEGACY_FIXTURE, 'workflow.json'), 'utf8')
    .replaceAll('L1', locationId));
}

function triggerBody() {
  return JSON.parse(readFileSync(join(LEGACY_FIXTURE, 'trigger.json'), 'utf8'));
}

function liveAreas(locationId = LOCATION) {
  return {
    pipelines: [{
      id: 'pipeline-1',
      locationId,
      name: 'Sales Pipeline',
      stages: [
        { id: 'stage-lead', locationId, name: 'Lead' },
        { id: 'stage-booked', locationId, name: 'Booked' },
      ],
    }],
    'custom-fields': [{ id: 'field-1', locationId, name: 'Treatment', fieldKey: 'contact.treatment' }],
    'custom-values': [{ id: 'value-1', locationId, name: 'Clinic Name', value: 'Example Clinic' }],
    tags: [{ id: 'tag-1', locationId, name: 'New Lead' }],
    calendars: [{ id: 'calendar-1', locationId, name: 'Consultation' }],
    users: [{ id: 'user-1', locationId, name: 'Owner' }],
    'phone-numbers': [{ id: 'phone-1', locationId, name: 'Tracked', number: '+61400000000' }],
    'ai-agents': [{ id: 'agent-1', locationId, name: 'Primary AI' }],
    workflows: [{ id: 'workflow-1', locationId, name: 'Lead Nurture', status: 'PUBLISHED' }],
  };
}

function publicCollector({
  locationId = LOCATION,
  responseLocationId = locationId,
  areas = liveAreas(responseLocationId),
  declaration = {},
  calls = [],
} = {}) {
  return {
    declaration: {
      actionId: 'fixture.read',
      method: 'GET',
      risk: 'read',
      locationId,
      boundLocationId: locationId,
      ...declaration,
    },
    async collect(request) {
      calls.push(structuredClone(request));
      return {
        boundLocationId: responseLocationId,
        complete: true,
        areas: structuredClone(areas),
      };
    },
  };
}

function browserCollector({
  locationId = LOCATION,
  statusFor = {},
  calls = [],
  declaration = {},
  bodyFor,
} = {}) {
  return {
    declaration: {
      method: 'GET',
      risk: 'read',
      locationId,
      boundLocationId: locationId,
      ...declaration,
    },
    async fetch(request) {
      calls.push({ type: 'fetch', file: request.file });
      const status = statusFor[request.file] ?? 200;
      const body = bodyFor?.(request)
        ?? (request.file === 'workflow.json'
          ? workflowBody(locationId)
          : request.file === 'trigger.json'
            ? triggerBody()
            : { locationId, file: request.file, unknownProviderField: 'preserved' });
      return { status, locationId, body };
    },
  };
}

function throttle(calls = []) {
  return {
    async wait() { calls.push({ type: 'wait' }); },
    async reject(status) { calls.push({ type: 'reject', status }); },
  };
}

function captureArgs(root, overrides = {}) {
  return {
    clientFolder: root,
    locationId: LOCATION,
    captureDate: DATE,
    publicCollector: publicCollector(),
    browserCollector: browserCollector(),
    browserThrottle: throttle(),
    includeOptionalWorkflowEndpoints: true,
    workflowCaptureValidator: async ({ files }) => ({
      valid: files['workflow.json']?.workflowData?.templates instanceof Array
        && files['trigger.json'] !== undefined,
      evidenceRefs: ['workflow.json', 'trigger.json'],
    }),
    ...overrides,
  };
}

function writeManifest(root, manifest) {
  const path = join(root, 'client-manifest.json');
  writeFileSync(path, json(manifest), 'utf8');
  return path;
}

function baseManifest() {
  return {
    manifest_version: 1,
    client_key: 'example-clinic',
    label: 'Example Clinic',
    status: 'design',
    ghl_location_id: null,
    market: 'AUS',
    currency: 'AUD',
    timezone: 'Australia/Melbourne',
    pipeline_id: null,
    stage_map: { Lead: 'lead', Booked: 'booked' },
    booking: { calendar_ids: [] },
    phone: { tracked_number: null },
    ai_agents: { chat_primary: null },
    secrets_pointers: { pit_vault_secret_name: null },
    tracking: {
      client_key_snippet: 'example-clinic',
      worker_url: 'https://example.invalid/events',
      clarity_project_id: 'clarity',
    },
    ids_harvested: false,
    field_lifecycle: {
      ghl_location_id: 'harvest',
      pipeline_id: 'harvest',
      stage_map: 'harvest',
      'booking.calendar_ids': 'harvest',
      'phone.tracked_number': 'harvest',
      'ai_agents.chat_primary': 'harvest',
      'secrets_pointers.pit_vault_secret_name': 'harvest',
      currency: 'design-time',
      'tracking.clarity_project_id': 'execution-discovered',
    },
  };
}

function harvestBindings(overrides = {}) {
  return {
    ghl_location_id: { kind: 'location' },
    pipeline_id: { kind: 'pipeline', name: 'Sales Pipeline' },
    stage_map: { kind: 'stages', pipelineName: 'Sales Pipeline' },
    'booking.calendar_ids': { kind: 'calendars', names: ['Consultation'] },
    'phone.tracked_number': { kind: 'phone', value: '+61400000000' },
    'ai_agents.chat_primary': { kind: 'ai-agent', name: 'Primary AI' },
    'secrets_pointers.pit_vault_secret_name': { kind: 'secret-pointer', value: 'GHL_EXAMPLE_PIT' },
    ...overrides,
  };
}

function harvestArgs(root, overrides = {}) {
  return {
    ...captureArgs(root),
    harvestBindings: harvestBindings(),
    goLiveChecker: async () => ({ pass: true, output: 'golive_check: READY' }),
    ...overrides,
  };
}

function walkFiles(root) {
  const found = [];
  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const absolute = join(dir, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else found.push(relative(root, absolute).split('\\').join('/'));
    }
  }
  walk(root);
  return found.sort();
}

function snapshot(path) {
  const stat = statSync(path);
  return { bytes: readFileSync(path), ino: stat.ino, mtimeMs: stat.mtimeMs };
}

function assertSnapshot(path, before) {
  const after = snapshot(path);
  assert.deepEqual(after.bytes, before.bytes);
  assert.equal(after.ino, before.ino);
  assert.equal(after.mtimeMs, before.mtimeMs);
}

function assertFrozenJson(value) {
  assert.doesNotThrow(() => JSON.stringify(value));
  const visit = (entry) => {
    if (!entry || typeof entry !== 'object') return;
    assert.equal(Object.isFrozen(entry), true);
    for (const nested of Object.values(entry)) visit(nested);
  };
  visit(value);
}

test('capture is the documented default and weekly remains explicit', () => {
  const skill = readFileSync(join(SKILL, 'SKILL.md'), 'utf8');
  assert.equal(resolveLegacyMode(), 'capture');
  assert.equal(resolveLegacyMode('capture'), 'capture');
  assert.equal(resolveLegacyMode('verify'), 'verify');
  assert.equal(resolveLegacyMode('harvest'), 'harvest');
  assert.equal(resolveLegacyMode('weekly'), 'weekly');
  assert.match(skill, /capture` \(default\)/);
  assert.match(skill, /weekly.*explicit/i);
  assert.throws(() => resolveLegacyMode('other'), /LEGACY_MODE_INVALID/);
});

test('capture preserves the legacy tree names raw ignore and sanitizer bytes', async (t) => {
  const root = tempClient('tree');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const result = await runCaptureMode(captureArgs(root));
  assertFrozenJson(result);
  assert.deepEqual(Object.keys(result), [
    'mode', 'status', 'locationId', 'captureDate', 'captureRoot', 'reportPath',
    'manifestChanged', 'checks', 'unresolved',
  ]);
  assert.equal(result.captureRoot, `captures/${DATE}`);
  assert.equal(result.reportPath, `captures/${DATE}/audit-report.md`);
  assert.equal(result.manifestChanged, false);
  const captureRoot = join(root, result.captureRoot);
  const files = walkFiles(captureRoot);
  for (const name of [
    'pipelines.md', 'custom-fields.md', 'custom-values.md', 'tags.md',
    'calendars.md', 'users.md', 'phone-numbers.md', 'ai-agents.md',
    'workflows.md', 'audit-report.md', 'manifest.json',
    'raw/pipelines.json', 'pipelines.json',
    'raw/workflows/workflow-1/workflow.json',
    'workflows/workflow-1/workflow.json',
    'raw/workflows/workflow-1/trigger.json',
    'workflows/workflow-1/trigger.json',
  ]) assert.ok(files.includes(name), name);
  assert.equal(
    readFileSync(join(root, '.gitignore'), 'utf8').split('\n')
      .filter((line) => line === 'captures/**/raw/').length,
    1,
  );
  const sanitized = readFileSync(join(captureRoot, 'pipelines.json'), 'utf8');
  assert.equal(sanitized, json(JSON.parse(sanitized)));
  const workflowsMarkdown = readFileSync(join(captureRoot, 'workflows.md'), 'utf8');
  assert.match(workflowsMarkdown, /\| Name \| ID \| Status \| Trigger \| Step count \|/);
  assert.match(workflowsMarkdown, /facebook_lead_form/);
  assert.match(workflowsMarkdown, /\| 1 \|/);
  const report = readFileSync(join(captureRoot, 'audit-report.md'), 'utf8');
  for (const exactCollision of [
    'contact.treatment',
    'New Lead',
    'Consultation',
    'Sales Pipeline',
  ]) assert.ok(report.includes(exactCollision), exactCollision);

  const out = join(root, 'dirty-sanitized.json');
  const normal = spawnSync('node', [
    join(SKILL, 'scripts', 'sanitize_capture.mjs'), DIRTY_FIXTURE, out,
  ], { encoding: 'utf8' });
  assert.equal(normal.status, 0, normal.stderr);
  assert.equal(normal.stdout, [
    'REDACTED\t$.headers.Authorization\tbearer',
    'REDACTED\t$.headers.Cookie\tcookie',
    'REDACTED\t$.meta.api_key\tsecret-key',
    'REDACTED\t$.steps[0].config.accessToken\tmeta-capi',
    'REDACTED\t$.steps[1].config.webhook.jwt\tjwt',
    '',
  ].join('\n'));
  assert.equal(readFileSync(out, 'utf8'), json(JSON.parse(readFileSync(out, 'utf8'))));
  assert.equal(spawnSync('node', [join(SKILL, 'scripts', 'sanitize_capture.mjs'), '--check', DIRTY_FIXTURE]).status, 1);
  assert.equal(spawnSync('node', [join(SKILL, 'scripts', 'sanitize_capture.mjs'), '--check', out]).status, 0);
  assert.equal(spawnSync('node', [join(SKILL, 'scripts', 'sanitize_capture.mjs')]).status, 2);
});

test('capture retry is idempotent but conflicting same-date bytes fail closed', async (t) => {
  const root = tempClient('retry');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const args = captureArgs(root);
  const first = await runCaptureMode(args);
  const report = join(root, first.reportPath);
  const before = snapshot(report);
  const second = await runCaptureMode(args);
  assert.deepEqual(second, first);
  assertSnapshot(report, before);
  writeFileSync(report, `${readFileSync(report, 'utf8')}x`, 'utf8');
  const changed = readFileSync(report);
  await assert.rejects(runCaptureMode(args), /LEGACY_CAPTURE_CONFLICT/);
  assert.deepEqual(readFileSync(report), changed);
});

test('browser workflow fallback throttles every GET and stops on 403 or 429', async () => {
  const calls = [];
  const evidence = await collectBrowserWorkflowEvidence({
    locationId: LOCATION,
    workflowIds: ['workflow-1'],
    browserCollector: browserCollector({ calls }),
    browserThrottle: throttle(calls),
    includeOptionalWorkflowEndpoints: true,
  });
  assert.deepEqual(
    calls.flatMap((call) => call.type === 'wait' ? ['wait'] : [`fetch:${call.file}`]),
    ALL_WORKFLOW_FILES.flatMap((file) => ['wait', `fetch:${file}`]),
  );
  assert.deepEqual(Object.keys(evidence.workflows['workflow-1'].files), ALL_WORKFLOW_FILES);

  for (const status of [403, 429]) {
    const stopped = [];
    await assert.rejects(
      collectBrowserWorkflowEvidence({
        locationId: LOCATION,
        workflowIds: ['workflow-1'],
        browserCollector: browserCollector({
          calls: stopped,
          statusFor: { 'trigger.json': status },
        }),
        browserThrottle: throttle(stopped),
        includeOptionalWorkflowEndpoints: true,
      }),
      /LEGACY_BROWSER_CAPTURE_STOPPED/,
    );
    assert.deepEqual(stopped.map((call) => call.type), ['wait', 'fetch', 'wait', 'fetch', 'reject']);
    assert.equal(stopped.at(-1).status, status);
  }
});

test('legacy wrappers reject writes raw requests confirmation and location drift', async (t) => {
  for (const [name, declaration] of [
    ['POST', { method: 'POST' }],
    ['PUT', { method: 'PUT' }],
    ['PATCH', { method: 'PATCH' }],
    ['DELETE', { method: 'DELETE' }],
    ['send', { send: true }],
    ['publish', { publish: true }],
    ['trigger', { trigger: true }],
    ['raw-request', { raw_request: true }],
    ['confirm', { confirm: true }],
    ['body', { body: {} }],
    ['request-body', { requestBody: {} }],
  ]) {
    const root = tempClient(`auth-${name}`);
    t.after(() => rmSync(root, { recursive: true, force: true }));
    let dispatches = 0;
    const collector = publicCollector({
      declaration,
      calls: new Proxy([], { get(target, key) {
        if (key === 'push') return () => { dispatches += 1; };
        return Reflect.get(target, key);
      } }),
    });
    await assert.rejects(
      runCaptureMode(captureArgs(root, { publicCollector: collector })),
      /LEGACY_READ_ONLY_VIOLATION/,
      name,
    );
    assert.equal(dispatches, 0, name);
    assert.equal(existsSync(join(root, 'captures')), false, name);
  }

  for (const collector of [
    publicCollector({ locationId: 'L2' }),
    publicCollector({ responseLocationId: 'L2' }),
    publicCollector({ declaration: { boundLocationId: undefined, locationId: undefined } }),
  ]) {
    const root = tempClient('location');
    t.after(() => rmSync(root, { recursive: true, force: true }));
    await assert.rejects(
      runCaptureMode(captureArgs(root, { publicCollector: collector })),
      /LEGACY_LOCATION_MISMATCH/,
    );
    assert.equal(existsSync(join(root, 'captures')), false);
  }
});

test('workflow validator remains authoritative and partial evidence cannot pass', async (t) => {
  const valid = spawnSync('python3', [
    join(SKILL, 'capture', 'validate_workflow_capture.py'), LEGACY_FIXTURE,
  ], { encoding: 'utf8' });
  assert.equal(valid.status, 0, valid.stdout + valid.stderr);
  assert.match(valid.stdout, /^VALID /);

  const invalid = tempClient('invalid-workflow');
  t.after(() => rmSync(invalid, { recursive: true, force: true }));
  cpSync(LEGACY_FIXTURE, invalid, { recursive: true });
  writeFileSync(join(invalid, 'workflow.json'), json({ id: 'workflow-1' }));
  const invalidResult = spawnSync('python3', [
    join(SKILL, 'capture', 'validate_workflow_capture.py'), invalid,
  ], { encoding: 'utf8' });
  assert.equal(invalidResult.status, 1);
  assert.match(invalidResult.stdout, /^INVALID/m);

  const root = tempClient('verify-partial');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeManifest(root, baseManifest());
  const result = await runVerifyMode(captureArgs(root, {
    browserCollector: browserCollector({ bodyFor: ({ file }) => (
      file === 'workflow.json' ? { id: 'workflow-1', locationId: LOCATION } : triggerBody()
    ) }),
    baselineValidator: async () => ({ pass: true, evidenceRefs: ['baseline'] }),
    workflowCaptureValidator: async () => ({ valid: false, evidenceRefs: ['workflow.json'] }),
    registry: { workflows: [{ id: 'workflow-1', section: 'registry.workflows' }] },
    stageConformance: async () => ({ pass: true, evidenceRefs: ['stages'] }),
    namedObjectConformance: async () => ({ pass: true, evidenceRefs: ['objects'] }),
    goLiveChecker: async () => ({ pass: true, evidenceRefs: ['golive'] }),
  }));
  assert.equal(result.status, 'FAIL');
  assert.equal(result.checks.find((check) => check.name === 'workflows').status, 'FAIL');
});

test('verify runs the five legacy checks in order and reports exact conformance', async (t) => {
  const root = tempClient('verify-order');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeManifest(root, baseManifest());
  const order = [];
  const pass = (name) => async () => {
    order.push(name);
    return { pass: true, evidenceRefs: [`registry.${name}`] };
  };
  const result = await runVerifyMode(captureArgs(root, {
    baselineValidator: pass('baseline'),
    workflowConformance: pass('workflows'),
    stageConformance: pass('stages'),
    namedObjectConformance: pass('named-objects'),
    goLiveChecker: pass('go-live'),
    registry: {},
  }));
  assert.deepEqual(order, ['baseline', 'workflows', 'stages', 'named-objects', 'go-live']);
  assert.equal(result.status, 'PASS');
  assert.equal(result.checks.length, 5);
  assert.ok(result.checks.every((check) => check.status === 'PASS'));

  for (const failedName of order) {
    const failureRoot = tempClient(`verify-${failedName}`);
    t.after(() => rmSync(failureRoot, { recursive: true, force: true }));
    writeManifest(failureRoot, baseManifest());
    const failed = await runVerifyMode(captureArgs(failureRoot, {
      baselineValidator: async () => ({ pass: failedName !== 'baseline', evidenceRefs: ['design.baseline'] }),
      workflowConformance: async () => ({ pass: failedName !== 'workflows', evidenceRefs: ['registry.workflows'] }),
      stageConformance: async () => ({ pass: failedName !== 'stages', evidenceRefs: ['registry.stage_map'] }),
      namedObjectConformance: async () => ({ pass: failedName !== 'named-objects', evidenceRefs: ['registry.objects'] }),
      goLiveChecker: async () => ({ pass: failedName !== 'go-live', evidenceRefs: ['manifest.golive'] }),
      registry: {},
    }));
    assert.equal(failed.status, 'FAIL');
    assert.ok(failed.checks.some((check) => check.status === 'FAIL' && check.evidenceRefs.length));
  }
});

test('capture verify and weekly do not modify client manifest', async (t) => {
  for (const mode of ['capture', 'verify']) {
    const root = tempClient(`manifest-${mode}`);
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const manifestPath = writeManifest(root, baseManifest());
    const old = new Date('2020-01-01T00:00:00.000Z');
    utimesSync(manifestPath, old, old);
    const before = snapshot(manifestPath);
    if (mode === 'capture') await runCaptureMode(captureArgs(root));
    else await runVerifyMode(captureArgs(root, {
      baselineValidator: async () => ({ pass: true, evidenceRefs: ['baseline'] }),
      workflowConformance: async () => ({ pass: true, evidenceRefs: ['workflow'] }),
      stageConformance: async () => ({ pass: true, evidenceRefs: ['stage'] }),
      namedObjectConformance: async () => ({ pass: true, evidenceRefs: ['objects'] }),
      goLiveChecker: async () => ({ pass: false, evidenceRefs: ['golive'] }),
      registry: {},
    }));
    assertSnapshot(manifestPath, before);
  }

  const weeklyRoot = tempClient('weekly-canary');
  t.after(() => rmSync(weeklyRoot, { recursive: true, force: true }));
  const weeklyManifest = writeManifest(weeklyRoot, baseManifest());
  const before = snapshot(weeklyManifest);
  const replayOutput = tempClient('weekly-output');
  t.after(() => rmSync(replayOutput, { recursive: true, force: true }));
  execFileSync('node', [
    join(SKILL, 'dist', 'audit-cli.mjs'),
    'replay',
    '--fixture', join(HERE, 'fixtures', 'weekly', 'client-partial-pagination'),
    '--output', replayOutput,
  ], { cwd: REPO, stdio: 'pipe' });
  assertSnapshot(weeklyManifest, before);
});

test('scheduled harvest is rejected before every side effect', async (t) => {
  const root = tempClient('scheduled');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let effects = 0;
  const effect = () => { effects += 1; throw new Error('effect reached'); };
  await assert.rejects(
    runHarvestMode({
      scheduled: true,
      clientFolder: root,
      locationId: LOCATION,
      publicCollector: { get declaration() { effect(); } },
      effects: {
        onManifestRead: effect,
        onCollect: effect,
        onCaptureDirectory: effect,
        onIgnoreFile: effect,
        onReportWrite: effect,
        onManifestWrite: effect,
      },
    }),
    /LEGACY_HARVEST_SCHEDULED/,
  );
  assert.equal(effects, 0);
  assert.equal(existsSync(join(root, 'captures')), false);
});

test('harvest resolves only exact unique same-location live IDs', async (t) => {
  const root = tempClient('harvest-exact');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeManifest(root, {
    ...baseManifest(),
    pipeline_id: 'old-unverified-id',
  });
  const result = await runHarvestMode(harvestArgs(root));
  const manifest = JSON.parse(readFileSync(join(root, 'client-manifest.json'), 'utf8'));
  assert.equal(result.manifestChanged, true);
  assert.equal(manifest.ghl_location_id, LOCATION);
  assert.equal(manifest.pipeline_id, 'pipeline-1');
  assert.deepEqual(manifest.stage_map, { 'stage-booked': 'booked', 'stage-lead': 'lead' });
  assert.deepEqual(manifest.booking.calendar_ids, ['calendar-1']);
  assert.equal(manifest.ai_agents.chat_primary, 'agent-1');
  assert.equal(manifest.phone.tracked_number, '+61400000000');

  const ambiguousRoot = tempClient('harvest-ambiguous');
  t.after(() => rmSync(ambiguousRoot, { recursive: true, force: true }));
  writeManifest(ambiguousRoot, { ...baseManifest(), pipeline_id: 'old-unverified-id' });
  const ambiguousAreas = liveAreas();
  ambiguousAreas.pipelines.push({
    id: 'pipeline-2',
    locationId: LOCATION,
    name: 'Sales Pipeline',
    stages: [],
  });
  const ambiguous = await runHarvestMode(harvestArgs(ambiguousRoot, {
    publicCollector: publicCollector({ areas: ambiguousAreas }),
  }));
  const ambiguousManifest = JSON.parse(readFileSync(join(ambiguousRoot, 'client-manifest.json'), 'utf8'));
  assert.ok(ambiguous.unresolved.includes('pipeline_id'));
  assert.equal(ambiguousManifest.pipeline_id, null);
  assert.equal(ambiguousManifest.ids_harvested, false);
});

test('harvest preserves lifecycle ownership and never invents an ID', async (t) => {
  const root = tempClient('harvest-lifecycle');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const original = baseManifest();
  writeManifest(root, original);
  const result = await runHarvestMode(harvestArgs(root, {
    harvestBindings: harvestBindings({
      'ai_agents.chat_primary': { kind: 'ai-agent', name: 'Missing Agent' },
    }),
  }));
  const manifest = JSON.parse(readFileSync(join(root, 'client-manifest.json'), 'utf8'));
  assert.equal(manifest.currency, original.currency);
  assert.equal(manifest.tracking.clarity_project_id, original.tracking.clarity_project_id);
  assert.equal(manifest.ai_agents.chat_primary, null);
  assert.ok(result.unresolved.includes('ai_agents.chat_primary'));
  assert.equal(manifest.stage_map['stage-lead'], 'lead');
  assert.equal(manifest.stage_map['stage-booked'], 'booked');
});

test('ids harvested is true only when every declared harvest field resolves', async (t) => {
  const allPaths = Object.keys(harvestBindings());
  for (const missingPath of [null, ...allPaths]) {
    const root = tempClient(`harvest-complete-${missingPath ?? 'none'}`);
    t.after(() => rmSync(root, { recursive: true, force: true }));
    writeManifest(root, baseManifest());
    const bindings = harvestBindings();
    if (missingPath) delete bindings[missingPath];
    const result = await runHarvestMode(harvestArgs(root, {
      harvestBindings: bindings,
      goLiveChecker: async () => ({ pass: false, output: 'GOLIVE_GAP' }),
    }));
    const manifest = JSON.parse(readFileSync(join(root, 'client-manifest.json'), 'utf8'));
    assert.equal(manifest.ids_harvested, missingPath === null, missingPath ?? 'complete');
    assert.equal(result.status, missingPath === null ? 'PASS' : 'FAIL');
  }
});

test('harvest manifest update is atomic and detects concurrent change', async (t) => {
  for (const hookName of ['beforeFsync', 'beforeRename']) {
    const root = tempClient(`atomic-${hookName}`);
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const manifestPath = writeManifest(root, baseManifest());
    const before = readFileSync(manifestPath);
    await assert.rejects(
      runHarvestMode(harvestArgs(root, {
        atomicHooks: { [hookName]: async () => { throw new Error(`crash-${hookName}`); } },
      })),
      new RegExp(`crash-${hookName}`),
    );
    assert.deepEqual(readFileSync(manifestPath), before);
    assert.equal(JSON.parse(readFileSync(manifestPath, 'utf8')).ids_harvested, false);
  }

  const root = tempClient('atomic-conflict');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const manifestPath = writeManifest(root, baseManifest());
  await assert.rejects(
    runHarvestMode(harvestArgs(root, {
      atomicHooks: {
        beforeConflictCheck: async () => {
          writeFileSync(manifestPath, json({ ...baseManifest(), label: 'Concurrent' }));
        },
      },
    })),
    /LEGACY_MANIFEST_CONFLICT/,
  );
  assert.equal(JSON.parse(readFileSync(manifestPath, 'utf8')).label, 'Concurrent');
});

test('legacy errors and artifacts contain no private or authorization canary', async (t) => {
  const root = tempClient('privacy');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const canaries = [
    'Bearer eyJprivate.header.payload',
    'Cookie=session-private',
    '/private/credential/path',
    'person@example.com',
    'private raw message',
  ];
  const areas = liveAreas();
  areas.pipelines[0].privateNote = canaries.join(' | ');
  const result = await runCaptureMode(captureArgs(root, {
    publicCollector: publicCollector({ areas }),
  }));
  const captureRoot = join(root, result.captureRoot);
  const committable = walkFiles(captureRoot).filter((path) => !path.startsWith('raw/'));
  const text = [JSON.stringify(result), ...committable.map((path) => readFileSync(join(captureRoot, path), 'utf8'))].join('\n');
  for (const canary of canaries.slice(0, 2)) assert.ok(!text.includes(canary));
  assert.ok(!text.includes('/private/credential/path'));
  await assert.rejects(
    runCaptureMode(captureArgs(tempClient('privacy-error'), {
      publicCollector: publicCollector({ declaration: { authorization: canaries[0] } }),
    })),
    (error) => {
      assert.equal(error.code, 'LEGACY_READ_ONLY_VIOLATION');
      assert.equal(error.message, 'LEGACY_READ_ONLY_VIOLATION');
      return true;
    },
  );
});

test('legacy migration creates no weekly state review memory or proposals', async (t) => {
  for (const mode of ['capture', 'verify', 'harvest']) {
    const root = tempClient(`isolation-${mode}`);
    t.after(() => rmSync(root, { recursive: true, force: true }));
    if (mode !== 'capture') writeManifest(root, baseManifest());
    if (mode === 'capture') await runCaptureMode(captureArgs(root));
    if (mode === 'verify') await runVerifyMode(captureArgs(root, {
      baselineValidator: async () => ({ pass: true, evidenceRefs: ['baseline'] }),
      workflowConformance: async () => ({ pass: true, evidenceRefs: ['workflow'] }),
      stageConformance: async () => ({ pass: true, evidenceRefs: ['stage'] }),
      namedObjectConformance: async () => ({ pass: true, evidenceRefs: ['objects'] }),
      goLiveChecker: async () => ({ pass: true, evidenceRefs: ['golive'] }),
      registry: {},
    }));
    if (mode === 'harvest') await runHarvestMode(harvestArgs(root));
    const paths = walkFiles(root);
    assert.equal(paths.some((path) => path.startsWith('audits/ghl')), false);
    assert.equal(paths.some((path) => path.endsWith('.sqlite')), false);
    assert.equal(paths.some((path) =>
      /(?:^|\/)(?:memory|review-request|REPORT\.md|solution)(?:\/|$)/i.test(path)), false);
  }
});

test('browser response location drift and throwing rejection handlers fail with stable codes', async () => {
  await assert.rejects(
    collectBrowserWorkflowEvidence({
      locationId: LOCATION,
      workflowIds: ['workflow-1'],
      browserCollector: browserCollector({
        bodyFor: ({ file }) => file === 'workflow.json'
          ? workflowBody('L2')
          : triggerBody(),
      }),
      browserThrottle: throttle(),
    }),
    (error) => error.code === 'LEGACY_LOCATION_MISMATCH'
      && error.message === 'LEGACY_LOCATION_MISMATCH',
  );

  await assert.rejects(
    collectBrowserWorkflowEvidence({
      locationId: LOCATION,
      workflowIds: ['workflow-1'],
      browserCollector: browserCollector({
        statusFor: { 'workflow.json': 429 },
      }),
      browserThrottle: {
        async wait() {},
        async reject() { throw new Error('private throttle state'); },
      },
    }),
    (error) => error.code === 'LEGACY_BROWSER_CAPTURE_STOPPED'
      && !error.message.includes('private throttle state'),
  );
});

test('capture reports invalid full workflow evidence as incomplete', async (t) => {
  const root = tempClient('capture-invalid');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const result = await runCaptureMode(captureArgs(root, {
    workflowCaptureValidator: async () => ({ valid: false, evidenceRefs: ['workflow.json'] }),
  }));
  assert.equal(result.status, 'FAIL');
  assert.deepEqual(result.unresolved, ['workflows.workflow-1']);
  assert.equal(result.checks[0].name, 'workflow-capture');
  assert.equal(result.checks[0].status, 'FAIL');
});

test('harvest validates required dependencies before changing a manifest', async (t) => {
  for (const overrides of [
    { goLiveChecker: undefined },
    { harvestBindings: undefined },
  ]) {
    const root = tempClient('harvest-input');
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const manifestPath = writeManifest(root, baseManifest());
    const before = snapshot(manifestPath);
    await assert.rejects(
      runHarvestMode(harvestArgs(root, overrides)),
      /LEGACY_VERIFY_INPUT_MISSING|LEGACY_HARVEST_SOURCE_INVALID/,
    );
    assertSnapshot(manifestPath, before);
  }
});

test('unverified stale harvest IDs are cleared when exact live resolution fails', async (t) => {
  const root = tempClient('stale-harvest');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const manifest = baseManifest();
  manifest.booking.calendar_ids = ['stale-calendar'];
  manifest.ai_agents.chat_primary = 'stale-agent';
  manifest.phone.tracked_number = '+61999999999';
  writeManifest(root, manifest);
  const bindings = harvestBindings();
  delete bindings['booking.calendar_ids'];
  delete bindings['ai_agents.chat_primary'];
  delete bindings['phone.tracked_number'];
  await runHarvestMode(harvestArgs(root, { harvestBindings: bindings }));
  const updated = JSON.parse(readFileSync(join(root, 'client-manifest.json'), 'utf8'));
  assert.deepEqual(updated.booking.calendar_ids, []);
  assert.equal(updated.ai_agents.chat_primary, null);
  assert.equal(updated.phone.tracked_number, null);
  assert.equal(updated.ids_harvested, false);
});

test('same-byte manifest inode replacement is a concurrent conflict', async (t) => {
  const root = tempClient('inode-conflict');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const manifestPath = writeManifest(root, baseManifest());
  const originalInode = statSync(manifestPath).ino;
  await assert.rejects(
    runHarvestMode(harvestArgs(root, {
      atomicHooks: {
        beforeConflictCheck: async () => {
          const bytes = readFileSync(manifestPath);
          rmSync(manifestPath);
          writeFileSync(manifestPath, bytes);
        },
      },
    })),
    /LEGACY_MANIFEST_CONFLICT/,
  );
  assert.notEqual(statSync(manifestPath).ino, originalInode);
  assert.equal(JSON.parse(readFileSync(manifestPath, 'utf8')).ids_harvested, false);
});
