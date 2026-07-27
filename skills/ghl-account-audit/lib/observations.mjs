/**
 * SURFACE OBSERVATIONS — the operational facts a defect detector needs and a journey event cannot
 * carry.
 *
 * The measurement chain projects raw rows into journey events. That is exactly right for measuring
 * conversion and exactly wrong for diagnosing it, because a journey event carries only what says
 * WHEN a subject moved. The single most useful sentence about Grom's own UK account is "156 of 175
 * conversations end with our message, 132 of those were automated, and only 17 end with theirs",
 * and not one of those fields survives projection, because none of them is a timestamp of movement.
 *
 * So a small set of aggregate counters is computed over the same raw rows, from declarations in the
 * projection contract. Three kinds and no more, the same discipline the projector's `when` predicate
 * keeps.
 *
 * ---------------------------------------------------------------------------------------------
 * ONLY COUNTS LEAVE HERE. THIS IS NOT A WAY TO READ ROW CONTENT.
 *
 * These numbers travel into the analysis phase, the mechanism packets and the publication. Three
 * locks, and all three are needed:
 *
 *  1. Every distribution value must match a narrow scalar charset. Anything else is counted under
 *     `__unsafe__`, so a field that turns out to hold free text, an email or a message body yields
 *     a COUNT of unsafe values and never the values.
 *  2. Distinct values are capped per declaration; the overflow is counted under `__other__` rather
 *     than dropped, because a silently truncated distribution reads as a tidier account.
 *  3. `presence` and `stale_status` emit integers only. They never name a row.
 *
 * A declaration is data, so someone will eventually point one at a name field. Lock 1 is what makes
 * that a harmless mistake instead of a leak.
 * ---------------------------------------------------------------------------------------------
 *
 * THE CLOCK IS THE SEALED CUTOFF, NEVER THE WALL CLOCK. `stale_status` asks "how many rows sit in
 * this state past a time that has already passed", and the answer has to be reproducible: the
 * kernel byte-compares this output on resume, and a verifier re-derives it later. Reading
 * `Date.now()` would make yesterday's run unreproducible today, and would also quietly widen the
 * window past the cutoff the run is sealed for.
 */
import { matchesOperationIdPattern } from '../schemas/v1.mjs';

/** Lock 1. A short, unambiguous scalar. No spaces, no `@`, no `/`, so no address, email or URL. */
const SAFE_VALUE = /^[A-Za-z0-9_.:-]{1,64}$/u;
const UNSAFE_BUCKET = '__unsafe__';
const OTHER_BUCKET = '__other__';
const ABSENT_BUCKET = '__absent__';
const DEFAULT_MAX_DISTINCT = 25;

function codedError(code, ErrorType = Error) {
  return Object.assign(new ErrorType(code), { code });
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Dotted path read, non-traversing past arrays on purpose. A path that lands inside an array is a
 * declaration this module does not implement, and answering it with the first element would be a
 * guess about which element the author meant.
 */
function readPath(row, path) {
  let current = row;
  for (const segment of path.split('.')) {
    if (!isPlainObject(current)) return undefined;
    current = current[segment];
  }
  return current;
}

/** Is there a value here at all? `0` and `false` ARE values; empty string and whitespace are not. */
function isPresent(value, { requirePositiveNumber = false } = {}) {
  if (value === null || value === undefined) return false;
  if (typeof value === 'number') return Number.isFinite(value) && (!requirePositiveNumber || value > 0);
  if (typeof value === 'string') {
    if (value.trim().length === 0) return false;
    if (!requirePositiveNumber) return true;
    // A number written as a string is the shape an engine in this workspace has actually been
    // observed writing `monetaryValue` in. It is NOT counted as a usable amount, because the
    // projector refuses to read it as one, and the two must agree or the detector contradicts
    // the measurement it is explaining.
    return false;
  }
  if (typeof value === 'boolean') return !requirePositiveNumber;
  if (Array.isArray(value)) return value.length > 0;
  if (isPlainObject(value)) return Object.keys(value).length > 0;
  return false;
}

function bucketFor(value) {
  if (value === null || value === undefined) return ABSENT_BUCKET;
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : UNSAFE_BUCKET;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.length === 0) return ABSENT_BUCKET;
    return SAFE_VALUE.test(trimmed) ? trimmed : UNSAFE_BUCKET;
  }
  return UNSAFE_BUCKET;
}

