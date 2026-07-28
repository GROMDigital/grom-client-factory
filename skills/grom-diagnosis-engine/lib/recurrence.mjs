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
 * That is exact-match, and it is BRITTLE ON PURPOSE. Rename a workflow and the fingerprint changes.
 * Rather than loosen it and quietly merge two different problems across weeks, an exact miss is
 * reported as NEW and a near miss is reported separately as "possibly the same as", with the overlap
 * stated so a reader can judge. A wrong match across weeks is worse than an unmatched pair, because it
 * would let the report claim a problem is recurring when it is not, or that it went away when it did
 * not.
 * ---------------------------------------------------------------------------------------------
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { appendMemoryEvent } from './memory.mjs';
import { sha256 } from './canonical.mjs';

export const RECURRENCE_SCHEMA = '1.0.0';

/** How much anchor overlap makes two causes worth flagging as possibly the same. See the header. */
const NEAR_MATCH_OVERLAP = 0.6;

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

/** Anchor overlap between two causes, for the near-match report only. Never for matching. */
function overlap(left, right) {
  const a = new Set(discriminating(left));
  const b = new Set(right);
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const key of a) if (b.has(key)) shared += 1;
  return shared / Math.min(a.size, b.size);
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
  const causes = (investigation.causes ?? []).map((cause) => {
    const fingerprint = causeFingerprint(cause);
    seenThisRun.add(fingerprint);
    const prior = priorRuns.get(fingerprint) ?? [];
    if (prior.length > 0) {
      return {
        causeId: cause.causeId,
        fingerprint,
        status: 'RECURRING',
        firstSeenAt: prior[0].occurredAt,
        priorRuns: [...new Set(prior.map((event) => event.runId))].length,
        nearMatches: [],
      };
    }
    /*
     * No exact match. Before calling it new, look for a prior observation that is probably the same
     * problem with shifted anchors, and REPORT it rather than silently matching on it.
     */
    const nearMatches = [...priorRuns.entries()]
      .filter(([, events]) => {
        const [first] = events;
        const sameMechanism = (first.mechanisms ?? []).some((m) => (cause.mechanisms ?? []).includes(m));
        return sameMechanism && overlap(cause, first.anchors ?? []) >= NEAR_MATCH_OVERLAP;
      })
      .map(([otherFingerprint, events]) => ({
        fingerprint: otherFingerprint,
        firstSeenAt: events[0].occurredAt,
        anchorOverlap: Number(overlap(cause, events[0].anchors ?? []).toFixed(2)),
      }))
      .sort((left, right) => right.anchorOverlap - left.anchorOverlap || byteOrder(left.fingerprint, right.fingerprint));

    return {
      causeId: cause.causeId,
      fingerprint,
      status: 'NEW',
      firstSeenAt: null,
      priorRuns: 0,
      nearMatches,
    };
  });

  const absent = [...priorRuns.entries()]
    .filter(([fingerprint]) => !seenThisRun.has(fingerprint))
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
  };
}
