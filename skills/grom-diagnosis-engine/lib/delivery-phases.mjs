/**
 * HOW LONG A SIGNED CLIENT SPENDS IN EACH DELIVERY PHASE.
 *
 * ---------------------------------------------------------------------------------------------
 * THE CLAIM THIS MODULE EXISTS TO RETIRE.
 *
 * Every step of the `client_onboarding` journey was declared permanently unmeasurable, on the
 * grounds that after a client signs, the work happens in a separate portal this audit cannot see.
 * That is true of WHETHER A CLIENT APPROVED something. It is false of WHEN THE CARD MOVED, and for
 * a delivery operation the second is the number that matters: an account that cannot say how long
 * its own build phase takes cannot put a date in the email that promises to come back.
 *
 * Three reviewers reached that objection independently on the 2026-07-27 Grom UK run, each as an
 * aside on a different workflow. They were right.
 * ---------------------------------------------------------------------------------------------
 *
 * WHERE THE TIMINGS ACTUALLY LIVE, and the two dead ends that were ruled out first.
 *
 *  1. NOT the opportunity record. It carries `lastStatusChangeAt` and `lastStageChangeAt` — the
 *     CURRENT stage and nothing before it. Verified live. So an opportunity can say "this client
 *     has been stuck here for nine days" and can never say how long the four phases before it took.
 *  2. NOT a stage-history endpoint. There isn't one.
 *  3. The workflow ENROLLMENT LOG. Every delivery phase on this account is a stage change on one
 *     pipeline, and every one of those stage changes is already the trigger of a published, firing
 *     workflow. So the instant a subject was enrolled in that workflow IS the instant the card
 *     entered that phase, and the log of those instants already arrives on every run.
 *
 * WHAT IS DERIVED AND WHAT IS DECLARED. The split is the whole design and it is not negotiable.
 *
 *   DERIVED, per run, from evidence the account itself wrote:
 *     - which pipeline and stage each workflow's trigger fires on  (`definition.triggers`)
 *     - what that stage is CALLED and where it sits in the ladder  (the pipelines read)
 *     - when each subject entered it                               (`runtime.enrollments.rows`)
 *
 *   DECLARED, once, in the projection contract:
 *     - that a stage named "Build In Progress" is the journey stage `build_in_progress`
 *
 * Nothing here is keyed on a workflow id, a stage id or a location. Grom AU and Grom UK are
 * separate accounts whose delivery pipelines share no ids at all, and they are covered by the same
 * contract because they use the same stage NAMES. Repoint a workflow at a different stage and the
 * next run follows it; a hand-maintained id list would quietly keep measuring the old one.
 *
 * ---------------------------------------------------------------------------------------------
 * 🔴 TWO POPULATION TRAPS, both of which cost a full session before this module existed.
 *
 *  1. `enrollmentTotals.total` IS NOT THE POPULATION OF `enrollments.rows`. The totals are
 *     `scope: workflow_all_time`; the rows are `windowScoped: true`, i.e. this run's collection
 *     horizon. They legitimately disagree — 5 against 3, 159 against 112 — because they are
 *     different endpoints counting different things, and that gap is NOT a paging failure to be
 *     reconciled. This module reads ROWS ONLY and never consults the totals, because a duration
 *     can only be computed from rows it actually holds.
 *  2. ROSTER LENGTH IS NOT A COUNT OF ANYTHING until the read that produced it is known complete.
 *     A pager defect once returned one enrollment fifty times. `reconcileRuntime` already refuses a
 *     runtime record whose enrollment read came back incomplete, so an incomplete read never
 *     reaches this module — but a workflow MISSING from the bundle is not the same as a workflow
 *     with no enrollments, and the two are reported separately below for exactly that reason.
 * ---------------------------------------------------------------------------------------------
 */
import { cloneJson, codedError } from './adapters/collection.mjs';

/** The operation id the projection contract binds this evidence to. */
export const DELIVERY_PHASE_OPERATION_ID = 'internal_ghl.delivery_phase_entries';

/**
 * The pipelines read, named once. It is the public rail's own action id, and it stays declared in
 * `unprojectedActions` on the projection contract: a pipeline DEFINITION is not journey evidence
 * about a subject and must never be projected as if it were. It is read here as a LOOKUP — stage
 * id to stage name — which is a different use and the reason that declaration still holds.
 */
const PIPELINES_OPERATION_ID = 'opportunities-v3__get-pipelines';

/**
 * The opportunities read, used ONLY to date the first rung (see `firstStageEntries`). It stays a
 * projected journey source in its own right for the acquisition journey; nothing here changes that.
 */
