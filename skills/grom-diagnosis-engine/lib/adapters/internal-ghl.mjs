// Strict adapter for the separate internal GHL audit MCP server (Task 11).
//
// It talks ONLY to the injected MCP client. There is no global `fetch`, no `node:http`,
// no `node:https`, no raw transport, no mutation client, no model workflow, no vault reader
// and no portal database anywhere in this module or its imports.
//
// SPLIT ERROR MODEL. On the internal server a policy violation THROWS (`error.code`) and a
// response failure RETURNS `{ok:false, code, failureClass}`. Both arrival shapes are handled.
//
// ANTI-ORACLE. Declared totals, page ledgers, coverage denominators and `complete` flags that
// arrive on the wire are treated as untrusted claims. Every reconciliation below is recomputed
// from the rows that were actually served.
//
// Internal hashes are `sha256:`-PREFIXED strings; `lib/canonical.mjs` `sha256()` returns BARE
// hex. `internalDigest()` is the only place the two are bridged, and workflow definition
// hashes stay bare hex because that is what the internal composite publishes for them.
import { createHmac, randomBytes } from 'node:crypto';
import { canonicalJson, sha256 } from '../canonical.mjs';
import {
  capturedAt,
  cloneJson,
  codedError,
  completeCollection,
  deepFreezeJson,
  incompleteCollection,
  validateCollectionWindow,
} from './collection.mjs';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SOURCE = 'internal_ghl';
const SCHEMA_VERSION = '1.0.0';
const SUPPORTED_CONTRACT_VERSIONS = Object.freeze(['1.0.0']);
const MANIFEST_SCHEMA_VERSION = '1.0';
const MANIFEST_PROFILE = 'audit';
const MANIFEST_PROOF_MODEL = 'external_capability_receipts_v1';
const PROOF_INDEX_SCHEMA_VERSION = '1.0';
const LIVE_RUNTIME = 'live_runtime';

const INTERNAL_DIGEST = /^sha256:[a-f0-9]{64}$/u;
const BARE_DIGEST = /^[a-f0-9]{64}$/u;
// A capability id SHAPE gate. It is never the whole answer: every capability id that reaches
// the result — as a value OR as an object key — must additionally RESOLVE against the sealed
// manifest (R3-3), so the grammar is only a cheap pre-filter in front of the real vocabulary.
const PROVENANCE_TOKEN = /^[a-z][a-z0-9_]{2,63}$/u;
// Strict ISO-8601 instant grammar. Wire capture times are re-parsed, never trusted as prose.
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;
// R3-1 (the fourth attempt at this class). Rounds 1-3 each fixed something narrower than the
// defect: a deny list, then an allow list of key NAMES, then a value SHAPE. 64 characters of
// `[A-Za-z0-9_-]` is a legible private sentence — `jane-doe-cancelled-botox-she-said-she-is-
// pregnant` matched it, and so did the bare phone number `447911123456`.
//
// The durable answer is not a wider guess, it is the SERVER'S OWN VOCABULARY:
//   * where the server emits a CLOSED set, this module carries the ENUM (see below). A grammar
//     is a guess about what a field might hold; an enum is a fact about what it does hold.
//   * where the server passes a RAW upstream row field through, the value is bounded to the
//     shape that provider-native data actually has, and anything wider is DROPPED.
//   * where the value IDENTIFIES A CONTACT, it is PSEUDONYMISED rather than echoed: a contact
//     identifier's only legitimate downstream use is joining, and `psn_<32 hex>` joins just as
//     well while carrying no name, no number and no sentence.
//
// An opaque provider-native identifier. GHL ids are Mongo ObjectId hex, base62 nanoids or short
// synthetic ids, so the separator budget here is ONE — enough for the qualified forms the rail
// really serves (`E_EARLY`, `WF1_V5`) and not enough for `jane-doe-447911123456`. The only
// multi-separator id shape admitted is a literal UUID. 36 is the UUID ceiling and nothing the
// audit rail serves is longer.
const MAX_ID_LENGTH = 36;
const PROVIDER_ID = /^[A-Za-z0-9]+(?:[_-][A-Za-z0-9]+)?$/u;
const UUID_ID = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/u;
// A run of 7 OR MORE digits is a national or international subscriber number, an account
// number or a PAN — never an id this rail needs. `447911123456` reached a healthy result
// under the old id grammar.
//
// R4-I3 — the upper bound used to be 15, which left an UNDECLARED GAP: an all-numeric value
// of 16+ digits (primary-account-number length) satisfied `PROVIDER_ID`, was below
// `MAX_ID_LENGTH`, and neither `lib/artifacts.mjs`'s `PHONE` pattern nor its private-value
// patterns see a bare digit run, so it reached a healthy result in EVERY id position. The
// ceiling is removed rather than raised: the rule this expresses is "an id on this rail is
// never a bare run of digits", and every id the internal server actually serves is Mongo
// ObjectId hex, a base62 nanoid, a short synthetic id or a UUID — none of which is all
// digits. A 16+ digit numeric id would now be dropped; that is the declared trade.
const BARE_DIGIT_RUN = /^\d{7,}$/u;
// A bounded machine token: `no_show`, `sent`, `failed`. ONE `_`/`-` separator and 24 characters
// is the whole vocabulary an execution-log outcome actually uses, and it is deliberately below
// the reviewer's suggested ceiling of two separators: `Jane-Doe-Smith` fits two, and the point
// of the bound is that a token may not carry a person.
const MAX_TOKEN_LENGTH = 24;
const MACHINE_TOKEN = /^[A-Za-z][A-Za-z0-9]*(?:[_-][A-Za-z0-9]+)?$/u;
// Interval notation for a half-open analytical window.
const INTERVAL_NOTATION = /^[[(][)\]]$/u;
// R3-2 — `host` and `normalizedPath` come from the SEALED manifest, which the brief declares
// untrusted, and were retained on `isNonEmptyString` alone. Both are closed vocabularies in the
// real manifest (`mcp-internal/audit-capability-manifest.json`): every one of the twenty
// descriptors declares `host` as `backend` or `services`, and every `normalizedPath` is a
// lower-case slash path whose only variable segments are `{locationId}`-style placeholders.
const ROUTE_HOSTS = Object.freeze(['backend', 'services']);
const NORMALIZED_PATH = /^(?:\/(?:[a-z0-9][a-z0-9-]*|\{[A-Za-z][A-Za-z0-9]*\})){1,8}$/u;
const MAX_PATH_LENGTH = 128;
// `core/audit-gateway.mjs:953` builds `failureClass` from a closed ladder of `core/errors.mjs`
// codes plus a literal `HTTP_<status>`. Everything else is not a failure class.
const FAILURE_CLASSES = Object.freeze([
  'AUTH_REJECTED',
  'RATE_LIMITED',
  'LOCATION_RATE_LIMITED',
  'INVALID_RESPONSE_BODY',
  'IDENTITY_CONFLICT',
  'IDENTITY_UNREADABLE',
  'IDENTITY_INSPECTION_CAPPED',
  'IDENTITY_DEPTH_CAPPED',
  'TRANSPORT_FAILED',
]);
const HTTP_FAILURE_CLASS = /^HTTP_\d{3}$/u;
// R4-I1 — WHAT THIS ENUM IS, AND WHAT IT IS NOT.
//
// `core/audit-capabilities.mjs:84` (`allowedQueryValues: { status: ['published','draft'] }`) is
// a REQUEST-side query allow list: it governs what this rail may ASK the roster for. It is NOT
// the response vocabulary — the server pushes the raw upstream row through (`core/
// audit-configuration.mjs` roster reader), so citing it for the row's `status` was reading the
// wrong code path.
//
// The RESPONSE vocabulary is not determinable from the server source, and the two live-derived
// samples that exist DISAGREE ON CASE:
//   * `core/tools.mjs:1899` / `:1785` / `:1927` compare a GET round-trip body to lower-case
//     `'published'` — response-side comparisons in production publish-verify code;
//   * this repo's own capture, `tests/fixtures/legacy/workflow-capture/workflow.json:5`,
//     carries upper-case `"PUBLISHED"`.
// A case-SENSITIVE `oneOf` therefore nulls every workflow's status on whichever of the two the
// live account turns out to emit. The match below is case-INSENSITIVE and the retained value is
// canonicalised to lower case, so both samples read. Out-of-vocabulary values are still dropped
// to `null` — the demonstrated leak put an absolute path to a private token file in this field.
const WORKFLOW_STATUSES = Object.freeze(['published', 'draft']);
// SILENT DROP 1 — the execution-log vocabulary this rail must be able to SEE.
//
// `isBoundedToken` allows ONE `_`/`-` separator, and that bound was derived on purpose:
// `event.eventType`, `event.status` and `event.outcome` are unbounded upstream free text, and a
// 24-character token with two separators is a legible private phrase (`Jane-Doe-Smith` fits
// two). Widening the grammar reopens exactly the leak round 4 closed.
//
// But the bound also DISCARDED `added_to_workflow` (17 characters, two separators), which
// `core/tools.mjs:974` states is live vocabulary and *"the ONLY proof a trigger fired"* — and
// which `core/tools.mjs:1705` and `:1916` both repeat as the only runtime proof of a firing
// trigger. Dropping it silently blinds the audit to trigger firings, the primary journey the
// whole system exists to diagnose.
//
// The durable answer is a KNOWN-VOCABULARY ALLOW LIST in front of the grammar, not a wider
// grammar: an exact literal can only ever match itself, so it carries no phrase. Values that
// are neither in the vocabulary nor inside the narrow grammar are still dropped, but the field
// NAME is now recorded in `event.unrecognisedFields` (see `projectEventDetail`) so "the wire
// carried an event type this rail does not know" is distinguishable from "the wire carried no
// event type at all". The bucket is a field-name list, never the value, so nothing widens.
//
// PROVENANCE, per entry — this is the whole determinable set and no more:
//   * `added_to_workflow` — DERIVED from `core/tools.mjs:974`, `:1705`, `:1916`.
//   * `waiting_on_action`, `action_skipped_by_filter` — NOT determinable from the server
//     source. They are named as live vocabulary by the round-4 external-contract sweep and are
//     admitted here as exact literals only; if they are not real they simply never match.
// The full upstream `/workflows/logs/v2` `eventType` set remains UNKNOWN — see the handoff.
const RUNTIME_EVENT_TYPES = Object.freeze([
  'added_to_workflow',
  'waiting_on_action',
  'action_skipped_by_filter',
]);
// The three execution-log fields whose value is upstream free text. A field present on the wire
// but not retained by its own grammar is reported by NAME here rather than vanishing.
const RUNTIME_EVENT_CLAIM_FIELDS = Object.freeze(['eventType', 'status', 'outcome']);
// `core/audit-configuration.mjs:215` sets `tombstonesApply: true` on `voice_ai` and on NO other
// surface, and `:1212` computes `tombstone: surface.tombstonesApply === true && grade ===
// 'tombstone'`. The server states the reason inline: the Voice discovery route is the only one
// on which a soft-deleted tombstone has been observed, and applying the rule to a product whose
// deletion schema this rail has never seen would drop a live configuration on a guess.
const TOMBSTONE_SURFACES = Object.freeze(['voice_ai']);
// The execution-log partition walk is ONE tree per requested event type, and this adapter never
// requests one, so there is exactly one root. See the terminality reconciliation in
// `reconcileRuntime` for the full derivation.
const LOG_PARTITION_STREAMS = 1;
// `core/audit-configuration.mjs:741` is the ONLY assignment to `terminalReason` in the module
// that serves the roster. There is exactly one emitted value.
const ROSTER_TERMINAL_REASONS = Object.freeze(['unique_count_equals_reported_total']);
// `core/workflow-runtime-window.mjs:1271` and `:1279` are the only two assignments to
// `statsSource`, and `:1293` pins the scope to a literal.
const ENROLLMENT_TOTAL_SOURCES = Object.freeze(['workflow_enroll_stats_cache', 'workflow_enroll_stats']);
const ENROLLMENT_TOTAL_SCOPES = Object.freeze(['workflow_all_time']);
// `core/workflow-runtime-window.mjs:718` emits this literal and nothing else.
const QUERY_BOUNDARIES = Object.freeze(['upstream-defined']);
// `core/workflow-runtime-window.mjs:344` — the timestamp priority ladder, in full.
const TIMESTAMP_FIELDS = Object.freeze(['startedExecutionAt', 'createdAt', 'updatedAt']);
// `validity.source` is hard-coded `null` on today's server (`:861-867`); the only source that
// could ever prove an effective interval is the reserved version-history capability, so that is
// the whole vocabulary the forward-compatible slot may carry.
const DEFINITION_VALIDITY_SOURCES = Object.freeze(['workflow_version_history']);
// R3-3 — the capability vocabulary this module itself seals, taken from the real
// `mcp-internal/audit-capability-manifest.json`. A capability id becomes an object KEY in
// `capabilityCoverage`, so it must resolve against a sealed vocabulary rather than merely
// look like a token. When a manifest is configured the manifest is the authority; when none
// is, THIS is, so a run without a proof chain still cannot mint a key out of free text.
const SEALED_CAPABILITY_IDS = Object.freeze([
  'workflow_roster_list',
  'workflow_detail',
  'workflow_triggers',
  'workflow_sticky_notes',
  'workflow_execution_logs',
  'workflow_count_per_step',
  'workflow_enrollment_search',
  'workflow_step_details',
  'workflow_enroll_stats_cache',
  'workflow_enroll_stats',
  'conversation_ai_agent_discovery',
  'conversation_ai_agent_detail',
  'voice_ai_agent_discovery',
  'voice_ai_agent_detail',
  'agent_studio_agent_discovery',
  'agent_studio_agent_detail',
]);
// The proof index is untrusted input: an unknown top-level key is a non-canonical index.
const PROOF_INDEX_KEYS = Object.freeze(['attestations', 'bundleHash', 'index', 'manifest']);

// D5 — a credential that cannot outlive the run's own lease window is short-lived.
const SHORT_LIVED_CREDENTIAL_MS = 300000;
// The attestation ceiling: no live canary receipt may claim more than thirty days of validity.
const MAXIMUM_PROOF_VALIDITY_MS = 30 * 24 * 60 * 60 * 1000;

// The exact six-tool read-only audit registry, in the order the profile publishes it.
const AUDIT_TOOL_NAMES = Object.freeze([
  'auth_status',
  'list_workflows_complete',
  'get_workflow',
  'export_workflow',
  'get_workflow_runtime_window',
  'get_ai_configuration_bundle',
]);

// The only input-schema property names any registered tool may expose. This is an ALLOW list on
// purpose: a deny list of write-ish tokens alone would wave through a `descriptors` escape hatch.
const AUDIT_TOOL_INPUT_KEYS = Object.freeze({
  auth_status: Object.freeze([]),
  list_workflows_complete: Object.freeze(['locationId', 'pageSize', 'maxPages']),
  get_workflow: Object.freeze(['locationId', 'workflowId']),
  export_workflow: Object.freeze(['locationId', 'workflowId']),
  get_workflow_runtime_window: Object.freeze([
    'locationId',
    'workflowId',
    'fromDate',
    'toDate',
    'contactId',
    'eventTypes',
    'stepIds',
    'pageSize',
    'maxLogPartitions',
    'minPartitionMs',
    'maxEnrollmentPages',
    'maxStepRosterPages',
  ]),
  get_ai_configuration_bundle: Object.freeze(['locationId', 'companyId', 'maxPages']),
});

// Scanned against tool NAMES and input-schema KEYS only. Prose descriptions legitimately
// contain the English words "trigger" and "publish", so they are never scanned.
const FORBIDDEN_SURFACE_TOKENS = Object.freeze([
  'rawrequest',
  'settokenfile',
  'confirm',
  'write',
  'send',
  'publish',
  'trigger',
  'fastforward',
  'delete',
  'remove',
  'course',
  'community',
  'membership',
]);

// Portal surfaces the audit rail must never request or return. The onboarding portal adapter
// stays the only portal evidence source.
const EXCLUDED_PORTAL_TOKENS = Object.freeze([
  'course', 'courses', 'lesson', 'lessons', 'offer', 'offers',
  'membership', 'memberships', 'community', 'communities',
  'assessment', 'assessments', 'certificate', 'certificates', 'credential',
]);

const AI_SURFACES = Object.freeze(['conversation_ai', 'voice_ai', 'agent_studio']);
const AI_SURFACE_CAPABILITIES = Object.freeze({
  conversation_ai: Object.freeze({
    discovery: 'conversation_ai_agent_discovery',
    detail: 'conversation_ai_agent_detail',
  }),
  voice_ai: Object.freeze({
    discovery: 'voice_ai_agent_discovery',
    detail: 'voice_ai_agent_detail',
  }),
  agent_studio: Object.freeze({
    discovery: 'agent_studio_agent_discovery',
    detail: 'agent_studio_agent_detail',
  }),
});

const DEFINITION_CAPABILITIES = Object.freeze([
  'workflow_detail',
  'workflow_triggers',
  'workflow_sticky_notes',
]);
// The route that returns the workflow body itself, and therefore the one whose declared
// location binding decides whether definition evidence is bound at all.
const DEFINITION_PRIMARY_CAPABILITY = 'workflow_detail';

