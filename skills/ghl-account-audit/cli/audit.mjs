#!/usr/bin/env node
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
} from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJson, sha256 } from '../lib/canonical.mjs';
import { replayWeeklyFixture } from '../lib/modes/weekly.mjs';

const COMMAND_FLAGS = Object.freeze({
  replay: new Set(['fixture', 'output']),
  run: new Set([
    'mode', 'project', 'location', 'profile', 'provider-config', 'vault-key-ref',
  ]),
  'review-request': new Set(['project', 'location', 'run-id']),
  'ingest-review': new Set(['project', 'location', 'run-id', 'response']),
  resume: new Set(['project', 'location', 'run-id', 'vault-key-ref']),
});
const REQUIRED_FLAGS = Object.freeze({
  replay: ['fixture', 'output'],
  run: ['mode', 'project', 'location', 'profile', 'provider-config', 'vault-key-ref'],
  'review-request': ['project', 'location', 'run-id'],
  'ingest-review': ['project', 'location', 'run-id', 'response'],
  resume: ['project', 'location', 'run-id'],
});
const LOCATION = /^[A-Za-z0-9][-A-Za-z0-9_.:]{0,127}$/u;

function codedError(code, ErrorType = Error) {
  return Object.assign(new ErrorType(code), { code });
}

export function parseAuditCliArgs(argv) {
  if (!Array.isArray(argv) || argv.length < 1) {
    throw codedError('AUDIT_COMMAND_INVALID_MISSING');
  }
  const [command, ...tokens] = argv;
  const allowed = COMMAND_FLAGS[command];
  if (!allowed) throw codedError('AUDIT_COMMAND_INVALID_UNKNOWN');
  if (tokens.length % 2 !== 0) throw codedError('AUDIT_COMMAND_INVALID_VALUE');
  const flags = {};
  for (let index = 0; index < tokens.length; index += 2) {
    const token = tokens[index];
    const value = tokens[index + 1];
    if (
      typeof token !== 'string'
      || !token.startsWith('--')
      || token.length < 3
      || !allowed.has(token.slice(2))
      || typeof value !== 'string'
      || value.length === 0
      || value.startsWith('--')
    ) throw codedError('AUDIT_COMMAND_INVALID_FLAG');
    const name = token.slice(2);
    if (Object.hasOwn(flags, name)) throw codedError('AUDIT_COMMAND_INVALID_DUPLICATE');
    flags[name] = value;
  }
  for (const required of REQUIRED_FLAGS[command]) {
    if (!Object.hasOwn(flags, required)) throw codedError('AUDIT_COMMAND_INVALID_MISSING');
  }
  if (flags.location !== undefined && !LOCATION.test(flags.location)) {
    throw codedError('AUDIT_COMMAND_INVALID_LOCATION');
  }
  if (flags['run-id'] !== undefined && !LOCATION.test(flags['run-id'])) {
    throw codedError('AUDIT_COMMAND_INVALID_RUN');
  }
  if (command === 'run' && flags.mode !== 'weekly') {
    throw codedError('AUDIT_MODE_UNSUPPORTED');
  }
  return Object.freeze({ command, flags: Object.freeze(flags) });
}

