/**
 * THE TRANSLATOR AGAINST THE REAL SERVER SHAPE.
 *
 * Every other translator test is written against bodies invented in the test file: the doubles
 * return `{ contacts: [...] }` while the live worker returns
 * `{ action, status, ok, data: { contacts: [...] }, note, filter, pagination, error }`. Nothing in
 * the suite could tell the two apart, so the whole envelope — including `action.method: "POST"` —
 * was invisible to every test that existed.
 *
 * The tolerant container lookups meant that did NOT break a successful read (see the module
 * header; a replay of the previous revision paged correctly). It broke every UNSUCCESSFUL read:
 * an `ok: false` envelope came back as `GHL_RESPONSE_SHAPE_UNRECOGNISED`, which is not retryable,
 * which surfaced as an undiagnosable `PUBLIC_COLLECTION_FAILED`. So the failure channel is tested
 * here first, against the real envelope, rather than assumed.
 *
 * So these tests are driven by `tests/fixtures/live-shapes/grom-uk-redacted.json`, which is FIVE
 * REAL RESPONSES captured read-only from Grom's UK sub-account, redacted to synthetic values with
 * the structure preserved byte-faithfully — same keys, same key order, same types, same array
 * lengths, same string forms, and the same cross-field invariants (see the fixture's own `$meta`).
 *
 * Nothing here opens a socket. The fixture IS the server.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  createGhlTranslatingConnect,
  parseUpstreamResult,
} from '../lib/adapters/ghl-public-translator.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const LIVE = JSON.parse(readFileSync(
  join(HERE, 'fixtures', 'live-shapes', 'grom-uk-redacted.json'),
  'utf8',
));

/** The location every record in the fixture is bound to. */
const LOCATION_ID = LIVE.contacts.response.structuredContent.data.contacts[0].locationId;

/**
 * The window is derived FROM the fixture rather than hard-coded, so the redacted instants are
 * always inside it and a re-redaction cannot silently turn these tests into assertions about an
 * empty window.
 */
const WINDOW = (() => {
  const instants = [];
  const walk = (value) => {
    if (value === null || typeof value !== 'object') return;
    for (const entry of Array.isArray(value) ? value : Object.values(value)) walk(entry);
  };
  const collect = (value) => {
    if (value === null) return;
    if (Array.isArray(value)) {
      for (const entry of value) collect(entry);
      return;
    }
    if (typeof value === 'object') {
      for (const entry of Object.values(value)) collect(entry);
      return;
    }
    if (typeof value === 'number' && value > 1_000_000_000_000 && value < 3_000_000_000_000) {
      instants.push(value);
    }
    if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/u.test(value)) {
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) instants.push(parsed);
    }
  };
  walk(LIVE);
  collect(LIVE);
  const DAY_MS = 86_400_000;
  return Object.freeze({
    from: new Date(Math.min(...instants) - DAY_MS).toISOString(),
    to: new Date(Math.max(...instants) + DAY_MS).toISOString(),
  });
})();

/** The captured tool RESULT for a scope, exactly as the MCP client would hand it over. */
function liveResult(scope) {
  return structuredClone(LIVE[scope].response);
}

function liveBody(scope) {
  return LIVE[scope].response.structuredContent.data;
}

async function translate(actionId, handlers, { from = WINDOW.from, to = WINDOW.to } = {}) {
  const upstream = [];
  const connect = async () => ({
    async callTool(request) {
      // `action_id` — the worker's own required argument name. See the translator module header
      // and `tests/ghl-wire-contract.test.mjs`.
      upstream.push({
        action: request.arguments.action_id,
        params: structuredClone(request.arguments.params),
      });
      const handler = handlers[request.arguments.action_id];
      if (!handler) throw new Error(`UNEXPECTED_UPSTREAM:${request.arguments.action_id}`);
      return handler(request.arguments.params, upstream.length);
    },
    async close() {},
  });
  const delegate = await createGhlTranslatingConnect({ connect })({ kind: 'stdio' });
  const result = await delegate.callTool({
    name: 'execute_action',
    arguments: {
      action: actionId,
      params: { locationId: LOCATION_ID, fromDate: from, toDate: to, cursor: null },
    },
  });
  return { body: result.structuredContent, upstream };
}

