import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import {
  createHash,
  createHmac,
  randomUUID,
} from 'node:crypto';
import {
  dirname,
  isAbsolute,
  join,
  normalize,
  relative,
  sep,
} from 'node:path';
import { canonicalJson, sha256 } from './canonical.mjs';
import { ensureAuditPaths, validateAuditPaths } from './paths.mjs';

const CREDENTIAL_KEY = /(?:authorization|cookie|api[_-]?key|secret|password|access[_-]?token|refresh[_-]?token|jwt|bearer)/iu;
const KEY_REFERENCE_KEY = /(?:key[_-]?ref(?:erence)?|vault[_-]?key|keyReference)/iu;
const PRIVATE_CONTENT_KEY = /(?:^|[_-])(?:transcript|body|message[_-]?body|raw[_-]?(?:message|content)|recording)(?:$|[_-])/iu;
const MESSAGE_CONTAINER_KEY = /^(?:messages?|conversationMessages)$/iu;
const PII_KEY = /(?:^|[_-])(?:e-?mail|phone|mobile|first[_-]?name|last[_-]?name|full[_-]?name|contact[_-]?name|display[_-]?name|name)(?:$|[_-])/iu;
const SAFE_PSEUDONYM = /^psn_[a-f0-9]{32}$/u;
const SAFE_REDACTION = /^<REDACTED:[a-z-]+>$/u;
const APPROVED_EVIDENCE_ID = /^(?:ev|obj|psn|actor)_[a-f0-9]{16,64}$/u;
const RAW_REFERENCE = /^raw_[a-f0-9]{16,64}$/u;
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu;
const PHONE = /(?:\+\d[\d\s().-]{7,}\d|\b\d{3}[\s().-]\d{3}[\s().-]\d{4}\b)/gu;
const BEARER = /Bearer\s+\S+/giu;
const JWT = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/gu;
const META_TOKEN = /EAA[A-Za-z0-9]{20,}/gu;
const MAGIC_LINK = /https?:\/\/[^\s"'<>]*[?&](?:token|code|signature|key|secret|auth)=[^\s"'<>]+/giu;
const ALLOWED_PROJECTIONS = new Set(['BACKLOG.md', 'backlog.json', 'current-system-flow.mmd']);
const ALLOWED_ROOT_ARTIFACTS = new Set([
  'REPORT.md',
  'coverage.json',
  'freshness.json',
  'diff.json',
  'metrics-and-findings.json',
  'conversation-sample.json',
  'evidence-manifest.jsonl',
]);
const PRIVATE_KINDS = new Set(['pii', 'credential', 'private-content', 'key-reference']);
const BOUNDARIES = new WeakMap();
const PRIVATE_REGISTRIES = new WeakMap();

function codedError(code, ErrorType = Error) {
  return Object.assign(new ErrorType(code), { code });
}

function pseudonym(value, key) {
  return `psn_${createHmac('sha256', key)
    .update(String(value).normalize('NFKC').trim().toLowerCase())
    .digest('hex')
    .slice(0, 32)}`;
}

function replacementFor(kind, value, key) {
  if (kind === 'pii') return pseudonym(value, key);
  if (kind === 'credential') return '<REDACTED:credential>';
  if (kind === 'key-reference') return '<REDACTED:key-reference>';
  return '<REDACTED:private-content>';
}

function collectSourceStrings(value, kind, stack = new WeakSet(), output = []) {
  if (typeof value === 'string') {
    if (value.length > 0) output.push({ kind, privateValue: value });
    return output;
  }
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return output;
  if (
    !value
    || typeof value !== 'object'
    || stack.has(value)
    || (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype)
  ) throw codedError('PRIVATE_SOURCE_BUNDLE_INVALID', TypeError);
  stack.add(value);
  try {
    if (Array.isArray(value)) {
      for (const entry of value) collectSourceStrings(entry, kind, stack, output);
    } else {
      for (const entry of Object.values(value)) collectSourceStrings(entry, kind, stack, output);
    }
    return output;
  } finally {
    stack.delete(value);
  }
}

export function ingestPrivateSourceBundle(bundle = {}) {
  if (
    !bundle
    || typeof bundle !== 'object'
    || Array.isArray(bundle)
    || Object.getPrototypeOf(bundle) !== Object.prototype
    || Object.keys(bundle).length !== 2
    || Object.keys(bundle).some((key) => !['runManifest', 'sources'].includes(key))
  ) throw codedError('PRIVATE_SOURCE_BUNDLE_INVALID', TypeError);
  const { runManifest, sources } = bundle;
  if (
    !runManifest
    || typeof runManifest !== 'object'
    || Array.isArray(runManifest)
    || Object.getPrototypeOf(runManifest) !== Object.prototype
    || !Array.isArray(sources)
  ) throw codedError('PRIVATE_SOURCE_BUNDLE_INVALID', TypeError);
  let manifestHash;
  let sourceBundleHash;
  try {
    manifestHash = sha256(runManifest);
    sourceBundleHash = sha256({ schemaVersion: '1.0.0', sources });
  } catch {
    throw codedError('PRIVATE_SOURCE_BUNDLE_INVALID', TypeError);
  }
  const entries = [];
  for (const source of sources) {
    if (
      !source
      || typeof source !== 'object'
      || Array.isArray(source)
      || Object.getPrototypeOf(source) !== Object.prototype
      || Object.keys(source).length !== 3
      || Object.keys(source).some((key) => !['kind', 'payload', 'sourceId'].includes(key))
      || typeof source.sourceId !== 'string'
      || !/^[a-z0-9][a-z0-9_.:-]{0,127}$/u.test(source.sourceId)
      || !PRIVATE_KINDS.has(source.kind)
    ) throw codedError('PRIVATE_SOURCE_BUNDLE_INVALID', TypeError);
    const before = entries.length;
    collectSourceStrings(source.payload, source.kind, new WeakSet(), entries);
    if (entries.length === before) throw codedError('PRIVATE_SOURCE_BUNDLE_INCOMPLETE', TypeError);
  }
  const registry = Object.freeze(Object.create(null));
  PRIVATE_REGISTRIES.set(registry, Object.freeze({
    entries: Object.freeze(entries.map((entry) => Object.freeze({ ...entry }))),
    manifestHash,
    sourceBundleHash,
    sourceRecordCount: sources.length,
    sourceValueCount: entries.length,
  }));
  return registry;
}

function sanitizeString(value, keyName, pseudonymKey, knownPrivateValues) {
  let output = value;
  for (const { privateValue, replacement } of knownPrivateValues) {
    output = output.split(privateValue).join(replacement);
  }
  const changed = output !== value;
  const containingSource = !changed && value.length >= 3
    ? knownPrivateValues.find(({ privateValue }) => privateValue.includes(value))
    : undefined;
  if (containingSource) return containingSource.replacement;
  if (
    SAFE_REDACTION.test(output)
    || SAFE_PSEUDONYM.test(output)
    || APPROVED_EVIDENCE_ID.test(output)
  ) {
    return output;
  }
  if (
    KEY_REFERENCE_KEY.test(keyName)
    || CREDENTIAL_KEY.test(keyName)
    || PRIVATE_CONTENT_KEY.test(keyName)
    || MESSAGE_CONTAINER_KEY.test(keyName)
    || PII_KEY.test(keyName)
  ) {
    if (changed) return output;
    throw codedError('PRIVATE_SOURCE_REGISTRY_INCOMPLETE');
  }
  for (const pattern of [BEARER, JWT, META_TOKEN, MAGIC_LINK, EMAIL, PHONE]) {
    pattern.lastIndex = 0;
    if (pattern.test(output)) throw codedError('PRIVATE_SOURCE_REGISTRY_INCOMPLETE');
  }
  return output;
}

function sanitizeNode(value, keyName, pseudonymKey, knownPrivateValues, stack) {
  if (typeof value === 'string') {
    return sanitizeString(value, keyName, pseudonymKey, knownPrivateValues);
  }
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (!value || typeof value !== 'object' || stack.has(value)) {
    throw codedError('PUBLICATION_VALUE_UNSUPPORTED', TypeError);
  }
  stack.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((entry) => sanitizeNode(
        entry,
        keyName,
        pseudonymKey,
        knownPrivateValues,
        stack,
      ));
    }
    if (Object.getPrototypeOf(value) !== Object.prototype) {
      throw codedError('PUBLICATION_VALUE_UNSUPPORTED', TypeError);
    }
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
      key,
      sanitizeNode(entry, key, pseudonymKey, knownPrivateValues, stack),
    ]));
  } finally {
    stack.delete(value);
  }
}

