import { constants } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { sanitizeCapture } from '../../scripts/sanitize_capture.mjs';
import {
  cloneJson,
  codedError,
  deepFreezeJson,
} from './collection.mjs';
import { sha256 } from '../canonical.mjs';

export const LEGACY_WORKFLOW_ENDPOINTS = deepFreezeJson([
  {
    file: 'workflow.json',
    endpoint: ({ locationId, workflowId }) =>
      `/workflow/${locationId}/${workflowId}?includeScheduledPauseInfo=true`,
    optional: false,
  },
  {
    file: 'trigger.json',
    endpoint: ({ locationId, workflowId }) =>
      `/workflow/${locationId}/trigger?workflowId=${workflowId}`,
    optional: false,
  },
  {
    file: 'sticky-notes.json',
    endpoint: ({ locationId, workflowId }) =>
      `/workflows/sticky-notes-all?workflowId=${workflowId}&locationId=${locationId}`,
    optional: true,
  },
  {
    file: 'step-counts.json',
    endpoint: ({ locationId, workflowId }) =>
      `/workflows/status/search/count-per-step?workflowId=${workflowId}&locationId=${locationId}`,
    optional: true,
  },
  {
    file: 'trigger-catalog.json',
    endpoint: ({ locationId }) =>
      `/marketplace/core/search/module?locationId=${locationId}&type=triggers&isInstalled=true&skip=0&limit=200`,
    optional: true,
  },
  {
    file: 'action-catalog.json',
    endpoint: ({ locationId }) =>
      `/marketplace/core/search/module?locationId=${locationId}&type=actions&isInstalled=true&skip=0&limit=200`,
    optional: true,
  },
  {
    file: 'pipelines.json',
    endpoint: ({ locationId }) => `/opportunities/pipelines?locationId=${locationId}`,
    optional: true,
  },
  {
    file: 'custom-values.json',
    endpoint: ({ locationId }) =>
      `/custom-data/conversations?locationId=${locationId}&types=custom-values`,
    optional: true,
  },
  {
    file: 'workflow-settings.json',
    endpoint: ({ locationId }) =>
      `/workflow/${locationId}/workflow-location-setting/settings`,
    optional: true,
  },
]);

const LEGACY_MODES = new Set(['capture', 'verify', 'harvest', 'weekly']);
const AREA_NAMES = [
  'pipelines',
  'custom-fields',
  'custom-values',
  'tags',
  'calendars',
  'users',
  'phone-numbers',
  'ai-agents',
  'workflows',
];
const DANGEROUS_DECLARATION_KEYS = /^(authorization|body|confirm|cookie|delete|mutation|publish|raw[_-]?request|requestbody|send|trigger)$/iu;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/u;

const DEFAULT_FS = Object.freeze({
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
});

function error(code, ErrorType = Error) {
  throw codedError(code, ErrorType);
}

function plainObject(value) {
  return Boolean(
    value
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
  );
}

function normalizedFs(fsOps) {
  const candidate = fsOps ?? DEFAULT_FS;
  for (const name of Object.keys(DEFAULT_FS)) {
    if (typeof candidate[name] !== 'function') error('LEGACY_CAPTURE_PATH_INVALID', TypeError);
  }
  return candidate;
}

export function resolveLegacyMode(mode) {
  const resolved = mode === undefined || mode === null || mode === '' ? 'capture' : mode;
  if (!LEGACY_MODES.has(resolved)) error('LEGACY_MODE_INVALID', TypeError);
  return resolved;
}

function assertLocationId(locationId) {
  if (typeof locationId !== 'string' || !SAFE_ID.test(locationId)) {
    error('LEGACY_TARGET_INVALID', TypeError);
  }
  return locationId;
}

export function resolveCaptureDate({ captureDate, clock } = {}) {
  let value = captureDate;
  if (value === undefined) {
    const now = typeof clock === 'function' ? clock() : new Date();
    const date = now instanceof Date ? now : new Date(now);
    if (Number.isNaN(date.getTime())) error('LEGACY_CAPTURE_DATE_INVALID', TypeError);
    value = date.toISOString().slice(0, 10);
  }
  if (typeof value !== 'string' || !DATE_PATTERN.test(value)) {
    error('LEGACY_CAPTURE_DATE_INVALID', TypeError);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    error('LEGACY_CAPTURE_DATE_INVALID', TypeError);
  }
  return value;
}

