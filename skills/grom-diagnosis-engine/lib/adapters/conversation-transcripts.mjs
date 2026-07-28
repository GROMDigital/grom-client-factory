/**
 * CONVERSATION TRANSCRIPTS — the half of the conversation the account did not write.
 *
 * Until now every word this system read was OUR OWN: workflow message steps, library email bodies,
 * AI agent prompts. The lead's side of it was present only as shape — `lastMessageDirection`,
 * `lastOutboundMessageAction`, a channel, a count. So the copywriter lane could say "the account
 * asks an answerable question twice in 55 messages" but could never say what people actually
 * replied, what they asked that went unanswered, or what they said on the way out.
 *
 * This module reads the messages themselves, in both directions, and hands a BOUNDED SAMPLE of
 * whole threads to the analysis briefs.
 *
 * ---------------------------------------------------------------------------------------------
 * WHY THIS IS COPY EVIDENCE AND NOT JOURNEY EVIDENCE, AND WHY THAT LINE IS LOAD-BEARING.
 *
 * `profiles/client-projection.v1.json` lists both message reads under `unprojectedActions` with the
 * reason "engagement is taken from the conversation index, not from message content". That is a
 * deliberate measurement decision, not an oversight: whether a lead engaged is decided by the
 * conversation index, so that a metric can never move because a body parsed differently this week.
 *
 * Nothing here changes that. These transcripts never become journey events, never reach
 * `normalizeEvidence`, and never touch a metric. They are read for the same reason the email
 * library is read — so that the lane judging COPY can see the copy — and they travel the same way:
 * attached to the internal evidence bundle, stated as its own completeness, sampled and hashed.
 *
 * The parallel to `lib/adapters/email-copy.mjs` is exact and intentional. Read that module first.
 * ---------------------------------------------------------------------------------------------
 *
 * WHY ONE LOCATION-WIDE READ AND NOT A FAN-OUT PER CONVERSATION.
 *
 * `conversations-v3__get-messages` needs a `conversationId`, which means choosing threads BEFORE
 * seeing any content. That ordering breaks the sampler: `lib/sampling.mjs` guarantees that every
 * complaint and every opt-out is included, and a complaint is only visible in a body. Sampling on
 * the index would have produced a stratified draw with the mandatory guarantee silently empty,
 * which is worse than not sampling at all, because the manifest would still claim it.
 *
 * So the whole window is read once through `conversations-v3__export-messages-by-location`, the
 * threads are assembled and flagged from real content, and the sample is drawn with the flags
 * already known. The cost is one paginated walk; the fan-out that read replaces would have been
 * one call per thread.
 *
 * WHAT NEVER HAPPENS HERE:
 *
 *  - No body is redacted, masked or scrubbed. This is an internal diagnostic read by the people who
 *    already own the inbox, and a manufactured gap in a complaint is worse than the complaint.
 *  - No message is summarised on the way in. The analyst reads what was sent.
 *  - Nothing is projected. See above.
 *  - No metric is computed from a body, including the response-time band, which exists only to
 *    stratify the draw and is never reported as a measurement.
 */
import { canonicalJson, sha256 } from '../canonical.mjs';
import { selectConversationSample } from '../sampling.mjs';
import { buildOutcomeIndex, outcomeStratumRef } from '../conversation-outcomes.mjs';

export const CONVERSATION_TRANSCRIPTS_SCHEMA = '1.0.0';

/** The one action this module may call. It is in the checked-in read allowlist. */
export const MESSAGE_EXPORT_ACTION = 'conversations-v3__export-messages-by-location';

