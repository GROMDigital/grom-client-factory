/**
 * THE MATURITY LADDER — `trailing60Days` / `trailing180Days`, and per-edge reporting windows.
 *
 * Owner decision, 2026-07-27. A window no LONGER than an edge's `allowedLag` can mature almost
 * nobody, because only a subject entering on the window's very first instant has had the whole lag
 * elapse by the cutoff. So the same measurement is declared at three maturities, each over a
 * lookback of roughly double its lag:
 *
 *   allowed lag 30 days -> trailing 60 days    reacts fast, shows whether a recent change worked
 *   allowed lag 60 days -> trailing 90 days    the middle read
 *   allowed lag 90 days -> trailing 180 days   the true settled number, too slow to attribute
 *
 * Every expectation in this file is HAND-STATED from the fixture and never read back from the code
 * under test. The two simulation fixtures below are built from a rule simple enough to count in the
 * head — one consultation per day, every third one converting twenty days later — precisely so that
 * "52 weeks x denominator 30" is an arithmetic claim and not an observation.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_REPORTING_WINDOWS,
  WINDOW_NAMES,
  buildWindows,
  computeJourneyMetrics,
} from '../lib/metrics.mjs';
import { MetricEdgeSchema, loadMetricContracts } from '../schemas/v1.mjs';

const DAY = 86_400_000;

function deepFreeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

// ===========================================================================
// 1. THE WINDOWS THEMSELVES
// ===========================================================================

test('trailing60Days and trailing180Days share the closed-week Monday and measure real hours', () => {
  // 2026-03-09 is a Monday. The cutoff sits mid-morning; the boundary is the start of that day.
  const built = buildWindows({
    cutoff: '2026-03-09T10:15:00-07:00',
    timezone: 'America/Los_Angeles',
    maturityDays: 0,
  });
  for (const name of ['trailing28Days', 'trailing60Days', 'trailing90Days', 'trailing180Days']) {
    assert.equal(built[name].end, built.currentClosedWeek.end, `${name} end`);
    assert.equal(built[name].end, '2026-03-09T00:00:00-07:00[America/Los_Angeles]', `${name} end`);
  }
  // 2026-03-09 minus 60 calendar days is 2026-01-08, still PST.
  assert.equal(built.trailing60Days.start, '2026-01-08T00:00:00-08:00[America/Los_Angeles]');
  // 2026-03-09 minus 180 calendar days is 2025-09-10, PDT.
  assert.equal(built.trailing180Days.start, '2025-09-10T00:00:00-07:00[America/Los_Angeles]');
  // 60 days = 1440 hours, less ONE for the 2026-03-08 spring-forward inside the span.
  assert.equal(built.trailing60Days.durationHours, 1439);
  // 180 days = 4320 hours, PLUS one for the 2025-11-02 fall-back and LESS one for 2026-03-08.
  assert.equal(built.trailing180Days.durationHours, 4320);

  const sydney = buildWindows({
    cutoff: '2026-04-13T09:00:00+10:00',
    timezone: 'Australia/Sydney',
    maturityDays: 0,
  });
  // 2026-04-13 minus 60 days is 2026-02-12, and minus 180 days is 2025-10-15. Both AEDT.
  assert.equal(sydney.trailing60Days.start, '2026-02-12T00:00:00+11:00[Australia/Sydney]');
  assert.equal(sydney.trailing180Days.start, '2025-10-15T00:00:00+11:00[Australia/Sydney]');
  // Both spans contain exactly one transition, the 2026-04-05 fall-back, which ADDS an hour.
  assert.equal(sydney.trailing60Days.durationHours, 1441);
  assert.equal(sydney.trailing180Days.durationHours, 4321);

  // Deep-frozen and deterministic, like every other window.
  assert.equal(Object.isFrozen(built.trailing180Days), true);
  assert.equal(
    JSON.stringify(built),
    JSON.stringify(buildWindows({
      cutoff: '2026-03-09T10:15:00-07:00',
      timezone: 'America/Los_Angeles',
      maturityDays: 0,
    })),
  );
});

test('the window name list is exactly the six windows buildWindows produces, in report order', () => {
  const built = buildWindows({ cutoff: '2026-07-27T00:00:00Z', timezone: 'UTC', maturityDays: 0 });
  assert.deepEqual([...WINDOW_NAMES], [
    'currentClosedWeek',
    'previousClosedWeek',
    'trailing28Days',
    'trailing60Days',
    'trailing90Days',
    'trailing180Days',
  ]);
  for (const name of WINDOW_NAMES) assert.ok(built[name], `buildWindows must produce ${name}`);
  // The default set is the PRE-CHANGE window set: the ladder rungs are opt-in and nothing else.
  assert.deepEqual([...DEFAULT_REPORTING_WINDOWS], [
    'currentClosedWeek',
    'previousClosedWeek',
    'trailing28Days',
    'trailing90Days',
  ]);
});

// ===========================================================================
// 2. THE SIX-SUBJECT FIXTURE — every count below is countable by eye
// ===========================================================================

/*
 * Cutoff 2026-07-27T00:00:00Z, a Monday, `maturityDays: 1`. So:
 *   trailing60Days   [2026-05-28, 2026-07-27)
 *   trailing90Days   [2026-04-28, 2026-07-27)
 *   trailing180Days  [2026-01-28, 2026-07-27)
 *   matureAsOf        2026-07-26
 *
 * SIX subjects, each with one `showed`, four of them with one `opportunity_outcome`:
 *
 *   s1  showed 2026-02-10  outcome 2026-02-20  (+10 days)
 *   s2  showed 2026-03-10  outcome 2026-05-24  (+75 days — the slow closer)
 *   s3  showed 2026-04-01  no outcome
 *   s4  showed 2026-05-10  outcome 2026-05-20  (+10 days)
 *   s5  showed 2026-06-10  outcome 2026-06-20  (+10 days)
 *   s6  showed 2026-07-10  no outcome
 */
