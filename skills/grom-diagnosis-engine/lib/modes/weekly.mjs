import {
  mkdirSync,
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { Temporal } from '@js-temporal/polyfill';
import { sourceCollectionsFromScopes } from '../adapters/collection.mjs';
import { canonicalJson, sha256 } from '../canonical.mjs';

const INTERNAL_LIMITATIONS = Object.freeze([
  'INTERNAL_WORKFLOW_DEFINITION_MISSING',
  'INTERNAL_WORKFLOW_RUNTIME_MISSING',
]);
const FORBIDDEN_MOVEMENT = new Set(['IMPROVING', 'REGRESSED', 'RESOLVED']);

// ---------------------------------------------------------------------------
// Task 11 constants
// ---------------------------------------------------------------------------

const AUTH_REQUIRED = 'INTERNAL_AUDIT_AUTH_REQUIRED';
const SNAPSHOT_SKEW = 'PUBLIC_INTERNAL_SNAPSHOT_SKEW';

/** The exact ten machine gates of the brief's `complete_full` eligibility section, in order. */
const FULL_ELIGIBILITY_GATES = Object.freeze([
  'capability_coverage',
  'live_runtime_receipts',
  'workflow_roster_and_coverage',
  'ai_discovery_and_details',
  'reconciliation',
  'snapshot_skew',
  'read_only_trace',
  'claim_support',
  'privacy_scan',
  'verifier',
]);

/** `blocked`, `failed` and `quarantined` runs publish no findings and no solution packs. */
const NON_PUBLISHING_STATUSES = new Set(['blocked', 'failed', 'quarantined']);

/** The exact read-only audit registry, plus the listing call itself. */
const REGISTERED_AUDIT_TOOLS = new Set([
  'tools/list',
  'auth_status',
  'list_workflows_complete',
  'get_workflow',
  'export_workflow',
  'get_workflow_runtime_window',
  'get_ai_configuration_bundle',
]);

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Domains the PUBLIC rail owns. Internal evidence may never silently overwrite them. */
const PUBLIC_OWNED_KINDS = new Set(['contact', 'appointment', 'opportunity', 'message']);

/** Internal runtime-event keys that name a public-rail entity, and the kind each names. */
const EVENT_ENTITY_KEYS = Object.freeze([
  Object.freeze(['contactId', 'contact']),
  Object.freeze(['appointmentId', 'appointment']),
  Object.freeze(['opportunityId', 'opportunity']),
  Object.freeze(['messageId', 'message']),
]);

/** Public-owned outcome fields an internal runtime event may CLAIM but never decide. */
const EVENT_CLAIM_FIELDS = Object.freeze(['outcome', 'state', 'stage', 'direction', 'status']);

const DEFAULT_SNAPSHOT_SKEW_MS = 0;
const BROAD_REPORT_LANGUAGE = /(?:account[- ]wide|whole[- ]account|all systems passed|total (?:account )?impact|top leak across)/iu;

/**
 * Merge limitations that mean a rail did NOT independently pass. Any one of them blocks
 * `complete_full`: gate 1 covers public capability completeness, gate 5 covers reconciliation.
 * Finding C1: only `PUBLIC_EVIDENCE_RECONCILIATION_FAILED` used to fail anything, so absent,
 * malformed and incomplete public evidence published Full.
 */
const RAIL_BLOCKING_LIMITATIONS = Object.freeze([
  'PUBLIC_EVIDENCE_MISSING',
  'PUBLIC_EVIDENCE_MALFORMED',
  'PUBLIC_EVIDENCE_INCOMPLETE',
  'PUBLIC_EVIDENCE_RECONCILIATION_FAILED',
  'PUBLIC_INTERNAL_LOCATION_CONFLICT',
  'INTERNAL_EVIDENCE_MISSING',
  'INTERNAL_EVIDENCE_INCOMPLETE',
  SNAPSHOT_SKEW,
]);

/** Object keys whose VALUE is private by construction and may never reach a publication input. */
const PRIVATE_KEY_DENY = new Set([
  'transcript', 'transcripts', 'messagebody', 'messagetext', 'messagecontent',
  'rawrequest', 'authorization', 'cookie', 'bearertoken', 'accesstoken', 'refreshtoken',
  'apikey', 'password', 'secret', 'credential', 'credentialpath', 'credentialreference',
  'keyreference', 'tokenid', 'tokenfile', 'privatepath',
  'email', 'emailaddress', 'contactemail', 'phone', 'phonenumber', 'contactphone',
  'dateofbirth', 'dob', 'ssn',
]);

/** Values that are private however they are keyed. */
const PRIVATE_VALUE_PATTERNS = Object.freeze([
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/u,
  /\bBearer\s+[A-Za-z0-9._-]{8,}/u,
  /\bvault:\/\//u,
  /\b(?:GET|POST|PUT|PATCH|DELETE)\s+https?:\/\//u,
]);

/** Claim-support states that may never carry a published claim, at ANY scope. */
const INELIGIBLE_SUPPORT = new Set([
  'inferred_only', 'inferred-only', 'stale', 'ambiguous', 'incomplete', 'none', 'unsupported',
]);

/** The exact shape `evaluateFullEligibility` emits. Finding R3-M2: exact-field, like
 * `state.mjs` `assertExactFields` and the adapter's `RECEIPT_FIELDS`. An unknown key means the
 * object was not minted here, so its meaning is unknown and it fails closed. */
const DECISION_FIELDS = Object.freeze([
  'status',
  'eligible',
  'runId',
  'frozenInputsHash',
  'gates',
  'failedGates',
  'limitations',
  'publishesFindings',
  'publishesSolutionPacks',
]);
const GATE_FIELDS = Object.freeze(['id', 'passed']);

/**
 * Findings R3-C1 and R4-C2 — a response page DESCRIBES ITSELF, so every self-description it
 * carries is untrusted input.
 *
 * FOUR attempts at this class failed the same way. Each one RECOGNISED the dangerous keys:
 * first `reportedCount`/`collectedCount`, then `nextCursor`, then a row-count noun list plus a
 * continuation-prefix list. A list of dangerous names is still a list, and round 4 walked
 * straight past it with `pagination`, `endCursor`, `after`, `lastEvaluatedKey`, `offset`,
 * `pageTotal`, `hits` and `numFound`.
 *
 * THE DEFAULT IS NOW INVERTED. A page, an envelope or a roster may carry ONLY the keys named
 * below, and each name declares what the value MEANS and what it is therefore allowed to be.
 * Any other own key is UNKNOWN — not ignored — and fails closed. A producer that adds a field
 * cannot silently widen the hole; the run degrades until someone teaches the auditor what the
 * new field means, which is the correct direction to fail.
 *
 * The three allow-lists are not guesses. They are exactly the records `lib/adapters/collection.mjs`
 * `completeCollection`/`incompleteCollection` and the internal adapter's `workflowRoster` emit —
 * the two producers whose output actually reaches this code.
 *
 * Meanings:
 * - `row_count`  — a stated number of SERVED ROWS. Must be an integer equal to the recount.
 * - `terminal_true` / `terminal_false` — a flag whose only non-contradictory value is that exact
 *   boolean, so `complete: 1` and `truncated: 1` are contradictions, not absences.
 * - `empty`      — a continuation or failure signal. Must be genuinely empty.
 * - `scalar`     — carries no completeness meaning, and may not HIDE structure: a record or an
 *   array under a scalar key is unrecognised content and fails closed.
 * - `rows`       — the served rows themselves; recounted by the caller, never a declaration.
 * - a nested spec object — RECURSE into the nested record with that spec. The round-3 classifier
 *   `continue`d on nested records, so `page.pagination = {hasMore, nextCursor}` was never seen.
 */
const WINDOW_SPEC = Object.freeze({ from: 'scalar', to: 'scalar' });

/** `lib/adapters/collection.mjs` `page`. */
const PAGE_SPEC = Object.freeze({
  // Where THIS page STARTED. It is a position, not a claim that more data exists, so it is the
  // one cursor-shaped key that may legitimately be non-empty; `nextCursor` is the claim.
  cursor: 'scalar',
  nextCursor: 'empty',
  reportedCount: 'row_count',
  collectedCount: 'row_count',
  complete: 'terminal_true',
  truncated: 'terminal_false',
  incompleteReason: 'empty',
});

/**
 * `lib/adapters/collection.mjs` envelope, minus `page`, which is inspected against PAGE_SPEC.
 *
 * Finding R6-C1: this list was written by READING `completeCollection`'s object literal, and
 * that literal is not its output. `authorizeTerminalCollection` (`collection.mjs:110-114`) adds
 * `privateSourceEnvelope` and `privateSourceInventory` to EVERY authorized collection, so the
 * real producer emitted two keys the allow-list called UNKNOWN and every honest run failed
 * closed with `PUBLIC_EVIDENCE_MALFORMED`. The inversion is right; deriving the allow-list from
 * source-as-read instead of from output-as-produced was not.
 *
 * `tests/internal-adapter.test.mjs` now DIFFS these specs against a genuine `completeCollection`,
 * a genuine `incompleteCollection` and a genuine sealed roster, so the specs can never again
 * drift from the producers. Add a key to a producer and that test fails before any run does.
 */
const ENVELOPE_SPEC = Object.freeze({
  source: 'scalar',
  operationId: 'scalar',
  boundLocationId: 'scalar',
  requestedWindow: WINDOW_SPEC,
  appliedWindow: WINDOW_SPEC,
  capturedAt: 'scalar',
  items: 'rows',
  incompleteReason: 'empty',
  // The Task-4 private-source authorization. Neither key states a row count or a continuation,
  // so neither may relax terminality; both are shape-checked so they cannot smuggle structure
  // in past a `scalar` meaning.
  privateSourceEnvelope: 'private_source',
  privateSourceInventory: 'private_inventory',
});

/** The internal adapter's `workflowRoster`. Finding R3-I3 defends it at this trust boundary. */
const ROSTER_SPEC = Object.freeze({
  complete: 'terminal_true',
  sealed: 'terminal_true',
  reportedTotal: 'row_count',
  terminalReason: 'scalar',
  workflowIds: 'rows',
  incompleteReason: 'empty',
});

/**
 * Finding R6-C1 — the specs are EXPORTED so a test can diff them against the real producers'
 * real output instead of against a hand-built stand-in. Read-only: the three records are frozen
 * and nothing in this module reads them back through this export.
 */
export const SELF_DESCRIPTION_SPECS = Object.freeze({
  page: PAGE_SPEC,
  envelope: ENVELOPE_SPEC,
  window: WINDOW_SPEC,
  roster: ROSTER_SPEC,
});

/** The five audit tools that actually FETCH evidence. `tools/list` and `auth_status` do not. */
const EVIDENCE_TOOLS = new Set([
  'list_workflows_complete',
  'get_workflow',
  'export_workflow',
  'get_workflow_runtime_window',
  'get_ai_configuration_bundle',
]);

/** A continuation signal only fails to contradict terminality when it is genuinely EMPTY. */
function isEmptySignal(value) {
  if (value === null || value === undefined || value === false || value === 0 || value === '') {
    return true;
  }
  if (Array.isArray(value)) return value.length === 0;
  if (isRecord(value)) return Object.keys(value).length === 0;
  return false;
}

/**
 * Is this value a MEANINGFUL scalar — something an auditor could actually read as evidence?
 *
 * `0` and `false` ARE meaningful: a count of zero and a flag that is off are real observations.
 * Empty, whitespace-only and absent are not, at ANY depth.
 */
function isMeaningfulScalar(value) {
  if (typeof value === 'string') return value.trim().length > 0;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'boolean' || typeof value === 'bigint') return true;
  return false;
}

/**
 * Does this value contain at least one meaningful scalar ANYWHERE inside it?
 *
 * Finding R6-C2, the SIXTH reopening of the padding class. Every previous attempt tested one
 * level: first "the slot is an object", then "the slot is a non-empty object". Padding simply
 * moved one level down, so `{x: ' '}`, `{x: {y: null}}` and `{x: [null]}` were all SUBSTANTIVE
 * rows and a response that lost three of ten rows published Full with zero limitations.
 *
 * The predicate is now defined on CONTENT rather than on shape, and it recurses, so there is no
 * "one level down" left to move to: a row counts only if some leaf of it says something.
 */
function containsMeaningfulScalar(value, seen = new WeakSet()) {
  if (isMeaningfulScalar(value)) return true;
  if (!value || typeof value !== 'object') return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) {
    return value.some((entry) => containsMeaningfulScalar(entry, seen));
  }
  return Object.values(value).some((entry) => containsMeaningfulScalar(entry, seen));
}

/**
 * A row must be SUBSTANTIVE, not merely an object. Finding R4-C2: `isRecord` accepted `{}`, so
 * the padding attack that round 3 closed for `null` slots simply switched to empty objects and
 * `items = [{}]` with `reportedCount = collectedCount = 1` reconciled perfectly. Finding R6-C2:
 * "some value is not an empty signal" was still only one level deep — see above.
 */
function isSubstantiveRow(value) {
  if (!isRecord(value) || Array.isArray(value)) return false;
  return containsMeaningfulScalar(value);
}

/** The Task-4 private-source envelope `collection.mjs:93-97` attaches to every authorization. */
function isPrivateSourceEnvelope(value) {
  return isRecord(value)
    && !Array.isArray(value)
    && canonicalJson(Object.keys(value).sort()) === canonicalJson(['kind', 'payload', 'sourceId'])
    && typeof value.sourceId === 'string' && value.sourceId.length > 0
    && typeof value.kind === 'string' && value.kind.length > 0;
}

