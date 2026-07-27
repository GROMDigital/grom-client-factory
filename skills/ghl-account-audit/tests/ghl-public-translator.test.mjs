/**
 * The GHL public translator.
 *
 * Every test here is HERMETIC. The "GHL MCP server" is a plain object whose `callTool` returns
 * literal bodies written in this file; no test opens a socket, spawns a process, reads a
 * credential, or touches a real GoHighLevel account. What they prove is the two directions of the
 * translation — our generic request out to endpoint-native parameters, their raw body back to the
 * `{items, page}` shape `lib/adapters/public-ghl.mjs` requires — plus the failure modes that must
 * never degrade into an empty item list.
 *
 * Response SHAPES are asserted against the bodies below, not against a verified GHL schema: the
 * bundled catalog documents request parameters only. Every shape assumption is listed in the
 * handoff and must be checked on the first live run.
 */
import assert from 'node:assert/strict';
import { createDecipheriv } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runAuditCli } from '../cli/audit.mjs';
import { canonicalJson, sha256 } from '../lib/canonical.mjs';
import {
  NOT_COLLECTABLE_IN_THIS_SHAPE,
  NOT_TRANSLATED,
  assertTranslatableCapabilities,
  calendarEventChunks,
  createGhlTranslatingConnect,
  translatedActionIds,
} from '../lib/adapters/ghl-public-translator.mjs';
import { auditPaths } from '../lib/paths.mjs';
import { openState } from '../lib/state.mjs';
import { loadPublicReadAllowlist } from '../schemas/v1.mjs';

const allowlist = loadPublicReadAllowlist();
const SNAPSHOT_HASH = allowlist.sourceSnapshotHash;
const ALLOWLIST_HASH = sha256(allowlist);
const MANIFEST_HASH = '8'.repeat(64);
const CUTOFF = 1_750_032_000_000;
const DAY_MS = 86_400_000;
const WINDOW = Object.freeze({
  from: new Date(CUTOFF - 90 * DAY_MS).toISOString(),
  to: new Date(CUTOFF).toISOString(),
});
const IN_WINDOW = new Date(CUTOFF - 10 * DAY_MS).toISOString();
const BEFORE_WINDOW = new Date(CUTOFF - 200 * DAY_MS).toISOString();
const VAULT_KEY_REFERENCE = 'test-only:key';
const PHASE_ENCRYPTION_KEY = Buffer.alloc(32, 0x31);

/**
 * Drives ONE translated scope against a hermetic GHL double and returns the normalised body plus
 * every upstream request the translator actually made.
 */
async function translate(actionId, handlers, {
  from = WINDOW.from,
  to = WINDOW.to,
  cursor = null,
  options,
  runtime,
} = {}) {
  const upstream = [];
  const connect = async () => ({
    async callTool(request, callOptions) {
      // `action_id` is the key the REAL worker requires (see the translator's module header). This
      // double stands in for a raw GHL MCP client, so it dispatches on the worker's key, not on
      // the adapter-side `action` this repo used to send. `upstream[].action` below keeps its
      // name: it records WHICH upstream action was called, which is what the assertions read.
      upstream.push({
        action: request.arguments.action_id,
        params: structuredClone(request.arguments.params),
        timeout: callOptions?.timeout ?? null,
      });
      const handler = handlers[request.arguments.action_id];
      if (!handler) throw new Error(`UNEXPECTED_UPSTREAM:${request.arguments.action_id}`);
      return handler(request.arguments.params, upstream.length);
    },
    async close() {},
  });
  const delegate = await createGhlTranslatingConnect({ connect, runtime })({ kind: 'stdio' });
  const result = await delegate.callTool({
    name: 'execute_action',
    arguments: { action: actionId, params: { locationId: 'L1', fromDate: from, toDate: to, cursor } },
  }, options);
  return { body: result.structuredContent, upstream };
}

async function translateRejects(actionId, handlers, code, extra = {}) {
  await assert.rejects(
    () => translate(actionId, handlers, extra),
    (error) => {
      assert.equal(error.code, code);
      return true;
    },
  );
}

// ---------------------------------------------------------------------------
// The catalog surface
// ---------------------------------------------------------------------------

