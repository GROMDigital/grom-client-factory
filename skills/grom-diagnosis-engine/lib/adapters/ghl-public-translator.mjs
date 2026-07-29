/**
 * The GHL PUBLIC TRANSLATOR — the seam between the bounded adapter and a real GHL MCP server.
 *
 * `lib/adapters/public-ghl.mjs` sends ONE generic request shape for every approved read — this is
 * OUR OWN internal dialect, and it stops here:
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
 * THE WORKER'S TOOL CONTRACT — BOTH DIRECTIONS OF IT LIVE IN THIS MODULE.
 *
 * This module already owned the worker contract on the way IN: `parseUpstreamResult` knows that
 * `structuredContent` is the worker's ENVELOPE (`{ ok, status, data, filter, pagination, error }`)
 * and that `filter` / `pagination` are the worker's own response-SHAPING channels. It did not own
 * it on the way OUT, and that split is exactly what broke a live run.
 *
 * The worker's `execute_action` tool takes:
 *
 *     { name: 'execute_action', arguments: { action_id: '<upstream action id>', params: { ... } } }
 *
 * `action_id`. NOT `action`. Every upstream call this repo has ever made named the key `action`,
 * so the worker's own zod refused every one of them before it ran —
 *
 *     { "code": "invalid_type", "path": ["action_id"],
 *       "message": "Invalid input: expected string, received undefined" }
 *
 * — and no hermetic double could see it, because every double in the suite dispatched on whatever
 * key it was handed. The single place the outgoing envelope is built is `upstreamToolRequest`
 * below; `tests/ghl-wire-contract.test.mjs` pins it against a reproduction of the worker's own
 * argument validation rather than against a response double.
 *
 * The BOUNDARY is exact: everything ABOVE this module (the bounded adapter, `connectMcp`, and any
 * host that injects a normalised `transportConnect`) speaks `{ action, params }`, which is why
 * `tests/adapters.test.mjs` still asserts that shape on `connectMcp`'s forward. Everything BELOW
 * — the delegate `createGhlTranslatingConnect` wraps, i.e. a raw GHL MCP client — speaks
 * `{ action_id, params }`. The translation between the two happens here and nowhere else.
 * ---------------------------------------------------------------------------------------------
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

/**
 * ---------------------------------------------------------------------------------------------
 * THE WORKER ENVELOPE. Established from five real responses captured off Grom's UK sub-account
 * (`contacts-v3__search-contacts-advanced`, `opportunities-v3__search-opportunity`,
 * `conversations-v3__search-conversation`, `calendars-v3__get-calendars`,
 * `calendars-v3__get-calendar-events`), NOT reasoned about.
 *
 * `structuredContent` is NOT the GHL body. It is the MCP worker's own envelope:
 *
 *     { action: { id, method, path, summary, category, risk }, status, ok, data, note, filter,
 *       pagination, error }
 *
 * The GHL body is ONE LEVEL DOWN, at `structuredContent.data`.
 *
 * WHAT THIS ACTUALLY BROKE — stated precisely, because the obvious answer is WRONG and was checked
 * by replaying the previous revision of this module against the captured responses.
 *
 * The previous `parseUpstreamResult` returned the ENVELOPE. That did NOT break the happy path:
 * `pickRecords` also searched `body.data`, and `pickPath` / `pickServerTotal` also searched
 * `body.data?.meta`, so on a SUCCESSFUL response the envelope was accidentally tolerated — a
 * replay collected all 159 opportunities across two pages, cursor and all.
 *
 * What it broke is the FAILURE path, and that is not a small thing. On an `ok: false` / non-2xx
 * envelope, `data` is not a GHL body, so `pickRecords` threw `GHL_RESPONSE_SHAPE_UNRECOGNISED` —
 * a SHAPE error for what was really an upstream REFUSAL. That code is not retryable, so
 * `lib/adapters/public-ghl.mjs:639` converted it into a bare `PUBLIC_COLLECTION_FAILED` carrying
 * no status, no action and no reason. Every upstream rejection — a bad parameter, a 401, a 422 —
 * arrived looking identical to "GHL returned something we have never seen". Verified by replay.
 *
 * So the envelope is now unwrapped, and — the part that actually matters — its failure channel is
 * read FIRST and raised as `GHL_UPSTREAM_ACTION_FAILED` with the HTTP status attached.
 *
 * THE ENVELOPE IS STRIPPED, NOT FORWARDED, and that is deliberate:
 *
 *  - `action.method` is `"POST"` for `contacts-v3__search-contacts-advanced` (it is
 *    `POST /contacts/search` — a read semantically, which the worker still labels
 *    `risk.kinds: ["write"]`). `lib/kernel.mjs` `assertSafeCollected` throws
 *    `AUDIT_INTEGRITY_FAILURE_WRITE_OR_RAW_TRACE` on any key normalising to `method` whose value
 *    is a write verb, so an envelope that reached collected evidence would KILL the run. Verified
 *    against the real capture: the `method` key exists ONLY in the envelope; nothing under `data`
 *    normalises to `method`, `rawrequest`, `authorization`, `cookie` or `mutationtool`.
 *  - `action.risk.kinds: ["write"]` would additionally misrepresent an approved read as a write
 *    in any downstream risk accounting.
 *  - Nothing else in the envelope describes the ACCOUNT. It describes OUR CALL, which is already
 *    recorded as `dataQuality.upstreamAction`.
 *
 * `traceId` IS retained — but it comes from the GHL body (`data.traceId`), not the envelope, so
 * retaining it costs nothing and gives a live run something to quote at GHL support. See
 * `counters.upstreamTraceIds`.
 * ---------------------------------------------------------------------------------------------
 */

