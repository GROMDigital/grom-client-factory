import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
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
import { dirname, isAbsolute, join, normalize, relative, sep } from 'node:path';
import { canonicalJson, sha256 } from './canonical.mjs';
import { ensureAuditPaths } from './paths.mjs';

const CREDENTIAL_KEY = /(?:authorization|cookie|api[_-]?key|secret|password|access[_-]?token|refresh[_-]?token|jwt|bearer)/iu;
const KEY_REFERENCE_KEY = /(?:key[_-]?ref(?:erence)?|vault[_-]?key|keyReference)/iu;
const PRIVATE_CONTENT_KEY = /(?:^|[_-])(?:transcript|body|message[_-]?body|raw[_-]?(?:message|content)|recording)(?:$|[_-])/iu;
const MESSAGE_CONTAINER_KEY = /^(?:messages?|conversationMessages)$/iu;
const PII_KEY = /(?:^|[_-])(?:e-?mail|phone|mobile|first[_-]?name|last[_-]?name|full[_-]?name|contact[_-]?name|display[_-]?name|name)(?:$|[_-])/iu;
const SAFE_PSEUDONYM = /^psn_[a-f0-9]{32}$/u;
const SAFE_REDACTION = /^<REDACTED:[a-z-]+>$/u;
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu;
const PHONE = /(?:\+\d[\d\s().-]{7,}\d|\b\d{3}[\s().-]\d{3}[\s().-]\d{4}\b)/gu;
const BEARER = /Bearer\s+\S+/giu;
const JWT = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/gu;
const META_TOKEN = /EAA[A-Za-z0-9]{20,}/gu;
const MAGIC_LINK = /https?:\/\/[^\s"'<>]*[?&](?:token|code|signature|key|secret|auth)=[^\s"'<>]+/giu;
const ALLOWED_PROJECTIONS = new Set(['BACKLOG.md', 'backlog.json', 'current-system-flow.mmd']);

function codedError(code, ErrorType = Error) {
  return Object.assign(new ErrorType(code), { code });
}

function pseudonym(value, key) {
  return `psn_${createHmac('sha256', key)
    .update(String(value).normalize('NFKC').trim().toLowerCase())
    .digest('hex')
    .slice(0, 32)}`;
}

function replacePattern(value, pattern, replacement) {
  pattern.lastIndex = 0;
  return value.replace(pattern, replacement);
}

function replaceKnownPrivateValues(value, knownPrivateValues) {
  let output = value;
  for (const { privateValue, replacement } of knownPrivateValues) {
    output = output.split(privateValue).join(replacement);
  }
  return output;
}

function sanitizeString(value, keyName, pseudonymKey, knownPrivateValues) {
  if (SAFE_REDACTION.test(value) || SAFE_PSEUDONYM.test(value)) return value;
  if (KEY_REFERENCE_KEY.test(keyName)) return '<REDACTED:key-reference>';
  if (CREDENTIAL_KEY.test(keyName)) return '<REDACTED:credential>';
  if (PRIVATE_CONTENT_KEY.test(keyName) || MESSAGE_CONTAINER_KEY.test(keyName)) {
    return '<REDACTED:private-content>';
  }
  if (PII_KEY.test(keyName)) return pseudonym(value, pseudonymKey);

  let output = replaceKnownPrivateValues(value, knownPrivateValues);
  output = replacePattern(output, BEARER, '<REDACTED:credential>');
  output = replacePattern(output, JWT, '<REDACTED:credential>');
  output = replacePattern(output, META_TOKEN, '<REDACTED:credential>');
  output = replacePattern(output, MAGIC_LINK, '<REDACTED:magic-link>');
  output = replacePattern(output, EMAIL, (match) => pseudonym(match, pseudonymKey));
  output = replacePattern(output, PHONE, (match) => pseudonym(match, pseudonymKey));
  return output;
}

function sanitizeNode(value, keyName, pseudonymKey, knownPrivateValues, stack) {
  if (typeof value === 'string') {
    return sanitizeString(value, keyName, pseudonymKey, knownPrivateValues);
  }
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (MESSAGE_CONTAINER_KEY.test(keyName)) return '<REDACTED:private-content>';
  if (Array.isArray(value)) {
    if (stack.has(value)) throw codedError('PUBLICATION_VALUE_UNSUPPORTED', TypeError);
    stack.add(value);
    try {
      return value.map((entry) => sanitizeNode(
        entry,
        keyName,
        pseudonymKey,
        knownPrivateValues,
        stack,
      ));
    } finally {
      stack.delete(value);
    }
  }
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    if (stack.has(value)) throw codedError('PUBLICATION_VALUE_UNSUPPORTED', TypeError);
    stack.add(value);
    try {
      return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
        key,
        sanitizeNode(entry, key, pseudonymKey, knownPrivateValues, stack),
      ]));
    } finally {
      stack.delete(value);
    }
  }
  throw codedError('PUBLICATION_VALUE_UNSUPPORTED', TypeError);
}