// ---------------------------------------------------------------------------
// The envelope — the root cause
// ---------------------------------------------------------------------------

test('the live capture really is a worker ENVELOPE, not a GHL body', () => {
  for (const scope of ['contacts', 'opportunities', 'conversations', 'calendars', 'calendarEvents']) {
    const structured = LIVE[scope].response.structuredContent;
    assert.deepEqual(
      Object.keys(structured),
      ['action', 'status', 'ok', 'data', 'note', 'filter', 'pagination', 'error'],
      scope,
    );
    assert.equal(structured.status, 200, scope);
    assert.equal(structured.ok, true, scope);
    assert.equal(structured.error, null, scope);
    // The shaping channels are unused, which is what lets us claim the array is the whole array.
    assert.equal(structured.filter, null, scope);
    assert.equal(structured.pagination, null, scope);
  }
});

test('parseUpstreamResult returns the GHL BODY, one level down at data', () => {
  const expected = {
    contacts: ['contacts', 'total', 'traceId'],
    opportunities: ['opportunities', 'meta', 'traceId'],
    conversations: ['conversations', 'total', 'traceId'],
    calendars: ['calendars', 'traceId'],
    calendarEvents: ['events', 'traceId'],
  };
  for (const [scope, keys] of Object.entries(expected)) {
    const body = parseUpstreamResult(liveResult(scope));
    assert.deepEqual(Object.keys(body), keys, scope);
    // The envelope's own keys are GONE. If any survived, the run would die downstream.
    for (const enveloped of ['action', 'status', 'ok', 'note', 'filter', 'pagination', 'error']) {
      assert.equal(Object.hasOwn(body, enveloped), false, `${scope}.${enveloped}`);
    }
  }
});

test('the POST write-trace in the envelope never reaches a translated item', async () => {
  // `contacts-v3__search-contacts-advanced` is POST /contacts/search — a read semantically, which
  // the worker still stamps `method: "POST"` and `risk.kinds: ["write"]`. `lib/kernel.mjs`
  // `assertSafeCollected` throws on exactly that, so an envelope reaching evidence KILLS a run.
  assert.equal(LIVE.contacts.response.structuredContent.action.method, 'POST');
  assert.deepEqual(LIVE.contacts.response.structuredContent.action.risk.kinds, ['write']);

  const { body } = await translate('contacts.search', {
    'contacts-v3__search-contacts-advanced': () => liveResult('contacts'),
  });

  // The same normalisation `assertSafeCollected` applies, over everything the translator returns.
  const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
  const offending = [];
  const scan = (value, path) => {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      const normalized = key.toLowerCase().replaceAll(/[^a-z]/gu, '');
      if (
        ['rawrequest', 'mutationtool', 'authorization', 'cookie'].includes(normalized)
        || (normalized === 'method' && WRITE_METHODS.has(String(child).toUpperCase()))
      ) offending.push(`${path}.${key}`);
      scan(child, `${path}.${key}`);
    }
  };
  scan(body, 'body');
  assert.deepEqual(offending, []);
});

test('traceId is the one piece of upstream metadata kept, and it is kept under dataQuality', async () => {
  const { body } = await translate('opportunities.list', {
    'opportunities-v3__search-opportunity': () => liveResult('opportunities'),
  });
  assert.deepEqual(body.dataQuality.upstreamTraceIds, [liveBody('opportunities').traceId]);
  // It is metadata about the CALL, so it must not have been smuggled into a record.
  for (const item of body.items) assert.equal(Object.hasOwn(item, 'traceId'), false);
});

