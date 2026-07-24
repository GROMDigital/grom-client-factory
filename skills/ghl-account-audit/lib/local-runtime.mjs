import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import { canonicalJson, sha256 } from './canonical.mjs';
import { createAuditKernel } from './kernel.mjs';
import { openState } from './state.mjs';

const LOCAL_SCHEMA = '1.0.0';
const INTERNAL_LIMITATIONS = Object.freeze([
  'INTERNAL_WORKFLOW_DEFINITION_MISSING',
  'INTERNAL_WORKFLOW_RUNTIME_MISSING',
]);

function codedError(code, ErrorType = Error) {
  return Object.assign(new ErrorType(code), { code });
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isWithin(parent, candidate) {
  const fromParent = relative(parent, candidate);
  return fromParent === ''
    || (!isAbsolute(fromParent) && fromParent !== '..' && !fromParent.startsWith(`..${sep}`));
}

function readRegularJson(pathname, code) {
  let descriptor;
  try {
    descriptor = openSync(pathname, constants.O_RDONLY | constants.O_NOFOLLOW);
    const metadata = fstatSync(descriptor);
    if (!metadata.isFile()) throw new Error();
    const parsed = JSON.parse(readFileSync(descriptor, 'utf8'));
    if (!isPlainObject(parsed)) throw new Error();
    return parsed;
  } catch {
    throw codedError(code);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function validateLocalConfig(config) {
  if (
    !isPlainObject(config)
    || config.schemaVersion !== LOCAL_SCHEMA
    || config.adapterKind !== 'local_fixture'
    || typeof config.providerId !== 'string'
    || config.providerId.length === 0
    || !Number.isSafeInteger(config.cutoff)
    || typeof config.timezone !== 'string'
    || config.timezone.length === 0
    || !isPlainObject(config.frozenInputs)
    || !isPlainObject(config.context)
    || !isPlainObject(config.publicEvidence)
    || !Array.isArray(config.reviews)
  ) throw codedError('AUDIT_PREFLIGHT_FAILED_PROVIDER_CONFIG');
  return config;
}

function loadProjectConfig({ descriptor, projectRoot }) {
  if (
    !isPlainObject(descriptor)
    || descriptor.kind !== 'project_file'
    || typeof descriptor.relativePath !== 'string'
    || descriptor.relativePath.length === 0
    || typeof descriptor.configHash !== 'string'
  ) throw codedError('AUDIT_PREFLIGHT_FAILED_PROVIDER_CONFIG');
  const project = resolve(projectRoot);
  const pathname = resolve(project, descriptor.relativePath);
  if (!isWithin(project, pathname)) {
    throw codedError('AUDIT_PREFLIGHT_FAILED_PROVIDER_CONFIG');
  }
  const config = validateLocalConfig(readRegularJson(
    pathname,
    'AUDIT_PREFLIGHT_FAILED_PROVIDER_CONFIG',
  ));
  return config;
}

function writeImmutable(pathname, value) {
  const bytes = Buffer.from(
    typeof value === 'string' ? value : `${canonicalJson(value)}\n`,
    'utf8',
  );
  if (existsSync(pathname)) {
    const metadata = lstatSync(pathname);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw codedError('AUDIT_INTEGRITY_FAILURE_PUBLICATION_CONFLICT');
    }
    if (!readFileSync(pathname).equals(bytes)) {
      throw codedError('AUDIT_INTEGRITY_FAILURE_PUBLICATION_CONFLICT');
    }
    return;
  }
  mkdirSync(dirname(pathname), { recursive: true, mode: 0o700 });
  const temporary = `${pathname}.tmp`;
  try {
    writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    const metadata = existsSync(temporary) ? lstatSync(temporary) : undefined;
    if (
      !metadata
      || metadata.isSymbolicLink()
      || !metadata.isFile()
      || !readFileSync(temporary).equals(bytes)
    ) throw codedError('AUDIT_INTEGRITY_FAILURE_PUBLICATION_CONFLICT');
  }
  renameSync(temporary, pathname);
  chmodSync(pathname, 0o400);
}

function localPublisher({
  paths,
  runId,
  publicationId,
  compiled,
  verification,
  frozenInputs,
}) {
  const publicationRoot = join(paths.weekly, publicationId);
  if (existsSync(publicationRoot)) {
    const metadata = lstatSync(publicationRoot);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw codedError('AUDIT_INTEGRITY_FAILURE_PUBLICATION_CONFLICT');
    }
  } else {
    mkdirSync(publicationRoot, { mode: 0o700 });
  }
  const report = [
    '# Weekly GHL audit',
    '',
    'Status: complete_partial',
    '',
    'This offline fixture publication covers the public comparable subset only.',
    '',
  ].join('\n');
  const manifest = {
    schemaVersion: LOCAL_SCHEMA,
    runId,
    publicationId,
    status: 'complete_partial',
    frozenInputsHash: sha256(frozenInputs),
    compiledHash: sha256(compiled),
    verificationHash: sha256(verification),
  };
  writeImmutable(join(publicationRoot, 'REPORT.md'), report);
  writeImmutable(join(publicationRoot, 'coverage.json'), compiled.coverage);
  writeImmutable(join(publicationRoot, 'result.json'), compiled);
  writeImmutable(join(publicationRoot, 'manifest.json'), manifest);
  return {
    publicationId,
    manifestHash: sha256(manifest),
    publicationRoot: sha256({
      report: sha256(report),
      coverage: sha256(compiled.coverage),
      result: sha256(compiled),
      manifest: sha256(manifest),
    }),
  };
}

export function localProviderDescriptor({ projectRoot, providerConfigPath, config }) {
  const project = resolve(projectRoot);
  const pathname = resolve(providerConfigPath);
  if (!isWithin(project, pathname)) {
    throw codedError('AUDIT_PREFLIGHT_FAILED_PROVIDER_CONFIG');
  }
  validateLocalConfig(config);
  return Object.freeze({
    kind: 'project_file',
    configHash: sha256(config),
    relativePath: relative(project, pathname).split(sep).join('/'),
  });
}

export function createLocalAuditKernel({ initialRunId } = {}) {
  let nextRunId = initialRunId;
  return createAuditKernel({
    clock: () => Date.now(),
    idFactory: () => {
      const selected = nextRunId ?? `run_${randomUUID()}`;
      nextRunId = undefined;
      return selected;
    },
    keyResolver: (reference) => {
      if (reference !== 'test-only:key') {
        throw codedError('AUDIT_PREFLIGHT_FAILED_VAULT_REFERENCE');
      }
      return {
        encryptionKey: Buffer.alloc(32, 0x31),
        pseudonymKey: Buffer.alloc(32, 0x32),
      };
    },
    stateStore: { open: openState },
    providerConfigLoader: loadProjectConfig,
    adapters: {
      collectContext: async ({ providerConfig }) => {
        validateLocalConfig(providerConfig);
        return structuredClone(providerConfig.context);
      },
      collectPublic: async ({ providerConfig }) => {
        validateLocalConfig(providerConfig);
        return structuredClone(providerConfig.publicEvidence);
      },
    },
    analyzer: {
      freezeInputs: ({ providerConfig }) => (
        structuredClone(validateLocalConfig(providerConfig).frozenInputs)
      ),
      normalize: async ({ context, publicEvidence }) => ({
        contextHash: sha256(context),
        publicEvidenceHash: sha256(publicEvidence),
      }),
      discover: async () => ({ findings: [] }),
      falsify: async () => ({ packets: [] }),
      loadMemory: async () => ({ events: [] }),
      createReviewRequests: async ({ providerConfig }) => (
        structuredClone(validateLocalConfig(providerConfig).reviews)
      ),
      prioritize: async ({ discovery, falsification, reviews }) => ({
        discovery,
        falsification,
        reviewHashes: reviews.map((review) => sha256(review)).sort(),
      }),
      compile: async () => ({
        status: 'complete_partial',
        coverage: {
          state: 'complete_partial',
          scope: 'public_comparable_subset',
          limitations: [...INTERNAL_LIMITATIONS],
        },
        diff: { state: 'FIRST_BASELINE', transitions: [] },
        findings: [],
      }),
    },
    verifier: async ({ compiled }) => {
      const limitations = new Set(compiled?.coverage?.limitations ?? []);
      return {
        result: compiled?.status === 'complete_partial'
          && limitations.has(INTERNAL_LIMITATIONS[0])
          && limitations.has(INTERNAL_LIMITATIONS[1])
          ? 'pass'
          : 'fail',
      };
    },
    publisher: localPublisher,
  });
}
