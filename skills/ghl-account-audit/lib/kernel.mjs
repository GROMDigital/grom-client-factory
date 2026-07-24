import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from 'node:crypto';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { canonicalJson, sha256 } from './canonical.mjs';
import { openState } from './state.mjs';
import {
  enforcePublicOnlyPublication,
  planWeeklyCollection,
  replayWeeklyFixture,
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
]);
const TERMINAL = new Set(['blocked', 'failed', 'quarantined', 'complete_partial']);
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const REVISION_PHASES = new Set([
  'awaiting_model_review',
  'prioritizing',
  'compiling',
  'verifying',
  'persisting',
  'complete_partial',
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
  const pathname = phaseArtifactPath(state, runId, phase);
  const temporary = `${pathname}.tmp`;
  mkdirSync(dirname(pathname), { recursive: true, mode: 0o700 });
  if (existsSync(pathname)) {
    const existing = JSON.parse(readFileSync(pathname, 'utf8'));
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
    };
  }
  if (existsSync(temporary)) {
    let orphan;
    try {
      const metadata = lstatSync(temporary);
      if (metadata.isSymbolicLink() || !metadata.isFile()) throw new Error();
      orphan = JSON.parse(readFileSync(temporary, 'utf8'));
      const restored = decryptPhaseArtifact({
        envelope: orphan,
        runId,
        phase,
        inputHash,
        keys,
      });
      if (canonicalJson(restored) !== canonicalJson(output)) throw new Error();
      renameSync(temporary, pathname);
      chmodSync(pathname, 0o600);
      return {
        artifactRef: relative(state.paths.root, pathname).split(sep).join('/'),
        artifactHash: sha256(orphan),
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
    descriptor = openSync(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    writeFileSync(descriptor, `${canonicalJson(envelope)}\n`);
    fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  renameSync(temporary, pathname);
  chmodSync(pathname, 0o600);
  return {
    artifactRef: relative(state.paths.root, pathname).split(sep).join('/'),
    artifactHash: sha256(envelope),
  };
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
  ) throw codedError('AUDIT_CHECKPOINT_INVALID_BINDING');
  const pathname = resolve(state.paths.root, checkpoint.payload.artifactRef);
  const checkpointRoot = resolve(state.paths.privateCheckpoints);
  if (!pathname.startsWith(`${checkpointRoot}${sep}`)) {
    throw codedError('AUDIT_CHECKPOINT_INVALID_PATH');
  }
  let envelope;
  try {
    const metadata = lstatSync(pathname);
    if (metadata.isSymbolicLink() || !metadata.isFile()) throw new Error();
    envelope = JSON.parse(readFileSync(pathname, 'utf8'));
  } catch {
    throw codedError('AUDIT_CHECKPOINT_INVALID_ARTIFACT');
  }
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
  return output;
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

  async function execute({ args, runId, frozenInputs, state, keys }) {
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

      phase = 'normalizing';
      const normalized = await runPhase(phase, {
        contextHash: sha256(context),
        publicHash: sha256(publicEvidence),
        collectionPlan,
      }, async () => (
        typeof analyzer.normalize === 'function'
          ? analyzer.normalize({
              context,
              publicEvidence,
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
        return enforcePublicOnlyPublication(compiledRaw, {
          firstBaseline: collectionPlan.mode === 'first',
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
        const publication = trustedPublication
          ? await publisher({
            paths: state.paths,
            runManifest: {
              ...compiled.manifestInput,
              status: 'complete_partial',
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
      phase = 'complete_partial';
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
      const frozenInputs = await analyzer.freezeInputs(args);
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
      state.createRun({ runId, frozenInputs, invocation, now: clock() });
      state.acquireLease({ runId, now: clock(), ttlMs: 300_000 });
      return await execute({ args, runId, frozenInputs, state, keys });
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
      const currentInputs = await analyzer.freezeInputs(args);
      let resumeMismatch = currentProviderDescriptor.configHash
        !== invocation.providerDescriptor.configHash;
      try {
        state.assertResumeInputs(input.runId, currentInputs);
      } catch (error) {
        if (error?.code !== 'RESUME_INPUT_MISMATCH') throw error;
        resumeMismatch = true;
      }
      if (resumeMismatch) {
        state.releaseLease({ runId: input.runId });
        state.close();
        state = undefined;
        zeroKeys(keys);
        keys = undefined;
        const newResult = await start(args);
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