const DEFAULT_BUDGETS = Object.freeze({
  /**
   * Threads handed to the analysts. `lib/sampling.mjs` takes a CENSUS at or below its threshold, so
   * an account with fewer than fifty conversations in the week is read whole and the manifest says
   * `CENSUS`. Above it, the draw is stratified and every mandatory thread is in regardless.
   */
  censusThreshold: 50,
  maxSample: 50,
  /**
   * Messages assembled before the draw. Not a sample size — this is the universe the sample is
   * drawn FROM, so it is generous. Grom's UK account produces a few hundred in a week.
   */
  maxMessages: 20_000,
  /**
   * Characters of one message body. A body longer than this is truncated with a visible marker, so
   * the analyst can tell a long message from a cut one.
   */
  maxBodyChars: 4_000,
  /**
   * Characters across every SAMPLED thread, together. This is the prompt-size ceiling: the sampled
   * transcripts reach three lane briefs and every AI-agent review, so their total size is paid for
   * several times over. When the budget binds, whole threads are dropped from the tail of the draw
   * rather than every thread being trimmed, because half a conversation teaches nothing and the
   * manifest can then state exactly how many threads the analyst did not see.
   */
  maxTranscriptChars: 120_000,
  /**
   * Characters of ONE thread. A genuinely hard per-thread bound, and it exists because the total
   * budget alone is not one: an early implementation admitted the first thread unconditionally so
   * that a budget smaller than a single conversation could not produce an empty result, and a
   * single 10,000-character thread then blew a documented 1,000-character ceiling silently.
   *
   * A thread over this keeps its OPENING and its ENDING and elides the middle with a visible
   * marker, because how a conversation starts and how it dies are the two things being judged.
   */
  maxThreadChars: 24_000,
  /** Messages kept at each end of an elided thread. */
  threadHeadMessages: 6,
  threadTailMessages: 6,
});

/** Response-time bands, in milliseconds. Strata only. Never reported as a measurement. */
const RESPONSE_BANDS = Object.freeze([
  ['instant', 5 * 60_000],
  ['fast', 60 * 60_000],
  ['moderate', 24 * 60 * 60_000],
]);

/** Call-duration bands, in seconds. Strata only. */
const CALL_BANDS = Object.freeze([
  ['short', 60],
  ['medium', 300],
]);

/**
 * The one flag family that can be read off a body with a straight face.
 *
 * These are STRATIFICATION flags, not findings. Their whole job is to guarantee that a thread
 * containing one of them is in the sample; whether it really is a complaint is the analyst's
 * judgement, made by reading it. A false positive therefore costs one sample slot, and a false
 * negative costs a guarantee, so both patterns are deliberately loose.
 */