function collectKnownPrivateValues(value, pseudonymKey, stack = new WeakSet(), keyName = '', output = []) {
  if (typeof value === 'string') {
    if (value.length < 3) return output;
    let replacement;
    if (PII_KEY.test(keyName)) replacement = pseudonym(value, pseudonymKey);
    else if (KEY_REFERENCE_KEY.test(keyName)) replacement = '<REDACTED:key-reference>';
    else if (CREDENTIAL_KEY.test(keyName)) replacement = '<REDACTED:credential>';
    else if (PRIVATE_CONTENT_KEY.test(keyName) || MESSAGE_CONTAINER_KEY.test(keyName)) {
      replacement = '<REDACTED:private-content>';
    }
    if (replacement) output.push({ privateValue: value, replacement });
    return output;
  }
  if (!value || typeof value !== 'object' || stack.has(value)) return output;
  stack.add(value);
  try {
    if (Array.isArray(value)) {
      for (const entry of value) {
        collectKnownPrivateValues(entry, pseudonymKey, stack, keyName, output);
      }
    } else {
      for (const [key, entry] of Object.entries(value)) {
        collectKnownPrivateValues(entry, pseudonymKey, stack, key, output);
      }
    }
    return output;
  } finally {
    stack.delete(value);
  }
}

export function sanitizeForPublication(value, { pseudonymKey } = {}) {
  if (!Buffer.isBuffer(pseudonymKey) && !(pseudonymKey instanceof Uint8Array)) {
    throw codedError('PSEUDONYM_KEY_INVALID', TypeError);
  }
  const key = Buffer.from(pseudonymKey);
  if (key.length !== 32) {
    key.fill(0);
    throw codedError('PSEUDONYM_KEY_INVALID', TypeError);
  }
  try {
    const knownPrivateValues = collectKnownPrivateValues(value, key)
      .sort((left, right) => right.privateValue.length - left.privateValue.length);
    return sanitizeNode(value, '', key, knownPrivateValues, new WeakSet());
  } finally {
    key.fill(0);
  }
}

function stringHasPrivateValue(value) {
  if (SAFE_REDACTION.test(value) || SAFE_PSEUDONYM.test(value)) return false;
  return [EMAIL, PHONE, BEARER, JWT, META_TOKEN, MAGIC_LINK].some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(value);
  });
}

function containsPrivateValue(value, keyName = '', stack = new WeakSet()) {
  if (typeof value === 'string') {
    if (
      (CREDENTIAL_KEY.test(keyName)
        || KEY_REFERENCE_KEY.test(keyName)
        || PRIVATE_CONTENT_KEY.test(keyName)
        || MESSAGE_CONTAINER_KEY.test(keyName)
        || PII_KEY.test(keyName))
      && !SAFE_REDACTION.test(value)
      && !SAFE_PSEUDONYM.test(value)
    ) return true;
    return stringHasPrivateValue(value);
  }
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return false;
  if (!value || typeof value !== 'object' || stack.has(value)) return true;
  stack.add(value);
  try {
    if (Array.isArray(value)) {
      if (MESSAGE_CONTAINER_KEY.test(keyName)) {
        return value.some((entry) => entry !== '<REDACTED:private-content>');
      }
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

function assertSanitized(value) {
  if (containsPrivateValue(value)) throw codedError('PUBLICATION_NOT_SANITIZED');
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
  if (name.startsWith(`evidence${sep}`) && !name.startsWith(`evidence${sep}sanitized${sep}`)) {
    throw codedError('UNSANITIZED_EVIDENCE_PATH');
  }
  return normalized;
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

function makeImmutable(directory) {
  const entries = [];
  const visit = (path) => {
    const names = readDirectory(path);
    for (const name of names) {
      const child = join(path, name);
      if (isDirectory(child)) {
        visit(child);
        entries.push(child);
      } else {
        chmodSync(child, 0o444);
      }
    }
  };
  visit(directory);
  for (const child of entries.reverse()) chmodSync(child, 0o555);
  chmodSync(directory, 0o555);
}

function makeWritable(directory) {
  chmodSync(directory, 0o700);
  for (const name of readDirectory(directory)) {
    const child = join(directory, name);
    if (isDirectory(child)) makeWritable(child);
    else chmodSync(child, 0o600);
  }
}

function readDirectory(path) {
  return readdirSync(path);
}

function isDirectory(path) {
  return statSync(path).isDirectory();
}

function atomicProjection(path, bytes) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o755 });
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o600 });
    renameSync(temporary, path);
    chmodSync(path, 0o644);
  } finally {
    if (existsSync(temporary)) rmSync(temporary, { force: true });
  }
}