test('exactly the seven location-drivable reads are translated, and the other five are named', () => {
  assert.deepEqual(translatedActionIds(), [
    'calendars-v3__get-calendar-events',
    'calendars-v3__get-calendars',
    'contacts.search',
    'conversations-v3__export-messages-by-location',
    'conversations-v3__search-conversation',
    'opportunities-v3__get-pipelines',
    'opportunities.list',
  ]);
  assert.deepEqual(Object.keys(NOT_TRANSLATED).sort(), [
    'payments-v3__list-orders',
    'payments-v3__list-transactions',
  ]);
  assert.deepEqual(Object.keys(NOT_COLLECTABLE_IN_THIS_SHAPE).sort(), [
    'calendars-v3__get-appointment',
    'contacts-v3__get-appointments-for-contact',
    'conversations-v3__get-messages',
  ]);
  // Together they account for every approved read in the catalog, so nothing is silently missing.
  assert.deepEqual(
    [
      ...translatedActionIds(),
      ...Object.keys(NOT_TRANSLATED),
      ...Object.keys(NOT_COLLECTABLE_IN_THIS_SHAPE),
    ].sort(),
    allowlist.actions.map(({ actionId }) => actionId).sort(),
  );
});

test('the preflight refuses an untranslated capability before any transport is connected', () => {
  assert.equal(assertTranslatableCapabilities([{ actionId: 'contacts.search' }]), true);
  for (const actionId of [
    'payments-v3__list-orders',
    'payments-v3__list-transactions',
    'conversations-v3__get-messages',
    'contacts-v3__get-appointments-for-contact',
    'calendars-v3__get-appointment',
  ]) {
    assert.throws(
      () => assertTranslatableCapabilities([{ actionId: 'contacts.search' }, { actionId }]),
      (error) => {
        assert.equal(error.code, 'AUDIT_PREFLIGHT_FAILED_PUBLIC_CAPABILITY_NOT_TRANSLATED');
        assert.deepEqual(error.actionIds, [actionId]);
        return true;
      },
    );
  }
});

test('payments and the parent-id reads FAIL rather than returning an empty item list', async () => {
  for (const actionId of Object.keys(NOT_TRANSLATED)) {
    await translateRejects(actionId, {}, 'GHL_ACTION_NOT_TRANSLATED');
  }
  for (const actionId of Object.keys(NOT_COLLECTABLE_IN_THIS_SHAPE)) {
    await translateRejects(actionId, {}, 'GHL_ACTION_NOT_COLLECTABLE_IN_THIS_SHAPE');
  }
});

// ---------------------------------------------------------------------------
// Request translation — our generic params out to endpoint-native ones
// ---------------------------------------------------------------------------

test('each of our action ids dispatches its endpoint-native upstream request', async () => {
  const cases = [
    {
      actionId: 'contacts.search',
      upstreamAction: 'contacts-v3__search-contacts-advanced',
      body: { contacts: [], total: 0 },
      expect: { locationId: 'L1', pageLimit: 100 },
    },
    {
      actionId: 'opportunities.list',
      upstreamAction: 'opportunities-v3__search-opportunity',
      body: { opportunities: [] },
      expect: { locationId: 'L1', limit: 100, status: 'all' },
    },
    {
      actionId: 'opportunities-v3__get-pipelines',
      upstreamAction: 'opportunities-v3__get-pipelines',
      body: { pipelines: [] },
      expect: { locationId: 'L1' },
    },
    {
      actionId: 'calendars-v3__get-calendars',
      upstreamAction: 'calendars-v3__get-calendars',
      body: { calendars: [] },
      expect: { locationId: 'L1' },
    },
    {
      actionId: 'conversations-v3__search-conversation',
      upstreamAction: 'conversations-v3__search-conversation',
      body: { conversations: [] },
      // VERIFIED from the spec: Unix milliseconds, filtering dateAdded.
      expect: {
        locationId: 'L1',
        limit: 100,
        startDate: Date.parse(WINDOW.from),
        endDate: Date.parse(WINDOW.to),
      },
    },
    {
      actionId: 'conversations-v3__export-messages-by-location',
      upstreamAction: 'conversations-v3__export-messages-by-location',
      body: { messages: [] },
      // No date parameter is sent: the spec types them only as `string` and pins no format.
      expect: { locationId: 'L1', limit: 100, sortBy: 'createdAt', sortOrder: 'desc' },
    },
  ];
  for (const { actionId, upstreamAction, body, expect } of cases) {
    const { upstream } = await translate(actionId, { [upstreamAction]: () => body });
    assert.equal(upstream.length, 1, actionId);
    assert.equal(upstream[0].action, upstreamAction, actionId);
    assert.deepEqual(upstream[0].params, expect, actionId);
  }
});

