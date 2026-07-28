/**
 * WHAT COMMERCIALLY HAPPENED TO THE PERSON ON THE OTHER END OF A CONVERSATION.
 *
 * Reading the lead's replies was worth doing on its own, but on its own it cannot answer the
 * question the whole diagnosis exists for. "What do people say" is interesting. "What do the
 * conversations that ENDED IN A BOOKING look like, next to the ones that ended in silence" is the
 * question, and the first version of the transcript rail could not ask it: every thread carried
 * `outcome: unknown`, so the sampler could not stratify on outcome and the analyst could not
 * compare a won conversation against a lost one.
 *
 * ---------------------------------------------------------------------------------------------
 * THIS IS A JOIN, NOT A DERIVATION. The distinction is the whole design.
 *
 * The outcome is READ from evidence the public rail already collected and already projects —
 * appointment statuses and opportunity statuses — and attached to a thread by contact id. Nothing
 * here parses a message body, and nothing here decides an outcome. If the two rails disagree, the
 * public rail wins, because it is the one that owns these fields.
 *
 * That keeps the rule the transcripts were built under intact: no metric can move because a body
 * parsed differently this week. A body still cannot change an outcome. What it can now do is be
 * READ ALONGSIDE one.
 * ---------------------------------------------------------------------------------------------
 *
 * Vocabulary is fixed by `lib/sampling.mjs`: open, lost, won, booked, no_show, cancelled, unknown.
 * Nothing outside that set may be returned, because the sampler validates it and a stratum it does
 * not recognise fails the whole draw.
 */
import { sha256 } from './canonical.mjs';

/**
 * APPOINTMENT STATUS BEATS OPPORTUNITY STATUS, and the order matters.
 *
 * An opportunity sitting at `open` while the appointment says `noshow` is not an open lead; it is a
 * no-show nobody moved. On accounts where staff do not maintain the pipeline — which, per the SK
 * Skin caveats, is most of them — the appointment record is the more truthful of the two.
 */
const APPOINTMENT_OUTCOME = Object.freeze({
  showed: 'won',
  confirmed: 'booked',
  new: 'booked',
  booked: 'booked',
  noshow: 'no_show',
  no_show: 'no_show',
  'no-show': 'no_show',
  cancelled: 'cancelled',
  canceled: 'cancelled',
  invalid: 'cancelled',
});

const OPPORTUNITY_OUTCOME = Object.freeze({
  open: 'open',
  won: 'won',
  lost: 'lost',
  abandoned: 'lost',
});

/** How decisive each outcome is. A later appointment that showed beats an earlier one that did not. */
const RANK = Object.freeze({
  unknown: 0,
  open: 1,
  booked: 2,
  cancelled: 3,
  no_show: 4,
  lost: 5,
  won: 6,
});

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Every record the public collection produced, flattened.
 *
 * The envelope shape varies by how far through the pipeline the evidence is (scopes with pages of
 * items, items that wrap the GHL payload in `record`), so this is deliberately forgiving about the
 * container and strict about the record. A shape it cannot walk yields no outcomes, which degrades
 * to `unknown` everywhere and is exactly what happened before this module existed.
 */
function* recordsOf(publicEvidence) {
  const scopes = [
    ...(Array.isArray(publicEvidence?.scopes) ? publicEvidence.scopes : []),
    ...(Array.isArray(publicEvidence?.collections) ? publicEvidence.collections : []),
    ...(Array.isArray(publicEvidence) ? publicEvidence : []),
  ];
  for (const scope of scopes) {
    const actionId = scope?.actionId ?? scope?.action ?? scope?.operationId ?? null;
    const items = [
      ...(Array.isArray(scope?.items) ? scope.items : []),
      ...(Array.isArray(scope?.records) ? scope.records : []),
      ...(Array.isArray(scope?.pages) ? scope.pages.flatMap((page) => page?.items ?? []) : []),
    ];
    for (const item of items) {
      const record = isPlainObject(item?.record) ? item.record : item;
      if (isPlainObject(record)) yield { actionId, record };
    }
  }
}

function contactIdOf(record) {
  const value = record.contactId ?? record.contact_id ?? null;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function better(left, right) {
  return (RANK[right] ?? 0) > (RANK[left] ?? 0) ? right : left;
}

/**
 * Build `contactId -> { outcome, basis }` from the public evidence.
 *
 * Returns a plain Map so the caller can join on it without this module knowing anything about
 * conversations.
 */
export function buildOutcomeIndex(publicEvidence) {
  const byContact = new Map();
  let appointmentsSeen = 0;
  let opportunitiesSeen = 0;
  let statusesRecorded = 0;

  for (const { record } of recordsOf(publicEvidence)) {
    const contactId = contactIdOf(record);
    if (contactId === null) continue;

    /*
     * GHL ships BOTH spellings of this field and the second is their own long-standing typo. The
     * translator's comment records that they agreed on the capture; both are read anyway, because
     * relying on the correctly-spelled one and being wrong costs every appointment outcome.
     */
    const appointmentStatus = record.appointmentStatus ?? record.appoinmentStatus ?? null;
    const isAppointment = typeof appointmentStatus === 'string'
      || (typeof record.startTime === 'string' && typeof record.calendarId === 'string');
    if (isAppointment) {
      appointmentsSeen += 1;
      if (record.deleted === true) continue;
      const mapped = typeof appointmentStatus === 'string'
        ? APPOINTMENT_OUTCOME[appointmentStatus.toLowerCase()] ?? null
        : null;
      if (mapped === null) continue;
      statusesRecorded += 1;
      const current = byContact.get(contactId);
      byContact.set(contactId, {
        outcome: current === undefined ? mapped : better(current.outcome, mapped),
        basis: 'appointment',
      });
      continue;
    }

    // An opportunity: it has a pipeline and a status. Only consulted when no appointment spoke.
    if (typeof record.status === 'string' && typeof record.pipelineId === 'string') {
      opportunitiesSeen += 1;
      const mapped = OPPORTUNITY_OUTCOME[record.status.toLowerCase()] ?? null;
      if (mapped === null) continue;
      const current = byContact.get(contactId);
      if (current !== undefined && current.basis === 'appointment') continue;
      byContact.set(contactId, {
        outcome: current === undefined ? mapped : better(current.outcome, mapped),
        basis: 'opportunity',
      });
    }
  }

  return {
    byContact,
    coverage: {
      contactsWithOutcome: byContact.size,
      appointmentsSeen,
      opportunitiesSeen,
      /**
       * 🔴 How many appointments carried a status the account actually maintains. On SK Skin this
       * was 1 of 21, which is why a zero show rate there is a 5% RECORDING rate and not a
       * conversion problem. A lane that stratifies on outcome without reading this number will
       * describe an unrecorded account as a failing one.
       */
      appointmentStatusesRecorded: statusesRecorded,
    },
  };
}

/**
 * The opaque stratum for one thread.
 *
 * Hashed for the same reason every other sampler field is: the manifest is publishable beside a
 * finding and must name nobody. The readable outcome still travels on the TRANSCRIPT, which is
 * private evidence, so the analyst can see it while the manifest cannot leak it.
 */
export function outcomeStratumRef(outcome) {
  return `stage_${sha256(['outcome', outcome])}`;
}