function markBoundary(value, boundary, stack = new WeakSet()) {
  if (!value || typeof value !== 'object' || stack.has(value)) return;
  stack.add(value);
  BOUNDARIES.set(value, boundary);
  for (const entry of Array.isArray(value) ? value : Object.values(value)) {
    markBoundary(entry, boundary, stack);
  }
  Object.freeze(value);
}

export function sanitizeForPublication(value, options = {}) {
  if (
    !options
    || typeof options !== 'object'
    || Array.isArray(options)
    || Object.keys(options).some((key) => !['pseudonymKey', 'registry', 'runManifest'].includes(key))
  ) throw codedError('PRIVATE_SOURCE_REGISTRY_REQUIRED', TypeError);
  const {
    pseudonymKey,
    registry,
    runManifest: explicitRunManifest,
  } = options;
  if (!Buffer.isBuffer(pseudonymKey) && !(pseudonymKey instanceof Uint8Array)) {
    throw codedError('PSEUDONYM_KEY_INVALID', TypeError);
  }
  const key = Buffer.from(pseudonymKey);
  if (key.length !== 32) {
    key.fill(0);
    throw codedError('PSEUDONYM_KEY_INVALID', TypeError);
  }
  try {
    const registryMetadata = PRIVATE_REGISTRIES.get(registry);
    if (!registryMetadata) throw codedError('PRIVATE_SOURCE_REGISTRY_REQUIRED', TypeError);
    const embeddedRunManifest = value
      && typeof value === 'object'
      && !Array.isArray(value)
      && Object.getPrototypeOf(value) === Object.prototype
      && value.runManifest
      && typeof value.runManifest === 'object'
      && !Array.isArray(value.runManifest)
      ? value.runManifest
      : undefined;
    const runManifest = embeddedRunManifest ?? explicitRunManifest;
    if (!runManifest) throw codedError('PRIVATE_SOURCE_REGISTRY_MISMATCH');
    let runManifestHash;
    try {
      runManifestHash = sha256(runManifest);
      if (
        embeddedRunManifest
        && explicitRunManifest
        && sha256(explicitRunManifest) !== runManifestHash
      ) throw codedError('PRIVATE_SOURCE_REGISTRY_MISMATCH');
    } catch (error) {
      if (error?.code === 'PRIVATE_SOURCE_REGISTRY_MISMATCH') throw error;
      throw codedError('PRIVATE_SOURCE_REGISTRY_MISMATCH');
    }
    if (runManifestHash !== registryMetadata.manifestHash) {
      throw codedError('PRIVATE_SOURCE_REGISTRY_MISMATCH');
    }
    const knownPrivateValues = registryMetadata.entries
      .map(({ kind, privateValue }) => ({
        privateValue,
        replacement: replacementFor(kind, privateValue, key),
      }))
      .sort((left, right) => right.privateValue.length - left.privateValue.length);
    const sanitized = sanitizeNode(value, '', key, knownPrivateValues, new WeakSet());
    if (
      embeddedRunManifest
      && sha256(sanitized.runManifest) !== registryMetadata.manifestHash
    ) throw codedError('PRIVATE_SOURCE_REGISTRY_MISMATCH');
    const boundary = Object.freeze({
      manifestHash: registryMetadata.manifestHash,
      sourceBundleHash: registryMetadata.sourceBundleHash,
      sourceRecordCount: registryMetadata.sourceRecordCount,
      sourceValueCount: registryMetadata.sourceValueCount,
    });
    markBoundary(sanitized, boundary);
    return sanitized;
  } finally {
    key.fill(0);
  }
}