function readIndex(path) {
  if (!existsSync(path)) return { schemaVersion: '1.0.0', publications: [] };
  try {
    const index = JSON.parse(readFileSync(path, 'utf8'));
    if (!index || !Array.isArray(index.publications)) throw new Error();
    assertSanitized(index);
    return index;
  } catch {
    throw codedError('PUBLICATION_INDEX_INVALID');
  }
}

function assertPublicationInputs(runManifest, payloadArtifacts, verifierAttestation, projections) {
  if (!runManifest || typeof runManifest !== 'object' || Array.isArray(runManifest)) {
    throw codedError('PUBLICATION_MANIFEST_INVALID', TypeError);
  }
  if (!payloadArtifacts || typeof payloadArtifacts !== 'object' || Array.isArray(payloadArtifacts)) {
    throw codedError('PUBLICATION_PAYLOAD_INVALID', TypeError);
  }
  if (!verifierAttestation || typeof verifierAttestation !== 'object' || Array.isArray(verifierAttestation)) {
    throw codedError('PUBLICATION_ATTESTATION_INVALID', TypeError);
  }
  assertSanitized(runManifest);
  assertSanitized(payloadArtifacts);
  assertSanitized(verifierAttestation);
  assertSanitized(projections);
}

export function publishAtomically({
  paths,
  runManifest,
  payloadArtifacts,
  verifierAttestation,
  projections = {},
} = {}) {
  assertPublicationInputs(runManifest, payloadArtifacts, verifierAttestation, projections);
  if (!paths || typeof paths !== 'object') throw codedError('PUBLICATION_PATHS_INVALID', TypeError);
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
    .map(([name, value]) => [safeRelativePath(name), value])
    .sort(([left], [right]) => left.localeCompare(right));
  if (artifactEntries.length === 0) throw codedError('PUBLICATION_PAYLOAD_INVALID', TypeError);
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
  assertSanitized(manifest);
  assertSanitized(attestation);

  const weekDirectory = join(paths.weekly, week);
  const publicationPath = join(weekDirectory, publicationId);
  ensureAuditPaths(paths);
  chmodSync(join(paths.privateRaw, '..'), 0o700);
  for (const directory of [
    paths.privateRaw,
    paths.privateLogs,
    paths.privateCheckpoints,
    paths.stateDir,
  ]) chmodSync(directory, 0o700);
  if (existsSync(publicationPath)) throw codedError('PUBLICATION_EXISTS');

  mkdirSync(weekDirectory, { recursive: true, mode: 0o755 });
  mkdirSync(join(paths.root, 'memory'), { recursive: true, mode: 0o755 });
  const staging = join(weekDirectory, `.staging-${randomUUID()}`);
  mkdirSync(staging, { mode: 0o700 });
  try {
    for (const [name] of artifactEntries) writeArtifact(staging, name, serialized.get(name));
    writeArtifact(staging, 'run-manifest.json', Buffer.from(`${canonicalJson(manifest)}\n`, 'utf8'));
    writeArtifact(
      staging,
      'verifier-attestation.json',
      Buffer.from(`${canonicalJson(attestation)}\n`, 'utf8'),
    );
    makeImmutable(staging);
    renameSync(staging, publicationPath);
  } catch (error) {
    if (existsSync(staging)) {
      makeWritable(staging);
      rmSync(staging, { recursive: true, force: true });
    }
    throw error?.code ? error : codedError('PUBLICATION_FAILED');
  }

  const relativeReport = relative(paths.root, join(publicationPath, 'REPORT.md')).split(sep).join('/');
  const current = `# Current GHL audit\n\n[Open the latest publication](${relativeReport})\n`;
  const indexPath = join(paths.root, 'index.json');
  const index = readIndex(indexPath);
  const pointer = {
    publicationId,
    week,
    status: manifest.status,
    path: relative(paths.root, publicationPath).split(sep).join('/'),
    publicationRoot,
  };
  const nextIndex = {
    schemaVersion: '1.0.0',
    publications: [...index.publications, pointer],
    latest: pointer,
    latestFull: manifest.status === 'complete_full' ? pointer : (index.latestFull ?? null),
  };
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
  });
}
