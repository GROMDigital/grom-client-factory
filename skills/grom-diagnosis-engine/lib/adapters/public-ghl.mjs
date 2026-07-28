import {
  CollectionBudgetsSchema,
  PublicReadAllowlistSchema,
  assertAllowedPublicAction,
  loadCollectionBudgets,
} from '../../schemas/v1.mjs';
import { canonicalJson, sha256 } from '../canonical.mjs';
import {
  boundedUpstreamCode,
  capturedAt,
  cloneJson,
  codedError,
  completeCollection,
  incompleteCollection,
  assertWindowWithin,
  validateCollectionWindow,
} from './collection.mjs';
import {
  assertTrustedAction,
  loadTrustedPublicReadPolicy,
} from './trusted-public-policy.mjs';

const SHA256 = /^[a-f0-9]{64}$/u;
const RETRYABLE = new Set(['RETRYABLE', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN']);
const BUDGET_REASONS = new Set([
  'BUDGET_MAXIMUM_PAGES',
  'BUDGET_MAXIMUM_RECORDS',
  'BUDGET_MAXIMUM_RESPONSE_BYTES',
  'BUDGET_REQUEST_TIMEOUT',
  'BUDGET_RETRY_COUNT',
  'BUDGET_TOTAL_RETRY_DELAY',
  'BUDGET_WALL_CLOCK',
]);

function isPlainObject(value) {
  return Boolean(
    value
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
  );
}

function parseToolResult(response) {
  let value = response;
  if (isPlainObject(response) && isPlainObject(response.structuredContent)) {
    value = response.structuredContent;
  } else if (isPlainObject(response) && Array.isArray(response.content)) {
    const text = response.content.find((entry) => entry?.type === 'text')?.text;
    if (typeof text !== 'string') throw codedError('PUBLIC_RESPONSE_INVALID');
    try {
      value = JSON.parse(text);
    } catch {
      throw codedError('PUBLIC_RESPONSE_INVALID');
    }
  }
  if (
    !isPlainObject(value)
    || !Array.isArray(value.items)
    || !isPlainObject(value.page)
    || typeof value.page.reportedCount !== 'number'
    || !Number.isInteger(value.page.reportedCount)
    || value.page.reportedCount < 0
    || typeof value.page.complete !== 'boolean'
    || typeof value.page.truncated !== 'boolean'
    || !(value.page.cursor === null || typeof value.page.cursor === 'string')
    || !(value.page.nextCursor === null || typeof value.page.nextCursor === 'string')
  ) throw codedError('PUBLIC_RESPONSE_INVALID');
  return cloneJson(value, 'PUBLIC_RESPONSE_INVALID');
}

function withRequestTimeout(invoke, timeoutMs, timeoutReason, runtime, externalSignal) {
  const setTimer = runtime.setTimer ?? setTimeout;
  const clearTimer = runtime.clearTimer ?? clearTimeout;
  const timeoutController = new AbortController();
  const combinedSignal = externalSignal
    ? AbortSignal.any([externalSignal, timeoutController.signal])
    : timeoutController.signal;
  let timer;
  let timedOut = false;
  const call = Promise.resolve().then(() => invoke(combinedSignal));
  const timeout = new Promise((resolve) => {
    timer = setTimer(() => {
      timedOut = true;
      timeoutController.abort(codedError(timeoutReason));
      resolve({ timeout: true, reason: timeoutReason });
    }, timeoutMs);
  });
  return Promise.race([
    call.then((value) => ({ value })).catch((error) => {
      if (timedOut) return { timeout: true, reason: timeoutReason };
      if (externalSignal?.aborted) throw codedError('COLLECTION_ABORTED');
      throw error;
    }),
    timeout,
  ]).finally(() => {
    if (timer !== undefined) clearTimer(timer);
  });
}

function collectLocationIndicators(value, indicators = []) {
  if (!value || typeof value !== 'object') return indicators;
  for (const [key, nested] of Object.entries(value)) {
    const normalized = key.toLowerCase().replace(/[^a-z0-9]/gu, '');
    if (['boundlocationid', 'ghllocationid', 'locationid'].includes(normalized)) {
      indicators.push(nested);
    } else if (
      normalized === 'location'
      && nested
      && typeof nested === 'object'
      && !Array.isArray(nested)
      && Object.hasOwn(nested, 'id')
    ) {
      indicators.push(nested.id);
    }
    collectLocationIndicators(nested, indicators);
  }
  return indicators;
}

function assertResponseLocation(response, expectedLocationId) {
  const indicators = collectLocationIndicators(response);
  if (
    indicators.length === 0
    || indicators.some((locationId) => locationId !== expectedLocationId)
  ) throw codedError('LOCATION_MISMATCH');
}

function elapsed(start, runtime) {
  const now = typeof runtime.now === 'function' ? runtime.now() : Date.now();
  return Number(now) - Number(start);
}

function startTime(runtime) {
  return typeof runtime.now === 'function' ? runtime.now() : Date.now();
}

function normalizeCapability(capability, allowlist, allowlistHash, client) {
  if (!isPlainObject(capability) || typeof capability.actionId !== 'string') {
    throw codedError('ACTION_NOT_ALLOWED');
  }
  const listed = allowlist.actions.find(({ actionId }) => actionId === capability.actionId);
  if (!listed) throw codedError('ACTION_NOT_ALLOWED');
  if (capability.allowlistHash !== allowlistHash) throw codedError('ALLOWLIST_HASH_MISMATCH');
  if (capability.providerId !== client.providerId) throw codedError('PROVIDER_PIN_MISMATCH');
  if (capability.capabilityManifestHash !== client.capabilityManifestHash) {
    throw codedError('CAPABILITY_MANIFEST_HASH_MISMATCH');
  }
  if (
    typeof client.providerId !== 'string'
    || typeof client.capabilityManifestHash !== 'string'
    || !SHA256.test(client.capabilityManifestHash)
  ) throw codedError('MCP_CLIENT_PIN_INVALID', TypeError);
  if (
    client.publicCatalogSnapshotHash !== allowlist.sourceSnapshotHash
    || client.publicReadAllowlistHash !== allowlistHash
  ) throw codedError('MCP_CLIENT_PIN_INVALID', TypeError);
  try {
    assertAllowedPublicAction(allowlist, {
      actionId: capability.actionId,
      method: capability.method,
      normalizedPath: capability.normalizedPath,
      category: capability.category,
      risk: capability.risk,
      sourceSnapshotHash: capability.sourceSnapshotHash,
    });
  } catch {
    throw codedError('ACTION_NOT_ALLOWED');
  }
  if (typeof capability.operationId !== 'string' || capability.operationId.length === 0) {
    throw codedError('PUBLIC_CAPABILITY_INVALID', TypeError);
  }
  return Object.freeze({ ...listed, operationId: capability.operationId });
}

function normalizeBudget(budgets, category) {
  const parsed = CollectionBudgetsSchema.parse(budgets ?? loadCollectionBudgets());
  const budget = parsed.capabilities[category];
  if (!budget) throw codedError('COLLECTION_BUDGET_MISSING');
  return budget;
}

function normalizeWindow(window) {
  return validateCollectionWindow(window, 'COLLECTION_WINDOW_INVALID');
}

function makeRequest(action, expectedLocationId, requestedWindow, cursor) {
  return {
    name: 'execute_action',
    arguments: {
      action: action.actionId,
      params: {
        locationId: expectedLocationId,
        fromDate: requestedWindow.from,
        toDate: requestedWindow.to,
        cursor,
      },
      policy: {
        actionId: action.actionId,
        method: action.method,
        normalizedPath: action.normalizedPath,
        category: action.category,
        risk: action.risk,
        sourceSnapshotHash: action.sourceSnapshotHash,
        allowlistHash: action.allowlistHash,
        providerId: action.providerId,
        capabilityManifestHash: action.capabilityManifestHash,
      },
    },
  };
}

function responseByteLength(response) {
  try {
    return Buffer.byteLength(canonicalJson(response), 'utf8');
  } catch {
    throw codedError('PUBLIC_RESPONSE_INVALID');
  }
}

function normalizeRawPageSink(rawPageSink) {
  return Object.freeze({
    sealPage: typeof rawPageSink?.sealPage === 'function'
      ? rawPageSink.sealPage.bind(rawPageSink)
      : null,
    restorePage: typeof rawPageSink?.restorePage === 'function'
      ? rawPageSink.restorePage.bind(rawPageSink)
      : null,
  });
}

function validateSealedPage(sealed, payloadHash) {
  if (
    !isPlainObject(sealed)
    || Object.keys(sealed).sort().join(',') !== 'opaqueRef,payloadHash'
    || typeof sealed.opaqueRef !== 'string'
    || !/^raw_[a-f0-9]{32}$/u.test(sealed.opaqueRef)
    || sealed.payloadHash !== payloadHash
  ) throw codedError('RAW_PAGE_SEAL_FAILED');
  return Object.freeze({
    opaqueRef: sealed.opaqueRef,
    payloadHash: sealed.payloadHash,
  });
}

function checkpointScopeHash({
  action,
  requestedWindow,
  expectedLocationId,
  allowlistHash,
  clientPins,
}) {
  return sha256({
    schemaVersion: '1.0.0',
    source: 'public_ghl',
    action,
    requestedWindow,
    expectedLocationId,
    allowlistHash,
    providerId: clientPins.providerId,
    capabilityManifestHash: clientPins.capabilityManifestHash,
  });
}

function validateCheckpointArtifact(artifact, index, expectedCursor, reportedCount) {
  const keys = [
    'artifactHash',
    'collectedCount',
    'cursor',
    'nextCursor',
    'opaqueRef',
    'pageIndex',
    'reportedCount',
    'responseBytes',
  ];
  if (
    !isPlainObject(artifact)
    || canonicalJson(Object.keys(artifact).sort()) !== canonicalJson(keys)
    || artifact.pageIndex !== index + 1
    || artifact.cursor !== expectedCursor
    || !(artifact.nextCursor === null || typeof artifact.nextCursor === 'string')
    || typeof artifact.opaqueRef !== 'string'
    || !/^raw_[a-f0-9]{32}$/u.test(artifact.opaqueRef)
    || typeof artifact.artifactHash !== 'string'
    || !SHA256.test(artifact.artifactHash)
    || !Number.isInteger(artifact.collectedCount)
    || artifact.collectedCount < 0
    || artifact.reportedCount !== reportedCount
    || !Number.isInteger(artifact.responseBytes)
    || artifact.responseBytes < 0
  ) throw codedError('RESUME_CHECKPOINT_INVALID');
  return artifact.nextCursor;
}

function validateResumeCheckpoint(checkpoint, {
  action,
  cursor,
  expectedLocationId,
  requestedWindow,
  scopeHash,
}) {
  const keys = [
    'appliedWindow',
    'boundLocationId',
    'collectedCount',
    'initialCursor',
    'inputHash',
    'operationId',
    'pageArtifacts',
    'pageArtifactsHash',
    'pageCount',
    'reason',
    'reportedCount',
    'requestedWindow',
    'responseBytes',
    'resumeCursor',
    'schemaVersion',
    'scopeHash',
    'source',
  ];
  if (
    !isPlainObject(checkpoint)
    || canonicalJson(Object.keys(checkpoint).sort()) !== canonicalJson(keys)
    || checkpoint.schemaVersion !== '1.0.0'
    || checkpoint.source !== 'public_ghl'
    || checkpoint.operationId !== action.operationId
    || checkpoint.boundLocationId !== expectedLocationId
    || checkpoint.resumeCursor !== cursor
    || checkpoint.initialCursor !== null
    || checkpoint.scopeHash !== scopeHash
    || checkpoint.inputHash !== scopeHash
    || canonicalJson(checkpoint.requestedWindow) !== canonicalJson(requestedWindow)
    || !Array.isArray(checkpoint.pageArtifacts)
    || checkpoint.pageArtifacts.length === 0
    || checkpoint.pageArtifactsHash !== sha256(checkpoint.pageArtifacts)
    || checkpoint.pageCount !== checkpoint.pageArtifacts.length
    || !Number.isInteger(checkpoint.collectedCount)
    || checkpoint.collectedCount < 0
    || !Number.isInteger(checkpoint.reportedCount)
    || checkpoint.reportedCount < checkpoint.collectedCount
    || !Number.isInteger(checkpoint.responseBytes)
    || checkpoint.responseBytes < 0
  ) throw codedError('RESUME_CHECKPOINT_INVALID');
  let appliedWindow;
  try {
    appliedWindow = validateCollectionWindow(
      checkpoint.appliedWindow,
      'RESUME_CHECKPOINT_INVALID',
    );
    assertWindowWithin(appliedWindow, requestedWindow, 'RESUME_CHECKPOINT_INVALID');
  } catch {
    throw codedError('RESUME_CHECKPOINT_INVALID');
  }
  let expectedCursor = checkpoint.initialCursor;
  let collectedCount = 0;
  let responseBytes = 0;
  for (const [index, artifact] of checkpoint.pageArtifacts.entries()) {
    expectedCursor = validateCheckpointArtifact(
      artifact,
      index,
      expectedCursor,
      checkpoint.reportedCount,
    );
    collectedCount += artifact.collectedCount;
    responseBytes += artifact.responseBytes;
  }
  if (
    expectedCursor !== cursor
    || collectedCount !== checkpoint.collectedCount
    || responseBytes !== checkpoint.responseBytes
  ) throw codedError('RESUME_CHECKPOINT_INVALID');
  return Object.freeze({
    ...cloneJson(checkpoint, 'RESUME_CHECKPOINT_INVALID'),
    appliedWindow,
  });
}

export function createPublicGhlAdapter({
  client,
  allowlist,
  expectedLocationId,
  budgets,
  checkpointStore,
  rawPageSink,
  runtime = {},
} = {}) {
  if (
    !client
    || typeof client.callTool !== 'function'
    || typeof expectedLocationId !== 'string'
    || expectedLocationId.length === 0
  ) throw codedError('PUBLIC_ADAPTER_CONFIG_INVALID', TypeError);
  const trustedPolicy = loadTrustedPublicReadPolicy();
  let suppliedAllowlist;
  try {
    suppliedAllowlist = cloneJson(PublicReadAllowlistSchema.parse(allowlist));
  } catch {
    throw codedError('TRUSTED_ALLOWLIST_MISMATCH', TypeError);
  }
  if (canonicalJson(suppliedAllowlist) !== canonicalJson(trustedPolicy.allowlist)) {
    throw codedError('TRUSTED_ALLOWLIST_MISMATCH', TypeError);
  }
  const pinnedAllowlist = trustedPolicy.allowlist;
  const allowlistHash = trustedPolicy.allowlistHash;
  const clientPins = Object.freeze({
    providerId: client.providerId,
    expectedLocationId: client.expectedLocationId,
    capabilityManifestHash: client.capabilityManifestHash,
    publicCatalogSnapshotHash: client.publicCatalogSnapshotHash,
    publicReadAllowlistHash: client.publicReadAllowlistHash,
  });
  if (
    typeof clientPins.providerId !== 'string'
    || typeof clientPins.capabilityManifestHash !== 'string'
    || !SHA256.test(clientPins.capabilityManifestHash)
    || clientPins.publicCatalogSnapshotHash !== trustedPolicy.snapshotHash
    || clientPins.publicReadAllowlistHash !== trustedPolicy.allowlistHash
    || clientPins.expectedLocationId !== expectedLocationId
  ) throw codedError('MCP_CLIENT_PIN_INVALID', TypeError);
  const dispatchTool = client.callTool.bind(client);
  const sealedPageStore = normalizeRawPageSink(rawPageSink);
  const loadCheckpoint = typeof checkpointStore?.load === 'function'
    ? checkpointStore.load.bind(checkpointStore)
    : null;
  const persistCheckpoint = typeof checkpointStore?.save === 'function'
    ? checkpointStore.save.bind(checkpointStore)
    : null;
  const saveCheckpoint = async (checkpoint) => {
    if (checkpointStore !== undefined && persistCheckpoint === null) {
      throw codedError('CHECKPOINT_STORE_INVALID', TypeError);
    }
    await persistCheckpoint?.(cloneJson(checkpoint));
  };

  return Object.freeze({
    async collect({ capability, window, cursor = null, signal } = {}) {
      const action = normalizeCapability(
        capability,
        pinnedAllowlist,
        allowlistHash,
        clientPins,
      );
      const scopedAction = Object.freeze({
        ...action,
        sourceSnapshotHash: capability.sourceSnapshotHash,
        allowlistHash: capability.allowlistHash,
        providerId: capability.providerId,
        capabilityManifestHash: capability.capabilityManifestHash,
      });
      try {
        assertTrustedAction(trustedPolicy, scopedAction);
      } catch {
        throw codedError('ACTION_NOT_ALLOWED');
      }
      const budget = normalizeBudget(budgets, action.category);
      const requestedWindow = normalizeWindow(window);
      if (!(cursor === null || typeof cursor === 'string')) {
        throw codedError('COLLECTION_CURSOR_INVALID', TypeError);
      }
      if (sealedPageStore.sealPage === null) throw codedError('RAW_PAGE_SINK_REQUIRED');
      const started = startTime(runtime);
      const scopeHash = checkpointScopeHash({
        action: scopedAction,
        requestedWindow,
        expectedLocationId,
        allowlistHash,
        clientPins,
      });
      let initialCursor = cursor;
      let currentCursor = cursor;
      let appliedWindow = requestedWindow;
      let reportedCount = null;
      let responseBytes = 0;
      let pageCount = 0;
      let collectedRecordCount = 0;
      let retryCount = 0;
      let retryDelay = 0;
      const items = [];
      const pageArtifacts = [];
      const seenCursors = new Set(cursor === null ? [] : [cursor]);

      if (cursor !== null) {
        if (loadCheckpoint === null) throw codedError('RESUME_CHECKPOINT_REQUIRED');
        if (sealedPageStore.restorePage === null) throw codedError('RESUME_PAGE_SOURCE_REQUIRED');
        let loaded;
        try {
          loaded = await loadCheckpoint({
            source: 'public_ghl',
            operationId: action.operationId,
            boundLocationId: expectedLocationId,
            resumeCursor: cursor,
            scopeHash,
          });
        } catch {
          throw codedError('RESUME_CHECKPOINT_INVALID');
        }
        const checkpoint = validateResumeCheckpoint(loaded, {
          action,
          cursor,
          expectedLocationId,
          requestedWindow,
          scopeHash,
        });
        initialCursor = checkpoint.initialCursor;
        appliedWindow = checkpoint.appliedWindow;
        reportedCount = checkpoint.reportedCount;
        responseBytes = checkpoint.responseBytes;
        pageCount = checkpoint.pageCount;
        for (const artifact of checkpoint.pageArtifacts) {
          let restored;
          try {
            restored = parseToolResult(await sealedPageStore.restorePage({
              opaqueRef: artifact.opaqueRef,
              payloadHash: artifact.artifactHash,
            }));
          } catch {
            throw codedError('RESUME_PAGE_INVALID');
          }
          try {
            assertResponseLocation(restored, expectedLocationId);
            const restoredWindow = validateCollectionWindow(
              restored.appliedWindow,
              'RESUME_PAGE_INVALID',
            );
            assertWindowWithin(restoredWindow, requestedWindow, 'RESUME_PAGE_INVALID');
            if (
              sha256(restored) !== artifact.artifactHash
              || restored.page.cursor !== artifact.cursor
              || restored.page.nextCursor !== artifact.nextCursor
              || restored.page.reportedCount !== artifact.reportedCount
              || restored.items.length !== artifact.collectedCount
              || responseByteLength(restored) !== artifact.responseBytes
              || canonicalJson(restoredWindow) !== canonicalJson(appliedWindow)
            ) throw codedError('RESUME_PAGE_INVALID');
          } catch {
            throw codedError('RESUME_PAGE_INVALID');
          }
          pageArtifacts.push(cloneJson(artifact));
          items.push(...restored.items);
          if (artifact.cursor !== null) seenCursors.add(artifact.cursor);
          if (artifact.nextCursor !== null) seenCursors.add(artifact.nextCursor);
        }
        if (items.length !== checkpoint.collectedCount) {
          throw codedError('RESUME_PAGE_INVALID');
        }
        collectedRecordCount = items.length;
        if (signal?.aborted) throw codedError('COLLECTION_ABORTED');
      }

      const finishIncomplete = async (reason, {
        nextCursor = currentCursor,
        truncated = BUDGET_REASONS.has(reason) || reason === 'TRUNCATED',
      } = {}) => {
        const result = incompleteCollection({
          source: 'public_ghl',
          operationId: action.operationId,
          boundLocationId: expectedLocationId,
          requestedWindow,
          appliedWindow,
          capturedAt: capturedAt(runtime),
          items,
          cursor: initialCursor,
          nextCursor,
          reportedCount,
          reason,
          truncated,
        });
        await saveCheckpoint({
          schemaVersion: '1.0.0',
          source: result.source,
          operationId: result.operationId,
          boundLocationId: result.boundLocationId,
          resumeCursor: result.page.nextCursor,
          reason,
          collectedCount: result.page.collectedCount,
          reportedCount,
          initialCursor,
          requestedWindow,
          appliedWindow,
          responseBytes: pageArtifacts.reduce(
            (total, artifact) => total + artifact.responseBytes,
            0,
          ),
          pageCount: pageArtifacts.length,
          pageArtifacts,
          pageArtifactsHash: sha256(pageArtifacts),
          scopeHash,
          inputHash: scopeHash,
        });
        return result;
      };

      for (;;) {
        if (signal?.aborted) throw codedError('COLLECTION_ABORTED');
        const remainingWallClock = budget.wallClockMs - elapsed(started, runtime);
        if (remainingWallClock <= 0) {
          return finishIncomplete('BUDGET_WALL_CLOCK');
        }
        if (pageCount >= budget.maximumPages) {
          return finishIncomplete('BUDGET_MAXIMUM_PAGES');
        }
        if (collectedRecordCount >= budget.maximumRecords) {
          return finishIncomplete('BUDGET_MAXIMUM_RECORDS');
        }
        if (responseBytes >= budget.maximumResponseBytes) {
          return finishIncomplete('BUDGET_MAXIMUM_RESPONSE_BYTES');
        }

        let raw;
        try {
          const request = makeRequest(
            scopedAction,
            expectedLocationId,
            requestedWindow,
            currentCursor,
          );
          const requestTimeoutMs = Math.min(
            budget.requestTimeoutMs,
            remainingWallClock,
          );
          const timeoutReason = remainingWallClock <= budget.requestTimeoutMs
            ? 'BUDGET_WALL_CLOCK'
            : 'BUDGET_REQUEST_TIMEOUT';
          const outcome = await withRequestTimeout(
            (requestSignal) => dispatchTool(request, {
              signal: requestSignal,
              timeout: requestTimeoutMs,
            }),
            requestTimeoutMs,
            timeoutReason,
            runtime,
            signal,
          );
          if (outcome?.timeout === true) return finishIncomplete(outcome.reason);
          raw = outcome.value;
        } catch (error) {
          if (error?.code === 429 || error?.code === '429' || error?.code === 'RATE_LIMITED') {
            return finishIncomplete('RATE_LIMITED');
          }
          if (!RETRYABLE.has(error?.code)) {
            // The originating code is carried as `upstreamCode` so an operator can tell an
            // upstream refusal from a shape surprise from a transport fault. Without it this
            // throw is a diagnostic black hole: a live run reported only `PUBLIC_COLLECTION_FAILED`
            // and naming the cause took a capture session and several probes.
            // ONLY the code travels. Never a message, payload, param or status body, because this
            // value reaches `assertSafeCollected` and the publication boundary, and the worker
            // echoes request parameters into its error channel.
            //
            // `error.upstreamCode` is preferred over `error.code`, and that preference is the
            // whole point. `lib/adapters/mcp-transport.mjs` sits between this adapter and the
            // wire, so by the time a GHL refusal arrives here its own `code` is already the
            // TRANSPORT's `MCP_TOOL_CALL_FAILED` — naming the layer it crossed, not the cause.
            // The transport carries the originating code forward in `upstreamCode`; taking
            // `error.code` here would throw that away and report the black hole all over again.
            const failure = codedError('PUBLIC_COLLECTION_FAILED');
            const upstreamCode = boundedUpstreamCode(error?.upstreamCode ?? error?.code);
            throw Object.assign(failure, { upstreamCode });
          }
          if (retryCount >= budget.retryCount) return finishIncomplete('BUDGET_RETRY_COUNT');
          const delay = Number.isInteger(error.retryAfterMs) && error.retryAfterMs >= 0
            ? error.retryAfterMs
            : 0;
          const remainingAfterFailure = budget.wallClockMs - elapsed(started, runtime);
          if (remainingAfterFailure <= 0) return finishIncomplete('BUDGET_WALL_CLOCK');
          const remainingRetryDelay = budget.maximumTotalRetryDelayMs - retryDelay;
          if (remainingRetryDelay < 0 || (remainingRetryDelay === 0 && delay > 0)) {
            return finishIncomplete('BUDGET_TOTAL_RETRY_DELAY');
          }
          if (
            delay >= remainingAfterFailure
            && remainingAfterFailure <= remainingRetryDelay
          ) {
            retryCount += 1;
            retryDelay += remainingAfterFailure;
            await (runtime.sleep ?? ((milliseconds) => new Promise(
              (resolve) => setTimeout(resolve, milliseconds),
            )))(remainingAfterFailure);
            return finishIncomplete('BUDGET_WALL_CLOCK');
          }
          if (
            delay > remainingRetryDelay
            && remainingRetryDelay < remainingAfterFailure
          ) {
            retryCount += 1;
            retryDelay += remainingRetryDelay;
            await (runtime.sleep ?? ((milliseconds) => new Promise(
              (resolve) => setTimeout(resolve, milliseconds),
            )))(remainingRetryDelay);
            return finishIncomplete('BUDGET_TOTAL_RETRY_DELAY');
          }
          retryCount += 1;
          retryDelay += delay;
          await (runtime.sleep ?? ((milliseconds) => new Promise(
            (resolve) => setTimeout(resolve, milliseconds),
          )))(delay);
          continue;
        }

        pageCount += 1;
        const response = parseToolResult(raw);
        const currentResponseBytes = responseByteLength(response);
        responseBytes += currentResponseBytes;
        assertResponseLocation(response, expectedLocationId);
        if (response.page.cursor !== currentCursor) throw codedError('CURSOR_MISMATCH');
        const checkedAppliedWindow = validateCollectionWindow(
          response.appliedWindow,
          'APPLIED_WINDOW_INVALID',
        );
        assertWindowWithin(checkedAppliedWindow, requestedWindow);
        if (reportedCount === null) {
          appliedWindow = checkedAppliedWindow;
          reportedCount = response.page.reportedCount;
        } else {
          if (canonicalJson(appliedWindow) !== canonicalJson(checkedAppliedWindow)) {
            return finishIncomplete('APPLIED_WINDOW_CHANGED', {
              nextCursor: currentCursor,
            });
          }
          if (reportedCount !== response.page.reportedCount) {
            return finishIncomplete('REPORTED_COUNT_CHANGED', {
              nextCursor: currentCursor,
            });
          }
        }
        const payloadHash = sha256(response);
        let sealed;
        try {
          sealed = validateSealedPage(await sealedPageStore.sealPage({
            source: 'public_ghl',
            operationId: action.operationId,
            cursor: response.page.cursor,
            payloadHash,
            payload: cloneJson(response),
          }), payloadHash);
        } catch (error) {
          if (error?.code === 'RAW_PAGE_SEAL_FAILED') throw error;
          throw codedError('RAW_PAGE_SEAL_FAILED');
        }
        if (signal?.aborted) throw codedError('COLLECTION_ABORTED');
        pageArtifacts.push({
          pageIndex: pageArtifacts.length + 1,
          cursor: response.page.cursor,
          nextCursor: response.page.nextCursor,
          opaqueRef: sealed.opaqueRef,
          artifactHash: sealed.payloadHash,
          collectedCount: response.items.length,
          reportedCount: response.page.reportedCount,
          responseBytes: currentResponseBytes,
        });
        items.push(...response.items);
        collectedRecordCount += response.items.length;
        currentCursor = response.page.nextCursor;

        if (elapsed(started, runtime) >= budget.wallClockMs) {
          return finishIncomplete('BUDGET_WALL_CLOCK', { nextCursor: currentCursor });
        }
        if (responseBytes > budget.maximumResponseBytes) {
          return finishIncomplete('BUDGET_MAXIMUM_RESPONSE_BYTES', { nextCursor: currentCursor });
        }
        if (collectedRecordCount > budget.maximumRecords) {
          return finishIncomplete('BUDGET_MAXIMUM_RECORDS', { nextCursor: currentCursor });
        }
        if (response.rateLimited === true) {
          return finishIncomplete('RATE_LIMITED', { nextCursor: currentCursor });
        }
        if (response.page.truncated === true) {
          return finishIncomplete('TRUNCATED', { nextCursor: currentCursor, truncated: true });
        }
        if (currentCursor !== null) {
          if (seenCursors.has(currentCursor)) {
            return finishIncomplete('CURSOR_LOOP', { nextCursor: currentCursor });
          }
          seenCursors.add(currentCursor);
          if (pageCount >= budget.maximumPages) {
            return finishIncomplete('BUDGET_MAXIMUM_PAGES', { nextCursor: currentCursor });
          }
          continue;
        }
        if (response.page.complete !== true) {
          return finishIncomplete('TERMINAL_PROOF_MISSING', { nextCursor: null });
        }
        if (reportedCount !== items.length) {
          return finishIncomplete('REPORTED_COUNT_MISMATCH', { nextCursor: null });
        }
        return completeCollection({
          source: 'public_ghl',
          operationId: action.operationId,
          boundLocationId: expectedLocationId,
          requestedWindow,
          appliedWindow,
          capturedAt: capturedAt(runtime),
          items,
          cursor: initialCursor,
          reportedCount,
        });
      }
    },
  });
}