/**
 * Recognises the worker envelope WITHOUT depending on `action`, so a worker that trims its
 * metadata still unwraps. `ok` + `data` together are the discriminator; no GHL list body carries
 * an `ok` field.
 */
function isWorkerEnvelope(value) {
  return isPlainObject(value)
    && Object.hasOwn(value, 'ok')
    && Object.hasOwn(value, 'data');
}

/**
 * The envelope's failure channel. `ok: false`, a non-2xx `status` (it is an HTTP status, so a 404
 * or a 422 can arrive with `ok` still set), or a populated `error` all mean the read did not
 * happen — and must NOT be parsed as data, because `data` on a failure is not a GHL body.
 *
 * THE STATUS IS TRANSLATED INTO THE CODES THE ADAPTER ALREADY UNDERSTANDS, and that matters more
 * than it looks. `lib/adapters/public-ghl.mjs:636-639` treats `RATE_LIMITED` as a clean stop with a
 * resume cursor, `RETRYABLE` as worth another attempt inside the retry budget, and EVERYTHING ELSE
 * as a fatal `PUBLIC_COLLECTION_FAILED`. The GHL MCP worker rate-limits at 60 execute calls per
 * minute, while a single scope here can walk up to `budget.maximumPages` requests plus one per
 * (calendar x week) chunk — so a 429 is not a remote possibility, it is the expected outcome of a
 * busy account. Left untranslated it would abort the whole audit instead of parking it.
 *
 *   429            -> RATE_LIMITED  (stop this scope cleanly; never hammer a throttled account)
 *   5xx            -> RETRYABLE     (the adapter's own retry budget governs)
 *   anything else  -> GHL_UPSTREAM_ACTION_FAILED (a real refusal: bad parameter, auth, not found)
 *
 * Nothing from the failure body is interpolated into the error beyond the numeric status: the
 * worker echoes request parameters into `error`, and a coded throw must never carry account data.
 */
function assertEnvelopeSucceeded(envelope) {
  const status = typeof envelope.status === 'number' ? envelope.status : null;
  const failed = envelope.ok !== true
    || (status !== null && (status < 200 || status > 299))
    || (envelope.error !== undefined && envelope.error !== null);
  if (!failed) return;
  let code = 'GHL_UPSTREAM_ACTION_FAILED';
  if (status === 429) code = 'RATE_LIMITED';
  else if (status !== null && status >= 500 && status <= 599) code = 'RETRYABLE';
  const error = codedError(code);
  error.upstreamStatus = status;
  throw error;
}

/**
 * The worker offers response SHAPING (`result_filter`, `result_fields`, `result_offset`,
 * `result_limit`), echoed back as `filter` / `pagination`. We never send those parameters, so both
 * are `null` on every captured response. If either is ever populated the array we were handed is a
 * SUBSET the worker chose, our `reportedCount === items.length` claim becomes a lie, and the scope
 * would silently under-report. Fail loudly instead.
 */
