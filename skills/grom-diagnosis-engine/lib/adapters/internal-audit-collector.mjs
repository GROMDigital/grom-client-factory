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
  /**
   * Runtime windows read per run. This is the ONLY brake once runtime covers every workflow by
   * default, so it is sized to match `maxDefinitions` rather than to a guess about which workflows
   * matter. Truncation is disclosed as `RUNTIME_BUDGET_EXHAUSTED`.
   *
   * MEASURED 2026-07-29, because "expensive" was folklore worth checking: a runtime response is
   * ~147KB on the wire but reaches the brief as UNDER 1KB, and three quarters of that payload is
   * the workflow definition and the enrollment walk. Putting runtime on all 16 SK Skin workflows
   * grows the workflow brief 33% (50KB to 66KB). The real cost is wall-clock and API load during
   * collection, NOT prompt size, and `maxLogPages` is the lever for that.
   */
  maxRuntimeWindows: 60,
  /**
   * Passed through to the runtime window, well under the server's own ceilings.
   *
   * OBSERVED: one real Grom UK workflow served 496 retained events and still reported
   * `LOG_PAGE_BUDGET_EXHAUSTED` at 5 pages. A budget that truncates is honest (the composite says
   * `complete: false` and names the code) but a truncated window cannot answer "did this step ever
   * fire", so the default is set where a busy real workflow finishes.
   */
  logPageSize: 100,
  maxLogPages: 50,
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
 * Pull the workflow ids out of what `list_workflows_complete` returned.
 *
 * OBSERVED 2026-07-27, first live internal read: the real path is `data.workflows[]`, and each row
 * identifies itself with **`_id`**. Not `id`, not `workflowId`. The first version of this tried both
 * of those and neither, so it would have found the array, mapped every row to `undefined`, filtered
 * them all out and reported `ROSTER_SHAPE_UNREADABLE` on a perfect 27-workflow roster. That is
 * exactly what the tolerant reader was there to survive, and exactly why it was written tolerant
 * instead of being narrowed from documentation.
 *
 * `_id` is now first. The other paths are kept, because they cost one array check each and a
 * differently-shaped server is then still understood, but the real one is no longer a guess.
 *
 * An empty roster and an unread roster stay different facts: a detector that read one as the other
 * would report a healthy account with no automation at all.
 */
export function readRosterIds(data) {
  const candidates = [
    data?.data?.workflows,
    data?.data?.workflowIds,
    data?.data?.roster,
    data?.workflows,
    data?.workflowIds,
    data?.roster,
  ];
  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) continue;
    const ids = candidate
      .map((entry) => (typeof entry === 'string'
        ? entry
        : entry?._id ?? entry?.id ?? entry?.workflowId))
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
 * The composite's own completeness verdict, which lives at `data.complete` inside the `{ok, data}`
 * envelope. `undefined` when the reply does not state one, which is NOT the same as `false`.
 */
function statedComplete(result) {
  const inner = result?.data?.data;
  return isPlainObject(inner) && typeof inner.complete === 'boolean' ? inner.complete : undefined;
}

/**
 * The composite's own coded warnings. OBSERVED shape: `[{code, component, detail, occurrences,
 * detailSamples}]`. Only the CODE and the COMPONENT travel onward -- `detail` and `detailSamples`
 * echo request context, and this value reaches the publication boundary.
 */
function statedWarnings(result) {
  const inner = result?.data?.data;
  if (!isPlainObject(inner) || !Array.isArray(inner.warnings)) return [];
  return inner.warnings
    .filter(isPlainObject)
    .map(({ code, component }) => ({
      code: typeof code === 'string' ? code : 'INTERNAL_AUDIT_WARNING_UNCODED',
      component: typeof component === 'string' ? component : null,
    }));
}

