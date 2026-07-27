/**
 * THE THIN INTERNAL ADAPTER.
 *
 * `lib/adapters/internal-ghl.mjs` is 3,065 lines to call an MCP server, and most of them are not
 * about reading a workflow. They are capability attestations, proof pins, authorized target
 * hashes, manifest bundle verification and forbidden-surface scanning: machinery specified to
 * defend against an attacker who controls the provider configuration. In this deployment the
 * person who controls the provider configuration is the operator. It guards against us.
 *
 * That module is left in place, untouched and unused by this one. This is the replacement for the
 * Grom-internal case, and it does the four things that genuinely matter:
 *
 *  1. Call the plugin's READ-ONLY audit server for the roster, the definitions and the runtime
 *     window (see `internal-audit-session.mjs`, which will launch no other artefact).
 *  2. Refuse anything that came back bound to a different sub-account. Mixing two clients' data is
 *     the one unrecoverable mistake this tool could make.
 *  3. Keep names, emails, phone numbers and message bodies out of anything written down.
 *  4. Speak the CURRENT contract, per tool, with every fact below observed from the real server
 *     rather than read off its source.
 *
 * ---------------------------------------------------------------------------------------------
 * OBSERVED FROM THE REAL AUDIT SERVER ON 2026-07-27. Every one of these was verified by calling
 * it, because a spec written from a producer's source rather than its real output has already
 * shipped a validator on this project that failed every honest run.
 *
 * A. `isError` IS NOT THE FAILURE CHANNEL. A refused call answers MCP-level success with
 *    `isError: false` and puts the refusal in the BODY as `{ok: false, code, detail, remediation}`.
 *    An adapter that branched on `isError` would read a refusal as a good read. The body's `ok` is
 *    the only channel, and `ok !== true` is a failure even when `isError` is false.
 *
 * B. `pageSize`, `maxLogPartitions` and `minPartitionMs` are REFUSED, not ignored:
 *    `{ok: false, code: 'VALIDATION_FAILED'}`. The replacements are `logPageSize` and
 *    `maxLogPages`. This module sends only names the server's own schema declares.
 *
 * C. AN EXPIRED CREDENTIAL LATCHES THE SHARED CIRCUIT. Observed directly: one call on a dead
 *    token returned `TRANSPORT_FAILED`, and the very next call on a different tool returned
 *    `CIRCUIT_OPEN`. Nothing auto-retries after a latch. So this module PREFLIGHTS `auth_status`,
 *    which makes no request at all, and refuses to spend anything on a credential that has already
 *    expired. Without that, a stale token burns the run and reports a transport fault instead of
 *    the truth, which is that nobody logged in.
 *
 * D. The contract version is PER TOOL, not per server. `get_workflow_runtime_window` answers
 *    `2.0.0`; `get_ai_configuration_bundle` still answers `1.0.0`. A single supported-versions
 *    list, which is what the old adapter has, is necessarily wrong about one of them.
 * ---------------------------------------------------------------------------------------------
 *
 * WHAT IS DELIBERATELY NOT VALIDATED. The success bodies of the three composites have not been
 * seen yet, because that needs a live credential. This module therefore checks only fields it has
 * proof of and passes the rest through untouched, rather than asserting a shape grammar copied out
 * of documentation. `assertSeenSuccessShape` is the single place that changes when the first live
 * reply arrives, and it is marked.
 */
import { codedError } from './collection.mjs';

/**
 * THE CONTRACT VERSION EACH TOOL IS EXPECTED TO ANSWER, as DATA.
 *
 * Derived from the server's own exported constants (`RUNTIME_WINDOW_CONTRACT_VERSION`,
 * `AUDIT_CONFIGURATION_CONTRACT_VERSION`), which is the right place to take an enum from: a
 * constant in the producer cannot drift from what the producer sends the way a hand-written shape
 * grammar can. A tool absent from this table carries no contract and is not version-checked.
 */
export const EXPECTED_CONTRACT_VERSIONS = Object.freeze({
  get_ai_configuration_bundle: '1.0.0',
  get_workflow_runtime_window: '2.0.0',
  list_workflows_complete: null,
});

/**
 * Codes that mean STOP, not RETRY. Observed: the rail never auto-retries after a latch, and a
 * `CIRCUIT_OPEN` carries the reads already completed on `error.partial`, so continuing to call is
 * pure waste that also destroys the partial.
 */
export const LATCHING_CODES = Object.freeze(new Set([
  'AUTH_REJECTED',
  'CIRCUIT_OPEN',
  'RATE_LIMITED',
  'TRANSPORT_FAILED',
]));