const LADDER_CUTOFF = '2026-07-27T00:00:00.000Z';
const LADDER_WINDOWS = buildWindows({
  cutoff: LADDER_CUTOFF,
  timezone: 'UTC',
  maturityDays: 1,
});

const SUBJECTS = Object.freeze([
  { id: 1, showed: '2026-02-10T09:00:00.000Z', outcome: '2026-02-20T09:00:00.000Z' },
  { id: 2, showed: '2026-03-10T09:00:00.000Z', outcome: '2026-05-24T09:00:00.000Z' },
  { id: 3, showed: '2026-04-01T09:00:00.000Z', outcome: null },
  { id: 4, showed: '2026-05-10T09:00:00.000Z', outcome: '2026-05-20T09:00:00.000Z' },
  { id: 5, showed: '2026-06-10T09:00:00.000Z', outcome: '2026-06-20T09:00:00.000Z' },
  { id: 6, showed: '2026-07-10T09:00:00.000Z', outcome: null },
]);

function journeyNode(serial, stage, eventTime) {
  const subject = `psn_${String(serial).padStart(16, '0')}`;
  return {
    nodeId: `node_${stage}_${serial}`,
    type: 'journey_event',
    classification: 'OBSERVED',
    journeyId: 'client_sales',
    journeyInstanceId: 'journey_client_sales',
    subjectRef: subject,
    stage,
    eventTime,
    capturedAt: eventTime,
    provenance: { completeness: 'COMPLETE' },
    evidenceRefs: [`ev_${stage.slice(0, 2)}${String(serial).padStart(14, '0')}`],
  };
}

function graphOf(nodes) {
  return deepFreeze({
    nodes,
    edges: nodes.map((node) => ({
      type: 'identity_exact',
      fromNodeId: `entity_${node.subjectRef}`,
      toNodeId: node.nodeId,
      joinMethod: 'native_id',
      joinConfidence: 'exact',
    })),
    conflicts: [],
    unresolvedJoins: [],
  });
}

function ladderGraph() {
  const nodes = [];
  for (const subject of SUBJECTS) {
    nodes.push(journeyNode(subject.id, 'showed', subject.showed));
    if (subject.outcome) {
      nodes.push(journeyNode(subject.id, 'opportunity_outcome', subject.outcome));
    }
  }
  return graphOf(nodes);
}

function outcomeEdge(edgeId, lagDays, reportingWindows) {
  return {
    edgeId,
    journeyId: 'client_sales',
    journeyInstanceId: 'journey_client_sales',
    fromStage: 'showed',
    toStage: 'opportunity_outcome',
    eligibilityRule: {},
    fromEventFields: [],
    toEventFields: [],
    allowedLag: { amount: lagDays, unit: 'days' },
    maturityRule: {},
    dispositions: ['won', 'lost', 'open', 'unknown'],
    reentryRule: 'same_journey_instance',
    outcomeRule: {},
    required: true,
    nativeMapping: 'MAPPED',
    ...(reportingWindows === undefined ? {} : { reportingWindows }),
  };
}