/** The Task-4 private-source inventory `collection.mjs:105-109` attaches alongside it. */
function isPrivateSourceInventory(value) {
  return Array.isArray(value) && value.every((entry) => (
    isRecord(entry)
    && !Array.isArray(entry)
    && canonicalJson(Object.keys(entry).sort())
      === canonicalJson(['kind', 'sourceHash', 'sourceId'])
    && ['sourceId', 'kind', 'sourceHash'].every(
      (key) => typeof entry[key] === 'string' && entry[key].length > 0,
    )
  ));
}

/**
 * Reads EVERY own key of a self-describing record against an ALLOW-LIST of keys the auditor
 * understands, and against the rows the record actually served.
 *
 * Returns `{declarations, contradicted, unreconciled, unknown}`:
 * - `declarations` — how many row-count fields the record actually stated. Zero means the
 *   record declared nothing at all, which is UNKNOWN and never assent (finding R2-C3).
 * - `contradicted` — the record contradicts its own terminality.
 * - `unreconciled` — a stated count that is not an integer, or that disagrees with the recount.
 * - `unknown` — the record carries at least one key, or one shape, this auditor has no meaning
 *   for. Finding R4-C2: this is the inverted default, and it fails closed.
 */
function inspectSelfDescription(record, servedRows, spec) {
  const state = { declarations: 0, contradicted: false, unreconciled: false, unknown: false };
  if (!isRecord(record) || Array.isArray(record)) {
    return { declarations: 0, contradicted: true, unreconciled: true, unknown: true };
  }
  for (const [key, value] of Object.entries(record)) {
    if (!Object.hasOwn(spec, key)) {
      // The whole point of the inversion: an unrecognised key is not ignored.
      state.unknown = true;
      continue;
    }
    const meaning = spec[key];
    if (isRecord(meaning)) {
      if (!isRecord(value) || Array.isArray(value)) {
        state.unknown = true;
        continue;
      }
      const nested = inspectSelfDescription(value, servedRows, meaning);
      state.declarations += nested.declarations;
      state.contradicted = state.contradicted || nested.contradicted;
      state.unreconciled = state.unreconciled || nested.unreconciled;
      state.unknown = state.unknown || nested.unknown;
      continue;
    }
    if (meaning === 'row_count') {
      state.declarations += 1;
      if (!Number.isInteger(value) || value !== servedRows) state.unreconciled = true;
    } else if (meaning === 'terminal_true') {
      if (value !== true) state.contradicted = true;
    } else if (meaning === 'terminal_false') {
      if (value !== false) state.contradicted = true;
    } else if (meaning === 'empty') {
      if (!isEmptySignal(value)) state.contradicted = true;
    } else if (meaning === 'rows') {
      if (!Array.isArray(value)) state.unknown = true;
    } else if (meaning === 'private_source') {
      // Finding R6-C1. The authorization record states no count and no continuation, so it can
      // never relax terminality — but it is still checked to its exact producer shape, because
      // an arbitrary record under a known key is exactly the hole `scalar` refuses to leave.
      if (!isPrivateSourceEnvelope(value)) state.unknown = true;
    } else if (meaning === 'private_inventory') {
      if (!isPrivateSourceInventory(value)) state.unknown = true;
    } else if (meaning === 'scalar') {
      // A key with no completeness meaning still may not smuggle structure underneath it.
      if (value !== null && typeof value === 'object') state.unknown = true;
    } else {
      state.unknown = true;
    }
  }
  return state;
}

function codedError(code, ErrorType = Error) {
  return Object.assign(new ErrorType(code), { code });
}

function deepFreeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function iso(value, code = 'AUDIT_COMMAND_INVALID_TIME') {
  try {
    return Temporal.Instant.from(value).toString({ smallestUnit: 'millisecond' });
  } catch {
    throw codedError(code, TypeError);
  }
}

function daysBetween(from, to) {
  const milliseconds = Temporal.Instant.from(to).epochMilliseconds
    - Temporal.Instant.from(from).epochMilliseconds;
  return Math.max(0, Math.ceil(milliseconds / 86_400_000));
}

function subtractHours(value, hours) {
  return Temporal.Instant.from(value).subtract({ hours }).toString({
    smallestUnit: 'millisecond',
  });
}

export function planWeeklyCollection({
  cutoff,
  timezone,
  salesCycleDays,
  providerAvailableFrom,
  priorWatermark,
  lateArrivalHours = 72,
} = {}) {
  const normalizedCutoff = iso(cutoff);
  try {
    Temporal.Now.zonedDateTimeISO(timezone);
  } catch {
    throw codedError('AUDIT_COMMAND_INVALID_TIMEZONE', TypeError);
  }
  if (priorWatermark !== undefined) {
    const overlapHours = Math.max(72, Number.isFinite(lateArrivalHours) ? lateArrivalHours : 72);
    return deepFreeze({
      mode: 'later',
      cutoff: normalizedCutoff,
      timezone,
      overlapHours,
      priorWatermark: iso(priorWatermark),
      collectionStart: subtractHours(priorWatermark, overlapHours),
      requestedHistoryDays: null,
      appliedHistoryDays: null,
      limitations: [],
    });
  }
  const cycleDays = Number.isFinite(salesCycleDays) && salesCycleDays > 0
    ? Math.ceil(salesCycleDays) * 2
    : 0;
  const requestedHistoryDays = Math.max(90, cycleDays);
  const requestedFrom = Temporal.Instant.from(normalizedCutoff)
    .subtract({ hours: requestedHistoryDays * 24 })
    .toString({ smallestUnit: 'millisecond' });
  const availableFrom = providerAvailableFrom === undefined
    ? requestedFrom
    : iso(providerAvailableFrom);
  const collectionStart = Temporal.Instant.compare(
    Temporal.Instant.from(availableFrom),
    Temporal.Instant.from(requestedFrom),
  ) > 0 ? availableFrom : requestedFrom;
  const appliedHistoryDays = daysBetween(collectionStart, normalizedCutoff);
  const limitations = appliedHistoryDays < requestedHistoryDays
    ? ['PROVIDER_HISTORY_SHORTER_THAN_REQUESTED']
    : [];
  return deepFreeze({
    mode: 'first',
    cutoff: normalizedCutoff,
    timezone,
    requestedHistoryDays,
    appliedHistoryDays,
    requestedFrom,
    providerAvailableFrom: availableFrom,
    collectionStart,
    limitations,
  });
}

/**
 * The ONE closed account-local week whose conversations this audit is judging.
 *
 * Public collection deliberately reaches much farther back so lagged commercial outcomes can
 * mature. Conversation copy is different evidence: mixing ninety days of older replies into this
 * week's sample can hide a new failure, and calling that sample "the week" is simply false. Keep
 * this window separate from the public/runtime collection horizon.
 */
export function currentClosedWeekWindow({ cutoff, timezone } = {}) {
  let localCutoff;
  try {
    localCutoff = Temporal.Instant.from(cutoff).toZonedDateTimeISO(timezone);
  } catch {
    throw codedError('AUDIT_COMMAND_INVALID_TIME', TypeError);
  }
  const end = localCutoff
    .subtract({ days: localCutoff.dayOfWeek - 1 })
    .startOfDay();
  const start = end.subtract({ weeks: 1 });
  return deepFreeze({
    from: start.toInstant().toString({ smallestUnit: 'millisecond' }),
    to: end.toInstant().toString({ smallestUnit: 'millisecond' }),
  });
}

function sanitizeFinding(finding) {
  if (!finding || typeof finding !== 'object' || Array.isArray(finding)) return finding;
  const next = structuredClone(finding);
  if (next.scope === 'account_wide') next.scope = 'public_comparable_subset';
  if (next.impact !== undefined) next.impact = null;
  if (next.totalImpact !== undefined) next.totalImpact = null;
  if (next.verdict === 'PASS') next.verdict = 'UNKNOWN';
  return next;
}

function isUnmeasuredValue(value) {
  if (value === null || value === 'UNMEASURED' || value === 'UNKNOWN') return true;
  if (Array.isArray(value)) return value.length === 0;
  if (!value || typeof value !== 'object') return false;
  const state = value.kind ?? value.state;
  return ['UNKNOWN', 'UNMEASURED', 'NOT_AVAILABLE'].includes(state)
    && Object.entries(value).every(([key, child]) => (
      ['kind', 'state', 'reasonCode', 'limitationCode'].includes(key)
      || child === null
      || child === 'UNKNOWN'
      || child === 'UNMEASURED'
    ));
}

function assertNoPublicOnlyOverclaim(
  value,
  path = [],
  seen = new WeakSet(),
  inheritedScope,
) {
  if (value === null || typeof value !== 'object') return;
  if (seen.has(value)) throw codedError('AUDIT_INTEGRITY_FAILURE_PUBLIC_SCOPE');
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((child, index) => assertNoPublicOnlyOverclaim(
      child,
      [...path, String(index)],
      seen,
      inheritedScope,
    ));
  } else {
    const localScope = typeof value.scope === 'string'
      ? value.scope
      : typeof value.coverageScope === 'string'
        ? value.coverageScope
        : inheritedScope;
    const subsetScoped = localScope === 'public_comparable_subset';
    for (const [key, child] of Object.entries(value)) {
      const normalized = key.toLowerCase().replaceAll(/[^a-z]/gu, '');
      if (
        ['scope', 'coveragescope'].includes(normalized)
        && typeof child === 'string'
        && /account.?wide|whole.?account|complete.?full/iu.test(child)
      ) throw codedError('AUDIT_INTEGRITY_FAILURE_PUBLIC_SCOPE');
      if (
        (normalized === 'verdict' || path.includes('verdicts'))
        && child === 'PASS'
        && !subsetScoped
      ) throw codedError('AUDIT_INTEGRITY_FAILURE_PUBLIC_SCOPE');
      if (
        /(?:total.*impact|account.*impact|revenuepromise|totalrevenue)/u.test(normalized)
        && !isUnmeasuredValue(child)
      ) throw codedError('AUDIT_INTEGRITY_FAILURE_PUBLIC_SCOPE');
      if (
        /(?:impact|commercialvalue)/u.test(normalized)
        && !subsetScoped
        && !(child && typeof child === 'object' && (
          child.scope === 'public_comparable_subset'
          || child.coverageScope === 'public_comparable_subset'
        ))
        && !isUnmeasuredValue(child)
      ) throw codedError('AUDIT_INTEGRITY_FAILURE_PUBLIC_SCOPE');
      assertNoPublicOnlyOverclaim(child, [...path, key], seen, localScope);
    }
  }
  seen.delete(value);
}

/**
 * Finding I8. The Full path used to SKIP `sanitizeFinding`, `assertNoPublicOnlyOverclaim` and the
 * broad-language check outright rather than substituting Full-scope equivalents, so a hand-built
 * decision published a transcript canary and a raw contact email. These three assertions are the
 * substitutes: private content, ineligible claim support and unmeasured-impact overclaim are all
 * refused at Full scope too — only the public-only SCOPE clamp is lifted.
 */
function assertNoPrivateContent(value, seen = new WeakSet()) {
  if (typeof value === 'string') {
    for (const pattern of PRIVATE_VALUE_PATTERNS) {
      if (pattern.test(value)) throw codedError('AUDIT_INTEGRITY_FAILURE_PRIVATE_CONTENT');
    }
    return;
  }
  if (value === null || typeof value !== 'object') return;
  if (seen.has(value)) throw codedError('AUDIT_INTEGRITY_FAILURE_PRIVATE_CONTENT');
  seen.add(value);
  if (Array.isArray(value)) {
    for (const child of value) assertNoPrivateContent(child, seen);
  } else {
    for (const [key, child] of Object.entries(value)) {
      const normalized = key.toLowerCase().replaceAll(/[^a-z]/gu, '');
      if (PRIVATE_KEY_DENY.has(normalized)) {
        throw codedError('AUDIT_INTEGRITY_FAILURE_PRIVATE_CONTENT');
      }
      assertNoPrivateContent(child, seen);
    }
  }
  seen.delete(value);
}

/** The Full-scope substitute for `assertNoPublicOnlyOverclaim`. */
function assertFullScopeClaimsSupported(value, seen = new WeakSet()) {
  if (value === null || typeof value !== 'object') return;
  if (seen.has(value)) throw codedError('AUDIT_INTEGRITY_FAILURE_FULL_SCOPE');
  seen.add(value);
  if (Array.isArray(value)) {
    for (const child of value) assertFullScopeClaimsSupported(child, seen);
  } else {
    for (const [key, child] of Object.entries(value)) {
      const normalized = key.toLowerCase().replaceAll(/[^a-z]/gu, '');
      if (
        ['support', 'claimsupport', 'evidencesupport'].includes(normalized)
        && typeof child === 'string'
        && INELIGIBLE_SUPPORT.has(child.toLowerCase())
      ) throw codedError('AUDIT_INTEGRITY_FAILURE_FULL_SCOPE');
      assertFullScopeClaimsSupported(child, seen);
    }
  }
  seen.delete(value);
}

/**
 * A structural, offline privacy scan of a publication input. Exported so the kernel can feed
 * gate 9 a REAL result instead of an assumption.
 */
export function scanPublicationPrivacy(value) {
  try {
    assertNoPrivateContent(value);
    return { passed: true, code: null };
  } catch (error) {
    return {
      passed: false,
      code: typeof error?.code === 'string' ? error.code : 'PUBLICATION_NOT_SANITIZED',
    };
  }
}

/**
 * Controller decision D2. `fullEligibility` is OPTIONAL: absent, `undefined` or `null` means
 * the approved Task 10 behaviour, byte for byte. Only a decision that survives full structural
 * validation here can lift the public-only clamp; anything else falls back to the clamp, so a
 * forged or truncated decision can never reach `complete_full`.
 */