/**
 * ---------------------------------------------------------------------------------------------
 * WHY THIS IS TWO LISTS AND A CONTEXT TEST, RATHER THAN ONE LIST OF KEY NAMES.
 *
 * The first version of this was a single deny list containing `name`, and the first live read
 * proved it the wrong KIND of check: it redacted all 27 WORKFLOW NAMES. A workflow name is a
 * business label the detectors have to read -- "this nurture never asks a human to step in" is not
 * a sentence you can write about `[redacted]` -- while a contact's name is exactly what must never
 * be written down. The same field name means different things on different records, so no list
 * keyed on the name alone can be right about both.
 *
 * So the decision comes from the RECORD's own shape:
 *
 *   ALWAYS_PERSONAL          unambiguous on any record. `email`, `phone`, `firstName`, an address.
 *   PERSONAL_IN_PERSON_RECORD  ambiguous, and redacted only when the enclosing record carries a
 *                            person marker. `name`, `title`, `city`, `companyName`.
 *   PERSON_MARKERS           what makes a record a person: `email`, `phone`, `contactId`,
 *                            `contactName`, `firstName`, `lastName`, `fullName`, `dateOfBirth`.
 *
 * A workflow record carries `locationId`, `status`, `version` and no person marker, so its `name`
 * survives. An appointment carries `contactId`, so its `title` ("<person> and GROM Digital") does
 * not. An enrollment row carries `contactId`, so its `name` does not.
 *
 * Two compensating controls remain, because a context test can be fooled by a record shape nobody
 * anticipated: any STRING that looks like an email, an international phone number, a URL or a
 * bearer credential is redacted wherever it appears whatever its key, and a personal SUBTREE goes
 * whole rather than leaf by leaf.
 * ---------------------------------------------------------------------------------------------
 */
const ALWAYS_PERSONAL = Object.freeze(new Set([
  'additionalemails',
  'additionalphones',
  'address',
  'dateofbirth',
  'email',
  'firstname',
  'firstnamelowercase',
  'fullname',
  'lastmessagebody',
  'lastname',
  'lastnamelowercase',
  'phone',
  'phonelabel',
  'postalcode',
]));
const PERSONAL_IN_PERSON_RECORD = Object.freeze(new Set([
  'city',
  'companyname',
  'contactname',
  'name',
  'state',
  'title',
  'website',
]));
const PERSON_MARKERS = Object.freeze(new Set([
  'contactid',
  'contactname',
  'dateofbirth',
  'email',
  'firstname',
  'fullname',
  'lastname',
  'phone',
]));

/** An email, an international phone number, a URL, or a bearer credential, anywhere. */
const PERSONAL_PATTERN = /(?:[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|\+\d[\d\s().-]{7,}\d|https?:\/\/|Bearer\s+\S+)/iu;

const REDACTED = '[redacted]';

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function normalizeKey(key) {
  return String(key).toLowerCase().replaceAll(/[^a-z]/gu, '');
}

/**
 * Replace personal values with a marker, in place of a copy, and never DROP the key: a missing key
 * and a redacted one mean different things, and a detector that cannot tell "this contact has no
 * email" from "we refused to write the email down" would report a data-quality defect that is not
 * there.
 */
/** Does this record identify a PERSON? Decided from its own field names, not from where it sits. */
function looksLikePersonRecord(record) {
  if (!isPlainObject(record)) return false;
  return Object.keys(record).some((key) => PERSON_MARKERS.has(normalizeKey(key)));
}

export function scrubPersonal(value, key = '', seen = new WeakSet(), inPersonRecord = false) {
  const normalized = normalizeKey(key);
  const personal = ALWAYS_PERSONAL.has(normalized)
    || (inPersonRecord && PERSONAL_IN_PERSON_RECORD.has(normalized));
  if (typeof value === 'string') {
    if (personal || PERSONAL_PATTERN.test(value)) return REDACTED;
    return value;
  }
  if (value === null || ['number', 'boolean'].includes(typeof value)) return value;
  if (typeof value === 'bigint') return value.toString();
  if (!value || typeof value !== 'object') return null;
  if (seen.has(value)) throw codedError('INTERNAL_AUDIT_RESPONSE_CYCLE');
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      // The KEY and the person context both travel into the elements, so
      // `additionalEmails: ["a@b.c"]` is redacted by name and not only by the pattern below it,
      // and a list of contact rows is judged row by row on its own shape.
      return value.map((entry) => scrubPersonal(entry, key, seen, inPersonRecord));
    }
    if (personal) return REDACTED;
    // A record decides for its OWN children, and the flag does not travel back up. A workflow
    // holding a list of enrollments does not become a person record, and an enrollment inside it
    // does not stop being one.
    const childContext = looksLikePersonRecord(value);
    return Object.fromEntries(
      Object.entries(value).map(([childKey, child]) => [
        childKey,
        scrubPersonal(child, childKey, seen, childContext),
      ]),
    );
  } finally {
    seen.delete(value);
  }
}