function measure(graph, edges, windows = LADDER_WINDOWS) {
  return computeJourneyMetrics({
    graph,
    metricContracts: { profileId: 'client', version: '1.0.0', coverageFloor: 0.8, edges },
    windows,
  });
}

test('THE POINT — the 90-day measurement is blank on a 90-day window and lands on a 180-day one', () => {
  const graph = ladderGraph();

  /*
   * THE OLD ARRANGEMENT: 90 days of lag reported over a 90-day window.
   * Entrants inside [2026-04-28, 2026-07-27) are s4, s5 and s6. For ANY of them to mature, the
   * entrant + 90 days would have to land on or before the cutoff, and the earliest of the three
   * showed on 2026-05-10, which matures on 2026-08-08. So nothing matures, ever.
   */
  const legacy = measure(graph, [outcomeEdge('outcome_legacy', 90)])
    .metrics.trailing90Days.outcome_legacy;
  assert.equal(legacy.state, 'UNKNOWN');
  assert.equal(legacy.reasonCode, 'IMMATURE_COHORT');
  assert.equal(legacy.denominator, null);
  assert.equal(legacy.eligible, 3);
  assert.equal(legacy.immature, 3);
  assert.equal(legacy.excluded, 0);

  /*
   * THE SETTLED RUNG: the same 90 days of lag reported over 180.
   * Entrants inside [2026-01-28, 2026-07-27) are all six. Mature (entrant + 90d <= cutoff):
   * s1 (2026-05-11), s2 (2026-06-08) and s3 (2026-06-30). s4, s5 and s6 are still inside their lag.
   * Of the three measurable, s1 converted after 10 days and s2 after 75, both inside 90; s3 never
   * converted. So 2 of 3.
   */
  const settled = measure(graph, [outcomeEdge('outcome_90d', 90, ['trailing180Days'])])
    .metrics.trailing180Days.outcome_90d;
  assert.equal(settled.state, 'OBSERVED');
  assert.equal(settled.numerator, 2);
  assert.equal(settled.denominator, 3);
  assert.equal(settled.rate, 2 / 3);
  assert.equal(settled.eligible, 6);
  assert.equal(settled.immature, 3);
  assert.equal(settled.excluded, 0);
  assert.equal(settled.coverageRatio, 1);
  assert.equal(settled.maturityRatio, 3 / 6);
  // Nothing was distrusted, but half the window cannot be spoken for yet, so NOT complete.
  assert.equal(settled.coverage, 'INCOMPLETE');
});

test('all three rungs report a number on the same six subjects, over their own populations', () => {
  const graph = ladderGraph();
  const { metrics } = measure(graph, [
    outcomeEdge('outcome_30d', 30, ['trailing60Days']),
    outcomeEdge('outcome_60d', 60, ['trailing90Days']),
    outcomeEdge('outcome_90d', 90, ['trailing180Days']),
  ]);

  /*
   * FAST RUNG. Window [2026-05-28, 2026-07-27) holds s5 and s6. s5 + 30d = 2026-07-10, on or
   * before the cutoff, so it matures; s6 + 30d = 2026-08-09 does not. s5 converted after 10 days.
   */
  const fast = metrics.trailing60Days.outcome_30d;
  assert.equal(fast.state, 'OBSERVED');
  assert.equal(fast.numerator, 1);
  assert.equal(fast.denominator, 1);
  assert.equal(fast.eligible, 2);
  assert.equal(fast.immature, 1);

  /*
   * MIDDLE RUNG. Window [2026-04-28, 2026-07-27) holds s4, s5 and s6. s4 + 60d = 2026-07-09
   * matures; s5 + 60d = 2026-08-09 and s6 + 60d = 2026-09-08 do not. s4 converted after 10 days.
   */
  const mid = metrics.trailing90Days.outcome_60d;
  assert.equal(mid.state, 'OBSERVED');
  assert.equal(mid.numerator, 1);
  assert.equal(mid.denominator, 1);
  assert.equal(mid.eligible, 3);
  assert.equal(mid.immature, 2);

  const settled = metrics.trailing180Days.outcome_90d;
  assert.equal(settled.numerator, 2);
  assert.equal(settled.denominator, 3);

  // Each rung lands in ITS window and nowhere else. This is the per-edge declaration doing its job.
  assert.deepEqual(Object.keys(metrics.trailing60Days), ['outcome_30d']);
  assert.deepEqual(Object.keys(metrics.trailing90Days), ['outcome_60d']);
  assert.deepEqual(Object.keys(metrics.trailing180Days), ['outcome_90d']);
  assert.deepEqual(Object.keys(metrics.currentClosedWeek), []);
});

