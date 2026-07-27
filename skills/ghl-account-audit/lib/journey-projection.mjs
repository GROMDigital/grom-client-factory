/**
 * THE JOURNEY PROJECTOR — the bridge from raw account records to canonical journey evidence.
 *
 * `normalizeEvidence` (`lib/normalize.mjs:248`) does not accept raw platform objects. It requires
 * items already shaped as `journey_event` and friends, each carrying a stage, a journey, a journey
 * instance, an identity and a canonical event time. The collection rail emits whatever the account
 * actually returned. This module is the only thing between the two.
 *
 * ---------------------------------------------------------------------------------------------
 * THE MAPPING IS DATA. THIS FILE CONTAINS NONE OF IT.
 *
 * Which native state means which stage, which field carries an amount, which field can be read as
 * an instant — all of that is a per-account fact and it lives entirely in a projection contract
 * file validated by `ProjectionContractSchema`. There is deliberately not one native field name,
 * native value or stage name anywhere below, and a test reads this source and proves it. Adding a
 * third account must be a matter of writing one more JSON file and touching nothing here.
 * ---------------------------------------------------------------------------------------------
 *
 * EIGHT RULES drive nearly every branch below, and they are the ONLY numbering this file uses.
 * Inline comments cite these numbers and nothing else: an earlier revision also cited the review
 * findings that produced them, which left a reader unable to tell which "rule 5" was meant.
 *
 * 1. AN AMOUNT IS NEVER QUIETLY READ AS ZERO. An engine in this workspace has been observed
 *    writing the canonical amount field as a STRING, and `evidence-graph.mjs:110-111` DROPS a
 *    non-finite amount without a word. So when a declared amount path resolves to anything that is
 *    not a finite number at or above zero, the event is still emitted, but as UNKNOWN with a
 *    recorded reason, and with no amount key at all. Emitting it as observed would be worse than
 *    wrong: `normalize.mjs:163-172` treats that as fatal.
 * 2. THE JOURNEY INSTANCE COMES FROM THE COVERAGE PROFILE. Never from the projection file, never
 *    from the raw record. `evidence-graph.mjs:451-457` throws otherwise.
 * 3. AN INSTANT IS READ ONLY FROM AN UNAMBIGUOUS, ZONE-BEARING FORM. `Date.parse` falls back to
 *    the HOST LOCAL TIMEZONE for anything ECMA-262 does not define, which silently relocates an
 *    account's history by hours depending on which machine happened to run the audit, and the
 *    kernel byte-compares this output on resume. Nothing is guessed: an epoch magnitude that could
 *    be either seconds or milliseconds is refused, not rounded into 1970, and a value that cannot
 *    be placed on a timeline suppresses its event rather than inheriting the capture time.
 * 4. INCOMPLETENESS PROPAGATES AND IS NEVER LAUNDERED. An incomplete input envelope always yields
 *    an incomplete output envelope carrying the same reason, and an input envelope whose own
 *    completeness claim contradicts its resume state is REFUSED rather than repaired. Rebuilding a
 *    clean envelope out of a self-contradictory one manufactures confidence the evidence does not
 *    support, and it is the single most damaging thing this module could do. The mechanism, not the
 *    field: EVERY envelope-level value this module carries forward is validated against exactly what
 *    `normalize.mjs` requires and then COPIED, never reconstructed from parts. A reconstruction is
 *    only ever as strict as the validation in front of it, and the first cut proved that: a window
 *    carrying a third key was refused as an input and accepted as this module's output, because the
 *    output was a fresh two-key object rather than the object that arrived.
 * 5. A SUBJECT IS EVIDENCE, NOT ONLY WHAT HAPPENED TO IT. `evidence-graph.mjs:217-218` builds the
 *    entity nodes that every `identity_exact` edge hangs off ONLY from entity records. A contract
 *    that declares events alone can never produce a proving join, so `metrics.mjs:220` returns
 *    UNKNOWN for every metric of every account. A source therefore declares the entities its
 *    payload yields as well as the events.
 * 6. A SUPPRESSION SURVIVES THE NEXT STAGE. `normalize.mjs:271-283` raises a collection-level
 *    signal only for an EMPTY INCOMPLETE envelope, and `normalize.mjs:260-269` discards everything
 *    this module writes onto the envelope. So a COMPLETE envelope whose rows were suppressed
 *    emits its own collection-level signal record, which normalisation carries and
 *    `evidence-graph.mjs:181-189` turns into an unresolved join. Without it, an account whose
 *    subjects were all dropped by one wrong identity path is indistinguishable from an account
 *    that genuinely had none.
 * 7. AN EVENT WHOSE SUBJECT NOTHING CAN KEY IS NEVER EMITTED AS OBSERVED. Rule 5 says a source
 *    declares the subjects its payload yields; this says the projector CHECKS it, per run, against
 *    the subjects actually emitted. `metrics.mjs:220` blanks an edge for EVERY subject as soon as
 *    ONE event has no proving join, so an event whose subject never appeared as an entity record —
 *    and which no composite identity can prove either — is downgraded to UNKNOWN with a counted
 *    reason. Declaring the entities is a contract fact and can be got wrong in data; this is the
 *    check that makes getting it wrong impossible to do SILENTLY.
 * 8. AN ENVELOPE'S OWN WINDOW BOUNDS THE EVENTS IT MAY CARRY. A payload can and does return rows
 *    outside the window that was asked for, and an instant resolved from a declared path is only
 *    evidence for the period the envelope claims to cover. Nothing downstream re-checks this: the
 *    projector is the only place that still holds both the envelope's applied window and the
 *    resolved instant, so an event outside it is suppressed with a counted reason rather than
 *    silently landing in whatever period the metric layer happens to bucket it into.
 *
 * Everything dropped is COUNTED on the envelope it was dropped from, with its unit, so the counts
 * reconcile against the input row count instead of merely gesturing at it.
 *
 * Pure, deterministic, deep-frozen. The kernel checkpoints this output and byte-compares it on
 * resume (`lib/kernel.mjs:494-496`), so input ORDER may never reach the result: envelopes are
 * processed in an order derived from their own content, items are sorted by BYTE order over their
 * own canonical form (never `localeCompare`, which reports two distinct strings as equal whenever
 * they differ only by a collation-ignorable character), and every ordering choice — including the
 * one that picks the survivor of a `first_of_kind` tie — is taken over EMITTED CONTENT. No index
 * into an input array is ever consulted: `collection.items` is never sorted, so a tiebreak on a row
 * position is a tiebreak on arrival order wearing a total order's clothes.
 */