function assertEnvelopeUnshaped(envelope) {
  if (
    (envelope.filter !== undefined && envelope.filter !== null)
    || (envelope.pagination !== undefined && envelope.pagination !== null)
  ) throw fail('GHL_UPSTREAM_RESPONSE_SHAPED');
}

/**
 * Unwraps an MCP tool result into the GHL body — through the worker envelope when one is present.
 *
 * A bare GHL body (no `ok`/`data` pair) is returned unchanged, so a differently-shaped MCP server,
 * and every hermetic double in the test suite, still work.
 */
export function parseUpstreamResult(response) {
  let value = response;
  /**
   * THE TOOL-LEVEL REFUSAL, and it is a different animal from an envelope failure.
   *
   * When the worker rejects the CALL rather than the action — bad arguments, a missing
   * `action_id`, an unrecognised key — MCP answers with a tool error, not a payload:
   *
   *     { content: [{ type: 'text', text: '<zod issues, or anything at all>' }], isError: true }
   *
   * There is NO `structuredContent`, so the text branch below used to try to parse it: sometimes
   * it was not JSON (`GHL_UPSTREAM_RESPONSE_INVALID`), sometimes it parsed to an array
   * (`GHL_UPSTREAM_RESPONSE_INVALID` again). Either way an explicit REFUSAL arrived looking
   * exactly like "the server sent us something we have never seen", and downstream that became a
   * bare `PUBLIC_COLLECTION_FAILED`. That is precisely the reply a live run received and could not
   * name.
   *
   * Recognised FIRST and raised as a refusal. The text is never read, never parsed and never
   * attached: it is where the worker echoes the request parameters back.
   */
  if (isPlainObject(response) && response.isError === true) {
    throw fail('GHL_UPSTREAM_TOOL_REFUSED');
  }
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
  if (!isWorkerEnvelope(value)) return value;
  assertEnvelopeSucceeded(value);
  assertEnvelopeUnshaped(value);
  const body = value.data;
  if (typeof body === 'string') {
    // OBSERVED on the real capture: for a large payload the worker's TEXT channel renders `data`
    // as a pretty-printed, TRUNCATED string with a trailing "showing N of M items" note, while
    // `structuredContent` stays complete. Parsing that string would silently drop records, so a
    // string body is refused rather than salvaged. `structuredContent` is always preferred above.
    throw fail('GHL_UPSTREAM_RESPONSE_TRUNCATED');
  }
  if (!isPlainObject(body)) throw fail('GHL_UPSTREAM_RESPONSE_INVALID');
  return body;
}

/**
 * Finds the record array. The candidate KEYS are per-endpoint.
 *
 * REAL, from the captured responses — every container is at the ROOT of the GHL body, which is
 * what `parseUpstreamResult` now returns:
 *
 *     contacts        -> body.contacts   (+ body.total, body.traceId)
 *     opportunities   -> body.opportunities (+ body.meta, body.traceId)
 *     conversations   -> body.conversations (+ body.total, body.traceId)
 *     calendars       -> body.calendars  (+ body.traceId)
 *     calendar events -> body.events     (+ body.traceId)
 *
 * The extra containers are kept as tolerance for a differently-wrapped MCP server, but the root is
 * tried FIRST so the known shape always wins. An unrecognised shape THROWS: returning `[]` here
 * would be indistinguishable from a genuinely empty account, which is the one failure this module
 * exists to prevent.
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

/**
 * A server-declared total, when one is offered. Recorded as a SIGNAL; never used as a count.
 *
 * REAL: contacts and conversations put it at `body.total`; opportunities put it at
 * `body.meta.total` (159 on the UK account). Calendars and calendar events declare none.
 */
function pickServerTotal(body) {
  for (const container of [body, body.meta, body.data, body.data?.meta]) {
    if (!isPlainObject(container)) continue;
    for (const key of ['total', 'totalCount', 'count']) {
      const value = container[key];
      if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
    }
  }
  return null;
}