test('an envelope failure channel raises a coded error instead of being parsed as data', () => {
  const base = () => structuredClone(LIVE.opportunities.response);
  const cases = [
    // `ok: false` alone is a failure even when the transport status stayed 200.
    ['ok false', (envelope) => { envelope.ok = false; }, 'GHL_UPSTREAM_ACTION_FAILED', 200],
    ['no status at all', (envelope) => {
      envelope.ok = false;
      delete envelope.status;
    }, 'GHL_UPSTREAM_ACTION_FAILED', null],
    ['422', (envelope) => { envelope.status = 422; }, 'GHL_UPSTREAM_ACTION_FAILED', 422],
    ['404', (envelope) => {
      envelope.status = 404;
      envelope.ok = false;
    }, 'GHL_UPSTREAM_ACTION_FAILED', 404],
    ['401', (envelope) => {
      envelope.status = 401;
      envelope.ok = false;
    }, 'GHL_UPSTREAM_ACTION_FAILED', 401],
    ['populated error', (envelope) => {
      envelope.error = { message: 'invalid enum value' };
    }, 'GHL_UPSTREAM_ACTION_FAILED', 200],
    // The worker rate-limits at 60 execute calls a minute and one scope can make far more than
    // that, so a 429 must PARK the scope rather than abort the audit.
    ['429', (envelope) => {
      envelope.status = 429;
      envelope.ok = false;
    }, 'RATE_LIMITED', 429],
    ['500', (envelope) => {
      envelope.status = 500;
      envelope.ok = false;
    }, 'RETRYABLE', 500],
    ['503', (envelope) => {
      envelope.status = 503;
      envelope.ok = false;
    }, 'RETRYABLE', 503],
  ];
  for (const [label, mutate, code, status] of cases) {
    const response = base();
    mutate(response.structuredContent);
    assert.throws(
      () => parseUpstreamResult(response),
      (error) => {
        assert.equal(error.code, code, label);
        assert.equal(error.upstreamStatus, status, label);
        // The worker echoes request parameters into `error`; none of it may ride along.
        assert.equal(error.message, code, label);
        return true;
      },
      label,
    );
  }
});

test('a server-SHAPED response is refused, because the array would be a subset we did not choose', () => {
  for (const key of ['filter', 'pagination']) {
    const response = structuredClone(LIVE.contacts.response);
    response.structuredContent[key] = key === 'filter' ? 'anything' : { offset: 0, limit: 2 };
    assert.throws(
      () => parseUpstreamResult(response),
      (error) => {
        assert.equal(error.code, 'GHL_UPSTREAM_RESPONSE_SHAPED');
        return true;
      },
      key,
    );
  }
});

test('the TEXT channel renders large payloads truncated, and a truncated body is refused', () => {
  // OBSERVED on the real capture: for a big payload the worker's text fallback stringifies `data`
  // and appends a "showing N of M items" note, while structuredContent stays complete. Salvaging
  // that string would silently drop records.
  const response = {
    content: [{
      type: 'text',
      text: JSON.stringify({
        action: { id: 'x', method: 'GET' },
        status: 200,
        ok: true,
        data: '{\n  "opportunities": [\n ... showing 2 of 3 items',
        note: null,
        filter: null,
        pagination: null,
        error: null,
      }),
    }],
  };
  assert.throws(
    () => parseUpstreamResult(response),
    (error) => {
      assert.equal(error.code, 'GHL_UPSTREAM_RESPONSE_TRUNCATED');
      return true;
    },
  );
});

test('a bare GHL body with no envelope still passes through unchanged', () => {
  assert.deepEqual(parseUpstreamResult({ calendars: [{ id: 'c1' }] }), { calendars: [{ id: 'c1' }] });
});

// ---------------------------------------------------------------------------
// Record containers — every one, against the real body
// ---------------------------------------------------------------------------