test('a normalised page carries exactly the fields the bounded adapter validates', async () => {
  const { body } = await translate('opportunities-v3__get-pipelines', {
    'opportunities-v3__get-pipelines': () => ({ pipelines: [{ id: 'p1', name: 'Sales' }] }),
  });
  assert.equal(body.locationId, 'L1');
  assert.deepEqual(body.appliedWindow, { from: WINDOW.from, to: WINDOW.to });
  assert.deepEqual(body.items, [{ id: 'p1', name: 'Sales' }]);
  assert.deepEqual(body.page, {
    cursor: null,
    nextCursor: null,
    reportedCount: 1,
    complete: true,
    truncated: false,
  });
  // `reportedCount === items.length` BY CONSTRUCTION, which is what lets a scope ever be complete.
  assert.equal(body.page.reportedCount, body.items.length);
});

test('an MCP text-content envelope is unwrapped the same as structuredContent', async () => {
  const { body } = await translate('calendars-v3__get-calendars', {
    'calendars-v3__get-calendars': () => ({
      content: [{ type: 'text', text: JSON.stringify({ calendars: [{ id: 'cal1' }] }) }],
    }),
  });
  assert.deepEqual(body.items, [{ id: 'cal1' }]);
});

test('an unrecognised body SHAPE throws instead of reporting an empty account', async () => {
  await translateRejects(
    'calendars-v3__get-calendars',
    { 'calendars-v3__get-calendars': () => ({ somethingElse: { nested: true } }) },
    'GHL_RESPONSE_SHAPE_UNRECOGNISED',
  );
  // A genuinely empty account is NOT an unrecognised shape.
  const { body } = await translate('calendars-v3__get-calendars', {
    'calendars-v3__get-calendars': () => ({ calendars: [] }),
  });
  assert.deepEqual(body.items, []);
  assert.equal(body.page.complete, true);
});

// ---------------------------------------------------------------------------
// monetaryValue — the canonical revenue basis
// ---------------------------------------------------------------------------

test('a non-numeric monetaryValue is PRESERVED and flagged, never coerced and never zeroed', async () => {
  const { body } = await translate('opportunities.list', {
    'opportunities-v3__search-opportunity': () => ({
      opportunities: [
        { id: 'o1', dateAdded: IN_WINDOW, monetaryValue: '1200.50' },
        { id: 'o2', dateAdded: IN_WINDOW, monetaryValue: 990 },
        { id: 'o3', dateAdded: IN_WINDOW, monetaryValue: null },
        { id: 'o4', dateAdded: IN_WINDOW, monetaryValue: Number.NaN },
        { id: 'o5', dateAdded: IN_WINDOW },
      ],
    }),
  });
  const byId = new Map(body.items.map((item) => [item.id, item]));

  // The engine-written STRING survives byte-for-byte. It is not parsed, not defaulted, not zeroed.
  assert.equal(byId.get('o1').monetaryValue, '1200.50');
  assert.deepEqual(byId.get('o1').$auditDataQuality, [
    { code: 'MONETARY_VALUE_NOT_FINITE', field: 'monetaryValue', observedType: 'string' },
  ]);

  // A real number is untouched and carries no annotation at all.
  assert.equal(byId.get('o2').monetaryValue, 990);
  assert.equal(Object.hasOwn(byId.get('o2'), '$auditDataQuality'), false);

  assert.equal(byId.get('o3').monetaryValue, null);
  assert.equal(byId.get('o3').$auditDataQuality[0].observedType, 'null');
  // NaN is a number and is still not a VALUE; it must not pass as one.
  assert.equal(byId.get('o4').$auditDataQuality[0].observedType, 'number');
  // An opportunity with no monetaryValue at all is not a data-quality event.
  assert.equal(Object.hasOwn(byId.get('o5'), '$auditDataQuality'), false);

  assert.equal(body.dataQuality.monetaryValueNotFinite, 3);
});

test('a record that already owns the annotation key is passed through untouched', async () => {
  const raw = { id: 'o1', dateAdded: IN_WINDOW, monetaryValue: 'x', $auditDataQuality: 'theirs' };
  const { body } = await translate('opportunities.list', {
    'opportunities-v3__search-opportunity': () => ({ opportunities: [structuredClone(raw)] }),
  });
  assert.deepEqual(body.items[0], raw);
  assert.equal(body.dataQuality.monetaryValueNotFinite, 1);
});

// ---------------------------------------------------------------------------
// The window
// ---------------------------------------------------------------------------

