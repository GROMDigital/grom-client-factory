/**
 * THE MEASUREMENT CHAIN, IN ONE PLACE.
 *
 * `projectJourneyEvents -> normalizeEvidence -> buildEvidenceGraph -> buildWindows ->
 * computeJourneyMetrics` was exported, tested, driven end to end against a real account by a
 * SCRIPT (`~/.grom-audit-runs/grom-uk/measure-run.mjs`), and called by nothing on the rail. A live
 * `audit run` therefore collected real evidence and published an empty report.
 *
 * This module is that script's chain, moved in-process, so `analyzer.normalize` produces the
 * numbers instead of a pair of hashes. It is PURE: no filesystem writes, no network, no clock. Its
 * only inputs are the run's own collected evidence and its sealed frozen inputs, and its output is
 * canonical JSON, because `lib/kernel.mjs` checkpoints it, canonical-JSON round-trips it and
 * byte-compares it on resume.
 *
 * ---------------------------------------------------------------------------------------------
 * THE TWO CLOCKS. They are not the same and conflating them discarded 100% of the evidence on the
 * first live run.
 *
 *   cutoff          the run's SEALED event-time boundary — the closed-week Monday. It decides
 *                   which events fall in which window, and which cohorts have had time to mature.
 *   capturedThrough the last instant any of this evidence was actually READ. Always AFTER the
 *                   cutoff, because a week must close before it can be read. It decides the
 *                   capture horizon: how much of the world the run could possibly have seen.
 *
 * Passing the cutoff for both makes every collected node look like it was captured after the
 * horizon, and the metric layer's no-lookahead rule then discards all of it. Every cell reads
 * `NO_ELIGIBLE_POPULATION` and the run looks like an empty account rather than a broken audit.
 * ---------------------------------------------------------------------------------------------
 *
 * WHY PROJECTED ENVELOPES ARE NOT RE-AUTHORIZED.
 *
 * `lib/adapters/collection.mjs:110-114` attaches `privateSourceEnvelope` and
 * `privateSourceInventory` to every authorized collection, and the projector builds a fresh
 * envelope, so those two keys do not survive projection. That is deliberate, not an oversight:
 *
 *  - The private-source authority binds a RAW CAPTURED PAYLOAD to the run's sealed
 *    `privateSourceInventoryHash`. That hash is computed inside `freezeInputs` and written into
 *    the run row before a single phase executes. Projection happens long after the seal.
 *  - So re-authorizing here could only do one of two dishonest things: mint inventory entries no
 *    seal covers, which is a false provenance claim, or demand a re-seal, which would mean a run
 *    whose frozen inputs change while it executes.
 *  - Nothing downstream of this module treats a projected envelope as SOURCE evidence.
 *    `normalizeEvidence` is its only consumer and it never crosses the publication boundary.
 *    The raw collections stay sealed and stay in the checkpoint; the projection is a pure,
 *    deterministic, byte-reproducible function of them.
 *
 * The authority that matters is therefore unchanged: what was collected is still exactly what the
 * run was sealed for. This module adds a derivation on top of it, and derivations are proved by
 * re-running them, which is precisely what `lib/verifier.mjs` does.
 */
import { canonicalJson } from './canonical.mjs';
import { buildEvidenceGraph } from './evidence-graph.mjs';
import { projectJourneyEvents } from './journey-projection.mjs';
import { buildWindows, computeJourneyMetrics } from './metrics.mjs';
import { normalizeEvidence } from './normalize.mjs';
import {
  loadMetricContracts,
  loadProfile,
  loadProjection,
  validateProjectionForProfile,
} from '../schemas/v1.mjs';

const MEASUREMENT_SCHEMA = '1.0.0';

/**
 * No metric contract declares a global maturity grace, and none should have to: maturity is
 * expressed per edge as `allowedLag`, which is the only place that knows how long THAT transition
 * takes. `maturityDays` is a whole-cohort grace on top of it, so zero is the neutral identity, not
 * a guess. It is stated here rather than defaulted inside `buildWindows` so that the day a profile
 * does want one, there is one obvious place to read it from.
 */
const GLOBAL_MATURITY_GRACE_DAYS = 0;

function codedError(code, ErrorType = Error) {
  return Object.assign(new ErrorType(code), { code });
}