function readRegularJson(pathname, code) {
  let descriptor;
  try {
    descriptor = openSync(pathname, constants.O_RDONLY | constants.O_NOFOLLOW);
    const metadata = fstatSync(descriptor);
    if (!metadata.isFile()) throw new Error();
    const value = JSON.parse(readFileSync(descriptor, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    throw codedError(code);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function safeStatus(value) {
  const safe = {};
  for (const key of [
    'status', 'runId', 'oldRunId', 'newRunId', 'publicationId', 'publicationPath',
  ]) {
    if (value?.[key] !== undefined) safe[key] = value[key];
  }
  if (Array.isArray(value?.requestPaths)) safe.requestPaths = [...value.requestPaths];
  return safe;
}

/**
 * The adapter kind that binds the run to a REAL sub-account through the public MCP adapter.
 * `local_fixture` replays a configuration; this one collects.
 */
const PUBLIC_ADAPTER_KIND = 'ghl_public';

/**
 * Which composition root a RESUME needs. A resume names only a project, a location and a run id,
 * so the adapter kind has to come from the run's own durable invocation. Resolved read-only, and
 * ANY failure falls back to the pre-existing local kernel so a fixture resume is unchanged.
 */
async function resumeAdapterKind({ projectRoot, locationId, runId }) {
  try {
    const { openState } = await import('../lib/state.mjs');
    const state = openState({ projectRoot, locationId });
    let descriptor;
    try {
      descriptor = state.getRunInvocation(runId).providerDescriptor;
    } finally {
      state.close();
    }
    if (descriptor?.kind === 'inline_safe') return descriptor.config?.adapterKind;
    if (descriptor?.kind !== 'project_file') return undefined;
    const pathname = resolve(projectRoot, descriptor.relativePath);
    return readRegularJson(pathname, 'AUDIT_PREFLIGHT_FAILED_PROVIDER_CONFIG').adapterKind;
  } catch {
    return undefined;
  }
}

export async function runAuditCli({
  argv = process.argv.slice(2),
  kernel,
  stdout = process.stdout,
  vaultReferenceResolver,
  // Host-owned bindings for the public rail: an already-authenticated `transportConnect`, a
  // secret-store `credentialResolver`, an OS-keychain `keyProvider`, an abort `signal`. Empty by
  // default, in which case the transport is the MCP SDK's own. Never a credential VALUE.
  publicRuntime = {},
} = {}) {
  const { command, flags } = parseAuditCliArgs(argv);
  let runtimeKernel = kernel;
  let result;
  if (command === 'replay') {
    result = replayWeeklyFixture({
      fixtureRoot: resolve(flags.fixture),
      outputRoot: resolve(flags.output),
    });
  } else if (command === 'review-request') {
    const { openState } = await import('../lib/state.mjs');
    const state = openState({
      projectRoot: resolve(flags.project),
      locationId: flags.location,
    });
    try {
      state.getRun(flags['run-id']);
      const requests = state.listReviewRequests(flags['run-id'])
        .filter(({ status }) => status === 'pending');
      result = {
        status: requests.length === 0 ? 'not_required' : 'awaiting_model_review',
        runId: flags['run-id'],
        requestPaths: requests.map(({ sealedRelativePath }) => sealedRelativePath).sort(),
      };
    } finally {
      state.close();
    }
  } else if (command === 'ingest-review') {
    const [
      { openState },
      { validateConversationReview },
      { validateMechanismReview },
    ] = await Promise.all([
      import('../lib/state.mjs'),
      import('../lib/review-bridge.mjs'),
      import('../lib/mechanisms.mjs'),
    ]);
    const response = readRegularJson(resolve(flags.response), 'REVIEW_RESPONSE_MISMATCH_FILE');
    const state = openState({
      projectRoot: resolve(flags.project),
      locationId: flags.location,
    });
    try {
      state.getRun(flags['run-id']);
      const pending = state.listReviewRequests(flags['run-id'])
        .filter(({ status }) => status === 'pending');
      const requestId = response.requestId;
      const request = pending.find((candidate) => candidate.requestId === requestId);
      if (!request) throw codedError('REVIEW_RESPONSE_MISMATCH_REQUEST');
      const validate = request.kind === 'conversation'
        ? validateConversationReview
        : validateMechanismReview;
      state.validateAndConsumeReviewRequest({
        requestId,
        response,
        consumedAt: Date.now(),
        validate,
        checkpoint: {
          runId: flags['run-id'],
          phase: `review-result-${request.kind}`,
          inputHash: request.requestHash,
          outputHash: sha256(response),
          payload: {
            schemaVersion: '1.0.0',
            requestId,
            responseHash: sha256(response),
          },
        },
      });
      result = { status: 'review_consumed', runId: flags['run-id'] };
    } finally {
      state.close();
    }
  } else {
    if (command === 'run') {
      const providerConfig = readRegularJson(
        resolve(flags['provider-config']),
        'AUDIT_PREFLIGHT_FAILED_PROVIDER_CONFIG',
      );
      let providerDescriptor;
      if (!runtimeKernel && providerConfig.adapterKind === 'local_fixture') {
        const local = await import('../lib/local-runtime.mjs');
        runtimeKernel = local.createLocalAuditKernel({
          initialRunId: providerConfig.runId,
        });
        providerDescriptor = local.localProviderDescriptor({
          projectRoot: resolve(flags.project),
          providerConfigPath: resolve(flags['provider-config']),
          config: providerConfig,
        });
      } else if (!runtimeKernel && providerConfig.adapterKind === PUBLIC_ADAPTER_KIND) {
        // The gap this branch closes: `createPublicGhlAdapter` and `connectMcp` shipped built and
        // tested but bound to nothing, so every non-fixture configuration fell through to
        // AUDIT_PREFLIGHT_FAILED_HOST_BINDINGS below and the CLI could not audit an account.
        const local = await import('../lib/local-runtime.mjs');
        runtimeKernel = local.createPublicAuditKernel({
          initialRunId: providerConfig.runId,
          ...publicRuntime,
        });
        providerDescriptor = local.publicProviderDescriptor({
          projectRoot: resolve(flags.project),
          providerConfigPath: resolve(flags['provider-config']),
          config: providerConfig,
        });
      }
      if (!runtimeKernel) throw codedError('AUDIT_PREFLIGHT_FAILED_HOST_BINDINGS');
      result = await runtimeKernel.start({
        mode: flags.mode,
        target: {
          targetKind: 'location',
          operatingProfile: flags.profile,
          locationId: flags.location,
        },
        projectRoot: resolve(flags.project),
        cutoff: providerConfig.cutoff,
        providerId: providerConfig.providerId,
        profile: flags.profile,
        providerConfig,
        ...(providerDescriptor ? { providerDescriptor } : {}),
        vaultKeyReference: flags['vault-key-ref'],
      });
    } else {
      const vaultKeyReference = flags['vault-key-ref']
        ?? await vaultReferenceResolver?.({
          projectRoot: resolve(flags.project),
          locationId: flags.location,
          runId: flags['run-id'],
        });
      if (typeof vaultKeyReference !== 'string' || vaultKeyReference.length === 0) {
        throw codedError('AUDIT_PREFLIGHT_FAILED_VAULT_REFERENCE');
      }
      if (!runtimeKernel) {
        const local = await import('../lib/local-runtime.mjs');
        const adapterKind = await resumeAdapterKind({
          projectRoot: resolve(flags.project),
          locationId: flags.location,
          runId: flags['run-id'],
        });
        runtimeKernel = adapterKind === PUBLIC_ADAPTER_KIND
          // The run id is passed so the public root adopts the inventory this run was already
          // sealed with instead of re-reading the live account (see `adoptSealedInventory`).
          ? local.createPublicAuditKernel({ ...publicRuntime, resumeRunId: flags['run-id'] })
          : local.createLocalAuditKernel();
      }
      result = await runtimeKernel.resume({
        projectRoot: resolve(flags.project),
        locationId: flags.location,
        runId: flags['run-id'],
        vaultKeyReference,
      });
    }
  }
  const status = safeStatus(result);
  stdout.write(`${canonicalJson(status)}\n`);
  return status;
}

async function main() {
  const emitWarning = process.emitWarning;
  process.emitWarning = (warning, ...args) => {
    if (/SQLite is an experimental feature/u.test(String(warning?.message ?? warning))) return;
    emitWarning.call(process, warning, ...args);
  };
  try {
    await runAuditCli();
  } catch (error) {
    process.stderr.write(`${error?.code ?? 'AUDIT_COMMAND_INVALID'}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