test('a shorter lag TRUNCATES the conversion window, so the rungs are not interchangeable', () => {
  const graph = ladderGraph();
  /*
   * The same 180-day window, read at 30 days of lag instead of 90. Entrants are all six; mature at
   * 30 days are s1..s5 (s6 + 30d = 2026-08-09 is past the cutoff). Of those five, s1 (+10), s4
   * (+10) and s5 (+10) converted inside 30 days; s2 took 75 days, which the 90-day rung counts and
   * the 30-day rung does NOT; s3 never converted.
   *
   * So the fast rung is a LEADING INDICATOR of the settled number and not an early estimate of it:
   * it necessarily reads lower on any account with slow closers, which for a clinic is real money.
   */
  const truncated = measure(graph, [outcomeEdge('outcome_30d_wide', 30, ['trailing180Days'])])
    .metrics.trailing180Days.outcome_30d_wide;
  assert.equal(truncated.numerator, 3);
  assert.equal(truncated.denominator, 5);
  assert.equal(truncated.eligible, 6);
  assert.equal(truncated.immature, 1);
});

// ===========================================================================
// 3. THE PER-EDGE DECLARATION
// ===========================================================================

test('an edge that declares nothing reports on exactly the pre-change window set', () => {
  const graph = ladderGraph();
  const { metrics, cohorts } = measure(graph, [outcomeEdge('outcome_default', 90)]);
  assert.deepEqual(Object.keys(metrics), [...DEFAULT_REPORTING_WINDOWS]);
  assert.deepEqual(Object.keys(cohorts), [...DEFAULT_REPORTING_WINDOWS]);
  for (const name of DEFAULT_REPORTING_WINDOWS) {
    assert.deepEqual(Object.keys(metrics[name]), ['outcome_default']);
  }
  // The ladder windows were BUILT and are still absent: nothing declared them.
  assert.ok(LADDER_WINDOWS.trailing60Days && LADDER_WINDOWS.trailing180Days);
  assert.equal(Object.hasOwn(metrics, 'trailing60Days'), false);
  assert.equal(Object.hasOwn(metrics, 'trailing180Days'), false);
});

test('the default spine is reported even when every edge declares somewhere else', () => {
  const graph = ladderGraph();
  const { metrics, cohorts } = measure(graph, [outcomeEdge('outcome_90d', 90, ['trailing180Days'])]);
  // Windows in report order: the four spine windows, empty, plus the one that was declared.
  assert.deepEqual(Object.keys(metrics), [
    'currentClosedWeek',
    'previousClosedWeek',
    'trailing28Days',
    'trailing90Days',
    'trailing180Days',
  ]);
  assert.deepEqual(Object.keys(metrics.trailing28Days), []);
  assert.deepEqual(cohorts.trailing28Days, {});
  // "This week reported nothing" is a fact worth publishing, not a key worth deleting.
  assert.deepEqual(Object.keys(cohorts), Object.keys(metrics));
});

test('a window the caller never built is skipped even when an edge declares it', () => {
  const graph = ladderGraph();
  const narrow = deepFreeze({
    cutoff: LADDER_WINDOWS.cutoff,
    matureAsOf: LADDER_WINDOWS.matureAsOf,
    currentClosedWeek: { ...LADDER_WINDOWS.currentClosedWeek },
    trailing90Days: { ...LADDER_WINDOWS.trailing90Days },
  });
  const { metrics } = measure(
    graph,
    [outcomeEdge('outcome_90d', 90, ['trailing180Days']), outcomeEdge('outcome_60d', 60, ['trailing90Days'])],
    narrow,
  );
  assert.deepEqual(Object.keys(metrics), ['currentClosedWeek', 'trailing90Days']);
  assert.deepEqual(Object.keys(metrics.trailing90Days), ['outcome_60d']);
});

