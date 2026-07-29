/**
 * WEEK OVER WEEK — is this problem new, is it still here, did the fix work?
 *
 * `lib/memory.mjs` shipped built and tested and with ZERO CALLERS. It is an append-only, hash-chained
 * ledger that already models a problem being observed, approved, implemented, verified and coming
 * back, and nothing in the product ever wrote to it or read from it. So every run was the first run:
 * twenty-two problems every Monday with no way to tell which of them were also there last Monday.
 *
 * This module is the join. It does two things and refuses to do a third:
 *
 *   1. After an investigation, record each cause in the ledger.
 *   2. Before rendering, compare this run's causes against everything ever recorded.
 *
 * It does NOT decide that a problem was fixed. A cause that has stopped appearing is reported as
 * ABSENT THIS WEEK, which is not the same as solved: an expert may simply have framed it differently,
 * the evidence may have moved, or the finding may have been refused this run for a formatting slip.
 * Claiming credit for a fix we cannot see is exactly the kind of confident wrongness the whole product
 * is built to avoid.
 *
 * ---------------------------------------------------------------------------------------------
 * THE HARD PART IS IDENTITY, AND IT IS NOT THE `findingId`.
 *
 * Every run, three experts invent their own ids for what they find. Last week's
 * `no_sms_on_lead_form_traffic` is this week's `lead_form_leads_never_texted`, and `causeId` is no
 * better: it hashes the anchors AND the finding ids, so it changes when the wording does.
 *
 * So identity is derived from what the problem IS rather than what anyone called it: the mechanism
 * families the lanes named, plus the discriminating anchors. Two runs that blame the same mechanism at
 * the same KPI edges in the same workflows are looking at the same problem whatever they titled it.
 *
 * EXACT MATCH ALONE DID NOT WORK, AND THE EVIDENCE IS UNAMBIGUOUS.
 *
 * The fingerprint was exact-match and brittle on purpose, on the reasoning that a wrong match is
 * worse than a missed one. That reasoning is still right. The setting was not.
 *
 * Measured on Grom UK 2026-07-29: two runs of THE SAME CLOSED WEEK, over the same account and the
 * same evidence, produced 20 causes and 14 causes and matched ZERO of them. Not one anchor list was
 * identical to a prior one. The nearest pairs ran 22 anchors against 37, and 13 against 22, because
 * both halves of the fingerprint are written fresh by experts every run: they group findings into
 * causes differently, and they pick different family labels for the same mechanism. Demanding that
 * two independent panels produce byte-identical lists is demanding something that does not happen.
 *
 * A test that fails 100% of the time is not conservative. It reports every problem as brand new every
 * week, which is a confident claim in its own right and the opposite of the truth.
 *
 * So there are now THREE answers instead of two, and the middle one carries its own uncertainty:
 *
 *   RECURRING         the fingerprint matched exactly. A fact.
 *   LIKELY_RECURRING  the anchors overlap enough to be worth saying so. An opinion, reported WITH
 *                     the overlap, the shared anchor count, and whether the families agreed.
 *   NEW               nothing prior comes close.
 *
 * The safety property survives: nothing is ever silently merged. A similarity match is labelled as
 * one and shows its own evidence, so a reader can overrule it. What has gone is the pretence that
 * refusing to look was the same as being careful.
 * ---------------------------------------------------------------------------------------------
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { appendMemoryEvent } from './memory.mjs';
import { sha256 } from './canonical.mjs';

export const RECURRENCE_SCHEMA = '1.0.0';

/** How much anchor overlap makes two causes worth flagging as possibly the same. See the header. */
const NEAR_MATCH_OVERLAP = 0.6;

/**
 * The bar for LIKELY_RECURRING, and why it is a SYMMETRIC measure plus a floor.
 *
 * The obvious measure is containment, the shared anchors over the smaller set, and it is the wrong
 * one to decide on. Most problems in one account point at the same two or three busy workflows, so a
 * small genuinely-new problem sitting inside a large old one scores 100% and would be reported as
 * recurring. Replayed against Grom UK's real history, containment matched 14 of 14, which is the
 * right answer for two runs of the same week and far too eager for a real one.
 *
 * Jaccard, shared over the UNION, penalises exactly that size mismatch: it asks how much the two
 * problems are the same rather than how much of the smaller one is covered. The floor on shared
 * anchors then rules out coincidences among tiny sets. Containment is still computed and reported,
 * because it is the number that explains a partial match to a reader.
 */