function safeRelative(value) {
  return typeof value === 'string'
    && value.length > 0
    && !value.startsWith('/')
    && !value.includes('\0')
    && value.split(/[\\/]/u).every((part) => part !== '' && part !== '.' && part !== '..');
}

function pathInside(root, candidate) {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !rel.startsWith(sep));
}

async function assertClientFolder(clientFolder, fsOps) {
  if (typeof clientFolder !== 'string' || clientFolder.length === 0) {
    error('LEGACY_TARGET_INVALID', TypeError);
  }
  let info;
  let canonical;
  try {
    info = await fsOps.lstat(clientFolder);
    canonical = await fsOps.realpath(clientFolder);
  } catch {
    error('LEGACY_TARGET_INVALID');
  }
  if (!info.isDirectory() || info.isSymbolicLink()) error('LEGACY_TARGET_INVALID');
  return canonical;
}

function inspectDangerousDeclaration(value, key = '') {
  if (DANGEROUS_DECLARATION_KEYS.test(key.replace(/[^A-Za-z0-9_-]/gu, ''))) {
    return true;
  }
  if (Array.isArray(value)) return value.some((entry) => inspectDangerousDeclaration(entry));
  if (plainObject(value)) {
    return Object.entries(value).some(([nestedKey, nested]) =>
      inspectDangerousDeclaration(nested, nestedKey));
  }
  return false;
}

export function assertLegacyReadOnlyCollector(collector, expectedLocationId) {
  if (!collector || typeof collector !== 'object' || typeof collector.collect !== 'function') {
    error('LEGACY_READ_ONLY_VIOLATION', TypeError);
  }
  const declaration = collector.declaration;
  if (
    !plainObject(declaration)
    || declaration.method !== 'GET'
    || declaration.risk !== 'read'
    || declaration.locationId !== expectedLocationId
    || declaration.boundLocationId !== expectedLocationId
  ) {
    if (
      declaration?.locationId !== expectedLocationId
      || declaration?.boundLocationId !== expectedLocationId
    ) error('LEGACY_LOCATION_MISMATCH');
    error('LEGACY_READ_ONLY_VIOLATION');
  }
  if (inspectDangerousDeclaration(declaration)) error('LEGACY_READ_ONLY_VIOLATION');
  return collector;
}

function assertBrowserCollector(collector, expectedLocationId) {
  if (!collector || typeof collector !== 'object' || typeof collector.fetch !== 'function') {
    error('LEGACY_COLLECTION_INCOMPLETE', TypeError);
  }
  const declaration = collector.declaration;
  if (
    !plainObject(declaration)
    || declaration.method !== 'GET'
    || declaration.risk !== 'read'
    || declaration.locationId !== expectedLocationId
    || declaration.boundLocationId !== expectedLocationId
  ) {
    if (
      declaration?.locationId !== expectedLocationId
      || declaration?.boundLocationId !== expectedLocationId
    ) error('LEGACY_LOCATION_MISMATCH');
    error('LEGACY_READ_ONLY_VIOLATION');
  }
  if (inspectDangerousDeclaration(declaration)) error('LEGACY_READ_ONLY_VIOLATION');
  return collector;
}

function assertResponseLocations(value, expectedLocationId, found = { count: 0 }) {
  if (!value || typeof value !== 'object') return found;
  for (const [key, nested] of Object.entries(value)) {
    const normalized = key.toLowerCase().replace(/[^a-z0-9]/gu, '');
    if (['boundlocationid', 'locationid'].includes(normalized)) {
      found.count += 1;
      if (nested !== expectedLocationId) error('LEGACY_LOCATION_MISMATCH');
    } else {
      assertResponseLocations(nested, expectedLocationId, found);
    }
  }
  return found;
}

function cloneSafe(value, code = 'LEGACY_COLLECTION_INCOMPLETE') {
  try {
    return cloneJson(value, code);
  } catch {
    error(code, TypeError);
  }
}