const OPT_OUT = /\b(?:stop|unsubscribe|opt[\s-]?out|remove me|take me off|delete my (?:number|details)|lose my number|leave me alone|do ?n[o']?t (?:contact|call|text|message|email|ring)|do not (?:contact|call|text|message|email|ring)|stop (?:contacting|calling|texting|messaging|emailing))\b/iu;
const COMPLAINT = /\b(?:complain(?:t|ing)?|unhappy|dissatisfied|disappointed|refund|terrible|awful|rude|appalling|useless|shambles|disgrace(?:ful)?|furious|angry|annoyed|fed up|waste of (?:my )?time|scam|misleading|report you|trading standards|never (?:got|received|heard)|still waiting|been waiting|ignored me|ignoring me|no ?one (?:has )?(?:called|replied|responded|got back|been in touch))\b/iu;
const FAILED_STATUS = new Set(['failed', 'undelivered', 'rejected', 'error', 'bounced']);
/**
 * A call that nobody had. VERIFIED LIVE: a `TYPE_CALL` record carries this in `status`
 * (`no-answer`, `voicemail` both observed on the UK account), NOT in a `callStatus` field — the
 * first draft read `callStatus` only and would never have flagged a single abandoned call.
 */
const UNANSWERED_CALL = new Set(['no-answer', 'no_answer', 'noanswer', 'busy', 'failed', 'canceled', 'cancelled', 'voicemail', 'missed']);

function codedError(code, ErrorType = Error) {
  return Object.assign(new ErrorType(code), { code });
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function byteOrder(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** An opaque ref of the shape `lib/sampling.mjs` demands. No real id ever reaches the manifest. */
function ref(prefix, ...parts) {
  return `${prefix}_${sha256(parts)}`;
}

function firstString(record, keys) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

function epochMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

/**
 * One message, reduced to what judging a conversation needs.
 *
 * GHL's export payload is NOT pinned by the bundled catalog — the spec types the response as an
 * object and stops. So every field is read through a list of spellings rather than one, and a
 * record that yields neither a body nor a timestamp is counted as unreadable rather than dropped
 * silently. `unreadable` is what makes the difference between "this account sent nothing" and "we
 * could not parse what it sent" visible in the result.
 */
function messageRecord(entry, maxBodyChars) {
  if (!isPlainObject(entry)) return null;
  const conversationId = firstString(entry, ['conversationId', 'conversation_id']);
  if (conversationId === null) return null;
  const at = epochMs(entry.dateAdded ?? entry.createdAt ?? entry.dateUpdated ?? entry.timestamp);
  const rawBody = firstString(entry, ['body', 'message', 'text', 'snippet']);
  const direction = firstString(entry, ['direction']) ?? 'unknown';
  const channel = firstString(entry, ['messageType', 'type', 'contentType']) ?? 'unknown';
  const status = firstString(entry, ['status', 'deliveryStatus', 'messageStatus']);
  const callStatus = firstString(entry, ['callStatus', 'call_status']);
  const duration = typeof entry.callDuration === 'number' ? entry.callDuration : null;
  const body = rawBody === null
    ? null
    : rawBody.length > maxBodyChars
      ? `${rawBody.slice(0, maxBodyChars)}\n[TRUNCATED at ${maxBodyChars} characters]`
      : rawBody;
  return {
    conversationId,
    contactId: firstString(entry, ['contactId', 'contact_id']),
    // Outbound only, and `workflow` on every automated send. See the live shape above.
    source: firstString(entry, ['source']),
    at,
    direction: direction === 'inbound' || direction === 'outbound' ? direction : 'unknown',
    channel,
    status,
    callStatus,
    callDuration: duration,
    body,
    // An attachment-only message has no body and is not a parse failure.
    attachmentCount: Array.isArray(entry.attachments) ? entry.attachments.length : 0,
    unreadable: at === null && rawBody === null,
  };
}

function isCall(message) {
  return /call|voice/iu.test(message.channel) || message.callDuration !== null || message.callStatus !== null;
}

/** Flags that force a thread into the sample. See the `OPT_OUT` comment for what they are for. */
function flagsFor(messages) {
  const flags = new Set();
  for (const message of messages) {
    const call = isCall(message);
    /*
     * `status` carries BOTH meanings depending on the channel, which is why the call check comes
     * first: on an SMS `failed` is a delivery failure, on a `TYPE_CALL` it is a call nobody took.
     * Counting an unanswered call as a delivery failure would report a working phone line as broken.
     */
    if (!call && typeof message.status === 'string' && FAILED_STATUS.has(message.status.toLowerCase())) {
      flags.add('failure');
    }
    if (
      call
      && (
        message.callDuration === 0
        || [message.callStatus, message.status].some(
          (value) => typeof value === 'string' && UNANSWERED_CALL.has(value.toLowerCase()),
        )
      )
    ) flags.add('abandoned_call');
    // Only the LEAD can complain or opt out. Matching our own outbound copy would flag every
    // sequence that contains the word "stop" in its footer.
    if (message.direction !== 'inbound' || typeof message.body !== 'string') continue;
    if (OPT_OUT.test(message.body)) flags.add('opt_out');
    if (COMPLAINT.test(message.body)) flags.add('complaint');
  }
  /*
   * `high_value_loss` is never set. It needs the opportunity's monetary value, which lives on the
   * public journey rail this module deliberately does not read from, and guessing it from a body
   * would put a fabricated value inside the one guarantee the sampler makes. A thread that is both
   * high value and lost still reaches the analyst through the ordinary stratified draw.
   */
  return [...flags].sort(byteOrder);
}

function responseTimeBand(messages) {
  for (let index = 0; index < messages.length; index += 1) {
    const inbound = messages[index];
    if (inbound.direction !== 'inbound' || inbound.at === null) continue;
    const reply = messages.slice(index + 1).find(
      (message) => message.direction === 'outbound' && message.at !== null,
    );
    if (reply === undefined) return 'slow';
    const gap = reply.at - inbound.at;
    return RESPONSE_BANDS.find(([, limit]) => gap < limit)?.[0] ?? 'slow';
  }
  return 'unknown';
}

function callDurationBand(messages) {
  const calls = messages.filter((message) => isCall(message) && message.callDuration !== null);
  if (calls.length === 0) return 'unknown';
  const longest = Math.max(...calls.map((message) => message.callDuration));
  if (longest === 0) return 'none';
  return CALL_BANDS.find(([, limit]) => longest < limit)?.[0] ?? 'long';
}

function occurredAtBand(at, fromMs, toMs) {
  if (at === null || !(toMs > fromMs)) return 'mid_week';
  const position = (at - fromMs) / (toMs - fromMs);
  if (position < 1 / 3) return 'early_week';
  return position < 2 / 3 ? 'mid_week' : 'late_week';
}

/**
 * VERIFIED LIVE against the UK sub-account on 2026-07-29, `limit: 100`:
 *
 *   { messages: [{ id, direction, status, type, locationId, attachments, body, contactId,
 *                  contentType, conversationId, dateAdded, dateUpdated, altId, from, to,
 *                  messageType, source }],
 *     nextCursor, total: 2767, traceId }
 *
 * Three things that are NOT guesses and that the parser depends on:
 *
 *  - `dateAdded` is an ISO STRING here, not the epoch-millisecond number the conversation index
 *    uses for the same concept. Both are accepted.
 *  - There is NO `userId` on any message, in either direction. An owner cannot be read off this
 *    endpoint at all, so nothing pretends to.
 *  - `source` appears on OUTBOUND messages only (`workflow` on every automated send observed) and
 *    is absent on inbound. It is the one field that says whether a human ever typed into a thread,
 *    which is why it is both the sampler's owner discriminator and a field on the transcript.
 *
 * `limit` below 10 is a 422 (`limit must not be less than 10`). The translator sends 100.
 */

/**
 * Assemble threads from a flat message list.
 *
 * Sorted by time within a thread and by id between them, so the same window always produces the
 * same universe in the same order and the sampler's determinism survives a reordered response.
 */
export function threadsFromMessages(messages, { fromMs, toMs, outcomes = null }) {
  const byConversation = new Map();
  for (const message of messages) {
    byConversation.set(message.conversationId, [...(byConversation.get(message.conversationId) ?? []), message]);
  }
  const threads = [];
  for (const [conversationId, group] of byConversation) {
    const contactId = group.find((message) => message.contactId !== null)?.contactId ?? null;
    /*
     * JOINED, never derived. See `lib/conversation-outcomes.mjs`: this comes from appointment and
     * opportunity records the public rail already owns, matched by contact id. A thread whose
     * contact has no such record is honestly `unknown` rather than assumed open.
     */
    const joined = contactId === null ? null : outcomes?.byContact?.get(contactId) ?? null;
    const outcome = joined?.outcome ?? 'unknown';
    group.sort((left, right) => (left.at ?? 0) - (right.at ?? 0));
    const last = group.at(-1);
    const lastOutbound = [...group].reverse().find((message) => message.direction === 'outbound');
    const channels = [...new Set(group.map((message) => message.channel))].sort(byteOrder);
    threads.push({
      conversationId,
      messages: group,
      flags: flagsFor(group),
      channels,
      // Readable on the transcript, opaque in the manifest. Both are deliberate.
      outcome,
      outcomeBasis: joined?.basis ?? null,
      inboundCount: group.filter((message) => message.direction === 'inbound').length,
      outboundCount: group.filter((message) => message.direction === 'outbound').length,
      lastAt: last?.at ?? null,
      lastDirection: last?.direction ?? 'unknown',
      outboundSources: [...new Set(
        group.filter((message) => message.direction === 'outbound' && message.source !== null)
          .map((message) => message.source),
      )].sort(byteOrder),
      interaction: {
        interactionRef: ref('obj', 'conversation', conversationId),
        // The contact, when the export named one. A thread with no contact id still has a subject:
        // itself. Inventing a shared placeholder would collapse unrelated threads into one person.
        subjectRef: ref('psn', 'contact', contactId ?? conversationId),
        evidenceRefs: [ref('ev', 'conversation-transcript', conversationId)],
        occurredAtBand: occurredAtBand(last?.at ?? null, fromMs, toMs),
        source: ref('src', 'channels', channels.join(',')),
        /*
         * The COMMERCIAL stratum when the public rail knows one, and only then the who-spoke-last
         * proxy. That ordering is the point of the join: stratifying on outcome is what lets the
         * draw put booked conversations next to lost ones, which is the comparison the whole
         * diagnosis rests on. The proxy stays as the fallback for a thread whose contact has no
         * appointment and no opportunity, where there is genuinely nothing commercial to say.
         */
        stage: outcome === 'unknown'
          ? ref('stage', 'last-direction', last?.direction ?? 'unknown')
          : outcomeStratumRef(outcome),
        outcome,
        responseTimeBand: responseTimeBand(group),
        callDurationBand: callDurationBand(group),
        handoffState: 'unknown',
        /*
         * WHO SENT THE LAST OUTBOUND — automation or a person. This endpoint carries no `userId` in
         * either direction (verified live), so an owner in the usual sense cannot be read at all.
         * `source` can, and it is the more decisive split anyway: a thread the account only ever
         * spoke to through a workflow is a different thing from one a human answered.
         */
        ownerRef: ref('actor', 'source', lastOutbound?.source ?? 'none'),
        flags: flagsFor(group),
      },
    });
  }
  return threads.sort((left, right) => byteOrder(left.conversationId, right.conversationId));
}

/**
 * The transcript the analyst reads. Ids are kept: this is an internal diagnostic and a finding that
 * cannot be traced back to the conversation it came from cannot be acted on.
 */
function transcriptOf(thread) {
  return {
    conversationId: thread.conversationId,
    channels: thread.channels,
    /*
     * What commercially happened to this person, joined from the public rail. `outcomeBasis` says
     * WHICH record decided it, because on an account that does not maintain its pipeline an
     * opportunity-based outcome means much less than an appointment-based one.
     */
    outcome: thread.outcome,
    outcomeBasis: thread.outcomeBasis,
    inboundCount: thread.inboundCount,
    outboundCount: thread.outboundCount,
    flags: thread.flags,
    lastDirection: thread.lastDirection,
    /*
     * Whether a HUMAN ever typed into this thread. `workflow` alone means every word the account
     * said was automated, which is the single most useful thing to know about a conversation that
     * went nowhere. Absent on inbound, so a thread with no outbound message has an empty list.
     */
    outboundSources: thread.outboundSources,
    messages: thread.messages.map((message) => ({
      at: message.at,
      direction: message.direction,
      channel: message.channel,
      ...(message.status === null ? {} : { status: message.status }),
      ...(message.callStatus === null ? {} : { callStatus: message.callStatus }),
      ...(message.callDuration === null ? {} : { callDuration: message.callDuration }),
      ...(message.attachmentCount > 0 ? { attachmentCount: message.attachmentCount } : {}),
      body: message.body,
    })),
  };
}

function transcriptSize(transcript) {
  return canonicalJson(transcript).length;
}

/**
 * Bring ONE thread under the per-thread ceiling by eliding its middle.
 *
 * Elision, not truncation: a conversation cut off at the top loses how it opened and a conversation
 * cut off at the bottom loses how it ended, and those are the two things a copy analyst is reading
 * for. The marker is a real entry in the message list so the gap cannot be mistaken for a jump in
 * the conversation itself.
 */
function elideToFit(transcript, limits) {
  if (transcriptSize(transcript) <= limits.maxThreadChars) return transcript;
  const { messages } = transcript;
  const head = limits.threadHeadMessages;
  const tail = limits.threadTailMessages;
  if (messages.length <= head + tail) {
    // Few messages, so the size is in the bodies rather than the count. Nothing to elide that
    // would help; the thread is declared oversized and the analyst is told.
    return { ...transcript, oversized: true };
  }
  const omitted = messages.length - head - tail;
  return {
    ...transcript,
    elided: true,
    messages: [
      ...messages.slice(0, head),
      { elidedMessages: omitted, note: `${omitted} messages omitted from the middle of this thread to fit the size budget. The opening and the ending are complete.` },
      ...messages.slice(-tail),
    ],
  };
}

/** The bounded envelope every governed read carries. Identical in shape to the journey collector's. */
function exportRequest(capability, locationId, fromDate, toDate) {
  return {
    name: 'execute_action',
    arguments: {
      action: MESSAGE_EXPORT_ACTION,
      params: { locationId, fromDate, toDate },
      policy: {
        actionId: capability.actionId,
        method: capability.method,
        normalizedPath: capability.normalizedPath,
        category: capability.category,
        risk: capability.risk,
        sourceSnapshotHash: capability.sourceSnapshotHash,
        allowlistHash: capability.allowlistHash,
        providerId: capability.providerId,
        capabilityManifestHash: capability.capabilityManifestHash,
      },
    },
  };
}

/**
 * The translator exhausts the scope upstream and answers one normalised page, so the payload is
 * `{ items, page, dataQuality }` at `structuredContent`. Both depths are accepted for the same
 * reason `email-copy.mjs` accepts both: a host that injects an already-unwrapped delegate must
 * still work, and reading one level too shallow is the exact defect that made the first live
 * email-copy run report a shape error against a perfectly good 200.
 */
function pageOf(response) {
  const outer = response?.structuredContent ?? response;
  if (!isPlainObject(outer)) return null;
  if (Array.isArray(outer.items)) return outer;
  if (isPlainObject(outer.data) && Array.isArray(outer.data.items)) return outer.data;
  return null;
}

function emptyResult(boundLocationId, limitations, extra = {}) {
  return Object.freeze({
    schemaVersion: CONVERSATION_TRANSCRIPTS_SCHEMA,
    boundLocationId,
    complete: false,
    limitations: Object.freeze([...new Set(limitations)].sort(byteOrder)),
    universeCount: 0,
    messageCount: 0,
    transcripts: Object.freeze([]),
    sample: null,
    transcriptsHash: sha256([]),
    ...extra,
  });
}

/**
 * Collect a bounded sample of whole conversation transcripts for the run's window.
 *
 * Fails SOFT, like every copy rail. A window that cannot be read becomes a stated limitation and an
 * empty transcript set; it must never cost a run its workflows, and it must never be mistaken for
 * an account that had no conversations.
 */
export function createConversationTranscriptCollector({
  client,
  capability,
  boundLocationId,
  window: runWindow,
  budgets = {},
} = {}) {
  const fromDate = runWindow?.fromDate;
  const toDate = runWindow?.toDate;
  if (
    typeof client?.callTool !== 'function'
    || !isPlainObject(capability)
    || capability.actionId !== MESSAGE_EXPORT_ACTION
    || typeof boundLocationId !== 'string'
    || boundLocationId.length === 0
    || typeof fromDate !== 'string'
    || typeof toDate !== 'string'
    || !Number.isFinite(Date.parse(fromDate))
    || !Number.isFinite(Date.parse(toDate))
    || Date.parse(fromDate) >= Date.parse(toDate)
  ) throw codedError('CONVERSATION_TRANSCRIPTS_CONFIG_INVALID', TypeError);
  const limits = { ...DEFAULT_BUDGETS, ...budgets };
  const fromMs = Date.parse(fromDate);
  const toMs = Date.parse(toDate);

  return {
    async collectTranscripts({ signal, publicEvidence = null } = {}) {
      const limitations = new Set();

      let page;
      try {
        page = pageOf(await client.callTool(
          exportRequest(capability, boundLocationId, fromDate, toDate),
          { signal },
        ));
      } catch (error) {
        return emptyResult(boundLocationId, [boundedCode(error)]);
      }
      if (page === null) return emptyResult(boundLocationId, ['CONVERSATION_MESSAGE_EXPORT_SHAPE']);
      if (page.page?.truncated === true) limitations.add('CONVERSATION_MESSAGE_EXPORT_TRUNCATED');

      const raw = page.items.slice(0, limits.maxMessages);
      if (page.items.length > limits.maxMessages) limitations.add('CONVERSATION_MESSAGE_BUDGET_EXHAUSTED');
      const messages = [];
      let unparsed = 0;
      for (const entry of raw) {
        // The translator annotates each record; the GHL payload is at `record` when it does.
        const record = messageRecord(
          isPlainObject(entry?.record) ? entry.record : entry,
          limits.maxBodyChars,
        );
        if (record === null || record.unreadable) {
          unparsed += 1;
          continue;
        }
        messages.push(record);
      }
      if (unparsed > 0) limitations.add('CONVERSATION_MESSAGE_RECORD_UNREADABLE');
      /*
       * A window with messages in it that yielded no readable record is a PARSE failure wearing an
       * empty result's clothes, and an empty transcript set is exactly what a quiet account looks
       * like. Naming it is the difference between the analyst writing "nobody wrote to this
       * account" and "we could not read what they wrote".
       */
      if (raw.length > 0 && messages.length === 0) {
        return emptyResult(boundLocationId, [...limitations, 'CONVERSATION_MESSAGE_EXPORT_UNPARSEABLE'], {
          messageCount: 0,
        });
      }

      /*
       * THE JOIN. Built here rather than in `threadsFromMessages` so the pure function stays pure
       * and testable, and so a run with no public evidence degrades to every outcome `unknown`
       * rather than failing — which is exactly what this rail did before the join existed.
       */
      const outcomes = publicEvidence === null ? null : buildOutcomeIndex(publicEvidence);
      const threads = threadsFromMessages(messages, { fromMs, toMs, outcomes });
      if (threads.length === 0) {
        return Object.freeze({
          schemaVersion: CONVERSATION_TRANSCRIPTS_SCHEMA,
          boundLocationId,
          complete: limitations.size === 0,
          limitations: Object.freeze([...limitations].sort(byteOrder)),
          universeCount: 0,
          messageCount: 0,
          transcripts: Object.freeze([]),
          sample: null,
          transcriptsHash: sha256([]),
        });
      }

      /*
       * The seed is derived from the window and the account, so the same week drawn twice draws the
       * same threads, and two different weeks do not draw the same stratum positions. It is
       * deliberately NOT random: a diagnosis that cannot be reproduced from its own inputs cannot
       * be argued with.
       */
      const seed = `seed_${sha256({ boundLocationId, fromDate, toDate })}`;
      let sample;
      try {
        sample = selectConversationSample({
          interactions: threads.map(({ interaction }) => interaction),
          seed,
          censusThreshold: limits.censusThreshold,
          maxSample: limits.maxSample,
        });
      } catch (error) {
        return emptyResult(boundLocationId, [...limitations, boundedCode(error)], {
          universeCount: threads.length,
          messageCount: messages.length,
        });
      }

      const byRef = new Map(threads.map((thread) => [thread.interaction.interactionRef, thread]));
      /*
       * Flagged threads FIRST, so the prompt-size budget can only ever cost an ordinary thread. A
       * complaint that fell out because a long thread came before it alphabetically would defeat
       * the one guarantee this rail makes.
       *
       * Ordered on the THREAD's own flags and NOT on `selectionReasons`. Under a CENSUS the sampler
       * has no reason to mark anything mandatory — everything is in — so every reason reads
       * `census` and a flag-blind sort silently dropped the one complaint in a small account. That
       * is exactly the case with the fewest conversations and the most at stake in each.
       */
      const flagged = new Set(
        threads.filter(({ flags }) => flags.length > 0).map(({ interaction }) => interaction.interactionRef),
      );
      const ordered = [...sample.selections].sort((left, right) => (
        Number(flagged.has(right.interactionRef)) - Number(flagged.has(left.interactionRef))
        || byteOrder(left.interactionRef, right.interactionRef)
      ));

      /*
       * TWO bounds, and the total is a REAL ceiling.
       *
       * The first version admitted the first thread unconditionally, so that a budget smaller than
       * one conversation could not return nothing. That made the documented hard ceiling soft: one
       * 10,000-character thread sailed past a 1,000-character budget reporting no limitation at
       * all. The per-thread elision above is what makes the unconditional case unnecessary — a
       * thread is brought under `maxThreadChars` first, so admitting it cannot blow the total by
       * more than one bounded thread, and if even that does not fit it is dropped and SAID.
       */
      const transcripts = [];
      let characters = 0;
      let dropped = 0;
      let droppedFlagged = 0;
      let elided = 0;
      for (const selection of ordered) {
        const thread = byRef.get(selection.interactionRef);
        if (thread === undefined) continue;
        const transcript = elideToFit(transcriptOf(thread), limits);
        if (transcript.elided === true || transcript.oversized === true) elided += 1;
        const size = transcriptSize(transcript);
        if (characters + size > limits.maxTranscriptChars) {
          dropped += 1;
          if (flagged.has(selection.interactionRef)) droppedFlagged += 1;
          continue;
        }
        characters += size;
        transcripts.push(transcript);
      }
      if (dropped > 0) limitations.add('CONVERSATION_TRANSCRIPT_CHAR_BUDGET_EXHAUSTED');
      if (elided > 0) limitations.add('CONVERSATION_TRANSCRIPT_THREAD_ELIDED');
      /*
       * THE RECONCILIATION. The manifest is a claim about what the analyst received, and until now
       * nothing checked it against what was actually handed over. If a flagged thread did not fit,
       * the mandatory guarantee DID NOT HOLD, and that has to be said in those words rather than
       * left to be inferred from two counts that do not match — every downstream sentence about
       * complaints depends on it.
       */
      const mandatoryGuaranteeHeld = droppedFlagged === 0;
      if (!mandatoryGuaranteeHeld) limitations.add('CONVERSATION_MANDATORY_THREAD_DROPPED');
      transcripts.sort((left, right) => byteOrder(left.conversationId, right.conversationId));

      return Object.freeze({
        schemaVersion: CONVERSATION_TRANSCRIPTS_SCHEMA,
        boundLocationId,
        complete: limitations.size === 0,
        limitations: Object.freeze([...limitations].sort(byteOrder)),
        universeCount: threads.length,
        messageCount: messages.length,
        /** How many of the drawn threads the analyst is actually handed. */
        sampledCount: transcripts.length,
        droppedForSizeCount: dropped,
        /**
         * 🔴 The honest reconciliation of the manifest against the delivery. When this is false the
         * sample manifest still reports its `mandatoryCount`, but the analyst did NOT receive that
         * many flagged threads, and no sentence claiming every complaint was included may be
         * written. The brief reads this field and changes what it says.
         */
        mandatoryGuaranteeHeld,
        droppedFlaggedCount: droppedFlagged,
        /**
         * How well the commercial join landed, and how many threads it could say nothing about.
         * A lane that stratifies on outcome without reading this will describe an account that
         * simply does not record attendance as an account whose leads do not attend.
         */
        outcomeCoverage: outcomes === null
          ? { joined: false, reason: 'No public evidence was available to this rail, so every conversation outcome is unknown.' }
          : {
              joined: true,
              ...outcomes.coverage,
              threadsWithOutcome: threads.filter(({ outcome }) => outcome !== 'unknown').length,
              threadsTotal: threads.length,
            },
        elidedThreadCount: elided,
        unparsedMessageCount: unparsed,
        transcripts: Object.freeze(transcripts),
        // The full manifest, including the strata and inclusion probabilities. It carries opaque
        // refs only, so it can be published beside a finding without naming anybody.
        sample,
        transcriptsHash: sha256(canonicalJson(transcripts)),
      });
    },
  };
}

/** An UPPER_SNAKE code or nothing. A raw message here can carry a lead's words. */
function boundedCode(error) {
  const code = error?.code;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{2,63}$/u.test(code)
    ? code
    : 'CONVERSATION_TRANSCRIPT_COLLECTION_FAILED';
}