test('every scope finds its real record container and returns the real record count', async () => {
  const cases = [
    ['contacts.search', 'contacts-v3__search-contacts-advanced', 'contacts', 'contacts'],
    ['opportunities.list', 'opportunities-v3__search-opportunity', 'opportunities', 'opportunities'],
    [
      'conversations-v3__search-conversation',
      'conversations-v3__search-conversation',
      'conversations',
      'conversations',
    ],
    ['calendars-v3__get-calendars', 'calendars-v3__get-calendars', 'calendars', 'calendars'],
  ];
  for (const [actionId, upstreamAction, scope, container] of cases) {
    const { body } = await translate(actionId, { [upstreamAction]: () => liveResult(scope) });
    const records = liveBody(scope)[container];
    assert.equal(body.items.length, records.length, actionId);
    assert.deepEqual(body.items.map(({ id }) => id), records.map(({ id }) => id), actionId);
    assert.equal(body.page.reportedCount, body.items.length, actionId);
    assert.equal(body.page.complete, true, actionId);
  }
});

test('calendar events resolve the real calendars and read the real `events` container', async () => {
  const calendars = liveBody('calendars').calendars;
  const { body, upstream } = await translate('calendars-v3__get-calendar-events', {
    'calendars-v3__get-calendars': () => liveResult('calendars'),
    'calendars-v3__get-calendar-events': () => liveResult('calendarEvents'),
  });
  assert.equal(upstream[0].action, 'calendars-v3__get-calendars');
  assert.equal(body.dataQuality.parentCalendarsResolved, calendars.length);
  assert.deepEqual(
    [...new Set(upstream.slice(1).map(({ params }) => params.calendarId))].sort(),
    calendars.map(({ id }) => id).sort(),
  );
  // The four fixture events are returned for every (calendar, chunk); id de-duplication collapses
  // them to four, which is the real behaviour the chunk grid depends on.
  assert.equal(body.items.length, liveBody('calendarEvents').events.length);
  assert.ok(body.dataQuality.duplicateIdsDropped > 0);
});

test('GHL ships BOTH spellings of appointment status and both survive untouched', async () => {
  const { body } = await translate('calendars-v3__get-calendar-events', {
    'calendars-v3__get-calendars': () => liveResult('calendars'),
    'calendars-v3__get-calendar-events': () => liveResult('calendarEvents'),
  });
  for (const item of body.items) {
    assert.equal(typeof item.appointmentStatus, 'string');
    // `appoinmentStatus` is GHL's own long-standing typo, shipped alongside the correct spelling.
    assert.equal(typeof item.appoinmentStatus, 'string');
  }
  const expected = liveBody('calendarEvents').events;
  assert.deepEqual(
    body.items.map(({ appointmentStatus }) => appointmentStatus).sort(),
    expected.map(({ appointmentStatus }) => appointmentStatus).sort(),
  );
});

// ---------------------------------------------------------------------------
// Cursors — against the real paging metadata
// ---------------------------------------------------------------------------

test('opportunity cursors come from data.meta, not the body root', async () => {
  const meta = liveBody('opportunities').meta;
  assert.deepEqual(Object.keys(meta), [
    'total', 'nextPageUrl', 'startAfterId', 'startAfter', 'currentPage', 'nextPage', 'prevPage',
  ]);
  assert.equal(Object.hasOwn(liveBody('opportunities'), 'startAfter'), false, 'NOT at the root');

  // A FULL page forces the walk to look for a cursor. The real page limit is 100, so the three
  // fixture rows are padded to 100 with clones that keep the real field shape.
  const rows = liveBody('opportunities').opportunities;
  const full = Array.from({ length: 100 }, (_unused, offset) => ({
    ...structuredClone(rows[offset % rows.length]),
    id: `opp-${offset}`,
  }));
  const first = structuredClone(LIVE.opportunities.response);
  first.structuredContent.data.opportunities = full;

  const { upstream } = await translate('opportunities.list', {
    'opportunities-v3__search-opportunity': (params, call) => (call === 1
      ? first
      : liveResult('opportunities')),
  });
  assert.equal(upstream.length, 2, 'the walk continued past 100 records');
  assert.equal(upstream[1].params.startAfter, meta.startAfter);
  assert.equal(upstream[1].params.startAfterId, meta.startAfterId);
  assert.equal(Object.hasOwn(upstream[0].params, 'startAfter'), false);
});