test('client-side filtering drops out-of-window records and KEEPS untimeable ones', async () => {
  const { body } = await translate('opportunities.list', {
    'opportunities-v3__search-opportunity': () => ({
      opportunities: [
        { id: 'in', dateAdded: IN_WINDOW },
        { id: 'old', dateAdded: BEFORE_WINDOW },
        { id: 'future', dateAdded: new Date(CUTOFF + DAY_MS).toISOString() },
        { id: 'untimed' },
        { id: 'updated-basis', dateUpdated: IN_WINDOW },
      ],
    }),
  });
  assert.deepEqual(body.items.map(({ id }) => id), ['in', 'untimed', 'updated-basis']);
  assert.equal(body.dataQuality.outsideWindowDropped, 2);
  assert.equal(body.dataQuality.withoutTimestampKept, 1);
  assert.equal(body.dataQuality.updatedBasisUsed, 1);
  assert.equal(body.page.reportedCount, 3);
});

test('a page where NOTHING can be placed in time fails rather than claiming a window', async () => {
  await translateRejects(
    'opportunities.list',
    { 'opportunities-v3__search-opportunity': () => ({ opportunities: [{ id: 'a' }, { id: 'b' }] }) },
    'GHL_WINDOW_FIELD_UNRECOGNISED',
  );
});

test('a server-windowed scope takes the records as given and does not re-filter them', async () => {
  const { body, upstream } = await translate('conversations-v3__search-conversation', {
    'conversations-v3__search-conversation': () => ({
      conversations: [{ id: 'cv1' }, { id: 'cv2', dateAdded: BEFORE_WINDOW }],
    }),
  });
  assert.equal(upstream[0].params.startDate, Date.parse(WINDOW.from));
  assert.deepEqual(body.items.map(({ id }) => id), ['cv1', 'cv2']);
  assert.equal(body.dataQuality.windowFilter, 'server');
  assert.equal(body.dataQuality.outsideWindowDropped, 0);
});

test('configuration-state reads are not windowed and say so', async () => {
  for (const [actionId, upstreamAction, key] of [
    ['calendars-v3__get-calendars', 'calendars-v3__get-calendars', 'calendars'],
    ['opportunities-v3__get-pipelines', 'opportunities-v3__get-pipelines', 'pipelines'],
  ]) {
    const { body } = await translate(actionId, {
      [upstreamAction]: () => ({ [key]: [{ id: 'x', dateAdded: BEFORE_WINDOW }] }),
    });
    assert.equal(body.dataQuality.windowFilter, 'none');
    assert.equal(body.items.length, 1, actionId);
  }
});

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

function fullContactPage(index) {
  return Array.from({ length: 100 }, (_unused, offset) => ({
    id: `c${index}-${offset}`,
    dateAdded: IN_WINDOW,
    searchAfter: [CUTOFF - offset, `c${index}-${offset}`],
  }));
}

test('contacts paginate on searchAfter taken from the last record of a FULL page', async () => {
  const { body, upstream } = await translate('contacts.search', {
    'contacts-v3__search-contacts-advanced': (params, call) => (call === 1
      ? { contacts: fullContactPage(1), total: 150 }
      : { contacts: [{ id: 'tail', dateAdded: IN_WINDOW }], total: 150 }),
  });
  assert.equal(upstream.length, 2);
  assert.equal(Object.hasOwn(upstream[0].params, 'searchAfter'), false);
  assert.deepEqual(upstream[1].params.searchAfter, [CUTOFF - 99, 'c1-99']);
  assert.equal(body.items.length, 101);
  assert.equal(body.page.complete, true);
  assert.equal(body.page.nextCursor, null);
  // The server's own total travels as a SIGNAL only; it is never the reported count.
  assert.equal(body.dataQuality.serverReportedTotal, 150);
  assert.equal(body.page.reportedCount, 101);
});

test('a FULL page with no derivable cursor is truncated, not complete', async () => {
  const { body } = await translate('contacts.search', {
    'contacts-v3__search-contacts-advanced': () => ({
      contacts: Array.from({ length: 100 }, (_unused, offset) => ({
        id: `c${offset}`,
        dateAdded: IN_WINDOW,
      })),
    }),
  });
  assert.equal(body.page.complete, false);
  assert.equal(body.page.truncated, true);
  assert.equal(body.dataQuality.paginationCursorUnavailable, true);
  assert.equal(body.items.length, 100);
});

test('message export uses the provider opaque cursor and stops once it passes the window', async () => {
  const { body, upstream } = await translate('conversations-v3__export-messages-by-location', {
    'conversations-v3__export-messages-by-location': (params, call) => (call === 1
      ? {
        messages: Array.from({ length: 100 }, (_unused, offset) => ({
          id: `m1-${offset}`,
          createdAt: IN_WINDOW,
        })),
        nextCursor: 'PROVIDER-CURSOR-1',
      }
      : {
        messages: [{ id: 'm2-0', createdAt: BEFORE_WINDOW }],
        nextCursor: 'PROVIDER-CURSOR-2',
      }),
  });
  assert.equal(upstream.length, 2);
  assert.equal(Object.hasOwn(upstream[0].params, 'cursor'), false);
  assert.equal(upstream[1].params.cursor, 'PROVIDER-CURSOR-1');
  // Sorted newest-first, so the first record older than the window ends the walk even though the
  // provider is still offering a cursor.
  assert.equal(body.items.length, 100);
  assert.equal(body.page.complete, true);
  assert.equal(body.dataQuality.outsideWindowDropped, 1);
});

