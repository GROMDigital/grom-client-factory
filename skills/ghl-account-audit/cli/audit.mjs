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

export async function runAuditCli({
  argv = process.argv.slice(2),
  kernel,
  stdout = process.stdout,
  vaultReferenceResolver,
} = {}) {
  const { command, flags } = parseAuditCliArgs(argv);
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
    if (!kernel) throw codedError('AUDIT_PREFLIGHT_FAILED_HOST_BINDINGS');
    if (command === 'run') {
      const providerConfig = readRegularJson(
        resolve(flags['provider-config']),
        'AUDIT_PREFLIGHT_FAILED_PROVIDER_CONFIG',
      );
      result = await kernel.start({
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
      result = await kernel.resume({
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
  try {
    await runAuditCli();
  } catch (error) {
    process.stderr.write(`${error?.code ?? 'AUDIT_COMMAND_INVALID'}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