/**
 * Byte order, not locale order. `localeCompare` is configuration-dependent and this output is
 * byte-compared on resume, possibly on a different machine.
 */
function byteOrder(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * The profile this account is audited as. It is read from the SEALED frozen inputs, never from the
 * mutable context record, because the profile decides what every number means and a run must
 * measure itself as the thing it was sealed as.
 */
function sealedProfileId(frozenInputs) {
  const declared = frozenInputs?.target?.operatingProfile;
  if (typeof declared !== 'string' || declared.length === 0) {
    throw codedError('MEASUREMENT_PROFILE_UNDECLARED');
  }
  return declared;
}

function sealedTimezone(frozenInputs) {
  const declared = frozenInputs?.timezone;
  if (typeof declared !== 'string' || declared.length === 0) {
    throw codedError('MEASUREMENT_TIMEZONE_UNDECLARED');
  }
  return declared;
}

/**
 * Rebuild the collection envelopes the projector validates from what the run durably checkpointed.
 *
 * `collectPublicEvidence` records each scope as the collection envelope MINUS `source` and
 * `boundLocationId` (both are stated once at the top of the public-evidence record instead of
 * being repeated per scope), PLUS an `incompleteReason: null` that a COMPLETE envelope may not
 * carry at all — `assertSourceCollection` refuses `Object.hasOwn(collection, 'incompleteReason')`
 * on a complete page, and it is right to. Both differences are repaired HERE, at the seam that
 * created them, rather than by loosening the projector.
 */
function collectionsFromScopes(publicEvidence) {
  if (!isPlainObject(publicEvidence) || !Array.isArray(publicEvidence.scopes)) {
    throw codedError('MEASUREMENT_PUBLIC_EVIDENCE_SHAPE_UNEXPECTED', TypeError);
  }
  return publicEvidence.scopes.map((scope) => {
    if (!isPlainObject(scope) || !isPlainObject(scope.page)) {
      throw codedError('MEASUREMENT_PUBLIC_EVIDENCE_SHAPE_UNEXPECTED', TypeError);
    }
    const collection = {
      source: publicEvidence.source,
      operationId: scope.operationId,
      boundLocationId: publicEvidence.boundLocationId,
      requestedWindow: { ...scope.requestedWindow },
      appliedWindow: { ...scope.appliedWindow },
      capturedAt: scope.capturedAt,
      items: scope.items,
      page: { ...scope.page },
    };
    if (collection.page.complete !== true) {
      // Rule 4 of the projector: incompleteness propagates and is never laundered. A scope that
      // is partial without saying why still says SOMETHING, and a generic reason is honest where
      // silence would read as completeness.
      collection.incompleteReason = typeof scope.incompleteReason === 'string'
        && scope.incompleteReason.length > 0
        ? scope.incompleteReason
        : 'PUBLIC_SCOPE_INCOMPLETE';
    }
    return collection;
  });
}

/**
 * The last instant any of this evidence was READ. `undefined` when the run collected no scope at
 * all, which `buildWindows` reads as "no horizon stated" and which is honest: there is nothing to
 * bound. It is never defaulted to the cutoff, because that is the exact substitution that
 * discarded every event on the first live run.
 */
function capturedThroughOf(publicEvidence) {
  const stamps = publicEvidence.scopes
    .map((scope) => scope.capturedAt)
    .filter((value) => typeof value === 'string' && value.length > 0)
    .sort();
  return stamps.at(-1);
}

/**
 * Content-derived order, not arrival order. `collectPublicEvidence` happens to sort its scopes by
 * `operationId` before checkpointing them, but a summary that INHERITS someone else's sort is only
 * accidentally deterministic, and the kernel byte-compares this output on resume. A test that
 * reverses the scopes catches exactly this, and did.
 */
function collectionSummary(publicEvidence) {
  return publicEvidence.scopes
    .map((scope) => ({
      operationId: scope.operationId,
      actionId: scope.actionId ?? null,
      status: scope.status ?? null,
      incompleteReason: scope.incompleteReason ?? null,
      collectedCount: Array.isArray(scope.items) ? scope.items.length : 0,
      reportedCount: scope.page?.reportedCount ?? null,
      appliedWindow: { ...scope.appliedWindow },
    }))
    .sort((left, right) => byteOrder(canonicalJson(left), canonicalJson(right)));
}

function projectionSummary(projected) {
  return projected.map((envelope) => ({
    operationId: envelope.operationId,
    kind: envelope.projection.kind,
    inputItemCount: envelope.projection.inputItemCount,
    recordsWithEmissions: envelope.projection.recordsWithEmissions,
    emittedCount: envelope.projection.emittedCount,
    // Rule 7: a projector that quietly drops 80% of an account looks identical to a healthy one
    // from downstream, so every suppression travels with the numbers it removed itself from.
    suppressed: envelope.projection.suppressed.map((entry) => ({ ...entry })),
    annotations: envelope.projection.annotations.map((entry) => ({ ...entry })),
  }));
}

/**
 * Drive the whole chain and return the sealed measurement bundle.
 *
 * Deterministic: same evidence and same frozen inputs always yield byte-identical output. Nothing
 * here reads the wall clock, the host timezone, the filesystem beyond the two profile files, or
 * anything the run was not sealed with.
 */
export function measurePublicEvidence({ publicEvidence, frozenInputs } = {}) {
  const profileId = sealedProfileId(frozenInputs);
  const timezone = sealedTimezone(frozenInputs);

  const profile = loadProfile(profileId);
  const projection = loadProjection(profileId);
  const metricContracts = loadMetricContracts(profileId);
  /*
   * `metricContracts` is a REQUIRED argument here specifically so the unmeasurable-edge gate
   * cannot be bypassed. It is what refuses to let an edge the projector cannot prove be reported
   * as MAPPED. Making it optional to get something working is how a fabricated confident zero
   * shipped once already.
   */
  validateProjectionForProfile(profile, projection, metricContracts);

  const locationId = publicEvidence?.boundLocationId;
  if (typeof locationId !== 'string' || locationId.length === 0) {
    throw codedError('MEASUREMENT_LOCATION_UNBOUND');
  }
  // The evidence must belong to the account the run was sealed for. A mismatch is a different
  // audit wearing this run's identity, and it fails closed rather than being measured.
  if (
    typeof frozenInputs.locationId === 'string'
    && frozenInputs.locationId !== locationId
  ) throw codedError('MEASUREMENT_LOCATION_MISMATCH');

  const cutoffSource = publicEvidence?.collectionWindow?.to;
  if (typeof cutoffSource !== 'string' || cutoffSource.length === 0) {
    throw codedError('MEASUREMENT_CUTOFF_UNDECLARED');
  }

  const context = { locationId };
  const collections = collectionsFromScopes(publicEvidence);
  const projected = projectJourneyEvents({
    collections, context, profile, projection,
  });
  const records = normalizeEvidence(projected, context);
  const graph = buildEvidenceGraph({ records, context, profile });
  const windows = buildWindows({
    cutoff: new Date(cutoffSource).toISOString(),
    timezone,
    maturityDays: GLOBAL_MATURITY_GRACE_DAYS,
    capturedThrough: capturedThroughOf(publicEvidence),
  });
  const metrics = computeJourneyMetrics({ graph, metricContracts, windows });

  return {
    schemaVersion: MEASUREMENT_SCHEMA,
    profileId,
    locationId,
    collectionWindow: { ...publicEvidence.collectionWindow },
    collectionMode: publicEvidence.collectionMode ?? null,
    // The collection rail's own account of what it could not finish. Carried onto the measurement
    // so a later stage cannot read the numbers without also seeing what was missing from them.
    collectionLimitations: (publicEvidence.limitations ?? []).map((entry) => ({ ...entry })),
    collection: collectionSummary(publicEvidence),
    projection: projectionSummary(projected),
    // The unmeasurable edges are stated on the measurement rather than left implicit in a metric
    // cell reading UNKNOWN. "We cannot see this from public data" and "we looked and found
    // nothing" are different sentences and a client is owed the difference.
    unmeasurableEdges: [...(projection.unmeasurableEdges ?? [])].sort(),
    // The reads this account exposes that the projection deliberately does not turn into journey
    // evidence. Same reasoning as above: a stage with no signal is a KNOWN blind spot, not a zero.
    unprojectedActions: [...(projection.unprojectedActions ?? [])]
      .map(({ actionId, reason }) => ({ actionId, reason }))
      .sort((left, right) => (
        left.actionId < right.actionId ? -1 : left.actionId > right.actionId ? 1 : 0
      )),
    graph,
    windows,
    metrics,
  };
}