test('duplicate ids across pages are dropped once, deterministically', async () => {
  const { body } = await translate('contacts.search', {
    'contacts-v3__search-contacts-advanced': (params, call) => (call === 1
      ? { contacts: fullContactPage(1) }
      : { contacts: [{ id: 'c1-0', dateAdded: IN_WINDOW }] }),
  });
  assert.equal(body.items.length, 100);
  assert.equal(body.dataQuality.duplicateIdsDropped, 1);
});

// ---------------------------------------------------------------------------
// Calendar events — parent resolution and window chunking
// ---------------------------------------------------------------------------

test('the window chunk grid is half-open and covers exactly [from, to)', () => {
  const from = Date.parse(WINDOW.from);
  const to = Date.parse(WINDOW.to);
  const chunks = calendarEventChunks(from, to);
  assert.equal(chunks.length, Math.ceil(90 / 7));
  assert.equal(chunks[0][0], from);
  assert.equal(chunks.at(-1)[1], to, 'the last chunk is clamped to the window end');
  for (let index = 1; index < chunks.length; index += 1) {
    assert.equal(chunks[index][0], chunks[index - 1][1], 'no gap and no overlap at a boundary');
  }
});

test('calendar events resolve the parent calendars first, then walk (calendar x chunk)', async () => {
  const from = new Date(CUTOFF - 14 * DAY_MS).toISOString();
  const { body, upstream } = await translate('calendars-v3__get-calendar-events', {
    'calendars-v3__get-calendars': () => ({ calendars: [{ id: 'calB' }, { id: 'calA' }] }),
    'calendars-v3__get-calendar-events': (params) => ({
      events: [{ id: `${params.calendarId}@${params.startTime}`, locationId: 'L1' }],
    }),
  }, { from });

  // One resolution, then 2 calendars x 2 weekly chunks.
  assert.equal(upstream[0].action, 'calendars-v3__get-calendars');
  assert.equal(upstream.length, 5);
  const walk = upstream.slice(1);
  assert.deepEqual(
    walk.map(({ params }) => params.calendarId),
    ['calA', 'calA', 'calB', 'calB'],
    'calendars are walked in sorted id order so a resume is deterministic',
  );
  const fromMs = Date.parse(from);
  assert.deepEqual(walk.map(({ params }) => [params.startTime, params.endTime]), [
    [String(fromMs), String(fromMs + 7 * DAY_MS - 1)],
    [String(fromMs + 7 * DAY_MS), String(CUTOFF - 1)],
    [String(fromMs), String(fromMs + 7 * DAY_MS - 1)],
    [String(fromMs + 7 * DAY_MS), String(CUTOFF - 1)],
  ]);
  assert.equal(body.items.length, 4);
  assert.equal(body.page.complete, true);
  assert.equal(body.dataQuality.parentCalendarsResolved, 2);
});

test('an event returned on both sides of a chunk boundary is collected once', async () => {
  const from = new Date(CUTOFF - 14 * DAY_MS).toISOString();
  const { body } = await translate('calendars-v3__get-calendar-events', {
    'calendars-v3__get-calendars': () => ({ calendars: [{ id: 'calA' }] }),
    'calendars-v3__get-calendar-events': () => ({ events: [{ id: 'boundary-event' }] }),
  }, { from });
  assert.deepEqual(body.items, [{ id: 'boundary-event' }]);
  assert.equal(body.dataQuality.duplicateIdsDropped, 1);
});

test('a location with zero calendars yields zero events, and says the lookup succeeded', async () => {
  const { body, upstream } = await translate('calendars-v3__get-calendar-events', {
    'calendars-v3__get-calendars': () => ({ calendars: [] }),
  });
  assert.equal(upstream.length, 1);
  assert.deepEqual(body.items, []);
  assert.equal(body.page.complete, true);
  assert.equal(body.dataQuality.parentCalendarsResolved, 0);
});

test('a parent lookup that comes back unrecognised throws instead of yielding no appointments', async () => {
  await translateRejects(
    'calendars-v3__get-calendar-events',
    { 'calendars-v3__get-calendars': () => ({ nope: true }) },
    'GHL_RESPONSE_SHAPE_UNRECOGNISED',
  );
});

