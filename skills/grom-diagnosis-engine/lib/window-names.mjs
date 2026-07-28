/**
 * THE CANONICAL WINDOW SET, in report order.
 *
 * It lives in its own dependency-free module because two layers have to agree on it exactly:
 * `lib/metrics.mjs`, which BUILDS the windows, and `schemas/v1.mjs`, which VALIDATES a metric
 * edge's declared reporting windows against them. Neither can import the other without dragging a
 * dependency where it does not belong — the contracts bundle is built with only `zod` external, so
 * reaching `metrics.mjs` from a schema would ship the Temporal polyfill inside a schema bundle, and
 * reaching `schemas/v1.mjs` from the metric engine would put zod and `node:fs` behind every metric
 * computation. One list, two importers, no copy to drift.
 *
 * Ordered by lookback length, shortest first, and that order is the order metrics are REPORTED in.
 */
export const WINDOW_NAMES = Object.freeze([
  'currentClosedWeek',
  'previousClosedWeek',
  'trailing28Days',
  'trailing60Days',
  'trailing90Days',
  'trailing180Days',
]);

/**
 * WHAT AN EDGE THAT DECLARES NOTHING REPORTS ON.
 *
 * Exactly the window set that existed before the maturity-ladder change, and deliberately NOT
 * `WINDOW_NAMES`. Adding a window to `buildWindows` must never retroactively change what an
 * already-shipped edge reports: a 2-day-lag engagement edge has no business being published over a
 * 180-day lookback, and an operator comparing this week's run to last week's must not find new
 * cells appearing under edges nobody touched. A new window is therefore OPT-IN, by declaring
 * `reportingWindows` on the edge that wants it.
 *
 * The converse — an edge that declares nothing keeps byte-identical behaviour — is what makes this
 * change safe to land on top of contracts written before it existed.
 */
export const DEFAULT_REPORTING_WINDOWS = Object.freeze([
  'currentClosedWeek',
  'previousClosedWeek',
  'trailing28Days',
  'trailing90Days',
]);