function stringHasPrivateValue(value) {
  if (
    SAFE_REDACTION.test(value)
    || SAFE_PSEUDONYM.test(value)
    || APPROVED_EVIDENCE_ID.test(value)
  ) return false;
  if (RAW_REFERENCE.test(value)) return true;
  return [EMAIL, PHONE, BEARER, JWT, META_TOKEN, MAGIC_LINK].some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(value);
  });
}

function containsPrivateValue(value, keyName = '', stack = new WeakSet()) {
  if (typeof value === 'string') {
    if (RAW_REFERENCE.test(value)) return true;
    if (
      (CREDENTIAL_KEY.test(keyName)
        || KEY_REFERENCE_KEY.test(keyName)
        || PRIVATE_CONTENT_KEY.test(keyName)
        || MESSAGE_CONTAINER_KEY.test(keyName)
        || PII_KEY.test(keyName))
      && !SAFE_REDACTION.test(value)
      && !SAFE_PSEUDONYM.test(value)
      && !APPROVED_EVIDENCE_ID.test(value)
    ) return true;
    return stringHasPrivateValue(value);
  }
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return false;
  if (!value || typeof value !== 'object' || stack.has(value)) return true;
  stack.add(value);
  try {
    if (Array.isArray(value)) {
      return value.some((entry) => containsPrivateValue(entry, keyName, stack));
    }
    if (Object.getPrototypeOf(value) !== Object.prototype) return true;
    return Object.entries(value).some(([key, entry]) => (
      stringHasPrivateValue(key) || containsPrivateValue(entry, key, stack)
    ));
  } finally {
    stack.delete(value);
  }
}

