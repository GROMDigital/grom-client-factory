/**
 * The GHL PUBLIC TRANSLATOR — the seam between the bounded adapter and a real GHL MCP server.
 *
 * `lib/adapters/public-ghl.mjs` sends ONE generic request shape for every approved read:
 *
 *     { name: 'execute_action', arguments: { action, params: { locationId, fromDate, toDate,
 *       cursor } } }
 *
 * and REQUIRES one normalised response shape back:
 *
 *     { locationId, appliedWindow, items, page: { cursor, nextCursor, reportedCount, complete,
 *       truncated } }
 *
 * A real GoHighLevel MCP server does neither: it takes endpoint-native parameters (`pageLimit`,
 * `searchAfter`, `startAfterDate`, `lastMessageId`, `startTime`/`endTime` in millis) and returns
 * raw GHL bodies (`{ contacts, total }`, `{ opportunities, meta }`, `{ events }`…). The original
 * plan put a normalising `ghl-public-mcp` server in front of GHL. That server was never built, so
 * the same job is done HERE, in-process, at the transport seam `connectMcp` already exposes:
 * `lib/local-runtime.mjs` injects `transport.connect`, this module returns the delegate, and the
 * delegate translates in BOTH directions around the host's real GHL MCP client.
 *
 * Neither `public-ghl.mjs` nor `mcp-transport.mjs` is touched.
 *
 * ---------------------------------------------------------------------------------------------
 * THE CANONICAL REVENUE BASIS FOR THIS AUDIT IS THE OPPORTUNITY `monetaryValue`.
 * GHL PAYMENTS DATA IS NEVER AUTHORITATIVE FOR REVENUE.
 *
 * The reason is NOT that payments happens to hold deposits today. That is one arrangement, for
 * one kind of client, at one moment, and it will change. The reason is structural: WHAT a GHL
 * account's payments surface captures varies per client and varies over time — which products are
 * sold through it, which are invoiced outside it, which are taken in clinic, which are financed by
 * a third party, whether a link is a deposit or a balance or a full fee. A number whose meaning is
 * a per-account, per-era configuration accident cannot be a revenue source. It is not a question
 * of accuracy; it is a question of what the field denotes, and that is not stable.
 *
 * So the two `payments-v3__*` entries stay APPROVED in the read catalog and have NO translator
 * here, and asking for one fails explicitly (`GHL_ACTION_NOT_TRANSLATED`) rather than returning an
 * empty item list. If payments is ever translated later, it is a signal about PAYMENT BEHAVIOUR
 * only — timing, method, failure, retry — and it must never be summed and labelled revenue.
 * ---------------------------------------------------------------------------------------------
 *
 * `monetaryValue` is therefore the single most important field in the entire collection, and an
 * engine in this workspace has been seen writing it as a STRING (which renders empty downstream).
 * It is NEVER coerced here. See `annotateRecord`: the value is preserved byte-for-byte exactly as
 * GHL returned it, and a non-finite-number value is surfaced as an explicit per-item data-quality
 * signal so it can never be read as zero.
 *
 * ---------------------------------------------------------------------------------------------
 * WHY ONE NORMALISED PAGE PER SCOPE
 *
 * The adapter enforces two things about `reportedCount`: it must be IDENTICAL on every page of a
 * scope (`REPORTED_COUNT_CHANGED`), and at the terminal page it must EQUAL the number of items
 * collected (`REPORTED_COUNT_MISMATCH`). Multi-page therefore requires knowing the exact final
 * total BEFORE the first page is returned. No GHL endpoint gives one that survives our own window
 * filtering, and the bundled catalog documents no response schemas at all, so any total we quoted
 * would be a guess that turns every scope into `complete_partial`.
 *
 * So the translator EXHAUSTS a scope upstream and returns exactly one normalised page whose
 * `reportedCount` is `items.length` by construction. Boundedness is preserved rather than
 * bypassed: the translator reads the SAME versioned per-category budget the adapter reads
 * (`profiles/collection-budgets.v1.json`) and stops on request count, record count, accumulated
 * bytes, the caller's abort signal, or a deadline derived from the adapter's own request timeout.
 * When it stops early it returns `truncated: true` with an opaque resume cursor, which the adapter
 * records as an honest `TRUNCATED` incompleteness — never as "there was nothing there".
 */