// ---------------------------------------------------------------------------
// Bounds and the opaque resume cursor
// ---------------------------------------------------------------------------

test('the versioned page budget stops the walk and hands back a resumable cursor', async () => {
  const { body, upstream } = await translate('contacts.search', {
    'contacts-v3__search-contacts-advanced': (params, call) => ({ contacts: fullContactPage(call) }),
  });
  // `profiles/collection-budgets.v1.json`: contacts allow 100 pages, 10000 records. 100 pages of
  // 100 records reaches the record ceiling first.
  assert.ok(upstream.length <= 100);
  assert.equal(body.page.complete, false);
  assert.equal(body.page.truncated, true);
  assert.equal(typeof body.page.nextCursor, 'string');

  // The cursor is opaque to the adapter and canonical to us: decoding it names the action and
  // carries the endpoint's own paging state, so a resume continues rather than restarting.
  const decoded = JSON.parse(Buffer.from(body.page.nextCursor, 'base64url').toString('utf8'));
  assert.equal(decoded.version, 1);
  assert.equal(decoded.action, 'contacts.search');
  assert.ok(Array.isArray(decoded.state.searchAfter));
});

test('a resume cursor is echoed back as page.cursor and continues the endpoint state', async () => {
  const first = await translate('contacts.search', {
    'contacts-v3__search-contacts-advanced': (params, call) => ({ contacts: fullContactPage(call) }),
  });
  const resumeCursor = first.body.page.nextCursor;
  const second = await translate('contacts.search', {
    'contacts-v3__search-contacts-advanced': () => ({ contacts: [{ id: 'z', dateAdded: IN_WINDOW }] }),
  }, { cursor: resumeCursor });
  assert.equal(second.body.page.cursor, resumeCursor, 'the adapter requires the echo to match');
  assert.deepEqual(
    second.upstream[0].params.searchAfter,
    JSON.parse(Buffer.from(resumeCursor, 'base64url').toString('utf8')).state.searchAfter,
  );
  assert.equal(second.body.page.complete, true);
});

test('the same paging state always encodes to the same cursor string', async () => {
  const run = () => translate('contacts.search', {
    'contacts-v3__search-contacts-advanced': (params, call) => (call === 1
      ? { contacts: fullContactPage(1) }
      : { contacts: Array.from({ length: 100 }, (_unused, offset) => ({ id: `t${offset}`, dateAdded: IN_WINDOW })) }),
  });
  const [left, right] = await Promise.all([run(), run()]);
  assert.equal(left.body.page.nextCursor, right.body.page.nextCursor);
});

test('a malformed or foreign cursor is refused', async () => {
  await translateRejects(
    'contacts.search',
    { 'contacts-v3__search-contacts-advanced': () => ({ contacts: [] }) },
    'GHL_TRANSLATION_CURSOR_INVALID',
    { cursor: 'not-a-cursor' },
  );
  const foreign = Buffer.from(
    canonicalJson({ action: 'opportunities.list', state: {}, version: 1 }),
    'utf8',
  ).toString('base64url');
  await translateRejects(
    'contacts.search',
    { 'contacts-v3__search-contacts-advanced': () => ({ contacts: [] }) },
    'GHL_TRANSLATION_CURSOR_INVALID',
    { cursor: foreign },
  );
});

test("the adapter's own request timeout becomes a clean truncation, not a lost page", async () => {
  let clock = 0;
  const { body, upstream } = await translate('contacts.search', {
    'contacts-v3__search-contacts-advanced': (params, call) => {
      clock += 3_000;
      return { contacts: fullContactPage(call) };
    },
  }, { options: { timeout: 10_000 }, runtime: { now: () => clock } });

  // The walk spends at most 80% of the adapter's 10s request budget, so the fourth call — which
  // would start at 9s and risk the adapter's own timer firing and discarding EVERYTHING — is not
  // made. Three pages are kept and handed back with a resume cursor instead.
  assert.equal(upstream.length, 3);
  assert.equal(upstream[0].timeout, 10_000, 'the caller timeout is forwarded to every upstream call');
  assert.equal(body.page.truncated, true);
  assert.equal(typeof body.page.nextCursor, 'string');
  assert.equal(body.items.length, 300);
});