/**
 * Build the adapter `collectInternalEvidencePhase` expects.
 *
 * `rail` is the thin adapter from `internal-audit.mjs`. `runtimeWorkflowIds` NARROWS which workflows
 * spend a runtime window; naming a subset is CONFIGURATION, because which workflows carry the
 * revenue path is an account fact and nothing in this module may guess it.
 *
 * 🔴 ABSENT (null/undefined) means EVERY workflow in the roster, bounded by `maxRuntimeWindows`.
 * Covering all of them is not this module guessing which ones matter, it is DECLINING to guess,
 * which is the safe direction. The old default was `[]`, meaning none, and it made the empty list
 * the silent default for every account: the 2026-07-27 SK Skin run read all 16 definitions and zero
 * runtime windows, so every finding about how a workflow BEHAVES was inferred from how it is BUILT.
 * A per-account hand-maintained id list does not survive contact with a second account, let alone a
 * tenth: onboarding gains a manual step nobody remembers, and a workflow added later silently gets
 * no runtime, which reads exactly like a workflow nobody used.
 *
 * An explicit array still wins, and an explicit `[]` still means none.
 */
export function createInternalAuditCollector({
  rail,
  boundLocationId,
  companyId = undefined,
  runtimeWorkflowIds = null,
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
      if (roster.ok && readable && statedComplete(roster) === false) {
        limitations.add('ROSTER_INCOMPLETE');
      }
      for (const warning of statedWarnings(roster)) limitations.add(warning.code);

      // Content-derived order and a stated cap, so the same account always reads the same
      // workflows and a dropped tail is DISCLOSED rather than looking like a shorter account.
      const definitionIds = ids.slice(0, budget.maxDefinitions);
      if (ids.length > definitionIds.length) limitations.add('DEFINITION_BUDGET_EXHAUSTED');

      /*
       * Absent means every workflow that got a definition this run. `definitionIds` is already in
       * content-derived order and already capped by `maxDefinitions`, so runtime can never be asked
       * for a workflow whose definition was not read: an event stream with no definition beside it
       * cannot be judged. An id asked for that the roster does not contain is a configuration error
       * worth naming rather than a silent no-op, and that check is meaningless when covering all.
       */
      const runtimeCoversAll = runtimeWorkflowIds === null || runtimeWorkflowIds === undefined;
      const requestedRuntime = runtimeCoversAll
        ? [...definitionIds]
        : [...new Set(runtimeWorkflowIds)].sort(byteOrder);
      const unknownRuntime = runtimeCoversAll
        ? []
        : requestedRuntime.filter((id) => !ids.includes(id));
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
        /*
         * `export_workflow`, NOT `get_workflow`. OBSERVED: `get_workflow` returns a seven-field
         * SUMMARY (`id, name, status, version, stepCount, updatedAt, note`) with no steps at all,
         * while `export_workflow` carries `workflow.workflowData.templates[]` -- the real step
         * graph, 37 steps on the workflow probed, each with `type`, `next` and `attributes` -- plus
         * `triggers[]`, `stickyNotes[]` and the settings the catalog's rules are about
         * (`allowMultiple`, `timezone`, `stopOnResponse`). Every configuration defect worth
         * detecting lives in the export and none of it is in the summary.
         */
        const definition = await rail.exported(workflowId);
        if (!definition.ok) limitations.add(definition.code);
        for (const warning of statedWarnings(definition)) limitations.add(warning.code);

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
          // A composite answers `ok: true` with `complete: false` and coded warnings on a surface it
          // could not finish -- OBSERVED on the live account: `LOG_PAGE_BUDGET_EXHAUSTED` and
          // `COMPONENT_READ_FAILED` for an enrollment search the platform answered 422. Reading
          // only `ok` would publish a truncated window as a whole one.
          for (const warning of statedWarnings(runtimeWindow)) limitations.add(warning.code);
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
        for (const warning of statedWarnings(bundle)) limitations.add(warning.code);
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
          complete: roster.ok && readable && statedComplete(roster) !== false,
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