import { canonicalJson } from '../canonical.mjs';
import { codedError } from './collection.mjs';
import { loadCollectionBudgets } from '../../schemas/v1.mjs';

/** Upstream page size. GHL documents 100 as the maximum for the list reads we use. */
const UPSTREAM_PAGE_LIMIT = 100;
/** Calendar-event window chunk. See `calendarEventChunks`. */
const CALENDAR_CHUNK_DAYS = 7;
const DAY_MS = 86_400_000;
/**
 * Fraction of the adapter's own request timeout the translator will spend before it stops and
 * hands back a resume cursor. Without this the adapter's timer fires mid-scope and the whole page
 * — and every upstream response already paid for — is discarded with no resume state at all.
 */
const DEADLINE_FRACTION = 0.8;
const MINIMUM_DEADLINE_MS = 1_000;

function isPlainObject(value) {
  return Boolean(
    value
    && typeof value === 'object'
    && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null),
  );
}

function fail(code) {
  return codedError(code);
}

// ---------------------------------------------------------------------------
// Opaque cursor
// ---------------------------------------------------------------------------

/**
 * The adapter treats the cursor as an opaque string, so it can carry whatever per-endpoint paging
 * state that endpoint actually uses — a `searchAfter` array, a `startAfterDate` sort value, a
 * `lastMessageId`, an opaque provider cursor, or a `(calendarIndex, chunkIndex)` position. It is
 * canonical JSON so the same state always encodes to the same string and a resume is deterministic.
 */
function encodeCursor(actionId, state) {
  return Buffer.from(
    canonicalJson({ action: actionId, state, version: 1 }),
    'utf8',
  ).toString('base64url');
}

function decodeCursor(actionId, cursor) {
  let decoded;
  try {
    decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw fail('GHL_TRANSLATION_CURSOR_INVALID');
  }
  if (
    !isPlainObject(decoded)
    || decoded.version !== 1
    || decoded.action !== actionId
    || !isPlainObject(decoded.state)
  ) throw fail('GHL_TRANSLATION_CURSOR_INVALID');
  return decoded.state;
}

// ---------------------------------------------------------------------------
// Upstream response reading
// ---------------------------------------------------------------------------

/** Unwraps an MCP tool result into the JSON body the GHL server returned. */
export function parseUpstreamResult(response) {
  let value = response;
  if (isPlainObject(response) && isPlainObject(response.structuredContent)) {
    value = response.structuredContent;
  } else if (isPlainObject(response) && Array.isArray(response.content)) {
    const text = response.content.find((entry) => entry?.type === 'text')?.text;
    if (typeof text !== 'string') throw fail('GHL_UPSTREAM_RESPONSE_INVALID');
    try {
      value = JSON.parse(text);
    } catch {
      throw fail('GHL_UPSTREAM_RESPONSE_INVALID');
    }
  }
  if (!isPlainObject(value)) throw fail('GHL_UPSTREAM_RESPONSE_INVALID');
  return value;
}

/**
 * Finds the record array. The candidate KEYS are per-endpoint; the containers are the three
 * envelopes an MCP server plausibly wraps a GHL body in. An unrecognised shape THROWS: returning
 * `[]` here would be indistinguishable from a genuinely empty account, which is the one failure
 * this module exists to prevent.
 */
function pickRecords(body, keys) {
  for (const container of [body, body.data, body.body, body.result, body.response]) {
    if (!isPlainObject(container)) continue;
    for (const key of keys) {
      if (Array.isArray(container[key])) return container[key];
    }
  }
  throw fail('GHL_RESPONSE_SHAPE_UNRECOGNISED');
}

/** A server-declared total, when one is offered. Recorded as a SIGNAL; never used as a count. */
function pickServerTotal(body) {
  for (const container of [body, body.data, body.meta, body.data?.meta]) {
    if (!isPlainObject(container)) continue;
    for (const key of ['total', 'totalCount', 'count']) {
      const value = container[key];
      if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
    }
  }
  return null;
}

function pickPath(body, key) {
  for (const container of [body, body.data, body.meta, body.data?.meta]) {
    if (isPlainObject(container) && container[key] !== undefined && container[key] !== null) {
      return container[key];
    }
  }
  return null;
}