/**
 * A named field anywhere in the body's paging area.
 *
 * REAL: opportunity cursors are at `body.meta` — `{ total, nextPageUrl, startAfterId, startAfter,
 * currentPage, nextPage, prevPage }` — and NOT at the body root, which is why `body.meta` is
 * searched. Contacts and conversations declare NO body-level cursor at all; both are derived from
 * the last record instead (see their plans).
 */
function pickPath(body, key) {
  for (const container of [body, body.meta, body.data, body.data?.meta]) {
    if (isPlainObject(container) && container[key] !== undefined && container[key] !== null) {
      return container[key];
    }
  }
  return null;
}

/**
 * REAL: every one of the five captured responses carries `traceId` at the root of the GHL body.
 * It is the only upstream metadata worth keeping — it is what a support ticket quotes — and it is
 * account-neutral, so it travels in `dataQuality` rather than being discarded with the envelope.
 * Bounded so a long walk cannot grow an unbounded artifact.
 */
const MAXIMUM_TRACE_IDS = 32;

function recordTraceId(body, counters) {
  const traceId = body?.traceId;
  if (typeof traceId !== 'string' || traceId.length === 0) return;
  if (counters.upstreamTraceIds.length >= MAXIMUM_TRACE_IDS) return;
  if (counters.upstreamTraceIds.includes(traceId)) return;
  counters.upstreamTraceIds.push(traceId);
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
    // The ONLY upstream metadata kept. See `recordTraceId`; the worker envelope itself is stripped.
    upstreamTraceIds: [],
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
    // REAL, from the captured contacts response: the body root carries ONLY
    // `{ contacts, total, traceId }` — there is NO body-level cursor. Every contact instead
    // carries its own `searchAfter: [<number>, <its own id>]`, present on every row, so the
    // last-record derivation below is the real mechanism and the body-level lookup is only a
    // fallback for a differently-shaped server.
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
      //
      // CONFIRMED LIVE against the UK account, decisively: `status: 'bogus_value'` comes back
      // `ok: false`, so the enum IS validated server-side and `all` is genuinely accepted rather
      // than being ignored. `all` and omitting `status` both report total 159; `won` reports 0 and
      // `lost` reports 56. Sending it is therefore safe AND load-bearing.
      status: 'all',
      ...(state.startAfter === null ? {} : { startAfter: state.startAfter }),
      ...(state.startAfterId === null ? {} : { startAfterId: state.startAfterId }),
    }),
    /**
     * REAL, from the captured opportunities response: the cursors are at `body.meta`, NOT at the
     * body root —
     *
     *     meta: { total: 159, nextPageUrl, startAfterId: "<id>", startAfter: 1785099111627,
     *             currentPage: 1, nextPage: 2, prevPage: null }
     *
     * `pickPath` searches `body.meta`, so this resolves. It is worth being exact about the
     * history: this was NOT previously broken. The old `pickPath` also searched `body.data?.meta`,
     * which reached the same field through the un-stripped envelope, and a replay of the previous
     * revision paged correctly through all 159 of the UK account's opportunities. The change here
     * is that the lookup now points at the shape that is actually documented above rather than
     * finding it by accident two containers away.
     *
     * The last record's `sort` array is the same pair — VERIFIED on the capture,
     * `meta.startAfter === last.sort[0]` and `meta.startAfterId === last.sort[1]` — and is used as
     * a fallback so a body that ever drops `meta` still pages rather than truncating. Note
     * `startAfterId` is NOT the last row's `id`; it is whatever the server's sort key resolves to,
     * so it is only ever read, never reconstructed.
     */
    advance: (state, body, records) => {
      if (records.length < UPSTREAM_PAGE_LIMIT) return null;
      const last = records.at(-1);
      const sort = Array.isArray(last?.sort) && last.sort.length === 2 ? last.sort : null;
      const startAfter = pickPath(body, 'startAfter') ?? sort?.[0] ?? null;
      const startAfterId = pickPath(body, 'startAfterId') ?? sort?.[1] ?? null;
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
    // REAL: `body.calendars` (+ `body.traceId`). No total and no cursor — the account's calendars
    // come back in one body, three of them on the UK account.
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
    /**
     * REAL, from the captured conversations response: the body root carries only
     * `{ conversations, total: 176, traceId }` — NO body-level cursor, and NO `sortValue` on any
     * record. What each conversation DOES carry is `sort: [<number>]`, and on the capture
     * `sort[0] === lastMessageDate` exactly (and equals neither `dateUpdated` nor `dateAdded`), so
     * `sort[0]` is the server's own sort value and is read first. `lastMessageDate`, `dateUpdated`
     * and `dateAdded` are all epoch-millisecond NUMBERS here, not ISO strings.
     */
    advance: (state, body, records) => {
      if (records.length < UPSTREAM_PAGE_LIMIT) return null;
      const last = records.at(-1);
      const startAfterDate = [
        Array.isArray(last?.sort) && last.sort.length > 0 ? last.sort[0] : undefined,
        last?.sortValue,
        last?.lastMessageDate,
        last?.dateUpdated,
        last?.dateAdded,
      ]
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
    /*
     * 🔴 `startDate`/`endDate` ARE SENT, as ISO strings, and they DO filter. VERIFIED live against
     * SK Skin 2026-07-29: the same call with an ISO window returns only in-window records, and the
     * same call with epoch millis returns ZERO, so the format matters and ISO is the right one.
     * The previous comment here declined to send them at all rather than guess the format, which
     * left the whole week to be reached by paging backwards through unfiltered history.
     *
     * `windowFilter: 'client'` STAYS as belt and braces. The server filter is now the thing that
     * makes the walk short; the client filter is what makes the window claim true.
     */
    windowFilter: 'client',
    earlyStopOlderThanFrom: true,
    initialState: () => ({ cursor: null, lastFirstId: null }),
    request: (state, { locationId, fromMs, toMs }) => ({
      locationId,
      limit: UPSTREAM_PAGE_LIMIT,
      sortBy: 'createdAt',
      sortOrder: 'desc',
      startDate: new Date(fromMs).toISOString(),
      endDate: new Date(toMs).toISOString(),
      ...(state.cursor === null ? {} : { cursor: state.cursor }),
    }),
    advance: (state, body, records) => {
      const nextCursor = pickPath(body, 'nextCursor');
      if (typeof nextCursor !== 'string' || nextCursor.length === 0) {
        return records.length < UPSTREAM_PAGE_LIMIT ? null : 'EXHAUSTED_WITHOUT_CURSOR';
      }
      /*
       * 🔴 A REPEATED CURSOR IS NOT A LOOP HERE, and treating it as one is what silently truncated
       * every transcript read. This endpoint hands back a STABLE scroll handle: the identical
       * `nextCursor` string comes back on every page, and passing it again correctly returns the
       * NEXT page. The old guard (`nextCursor === state.cursor` -> stop) therefore ended the walk
       * after exactly two pages, cleanly and with no truncation flag, so the corpus was whatever
       * happened to sit in the newest 200 records and SHRANK as new traffic arrived. Measured on SK
       * Skin: 40 messages and 15 conversations reported for a week that really held 438 across 68,
       * published as a CENSUS.
       *
       * Progress is judged on the DATA instead: a page that opens on the same record as the last
       * one is not advancing, which is the real non-progress signal. A short page is the last page.
       * The walker's page and record budgets remain the outer bound.
       */
      const firstId = recordId(records[0]) ?? null;
      if (firstId !== null && firstId === state.lastFirstId) return null;
      if (records.length < UPSTREAM_PAGE_LIMIT) return null;
      return { cursor: nextCursor, lastFirstId: firstId };
    },
  },

  'calendars-v3__get-calendar-events': {
    upstreamAction: 'calendars-v3__get-calendar-events',
    category: 'appointments',
    /**
     * REAL: `body.events` (+ `body.traceId`). No total and no cursor, which is exactly why the
     * window has to be the pagination.
     *
     * Each event carries, verbatim: `appointmentStatus`, `appoinmentStatus` (GHL ships BOTH
     * spellings and the second is their own long-standing typo; on the capture the two always
     * agreed), `assignedUserId`, `address`, `calendarId`, `contactId`, `dateAdded`, `dateUpdated`,
     * `endTime`, `id`, `locationId`, `notes`, `description`, `startTime`, `title`,
     * `assignedResources`, `isRecurring`, `createdBy: { source, userId }`, `deleted`. Times are
     * ISO strings WITH an offset (not `Z`, not epoch millis). Records pass through unchanged; any
     * consumer that reads a status must tolerate both spellings.
     */
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
  /*
   * Approved, and deliberately NOT a journey capability. The email library is configuration and
   * copy, not a time series: it takes `limit`/`offset` and has no date parameter and no cursor, so
   * the journey request shape `{locationId, fromDate, toDate, cursor}` does not describe it.
   * `lib/adapters/email-copy.mjs` reads it on its own terms, against this same allowlist entry, as
   * part of the INTERNAL copy evidence the conversation lane is built from.
   */
  'emails__fetch-template':
    'the email library is configuration and copy, not a windowed time series; lib/adapters/email-copy.mjs reads it as internal copy evidence',
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

/**
 * THE ONE PLACE THE WORKER'S REQUEST ENVELOPE IS BUILT. See the module header.
 *
 * `action_id` is the key the worker's zod requires; naming it `action` is what made every live
 * upstream call fail before it ran. Exactly two arguments leave: no `policy` (the bounded
 * adapter's authorization record, which `connectMcp` already strips and the worker never
 * declared), no shaping channel (`result_filter` / `result_fields` / `result_offset` /
 * `result_limit` — see `assertEnvelopeUnshaped` for why we must never send one), and no `confirm`
 * or `dry_run`.
 */
export function upstreamToolRequest(actionId, params) {
  if (typeof actionId !== 'string' || actionId.length === 0) {
    throw fail('GHL_TRANSLATION_REQUEST_INVALID');
  }
  if (!isPlainObject(params)) throw fail('GHL_TRANSLATION_REQUEST_INVALID');
  return { name: 'execute_action', arguments: { action_id: actionId, params } };
}

/**
 * Approved reads carried to the worker verbatim, without a journey plan.
 *
 * Membership here does NOT make an action collectable as journey evidence: it stays listed in
 * `NOT_COLLECTABLE_IN_THIS_SHAPE` and out of `translatedActionIds()`, so the journey preflight
 * still refuses it. The two facts are separate and both are true: it may be called, and it may not
 * be collected as a scope.
 */
export const PASSTHROUGH_ACTIONS = new Set(['emails__fetch-template']);

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
    actionId: PLANS['calendars-v3__get-calendars'].upstreamAction,
    params: { locationId: context.locationId },
  }));
  recordTraceId(body, context.counters);
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
      actionId: plan.upstreamAction,
      params: plan.request(state, context),
    }));
    counters.upstreamRequests += 1;
    recordTraceId(body, counters);
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
        /*
         * THE ONE NON-JOURNEY PASSTHROUGH, and it is deliberately not a plan.
         *
         * `lib/adapters/mcp-transport.mjs` requires the bounded envelope on every call: it checks
         * `arguments.policy` against the trusted policy and refuses anything without one. So the
         * bounded dialect is mandatory on the wire, and this translator is the ONLY thing that
         * converts bounded into the worker's `{action_id, params}`. An approved read that is not a
         * journey read therefore still has to pass through here, or it cannot be called at all --
         * which is exactly what happened on the first live run of the email-copy rail
         * (`ACTION_NOT_ALLOWED`, after `MCP_TOOL_CALL_FAILED` before it).
         *
         * It is a PASSTHROUGH and not a `PLANS` entry on purpose. It is absent from
         * `translatedActionIds()`, so `assertTranslatableCapabilities` still refuses it as a
         * journey capability and it can never be collected as a scope, windowed, or projected. All
         * this does is carry an already-approved read to the worker in the worker's own dialect.
         */
        if (PASSTHROUGH_ACTIONS.has(request.arguments.action)) {
          return delegate.callTool(
            upstreamToolRequest(request.arguments.action, request.arguments.params),
            options,
          );
        }
        const structured = await translateScope({
          // INBOUND: our own dialect, `arguments.action`. See the module header for why the two
          // names are different and where the boundary between them is.
          actionId: request.arguments.action,
          params: request.arguments.params,
          // OUTBOUND: the worker's tool contract, `arguments.action_id`, built in exactly one
          // place. Every upstream call carries the caller's own signal and timeout, so the
          // adapter's budget still governs the wire even though one adapter request is now N.
          call: (upstream) => delegate.callTool(
            upstreamToolRequest(upstream.actionId, upstream.params),
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
