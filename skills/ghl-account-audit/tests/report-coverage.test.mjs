/**
 * Task A2a round 2, F4 (report half) — coverage must be visible to the READER, not only to the
 * machine metric, and clients are the primary audience.
 *
 * Round 1 added a "(measured N of M eligible)" annotation, but only inside the `grom_internal`
 * branch of `renderReport`, so a client report disclosed no coverage in prose at all.
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

test('a client report discloses when a rate was measured over part of the account', () => {
  // TWO of ten eligible subjects excluded: measured over 8, and the reader must be told.
  const report = clientReport({
    lead_created_to_first_engagement: metric({
      eligible: 10,
      excluded: 2,
      exclusions: { IDENTITY_CONFLICT: 2 },
      coverage: 'INCOMPLETE',
      coverageRatio: 0.8,
    }),
  });
  assert.match(report, /lead_created_to_first_engagement/u);
  assert.match(report, /8 of 10 eligible/u);
});

test('a client report says so when the coverage floor refused a metric entirely', () => {
  const report = clientReport({
    won_to_collected_revenue: metric({
      state: 'UNKNOWN',
      numerator: null,
      denominator: null,
      rate: null,
      eligible: 10,
      excluded: 6,
      exclusions: { UNPROVEN_JOIN: 6 },
      rankEligible: false,
      coverage: 'INCOMPLETE',
      coverageRatio: 0.4,
      reasonCode: 'COVERAGE_BELOW_FLOOR',
    }),
  });
  assert.match(report, /won_to_collected_revenue/u);
  assert.match(report, /6 of 10 eligible subjects excluded/u);
});

test('a client report states plainly when nothing was excluded', () => {
  const report = clientReport({ lead_created_to_first_engagement: metric() });
  assert.match(report, /whole eligible population/u);
  assert.doesNotMatch(report, /eligible subjects excluded/u);
});
