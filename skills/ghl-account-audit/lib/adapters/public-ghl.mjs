import {
  CollectionBudgetsSchema,
  PublicReadAllowlistSchema,
  assertAllowedPublicAction,
  loadCollectionBudgets,
} from '../../schemas/v1.mjs';
import { canonicalJson, sha256 } from '../canonical.mjs';
import {
  capturedAt,
  cloneJson,
  codedError,
  completeCollection,
  incompleteCollection,
} from './collection.mjs';

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

function withRequestTimeout(promise, timeoutMs, runtime) {
  const setTimer = runtime.setTimer ?? setTimeout;
  const clearTimer = runtime.clearTimer ?? clearTimeout;
  let timer;
  return Promise.race([
    promise,
    new Promise((resolve) => {
      timer = setTimer(() => resolve({ timeout: true }), timeoutMs);
    }),
  ]).finally(() => {
    if (timer !== undefined) clearTimer(timer);
  });
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
  if (
    !isPlainObject(window)
    || Object.keys(window).sort().join(',') !== 'from,to'
    || typeof window.from !== 'string'
    || typeof window.to !== 'string'
  ) throw codedError('COLLECTION_WINDOW_INVALID', TypeError);
  const from = Date.parse(window.from);
  const to = Date.parse(window.to);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) {
    throw codedError('COLLECTION_WINDOW_INVALID', TypeError);
  }
  return cloneJson(window, 'COLLECTION_WINDOW_INVALID');
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

export function createPublicGhlAdapter({
  client,
  allowlist,
  expectedLocationId,
  budgets,
  checkpointStore,
  runtime = {},
} = {}) {
  if (
    !client
    || typeof client.callTool !== 'function'
    || typeof expectedLocationId !== 'string'
    || expectedLocationId.length === 0
  ) throw codedError('PUBLIC_ADAPTER_CONFIG_INVALID', TypeError);
  const pinnedAllowlist = cloneJson(
    PublicReadAllowlistSchema.parse(allowlist),
    'PUBLIC_ADAPTER_CONFIG_INVALID',
  );
  const allowlistHash = sha256(pinnedAllowlist);
  const saveCheckpoint = async (checkpoint) => {
    if (checkpointStore !== undefined && typeof checkpointStore?.save !== 'function') {
      throw codedError('CHECKPOINT_STORE_INVALID', TypeError);
    }
    await checkpointStore?.save(cloneJson(checkpoint));
  };

  return Object.freeze({
    async collect({ capability, window, cursor = null, signal } = {}) {
      const action = normalizeCapability(capability, pinnedAllowlist, allowlistHash, client);
      const budget = normalizeBudget(budgets, action.category);
      const requestedWindow = normalizeWindow(window);
      if (!(cursor === null || typeof cursor === 'string')) {
        throw codedError('COLLECTION_CURSOR_INVALID', TypeError);
      }
      const started = startTime(runtime);
      const initialCursor = cursor;
      let currentCursor = cursor;
      let appliedWindow = requestedWindow;
      let reportedCount = null;
      let responseBytes = 0;
      let pageCount = 0;
      let retryCount = 0;
      let retryDelay = 0;
      const items = [];
      const seenCursors = new Set(cursor === null ? [] : [cursor]);

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
          reportedCount: reportedCount ?? items.length,
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
          inputHash: sha256({
            action,
            requestedWindow,
            initialCursor,
            allowlistHash,
            providerId: client.providerId,
            capabilityManifestHash: client.capabilityManifestHash,
          }),
        });
        return result;
      };

      for (;;) {
        if (signal?.aborted) throw codedError('COLLECTION_ABORTED');
        if (elapsed(started, runtime) > budget.wallClockMs) {
          return finishIncomplete('BUDGET_WALL_CLOCK');
        }
        if (pageCount >= budget.maximumPages) {
          return finishIncomplete('BUDGET_MAXIMUM_PAGES');
        }

        let raw;
        try {
          const request = makeRequest(action, expectedLocationId, requestedWindow, currentCursor);
          const outcome = await withRequestTimeout(
            Promise.resolve().then(() => client.callTool(request, {
              signal,
              timeout: budget.requestTimeoutMs,
            })),
            budget.requestTimeoutMs,
            runtime,
          );
          if (outcome?.timeout === true) return finishIncomplete('BUDGET_REQUEST_TIMEOUT');
          raw = outcome;
        } catch (error) {
          if (error?.code === 429 || error?.code === '429' || error?.code === 'RATE_LIMITED') {
            return finishIncomplete('RATE_LIMITED');
          }
          if (!RETRYABLE.has(error?.code)) throw codedError('PUBLIC_COLLECTION_FAILED');
          if (retryCount >= budget.retryCount) return finishIncomplete('BUDGET_RETRY_COUNT');
          const delay = Number.isInteger(error.retryAfterMs) && error.retryAfterMs >= 0
            ? error.retryAfterMs
            : 0;
          if (retryDelay + delay > budget.maximumTotalRetryDelayMs) {
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
        responseBytes += responseByteLength(raw);
        const response = parseToolResult(raw);
        const responseLocationId = response.boundLocationId ?? response.locationId;
        if (responseLocationId !== expectedLocationId) throw codedError('LOCATION_MISMATCH');
        if (response.page.cursor !== currentCursor) throw codedError('CURSOR_MISMATCH');
        if (pageCount === 1) {
          appliedWindow = cloneJson(response.appliedWindow, 'APPLIED_WINDOW_INVALID');
          reportedCount = response.page.reportedCount;
        } else {
          if (canonicalJson(appliedWindow) !== canonicalJson(response.appliedWindow)) {
            return finishIncomplete('APPLIED_WINDOW_CHANGED', {
              nextCursor: response.page.nextCursor,
            });
          }
          if (reportedCount !== response.page.reportedCount) {
            return finishIncomplete('REPORTED_COUNT_CHANGED', {
              nextCursor: response.page.nextCursor,
            });
          }
        }
        items.push(...response.items);
        currentCursor = response.page.nextCursor;

        if (elapsed(started, runtime) > budget.wallClockMs) {
          return finishIncomplete('BUDGET_WALL_CLOCK', { nextCursor: currentCursor });
        }
        if (responseBytes > budget.maximumResponseBytes) {
          return finishIncomplete('BUDGET_MAXIMUM_RESPONSE_BYTES', { nextCursor: currentCursor });
        }
        if (items.length > budget.maximumRecords) {
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