const OPPORTUNITIES_OPERATION_ID = 'opportunities.list';

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

/**
 * A stage name compared the way a human would compare it. The builder's stage labels are typed by
 * hand and drift in case and spacing between accounts and between renames — "Build In Progress",
 * "build in progress" and "Build  In Progress" are one stage, and a contract author cannot be asked
 * to guess which spelling an account holds today. Mirrors `comparableKey` in the projector, which
 * trims and lowercases every text predicate for the same reason.
 */
export function normalizeStageName(value) {
  if (!isNonEmptyString(value)) return null;
  const collapsed = value.trim().toLowerCase().replace(/\s+/gu, ' ');
  return collapsed.length > 0 ? collapsed : null;
}

/**
 * Stage id -> {name, pipelineId, position} for every pipeline the account exposes.
 *
 * Deliberately built across ALL pipelines rather than a nominated delivery one. Which pipeline is
 * "the delivery pipeline" is a judgement nothing in the evidence settles, and it does not need
 * settling: a stage is identified by the name the account gave it, and the projection contract
 * names the stages it recognises. A sales pipeline that happens to contain no stage the contract
 * names contributes nothing and needs no rule to exclude it.
 */
export function indexPipelineStages(pipelines) {
  const byStageId = new Map();
  if (!Array.isArray(pipelines)) return byStageId;
  for (const pipeline of pipelines) {
    if (!isPlainObject(pipeline)) continue;
    const pipelineId = [pipeline.id, pipeline._id].find(isNonEmptyString) ?? null;
    const stages = Array.isArray(pipeline.stages) ? pipeline.stages : [];
    stages.forEach((stage, position) => {
      if (!isPlainObject(stage)) return;
      const stageId = [stage.id, stage._id].find(isNonEmptyString);
      const name = normalizeStageName([stage.name, stage.stageName].find(isNonEmptyString));
      if (!isNonEmptyString(stageId) || name === null) return;
      // First declaration wins. A stage id is unique across an account, so a second claim on one
      // is a malformed payload, and silently letting the later one overwrite the earlier would
      // make which name a stage has depend on array order.
      if (!byStageId.has(stageId)) byStageId.set(stageId, { name, pipelineId, position });
    });
  }
  return byStageId;
}

/**
 * Workflow id -> the normalized name of the single stage its triggers fire on.
 *
 * 🔴 A WORKFLOW WITH TWO DIFFERENT STAGE TRIGGERS IS REFUSED, not resolved. Its enrollments cannot
 * be attributed to either stage — an enrollment row says a subject entered THE WORKFLOW, not which
 * of its triggers admitted them — so attributing them to the first trigger would invent a phase
 * entry that may never have happened. Refusing costs one workflow's timings and is disclosed;
 * guessing corrupts a published duration and is not.
 */
export function bindWorkflowsToStages(workflows, stageIndex) {
  const bound = new Map();
  const ambiguous = [];
  if (!Array.isArray(workflows)) return { bound, ambiguous };
  for (const workflow of workflows) {
    if (!isPlainObject(workflow)) continue;
    const workflowId = workflow.workflowId ?? workflow.id;
    if (!isNonEmptyString(workflowId)) continue;
    const triggers = Array.isArray(workflow.definition?.triggers)
      ? workflow.definition.triggers
      : [];
    const names = new Set();
    for (const trigger of triggers) {
      if (!isPlainObject(trigger) || !isNonEmptyString(trigger.stageId)) continue;
      const stage = stageIndex.get(trigger.stageId);
      // A stage id no pipeline claims is a trigger pointing at a deleted stage. It names no phase
      // and is skipped rather than counted as a second, conflicting one.
      if (stage) names.add(stage.name);
    }
    if (names.size === 1) bound.set(workflowId, [...names][0]);
    else if (names.size > 1) ambiguous.push(workflowId);
  }
  return { bound, ambiguous };
}

/**
 * Find the raw rows of one collected public scope. Returns `null` — never `[]` — when the scope is
 * absent, because "the account exposed no pipelines" and "this run never read pipelines" are
 * different facts and the second one must not silently read as a delivery pipeline with no stages.
 */
function scopeItems(publicEvidence, operationId) {
  const scopes = Array.isArray(publicEvidence?.scopes) ? publicEvidence.scopes : [];
  const scope = scopes.find((entry) => entry?.operationId === operationId);
  if (!scope) return null;
  return Array.isArray(scope.items) ? scope.items : [];
}

