import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createConversationTranscriptCollector,
  MESSAGE_EXPORT_ACTION,
  threadsFromMessages,
} from '../lib/adapters/conversation-transcripts.mjs';

const LOCATION = 'LOC_TEST_00000000001';
const FROM = '2026-07-20T00:00:00.000Z';
const TO = '2026-07-27T00:00:00.000Z';
const DAY = 86_400_000;
const START = Date.parse(FROM);

const CAPABILITY = Object.freeze({
  actionId: MESSAGE_EXPORT_ACTION,
  method: 'GET',
  normalizedPath: '/conversations/messages/export',
  category: 'conversations',
  risk: 'read',
  sourceSnapshotHash: 'snapshot',
  allowlistHash: 'allowlist',
  providerId: 'provider',
  capabilityManifestHash: 'manifest',
});

function message(conversationId, overrides = {}) {
  return {
    id: `msg-${conversationId}-${overrides.seq ?? 0}`,
    conversationId,
    contactId: `contact-${conversationId}`,
    dateAdded: START + DAY,
    direction: 'outbound',
    messageType: 'TYPE_SMS',
    body: 'Hi, are you still interested in booking?',
    ...overrides,
  };
}

/** A client double. Records what it was asked so the envelope can be asserted, never a socket. */
function clientReturning(items, { page = {}, wrap = (value) => ({ structuredContent: value }) } = {}) {
  const calls = [];
  return {
    calls,
    async callTool(request) {
      calls.push(request);
      return wrap({
        locationId: LOCATION,
        appliedWindow: { from: FROM, to: TO },
        items,
        page: { cursor: null, nextCursor: null, reportedCount: items.length, complete: true, truncated: false, ...page },
        dataQuality: { actionId: MESSAGE_EXPORT_ACTION },
      });
    },
  };
}

function collector(client, budgets = {}) {
  return createConversationTranscriptCollector({
    client,
    capability: CAPABILITY,
    boundLocationId: LOCATION,
    window: { fromDate: FROM, toDate: TO },
    budgets,
  });
}

test('a small week is read whole, in both directions, and the words survive verbatim', async () => {
  const client = clientReturning([
    message('c1', { seq: 0, body: 'Thanks for enquiring! When suits you?' }),
    message('c1', { seq: 1, direction: 'inbound', dateAdded: START + DAY + 60_000, body: "How much is it? I've asked twice" }),
    message('c2', { seq: 0, body: 'Just checking in.' }),
  ]);

  const result = await collector(client).collectTranscripts({});

  assert.equal(result.complete, true);
  assert.equal(result.universeCount, 2);
  assert.equal(result.messageCount, 3);
  assert.equal(result.sample.mode, 'CENSUS', 'two threads is far below the census threshold');
  assert.equal(result.transcripts.length, 2);
  const first = result.transcripts.find((thread) => thread.conversationId === 'c1');
  assert.equal(first.inboundCount, 1);
  assert.equal(first.outboundCount, 1);
  assert.equal(
    first.messages[1].body,
    "How much is it? I've asked twice",
    'the lead\'s own words reach the analyst unmodified — no scrub, no summary',
  );

  // The governed envelope, not a bare action name.
  const [request] = client.calls;
  assert.equal(request.arguments.action, MESSAGE_EXPORT_ACTION);
  assert.deepEqual(request.arguments.params, { locationId: LOCATION, fromDate: FROM, toDate: TO });
  assert.equal(request.arguments.policy.allowlistHash, 'allowlist');
});

test('every complaint and opt-out survives a stratified draw', async () => {
  // Above the census threshold, so the draw is a sample and the mandatory guarantee is the only
  // thing keeping these two threads in it.
  const items = [];
  for (let index = 0; index < 90; index += 1) {
    items.push(message(`bulk-${String(index).padStart(3, '0')}`, { dateAdded: START + DAY + index * 1000 }));
  }
  items.push(message('angry', { direction: 'inbound', body: 'This is appalling, no one has called me back. I want a refund.' }));
  items.push(message('gone', { direction: 'inbound', body: 'STOP' }));

  const result = await collector(clientReturning(items)).collectTranscripts({});

  assert.equal(result.sample.mode, 'STRATIFIED_SAMPLE');
  assert.equal(result.universeCount, 92);
  const sampled = new Set(result.transcripts.map((thread) => thread.conversationId));
  assert.ok(sampled.has('angry'), 'a complaint may never be sampled out');
  assert.ok(sampled.has('gone'), 'an opt-out may never be sampled out');
  assert.deepEqual(
    result.transcripts.find((thread) => thread.conversationId === 'angry').flags,
    ['complaint'],
  );
  assert.deepEqual(
    result.transcripts.find((thread) => thread.conversationId === 'gone').flags,
    ['opt_out'],
  );
});

test('the same week drawn twice draws the same threads', async () => {
  const items = Array.from({ length: 80 }, (_, index) => (
    message(`c-${String(index).padStart(3, '0')}`, { dateAdded: START + DAY + index * 1000 })
  ));
  const first = await collector(clientReturning(items)).collectTranscripts({});
  const second = await collector(clientReturning([...items].reverse())).collectTranscripts({});
  assert.equal(first.transcriptsHash, second.transcriptsHash, 'a reordered response must not change the draw');
});