function ownValue(container, key) {
  // Finding I3: `typeof x.y` reads INHERITED properties, so `Object.prototype.passed = true`
  // satisfied every `typeof gate.passed === 'boolean'` check and opened the Full clamp.
  return Object.hasOwn(container, key) ? container[key] : undefined;
}

/** Finding R3-M2. Own keys only, exact set, no more and no fewer. */
function hasExactFields(value, fields) {
  const keys = Object.keys(value);
  return keys.length === fields.length && fields.every((field) => Object.hasOwn(value, field));
}

/**
 * Three outcomes, deliberately distinct (finding R2-I4):
 *
 * - `{ decision }`      — a decision this module could have produced, for this run.
 * - `{ reason: 'run' }` — well-formed, but not bound to the run it is being applied to: minted
 *                         for a DIFFERENT run, consumed without its run, or (finding R2-M1)
 *                         eligible while bound to NO run. The clamp stands; this is the approved
 *                         Task 10 refusal and it publishes clamped, never Full.
 * - `{ reason: 'structure' }` — present but unvalidatable. The caller cannot know what it
 *                         means, so it must FAIL CLOSED and never reach a publishing path.
 * - `{ reason: 'absent' }` — no decision at all: byte-identical Task 10 behaviour.
 */
function validateFullEligibilityDecision(value, expectedRun = null) {
  const invalid = { decision: null, reason: 'structure' };
  if (value === undefined || value === null) return { decision: null, reason: 'absent' };
  if (typeof value !== 'object' || Array.isArray(value)) return invalid;
  // A null-prototype object is not a decision this module produced.
  if (Object.getPrototypeOf(value) !== Object.prototype) return invalid;
  const status = ownValue(value, 'status');
  const eligible = ownValue(value, 'eligible');
  if (typeof status !== 'string' || typeof eligible !== 'boolean') return invalid;
  // Finding R3-M2: exact-field, exactly as `state.mjs` `assertExactFields` and the adapter's
  // `RECEIPT_FIELDS`. A decision carrying an unknown key — or missing one this module always
  // emits — is not a decision this module produced, so its meaning is unknown.
  if (!hasExactFields(value, DECISION_FIELDS)) return invalid;
  const gates = ownValue(value, 'gates');
  if (!Array.isArray(gates) || gates.length !== FULL_ELIGIBILITY_GATES.length) return invalid;
  const failedFromGates = [];
  for (const [index, gate] of gates.entries()) {
    if (!gate || typeof gate !== 'object' || Array.isArray(gate)) return invalid;
    if (Object.getPrototypeOf(gate) !== Object.prototype) return invalid;
    if (!hasExactFields(gate, GATE_FIELDS)) return invalid;
    if (ownValue(gate, 'id') !== FULL_ELIGIBILITY_GATES[index]) return invalid;
    const passed = ownValue(gate, 'passed');
    if (typeof passed !== 'boolean') return invalid;
    if (!passed) failedFromGates.push(gate.id);
  }
  const failedGates = ownValue(value, 'failedGates');
  if (!Array.isArray(failedGates)) return invalid;
  if (failedGates.some((id) => typeof id !== 'string')) return invalid;
  if (
    canonicalJson([...failedGates].sort())
    !== canonicalJson([...failedFromGates].sort())
  ) return invalid;
  const allPassed = failedFromGates.length === 0;
  if (eligible !== allPassed) return invalid;
  if (eligible !== (status === 'complete_full')) return invalid;
  // A non-publishing status must be internally consistent too: it can only be reached with at
  // least one failed gate (finding R2-I4 — identity/location mismatch used to quarantine while
  // all ten gates passed, producing a decision this validator then rejected outright).
  if (NON_PUBLISHING_STATUSES.has(status) && failedFromGates.length === 0) return invalid;
  // Finding I3, second half: nothing bound the decision to the run it describes. When the
  // caller states which run it expects, the decision must name that run and those inputs.
  const boundRunId = ownValue(value, 'runId');
  const boundInputsHash = ownValue(value, 'frozenInputsHash');
  const namesRun = typeof boundRunId === 'string' && boundRunId.length > 0;
  const namesInputs = typeof boundInputsHash === 'string' && boundInputsHash.length > 0;
  if (isRecord(expectedRun)) {
    for (const [key, bound] of [['runId', boundRunId], ['frozenInputsHash', boundInputsHash]]) {
      const wanted = expectedRun[key];
      if (typeof wanted !== 'string' || wanted.length === 0) return { decision: null, reason: 'run' };
      if (bound !== wanted) return { decision: null, reason: 'run' };
    }
  } else if (namesRun || namesInputs) {
    // Finding R2-M1, first half: a decision that NAMES a run may only ever be consumed together
    // with that run. Omitting `expectedRun` can no longer disable the binding for a bound
    // decision.
    return { decision: null, reason: 'run' };
  }
  // Finding R2-M1, residual half: a WHOLLY UNBOUND decision (`runId` and `frozenInputsHash` both
  // absent, null or empty) names no run at all, so no caller can ever state the run it belongs
  // to and no `expectedRun` can ever confirm it. It may still SUPPRESS publication — a decision
  // that refuses to publish is never the unsafe direction — but it can never LIFT the
  // public-only clamp. Together with the branch above, `complete_full` is now reachable only
  // when the decision NAMES a run and the caller INDEPENDENTLY states that same run and the
  // same frozen inputs; there is no remaining input that lifts the clamp unbound.
  if (eligible && !(namesRun && namesInputs)) return { decision: null, reason: 'run' };
  return { decision: { status, eligible }, reason: null };
}

export function enforcePublicOnlyPublication(
  input = {},
  { firstBaseline = false, fullEligibility = null, expectedRun = null } = {},
) {
  const validated = validateFullEligibilityDecision(fullEligibility, expectedRun);
  // Finding R2-I4: a decision that is PRESENT but unvalidatable used to be silently downgraded
  // to `null`, which fell back to the clamp and PUBLISHED. Unvalidatable now fails closed.
  if (validated.reason === 'structure') {
    throw codedError('AUDIT_INTEGRITY_FAILURE_FULL_ELIGIBILITY');
  }
  const decision = validated.decision;
  const publishFull = decision !== null && decision.status === 'complete_full';
  const nonPublishing = decision !== null && NON_PUBLISHING_STATUSES.has(decision.status);
  if (input?.payloadArtifacts && input?.projections && input?.manifestInput) {
    // A trusted publication payload is never emitted for a non-publishing run.
    if (nonPublishing) throw codedError('AUDIT_INTEGRITY_FAILURE_PUBLIC_SCOPE');
    const expectedStatus = publishFull ? 'complete_full' : 'complete_partial';
    const coverage = input.payloadArtifacts['coverage.json'];
    const machine = input.payloadArtifacts['metrics-and-findings.json'];
    const limitations = Array.isArray(coverage?.limitations)
      ? new Set(coverage.limitations)
      : new Set();
    if (
      input.manifestInput.status !== expectedStatus
      || coverage?.state !== expectedStatus
      || machine?.sealedInputs?.run?.status !== expectedStatus
      || !publishFull && !limitations.has('INTERNAL_WORKFLOW_DEFINITION_MISSING')
      || !publishFull && !limitations.has('INTERNAL_WORKFLOW_RUNTIME_MISSING')
    ) throw codedError('AUDIT_INTEGRITY_FAILURE_PUBLIC_SCOPE');
    if (publishFull) {
      // Finding I8: Full SUBSTITUTES equivalents, it never skips the checks.
      for (const artifact of Object.values(input.payloadArtifacts)) {
        assertNoPrivateContent(artifact);
        assertFullScopeClaimsSupported(artifact);
      }
      assertNoPrivateContent(input.projections);
      assertFullScopeClaimsSupported(input.projections);
    } else {
      for (const artifact of Object.values(input.payloadArtifacts)) {
        if (artifact && typeof artifact === 'object') {
          assertNoPublicOnlyOverclaim(artifact);
        }
      }
      assertNoPublicOnlyOverclaim(input.projections);
    }
    if (
      typeof input.payloadArtifacts['REPORT.md'] !== 'string'
      || !publishFull && BROAD_REPORT_LANGUAGE.test(input.payloadArtifacts['REPORT.md'])
    ) throw codedError('AUDIT_INTEGRITY_FAILURE_PUBLIC_SCOPE');
    const serialized = canonicalJson(input.payloadArtifacts);
    if (
      firstBaseline
      && [...FORBIDDEN_MOVEMENT].some((label) => serialized.includes(`"${label}"`))
    ) throw codedError('AUDIT_INTEGRITY_FAILURE_FIRST_BASELINE_MOVEMENT');
    return deepFreeze({ ...structuredClone(input), status: expectedStatus });
  }
  const coverage = input.coverage && typeof input.coverage === 'object'
    ? structuredClone(input.coverage)
    : {};
  if (!publishFull) {
    coverage.state = 'complete_partial';
    coverage.scope = 'public_comparable_subset';
    coverage.limitations = [...new Set([
      ...(Array.isArray(coverage.limitations) ? coverage.limitations : []),
      ...INTERNAL_LIMITATIONS,
    ])].sort();
  }
  const diff = input.diff && typeof input.diff === 'object'
    ? structuredClone(input.diff)
    : { state: 'FIRST_BASELINE', transitions: [] };
  if (Array.isArray(diff.transitions) && firstBaseline) {
    diff.transitions = diff.transitions.filter((transition) => (
      !FORBIDDEN_MOVEMENT.has(transition?.state ?? transition)
    ));
  }
  if (firstBaseline && FORBIDDEN_MOVEMENT.has(diff.state)) diff.state = 'NOT_COMPARABLE';
  let findings = [];
  if (!nonPublishing && Array.isArray(input.findings)) {
    if (publishFull) {
      // Finding I8: the Full-scope substitutes for `sanitizeFinding`.
      assertNoPrivateContent(input.findings);
      assertFullScopeClaimsSupported(input.findings);
      assertNoPrivateContent(coverage);
      assertNoPrivateContent(diff);
      if (Object.hasOwn(input, 'solutionPacks')) {
        assertNoPrivateContent(input.solutionPacks);
        assertFullScopeClaimsSupported(input.solutionPacks);
      }
      findings = structuredClone(input.findings);
    } else {
      findings = input.findings.map(sanitizeFinding);
    }
  }
  const output = {
    ...structuredClone(input),
    status: publishFull ? 'complete_full' : nonPublishing ? decision.status : 'complete_partial',
    coverage,
    diff,
    findings,
    latestFull: input.latestFull ?? null,
  };
  // `solutionPacks` may only appear when the input carried it, so the no-decision byte-lock is
  // untouched by this branch.
  if (nonPublishing && Object.hasOwn(input, 'solutionPacks')) output.solutionPacks = [];
  return deepFreeze(output);
}

function safeFixturePath(root, candidate, code) {
  const resolvedRoot = realpathSync(root);
  const resolvedCandidate = realpathSync(candidate);
  if (
    resolvedCandidate !== resolvedRoot
    && !resolvedCandidate.startsWith(`${resolvedRoot}${sep}`)
  ) throw codedError(code);
  return resolvedCandidate;
}

function writeReplayArtifact(pathname, bytes) {
  if (existsSync(pathname)) {
    const metadata = lstatSync(pathname);
    if (
      metadata.isSymbolicLink()
      || !metadata.isFile()
      || !readFileSync(pathname).equals(bytes)
    ) throw codedError('AUDIT_INTEGRITY_FAILURE_REPLAY_CONFLICT');
    return;
  }
  writeFileSync(pathname, bytes, { mode: 0o400, flag: 'wx' });
}

export function replayWeeklyFixture({ fixtureRoot, outputRoot }) {
  if (typeof fixtureRoot !== 'string' || typeof outputRoot !== 'string') {
    throw codedError('AUDIT_COMMAND_INVALID_REPLAY', TypeError);
  }
  const fixtureDir = safeFixturePath(fixtureRoot, fixtureRoot, 'AUDIT_COMMAND_INVALID_FIXTURE');
  let fixture;
  try {
    fixture = JSON.parse(readFileSync(join(fixtureDir, 'fixture.json'), 'utf8'));
  } catch {
    throw codedError('AUDIT_COMMAND_INVALID_FIXTURE');
  }
  if (
    fixture?.schemaVersion !== '1.0.0'
    || !Array.isArray(fixture.pages)
    || typeof fixture.locationId !== 'string'
  ) throw codedError('AUDIT_COMMAND_INVALID_FIXTURE');
  mkdirSync(outputRoot, { recursive: true, mode: 0o700 });
  const canonicalOutput = realpathSync(outputRoot);
  const events = [];
  for (const page of fixture.pages) {
    if (!Array.isArray(page.events)) throw codedError('AUDIT_COMMAND_INVALID_FIXTURE');
    events.push(...page.events);
  }
  const byId = new Map();
  for (const event of events) {
    if (typeof event.nativeEventId !== 'string') throw codedError('AUDIT_COMMAND_INVALID_FIXTURE');
    const existing = byId.get(event.nativeEventId);
    if (existing && canonicalJson(existing) !== canonicalJson(event)) {
      throw codedError('AUDIT_INTEGRITY_FAILURE_EVENT_CONFLICT');
    }
    byId.set(event.nativeEventId, event);
  }
  const safeEvents = [...byId.values()]
    .map(({ nativeEventId, occurredAt, kind }) => ({ nativeEventId, occurredAt, kind }))
    .sort((left, right) => left.nativeEventId.localeCompare(right.nativeEventId));
  const publicationId = `fixture_${sha256({
    locationId: fixture.locationId,
    cutoff: fixture.cutoff,
    events: safeEvents,
  }).slice(0, 20)}`;
  const week = '2026-W29';
  const relativePublication = join('weekly', week, publicationId);
  const publicationRoot = resolve(canonicalOutput, relativePublication);
  if (!publicationRoot.startsWith(`${canonicalOutput}${sep}`)) {
    throw codedError('AUDIT_COMMAND_INVALID_OUTPUT');
  }
  mkdirSync(publicationRoot, { recursive: true, mode: 0o700 });
  const plan = planWeeklyCollection({
    cutoff: fixture.cutoff,
    timezone: fixture.timezone,
    salesCycleDays: fixture.salesCycleDays,
    providerAvailableFrom: fixture.providerAppliedFrom,
  });
  const coverage = {
    schemaVersion: '1.0.0',
    state: 'complete_partial',
    scope: 'public_comparable_subset',
    limitations: [
      ...INTERNAL_LIMITATIONS,
      ...plan.limitations,
    ].sort(),
  };
  const report = [
    '# Weekly GHL audit replay',
    '',
    'Status: complete_partial',
    'Scope: public comparable subset',
    '',
    'Internal workflow definitions and runtime logs were not available.',
    '',
  ].join('\n');
  writeReplayArtifact(join(publicationRoot, 'REPORT.md'), Buffer.from(report, 'utf8'));
  writeReplayArtifact(
    join(publicationRoot, 'coverage.json'),
    Buffer.from(`${canonicalJson(coverage)}\n`, 'utf8'),
  );
  writeReplayArtifact(
    join(publicationRoot, 'replay-summary.json'),
    Buffer.from(`${canonicalJson({
      schemaVersion: '1.0.0',
      eventCount: safeEvents.length,
      requestedHistoryDays: plan.requestedHistoryDays,
      appliedHistoryDays: plan.appliedHistoryDays,
    })}\n`, 'utf8'),
  );
  return deepFreeze({
    status: 'complete_partial',
    publicationId,
    publicationPath: relative(canonicalOutput, publicationRoot).split(sep).join('/'),
  });
}