const LIKELY_JACCARD = 0.5;
const LIKELY_SHARED_ANCHORS = 3;

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function byteOrder(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** The discriminating anchors only. Journey stages are near-universal and identify nothing. */
function discriminating(cause) {
  return (cause.anchors ?? [])
    .filter((anchor) => anchor.startsWith('kpi:') || anchor.startsWith('workflow:'))
    .sort(byteOrder);
}

/**
 * WHAT THIS PROBLEM IS, independent of what anyone called it this week.
 *
 * Mechanism families plus discriminating anchors. Not the title, not the finding ids, not the
 * `causeId`: all three move when a model rephrases itself, and a fingerprint that moves is a
 * fingerprint that reports every recurring problem as new.
 */
export function causeFingerprint(cause) {
  return sha256({
    mechanisms: [...(cause.mechanisms ?? [])].sort(byteOrder),
    anchors: discriminating(cause),
  });
}

/**
 * How much two causes point at the same objects, and how many objects that is.
 *
 * Containment rather than Jaccard: see `LIKELY_CONTAINMENT`. The raw shared COUNT is returned with it
 * because the ratio alone cannot tell a two-anchor cause sitting inside a large one from a real match.
 */
function similarity(cause, otherAnchors) {
  const a = new Set(discriminating(cause));
  const b = new Set(otherAnchors ?? []);
  if (a.size === 0 || b.size === 0) return { containment: 0, jaccard: 0, shared: 0 };
  let shared = 0;
  for (const key of a) if (b.has(key)) shared += 1;
  return {
    containment: shared / Math.min(a.size, b.size),
    jaccard: shared / (a.size + b.size - shared),
    shared,
  };
}

/** Anchor overlap between two causes, kept for the near-match report. */
function overlap(left, right) {
  return similarity(left, right).containment;
}

/**
 * STEP 1. Put this run's causes in the ledger.
 *
 * `occurredAt` comes from the RUN's own collection window, never from the clock. Two reasons: the
 * artefacts around this are write-once and byte-compared, so a wall-clock timestamp would make a
 * re-run of the same run id conflict with itself; and the honest date for "when was this observed" is
 * the end of the window the evidence covers, not the moment somebody happened to run the command.
 *
 * The event payload is deliberately THIN. `lib/memory.mjs` refuses any string containing a URL, an
 * email address or a phone number, and a cause title is written by an expert quoting real account
 * copy, so titles stay out of the ledger. The fingerprint is the join key; the words live in the
 * investigation record.
 */
export function recordRun({ paths, runId, investigation, occurredAt } = {}) {
  if (!isPlainObject(investigation)) throw Object.assign(new TypeError('RECURRENCE_INVESTIGATION_INVALID'), { code: 'RECURRENCE_INVESTIGATION_INVALID' });
  if (typeof occurredAt !== 'string' || !Number.isFinite(Date.parse(occurredAt))) {
    throw Object.assign(new Error('RECURRENCE_OCCURRED_AT_INVALID'), { code: 'RECURRENCE_OCCURRED_AT_INVALID' });
  }
  const recorded = [];
  for (const cause of investigation.causes ?? []) {
    const fingerprint = causeFingerprint(cause);
    const event = Object.freeze({
      schemaVersion: RECURRENCE_SCHEMA,
      // Derived from the run and the fingerprint, so replaying the same investigation is a no-op
      // rather than a second observation. `appendMemoryEvent` byte-compares and returns `recovered`.
      eventId: `obs_${sha256({ runId, fingerprint }).slice(0, 32)}`,
      type: 'finding_observed',
      occurredAt,
      findingId: cause.causeId,
      findingFingerprint: fingerprint,
      runId,
      mechanisms: Object.freeze([...(cause.mechanisms ?? [])].sort(byteOrder)),
      anchors: Object.freeze(discriminating(cause)),
      confidence: cause.confidence,
      rankScore: cause.rankScore,
    });
    const result = appendMemoryEvent({ paths, event });
    recorded.push({ fingerprint, causeId: cause.causeId, recovered: result.recovered });
  }
  return { recorded, count: recorded.length };
}

/**
 * Every observation ever recorded for this account, oldest first.
 *
 * Read straight off the ledger directory rather than through `projectBacklog`, because that projection
 * answers a different question (what is the state of each item, given approvals and receipts) and
 * throws on a sequence it cannot reconcile. All this needs is "when has this fingerprint been seen",
 * and a run that cannot read the history must still produce a report.
 */
export function readObservations({ paths } = {}) {
  const directory = paths?.memoryEvents;
  if (typeof directory !== 'string' || !existsSync(directory)) return [];
  const observations = [];
  for (const name of readdirSync(directory).sort()) {
    if (!name.endsWith('.json') || name.startsWith('.')) continue;
    let event;
    try {
      event = JSON.parse(readFileSync(join(directory, name), 'utf8'));
    } catch {
      continue;
    }
    if (event?.type !== 'finding_observed' || typeof event.findingFingerprint !== 'string') continue;
    observations.push(event);
  }
  return observations.sort((left, right) => (
    Date.parse(left.occurredAt) - Date.parse(right.occurredAt) || byteOrder(left.eventId, right.eventId)
  ));
}

/**
 * STEP 2. This week against every week before it.
 *
 * Three answers, and the third is the one nobody currently gets:
 *
 *   NEW        first time this fingerprint has been seen
 *   RECURRING  seen before, with when it was first seen and how many runs have carried it
 *   ABSENT     recorded previously and not present in this run
 *
 * ABSENT IS NOT FIXED and the wording says so wherever it is rendered. A cause can vanish because it
 * was solved, because an expert framed it differently, because its finding was refused this week, or
 * because the evidence moved. Only a `verification_result` in the ledger settles it, and nothing in
 * this product writes one yet.
 */
export function compareToHistory({ investigation, observations, runId } = {}) {
  const priorRuns = new Map();
  for (const event of observations ?? []) {
    if (event.runId === runId) continue;
    if (!priorRuns.has(event.findingFingerprint)) priorRuns.set(event.findingFingerprint, []);
    priorRuns.get(event.findingFingerprint).push(event);
  }

  const seenThisRun = new Set();
  // A prior problem matched by similarity is NOT absent this week. Without this the same problem is
  // reported twice, once as new and once as gone, which is how a report says two opposite things.
  const claimedByLikely = new Set();

  const scored = (investigation.causes ?? []).map((cause) => {
    const fingerprint = causeFingerprint(cause);
    seenThisRun.add(fingerprint);
    const prior = priorRuns.get(fingerprint) ?? [];
    /*
     * Rank every prior problem by how much of this one it accounts for, and keep the candidates worth
     * showing a reader. Done for exact matches too, so the shape is uniform, but unused by them.
     */
    const candidates = [...priorRuns.entries()]
      .map(([otherFingerprint, events]) => {
        const { containment, jaccard, shared } = similarity(cause, events[0].anchors ?? []);
        return {
          fingerprint: otherFingerprint,
          firstSeenAt: events[0].occurredAt,
          lastSeenAt: events[events.length - 1].occurredAt,
          priorRuns: [...new Set(events.map((event) => event.runId))].length,
          anchorOverlap: Number(containment.toFixed(2)),
          similarity: Number(jaccard.toFixed(2)),
          sharedAnchors: shared,
          // Agreement raises confidence but is NOT required. Two experts can file the same problem
          // under different families, and demanding they agree reintroduces the brittleness this
          // whole change exists to remove. The anchors are concrete account objects; the family is a
          // judgement about them.
          mechanismAgreement: (events[0].mechanisms ?? []).some((m) => (cause.mechanisms ?? []).includes(m)),
        };
      })
      .filter((candidate) => candidate.anchorOverlap >= NEAR_MATCH_OVERLAP)
      .sort((left, right) => (
        right.similarity - left.similarity
        || right.sharedAnchors - left.sharedAnchors
        || byteOrder(left.fingerprint, right.fingerprint)
      ));

    return { cause, fingerprint, prior, candidates };
  });

  /*
   * ONE ancestor per problem, and one problem per ancestor, assigned GLOBALLY by strength.
   *
   * Two of this week's causes both claiming the same earlier one means at least one is wrong, and it
   * also makes the absent list lie: replayed against the real history, four earlier problems were
   * claimed twice while ten were reported as gone with their descendants sitting in the same table.
   *
   * The assignment is done across all pairs at once, strongest first, rather than cause by cause.
   * Walking the causes in array order would let whichever happened to be first take an ancestor that
   * fits a later one better, so the same evidence could produce a different answer depending on the
   * order the experts' findings were grouped. These artefacts are hashed and byte-compared, so an
   * order-dependent result is a correctness problem and not only an aesthetic one.
   */
  const assignable = [];
  for (const entry of scored) {
    if (entry.prior.length > 0) continue;
    for (const candidate of entry.candidates) {
      if (candidate.similarity >= LIKELY_JACCARD && candidate.sharedAnchors >= LIKELY_SHARED_ANCHORS) {
        assignable.push({ causeId: entry.cause.causeId, candidate });
      }
    }
  }
  assignable.sort((left, right) => (
    right.candidate.similarity - left.candidate.similarity
    || right.candidate.sharedAnchors - left.candidate.sharedAnchors
    || byteOrder(left.causeId, right.causeId)
    || byteOrder(left.candidate.fingerprint, right.candidate.fingerprint)
  ));
  const assigned = new Map();
  for (const { causeId, candidate } of assignable) {
    if (assigned.has(causeId) || claimedByLikely.has(candidate.fingerprint)) continue;
    assigned.set(causeId, candidate);
    claimedByLikely.add(candidate.fingerprint);
  }

  const causes = scored.map(({ cause, fingerprint, prior, candidates }) => {
    if (prior.length > 0) {
      return {
        causeId: cause.causeId,
        fingerprint,
        status: 'RECURRING',
        firstSeenAt: prior[0].occurredAt,
        priorRuns: [...new Set(prior.map((event) => event.runId))].length,
        matchedOn: 'fingerprint',
        nearMatches: [],
      };
    }
    /*
     * A similarity match is LIKELY_RECURRING, never RECURRING. That distinction is the safety
     * argument: an exact fingerprint is a fact, a strong overlap is an opinion, and the report says
     * which one it is holding along with the number behind it. A reader can overrule an opinion; they
     * cannot overrule a silent merge.
     */
    const best = assigned.get(cause.causeId);
    const isLikely = best !== undefined;
    return {
      causeId: cause.causeId,
      fingerprint,
      status: isLikely ? 'LIKELY_RECURRING' : 'NEW',
      firstSeenAt: isLikely ? best.firstSeenAt : null,
      priorRuns: isLikely ? best.priorRuns : 0,
      matchedOn: isLikely ? 'anchor_overlap' : null,
      ...(isLikely ? { matchedFingerprint: best.fingerprint, match: best } : {}),
      nearMatches: candidates,
    };
  });

  const absent = [...priorRuns.entries()]
    .filter(([fingerprint]) => !seenThisRun.has(fingerprint) && !claimedByLikely.has(fingerprint))
    .map(([fingerprint, events]) => ({
      fingerprint,
      firstSeenAt: events[0].occurredAt,
      lastSeenAt: events[events.length - 1].occurredAt,
      priorRuns: [...new Set(events.map((event) => event.runId))].length,
    }))
    .sort((left, right) => byteOrder(left.lastSeenAt, right.lastSeenAt) || byteOrder(left.fingerprint, right.fingerprint));

  return {
    schemaVersion: RECURRENCE_SCHEMA,
    // Zero prior runs is the normal state on a first run, and it is stated rather than left to be
    // inferred from an empty comparison.
    priorRunCount: [...new Set((observations ?? []).filter((e) => e.runId !== runId).map((e) => e.runId))].length,
    causes,
    absent,
    newCount: causes.filter((cause) => cause.status === 'NEW').length,
    recurringCount: causes.filter((cause) => cause.status === 'RECURRING').length,
    likelyRecurringCount: causes.filter((cause) => cause.status === 'LIKELY_RECURRING').length,
  };
}