/**
 * Unwrap one tool reply into the server's own envelope.
 *
 * Observation A above lives here. `isError` is read, because an MCP-level error is still an error,
 * but it is NOT the discriminator: the body's `ok` is, and a body that carries no `ok` at all is a
 * shape this adapter does not understand and refuses rather than guesses at.
 */
export function readEnvelope(reply) {
  if (reply?.isError === true) throw codedError('INTERNAL_AUDIT_TOOL_ERROR');
  let body = reply?.structuredContent;
  if (body === undefined) {
    const text = reply?.content?.[0]?.text;
    if (typeof text !== 'string') throw codedError('INTERNAL_AUDIT_RESPONSE_UNREADABLE');
    try {
      body = JSON.parse(text);
    } catch {
      throw codedError('INTERNAL_AUDIT_RESPONSE_UNREADABLE');
    }
  }
  if (!isPlainObject(body) || !Object.hasOwn(body, 'ok')) {
    throw codedError('INTERNAL_AUDIT_RESPONSE_UNREADABLE');
  }
  return body;
}

/**
 * A refusal, as its own value rather than a throw.
 *
 * A read that failed is EVIDENCE — "we could not see this surface, and here is the code for why" —
 * and turning it into an exception is how a partial result becomes a dead run. Only `detail` and
 * `remediation` are dropped, because the server echoes request context into them and this value
 * reaches the publication boundary.
 */
function refusal(tool, body) {
  return Object.freeze({
    tool,
    ok: false,
    code: typeof body.code === 'string' ? body.code : 'INTERNAL_AUDIT_CODE_MISSING',
    latching: LATCHING_CODES.has(body.code),
    data: null,
  });
}

/**
 * What a SUCCESS reply must satisfy, now written from real replies rather than from documentation.
 *
 * OBSERVED 2026-07-27, first live internal read: the envelope is `{ok, data}` and EVERYTHING is
 * under `data`. `contractVersion` and `boundLocationId` are `data.contractVersion` and
 * `data.boundLocationId`, not top-level. The first version of this checked the top level only and
 * threw `INTERNAL_AUDIT_CONTRACT_MISMATCH` on a perfectly good reply -- which is the same failure
 * mode, in the same place, as the specs written from a producer's source that have already cost
 * this project a day. Both levels are now read, and the top level is kept because it costs nothing
 * and a differently-shaped server would still be understood.
 *
 * `list_workflows_complete` genuinely carries NO `contractVersion`, which is why its entry in the
 * table above is `null` rather than a version. Confirmed against the live reply.
 *
 * Still deliberately unasserted: the rest of the bodies. Extra fields pass through and fields
 * nothing reads may be missing, because a shape grammar over 25 keys would fail an honest run the
 * first time the server added one.
 */
function contractVersionOf(body) {
  if (typeof body.contractVersion === 'string') return body.contractVersion;
  if (isPlainObject(body.data) && typeof body.data.contractVersion === 'string') {
    return body.data.contractVersion;
  }
  return null;
}

function assertSeenSuccessShape(tool, body, expectedLocationId) {
  const expectedContract = EXPECTED_CONTRACT_VERSIONS[tool];
  if (expectedContract !== null && expectedContract !== undefined) {
    if (contractVersionOf(body) !== expectedContract) {
      throw codedError('INTERNAL_AUDIT_CONTRACT_MISMATCH');
    }
  }
  // The one unrecoverable mistake. Wherever the reply names a location, it must be OUR location.
  for (const record of [body, body.data]) {
    if (!isPlainObject(record)) continue;
    if (
      Object.hasOwn(record, 'boundLocationId')
      && record.boundLocationId !== expectedLocationId
    ) throw codedError('INTERNAL_AUDIT_LOCATION_MISMATCH');
  }
}

/**
 * The adapter.
 *
 * `client` is the minimal `{listTools, callTool, close}` surface `createInternalAuditConnect`
 * returns, or any host-owned equivalent. Nothing here constructs a transport, resolves a
 * credential or reads the filesystem.
 */
