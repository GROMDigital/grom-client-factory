/**
 * THE INTERNAL COLLECTION, as one weekly phase.
 *
 * `collectInternalEvidencePhase` (`lib/modes/weekly.mjs:973`) asks its adapter for exactly one
 * thing: `collectAuditEvidence({target, window, applicability, stepRosterRequests, signal})`. This
 * module is that method, built on the thin adapter in `internal-audit.mjs`.
 *
 * ---------------------------------------------------------------------------------------------
 * WHY DEFINITIONS FOR EVERY WORKFLOW AND RUNTIME WINDOWS FOR ONLY A FEW.
 *
 * The point of this rail is defect detection, and the defect catalog it serves is overwhelmingly
 * about CONFIGURATION: a branch that exits on a tag nothing sets, a nurture that never creates a
 * task for a human, a wait step with no timezone, two workflows that hand off to each other with
 * `allowMultiple: false` on the return leg. All of that is in the definition, which costs one
 * cheap call per workflow.
 *
 * A runtime window is a different animal. It walks execution logs by cursor, an enrollment list
 * and per-step rosters, and its own budgets default to 200 pages EACH. On an account with 40
 * workflows, asking for all of them unprompted would be thousands of requests to answer questions
 * only a handful of rules ask. So runtime is opt-in per workflow, bounded, and the workflows that
 * did not get one say so rather than reading as having no runtime.
 *
 * THE HONEST CONSEQUENCE, stated rather than engineered around: `capabilityCoverage` is EMPTY.
 * The plugin's own documentation says the audit composites have never been run live and no
 * capability receipt exists, and the kernel machine-enforces "no receipt, no Full audit". So a run
 * on this rail is `complete_partial` by design. That is correct. For an internal tool the Full
 * designation is compliance ceremony, and the findings are produced either way. Manufacturing a
 * coverage row here to satisfy the gate would be forging the one record that says whether anything
 * was ever proven.
 * ---------------------------------------------------------------------------------------------
 *
 * A FAILED READ IS EVIDENCE, NOT AN EXCEPTION. Every per-workflow failure is recorded with its
 * code and the walk continues, EXCEPT when the code latches: the rail never auto-retries after a
 * latch, so continuing to call is waste that also destroys the partial. The whole collection then
 * ends with `complete: false` and the latching code, which is a true statement about a partial
 * read rather than a dead run.
 */
import { codedError } from './collection.mjs';

/** The code `collectInternalEvidencePhase` recognises as the auth boundary. Must match exactly. */
const AUTH_REQUIRED = 'INTERNAL_AUDIT_AUTH_REQUIRED';

const INTERNAL_SCHEMA = '1.0.0';

/**
 * How much of an account one weekly run will read without being asked. Deliberately modest: the
 * cost of asking for too little is a smaller finding set this week, and the cost of asking for too
 * much is a latched circuit and no findings at all.
 */
export const DEFAULT_BUDGETS = Object.freeze({
  /** Roster pages. The server reconciles to a stable total or reports incomplete. */
  rosterMaxPages: 20,
  /** Definitions read per run. Cheap, one call each. */
  maxDefinitions: 60,
  /** Runtime windows read per run. Expensive; see the module header. */
  maxRuntimeWindows: 5,
  /** Passed through to the runtime window, well under the server's own ceilings. */
  logPageSize: 100,
  maxLogPages: 20,
  maxLogRetries: 3,
  maxEnrollmentPages: 20,
  maxStepRosterPages: 20,
});

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function byteOrder(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Pull the workflow ids out of whatever `list_workflows_complete` returned.
 *
 * ITS SUCCESS SHAPE HAS NOT BEEN SEEN. So this reads the several places a roster plausibly lives,
 * accepts the first that yields ids, and reports `ROSTER_SHAPE_UNREADABLE` rather than an empty
 * list if none does. An empty roster and an unread roster are different facts and a detector that
 * confused them would report a healthy account.
 *
 * 🔴 Narrow this to the one real path the moment a live reply is seen.
 */
export function readRosterIds(data) {
  const candidates = [
    data?.data?.workflowIds,
    data?.data?.roster,
    data?.data?.workflows,
    data?.workflowIds,
    data?.roster,
    data?.workflows,
  ];
  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) continue;
    const ids = candidate
      .map((entry) => (typeof entry === 'string' ? entry : entry?.id ?? entry?.workflowId))
      .filter((id) => typeof id === 'string' && id.length > 0);
    if (ids.length > 0) return { ids: [...new Set(ids)].sort(byteOrder), readable: true };
  }
  // A roster that is genuinely, explicitly empty is a real answer.
  for (const candidate of candidates) {
    if (Array.isArray(candidate) && candidate.length === 0) return { ids: [], readable: true };
  }
  return { ids: [], readable: false };
}

