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
      { conversationId: 'c1', direction: 'outbound', channel: 'TYPE_SMS', at: START, body: 'Book here. Reply STOP to unsubscribe.', status: null, callStatus: null, callDuration: null, contactId: 'p1', source: 'workflow', attachmentCount: 0, unreadable: false },
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
    message('conversation-XYZ', { contactId: 'real-contact-id', source: 'real-source-name' }),
  ])).collectTranscripts({});
  const serialised = JSON.stringify(result.sample);
  assert.ok(!serialised.includes('real-contact-id'));
  assert.ok(!serialised.includes('real-source-name'));
  assert.ok(!serialised.includes('conversation-XYZ'), 'even the conversation id is opaque in the manifest');
  // ...and the transcript, which is what a person reads, keeps it, because a finding you cannot
  // trace back to a conversation cannot be acted on.
  assert.equal(result.transcripts[0].conversationId, 'conversation-XYZ');
});

test('the real GHL export record parses, field for field', async () => {
  /*
   * VERBATIM from the UK sub-account on 2026-07-29, phone numbers and ids aside. Pinned because
   * every field here is read through a list of spellings — the bundled catalog types this response
   * as an untyped object — and a shape drift must fail here rather than downstream as a quiet
   * empty week. Note `dateAdded` is an ISO STRING, unlike the conversation index's epoch number,
   * and note that inbound carries no `source`.
   */
  const outbound = {
    id: '6WhRsyyZ5NU1Wnx4ZdoV',
    direction: 'outbound',
    status: 'delivered',
    type: 2,
    locationId: LOCATION,
    attachments: [],
    body: 'Hi James, your strategy is ready to review. Check the email I just sent!',
    contactId: 'RDYNgl1NccsTRXtMF2RA',
    contentType: 'text/plain',
    conversationId: '3FZDrKmz41Ipag98qpqW',
    dateAdded: '2026-07-22T15:19:16.953Z',
    dateUpdated: '2026-07-22T15:19:25.669Z',
    source: 'workflow',
    altId: 'SM68f616c984778ac41cbe22902640d041',
    from: '+447480800405',
    to: '+447846445242',
    messageType: 'TYPE_SMS',
  };
  const inbound = {
    ...outbound,
    id: 'XVntDZCzClEijTLgBE7q',
    direction: 'inbound',
    body: 'Looks good.. only thing is the image on meet kelly is not me.',
    dateAdded: '2026-07-22T16:14:40.968Z',
  };
  delete inbound.source;

  const result = await collector(clientReturning([outbound, inbound])).collectTranscripts({});

  assert.equal(result.complete, true, 'no limitation: every field was understood');
  assert.equal(result.messageCount, 2, 'neither record counted as unreadable');
  const [thread] = result.transcripts;
  assert.equal(thread.conversationId, '3FZDrKmz41Ipag98qpqW');
  assert.equal(thread.inboundCount, 1);
  assert.equal(thread.outboundCount, 1);
  assert.deepEqual(thread.channels, ['TYPE_SMS'], 'messageType wins over the numeric `type`');
  assert.deepEqual(thread.outboundSources, ['workflow'], 'no human ever typed into this thread');
  assert.equal(thread.lastDirection, 'inbound', 'the ISO timestamps ordered correctly');
  assert.equal(thread.messages[1].body, inbound.body);
});

/*
 * The four below reproduce an external review's own repros. Each one FAILED before the fix.
 */

test('the total budget is a real ceiling, even for the very first thread', async () => {
  // Reported: a 1,000-character budget delivered ~9,898 characters, 0 dropped, no limitation.
  const items = Array.from({ length: 40 }, (_, index) => message('huge', {
    seq: index,
    dateAdded: START + DAY + index * 1000,
    body: 'z'.repeat(240),
  }));
  const result = await collector(clientReturning(items), { maxTranscriptChars: 1_000, maxThreadChars: 800 })
    .collectTranscripts({});

  const delivered = JSON.stringify(result.transcripts).length;
  assert.ok(
    delivered <= 1_400,
    `the delivered payload must respect the ceiling, got ${delivered} characters`,
  );
  assert.ok(
    result.limitations.length > 0,
    'exceeding or eliding to fit must always be stated, never silent',
  );
});

