import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import {
  basename,
  dirname,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import { canonicalJson, sha256 } from './canonical.mjs';
import { openState } from './state.mjs';
import {
  collectInternalEvidencePhase,
  enforcePublicOnlyPublication,
  evaluateFullEligibility,
  frozenInputAnchorDigest,
  mergeInternalEvidence,
  planWeeklyCollection,
  currentClosedWeekWindow,
  replayWeeklyFixture,
  scanPublicationPrivacy,
} from './modes/weekly.mjs';

export { planWeeklyCollection };

const PHASES = Object.freeze([
  'queued',
  'preflight',
  'collecting_context',
  'collecting_public',
  'normalizing',
  'analyzing',
  'loading_memory',
  'planning_reviews',
  'awaiting_model_review',
  'prioritizing',
  'compiling',
  'verifying',
  'persisting',
  'complete_partial',
  // Task 11 / controller decision D1. APPENDED, never inserted: `phaseArtifactPath()` bakes
  // `PHASES.indexOf(phase)` into the on-disk checkpoint filename and `restorePhase()` refuses
  // any other pathname, so renumbering an existing phase would break every in-flight resume.
  // Array position is STORAGE identity; EXECUTION position is the source order inside
  // `execute()`, where these two run between `collecting_public` and `normalizing`.
  'awaiting_internal_auth',
  'collecting_internal',
  // The DERIVED terminal phase (finding I7). Appended for the same storage-identity reason as
  // the two above. Unreachable today because gate 2 has no live_runtime receipt to satisfy it.
  'complete_full',
]);
const TERMINAL = new Set([
  'blocked',
  'failed',
  'quarantined',
  'complete_partial',
  'complete_full',
]);
/**
 * Finding I4. Quarantine is not only the `AUDIT_INTEGRITY_FAILURE*` / `AUDIT_CHECKPOINT_INVALID*`
 * / `VERIFIER_*` families: the brief also quarantines on location mismatch, a write/raw trace
 * and a manifest/profile/hash mismatch, and controller decision D4 quarantines a privacy-scan
 * failure. These all landed in `failed` before.
 */
const QUARANTINING_CODES = new Set([
  'AUDIT_QUARANTINED',
  'INTERNAL_AUDIT_LOCATION_MISMATCH',
  'INTERNAL_AUDIT_MANIFEST_INVALID',
  'INTERNAL_AUDIT_PROFILE_MISMATCH',
  'INTERNAL_AUDIT_READ_ONLY_VIOLATION',
]);
const NON_PUBLISHING_STATUSES = new Set(['blocked', 'failed', 'quarantined']);
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const REVISION_PHASES = new Set([
  'awaiting_model_review',
  'prioritizing',
  'compiling',
  'verifying',
  'persisting',
  'complete_partial',
  // Finding R2-M3: `complete_full` was omitted while its sibling terminal phase was present, so
  // a second revision of a Full run would collide on the single `16-complete_full.json` path.
  'complete_full',
]);
const OPAQUE_ID = /^[A-Za-z0-9][-A-Za-z0-9_.:]{0,127}$/u;

function codedError(code, ErrorType = Error) {
  return Object.assign(new ErrorType(code), { code });
}

function deepFreeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function assertObject(value, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw codedError(code, TypeError);
  }
}

function assertSafeCollected(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object') return;
  if (seen.has(value)) throw codedError('AUDIT_INTEGRITY_FAILURE_CYCLE');
  seen.add(value);
  for (const [key, child] of Object.entries(value)) {
    const normalized = key.toLowerCase().replaceAll(/[^a-z]/gu, '');
    if (
      ['rawrequest', 'mutationtool', 'authorization', 'cookie'].includes(normalized)
      || normalized === 'method' && WRITE_METHODS.has(String(child).toUpperCase())
    ) throw codedError('AUDIT_INTEGRITY_FAILURE_WRITE_OR_RAW_TRACE');
    assertSafeCollected(child, seen);
  }
  seen.delete(value);
}

function eventKey(event) {
  if (typeof event?.nativeEventId === 'string' && event.nativeEventId.length > 0) {
    return `native:${event.nativeEventId}`;
  }
  if (typeof event?.stableEventKey === 'string' && event.stableEventKey.length > 0) {
    return `stable:${event.stableEventKey}`;
  }
  throw codedError('AUDIT_INTEGRITY_FAILURE_EVENT_IDENTITY');
}

export function mergeExactEvents({ priorEvents = [], collectedEvents = [] } = {}) {
  if (!Array.isArray(priorEvents) || !Array.isArray(collectedEvents)) {
    throw codedError('AUDIT_INTEGRITY_FAILURE_EVENT_SET', TypeError);
  }
  const events = new Map();
  for (const event of [...priorEvents, ...collectedEvents]) {
    const key = eventKey(event);
    const prior = events.get(key);
    if (prior && sha256(prior) !== sha256(event)) {
      throw codedError('AUDIT_INTEGRITY_FAILURE_EVENT_CONFLICT');
    }
    events.set(key, structuredClone(event));
  }
  return deepFreeze([...events.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, event]) => event));
}

function zeroKeys(keys) {
  if (!keys) return;
  for (const key of [keys.encryptionKey, keys.pseudonymKey]) {
    if (Buffer.isBuffer(key)) key.fill(0);
  }
}

function validateKeys(keys) {
  if (
    !keys
    || !Buffer.isBuffer(keys.encryptionKey)
    || keys.encryptionKey.length !== 32
    || !Buffer.isBuffer(keys.pseudonymKey)
    || keys.pseudonymKey.length !== 32
  ) throw codedError('AUDIT_PREFLIGHT_FAILED_KEY_MATERIAL');
}

// ---------------------------------------------------------------------------
// Finding R7-C1 — `analyzer.freezeInputs` had NO provenance requirement
// ---------------------------------------------------------------------------

/**
 * Round 6 moved the anchoring half of the frozen inputs out of the record that carries the proof
 * chain, and authenticated it with a MAC keyed by the run's vault key material. That closed the
 * SHIPPED composition root — `lib/local-runtime.mjs` — and nothing else, because this kernel
 * still did `const frozenInputs = await analyzer.freezeInputs(args)` and accepted whatever came
 * back. `analyzer` is INJECTED. A library host supplying its own therefore went on sealing its
 * own forgery: it returned anchors naming a proof chain it had minted, the kernel sealed them
 * into the run at `createRunWithLease`, and `evaluateFullEligibility` anchored on them because
 * nothing could state HOW they had been authenticated.
 *
 * `freezeInputs` may now return its frozen inputs wrapped in a host seal. The seal is a MAC over
 * the digest of EXACTLY the anchoring fields, keyed by the material `keyResolver` resolves for
 * this run — key material the provider configuration does not contain and its author cannot
 * read. Only a verified seal produces the provenance token that gate 2 requires.
 *
 * FAIL CLOSED, in both directions, exactly as the shipped half does:
 *  - a PLAIN return (every existing host, and every host that has no vault access) is accepted
 *    unchanged and carries NO provenance, so no identity is anchored, gate 2 fails and the run
 *    is capped at `complete_partial`. That is honest-but-limited, never a quarantine: absent
 *    authentication is missing evidence, not corrupt evidence.
 *  - a seal that is DECLARED and does not verify is refused at PREFLIGHT, matching the R2-M4
 *    precedent that a malformed declaration is refused rather than silently degraded.
 */