test('a broken reportingWindows declaration throws rather than reporting everywhere', () => {
  const graph = ladderGraph();
  for (const broken of [
    [],
    ['trailing365Days'],
    ['trailing60Days', 'trailing60Days'],
    'trailing60Days',
    ['trailing60Days', null],
  ]) {
    assert.throws(
      () => measure(graph, [outcomeEdge('outcome_broken', 30, broken)]),
      (error) => error.code === 'METRICS_CONTRACT_INVALID',
      `${JSON.stringify(broken)} must be refused`,
    );
  }
});

test('the schema refuses the same declarations the engine refuses', () => {
  const valid = MetricEdgeSchema.parse(outcomeEdge('outcome_30d', 30, ['trailing60Days']));
  assert.deepEqual(valid.reportingWindows, ['trailing60Days']);
  // Absent is legal and stays absent, so the engine can tell "not declared" from "declared empty".
  assert.equal(Object.hasOwn(MetricEdgeSchema.parse(outcomeEdge('e', 30)), 'reportingWindows'), false);
  for (const broken of [[], ['nope'], ['trailing60Days', 'trailing60Days'], 'trailing60Days']) {
    assert.throws(() => MetricEdgeSchema.parse(outcomeEdge('outcome_broken', 30, broken)));
  }
});

test('the shipped profiles declare the ladder as data, at three lags over three windows', () => {
  for (const [profileId, prefix] of [
    ['client', 'showed_to_opportunity_outcome'],
    ['grom_internal', 'showed_to_decision'],
  ]) {
    const byId = new Map(loadMetricContracts(profileId).edges.map((edge) => [edge.edgeId, edge]));
    for (const [edgeId, lagDays, window] of [
      [`${prefix}_30d`, 30, 'trailing60Days'],
      [`${prefix}_60d`, 60, 'trailing90Days'],
      [prefix, 90, 'trailing180Days'],
    ]) {
      const edge = byId.get(edgeId);
      assert.ok(edge, `${profileId} must declare ${edgeId}`);
      assert.equal(edge.allowedLag.amount, lagDays, `${edgeId} lag`);
      assert.equal(edge.allowedLag.unit, 'days', `${edgeId} lag unit`);
      assert.deepEqual(edge.reportingWindows, [window], `${edgeId} window`);
      assert.equal(edge.nativeMapping, 'MAPPED', `${edgeId} mapping`);
    }
    // Every OTHER edge keeps the pre-change behaviour by declaring nothing at all.
    for (const edge of byId.values()) {
      if (edge.fromStage === 'showed' && edge.toStage.match(/^(opportunity_outcome|decision)$/)) continue;
      assert.equal(
        Object.hasOwn(edge, 'reportingWindows'),
        false,
        `${profileId}/${edge.edgeId} must not have been given a window declaration`,
      );
    }
  }
});

// ===========================================================================
// 4. 52 CONSECUTIVE WEEKLY RUNS
// ===========================================================================

/*
 * THE SIMULATED ACCOUNT, built from a rule simple enough that every number below is arithmetic.
 *
 * ONE consultation per day at 09:00 UTC, forever. EVERY THIRD one converts, exactly 20 days later.
 * `capturedAt === eventTime`, so a run with an earlier cutoff genuinely cannot see the future —
 * which is what makes replaying one graph at 52 cutoffs a faithful simulation of 52 weekly runs.
 *
 * Take any cutoff E at 00:00 on a Monday. A subject that showed on day d matures against a lag of
 * L days when d + L <= E, and since the consultation is at 09:00 that means d <= E - L - 1.
 *
 *   30 days of lag over [E-60, E):   60 entrants, of which d in [E-60, E-31] mature  -> 30
 *   60 days of lag over [E-90, E):   90 entrants, of which d in [E-90, E-61] mature  -> 30
 *   90 days of lag over [E-180, E): 180 entrants, of which d in [E-180, E-91] mature -> 90
 *   90 days of lag over [E-90, E):   90 entrants, of which NONE mature               ->  0
 *
 * The last line is the arrangement being replaced, and it is blank in every one of the 52 weeks.
 * Every converter takes 20 days, which is inside all three lags, so the numerator is exactly one
 * third of each denominator.
 */