test('a dropped complaint is reported as the guarantee failing, not hidden', async () => {
  // Reported: manifest mandatoryCount 2, complaints actually delivered 1, no admission.
  const long = 'q'.repeat(600);
  const items = [
    message('complaint-a', { direction: 'inbound', body: `${long} this is terrible` }),
    message('complaint-b', { direction: 'inbound', body: `${long} I want a refund` }),
  ];
  const result = await collector(clientReturning(items), { maxTranscriptChars: 1_300 })
    .collectTranscripts({});

  const delivered = result.transcripts.filter((thread) => thread.flags.length > 0).length;
  if (delivered < 2) {
    assert.equal(result.mandatoryGuaranteeHeld, false, 'a dropped flagged thread must fail the guarantee');
    assert.ok(result.limitations.includes('CONVERSATION_MANDATORY_THREAD_DROPPED'));
    assert.equal(result.droppedFlaggedCount, 2 - delivered);
  } else {
    assert.equal(result.mandatoryGuaranteeHeld, true);
  }
});

test('common ways of complaining and opting out are caught', async () => {
  const cases = [
    ['leave me alone', 'opt_out'],
    ['lose my number', 'opt_out'],
    ['do not message me again', 'opt_out'],
    ['this service is useless', 'complaint'],
    ['you have ignored me for a week', 'complaint'],
    ['I am furious about this', 'complaint'],
  ];
  const items = cases.map(([body], index) => message(`case-${index}`, { direction: 'inbound', body }));
  const result = await collector(clientReturning(items)).collectTranscripts({});
  const byId = new Map(result.transcripts.map((thread) => [thread.conversationId, thread]));
  for (const [index, [body, expected]] of cases.entries()) {
    assert.ok(
      byId.get(`case-${index}`).flags.includes(expected),
      `"${body}" should flag as ${expected}`,
    );
  }
});

test('an unanswered call carries its outcome in status, not callStatus', async () => {
  // VERIFIED LIVE: TYPE_CALL records come back with status `no-answer` / `voicemail` and no
  // `callStatus` field at all. Reading `callStatus` alone flagged nothing.
  const result = await collector(clientReturning([
    message('missed', { direction: 'inbound', messageType: 'TYPE_CALL', status: 'no-answer', body: null }),
    message('vm', { direction: 'inbound', messageType: 'TYPE_CALL', status: 'voicemail', body: null }),
    message('sms-fail', { status: 'failed' }),
  ])).collectTranscripts({});
  const byId = new Map(result.transcripts.map((thread) => [thread.conversationId, thread]));
  assert.deepEqual(byId.get('missed').flags, ['abandoned_call']);
  assert.deepEqual(byId.get('vm').flags, ['abandoned_call']);
  assert.deepEqual(
    byId.get('sms-fail').flags,
    ['failure'],
    'on a text channel the same word still means a delivery failure',
  );
});