const FROZEN_INPUT_SEAL_KIND = 'host_sealed_frozen_inputs';
const FROZEN_INPUT_SEAL_DOMAIN = 'grom.audit.kernel.frozen-input-provenance.v1';
const FROZEN_INPUT_PROVENANCE_METHOD = 'host_key_mac';
const FROZEN_INPUT_SEAL_FIELDS = Object.freeze(['frozenInputs', 'kind', 'mac']);

function frozenInputSealMac(anchorDigest, keys) {
  // Domain-separated from every other use of the same key material, so a value produced for
  // another purpose can never be replayed as a frozen-input seal.
  const sealKey = createHmac('sha256', Buffer.concat([keys.encryptionKey, keys.pseudonymKey]))
    .update(FROZEN_INPUT_SEAL_DOMAIN)
    .digest();
  return createHmac('sha256', sealKey)
    .update(canonicalJson({
      anchorDigest,
      domain: FROZEN_INPUT_SEAL_DOMAIN,
      kind: FROZEN_INPUT_SEAL_KIND,
    }))
    .digest('hex');
}

function frozenInputMacMatches(expected, actual) {
  if (typeof actual !== 'string' || actual.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(actual, 'utf8'));
  } catch {
    return false;
  }
}

/**
 * Mints the host seal. A host calls this from inside its own `freezeInputs`, with the key
 * material its vault resolved for the run — which is what makes the seal a seal: the party whose
 * anchoring claim it is cannot produce the MAC.
 */
export function sealFrozenInputs({ frozenInputs, keys } = {}) {
  validateKeys(keys);
  const anchorDigest = frozenInputAnchorDigest(frozenInputs);
  if (typeof anchorDigest !== 'string' || anchorDigest.length === 0) {
    throw codedError('AUDIT_PREFLIGHT_FAILED_FROZEN_INPUTS');
  }
  return {
    kind: FROZEN_INPUT_SEAL_KIND,
    frozenInputs,
    mac: frozenInputSealMac(anchorDigest, keys),
  };
}

/**
 * Unwraps what `freezeInputs` returned into the frozen inputs the run is created with, plus the
 * provenance of their anchoring half. The frozen inputs handed on are ALWAYS the plain record —
 * `lib/state.mjs` `FROZEN_INPUT_FIELDS` is an exact-match list, so a wrapper must never reach
 * `createRunWithLease`, and a sealed run's `frozenInputsHash` stays byte-identical to the
 * unsealed one for the same inputs.
 */
function acceptFrozenInputs(returned, keys) {
  assertObject(returned, 'AUDIT_PREFLIGHT_FAILED_FROZEN_INPUTS');
  if (!Object.hasOwn(returned, 'kind') || returned.kind !== FROZEN_INPUT_SEAL_KIND) {
    return { frozenInputs: returned, provenance: null };
  }
  const fail = () => {
    throw codedError('AUDIT_PREFLIGHT_FAILED_FROZEN_INPUT_SEAL');
  };
  // Exact-field: the MAC covers only what it names, so an unnamed key would ride along
  // unauthenticated.
  const present = Object.keys(returned).sort();
  if (present.length !== FROZEN_INPUT_SEAL_FIELDS.length) fail();
  if (present.some((key, index) => key !== FROZEN_INPUT_SEAL_FIELDS[index])) fail();
  const inner = returned.frozenInputs;
  if (!inner || typeof inner !== 'object' || Array.isArray(inner)) fail();
  const anchorDigest = frozenInputAnchorDigest(inner);
  if (typeof anchorDigest !== 'string' || anchorDigest.length === 0) fail();
  if (!frozenInputMacMatches(frozenInputSealMac(anchorDigest, keys), returned.mac)) fail();
  return {
    frozenInputs: inner,
    // Bound to the anchors it authenticated. A provenance minted for one anchor block can never
    // license a different one, so re-writing the anchors after minting is not a seal either.
    provenance: Object.freeze({
      authenticated: true,
      method: FROZEN_INPUT_PROVENANCE_METHOD,
      anchorDigest,
    }),
  };
}

function phasePayload(value) {
  return {
    schemaVersion: '1.0.0',
    valueHash: sha256(value ?? null),
  };
}

function phaseArtifactPath(state, runId, phase) {
  const logicalPhase = phase.split('@', 1)[0];
  const safePhase = phase.replaceAll(/[^a-z0-9_-]/gu, '_');
  return join(
    state.paths.privateCheckpoints,
    runId,
    'phases',
    `${String(PHASES.indexOf(logicalPhase)).padStart(2, '0')}-${safePhase}.json`,
  );
}

function checkpointPhase(phase, input) {
  return REVISION_PHASES.has(phase)
    ? `${phase}@${sha256(input ?? null).slice(0, 24)}`
    : phase;
}

function filesystemIdentity(metadata) {
  return Object.freeze({
    dev: String(metadata.dev),
    ino: String(metadata.ino),
  });
}

function sameIdentity(left, right) {
  return left?.dev === right?.dev && left?.ino === right?.ino;
}