test("the UK account's 159 opportunities are not silently truncated at 100", async () => {
  const meta = liveBody('opportunities').meta;
  assert.equal(meta.total, 159, 'the real account really does hold more than one page');
  const rows = liveBody('opportunities').opportunities;
  const page = (count, prefix) => Array.from({ length: count }, (_unused, offset) => ({
    ...structuredClone(rows[offset % rows.length]),
    id: `${prefix}-${offset}`,
  }));
  const withRows = (records) => {
    const response = structuredClone(LIVE.opportunities.response);
    response.structuredContent.data.opportunities = records;
    return response;
  };
  const { body, upstream } = await translate('opportunities.list', {
    'opportunities-v3__search-opportunity': (params, call) => (call === 1
      ? withRows(page(100, 'a'))
      : withRows(page(59, 'b'))),
  });
  assert.equal(upstream.length, 2);
  assert.equal(body.items.length, 159);
  assert.equal(body.page.complete, true);
  assert.equal(body.page.truncated, false);
  assert.equal(body.dataQuality.paginationCursorUnavailable, false);
  // The server total is carried as a SIGNAL, and here it happens to agree.
  assert.equal(body.dataQuality.serverReportedTotal, 159);
});

test('contacts page on the per-record searchAfter, because the body carries no cursor', async () => {
  const body = liveBody('contacts');
  assert.deepEqual(Object.keys(body), ['contacts', 'total', 'traceId'], 'no body-level cursor');
  for (const contact of body.contacts) {
    assert.equal(Array.isArray(contact.searchAfter), true);
    assert.equal(contact.searchAfter.length, 2);
    assert.equal(typeof contact.searchAfter[0], 'number');
    assert.equal(contact.searchAfter[1], contact.id);
  }

  const rows = body.contacts;
  const full = Array.from({ length: 100 }, (_unused, offset) => {
    const source = structuredClone(rows[offset % rows.length]);
    source.id = `contact-${offset}`;
    source.searchAfter = [source.searchAfter[0] - offset, `contact-${offset}`];
    return source;
  });
  const first = structuredClone(LIVE.contacts.response);
  first.structuredContent.data.contacts = full;

  const { upstream } = await translate('contacts.search', {
    'contacts-v3__search-contacts-advanced': (params, call) => (call === 1
      ? first
      : liveResult('contacts')),
  });
  assert.equal(upstream.length, 2);
  assert.deepEqual(upstream[1].params.searchAfter, full.at(-1).searchAfter);
});

test('conversations page on the per-record `sort` value, which is the last-message date', async () => {
  const body = liveBody('conversations');
  assert.deepEqual(Object.keys(body), ['conversations', 'total', 'traceId'], 'no body-level cursor');
  for (const conversation of body.conversations) {
    assert.equal(Object.hasOwn(conversation, 'sortValue'), false, 'the spec name is NOT present');
    assert.equal(Array.isArray(conversation.sort), true);
    assert.equal(conversation.sort.length, 1);
    // Epoch MILLISECONDS as numbers, not ISO strings.
    assert.equal(typeof conversation.dateAdded, 'number');
    assert.equal(typeof conversation.lastMessageDate, 'number');
    assert.equal(conversation.sort[0], conversation.lastMessageDate);
  }

  const rows = body.conversations;
  const full = Array.from({ length: 100 }, (_unused, offset) => {
    const source = structuredClone(rows[offset % rows.length]);
    source.id = `conversation-${offset}`;
    source.lastMessageDate -= offset;
    source.sort = [source.lastMessageDate];
    return source;
  });
  const first = structuredClone(LIVE.conversations.response);
  first.structuredContent.data.conversations = full;

  const { upstream } = await translate('conversations-v3__search-conversation', {
    'conversations-v3__search-conversation': (params, call) => (call === 1
      ? first
      : liveResult('conversations')),
  });
  assert.equal(upstream.length, 2);
  assert.equal(upstream[1].params.startAfterDate, full.at(-1).sort[0]);
});

