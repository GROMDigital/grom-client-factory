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
  'awaiting_model_review',
  'prioritizing',
  'compiling',
  'verifying',
  'persisting',
  'complete_partial',
]);
const TERMINAL = new Set(['blocked', 'failed', 'quarantined', 'complete_partial']);
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
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

function savePhase(state, runId, phase, input, output) {
  const inputHash = sha256(input ?? null);
  const outputHash = sha256(output ?? null);
  return state.saveCheckpoint({
    runId,
    phase,
    inputHash,
    outputHash,
    payload: phasePayload(output),
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

  const runtime = new Map();

  async function checkpoint(state, runId, phase, input, output) {
    const saved = savePhase(state, runId, phase, input, output);
    if (typeof faultInjector === 'function') {
      await faultInjector({ phase, runId, checkpoint: saved });
    }
    return saved;
  }

  async function execute({ args, runId, frozenInputs, state, keys }) {
    let phase = 'queued';
    try {
      await checkpoint(state, runId, 'queued', frozenInputs, { runId });
      phase = 'preflight';
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
      await checkpoint(state, runId, phase, frozenInputs, {
        frozenInputsHash: sha256(frozenInputs),
        collectionPlan,
      });

      phase = 'collecting_context';
      const context = typeof adapters.collectContext === 'function'
        ? await adapters.collectContext({ ...args, runId, collectionPlan })
        : {};
      assertSafeCollected(context);
      await checkpoint(state, runId, phase, frozenInputs, context);

      phase = 'collecting_public';
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
      const publicEvidence = Array.isArray(collectedPublic.events)
        && Array.isArray(baseline?.priorEvents)
        ? {
            ...structuredClone(collectedPublic),
            events: mergeExactEvents({
          priorEvents: baseline.priorEvents,
              collectedEvents: collectedPublic.events,
            }),
          }
        : collectedPublic;
      assertSafeCollected(publicEvidence);
      await checkpoint(state, runId, phase, context, publicEvidence);

      phase = 'normalizing';
      const normalized = typeof analyzer.normalize === 'function'
        ? await analyzer.normalize({
            context,
            publicEvidence,
            frozenInputs,
            runId,
            collectionPlan,
          })
        : { contextHash: sha256(context), publicHash: sha256(publicEvidence) };
      assertSafeCollected(normalized);
      await checkpoint(state, runId, phase, publicEvidence, normalized);

      phase = 'analyzing';
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
      assertSafeCollected(discovery);
      assertSafeCollected(falsification);
      await checkpoint(state, runId, phase, normalized, { discovery, falsification });

      const memory = typeof analyzer.loadMemory === 'function'
        ? await analyzer.loadMemory({ frozenInputs, runId })
        : {};
      assertSafeCollected(memory);

      let durableRequests = state.listReviewRequests(runId);
      if (durableRequests.length === 0) {
        const requests = typeof analyzer.createReviewRequests === 'function'
          ? await analyzer.createReviewRequests({
              normalized,
              discovery,
              falsification,
              frozenInputs,
              runId,
              keys,
            })
          : [];
        if (!Array.isArray(requests)) throw codedError('REVIEW_REQUEST_STATE_INVALID_SHAPE');
        if (requests.length > 0) {
          for (const item of requests) {
            persistReviewRequest(state, runId, item, clock());
          }
        } else {
          persistNotRequiredReviews(state, runId, clock());
        }
        durableRequests = state.listReviewRequests(runId);
      }
      const pendingRequests = durableRequests.filter(({ status }) => status === 'pending');
      if (pendingRequests.length > 0) {
        phase = 'awaiting_model_review';
        await checkpoint(state, runId, phase, falsification, {
          requestHashes: pendingRequests.map(({ requestHash }) => requestHash).sort(),
        });
        state.updateRunStatus({ runId, status: phase, now: clock() });
        return deepFreeze({ status: phase, runId });
      }
      const acceptedReviews = durableRequests
        .filter(({ status }) => status === 'consumed')
        .map(({ result }) => result);

      phase = 'prioritizing';
      const prioritized = typeof analyzer.prioritize === 'function'
        ? await analyzer.prioritize({
          normalized,
          discovery,
          falsification,
          memory,
          reviews: acceptedReviews,
          frozenInputs,
          runId,
        })
        : { discovery, falsification };
      await checkpoint(state, runId, phase, { discovery, falsification }, prioritized);

      phase = 'compiling';
      const compiledRaw = typeof analyzer.compile === 'function'
        ? await analyzer.compile({
          normalized,
          prioritized,
          memory,
          frozenInputs,
          runId,
        })
        : { status: 'complete_partial', findings: [] };
      const compiled = enforcePublicOnlyPublication(compiledRaw, {
        firstBaseline: collectionPlan.mode === 'first',
      });
      await checkpoint(state, runId, phase, prioritized, compiled);

      phase = 'verifying';
      const trustedPublication = compiled?.payloadArtifacts
        && compiled?.projections
        && compiled?.manifestInput;
      const verification = trustedPublication
        ? {
            result: 'required_at_publication_gate',
            verifierInputHash: sha256(compiled),
          }
        : await verifier({ compiled, runId, frozenInputs });
      if (!trustedPublication && verification?.result !== 'pass') {
        throw codedError('AUDIT_INTEGRITY_FAILURE_VERIFIER');
      }
      await checkpoint(state, runId, phase, compiled, verification);

      phase = 'persisting';
      const revisionHash = sha256({
        runId,
        frozenInputsHash: sha256(frozenInputs),
        compiled,
        verification,
      });
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
            runId,
            publicationId: prepared.publicationId,
            compiled,
            verification,
            frozenInputs,
          });
      if (trustedPublication && publication?.attestation?.result !== 'pass') {
        throw codedError('AUDIT_INTEGRITY_FAILURE_VERIFIER');
      }
      const manifestHash = publication?.manifestHash ?? sha256({
        publicationId: prepared.publicationId,
        compiled,
      });
      const publicationRoot = publication?.publicationRoot ?? sha256({
        publicationId: prepared.publicationId,
        verification,
      });
      state.markPublicationIntentPublished({
        runId,
        revisionHash,
        manifestHash,
        publicationRoot,
        now: clock(),
      });
      await checkpoint(state, runId, phase, { compiled, verification }, {
        publicationId: prepared.publicationId,
        manifestHash,
        publicationRoot,
      });
      phase = 'complete_partial';
      await checkpoint(state, runId, phase, revisionHash, {
        publicationId: prepared.publicationId,
      });
      state.updateRunStatus({ runId, status: phase, now: clock() });
      state.releaseLease({ runId });
      return deepFreeze({
        status: phase,
        runId,
        publicationId: prepared.publicationId,
      });
    } catch (error) {
      const integrity = typeof error?.code === 'string'
        && (
          error.code.startsWith('AUDIT_INTEGRITY_FAILURE')
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
      state.createRun({ runId, frozenInputs, now: clock() });
      state.acquireLease({ runId, now: clock(), ttlMs: 300_000 });
      runtime.set(runId, {
        args: {
          mode: args.mode,
          target: structuredClone(args.target),
          projectRoot: args.projectRoot,
          cutoff: args.cutoff,
          providerId: args.providerId,
          profile: args.profile,
          providerConfig: structuredClone(args.providerConfig ?? {}),
        },
      });
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
      const remembered = runtime.get(input.runId);
      const args = {
        mode: 'weekly',
        target: oldRun.frozenInputs.target,
        projectRoot: input.projectRoot,
        cutoff: oldRun.frozenInputs.cutoff,
        providerId: remembered?.args.providerId ?? 'provider',
        profile: remembered?.args.profile ?? oldRun.frozenInputs.target.operatingProfile,
        providerConfig: remembered?.args.providerConfig ?? {},
        vaultKeyReference: input.vaultKeyReference,
      };
      const currentInputs = await analyzer.freezeInputs(args);
      try {
        state.assertResumeInputs(input.runId, currentInputs);
      } catch (error) {
        if (error?.code !== 'RESUME_INPUT_MISMATCH') throw error;
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