export function createInternalAuditAdapter({
  client,
  expectedLocationId,
  // Minimum credential life a run needs before it is worth starting. A token that expires
  // mid-run latches the circuit and destroys the partial, so this is not politeness.
  minimumCredentialSeconds = 300,
} = {}) {
  if (!client || typeof client.callTool !== 'function') {
    throw codedError('INTERNAL_AUDIT_CLIENT_INVALID', TypeError);
  }
  if (typeof expectedLocationId !== 'string' || expectedLocationId.length === 0) {
    throw codedError('INTERNAL_AUDIT_LOCATION_UNBOUND', TypeError);
  }

  /** Set the moment any latching code is seen. Nothing is spent after that. */
  let latched = null;

  async function call(tool, args) {
    if (latched !== null) return Object.freeze({ tool, ok: false, code: latched, latching: true, data: null });
    const body = readEnvelope(await client.callTool({ name: tool, arguments: args }));
    if (body.ok !== true) {
      const result = refusal(tool, body);
      if (result.latching) latched = result.code;
      return result;
    }
    assertSeenSuccessShape(tool, body, expectedLocationId);
    return Object.freeze({
      tool,
      ok: true,
      code: null,
      latching: false,
      // Scrubbed at the boundary, once, so no later caller has to remember to do it.
      data: scrubPersonal(body),
    });
  }

  return {
    /**
     * PREFLIGHT. Observation C: this makes no request, so it costs nothing, and it is the
     * difference between "nobody is logged in" and a run that reports a transport fault.
     */
    async credentialState() {
      const body = readEnvelope(await client.callTool({ name: 'auth_status', arguments: {} }));
      if (body.ok !== true) return Object.freeze({ usable: false, reason: 'AUTH_STATUS_UNAVAILABLE' });
      const jwt = body.data?.jwtClaims ?? {};
      const tokenId = body.data?.tokenIdClaims ?? {};
      const remaining = Number(jwt.secondsRemaining);
      if (jwt.present !== true) return Object.freeze({ usable: false, reason: 'CREDENTIAL_ABSENT' });
      if (!Number.isFinite(remaining) || remaining < minimumCredentialSeconds) {
        return Object.freeze({
          usable: false,
          reason: remaining < 0 ? 'CREDENTIAL_EXPIRED' : 'CREDENTIAL_EXPIRING',
          secondsRemaining: Number.isFinite(remaining) ? Math.floor(remaining) : null,
        });
      }
      return Object.freeze({
        usable: true,
        reason: null,
        secondsRemaining: Math.floor(remaining),
        // The AI surfaces additionally need the elevated agency-admin token-id, which expires
        // independently. Reported separately so a run can honestly skip that surface alone
        // instead of failing whole or claiming an empty agent list.
        agencyTokenUsable: tokenId.present === true
          && Number(tokenId.secondsRemaining) >= minimumCredentialSeconds,
      });
    },

    /** The whole workflow roster, walked to a reconciled terminal proof by the server. */
    async roster({ pageSize, maxPages } = {}) {
      return call('list_workflows_complete', {
        locationId: expectedLocationId,
        ...(pageSize === undefined ? {} : { pageSize }),
        ...(maxPages === undefined ? {} : { maxPages }),
      });
    },

    /** One workflow's configuration. */
    async definition(workflowId) {
      return call('get_workflow', { locationId: expectedLocationId, workflowId });
    },

    /** One workflow's exported form, which is what carries the step graph. */
    async exported(workflowId) {
      return call('export_workflow', { locationId: expectedLocationId, workflowId });
    },

    /**
     * One workflow's runtime window. Observation B: `logPageSize` and `maxLogPages`, never the
     * three retired names, and the window is half-open so `fromDate` must be strictly less than
     * `toDate` or the server refuses it before building a gateway.
     */
    async runtimeWindow({
      workflowId,
      fromDate,
      toDate,
      eventTypes,
      stepIds,
      logPageSize,
      maxLogPages,
      maxLogRetries,
      maxEnrollmentPages,
      maxStepRosterPages,
    } = {}) {
      if (!Number.isInteger(fromDate) || !Number.isInteger(toDate) || fromDate >= toDate) {
        throw codedError('INTERNAL_AUDIT_WINDOW_INVALID', TypeError);
      }
      return call('get_workflow_runtime_window', {
        locationId: expectedLocationId,
        workflowId,
        fromDate,
        toDate,
        ...(eventTypes === undefined ? {} : { eventTypes }),
        ...(stepIds === undefined ? {} : { stepIds }),
        ...(logPageSize === undefined ? {} : { logPageSize }),
        ...(maxLogPages === undefined ? {} : { maxLogPages }),
        ...(maxLogRetries === undefined ? {} : { maxLogRetries }),
        ...(maxEnrollmentPages === undefined ? {} : { maxEnrollmentPages }),
        ...(maxStepRosterPages === undefined ? {} : { maxStepRosterPages }),
      });
    },

    /** Conversation AI, Voice AI and Agent Studio. Needs the elevated token-id. */
    async aiBundle({ companyId, maxPages } = {}) {
      return call('get_ai_configuration_bundle', {
        locationId: expectedLocationId,
        ...(companyId === undefined ? {} : { companyId }),
        ...(maxPages === undefined ? {} : { maxPages }),
      });
    },

    /** Has anything latched, and on what. Read by a caller deciding whether to keep going. */
    latchedCode() {
      return latched;
    },
  };
}