function distribution(rows, declaration) {
  const maxDistinct = declaration.maxDistinct ?? DEFAULT_MAX_DISTINCT;
  const tally = new Map();
  for (const row of rows) {
    const bucket = bucketFor(readPath(row, declaration.path));
    tally.set(bucket, (tally.get(bucket) ?? 0) + 1);
  }
  // Lock 2. Ordered by count then by name so the SAME account always truncates the same way, and
  // the overflow is counted rather than dropped.
  const ordered = [...tally.entries()].sort(
    (left, right) => right[1] - left[1] || (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0),
  );
  const kept = ordered.slice(0, maxDistinct);
  const overflow = ordered.slice(maxDistinct);
  const values = Object.fromEntries(kept);
  if (overflow.length > 0) {
    values[OTHER_BUCKET] = overflow.reduce((total, [, count]) => total + count, 0);
    values[`${OTHER_BUCKET}_distinct`] = overflow.length;
  }
  return {
    observationId: declaration.observationId,
    kind: 'distribution',
    rows: rows.length,
    distinct: ordered.length,
    values,
  };
}

function presence(rows, declaration) {
  let present = 0;
  for (const row of rows) {
    const hit = declaration.paths.some((path) => isPresent(readPath(row, path), {
      requirePositiveNumber: declaration.requirePositiveNumber === true,
    }));
    if (hit) present += 1;
  }
  return {
    observationId: declaration.observationId,
    kind: 'presence',
    rows: rows.length,
    present,
    absent: rows.length - present,
  };
}

function staleStatus(rows, declaration, cutoffMs) {
  const states = new Set(declaration.statusValues);
  let stale = 0;
  let inState = 0;
  let unreadableTime = 0;
  for (const row of rows) {
    const status = readPath(row, declaration.statusPath);
    if (typeof status !== 'string' || !states.has(status)) continue;
    inState += 1;
    const parsed = Date.parse(String(readPath(row, declaration.timePath) ?? ''));
    if (!Number.isFinite(parsed)) {
      unreadableTime += 1;
      continue;
    }
    if (parsed < cutoffMs) stale += 1;
  }
  return {
    observationId: declaration.observationId,
    kind: 'stale_status',
    rows: rows.length,
    inState,
    stale,
    // A row in the state whose own time cannot be read is neither stale nor fresh, and saying so
    // is the difference between a measured zero and an unmeasured one.
    unreadableTime,
  };
}

/**
 * Compute every declared observation over the collected rows.
 *
 * `collections` are the SAME source envelopes the projector is handed, so an observation and a
 * metric can never be computed over different rows. `cutoffMs` is the run's sealed cutoff.
 */
export function computeSurfaceObservations({ collections, projection, cutoffMs } = {}) {
  if (!Array.isArray(collections)) {
    throw codedError('OBSERVATIONS_COLLECTIONS_INVALID', TypeError);
  }
  if (!Number.isFinite(cutoffMs)) throw codedError('OBSERVATIONS_CUTOFF_INVALID', TypeError);

  const surfaces = [];
  for (const source of projection?.sources ?? []) {
    const declarations = source.observations ?? [];
    if (declarations.length === 0) continue;
    const matched = collections.filter((collection) => (
      source.evidenceSource === collection.source
      && matchesOperationIdPattern(source.operationIdPattern, collection.operationId)
    ));
    // A source with nothing collected is reported with a row count of zero rather than omitted.
    // An absent surface and an empty one are different facts, and a detector that read "no
    // conversations observed" as "everybody replied" would be worse than useless.
    const rows = matched.flatMap((collection) => (
      Array.isArray(collection.items) ? collection.items : []
    ));
    const complete = matched.length > 0
      && matched.every((collection) => collection.page?.complete === true);
    const observations = declarations.map((declaration) => {
      if (declaration.kind === 'distribution') return distribution(rows, declaration);
      if (declaration.kind === 'presence') return presence(rows, declaration);
      if (declaration.kind === 'stale_status') return staleStatus(rows, declaration, cutoffMs);
      throw codedError('OBSERVATION_KIND_UNSUPPORTED');
    });
    surfaces.push({
      sourceId: source.sourceId,
      capability: source.capability,
      collected: matched.length,
      // Whether these counts describe the whole surface or a truncated read of it. A ratio taken
      // over a partial surface is not the account's ratio, and a detector has to be able to say so.
      complete,
      rows: rows.length,
      observations,
    });
  }
  return surfaces.sort((left, right) => (
    left.sourceId < right.sourceId ? -1 : left.sourceId > right.sourceId ? 1 : 0
  ));
}

/** Convenience for a detector: one observation by surface capability and observation id. */
export function findObservation(surfaces, capability, observationId) {
  const surface = (surfaces ?? []).find((entry) => entry.capability === capability);
  if (surface === undefined) return null;
  const observation = surface.observations.find(
    (entry) => entry.observationId === observationId,
  );
  return observation === undefined ? null : { ...observation, surface };
}
