import {
  buildLegacyCaptureFiles,
  collectLegacySweep,
  legacyModeResult,
  resolveCaptureDate,
  writeLegacyCaptureTree,
} from '../adapters/legacy-capture.mjs';

export async function runCaptureMode(args = {}) {
  const captureDate = resolveCaptureDate(args);
  const sweep = await collectLegacySweep(args);
  const invalidWorkflows = Object.entries(sweep.workflowValidity)
    .filter(([, validity]) => validity.valid !== true)
    .map(([workflowId]) => `workflows.${workflowId}`);
  const checks = [{
    name: 'workflow-capture',
    status: invalidWorkflows.length ? 'FAIL' : 'PASS',
    evidenceRefs: Object.values(sweep.workflowValidity)
      .flatMap(({ evidenceRefs }) => evidenceRefs)
      .sort(),
  }];
  const files = buildLegacyCaptureFiles({
    sweep,
    captureDate,
    mode: 'capture',
    checks,
    unresolved: invalidWorkflows,
  });
  const paths = await writeLegacyCaptureTree({
    clientFolder: args.clientFolder,
    captureDate,
    files,
    fsOps: args.fsOps,
    effects: args.effects,
  });
  return legacyModeResult({
    mode: 'capture',
    status: invalidWorkflows.length ? 'FAIL' : 'PASS',
    locationId: sweep.locationId,
    captureDate,
    captureRoot: paths.captureRoot,
    reportPath: paths.reportPath,
    manifestChanged: false,
    checks,
    unresolved: invalidWorkflows,
  });
}