function recordId(record) {
  if (!isPlainObject(record)) return null;
  for (const key of ['id', '_id', 'eventId', 'messageId', 'conversationId']) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Timestamps and the window
// ---------------------------------------------------------------------------

const CREATED_FIELDS = Object.freeze([
  'dateAdded', 'createdAt', 'dateCreated', 'created_at', 'addedAt', 'startTime', 'startAt',
]);
const UPDATED_FIELDS = Object.freeze([
  'dateUpdated', 'updatedAt', 'lastMessageDate', 'updated_at',
]);

function toEpochMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.length > 0) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
    const numeric = Number(value);
    if (Number.isFinite(numeric) && /^\d+$/u.test(value)) return numeric;
  }
  return null;
}

/** `{ epochMs, basis }` where basis is 'created' | 'updated' | null. */
function recordTimestamp(record) {
  if (!isPlainObject(record)) return { epochMs: null, basis: null };
  for (const field of CREATED_FIELDS) {
    const epochMs = toEpochMs(record[field]);
    if (epochMs !== null) return { epochMs, basis: 'created' };
  }
  for (const field of UPDATED_FIELDS) {
    const epochMs = toEpochMs(record[field]);
    if (epochMs !== null) return { epochMs, basis: 'updated' };
  }
  return { epochMs: null, basis: null };
}

// ---------------------------------------------------------------------------
// Per-item data quality — `monetaryValue` above all
// ---------------------------------------------------------------------------

const QUALITY_KEY = '$auditDataQuality';

/**
 * Returns the record with its raw fields UNCHANGED, plus a namespaced annotation array when
 * something about it needs to be visible downstream.
 *
 * `monetaryValue` is the case this exists for. It is the canonical revenue basis (see the module
 * header), it has been observed written as a STRING by an engine in this workspace, and a string
 * renders empty — i.e. it reads as ZERO — everywhere downstream. It is NOT coerced, NOT parsed and
 * NOT defaulted: the original value survives byte-for-byte and the fact that it is not a finite
 * number travels WITH it as an explicit signal.
 *
 * If a record already owns the annotation key the record is passed through untouched rather than
 * clobbered; the scope-level counters below still record the observation, so nothing is lost.
 */
function annotateRecord(record, counters) {
  if (!isPlainObject(record)) return record;
  const notes = [];
  if (Object.hasOwn(record, 'monetaryValue')) {
    const value = record.monetaryValue;
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      counters.monetaryValueNotFinite += 1;
      notes.push({
        code: 'MONETARY_VALUE_NOT_FINITE',
        field: 'monetaryValue',
        observedType: value === null ? 'null' : typeof value,
      });
    }
  }
  if (notes.length === 0) return record;
  if (Object.hasOwn(record, QUALITY_KEY)) return record;
  return { ...record, [QUALITY_KEY]: notes };
}

function newCounters() {
  return {
    monetaryValueNotFinite: 0,
    duplicateIdsDropped: 0,
    outsideWindowDropped: 0,
    withoutTimestampKept: 0,
    updatedBasisUsed: 0,
    serverReportedTotal: null,
    upstreamRequests: 0,
    parentCalendarsResolved: null,
    paginationCursorUnavailable: false,
  };
}

// ---------------------------------------------------------------------------
// Endpoint plans
// ---------------------------------------------------------------------------

/**
 * `windowFilter`:
 *   'server'   — the bundled spec VERIFIES a date parameter with an unambiguous type, so the
 *                window is applied upstream and the records are taken as given.
 *   'client'   — no date parameter whose FORMAT the spec pins down, so nothing unverified is sent
 *                and the window is applied here, on the records themselves.
 *   'chunked'  — the endpoint has required, verified millisecond bounds and no pagination, so the
 *                window IS the pagination. See `calendarEventChunks`.
 *   'none'     — configuration state, not a time series. Calendars and pipelines are what the
 *                account IS, not what happened during the week.
 */