const CODES = Object.freeze({
  HANDSHAKE: 'INTERNAL_AUDIT_HANDSHAKE_INVALID',
  READ_ONLY: 'INTERNAL_AUDIT_READ_ONLY_VIOLATION',
  CONTRACT: 'INTERNAL_AUDIT_CONTRACT_UNSUPPORTED',
  PROFILE: 'INTERNAL_AUDIT_PROFILE_MISMATCH',
  MANIFEST: 'INTERNAL_AUDIT_MANIFEST_INVALID',
  PROOF_INVALID: 'INTERNAL_AUDIT_PROOF_INVALID',
  PROOF_EXPIRED: 'INTERNAL_AUDIT_PROOF_EXPIRED',
  UNPROVEN: 'INTERNAL_AUDIT_CAPABILITY_UNPROVEN',
  LOCATION: 'INTERNAL_AUDIT_LOCATION_MISMATCH',
  QUARANTINED: 'AUDIT_QUARANTINED',
  ROSTER: 'INTERNAL_AUDIT_ROSTER_INCOMPLETE',
  WORKFLOW: 'INTERNAL_AUDIT_WORKFLOW_INCOMPLETE',
  RUNTIME: 'INTERNAL_AUDIT_RUNTIME_INCOMPLETE',
  AI: 'INTERNAL_AUDIT_AI_INCOMPLETE',
  AUTH: 'INTERNAL_AUDIT_AUTH_REQUIRED',
  ABORTED: 'INTERNAL_AUDIT_COLLECTION_ABORTED',
  DEADLINE: 'INTERNAL_AUDIT_COLLECTION_DEADLINE',
  BUDGET: 'INTERNAL_AUDIT_COLLECTION_BUDGET_EXHAUSTED',
  WINDOW: 'INTERNAL_AUDIT_WINDOW_INVALID',
  REQUEST: 'INTERNAL_AUDIT_REQUEST_INVALID',
});

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function isPlainObject(value) {
  return Boolean(
    value
    && typeof value === 'object'
    && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null),
  );
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function normalizeToken(value) {
  return String(value).toLowerCase().replaceAll(/[^a-z0-9]/gu, '');
}

/** `sha256:`-prefixed internal digest over canonical JSON. Never over a raw string. */
function internalDigest(value) {
  return `sha256:${sha256(value)}`;
}

function isoOrNull(value) {
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function nowMs(runtime) {
  const value = typeof runtime?.now === 'function' ? runtime.now() : Date.now();
  const parsed = value instanceof Date ? value.getTime() : Number(value);
  if (!Number.isFinite(parsed)) throw codedError(CODES.REQUEST, TypeError);
  return parsed;
}

function safeClone(value, code = CODES.REQUEST) {
  return cloneJson(value === undefined ? null : value, code);
}

function isoOrNullString(value) {
  return typeof value === 'string' && ISO_INSTANT.test(value) && isoOrNull(value) !== null
    ? value
    : null;
}

// ---------------------------------------------------------------------------
// Projection (PRIVACY). Wire sub-objects are never copied: every retained field is named by an
// explicit allow list below and everything else is dropped. A deny list is not enough — the
// host's own deny list knows nothing about `bearerToken`, `credentialPath` or `tokenId`.
// ---------------------------------------------------------------------------

// The retention vocabulary. Each predicate answers one question: may THIS value be retained?
// `oneOf` is preferred over every grammar below wherever the server has a closed set.
const oneOf = (values) => {
  const allowed = new Set(values);
  return (value) => typeof value === 'string' && allowed.has(value);
};
const isOpaqueId = (value) => typeof value === 'string'
  && value.length > 0
  && value.length <= MAX_ID_LENGTH
  && !BARE_DIGIT_RUN.test(value)
  && (PROVIDER_ID.test(value) || UUID_ID.test(value));
// A machine token can never be a bare digit run (it must start with a letter), so the digit
// rule is carried by the grammar itself.
const isBoundedToken = (value) => typeof value === 'string'
  && value.length <= MAX_TOKEN_LENGTH
  && MACHINE_TOKEN.test(value);
const isProvenanceToken = (value) => typeof value === 'string' && PROVENANCE_TOKEN.test(value);
const isRouteHost = oneOf(ROUTE_HOSTS);
const isNormalizedPath = (value) => typeof value === 'string'
  && value.length <= MAX_PATH_LENGTH
  && NORMALIZED_PATH.test(value);
const isFailureClass = (value) => typeof value === 'string'
  && (FAILURE_CLASSES.includes(value) || HTTP_FAILURE_CLASS.test(value));
const isKnownRuntimeEventType = oneOf(RUNTIME_EVENT_TYPES);
const isRosterTerminalReason = oneOf(ROSTER_TERMINAL_REASONS);
const isEnrollmentTotalSource = oneOf(ENROLLMENT_TOTAL_SOURCES);
const isEnrollmentTotalScope = oneOf(ENROLLMENT_TOTAL_SCOPES);
const isQueryBoundaries = oneOf(QUERY_BOUNDARIES);
const isTimestampField = oneOf(TIMESTAMP_FIELDS);
const isDefinitionValiditySource = oneOf(DEFINITION_VALIDITY_SOURCES);
const isSealedCapabilityId = oneOf(SEALED_CAPABILITY_IDS);
const isBoolean = (value) => value === true || value === false;
const isInteger = (value) => Number.isInteger(value);
const isCount = (value) => Number.isInteger(value) && value >= 0;
const isIsoInstant = (value) => typeof value === 'string'
  && ISO_INSTANT.test(value)
  && isoOrNull(value) !== null;
const isIntervalNotation = (value) => typeof value === 'string' && INTERVAL_NOTATION.test(value);
const nullable = (check) => (value) => value === null || check(value);
const either = (...checks) => (value) => checks.some((check) => check(value));
const listOf = (check) => (value) => Array.isArray(value) && value.every(check);

/**
 * Copies ONLY the named keys, and only when the value MATCHES the grammar declared for that
 * key. `spec` is `{key: predicate}`. A present key whose value fails its grammar is dropped
 * outright rather than nulled or coerced, so nothing unrecognised survives into the result.
 */
function projectTyped(value, spec) {
  if (!isPlainObject(value)) return null;
  const projected = {};
  for (const key of Object.keys(spec)) {
    if (!Object.hasOwn(value, key)) continue;
    const nested = value[key];
    if (!spec[key](nested)) continue;
    projected[key] = Array.isArray(nested) ? [...nested] : nested;
  }
  return projected;
}

function projectTypedList(value, spec) {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => projectTyped(entry, spec)).filter((entry) => entry !== null);
}

/** A single vocabulary-checked scalar, or `null` when the wire value is not in it. */
function inVocabularyOrNull(check, value) {
  return check(value) ? value : null;
}

/**
 * R4-I1 — the roster row's `status`, matched CASE-INSENSITIVELY against `WORKFLOW_STATUSES` and
 * canonicalised to lower case. See that constant for why the response vocabulary's case is
 * undetermined and why both live samples must read. Anything outside the two-value vocabulary
 * is `null`, exactly as before: this widens the CASE, never the vocabulary.
 */
function canonicalWorkflowStatus(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_TOKEN_LENGTH) {
    return null;
  }
  const lowered = value.toLowerCase();
  return WORKFLOW_STATUSES.includes(lowered) ? lowered : null;
}

// SILENT DROP 3 — the enrollment cursor's timestamp key. `core/workflow-runtime-window.mjs:
// 1326-1329` `String()`-COERCES every cursor value, so the `isInteger` half of the old
// `either(isIsoInstant, isInteger)` grammar was DEAD CODE and a 13-digit epoch arrived as a
// string that `BARE_DIGIT_RUN` then rejected. An epoch is admitted here, but it is NORMALISED
// to an ISO instant rather than echoed: that keeps the evidence and means no bare digit run
// ever reaches the artefact. The plausibility window is 2000-01-01 to 2100-01-01, which is the
// bound that makes the normalisation a timestamp reading rather than a number-shaped guess.
// RESIDUAL, stated rather than hidden: a 13-digit subscriber number landing inside that window
// would normalise to an ISO instant instead of being dropped. It is a timestamp position built
// by the server from `row.createdAt` only (`:1327`), not a contact field.
const EPOCH_MS_FLOOR = Date.UTC(2000, 0, 1);
const EPOCH_MS_CEILING = Date.UTC(2100, 0, 1);
const EPOCH_DIGITS = /^\d{10,13}$/u;
function normalizeCursorInstant(value) {
  if (isIsoInstant(value)) return value;
  if (typeof value !== 'string' || !EPOCH_DIGITS.test(value)) return null;
  const asMs = value.length <= 10 ? Number(value) * 1000 : Number(value);
  if (!Number.isInteger(asMs) || asMs < EPOCH_MS_FLOOR || asMs >= EPOCH_MS_CEILING) return null;
  return new Date(asMs).toISOString();
}

/**
 * PSEUDONYM, not echo. `filters.contactId`, `enrollments.rows[]._id`,
 * `stepRosters[].contacts[].id` and `runtimeEvents[].event.contactId` are the four places a
 * CONTACT identifier reaches this module, and no grammar can separate a provider id from a
 * name: `JaneDoeSmith` is 12 characters of plain base62 and would satisfy any id bound that
 * `C1` also satisfies. The only legitimate downstream use of a contact identifier is JOINING,
 * and a stable keyed digest joins exactly as well.
 *
 * The output shape is `psn_<32 hex>`, which is byte-for-byte the shape `lib/artifacts.mjs`
 * already recognises as SAFE (`SAFE_PSEUDONYM`), so the publication scanner reads it as a
 * pseudonym rather than as an unexplained opaque string.
 */
function pseudonymizerFor(key) {
  return (value) => {
    if (value === null || value === undefined || typeof value === 'object') return null;
    const normalized = String(value)
      .normalize('NFKC')
      .toLocaleLowerCase('und')
      .replaceAll(/\s+/gu, ' ')
      .trim();
    if (normalized === '') return null;
    return `psn_${createHmac('sha256', key).update(normalized).digest('hex').slice(0, 32)}`;
  };
}

// R4-I2 — the injected key must be at least as strong as the one this module would mint. A
// SHORTER key accepted silently is the worst of both worlds: the caller believes it pinned
// reproducibility and got a weakened HMAC instead.
const PSEUDONYM_KEY_BYTES = 32;

/**
 * THE RUN'S PSEUDONYM KEY, AND ITS OPTION CONTRACT (R4-I2).
 *
 * `options.pseudonymKey` — `Buffer` or `Uint8Array` of AT LEAST 32 bytes, or a UTF-8 string of
 * at least 32 bytes. It is read once here, never stored on the result, never echoed, and never
 * hashed into anything the artefact publishes. `lib/vault.mjs:78` already derives exactly such a
 * key (`pseudonymKey`, 32 bytes) alongside the encryption key, and `lib/kernel.mjs:176-177`
 * already requires it to be a 32-byte Buffer, so the value the host must forward exists today.
 *
 * WHEN IT IS ABSENT the adapter mints a fresh key per instance, and that is NOT a neutral
 * default: the evidence artefact stops being reproducible, `sha256(internalEvidence)` — which
 * the kernel bakes into the `normalizing` checkpoint input — stops being reproducible, and NO
 * CROSS-RUN JOIN is possible on either pseudonymised ledger, so week-over-week diffing sees
 * every enrolled contact as new. The fallback is retained (refusing to run would be a worse
 * canary outcome than an unjoinable one) but it is DECLARED on the result as
 * `pseudonymBinding.keySource: 'ephemeral'`, so a consumer can tell a joinable run from an
 * unjoinable one instead of assuming.
 *
 * A key that is PRESENT but unusable is a caller error and throws, rather than silently
 * degrading to the ephemeral path the caller was trying to avoid.
 */
function resolvePseudonymKey(candidate) {
  if (candidate === undefined || candidate === null) {
    return { key: randomBytes(PSEUDONYM_KEY_BYTES), source: 'ephemeral' };
  }
  let key = null;
  if (Buffer.isBuffer(candidate) || candidate instanceof Uint8Array) key = Buffer.from(candidate);
  else if (typeof candidate === 'string') key = Buffer.from(candidate, 'utf8');
  if (key === null || key.length < PSEUDONYM_KEY_BYTES) throw codedError(CODES.REQUEST, TypeError);
  return { key, source: 'injected' };
}

// `filters` is a REQUEST ECHO (`core/workflow-runtime-window.mjs:723`), so its only honest
// content is what THIS adapter asked for. It is reconciled against the outbound request rather
// than projected from the wire — see `projectRuntimeFilters`.
// Exactly the execution-log fields the audit consumes: the event and step identity and the
// typed outcome. Message bodies, contact emails, names, phone numbers and every other upstream
// field are dropped — and so is anything that arrives under one of these names without being in
// its vocabulary. `contactId` is handled separately because it is PSEUDONYMISED, not retained.
const RUNTIME_EVENT_DETAIL_SPEC = Object.freeze({
  _id: isOpaqueId,
  stepId: isOpaqueId,
  // SILENT DROP 1 — the sealed vocabulary FIRST, then the narrow machine-token grammar. See
  // `RUNTIME_EVENT_TYPES` for the per-entry provenance and for why the grammar itself is not
  // widened. A value that satisfies neither is dropped AND named in `unrecognisedFields`.
  eventType: either(isKnownRuntimeEventType, isBoundedToken),
  status: isBoundedToken,
  // NOT pseudonymised, deliberately, and this is the one contact identifier that may not be.
  // `lib/modes/weekly.mjs` `EVENT_ENTITY_KEYS` joins this value against the PUBLIC rail's raw
  // contact ids to detect an internal claim contradicting a public-owned outcome. A pseudonym
  // joins as well as the raw id only when BOTH sides carry it, and the public rail does not,
  // so pseudonymising here would silently switch that contradiction detector off. It is bound
  // to the id vocabulary instead.
  contactId: isOpaqueId,
  outcome: isBoundedToken,
});
// `_id` is pseudonymised in `projectEnrollments`; it is not in this spec because a raw
// enrollment-row id is never retained.
//
// `contactId` IS retained raw, and it is the second identifier in this file permitted to be — the
// first is `RUNTIME_EVENT_DETAIL_SPEC.contactId`, for the identical reason, stated there in full.
// An enrollment row is the moment a subject ENTERED a workflow, and on this account every delivery
// workflow is triggered by one pipeline stage, so that instant is the moment the subject entered
// that stage. `lib/delivery-phases.mjs` turns those instants into per-phase durations, and it can
// only do so by joining the row to a SUBJECT. A pseudonym joins as well as the raw id only when
// BOTH sides carry it; the public rail carries raw contact ids and does not carry this run's
// pseudonyms, so pseudonymising here would leave every enrollment unjoinable to the contact it
// describes and the whole delivery journey unmeasurable — which is exactly the state this retention
// exists to end. It is bound to the id vocabulary rather than echoed.
const ENROLLMENT_ROW_SPEC = Object.freeze({
  createdAt: isIsoInstant,
  contactId: isOpaqueId,
});
const ENROLLMENT_SPEC = Object.freeze({
  complete: isBoolean,
  windowScoped: isBoolean,
  contactFiltered: isBoolean,
});
// SILENT DROP 4 — `source` and `scope` are NULLABLE. `core/workflow-runtime-window.mjs:1289`
// assigns `source: statsSource`, and `statsSource` is `null` whenever neither the cache route
// nor the legacy route returned a usable total (`:1271`, `:1279`, `:1284`). A non-nullable
// predicate DROPPED THE KEY in exactly that case, which made "the server could not read a
// totals source" indistinguishable from "this build does not project the key". The honest
// `null` is retained. (`scope` is assigned the literal unconditionally at `:1293`, so it never
// legitimately arrives null — it is made nullable for symmetry, not because the server emits it.)
const ENROLLMENT_TOTAL_SPEC = Object.freeze({
  total: nullable(isCount),
  finished: nullable(isCount),
  source: nullable(isEnrollmentTotalSource),
  scope: nullable(isEnrollmentTotalScope),
});
const PER_STEP_COUNT_SPEC = Object.freeze({ stepId: isOpaqueId, count: nullable(isCount) });
const STEP_ROSTER_SPEC = Object.freeze({
  stepId: isOpaqueId,
  total: nullable(isCount),
  complete: isBoolean,
  pages: nullable(isCount),
});
// `id` is pseudonymised in `projectStepRosters`; a raw step-roster contact id is never retained.
const STEP_ROSTER_CONTACT_SPEC = Object.freeze({});
const COMPLETENESS_SPEC = Object.freeze({
  workflowDefinition: isBoolean,
  runtimeEvents: isBoolean,
  perStepCounts: isBoolean,
  enrollments: isBoolean,
  stepRosters: isBoolean,
  enrollmentTotals: isBoolean,
});
const REQUESTED_WINDOW_SPEC = Object.freeze({
  fromDate: isInteger,
  toDate: isInteger,
  boundaries: isIntervalNotation,
});
const APPLIED_WINDOW_SPEC = Object.freeze({
  fromDate: isInteger,
  toDate: isInteger,
  queryBoundaries: isQueryBoundaries,
  analyticalFilter: isIntervalNotation,
  expansionMs: isCount,
});
const LOG_PARTITION_SPEC = Object.freeze({
  attempted: nullable(isCount),
  terminal: nullable(isCount),
  exhausted: isBoolean,
  budget: nullable(isCount),
});
const PAGE_LEDGER_SPEC = Object.freeze({
  fetched: nullable(isCount),
  exhausted: isBoolean,
  budget: nullable(isCount),
});
// SILENT DROP 3 — every cursor value is `String()`-coerced by the server
// (`core/workflow-runtime-window.mjs:1326-1329`), so no cursor key ever arrives as a number and
// the `isInteger` alternatives were unreachable. `referenceCreatedAt` goes through
// `normalizeCursorInstant` (ISO verbatim, epoch normalised to ISO); the other three keep the id
// vocabulary, which already admits a short numeric sequence such as `"1"`.
const ENROLLMENT_CURSOR_KEYS = Object.freeze([
  'referenceId', 'referenceCreatedAt', 'referenceSid', 'referenceSequence',
]);
const ENROLLMENT_CURSOR_SPEC = Object.freeze({
  referenceId: isOpaqueId,
  referenceCreatedAt: (value) => normalizeCursorInstant(value) !== null,
  referenceSid: isOpaqueId,
  referenceSequence: isOpaqueId,
});