function directoryIdentity(pathname, code) {
  let metadata;
  try {
    metadata = lstatSync(pathname, { bigint: true });
  } catch {
    throw codedError(code);
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw codedError(code);
  return filesystemIdentity(metadata);
}

function openPhaseDirectory({ state, runId, create, expectedBinding }) {
  if (
    !Number.isInteger(constants.O_NOFOLLOW)
    || !Number.isInteger(constants.O_DIRECTORY)
  ) throw codedError('AUDIT_CHECKPOINT_INVALID_FS_UNSUPPORTED');
  const root = resolve(state.paths.privateCheckpoints);
  const authorizedRoot = state.pathBindings?.privateCheckpoints;
  const runDirectory = join(root, runId);
  const phasesDirectory = join(runDirectory, 'phases');
  let canonicalRoot;
  const assertDirectory = (pathname, expected, code) => {
    const identity = directoryIdentity(pathname, code);
    if (expected && !sameIdentity(identity, expected)) throw codedError(code);
    let canonical;
    try {
      canonical = realpathSync(pathname);
    } catch {
      throw codedError(code);
    }
    if (resolve(pathname) === root) {
      if (expected?.realpath && canonical !== expected.realpath) throw codedError(code);
      canonicalRoot = canonical;
      return Object.freeze({ ...identity, realpath: canonical });
    }
    else if (
      canonical === canonicalRoot
      || !canonical.startsWith(`${canonicalRoot}${sep}`)
    ) throw codedError(code);
    return identity;
  };
  const rootIdentity = assertDirectory(
    root,
    authorizedRoot,
    'AUDIT_CHECKPOINT_INVALID_ROOT_DIRECTORY',
  );
  const ensureChild = (parent, pathname) => {
    assertDirectory(parent, undefined, 'AUDIT_CHECKPOINT_INVALID_DIRECTORY');
    if (!existsSync(pathname)) {
      if (!create) throw codedError('AUDIT_CHECKPOINT_INVALID_DIRECTORY');
      try {
        mkdirSync(pathname, { mode: 0o700 });
      } catch {
        throw codedError('AUDIT_CHECKPOINT_INVALID_DIRECTORY');
      }
    }
  };
  ensureChild(root, runDirectory);
  const runIdentity = assertDirectory(
    runDirectory,
    expectedBinding?.run,
    'AUDIT_CHECKPOINT_INVALID_RUN_DIRECTORY',
  );
  ensureChild(runDirectory, phasesDirectory);
  const phasesIdentity = assertDirectory(
    phasesDirectory,
    expectedBinding?.phases,
    'AUDIT_CHECKPOINT_INVALID_PHASES_DIRECTORY',
  );
  const binding = Object.freeze({
    root: rootIdentity,
    run: runIdentity,
    phases: phasesIdentity,
  });
  if (expectedBinding && canonicalJson(binding) !== canonicalJson(expectedBinding)) {
    throw codedError('AUDIT_CHECKPOINT_INVALID_DIRECTORY_BINDING');
  }
  let descriptor;
  try {
    descriptor = openSync(
      phasesDirectory,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
  } catch {
    throw codedError('AUDIT_CHECKPOINT_INVALID_PHASES_DIRECTORY');
  }
  const assertSame = () => {
    assertDirectory(root, binding.root, 'AUDIT_CHECKPOINT_INVALID_ROOT_DIRECTORY');
    assertDirectory(runDirectory, binding.run, 'AUDIT_CHECKPOINT_INVALID_RUN_DIRECTORY');
    assertDirectory(
      phasesDirectory,
      binding.phases,
      'AUDIT_CHECKPOINT_INVALID_PHASES_DIRECTORY',
    );
    const opened = filesystemIdentity(fstatSync(descriptor, { bigint: true }));
    if (!sameIdentity(opened, binding.phases)) {
      throw codedError('AUDIT_CHECKPOINT_INVALID_DIRECTORY_BINDING');
    }
  };
  assertSame();
  return {
    directory: phasesDirectory,
    binding,
    assertSame,
    close() {
      if (descriptor !== undefined) {
        closeSync(descriptor);
        descriptor = undefined;
      }
    },
  };
}

function readPhaseEnvelope(pathname, guard) {
  let descriptor;
  try {
    guard.assertSame();
    descriptor = openSync(pathname, constants.O_RDONLY | constants.O_NOFOLLOW);
    const metadata = fstatSync(descriptor);
    if (!metadata.isFile()) throw new Error();
    const envelope = JSON.parse(readFileSync(descriptor, 'utf8'));
    guard.assertSame();
    return envelope;
  } catch (error) {
    if (error?.code?.startsWith?.('AUDIT_CHECKPOINT_INVALID')) throw error;
    throw codedError('AUDIT_CHECKPOINT_INVALID_ARTIFACT');
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function phaseAad({ runId, phase, inputHash }) {
  return Buffer.from(canonicalJson({
    schemaVersion: '1.0.0',
    runId,
    phase,
    inputHash,
  }), 'utf8');
}

function decryptPhaseArtifact({ envelope, runId, phase, inputHash, keys }) {
  if (
    !envelope
    || envelope.schemaVersion !== '1.0.0'
    || envelope.runId !== runId
    || envelope.phase !== phase
    || envelope.inputHash !== inputHash
    || typeof envelope.iv !== 'string'
    || typeof envelope.tag !== 'string'
    || typeof envelope.ciphertext !== 'string'
  ) throw codedError('AUDIT_CHECKPOINT_INVALID_ARTIFACT');
  try {
    const decipher = createDecipheriv(
      'aes-256-gcm',
      keys.encryptionKey,
      Buffer.from(envelope.iv, 'base64'),
    );
    decipher.setAAD(phaseAad({ runId, phase, inputHash }));
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
      decipher.final(),
    ]);
    const output = JSON.parse(plaintext.toString('utf8'));
    if (canonicalJson(output) !== plaintext.toString('utf8')) {
      throw codedError('AUDIT_CHECKPOINT_INVALID_CANONICAL');
    }
    plaintext.fill(0);
    return output;
  } catch (error) {
    if (error?.code?.startsWith?.('AUDIT_CHECKPOINT_INVALID')) throw error;
    throw codedError('AUDIT_CHECKPOINT_INVALID_DECRYPT');
  }
}

function writePhaseArtifact({ state, runId, phase, inputHash, output, keys }) {
  const priorBinding = state.listCheckpoints(runId)
    .map(({ payload }) => payload?.phaseDirectoryBinding)
    .find(Boolean);
  const guard = openPhaseDirectory({
    state,
    runId,
    create: true,
    expectedBinding: priorBinding,
  });
  const pathname = join(
    guard.directory,
    basename(phaseArtifactPath(state, runId, phase)),
  );
  const temporary = `${pathname}.tmp`;
  try {
    if (existsSync(pathname)) {
      const existing = readPhaseEnvelope(pathname, guard);
      const restored = decryptPhaseArtifact({
        envelope: existing,
        runId,
        phase,
        inputHash,
        keys,
      });
      if (canonicalJson(restored) !== canonicalJson(output)) {
        throw codedError('AUDIT_CHECKPOINT_INVALID_OUTPUT_CONFLICT');
      }
      return {
        artifactRef: relative(state.paths.root, pathname).split(sep).join('/'),
        artifactHash: sha256(existing),
        phaseDirectoryBinding: guard.binding,
      };
    }
    if (existsSync(temporary)) {
      let orphan;
      try {
        orphan = readPhaseEnvelope(temporary, guard);
        const restored = decryptPhaseArtifact({
          envelope: orphan,
          runId,
          phase,
          inputHash,
          keys,
        });
        if (canonicalJson(restored) !== canonicalJson(output)) throw new Error();
        guard.assertSame();
        renameSync(temporary, pathname);
        guard.assertSame();
        chmodSync(pathname, 0o600);
        return {
          artifactRef: relative(state.paths.root, pathname).split(sep).join('/'),
          artifactHash: sha256(orphan),
          phaseDirectoryBinding: guard.binding,
        };
      } catch (error) {
        if (error?.code?.startsWith?.('AUDIT_CHECKPOINT_INVALID')) throw error;
        throw codedError('AUDIT_CHECKPOINT_INVALID_ORPHAN');
      }
    }
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', keys.encryptionKey, iv);
    cipher.setAAD(phaseAad({ runId, phase, inputHash }));
    const plaintext = Buffer.from(canonicalJson(output), 'utf8');
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const envelope = {
      schemaVersion: '1.0.0',
      runId,
      phase,
      inputHash,
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      ciphertext: ciphertext.toString('base64'),
    };
    plaintext.fill(0);
    ciphertext.fill(0);
    let descriptor;
    try {
      guard.assertSame();
      descriptor = openSync(
        temporary,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600,
      );
      writeFileSync(descriptor, `${canonicalJson(envelope)}\n`);
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      guard.assertSame();
      renameSync(temporary, pathname);
      guard.assertSame();
      chmodSync(pathname, 0o600);
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
    return {
      artifactRef: relative(state.paths.root, pathname).split(sep).join('/'),
      artifactHash: sha256(envelope),
      phaseDirectoryBinding: guard.binding,
    };
  } finally {
    guard.close();
  }
}

function restorePhase({ state, runId, phase, input, keys }) {
  const checkpoint = state.getCheckpoint({ runId, phase });
  if (!checkpoint) return undefined;
  const inputHash = sha256(input ?? null);
  if (
    checkpoint.inputHash !== inputHash
    || !checkpoint.payload
    || checkpoint.payload.schemaVersion !== '1.0.0'
    || typeof checkpoint.payload.artifactRef !== 'string'
    || typeof checkpoint.payload.artifactHash !== 'string'
    || checkpoint.payload.outputHash !== checkpoint.outputHash
    || !checkpoint.payload.phaseDirectoryBinding
  ) throw codedError('AUDIT_CHECKPOINT_INVALID_BINDING');
  const guard = openPhaseDirectory({
    state,
    runId,
    create: false,
    expectedBinding: checkpoint.payload.phaseDirectoryBinding,
  });
  const pathname = resolve(state.paths.root, checkpoint.payload.artifactRef);
  const checkpointRoot = resolve(state.paths.privateCheckpoints);
  const expectedPathname = join(
    guard.directory,
    basename(phaseArtifactPath(state, runId, phase)),
  );
  if (
    !pathname.startsWith(`${checkpointRoot}${sep}`)
    || pathname !== expectedPathname
  ) {
    guard.close();
    throw codedError('AUDIT_CHECKPOINT_INVALID_PATH');
  }
  try {
    const envelope = readPhaseEnvelope(pathname, guard);
    if (sha256(envelope) !== checkpoint.payload.artifactHash) {
      throw codedError('AUDIT_CHECKPOINT_INVALID_HASH');
    }
    const output = decryptPhaseArtifact({
      envelope,
      runId,
      phase,
      inputHash,
      keys,
    });
    if (sha256(output) !== checkpoint.outputHash) {
      throw codedError('AUDIT_CHECKPOINT_INVALID_OUTPUT_HASH');
    }
    guard.assertSame();
    return output;
  } finally {
    guard.close();
  }
}

function savePhase(state, runId, phase, input, output, keys) {
  const inputHash = sha256(input ?? null);
  const outputHash = sha256(output ?? null);
  const artifact = writePhaseArtifact({
    state,
    runId,
    phase,
    inputHash,
    output,
    keys,
  });
  return state.saveCheckpoint({
    runId,
    phase,
    inputHash,
    outputHash,
    payload: {
      schemaVersion: '1.0.0',
      outputHash,
      ...artifact,
    },
  });
}

function atomicPrivateArtifact({ state, runId, kind, request, validatorState }) {
  const requestId = request.requestId;
  if (
    typeof requestId !== 'string'
    || !OPAQUE_ID.test(requestId)
    || !['conversation', 'mechanism'].includes(kind)
  ) throw codedError('REVIEW_REQUEST_STATE_INVALID_ID');
  const directory = join(state.paths.privateCheckpoints, runId, 'reviews');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  for (const candidate of [
    state.paths.privateCheckpoints,
    join(state.paths.privateCheckpoints, runId),
    directory,
  ]) {
    const metadata = lstatSync(candidate);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw codedError('AUDIT_INTEGRITY_FAILURE_REVIEW_PATH');
    }
    chmodSync(candidate, 0o700);
  }
  const destination = join(directory, `${kind}-${requestId}.json`);
  const expectedRoot = resolve(state.paths.root);
  const resolvedDestination = resolve(destination);
  if (!resolvedDestination.startsWith(`${expectedRoot}${sep}`)) {
    throw codedError('AUDIT_INTEGRITY_FAILURE_REVIEW_PATH');
  }
  const bytes = Buffer.from(`${canonicalJson({
    schemaVersion: '1.0.0',
    kind,
    runId,
    request,
    validatorState,
  })}\n`, 'utf8');
  if (existsSync(destination)) {
    const metadata = lstatSync(destination);
    if (
      metadata.isSymbolicLink()
      || !metadata.isFile()
      || !readFileSync(destination).equals(bytes)
    ) throw codedError('AUDIT_INTEGRITY_FAILURE_REVIEW_ARTIFACT');
  } else {
    const temporary = `${destination}.tmp`;
    let descriptor;
    try {
      if (existsSync(temporary)) {
        const metadata = lstatSync(temporary);
        if (
          metadata.isSymbolicLink()
          || !metadata.isFile()
          || !readFileSync(temporary).equals(bytes)
        ) throw codedError('AUDIT_INTEGRITY_FAILURE_REVIEW_ARTIFACT');
      } else {
        descriptor = openSync(
          temporary,
          constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
          0o600,
        );
        writeFileSync(descriptor, bytes);
        fsyncSync(descriptor);
        closeSync(descriptor);
        descriptor = undefined;
      }
      renameSync(temporary, destination);
      chmodSync(destination, 0o600);
    } catch (error) {
      if (descriptor !== undefined) closeSync(descriptor);
      throw error?.code?.startsWith?.('AUDIT_')
        ? error
        : codedError('AUDIT_INTEGRITY_FAILURE_REVIEW_ARTIFACT');
    }
  }
  return relative(state.paths.root, destination).split(sep).join('/');
}

function persistReviewRequest(state, runId, item, now) {
  assertObject(item, 'REVIEW_REQUEST_STATE_INVALID_SHAPE');
  const sealedRelativePath = atomicPrivateArtifact({
    state,
    runId,
    kind: item.kind,
    request: item.request,
    validatorState: item.validatorState,
  });
  const deadline = Number.isFinite(item.deadline)
    ? item.deadline
    : Date.parse(item.deadline ?? item.request.reviewDeadline ?? item.request.cutoff);
  return state.saveReviewRequest({
    runId,
    kind: item.kind,
    request: item.request,
    validatorState: item.validatorState,
    sealedRelativePath,
    createdAt: Number.isFinite(item.createdAt) ? item.createdAt : now,
    deadline,
    grants: item.grants ?? [],
    notRequired: item.notRequired ?? false,
  });
}

function persistNotRequiredReviews(state, runId, now) {
  for (const kind of ['conversation', 'mechanism']) {
    const nonceRef = `not_required_${kind}_${sha256({ runId, kind }).slice(0, 24)}`;
    const body = {
      schemaVersion: '1.0.0',
      requestId: `not_required_${kind}_${sha256({ runId, kind }).slice(0, 20)}`,
      nonceRef,
      runId,
      kind,
      state: 'not_required',
    };
    const request = { ...body, requestHash: sha256(body) };
    persistReviewRequest(state, runId, {
      kind,
      request,
      validatorState: { schemaVersion: '1.0.0', state: 'not_required' },
      grants: [],
      createdAt: now,
      deadline: now,
      notRequired: true,
    }, now);
  }
}

function normalizeStartArgs(args) {
  assertObject(args, 'AUDIT_COMMAND_INVALID_ARGS');
  if (args.mode !== 'weekly') throw codedError('AUDIT_MODE_UNSUPPORTED');
  if (
    typeof args.projectRoot !== 'string'
    || typeof args.providerId !== 'string'
    || typeof args.profile !== 'string'
    || typeof args.vaultKeyReference !== 'string'
    || args.vaultKeyReference.length === 0
  ) throw codedError('AUDIT_COMMAND_INVALID_ARGS');
  assertObject(args.target, 'AUDIT_COMMAND_INVALID_TARGET');
  assertObject(args.providerConfig ?? {}, 'AUDIT_COMMAND_INVALID_PROVIDER_CONFIG');
  return args;
}

export function createAuditKernel({
  clock,
  idFactory,
  stateStore = { open: openState },
  adapters,
  analyzer,
  verifier,
  publisher,
  keyResolver,
  providerConfigLoader,
  faultInjector,
} = {}) {
  if (
    typeof clock !== 'function'
    || typeof idFactory !== 'function'
    || typeof stateStore?.open !== 'function'
    || !adapters
    || !analyzer
    || typeof verifier !== 'function'
    || typeof publisher !== 'function'
    || typeof keyResolver !== 'function'
  ) throw codedError('AUDIT_COMMAND_INVALID_KERNEL', TypeError);

  const loadProviderConfig = async (invocation, projectRoot) => {
    const descriptor = invocation.providerDescriptor;
    if (descriptor.kind === 'inline_safe') return structuredClone(descriptor.config);
    if (typeof providerConfigLoader !== 'function') {
      throw codedError('AUDIT_PREFLIGHT_FAILED_PROVIDER_CONFIG');
    }
    const config = await providerConfigLoader({ descriptor, projectRoot });
    assertObject(config, 'AUDIT_PREFLIGHT_FAILED_PROVIDER_CONFIG');
    return config;
  };

  async function checkpoint(state, runId, phase, storedPhase, input, output, keys) {
    const saved = savePhase(state, runId, storedPhase, input, output, keys);
    if (typeof faultInjector === 'function') {
      await faultInjector({ phase, runId, checkpoint: saved });
    }
    return saved;
  }

  async function execute({
    args,
    runId,
    frozenInputs,
    // Finding R7-C1. `null` is the honest UNKNOWN: the host stated nothing about how the
    // anchoring half of `frozenInputs` was authenticated, so gate 2 anchors nothing.
    frozenInputProvenance = null,
    state,
    keys,
  }) {
    let phase = 'queued';
    const runPhase = async (phaseName, input, compute) => {
      const storedPhase = checkpointPhase(phaseName, input);
      const restored = restorePhase({
        state,
        runId,
        phase: storedPhase,
        input,
        keys,
      });
      if (restored !== undefined) return restored;
      const output = await compute();
      await checkpoint(state, runId, phaseName, storedPhase, input, output, keys);
      return output;
    };
    try {
      await runPhase('queued', frozenInputs, async () => ({ runId }));
      phase = 'preflight';
      const preflight = await runPhase(phase, frozenInputs, async () => {
        const baselineCandidate = typeof adapters.getGovernedBaseline === 'function'
          ? await adapters.getGovernedBaseline({
              target: args.target,
              profile: args.profile,
              frozenInputs,
            })
          : null;
        const baseline = baselineCandidate?.governedVerified === true
          ? baselineCandidate
          : null;
        const collectionPlan = planWeeklyCollection({
          cutoff: new Date(frozenInputs.cutoff).toISOString(),
          timezone: frozenInputs.timezone,
          salesCycleDays: args.providerConfig.salesCycleDays,
          providerAvailableFrom: args.providerConfig.providerAvailableFrom,
          priorWatermark: baseline?.watermark,
          lateArrivalHours: Math.max(
            72,
            Number.isFinite(args.providerConfig.lateArrivalHours)
              ? args.providerConfig.lateArrivalHours
              : 72,
          ),
        });
        return {
          frozenInputsHash: sha256(frozenInputs),
          baseline,
          collectionPlan,
        };
      });
      const { baseline, collectionPlan } = preflight;

      phase = 'collecting_context';
      const context = await runPhase(phase, preflight, async () => (
        typeof adapters.collectContext === 'function'
          ? adapters.collectContext({ ...args, runId, collectionPlan })
          : {}
      ));
      assertSafeCollected(context);

      phase = 'collecting_public';
      const publicEvidence = await runPhase(phase, {
        context,
        collectionPlan,
        baselineHash: sha256(baseline ?? null),
      }, async () => {
        const collectedPublic = typeof adapters.collectPublic === 'function'
          ? await adapters.collectPublic({
              ...args,
              runId,
              context,
              collectionPlan,
              baseline: baseline ? {
                publicationId: baseline.publicationId,
                watermark: baseline.watermark,
              } : null,
            })
          : {};
        return Array.isArray(collectedPublic.events)
          && Array.isArray(baseline?.priorEvents)
          ? {
              ...structuredClone(collectedPublic),
              events: mergeExactEvents({
                priorEvents: baseline.priorEvents,
                collectedEvents: collectedPublic.events,
              }),
            }
          : collectedPublic;
      });
      assertSafeCollected(publicEvidence);

      // ---- internal evidence (Task 11) ------------------------------------
      // Executed here, between `collecting_public` and `normalizing`, even though the two
      // phase names live at the END of `PHASES` (decision D1). Internal auth is resolved only
      // AFTER the public evidence above is durably checkpointed.
      let internalEvidence = null;
      let internalMerge = null;
      {
        const internalInput = {
          publicHash: sha256(publicEvidence),
          collectionPlan,
        };
        // Finding R2-I1: the DURABLE ANSWER IS CONSULTED FIRST. Collecting before reading the
        // `collecting_internal` checkpoint threw a run that had already checkpointed its
        // internal evidence back to `awaiting_internal_auth` on every single resume once the
        // short-lived credential lapsed (D5 = 300 s, i.e. the normal case), wedging the run
        // forever and re-issuing live account reads each time.
        //
        // Finding R3-I1: the durable answer is now consulted whether or not THIS kernel has an
        // internal rail. Restoring it costs no live call — the input is `{publicHash,
        // collectionPlan}`, computable with the rail off — and it is what makes a rail ROLLBACK
        // resume instead of quarantine: the `normalizing` input below is derived from the same
        // internal evidence either way, so disabling the rail no longer changes the phase input
        // of a run that already answered it with the rail on.
        const restoredInternal = restorePhase({
          state,
          runId,
          phase: checkpointPhase('collecting_internal', internalInput),
          input: internalInput,
          keys,
        });
        if (restoredInternal !== undefined) {
          phase = 'collecting_internal';
          internalEvidence = restoredInternal.internalEvidence;
          internalMerge = restoredInternal.merge;
          assertSafeCollected(internalEvidence);
        } else if (typeof adapters.collectInternal === 'function') {
          const internalPhase = await collectInternalEvidencePhase({
            adapter: await adapters.collectInternal({ ...args, runId, context, collectionPlan }),
            target: args.target,
            window: {
              from: new Date(collectionPlan.collectionStart).toISOString(),
              to: new Date(collectionPlan.cutoff).toISOString(),
            },
            // Copy analysis is about this closed week. The broader window above remains available
            // to workflow runtime and public outcome evidence so mature journeys are not clipped.
            conversationWindow: currentClosedWeekWindow({
              cutoff: collectionPlan.cutoff,
              timezone: collectionPlan.timezone,
            }),
            applicability: args.providerConfig?.internalApplicability ?? {},
            stepRosterRequests: args.providerConfig?.stepRosterRequests ?? {},
            publicEvidence,
            checkpoint: { schemaVersion: '1.0.0', phase: 'collecting_public' },
          });
          if (internalPhase.phase === 'awaiting_internal_auth') {
            phase = 'awaiting_internal_auth';
            await runPhase(phase, internalInput, async () => ({
              limitations: [...internalPhase.limitations],
            }));
            // Mirrors the `awaiting_model_review` suspend exactly. The lease is deliberately NOT
            // released here — that is a known Task 9 defect scoped to Task 12, not to this task.
            state.updateRunStatus({ runId, status: phase, now: clock() });
            return deepFreeze({ status: phase, runId });
          }
          if (internalPhase.internalEvidence !== null) {
            phase = 'collecting_internal';
            // The merge is checkpointed WITH the evidence that produced it. That is the durable
            // mark finding M3 asked for: the one bounded public refresh a logical run may spend
            // is restored from disk on resume rather than being spent again.
            const collected = await runPhase(phase, internalInput, async () => {
              const evidence = internalPhase.internalEvidence;
              const merged = await mergeInternalEvidence({
                publicEvidence,
                internalEvidence: evidence,
                coveragePolicy: args.providerConfig?.coveragePolicy ?? {},
                checkpoint: internalPhase.checkpoint,
                refreshPublicEvidence: typeof adapters.refreshPublic === 'function'
                  ? (request) => adapters.refreshPublic({ ...args, runId, ...request })
                  : undefined,
                refreshLedger: null,
              });
              return { internalEvidence: evidence, merge: merged };
            });
            internalEvidence = collected.internalEvidence;
            internalMerge = collected.merge;
            assertSafeCollected(internalEvidence);
          }
        }
      }

      phase = 'normalizing';
      // Finding C5: the `normalizing` checkpoint INPUT must stay byte-identical to the approved
      // Task 10 shape when there is no internal evidence, or every run checkpointed by Task 10
      // and resumed after this change terminates `quarantined`. The key is added ONLY when
      // internal evidence actually exists.
      const publicOnlyNormalizingInput = {
        contextHash: sha256(context),
        publicHash: sha256(publicEvidence),
        collectionPlan,
      };
      let normalizingInput = publicOnlyNormalizingInput;
      if (internalEvidence !== null) {
        // Finding R2-I2: C5 was closed only while the RESUMING kernel also had no rail. A
        // `normalizing` checkpoint already written under the Task 10 (public-only) input shape
        // stays restorable even when the resuming kernel HAS an internal rail — which is the
        // deployment this task exists to enable. The extended shape is used only for a phase
        // this run has not already durably answered.
        const stored = state.getCheckpoint({ runId, phase: 'normalizing' });
        normalizingInput = stored !== undefined
          && stored.inputHash === sha256(publicOnlyNormalizingInput)
          ? publicOnlyNormalizingInput
          : {
              ...publicOnlyNormalizingInput,
              internalHash: sha256(internalEvidence),
              mergeHash: sha256(internalMerge ?? null),
            };
      }
      const normalized = await runPhase(phase, normalizingInput, async () => (
        typeof analyzer.normalize === 'function'
          ? analyzer.normalize({
              context,
              publicEvidence,
              internalEvidence,
              merge: internalMerge,
              frozenInputs,
              runId,
              collectionPlan,
            })
          : { contextHash: sha256(context), publicHash: sha256(publicEvidence) }
      ));
      assertSafeCollected(normalized);

      phase = 'analyzing';
      const analysis = await runPhase(phase, {
        normalizedHash: sha256(normalized),
        collectionPlan,
      }, async () => {
        const discovery = typeof analyzer.discover === 'function'
          ? await analyzer.discover({ normalized, frozenInputs, runId, collectionPlan })
          : {};
        const falsification = typeof analyzer.falsify === 'function'
          ? await analyzer.falsify({
              normalized,
              discovery,
              frozenInputs,
              runId,
              collectionPlan,
            })
          : {};
        return { discovery, falsification };
      });
      const { discovery, falsification } = analysis;
      assertSafeCollected(discovery);
      assertSafeCollected(falsification);

      phase = 'loading_memory';
      const memory = await runPhase(phase, {
        analysisHash: sha256(analysis),
        frozenInputsHash: sha256(frozenInputs),
      }, async () => (
        typeof analyzer.loadMemory === 'function'
          ? analyzer.loadMemory({ frozenInputs, runId })
          : {}
      ));
      assertSafeCollected(memory);

      let durableRequests = state.listReviewRequests(runId);
      const reviewPlanInput = {
        analysisHash: sha256(analysis),
        frozenInputsHash: sha256(frozenInputs),
      };
      const hasReviewPlan = state.getCheckpoint({
        runId,
        phase: checkpointPhase('planning_reviews', reviewPlanInput),
      }) !== undefined;
      if (durableRequests.length === 0 || hasReviewPlan) {
        phase = 'planning_reviews';
        const requests = await runPhase(phase, reviewPlanInput, async () => {
          const created = typeof analyzer.createReviewRequests === 'function'
            ? await analyzer.createReviewRequests({
                normalized,
                discovery,
                falsification,
                frozenInputs,
                runId,
                keys,
                providerConfig: args.providerConfig,
              })
            : [];
          if (!Array.isArray(created)) {
            throw codedError('REVIEW_REQUEST_STATE_INVALID_SHAPE');
          }
          return created;
        });
        if (requests.length > 0) {
          for (const item of requests) {
            const persistedRequest = persistReviewRequest(state, runId, item, clock());
            if (typeof faultInjector === 'function') {
              await faultInjector({
                phase: 'review_request_persisted',
                runId,
                requestId: persistedRequest.requestId,
              });
            }
          }
        } else {
          persistNotRequiredReviews(state, runId, clock());
        }
        durableRequests = state.listReviewRequests(runId);
      }
      const pendingRequests = durableRequests.filter(({ status }) => status === 'pending');
      if (pendingRequests.length > 0) {
        phase = 'awaiting_model_review';
        await runPhase(phase, {
          analysisHash: sha256(analysis),
          requestHashes: pendingRequests.map(({ requestHash }) => requestHash).sort(),
        }, async () => ({
          requestHashes: pendingRequests.map(({ requestHash }) => requestHash).sort(),
        }));
        state.updateRunStatus({ runId, status: phase, now: clock() });
        return deepFreeze({ status: phase, runId });
      }
      const acceptedReviews = durableRequests
        .filter(({ status }) => status === 'consumed')
        .map(({ result }) => result);

      phase = 'prioritizing';
      const prioritizeInput = {
        analysisHash: sha256(analysis),
        memoryHash: sha256(memory),
        reviewHashes: acceptedReviews.map((review) => sha256(review)).sort(),
      };
      const prioritized = await runPhase(phase, prioritizeInput, async () => (
        typeof analyzer.prioritize === 'function'
          ? analyzer.prioritize({
              normalized,
              discovery,
              falsification,
              memory,
              reviews: acceptedReviews,
              frozenInputs,
              runId,
            })
          : { discovery, falsification }
      ));

      phase = 'compiling';
      const runBinding = {
        runId,
        frozenInputsHash: sha256(frozenInputs),
      };
      const compiled = await runPhase(phase, {
        prioritizedHash: sha256(prioritized),
        memoryHash: sha256(memory),
      }, async () => {
        const compiledRaw = typeof analyzer.compile === 'function'
          ? await analyzer.compile({
              normalized,
              prioritized,
              memory,
              frozenInputs,
              runId,
            })
          : { status: 'complete_partial', findings: [] };
        // ---- finding I7: the integration, no longer inert ---------------------
        // With no internal rail the decision stays `null` and `enforcePublicOnlyPublication`
        // behaves exactly as the approved Task 10 code, byte for byte. With an internal rail
        // the status is DERIVED from validated machine data by the ten gates.
        let fullEligibility = null;
        if (internalEvidence !== null) {
          // ---- finding R2-C1: gate 10 is DEFERRED, never a second verifier call ----------
          // The brief puts gate 10 INSIDE the trusted atomic publication gate. Invoking the
          // injected verifier here, mid-`compiling`, ran it a SECOND time and on the PRE-clamp
          // analyzer output — before `enforcePublicOnlyPublication` injects the two
          // INTERNAL_LIMITATIONS that the shipped verifier demands — so an identical run
          // terminated `complete_partial` with the rail off and `quarantined` with it on.
          // The trusted carrier already defers verification to `publishAtomically`, which
          // refuses to rename a publication into place unless the verifier attests `pass`
          // (`lib/artifacts.mjs`), and a failure there raises a `VERIFIER_*` code that
          // quarantines. That deferral IS gate 10; a compiled payload that does not travel the
          // trusted carrier has no such gate, so it fails closed and can never reach Full.
          const trustedCarrier = Boolean(
            compiledRaw?.payloadArtifacts
            && compiledRaw?.projections
            && compiledRaw?.manifestInput,
          );
          fullEligibility = await evaluateFullEligibility({
            internalEvidence,
            merge: internalMerge,
            trace: internalEvidence.trace ?? null,
            claimSupport: typeof analyzer.describeClaimSupport === 'function'
              ? await analyzer.describeClaimSupport({
                  compiled: compiledRaw,
                  normalized,
                  merge: internalMerge,
                  frozenInputs,
                  runId,
                })
              : null,
            privacyScan: scanPublicationPrivacy(compiledRaw),
            // Not an assertion that the verifier already ran: an assertion that this payload is
            // bound to a publication path where the verifier MUST pass before anything is
            // published. `null` (no such binding) is UNKNOWN and fails gate 10 closed without
            // being read as a verifier FAILURE, which would quarantine.
            verification: trustedCarrier
              ? { passed: true, code: null, boundTo: 'trusted_publication_gate' }
              : null,
            requiredWindows: [{
              windowId: 'analytical',
              from: new Date(collectionPlan.collectionStart).toISOString(),
              to: new Date(collectionPlan.cutoff).toISOString(),
            }],
            expected: {
              ...(args.providerConfig?.internalIdentities ?? {}),
              locationId: args.target.locationId,
            },
            // ---- finding R3-C2: the anchor is the SEALED frozen inputs --------------------
            // `providerConfig.internalIdentities` is minted by the same actor, and in the
            // shipped composition root the same configuration record, as the proof index it
            // was supposed to vouch for — so anchoring against it (or against the evidence's
            // own self-declared identity fields) was circular and a wholly self-minted proof
            // chain reached `complete_full` with no live canary. Decision D3's frozen inputs
            // are sealed at run creation, hashed into `frozenInputsHash` and
            // `RESUME_INPUT_MISMATCH`-protected: they are the only identity statement this run
            // cannot rewrite. `expected` above is retained ONLY as a mismatch discriminator.
            frozenInputs,
            // ---- finding R7-C1: HOW the anchoring half was authenticated ------------------
            // Round 6 authenticated the anchors in the shipped composition root; the kernel
            // still accepted any `analyzer.freezeInputs` return with no provenance at all, so
            // a library host running its own analyzer sealed its own forgery. This token is
            // emitted by `acceptFrozenInputs` ONLY after a host MAC keyed by this run's vault
            // key material verified against the digest of exactly these anchors. Absent — the
            // default for every host that seals nothing — no identity is anchored, gate 2
            // fails, and the run is capped at `complete_partial` rather than quarantined.
            frozenInputProvenance,
            run: runBinding,
          });
          if (NON_PUBLISHING_STATUSES.has(fullEligibility.status)) {
            // `blocked`, `failed` and `quarantined` runs publish no findings and no packs.
            throw codedError('AUDIT_QUARANTINED');
          }
        }
        return enforcePublicOnlyPublication(compiledRaw, {
          firstBaseline: collectionPlan.mode === 'first',
          fullEligibility,
          expectedRun: fullEligibility === null ? null : runBinding,
        });
      });

      phase = 'verifying';
      const trustedPublication = compiled?.payloadArtifacts
        && compiled?.projections
        && compiled?.manifestInput;
      const verification = await runPhase(phase, {
        compiledHash: sha256(compiled),
      }, async () => (
        trustedPublication
          ? {
              result: 'required_at_publication_gate',
              verifierInputHash: sha256(compiled),
            }
          : verifier({ compiled, runId, frozenInputs })
      ));
      if (!trustedPublication && verification?.result !== 'pass') {
        throw codedError('AUDIT_INTEGRITY_FAILURE_VERIFIER');
      }

      phase = 'persisting';
      // Finding I7: DERIVED, never hardcoded. `enforcePublicOnlyPublication` is the single
      // authority that stamped this status, and it only ever emits one of these two.
      const derivedStatus = compiled?.status === 'complete_full'
        ? 'complete_full'
        : 'complete_partial';
      const revisionHash = sha256({
        runId,
        frozenInputsHash: sha256(frozenInputs),
        compiled,
        verification,
      });
      const persisted = await runPhase(phase, {
        revisionHash,
      }, async () => {
        const prepared = state.preparePublicationIntent({
          runId,
          revisionHash,
          publicationId: `publication_${revisionHash.slice(0, 24)}`,
          now: clock(),
        });
        if (typeof faultInjector === 'function') {
          await faultInjector({
            phase: 'publication_intent_prepared',
            runId,
            publicationId: prepared.publicationId,
          });
        }
        const publication = trustedPublication
          ? await publisher({
            paths: state.paths,
            runManifest: {
              ...compiled.manifestInput,
              status: derivedStatus,
              publicationId: prepared.publicationId,
            },
            payloadArtifacts: compiled.payloadArtifacts,
            verifierAttestation: {
              verifierVersion: '1.0.0',
              result: 'pending',
            },
            verifyPublication: verifier,
            projections: compiled.projections,
            })
          : await publisher({
            paths: state.paths,
            runId,
            publicationId: prepared.publicationId,
            compiled,
            verification,
            frozenInputs,
            });
        if (trustedPublication && publication?.attestation?.result !== 'pass') {
          throw codedError('AUDIT_INTEGRITY_FAILURE_VERIFIER');
        }
        const manifestHash = publication?.manifestHash
          ?? publication?.attestation?.manifestHash
          ?? sha256({ publicationId: prepared.publicationId, compiled });
        const publicationRoot = publication?.publicationRoot
          ?? publication?.manifest?.publicationRoot
          ?? sha256({ publicationId: prepared.publicationId, verification });
        state.markPublicationIntentPublished({
          runId,
          revisionHash,
          manifestHash,
          publicationRoot,
          now: clock(),
        });
        return {
          publicationId: prepared.publicationId,
          manifestHash,
          publicationRoot,
        };
      });
      phase = derivedStatus;
      await runPhase(phase, persisted, async () => ({
        publicationId: persisted.publicationId,
      }));
      state.updateRunStatus({ runId, status: phase, now: clock() });
      state.releaseLease({ runId });
      return deepFreeze({
        status: phase,
        runId,
        publicationId: persisted.publicationId,
      });
    } catch (error) {
      const integrity = typeof error?.code === 'string'
        && (
          error.code.startsWith('AUDIT_INTEGRITY_FAILURE')
          || error.code.startsWith('AUDIT_CHECKPOINT_INVALID')
          || error.code.startsWith('VERIFIER_')
          || QUARANTINING_CODES.has(error.code)
        );
      const status = integrity ? 'quarantined' : 'failed';
      try {
        state.updateRunStatus({ runId, status, now: clock() });
        state.releaseLease({ runId });
      } catch {
        // The original failure remains authoritative.
      }
      if (integrity) throw codedError('AUDIT_QUARANTINED');
      if (error?.code) throw error;
      throw codedError(`AUDIT_PHASE_INVALID_${phase.toUpperCase()}`);
    }
  }

  async function start(input) {
    const args = normalizeStartArgs(input);
    let keys;
    let state;
    try {
      keys = await keyResolver(args.vaultKeyReference);
      validateKeys(keys);
      // Finding R7-C1. What `freezeInputs` returns is a CLAIM until the run's own key material
      // authenticates its anchoring half. `frozenInputs` below is always the plain record —
      // the seal never reaches `createRunWithLease`, so `frozenInputsHash` is unchanged.
      const returnedInputs = await analyzer.freezeInputs(args);
      assertObject(returnedInputs, 'AUDIT_PREFLIGHT_FAILED_FROZEN_INPUTS');
      const { frozenInputs, provenance: frozenInputProvenance } = acceptFrozenInputs(
        returnedInputs,
        keys,
      );
      assertObject(frozenInputs, 'AUDIT_PREFLIGHT_FAILED_FROZEN_INPUTS');
      const runId = idFactory('run');
      if (typeof runId !== 'string' || !OPAQUE_ID.test(runId)) {
        throw codedError('AUDIT_PREFLIGHT_FAILED_RUN_ID');
      }
      state = stateStore.open({
        projectRoot: args.projectRoot,
        locationId: args.target.locationId,
      });
      const providerDescriptor = args.providerDescriptor ?? {
        kind: 'inline_safe',
        configHash: sha256(args.providerConfig ?? {}),
        config: structuredClone(args.providerConfig ?? {}),
      };
      const invocation = {
        mode: args.mode,
        target: structuredClone(args.target),
        cutoff: frozenInputs.cutoff,
        providerId: args.providerId,
        profile: args.profile,
        providerDescriptor,
      };
      state.createRunWithLease({
        runId,
        frozenInputs,
        invocation,
        now: clock(),
        ttlMs: 300_000,
      });
      return await execute({ args, runId, frozenInputs, frozenInputProvenance, state, keys });
    } catch (error) {
      if (error?.code) throw error;
      throw codedError('AUDIT_PREFLIGHT_FAILED');
    } finally {
      zeroKeys(keys);
      state?.close();
    }
  }

  async function resume(input) {
    assertObject(input, 'AUDIT_COMMAND_INVALID_ARGS');
    if (
      typeof input.projectRoot !== 'string'
      || typeof input.locationId !== 'string'
      || typeof input.runId !== 'string'
      || typeof input.vaultKeyReference !== 'string'
    ) throw codedError('AUDIT_COMMAND_INVALID_ARGS');
    let keys;
    let state;
    try {
      keys = await keyResolver(input.vaultKeyReference);
      validateKeys(keys);
      state = stateStore.open({
        projectRoot: input.projectRoot,
        locationId: input.locationId,
      });
      const oldRun = state.getRun(input.runId);
      const invocation = state.getRunInvocation(input.runId);
      const providerConfig = await loadProviderConfig(invocation, input.projectRoot);
      const currentProviderDescriptor = invocation.providerDescriptor.kind === 'project_file'
        ? {
            ...invocation.providerDescriptor,
            configHash: sha256(providerConfig),
          }
        : invocation.providerDescriptor;
      const args = {
        mode: invocation.mode,
        target: invocation.target,
        projectRoot: input.projectRoot,
        cutoff: invocation.cutoff,
        providerId: invocation.providerId,
        profile: invocation.profile,
        providerConfig,
        providerDescriptor: currentProviderDescriptor,
        vaultKeyReference: input.vaultKeyReference,
      };
      // Finding R7-C1. A resume re-authenticates rather than inheriting: the seal that decides
      // is the one the host can produce NOW. `currentInputs` stays the plain record, so the
      // `assertResumeInputs` comparison below is byte-identical to the unsealed one.
      const returnedInputs = await analyzer.freezeInputs(args);
      assertObject(returnedInputs, 'AUDIT_PREFLIGHT_FAILED_FROZEN_INPUTS');
      const {
        frozenInputs: currentInputs,
        provenance: frozenInputProvenance,
      } = acceptFrozenInputs(returnedInputs, keys);
      let resumeMismatch = currentProviderDescriptor.configHash
        !== invocation.providerDescriptor.configHash;
      try {
        state.assertResumeInputs(input.runId, currentInputs);
      } catch (error) {
        if (error?.code !== 'RESUME_INPUT_MISMATCH') throw error;
        resumeMismatch = true;
      }
      if (resumeMismatch) {
        state.close();
        state = undefined;
        zeroKeys(keys);
        keys = undefined;
        let newResult;
        try {
          newResult = await start(args);
        } catch (error) {
          if (error?.code !== 'LEASE_HELD') throw error;
          return deepFreeze({
            status: 'RESUME_INPUT_MISMATCH_ACTIVE_LEASE',
            oldRunId: input.runId,
          });
        }
        return deepFreeze({
          status: 'RESUME_INPUT_MISMATCH',
          oldRunId: input.runId,
          newRunId: newResult.runId,
        });
      }
      state.acquireLease({ runId: input.runId, now: clock(), ttlMs: 300_000 });
      return await execute({
        args,
        runId: input.runId,
        frozenInputs: currentInputs,
        frozenInputProvenance,
        state,
        keys,
      });
    } finally {
      zeroKeys(keys);
      state?.close();
    }
  }

  return deepFreeze({
    start,
    resume,
    replay: async (args) => replayWeeklyFixture(args),
    phases: PHASES,
    terminalStates: [...TERMINAL],
  });
}