// ---------------------------------------------------------------------------
// The fields the audit actually spends
// ---------------------------------------------------------------------------

test('every real opportunity carries a NUMBER monetaryValue and is therefore not flagged', async () => {
  const { body } = await translate('opportunities.list', {
    'opportunities-v3__search-opportunity': () => liveResult('opportunities'),
  });
  assert.equal(body.items.length > 0, true);
  for (const item of body.items) {
    assert.equal(typeof item.monetaryValue, 'number');
    assert.equal(Object.hasOwn(item, '$auditDataQuality'), false);
  }
  assert.equal(body.dataQuality.monetaryValueNotFinite, 0);
});

test('the real timestamp fields place every windowed record in time', async () => {
  const contacts = await translate('contacts.search', {
    'contacts-v3__search-contacts-advanced': () => liveResult('contacts'),
  });
  assert.equal(contacts.body.dataQuality.windowFilter, 'client');
  assert.equal(contacts.body.dataQuality.withoutTimestampKept, 0);
  assert.equal(contacts.body.dataQuality.outsideWindowDropped, 0);
  assert.equal(contacts.body.dataQuality.updatedBasisUsed, 0, 'contacts use dateAdded, not a fallback');

  const opportunities = await translate('opportunities.list', {
    'opportunities-v3__search-opportunity': () => liveResult('opportunities'),
  });
  // Opportunities have NO `dateAdded`; `createdAt` is the real field and it is an ISO string.
  assert.equal(Object.hasOwn(liveBody('opportunities').opportunities[0], 'dateAdded'), false);
  assert.equal(opportunities.body.dataQuality.withoutTimestampKept, 0);
  assert.equal(opportunities.body.dataQuality.updatedBasisUsed, 0);
});

test('every real record is bound to the expected location, as the adapter demands', async () => {
  const scopes = [
    ['contacts.search', 'contacts-v3__search-contacts-advanced', 'contacts'],
    ['opportunities.list', 'opportunities-v3__search-opportunity', 'opportunities'],
    ['conversations-v3__search-conversation', 'conversations-v3__search-conversation', 'conversations'],
    ['calendars-v3__get-calendars', 'calendars-v3__get-calendars', 'calendars'],
  ];
  for (const [actionId, upstreamAction, scope] of scopes) {
    const { body } = await translate(actionId, { [upstreamAction]: () => liveResult(scope) });
    // `lib/adapters/public-ghl.mjs` `collectLocationIndicators` recurses the WHOLE response and
    // fails the run if ANY nested locationId differs. Verified against the real nesting.
    const indicators = [];
    const walk = (value) => {
      if (!value || typeof value !== 'object') return;
      for (const [key, child] of Object.entries(value)) {
        const normalized = key.toLowerCase().replaceAll(/[^a-z0-9]/gu, '');
        if (['boundlocationid', 'ghllocationid', 'locationid'].includes(normalized)) {
          indicators.push(child);
        } else if (
          normalized === 'location'
          && child && typeof child === 'object' && !Array.isArray(child)
          && Object.hasOwn(child, 'id')
        ) indicators.push(child.id);
        walk(child);
      }
    };
    walk(body);
    assert.equal(indicators.length > 0, true, actionId);
    assert.deepEqual([...new Set(indicators)], [LOCATION_ID], actionId);
  }
});