const PLANS = Object.freeze({
  'contacts.search': {
    upstreamAction: 'contacts-v3__search-contacts-advanced',
    category: 'contacts',
    recordKeys: ['contacts'],
    windowFilter: 'client',
    initialState: () => ({ searchAfter: null }),
    request: (state, { locationId }) => ({
      locationId,
      pageLimit: UPSTREAM_PAGE_LIMIT,
      ...(state.searchAfter === null ? {} : { searchAfter: state.searchAfter }),
    }),
    advance: (state, body, records) => {
      if (records.length < UPSTREAM_PAGE_LIMIT) return null;
      const last = records.at(-1);
      const searchAfter = Array.isArray(last?.searchAfter) && last.searchAfter.length > 0
        ? last.searchAfter
        : pickPath(body, 'searchAfter');
      if (!Array.isArray(searchAfter) || searchAfter.length === 0) return 'EXHAUSTED_WITHOUT_CURSOR';
      if (canonicalJson(searchAfter) === canonicalJson(state.searchAfter)) return null;
      return { searchAfter };
    },
  },

  'opportunities.list': {
    upstreamAction: 'opportunities-v3__search-opportunity',
    category: 'opportunities',
    recordKeys: ['opportunities'],
    windowFilter: 'client',
    initialState: () => ({ startAfter: null, startAfterId: null }),
    request: (state, { locationId }) => ({
      locationId,
      limit: UPSTREAM_PAGE_LIMIT,
      // `status` is a VERIFIED enum on this endpoint and `all` is one of its values. Without it
      // the default is unstated, and a default of `open` would silently exclude every won and
      // lost opportunity — i.e. every opportunity that carries realised `monetaryValue`.
      status: 'all',
      ...(state.startAfter === null ? {} : { startAfter: state.startAfter }),
      ...(state.startAfterId === null ? {} : { startAfterId: state.startAfterId }),
    }),
    advance: (state, body, records) => {
      if (records.length < UPSTREAM_PAGE_LIMIT) return null;
      const startAfter = pickPath(body, 'startAfter');
      const startAfterId = pickPath(body, 'startAfterId');
      if (startAfter === null || startAfterId === null) return 'EXHAUSTED_WITHOUT_CURSOR';
      if (
        canonicalJson(startAfter) === canonicalJson(state.startAfter)
        && startAfterId === state.startAfterId
      ) return null;
      return { startAfter, startAfterId };
    },
  },

  'opportunities-v3__get-pipelines': {
    upstreamAction: 'opportunities-v3__get-pipelines',
    category: 'opportunities',
    recordKeys: ['pipelines'],
    windowFilter: 'none',
    initialState: () => ({ single: true }),
    request: (_state, { locationId }) => ({ locationId }),
    advance: () => null,
  },

  'calendars-v3__get-calendars': {
    upstreamAction: 'calendars-v3__get-calendars',
    category: 'appointments',
    recordKeys: ['calendars'],
    windowFilter: 'none',
    initialState: () => ({ single: true }),
    request: (_state, { locationId }) => ({ locationId }),
    advance: () => null,
  },

  'conversations-v3__search-conversation': {
    upstreamAction: 'conversations-v3__search-conversation',
    category: 'conversations',
    recordKeys: ['conversations'],
    // VERIFIED from the bundled spec: `startDate` and `endDate` are `number`, "Unix timestamp in
    // milliseconds", filtering `dateAdded`. Unambiguous, so the window goes upstream.
    windowFilter: 'server',
    initialState: () => ({ startAfterDate: null }),
    request: (state, { locationId, fromMs, toMs }) => ({
      locationId,
      limit: UPSTREAM_PAGE_LIMIT,
      startDate: fromMs,
      endDate: toMs,
      ...(state.startAfterDate === null ? {} : { startAfterDate: state.startAfterDate }),
    }),
    advance: (state, body, records) => {
      if (records.length < UPSTREAM_PAGE_LIMIT) return null;
      const last = records.at(-1);
      // "should contain the sort value of the last document" — with no `sortBy` set the sort value
      // is the last-message date. `sortValue` is preferred when the server offers it explicitly.
      const startAfterDate = [last?.sortValue, last?.lastMessageDate, last?.dateUpdated, last?.dateAdded]
        .map((value) => toEpochMs(value))
        .find((value) => value !== null) ?? null;
      if (startAfterDate === null) return 'EXHAUSTED_WITHOUT_CURSOR';
      if (startAfterDate === state.startAfterDate) return null;
      return { startAfterDate };
    },
  },

  'conversations-v3__export-messages-by-location': {
    upstreamAction: 'conversations-v3__export-messages-by-location',
    category: 'conversations',
    recordKeys: ['messages'],
    // `startDate`/`endDate` exist here too but the spec types them only as `string` and pins no
    // format. Sending a guessed format risks a 422 that fails the whole scope, so nothing
    // unverified is sent; the window is applied here and `sortOrder: desc` (a VERIFIED enum) lets
    // the walk stop as soon as it passes the start of the window.
    windowFilter: 'client',
    earlyStopOlderThanFrom: true,
    initialState: () => ({ cursor: null }),
    request: (state, { locationId }) => ({
      locationId,
      limit: UPSTREAM_PAGE_LIMIT,
      sortBy: 'createdAt',
      sortOrder: 'desc',
      ...(state.cursor === null ? {} : { cursor: state.cursor }),
    }),
    advance: (state, body, records) => {
      // The one endpoint in the set with a REAL opaque cursor: the request parameter's own
      // description says to pass `nextCursor` from the previous response. Drop-in.
      const nextCursor = pickPath(body, 'nextCursor');
      if (typeof nextCursor !== 'string' || nextCursor.length === 0) {
        return records.length < UPSTREAM_PAGE_LIMIT ? null : 'EXHAUSTED_WITHOUT_CURSOR';
      }
      if (nextCursor === state.cursor) return null;
      return { cursor: nextCursor };
    },
  },

  'calendars-v3__get-calendar-events': {
    upstreamAction: 'calendars-v3__get-calendar-events',
    category: 'appointments',
    recordKeys: ['events'],
    windowFilter: 'chunked',
    // Resolved parent + chunk walk; see `calendarEventInitialState` / `calendarEventChunks`.
    initialState: calendarEventInitialState,
    request: (state, { locationId }) => ({
      locationId,
      calendarId: state.calendarIds[state.calendarIndex],
      startTime: String(state.chunks[state.chunkIndex][0]),
      // The chunk grid is half-open in millisecond space. GHL does not document whether
      // `endTime` is inclusive, so the last millisecond is withheld and the grid can never
      // present the same instant to two chunks. Any residual overlap (recurring instances,
      // clock skew) is removed by the id de-duplication every plan runs.
      endTime: String(state.chunks[state.chunkIndex][1] - 1),
    }),
    advance: (state) => {
      const chunkIndex = state.chunkIndex + 1;
      if (chunkIndex < state.chunks.length) return { ...state, chunkIndex };
      const calendarIndex = state.calendarIndex + 1;
      if (calendarIndex < state.calendarIds.length) {
        return { ...state, calendarIndex, chunkIndex: 0 };
      }
      return null;
    },
  },
});