test('conversations are joined to what commercially happened', async () => {
  const publicEvidence = {
    scopes: [{
      actionId: 'calendars-v3__get-calendar-events',
      items: [
        { record: { contactId: 'contact-booked', calendarId: 'cal1', startTime: '2026-07-21T10:00:00+00:00', appointmentStatus: 'showed' } },
        { record: { contactId: 'contact-ghost', calendarId: 'cal1', startTime: '2026-07-21T11:00:00+00:00', appointmentStatus: 'noshow' } },
      ],
    }, {
      actionId: 'opportunities.search',
      items: [
        { record: { contactId: 'contact-lost', pipelineId: 'p1', status: 'lost', monetaryValue: 400 } },
        // An appointment already spoke for this contact; the pipeline must not overrule it.
        { record: { contactId: 'contact-ghost', pipelineId: 'p1', status: 'open' } },
      ],
    }],
  };
  const items = [
    { ...message('won', {}), contactId: 'contact-booked' },
    { ...message('ghosted', {}), contactId: 'contact-ghost' },
    { ...message('lost', {}), contactId: 'contact-lost' },
    { ...message('nothing-known', {}), contactId: 'contact-absent' },
  ];

  const result = await collector(clientReturning(items)).collectTranscripts({ publicEvidence });

  const byId = new Map(result.transcripts.map((thread) => [thread.conversationId, thread]));
  assert.equal(byId.get('won').outcome, 'won');
  assert.equal(byId.get('won').outcomeBasis, 'appointment');
  assert.equal(byId.get('ghosted').outcome, 'no_show', 'the appointment beats the open opportunity');
  assert.equal(
    byId.get('ghosted').outcomeBasis,
    'appointment',
    'and it is still recorded as decided by the appointment',
  );
  assert.equal(byId.get('lost').outcome, 'lost');
  assert.equal(byId.get('lost').outcomeBasis, 'opportunity');
  assert.equal(byId.get('nothing-known').outcome, 'unknown', 'no record means unknown, never assumed open');
  assert.equal(result.outcomeCoverage.joined, true);
  assert.equal(result.outcomeCoverage.threadsWithOutcome, 3);

  // The outcome must reach the SAMPLER, not just the transcript: it is the stratum that lets a
  // booked conversation be drawn next to a lost one.
  const strata = new Set(result.sample.selections.map((selection) => selection.stratum));
  assert.ok(strata.size >= 3, 'distinct outcomes must produce distinct strata');
  // ...and it must not leak a real id into the manifest while doing it.
  assert.ok(!JSON.stringify(result.sample).includes('contact-booked'));
});

test('a pipeline nobody maintains cannot overrule the appointment record', async () => {
  /*
   * The case the ordering rule exists for, and the one the rank alone does NOT cover. This account
   * cancelled the appointment and the pipeline says the deal was won — which happens constantly on
   * accounts where staff close opportunities in bulk and never touch the calendar. The appointment
   * is the record that was actually touched by the event, so it decides.
   */
  const publicEvidence = {
    scopes: [
      { actionId: 'calendars-v3__get-calendar-events', items: [{ record: { contactId: 'c-1', calendarId: 'cal1', startTime: '2026-07-21T10:00:00+00:00', appointmentStatus: 'cancelled' } }] },
      { actionId: 'opportunities.search', items: [{ record: { contactId: 'c-1', pipelineId: 'p1', status: 'won' } }] },
    ],
  };
  const result = await collector(clientReturning([{ ...message('t1'), contactId: 'c-1' }]))
    .collectTranscripts({ publicEvidence });
  assert.equal(result.transcripts[0].outcome, 'cancelled');
  assert.equal(result.transcripts[0].outcomeBasis, 'appointment');
});

test('a deleted appointment decides nothing', async () => {
  const publicEvidence = {
    scopes: [{
      actionId: 'calendars-v3__get-calendar-events',
      items: [{ record: { contactId: 'c-1', calendarId: 'cal1', startTime: '2026-07-21T10:00:00+00:00', appointmentStatus: 'showed', deleted: true } }],
    }],
  };
  const result = await collector(clientReturning([{ ...message('t1'), contactId: 'c-1' }]))
    .collectTranscripts({ publicEvidence });
  assert.equal(result.transcripts[0].outcome, 'unknown');
});

test('with no public evidence every outcome is honestly unknown', async () => {
  const result = await collector(clientReturning([message('c1')])).collectTranscripts({});
  assert.equal(result.transcripts[0].outcome, 'unknown');
  assert.equal(result.outcomeCoverage.joined, false);
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