/**
 * A source route is projected onto sealed manifest constants wherever one exists: the retained
 * host and path come from the capability DESCRIPTOR, not from the wire, so nothing a response
 * chooses to put in `appliedPath`, `appliedQuery`, `bearerToken` or `credentialPath` survives.
 */
function projectRoute(route, manifest) {
  if (!isPlainObject(route)) return null;
  // R2-M6 — the wire's `capabilityId` is echoed only once it RESOLVES to a sealed descriptor.
  // An id that resolves to nothing is an untrusted wire string, so it is nulled here; the
  // session's separate raw exercise ledger still remembers that a route was exercised, so
  // dropping the name never softens the C3 coverage reconciliation.
  const declaredCapabilityId = isNonEmptyString(route.capabilityId) ? route.capabilityId : null;
  const sealed = declaredCapabilityId && manifest
    ? manifest.descriptors.get(declaredCapabilityId)
    : null;
  const capabilityId = sealed ? declaredCapabilityId : null;
  const spec = sealed ? sealed.descriptor : null;
  return {
    capabilityId,
    // R3-2 — the manifest is UNTRUSTED input, and `host`/`normalizedPath` were retained on
    // `isNonEmptyString` alone. A poisoned manifest put an absolute path to a private token
    // file with a `?token=` query into `appliedPath` and it survived every layer. Both are
    // closed vocabularies in the real manifest, so both are checked against them here.
    host: spec && isRouteHost(spec.host) ? spec.host : null,
    appliedPath: spec && isNormalizedPath(spec.normalizedPath) ? spec.normalizedPath : null,
    status: Number.isInteger(route.status) ? route.status : null,
    ok: route.ok === true,
    failureClass: inVocabularyOrNull(isFailureClass, route.failureClass),
    capturedAt: isoOrNullString(route.capturedAt),
  };
}

function projectRoutes(routes, manifest, filter = null) {
  if (!Array.isArray(routes)) return [];
  const projected = [];
  for (const route of routes) {
    if (!isPlainObject(route)) continue;
    if (filter && !filter(route)) continue;
    const entry = projectRoute(route, manifest);
    if (entry !== null) projected.push(entry);
  }
  return projected;
}

/**
 * An enrollment row is a RAW upstream row. Its `_id` identifies the enrolled contact, so it is
 * pseudonymised rather than echoed; the row keeps its arrival time and nothing else. The id is
 * read through the server's own `idOf` vocabulary first so `{$oid}` and numeric ids pseudonymise
 * to the same value as their string spelling.
 */
function projectEnrollments(value, pseudonymize) {
  if (!isPlainObject(value)) return null;
  const rows = Array.isArray(value.rows) ? value.rows : [];
  return {
    ...projectTyped(value, ENROLLMENT_SPEC),
    rows: rows.filter(isPlainObject).map((row) => {
      const projected = projectTyped(row, ENROLLMENT_ROW_SPEC) ?? {};
      const identifier = rosterRowId(row);
      return identifier === null
        ? projected
        : { _id: pseudonymize(identifier), ...projected };
    }),
  };
}

/**
 * WHICH PIPELINE STAGE A WORKFLOW FIRES ON, and nothing else about the trigger.
 *
 * `definitionIsSound` already hashes `block.triggers`, so the triggers are read and verified on
 * every run and were then discarded. That discard is what made the whole `client_onboarding`
 * journey permanently unmeasurable: every delivery phase on this account IS a stage change on one
 * pipeline, and every one of those stage changes is already the trigger of a firing workflow, so
 * the enrollment log of that workflow is a record of when cards entered that phase. Without the
 * trigger, an enrollment timestamp is an instant with nothing to attach it to.
 *
 * 🔴 THIS IS EVIDENCE, NOT CONFIGURATION, and the distinction is the whole reason it is derived
 * here rather than declared in a profile. `profiles/accounts/<locationId>.v1.json` may not say what
 * a workflow is FOR — that is the owner's standing rule and stage 1 derives it. Reading the stage
 * id out of a trigger the account itself wrote says nothing about purpose: it is the same class of
 * fact as "this opportunity's status is won", and it stays true if somebody repoints the workflow
 * tomorrow, which a hand-maintained id list would not.
 *
 * TWO IDS AND A TYPE. Not the filters, not the conditions, not the steps, not a name. A pipeline id
 * and a stage id are opaque account ids in the same vocabulary every other retained id here is
 * bound to; none of it is free text and none of it is a contact.
 */
const TRIGGER_TYPE_PATHS = Object.freeze(['type', 'key', 'eventType']);
/**
 * A trigger type is lowercase snake case with NO BOUND ON THE NUMBER OF SEGMENTS, which is why it
 * cannot reuse `isBoundedToken`: that grammar admits at most one `_` segment, so it rejects
 * `pipeline_stage_updated` and `facebook_lead_form` alike and every trigger type in this account
 * would have been retained as `null`. Still a closed CHARSET and still length-bounded — the point
 * of a vocabulary here is that free text can never ride out on this field, not that the set of
 * trigger names is one this repo can enumerate. It is not: GHL adds them.
 */
const MAX_TRIGGER_TYPE_LENGTH = 64;
const TRIGGER_TYPE_TOKEN = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/u;
const isTriggerTypeToken = (value) => typeof value === 'string'
  && value.length <= MAX_TRIGGER_TYPE_LENGTH
  && TRIGGER_TYPE_TOKEN.test(value);
const PIPELINE_ID_FIELDS = Object.freeze(['opportunity.pipelineid', 'pipelineid', 'pipeline']);
const STAGE_ID_FIELDS = Object.freeze([
  'opportunity.pipelinestageid', 'pipelinestageid', 'stageid', 'stage',
]);
// A trigger is a small hand-authored object. The bound stops a pathological payload turning this
// into an unbounded walk; nothing real nests a stage filter deeper than a few levels.
const TRIGGER_SCAN_MAX_DEPTH = 6;
const TRIGGER_SCAN_MAX_NODES = 512;

/**
 * Collect every `field -> value` pair a trigger states, however the builder chose to spell it.
 * GHL has shipped filters as `{field, value}`, as `{key, value}` and as plain properties on the
 * trigger itself across eras, and a reader that knows only one of the three silently sees no
 * stage at all — which is indistinguishable from a workflow that has no stage trigger. So all
 * three are read, the field name is compared case-insensitively, and anything that is not an id
 * in the sealed vocabulary is dropped rather than guessed at.
 */
function collectTriggerFields(node, into, depth = 0, budget = { nodes: 0 }) {
  if (depth > TRIGGER_SCAN_MAX_DEPTH) return;
  if (budget.nodes >= TRIGGER_SCAN_MAX_NODES) return;
  budget.nodes += 1;
  if (Array.isArray(node)) {
    for (const entry of node) collectTriggerFields(entry, into, depth + 1, budget);
    return;
  }
  if (!isPlainObject(node)) return;
  const name = ['field', 'key', 'name'].map((k) => node[k]).find(isNonEmptyString);
  if (isNonEmptyString(name) && isOpaqueId(node.value) && !into.has(name.toLowerCase())) {
    into.set(name.toLowerCase(), node.value);
  }
  for (const [key, value] of Object.entries(node)) {
    if (isOpaqueId(value) && !into.has(key.toLowerCase())) into.set(key.toLowerCase(), value);
    else collectTriggerFields(value, into, depth + 1, budget);
  }
}

function projectTriggers(triggers) {
  if (!Array.isArray(triggers)) return [];
  const projected = [];
  for (const trigger of triggers) {
    if (!isPlainObject(trigger)) continue;
    const fields = new Map();
    collectTriggerFields(trigger, fields);
    const pipelineId = PIPELINE_ID_FIELDS.map((f) => fields.get(f)).find(isOpaqueId) ?? null;
    const stageId = STAGE_ID_FIELDS.map((f) => fields.get(f)).find(isOpaqueId) ?? null;
    // A trigger that names no stage is not a delivery rung. It is retained with nulls rather than
    // dropped so that "this workflow has three triggers and none is a stage change" stays readable
    // downstream; a dropped entry reads as a workflow with no triggers at all.
    projected.push({
      type: inVocabularyOrNull(
        isTriggerTypeToken,
        TRIGGER_TYPE_PATHS.map((path) => trigger[path]).find(isNonEmptyString),
      ),
      pipelineId,
      stageId,
    });
  }
  return projected;
}

function projectStepRosters(value, pseudonymize) {
  if (!Array.isArray(value)) return [];
  return value.map((roster) => {
    if (!isPlainObject(roster)) return null;
    const contacts = Array.isArray(roster.contacts) ? roster.contacts : [];
    return {
      ...projectTyped(roster, STEP_ROSTER_SPEC),
      // A step-roster row IS a contact record. Its id is pseudonymised; every other field it
      // carries (name, email, phone, tags) is dropped by the empty projection spec.
      contacts: contacts.filter(isPlainObject).map((contact) => {
        const projected = projectTyped(contact, STEP_ROSTER_CONTACT_SPEC) ?? {};
        const identifier = rosterRowId(contact);
        return identifier === null
          ? projected
          : { id: pseudonymize(identifier), ...projected };
      }),
    };
  }).filter((roster) => roster !== null);
}

/**
 * One execution-log row. Everything outside `RUNTIME_EVENT_DETAIL_SPEC` is dropped.
 *
 * SILENT DROP 1 — the drop is no longer SILENT. `eventType`, `status` and `outcome` are the
 * three fields whose upstream value is free text, so a value that satisfies neither the sealed
 * vocabulary nor the narrow machine-token grammar is still refused — but the FIELD NAME is
 * reported in `unrecognisedFields`. That distinguishes "the row carried no event type" from
 * "the row carried an event type this rail is not willing to admit", which the audit needs in
 * order to know it is blind rather than looking at an empty account.
 *
 * The bucket is deliberately a list of FIELD NAMES, never a placeholder VALUE: `weekly.mjs:68`
 * `EVENT_CLAIM_FIELDS` compares `status`/`outcome` against the public rail's own values, and
 * writing a synthetic token into those keys would manufacture contradictions that never
 * happened. `unrecognisedFields` is not in `EVENT_CLAIM_FIELDS` or `EVENT_ENTITY_KEYS`, so it
 * is inert to the contradiction detector.
 */
function projectEventDetail(value) {
  const projected = projectTyped(value, RUNTIME_EVENT_DETAIL_SPEC) ?? {};
  if (!isPlainObject(value)) return projected;
  const unrecognised = RUNTIME_EVENT_CLAIM_FIELDS.filter(
    (field) => Object.hasOwn(value, field) && !Object.hasOwn(projected, field),
  );
  return unrecognised.length === 0 ? projected : { ...projected, unrecognisedFields: unrecognised };
}

/**
 * `filters` is a REQUEST ECHO (`core/workflow-runtime-window.mjs:723`). The tightest possible
 * bound on an echo is the request itself, so nothing here comes off the wire: this adapter
 * never sends `contactId` and never sends `eventTypes`, so both are constants, and `stepIds` is
 * exactly the set that was asked for. A wire value that disagrees is a contradiction, not
 * evidence, and it is dropped. The demonstrated leak (a live phone number under
 * `filters.contactId`) is unreachable by construction rather than by grammar.
 */
function projectRuntimeFilters(value, request, pseudonymize) {
  const requestedStepIds = Array.isArray(request?.stepIds) ? request.stepIds.filter(isOpaqueId) : [];
  const requestedContactId = request?.contactId ?? null;
  const declared = isPlainObject(value) ? value : {};
  const echoedStepIds = Array.isArray(declared.stepIds) ? declared.stepIds : [];
  return {
    // The outbound request carries NO contact id, so the only honest echo is `null`. A wire
    // value here is a contradiction, not evidence — the demonstrated leak was a live MSISDN
    // arriving under exactly this key on a run that never asked about a contact. Should a
    // future request ever carry one, the matching echo is pseudonymised, never echoed raw.
    contactId: requestedContactId !== null && declared.contactId === requestedContactId
      ? pseudonymize(requestedContactId)
      : null,
    // The outbound request never narrows by event type either.
    eventTypes: [],
    stepIds: requestedStepIds.filter((stepId) => echoedStepIds.includes(stepId)),
  };
}

function projectPagination(value) {
  if (!isPlainObject(value)) return null;
  return {
    logPartitions: projectTyped(value.logPartitions, LOG_PARTITION_SPEC),
    enrollmentPages: projectTyped(value.enrollmentPages, PAGE_LEDGER_SPEC),
    stepRosterPages: projectTyped(value.stepRosterPages, PAGE_LEDGER_SPEC),
  };
}

const LOCATION_INDICATOR_KEYS = Object.freeze([
  'locationid',
  'boundlocationid',
  'ghllocationid',
  'ghllocation',
  'sublocationid',
  'subaccountid',
]);

/**
 * Deep scan for any key that names a location. Used to bind EVERY response to the run's
 * expected location independently of the canary provenance recorded in the proof chain.
 */
function collectLocationIndicators(value, indicators = [], seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return indicators;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const entry of value) collectLocationIndicators(entry, indicators, seen);
    return indicators;
  }
  for (const [key, nested] of Object.entries(value)) {
    const normalized = normalizeToken(key);
    if (LOCATION_INDICATOR_KEYS.includes(normalized)) {
      indicators.push(nested);
    } else if (normalized === 'location') {
      // A location may arrive as `{id}` OR as a bare string. The bare-string form used to slip
      // past the scan entirely, which let a body tagged with a foreign location read as silence.
      if (isPlainObject(nested) && Object.hasOwn(nested, 'id')) indicators.push(nested.id);
      else if (typeof nested === 'string') indicators.push(nested);
    }
    collectLocationIndicators(nested, indicators, seen);
  }
  return indicators;
}

function assertResponseLocation(body, expectedLocationId) {
  const indicators = collectLocationIndicators(body);
  if (indicators.some((locationId) => locationId !== expectedLocationId)) {
    throw codedError(CODES.LOCATION);
  }
}

function assertBoundLocation(body, expectedLocationId) {
  if (!isPlainObject(body) || body.boundLocationId !== expectedLocationId) {
    throw codedError(CODES.LOCATION);
  }
  const binding = body.locationBinding;
  if (!isPlainObject(binding)) throw codedError(CODES.LOCATION);
  if (binding.quarantined === true) throw codedError(CODES.QUARANTINED);
  if (binding.inspectionIncomplete === true) throw codedError(CODES.QUARANTINED);
  if (Array.isArray(binding.conflicts) && binding.conflicts.length > 0) {
    throw codedError(CODES.QUARANTINED);
  }
  assertResponseLocation(body, expectedLocationId);
}

function assertContractVersion(body, expectedContractVersion) {
  if (body.contractVersion !== expectedContractVersion) throw codedError(CODES.CONTRACT);
}

// ---------------------------------------------------------------------------
// Handshake
// ---------------------------------------------------------------------------

function scanForbiddenSurface(text) {
  const normalized = normalizeToken(text);
  return FORBIDDEN_SURFACE_TOKENS.some((token) => normalized.includes(token));
}

function validateToolRegistry(listing) {
  const source = isPlainObject(listing) && Array.isArray(listing.content)
    ? parseToolBody(listing).data
    : listing;
  if (!isPlainObject(source) || !Array.isArray(source.tools)) throw codedError(CODES.HANDSHAKE);
  const tools = source.tools;
  if (tools.length !== AUDIT_TOOL_NAMES.length) throw codedError(CODES.HANDSHAKE);

  for (const tool of tools) {
    if (!isPlainObject(tool) || !isNonEmptyString(tool.name)) throw codedError(CODES.HANDSHAKE);
    if (scanForbiddenSurface(tool.name)) throw codedError(CODES.READ_ONLY);
  }
  const names = tools.map((tool) => tool.name);
  // Exact canonical equality, ORDER INCLUDED: the profile hash is taken over this order.
  if (canonicalJson(names) !== canonicalJson([...AUDIT_TOOL_NAMES])) {
    throw codedError(CODES.HANDSHAKE);
  }

  for (const tool of tools) {
    const schema = tool.inputSchema;
    if (!isPlainObject(schema) || schema.type !== 'object') throw codedError(CODES.HANDSHAKE);
    const properties = schema.properties;
    if (!isPlainObject(properties)) throw codedError(CODES.HANDSHAKE);
    const allowed = AUDIT_TOOL_INPUT_KEYS[tool.name];
    for (const key of Object.keys(properties)) {
      if (scanForbiddenSurface(key)) throw codedError(CODES.READ_ONLY);
      if (!allowed.includes(key)) throw codedError(CODES.HANDSHAKE);
    }
    if (Object.hasOwn(schema, 'required')) {
      if (!Array.isArray(schema.required)) throw codedError(CODES.HANDSHAKE);
      for (const key of schema.required) {
        if (scanForbiddenSurface(key)) throw codedError(CODES.READ_ONLY);
        if (!allowed.includes(key)) throw codedError(CODES.HANDSHAKE);
      }
    }
  }
  return Object.freeze([...names]);
}

// ---------------------------------------------------------------------------
// Manifest and proof chain
// ---------------------------------------------------------------------------

