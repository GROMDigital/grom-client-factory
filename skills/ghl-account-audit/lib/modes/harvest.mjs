import {
  atomicWriteLegacyManifest,
  buildLegacyCaptureFiles,
  captureReport,
  collectLegacySweep,
  legacyModeResult,
  readLegacyManifest,
  resolveCaptureDate,
  resolveHarvestManifest,
  sanitizeLegacyMarkdownText,
  writeLegacyCaptureTree,
} from '../adapters/legacy-capture.mjs';
import { canonicalJson } from '../canonical.mjs';
import { codedError } from '../adapters/collection.mjs';

function safeGoLiveCheck(outcome) {
  const pass = outcome?.pass === true;
  return {
    name: 'go-live',
    status: pass ? 'PASS' : 'FAIL',
    evidenceRefs: ['manifest.golive'],
  };
}

export async function runHarvestMode(args = {}) {
  if (args.scheduled === true) throw codedError('LEGACY_HARVEST_SCHEDULED');
  if (typeof args.goLiveChecker !== 'function') {
    throw codedError('LEGACY_VERIFY_INPUT_MISSING', TypeError);
  }
  if (
    !args.harvestBindings
    || typeof args.harvestBindings !== 'object'
    || Array.isArray(args.harvestBindings)
  ) throw codedError('LEGACY_HARVEST_SOURCE_INVALID', TypeError);
  const captureDate = resolveCaptureDate(args);
  const manifestRecord = await readLegacyManifest({
    clientFolder: args.clientFolder,
    fsOps: args.fsOps,
    effects: args.effects,
  });
  if (
    manifestRecord.manifest.ghl_location_id !== null
    && manifestRecord.manifest.ghl_location_id !== undefined
    && manifestRecord.manifest.ghl_location_id !== args.locationId
  ) throw codedError('LEGACY_LOCATION_MISMATCH');
  const sweep = await collectLegacySweep(args);
  const resolution = resolveHarvestManifest({
    manifest: manifestRecord.manifest,
    sweep,
    locationId: sweep.locationId,
    harvestBindings: args.harvestBindings,
  });
  const changed = canonicalJson(resolution.manifest) !== canonicalJson(manifestRecord.manifest);
  if (changed) {
    await atomicWriteLegacyManifest({
      manifestPath: manifestRecord.manifestPath,
      originalHash: manifestRecord.hash,
      originalIdentity: manifestRecord.identity,
      manifest: resolution.manifest,
      fsOps: args.fsOps,
      atomicHooks: args.atomicHooks,
      effects: args.effects,
    });
  }
  let goLive;
  try {
    goLive = await args.goLiveChecker({
      clientFolder: manifestRecord.clientRoot,
      manifestPath: manifestRecord.manifestPath,
    });
  } catch {
    goLive = { pass: false, output: 'GOLIVE_CHECK_FAILED' };
  }
  const checks = [safeGoLiveCheck(goLive)];
  const report = [
    captureReport({
      sweep,
      mode: 'harvest',
      checks,
      unresolved: resolution.unresolved,
    }).trimEnd(),
    '',
    '## Go-live checker',
    '',
    '```text',
    typeof goLive.output === 'string'
      ? sanitizeLegacyMarkdownText(goLive.output)
      : goLive.pass === true
        ? 'golive_check: READY'
        : 'GOLIVE_CHECK_FAILED',
    '```',
    '',
  ].join('\n');
  const files = buildLegacyCaptureFiles({
    sweep,
    captureDate,
    mode: 'harvest',
    checks,
    unresolved: resolution.unresolved,
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
    mode: 'harvest',
    status: resolution.complete ? 'PASS' : 'FAIL',
    locationId: sweep.locationId,
    captureDate,
    captureRoot: paths.captureRoot,
    reportPath: paths.reportPath,
    manifestChanged: changed,
    checks,
    unresolved: resolution.unresolved,
  });
}