/**
 * THE FIRST RUNG, which no enrollment log can supply.
 *
 * `01 Onboarding Ready` does NOT trigger on a stage change. It triggers on `opportunity_created`,
 * because on this account the opportunity is CREATED into the delivery pipeline's first stage by
 * the contract-signed handoff — there is no earlier stage for it to move from. Verified live
 * 2026-08-02, and confirmed by the owner as the intended process: a client must exist in that first
 * stage before an onboarding form link can be sent to them at all.
 *
 * So the first stage entry is the opportunity's own `dateAdded`, read off the opportunities the
 * public rail already collects. Every later rung still comes from an enrollment log; this is the
 * one place the two rails are combined, and each emitted row says which one it came from.
 *
 * 🔴 THE ASSUMPTION, STATED RATHER THAN BURIED: an opportunity in the delivery pipeline was created
 * INTO that pipeline's first stage. The record cannot prove it — `pipelineStageId` is the CURRENT
 * stage, so an opportunity that has moved on carries no memory of where it started, which is the
 * same limitation that made this whole journey unmeasurable in the first place. If a delivery
 * opportunity were ever created directly into a later stage, its first-rung entry time would be
 * wrong. It is accepted deliberately, because the alternative is leaving the first rung permanently
 * unmeasured, and because the process that creates these opportunities has exactly one entry point.
 *
 * The pipeline is identified by DERIVATION, never by a declared id: it is whichever pipeline the
 * stage-triggered delivery workflows themselves point at.
 */
function firstStageEntries(publicEvidence, stageIndex, deliveryPipelineIds) {
  const items = scopeItems(publicEvidence, OPPORTUNITIES_OPERATION_ID);
  if (items === null || deliveryPipelineIds.size === 0) return { rows: [], read: false };

  // Position 0 of each delivery pipeline, by the pipeline's own ordering — not by a name this
  // module guesses at.
  const firstStageByPipeline = new Map();
  for (const [, stage] of stageIndex) {
    if (!deliveryPipelineIds.has(stage.pipelineId)) continue;
    const held = firstStageByPipeline.get(stage.pipelineId);
    if (!held || stage.position < held.position) firstStageByPipeline.set(stage.pipelineId, stage);
  }

  const rows = [];
  for (const item of items) {
    if (!isPlainObject(item)) continue;
    const stage = firstStageByPipeline.get(item.pipelineId);
    if (!stage) continue;
    const contactId = [item.contactId, item.contact?.id].find(isNonEmptyString);
    const createdAt = [item.dateAdded, item.createdAt].find(isNonEmptyString);
    if (!isNonEmptyString(contactId) || !isNonEmptyString(createdAt)) continue;
    rows.push({
      contactId,
      enteredAt: createdAt,
      deliveryStageName: stage.name,
      evidenceOrigin: 'opportunity_created',
      workflowId: null,
    });
  }
  return { rows, read: true };
}

/**
 * Pipelines arrive either as the bare array or wrapped in `{pipelines: [...]}` depending on which
 * shape of the read answered. Both are unwrapped here rather than in the indexer so the indexer
 * has exactly one input shape to reason about.
 */
function unwrapPipelines(items) {
  if (!Array.isArray(items)) return [];
  const unwrapped = [];
  for (const item of items) {
    if (!isPlainObject(item)) continue;
    if (Array.isArray(item.pipelines)) unwrapped.push(...item.pipelines.filter(isPlainObject));
    else unwrapped.push(item);
  }
  return unwrapped;
}

/**
 * THE COLLECTION THE PROJECTOR SEES: one row per (subject, phase entry).
 *
 * Emitted as an ordinary collection envelope in the same shape `sourceCollectionsFromScopes`
 * produces, because the projector must not need to know that this evidence came from a different
 * rail. Its `source` is `internal_ghl`, which is already a first-class evidence source in the
 * projection schema, and it carries the internal rail's own window and capture time rather than
 * borrowing the public rail's.
 *
 * Returns `[]` — no envelope at all — when the account has no internal rail, when pipelines were
 * never read, or when no workflow binds to a named stage. An empty envelope would assert that the
 * run looked and found no phase entries; returning nothing asserts only that it could not look,
 * and the projector then leaves every delivery edge exactly as unmeasured as it was.
 */