function validateManifest(manifest, bundleHash) {
  if (!isPlainObject(manifest)) throw codedError(CODES.MANIFEST);
  if (manifest.schemaVersion !== MANIFEST_SCHEMA_VERSION) throw codedError(CODES.MANIFEST);
  if (manifest.profile !== MANIFEST_PROFILE) throw codedError(CODES.MANIFEST);
  if (manifest.proofModel !== MANIFEST_PROOF_MODEL) throw codedError(CODES.MANIFEST);
  if (!Array.isArray(manifest.capabilities) || manifest.capabilities.length === 0) {
    throw codedError(CODES.MANIFEST);
  }
  if (
    !Array.isArray(manifest.tools)
    || canonicalJson(manifest.tools) !== canonicalJson([...AUDIT_TOOL_NAMES])
  ) throw codedError(CODES.MANIFEST);
  const declared = manifest.manifestHash;
  if (typeof declared !== 'string' || !INTERNAL_DIGEST.test(declared)) {
    throw codedError(CODES.MANIFEST);
  }
  const { manifestHash: _omitted, ...withoutSelfHash } = manifest;
  let recomputed;
  try {
    recomputed = internalDigest(withoutSelfHash);
  } catch {
    throw codedError(CODES.MANIFEST);
  }
  if (recomputed !== declared) throw codedError(CODES.MANIFEST);
  if (typeof bundleHash !== 'string' || !INTERNAL_DIGEST.test(bundleHash)) {
    throw codedError(CODES.MANIFEST);
  }

  const descriptors = new Map();
  for (const row of manifest.capabilities) {
    if (!isPlainObject(row) || !isNonEmptyString(row.capabilityId)) throw codedError(CODES.MANIFEST);
    // `tool` is stripped: several capability ids appear under more than one tool and the
    // tool-stripped rows for a repeated id are byte-identical.
    const { tool: _tool, ...descriptor } = row;
    const encoded = canonicalJson(descriptor);
    const existing = descriptors.get(descriptor.capabilityId);
    if (existing && existing.encoded !== encoded) throw codedError(CODES.MANIFEST);
    if (!existing) {
      descriptors.set(descriptor.capabilityId, {
        encoded,
        descriptorHash: internalDigest(descriptor),
        descriptor: Object.freeze(safeClone(descriptor, CODES.MANIFEST)),
      });
    }
  }
  // `manifestHash` inside the document is the SELF-OMITTING integrity anchor checked above.
  // The identity this run publishes, and the one the attestation binds, is taken over the
  // whole document including that anchor.
  return Object.freeze({
    manifestHash: internalDigest(manifest),
    selfHash: declared,
    bundleHash,
    descriptors,
  });
}

const ATTESTATION_BOUND_FIELDS = Object.freeze([
  'toolProfileHash',
  'capabilityManifestHash',
  'bundleHash',
  'targetHash',
  'provenAt',
  'expiresAt',
  'callTraceHashes',
  'approver',
]);

const RECEIPT_FIELDS = Object.freeze([
  'attestationHash',
  'capabilityDescriptorHash',
  'capabilityId',
  'expiresAt',
  'proofClass',
  'provenAt',
]);

/**
 * Finding R6-I2 — `targetHash` was in `ATTESTATION_BOUND_FIELDS` and compared with NOTHING, so a
 * single canary attestation anchored EVERY account whose operator sealed its hash.
 *
 * The tension the brief names is real and is resolved here explicitly. LOCATION BINDING stays
 * independent: `targetHash` is still never compared with the run's location id, never
 * substituted for it, and never treated as authorization to read this account — the location is
 * bound by `expectedLocationId` and by the per-response location assertions, exactly as before.
 *
 * What `targetHash` DOES now is scope the proof. A pseudonymous canary is run against ONE
 * account; whether its proof carries over to a different account is a decision, and a decision
 * has to be recorded somewhere the proof chain cannot write. So a canary must be EXPLICITLY
 * SCOPED to the accounts it may support: the run supplies `authorizedCanaryTargetHashes` — in
 * the shipped composition root, from the independently sealed, vault-authenticated seal document
 * (finding R6-C3), which is per-location and which the config author cannot mint — and an
 * attestation whose target is not in that list proves nothing HERE, however sound it is.
 *
 * The alternative reading ("the run's own target hash must match") was rejected deliberately: the
 * canary target hash is a pseudonym minted by the server from the canary account with a recipe
 * this adapter cannot reproduce, so recomputing it for the audited account would guarantee a
 * mismatch on every real run — the exact class of structural canary blocker the external-contract
 * sweep exists to prevent. Explicit scoping costs the operator one authenticated statement per
 * account and makes cross-account reuse a recorded decision instead of a silent one.
 *
 * A run that supplies NO scope list keeps the previous behaviour (library callers, and every
 * run that cannot reach `complete_full` anyway because it seals no independent anchors).
 */
function targetIsAuthorized(attestation, authorizedTargetHashes) {
  if (authorizedTargetHashes === null) return true;
  return isNonEmptyString(attestation.targetHash)
    && authorizedTargetHashes.has(attestation.targetHash);
}

function attestationIsSound(attestation, attestationHash, pins) {
  if (!isPlainObject(attestation)) return false;
  for (const field of ATTESTATION_BOUND_FIELDS) {
    if (!Object.hasOwn(attestation, field)) return false;
  }
  const { attestationHash: declared, ...rest } = attestation;
  if (declared !== attestationHash) return false;
  let recomputed;
  try {
    recomputed = internalDigest(rest);
  } catch {
    return false;
  }
  if (recomputed !== attestationHash) return false;
  // The canary target hash is never compared with, substituted for, or treated as authorization
  // for the current LOCATION, and it never leaves this function. It is compared with the run's
  // explicit canary SCOPE — see `targetIsAuthorized` — which is a different question.
  if (!targetIsAuthorized(attestation, pins.authorizedCanaryTargetHashes ?? null)) return false;
  if (attestation.toolProfileHash !== pins.toolProfileHash) return false;
  if (attestation.capabilityManifestHash !== pins.capabilityManifestHash) return false;
  if (attestation.bundleHash !== pins.bundleHash) return false;
  return true;
}

/**
 * Evaluates the untrusted external proof index. Never throws: an unusable proof chain forces
 * the affected scope to Partial rather than failing the whole collection.
 */
function evaluateCapabilityProofs({
  capabilityProofIndex,
  capabilityIds,
  manifest,
  toolProfileHash,
  now,
  authorizedCanaryTargetHashes = null,
}) {
  const coverage = {};
  const reasons = [];
  /**
   * Finding R4-C1, round-5 close. The attestation hashes this evaluation ACTUALLY ACCEPTED:
   * one is added only where a receipt was validated as an unexpired `live_runtime` proof for a
   * manifest-sealed capability AND `attestationIsSound` verified the attestation document —
   * its self-omitting preimage, and its binding to THIS run's `pins` (tool profile, manifest
   * identity, bundle identity). A decoy attestation no receipt references, an expired one, one
   * whose document does not hash to its own declared hash, and one that binds some other
   * bundle are all excluded, because none of them ever reaches this line.
   */
  const governingAttestationHashes = new Set();
  const record = (capabilityId, proven, code) => {
    coverage[capabilityId] = {
      capabilityId,
      applicable: true,
      proven,
      proofClass: proven ? LIVE_RUNTIME : null,
    };
    if (!proven && code) reasons.push(code);
  };

  const indexIsUsable = isPlainObject(capabilityProofIndex)
    && isPlainObject(capabilityProofIndex.index)
    && capabilityProofIndex.index.schemaVersion === PROOF_INDEX_SCHEMA_VERSION
    && Array.isArray(capabilityProofIndex.index.receipts)
    && isPlainObject(capabilityProofIndex.attestations)
    && manifest !== null;

  if (!indexIsUsable) {
    for (const capabilityId of capabilityIds) record(capabilityId, false, CODES.PROOF_INVALID);
    return {
      coverage,
      reasons,
      proven: capabilityIds.length === 0,
      governingAttestationHashes: [],
    };
  }

  const receiptsById = new Map();
  const duplicated = new Set();
  for (const receipt of capabilityProofIndex.index.receipts) {
    if (!isPlainObject(receipt) || !isNonEmptyString(receipt.capabilityId)) continue;
    if (receiptsById.has(receipt.capabilityId)) duplicated.add(receipt.capabilityId);
    else receiptsById.set(receipt.capabilityId, receipt);
  }

  const pins = {
    toolProfileHash,
    capabilityManifestHash: manifest.manifestHash,
    bundleHash: manifest.bundleHash,
    // R6-I2 — the run's explicit canary scope, or `null` when the run declares none.
    authorizedCanaryTargetHashes,
  };

  for (const capabilityId of capabilityIds) {
    const descriptor = manifest.descriptors.get(capabilityId);
    if (!descriptor) {
      record(capabilityId, false, CODES.UNPROVEN);
      continue;
    }
    if (duplicated.has(capabilityId)) {
      record(capabilityId, false, CODES.PROOF_INVALID);
      continue;
    }
    const receipt = receiptsById.get(capabilityId);
    if (!receipt) {
      record(capabilityId, false, CODES.UNPROVEN);
      continue;
    }
    if (canonicalJson(Object.keys(receipt).sort()) !== canonicalJson([...RECEIPT_FIELDS])) {
      record(capabilityId, false, CODES.PROOF_INVALID);
      continue;
    }
    if (receipt.proofClass !== LIVE_RUNTIME) {
      record(capabilityId, false, CODES.UNPROVEN);
      continue;
    }
    if (receipt.capabilityDescriptorHash !== descriptor.descriptorHash) {
      record(capabilityId, false, CODES.PROOF_INVALID);
      continue;
    }
    const attestation = Object.hasOwn(capabilityProofIndex.attestations, receipt.attestationHash)
      ? capabilityProofIndex.attestations[receipt.attestationHash]
      : null;
    if (!attestationIsSound(attestation, receipt.attestationHash, pins)) {
      record(capabilityId, false, CODES.PROOF_INVALID);
      continue;
    }
    if (
      receipt.provenAt !== attestation.provenAt
      || receipt.expiresAt !== attestation.expiresAt
    ) {
      record(capabilityId, false, CODES.PROOF_INVALID);
      continue;
    }
    const provenAt = isoOrNull(receipt.provenAt);
    const expiresAt = isoOrNull(receipt.expiresAt);
    if (provenAt === null || expiresAt === null || expiresAt <= provenAt) {
      record(capabilityId, false, CODES.PROOF_INVALID);
      continue;
    }
    if (expiresAt - provenAt > MAXIMUM_PROOF_VALIDITY_MS) {
      record(capabilityId, false, CODES.PROOF_INVALID);
      continue;
    }
    if (provenAt > now) {
      record(capabilityId, false, CODES.PROOF_INVALID);
      continue;
    }
    if (expiresAt <= now) {
      record(capabilityId, false, CODES.PROOF_EXPIRED);
      continue;
    }
    governingAttestationHashes.add(receipt.attestationHash);
    record(capabilityId, true, null);
  }

  const proven = capabilityIds.every((capabilityId) => coverage[capabilityId].proven);
  return {
    coverage,
    reasons,
    proven,
    governingAttestationHashes: [...governingAttestationHashes].sort(),
  };
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

function parseToolBody(response) {
  if (!isPlainObject(response) || !Array.isArray(response.content)) {
    return { status: 'failed', code: 'RESPONSE_ENVELOPE_INVALID' };
  }
  const text = response.content.find((entry) => isPlainObject(entry) && entry.type === 'text')?.text;
  if (typeof text !== 'string') return { status: 'failed', code: 'RESPONSE_ENVELOPE_INVALID' };
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return { status: 'failed', code: 'RESPONSE_BODY_INVALID' };
  }
  if (!isPlainObject(body)) return { status: 'failed', code: 'RESPONSE_BODY_INVALID' };
  if (body.ok === true) {
    if (!isPlainObject(body.data)) return { status: 'failed', code: 'RESPONSE_BODY_INVALID' };
    return { status: 'ok', data: body.data };
  }
  // `detail` and `remediation` are deliberately dropped: they may carry private strings.
  return {
    status: 'failed',
    code: isNonEmptyString(body.code) ? body.code : 'RESPONSE_FAILED',
  };
}

// ---------------------------------------------------------------------------
// Roster reconciliation (recomputed, never trusted)
// ---------------------------------------------------------------------------

function validateAppliedQueries(appliedQueries, manifest, expectedPages) {
  if (!Array.isArray(appliedQueries) || appliedQueries.length !== expectedPages) return false;
  for (const entry of appliedQueries) {
    if (!isPlainObject(entry) || !isNonEmptyString(entry.capabilityId)) return false;
    if (!isPlainObject(entry.query)) return false;
    if (!manifest) continue;
    const descriptor = manifest.descriptors.get(entry.capabilityId);
    if (!descriptor) return false;
    const spec = descriptor.descriptor;
    const allowed = new Set([
      ...(spec.requiredQueryKeys ?? []),
      ...(spec.optionalQueryKeys ?? []),
      ...(spec.repeatableQueryKeys ?? []),
      ...Object.keys(spec.queryBindings ?? {}),
    ]);
    for (const key of Object.keys(entry.query)) {
      if (!allowed.has(key)) return false;
    }
    for (const key of spec.requiredQueryKeys ?? []) {
      if (!Object.hasOwn(entry.query, key)) return false;
    }
    for (const [key, value] of Object.entries(spec.fixedQueryValues ?? {})) {
      if (entry.query[key] !== value) return false;
    }
  }
  return true;
}

function validateSourceRoutes(sourceRoutes, manifest, { requireOk = true } = {}) {
  if (!Array.isArray(sourceRoutes)) return false;
  for (const route of sourceRoutes) {
    if (!isPlainObject(route) || !isNonEmptyString(route.capabilityId)) return false;
    if (manifest && !manifest.descriptors.has(route.capabilityId)) return false;
    if (requireOk && route.ok !== true) return false;
  }
  return true;
}

// The real Mongo/BSON wrappers a roster-row id can arrive inside. This list MIRRORS
// `ID_WRAPPER_KEYS` in the internal server's `core/audit-configuration.mjs`, which is the
// module that serves the RAW GHL row this adapter reconciles. Reading only `row.id` drifted the
// adapter toward its own fixtures: on live data an `_id`-only or `{$oid}` row could never seal.
const ROSTER_ID_WRAPPER_KEYS = Object.freeze(['$oid', '_id', 'id']);

function unwrapRosterId(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'object') return raw;
  if (Array.isArray(raw)) return null;                  // an id is never a list
  for (const key of ROSTER_ID_WRAPPER_KEYS) {
    if (!Object.hasOwn(raw, key)) continue;
    // ONE level only, exactly as the server does it.
    const inner = raw[key];
    return inner !== null && inner !== undefined && typeof inner !== 'object' ? inner : null;
  }
  return null;                                          // an unrecognised object shape is unreadable
}

/** `_id` first, `id` second, unwrapped and `String()`-coerced — the server's own `idOf`. */
function rosterRowId(row) {
  if (!isPlainObject(row)) return null;
  for (const key of ['_id', 'id']) {
    const raw = unwrapRosterId(row[key]);
    if (raw === null) continue;
    const value = String(raw);
    if (value !== '') return value;
  }
  return null;
}

/**
 * Ids are normalised to strings BEFORE fingerprinting, exactly as the server's `contentHashOf`
 * does, so `{_id: 5}`, `{_id: '5'}` and `{_id: {$oid: '5'}}` are ONE row serialized three ways
 * rather than three rows sharing one id.
 */
function rosterRowFingerprint(row) {
  const normalized = { ...row };
  for (const key of ['_id', 'id']) {
    if (!Object.hasOwn(normalized, key)) continue;
    const unwrapped = unwrapRosterId(normalized[key]);
    if (unwrapped !== null) normalized[key] = String(unwrapped);
  }
  return canonicalJson(normalized);
}

function reconcileRoster(data, manifest) {
  const fail = (reason) => ({ ok: false, reason, workflowIds: [] });
  if (!isPlainObject(data)) return fail('roster_body_invalid');

  const rows = data.workflows;
  if (!Array.isArray(rows)) return fail('roster_page_never_read');

  const identified = [];
  const seen = new Map();
  let rowsMalformed = null;
  for (const row of rows) {
    if (!isPlainObject(row)) { rowsMalformed = 'roster_row_malformed'; break; }
    const rowId = rosterRowId(row);
    if (rowId === null) { rowsMalformed = 'roster_row_id_missing'; break; }
    // The id is load-bearing: it addresses outbound tool calls and it is echoed into the
    // result, the checkpoint and the warnings. An id that is not an opaque identifier fails
    // the roster closed rather than being carried as free text.
    if (!isOpaqueId(rowId)) { rowsMalformed = 'roster_row_id_invalid'; break; }
    const fingerprint = rosterRowFingerprint(row);
    if (seen.has(rowId)) {
      if (seen.get(rowId) !== fingerprint) { rowsMalformed = 'roster_duplicate_conflict'; break; }
    } else {
      seen.set(rowId, fingerprint);
      identified.push({ row, rowId });
    }
  }
  const workflowIds = identified.map((entry) => entry.rowId);
  const withIds = (result) => ({ ...result, workflowIds });
  if (rowsMalformed) return withIds({ ok: false, reason: rowsMalformed });

  const pagination = data.pagination;
  if (
    !isPlainObject(pagination)
    || !Number.isInteger(pagination.attempted)
    || !Number.isInteger(pagination.fetched)
    || pagination.fetched < 1
    || pagination.attempted < pagination.fetched
  ) return withIds({ ok: false, reason: 'roster_pagination_invalid' });
  if (pagination.exhausted !== false) {
    return withIds({ ok: false, reason: 'roster_page_budget_exhausted' });
  }
  if (!isPlainObject(data.rateLimit) || data.rateLimit.limited !== false) {
    return withIds({ ok: false, reason: 'roster_rate_limited' });
  }
  if (!Array.isArray(data.warnings) || data.warnings.length > 0) {
    return withIds({ ok: false, reason: 'roster_warnings_present' });
  }
  if (data.complete !== true || data.truncated !== false) {
    return withIds({ ok: false, reason: 'roster_declared_incomplete' });
  }
  // The terminal reason is a machine token, never prose. The demonstrated leak put a patient
  // transcript here and it reached a healthy `complete: true` result.
  if (!isRosterTerminalReason(data.terminalReason)) {
    return withIds({ ok: false, reason: 'roster_not_terminal' });
  }
  if (!Number.isInteger(data.reportedTotal) || data.reportedTotal < 0) {
    return withIds({ ok: false, reason: 'roster_reported_total_invalid' });
  }
  if (!Number.isInteger(data.uniqueCount) || data.uniqueCount < 0) {
    return withIds({ ok: false, reason: 'roster_unique_count_invalid' });
  }
  if (!isNonEmptyString(data.capabilityVersion) || !isNonEmptyString(data.capturedAt)) {
    return withIds({ ok: false, reason: 'roster_provenance_invalid' });
  }

  const totalHistory = data.totalHistory;
  const uniqueProgress = data.uniqueProgress;
  if (!Array.isArray(totalHistory) || totalHistory.length !== pagination.fetched) {
    return withIds({ ok: false, reason: 'roster_total_ledger_short' });
  }
  if (!Array.isArray(uniqueProgress) || uniqueProgress.length !== pagination.fetched) {
    return withIds({ ok: false, reason: 'roster_progress_ledger_short' });
  }
  if (totalHistory.some((total) => total !== data.reportedTotal)) {
    return withIds({ ok: false, reason: 'roster_total_unstable' });
  }

  if (workflowIds.length !== data.uniqueCount) {
    return withIds({ ok: false, reason: 'roster_unique_count_mismatch' });
  }
  if (data.reportedTotal !== data.uniqueCount) {
    return withIds({ ok: false, reason: 'roster_total_mismatch' });
  }

  let running = 0;
  for (const progress of uniqueProgress) {
    if (!Number.isInteger(progress) || progress < 0) {
      return withIds({ ok: false, reason: 'roster_progress_invalid' });
    }
    if (progress === 0 && running < data.reportedTotal) {
      return withIds({ ok: false, reason: 'roster_no_unique_progress' });
    }
    running += progress;
  }
  if (running !== data.uniqueCount) {
    return withIds({ ok: false, reason: 'roster_progress_sum_mismatch' });
  }

  if (!validateAppliedQueries(data.appliedQueries, manifest, pagination.fetched)) {
    return withIds({ ok: false, reason: 'roster_applied_queries_invalid' });
  }
  if (!validateSourceRoutes(data.sourceRoutes, manifest)) {
    return withIds({ ok: false, reason: 'roster_source_routes_invalid' });
  }

  return {
    ok: true,
    reason: null,
    workflowIds,
    terminalReason: data.terminalReason,
    rows: identified.map(({ row, rowId }) => ({
      workflowId: rowId,
      // `status` is a RAW upstream GHL row field. The demonstrated leak put an absolute path
      // to a private token file here, and it reached both the composite and `collect()`.
      status: canonicalWorkflowStatus(row.status),
      version: Number.isInteger(row.version) ? row.version : null,
    })),
  };
}