function normalizedReferenceKey(keyName) {
  return String(keyName)
    .replace(/([a-z0-9])([A-Z])/gu, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '_')
    .replace(/^_+|_+$/gu, '');
}

function isForbiddenRawReferenceKey(keyName) {
  const tokens = normalizedReferenceKey(keyName).split('_');
  return tokens.includes('raw')
    && (
      tokens.includes('hash')
      || tokens.includes('ref')
      || tokens.includes('reference')
      || tokens.includes('vault')
    );
}

function containsRawReference(value, keyName = '', stack = new WeakSet()) {
  if (typeof value === 'string') {
    return RAW_REFERENCE.test(value)
      || isForbiddenRawReferenceKey(keyName);
  }
  if (!value || typeof value !== 'object' || stack.has(value)) return false;
  stack.add(value);
  try {
    if (Array.isArray(value)) return value.some((entry) => containsRawReference(entry, keyName, stack));
    return Object.entries(value).some(([key, entry]) => {
      if (isForbiddenRawReferenceKey(key)) return true;
      return containsRawReference(entry, key, stack);
    });
  } finally {
    stack.delete(value);
  }
}

function assertPublicationBoundary(runManifest, payloadArtifacts, verifierAttestation, projections) {
  const roots = [runManifest, payloadArtifacts, verifierAttestation, projections];
  const boundary = BOUNDARIES.get(roots[0]);
  if (!boundary || roots.some((root) => BOUNDARIES.get(root) !== boundary)) {
    throw codedError('PUBLICATION_BOUNDARY_REQUIRED');
  }
  if (boundary.manifestHash !== sha256(runManifest)) {
    throw codedError('PRIVATE_SOURCE_REGISTRY_MISMATCH');
  }
  for (const value of roots) {
    if (containsRawReference(value)) throw codedError('RAW_REFERENCE_FORBIDDEN');
    if (containsPrivateValue(value)) throw codedError('PUBLICATION_NOT_SANITIZED');
  }
}