export async function collectBrowserWorkflowEvidence({
  locationId,
  workflowIds,
  browserCollector,
  browserThrottle,
  includeOptionalWorkflowEndpoints = false,
} = {}) {
  const expectedLocationId = assertLocationId(locationId);
  assertBrowserCollector(browserCollector, expectedLocationId);
  if (
    !browserThrottle
    || typeof browserThrottle.wait !== 'function'
    || typeof browserThrottle.reject !== 'function'
    || !Array.isArray(workflowIds)
    || workflowIds.some((workflowId) => typeof workflowId !== 'string' || !SAFE_ID.test(workflowId))
  ) error('LEGACY_COLLECTION_INCOMPLETE', TypeError);

  const endpoints = LEGACY_WORKFLOW_ENDPOINTS.filter(
    ({ optional }) => !optional || includeOptionalWorkflowEndpoints,
  );
  const workflows = {};
  for (const workflowId of [...new Set(workflowIds)].sort()) {
    const files = {};
    for (const endpoint of endpoints) {
      await browserThrottle.wait();
      let response;
      try {
        response = await browserCollector.fetch({
          method: 'GET',
          locationId: expectedLocationId,
          workflowId,
          file: endpoint.file,
          endpoint: endpoint.endpoint({ locationId: expectedLocationId, workflowId }),
        });
      } catch {
        error('LEGACY_COLLECTION_INCOMPLETE');
      }
      if (!plainObject(response) || response.locationId !== expectedLocationId) {
        error('LEGACY_LOCATION_MISMATCH');
      }
      if (response.status === 403 || response.status === 429) {
        try {
          await browserThrottle.reject(response.status);
        } catch {
          // The legacy throttle normally throws after persisting its cooldown.
        }
        error('LEGACY_BROWSER_CAPTURE_STOPPED');
      }
      if (response.status === 401) error('LEGACY_BROWSER_CAPTURE_STOPPED');
      if (response.status !== 200 || !Object.hasOwn(response, 'body')) {
        error('LEGACY_COLLECTION_INCOMPLETE');
      }
      assertResponseLocations(response.body, expectedLocationId);
      files[endpoint.file] = cloneSafe(response.body);
    }
    workflows[workflowId] = { files };
  }
  return deepFreezeJson({ locationId: expectedLocationId, workflows });
}

export async function collectLegacySweep({
  locationId,
  publicCollector,
  browserCollector,
  browserThrottle,
  includeOptionalWorkflowEndpoints = false,
  workflowCaptureValidator,
  effects = {},
} = {}) {
  const expectedLocationId = assertLocationId(locationId);
  const collector = assertLegacyReadOnlyCollector(publicCollector, expectedLocationId);
  effects.onCollect?.();
  let publicResult;
  try {
    publicResult = await collector.collect({
      method: 'GET',
      locationId: expectedLocationId,
      readOnly: true,
    });
  } catch (caught) {
    if (caught?.code) throw caught;
    error('LEGACY_COLLECTION_INCOMPLETE');
  }
  if (
    !plainObject(publicResult)
    || publicResult.boundLocationId !== expectedLocationId
    || publicResult.complete !== true
    || !plainObject(publicResult.areas)
  ) {
    if (publicResult?.boundLocationId !== expectedLocationId) error('LEGACY_LOCATION_MISMATCH');
    error('LEGACY_COLLECTION_INCOMPLETE');
  }
  assertResponseLocations(publicResult, expectedLocationId);
  for (const area of AREA_NAMES) {
    if (!Array.isArray(publicResult.areas[area])) error('LEGACY_COLLECTION_INCOMPLETE');
  }
  const areas = cloneSafe(publicResult.areas);
  const workflowIds = areas.workflows.map(({ id }) => id);
  const browser = await collectBrowserWorkflowEvidence({
    locationId: expectedLocationId,
    workflowIds,
    browserCollector,
    browserThrottle,
    includeOptionalWorkflowEndpoints,
  });
  const workflowValidity = {};
  for (const workflowId of workflowIds) {
    const files = browser.workflows[workflowId]?.files;
    let validation = { valid: false, evidenceRefs: [] };
    if (typeof workflowCaptureValidator === 'function') {
      try {
        validation = await workflowCaptureValidator({
          workflowId,
          locationId: expectedLocationId,
          files: cloneSafe(files),
        });
      } catch {
        validation = { valid: false, evidenceRefs: [] };
      }
    }
    workflowValidity[workflowId] = {
      valid: validation?.valid === true,
      evidenceRefs: Array.isArray(validation?.evidenceRefs)
        ? validation.evidenceRefs.filter(safeRelative)
        : [],
    };
  }
  return deepFreezeJson({
    locationId: expectedLocationId,
    areas,
    browser,
    workflowValidity,
  });
}

function rawJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function removePrivateContent(value, key = '') {
  if (/^(?:credential(?:path|ref)|private(?:body|message|note)|raw(?:body|message|transcript)|pii)$/iu.test(key)) {
    return '<REDACTED:private-content>';
  }
  if (Array.isArray(value)) return value.map((entry) => removePrivateContent(entry, key));
  if (plainObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([nestedKey, nested]) => [
      nestedKey,
      removePrivateContent(nested, nestedKey),
    ]));
  }
  return value;
}

function sanitizedJson(value) {
  const { sanitized } = sanitizeCapture(value);
  return rawJson(removePrivateContent(sanitized));
}

function markdownCell(value) {
  return String(value ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ');
}

function areaMarkdown(area, items) {
  const title = area.split('-').map((part) =>
    `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`).join(' ');
  const rows = [...items].sort((left, right) =>
    String(left.name ?? left.id ?? '').localeCompare(String(right.name ?? right.id ?? '')));
  const lines = [
    `# ${title}`,
    '',
    '| Name | ID | Status |',
    '|---|---|---|',
    ...rows.map((item) =>
      `| ${markdownCell(item.name)} | \`${markdownCell(item.id)}\` | ${markdownCell(item.status)} |`),
    '',
  ];
  return lines.join('\n');
}

function workflowMarkdown(sweep) {
  const rows = [...sweep.areas.workflows].sort((left, right) =>
    String(left.name ?? left.id).localeCompare(String(right.name ?? right.id)));
  return [
    '# Workflows',
    '',
    '| Name | ID | Status | Trigger | Step count |',
    '|---|---|---|---|---|',
    ...rows.map((item) => {
      const files = sweep.browser.workflows[item.id]?.files;
      const full = files?.['workflow.json'];
      const trigger = files?.['trigger.json'];
      const triggerItems = trigger?.triggers ?? trigger?.items ?? trigger?.data ?? [];
      const triggerTypes = Array.isArray(triggerItems)
        ? triggerItems.map((entry) => entry?.type).filter(Boolean).sort().join(', ')
        : '';
      const templates = full?.workflowData?.templates;
      const count = Array.isArray(templates) ? templates.length : '';
      return `| ${markdownCell(item.name)} | \`${markdownCell(item.id)}\` | ${markdownCell(full?.status ?? item.status)} | ${markdownCell(triggerTypes)} | ${markdownCell(count)} |`;
    }),
    '',
  ].join('\n');
}

export function captureReport({ sweep, mode = 'capture', checks = [], unresolved = [] }) {
  const workflowItems = sweep.areas.workflows;
  const active = workflowItems.filter(({ status }) => status === 'PUBLISHED' || status === 'ACTIVE').length;
  const draft = workflowItems.length - active;
  const inventory = AREA_NAMES.map((area) => `- ${area}: ${sweep.areas[area].length}`);
  const customLooking = [
    ...sweep.areas.workflows,
    ...sweep.areas.pipelines,
    ...sweep.areas['custom-fields'],
  ].filter((item) => !/^\d{2}\s/u.test(String(item.name ?? '')));
  const fieldKeys = sweep.areas['custom-fields']
    .map((item) => item.fieldKey)
    .filter(Boolean)
    .sort();
  const tagNames = sweep.areas.tags.map((item) => item.name).filter(Boolean).sort();
  const calendarNames = sweep.areas.calendars.map((item) => item.name).filter(Boolean).sort();
  const pipelineNames = sweep.areas.pipelines.map((item) => item.name).filter(Boolean).sort();
  const dispositionRows = [];
  for (const area of ['workflows', 'pipelines', 'custom-fields']) {
    for (const item of [...sweep.areas[area]].sort((left, right) =>
      String(left.name ?? left.id).localeCompare(String(right.name ?? right.id)))) {
      dispositionRows.push(
        `| ${area} | ${markdownCell(item.name)} | \`${markdownCell(item.id)}\` | keep | Existing live object requires architect review |`,
      );
    }
  }
  const checkLines = checks.map((check) =>
    `| ${check.name} | ${check.status} | ${check.evidenceRefs.map(markdownCell).join(', ')} |`);
  return [
    `# Legacy ${mode} audit report`,
    '',
    '## Inventory',
    '',
    ...inventory,
    `- workflows active: ${active}`,
    `- workflows draft: ${draft}`,
    '',
    '## Snapshot stock and custom-looking objects',
    '',
    `- custom-looking or unnumbered objects: ${customLooking.length}`,
    ...customLooking.map((item) => `- ${markdownCell(item.name)} (\`${markdownCell(item.id)}\`)`),
    '',
    '## Collision surfaces',
    '',
    `- custom-field keys: ${fieldKeys.map(markdownCell).join(', ') || 'none'}`,
    `- tag spellings: ${tagNames.map(markdownCell).join(', ') || 'none'}`,
    `- calendar names: ${calendarNames.map(markdownCell).join(', ') || 'none'}`,
    `- pipeline names: ${pipelineNames.map(markdownCell).join(', ') || 'none'}`,
    '',
    '## Disposition input',
    '',
    '| Area | Name | ID | Suggestion | Reason |',
    '|---|---|---|---|---|',
    ...dispositionRows,
    ...(checks.length ? [
      '',
      '## Conformance checks',
      '',
      '| Check | Status | Evidence |',
      '|---|---|---|',
      ...checkLines,
    ] : []),
    ...(unresolved.length ? [
      '',
      '## Unresolved',
      '',
      ...unresolved.map((path) => `- ${markdownCell(path)}`),
    ] : []),
    '',
  ].join('\n');
}

export function buildLegacyCaptureFiles({
  sweep,
  captureDate,
  mode,
  checks = [],
  unresolved = [],
  report,
} = {}) {
  const files = new Map();
  for (const area of AREA_NAMES) {
    const value = sweep.areas[area];
    files.set(`raw/${area}.json`, rawJson(value));
    files.set(`${area}.json`, sanitizedJson(value));
    files.set(`${area}.md`, areaMarkdown(area, value));
  }
  files.set('workflows.md', workflowMarkdown(sweep));
  for (const [workflowId, workflow] of Object.entries(sweep.browser.workflows)) {
    for (const [file, value] of Object.entries(workflow.files)) {
      const rel = `workflows/${workflowId}/${file}`;
      files.set(`raw/${rel}`, rawJson(value));
      files.set(rel, sanitizedJson(value));
    }
  }
  const endpointList = [
    ...AREA_NAMES.map((area) => `public:${area}`),
    ...Object.entries(sweep.browser.workflows).flatMap(([workflowId, workflow]) =>
      Object.keys(workflow.files).map((file) => `browser:${workflowId}/${file}`)),
  ].sort();
  files.set('manifest.json', rawJson({
    locationId: sweep.locationId,
    captureDate,
    mode,
    endpoints: endpointList,
    skipped: [],
  }));
  files.set('audit-report.md', report ?? captureReport({
    sweep,
    mode,
    checks,
    unresolved,
  }));
  return files;
}

async function lstatOrNull(path, fsOps) {
  try {
    return await fsOps.lstat(path);
  } catch (caught) {
    if (caught?.code === 'ENOENT') return null;
    error('LEGACY_CAPTURE_PATH_INVALID');
  }
}

async function ensureIgnoreRule(clientRoot, fsOps, effects) {
  const path = join(clientRoot, '.gitignore');
  const info = await lstatOrNull(path, fsOps);
  let current = '';
  if (info) {
    if (!info.isFile() || info.isSymbolicLink()) error('LEGACY_CAPTURE_PATH_INVALID');
    current = await fsOps.readFile(path, 'utf8');
  }
  if (current.split(/\r?\n/u).includes('captures/**/raw/')) return;
  effects.onIgnoreFile?.();
  const withNewline = current.length === 0
    ? ''
    : current.endsWith('\n')
      ? current
      : `${current}\n`;
  await fsOps.writeFile(path, `${withNewline}captures/**/raw/\n`, {
    encoding: 'utf8',
    flag: info ? 'w' : 'wx',
  });
}

async function walkTree(root, fsOps, prefix = '') {
  const output = [];
  const directory = prefix ? join(root, ...prefix.split('/')) : root;
  for (const entry of await fsOps.readdir(directory, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolute = join(root, ...rel.split('/'));
    const info = await fsOps.lstat(absolute);
    if (info.isSymbolicLink()) error('LEGACY_CAPTURE_PATH_INVALID');
    if (info.isDirectory()) output.push(...await walkTree(root, fsOps, rel));
    else if (info.isFile()) output.push(rel);
    else error('LEGACY_CAPTURE_PATH_INVALID');
  }
  return output.sort();
}

async function ensureCaptureAncestors(clientRoot, captureRoot, fsOps, effects) {
  const captures = join(clientRoot, 'captures');
  let info = await lstatOrNull(captures, fsOps);
  if (!info) {
    effects.onCaptureDirectory?.();
    await fsOps.mkdir(captures);
    info = await fsOps.lstat(captures);
  }
  if (!info.isDirectory() || info.isSymbolicLink()) error('LEGACY_CAPTURE_PATH_INVALID');
  const canonicalCaptures = await fsOps.realpath(captures);
  if (!pathInside(clientRoot, canonicalCaptures)) error('LEGACY_CAPTURE_PATH_INVALID');
  const rootInfo = await lstatOrNull(captureRoot, fsOps);
  if (!rootInfo) {
    await fsOps.mkdir(captureRoot);
  } else if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    error('LEGACY_CAPTURE_PATH_INVALID');
  }
}

async function compareExistingTree(captureRoot, files, fsOps) {
  const info = await lstatOrNull(captureRoot, fsOps);
  if (!info) return { complete: false, existing: [] };
  const existing = await walkTree(captureRoot, fsOps);
  for (const rel of existing) {
    if (!files.has(rel)) error('LEGACY_CAPTURE_CONFLICT');
    const bytes = await fsOps.readFile(join(captureRoot, ...rel.split('/')), 'utf8');
    if (bytes !== files.get(rel)) error('LEGACY_CAPTURE_CONFLICT');
  }
  return { complete: existing.length === files.size, existing };
}

export async function writeLegacyCaptureTree({
  clientFolder,
  captureDate,
  files,
  fsOps,
  effects = {},
} = {}) {
  const fs = normalizedFs(fsOps);
  const clientRoot = await assertClientFolder(clientFolder, fs);
  const date = resolveCaptureDate({ captureDate });
  const captureRoot = resolve(clientRoot, 'captures', date);
  if (!pathInside(clientRoot, captureRoot)) error('LEGACY_CAPTURE_PATH_INVALID');
  await ensureIgnoreRule(clientRoot, fs, effects);
  const initial = await compareExistingTree(captureRoot, files, fs);
  if (initial.complete) {
    return deepFreezeJson({
      captureRoot: `captures/${date}`,
      reportPath: `captures/${date}/audit-report.md`,
      retried: true,
    });
  }
  await ensureCaptureAncestors(clientRoot, captureRoot, fs, effects);
  const existing = new Set(initial.existing);
  for (const [rel, bytes] of [...files.entries()].sort(([left], [right]) =>
    left.localeCompare(right))) {
    if (!safeRelative(rel)) error('LEGACY_CAPTURE_PATH_INVALID');
    const absolute = resolve(captureRoot, ...rel.split('/'));
    if (!pathInside(captureRoot, absolute)) error('LEGACY_CAPTURE_PATH_INVALID');
    if (existing.has(rel)) continue;
    await fs.mkdir(dirname(absolute), { recursive: true });
    try {
      await fs.writeFile(absolute, bytes, { encoding: 'utf8', flag: 'wx' });
    } catch (caught) {
      if (caught?.code === 'EEXIST') error('LEGACY_CAPTURE_CONFLICT');
      throw caught;
    }
  }
  const final = await compareExistingTree(captureRoot, files, fs);
  if (!final.complete) error('LEGACY_CAPTURE_CONFLICT');
  effects.onReportWrite?.();
  return deepFreezeJson({
    captureRoot: `captures/${date}`,
    reportPath: `captures/${date}/audit-report.md`,
    retried: false,
  });
}

export function legacyModeResult({
  mode,
  status,
  locationId,
  captureDate,
  captureRoot,
  reportPath,
  manifestChanged,
  checks = [],
  unresolved = [],
} = {}) {
  const result = {
    mode,
    status,
    locationId,
    captureDate,
    captureRoot,
    reportPath,
    manifestChanged,
    checks: cloneSafe(checks, 'LEGACY_TARGET_INVALID'),
    unresolved: [...unresolved].sort(),
  };
  return deepFreezeJson(result);
}

export async function readLegacyManifest({
  clientFolder,
  fsOps,
  effects = {},
} = {}) {
  const fs = normalizedFs(fsOps);
  const clientRoot = await assertClientFolder(clientFolder, fs);
  const manifestPath = join(clientRoot, 'client-manifest.json');
  effects.onManifestRead?.();
  const info = await lstatOrNull(manifestPath, fs);
  if (!info || !info.isFile() || info.isSymbolicLink()) error('LEGACY_MANIFEST_INVALID');
  let bytes;
  let manifest;
  try {
    bytes = await fs.readFile(manifestPath, 'utf8');
    manifest = JSON.parse(bytes);
  } catch {
    error('LEGACY_MANIFEST_INVALID');
  }
  if (!plainObject(manifest)) error('LEGACY_MANIFEST_INVALID');
  return {
    clientRoot,
    manifestPath,
    bytes,
    hash: sha256(bytes),
    identity: { dev: info.dev, ino: info.ino },
    manifest: cloneSafe(manifest, 'LEGACY_MANIFEST_INVALID'),
    fs,
  };
}

function secretShaped(value) {
  return typeof value === 'string' && (
    /^Bearer\s+/iu.test(value)
    || /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\./u.test(value)
    || /^EAA[A-Za-z0-9]{20,}$/u.test(value)
    || /(?:cookie|session)=/iu.test(value)
    || /^(?:sk|pit|api)[_-](?:live|test)?[_-]?[A-Za-z0-9]{8,}$/iu.test(value)
  );
}

function getPath(object, dotted) {
  return dotted.split('.').reduce((current, part) => current?.[part], object);
}

function setPath(object, dotted, value) {
  const parts = dotted.split('.');
  let current = object;
  for (const part of parts.slice(0, -1)) {
    if (!plainObject(current[part])) current[part] = {};
    current = current[part];
  }
  current[parts.at(-1)] = value;
}

function sameLocationItems(items, locationId) {
  return items.filter((item) => item?.locationId === locationId);
}

function uniqueExact(items, predicate) {
  const matches = items.filter(predicate);
  return matches.length === 1 ? matches[0] : null;
}

function resolveHarvestPath({ path, binding, sweep, manifest, locationId }) {
  if (!plainObject(binding) || typeof binding.kind !== 'string') return { resolved: false };
  if (path === 'ghl_location_id' && binding.kind === 'location') {
    return { resolved: true, value: locationId };
  }
  if (path === 'pipeline_id' && binding.kind === 'pipeline' && typeof binding.name === 'string') {
    const match = uniqueExact(
      sameLocationItems(sweep.areas.pipelines, locationId),
      (item) => item.name === binding.name && typeof item.id === 'string' && item.id.length > 0,
    );
    return match ? { resolved: true, value: match.id } : { resolved: false, clear: true };
  }
  if (path === 'stage_map' && binding.kind === 'stages') {
    const pipeline = uniqueExact(
      sameLocationItems(sweep.areas.pipelines, locationId),
      (item) => item.name === binding.pipelineName && typeof item.id === 'string',
    );
    if (!pipeline || !Array.isArray(pipeline.stages)) return { resolved: false };
    const output = {};
    for (const [stageName, canonicalStep] of Object.entries(manifest.stage_map ?? {})) {
      const match = uniqueExact(
        sameLocationItems(pipeline.stages, locationId),
        (stage) => stage.name === stageName && typeof stage.id === 'string' && stage.id.length > 0,
      );
      if (!match) return { resolved: false };
      output[match.id] = canonicalStep;
    }
    return { resolved: Object.keys(output).length > 0, value: output };
  }
  if (path === 'booking.calendar_ids' && binding.kind === 'calendars' && Array.isArray(binding.names)) {
    const ids = [];
    for (const name of binding.names) {
      const match = uniqueExact(
        sameLocationItems(sweep.areas.calendars, locationId),
        (item) => item.name === name && typeof item.id === 'string' && item.id.length > 0,
      );
      if (!match) return { resolved: false };
      ids.push(match.id);
    }
    return { resolved: ids.length > 0, value: ids.sort() };
  }
  if (path.startsWith('ai_agents.') && binding.kind === 'ai-agent' && typeof binding.name === 'string') {
    const match = uniqueExact(
      sameLocationItems(sweep.areas['ai-agents'], locationId),
      (item) => item.name === binding.name && typeof item.id === 'string' && item.id.length > 0,
    );
    return match ? { resolved: true, value: match.id } : { resolved: false, clear: true };
  }
  if (path === 'phone.tracked_number' && binding.kind === 'phone') {
    const match = uniqueExact(
      sameLocationItems(sweep.areas['phone-numbers'], locationId),
      (item) => item.number === binding.value && typeof item.number === 'string' && item.number.length > 0,
    );
    return match ? { resolved: true, value: match.number } : { resolved: false, clear: true };
  }
  if (
    path === 'secrets_pointers.pit_vault_secret_name'
    && binding.kind === 'secret-pointer'
    && typeof binding.value === 'string'
    && binding.value.length > 0
    && !secretShaped(binding.value)
  ) {
    return { resolved: true, value: binding.value };
  }
  return { resolved: false };
}

export function resolveHarvestManifest({
  manifest,
  sweep,
  locationId,
  harvestBindings,
} = {}) {
  if (
    !plainObject(manifest)
    || !plainObject(manifest.field_lifecycle)
    || !plainObject(harvestBindings)
  ) error('LEGACY_HARVEST_SOURCE_INVALID');
  const updated = cloneSafe(manifest, 'LEGACY_MANIFEST_INVALID');
  const unresolved = [];
  for (const [path, lifecycle] of Object.entries(manifest.field_lifecycle).sort()) {
    if (lifecycle !== 'harvest') continue;
    const resolution = resolveHarvestPath({
      path,
      binding: harvestBindings[path],
      sweep,
      manifest,
      locationId,
    });
    if (!resolution.resolved) {
      unresolved.push(path);
      if (resolution.clear || path !== 'stage_map') {
        setPath(updated, path, path === 'booking.calendar_ids' ? [] : null);
      }
      continue;
    }
    setPath(updated, path, resolution.value);
  }
  const harvestPaths = Object.entries(manifest.field_lifecycle)
    .filter(([, lifecycle]) => lifecycle === 'harvest')
    .map(([path]) => path);
  const complete = harvestPaths.length > 0
    && unresolved.length === 0
    && harvestPaths.every((path) => {
      const value = getPath(updated, path);
      if (path === 'stage_map') {
        return plainObject(value)
          && Object.keys(value).length > 0
          && Object.keys(value).every((key) => !Object.hasOwn(manifest.stage_map ?? {}, key));
      }
      return value !== null
        && value !== undefined
        && value !== ''
        && (!Array.isArray(value) || value.length > 0);
    });
  updated.ids_harvested = complete;
  return deepFreezeJson({
    manifest: updated,
    unresolved,
    complete,
  });
}

export async function atomicWriteLegacyManifest({
  manifestPath,
  originalHash,
  originalIdentity,
  manifest,
  fsOps,
  atomicHooks = {},
  effects = {},
} = {}) {
  const fs = normalizedFs(fsOps);
  const bytes = rawJson(manifest);
  const tempPath = join(dirname(manifestPath), `.${basename(manifestPath)}.legacy-${process.pid}.tmp`);
  let handle;
  try {
    handle = await fs.open(tempPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    await handle.writeFile(bytes, 'utf8');
    await atomicHooks.beforeFsync?.();
    await handle.sync();
    await handle.close();
    handle = null;
    await atomicHooks.beforeConflictCheck?.();
    const currentInfo = await fs.lstat(manifestPath);
    if (
      !currentInfo.isFile()
      || currentInfo.isSymbolicLink()
      || currentInfo.dev !== originalIdentity?.dev
      || currentInfo.ino !== originalIdentity?.ino
    ) error('LEGACY_MANIFEST_CONFLICT');
    const current = await fs.readFile(manifestPath, 'utf8');
    if (sha256(current) !== originalHash) error('LEGACY_MANIFEST_CONFLICT');
    await atomicHooks.beforeRename?.();
    effects.onManifestWrite?.();
    await fs.rename(tempPath, manifestPath);
    const directory = await fs.open(dirname(manifestPath), constants.O_RDONLY);
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    if (handle) await handle.close().catch(() => {});
    await fs.rm(tempPath, { force: true }).catch(() => {});
  }
  return bytes;
}