test('our own footer is not the lead opting out', async () => {
  const [thread] = threadsFromMessages(
    [
      { conversationId: 'c1', direction: 'outbound', channel: 'TYPE_SMS', at: START, body: 'Book here. Reply STOP to unsubscribe.', status: null, callStatus: null, callDuration: null, contactId: 'p1', userId: null, attachmentCount: 0, unreadable: false },
    ],
    { fromMs: START, toMs: START + 7 * DAY },
  );
  assert.deepEqual(thread.flags, [], 'only an inbound message can be an opt-out');
});

test('a window we could not parse never looks like a quiet account', async () => {
  // Real records came back, and not one of them yielded a conversation to attach to.
  const client = clientReturning([{ id: 'm1', foo: 'bar' }, { id: 'm2', foo: 'baz' }]);
  const result = await client && await collector(client).collectTranscripts({});
  assert.equal(result.complete, false);
  assert.ok(result.limitations.includes('CONVERSATION_MESSAGE_EXPORT_UNPARSEABLE'));
  assert.equal(result.transcripts.length, 0);
});

test('an unrecognised payload is a limitation, not a crash and not an empty week', async () => {
  const result = await collector({ async callTool() { return { structuredContent: { nope: true } }; } })
    .collectTranscripts({});
  assert.equal(result.complete, false);
  assert.deepEqual(result.limitations, ['CONVERSATION_MESSAGE_EXPORT_SHAPE']);
});

test('a read that throws costs the transcripts and nothing else', async () => {
  const result = await collector({
    async callTool() { throw Object.assign(new Error('boom'), { code: 'MCP_TOOL_CALL_FAILED' }); },
  }).collectTranscripts({});
  assert.equal(result.complete, false);
  assert.deepEqual(result.limitations, ['MCP_TOOL_CALL_FAILED']);
});

test('the prompt-size budget drops whole threads and never a flagged one', async () => {
  const long = 'x'.repeat(900);
  const items = [];
  for (let index = 0; index < 12; index += 1) {
    items.push(message(`bulk-${index}`, { body: long, dateAdded: START + DAY + index * 1000 }));
  }
  items.push(message('zzz-complaint', { direction: 'inbound', body: `${long} this is terrible` }));

  const result = await collector(clientReturning(items), { maxTranscriptChars: 3_000 }).collectTranscripts({});

  assert.ok(result.droppedForSizeCount > 0, 'the budget has to actually bind for this test to mean anything');
  assert.ok(result.limitations.includes('CONVERSATION_TRANSCRIPT_CHAR_BUDGET_EXHAUSTED'));
  assert.ok(
    result.transcripts.some((thread) => thread.conversationId === 'zzz-complaint'),
    'the complaint sorts last by id and must still be kept',
  );
  assert.equal(result.universeCount, 13, 'the universe count reports the week, not what fitted');
});

test('a long body is truncated visibly rather than silently', async () => {
  const result = await collector(clientReturning([message('c1', { body: 'y'.repeat(50) })]), { maxBodyChars: 20 })
    .collectTranscripts({});
  const [{ messages }] = result.transcripts;
  assert.ok(messages[0].body.endsWith('[TRUNCATED at 20 characters]'));
});

test('an unanswered call and a failed send are both flagged', async () => {
  const result = await collector(clientReturning([
    message('call', { messageType: 'TYPE_CALL', callStatus: 'no-answer', callDuration: 0, body: null }),
    message('sms', { status: 'undelivered' }),
  ])).collectTranscripts({});
  const byId = new Map(result.transcripts.map((thread) => [thread.conversationId, thread]));
  assert.deepEqual(byId.get('call').flags, ['abandoned_call']);
  assert.deepEqual(byId.get('sms').flags, ['failure']);
});

test('the manifest names nobody', async () => {
  const result = await collector(clientReturning([
    // Deliberately not hex: a short id like `c1` IS valid hex and would match inside a digest,
    // which would make this assertion pass for the wrong reason.
    message('conversation-XYZ', { contactId: 'real-contact-id', userId: 'real-user-id' }),
  ])).collectTranscripts({});
  const serialised = JSON.stringify(result.sample);
  assert.ok(!serialised.includes('real-contact-id'));
  assert.ok(!serialised.includes('real-user-id'));
  assert.ok(!serialised.includes('conversation-XYZ'), 'even the conversation id is opaque in the manifest');
  // ...and the transcript, which is what a person reads, keeps it, because a finding you cannot
  // trace back to a conversation cannot be acted on.
  assert.equal(result.transcripts[0].conversationId, 'conversation-XYZ');
});

test('a misconfigured collector refuses to exist', () => {
  for (const bad of [
    { window: { fromDate: TO, toDate: FROM } },
    { window: { fromDate: FROM, toDate: 'not a date' } },
    { capability: { ...CAPABILITY, actionId: 'contacts.search' } },
    { boundLocationId: '' },
  ]) {
    assert.throws(() => createConversationTranscriptCollector({
      client: clientReturning([]),
      capability: CAPABILITY,
      boundLocationId: LOCATION,
      window: { fromDate: FROM, toDate: TO },
      ...bad,
    }), { code: 'CONVERSATION_TRANSCRIPTS_CONFIG_INVALID' });
  }
});