// ---------------------------------------------------------------------------
// Runtime-window reconciliation (recomputed, never trusted)
// ---------------------------------------------------------------------------

/**
 * SILENT DROP 2 — the cursor is read from the LAST cursor-bearing enrollment query, not the
 * first entry of any kind.
 *
 * `core/workflow-runtime-window.mjs:1074-1086` builds page one with `action: 'first'` and
 * assigns the cursor tuple onto the query only from page two onward (`if (cursor !== null)
 * Object.assign(query, cursor)` at `:1085`, with `action = 'next'` set at `:1147`). Taking the
 * FIRST `workflow_enrollment_search` entry therefore always read page one, which never carries
 * a cursor key — so `enrollmentCursor` was `null` on every account, whatever the walk did.
 * `appliedQueries` is pushed once per read at `:609`, in call order, so the last entry that
 * carries any cursor key is the tuple the walk actually paged on.
 */
function extractEnrollmentCursor(appliedQueries) {
  if (!Array.isArray(appliedQueries)) return null;
  let latest = null;
  for (const row of appliedQueries) {
    if (!isPlainObject(row) || row.capabilityId !== 'workflow_enrollment_search') continue;
    if (!isPlainObject(row.query)) continue;
    if (!ENROLLMENT_CURSOR_KEYS.some((key) => Object.hasOwn(row.query, key))) continue;
    latest = row.query;
  }
  if (latest === null) return null;
  const cursor = projectTyped(latest, ENROLLMENT_CURSOR_SPEC);
  if (cursor === null || Object.keys(cursor).length === 0) return null;
  // `referenceCreatedAt` is NORMALISED, never echoed — see `normalizeCursorInstant`.
  if (Object.hasOwn(cursor, 'referenceCreatedAt')) {
    cursor.referenceCreatedAt = normalizeCursorInstant(cursor.referenceCreatedAt);
  }
  return cursor;
}

function reconcileRuntime(data, {
  manifest,
  requestedWindow,
  requestedStepIds,
}) {
  const fail = (reason) => ({ ok: false, reason });
  if (!isPlainObject(data)) return fail('runtime_body_invalid');

  if (data.complete !== true || data.truncated !== false) return fail('runtime_declared_incomplete');
  if (!Array.isArray(data.warnings) || data.warnings.length > 0) return fail('runtime_warnings_present');
  if (!isPlainObject(data.rateLimit) || data.rateLimit.limited !== false) return fail('runtime_rate_limited');

  const completeness = data.componentCompleteness;
  if (!isPlainObject(completeness)) return fail('runtime_completeness_invalid');
  for (const component of [
    'workflowDefinition',
    'runtimeEvents',
    'perStepCounts',
    'enrollments',
    'stepRosters',
    'enrollmentTotals',
  ]) {
    if (completeness[component] !== true) return fail('runtime_component_incomplete');
  }

  // Half-open window reconciliation: [fromDate, toDate) with an explicit expansion.
  const requested = data.requestedWindow;
  const applied = data.appliedWindow;
  if (
    !isPlainObject(requested)
    || requested.fromDate !== requestedWindow.fromDate
    || requested.toDate !== requestedWindow.toDate
    || requested.boundaries !== '[)'
  ) return fail('runtime_requested_window_mismatch');
  if (
    !isPlainObject(applied)
    || !Number.isInteger(applied.expansionMs)
    || applied.expansionMs < 0
    || applied.fromDate !== requested.fromDate - applied.expansionMs
    || applied.toDate !== requested.toDate
    || applied.analyticalFilter !== '[)'
  ) return fail('runtime_applied_window_mismatch');

  const events = data.runtimeEvents;
  if (!Array.isArray(events)) return fail('runtime_events_invalid');
  for (const event of events) {
    if (!isPlainObject(event) || !isOpaqueId(event.id)) return fail('runtime_event_invalid');
    if (!Number.isInteger(event.timestamp)) return fail('runtime_event_timestamp_invalid');
    if (event.timestamp < requested.fromDate || event.timestamp >= requested.toDate) {
      return fail('runtime_half_open_violation');
    }
  }

  const enrollments = data.enrollments;
  if (!isPlainObject(enrollments) || !Array.isArray(enrollments.rows)) {
    return fail('runtime_enrollments_invalid');
  }
  if (enrollments.complete !== true) return fail('runtime_enrollments_incomplete');
  const totals = data.enrollmentTotals;
  // Consumer rule: `enrollments:true` is never skippable unless `enrollmentTotals:true` holds.
  if (!isPlainObject(totals) || !Number.isInteger(totals.total) || totals.total < 0) {
    return fail('runtime_enrollment_totals_missing');
  }
  if (enrollments.rows.length > totals.total) return fail('runtime_enrollment_rows_exceed_total');

  if (!Array.isArray(data.perStepCounts)) return fail('runtime_per_step_counts_invalid');

  const stepRosters = data.stepRosters;
  if (!Array.isArray(stepRosters)) return fail('runtime_step_rosters_invalid');
  const rosterByStep = new Map();
  for (const roster of stepRosters) {
    if (!isPlainObject(roster) || !isNonEmptyString(roster.stepId)) {
      return fail('runtime_step_roster_invalid');
    }
    if (roster.complete !== true || !Array.isArray(roster.contacts)) {
      return fail('runtime_step_roster_unsealed');
    }
    // BLOCKER F — `total` may legitimately be `null` on a COMPLETE roster. The server sets it
    // only from a finite `totalCount` (`core/workflow-runtime-window.mjs:1216-1217`), and a
    // short page with `roster.total === null` is terminal on its own (`:1236-1237`, "nothing to
    // reconcile against; a short page is terminal") while `roster.complete` stays `true` from
    // `:1180`. Requiring an integer made every such roster fail. The arithmetic check is kept
    // for the case where a total IS reported.
    if (roster.total !== null && !Number.isInteger(roster.total)) {
      return fail('runtime_step_roster_total_mismatch');
    }
    if (Number.isInteger(roster.total) && roster.contacts.length > roster.total) {
      return fail('runtime_step_roster_total_mismatch');
    }
    if (!Number.isInteger(roster.pages) || roster.pages < 1) {
      return fail('runtime_step_roster_pages_invalid');
    }
    rosterByStep.set(roster.stepId, roster);
  }
  for (const stepId of requestedStepIds) {
    if (!rosterByStep.has(stepId)) return fail('runtime_step_roster_missing');
  }

  const pagination = data.pagination;
  if (!isPlainObject(pagination)) return fail('runtime_pagination_invalid');
  // BLOCKER B — the terminality condition, DERIVED FROM THE WALK rather than assumed.
  //
  // `attempted === terminal` is only true when the very first partition came back short.
  // `core/workflow-runtime-window.mjs:998-999` increments `terminal` ONLY on a SHORT page
  // (`rows.length < LOG_PAGE_SIZE`, and `LOG_PAGE_SIZE = 20` at `:88`); a SATURATED partition
  // splits at `:1014-1016` and recurses into exactly two children, and its own `attempted += 1`
  // at `:961` is never matched by a `terminal`. So any workflow with more than 20 log rows in
  // the window returned Partial. The server's own test pins `attempted 5 / terminal 0`
  // (`test/workflow-runtime-window.test.mjs:1662-1664`).
  //
  // The walk is a FULL BINARY TREE: `visitPartition` either counts itself and returns (short
  // page => terminal, or saturated-at-floor => warns) or counts itself and recurses TWICE.
  // The two non-terminal leaf exits — saturation at `:1010` and budget exhaustion at
  // `:940-945` — both WARN, and this reconciler has already refused any body carrying a warning
  // or `complete !== true` above, so on every body that reaches this line every leaf is
  // terminal. A full binary tree with L leaves has 2L-1 nodes, per stream root. The stream
  // count is 1: `:1022` walks `config.eventTypes.length > 0 ? config.eventTypes : [null]`, and
  // this adapter never sends `eventTypes` (see `projectRuntimeFilters`), so `stringList`
  // (`:180`) yields `[]` and there is exactly one root call.
  const partitions = pagination.logPartitions;
  if (
    !isPlainObject(partitions)
    || !Number.isInteger(partitions.attempted)
    || !Number.isInteger(partitions.terminal)
    || partitions.exhausted !== false
    || partitions.terminal < 1
    || partitions.attempted !== (2 * partitions.terminal) - LOG_PARTITION_STREAMS
  ) return fail('runtime_log_partitions_incomplete');
  for (const key of ['enrollmentPages', 'stepRosterPages']) {
    const ledger = pagination[key];
    if (
      !isPlainObject(ledger)
      || !Number.isInteger(ledger.fetched)
      || ledger.fetched < 0
      || ledger.exhausted !== false
    ) return fail('runtime_page_budget_exhausted');
  }

  if (!validateSourceRoutes(data.sourceRoutes, manifest)) {
    return fail('runtime_source_routes_invalid');
  }
  if (!Array.isArray(data.sourceRoutes) || data.sourceRoutes.length === 0) {
    return fail('runtime_source_routes_missing');
  }
  if (!isNonEmptyString(data.capabilityVersion) || !isNonEmptyString(data.capturedAt)) {
    return fail('runtime_provenance_invalid');
  }

  return { ok: true, reason: null };
}

// ---------------------------------------------------------------------------
// Historical definition binding
// ---------------------------------------------------------------------------

/**
 * Historical binding. The wire's own `provenEffectiveInterval` flag is NOT sufficient: a proven
 * effective interval additionally requires a strictly well-formed digest on every interval, a
 * history that ties to the definition this adapter independently verified, and a valid live
 * receipt for the capability that governs the definition evidence. And the composite's own
 * `configurationBinding` is authoritative — it is a CEILING, never overridden upward.
 */
function bindEventsToDefinition(validity, events, {
  currentDefinitionHash = null,
  compositeBinding = null,
  governingCapabilityProven = false,
  definitionHashVerification = null,
} = {}) {
  const unprovenLimitation = 'No typed evidence proves which definition was in force for these '
    + 'runtime events, so configuration-to-execution stops at correlation.';

  const rawIntervals = isPlainObject(validity) && Array.isArray(validity.versionHistory)
    ? validity.versionHistory
    : null;
  // Strict digest grammar on EVERY declared interval: one malformed row invalidates the history
  // rather than being skipped, so a partial forgery cannot narrow the candidate set.
  const intervalsWellFormed = Array.isArray(rawIntervals)
    && rawIntervals.length > 0
    && rawIntervals.every((interval) => isPlainObject(interval)
      && typeof interval.canonicalHash === 'string'
      && BARE_DIGEST.test(interval.canonicalHash)
      && isoOrNull(interval.effectiveFrom) !== null
      && (interval.effectiveTo === null || isoOrNull(interval.effectiveTo) !== null));
  // The history must describe the definition the adapter independently verified. A history that
  // never mentions the captured definition is evidence about some other workflow.
  const tiesToVerifiedDefinition = intervalsWellFormed
    && typeof currentDefinitionHash === 'string'
    && BARE_DIGEST.test(currentDefinitionHash)
    && rawIntervals.some((interval) => interval.canonicalHash === currentDefinitionHash);
  const sourceToken = isPlainObject(validity)
    && typeof validity.source === 'string'
    && isDefinitionValiditySource(validity.source)
    ? validity.source
    : null;

  const intervals = rawIntervals;
  /**
   * Finding R6-M1 — the weaker verdict now CONSTRAINS something instead of merely being labelled.
   *
   * `hashVerification: 'scrub_explained'` was consumed by nothing anywhere in the system: zero
   * references in `weekly.mjs` or `kernel.mjs`, so "the weaker verdict can never pass as the
   * stronger" was true of the STRING and of nothing else. The claim that actually requires an
   * exactly verified definition is the direct causal one — `supportsDirectMechanismProof`, and
   * the `definitionGovernedRuntimeEvents: 'proven'` binding built from it — because it asserts
   * that THIS byte-for-byte definition governed those executions. A scrub-explained definition
   * is verified only by cross-read agreement between two post-scrub reads: it establishes that
   * both reads saw the same workflow, not that the declared digest describes these bytes. That
   * is honest correlation evidence and it stays published; it is not proof of governance.
   */
  const definitionExactlyVerified = definitionHashVerification === 'exact';
  const provenSource = isPlainObject(validity)
    && validity.provenEffectiveInterval === true
    && sourceToken !== null
    && intervalsWellFormed
    && tiesToVerifiedDefinition
    && governingCapabilityProven === true
    && definitionExactlyVerified;

  const bound = events.map((event) => {
    if (!provenSource) {
      return { ...event, workflowDefinitionHash: null, supportsDirectMechanismProof: false };
    }
    const candidates = intervals.filter((interval) => {
      if (!isPlainObject(interval) || typeof interval.canonicalHash !== 'string') return false;
      const from = isoOrNull(interval.effectiveFrom);
      const to = interval.effectiveTo === null ? Number.POSITIVE_INFINITY : isoOrNull(interval.effectiveTo);
      if (from === null || to === null) return false;
      // Strict on BOTH ends: the internal contract declares no boundary convention, so an
      // event sitting exactly on an effective instant is not PROVEN to belong to either side.
      return from < event.timestamp && event.timestamp < to;
    });
    if (candidates.length !== 1) {
      return { ...event, workflowDefinitionHash: null, supportsDirectMechanismProof: false };
    }
    return {
      ...event,
      workflowDefinitionHash: candidates[0].canonicalHash,
      supportsDirectMechanismProof: true,
    };
  });

  const allBound = bound.length > 0 && bound.every((event) => event.workflowDefinitionHash !== null);
  // The server's own verdict is the ceiling. Today it is a CONSTANT `unproven` because the audit
  // rail exposes no version-history capability, so nothing this adapter computes may publish a
  // stronger claim than the composite itself is willing to make.
  const compositeProven = isPlainObject(compositeBinding)
    && compositeBinding.definitionGovernedRuntimeEvents === 'proven'
    && compositeBinding.publishableAsGoverning === true;
  const governing = allBound && compositeProven;
  return {
    events: bound,
    binding: {
      definitionGovernedRuntimeEvents: governing ? 'proven' : 'unproven',
      // `provenBy` only ever carries a token that passed the strict grammar above.
      provenBy: governing ? sourceToken : null,
      publishableAsGoverning: governing,
      limitation: governing ? null : unprovenLimitation,
    },
  };
}

// ---------------------------------------------------------------------------
// AI bundle reconciliation
// ---------------------------------------------------------------------------

function emptyAiComponent(surface) {
  return {
    component: surface,
    applicable: null,
    complete: false,
    discoveryTerminal: false,
    detailDenominator: 0,
    detailsRead: 0,
    items: [],
    reportedTotal: null,
    reason: 'ai_component_missing',
  };
}