/**
 * Reads that are APPROVED in the catalog but cannot be driven from `{locationId, fromDate,
 * toDate}` alone, with the sibling read that covers the same ground and IS translated. Asking for
 * one of these is a configuration error and is refused explicitly — the whole point is that it
 * must never come back as an empty item list, which would read as "there were none".
 */
export const NOT_COLLECTABLE_IN_THIS_SHAPE = Object.freeze({
  'conversations-v3__get-messages':
    'requires a conversationId; use conversations-v3__export-messages-by-location, which is location-scoped',
  'contacts-v3__get-appointments-for-contact':
    'requires a contactId; use calendars-v3__get-calendar-events, which is location-scoped',
  'calendars-v3__get-appointment':
    'requires an eventId; use calendars-v3__get-calendar-events, which is location-scoped',
});

/**
 * Approved reads with NO translator at all. See the canonical-revenue-basis rule in the module
 * header for why payments is here and why it is not a gap to be closed casually.
 */
export const NOT_TRANSLATED = Object.freeze({
  'payments-v3__list-orders':
    'payments is never authoritative for revenue; the canonical basis is opportunity monetaryValue',
  'payments-v3__list-transactions':
    'payments is never authoritative for revenue; the canonical basis is opportunity monetaryValue',
});

export function translatedActionIds() {
  return Object.freeze(Object.keys(PLANS).sort());
}

