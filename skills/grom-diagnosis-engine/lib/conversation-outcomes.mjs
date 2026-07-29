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
 * Vocabulary is fixed by `lib/sampling.mjs`: open, lost, won, booked, showed, no_show, cancelled,
 * unknown.
 * Nothing outside that set may be returned, because the sampler validates it and a stratum it does
 * not recognise fails the whole draw.
 */
import { sha256 } from './canonical.mjs';

/**
 * Appointment attendance and sales outcome are different dimensions.
 *
 * `showed` must never become `won`: attending a consultation is not buying. An opportunity sitting
 * at `open` while the appointment says `noshow` is still a no-show nobody moved, while a later
 * terminal opportunity can truthfully add the eventual won/lost result.
 */
const APPOINTMENT_OUTCOME = Object.freeze({
  showed: 'showed',
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

const TERMINAL_OPPORTUNITY = new Set(['won', 'lost']);

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

function instantOf(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string' || value.trim() === '') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function eventAt(record, fields) {
  for (const field of fields) {
    const parsed = instantOf(record[field]);
    if (parsed !== null) return parsed;
  }
  return null;
}

function eventRecord(record, outcome, kind) {
  const at = kind === 'appointment'
    ? eventAt(record, ['startTime', 'dateUpdated', 'updatedAt', 'dateAdded', 'createdAt'])
    : eventAt(record, ['lastStatusChangeAt', 'dateUpdated', 'updatedAt', 'dateAdded', 'createdAt']);
  return Object.freeze({
    outcome,
    at,
    // A deterministic tie-breaker only. Never leaves this module and never names a person.
    order: sha256({
      id: record.id ?? record._id ?? null,
      outcome,
      at,
    }),
  });
}

/** Latest by event time, deterministic under input reversal when two records tie. */
function latest(left, right) {
  if (left === null) return right;
  if (right === null) return left;
  if (left.at === null && right.at !== null) return right;
  if (left.at !== null && right.at === null) return left;
  if (left.at !== right.at) return (right.at ?? -Infinity) > (left.at ?? -Infinity) ? right : left;
  return right.order > left.order ? right : left;
}

function publicOutcome(event) {
  if (event === null) return null;
  return Object.freeze({ outcome: event.outcome, at: event.at });
}

/**
 * Pick the readable headline without destroying either underlying dimension.
 *
 * An open opportunity never overrules an appointment. A terminal opportunity is later in the
 * commercial journey, but it only becomes the headline when its dated transition is at least as
 * recent as the appointment. An undated/stale pipeline therefore cannot turn this week's no-show
 * into a historical win. Both dimensions still travel on the transcript whatever the headline is.
 */
function joinedOutcome(value) {
  const appointment = value.appointment;
  const opportunity = value.opportunity;
  let primary = appointment;
  let basis = appointment === null ? null : 'appointment';
  if (
    opportunity !== null
    && (
      appointment === null
      || (
        TERMINAL_OPPORTUNITY.has(opportunity.outcome)
        && opportunity.at !== null
        && (appointment.at === null || opportunity.at >= appointment.at)
      )
    )
  ) {
    primary = opportunity;
    basis = 'opportunity';
  }
  return Object.freeze({
    outcome: primary?.outcome ?? 'unknown',
    basis,
    appointmentOutcome: publicOutcome(appointment),
    opportunityOutcome: publicOutcome(opportunity),
  });
}

/**
 * Build `contactId -> { outcome, basis, appointmentOutcome, opportunityOutcome }`.
 *
 * Returns a plain Map so the caller can join on it without this module knowing anything about
 * conversations.
 */
export function buildOutcomeIndex(publicEvidence) {
  const recordsByContact = new Map();
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
        ? APPOINTMENT_OUTCOME[appointmentStatus.trim().toLowerCase()] ?? null
        : null;
      if (mapped === null) continue;
      statusesRecorded += 1;
      const current = recordsByContact.get(contactId) ?? { appointment: null, opportunity: null };
      recordsByContact.set(contactId, {
        ...current,
        appointment: latest(current.appointment, eventRecord(record, mapped, 'appointment')),
      });
      continue;
    }

    // An opportunity: kept beside the appointment and allowed to lead only under `joinedOutcome`.
    if (typeof record.status === 'string' && typeof record.pipelineId === 'string') {
      opportunitiesSeen += 1;
      const mapped = OPPORTUNITY_OUTCOME[record.status.trim().toLowerCase()] ?? null;
      if (mapped === null) continue;
      const current = recordsByContact.get(contactId) ?? { appointment: null, opportunity: null };
      recordsByContact.set(contactId, {
        ...current,
        opportunity: latest(current.opportunity, eventRecord(record, mapped, 'opportunity')),
      });
    }
  }

  const byContact = new Map(
    [...recordsByContact.entries()].map(([contactId, value]) => [contactId, joinedOutcome(value)]),
  );
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
export function outcomeStratumRef(joined) {
  return `stage_${sha256([
    'commercial-outcomes',
    joined?.appointmentOutcome?.outcome ?? 'unknown',
    joined?.opportunityOutcome?.outcome ?? 'unknown',
  ])}`;
}
