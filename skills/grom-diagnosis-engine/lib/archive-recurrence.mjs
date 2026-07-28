/**
 * READING LAST WEEK'S `CHANGES-MADE.md`, AND DECIDING WHETHER IT CAN BE TRUSTED AT ALL.
 *
 * Extracted from `scripts/archive-run.mjs` so it can be tested. It could not be before — that
 * script is top-to-bottom with no exports — and an external review pointed out that the most
 * consequential logic in the archive had no test at all. The word this code can produce is
 * "fixed", about a problem in a real client's account, so it is the last place to run untested.
 *
 * ---------------------------------------------------------------------------------------------
 * THE JOIN KEY IS THE FINGERPRINT, NEVER THE causeId.
 *
 * `causeId` hashes model-invented finding ids, so an expert rewording the same finding produces a
 * different id and the problem would be reported as SOLVED. `causeFingerprint` is built from the
 * mechanism plus the discriminating anchors, so it survives a rewrite of the prose.
 *
 * AND THE FILE IS ALL-OR-NOTHING. A first version asked whether ANY block carried a fingerprint,
 * which is a different question and hides a false "fixed": nine good blocks make the file look
 * modern, and the tenth — a DONE cause whose fingerprint line was deleted, never filled in, or
 * mangled — then matches nothing this week and is reported as solved. Duplicates are refused for
 * the mirror reason. One bad line invalidates the whole comparison, and that is the correct
 * trade: a refused comparison costs a week of week-over-week reporting, and a false "fixed" costs
 * a client a problem everyone now believes is gone.
 * ---------------------------------------------------------------------------------------------
 */

/** A block heading and its body, up to the next heading. `(?![\s\S])` is end-of-input. */
const BLOCK = /^### (cause_[a-f0-9]+)\n([\s\S]*?)(?=^#{2,3} |(?![\s\S]))/gmu;
const FINGERPRINT = /^[a-f0-9]{8,}$/u;

/**
 * Parse the blocks out of a `CHANGES-MADE.md`.
 *
 * Returns a Map of causeId to `{ status, did, print }`. Nothing is judged here; see `joinable`.
 */
export function parseChangesMade(text) {
  const claimed = new Map();
  for (const match of String(text ?? '').matchAll(BLOCK)) {
    claimed.set(match[1], {
      status: (match[2].match(/\*\*Status:\*\*\s*(.+)/u)?.[1] ?? '').trim() || 'NOT STARTED',
      did: (match[2].match(/\*\*What was actually done:\*\*\s*(.*)/u)?.[1] ?? '').trim(),
      print: (match[2].match(/\*\*fingerprint:\*\*\s*`([a-f0-9]+)`/u)?.[1] ?? '').trim(),
    });
  }
  return claimed;
}

/**
 * May last week's file be joined to this week at all?
 *
 * EVERY parsed block must carry a valid fingerprint, and no two may share one. An empty file is
 * not joinable either, but that is a different message: nothing was ever recorded, rather than
 * something was recorded badly.
 */
export function joinable(claimed) {
  if (claimed.size === 0) return { ok: false, reason: 'EMPTY' };
  const prints = [...claimed.values()].map((value) => value.print);
  if (!prints.every((print) => FINGERPRINT.test(print))) {
    return { ok: false, reason: 'MISSING_FINGERPRINT', missing: prints.filter((print) => !FINGERPRINT.test(print)).length };
  }
  if (new Set(prints).size !== prints.length) return { ok: false, reason: 'DUPLICATE_FINGERPRINT' };
  return { ok: true, reason: 'OK' };
}

/**
 * Compare last week's claims against this week's causes.
 *
 * Returns empty buckets and `concluded: false` whenever the file is not joinable, so a caller that
 * forgets to check `joinable` still cannot accidentally report anything as fixed.
 */
export function compareWeeks({ claimed, thisWeeksFingerprints }) {
  const verdict = joinable(claimed);
  const prints = new Set(thisWeeksFingerprints ?? []);
  if (!verdict.ok) {
    return { concluded: false, verdict, acted: [], gone: [], stillHere: [], untouchedGone: [] };
  }
  const present = (value) => value.print !== '' && prints.has(value.print);
  const entries = [...claimed.entries()];
  const acted = entries.filter(([, value]) => /^DONE/u.test(value.status));
  return {
    concluded: true,
    verdict,
    acted,
    // Changed, and the problem is no longer found. The only combination that earns "fixed".
    gone: acted.filter(([, value]) => !present(value)),
    // Changed, and still found. The fix did not work or did not address the cause.
    stillHere: acted.filter(([, value]) => present(value)),
    // Never actioned, and gone anyway. Not a fix; something else moved.
    untouchedGone: entries.filter(([, value]) => !/^DONE/u.test(value.status) && !present(value)),
  };
}