function safeRelativePath(name) {
  if (
    typeof name !== 'string'
    || name.length === 0
    || isAbsolute(name)
    || name.includes('\0')
    || name.includes('\\')
  ) throw codedError('INVALID_ARTIFACT_PATH', TypeError);
  const normalized = normalize(name);
  if (
    normalized !== name
    || normalized === '..'
    || normalized.startsWith(`..${sep}`)
    || normalized.split(sep).some((part) => part === '' || part === '.' || part === '..')
    || name === 'run-manifest.json'
    || name === 'verifier-attestation.json'
  ) throw codedError('INVALID_ARTIFACT_PATH', TypeError);
  return normalized;
}

function assertAllowedArtifactPath(name) {
  if (ALLOWED_ROOT_ARTIFACTS.has(name)) return;
  if (/^evidence\/sanitized\/[A-Za-z0-9][A-Za-z0-9._/-]*\.(?:json|jsonl|md|txt)$/u.test(name)) return;
  if (/^solution-packs\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}\/(?:README\.md|proposal\.json|acceptance-tests\.md)$/u.test(name)) return;
  throw codedError('ARTIFACT_SCHEMA_NOT_ALLOWED');
}

function safeSegment(value, code) {
  if (
    typeof value !== 'string'
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value)
    || value.includes('..')
  ) throw codedError(code, TypeError);
  return value;
}