const FIRST_CUTOFF_MS = Date.parse('2025-08-04T00:00:00.000Z'); // a Monday
const SIM_WEEKS = 52;
const SIM_FIRST_DAY_MS = FIRST_CUTOFF_MS - (200 * DAY);
const SIM_DAYS = 200 + (SIM_WEEKS * 7) + 1;

function simulatedAccount() {
  const nodes = [];
  for (let day = 0; day < SIM_DAYS; day += 1) {
    const showedMs = SIM_FIRST_DAY_MS + (day * DAY) + (9 * 3_600_000);
    nodes.push(journeyNode(day + 1, 'showed', new Date(showedMs).toISOString()));
    if (day % 3 !== 0) continue;
    nodes.push(journeyNode(
      day + 1,
      'opportunity_outcome',
      new Date(showedMs + (20 * DAY)).toISOString(),
    ));
  }
  return graphOf(nodes);
}

test('52 consecutive weekly runs — the ladder reports every week, the old arrangement never does', () => {
  const graph = simulatedAccount();
  const edges = [
    outcomeEdge('outcome_legacy', 90),
    outcomeEdge('outcome_30d', 30, ['trailing60Days']),
    outcomeEdge('outcome_60d', 60, ['trailing90Days']),
    outcomeEdge('outcome_90d', 90, ['trailing180Days']),
  ];
  const tally = {
    outcome_legacy: { produced: 0, denominators: 0 },
    outcome_30d: { produced: 0, denominators: 0 },
    outcome_60d: { produced: 0, denominators: 0 },
    outcome_90d: { produced: 0, denominators: 0 },
  };
  for (let week = 0; week < SIM_WEEKS; week += 1) {
    const cutoff = new Date(FIRST_CUTOFF_MS + (week * 7 * DAY)).toISOString();
    const { metrics } = computeJourneyMetrics({
      graph,
      metricContracts: { profileId: 'client', version: '1.0.0', coverageFloor: 0.8, edges },
      windows: buildWindows({ cutoff, timezone: 'UTC', maturityDays: 1 }),
    });
    const cells = {
      outcome_legacy: metrics.trailing90Days.outcome_legacy,
      outcome_30d: metrics.trailing60Days.outcome_30d,
      outcome_60d: metrics.trailing90Days.outcome_60d,
      outcome_90d: metrics.trailing180Days.outcome_90d,
    };
    for (const [edgeId, cell] of Object.entries(cells)) {
      if (cell.state !== 'OBSERVED' || !(cell.denominator > 0)) continue;
      tally[edgeId].produced += 1;
      tally[edgeId].denominators += cell.denominator;
    }
    // HAND-STATED, and identical in every one of the 52 weeks by the arithmetic above.
    assert.equal(cells.outcome_legacy.state, 'UNKNOWN', `week ${week} legacy state`);
    assert.equal(cells.outcome_legacy.reasonCode, 'IMMATURE_COHORT', `week ${week} legacy reason`);
    assert.equal(cells.outcome_legacy.eligible, 90, `week ${week} legacy eligible`);
    assert.equal(cells.outcome_legacy.immature, 90, `week ${week} legacy immature`);

    assert.equal(cells.outcome_30d.denominator, 30, `week ${week} 30d denominator`);
    assert.equal(cells.outcome_30d.eligible, 60, `week ${week} 30d eligible`);
    assert.equal(cells.outcome_30d.numerator, 10, `week ${week} 30d numerator`);

    assert.equal(cells.outcome_60d.denominator, 30, `week ${week} 60d denominator`);
    assert.equal(cells.outcome_60d.eligible, 90, `week ${week} 60d eligible`);
    assert.equal(cells.outcome_60d.numerator, 10, `week ${week} 60d numerator`);

    assert.equal(cells.outcome_90d.denominator, 90, `week ${week} 90d denominator`);
    assert.equal(cells.outcome_90d.eligible, 180, `week ${week} 90d eligible`);
    assert.equal(cells.outcome_90d.numerator, 30, `week ${week} 90d numerator`);
  }
  assert.equal(tally.outcome_legacy.produced, 0, 'the 90-day lag on a 90-day window never fires');
  for (const edgeId of ['outcome_30d', 'outcome_60d', 'outcome_90d']) {
    assert.equal(tally[edgeId].produced, SIM_WEEKS, `${edgeId} must report in all 52 weeks`);
  }
  assert.equal(tally.outcome_30d.denominators / SIM_WEEKS, 30);
  assert.equal(tally.outcome_60d.denominators / SIM_WEEKS, 30);
  assert.equal(tally.outcome_90d.denominators / SIM_WEEKS, 90);
});