import { canonicalJson, sha256 } from './canonical.mjs';

function codedError(code, ErrorType = Error) {
  return Object.assign(new ErrorType(code), { code });
}

function isPlainObject(value) {
  return Boolean(
    value
    && typeof value === 'object'
    && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null),
  );
}

function deepFreeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const nested of Object.values(value)) deepFreeze(nested, seen);
  return Object.freeze(value);
}

/**
 * A BYTE comparison, not a locale comparison. `localeCompare` returns 0 for two distinct strings
 * that differ only by a collation-ignorable code point, which makes the sort fall back to input
 * order and lets the input order reach the output. Reproduced on a real profile with one soft
 * hyphen inside an address.
 */
function byteCompare(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/** `normalize.mjs:157` — the pattern a stage must satisfy to survive as observed evidence. */
const IDENTIFIER_PATTERN = /^[a-z][a-z0-9_]{0,127}$/u;
/** `normalize.mjs:124-126` — the pattern a cohort reference must satisfy. */
const COHORT_PREFIX = 'cohort_';
const RECORD_TYPE = 'journey_event';

/**
 * The identity fields `normalize.mjs:178-194` recognises. Order is fixed so two runs build the
 * same object with the same key order and therefore the same bytes.
 */
const IDENTITY_FIELDS = Object.freeze([
  'nativeId',
  'subjectNativeId',
  'organizationNativeId',
  'opportunityNativeId',
  'projectNativeId',
  'normalizedEmail',
  'normalizedPhone',
]);

const REASON_NO_SOURCE = 'COLLECTION_MATCHED_NO_PROJECTION_SOURCE';
const REASON_NOT_AN_OBJECT = 'RECORD_NOT_AN_OBJECT';
const REASON_NO_IDENTITY = 'IDENTITY_UNRESOLVED';
const REASON_NO_OUTPUT = 'RECORD_YIELDED_NO_EVENT';
const REASON_NO_INSTANT = 'EVENT_TIME_UNPARSEABLE';
const REASON_ZONE_UNSPECIFIED = 'EVENT_TIME_ZONE_UNSPECIFIED';
const REASON_EPOCH_AMBIGUOUS = 'EVENT_TIME_EPOCH_AMBIGUOUS';
const REASON_NOT_FIRST = 'NOT_FIRST_OF_KIND';
const REASON_NO_ENTITY_KEY = 'ENTITY_NATIVE_ID_UNRESOLVED';
const REASON_OUTSIDE_WINDOW = 'EVENT_TIME_OUTSIDE_APPLIED_WINDOW';
const NOTE_AMOUNT_UNUSABLE = 'REVENUE_NOT_FINITE';
const NOTE_SUBJECT_UNPROVABLE = 'SUBJECT_ENTITY_UNRESOLVED';

const SIGNAL_REASON_PREFIX = 'PROJECTION_SUPPRESSED';

/**
 * Units. A record-unit reason fires AT MOST ONCE per input row and is mutually exclusive with a row
 * producing anything, so `recordsWithEmissions + sum(record-unit counts) === inputItemCount` for
 * every envelope. An emission-unit reason fires per dropped emission, of which one row can produce
 * several. Mixing the two silently, as the first cut did, made the counters unreconcilable.
 */
const UNIT_RECORD = 'record';
const UNIT_EMISSION = 'emission';
const SUPPRESSION_UNITS = Object.freeze({
  [REASON_NO_SOURCE]: UNIT_RECORD,
  [REASON_NOT_AN_OBJECT]: UNIT_RECORD,
  [REASON_NO_IDENTITY]: UNIT_RECORD,
  [REASON_NO_OUTPUT]: UNIT_RECORD,
  [REASON_NO_INSTANT]: UNIT_EMISSION,
  [REASON_ZONE_UNSPECIFIED]: UNIT_EMISSION,
  [REASON_EPOCH_AMBIGUOUS]: UNIT_EMISSION,
  [REASON_NOT_FIRST]: UNIT_EMISSION,
  [REASON_NO_ENTITY_KEY]: UNIT_EMISSION,
  [REASON_OUTSIDE_WINDOW]: UNIT_EMISSION,
});

const KIND_RECORDS = 'projected_records';
const KIND_SIGNAL = 'suppression_signal';

// ---------------------------------------------------------------------------
// Reading declared paths out of a raw record
// ---------------------------------------------------------------------------

/**
 * Walks a dotted path through PLAIN OBJECTS ONLY. Nothing structural is ever copied out of a raw
 * record — only the scalar a declared path lands on — which is also why a nested foreign location
 * id can never ride through into projected evidence and trip `normalize.mjs:37-53`.
 */
function readPath(record, path) {
  let current = record;
  for (const key of path.split('.')) {
    if (!isPlainObject(current) || !Object.hasOwn(current, key)) return undefined;
    current = current[key];
  }
  return current;
}

function readFirstPath(record, paths) {
  for (const path of paths) {
    const value = readPath(record, path);
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

function asText(value) {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

function asAddressText(value) {
  const text = asText(value);
  return text === null ? null : text.toLowerCase();
}

function asDialText(value) {
  const text = asText(value);
  if (text === null) return null;
  const international = text.startsWith('+') ? '+' : '';
  const digits = text.replace(/\D/gu, '');
  return digits.length > 0 ? `${international}${digits}` : null;
}

const FIELD_READERS = Object.freeze({
  normalizedEmail: asAddressText,
  normalizedPhone: asDialText,
});

function resolveIdentity(declaration, record) {
  const identity = {};
  for (const field of IDENTITY_FIELDS) {
    const paths = declaration[field];
    if (!Array.isArray(paths)) continue;
    const read = FIELD_READERS[field] ?? asText;
    const value = read(readFirstPath(record, paths));
    if (value !== null) identity[field] = value;
  }
  return identity;
}

/** Exactly the disjunction `normalize.mjs:178-194` accepts, and nothing looser. */
function hasUsableIdentity(identity) {
  return Boolean(identity.subjectNativeId)
    || Boolean(identity.normalizedEmail)
    || Boolean(identity.normalizedPhone)
    || (
      Boolean(identity.organizationNativeId)
      && (Boolean(identity.opportunityNativeId) || Boolean(identity.projectNativeId))
    );
}

/** The strongest identity available, used only to group events of the same kind together. */
function identityGroupKey(identity) {
  if (identity.subjectNativeId) return `subject:${identity.subjectNativeId}`;
  if (identity.organizationNativeId && identity.opportunityNativeId) {
    return `org:${identity.organizationNativeId}|opp:${identity.opportunityNativeId}`;
  }
  if (identity.organizationNativeId && identity.projectNativeId) {
    return `org:${identity.organizationNativeId}|proj:${identity.projectNativeId}`;
  }
  if (identity.normalizedEmail) return `email:${identity.normalizedEmail}`;
  return `dial:${identity.normalizedPhone}`;
}

// ---------------------------------------------------------------------------
// Instants — rule 3
// ---------------------------------------------------------------------------

/**
 * Only these two written forms are accepted, and both are parsed HERE rather than handed to
 * `Date.parse`, whose behaviour outside the ECMA-262 grammar is implementation-defined and
 * timezone-dependent. Measured: `2026-07-15T09:00:00` reads as 09:00Z under `TZ=UTC` and as the
 * previous day under `TZ=Australia/Sydney`, a ten-hour shift that crosses week boundaries and
 * guarantees a checkpoint hash mismatch on resume from a different host.
 */
const ZONED_INSTANT = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(?:([Zz])|([+-])(\d{2}):?(\d{2}))$/u;
/** ECMA-262 defines the date-only form as UTC, so it is unambiguous across hosts. */
const CALENDAR_DAY = /^(\d{4})-(\d{2})-(\d{2})$/u;
/** Recognised only so the refusal can name the actual problem instead of shrugging. */
const ZONE_FREE = /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?$/u;
const DIGIT_RUN = /^-?\d+$/u;

/**
 * Epoch bounds. Below the floor a value is as plausibly SECONDS as milliseconds, and guessing wrong
 * lands a real event in 1970; `0` and negatives are almost always an absent field written as a
 * number rather than an instant before the platform existed. Both are refused and counted.
 */
const EPOCH_FLOOR_MS = 1_000_000_000_000;
const EPOCH_CEILING_MS = 4_102_444_800_000;

function utcFromParts(year, month, day, hour, minute, second, millisecond) {
  const epoch = Date.UTC(year, month - 1, day, hour, minute, second, millisecond);
  if (!Number.isFinite(epoch)) return null;
  const probe = new Date(epoch);
  // `Date.UTC` rolls impossible calendar values over silently, and maps a two-digit year into the
  // twentieth century. A round trip is the cheapest way to refuse both.
  if (
    probe.getUTCFullYear() !== year
    || probe.getUTCMonth() !== month - 1
    || probe.getUTCDate() !== day
    || probe.getUTCHours() !== hour
    || probe.getUTCMinutes() !== minute
    || probe.getUTCSeconds() !== second
    || probe.getUTCMilliseconds() !== millisecond
  ) return null;
  return epoch;
}

function epochFromText(text) {
  const zoned = ZONED_INSTANT.exec(text);
  if (zoned) {
    const [, year, month, day, hour, minute, second, fraction, zulu, sign, offsetHour, offsetMinute] = zoned;
    // Sub-millisecond precision is truncated: the accepted canonical form has millisecond
    // resolution, and rounding would move an instant the account never reported.
    const millisecond = fraction === undefined ? 0 : Number(`${fraction}000`.slice(0, 3));
    const base = utcFromParts(
      Number(year),
      Number(month),
      Number(day),
      Number(hour),
      Number(minute),
      Number(second),
      millisecond,
    );
    if (base === null) return { epochMs: null, reason: REASON_NO_INSTANT };
    if (zulu !== undefined) return { epochMs: base, reason: null };
    if (Number(offsetHour) > 23 || Number(offsetMinute) > 59) {
      return { epochMs: null, reason: REASON_NO_INSTANT };
    }
    const offsetMs = (Number(offsetHour) * 60 + Number(offsetMinute)) * 60_000;
    return { epochMs: sign === '-' ? base + offsetMs : base - offsetMs, reason: null };
  }
  const day = CALENDAR_DAY.exec(text);
  if (day) {
    const base = utcFromParts(Number(day[1]), Number(day[2]), Number(day[3]), 0, 0, 0, 0);
    return base === null
      ? { epochMs: null, reason: REASON_NO_INSTANT }
      : { epochMs: base, reason: null };
  }
  if (ZONE_FREE.test(text)) return { epochMs: null, reason: REASON_ZONE_UNSPECIFIED };
  if (DIGIT_RUN.test(text)) return epochFromNumber(Number(text));
  return { epochMs: null, reason: REASON_NO_INSTANT };
}

function epochFromNumber(value) {
  if (!Number.isInteger(value) || value < EPOCH_FLOOR_MS || value > EPOCH_CEILING_MS) {
    return { epochMs: null, reason: REASON_EPOCH_AMBIGUOUS };
  }
  return { epochMs: value, reason: null };
}

function canonicalInstant(value) {
  let read = { epochMs: null, reason: REASON_NO_INSTANT };
  if (typeof value === 'number') {
    read = Number.isFinite(value)
      ? epochFromNumber(value)
      : { epochMs: null, reason: REASON_EPOCH_AMBIGUOUS };
  } else if (typeof value === 'string') {
    const text = value.trim();
    if (text.length > 0) read = epochFromText(text);
  }
  if (read.epochMs === null) return { instant: null, reason: read.reason };
  // No `try` here on purpose: every path that produces an epoch has already bounded it, either by
  // `EPOCH_FLOOR_MS`/`EPOCH_CEILING_MS` or by the round trip in `utcFromParts`, so `toISOString`
  // has no reachable throw. A catch around it would be an untestable branch pretending to be care.
  return { instant: new Date(read.epochMs).toISOString(), reason: null };
}

/** `normalize.mjs:24-28`, restated exactly: the one written form the next stage accepts. */
function isCanonicalTimestamp(value) {
  if (typeof value !== 'string') return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

/** Rule 8. Inclusive at both bounds, so a boundary event is kept rather than guessed away. */
function withinWindow(instant, window) {
  const at = Date.parse(instant);
  return at >= Date.parse(window.from) && at <= Date.parse(window.to);
}

/**
 * The first declared path that yields a usable instant wins. When none does, the reason reported is
 * the one from the first path that actually held a value, so the counter names the real defect
 * rather than the last candidate tried.
 */
function firstCanonicalInstant(record, paths) {
  let firstReason = null;
  for (const path of paths) {
    const raw = readPath(record, path);
    if (raw === undefined || raw === null) continue;
    const { instant, reason } = canonicalInstant(raw);
    if (instant !== null) return { instant, reason: null };
    if (firstReason === null) firstReason = reason;
  }
  return { instant: null, reason: firstReason ?? REASON_NO_INSTANT };
}

// ---------------------------------------------------------------------------
// Declarative predicates
// ---------------------------------------------------------------------------

/**
 * A comparison key for the scalars a contract may compare. Text is compared case-insensitively and
 * trimmed, because native enumerations in the wild differ in casing between endpoints and eras and
 * a contract author cannot be expected to guess which spelling an account will emit today.
 */
function comparableKey(value) {
  if (typeof value === 'string') return `t:${value.trim().toLowerCase()}`;
  if (typeof value === 'number') return Number.isFinite(value) ? `n:${value === 0 ? 0 : value}` : null;
  if (typeof value === 'boolean') return `b:${value}`;
  if (value === null) return 'empty';
  return null;
}

function predicateHolds(when, record) {
  if (when.kind === 'always' || when.kind === 'first_of_kind') return true;
  const observed = comparableKey(readPath(record, when.field));
  if (observed === null) return false;
  if (when.kind === 'field_equals') return observed === comparableKey(when.value);
  if (when.kind === 'field_in') {
    return when.values.some((candidate) => comparableKey(candidate) === observed);
  }
  throw codedError('PROJECTION_CONTRACT_INVALID');
}

// ---------------------------------------------------------------------------
// Matching an envelope to its contract entry
// ---------------------------------------------------------------------------

/**
 * A literal-or-wildcard match, deliberately NOT a regular expression. A contract is data handed to
 * a long-running deterministic process; letting it supply a pattern that can backtrack
 * catastrophically would make a profile file into a denial-of-service surface.
 */
function patternMatches(pattern, text) {
  if (typeof text !== 'string') return false;
  const literal = pattern
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'))
    .join('.*');
  return new RegExp(`^${literal}$`, 'u').test(text);
}

/**
 * At most one source may claim an envelope. Two sources claiming the same payload used to resolve
 * as "first declared wins", which is a coin toss dressed as a rule; the load-time validator refuses
 * it, and this refuses it again for a contract handed in directly.
 */
function matchSource(sources, collection) {
  const matched = sources.filter((source) => (
    source.evidenceSource === collection.source
    && patternMatches(source.operationIdPattern, collection.operationId)
  ));
  if (matched.length > 1) throw codedError('PROJECTION_SOURCE_AMBIGUOUS');
  return matched[0] ?? null;
}

// ---------------------------------------------------------------------------
// Amounts
// ---------------------------------------------------------------------------

/**
 * See rule 1 in the module header. A value that is not a finite number at or above zero yields no
 * amount and a reason, NEVER a zero. `-0` is folded to `0` because `canonicalJson` refuses `-0`
 * outright and a refused canonicalisation downstream discards the whole record.
 *
 * ORDERED CANDIDATE PATHS, like every other path field on a contract: the first path that holds a
 * value decides, and a later path is not consulted to rescue an unusable earlier one, because
 * silently reading the amount from somewhere else is how an amount stops meaning what it says.
 */
function readAmount(record, paths) {
  const value = readFirstPath(record, paths);
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return { amount: value === 0 ? 0 : value, note: null };
  }
  return { amount: null, note: NOTE_AMOUNT_UNUSABLE };
}

function cohortReference(journeyId, journeyInstanceId, value) {
  const text = asText(value);
  if (text === null) return null;
  return `${COHORT_PREFIX}${sha256({ journeyId, journeyInstanceId, value: text }).slice(0, 32)}`;
}

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------

/**
 * A total order over ARBITRARY raw input. `canonicalJson` cannot be used here: it REFUSES a
 * non-finite number, and a non-finite number in a raw record is precisely one of the cases this
 * module exists to survive. Only the ordering of envelopes depends on this; nothing it produces
 * reaches the output.
 */
function orderingKey(value, seen = new WeakSet()) {
  if (value === null) return 'null';
  const kind = typeof value;
  if (kind === 'string') return `t${JSON.stringify(value)}`;
  if (kind === 'number') return Number.isFinite(value) ? `n${value === 0 ? 0 : value}` : `n!${String(value)}`;
  if (kind === 'boolean') return `b${value}`;
  if (kind === 'undefined') return 'absent';
  if (kind !== 'object') return `other:${kind}`;
  if (seen.has(value)) return 'cycle';
  seen.add(value);
  try {
    if (Array.isArray(value)) return `[${value.map((entry) => orderingKey(entry, seen)).join(',')}]`;
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${orderingKey(value[key], seen)}`
    )).join(',')}}`;
  } finally {
    seen.delete(value);
  }
}

/**
 * The order envelopes are PROCESSED in. Deliberately independent of the order of rows INSIDE an
 * envelope: `orderingKey` preserves array order, and `"items"` sorts before `"operationId"`, so a
 * naive whole-object key let a permutation of the rows reorder the envelopes around it and change
 * the output bytes. The row contribution is therefore a sorted digest of the rows, not the rows.
 */
function envelopeOrderingKey(collection) {
  if (!isPlainObject(collection)) return orderingKey(collection);
  const rows = Array.isArray(collection.items) ? collection.items : [];
  const withoutRows = Object.fromEntries(
    Object.entries(collection).filter(([key]) => key !== 'items'),
  );
  const rowKeys = rows.map((row) => orderingKey(row)).sort(byteCompare);
  return `${orderingKey(withoutRows)}|rows[${rowKeys.join(',')}]`;
}

function tally(counter, key, amount = 1) {
  counter.set(key, (counter.get(key) ?? 0) + amount);
}

function talliedSuppressions(counter) {
  return [...counter.entries()]
    .sort(([left], [right]) => byteCompare(left, right))
    .map(([reason, count]) => ({ reason, unit: SUPPRESSION_UNITS[reason] ?? UNIT_EMISSION, count }));
}

function talliedAnnotations(counter) {
  return [...counter.entries()]
    .sort(([left], [right]) => byteCompare(left, right))
    .map(([code, count]) => ({ code, count }));
}

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

function assertInput({ collections, context, profile, projection }) {
  if (
    !Array.isArray(collections)
    || collections.length === 0
    || !isPlainObject(context)
    || typeof context.locationId !== 'string'
    || context.locationId.length === 0
    || !isPlainObject(profile)
    || !Array.isArray(profile.journeys)
    || profile.journeys.length === 0
    || !isPlainObject(projection)
    || typeof projection.revenueBasis !== 'string'
    || projection.revenueBasis.length === 0
    || !isPlainObject(projection.suppressionSignal)
    || typeof projection.suppressionSignal.recordType !== 'string'
    || projection.suppressionSignal.recordType.length === 0
    || !Array.isArray(projection.sources)
    || projection.sources.length === 0
  ) throw codedError('PROJECTION_INPUT_INVALID', TypeError);
}

/**
 * Rule 4, the mechanism half. This is `normalize.mjs:55-65` restated on the way IN, key set and
 * all, and it VALIDATES IN PLACE — it returns nothing. The previous shape returned a fresh
 * `{ from, to }`, which is why a window carrying a third key was refused as an input and accepted
 * as an output: the rebuild was stricter than the check in front of it, so it laundered the
 * difference. Anything this module cannot vouch for is refused, never narrowed into acceptability.
 */
function assertWindowShape(window) {
  if (
    !isPlainObject(window)
    // `normalize.mjs:7-14` accepts an `Object.prototype` object and nothing else. A null-prototype
    // one would be spread into an ordinary object below, which is the same laundering by another
    // route, so the check here has to be exactly as narrow as the check downstream.
    || Object.getPrototypeOf(window) !== Object.prototype
    || Object.keys(window).sort().join(',') !== 'from,to'
    || !isCanonicalTimestamp(window.from)
    || !isCanonicalTimestamp(window.to)
    || Date.parse(window.from) >= Date.parse(window.to)
  ) throw codedError('PROJECTION_SOURCE_COLLECTION_INVALID', TypeError);
}

/**
 * A COPY, never a reconstruction. Whatever the validated input carried reaches the output verbatim,
 * so if the validation above is ever loosened the next stage sees exactly what this stage saw and
 * refuses it there instead of being handed a laundered replacement.
 */
function copyWindow(window) {
  return { ...window };
}

/**
 * Rule 4. This enforces exactly the invariants `normalize.mjs:78-106` enforces, on the way IN.
 * The first cut checked far less and then REBUILT the envelope, so an input claiming to be complete
 * while carrying a resume cursor and a reported total twenty times its row count was rewritten into
 * a clean complete envelope that normalised as OBSERVED. Repairing an envelope towards completeness
 * is the one direction this module must never move in.
 */
function assertSourceCollection(collection, locationId) {
  if (!isPlainObject(collection)) {
    throw codedError('PROJECTION_SOURCE_COLLECTION_INVALID', TypeError);
  }
  if (collection.boundLocationId !== locationId) {
    throw codedError('PROJECTION_LOCATION_MISMATCH');
  }
  if (
    typeof collection.source !== 'string'
    || collection.source.length === 0
    || typeof collection.operationId !== 'string'
    || collection.operationId.length === 0
    // `normalize.mjs:75` requires a CANONICAL instant here, not merely a non-empty string.
    || !isCanonicalTimestamp(collection.capturedAt)
    || !Array.isArray(collection.items)
    || !isPlainObject(collection.page)
    || typeof collection.page.complete !== 'boolean'
    || typeof collection.page.truncated !== 'boolean'
    || !Number.isInteger(collection.page.reportedCount)
    || !Number.isInteger(collection.page.collectedCount)
  ) throw codedError('PROJECTION_SOURCE_COLLECTION_INVALID', TypeError);
  assertWindowShape(collection.requestedWindow);
  assertWindowShape(collection.appliedWindow);
  // `normalize.mjs:91-94`. An applied window reaching outside the requested one is a claim the
  // collection rail had no authority to make, and it is refused here for the same reason.
  if (
    Date.parse(collection.appliedWindow.from) < Date.parse(collection.requestedWindow.from)
    || Date.parse(collection.appliedWindow.to) > Date.parse(collection.requestedWindow.to)
  ) throw codedError('PROJECTION_WINDOW_MISMATCH');
  if (collection.page.collectedCount !== collection.items.length) {
    throw codedError('PROJECTION_SOURCE_COLLECTION_INCOHERENT');
  }
  if (collection.page.complete) {
    if (
      collection.page.truncated === true
      || (collection.page.nextCursor !== null && collection.page.nextCursor !== undefined)
      || collection.page.reportedCount !== collection.items.length
      || Object.hasOwn(collection, 'incompleteReason')
    ) throw codedError('PROJECTION_SOURCE_COLLECTION_INCOHERENT');
    return;
  }
  // An envelope that claims to be partial without saying why cannot be carried honestly, and
  // `normalize.mjs:104-106` would reject it anyway.
  if (
    typeof collection.incompleteReason !== 'string'
    || collection.incompleteReason.length === 0
  ) throw codedError('PROJECTION_SOURCE_COLLECTION_INVALID', TypeError);
}

/**
 * Resolves every declared journey to its profile instance ONCE, up front, so a contract naming a
 * journey the coverage profile never declared fails immediately and identically on every run
 * instead of only when a matching record happens to turn up.
 */
function resolveJourneyInstances(profile, projection) {
  const declared = new Map();
  for (const journey of profile.journeys) {
    if (
      typeof journey?.journeyId !== 'string'
      || typeof journey?.journeyInstanceId !== 'string'
      || journey.journeyInstanceId.length === 0
    ) throw codedError('PROJECTION_INPUT_INVALID', TypeError);
    declared.set(journey.journeyId, journey.journeyInstanceId);
  }
  for (const source of projection.sources) {
    const events = source?.events ?? [];
    const entities = source?.entities ?? [];
    if (!Array.isArray(events) || !Array.isArray(entities) || events.length + entities.length === 0) {
      throw codedError('PROJECTION_CONTRACT_INVALID', TypeError);
    }
    for (const entity of entities) {
      if (typeof entity?.recordType !== 'string' || entity.recordType.length === 0) {
        throw codedError('PROJECTION_CONTRACT_INVALID');
      }
      if (!isPlainObject(entity.when) || typeof entity.when.kind !== 'string') {
        throw codedError('PROJECTION_CONTRACT_INVALID');
      }
    }
    for (const event of events) {
      if (!declared.has(event.journeyId)) throw codedError('PROJECTION_JOURNEY_UNKNOWN');
      if (typeof event.stage !== 'string' || !IDENTIFIER_PATTERN.test(event.stage)) {
        throw codedError('PROJECTION_CONTRACT_INVALID');
      }
      if (!Array.isArray(event.eventTimeField) || event.eventTimeField.length === 0) {
        throw codedError('PROJECTION_CONTRACT_INVALID');
      }
      if (!isPlainObject(event.when) || typeof event.when.kind !== 'string') {
        throw codedError('PROJECTION_CONTRACT_INVALID');
      }
      // Every path field on a contract is a LIST of candidates. A contract still carrying the old
      // single-path spelling would otherwise be read as "no amount declared" and drop the account's
      // money without a word, which is precisely the failure rule 1 exists to prevent.
      if (Object.hasOwn(event, 'revenueFrom') && !Array.isArray(event.revenueFrom)) {
        throw codedError('PROJECTION_CONTRACT_INVALID');
      }
    }
  }
  return declared;
}

// ---------------------------------------------------------------------------
// The projection
// ---------------------------------------------------------------------------

export function projectJourneyEvents({ collections, context, profile, projection } = {}) {
  assertInput({ collections, context, profile, projection });
  const instanceByJourney = resolveJourneyInstances(profile, projection);

  // Content-derived processing order. Input order can therefore never reach the output, which is
  // what makes the kernel's byte-comparison on resume meaningful rather than accidental.
  const ordered = [...collections]
    .map((collection, arrivalIndex) => ({
      collection,
      key: envelopeOrderingKey(collection),
      arrivalIndex,
    }))
    .sort((left, right) => byteCompare(left.key, right.key) || left.arrivalIndex - right.arrivalIndex)
    .map(({ collection }) => collection);

  const plans = ordered.map((collection, planIndex) => {
    assertSourceCollection(collection, context.locationId);
    return {
      collection,
      planIndex,
      spec: matchSource(projection.sources, collection),
      suppressed: new Map(),
      annotated: new Map(),
      recordsWithEmissions: 0,
    };
  });

  const emissions = [];
  for (const plan of plans) {
    if (plan.spec === null) {
      // The unit here is the RECORD. Counting one per ENVELOPE reported five hundred discarded
      // rows as `count: 1`.
      if (plan.collection.items.length > 0) {
        tally(plan.suppressed, REASON_NO_SOURCE, plan.collection.items.length);
      }
      continue;
    }
    const entities = plan.spec.entities ?? [];
    const events = plan.spec.events ?? [];
    for (const record of plan.collection.items) {
      if (!isPlainObject(record)) {
        tally(plan.suppressed, REASON_NOT_AN_OBJECT);
        continue;
      }
      const identity = resolveIdentity(plan.spec.identity, record);
      // `normalize.mjs:178-194`: identity or nothing. A record we cannot attach to anybody is not
      // evidence, and emitting it would be fatal at the next stage.
      if (!hasUsableIdentity(identity)) {
        tally(plan.suppressed, REASON_NO_IDENTITY);
        continue;
      }
      const groupIdentity = identityGroupKey(identity);
      let produced = 0;
      // Rule 5. The subject itself, so `evidence-graph.mjs:217-218` has something to key on.
      //
      // An entity record IS the subject, so it is keyed on the SUBJECT's native id and never on the
      // row's own. `evidence-graph.mjs:328` joins an event to an entity by looking the event's
      // `subjectNativeId` up among the entities' `nativeId`s, so an entity keyed on the id of the
      // row that mentioned the subject — an appointment id, a conversation id — is inert: it
      // creates a node nothing can ever join to, which looks exactly like the fix and is not one.
      // The events emitted from the same row keep their own `nativeId`, so nothing loses provenance.
      for (const entity of entities) {
        if (!predicateHolds(entity.when, record)) continue;
        if (typeof identity.subjectNativeId !== 'string' || identity.subjectNativeId.length === 0) {
          tally(plan.suppressed, REASON_NO_ENTITY_KEY);
          continue;
        }
        produced += 1;
        emissions.push(emission({
          plan,
          item: { recordType: entity.recordType, ...identity, nativeId: identity.subjectNativeId },
          eventTime: '',
          isEvent: false,
          entityKey: identity.subjectNativeId,
          group: null,
        }));
      }
      for (const event of events) {
        if (!predicateHolds(event.when, record)) continue;
        const { instant: eventTime, reason } = firstCanonicalInstant(record, event.eventTimeField);
        // Rule 3. Never the capture time, never a guess.
        if (eventTime === null) {
          tally(plan.suppressed, reason);
          continue;
        }
        // Rule 8. The envelope's own applied window is the only period it is evidence for.
        if (!withinWindow(eventTime, plan.collection.appliedWindow)) {
          tally(plan.suppressed, REASON_OUTSIDE_WINDOW);
          continue;
        }
        // Rule 2. The instance is the profile's, whatever the record or the contract may claim.
        const journeyInstanceId = instanceByJourney.get(event.journeyId);
        const item = {
          recordType: RECORD_TYPE,
          stage: event.stage,
          journeyId: event.journeyId,
          journeyInstanceId,
          eventTime,
          ...identity,
        };
        if (Array.isArray(event.cohortFrom)) {
          const reference = cohortReference(
            event.journeyId,
            journeyInstanceId,
            readFirstPath(record, event.cohortFrom),
          );
          if (reference !== null) item.cohortInstanceRef = reference;
        }
        if (Array.isArray(event.revenueFrom)) {
          const { amount, note } = readAmount(record, event.revenueFrom);
          if (note === null) {
            item.revenueAmount = amount;
          } else {
            // Rule 1. UNKNOWN with a reason, never an amount of zero and never observed.
            item.classification = 'UNKNOWN';
            item.projectionReasons = [note];
            tally(plan.annotated, note);
          }
        }
        produced += 1;
        emissions.push(emission({
          plan,
          item,
          eventTime,
          isEvent: true,
          // Exactly the two things `evidence-graph.mjs:327-361` can build a proving join out of.
          subjectKey: typeof identity.subjectNativeId === 'string' ? identity.subjectNativeId : null,
          provableByComposite: Boolean(
            identity.organizationNativeId
            && (identity.opportunityNativeId || identity.projectNativeId),
          ),
          group: event.when.kind === 'first_of_kind'
            ? `${event.journeyId} ${event.stage} ${groupIdentity}`
            : null,
        }));
      }
      if (produced === 0) tally(plan.suppressed, REASON_NO_OUTPUT);
      else plan.recordsWithEmissions += 1;
    }
  }

  // `first_of_kind` is resolved across the WHOLE input, not per envelope, because the same subject
  // can appear on two pages of the same scope. The winner is the earliest instant, then the BYTES
  // of the emitted content, then the content-ordered envelope. Every term is derived from content,
  // so no permutation of the input can move the survivor.
  const earliest = new Map();
  for (const candidate of emissions) {
    if (candidate.group === null) continue;
    const held = earliest.get(candidate.group);
    if (held === undefined || compareEmissions(candidate, held) < 0) {
      earliest.set(candidate.group, candidate);
    }
  }

  // Rule 7. The subjects this run actually emitted, gathered across every envelope: a subject can
  // arrive on one payload and be spoken about on another.
  const emittedSubjects = new Set(emissions
    .filter(({ isEvent }) => !isEvent)
    .map(({ entityKey }) => entityKey));

  const itemsByPlan = new Map(plans.map((plan) => [plan.planIndex, []]));
  for (const candidate of emissions) {
    if (candidate.group !== null && earliest.get(candidate.group) !== candidate) {
      tally(candidate.plan.suppressed, REASON_NOT_FIRST);
      continue;
    }
    let { item } = candidate;
    if (candidate.isEvent && !hasProvableSubject(candidate, emittedSubjects)) {
      item = withProjectionNote(item, NOTE_SUBJECT_UNPROVABLE);
      tally(candidate.plan.annotated, NOTE_SUBJECT_UNPROVABLE);
    }
    itemsByPlan.get(candidate.plan.planIndex).push(item);
  }

  const projected = plans.map((plan) => {
    const items = itemsByPlan.get(plan.planIndex)
      .map((item, index) => ({ item, key: canonicalJson(item), index }))
      .sort((left, right) => byteCompare(left.key, right.key) || left.index - right.index)
      .map(({ item }) => item);
    const complete = plan.collection.page.complete === true;
    const envelope = {
      source: plan.collection.source,
      operationId: plan.collection.operationId,
      boundLocationId: plan.collection.boundLocationId,
      requestedWindow: copyWindow(plan.collection.requestedWindow),
      appliedWindow: copyWindow(plan.collection.appliedWindow),
      capturedAt: plan.collection.capturedAt,
      items,
      page: {
        cursor: plan.collection.page.cursor ?? null,
        // Rule 4 in both directions: a complete envelope can carry no resume state, and an
        // incomplete one keeps the exact resume state it arrived with.
        nextCursor: complete ? null : (plan.collection.page.nextCursor ?? null),
        // Recomputed for the PROJECTED items, because one input record can fan out to several.
        // `normalize.mjs:78-106` rejects the collection outright if these drift.
        reportedCount: items.length,
        collectedCount: items.length,
        complete,
        truncated: complete ? false : plan.collection.page.truncated === true,
      },
      projection: projectionBlock(plan, projection, items.length, KIND_RECORDS),
    };
    if (!complete) envelope.incompleteReason = plan.collection.incompleteReason;
    return envelope;
  });

  // Rule 6. Appended AFTER the payload envelopes so the payload envelopes keep their positions,
  // and only for COMPLETE envelopes: an incomplete one already reaches the graph as UNKNOWN, and
  // an empty incomplete one already gets a signal from `normalize.mjs:271-283`.
  const signals = [];
  for (const plan of plans) {
    if (plan.collection.page.complete !== true || plan.suppressed.size === 0) continue;
    const items = talliedSuppressions(plan.suppressed).map(({ reason, unit, count }) => ({
      recordType: projection.suppressionSignal.recordType,
      classification: 'OBSERVED',
      reason: `${SIGNAL_REASON_PREFIX}:${reason}`,
      suppressedReason: reason,
      suppressedUnit: unit,
      suppressedCount: count,
      inputItemCount: plan.collection.items.length,
    }));
    signals.push({
      source: plan.collection.source,
      operationId: plan.collection.operationId,
      boundLocationId: plan.collection.boundLocationId,
      requestedWindow: copyWindow(plan.collection.requestedWindow),
      appliedWindow: copyWindow(plan.collection.appliedWindow),
      capturedAt: plan.collection.capturedAt,
      items,
      page: {
        cursor: null,
        nextCursor: null,
        reportedCount: items.length,
        collectedCount: items.length,
        complete: true,
        truncated: false,
      },
      projection: projectionBlock(plan, projection, items.length, KIND_SIGNAL),
    });
  }

  return deepFreeze([...projected, ...signals]);
}

function projectionBlock(plan, projection, emittedCount, kind) {
  return {
    kind,
    profileId: projection.profileId ?? null,
    revenueBasis: projection.revenueBasis,
    sourceId: plan.spec === null ? null : plan.spec.sourceId,
    capability: plan.spec === null ? null : plan.spec.capability,
    inputItemCount: plan.collection.items.length,
    // Rows that yielded at least one emission candidate. The reconciliation invariant is
    // `recordsWithEmissions + sum(record-unit suppressions) === inputItemCount`.
    recordsWithEmissions: plan.recordsWithEmissions,
    emittedCount,
    suppressed: talliedSuppressions(plan.suppressed),
    annotations: talliedAnnotations(plan.annotated),
  };
}

/**
 * An emission carries the BYTES of what it would emit, computed once, at the moment it is created.
 * Everything ordering-related downstream reads that string and nothing else.
 */
function emission(fields) {
  return { ...fields, contentKey: canonicalJson(fields.item) };
}

/**
 * A TOTAL ORDER OVER EMITTED CONTENT. The instant first, because the earliest event of a kind is
 * what the rule is about; then the canonical bytes of the emission itself; then the envelope, whose
 * own order is derived from its content. There is deliberately no term here that depends on where a
 * row happened to sit in `collection.items`: that array is never sorted, so any comparison against
 * it resolves ties by arrival order, and two rows tying on an instant would then be decided by
 * which page of the account's API happened to come back first.
 *
 * When every term ties the two emissions are byte-identical and belong to the same envelope, so
 * which one is retained cannot be observed in the output.
 */
function compareEmissions(left, right) {
  return byteCompare(left.eventTime, right.eventTime)
    || byteCompare(left.contentKey, right.contentKey)
    || left.plan.planIndex - right.plan.planIndex;
}

/**
 * Rule 7. `evidence-graph.mjs:327-361` proves a non-entity record either by matching its
 * `subjectNativeId` against an entity keyed on the same native id, or by a composite identity it
 * carries on its own. Anything else reaches `metrics.mjs:220` as an unproven event and blanks the
 * edge for every other subject in the journey.
 */
function hasProvableSubject(candidate, emittedSubjects) {
  if (candidate.provableByComposite) return true;
  return candidate.subjectKey !== null && emittedSubjects.has(candidate.subjectKey);
}

/**
 * Rule 1 and rule 7 share this shape. The spread comes first so a key the item already carries
 * keeps the position it was built in: two items with the same content must serialise to the same
 * bytes whichever downgrade wrote them, or the byte-ordered sort below has no total order.
 */
function withProjectionNote(item, note) {
  return {
    ...item,
    classification: 'UNKNOWN',
    projectionReasons: [...(item.projectionReasons ?? []), note],
  };
}