test('an aborted signal stops the walk without inventing a page', async () => {
  const controller = new AbortController();
  await assert.rejects(
    () => translate('contacts.search', {
      'contacts-v3__search-contacts-advanced': (params, call) => {
        if (call === 1) controller.abort();
        return { contacts: fullContactPage(call) };
      },
    }, { options: { signal: controller.signal } }),
    (error) => {
      assert.equal(error.code, 'GHL_TRANSLATION_ABORTED');
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// End to end through the composition root and the bounded adapter
// ---------------------------------------------------------------------------

function frozenInputs() {
  return {
    locationId: 'L1',
    target: { targetKind: 'location', operatingProfile: 'client', locationId: 'L1' },
    cutoff: CUTOFF,
    timezone: 'Australia/Sydney',
    contextHash: 'context-translator-1',
    coverageProfileHash: 'coverage-translator-1',
    metricProfileHash: 'metric-translator-1',
    rulesetHash: 'rules-translator-1',
    codeHash: 'code-translator-1',
    auditProfileHash: 'profile-translator-1',
    providerToolProfileHash: 'provider-translator-1',
    windowDefinitionsHash: 'windows-translator-1',
    collectionBudgetHash: 'budget-translator-1',
    capabilityManifestHashes: ['manifest-translator-1'],
    capabilityProofIndexHash: 'proof-index-translator-1',
    capabilityReceiptHashes: ['receipt-translator-1'],
    capabilityAttestationHashes: ['attestation-translator-1'],
    capabilityProofExpiries: [1_850_032_000_000],
  };
}

function publicConfig(capabilities) {
  return {
    schemaVersion: '1.0.0',
    adapterKind: 'ghl_public',
    runId: 'run_translator_1',
    providerId: 'translator-provider',
    expectedLocationId: 'L1',
    capabilityManifestHash: MANIFEST_HASH,
    publicCatalogSnapshotHash: SNAPSHOT_HASH,
    publicReadAllowlistHash: ALLOWLIST_HASH,
    credentialRef: null,
    transport: { kind: 'streamable-http', url: 'https://mcp.invalid.example.test' },
    capabilities,
    cutoff: CUTOFF,
    timezone: 'Australia/Sydney',
    frozenInputs: frozenInputs(),
    context: { safe: 'context' },
    reviews: [],
  };
}

function decryptPhaseArtifact(projectRoot, runId, filename) {
  const paths = auditPaths(projectRoot, 'L1');
  const envelope = JSON.parse(readFileSync(
    join(paths.privateCheckpoints, runId, 'phases', filename),
    'utf8',
  ));
  const decipher = createDecipheriv(
    'aes-256-gcm',
    PHASE_ENCRYPTION_KEY,
    Buffer.from(envelope.iv, 'base64'),
  );
  decipher.setAAD(Buffer.from(canonicalJson({
    schemaVersion: '1.0.0',
    runId: envelope.runId,
    phase: envelope.phase,
    inputHash: envelope.inputHash,
  }), 'utf8'));
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  return JSON.parse(Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8'));
}

async function withProject(run) {
  const projectRoot = realpathSync(mkdtempSync(join(tmpdir(), 'ghl-translator-')));
  try {
    return await run({
      projectRoot,
      writeConfig(config) {
        const pathname = join(projectRoot, 'provider.json');
        writeFileSync(pathname, `${JSON.stringify(config)}\n`);
        return pathname;
      },
    });
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
}

function ghlNativeDouble(handlers) {
  const observed = { requests: [], connects: 0, closes: 0 };
  return {
    observed,
    async connect() {
      observed.connects += 1;
      return {
        async callTool(request) {
          observed.requests.push(structuredClone(request.arguments));
          const handler = handlers[request.arguments.action_id];
          if (!handler) throw new Error(`UNEXPECTED_UPSTREAM:${request.arguments.action_id}`);
          return { structuredContent: handler(request.arguments.params) };
        },
        async close() {
          observed.closes += 1;
        },
      };
    },
  };
}

test('the public rail collects a RAW GHL MCP server end to end through the translator', async () => withProject(async ({ projectRoot, writeConfig }) => {
  const server = ghlNativeDouble({
    'contacts-v3__search-contacts-advanced': () => ({
      contacts: [{ id: 'c1', locationId: 'L1', dateAdded: IN_WINDOW }],
      total: 1,
    }),
    'opportunities-v3__search-opportunity': () => ({
      opportunities: [
        { id: 'o1', locationId: 'L1', dateAdded: IN_WINDOW, monetaryValue: '4500' },
        { id: 'o2', locationId: 'L1', dateAdded: IN_WINDOW, monetaryValue: 2000 },
      ],
      meta: { total: 2 },
    }),
  });
  const stdout = { chunks: [], write(chunk) { this.chunks.push(String(chunk)); return true; } };
  const result = await runAuditCli({
    argv: [
      'run',
      '--mode', 'weekly',
      '--project', projectRoot,
      '--location', 'L1',
      '--profile', 'client',
      '--provider-config', writeConfig(publicConfig([
        { operationId: 'contacts-weekly', actionId: 'contacts.search' },
        { operationId: 'opportunities-weekly', actionId: 'opportunities.list' },
      ])),
      '--vault-key-ref', VAULT_KEY_REFERENCE,
    ],
    stdout,
    publicRuntime: { ghlNativeConnect: server.connect },
  });

  assert.equal(result.status, 'complete_partial');
  assert.equal(result.runId, 'run_translator_1');
  assert.ok(result.publicationId);
  assert.equal(server.observed.connects, 1);
  assert.equal(server.observed.closes, 1);

  // What actually went to the "GHL server" is GHL-native, not the adapter's generic shape.
  // The key is `action_id` because that is what the worker's own zod requires; naming it `action`
  // is the defect this assertion could not see. See `tests/ghl-wire-contract.test.mjs`.
  assert.deepEqual(server.observed.requests.map(({ action_id: actionId }) => actionId).sort(), [
    'contacts-v3__search-contacts-advanced',
    'opportunities-v3__search-opportunity',
  ]);
  for (const { params } of server.observed.requests) {
    assert.equal(params.locationId, 'L1');
    assert.equal(Object.hasOwn(params, 'fromDate'), false);
    assert.equal(Object.hasOwn(params, 'cursor'), false);
  }

  // Both scopes were accepted by the bounded adapter as COMPLETE, which is only possible because
  // the translated `reportedCount` matched the collected items exactly.
  const evidence = decryptPhaseArtifact(projectRoot, 'run_translator_1', '03-collecting_public.json');
  assert.deepEqual(evidence.scopes.map(({ status }) => status), ['complete', 'complete']);
  assert.deepEqual(evidence.limitations, []);
  const opportunities = evidence.scopes.find(({ operationId }) => operationId === 'opportunities-weekly');
  // The string monetaryValue survived the whole pipeline into sealed evidence, still a string.
  assert.equal(opportunities.items[0].monetaryValue, '4500');
  assert.equal(opportunities.items[0].$auditDataQuality[0].code, 'MONETARY_VALUE_NOT_FINITE');
  assert.equal(opportunities.items[1].monetaryValue, 2000);

  const state = openState({ projectRoot, locationId: 'L1' });
  try {
    assert.equal(state.getRun('run_translator_1').frozenInputs.privateSourceInventory.length, 2);
  } finally {
    state.close();
  }
}));

test('a configuration naming an untranslated read never reaches the transport', async () => withProject(async ({ projectRoot, writeConfig }) => {
  const server = ghlNativeDouble({});
  await assert.rejects(
    () => runAuditCli({
      argv: [
        'run',
        '--mode', 'weekly',
        '--project', projectRoot,
        '--location', 'L1',
        '--profile', 'client',
        '--provider-config', writeConfig(publicConfig([
          { operationId: 'contacts-weekly', actionId: 'contacts.search' },
          { operationId: 'payments-weekly', actionId: 'payments-v3__list-orders' },
        ])),
        '--vault-key-ref', VAULT_KEY_REFERENCE,
      ],
      stdout: { write: () => true },
      publicRuntime: { ghlNativeConnect: server.connect },
    }),
    (error) => {
      assert.equal(error.code, 'AUDIT_PREFLIGHT_FAILED_PUBLIC_CAPABILITY_NOT_TRANSLATED');
      assert.deepEqual(error.actionIds, ['payments-v3__list-orders']);
      return true;
    },
  );
  assert.equal(server.observed.connects, 0, 'no transport may be connected for a refused capability');
}));

test('declaring BOTH transport seams at once is refused', async () => withProject(async ({ projectRoot, writeConfig }) => {
  const server = ghlNativeDouble({});
  await assert.rejects(
    () => runAuditCli({
      argv: [
        'run',
        '--mode', 'weekly',
        '--project', projectRoot,
        '--location', 'L1',
        '--profile', 'client',
        '--provider-config', writeConfig(publicConfig([
          { operationId: 'contacts-weekly', actionId: 'contacts.search' },
        ])),
        '--vault-key-ref', VAULT_KEY_REFERENCE,
      ],
      stdout: { write: () => true },
      publicRuntime: { ghlNativeConnect: server.connect, transportConnect: server.connect },
    }),
    (error) => {
      assert.equal(error.code, 'AUDIT_PREFLIGHT_FAILED_PROVIDER_CONFIG');
      return true;
    },
  );
}));