function reconcileAiComponent(surface, component, { manifest, companyId, coverage }) {
  if (!isPlainObject(component)) return emptyAiComponent(surface);

  const declaredApplicable = component.applicable;
  const items = Array.isArray(component.items) ? component.items : null;
  // BLOCKER D — the tombstone rule is SCOPED to the surfaces the server scopes it to.
  // `core/audit-configuration.mjs:215` sets `tombstonesApply: true` on `voice_ai` alone and
  // `:1212` computes `tombstone: surface.tombstonesApply === true && grade === 'tombstone'`, so
  // a soft-deleted Conversation AI or Agent Studio row carrying both fields is `tombstone:
  // false` on the wire. Computing `tombstoneProven` on all three surfaces made that ordinary
  // row disagree with the server and hard-failed the whole component as `ai_tombstone_unproven`.
  // The two-signal grading itself is unchanged and matches `gradeDeletionSignals` (`:817-818`):
  // `isDeleted === true` AND `agentStatus === 'INACTIVE'`, strictly, with no coercion.
  const tombstonesApply = TOMBSTONE_SURFACES.includes(surface);
  const mapped = (items ?? []).map((item) => {
    const row = isPlainObject(item?.row) ? item.row : {};
    const tombstoneProven = tombstonesApply
      && row.isDeleted === true
      && row.agentStatus === 'INACTIVE';
    return {
      id: isOpaqueId(item?.id) ? item.id : null,
      applicable: !tombstoneProven,
      tombstoneProven,
      detailRequired: !tombstoneProven,
      detailRead: item?.detailRead === true && item?.detail !== null && item?.detail !== undefined,
      declaredTombstone: item?.tombstone === true,
    };
  });

  const shell = {
    component: surface,
    // R2-I5 — anything that is not a boolean is UNKNOWN, and unknown is `null`. Copying the
    // wire value verbatim here carried an arbitrary nested object (a bearer token, an email
    // and a transcript were demonstrated) straight into the result via `ai_applicability_unknown`.
    applicable: isBoolean(declaredApplicable) ? declaredApplicable : null,
    complete: false,
    discoveryTerminal: false,
    detailDenominator: mapped.filter((item) => item.detailRequired).length,
    detailsRead: mapped.filter((item) => item.detailRequired && item.detailRead).length,
    items: mapped.map(({ declaredTombstone: _declared, ...rest }) => rest),
    // BLOCKER C — the total the upstream reported, or `null` when it reported none. Published
    // so that "the row count was reconciled against a declared total" and "no total was ever
    // offered, so the short-page/single-shot terminal is the only proof there is" are
    // distinguishable in the artefact rather than collapsed into a silent pass.
    reportedTotal: Array.isArray(component.totalHistory)
      && Number.isInteger(component.totalHistory[0])
      ? component.totalHistory[0]
      : null,
    reason: null,
  };

  const fail = (reason) => ({ ...shell, reason });

  if (items === null) return fail('ai_items_missing');
  if (declaredApplicable !== true && declaredApplicable !== false) {
    return fail('ai_applicability_unknown');
  }
  if (component.complete !== true) return fail('ai_component_failed');
  if (!Array.isArray(component.errors) || component.errors.length > 0) {
    return fail('ai_component_errors');
  }
  if (mapped.some((item) => item.id === null)) return fail('ai_item_id_missing');
  if (mapped.some((item) => item.declaredTombstone !== item.tombstoneProven)) {
    return fail('ai_tombstone_unproven');
  }

  const pages = component.pages;
  if (
    !isPlainObject(pages)
    || !Number.isInteger(pages.attempted)
    || !Number.isInteger(pages.fetched)
    || pages.fetched < 1
    || pages.exhausted !== false
  ) return fail('ai_pagination_incomplete');

  // BLOCKER C — AN ABSENT TOTAL IS AN HONEST UNKNOWN, NOT A FAILURE.
  //
  // `core/audit-configuration.mjs:427-430` `readTotal` pushes `null` whenever the root `total`
  // is absent or is not already numeric, and the walk still sets `reconciled = true` on a
  // single-shot surface (`:1279-1286`) or a short page: an absent total is EXPLICITLY LEGAL,
  // and the server says outright at `:1230-1236` that whether GHL emits `total` on
  // `/ai-employees/agents` or `/voice-ai/agents/simple` at all is UNVERIFIED. Requiring
  // `totalHistory[0] === mapped.length` therefore failed every AI component on any account
  // whose routes omit the key — INCLUDING an account with zero agents, where `null !== 0`.
  //
  // Stability is still enforced: `:1247-1265` ends the walk on a total that appears, changes or
  // disappears mid-walk, so a history that is not constant is a contradiction either way. And a
  // total that IS present must still agree with the rows actually served.
  const totalHistory = component.totalHistory;
  if (!Array.isArray(totalHistory) || totalHistory.length === 0) return fail('ai_total_history_missing');
  if (totalHistory.some((total) => total !== totalHistory[0])) return fail('ai_total_unstable');
  const reportedTotal = totalHistory[0];
  if (reportedTotal !== null && !Number.isInteger(reportedTotal)) return fail('ai_total_mismatch');
  if (reportedTotal !== null && reportedTotal !== mapped.length) return fail('ai_total_mismatch');

  const discoveryTerminal = true;

  if (component.detailDenominator !== shell.detailDenominator) return fail('ai_detail_denominator_mismatch');
  if (component.detailsRead !== shell.detailsRead) return fail('ai_details_read_mismatch');
  if (shell.detailsRead !== shell.detailDenominator) return fail('ai_detail_missing');

  if (!validateSourceRoutes(component.sourceRoutes, manifest)) return fail('ai_source_routes_invalid');

  const capabilities = AI_SURFACE_CAPABILITIES[surface];
  if (coverage[capabilities.discovery]?.proven !== true) {
    return { ...shell, discoveryTerminal, reason: 'ai_discovery_capability_unproven' };
  }
  if (shell.detailDenominator > 0 && coverage[capabilities.detail]?.proven !== true) {
    return { ...shell, discoveryTerminal, reason: 'ai_detail_capability_unproven' };
  }
  if (surface === 'agent_studio' && declaredApplicable === true && !isNonEmptyString(companyId)) {
    return { ...shell, discoveryTerminal, reason: 'ai_company_context_missing' };
  }

  return { ...shell, complete: true, discoveryTerminal, reason: null };
}

