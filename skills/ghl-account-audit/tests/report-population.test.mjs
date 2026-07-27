/**
 * Task A2a round 3 — the report may not claim full coverage for a run that measured nothing.
 *
 * `metricCoverageDisclosure` printed "every reported rate covered its whole eligible population"
 * whenever no metric carried an exclusion count. A window in which every entrant was conflicted
 * carried none, because the immaturity early return discarded them, so the sentence was both
 * vacuously true and read as reassurance. A run in which NO rate was reported at all cannot make
 * a claim about the coverage of its rates.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sha256 } from '../lib/canonical.mjs';
import { compilePublicationArtifacts } from '../lib/report.mjs';

const H = 'a'.repeat(64);
const H2 = 'b'.repeat(64);
const E1 = 'ev_1111111111111111';
const E2 = 'ev_2222222222222222';

function deepFreeze(value) {
  for (const child of Object.values(value ?? {})) {
    if (child && typeof child === 'object' && !Object.isFrozen(child)) deepFreeze(child);
  }
  return Object.freeze(value);
}

const SAMPLE_BODY = {
  schemaVersion: '1.0.0',
  seed: 'seed_1111111111111111',
  mode: 'CENSUS',
  universeCount: 0,
  requestedMaxSample: 50,
  actualSampleCount: 0,
  mandatoryCount: 0,
  mandatoryOverflowCount: 0,
  selections: [],
  populationPrevalence: 'CENSUS_ONLY',
  prevalenceScope: {
    kind: 'CENSUS',
    weightingRequiredForPopulationEstimate: false,
    uncertaintyRequiredForPopulationEstimate: false,
  },
};

function metric(overrides = {}) {
  return {
    state: 'OBSERVED',
    numerator: 2,
    denominator: 8,
    rate: 0.25,
    eligible: 8,
    excluded: 0,
    exclusions: {},
    threshold: 1,
    rankEligible: true,
    window: { start: '2026-07-06T00:00:00Z', end: '2026-07-13T00:00:00Z' },
    coverage: 'COMPLETE',
    coverageRatio: 1,
    coverageFloor: 0.8,
    reasonCode: null,
    ...overrides,
  };
}

function unmeasurable(overrides = {}) {
  return metric({
    state: 'UNKNOWN',
    numerator: null,
    denominator: null,
    rate: null,
    rankEligible: false,
    coverage: 'INCOMPLETE',
    reasonCode: 'MISSING_REQUIRED_EVIDENCE',
    ...overrides,
  });
}

function clientPublication(currentWeekMetrics) {
  return {
    run: deepFreeze({
      schemaVersion: '1.0.0',
      runId: 'run-2026-W30',
      publicationId: 'pub-2026-W30',
      week: '2026-W30',
      target: { operatingProfile: 'client', locationId: 'L1' },
      status: 'complete_full',
      cutoff: '2026-07-20T00:00:00Z',
    }),
    systemOverview: deepFreeze({ summary: 'Lead capture enters a nurture workflow.' }),
    coverage: deepFreeze({ state: 'complete_full', limitations: [], comparableSubsets: [] }),
    freshness: deepFreeze({ cutoff: '2026-07-20T00:00:00Z', staleCapabilities: [] }),
    diff: deepFreeze({ changes: [] }),
    graph: deepFreeze({ nodes: [], edges: [], conflicts: [], unresolvedJoins: [] }),
    metricContracts: deepFreeze({ profileId: 'client', version: '1.0.0', edges: [] }),
    windows: deepFreeze({
      cutoff: '2026-07-20T00:00:00Z',
      matureAsOf: '2026-07-13T00:00:00Z',
      currentClosedWeek: { start: '2026-07-06T00:00:00Z', end: '2026-07-13T00:00:00Z' },
      previousClosedWeek: { start: '2026-06-29T00:00:00Z', end: '2026-07-06T00:00:00Z' },
      trailing28Days: { start: '2026-06-15T00:00:00Z', end: '2026-07-13T00:00:00Z' },
    }),
    metrics: deepFreeze({
      metrics: {
        currentClosedWeek: currentWeekMetrics,
        previousClosedWeek: {},
        trailing28Days: {},
      },
      cohorts: { currentClosedWeek: {}, previousClosedWeek: {}, trailing28Days: {} },
      currentStock: {},
    }),
    sample: deepFreeze({
      ...SAMPLE_BODY,
      sampleHash: sha256(SAMPLE_BODY),
      verification: {
        interactions: [],
        universeHash: sha256([]),
        censusThreshold: 50,
        maxSample: 50,
      },
    }),
    findings: deepFreeze({ criticalIssues: [], promoted: [], backlog: [] }),
    mechanismReview: deepFreeze({
      coverage: {
        state: 'complete_full',
        comparableSubsets: [],
        capabilityStates: [],
        limits: [],
        edgeScopes: [],
      },
      maxCandidates: 5,
      maxPromoted: 3,
      packetBindings: [],
      reviewEnvelopes: [],
    }),
    conversationReview: deepFreeze({ availability: 'NOT_REVIEWABLE', judgments: [] }),
    evidenceManifest: deepFreeze([
      {
        evidenceRef: E1,
        classification: 'OBSERVED',
        provenance: { source: 'public_ghl', completeness: 'COMPLETE' },
        sanitizedPayloadHash: H,
      },
      {
        evidenceRef: E2,
        classification: 'OBSERVED',
        provenance: { source: 'internal_ghl', completeness: 'COMPLETE' },
        sanitizedPayloadHash: H2,
      },
    ]),
    solutionPacks: deepFreeze([]),
    memoryProjection: deepFreeze({ json: { entries: [] }, markdown: '# Backlog\n' }),
  };
}

function clientReport(currentWeekMetrics) {
  return compilePublicationArtifacts(clientPublication(currentWeekMetrics))
    .payloadArtifacts['REPORT.md'];
}

test('a run that reported no rate at all does not claim its rates covered everything', () => {
  // ONE metric, UNKNOWN because its cohort is still young. Nothing was excluded, so the old
  // wording read "every reported rate covered its whole eligible population" — about no rate.
  const report = clientReport({
    lead_created_to_first_engagement: unmeasurable({
      eligible: 4,
      excluded: 0,
      exclusions: {},
      coverageRatio: null,
      reasonCode: 'IMMATURE_COHORT',
    }),
  });
  assert.doesNotMatch(report, /whole eligible population/u);
  assert.match(report, /no rate was measurable/u);
});

test('a window in which every subject was excluded is disclosed as such', () => {
  const report = clientReport({
    lead_created_to_first_engagement: unmeasurable({
      eligible: 3,
      excluded: 3,
      exclusions: { IDENTITY_CONFLICT: 3 },
      coverageRatio: 0,
      reasonCode: 'ALL_SUBJECTS_EXCLUDED',
    }),
  });
  assert.match(report, /3 of 3 eligible subjects excluded/u);
  assert.doesNotMatch(report, /whole eligible population/u);
});

test('a rate that was reported over its whole population still says so', () => {
  // One measured rate at full coverage, beside one metric that could not be measured at all.
  const report = clientReport({
    lead_created_to_first_engagement: metric(),
    won_to_collected_revenue: unmeasurable({
      eligible: 2,
      excluded: 0,
      exclusions: {},
      coverageRatio: null,
      reasonCode: 'IMMATURE_COHORT',
    }),
  });
  assert.match(report, /whole eligible population/u);
});