function isoWeek(instant) {
  const date = new Date(instant);
  if (!Number.isFinite(date.valueOf())) throw codedError('PUBLICATION_WEEK_INVALID', TypeError);
  const utc = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const weekday = utc.getUTCDay() || 7;
  utc.setUTCDate(utc.getUTCDate() + 4 - weekday);
  const yearStart = new Date(Date.UTC(utc.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((utc - yearStart) / 86400000) + 1) / 7);
  return `${utc.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function artifactBytes(value) {
  if (typeof value === 'string') return Buffer.from(value, 'utf8');
  if (
    value === null
    || Array.isArray(value)
    || (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype)
  ) return Buffer.from(`${canonicalJson(value)}\n`, 'utf8');
  throw codedError('PUBLICATION_VALUE_UNSUPPORTED', TypeError);
}

function byteHash(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function writeArtifact(base, name, bytes) {
  const path = join(base, name);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, bytes, { flag: 'wx', mode: 0o600 });
}

function listFiles(directory, prefix = '', output = []) {
  for (const name of readdirSync(directory).sort()) {
    const path = join(directory, name);
    const relativeName = prefix ? `${prefix}/${name}` : name;
    const metadata = lstatSync(path);
    if (metadata.isSymbolicLink()) throw codedError('PUBLICATION_PATH_SYMLINK');
    if (metadata.isDirectory()) listFiles(path, relativeName, output);
    else if (metadata.isFile()) output.push(relativeName);
    else throw codedError('PUBLICATION_CONFLICT');
  }
  return output;
}

function makeImmutable(directory) {
  const directories = [];
  const visit = (path) => {
    for (const name of readdirSync(path)) {
      const child = join(path, name);
      const metadata = lstatSync(child);
      if (metadata.isSymbolicLink()) throw codedError('PUBLICATION_PATH_SYMLINK');
      if (metadata.isDirectory()) {
        visit(child);
        directories.push(child);
      } else {
        chmodSync(child, 0o444);
      }
    }
  };
  visit(directory);
  for (const child of directories.reverse()) chmodSync(child, 0o555);
  chmodSync(directory, 0o555);
}

function makeWritable(directory) {
  chmodSync(directory, 0o700);
  for (const name of readdirSync(directory)) {
    const child = join(directory, name);
    if (statSync(child).isDirectory()) makeWritable(child);
    else chmodSync(child, 0o600);
  }
}

function atomicProjection(path, bytes) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o755 });
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o600 });
    renameSync(temporary, path);
    chmodSync(path, 0o644);
  } catch {
    throw codedError('PROJECTION_UPDATE_FAILED');
  } finally {
    if (existsSync(temporary)) rmSync(temporary, { force: true });
  }
}

function readIndex(path) {
  if (!existsSync(path)) return { schemaVersion: '1.0.0', publications: [] };
  try {
    const index = JSON.parse(readFileSync(path, 'utf8'));
    if (!index || !Array.isArray(index.publications) || containsPrivateValue(index)) throw new Error();
    return index;
  } catch {
    throw codedError('PUBLICATION_INDEX_INVALID');
  }
}

function isWithin(parent, child) {
  const pathFromParent = relative(parent, child);
  return pathFromParent === ''
    || (!isAbsolute(pathFromParent) && pathFromParent !== '..' && !pathFromParent.startsWith(`..${sep}`));
}

function openWeekGuard(paths, week) {
  ensureAuditPaths(paths);
  chmodSync(join(paths.privateRaw, '..'), 0o700);
  for (const directory of [
    paths.privateRaw,
    paths.privateLogs,
    paths.privateCheckpoints,
    paths.stateDir,
  ]) chmodSync(directory, 0o700);

  const weekDirectory = join(paths.weekly, week);
  let metadata;
  try {
    metadata = lstatSync(weekDirectory);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw codedError('PUBLICATION_PATH_INVALID');
  }
  if (metadata) {
    if (metadata.isSymbolicLink()) throw codedError('PUBLICATION_PATH_SYMLINK');
    if (!metadata.isDirectory()) throw codedError('PUBLICATION_PATH_INVALID');
  } else {
    mkdirSync(weekDirectory, { mode: 0o555 });
  }
  const weeklyReal = realpathSync(paths.weekly);
  let descriptor;
  try {
    descriptor = openSync(
      weekDirectory,
      constants.O_RDONLY
        | (constants.O_DIRECTORY ?? 0)
        | (constants.O_NOFOLLOW ?? 0),
    );
    const opened = fstatSync(descriptor);
    if (!opened.isDirectory()) throw codedError('PUBLICATION_PATH_INVALID');
    if (!isWithin(weeklyReal, realpathSync(weekDirectory))) {
      throw codedError('PUBLICATION_PATH_ESCAPE');
    }
    const identity = { dev: opened.dev, ino: opened.ino };
    const assertSame = () => {
      let current;
      try {
        current = lstatSync(weekDirectory);
      } catch {
        throw codedError('PUBLICATION_PATH_REPLACED');
      }
      if (
        current.isSymbolicLink()
        || !current.isDirectory()
        || current.dev !== identity.dev
        || current.ino !== identity.ino
        || !isWithin(weeklyReal, realpathSync(weekDirectory))
      ) throw codedError('PUBLICATION_PATH_REPLACED');
      const openMetadata = fstatSync(descriptor);
      if (openMetadata.dev !== identity.dev || openMetadata.ino !== identity.ino) {
        throw codedError('PUBLICATION_PATH_REPLACED');
      }
    };
    fchmodSync(descriptor, 0o755);
    assertSame();
    return Object.freeze({
      directory: weekDirectory,
      assertSame,
      close() {
        if (descriptor === undefined) return;
        try {
          fchmodSync(descriptor, 0o555);
        } finally {
          closeSync(descriptor);
          descriptor = undefined;
        }
      },
    });
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        fchmodSync(descriptor, 0o555);
      } finally {
        closeSync(descriptor);
      }
    }
    throw error?.code ? error : codedError('PUBLICATION_PATH_INVALID');
  }
}

function verifyExistingPublication(publicationPath, manifest, attestation, payloadHashes) {
  try {
    const metadata = lstatSync(publicationPath);
    if (metadata.isSymbolicLink()) throw codedError('PUBLICATION_PATH_SYMLINK');
    if (!metadata.isDirectory()) throw codedError('PUBLICATION_CONFLICT');
    const expectedFiles = [
      ...Object.keys(payloadHashes),
      'run-manifest.json',
      'verifier-attestation.json',
    ].sort();
    if (canonicalJson(listFiles(publicationPath)) !== canonicalJson(expectedFiles)) {
      throw codedError('PUBLICATION_CONFLICT');
    }
    const diskManifest = JSON.parse(readFileSync(join(publicationPath, 'run-manifest.json'), 'utf8'));
    const diskAttestation = JSON.parse(readFileSync(join(publicationPath, 'verifier-attestation.json'), 'utf8'));
    if (
      canonicalJson(diskManifest) !== canonicalJson(manifest)
      || canonicalJson(diskAttestation) !== canonicalJson(attestation)
    ) throw codedError('PUBLICATION_CONFLICT');
    for (const [name, expectedHash] of Object.entries(payloadHashes)) {
      if (byteHash(readFileSync(join(publicationPath, name))) !== expectedHash) {
        throw codedError('PUBLICATION_CONFLICT');
      }
    }
    return true;
  } catch (error) {
    if (error?.code === 'PUBLICATION_PATH_SYMLINK') throw error;
    throw codedError('PUBLICATION_CONFLICT');
  }
}

function nextIndexValue(index, pointer, status) {
  const prior = index.publications.find(({ publicationId, week }) => (
    publicationId === pointer.publicationId && week === pointer.week
  ));
  if (prior && canonicalJson(prior) !== canonicalJson(pointer)) {
    throw codedError('PUBLICATION_INDEX_CONFLICT');
  }
  const publications = prior ? index.publications : [...index.publications, pointer];
  return {
    schemaVersion: '1.0.0',
    publications,
    latest: pointer,
    latestFull: status === 'complete_full' ? pointer : (index.latestFull ?? null),
  };
}

export function publishAtomically({
  paths: suppliedPaths,
  runManifest,
  payloadArtifacts,
  verifierAttestation,
  projections = {},
  hooks,
} = {}) {
  if (
    !runManifest || typeof runManifest !== 'object' || Array.isArray(runManifest)
    || !payloadArtifacts || typeof payloadArtifacts !== 'object' || Array.isArray(payloadArtifacts)
    || !verifierAttestation || typeof verifierAttestation !== 'object' || Array.isArray(verifierAttestation)
    || !projections || typeof projections !== 'object' || Array.isArray(projections)
  ) throw codedError('PUBLICATION_INPUT_INVALID', TypeError);
  assertPublicationBoundary(runManifest, payloadArtifacts, verifierAttestation, projections);
  const paths = validateAuditPaths(suppliedPaths);
  if (!['complete_full', 'complete_partial'].includes(runManifest.status)) {
    throw codedError('PUBLICATION_STATUS_INVALID', TypeError);
  }
  const publicationId = safeSegment(runManifest.publicationId ?? runManifest.runId, 'PUBLICATION_ID_INVALID');
  const week = safeSegment(
    runManifest.week ?? isoWeek(runManifest.startedAt),
    'PUBLICATION_WEEK_INVALID',
  );
  if (!/^\d{4}-W\d{2}$/u.test(week)) throw codedError('PUBLICATION_WEEK_INVALID', TypeError);

  const artifactEntries = Object.entries(payloadArtifacts)
    .map(([name, value]) => {
      const safeName = safeRelativePath(name);
      assertAllowedArtifactPath(safeName);
      return [safeName, value];
    })
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  if (!artifactEntries.some(([name]) => name === 'REPORT.md')) {
    throw codedError('REPORT_ARTIFACT_REQUIRED');
  }
  for (const name of Object.keys(projections)) {
    if (!ALLOWED_PROJECTIONS.has(name)) throw codedError('INVALID_PROJECTION_PATH', TypeError);
  }

  const projectionBytes = new Map(
    Object.entries(projections).map(([name, value]) => [name, artifactBytes(value)]),
  );
  const serialized = new Map();
  const payloadHashes = {};
  for (const [name, value] of artifactEntries) {
    const bytes = artifactBytes(value);
    serialized.set(name, bytes);
    payloadHashes[name] = byteHash(bytes);
  }
  const publicationRoot = sha256(payloadHashes);
  const manifest = {
    ...runManifest,
    publicationId,
    week,
    payloadArtifacts: Object.entries(payloadHashes).map(([path, hash]) => ({ path, sha256: hash })),
    publicationRoot,
  };
  const attestation = {
    ...verifierAttestation,
    manifestHash: sha256(manifest),
    publicationRoot,
  };
  if (containsPrivateValue(manifest) || containsPrivateValue(attestation)) {
    throw codedError('PUBLICATION_NOT_SANITIZED');
  }

  const weekGuard = openWeekGuard(paths, week);
  const publicationPath = join(weekGuard.directory, publicationId);
  let recovered = false;
  try {
    weekGuard.assertSame();
    if (existsSync(publicationPath)) {
      weekGuard.assertSame();
      verifyExistingPublication(publicationPath, manifest, attestation, payloadHashes);
      weekGuard.assertSame();
      recovered = true;
    } else {
      const staging = join(weekGuard.directory, `.staging-${randomUUID()}`);
      weekGuard.assertSame();
      mkdirSync(staging, { mode: 0o700 });
      weekGuard.assertSame();
      try {
        for (const [name] of artifactEntries) writeArtifact(staging, name, serialized.get(name));
        writeArtifact(staging, 'run-manifest.json', Buffer.from(`${canonicalJson(manifest)}\n`, 'utf8'));
        writeArtifact(
          staging,
          'verifier-attestation.json',
          Buffer.from(`${canonicalJson(attestation)}\n`, 'utf8'),
        );
        makeImmutable(staging);
        weekGuard.assertSame();
        hooks?.beforePublicationRename?.();
        weekGuard.assertSame();
        renameSync(staging, publicationPath);
        weekGuard.assertSame();
      } catch (error) {
        if (existsSync(staging)) {
          makeWritable(staging);
          rmSync(staging, { recursive: true, force: true });
        }
        throw error?.code ? error : codedError('PUBLICATION_FAILED');
      }
    }

    const relativeReport = relative(paths.root, join(publicationPath, 'REPORT.md')).split(sep).join('/');
    const current = `# Current GHL audit\n\n[Open the latest publication](${relativeReport})\n`;
    const indexPath = join(paths.root, 'index.json');
    const pointer = {
      publicationId,
      week,
      status: manifest.status,
      path: relative(paths.root, publicationPath).split(sep).join('/'),
      publicationRoot,
    };
    const nextIndex = nextIndexValue(readIndex(indexPath), pointer, manifest.status);
    atomicProjection(join(paths.root, 'CURRENT.md'), Buffer.from(current, 'utf8'));
    atomicProjection(indexPath, Buffer.from(`${canonicalJson(nextIndex)}\n`, 'utf8'));
    for (const [name, bytes] of projectionBytes) {
      atomicProjection(join(paths.root, 'memory', name), bytes);
    }

    return Object.freeze({
      path: publicationPath,
      rootMembers: artifactEntries.map(([name]) => name),
      manifest: Object.freeze(manifest),
      attestation: Object.freeze(attestation),
      recovered,
    });
  } finally {
    weekGuard.close();
  }
}