/**
 * Preflight. Runs in the composition root BEFORE any transport is connected, so a configuration
 * that names an untranslatable capability fails with a clear code and makes no live call at all,
 * instead of dying somewhere in the middle of a collection.
 */
export function assertTranslatableCapabilities(capabilities) {
  const offending = [];
  for (const capability of capabilities ?? []) {
    const actionId = capability?.actionId;
    if (typeof actionId !== 'string' || !Object.hasOwn(PLANS, actionId)) {
      offending.push(actionId ?? null);
    }
  }
  if (offending.length > 0) {
    const error = codedError('AUDIT_PREFLIGHT_FAILED_PUBLIC_CAPABILITY_NOT_TRANSLATED');
    error.actionIds = Object.freeze([...new Set(offending)].sort());
    throw error;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Calendar events — parent resolution and window chunking
// ---------------------------------------------------------------------------

/**
 * `calendars-v3__get-calendar-events` requires ONE of `calendarId`, `userId` or `groupId`, and
 * none of the three is derivable from `{locationId, fromDate, toDate}`. The translator therefore
 * RESOLVES THE PARENT LIST FIRST, with `calendars-v3__get-calendars` — the cheapest of the three
 * (one request, and a sub-account has a handful of calendars, not a handful of thousands).
 *
 * The resolved ids are carried INSIDE the opaque cursor, so a resume walks exactly the same
 * calendars in exactly the same order and never re-resolves against a list that may have changed.
 *
 * A resolution that comes back in an unrecognised shape THROWS. A location with genuinely zero
 * calendars yields zero events, which is a true answer and is recorded as such
 * (`parentCalendarsResolved: 0`) rather than being indistinguishable from a failed lookup.
 */
async function calendarEventInitialState(context) {
  const body = parseUpstreamResult(await context.call({
    action: PLANS['calendars-v3__get-calendars'].upstreamAction,
    params: { locationId: context.locationId },
  }));
  const calendars = pickRecords(body, PLANS['calendars-v3__get-calendars'].recordKeys);
  const calendarIds = [...new Set(
    calendars.map((calendar) => recordId(calendar)).filter((id) => id !== null),
  )].sort();
  context.counters.parentCalendarsResolved = calendarIds.length;
  context.counters.upstreamRequests += 1;
  if (calendarIds.length === 0) return null;
  return {
    calendarIds,
    calendarIndex: 0,
    chunks: calendarEventChunks(context.fromMs, context.toMs),
    chunkIndex: 0,
  };
}

/**
 * The window, cut into a fixed grid of half-open `[start, end)` millisecond ranges.
 *
 * This endpoint has NO pagination. Its only bound is the required `startTime`/`endTime` pair, so a
 * 90-day window on a busy account returns every event in one body and trips
 * `BUDGET_MAXIMUM_RESPONSE_BYTES` — the collection stops having learned nothing. Chunking turns the
 * window itself into the pagination: one upstream request per (calendar, chunk), each bounded by a
 * week of calendar time rather than by the size of the account.
 *
 * At a CHUNK BOUNDARY: the grid is half-open and `endTime` is the chunk end minus one millisecond,
 * so chunk N covers `[t0, t1)` and chunk N+1 starts at `t1` — no instant belongs to two chunks even
 * if GHL treats both bounds as inclusive. Any event that still appears twice (a recurring series
 * instance, an event mutated between two requests) is removed by id de-duplication, keeping the
 * FIRST occurrence, which is deterministic because calendars are walked in sorted id order and
 * chunks in ascending time order. The final chunk is clamped to the window end, so the grid covers
 * exactly `[from, to)` and never reads outside the requested window.
 */
export function calendarEventChunks(fromMs, toMs, chunkMs = CALENDAR_CHUNK_DAYS * DAY_MS) {
  const chunks = [];
  for (let start = fromMs; start < toMs; start += chunkMs) {
    chunks.push([start, Math.min(start + chunkMs, toMs)]);
  }
  return chunks;
}

// ---------------------------------------------------------------------------
// The scope walk
// ---------------------------------------------------------------------------

function budgetFor(category) {
  const budget = loadCollectionBudgets().capabilities[category];
  if (!budget) throw fail('COLLECTION_BUDGET_MISSING');
  return budget;
}

/**
 * Byte accounting for the walk's own bound. Deliberately `JSON.stringify` and not `canonicalJson`:
 * this number decides when to STOP, not what to hash, and `canonicalJson` REFUSES values it cannot
 * canonicalise (a non-finite number, a `-0`). Refusing to measure a page is not a reason to abandon
 * a collection — the value itself is preserved and, where it matters, flagged.
 */
function byteLength(value) {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8');
  } catch {
    throw fail('GHL_UPSTREAM_RESPONSE_INVALID');
  }
}

async function translateScope({ actionId, params, call, options, now }) {
  const plan = PLANS[actionId];
  if (!plan) {
    const reason = NOT_TRANSLATED[actionId] ?? NOT_COLLECTABLE_IN_THIS_SHAPE[actionId] ?? null;
    const error = codedError(
      Object.hasOwn(NOT_COLLECTABLE_IN_THIS_SHAPE, actionId)
        ? 'GHL_ACTION_NOT_COLLECTABLE_IN_THIS_SHAPE'
        : 'GHL_ACTION_NOT_TRANSLATED',
    );
    if (reason !== null) error.reason = reason;
    throw error;
  }
  const locationId = params.locationId;
  const fromMs = Date.parse(params.fromDate);
  const toMs = Date.parse(params.toDate);
  if (
    typeof locationId !== 'string'
    || locationId.length === 0
    || !Number.isFinite(fromMs)
    || !Number.isFinite(toMs)
    || fromMs >= toMs
  ) throw fail('GHL_TRANSLATION_REQUEST_INVALID');

  const budget = budgetFor(plan.category);
  const counters = newCounters();
  const context = { locationId, fromMs, toMs, call, counters };
  const timeout = Number.isFinite(options?.timeout) ? Number(options.timeout) : null;
  const deadline = timeout === null
    ? null
    : now() + Math.max(MINIMUM_DEADLINE_MS, Math.floor(timeout * DEADLINE_FRACTION));

  const requestedCursor = params.cursor ?? null;
  let state = requestedCursor === null
    ? await plan.initialState(context)
    : decodeCursor(actionId, requestedCursor);

  const items = [];
  const seenIds = new Set();
  let bytes = 0;
  let truncated = false;

  while (state !== null) {
    if (options?.signal?.aborted) throw fail('GHL_TRANSLATION_ABORTED');
    if (counters.upstreamRequests >= budget.maximumPages) {
      truncated = true;
      break;
    }
    if (deadline !== null && now() >= deadline) {
      truncated = true;
      break;
    }

    const body = parseUpstreamResult(await call({
      action: plan.upstreamAction,
      params: plan.request(state, context),
    }));
    counters.upstreamRequests += 1;
    const records = pickRecords(body, plan.recordKeys);
    bytes += byteLength(records);
    const serverTotal = pickServerTotal(body);
    if (serverTotal !== null && counters.serverReportedTotal === null) {
      counters.serverReportedTotal = serverTotal;
    }

    let recognisedTimestamps = 0;
    let sawOlderThanFrom = false;
    for (const record of records) {
      // The timestamp is read FIRST, for every record the page contained, including ones that are
      // about to be dropped as duplicates. `recognisedTimestamps` answers "does this endpoint's
      // payload expose a field we can place in time at all", and a page whose records happen to be
      // repeats must not be able to answer that question with "no".
      let epochMs = null;
      if (plan.windowFilter === 'client') {
        const timestamp = recordTimestamp(record);
        epochMs = timestamp.epochMs;
        if (epochMs !== null) {
          recognisedTimestamps += 1;
          if (timestamp.basis === 'updated') counters.updatedBasisUsed += 1;
          if (epochMs < fromMs) sawOlderThanFrom = true;
        }
      }
      const id = recordId(record);
      if (id !== null) {
        if (seenIds.has(id)) {
          counters.duplicateIdsDropped += 1;
          continue;
        }
        seenIds.add(id);
      }
      if (plan.windowFilter === 'client') {
        if (epochMs === null) {
          // KEPT, never dropped: a record we cannot place in time is a data-quality problem, not
          // evidence of absence, and dropping it is exactly how a scope quietly becomes empty.
          counters.withoutTimestampKept += 1;
        } else if (epochMs < fromMs || epochMs >= toMs) {
          counters.outsideWindowDropped += 1;
          continue;
        }
      }
      items.push(annotateRecord(record, counters));
    }

    if (plan.windowFilter === 'client' && records.length > 0 && recognisedTimestamps === 0) {
      // Every record in a non-empty page was untimeable, so this scope's window claim would be
      // fiction. Fail loudly rather than publish an unwindowed set as a windowed one.
      throw fail('GHL_WINDOW_FIELD_UNRECOGNISED');
    }

    const next = plan.advance(state, body, records, context);
    if (next === 'EXHAUSTED_WITHOUT_CURSOR') {
      // A FULL page came back and no next-page cursor could be derived. There is more data and no
      // way to reach it, which is truncation, not completion.
      counters.paginationCursorUnavailable = true;
      truncated = true;
      state = null;
      break;
    }
    if (plan.earlyStopOlderThanFrom === true && sawOlderThanFrom) {
      // Sorted newest-first, so everything beyond this point is older than the window.
      state = null;
      break;
    }
    if (
      items.length >= budget.maximumRecords
      || bytes >= budget.maximumResponseBytes
    ) {
      if (next !== null) truncated = true;
      state = next;
      break;
    }
    state = next;
  }

  return {
    locationId,
    // The applied window is the REQUESTED window for every plan. Incompleteness is carried by
    // `truncated` plus the resume cursor, not by narrowing the window, because a fan-out scope
    // (calendar events across N calendars) has no single interval to narrow TO: different parents
    // can stop at different points, and a single `{from,to}` cannot say that honestly.
    appliedWindow: { from: params.fromDate, to: params.toDate },
    items,
    page: {
      cursor: requestedCursor,
      nextCursor: truncated && state !== null ? encodeCursor(actionId, state) : null,
      // Equal to `items.length` BY CONSTRUCTION. See the module header: the adapter requires a
      // count that is constant across pages and exact at the terminal page, and no GHL total
      // survives our own window filtering, so the scope is exhausted upstream and counted here.
      reportedCount: items.length,
      complete: !truncated,
      truncated,
    },
    dataQuality: {
      actionId,
      upstreamAction: plan.upstreamAction,
      windowFilter: plan.windowFilter,
      ...counters,
    },
  };
}

// ---------------------------------------------------------------------------
// The transport seam
// ---------------------------------------------------------------------------

/**
 * Wraps a connect that yields a RAW GHL MCP client and returns a connect that yields a delegate
 * speaking the bounded adapter's dialect. `lib/local-runtime.mjs` hands the result to
 * `connectMcp` as `transport.connect`, which is the seam that already exists.
 *
 * Nothing here reads, logs, stores or returns a credential: `connectMcp` resolves the credential
 * and passes it to the underlying connect, and the value never enters this module's own state.
 */
export function createGhlTranslatingConnect({ connect, runtime = {} } = {}) {
  if (typeof connect !== 'function') throw codedError('MCP_TRANSPORT_INVALID', TypeError);
  const now = typeof runtime.now === 'function' ? () => Number(runtime.now()) : () => Date.now();
  return async function translatingConnect(transportOptions) {
    const delegate = await connect(transportOptions);
    if (!delegate || typeof delegate.callTool !== 'function') {
      throw codedError('MCP_CONNECTION_FAILED');
    }
    return Object.freeze({
      async callTool(request, options) {
        if (
          !isPlainObject(request)
          || request.name !== 'execute_action'
          || !isPlainObject(request.arguments)
          || !isPlainObject(request.arguments.params)
        ) throw fail('GHL_TRANSLATION_REQUEST_INVALID');
        const structured = await translateScope({
          actionId: request.arguments.action,
          params: request.arguments.params,
          // Every upstream call carries the caller's own signal and timeout, so the adapter's
          // budget still governs the wire even though one adapter request is now N of them.
          call: (upstream) => delegate.callTool(
            { name: 'execute_action', arguments: upstream },
            options,
          ),
          options,
          now,
        });
        return { structuredContent: structured };
      },
      async close() {
        await delegate.close?.();
      },
    });
  };
}