export const WEEKLY_INTERNAL_LIMITATIONS = INTERNAL_LIMITATIONS;
export const WEEKLY_FULL_ELIGIBILITY_GATES = FULL_ELIGIBILITY_GATES;

// ===========================================================================
// Task 11 — internal evidence phase, public/internal merge, full eligibility
// ===========================================================================

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function jsonClone(value) {
  return value === undefined ? null : structuredClone(value);
}

function epochOrNull(value) {
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function sortedUnique(values) {
  return [...new Set(values.filter((value) => typeof value === 'string'))].sort();
}

// ---------------------------------------------------------------------------
// Phase: collect internal evidence
// ---------------------------------------------------------------------------

/**
 * Runs the internal audit rail as its own weekly phase.
 *
 * Internal auth is resolved ONLY after the public/context evidence handed in here already
 * exists to preserve; a call without it is an ordering violation, not a soft partial. Missing,
 * short-lived, expired and rejected credentials all checkpoint at `awaiting_internal_auth`
 * having issued zero evidence calls, and neither the credential nor any reference to it is
 * ever echoed back. No unattended token renewal is attempted.
 */
export async function collectInternalEvidencePhase({
  adapter,
  target,
  window,
  conversationWindow,
  applicability,
  stepRosterRequests,
  publicEvidence,
  checkpoint,
  signal,
} = {}) {
  if (publicEvidence === undefined || publicEvidence === null) {
    throw codedError('AUDIT_INTEGRITY_FAILURE_PUBLIC_EVIDENCE_MISSING');
  }
  const preservedPublic = jsonClone(publicEvidence);
  const preservedCheckpoint = jsonClone(checkpoint);

  if (adapter === undefined || adapter === null) {
    // No internal rail at all: the approved Task 9 public-only path, unchanged.
    return deepFreeze({
      phase: 'normalizing',
      publicEvidence: preservedPublic,
      checkpoint: preservedCheckpoint,
      internalEvidence: null,
      limitations: [...INTERNAL_LIMITATIONS],
    });
  }
  if (typeof adapter.collectAuditEvidence !== 'function') {
    throw codedError('INTERNAL_AUDIT_REQUEST_INVALID', TypeError);
  }

  const internalEvidence = await adapter.collectAuditEvidence({
    target,
    window,
    ...(conversationWindow === undefined
      ? {}
      : { conversationWindow: jsonClone(conversationWindow) }),
    applicability,
    stepRosterRequests,
    /*
     * READ-ONLY, and passed as a CLONE so an adapter cannot reach back and edit the public
     * evidence this phase is required to preserve byte-for-byte. The transcript rail joins
     * conversations to their commercial outcome from it; nothing else consumes it, and nothing may
     * write to it. Deliberately NOT `preservedPublic`: that object is what travels onward, and
     * handing the adapter the very reference this phase promises to preserve is how a preserved
     * copy stops being one.
     */
    publicEvidence: jsonClone(publicEvidence),
    signal,
  });

  const authBoundary = internalEvidence?.checkpoint?.phase === 'awaiting_internal_auth'
    && internalEvidence?.checkpoint?.reason === AUTH_REQUIRED;
  if (authBoundary) {
    // The public evidence and the public checkpoint survive byte-for-byte. Nothing from the
    // credential probe — path, claim, key reference, header — travels out of here.
    return deepFreeze({
      phase: 'awaiting_internal_auth',
      publicEvidence: preservedPublic,
      checkpoint: preservedCheckpoint,
      internalEvidence: null,
      limitations: [AUTH_REQUIRED, ...INTERNAL_LIMITATIONS],
    });
  }

  // A successful `auth_status` is NOT capability proof and NOT complete evidence: whatever the
  // adapter returns keeps its own `complete` verdict and its own limitations.
  return deepFreeze({
    phase: 'collecting_internal',
    publicEvidence: preservedPublic,
    checkpoint: preservedCheckpoint,
    internalEvidence,
    limitations: internalEvidence?.complete === true ? [] : [...INTERNAL_LIMITATIONS],
  });
}

// ---------------------------------------------------------------------------
// Public / internal evidence merge
// ---------------------------------------------------------------------------

/** A Task-4 collection envelope is recognisable by the two fields every producer stamps. */
function looksLikeEnvelope(value) {
  return isRecord(value) && !Array.isArray(value)
    && isRecord(value.page) && !Array.isArray(value.page)
    && Array.isArray(value.items);
}

/**
 * Finding R6-I1 — the merge SILENTLY DISCARDED the shipped public-evidence shape.
 *
 * `if (!Array.isArray(envelopes)) envelopes = [];` meant only the test harness's bare array ever
 * reached the rail check. The shipped composition root REQUIRES `publicEvidence` to be a plain
 * object (`lib/local-runtime.mjs` rejects arrays outright) and the Task-10 kernel shape is a
 * record — so on every shipped run, evidence that HAD been collected was reported as
 * `PUBLIC_EVIDENCE_MISSING`, which is a false statement, and no shape error was ever raised.
 *
 * Every shape that genuinely CARRIES envelopes is now accepted:
 *  - a bare array of envelopes (the harness shape);
 *  - a record with an `envelopes` array (the shipped shape);
 *  - a record with a `scopes` array (the LIVE PUBLIC RAIL's shape — see below);
 *  - a record that IS a single envelope;
 *  - a record whose `events` array carries envelopes.
 *
 * A record with an EMPTY ledger is honestly `absent` — zero evidence is missing evidence. Any
 * other shape is `unrecognised`, which is a MALFORMED shape error stated out loud, never a
 * silent empty list and never a claim that nothing was collected.
 *
 * ---------------------------------------------------------------------------------------------
 * THE `scopes` BRANCH, AND WHY IT MUST COME BEFORE `events`.
 *
 * The live public rail checkpoints `{schemaVersion, source, boundLocationId, collectionWindow,
 * collectionMode, events: [], scopes: [...], privateSourceEnvelopes, scopeCheckpoints,
 * limitations}`. `events` is present and EMPTY on purpose, as the slot a governed baseline is
 * later merged into. So the `events` branch below matched it first, found an empty array, and
 * returned zero envelopes — and `inspectPublicRail` then reported `PUBLIC_EVIDENCE_MISSING` for a
 * run that had just collected 588 real records.
 *
 * That never fired, because `mergeInternalEvidence` only runs when internal evidence exists and
 * the internal rail has never been reachable from the CLI. It would have fired on the first run
 * that turned it on, and it would have looked like an empty account rather than a shape bug — the
 * same signature as the capture-horizon defect.
 *
 * The mapping is NOT written out again here. `sourceCollectionsFromScopes` is the one function
 * both consumers use, so the envelopes this rail check inspects are byte-identical to the ones the
 * measurement chain's projector validates. Two copies of that mapping is exactly how one consumer
 * ends up reconciling an envelope the other rejects.
 * ---------------------------------------------------------------------------------------------
 */
function normalizePublicEvidence(value) {
  if (value === null || value === undefined) return { envelopes: [], unrecognised: false };
  if (Array.isArray(value)) return { envelopes: value, unrecognised: false };
  if (!isRecord(value)) return { envelopes: [], unrecognised: true };
  if (Array.isArray(value.envelopes)) {
    return { envelopes: value.envelopes, unrecognised: false };
  }
  // A record that IS one envelope. It stays ahead of the two ledger branches, exactly where it
  // was: a single envelope carries neither `scopes` nor `events`, so the order cannot matter for
  // correctness, and leaving it here means this function's behaviour on every shape that already
  // worked is bit-for-bit what it was.
  if (looksLikeEnvelope(value)) return { envelopes: [value], unrecognised: false };
  if (Array.isArray(value.scopes)) {
    if (value.scopes.length === 0) return { envelopes: [], unrecognised: false };
    try {
      return { envelopes: sourceCollectionsFromScopes(value), unrecognised: false };
    } catch {
      // A `scopes` array this rail cannot turn into envelopes is a SHAPE error about evidence that
      // exists. Saying nothing was collected would be a false statement.
      return { envelopes: [], unrecognised: true };
    }
  }
  if (Array.isArray(value.events)) {
    if (value.events.length === 0) return { envelopes: [], unrecognised: false };
    if (value.events.every(looksLikeEnvelope)) {
      return { envelopes: value.events, unrecognised: false };
    }
    // A raw event ledger states no pagination, terminality or location binding, so nothing in
    // it can be reconciled. That is a SHAPE error about evidence that exists, not an absence.
    return { envelopes: [], unrecognised: true };
  }
  return { envelopes: [], unrecognised: true };
}

function inspectPublicRail(envelopes, expectedLocationId, { unrecognisedShape = false } = {}) {
  const reasons = [];
  let locationConflict = false;
  if (unrecognisedShape) {
    return { ok: false, locationConflict, reasons: ['PUBLIC_EVIDENCE_MALFORMED'] };
  }
  if (!Array.isArray(envelopes) || envelopes.length === 0) {
    return { ok: false, locationConflict, reasons: ['PUBLIC_EVIDENCE_MISSING'] };
  }
  for (const envelope of envelopes) {
    if (!isRecord(envelope)) {
      reasons.push('PUBLIC_EVIDENCE_MALFORMED');
      continue;
    }
    if (
      typeof envelope.boundLocationId !== 'string'
      || expectedLocationId !== null && envelope.boundLocationId !== expectedLocationId
    ) {
      locationConflict = true;
      reasons.push('PUBLIC_INTERNAL_LOCATION_CONFLICT');
      continue;
    }
    const page = envelope.page;
    const items = Array.isArray(envelope.items) ? envelope.items : null;
    if (!isRecord(page) || items === null) {
      reasons.push('PUBLIC_EVIDENCE_MALFORMED');
      continue;
    }
    // ANTI-ORACLE, finding R3-C1. Everything below is recomputed from the rows THIS response
    // actually served, and every self-description the response carries is reconciled against
    // that recount — not against `items.length`, which is a number the same response controls
    // and which counts array slots that are not rows at all.
    // Terminality must be STATED, exactly. An absent flag is UNKNOWN, and a truthy-but-not-true
    // one (`complete: 1`) is UNKNOWN too — never a substitute for `true`.
    if (page.complete !== true) reasons.push('PUBLIC_EVIDENCE_INCOMPLETE');
    const rows = items.filter(isSubstantiveRow);
    if (rows.length !== items.length) {
      // Null, primitive, array and CONTENTLESS slots are not rows. A response that pads its
      // array to make a declared count come out right has served fewer rows than it claims.
      reasons.push('PUBLIC_EVIDENCE_MALFORMED');
      continue;
    }
    if (rows.length === 0) {
      // Zero served rows is zero evidence. It may be an honest empty window, but it can never
      // be the COMPLETE public rail that gate 1 requires: absent evidence is UNKNOWN.
      reasons.push('PUBLIC_EVIDENCE_INCOMPLETE');
    }
    // Both self-describing records are read: the page, and the envelope that carries it. An
    // envelope-level count or continuation signal contradicts terminality exactly as a
    // page-level one does.
    const pageState = inspectSelfDescription(page, rows.length, PAGE_SPEC);
    const envelopeState = inspectSelfDescription(
      Object.fromEntries(Object.entries(envelope).filter(([key]) => key !== 'page')),
      rows.length,
      ENVELOPE_SPEC,
    );
    if (pageState.contradicted || envelopeState.contradicted) {
      reasons.push('PUBLIC_EVIDENCE_INCOMPLETE');
    }
    if (pageState.unreconciled || envelopeState.unreconciled) {
      reasons.push('PUBLIC_EVIDENCE_RECONCILIATION_FAILED');
    }
    // Finding R4-C2: a key the auditor has no meaning for is not evidence it can reconcile.
    if (pageState.unknown || envelopeState.unknown) {
      reasons.push('PUBLIC_EVIDENCE_MALFORMED');
    }
    // Finding R2-C3: a page that declares NO count at all was accepted unconditionally.
    if (pageState.declarations === 0) reasons.push('PUBLIC_EVIDENCE_RECONCILIATION_FAILED');
    // A terminal response that also states why it is NOT terminal contradicts itself.
    if (
      Object.hasOwn(envelope, 'incompleteReason') && !isEmptySignal(envelope.incompleteReason)
      || Object.hasOwn(page, 'incompleteReason') && !isEmptySignal(page.incompleteReason)
    ) reasons.push('PUBLIC_EVIDENCE_INCOMPLETE');
  }
  return { ok: reasons.length === 0, locationConflict, reasons: sortedUnique(reasons) };
}

function publicCaptureExtremes(envelopes) {
  const stamps = (Array.isArray(envelopes) ? envelopes : [])
    .map((envelope) => epochOrNull(envelope?.capturedAt))
    .filter((value) => value !== null);
  if (stamps.length === 0) return null;
  return { oldest: Math.min(...stamps), newest: Math.max(...stamps) };
}

function observedSkewMs(envelopes, internalCapturedAt) {
  // Finding C2: returning `0` here turned UNMEASURABLE skew into PERFECT skew, so a run with no
  // trusted internal capture timestamp — including one with zero public evidence — sailed
  // through the skew gate. Unmeasurable is `null`, and `null` never satisfies the policy.
  if (internalCapturedAt === null) return null;
  const extremes = publicCaptureExtremes(envelopes);
  if (extremes === null) return null;
  return Math.max(
    Math.abs(internalCapturedAt - extremes.oldest),
    Math.abs(internalCapturedAt - extremes.newest),
  );
}

/**
 * Finding R6-I1, the refresh half. A refusal is `null`; anything else is read through exactly
 * the same shape normalizer as the primary rail, so a refresh returning the SHIPPED record shape
 * is understood, and one returning a shape the auditor cannot read is refused rather than being
 * wrapped into a one-element list that then fails for the wrong reason.
 */
function normalizeRefreshed(value) {
  if (value === null || value === undefined) return null;
  const { envelopes, unrecognised } = normalizePublicEvidence(value);
  if (unrecognised) return null;
  return envelopes;
}

function entityKeyFor(kind, nativeId, row) {
  if (typeof nativeId === 'string' && nativeId.length > 0) return `${kind}:${nativeId}`;
  // No native ID means no join. The key is content-derived so the identity is stable under
  // input reordering, and it can never collide with a natively identified entity.
  return `${kind}:unjoined:${sha256(row ?? null).slice(0, 24)}`;
}

function ensureEntity(entities, { entityKey, kind, nativeId }) {
  let entity = entities.get(entityKey);
  if (entity === undefined) {
    entity = {
      entityKey,
      kind,
      nativeId: typeof nativeId === 'string' && nativeId.length > 0 ? nativeId : null,
      rails: new Set(),
      provenance: new Map(),
      // Finding I1: each rail keeps EVERY distinct value it observed for a field, keyed by its
      // canonical form. Arrival order can no longer decide anything, and a same-rail
      // contradiction on one native id is recorded instead of silently overwritten.
      publicFields: new Map(),
      internalFields: new Map(),
      internalFacts: new Map(),
    };
    entities.set(entityKey, entity);
  }
  return entity;
}

/** Records one observation of `field` on one rail. Idempotent and order-independent. */
function observeField(store, field, value) {
  const cloned = jsonClone(value);
  const bucket = store.get(field) ?? new Map();
  bucket.set(canonicalJson(cloned ?? null), cloned);
  store.set(field, bucket);
}

/** Collapses a rail's observations for one field into a single value or a contradiction. */
function railValue(store, field) {
  const bucket = store.get(field);
  if (bucket === undefined) {
    return { present: false, conflicted: false, value: null, values: [] };
  }
  const keys = [...bucket.keys()].sort();
  const values = keys.map((key) => bucket.get(key));
  if (values.length === 1) {
    return { present: true, conflicted: false, value: values[0], values };
  }
  return { present: true, conflicted: true, value: null, values };
}

const INTERNAL_FACT_NAMES = Object.freeze(['definition', 'runtime', 'configurationBinding']);

function addProvenance(entity, rail, record) {
  // Finding R2-I3: dedup on `${rail}:${operationId ?? ''}` collapsed two envelopes that share
  // an `operationId` — or that both lack one — by ARRIVAL ORDER, silently discarding the
  // loser's `capturedAt` and `appliedWindow`. Provenance identity is now TOTAL: the canonical
  // form of the whole record is the key, so the merge is byte-identical under any permutation
  // of the envelopes and no observation is ever dropped.
  const entry = { rail, ...record };
  entity.provenance.set(canonicalJson(entry), entry);
  entity.rails.add(rail);
}

function collectPublicEntities(entities, envelopes) {
  for (const envelope of Array.isArray(envelopes) ? envelopes : []) {
    if (!isRecord(envelope) || !Array.isArray(envelope.items)) continue;
    const provenance = {
      source: typeof envelope.source === 'string' ? envelope.source : 'public_ghl',
      operationId: typeof envelope.operationId === 'string' ? envelope.operationId : null,
      capturedAt: typeof envelope.capturedAt === 'string' ? envelope.capturedAt : null,
      requestedWindow: jsonClone(envelope.requestedWindow),
      appliedWindow: jsonClone(envelope.appliedWindow),
    };
    for (const row of envelope.items) {
      if (!isRecord(row)) continue;
      const kind = typeof row.kind === 'string' ? row.kind : 'unknown';
      const nativeId = typeof row.nativeId === 'string' && row.nativeId.length > 0
        ? row.nativeId
        : null;
      const entity = ensureEntity(entities, {
        entityKey: entityKeyFor(kind, nativeId, row),
        kind,
        nativeId,
      });
      addProvenance(entity, 'public', provenance);
      for (const [field, value] of Object.entries(row)) {
        if (field === 'kind' || field === 'nativeId') continue;
        observeField(entity.publicFields, field, value);
      }
    }
  }
}

function collectInternalEntities(entities, internalEvidence) {
  if (!isRecord(internalEvidence)) return;
  const provenance = {
    source: typeof internalEvidence.source === 'string' ? internalEvidence.source : 'internal_ghl',
    operationId: typeof internalEvidence.operationId === 'string'
      ? internalEvidence.operationId
      : null,
    capturedAt: typeof internalEvidence.capturedAt === 'string'
      ? internalEvidence.capturedAt
      : null,
    requestedWindow: jsonClone(internalEvidence.requestedWindow),
    appliedWindow: jsonClone(internalEvidence.appliedWindow),
  };
  const workflows = Array.isArray(internalEvidence.workflows) ? internalEvidence.workflows : [];
  for (const record of workflows) {
    if (!isRecord(record) || typeof record.workflowId !== 'string') continue;
    // Exact provider-native ID. Never a display name, never a timestamp, never a guess.
    const entity = ensureEntity(entities, {
      entityKey: entityKeyFor('workflow', record.workflowId, record),
      kind: 'workflow',
      nativeId: record.workflowId,
    });
    addProvenance(entity, 'internal', provenance);
    if (typeof record.status === 'string') {
      observeField(entity.internalFields, 'status', record.status);
    }
    if (Number.isInteger(record.version)) {
      observeField(entity.internalFields, 'version', record.version);
    }
    observeField(entity.internalFacts, 'definition', record.definition ?? null);
    observeField(entity.internalFacts, 'runtime', record.runtime ?? null);
    observeField(
      entity.internalFacts,
      'configurationBinding',
      record.configurationBinding ?? null,
    );

    const events = Array.isArray(record.runtime?.events) ? record.runtime.events : [];
    for (const entry of events) {
      const payload = isRecord(entry?.event) ? entry.event : null;
      if (payload === null) continue;
      for (const [idKey, kind] of EVENT_ENTITY_KEYS) {
        const nativeId = payload[idKey];
        if (typeof nativeId !== 'string' || nativeId.length === 0) continue;
        const referenced = ensureEntity(entities, {
          entityKey: entityKeyFor(kind, nativeId, null),
          kind,
          nativeId,
        });
        addProvenance(referenced, 'internal', provenance);
        for (const field of EVENT_CLAIM_FIELDS) {
          if (!Object.hasOwn(payload, field)) continue;
          observeField(referenced.internalFields, field, payload[field]);
        }
      }
    }
  }
}

function resolveEntities(entities) {
  const resolved = [];
  const conflicts = [];
  for (const entity of entities.values()) {
    const fields = {};
    const entityConflicts = [];
    const names = sortedUnique([
      ...entity.publicFields.keys(),
      ...entity.internalFields.keys(),
    ]);
    const recordConflict = (conflict) => {
      entityConflicts.push(conflict);
      conflicts.push(conflict);
    };
    for (const field of names) {
      const publicRail = railValue(entity.publicFields, field);
      // Internal-only facts live in `internalFacts`, never in `fields`.
      if (!publicRail.present) continue;
      const internalRail = railValue(entity.internalFields, field);
      if (publicRail.conflicted || internalRail.conflicted) {
        // Finding I1: a SAME-RAIL contradiction on one native id used to resolve by arrival
        // order with no conflict recorded at all. It is now explicit and order-independent.
        fields[field] = {
          state: 'CONFLICT',
          publicValue: publicRail.conflicted
            ? { state: 'CONTRADICTORY', values: publicRail.values }
            : publicRail.value,
          internalValue: !internalRail.present
            ? null
            : internalRail.conflicted
              ? { state: 'CONTRADICTORY', values: internalRail.values }
              : internalRail.value,
        };
        recordConflict({
          nativeId: entity.nativeId,
          field,
          resolution: 'conflict',
          rail: publicRail.conflicted && internalRail.conflicted
            ? 'both'
            : publicRail.conflicted ? 'public' : 'internal',
          publicOwnedDomain: PUBLIC_OWNED_KINDS.has(entity.kind),
        });
        continue;
      }
      const publicValue = publicRail.value;
      if (!internalRail.present) {
        fields[field] = publicValue;
        continue;
      }
      const internalValue = internalRail.value;
      if (canonicalJson(publicValue ?? null) === canonicalJson(internalValue ?? null)) {
        fields[field] = publicValue;
        continue;
      }
      // A native contradiction is recorded, never resolved last-write-wins.
      fields[field] = { state: 'CONFLICT', publicValue, internalValue };
      recordConflict({
        nativeId: entity.nativeId,
        field,
        resolution: 'conflict',
        publicOwnedDomain: PUBLIC_OWNED_KINDS.has(entity.kind),
      });
    }
    const internalFacts = {};
    for (const name of INTERNAL_FACT_NAMES) {
      const observed = railValue(entity.internalFacts, name);
      if (!observed.present) {
        internalFacts[name] = null;
        continue;
      }
      if (observed.conflicted) {
        internalFacts[name] = { state: 'CONTRADICTORY', values: observed.values };
        recordConflict({
          nativeId: entity.nativeId,
          field: `internalFacts.${name}`,
          resolution: 'conflict',
          rail: 'internal',
          publicOwnedDomain: PUBLIC_OWNED_KINDS.has(entity.kind),
        });
        continue;
      }
      internalFacts[name] = observed.value;
    }
    resolved.push({
      entityKey: entity.entityKey,
      kind: entity.kind,
      nativeId: entity.nativeId,
      joinBasis: entity.nativeId === null ? 'unjoined' : 'provider_native_id',
      rails: [...entity.rails].sort(),
      provenance: [...entity.provenance.values()].sort(
        (left, right) => canonicalJson(left).localeCompare(canonicalJson(right)),
      ),
      fields,
      conflicts: entityConflicts,
      internalFacts,
    });
  }
  resolved.sort((left, right) => left.entityKey.localeCompare(right.entityKey));
  conflicts.sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
  return { entities: resolved, conflicts };
}

/**
 * Merges the public and internal rails after each has independently passed its own location,
 * pagination, completeness and freshness checks.
 *
 * The analytical cutoff never moves, in any branch. The bounded public refresh is attempted at
 * most once and only when measured capture skew exceeds the pinned policy; a refusal keeps the
 * already collected public evidence and the checkpoint exactly as they arrived.
 */
export async function mergeInternalEvidence({
  publicEvidence,
  internalEvidence = null,
  coveragePolicy,
  checkpoint,
  refreshPublicEvidence,
  refreshLedger = null,
  runtime,
} = {}) {
  const policy = isRecord(coveragePolicy) ? coveragePolicy : {};
  const policyMs = Number.isFinite(policy.maxSnapshotSkewMs)
    ? Number(policy.maxSnapshotSkewMs)
    : DEFAULT_SNAPSHOT_SKEW_MS;
  const analyticalCutoff = typeof policy.analyticalCutoff === 'string'
    ? policy.analyticalCutoff
    : null;
  const freshnessFloor = epochOrNull(policy.freshnessFloor);

  const preservedCheckpoint = jsonClone(checkpoint);
  // Finding R6-I1: the shipped record shape is READ, not silently thrown away, and a shape this
  // auditor does not recognise is an explicit malformed error rather than an empty list.
  const normalizedPublic = normalizePublicEvidence(jsonClone(publicEvidence ?? null));
  const publicShapeUnrecognised = normalizedPublic.unrecognised;
  let envelopes = normalizedPublic.envelopes;

  const limitations = new Set();
  let quarantined = false;

  const internalPresent = isRecord(internalEvidence);
  const expectedLocationId = internalPresent
    && typeof internalEvidence.boundLocationId === 'string'
    ? internalEvidence.boundLocationId
    : typeof envelopes[0]?.boundLocationId === 'string'
      ? envelopes[0].boundLocationId
      : null;

  // ---- rail 1: the public envelopes, checked entirely on their own ---------
  const publicRail = inspectPublicRail(envelopes, expectedLocationId, {
    unrecognisedShape: publicShapeUnrecognised,
  });
  for (const reason of publicRail.reasons) limitations.add(reason);
  if (publicRail.locationConflict) quarantined = true;

  // ---- rail 2: the internal evidence, checked entirely on its own ----------
  if (!internalPresent) {
    limitations.add('INTERNAL_EVIDENCE_MISSING');
    for (const code of INTERNAL_LIMITATIONS) limitations.add(code);
  } else if (internalEvidence.complete !== true) {
    limitations.add('INTERNAL_EVIDENCE_INCOMPLETE');
  }
  const internalCapturedAt = internalPresent
    ? epochOrNull(internalEvidence.capturedAt)
    : null;

  // ---- snapshot skew, from TRUSTED capture timestamps only -----------------
  let observedMs = observedSkewMs(envelopes, internalCapturedAt);
  let withinPolicy = observedMs !== null && observedMs <= policyMs;
  let refreshed = false;

  // Finding M3: the bound used to be at most once per CALL, so a resumed or retried logical run
  // could refresh again and again, and nothing durable recorded that it had already happened.
  // The prior mark is now an INPUT (`refreshLedger`, or the durable checkpoint's own flag), and
  // the outcome is republished as `publicRefreshLedger` for the caller to persist.
  const priorAttempted = isRecord(refreshLedger)
    ? refreshLedger.attempted === true
    : isRecord(preservedCheckpoint) && preservedCheckpoint.publicRefreshAttempted === true;
  let attemptedNow = false;

  if (
    publicRail.ok
    && internalCapturedAt !== null
    && observedMs !== null
    && !withinPolicy
    && priorAttempted
  ) {
    // The one bounded refresh this logical run is allowed has already been spent.
    limitations.add(SNAPSHOT_SKEW);
  } else if (
    publicRail.ok
    && internalCapturedAt !== null
    && observedMs !== null
    && !withinPolicy
  ) {
    if (typeof refreshPublicEvidence !== 'function') {
      limitations.add(SNAPSHOT_SKEW);
    } else {
      attemptedNow = true;
      const requestedWindow = jsonClone(envelopes[0]?.requestedWindow ?? null);
      let candidate = null;
      try {
        // Bounded, at most once, for the SAME window. It never widens the collection.
        candidate = normalizeRefreshed(await refreshPublicEvidence({
          requestedWindow,
          reason: SNAPSHOT_SKEW,
        }));
      } catch {
        candidate = null;
      }
      const candidateRail = candidate === null
        ? { ok: false, locationConflict: false, reasons: [] }
        : inspectPublicRail(candidate, expectedLocationId);
      const candidateSkew = candidate === null
        ? null
        : observedSkewMs(candidate, internalCapturedAt);
      const candidateFresh = candidate === null || freshnessFloor === null
        ? candidate !== null
        : (publicCaptureExtremes(candidate)?.oldest ?? -Infinity) >= freshnessFloor;
      if (
        candidateRail.ok
        && candidateSkew !== null
        && candidateSkew <= policyMs
        && candidateFresh
      ) {
        envelopes = jsonClone(candidate);
        observedMs = candidateSkew;
        withinPolicy = true;
        refreshed = true;
      } else {
        // The incompatible snapshot is never mixed in. Everything already collected stands.
        if (candidateRail.locationConflict) quarantined = true;
        limitations.add(SNAPSHOT_SKEW);
      }
    }
  } else if (!withinPolicy && (observedMs !== null || internalPresent)) {
    // Unmeasurable skew is NOT zero skew (finding C2): it is an explicit limitation.
    limitations.add(SNAPSHOT_SKEW);
  }

  // ---- merge ---------------------------------------------------------------
  const entityMap = new Map();
  if (publicRail.ok || !publicRail.locationConflict) collectPublicEntities(entityMap, envelopes);
  collectInternalEntities(entityMap, internalEvidence);
  const { entities, conflicts } = resolveEntities(entityMap);

  const status = quarantined
    ? 'QUARANTINED'
    : publicRail.ok
      && internalPresent
      && internalEvidence.complete === true
      && withinPolicy
      ? 'COMPLETE'
      : 'PARTIAL';

  return deepFreeze({
    status,
    analyticalCutoff,
    entities,
    conflicts,
    limitations: [...limitations].sort(),
    skew: {
      observedMs,
      policyMs,
      withinPolicy,
      refreshed,
    },
    // The durable mark finding M3 asked for. The caller persists it (the kernel checkpoints it
    // with the internal phase) and hands it back as `refreshLedger` on any later attempt.
    publicRefreshLedger: {
      attempted: priorAttempted || attemptedNow,
      attemptedThisCall: attemptedNow,
      alreadyAttempted: priorAttempted,
    },
    publicEvidence: envelopes,
    internalEvidence: internalPresent ? internalEvidence : null,
    checkpoint: preservedCheckpoint,
  });
}

// ---------------------------------------------------------------------------
// `complete_full` eligibility
// ---------------------------------------------------------------------------

function coverageRowsOf(internalEvidence) {
  const coverage = internalEvidence?.capabilityCoverage;
  if (Array.isArray(coverage)) return coverage.filter(isRecord);
  if (isRecord(coverage)) return Object.values(coverage).filter(isRecord);
  return [];
}

function windowsCovered(internalEvidence, requiredWindows) {
  const applied = isRecord(internalEvidence?.appliedWindow)
    ? internalEvidence.appliedWindow
    : internalEvidence?.requestedWindow;
  const from = epochOrNull(applied?.from);
  const to = epochOrNull(applied?.to);
  if (from === null || to === null) return false;
  const required = Array.isArray(requiredWindows) ? requiredWindows : [];
  if (required.length === 0) return false;
  return required.every((entry) => {
    const start = epochOrNull(entry?.from);
    const end = epochOrNull(entry?.to);
    if (start === null || end === null) return false;
    return from <= start && to >= end;
  });
}

/**
 * Finding M2: `readOnlyTraceIsClean([])` returned `true`, so gate 7 passed VACUOUSLY on an empty
 * or absent trace. A trace that was never produced is now `clean: false` (missing evidence →
 * Partial) and is carefully distinguished from a trace that CONTAINS a violation
 * (`violation: true` → quarantine).
 */
function inspectReadOnlyTrace(trace, expectedLocationId) {
  if (!Array.isArray(trace) || trace.length === 0) {
    return { clean: false, violation: false };
  }
  // Finding R2-M5: an entry that omitted `boundLocationId` SKIPPED the cross-location check
  // entirely. An unbound entry is UNKNOWN, not assent: it can no longer satisfy gate 7, but it
  // is missing evidence (Partial), not a demonstrated cross-location read (quarantine).
  let unbound = false;
  // Finding R3-M1: raising the floor from zero entries to one made a trace containing ONLY the
  // `tools/list` handshake sufficient, and the gate never read the per-call OUTCOME at all, so
  // an `ok: false` entry passed. A trace proves the run stayed read-only only when it also
  // shows that evidence was actually fetched, and that every call it records SUCCEEDED.
  let evidenceCalls = 0;
  let unusableOutcome = false;
  for (const entry of trace) {
    if (!isRecord(entry)) return { clean: false, violation: true };
    if (typeof entry.tool !== 'string' || !REGISTERED_AUDIT_TOOLS.has(entry.tool)) {
      return { clean: false, violation: true };
    }
    if (entry.confirmed === true) return { clean: false, violation: true };
    if (typeof entry.method === 'string' && WRITE_METHODS.has(entry.method.toUpperCase())) {
      return { clean: false, violation: true };
    }
    if (EVIDENCE_TOOLS.has(entry.tool)) evidenceCalls += 1;
    // A call that failed, or that never said whether it succeeded, is missing evidence
    // (Partial) — not a demonstrated violation (quarantine).
    if (entry.ok !== true) unusableOutcome = true;
    if (
      Object.hasOwn(entry, 'status')
      && entry.status !== null
      && !(Number.isInteger(entry.status) && entry.status >= 200 && entry.status < 300)
    ) unusableOutcome = true;
    if (
      expectedLocationId === null
      || typeof entry.boundLocationId !== 'string'
      || entry.boundLocationId.length === 0
    ) {
      unbound = true;
      continue;
    }
    if (entry.boundLocationId !== expectedLocationId) return { clean: false, violation: true };
  }
  return { clean: !unbound && !unusableOutcome && evidenceCalls > 0, violation: false };
}

/**
 * Finding R2-C2 (the gate half). The adapter pushes a roster member the caller EXCLUDED as
 * `{applicable: false, complete: true, definition: null, runtime: null}`, and this gate never
 * compared the workflow records it was handed against the SEALED roster — so 1 of 2 roster
 * workflows actually read still reported Full with zero failed gates and zero limitations.
 * A roster member that was not READ can never be counted as covered.
 */
function rosterCoverageReconciles(roster, workflows) {
  const declaredIds = Array.isArray(roster?.workflowIds) ? roster.workflowIds : null;
  if (declaredIds === null || declaredIds.length === 0) return false;
  if (declaredIds.some((id) => typeof id !== 'string' || id.length === 0)) return false;
  const declared = new Set(declaredIds);
  if (declared.size !== declaredIds.length) return false;
  // Finding R3-I3: the roster is an adapter OUTPUT, and this gate is the trust boundary between
  // adapter output and publication — it may not take the adapter's word for the roster's own
  // arithmetic. Every count the roster states about itself is recounted against the ids it
  // actually listed, by the same classification the public page uses, so `reportedTotal: 99`
  // over one listed id can never be published as covered.
  // Finding R4-C2: the roster is defended by the SAME allow-list, so `roster.pagination`,
  // `roster.pageTotal` and `roster.hits` are unknown keys here too, not silently ignored ones.
  const stated = inspectSelfDescription(roster, declared.size, ROSTER_SPEC);
  if (
    stated.declarations === 0
    || stated.unreconciled
    || stated.contradicted
    || stated.unknown
  ) return false;
  const read = new Set();
  for (const entry of workflows) {
    if (!isRecord(entry) || typeof entry.workflowId !== 'string') return false;
    if (
      entry.applicable !== true
      || entry.complete !== true
      || entry.definition === null || entry.definition === undefined
      || entry.runtime === null || entry.runtime === undefined
    ) return false;
    // A record for a workflow the sealed roster never listed is a reconciliation failure too.
    if (!declared.has(entry.workflowId)) return false;
    read.add(entry.workflowId);
  }
  return read.size === declared.size;
}

/**
 * Finding R3-C2 — the D7 anchors were CIRCULAR.
 *
 * The adapter's `capabilityProofAnchor` pins and the caller's `expected.<hash>` values both come
 * from the same actor and, in the shipped composition root, the same configuration record as the
 * proof index itself; and the `expected` comparison was against `internalEvidence[identityKey]`,
 * the evidence's own self-declared field. Restating what the evidence claims is not anchoring,
 * so a wholly self-minted proof chain reached `complete_full` with no live canary anywhere.
 *
 * Decision D3 already provides genuinely independent anchors: `providerToolProfileHash`,
 * `capabilityManifestHashes` and `capabilityAttestationHashes` are SEALED into the Task 2 frozen
 * inputs at run creation, hashed into `frozenInputsHash`, and `RESUME_INPUT_MISMATCH`-protected —
 * any change to them is a different logical run. This reads exactly those sealed values.
 */
/** `sha256:`-prefixed internal digest over canonical JSON — the internal MCP's own convention. */
function internalDigest(value) {
  try {
    return `sha256:${sha256(value)}`;
  } catch {
    return null;
  }
}

/**
 * The eight fields an attestation BINDS (`internal-ghl.mjs` `ATTESTATION_BOUND_FIELDS`). All
 * eight go into the digest, which is why an attestation hash is the one value in this system
 * that a self-minted chain cannot restate.
 */
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

/**
 * The attestations that may anchor an identity on THIS run.
 *
 * An attestation qualifies only when all four hold:
 *  1. its own hash is SEALED in `frozenInputs.capabilityAttestationHashes` (decision D3);
 *  2. the document hashes to that sealed hash — the preimage relation, which is what makes the
 *     seal mean something: a forged attestation has a hash the run never sealed, and an
 *     attestation whose hash the run DID seal cannot have been forged;
 *  3. a receipt in the same chain REFERENCES it, with `proofClass: 'live_runtime'`, for a
 *     capability this run's own coverage ledger proves live AND exercised. Finding R4-C1's
 *     decoy variant: an attestation referenced by no receipt is validated by nobody, so its
 *     hash being sealed says nothing about the identities it claims to bind;
 *  4. it names a human approver.
 *
 * The chain document itself is UNTRUSTED input, deliberately. It never decides anything: the
 * sealed hash decides, and the document only supplies the preimage the seal is a commitment to.
 */
function governingAttestations({ proofChain, sealedAttestationHashes, provenCapabilityIds }) {
  const governing = [];
  if (!isRecord(proofChain) || sealedAttestationHashes.size === 0) return governing;
  const attestations = proofChain.attestations;
  if (!isRecord(attestations) || Array.isArray(attestations)) return governing;
  const receipts = Array.isArray(proofChain.index?.receipts) ? proofChain.index.receipts : [];

  const referenced = new Set();
  for (const receipt of receipts) {
    if (!isRecord(receipt) || Array.isArray(receipt)) continue;
    if (receipt.proofClass !== 'live_runtime') continue;
    if (typeof receipt.capabilityId !== 'string') continue;
    if (!provenCapabilityIds.has(receipt.capabilityId)) continue;
    if (typeof receipt.attestationHash !== 'string' || receipt.attestationHash.length === 0) {
      continue;
    }
    referenced.add(receipt.attestationHash);
  }

  for (const [hash, attestation] of Object.entries(attestations)) {
    if (!sealedAttestationHashes.has(hash)) continue;
    if (!referenced.has(hash)) continue;
    if (!isRecord(attestation) || Array.isArray(attestation)) continue;
    if (attestation.attestationHash !== hash) continue;
    if (ATTESTATION_BOUND_FIELDS.some((field) => !Object.hasOwn(attestation, field))) continue;
    if (typeof attestation.approver !== 'string' || attestation.approver.length === 0) continue;
    if (ATTESTATION_BOUND_FIELDS.slice(0, 4).some(
      (field) => typeof attestation[field] !== 'string' || attestation[field].length === 0,
    )) continue;
    const { attestationHash: _selfHash, ...rest } = attestation;
    if (internalDigest(rest) !== hash) continue;
    governing.push(attestation);
  }
  return governing;
}

/**
 * Findings R3-C2 and R4-C1 — this is the FIFTH round of the anchoring class, so the rule is
 * stated as a principle rather than as another special case.
 *
 * **Every identity is anchored by its OWN sealed provenance, and by nothing else.** Never by
 * membership in another identity's sealed set, never by a value the caller restates, never by
 * the evidence's own self-declaration, and never by an attestation nobody validated.
 *
 * Round 4 broke the previous rule because it anchored the bundle by `manifests.has(claimed) ||
 * attestations.has(claimed)` — set membership in two OTHER identities' sets. The manifest digest
 * and the tool-profile digest are PUBLIC derivable constants (the manifest is checked in; the
 * profile is the digest of six public tool names), so an attacker could compute both and simply
 * point `capabilityProofIndex.bundleHash` at one of them, or at a decoy attestation's hash.
 *
 * What an attacker CANNOT produce is an attestation document that hashes to a value the run
 * sealed. `capabilityAttestationHashes` is the only sealed input in the whole chain that a
 * genuine live canary run produces and a forger cannot: the digest covers the canary target,
 * the call-trace hashes, the proof window and the human approver. So:
 *
 * - `toolProfileHash` — its own sealed slot `providerToolProfileHash`, AND bound by a governing
 *   attestation. The sealed slot alone is a public constant; the attestation is what proves a
 *   canary actually ran against that profile.
 * - `capabilityManifestHash` — its own sealed slot `capabilityManifestHashes`, AND bound by a
 *   governing attestation, for the same reason.
 * - `bundleHash` — has NO sealed slot of its own, which is exactly what decision D3 says: the
 *   bundle is frozen TRANSITIVELY, through the immutable attestation that binds it. D3's
 *   transitivity is now actually EXERCISED instead of being asserted: the bundle identity must
 *   be the one carried INSIDE a governing attestation.
 *
 * One single attestation must bind all three, so the three identities cannot be assembled from
 * different proofs of different things.
 */
/**
 * ---- finding R7-C1: the anchoring half must arrive WITH ITS PROVENANCE -------------------
 *
 * Round 6 moved the trust root out of the record that carries the proof chain: the anchoring
 * fields now come from a separate, MAC-authenticated document that the provider configuration's
 * author cannot mint. That closed the SHIPPED composition root. It did not close this function,
 * nor `kernel.mjs`, because both still accepted whatever `analyzer.freezeInputs` returned with
 * no statement of how it was authenticated — so a library host supplying its own analyzer went
 * on sealing its own forgery and reaching `complete_full` through the real kernel.
 *
 * The anchoring fields are therefore no longer trusted because they are PRESENT. They are
 * trusted because a separate `frozenInputProvenance` says the host authenticated exactly these
 * anchors, and the kernel emits that token only after verifying a MAC keyed by the run's vault
 * key material. The token is bound to the anchors it authenticated by `anchorDigest`, so a
 * provenance minted for one anchor block can never license a different one.
 *
 * FAIL CLOSED, and NOT a quarantine: an unprovenanced run has honestly missing authentication,
 * not corrupt evidence. No anchoring means gate 2 fails, `INTERNAL_AUDIT_PROOF_UNANCHORED` is
 * named, and the run is capped at `complete_partial` — exactly the D11 treatment of frozen
 * inputs that seal nothing.
 */
export const FROZEN_INPUT_ANCHOR_FIELDS = Object.freeze([
  'providerToolProfileHash',
  'capabilityManifestHashes',
  'capabilityProofIndexHash',
  'capabilityReceiptHashes',
  'capabilityAttestationHashes',
  'capabilityProofExpiries',
]);

/**
 * The digest of EXACTLY the anchoring fields, and of nothing else. Own keys only, absent fields
 * pinned as `null`, so the digest is a total function of the anchor block and cannot be shifted
 * by any other frozen input, by key order, or by an inherited property.
 */
export function frozenInputAnchorDigest(frozenInputs) {
  if (!isRecord(frozenInputs)) return null;
  return sha256(Object.fromEntries(FROZEN_INPUT_ANCHOR_FIELDS.map((field) => [
    field,
    Object.hasOwn(frozenInputs, field) ? frozenInputs[field] : null,
  ])));
}

/** The one method this module accepts. A token that names another method authenticates nothing. */
const FROZEN_INPUT_PROVENANCE_METHOD = 'host_key_mac';

/**
 * Whether the anchoring half of `frozenInputs` was authenticated by the host, for THESE anchors.
 * Own-property reads throughout (finding I3: `typeof x.y` reads inherited properties, and
 * `Object.prototype.authenticated = true` must never authenticate anything).
 */
function anchorProvenanceAuthenticates(provenance, frozenInputs) {
  if (!isRecord(provenance)) return false;
  if (ownValue(provenance, 'authenticated') !== true) return false;
  if (ownValue(provenance, 'method') !== FROZEN_INPUT_PROVENANCE_METHOD) return false;
  const digest = frozenInputAnchorDigest(frozenInputs);
  if (typeof digest !== 'string' || digest.length === 0) return false;
  return ownValue(provenance, 'anchorDigest') === digest;
}

function sealedIdentityAnchors(
  frozenInputs,
  {
    proofChain = null,
    provenCapabilityIds = new Set(),
    evidenceGoverningHashes = null,
  } = {},
) {
  if (!isRecord(frozenInputs)) return null;
  const sealedString = (value) => (
    typeof value === 'string' && value.length > 0 ? value : null
  );
  const sealedSet = (value) => new Set(
    (Array.isArray(value) ? value : []).filter((entry) => sealedString(entry) !== null),
  );
  const toolProfile = sealedString(frozenInputs.providerToolProfileHash);
  const manifests = sealedSet(frozenInputs.capabilityManifestHashes);
  const attestationHashes = sealedSet(frozenInputs.capabilityAttestationHashes);
  // The PROOF-CHAIN digest namespace. These are digests OF THE PROOF, never identities of the
  // thing proved, and finding R4-C1's decoy variant turned exactly that confusion into a free
  // bundle identity: `bundleHash` was allowed to be any sealed attestation hash, including one
  // belonging to an attestation no receipt referenced and `attestationIsSound` never saw.
  const proofDigests = new Set([
    ...attestationHashes,
    ...sealedSet(frozenInputs.capabilityReceiptHashes),
    ...(sealedString(frozenInputs.capabilityProofIndexHash) === null
      ? []
      : [frozenInputs.capabilityProofIndexHash]),
  ]);
  /**
   * Finding R4-C1, round-5 close — SEALED ∩ ACCEPTED.
   *
   * `internalEvidence.governingAttestationHashes` is the set of attestation hashes the ADAPTER
   * actually accepted: documents whose self-omitting preimage it recomputed, each referenced by
   * an unexpired `live_runtime` receipt, each binding exactly the three identities the evidence
   * declares. Intersecting it with the run's SEALED `capabilityAttestationHashes` is what makes
   * anchoring provenance rather than slot discipline, and it needs no preimage HERE — the
   * preimage was verified where the document lives.
   *
   * The list itself is untrusted input like everything else on the artefact; it can only ever
   * SUBTRACT, because a hash that is not sealed contributes nothing and a sealed hash is one an
   * attacker cannot produce a document for.
   */
  const acceptedGoverning = new Set(
    (Array.isArray(evidenceGoverningHashes) ? evidenceGoverningHashes : [])
      .filter((entry) => sealedString(entry) !== null),
  );
  const sealedGoverning = new Set(
    [...acceptedGoverning].filter((hash) => attestationHashes.has(hash)),
  );
  // Frozen inputs that seal no profile, no manifest identity or no proof chain anchor nothing.
  // That is a fail-CLOSED state: the identities stay unanchored and the run stays Partial.
  const ready = toolProfile !== null && manifests.size > 0 && attestationHashes.size > 0;
  const chainSupplied = isRecord(proofChain);
  const governing = ready
    ? governingAttestations({
        proofChain,
        sealedAttestationHashes: attestationHashes,
        provenCapabilityIds,
      })
    : [];
  return {
    ready,
    governingCount: governing.length,
    sealedGoverningCount: sealedGoverning.size,
    anchorsIdentities(identities) {
      if (!ready) return false;
      const claimed = isRecord(identities) ? identities : {};
      const profile = sealedString(claimed.toolProfileHash);
      const manifest = sealedString(claimed.capabilityManifestHash);
      const bundle = sealedString(claimed.bundleHash);
      if (profile === null || manifest === null || bundle === null) return false;
      // 1. NAMESPACE. An identity may never be a proof-chain digest. This is the decoy killer:
      //    pointing `bundleHash` at a sealed attestation hash now anchors nothing at all.
      if (proofDigests.has(profile) || proofDigests.has(manifest) || proofDigests.has(bundle)) {
        return false;
      }
      // 2. OWN SLOT. Each identity is matched against the sealed slot that names it, and every
      //    identity must consume a DISTINCT sealed value. Round 4's headline attack set
      //    `capabilityProofIndex.bundleHash = MANIFEST_HASH`, so one sealed digest anchored two
      //    different identities; a value that is already another identity anchors nothing.
      if (profile !== toolProfile) return false;
      if (!manifests.has(manifest)) return false;
      if (!manifests.has(bundle)) return false;
      if (bundle === manifest || bundle === profile || manifest === profile) return false;
      // 3. SEALED PROVENANCE — UNCONDITIONAL, and this is the layer that decides.
      //
      //    Round 4 left this layer conditional on the caller happening to hand the proof-chain
      //    DOCUMENT to the gate, so an attacker who knew the three honest identity digests —
      //    all public: the manifest is checked in, the tool profile is the digest of six public
      //    tool names, the bundle is a build artefact an honest operator seals — could mint a
      //    chain binding exactly those, supply NO document, satisfy layers 1 and 2, and anchor.
      //    Slot discipline is not proof that a canary ran.
      //
      //    The preimage relation is now checked where the document actually lives, in the
      //    adapter, and arrives here as the hashes it ACCEPTED. At least one of them must be a
      //    hash the run SEALED. An attacker can mint an attestation, but its hash is then a
      //    value the run never sealed; and an attestation whose hash the run DID seal cannot
      //    have been minted by them, because producing a preimage for a sealed digest is a
      //    second-preimage attack on SHA-256. The sealed attestation digest is the one value in
      //    this whole chain that only a genuine live canary produces and an outsider cannot
      //    compute — it covers the canary target, the call traces, the proof window and the
      //    human approver.
      //
      //    All three identities are anchored by that single intersection, and legitimately so:
      //    the adapter admits a hash here only when `attestationIsSound` verified the document
      //    against `pins` — the very `toolProfileHash`, `capabilityManifestHash` and
      //    `bundleHash` the evidence declares and layer 2 has just matched to their own sealed
      //    slots. One attestation therefore binds the whole triple, so the three identities can
      //    never be assembled from different proofs of different things.
      if (sealedGoverning.size === 0) return false;
      //    When the caller ALSO supplies the document, it is held to the stronger reading: the
      //    document must independently produce a governing attestation that is sealed, adapter
      //    accepted, and binds all three claimed identities. Offering the document and having
      //    it rejected is worse evidence than offering nothing.
      if (chainSupplied || governing.length > 0) {
        return governing.some((attestation) => (
          sealedGoverning.has(attestation.attestationHash)
          && attestation.toolProfileHash === profile
          && attestation.capabilityManifestHash === manifest
          && attestation.bundleHash === bundle
        ));
      }
      return sealedGoverning.size > 0;
    },
  };
}

/**
 * Derives the publication status ONCE, from validated machine data. Missing but trustworthy
 * evidence degrades to `complete_partial`; integrity failures quarantine. `blocked`, `failed`
 * and `quarantined` publish nothing.
 */
export async function evaluateFullEligibility({
  internalEvidence = null,
  merge = null,
  trace = null,
  claimSupport = null,
  privacyScan = null,
  verification = null,
  requiredWindows = null,
  expected = null,
  frozenInputs = null,
  // Finding R7-C1. How the anchoring half of `frozenInputs` was authenticated. The kernel emits
  // this only after verifying a host MAC keyed by the run's vault key material. Absent — every
  // caller that supplies no provenance, including a library host running its own analyzer — is
  // UNKNOWN, and unknown anchors anchor nothing.
  frozenInputProvenance = null,
  run = null,
} = {}) {
  const identities = isRecord(expected) ? expected : {};
  const expectedLocationId = typeof identities.locationId === 'string'
    ? identities.locationId
    : null;
  const internalPresent = isRecord(internalEvidence);
  const coverageRows = coverageRowsOf(internalEvidence);
  const unprovenCapabilities = sortedUnique(coverageRows
    .filter((row) => row.proven !== true || row.proofClass !== 'live_runtime')
    .map((row) => row.capabilityId));
  // Finding R3-I2: a receipt proves a capability WORKS, not that this run USED it. Gate 8
  // filtered on `proven`/`proofClass` only, so a published claim could rest on a capability the
  // run never exercised — evidence that was never collected. A capability supports a claim only
  // when it is KNOWN to this run's coverage ledger, proven live, AND actually exercised; an id
  // that appears in no coverage row at all is unknown applicability and supports nothing
  // (`unprovenCapabilities.includes(id)` was vacuously false for it).
  const supportingCapabilities = new Set(coverageRows
    .filter((row) => (
      row.proven === true
      && row.proofClass === 'live_runtime'
      && row.exercised === true
      && typeof row.capabilityId === 'string'
      && row.capabilityId.length > 0
    ))
    .map((row) => row.capabilityId));
  const unexercisedCapabilities = sortedUnique(coverageRows
    .filter((row) => row.exercised !== true)
    .map((row) => row.capabilityId));
  const supportRows = Array.isArray(claimSupport) ? claimSupport.filter(isRecord) : [];
  const blockedClaims = sortedUnique(supportRows
    .filter((row) => {
      const dependencies = Array.isArray(row.dependsOnCapabilityIds)
        ? row.dependsOnCapabilityIds.filter((id) => typeof id === 'string' && id.length > 0)
        : [];
      // Finding R2-M2: `.some()` over an EMPTY dependency list is vacuously false, so gate 8
      // could never block a claim that declared no dependencies at all. A claim that names no
      // supporting capability cannot be verified as supported: fail closed.
      if (dependencies.length === 0) return true;
      return !dependencies.every((id) => supportingCapabilities.has(id));
    })
    .map((row) => row.claimId));
  const unsupportedClaims = sortedUnique(supportRows
    .filter((row) => row.support !== 'direct_evidence')
    .map((row) => row.claimId));
  const mergeLimitations = Array.isArray(merge?.limitations)
    ? merge.limitations.map((entry) => (typeof entry === 'string' ? entry : entry?.code))
      .filter((code) => typeof code === 'string')
    : [];

  const workflows = Array.isArray(internalEvidence?.workflows) ? internalEvidence.workflows : [];
  const roster = internalEvidence?.workflowRoster;

  // ---- finding C1: the PUBLIC rail is a first-class gate input ---------------
  // The merge product is the only place where the public rail's own location, pagination,
  // completeness and reconciliation verdicts live. Gate 1 could previously be satisfied with
  // absent, malformed or incomplete public evidence because it read only internal coverage,
  // and gate 5 checked exactly one of the merge's limitation codes.
  const mergePresent = isRecord(merge);
  const mergeComplete = mergePresent && merge.status === 'COMPLETE';
  const railsClean = mergePresent
    && !mergeLimitations.some((code) => RAIL_BLOCKING_LIMITATIONS.includes(code));
  const publicRailComplete = mergeComplete && railsClean;

  // ---- controller decision D11: the SEALED frozen inputs are the ONLY anchor -------------
  // Decision D7 accepted two other channels — the adapter's `capabilityProofAnchor` pin flags,
  // and a caller-supplied `expected.<hash>` restatement compared against the evidence's OWN
  // self-declared identity field. Finding R3-C2 showed both are circular: they are minted by
  // the same actor (in the shipped composition root, the same configuration record) as the
  // proof index they would be vouching for, so a wholly self-minted chain reached
  // `complete_full` with no live canary. BOTH CHANNELS ARE REMOVED, not merely out-ranked: a
  // library host calling this function directly gets the same rule the kernel does.
  //
  // `frozenInputs` is therefore the only thing that can anchor an identity. Called without it
  // — absent, null, or sealing nothing — NO identity is anchored, gate 2 fails, and the run
  // degrades to `complete_partial` with `INTERNAL_AUDIT_PROOF_UNANCHORED`. That is fail-closed.
  // `expected.<hash>` survives only as a MISMATCH discriminator (`identityMismatch` below),
  // where disagreeing with the caller quarantines but agreeing proves nothing.
  //
  // Finding R4-C1: the proof-chain DOCUMENT is now read here as well, and it is untrusted on
  // purpose. It never decides anything — it supplies the attestation preimage that the sealed
  // `capabilityAttestationHashes` is a commitment to. Restating a public digest still proves
  // nothing; producing a document that hashes to a sealed attestation hash cannot be done
  // without the attestation a genuine live canary run produced.
  //
  // Finding R7-C1: and the sealed inputs anchor only when the HOST says it authenticated them.
  // `freezeInputs` is an injected function — in a library host, code the same actor may have
  // written — so an anchor block that arrives with no provenance is a claim, not a seal. The
  // anchors are handed to `sealedIdentityAnchors` only when the provenance token authenticates
  // exactly this anchor block; otherwise NOTHING is anchored and gate 2 fails closed.
  const anchorProvenanced = anchorProvenanceAuthenticates(frozenInputProvenance, frozenInputs);
  const sealed = !anchorProvenanced ? null : sealedIdentityAnchors(frozenInputs, {
    proofChain: isRecord(identities.capabilityProofIndex)
      ? identities.capabilityProofIndex
      : null,
    provenCapabilityIds: supportingCapabilities,
    // Finding R4-C1, round-5 close: the attestations the ADAPTER accepted after verifying their
    // preimage. Anchoring is now the intersection of that set with the run's sealed
    // `capabilityAttestationHashes`, so withholding the document no longer waives layer 3.
    evidenceGoverningHashes: internalPresent
      ? internalEvidence.governingAttestationHashes
      : null,
  });
  const proofAnchored = internalPresent
    && sealed !== null
    && sealed.anchorsIdentities({
      toolProfileHash: internalEvidence.toolProfileHash,
      capabilityManifestHash: internalEvidence.capabilityManifestHash,
      bundleHash: internalEvidence.bundleHash,
    });

  const traceInspection = inspectReadOnlyTrace(trace, expectedLocationId);

  // ---- quarantine discriminators, computed BEFORE the gates ----------------
  // Finding R2-I4: these used to quarantine while every gate still reported `passed`, which
  // produced `{status:'quarantined', eligible:false, failedGates:[]}` — a decision the
  // publication guard then rejected as structurally inconsistent and silently PUBLISHED past.
  // An identity mismatch is a receipt-chain failure (gate 2); a location mismatch is a
  // reconciliation failure (gate 5). Both are now real failed gates as well as quarantines.
  const identityMismatch = internalPresent && (
    typeof identities.contractVersion === 'string'
      && internalEvidence.contractVersion !== identities.contractVersion
    || typeof identities.toolProfileHash === 'string'
      && internalEvidence.toolProfileHash !== identities.toolProfileHash
    || typeof identities.capabilityManifestHash === 'string'
      && internalEvidence.capabilityManifestHash !== identities.capabilityManifestHash
    || typeof identities.bundleHash === 'string'
      && internalEvidence.bundleHash !== identities.bundleHash
  );
  const locationMismatch = internalPresent
    && expectedLocationId !== null
    && internalEvidence.boundLocationId !== expectedLocationId;

  const passed = {
    capability_coverage: internalPresent
      && coverageRows.length > 0
      && coverageRows.every((row) => row.applicable === true)
      // An empty exercise ledger proves nothing: at least one capability must have been used.
      && coverageRows.some((row) => row.exercised === true)
      && windowsCovered(internalEvidence, requiredWindows)
      && publicRailComplete,
    live_runtime_receipts: internalPresent
      && coverageRows.length > 0
      && unprovenCapabilities.length === 0
      && proofAnchored
      && !identityMismatch,
    workflow_roster_and_coverage: internalPresent
      && isRecord(roster)
      && roster.complete === true
      && roster.sealed === true
      && workflows.length > 0
      && workflows.every((entry) => entry?.complete === true)
      // Finding R2-C2: the sealed roster is the denominator. Every roster member must have
      // been read; an excluded or unread member can never be counted as covered.
      && rosterCoverageReconciles(roster, workflows),
    ai_discovery_and_details: internalPresent
      && internalEvidence.aiConfiguration?.complete === true,
    reconciliation: internalPresent
      && internalEvidence.complete === true
      && mergeComplete
      && railsClean
      && !locationMismatch,
    snapshot_skew: mergePresent
      && merge.skew?.withinPolicy === true
      && Number.isFinite(merge.skew?.observedMs),
    read_only_trace: traceInspection.clean,
    claim_support: supportRows.length > 0
      && Array.isArray(claimSupport)
      && supportRows.length === claimSupport.length
      && supportRows.every((row) => typeof row.claimId === 'string' && row.claimId.length > 0)
      && unsupportedClaims.length === 0
      && blockedClaims.length === 0,
    privacy_scan: isRecord(privacyScan) && privacyScan.passed === true,
    verifier: isRecord(verification) && verification.passed === true,
  };

  const gates = FULL_ELIGIBILITY_GATES.map((id) => ({ id, passed: passed[id] === true }));
  const failedGates = gates.filter((gate) => !gate.passed).map((gate) => gate.id);

  // ---- quarantine discriminators -----------------------------------------
  // Trustworthy MISSING evidence is Partial. These are integrity failures.
  // A check that was never RUN is trustworthy missing evidence (Partial). Only a check that
  // ran and FAILED is an integrity failure (quarantine).
  const quarantined = traceInspection.violation
    || isRecord(privacyScan) && privacyScan.passed !== true // decision D4
    || isRecord(verification) && verification.passed !== true
    || merge?.status === 'QUARANTINED'
    || identityMismatch
    || locationMismatch;

  const status = quarantined
    ? 'quarantined'
    : failedGates.length === 0
      ? 'complete_full'
      : 'complete_partial';
  const eligible = status === 'complete_full';

  // ---- limitations, each NAMING what it blocks -----------------------------
  const limitations = [];
  const addLimitation = (code, capabilityIds = [], claimIds = []) => {
    if (limitations.some((entry) => entry.code === code)) return;
    limitations.push({ code, capabilityIds: [...capabilityIds], claimIds: [...claimIds] });
  };
  if (!passed.live_runtime_receipts && unprovenCapabilities.length > 0) {
    addLimitation('INTERNAL_AUDIT_CAPABILITY_UNPROVEN', unprovenCapabilities, blockedClaims);
  }
  if (!passed.capability_coverage) {
    addLimitation('CAPABILITY_COVERAGE_INCOMPLETE', unprovenCapabilities, []);
  }
  if (internalPresent && !proofAnchored) {
    addLimitation('INTERNAL_AUDIT_PROOF_UNANCHORED', [], []);
  }
  if (!internalPresent || !passed.workflow_roster_and_coverage) {
    for (const code of INTERNAL_LIMITATIONS) addLimitation(code, [], []);
  }
  if (!passed.ai_discovery_and_details) addLimitation('INTERNAL_AUDIT_AI_INCOMPLETE', [], []);
  if (!passed.reconciliation) addLimitation('INTERNAL_AUDIT_RECONCILIATION_INCOMPLETE', [], []);
  if (!passed.snapshot_skew) addLimitation(SNAPSHOT_SKEW, [], []);
  if (!passed.read_only_trace) addLimitation('INTERNAL_AUDIT_READ_ONLY_VIOLATION', [], []);
  if (!passed.claim_support) {
    // Finding R3-I2: the limitation NAMES the capabilities that failed to support the claims —
    // unproven ones and, now, ones this run never exercised.
    addLimitation(
      'CLAIM_SUPPORT_INSUFFICIENT',
      sortedUnique([...unprovenCapabilities, ...unexercisedCapabilities]),
      sortedUnique([...unsupportedClaims, ...blockedClaims]),
    );
  }
  if (!passed.privacy_scan) {
    addLimitation(
      typeof privacyScan?.code === 'string' ? privacyScan.code : 'PUBLICATION_NOT_SANITIZED',
      [],
      [],
    );
  }
  if (!passed.verifier) {
    addLimitation(
      typeof verification?.code === 'string' ? verification.code : 'AUDIT_VERIFY_FAILED',
      [],
      [],
    );
  }
  if (identityMismatch) addLimitation('INTERNAL_AUDIT_MANIFEST_INVALID', [], []);
  if (locationMismatch) addLimitation('INTERNAL_AUDIT_LOCATION_MISMATCH', [], []);
  for (const code of mergeLimitations) addLimitation(code, [], []);

  const publishes = status === 'complete_full' || status === 'complete_partial';
  const binding = isRecord(run) ? run : {};
  // Finding R2-M1: the run binding is ALL OR NOTHING. A half-named run (an id with no
  // frozen-inputs hash, or the reverse) is not a run any caller can confirm, so it is never
  // retained as a partial binding — the decision is minted WHOLLY unbound instead, and a
  // wholly unbound decision can never lift the public-only clamp
  // (`validateFullEligibilityDecision`). Empty strings are not names either.
  const boundRunId = typeof binding.runId === 'string' && binding.runId.length > 0
    ? binding.runId
    : null;
  const boundInputsHash = typeof binding.frozenInputsHash === 'string'
    && binding.frozenInputsHash.length > 0
    ? binding.frozenInputsHash
    : null;
  const runBound = boundRunId !== null && boundInputsHash !== null;
  return deepFreeze({
    status,
    eligible,
    // Finding I3: the decision now NAMES the run and the frozen inputs it describes, so a
    // decision minted for one run can be refused by another.
    runId: runBound ? boundRunId : null,
    frozenInputsHash: runBound ? boundInputsHash : null,
    gates,
    failedGates,
    limitations,
    publishesFindings: publishes,
    publishesSolutionPacks: publishes,
  });
}