export function deliveryPhaseCollections({ internalEvidence, publicEvidence } = {}) {
  if (!isPlainObject(internalEvidence)) return [];
  const workflows = Array.isArray(internalEvidence.workflows) ? internalEvidence.workflows : [];
  if (workflows.length === 0) return [];

  const pipelineItems = scopeItems(publicEvidence, PIPELINES_OPERATION_ID);
  if (pipelineItems === null) return [];
  const stageIndex = indexPipelineStages(unwrapPipelines(pipelineItems));
  if (stageIndex.size === 0) return [];

  const { bound, ambiguous } = bindWorkflowsToStages(workflows, stageIndex);
  if (bound.size === 0) return [];

  // WHICH PIPELINE IS THE DELIVERY ONE, derived and never declared: whichever pipeline the
  // stage-triggered delivery workflows actually point at. A sales pipeline with no such workflow
  // contributes nothing and needs no rule to exclude it.
  const deliveryPipelineIds = new Set();
  for (const [, stageName] of bound) {
    for (const [, stage] of stageIndex) {
      if (stage.name === stageName && stage.pipelineId) deliveryPipelineIds.add(stage.pipelineId);
    }
  }

  const items = [];
  const incomplete = [];
  for (const workflow of workflows) {
    if (!isPlainObject(workflow)) continue;
    const workflowId = workflow.workflowId ?? workflow.id;
    const stageName = bound.get(workflowId);
    if (stageName === undefined) continue;
    const enrollments = workflow.runtime?.enrollments;
    if (!isPlainObject(enrollments) || !Array.isArray(enrollments.rows)) {
      // The workflow binds to a phase and its enrollments are missing. That is a HOLE, and a hole
      // reported as zero entries would publish a phase nobody ever entered.
      incomplete.push(workflowId);
      continue;
    }
    for (const row of enrollments.rows) {
      if (!isPlainObject(row)) continue;
      // Both are required, and neither is defaulted. A row with no contact cannot be joined to a
      // subject, and a row with no instant cannot be a duration endpoint; either way it is not
      // phase evidence and is dropped rather than carried as a partial one. The bare
      // `inbound_webhook` workflows on this account enroll with `contactId: undefined`, so this
      // is the normal state of a whole class of workflow, not a rare defect.
      if (!isNonEmptyString(row.contactId) || !isNonEmptyString(row.createdAt)) continue;
      items.push({
        contactId: row.contactId,
        enteredAt: row.createdAt,
        deliveryStageName: stageName,
        evidenceOrigin: 'enrollment_log',
        workflowId,
      });
    }
  }

  // The first rung, from the opportunity record rather than an enrollment log. Appended here so
  // every row in the envelope carries the same shape and the sort below orders all of them together.
  const first = firstStageEntries(publicEvidence, stageIndex, deliveryPipelineIds);
  items.push(...first.rows);

  if (items.length === 0 && incomplete.length === 0) return [];

  // Deterministic byte order. The kernel byte-compares the measurement on resume, and the order
  // workflows arrive in is the adapter's, which is not this module's to depend on.
  items.sort((left, right) => {
    const key = (row) => `${row.deliveryStageName} ${row.enteredAt} ${row.contactId}`;
    return key(left) < key(right) ? -1 : key(left) > key(right) ? 1 : 0;
  });

  const complete = incomplete.length === 0 && ambiguous.length === 0;
  const collection = {
    source: 'internal_ghl',
    operationId: DELIVERY_PHASE_OPERATION_ID,
    boundLocationId: internalEvidence.boundLocationId ?? publicEvidence?.boundLocationId ?? null,
    requestedWindow: cloneJson(internalEvidence.requestedWindow ?? {}),
    appliedWindow: cloneJson(internalEvidence.appliedWindow ?? internalEvidence.requestedWindow ?? {}),
    capturedAt: internalEvidence.capturedAt ?? null,
    items,
    page: {
      complete,
      truncated: false,
      nextCursor: null,
      collectedCount: items.length,
      reportedCount: items.length,
    },
  };
  if (!complete) {
    // Named causes, not a generic flag. "Two workflows never returned an enrollment log" and "one
    // workflow triggers on two stages" are different holes with different fixes, and a reader who
    // is told only that something was incomplete cannot act on either.
    collection.incompleteReason = incomplete.length > 0
      ? 'DELIVERY_PHASE_ENROLLMENTS_MISSING'
      : 'DELIVERY_PHASE_TRIGGER_AMBIGUOUS';
  }
  return [collection];
}

/**
 * Guard for callers that hand this module something that is not evidence at all. Kept separate so
 * the builder above can stay total: it returns no envelope for every honest absence, and throws
 * only for a caller error.
 */
export function assertDeliveryPhaseInputs(internalEvidence) {
  if (internalEvidence !== null && internalEvidence !== undefined && !isPlainObject(internalEvidence)) {
    throw codedError('DELIVERY_PHASE_EVIDENCE_INVALID', TypeError);
  }
  return true;
}