/**
 * Build the adapter `collectInternalEvidencePhase` expects.
 *
 * `rail` is the thin adapter from `internal-audit.mjs`. `runtimeWorkflowIds` is the opt-in list of
 * workflows to spend a runtime window on; it is CONFIGURATION, because which workflows carry the
 * revenue path is an account fact and nothing in this module may guess it.
 */
export function createInternalAuditCollector({
  rail,
  boundLocationId,
  companyId = undefined,
  runtimeWorkflowIds = [],
  budgets = {},
  runtime = {},
} = {}) {
  if (!rail || typeof rail.roster !== 'function') {
    throw codedError('INTERNAL_AUDIT_RAIL_INVALID', TypeError);
  }
  if (typeof boundLocationId !== 'string' || boundLocationId.length === 0) {
    throw codedError('INTERNAL_AUDIT_LOCATION_UNBOUND', TypeError);
  }
  const budget = { ...DEFAULT_BUDGETS, ...budgets };
  const capturedAt = () => new Date(
    typeof runtime.now === 'function' ? runtime.now() : Date.now(),
  ).toISOString();

  return {
    async collectAuditEvidence({ window, signal } = {}) {
      const limitations = new Set();

      /*
       * PREFLIGHT, and it is not politeness. An expired credential returns `TRANSPORT_FAILED` on
       * the first read and latches the shared circuit, after which every later call on every tool
       * answers `CIRCUIT_OPEN`. Observed directly on 2026-07-27. Checking first costs no request
       * and is the difference between "nobody is logged in" and a run that blames the transport.
       */
      const credential = await rail.credentialState();
      if (credential.usable !== true) {
        // The shape `collectInternalEvidencePhase` recognises. The public evidence and the public
        // checkpoint survive it byte-for-byte, and nothing about the credential travels out --
        // not a path, not a claim, not a key reference.
        return Object.freeze({
          schemaVersion: INTERNAL_SCHEMA,
          source: 'internal_ghl',
          boundLocationId,
          checkpoint: Object.freeze({ phase: 'awaiting_internal_auth', reason: AUTH_REQUIRED }),
          complete: false,
          limitations: Object.freeze([credential.reason]),
          capabilityCoverage: Object.freeze([]),
          workflows: Object.freeze([]),
        });
      }

      const roster = await rail.roster({ maxPages: budget.rosterMaxPages });
      if (!roster.ok) limitations.add(roster.code);
      const { ids, readable } = roster.ok
        ? readRosterIds(roster.data)
        : { ids: [], readable: false };
      if (roster.ok && !readable) limitations.add('ROSTER_SHAPE_UNREADABLE');
      if (roster.ok && readable && roster.data?.complete === false) {
        limitations.add('ROSTER_INCOMPLETE');
      }

      // Content-derived order and a stated cap, so the same account always reads the same
      // workflows and a dropped tail is DISCLOSED rather than looking like a shorter account.
      const definitionIds = ids.slice(0, budget.maxDefinitions);
      if (ids.length > definitionIds.length) limitations.add('DEFINITION_BUDGET_EXHAUSTED');

      // Runtime is opt-in, and an id asked for that the roster does not contain is a
      // configuration error worth naming rather than a silent no-op.
      const requestedRuntime = [...new Set(runtimeWorkflowIds)].sort(byteOrder);
      const unknownRuntime = requestedRuntime.filter((id) => !ids.includes(id));
      if (unknownRuntime.length > 0) limitations.add('RUNTIME_WORKFLOW_NOT_IN_ROSTER');
      const runtimeIds = requestedRuntime
        .filter((id) => ids.includes(id))
        .slice(0, budget.maxRuntimeWindows);
      if (requestedRuntime.filter((id) => ids.includes(id)).length > runtimeIds.length) {
        limitations.add('RUNTIME_BUDGET_EXHAUSTED');
      }
      const runtimeWanted = new Set(runtimeIds);

      const fromDate = Date.parse(window?.from ?? '');
      const toDate = Date.parse(window?.to ?? '');
      const windowUsable = Number.isInteger(fromDate)
        && Number.isInteger(toDate)
        && fromDate < toDate;
      if (!windowUsable && runtimeWanted.size > 0) limitations.add('RUNTIME_WINDOW_UNUSABLE');

      const workflows = [];
      for (const workflowId of definitionIds) {
        if (signal?.aborted) {
          limitations.add('COLLECTION_ABORTED');
          break;
        }
        if (rail.latchedCode() !== null) {
          limitations.add(rail.latchedCode());
          break;
        }
        const definition = await rail.definition(workflowId);
        if (!definition.ok) limitations.add(definition.code);

        let runtimeWindow = null;
        if (runtimeWanted.has(workflowId) && windowUsable && rail.latchedCode() === null) {
          runtimeWindow = await rail.runtimeWindow({
            workflowId,
            fromDate,
            toDate,
            logPageSize: budget.logPageSize,
            maxLogPages: budget.maxLogPages,
            maxLogRetries: budget.maxLogRetries,
            maxEnrollmentPages: budget.maxEnrollmentPages,
            maxStepRosterPages: budget.maxStepRosterPages,
          });
          if (!runtimeWindow.ok) limitations.add(runtimeWindow.code);
        }

        workflows.push({
          workflowId,
          definition: definition.ok ? definition.data : null,
          definitionCode: definition.ok ? null : definition.code,
          runtimeWindow: runtimeWindow?.ok === true ? runtimeWindow.data : null,
          // Absent is not the same as failed, and neither is the same as empty. A detector must be
          // able to tell "we did not ask" from "we asked and could not read it".
          runtimeCode: runtimeWindow === null
            ? 'RUNTIME_NOT_REQUESTED'
            : runtimeWindow.ok ? null : runtimeWindow.code,
        });
      }

      /*
       * The AI surfaces need the elevated agency-admin token-id, which expires INDEPENDENTLY of
       * the location JWT. When it is dead the surface is skipped and said so, rather than the run
       * failing whole or, far worse, reporting an empty agent list.
       */
      let aiConfiguration = null;
      if (credential.agencyTokenUsable === true && rail.latchedCode() === null) {
        const bundle = await rail.aiBundle({ companyId });
        if (bundle.ok) aiConfiguration = bundle.data;
        else limitations.add(bundle.code);
      } else if (credential.agencyTokenUsable !== true) {
        limitations.add('AGENCY_TOKEN_UNAVAILABLE');
      }

      const complete = limitations.size === 0 && readable && definitionIds.length === ids.length;

      return Object.freeze({
        schemaVersion: INTERNAL_SCHEMA,
        source: 'internal_ghl',
        boundLocationId,
        capturedAt: capturedAt(),
        requestedWindow: Object.freeze({ from: window?.from ?? null, to: window?.to ?? null }),
        appliedWindow: Object.freeze({ from: window?.from ?? null, to: window?.to ?? null }),
        complete,
        truncated: !complete,
        limitations: Object.freeze([...limitations].sort(byteOrder)),
        // EMPTY, honestly. See the module header: no capability receipt exists, and forging a row
        // here would forge the one record that says whether anything was ever proven.
        capabilityCoverage: Object.freeze([]),
        roster: Object.freeze({
          complete: roster.ok && readable && roster.data?.complete !== false,
          reportedCount: ids.length,
          readCount: definitionIds.length,
          code: roster.ok ? null : roster.code,
        }),
        workflows: Object.freeze(workflows),
        aiConfiguration,
        latchedCode: rail.latchedCode(),
      });
    },
  };
}

/** Exported for the collector's own tests; nothing else reads it. */
export function isInternalEvidenceRecord(value) {
  return isPlainObject(value) && value.source === 'internal_ghl';
}
