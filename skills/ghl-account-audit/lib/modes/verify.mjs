import {
  buildLegacyCaptureFiles,
  captureReport,
  collectLegacySweep,
  legacyModeResult,
  readLegacyManifest,
  resolveCaptureDate,
  writeLegacyCaptureTree,
} from '../adapters/legacy-capture.mjs';
import { codedError } from '../adapters/collection.mjs';

function safeEvidenceRefs(value, fallback) {
  if (!Array.isArray(value)) return [fallback];
  const safe = value.filter((entry) =>
    typeof entry === 'string'
    && entry.length > 0
    && !entry.startsWith('/')
    && !entry.includes('..')
    && !/bearer|cookie|token|authorization/iu.test(entry));
  return safe.length ? safe : [fallback];
}

function check(name, outcome, fallback) {
  return {
    name,
    status: outcome?.pass === true ? 'PASS' : 'FAIL',
    evidenceRefs: safeEvidenceRefs(outcome?.evidenceRefs, fallback),
  };
}

function defaultWorkflowConformance({ registry, sweep }) {
  const workflows = Array.isArray(registry?.workflows) ? registry.workflows : [];
  if (workflows.length === 0) {
    return { pass: true, evidenceRefs: ['registry.workflows'] };
  }
  let pass = true;
  const evidenceRefs = [];
  for (const expected of workflows) {
    const live = sweep.areas.workflows.filter((item) =>
      item.id === expected.id || (expected.name && item.name === expected.name));
    const workflowId = live.length === 1 ? live[0].id : expected.id;
    const full = sweep.browser.workflows[workflowId]?.files;
    const valid = sweep.workflowValidity[workflowId]?.valid === true;
    const triggerItems = full?.['trigger.json']?.triggers
      ?? full?.['trigger.json']?.items
      ?? full?.['trigger.json']?.data;
    const triggerMatches = !expected.triggerType
      || (Array.isArray(triggerItems)
        && triggerItems.some((item) => item?.type === expected.triggerType));
    const templates = full?.['workflow.json']?.workflowData?.templates;
    const notificationsMatch = !Array.isArray(expected.requiredNotificationTypes)
      || expected.requiredNotificationTypes.every((type) =>
        Array.isArray(templates) && templates.some((step) =>
          step?.type === type || step?.attributes?.notificationType === type));
    if (
      live.length !== 1
      || live[0].status !== (expected.status ?? 'PUBLISHED')
      || !valid
      || !triggerMatches
      || !notificationsMatch
    ) pass = false;
    evidenceRefs.push(expected.section ?? `registry.workflows.${workflowId ?? 'missing'}`);
  }
  return { pass, evidenceRefs };
}

function defaultStageConformance({ registry, manifest, sweep }) {
  const expected = Array.isArray(registry?.stages) ? registry.stages : [];
  if (expected.length === 0) return { pass: true, evidenceRefs: ['registry.stage_map'] };
  const liveStages = sweep.areas.pipelines.flatMap((pipeline) => pipeline.stages ?? []);
  const pass = expected.every((stage) => {
    const matches = liveStages.filter((live) =>
      live.locationId === sweep.locationId
      && live.id === stage.id
      && (!stage.name || live.name === stage.name));
    return matches.length === 1
      && Object.hasOwn(manifest.stage_map ?? {}, stage.id)
      && (stage.canonicalStep === undefined
        || manifest.stage_map[stage.id] === stage.canonicalStep);
  });
  return {
    pass,
    evidenceRefs: expected.map((stage) => stage.section ?? `registry.stage_map.${stage.id}`),
  };
}

function defaultNamedObjectConformance({ registry, sweep }) {
  const groups = [
    ['calendars', registry?.calendars],
    ['payment-products', registry?.paymentProducts],
    ['ai-agents', registry?.aiAgents],
  ];
  let pass = true;
  const evidenceRefs = [];
  for (const [area, declarations] of groups) {
    for (const declaration of declarations ?? []) {
      const items = area === 'payment-products'
        ? (sweep.areas['payment-products'] ?? [])
        : sweep.areas[area];
      const name = typeof declaration === 'string' ? declaration : declaration.name;
      const section = typeof declaration === 'string'
        ? `registry.${area}.${name}`
        : declaration.section ?? `registry.${area}.${name}`;
      if (items.filter((item) => item.locationId === sweep.locationId && item.name === name).length !== 1) {
        pass = false;
      }
      evidenceRefs.push(section);
    }
  }
  return { pass, evidenceRefs: evidenceRefs.length ? evidenceRefs : ['registry.named_objects'] };
}

async function runRequiredCheck(fn, input) {
  if (typeof fn !== 'function') throw codedError('LEGACY_VERIFY_INPUT_MISSING', TypeError);
  try {
    return await fn(input);
  } catch (caught) {
    if (caught?.code) throw caught;
    return { pass: false, evidenceRefs: input.fallbackEvidenceRefs };
  }
}

export async function runVerifyMode(args = {}) {
  const captureDate = resolveCaptureDate(args);
  const manifestRecord = await readLegacyManifest({
    clientFolder: args.clientFolder,
    fsOps: args.fsOps,
  });
  if (
    manifestRecord.manifest.ghl_location_id !== null
    && manifestRecord.manifest.ghl_location_id !== undefined
    && manifestRecord.manifest.ghl_location_id !== args.locationId
  ) throw codedError('LEGACY_LOCATION_MISMATCH');
  const sweep = await collectLegacySweep(args);
  const input = {
    clientFolder: manifestRecord.clientRoot,
    manifestPath: manifestRecord.manifestPath,
    manifest: manifestRecord.manifest,
    registry: args.registry ?? {},
    sweep,
  };
  const checks = [];
  checks.push(check(
    'baseline',
    await runRequiredCheck(args.baselineValidator, {
      ...input,
      fallbackEvidenceRefs: ['baseline.validate'],
    }),
    'baseline.validate',
  ));
  checks.push(check(
    'workflows',
    await (args.workflowConformance ?? defaultWorkflowConformance)(input),
    'registry.workflows',
  ));
  checks.push(check(
    'stages',
    await (args.stageConformance ?? defaultStageConformance)(input),
    'registry.stage_map',
  ));
  checks.push(check(
    'named-objects',
    await (args.namedObjectConformance ?? defaultNamedObjectConformance)(input),
    'registry.named_objects',
  ));
  checks.push(check(
    'go-live',
    await runRequiredCheck(args.goLiveChecker, {
      ...input,
      fallbackEvidenceRefs: ['manifest.golive'],
    }),
    'manifest.golive',
  ));
  const failed = checks.filter(({ status }) => status === 'FAIL');
  const unresolved = failed.map(({ name }) => name);
  const report = captureReport({
    sweep,
    mode: 'verify',
    checks,
    unresolved,
  });
  const files = buildLegacyCaptureFiles({
    sweep,
    captureDate,
    mode: 'verify',
    checks,
    unresolved,
    report,
  });
  const paths = await writeLegacyCaptureTree({
    clientFolder: args.clientFolder,
    captureDate,
    files,
    fsOps: args.fsOps,
    effects: args.effects,
  });
  return legacyModeResult({
    mode: 'verify',
    status: failed.length ? 'FAIL' : 'PASS',
    locationId: sweep.locationId,
    captureDate,
    captureRoot: paths.captureRoot,
    reportPath: paths.reportPath,
    manifestChanged: false,
    checks,
    unresolved,
  });
}