test('the fast rung moves BEFORE the settled one when conversion steps up', () => {
  /*
   * THE RESPONSIVENESS ARGUMENT, made arithmetically rather than statistically.
   *
   * A rung's denominator is the subjects that showed between `cutoff - window` and `cutoff - lag`.
   * So the cohort each rung speaks for sits in a known band of the past:
   *
   *   30 days of lag over 60:   30 to 60 days ago
   *   60 days of lag over 90:   60 to 90 days ago
   *   90 days of lag over 180:  90 to 180 days ago
   *
   * A change made today therefore cannot enter the settled rung for 90 days, and cannot LEAVE the
   * fast rung's band after 60. Here every subject from 2026-01-05 onward converts and nobody before
   * it does, and each rung is asked when it first reports a rate above zero.
   */
  const stepMs = Date.parse('2026-01-05T00:00:00.000Z');
  const nodes = [];
  for (let day = 0; day < SIM_DAYS; day += 1) {
    const showedMs = SIM_FIRST_DAY_MS + (day * DAY) + (9 * 3_600_000);
    nodes.push(journeyNode(day + 1, 'showed', new Date(showedMs).toISOString()));
    if (showedMs < stepMs) continue;
    nodes.push(journeyNode(
      day + 1,
      'opportunity_outcome',
      new Date(showedMs + (5 * DAY)).toISOString(),
    ));
  }
  const graph = graphOf(nodes);
  const edges = [
    outcomeEdge('outcome_30d', 30, ['trailing60Days']),
    outcomeEdge('outcome_60d', 60, ['trailing90Days']),
    outcomeEdge('outcome_90d', 90, ['trailing180Days']),
  ];
  const firstNonZero = { outcome_30d: null, outcome_60d: null, outcome_90d: null };
  let stepWeek = null;
  for (let week = 0; week < SIM_WEEKS; week += 1) {
    const cutoffMs = FIRST_CUTOFF_MS + (week * 7 * DAY);
    if (stepWeek === null && cutoffMs >= stepMs) stepWeek = week;
    const { metrics } = computeJourneyMetrics({
      graph,
      metricContracts: { profileId: 'client', version: '1.0.0', coverageFloor: 0.8, edges },
      windows: buildWindows({
        cutoff: new Date(cutoffMs).toISOString(),
        timezone: 'UTC',
        maturityDays: 1,
      }),
    });
    const cells = {
      outcome_30d: metrics.trailing60Days.outcome_30d,
      outcome_60d: metrics.trailing90Days.outcome_60d,
      outcome_90d: metrics.trailing180Days.outcome_90d,
    };
    for (const [edgeId, cell] of Object.entries(cells)) {
      if (firstNonZero[edgeId] === null && cell.state === 'OBSERVED' && cell.numerator > 0) {
        firstNonZero[edgeId] = week;
      }
    }
  }
  /*
   * HAND-STATED. The step lands on 2026-01-05, which is itself a Monday cutoff, so `stepWeek` is
   * the run whose cutoff IS the step. A rung first sees a converter once its band reaches
   * 2026-01-05, i.e. once `cutoff - lag - 1 day >= 2026-01-05`, which is lag+1 days later:
   *   30-day rung: 31 days ->  5 weeks (2026-02-09 is the first Monday at or past 2026-02-05)
   *   60-day rung: 61 days ->  9 weeks (2026-03-09 is the first Monday at or past 2026-03-07)
   *   90-day rung: 91 days -> 13 weeks (2026-04-06 is the first Monday at or past 2026-04-06)
   */
  assert.equal(firstNonZero.outcome_30d - stepWeek, 5);
  assert.equal(firstNonZero.outcome_60d - stepWeek, 9);
  assert.equal(firstNonZero.outcome_90d - stepWeek, 13);
  // The ordering is the whole justification for having three, so assert it as such.
  assert.ok(firstNonZero.outcome_30d < firstNonZero.outcome_60d);
  assert.ok(firstNonZero.outcome_60d < firstNonZero.outcome_90d);
});