function reconcileAiBundle(data, { manifest, coverage }) {
  const components = {};
  const reasons = [];
  const push = (reason) => { if (reason) reasons.push(reason); };

  const declaredComponents = isPlainObject(data?.components) ? data.components : {};
  const foreignSurfaces = Object.keys(declaredComponents).filter(
    (surface) => !AI_SURFACES.includes(surface),
  );
  const portalOffered = foreignSurfaces.some(
    (surface) => EXCLUDED_PORTAL_TOKENS.some((token) => normalizeToken(surface).includes(token)),
  );

  if (foreignSurfaces.length > 0) {
    // Nothing about an excluded surface is retained or echoed.
    for (const surface of AI_SURFACES) components[surface] = emptyAiComponent(surface);
    return {
      components,
      complete: false,
      reasons: [portalOffered ? 'ai_excluded_surface_offered' : 'ai_unknown_surface_offered'],
    };
  }

  if (!isPlainObject(data) || !isPlainObject(data.rateLimit) || data.rateLimit.limited !== false) {
    for (const surface of AI_SURFACES) components[surface] = emptyAiComponent(surface);
    return { components, complete: false, reasons: ['ai_bundle_rate_limited'] };
  }

  const bundleHealthy = data.truncated === false
    && Array.isArray(data.warnings)
    && isNonEmptyString(data.capabilityVersion)
    && isNonEmptyString(data.capturedAt);
  if (!bundleHealthy) {
    for (const surface of AI_SURFACES) components[surface] = emptyAiComponent(surface);
    return { components, complete: false, reasons: ['ai_bundle_invalid'] };
  }
  const bundleDegraded = data.complete !== true || data.warnings.length > 0;

  // Agent Studio needs the typed company context the bundle itself reports. The target's own
  // companyId is never substituted for it: a bundle that resolved no company has not proven
  // the surface was enumerated for the right agency.
  const companyId = isNonEmptyString(data.companyId) ? data.companyId : null;
  for (const surface of AI_SURFACES) {
    const component = reconcileAiComponent(surface, declaredComponents[surface], {
      manifest,
      companyId,
      coverage,
    });
    components[surface] = bundleDegraded && component.complete
      ? { ...component, complete: false, reason: 'ai_bundle_degraded' }
      : component;
    push(components[surface].reason);
  }

  const complete = AI_SURFACES.every((surface) => components[surface].complete === true);
  return { components, complete, reasons };
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export function createInternalGhlAdapter(options = {}) {
  if (!isPlainObject(options)) throw codedError(CODES.REQUEST, TypeError);
  const {
    client,
    expectedContractVersion,
    expectedLocationId,
    expectedToolProfileHash,
    capabilityProofIndex,
    runtime = {},
  } = options;

  if (!client || typeof client.callTool !== 'function') {
    throw codedError(CODES.HANDSHAKE, TypeError);
  }

  // R3-1 — the run's contact pseudonym key. Injected when the host already owns one so the
  // adapter's pseudonyms agree with the rest of the run's artifacts, minted per instance
  // otherwise. It is read once, never stored on the result and never echoed.
  const { key: pseudonymKey, source: pseudonymKeySource } = resolvePseudonymKey(
    options.pseudonymKey,
  );
  const pseudonymize = pseudonymizerFor(pseudonymKey);

  // R6-I2 — the run's explicit canary scope. Absent means "this run states no scope", which is
  // the pre-existing behaviour and can never reach `complete_full` in the shipped root because
  // that requires an independently sealed anchor, which is minted by the same authenticated
  // document that carries this list. A DECLARED list is authoritative: an empty one authorizes
  // no canary at all, and a malformed one is a caller error rather than a silent degradation.
  const authorizedCanaryTargetHashes = (() => {
    if (!Object.hasOwn(options, 'authorizedCanaryTargetHashes')) return null;
    const declared = options.authorizedCanaryTargetHashes;
    if (declared === null) return null;
    if (!Array.isArray(declared) || !declared.every(isNonEmptyString)) {
      throw codedError(CODES.REQUEST, TypeError);
    }
    return new Set(declared);
  })();

  // -------------------------------------------------------------------------
  // Bounded dispatch
  // -------------------------------------------------------------------------

  function makeSession({ signal, manifest = null }) {
    const trace = [];
    const sourceRoutes = [];
    // The RAW capability ids every recorded route declared. Internal only — it is never
    // returned, never echoed and never used as an object key. It exists so that nulling an
    // unsealed `capabilityId` in the PROJECTED route (R2-M6) cannot soften the C3
    // exercised-coverage reconciliation.
    const exercisedCapabilityIds = [];
    let toolCalls = 0;

    const budgetLimit = Number.isInteger(runtime?.budget?.toolCalls)
      ? runtime.budget.toolCalls
      : null;
    const deadlineAt = Number.isFinite(runtime?.deadlineAt) ? Number(runtime.deadlineAt) : null;

    const boundary = () => {
      if (signal?.aborted === true) return CODES.ABORTED;
      if (deadlineAt !== null && nowMs(runtime) >= deadlineAt) return CODES.DEADLINE;
      if (budgetLimit !== null && toolCalls >= budgetLimit) return CODES.BUDGET;
      return null;
    };

    const dispatch = async (name, args) => {
      if (!AUDIT_TOOL_NAMES.includes(name)) throw codedError(CODES.READ_ONLY);
      toolCalls += 1;
      let response;
      try {
        response = await client.callTool({ name, arguments: args }, { signal });
      } catch (error) {
        // The THROWING half of the split error model.
        trace.push({
          tool: name,
          capabilityId: null,
          status: null,
          ok: false,
          boundLocationId: expectedLocationId ?? null,
        });
        return { status: 'failed', code: isNonEmptyString(error?.code) ? error.code : 'TRANSPORT_FAILED' };
      }
      const parsed = parseToolBody(response);
      trace.push({
        tool: name,
        capabilityId: null,
        status: parsed.status === 'ok' ? 200 : null,
        ok: parsed.status === 'ok',
        boundLocationId: expectedLocationId ?? null,
      });
      return parsed;
    };

    const listTools = async () => {
      toolCalls += 1;
      trace.push({
        tool: 'tools/list',
        capabilityId: null,
        status: 200,
        ok: true,
        boundLocationId: expectedLocationId ?? null,
      });
      if (typeof client.listTools === 'function') return client.listTools({ signal });
      return client.callTool({ name: 'tools/list', arguments: null }, { signal });
    };

    // PROJECTED onto sealed manifest constants — see `projectRoute`. A wire route carrying a
    // bearer token, a credential path, a token id or a full request envelope loses all of it
    // here, which is the only place session routes are ever recorded.
    const recordRoutes = (routes) => {
      if (Array.isArray(routes)) {
        for (const raw of routes) {
          if (isPlainObject(raw) && isNonEmptyString(raw.capabilityId)) {
            exercisedCapabilityIds.push(raw.capabilityId);
          }
        }
      }
      for (const route of projectRoutes(routes, manifest)) sourceRoutes.push(route);
    };

    return {
      boundary,
      dispatch,
      listTools,
      recordRoutes,
      trace,
      sourceRoutes,
      exercisedCapabilityIds,
    };
  }

  // -------------------------------------------------------------------------
  // Preflight — every check below happens BEFORE any evidence call.
  // -------------------------------------------------------------------------

  // C4 — the manifest and bundle identities must be anchored OUTSIDE the untrusted proof index.
  // A pin that is present in the constructor options is binding, whatever its value; `null`,
  // a malformed digest and a wrong digest are all rejections, exactly as for the profile hash.
  const manifestPinned = Object.hasOwn(options, 'expectedCapabilityManifestHash');
  const bundlePinned = Object.hasOwn(options, 'expectedBundleHash');
  const { expectedCapabilityManifestHash, expectedBundleHash } = options;

  function preflight(window) {
    if (
      typeof expectedContractVersion !== 'string'
      || !SUPPORTED_CONTRACT_VERSIONS.includes(expectedContractVersion)
    ) throw codedError(CODES.CONTRACT);
    if (!isNonEmptyString(expectedLocationId)) throw codedError(CODES.LOCATION);
    const requestedWindow = validateCollectionWindow(window, CODES.WINDOW);
    if (isPlainObject(capabilityProofIndex)) {
      // Strict canonical parse: an unknown top-level key means this is not the proof index
      // shape the contract defines, and an unrecognised container is never partially trusted.
      for (const key of Object.keys(capabilityProofIndex)) {
        if (!PROOF_INDEX_KEYS.includes(key)) throw codedError(CODES.MANIFEST);
      }
    }
    const manifest = isPlainObject(capabilityProofIndex)
      ? validateManifest(capabilityProofIndex.manifest, capabilityProofIndex.bundleHash)
      : null;
    if ((manifestPinned || bundlePinned) && manifest === null) throw codedError(CODES.MANIFEST);
    if (manifestPinned) {
      if (
        typeof expectedCapabilityManifestHash !== 'string'
        || !INTERNAL_DIGEST.test(expectedCapabilityManifestHash)
        || expectedCapabilityManifestHash !== manifest.manifestHash
      ) throw codedError(CODES.MANIFEST);
    }
    if (bundlePinned) {
      if (
        typeof expectedBundleHash !== 'string'
        || !INTERNAL_DIGEST.test(expectedBundleHash)
        || expectedBundleHash !== manifest.bundleHash
      ) throw codedError(CODES.MANIFEST);
    }
    return { requestedWindow, manifest };
  }

  function assertHandshake(listing) {
    const names = validateToolRegistry(listing);
    const toolProfileHash = internalDigest([...names]);
    if (
      typeof expectedToolProfileHash !== 'string'
      || !INTERNAL_DIGEST.test(expectedToolProfileHash)
      || expectedToolProfileHash !== toolProfileHash
    ) throw codedError(CODES.PROFILE);
    return toolProfileHash;
  }

  // -------------------------------------------------------------------------
  // The narrow weekly composite
  // -------------------------------------------------------------------------

  async function collectAuditEvidence(request = {}) {
    if (!isPlainObject(request)) throw codedError(CODES.REQUEST, TypeError);
    const { target, window, applicability, stepRosterRequests, signal } = request;

    const { requestedWindow, manifest } = preflight(window);
    if (!isPlainObject(target) || target.locationId !== expectedLocationId) {
      throw codedError(CODES.LOCATION);
    }
    const expectedCompanyId = isNonEmptyString(target.companyId) ? target.companyId : null;

    // R3-3 — a declared id becomes an object KEY in `capabilityCoverage`, and `finish()` is
    // already careful that only a SEALED id may become one for wire-sourced ids. Config is a
    // lower-power source than the wire, but it is not a sealed vocabulary either, and an
    // unsealed string used as a key is echoed exactly as loudly as a value. The declared set is
    // therefore RESOLVED against the sealed manifest, not merely shape-checked; whatever fails
    // to resolve is counted, reported without being repeated, and fails the run closed.
    const declaredCapabilityIds = Array.isArray(applicability?.capabilityIds)
      ? [...new Set(applicability.capabilityIds)]
      : null;
    const capabilityIds = declaredCapabilityIds === null
      ? [...(manifest ? manifest.descriptors.keys() : [])]
      : declaredCapabilityIds.filter(
        (capabilityId) => isProvenanceToken(capabilityId)
          && (manifest !== null
            ? manifest.descriptors.has(capabilityId)
            : isSealedCapabilityId(capabilityId)),
      );
    const unsealedDeclaredCount = declaredCapabilityIds === null
      ? 0
      : declaredCapabilityIds.length - capabilityIds.length;
    const workflowFilter = Array.isArray(applicability?.workflowIds)
      ? new Set(applicability.workflowIds.filter(isNonEmptyString))
      : null;
    const stepRequests = isPlainObject(stepRosterRequests) ? stepRosterRequests : {};

    const session = makeSession({ signal, manifest });
    const now = nowMs(runtime);
    const captured = capturedAt(runtime);
    const windowMs = {
      fromDate: Date.parse(requestedWindow.from),
      toDate: Date.parse(requestedWindow.to),
    };
    const operationId = `internal-audit.${sha256({
      schemaVersion: SCHEMA_VERSION,
      source: SOURCE,
      boundLocationId: expectedLocationId,
      requestedWindow,
      capabilityIds: [...capabilityIds].sort(),
    }).slice(0, 32)}`;

    const warnings = [];
    const addWarning = (code, component, reason) => {
      warnings.push({ code, component, reason: reason ?? null });
    };

    let coverage = Object.fromEntries(capabilityIds.map((capabilityId) => [capabilityId, {
      capabilityId,
      applicable: true,
      proven: false,
      proofClass: null,
    }]));
    let coverageProven = capabilityIds.length === 0;
    let toolProfileHash = null;
    // Finding R4-C1, round-5 close: every attestation hash this run's proof evaluation
    // accepted, across the declared pass and the exercised-reconciliation pass. `finish()`
    // publishes it so the publication gate can require a sealed one WITHOUT needing the
    // attestation document at the gate — see `weekly.mjs` `sealedIdentityAnchors`.
    const governingAttestationHashes = new Set();

    /**
     * C3 — the caller-declared applicable set is a REQUEST, not a licence. Reconcile it against
     * the capabilities this run actually exercised (`session.sourceRoutes` is the exercised
     * ledger). Any exercised capability without a valid unexpired `live_runtime` receipt is
     * named in `capabilityCoverage` and forces the affected scope incomplete; a declared set
     * that omits an exercised capability is an error, never permission.
     */
    const reconcileExercisedCoverage = () => {
      const declaredOnTheWire = [...new Set(session.exercisedCapabilityIds)].sort();
      // Only a SEALED id may become a `capabilityCoverage` KEY: an unsealed id is an untrusted
      // wire string and object keys are echoed just as loudly as values.
      const exercised = declaredOnTheWire.filter(
        (capabilityId) => manifest !== null && manifest.descriptors.has(capabilityId),
      );
      const unsealed = declaredOnTheWire.length - exercised.length;
      const undeclared = exercised.filter((capabilityId) => !Object.hasOwn(coverage, capabilityId));
      let merged = coverage;
      if (undeclared.length > 0) {
        // An undeclared capability may still hold an honest receipt; evaluate it rather than
        // assuming the worst, then fail closed on whatever remains unproven.
        const extra = evaluateCapabilityProofs({
          capabilityProofIndex,
          capabilityIds: undeclared,
          manifest,
          toolProfileHash,
          now,
          authorizedCanaryTargetHashes,
        });
        for (const hash of extra.governingAttestationHashes) {
          governingAttestationHashes.add(hash);
        }
        merged = { ...coverage, ...extra.coverage };
      }
      const withExercise = {};
      for (const [capabilityId, entry] of Object.entries(merged)) {
        withExercise[capabilityId] = { ...entry, exercised: exercised.includes(capabilityId) };
      }
      const unproven = exercised.filter(
        (capabilityId) => withExercise[capabilityId]?.proven !== true,
      );
      return { coverage: withExercise, unproven, unsealed };
    };

    const finish = ({
      stage,
      reason = null,
      workflowRoster = {
        complete: false,
        sealed: false,
        reportedTotal: null,
        terminalReason: null,
        workflowIds: [],
        incompleteReason: null,
      },
      workflows = [],
      aiConfiguration = { components: {}, complete: false },
      complete = false,
    }) => {
      const exercisedCoverage = reconcileExercisedCoverage();
      coverage = exercisedCoverage.coverage;
      for (const capabilityId of exercisedCoverage.unproven) {
        // Only a SEALED capability id is echoed; an id that resolves to no descriptor is an
        // untrusted wire string and is reported without being repeated.
        const named = manifest !== null && manifest.descriptors.has(capabilityId);
        addWarning(
          CODES.UNPROVEN,
          named ? capabilityId : 'capability_proof',
          'exercised_capability_not_proven_live',
        );
      }
      if (unsealedDeclaredCount > 0) {
        // R3-3 — the id is never repeated: it resolved to no sealed descriptor, so it is an
        // unsealed string and may not become a `capabilityCoverage` key. That the caller
        // declared a capability outside the sealed manifest is still reported, and it still
        // fails the run closed.
        addWarning(
          CODES.UNPROVEN,
          'capability_proof',
          'declared_capability_outside_sealed_manifest',
        );
      }
      if (exercisedCoverage.unsealed > 0) {
        // The id itself is never repeated: it resolved to no sealed descriptor, so it is an
        // untrusted wire string. That a route outside the sealed manifest was exercised is
        // still reported, and it still fails the run closed.
        addWarning(
          CODES.UNPROVEN,
          'capability_proof',
          'exercised_capability_outside_sealed_manifest',
        );
      }

      /**
       * R2-C2 — the SEALED ROSTER is the denominator, and `applicability.workflowIds` is a
       * REQUEST, not a licence. A roster member the caller excluded was never read, so it is
       * not reviewable and it may not be reported `complete: true`. This is the round-1 C3
       * reconciliation mirrored onto the workflow axis.
       */
      const rosterMembers = Array.isArray(workflowRoster.workflowIds)
        ? [...new Set(workflowRoster.workflowIds)]
        : [];
      const reviewedIds = new Set(
        workflows.filter((entry) => entry.reviewed === true).map((entry) => entry.workflowId),
      );
      const completedIds = new Set(
        workflows
          .filter((entry) => entry.reviewed === true && entry.complete === true)
          .map((entry) => entry.workflowId),
      );
      const notReviewed = rosterMembers.filter((workflowId) => !reviewedIds.has(workflowId)).sort();
      for (const workflowId of notReviewed) {
        addWarning(CODES.WORKFLOW, workflowId, 'roster_member_not_reviewed');
      }
      const workflowCoverage = {
        rosterSealed: workflowRoster.sealed === true,
        rosterTotal: rosterMembers.length,
        reviewed: [...reviewedIds].filter((id) => rosterMembers.includes(id)).length,
        complete: [...completedIds].filter((id) => rosterMembers.includes(id)).length,
        notReviewed,
        reconciled: workflowRoster.sealed === true
          && notReviewed.length === 0
          && completedIds.size === rosterMembers.length,
      };

      const effectiveComplete = complete === true
        && exercisedCoverage.unproven.length === 0
        && workflowCoverage.reconciled === true
        && warnings.length === 0;
      const checkpoint = {
        schemaVersion: SCHEMA_VERSION,
        source: SOURCE,
        operationId,
        phase: stage === 'auth' ? 'awaiting_internal_auth' : 'collecting_internal',
        stage,
        boundLocationId: expectedLocationId,
        requestedWindow,
        capturedAt: captured,
        reason,
        sealedRoster: workflowRoster.sealed === true,
        rosterReconciled: workflowCoverage.reconciled,
        collectedWorkflowIds: workflows
          .filter((entry) => entry.complete === true && entry.reviewed === true)
          .map((entry) => entry.workflowId)
          .sort(),
      };
      const result = {
        source: SOURCE,
        operationId,
        boundLocationId: expectedLocationId,
        requestedWindow,
        appliedWindow: requestedWindow,
        capturedAt: captured,
        contractVersion: expectedContractVersion,
        toolProfileHash,
        capabilityManifestHash: manifest ? manifest.manifestHash : null,
        bundleHash: manifest ? manifest.bundleHash : null,
        // R4-I2 — whether this run's pseudonyms are reproducible. The KEY never leaves this
        // module; only the fact of its provenance does. `ephemeral` means the two pseudonymised
        // ledgers cannot be joined to any other run, so a week-over-week diff must treat every
        // enrolled contact as new rather than silently doing so.
        pseudonymBinding: {
          keySource: pseudonymKeySource,
          stableAcrossRuns: pseudonymKeySource === 'injected',
        },
        // Which identities were anchored OUTSIDE the untrusted proof index on this run.
        capabilityProofAnchor: {
          toolProfilePinned: true,
          manifestPinned,
          bundlePinned,
        },
        /**
         * Finding R4-C1, round-5 close — THE GOVERNING ATTESTATIONS.
         *
         * The attestation hashes `attestationIsSound` actually accepted on this run: validated
         * documents, each referenced by an unexpired `live_runtime` receipt for a
         * manifest-sealed capability, each binding exactly the three identities this artefact
         * declares above (`toolProfileHash`, `capabilityManifestHash`, `bundleHash`) —
         * `pins` in `evaluateCapabilityProofs` is built from the same three values.
         *
         * This is the PREIMAGE RELATION, computed where the document actually lives. The
         * publication gate can then require one of these hashes to be SEALED in the run's
         * frozen inputs without ever needing the document: an attacker can mint an attestation,
         * but its hash is then a value the run never sealed, and an attestation whose hash the
         * run DID seal cannot have been minted by them, because producing a document that
         * hashes to a sealed digest is a second-preimage attack on SHA-256. Sorted, so the
         * artefact stays byte-reproducible.
         */
        governingAttestationHashes: [...governingAttestationHashes].sort(),
        workflowRoster,
        workflows,
        workflowCoverage,
        aiConfiguration,
        capabilityCoverage: coverage,
        locationBinding: {
          boundLocationId: expectedLocationId,
          bindingMethod: 'native',
          quarantined: false,
          conflicts: [],
        },
        sourceRoutes: session.sourceRoutes,
        trace: session.trace,
        complete: effectiveComplete,
        truncated: !effectiveComplete,
        checkpoint,
        warnings,
      };
      return deepFreezeJson(safeClone(result, CODES.REQUEST));
    };

    // ---- bounded boundary before the handshake -----------------------------
    let hit = session.boundary();
    if (hit) {
      addWarning(hit, 'run', 'boundary_before_handshake');
      return finish({ stage: 'handshake', reason: hit });
    }

    // ---- handshake --------------------------------------------------------
    let listing;
    try {
      listing = await session.listTools();
    } catch {
      throw codedError(CODES.HANDSHAKE);
    }
    toolProfileHash = assertHandshake(listing);

    // ---- proof chain (soft: forces the affected scope to Partial) ----------
    const proofs = evaluateCapabilityProofs({
      capabilityProofIndex,
      capabilityIds,
      manifest,
      toolProfileHash,
      now,
      authorizedCanaryTargetHashes,
    });
    coverage = proofs.coverage;
    coverageProven = proofs.proven;
    for (const hash of proofs.governingAttestationHashes) governingAttestationHashes.add(hash);
    for (const code of [...new Set(proofs.reasons)]) {
      addWarning(code, 'capability_proof', 'capability_not_proven_live');
    }

    hit = session.boundary();
    if (hit) {
      addWarning(hit, 'run', 'boundary_before_auth');
      return finish({ stage: 'handshake', reason: hit });
    }

    // ---- credentials ------------------------------------------------------
    const auth = await session.dispatch('auth_status', {});
    if (auth.status !== 'ok' || !credentialIsUsable(auth.data)) {
      addWarning(CODES.AUTH, 'auth', 'internal_credential_unavailable');
      return finish({ stage: 'auth', reason: CODES.AUTH });
    }

    hit = session.boundary();
    if (hit) {
      addWarning(hit, 'run', 'boundary_before_roster');
      return finish({ stage: 'auth', reason: hit });
    }

    // ---- roster -----------------------------------------------------------
    const rosterResponse = await session.dispatch('list_workflows_complete', {
      locationId: expectedLocationId,
    });
    if (rosterResponse.status !== 'ok') {
      addWarning(CODES.ROSTER, 'workflow_roster', 'roster_read_failed');
      return finish({
        stage: 'roster',
        reason: CODES.ROSTER,
        workflowRoster: {
          complete: false,
          sealed: false,
          reportedTotal: null,
          terminalReason: null,
          workflowIds: [],
          incompleteReason: 'roster_read_failed',
        },
      });
    }
    assertBoundLocation(rosterResponse.data, expectedLocationId);
    session.recordRoutes(rosterResponse.data.sourceRoutes);
    const roster = reconcileRoster(rosterResponse.data, manifest);
    if (!roster.ok) {
      addWarning(CODES.ROSTER, 'workflow_roster', roster.reason);
      return finish({
        stage: 'roster',
        reason: CODES.ROSTER,
        workflowRoster: {
          complete: false,
          sealed: false,
          reportedTotal: Number.isInteger(rosterResponse.data.reportedTotal)
            ? rosterResponse.data.reportedTotal
            : null,
          // Same grammar on the failure path: an unsealed roster is exactly where a
          // transcript-bearing `terminalReason` would otherwise still reach the publisher.
          terminalReason: inVocabularyOrNull(
            isRosterTerminalReason,
            rosterResponse.data.terminalReason,
          ),
          workflowIds: roster.workflowIds,
          incompleteReason: roster.reason,
        },
      });
    }

    const sealedRoster = {
      complete: true,
      sealed: true,
      reportedTotal: rosterResponse.data.reportedTotal,
      terminalReason: roster.terminalReason,
      workflowIds: roster.workflowIds,
      incompleteReason: null,
    };

    // ---- per-workflow definition and runtime ------------------------------
    const workflows = [];
    for (const row of roster.rows) {
      const workflowId = row.workflowId;
      const applicable = workflowFilter === null || workflowFilter.has(workflowId);
      if (!applicable) {
        // R2-C2 — never read, therefore never proven. `complete: true` here asserted a
        // completeness this run does not have and published Full with zero limitations.
        workflows.push({
          workflowId,
          applicable: false,
          reviewed: false,
          complete: false,
          status: row.status,
          version: row.version,
          definition: null,
          runtime: null,
          configurationBinding: null,
          incompleteReason: 'workflow_not_reviewed_out_of_declared_scope',
        });
        continue;
      }

      hit = session.boundary();
      if (hit) {
        addWarning(hit, 'run', 'boundary_during_workflows');
        return finish({
          stage: 'workflows',
          reason: hit,
          workflowRoster: sealedRoster,
          workflows,
        });
      }

      const record = await collectWorkflow({
        session,
        workflowId,
        row,
        manifest,
        coverage,
        windowMs,
        // Sent OUTBOUND and echoed back under `filters.stepIds`, so a requested step id
        // carries the same id vocabulary as every other retained identifier.
        stepIds: Array.isArray(stepRequests[workflowId])
          ? stepRequests[workflowId].filter(isOpaqueId)
          : [],
      });
      if (record.definitionFailed) addWarning(CODES.WORKFLOW, workflowId, record.incompleteReason);
      else if (record.complete !== true) addWarning(CODES.RUNTIME, workflowId, record.incompleteReason);
      workflows.push(record.record);
    }

    hit = session.boundary();
    if (hit) {
      addWarning(hit, 'run', 'boundary_before_ai');
      return finish({
        stage: 'ai',
        reason: hit,
        workflowRoster: sealedRoster,
        workflows,
      });
    }

    // ---- AI configuration bundle ------------------------------------------
    const bundleArguments = { locationId: expectedLocationId };
    if (expectedCompanyId !== null) bundleArguments.companyId = expectedCompanyId;
    const aiResponse = await session.dispatch('get_ai_configuration_bundle', bundleArguments);
    let aiConfiguration;
    if (aiResponse.status !== 'ok') {
      addWarning(CODES.AI, 'ai_configuration', 'ai_bundle_read_failed');
      aiConfiguration = {
        components: Object.fromEntries(AI_SURFACES.map((surface) => [surface, emptyAiComponent(surface)])),
        complete: false,
      };
    } else {
      assertContractVersion(aiResponse.data, expectedContractVersion);
      assertBoundLocation(aiResponse.data, expectedLocationId);
      const reconciled = reconcileAiBundle(aiResponse.data, { manifest, coverage });
      for (const surface of AI_SURFACES) {
        const component = reconciled.components[surface];
        if (component.complete !== true) addWarning(CODES.AI, surface, component.reason);
      }
      for (const reason of reconciled.reasons) {
        if (!AI_SURFACES.some((surface) => reconciled.components[surface].reason === reason)) {
          addWarning(CODES.AI, 'ai_configuration', reason);
        }
      }
      aiConfiguration = { components: reconciled.components, complete: reconciled.complete };
      // Only routes for the three enumerated surfaces are ever retained.
      for (const surface of AI_SURFACES) {
        const declared = isPlainObject(aiResponse.data.components)
          ? aiResponse.data.components[surface]
          : null;
        if (isPlainObject(declared)) session.recordRoutes(declared.sourceRoutes);
      }
    }

    const workflowsComplete = workflows.length === sealedRoster.workflowIds.length
      && workflows.every((entry) => entry.complete === true);
    const complete = coverageProven
      && sealedRoster.complete === true
      && workflowsComplete
      && aiConfiguration.complete === true
      && warnings.length === 0;

    return finish({
      stage: 'complete',
      reason: null,
      workflowRoster: sealedRoster,
      workflows,
      aiConfiguration,
      complete,
    });
  }

  // -------------------------------------------------------------------------
  // One workflow: definition (export) + runtime window
  // -------------------------------------------------------------------------

  async function collectWorkflow({
    session,
    workflowId,
    row,
    manifest,
    coverage,
    windowMs,
    stepIds,
  }) {
    const base = {
      workflowId,
      applicable: true,
      reviewed: true,
      complete: false,
      status: row.status,
      version: row.version,
      definition: null,
      runtime: null,
      configurationBinding: null,
      incompleteReason: null,
    };

    const exported = await session.dispatch('export_workflow', {
      locationId: expectedLocationId,
      workflowId,
    });
    if (exported.status !== 'ok') {
      return {
        record: { ...base, incompleteReason: 'definition_read_failed' },
        complete: false,
        definitionFailed: true,
        incompleteReason: 'definition_read_failed',
      };
    }
    assertResponseLocation(exported.data, expectedLocationId);
    // I5 — silence is UNKNOWN. Definition evidence needs a POSITIVE binding, not the absence
    // of a contradiction.
    const definitionBinding = definitionLocationBinding(exported.data, workflowId, manifest);
    if (definitionBinding !== null) {
      return {
        record: { ...base, incompleteReason: definitionBinding },
        complete: false,
        definitionFailed: true,
        incompleteReason: definitionBinding,
      };
    }
    const exportTriple = {
      workflow: exported.data.workflow,
      triggers: exported.data.triggers,
      stickyNotes: exported.data.stickyNotes,
    };
    let exportedHash = null;
    try {
      exportedHash = sha256(exportTriple);
    } catch {
      exportedHash = null;
    }
    if (exportedHash === null) {
      return {
        record: { ...base, incompleteReason: 'definition_payload_invalid' },
        complete: false,
        definitionFailed: true,
        incompleteReason: 'definition_payload_invalid',
      };
    }

    const runtimeResponse = await session.dispatch('get_workflow_runtime_window', {
      locationId: expectedLocationId,
      workflowId,
      fromDate: windowMs.fromDate,
      toDate: windowMs.toDate,
      stepIds,
    });
    if (runtimeResponse.status !== 'ok') {
      return {
        record: { ...base, incompleteReason: 'runtime_read_failed' },
        complete: false,
        definitionFailed: false,
        incompleteReason: 'runtime_read_failed',
      };
    }
    const data = runtimeResponse.data;
    assertContractVersion(data, expectedContractVersion);
    assertBoundLocation(data, expectedLocationId);
    session.recordRoutes(data.sourceRoutes);

    if (data.workflowId !== workflowId) {
      return {
        record: { ...base, incompleteReason: 'runtime_workflow_mismatch' },
        complete: false,
        definitionFailed: false,
        incompleteReason: 'runtime_workflow_mismatch',
      };
    }

    const definitionBlock = data.workflowDefinition;
    const definitionIntegrity = definitionIsSound(definitionBlock, exportedHash);
    const definitionRoutes = projectRoutes(
      data.sourceRoutes,
      manifest,
      (route) => DEFINITION_CAPABILITIES.includes(route.capabilityId),
    );

    if (definitionIntegrity.reason !== null) {
      return {
        record: { ...base, incompleteReason: definitionIntegrity.reason },
        complete: false,
        definitionFailed: true,
        incompleteReason: definitionIntegrity.reason,
      };
    }

    const definition = {
      version: definitionBlock.version,
      definitionHash: definitionBlock.canonicalHash,
      hashAlgorithm: definitionBlock.hashAlgorithm,
      // BLOCKER E — `'exact'` when this adapter reproduced the server's declared digest;
      // `'scrub_explained'` when it provably could not because the payload was scrubbed after
      // the digest was taken, and the definition was instead verified against the independent
      // `export_workflow` read. Never absent, so the weaker verdict cannot pass as the stronger.
      hashVerification: definitionIntegrity.hashVerification,
      capturedAt: isoOrNullString(definitionBlock.capturedAt),
      // Two opaque ids and a type per trigger. See `projectTriggers` for why the stage a workflow
      // fires on is evidence rather than configuration, and for what is deliberately NOT kept.
      triggers: projectTriggers(definitionBlock.triggers),
      sourceRoutes: definitionRoutes,
    };

    const observedEvents = (Array.isArray(data.runtimeEvents) ? data.runtimeEvents : []).map(
      (event) => ({
        id: isOpaqueId(event?.id) ? event.id : null,
        timestamp: Number.isInteger(event?.timestamp) ? event.timestamp : null,
        timestampField: inVocabularyOrNull(isTimestampField, event?.timestampField),
        // PROJECTED, never copied: an execution-log row carries message bodies, contact emails
        // and whatever else the upstream chose to include. Each retained field additionally
        // has to be in its own vocabulary — an expected key is not a licence for free text.
        event: projectEventDetail(event?.event),
      }),
    );
    const historical = bindEventsToDefinition(definitionBlock.validity, observedEvents, {
      currentDefinitionHash: definitionBlock.canonicalHash,
      compositeBinding: data.configurationBinding,
      governingCapabilityProven: DEFINITION_CAPABILITIES.every(
        (capabilityId) => coverage?.[capabilityId]?.proven === true,
      ),
      // R6-M1: a `scrub_explained` definition may not support a claim that requires an exactly
      // verified one.
      definitionHashVerification: definitionIntegrity.hashVerification,
    });
    const configurationBinding = {
      currentDefinitionHash: definitionBlock.canonicalHash,
      ...historical.binding,
    };

    const reconciled = reconcileRuntime(data, {
      manifest,
      requestedWindow: windowMs,
      requestedStepIds: stepIds,
    });

    // Every field below is PROJECTED onto an explicit allow list. Nothing is copied from the
    // wire verbatim: the reconciliation above already ran against the untrusted body, and what
    // survives into the result is only what the audit itself needs.
    const runtimeRecord = {
      workflowId,
      boundLocationId: expectedLocationId,
      capabilityVersion: typeof data.capabilityVersion === 'string'
        && INTERNAL_DIGEST.test(data.capabilityVersion)
        ? data.capabilityVersion
        : null,
      capturedAt: isoOrNullString(data.capturedAt),
      requestedWindow: projectTyped(data.requestedWindow, REQUESTED_WINDOW_SPEC),
      appliedWindow: projectTyped(data.appliedWindow, APPLIED_WINDOW_SPEC),
      filters: projectRuntimeFilters(data.filters, { stepIds, contactId: null }, pseudonymize),
      events: historical.events,
      enrollments: projectEnrollments(data.enrollments, pseudonymize),
      enrollmentCursor: extractEnrollmentCursor(data.appliedQueries),
      enrollmentTotals: projectTyped(data.enrollmentTotals, ENROLLMENT_TOTAL_SPEC),
      perStepCounts: projectTypedList(data.perStepCounts, PER_STEP_COUNT_SPEC),
      stepRosters: projectStepRosters(data.stepRosters, pseudonymize),
      componentCompleteness: projectTyped(data.componentCompleteness, COMPLETENESS_SPEC),
      pagination: projectPagination(data.pagination),
      sourceRoutes: projectRoutes(data.sourceRoutes, manifest),
      complete: reconciled.ok,
    };

    return {
      record: {
        ...base,
        complete: reconciled.ok,
        definition,
        runtime: runtimeRecord,
        configurationBinding,
        incompleteReason: reconciled.ok ? null : reconciled.reason,
      },
      complete: reconciled.ok,
      definitionFailed: false,
      incompleteReason: reconciled.reason,
    };
  }

  // -------------------------------------------------------------------------
  // Bounded single-capability collection (the Task 4 convention)
  // -------------------------------------------------------------------------

  async function collect(request = {}) {
    if (!isPlainObject(request)) throw codedError(CODES.REQUEST, TypeError);
    const { capability, window, cursor = null, signal } = request;
    const { requestedWindow, manifest } = preflight(window);
    if (!isPlainObject(capability) || capability.capabilityId !== 'workflow_roster_list') {
      throw codedError(CODES.UNPROVEN);
    }
    const session = makeSession({ signal, manifest });
    const operationId = isNonEmptyString(capability.operationId)
      ? capability.operationId
      : 'internal_ghl.workflow_roster_list';

    const envelope = (reason, items, reportedCount) => incompleteCollection({
      source: SOURCE,
      operationId,
      boundLocationId: expectedLocationId,
      requestedWindow,
      appliedWindow: requestedWindow,
      capturedAt: capturedAt(runtime),
      items,
      cursor,
      nextCursor: null,
      reportedCount,
      reason,
      truncated: true,
    });

    const hit = session.boundary();
    if (hit) return envelope(hit, [], 0);

    let listing;
    try {
      listing = await session.listTools();
    } catch {
      throw codedError(CODES.HANDSHAKE);
    }
    const toolProfileHash = assertHandshake(listing);

    // M4 — the bounded entry point applies the SAME proof state as the composite. An unproven
    // capability may not return a terminal, complete collection just because it was requested
    // through the narrow door.
    const now = nowMs(runtime);
    const requested = evaluateCapabilityProofs({
      capabilityProofIndex,
      capabilityIds: [capability.capabilityId],
      manifest,
      toolProfileHash,
      now,
    });
    if (!requested.proven) {
      return envelope(requested.reasons[0] ?? CODES.UNPROVEN, [], 0);
    }

    const response = await session.dispatch('list_workflows_complete', {
      locationId: expectedLocationId,
    });
    if (response.status !== 'ok') return envelope(CODES.ROSTER, [], 0);
    assertBoundLocation(response.data, expectedLocationId);
    const roster = reconcileRoster(response.data, manifest);
    if (!roster.ok) {
      return envelope(
        CODES.ROSTER,
        roster.workflowIds.map((workflowId) => ({ workflowId })),
        Number.isInteger(response.data.reportedTotal) ? response.data.reportedTotal : 0,
      );
    }
    // C3 for the bounded door: whatever the response says it actually exercised must be proven
    // too, not merely the capability the caller named.
    session.recordRoutes(response.data.sourceRoutes);
    // The RAW ledger, not the projected routes: R2-M6 nulls an unsealed `capabilityId` in the
    // projection, and reading the projection here would quietly stop noticing that an
    // out-of-manifest route was exercised at all.
    const exercised = [...new Set(
      session.exercisedCapabilityIds.filter(
        (capabilityId) => capabilityId !== capability.capabilityId,
      ),
    )].sort();
    if (exercised.length > 0) {
      const exercisedProofs = evaluateCapabilityProofs({
        capabilityProofIndex,
        capabilityIds: exercised,
        manifest,
        toolProfileHash,
        now,
      });
      if (!exercisedProofs.proven) {
        return envelope(
          exercisedProofs.reasons[0] ?? CODES.UNPROVEN,
          roster.rows,
          Number.isInteger(response.data.reportedTotal) ? response.data.reportedTotal : 0,
        );
      }
    }
    return completeCollection({
      source: SOURCE,
      operationId,
      boundLocationId: expectedLocationId,
      requestedWindow,
      appliedWindow: requestedWindow,
      capturedAt: capturedAt(runtime),
      items: roster.rows,
      cursor,
      reportedCount: response.data.reportedTotal,
    });
  }

  return Object.freeze({
    source: SOURCE,
    collect,
    collectAuditEvidence,
  });
}

// ---------------------------------------------------------------------------
// Shared leaf helpers
// ---------------------------------------------------------------------------

/**
 * A credential is usable only when it is present AND will outlive the run's own lease window.
 * Nothing about the credential — path, reference, claim value — is ever returned or logged.
 */
function credentialIsUsable(data) {
  if (!isPlainObject(data)) return false;
  if (!isNonEmptyString(data.tokenFile)) return false;
  const jwt = data.jwtClaims;
  const tokenId = data.tokenIdClaims;
  if (!isPlainObject(jwt) || jwt.present !== true) return false;
  if (!isPlainObject(tokenId) || tokenId.present !== true) return false;
  const remaining = [jwt.secondsRemaining, tokenId.secondsRemaining];
  for (const seconds of remaining) {
    if (!Number.isFinite(seconds)) return false;
    if (Number(seconds) * 1000 < SHORT_LIVED_CREDENTIAL_MS) return false;
  }
  return true;
}

/**
 * POSITIVE location binding for the definition rail. `assertResponseLocation` alone passes
 * VACUOUSLY when an export body names no location at all, and silence is UNKNOWN, never assent.
 * Binding is therefore established only when ALL of the following hold:
 *   - the SEALED manifest declares how each definition capability binds a location, and the
 *     primary definition route binds it positionally as `/workflow/{locationId}/{workflowId}`;
 *   - the response positively identifies the workflow that was requested under that binding;
 *   - no location indicator anywhere in the body disagrees (checked separately, and it throws).
 * Without a sealed manifest there is no descriptor to bind against, so the answer is UNKNOWN.
 */
function definitionLocationBinding(exportData, workflowId, manifest) {
  if (!isPlainObject(exportData)) return 'definition_payload_invalid';
  if (manifest === null) return 'definition_location_unbound';
  for (const capabilityId of DEFINITION_CAPABILITIES) {
    const sealed = manifest.descriptors.get(capabilityId);
    if (!sealed) return 'definition_location_unbound';
    const spec = sealed.descriptor;
    if (spec.locationBinding !== 'path' && spec.locationBinding !== 'query') {
      return 'definition_location_unbound';
    }
    if (capabilityId === DEFINITION_PRIMARY_CAPABILITY) {
      if (spec.locationBinding !== 'path') return 'definition_location_unbound';
      if (!isPlainObject(spec.pathBindings)) return 'definition_location_unbound';
      if (spec.pathBindings.locationId !== 'locationId') return 'definition_location_unbound';
      if (spec.pathBindings.workflowId !== 'workflowId') return 'definition_location_unbound';
    }
  }
  const workflow = exportData.workflow;
  if (!isPlainObject(workflow)) return 'definition_payload_invalid';
  // The SAME id vocabulary the roster reader uses (`rosterRowId` / `unwrapRosterId`, a faithful
  // copy of the server's `idOf` / `unwrapId`). Reading `workflow._id ?? workflow.id` with no
  // `{$oid}` unwrap left this the last id reader off the server's vocabulary: on live data an
  // `{$oid}`-wrapped or numeric export id could never bind, and the binding failed closed for a
  // reason that has nothing to do with the location.
  const declaredId = rosterRowId(workflow);
  if (declaredId !== workflowId) return 'definition_identity_unbound';
  return null;
}

// BLOCKER E — the server's scrub sentinel. `core/errors.mjs:118-131` `scrub()` replaces a
// JWT-shaped run (`TOKENISH`), a `label:`/`label=`/`label/`-prefixed secret (`LABELED_SECRET`)
// and a `Bearer <token>` (`BEARER_SECRET`) with the literal `<redacted>`, and `scrubSecrets`
// (`:148-165`) additionally replaces the WHOLE subtree under any `SECRET_KEYS` key (`:108-115`)
// with the same literal — and scrubs object KEYS as well as values. Every one of those four
// paths leaves this exact substring behind, so its presence anywhere in the block is a positive
// mark that the bytes on the wire are not the bytes that were hashed.
const SCRUB_SENTINEL = '<redacted>';
function carriesScrubSentinel(value, seen = new WeakSet()) {
  if (typeof value === 'string') return value.includes(SCRUB_SENTINEL);
  if (!value || typeof value !== 'object' || seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.some((entry) => carriesScrubSentinel(entry, seen));
  return Object.entries(value).some(
    ([key, nested]) => key.includes(SCRUB_SENTINEL) || carriesScrubSentinel(nested, seen),
  );
}

/**
 * BLOCKER E — THE PRE-SCRUB / POST-SCRUB HASH, AND WHY IT RESOLVES THIS WAY.
 *
 * The server computes `canonicalHash` over the UNSCRUBBED triple
 * (`core/workflow-runtime-window.mjs:854`, `sha256Canonical({workflow, triggers, stickyNotes})`)
 * and then hands the whole result to `ok()` (`core/tools.mjs:1038`), which is
 * `scrubSecrets` (`core/errors.mjs:168`). The bytes this adapter receives are therefore
 * POST-scrub while the digest it is asked to verify is PRE-scrub. Any workflow carrying a
 * `Bearer`, a `token:`/`apiKey=`/`password:` value, a JWT-shaped string or a `SECRET_KEYS` key
 * hashes differently — and webhook and custom-code steps are exactly where those live.
 *
 * THE ADAPTER CANNOT REPRODUCE A PRE-SCRUB HASH FROM POST-SCRUB BYTES. `scrub` is lossy and
 * non-invertible by design, so no amount of recomputation recovers the original digest. There
 * are only three honest options and two of them are wrong: failing the workflow punishes it for
 * the server's own privacy control, and dropping the check entirely retires the one thing that
 * proves the runtime window described the definition that was exported.
 *
 * So the check is SPLIT. The digest equality is attempted first, exactly as before. If and only
 * if it fails, and the block positively carries the scrub sentinel, the mismatch is ATTRIBUTED
 * to scrubbing — and the definition is then verified the one way that still works on post-scrub
 * bytes: the runtime window's triple must hash EQUAL TO THE INDEPENDENTLY-READ `export_workflow`
 * triple. Both sides came through the same deterministic `scrubSecrets` over the same upstream
 * content (`core/tools.mjs:839-843` returns the same three keys through the same `ok()`), so
 * that cross-read equality is untouched by scrubbing while still catching a definition that
 * changed, was truncated, or belongs to another workflow. The verdict is REPORTED
 * (`hashVerification: 'scrub_explained'`) rather than swallowed, so a reader can tell it apart
 * from `'exact'`.
 *
 * RESIDUAL, stated: a workflow whose own content legitimately contains the literal
 * `<redacted>` could route a genuine single-read corruption down the scrub-explained branch —
 * but only if the OTHER, independent read corrupted identically, which the cross-check requires.
 *
 * Returns `{reason, hashVerification}`; `reason` is `null` when the definition is sound.
 */
function definitionIsSound(block, exportedHash) {
  const bad = (reason) => ({ reason, hashVerification: null });
  if (!isPlainObject(block)) return bad('definition_block_missing');
  if (!Number.isInteger(block.version)) return bad('definition_version_invalid');
  if (block.hashAlgorithm !== 'sha256') return bad('definition_hash_algorithm_invalid');
  if (typeof block.canonicalHash !== 'string' || !BARE_DIGEST.test(block.canonicalHash)) {
    return bad('definition_hash_invalid');
  }
  if (!isNonEmptyString(block.capturedAt)) return bad('definition_capture_time_invalid');
  const triple = {
    workflow: block.workflow,
    triggers: block.triggers,
    stickyNotes: block.stickyNotes,
  };
  let recomputed;
  try {
    recomputed = sha256(triple);
  } catch {
    return bad('definition_payload_invalid');
  }
  if (recomputed !== block.canonicalHash) {
    if (!carriesScrubSentinel(triple)) return bad('definition_hash_mismatch');
    // Scrub-explained: the declared digest is unverifiable, so the two independent READS must
    // agree with each other instead. This is strictly the same comparison the exact branch
    // makes below, moved onto the only two values that are both post-scrub.
    if (exportedHash !== recomputed) return bad('definition_export_mismatch');
    return { reason: null, hashVerification: 'scrub_explained' };
  }
  // The definition the runtime window hashed MUST be the definition that was exported.
  if (exportedHash !== block.canonicalHash) return bad('definition_export_mismatch');
  return { reason: null, hashVerification: 'exact' };
}
