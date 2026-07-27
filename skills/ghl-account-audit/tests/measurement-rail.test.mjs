/**
 * A3 — THE MEASUREMENT CHAIN ON THE RAIL.
 *
 * `projectJourneyEvents -> normalizeEvidence -> buildEvidenceGraph -> buildWindows ->
 * computeJourneyMetrics` was exported, tested, and driven only by a script outside this repo. A
 * live run therefore collected 588 real records and published an empty report, and 667 tests were
 * green throughout, because nothing asserted that `analyzer.normalize` produced a number.
 *
 * THE ORACLE PROBLEM. Test doubles that agree with our own assumptions have hidden three separate
 * defects on this project, so nothing below takes its expected values from the chain:
 *
 *  - Every expected count is HAND-DERIVED in a comment from the fixture rows and the shipped
 *    contract, before the chain is run. The fixture is small enough to count by eye on purpose.
 *  - The fixture's ENVELOPE SHAPE is not hand-written from `collectPublicEvidence`'s source. One
 *    test drives the real public CLI end to end and asserts the fixture's scope records carry
 *    exactly the keys the real producer emits, so a fixture written against a shape the producer
 *    does not actually emit fails here rather than on the next live run.
 *  - The two-clocks test carries its own discriminator: it proves the SAME graph blanks completely
 *    when the capture horizon is collapsed onto the cutoff, so a green result cannot be vacuous.
 */
import assert from 'node:assert/strict';
import { createDecipheriv } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runAuditCli } from '../cli/audit.mjs';
import { canonicalJson, sha256 } from '../lib/canonical.mjs';
import { sourceCollectionsFromScopes } from '../lib/adapters/collection.mjs';
import { measurePublicEvidence } from '../lib/measurement.mjs';
import { buildWindows, computeJourneyMetrics } from '../lib/metrics.mjs';
import { discoverAuditServerPaths } from '../lib/adapters/internal-audit-session.mjs';
import { mergeInternalEvidence } from '../lib/modes/weekly.mjs';
import { auditPaths } from '../lib/paths.mjs';
import { loadMetricContracts, loadPublicReadAllowlist } from '../schemas/v1.mjs';

// ---------------------------------------------------------------------------
// The fixture account. Timezone UTC so every window boundary below is plain UTC
// arithmetic a reader can check without a timezone database.
// ---------------------------------------------------------------------------

const LOCATION = 'L1';
/**
 * Monday 2026-03-02T00:00:00Z. The cutoff of a real run is always a closed-week Monday, and the
 * boundaries that follow from it, all in UTC:
 *
 *   currentClosedWeek   2026-02-23 -> 2026-03-02
 *   previousClosedWeek  2026-02-16 -> 2026-02-23
 *   trailing28Days      2026-02-02 -> 2026-03-02
 *   trailing90Days      2025-12-02 -> 2026-03-02
 */
const CUTOFF_ISO = '2026-03-02T00:00:00.000Z';
/**
 * A run always reads AFTER its own cutoff, because a week must close before it can be read. Seven
 * hours is the gap the first live run actually had. Conflating this with the cutoff is what
 * discarded all 1,099 of that run's events.
 */
const CAPTURED_AT = '2026-03-02T07:00:00.000Z';
const WINDOW_FROM = '2025-12-02T00:00:00.000Z';

/** Contacts. `client_contacts` reads `id`, `email`, `dateAdded`; stage `lead_created`. */
const CONTACTS = [
  { id: 'c1', email: 'one@fixture.test', dateAdded: '2026-02-24T09:00:00.000Z' },
  { id: 'c2', email: 'two@fixture.test', dateAdded: '2026-02-24T10:00:00.000Z' },
  { id: 'c3', email: 'three@fixture.test', dateAdded: '2026-02-25T09:00:00.000Z' },
  { id: 'c5', email: 'five@fixture.test', dateAdded: '2026-01-05T09:00:00.000Z' },
  { id: 'c6', email: 'six@fixture.test', dateAdded: '2026-01-05T10:00:00.000Z' },
  { id: 'c7', email: 'seven@fixture.test', dateAdded: '2026-01-05T11:00:00.000Z' },
];

/**
 * Conversations. `client_conversations` reads `contactId` and `dateAdded`; stage
 * `first_engagement`, cohort keyed on `contactId`, so it joins the contact's own cohort.
 *
 * c1 is engaged inside the 2-day contract lag. c2 is engaged three days later, which is OUTSIDE
 * it. c3 is never engaged at all.
 */
const CONVERSATIONS = [
  { id: 'v1', contactId: 'c1', dateAdded: '2026-02-24T09:30:00.000Z' },
  { id: 'v2', contactId: 'c2', dateAdded: '2026-02-27T09:00:00.000Z' },
];

/**
 * Appointments. `client_appointments` keys its cohort on the APPOINTMENT id, so these edges count
 * appointments and not contacts. `booked` fires always off `dateAdded`; `showed`, `no_show` and
 * `cancelled` fire off `appointmentStatus` and read `startTime`.
 */
const APPOINTMENTS = [
  // Booked inside the current closed week: 24 Feb + 14 days of lag lands past the cutoff, so
  // these two are IMMATURE for every 14-day edge, in every window.
  {
    id: 'a1',
    contactId: 'c1',
    dateAdded: '2026-02-24T12:00:00.000Z',
    startTime: '2026-02-26T12:00:00.000Z',
    appointmentStatus: 'showed',
  },
  {
    id: 'a2',
    contactId: 'c2',
    dateAdded: '2026-02-25T12:00:00.000Z',
    startTime: '2026-02-27T12:00:00.000Z',
    appointmentStatus: 'confirmed',
  },
  // Booked on 6 Jan: matured on 20 Jan, well before the cutoff. One of each outcome.
  {
    id: 'a5',
    contactId: 'c5',
    dateAdded: '2026-01-06T10:00:00.000Z',
    startTime: '2026-01-08T10:00:00.000Z',
    appointmentStatus: 'showed',
  },
  {
    id: 'a6',
    contactId: 'c6',
    dateAdded: '2026-01-06T11:00:00.000Z',
    startTime: '2026-01-09T11:00:00.000Z',
    appointmentStatus: 'noshow',
  },
  {
    id: 'a7',
    contactId: 'c7',
    dateAdded: '2026-01-06T12:00:00.000Z',
    startTime: '2026-01-10T12:00:00.000Z',
    appointmentStatus: 'cancelled',
  },
];

/**
 * Opportunities. `won` and `collected_revenue` come off the SAME row under the SAME predicate, so
 * `won_to_collected_revenue` is a VALUE measure: it publishes an amount, never a rate.
 */
const OPPORTUNITIES = [
  {
    id: 'o1',
    contactId: 'c5',
    status: 'won',
    monetaryValue: 1200,
    lastStatusChangeAt: '2026-01-20T10:00:00.000Z',
  },
  {
    id: 'o2',
    contactId: 'c6',
    status: 'won',
    monetaryValue: 900,
    lastStatusChangeAt: '2026-01-21T10:00:00.000Z',
  },
  {
    id: 'o3',
    contactId: 'c7',
    status: 'lost',
    lastStatusChangeAt: '2026-01-22T10:00:00.000Z',
  },
];

const SCOPE_ROWS = Object.freeze({
  'contacts.search': CONTACTS,
  'conversations-v3__search-conversation': CONVERSATIONS,
  'calendars-v3__get-calendar-events': APPOINTMENTS,
  'opportunities.list': OPPORTUNITIES,
});

/**
 * The shape `collectPublicEvidence` records per scope. Asserted against the REAL producer by
 * `fixture scope records carry exactly the keys the real collector emits` below, so this cannot
 * drift into a shape the rail never actually emits.
 */
function scope(operationId, items, overrides = {}) {
  return {
    operationId,
    actionId: operationId,
    category: 'fixture',
    status: 'complete',
    incompleteReason: null,
    requestedWindow: { from: WINDOW_FROM, to: CUTOFF_ISO },
    appliedWindow: { from: WINDOW_FROM, to: CUTOFF_ISO },
    capturedAt: CAPTURED_AT,
    page: {
      cursor: null,
      nextCursor: null,
      reportedCount: items.length,
      collectedCount: items.length,
      complete: true,
      truncated: false,
    },
    items,
    ...overrides,
  };
}

function publicEvidence(overrides = {}) {
  return {
    schemaVersion: '1.0.0',
    source: 'public_ghl',
    boundLocationId: LOCATION,
    collectionWindow: { from: WINDOW_FROM, to: CUTOFF_ISO },
    collectionMode: 'first',
    events: [],
    scopes: Object.entries(SCOPE_ROWS).map(([operationId, items]) => scope(operationId, items)),
    privateSourceEnvelopes: [],
    scopeCheckpoints: [],
    limitations: [],
    ...overrides,
  };
}

function frozenInputs(overrides = {}) {
  return {
    locationId: LOCATION,
    target: { targetKind: 'location', operatingProfile: 'client', locationId: LOCATION },
    cutoff: Date.parse(CUTOFF_ISO),
    timezone: 'UTC',
    ...overrides,
  };
}

function cell(measured, window, edgeId) {
  const found = measured.metrics.metrics[window]?.[edgeId];
  assert.ok(found, `no cell for ${window}.${edgeId}`);
  return found;
}

// ---------------------------------------------------------------------------

test('the chain runs in-process and produces the hand-counted numbers', () => {
  const measured = measurePublicEvidence({
    publicEvidence: publicEvidence(),
    frozenInputs: frozenInputs(),
  });

  assert.equal(measured.profileId, 'client');
  assert.equal(measured.locationId, LOCATION);

  /*
   * lead_created_to_first_engagement, allowed lag 2 days, currentClosedWeek 23 Feb -> 2 Mar.
   *
   * Entrants: c1 (24 Feb 09:00), c2 (24 Feb 10:00), c3 (25 Feb 09:00). c5/c6/c7 entered on 5 Jan
   * and are outside the window. So eligible = 3.
   * Maturity: each entrant plus 2 days is 26 or 27 Feb, all at or before the 2 Mar cutoff, so all
   * three are mature and none is excluded on trust: denominator = 3.
   * Conversions inside the 2-day deadline: c1 engaged at 09:30 the same day (yes); c2 engaged on
   * 27 Feb, which is three days later (no); c3 never (no). Numerator = 1.
   */
  const engagement = cell(measured, 'currentClosedWeek', 'lead_created_to_first_engagement');
  assert.equal(engagement.state, 'OBSERVED');
  assert.equal(engagement.eligible, 3);
  assert.equal(engagement.denominator, 3);
  assert.equal(engagement.numerator, 1);
  assert.equal(engagement.excluded, 0);
  assert.equal(engagement.immature, 0);

  /*
   * booked_to_showed / _no_show / _cancelled, allowed lag 14 days, trailing90Days 2 Dec -> 2 Mar.
   *
   * The cohort key is the APPOINTMENT id, so these count appointments. All five are booked inside
   * the window: eligible = 5.
   * a1 (24 Feb) and a2 (25 Feb) plus 14 days land on 10 and 11 Mar, past the 2 Mar cutoff, so both
   * are immature. a5, a6, a7 (6 Jan) matured on 20 Jan: denominator = 3, immature = 2.
   * Outcomes among the mature three: a5 showed, a6 no-show, a7 cancelled — one each. a1 also
   * showed, but an immature entrant is not in the denominator and so cannot be in the numerator.
   */
  for (const [edgeId, expectedNumerator] of [
    ['booked_to_showed', 1],
    ['booked_to_no_show', 1],
    ['booked_to_cancelled', 1],
  ]) {
    const outcome = cell(measured, 'trailing90Days', edgeId);
    assert.equal(outcome.state, 'OBSERVED', edgeId);
    assert.equal(outcome.eligible, 5, edgeId);
    assert.equal(outcome.denominator, 3, edgeId);
    assert.equal(outcome.immature, 2, edgeId);
    assert.equal(outcome.excluded, 0, edgeId);
    assert.equal(outcome.numerator, expectedNumerator, edgeId);
  }

  /*
   * won_to_collected_revenue is a VALUE measure: an amount, and never a rate. Two priced wins in
   * trailing90Days, 1200 and 900, so the money is 2100 over two subjects. The rate is deliberately
   * null: a collection rate is not derivable from opportunity data alone.
   */
  const revenue = cell(measured, 'trailing90Days', 'won_to_collected_revenue');
  assert.equal(revenue.state, 'UNKNOWN');
  assert.equal(revenue.reasonCode, 'RATE_NOT_DERIVABLE');
  assert.equal(revenue.numerator, null);
  assert.equal(revenue.denominator, null);
  assert.equal(revenue.value, 2100);
  assert.equal(revenue.valueSubjects, 2);
});

test('an unusable amount removes ONE subject, never the account, and never reads as zero', () => {
  /*
   * An engine in this workspace has been observed writing `monetaryValue` as a STRING. Rule 1 of
   * the projector refuses to read that as a number, and refuses just as hard to read it as zero.
   *
   * Before A2a a single such row blacked out every metric in every window, because uncertainty was
   * scoped to the journey INSTANCE and the profile collapses the whole account into one. This is
   * the regression test for that: the taint must land on c6 and stop there.
   */
  const stringAmount = publicEvidence({
    scopes: Object.entries(SCOPE_ROWS).map(([operationId, items]) => scope(
      operationId,
      operationId === 'opportunities.list'
        ? items.map((row) => (row.id === 'o2' ? { ...row, monetaryValue: '900' } : row))
        : items,
    )),
  });
  const measured = measurePublicEvidence({
    publicEvidence: stringAmount,
    frozenInputs: frozenInputs(),
  });

  // The projector says out loud that it could not read one amount.
  assert.deepEqual(
    measured.projection.find(({ operationId }) => operationId === 'opportunities.list').annotations,
    [{ code: 'REVENUE_NOT_FINITE', count: 1 }],
  );

  // The money is 1200 over ONE subject. Never 2100, and never 1200-over-two, and never a zero
  // silently added for o2.
  const revenue = cell(measured, 'trailing90Days', 'won_to_collected_revenue');
  assert.equal(revenue.value, 1200);
  assert.equal(revenue.valueSubjects, 1);
  assert.equal(revenue.eligible, 2);
  assert.equal(revenue.excluded, 1);
  assert.deepEqual(revenue.exclusions, { NON_OBSERVED_EVIDENCE: 1 });

  // c6 is dropped from the appointment edges too, because the untrustworthy row is c6's. That is
  // the whole point of subject-scoped uncertainty: one bad row, one lost subject.
  const showed = cell(measured, 'trailing90Days', 'booked_to_showed');
  assert.equal(showed.eligible, 5);
  assert.equal(showed.excluded, 1);
  assert.deepEqual(showed.exclusions, { NON_OBSERVED_EVIDENCE: 1 });

  // And the rest of the account still reports. c1/c2/c3 never touched that row, so the current
  // week's engagement rate is unchanged from the clean fixture.
  const engagement = cell(measured, 'currentClosedWeek', 'lead_created_to_first_engagement');
  assert.equal(engagement.state, 'OBSERVED');
  assert.equal(engagement.numerator, 1);
  assert.equal(engagement.denominator, 3);
});

test('an edge the projection cannot prove is a declared blind spot, not a zero', () => {
  const measured = measurePublicEvidence({
    publicEvidence: publicEvidence(),
    frozenInputs: frozenInputs(),
  });

  // The four client edges no public GHL read can supply. `validateProjectionForProfile` refuses to
  // let any of them be flipped to MAPPED, and the measurement states them out loud so a later
  // stage cannot mistake "we cannot see this" for "we looked and found none".
  for (const edgeId of [
    'first_engagement_to_qualified',
    'qualified_to_booked',
    'cancelled_to_rebooked',
    'closed_to_reactivated',
  ]) {
    const blind = cell(measured, 'trailing90Days', edgeId);
    assert.equal(blind.state, 'UNKNOWN', edgeId);
    assert.equal(blind.reasonCode, 'MISSING_REQUIRED_EVIDENCE', edgeId);
    assert.equal(blind.numerator, null, edgeId);
  }

  // The largest single drop on the live UK account fell in exactly such a step. It has to be
  // legible as a blind spot from the measurement alone.
  assert.ok(
    measured.unmeasurableEdges.length > 0,
    'the measurement must state which stages have no signal at all',
  );
  assert.deepEqual(measured.unmeasurableEdges, [...measured.unmeasurableEdges].sort());
});

test('the capture horizon is the last READ, not the cutoff, and collapsing it is fatal', () => {
  const measured = measurePublicEvidence({
    publicEvidence: publicEvidence(),
    frozenInputs: frozenInputs(),
  });

  // Two clocks. The horizon is the latest `capturedAt` across the scopes, which is after the
  // cutoff, because a run reads a week only once that week has closed.
  assert.equal(measured.windows.capturedThrough, '2026-03-02T07:00:00+00:00[UTC]');
  assert.equal(measured.windows.cutoff, '2026-03-02T00:00:00+00:00[UTC]');
  assert.ok(
    Date.parse(CAPTURED_AT) > Date.parse(CUTOFF_ISO),
    'the fixture must reproduce the ordering every real run has',
  );

  /*
   * THE DISCRIMINATOR. Re-measure the SAME graph with the horizon collapsed onto the cutoff, which
   * is the substitution the first live run made. Every node carries a `capturedAt` seven hours past
   * the cutoff, so under that horizon there is no evidence the run may look at at all.
   *
   * It THROWS. That guard was added after the first live run precisely because the previous
   * behaviour — reporting `NO_ELIGIBLE_POPULATION` in every cell — was indistinguishable from an
   * empty account. If the assertions above were passing for free, this would not throw.
   */
  assert.throws(
    () => computeJourneyMetrics({
      graph: measured.graph,
      metricContracts: loadMetricContracts('client'),
      windows: buildWindows({
        cutoff: CUTOFF_ISO,
        timezone: 'UTC',
        maturityDays: 0,
        capturedThrough: CUTOFF_ISO,
      }),
    }),
    { code: 'METRICS_CAPTURE_HORIZON_PRECEDES_EVIDENCE' },
  );
});

test('an incomplete scope stays incomplete and says why', () => {
  const truncated = publicEvidence({
    scopes: Object.entries(SCOPE_ROWS).map(([operationId, items]) => (
      operationId === 'contacts.search'
        ? scope(operationId, items, {
            status: 'complete_partial',
            incompleteReason: 'BUDGET_MAXIMUM_PAGES',
            page: {
              cursor: null,
              nextCursor: 'more',
              reportedCount: 99,
              collectedCount: items.length,
              complete: false,
              truncated: false,
            },
          })
        : scope(operationId, items)
    )),
  });
  const measured = measurePublicEvidence({
    publicEvidence: truncated,
    frozenInputs: frozenInputs(),
  });
  const contacts = measured.collection.find(
    ({ operationId }) => operationId === 'contacts.search',
  );
  assert.equal(contacts.incompleteReason, 'BUDGET_MAXIMUM_PAGES');
  // Incompleteness is never laundered into completeness on the way through the projector.
  const projected = measured.projection.find(
    ({ operationId }) => operationId === 'contacts.search',
  );
  assert.equal(projected.inputItemCount, CONTACTS.length);
});

test('a scope the projection has no source for is suppressed and COUNTED, never dropped quietly', () => {
  const measured = measurePublicEvidence({
    publicEvidence: publicEvidence({
      scopes: [scope('some-unmapped-read', [{ id: 'x1' }, { id: 'x2' }])],
    }),
    frozenInputs: frozenInputs(),
  });
  // Two envelopes: the projected one, which emits nothing, and a `suppression_signal` one that
  // exists so the drop is visible downstream. A projector that quietly discarded 80% of an account
  // would otherwise look identical to a healthy one.
  const [projected, signal] = measured.projection;
  assert.equal(projected.kind, 'projected_records');
  assert.equal(projected.emittedCount, 0);
  assert.equal(projected.inputItemCount, 2);
  assert.deepEqual(projected.suppressed, [
    { reason: 'COLLECTION_MATCHED_NO_PROJECTION_SOURCE', unit: 'record', count: 2 },
  ]);
  assert.equal(signal.kind, 'suppression_signal');
  assert.equal(signal.emittedCount, 1);
});

test('the profile comes from the sealed frozen inputs and a missing one fails loudly', () => {
  // The context record is mutable configuration; the sealed target is what the run was created
  // as. A run must measure itself as the thing it was sealed as.
  assert.throws(
    () => measurePublicEvidence({
      publicEvidence: publicEvidence(),
      frozenInputs: frozenInputs({ target: { targetKind: 'location', locationId: LOCATION } }),
    }),
    { code: 'MEASUREMENT_PROFILE_UNDECLARED' },
  );
  assert.throws(
    () => measurePublicEvidence({
      publicEvidence: publicEvidence(),
      frozenInputs: frozenInputs({ timezone: '' }),
    }),
    { code: 'MEASUREMENT_TIMEZONE_UNDECLARED' },
  );
  // Evidence from a different account wearing this run's identity is refused, not measured.
  assert.throws(
    () => measurePublicEvidence({
      publicEvidence: publicEvidence({ boundLocationId: 'L2' }),
      frozenInputs: frozenInputs(),
    }),
    { code: 'MEASUREMENT_LOCATION_MISMATCH' },
  );
});

test('the measurement is deterministic under input reordering and canonical-JSON round-trips', () => {
  const forward = measurePublicEvidence({
    publicEvidence: publicEvidence(),
    frozenInputs: frozenInputs(),
  });
  const reversed = measurePublicEvidence({
    publicEvidence: publicEvidence({ scopes: publicEvidence().scopes.toReversed() }),
    frozenInputs: frozenInputs(),
  });
  // The kernel checkpoints this, canonical-JSON round-trips it and byte-compares it on resume, so
  // input order can never be allowed to reach the output.
  assert.equal(canonicalJson(reversed), canonicalJson(forward));
  assert.equal(canonicalJson(JSON.parse(canonicalJson(forward))), canonicalJson(forward));
});

// ---------------------------------------------------------------------------
// The wiring, end to end through the real CLI.
// ---------------------------------------------------------------------------

const allowlist = loadPublicReadAllowlist();
const CLI_CUTOFF = 1_750_032_000_000;
const VAULT_KEY_REFERENCE = 'test-only:key';
const PHASE_ENCRYPTION_KEY = Buffer.alloc(32, 0x31);

function cliConfig() {
  return {
    schemaVersion: '1.0.0',
    adapterKind: 'ghl_public',
    runId: 'run_measurement_1',
    providerId: 'fixture-provider',
    expectedLocationId: LOCATION,
    capabilityManifestHash: '8'.repeat(64),
    publicCatalogSnapshotHash: allowlist.sourceSnapshotHash,
    publicReadAllowlistHash: sha256(allowlist),
    credentialRef: { kind: 'environment', name: 'FIXTURE_TOKEN' },
    transport: { kind: 'streamable-http', url: 'https://mcp.invalid.example.test' },
    capabilities: [
      { operationId: 'contacts.search', actionId: 'contacts.search' },
      { operationId: 'opportunities.list', actionId: 'opportunities.list' },
    ],
    cutoff: CLI_CUTOFF,
    timezone: 'UTC',
    frozenInputs: {
      locationId: LOCATION,
      target: { targetKind: 'location', operatingProfile: 'client', locationId: LOCATION },
      cutoff: CLI_CUTOFF,
      timezone: 'UTC',
      contextHash: 'context-measurement-1',
      coverageProfileHash: 'coverage-measurement-1',
      metricProfileHash: 'metric-measurement-1',
      rulesetHash: 'rules-measurement-1',
      codeHash: 'code-measurement-1',
      auditProfileHash: 'profile-measurement-1',
      providerToolProfileHash: 'provider-measurement-1',
      windowDefinitionsHash: 'windows-measurement-1',
      collectionBudgetHash: 'budget-measurement-1',
      capabilityManifestHashes: ['manifest-measurement-1'],
      capabilityProofIndexHash: 'proof-index-measurement-1',
      capabilityReceiptHashes: ['receipt-measurement-1'],
      capabilityAttestationHashes: ['attestation-measurement-1'],
      capabilityProofExpiries: [1_850_032_000_000],
    },
    context: { safe: 'context' },
    reviews: [],
  };
}

/** One terminal page per capability, echoing the window the request asked for. */
function hermeticTransport(rowsByAction) {
  return {
    async connect() {
      return {
        async callTool(request) {
          const rows = rowsByAction[request.arguments.action] ?? [];
          return {
            structuredContent: {
              locationId: LOCATION,
              appliedWindow: {
                from: request.arguments.params.fromDate,
                to: request.arguments.params.toDate,
              },
              items: rows,
              page: {
                cursor: null,
                nextCursor: null,
                reportedCount: rows.length,
                complete: true,
                truncated: false,
              },
            },
          };
        },
        async close() {},
      };
    },
  };
}

function decryptPhaseArtifact(projectRoot, runId, filename) {
  const paths = auditPaths(projectRoot, LOCATION);
  const envelope = JSON.parse(readFileSync(
    join(paths.privateCheckpoints, runId, 'phases', filename),
    'utf8',
  ));
  const decipher = createDecipheriv(
    'aes-256-gcm',
    PHASE_ENCRYPTION_KEY,
    Buffer.from(envelope.iv, 'base64'),
  );
  decipher.setAAD(Buffer.from(canonicalJson({
    schemaVersion: '1.0.0',
    runId: envelope.runId,
    phase: envelope.phase,
    inputHash: envelope.inputHash,
  }), 'utf8'));
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  return JSON.parse(Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8'));
}

async function runPublicCli(rowsByAction, { configOverrides = {}, extraRuntime = {} } = {}) {
  const projectRoot = realpathSync(mkdtempSync(join(tmpdir(), 'measurement-rail-')));
  try {
    const configPath = join(projectRoot, 'provider.json');
    writeFileSync(configPath, `${JSON.stringify({ ...cliConfig(), ...configOverrides })}\n`);
    const result = await runAuditCli({
      argv: [
        'run',
        '--mode', 'weekly',
        '--project', projectRoot,
        '--location', LOCATION,
        '--profile', 'client',
        '--provider-config', configPath,
        '--vault-key-ref', VAULT_KEY_REFERENCE,
      ],
      stdout: { write: () => true },
      publicRuntime: {
        transportConnect: hermeticTransport(rowsByAction).connect,
        credentialResolver: async () => 'private-token-canary',
        ...extraRuntime,
      },
    });
    const read = (filename) => {
      try {
        return decryptPhaseArtifact(projectRoot, result.runId, filename);
      } catch {
        return null;
      }
    };
    return {
      result,
      projectRoot,
      collected: read('03-collecting_public.json'),
      // `phaseArtifactPath` bakes `PHASES.indexOf(phase)` into the filename, and the two internal
      // phases were APPENDED to that array rather than inserted, so they are 14 and 15 even though
      // they EXECUTE between `collecting_public` (03) and `normalizing` (04).
      internalAuth: read('14-awaiting_internal_auth.json'),
      internal: read('15-collecting_internal.json'),
      normalized: read('04-normalizing.json'),
    };
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
}

test('audit run measures in-process: the normalizing checkpoint carries real metrics', async () => {
  const { result, normalized } = await runPublicCli({
    'contacts.search': CONTACTS,
    'opportunities.list': OPPORTUNITIES,
  });
  assert.equal(result.status, 'complete_partial');

  // The two hashes the Task 10 shape declares are unchanged and still first.
  assert.equal(typeof normalized.contextHash, 'string');
  assert.equal(typeof normalized.publicEvidenceHash, 'string');

  // And the measurement is now beside them. This is the assertion whose absence let a live run
  // collect 588 real records and publish an empty report.
  assert.ok(normalized.measurement, 'analyzer.normalize must carry the measurement');
  assert.equal(normalized.measurement.profileId, 'client');
  assert.equal(normalized.measurement.locationId, LOCATION);
  assert.deepEqual(Object.keys(normalized.measurement.metrics.metrics).sort(), [
    'currentClosedWeek',
    'previousClosedWeek',
    'trailing180Days',
    'trailing28Days',
    'trailing60Days',
    'trailing90Days',
  ]);
  assert.ok(normalized.measurement.graph.nodes.length > 0, 'the graph must have been built');
  assert.equal(
    normalized.measurement.projection.find(
      ({ operationId }) => operationId === 'contacts.search',
    ).inputItemCount,
    CONTACTS.length,
  );
});

test('fixture scope records carry exactly the keys the real collector emits', async () => {
  const { collected } = await runPublicCli({
    'contacts.search': CONTACTS,
    'opportunities.list': OPPORTUNITIES,
  });
  /*
   * THE ANTI-ORACLE. Specs written from a producer's SOURCE rather than its real OUTPUT have
   * shipped validators that failed every honest run on this project. The hand-built fixture at the
   * top of this file is a claim about what `collectPublicEvidence` emits, so it is diffed against
   * what it actually emitted here. Add or rename a key on the producer and this fails before the
   * next live run does.
   */
  const real = collected.scopes.find(({ operationId }) => operationId === 'contacts.search');
  const fixture = scope('contacts.search', CONTACTS);
  assert.deepEqual(Object.keys(real).sort(), Object.keys(fixture).sort());
  assert.deepEqual(Object.keys(real.page).sort(), Object.keys(fixture.page).sort());
  assert.deepEqual(
    Object.keys(collected).sort(),
    Object.keys(publicEvidence()).sort(),
  );
});

// ---------------------------------------------------------------------------
// The merge seam. Reachable only once the internal rail is on, which is why nothing caught it.
// ---------------------------------------------------------------------------

test('the merge check reads the live public rail shape instead of calling it missing', async () => {
  /*
   * `mergeInternalEvidence` runs ONLY when internal evidence exists, and the internal rail has
   * never been reachable from the CLI, so this path has never executed on a real record. It would
   * have executed on the first run that turned the rail on.
   *
   * The live record carries `events: []` as the slot a governed baseline is later merged into, and
   * `normalizePublicEvidence` matched that empty array before it ever looked at `scopes`. So a run
   * that had just collected 588 real records would have been reported as having no public evidence
   * at all — the same signature as the capture-horizon defect: a shape bug wearing the costume of
   * an empty account.
   */
  const collected = publicEvidence();
  assert.deepEqual(collected.events, [], 'the fixture must reproduce the empty ledger that caused it');
  assert.equal(collected.scopes.length, 4);

  const merged = await mergeInternalEvidence({
    publicEvidence: collected,
    internalEvidence: {
      schemaVersion: '1.0.0',
      boundLocationId: LOCATION,
      capturedAt: CAPTURED_AT,
      workflows: [],
      coverage: [],
    },
    coveragePolicy: { analyticalCutoff: CUTOFF_ISO },
    checkpoint: { schemaVersion: '1.0.0', phase: 'collecting_public' },
    refreshPublicEvidence: undefined,
    runtime: {},
  });

  const limitations = (merged.limitations ?? []).map((entry) => (
    typeof entry === 'string' ? entry : entry?.code
  ));
  assert.equal(
    limitations.includes('PUBLIC_EVIDENCE_MISSING'),
    false,
    `588 records is not "missing": ${JSON.stringify(limitations)}`,
  );
  assert.equal(
    limitations.includes('PUBLIC_EVIDENCE_MALFORMED'),
    false,
    `the mapped envelopes must satisfy the envelope allow-list unchanged: ${JSON.stringify(limitations)}`,
  );
  // And the location conflict check is genuinely running, not vacuously passing on zero envelopes.
  assert.equal(merged.quarantined ?? false, false);
});

test('the merge check and the projector inspect byte-identical envelopes', () => {
  /*
   * THE ANTI-DRIFT PROPERTY, and the reason this mapping is one function rather than two.
   *
   * Two consumers turn the checkpointed scopes back into envelopes: the measurement chain, whose
   * projector VALIDATES them, and the merge check, which RECONCILES them. If those two ever
   * disagree, one of them reconciles an envelope the other rejects, and the run reports something
   * true about a record neither of them actually read.
   */
  const collected = publicEvidence();
  const forMerge = sourceCollectionsFromScopes(collected);
  assert.equal(forMerge.length, collected.scopes.length);
  for (const envelope of forMerge) {
    // The three bookkeeping fields are dropped, and `status` in particular: it is a derived
    // restatement of `page.complete`, and an envelope with two places to claim completeness is one
    // where a `complete_partial` scope can be read as terminal.
    assert.equal(Object.hasOwn(envelope, 'status'), false);
    assert.equal(Object.hasOwn(envelope, 'actionId'), false);
    assert.equal(Object.hasOwn(envelope, 'category'), false);
    // A complete envelope may not carry the key at all, which is what the projector enforces.
    assert.equal(Object.hasOwn(envelope, 'incompleteReason'), false);
    assert.equal(envelope.boundLocationId, LOCATION);
    assert.equal(envelope.source, 'public_ghl');
  }
  // The measurement chain accepts exactly these, which is the proof that both consumers agree.
  const measured = measurePublicEvidence({
    publicEvidence: collected,
    frozenInputs: frozenInputs(),
  });
  assert.deepEqual(
    measured.projection.map(({ operationId }) => operationId).sort(),
    forMerge.map(({ operationId }) => operationId).sort(),
  );
});

test('an incomplete scope keeps its reason through the merge mapping too', () => {
  const truncated = publicEvidence({
    scopes: [scope('contacts.search', CONTACTS, {
      status: 'complete_partial',
      incompleteReason: 'BUDGET_MAXIMUM_PAGES',
      page: {
        cursor: null,
        nextCursor: 'more',
        reportedCount: 99,
        collectedCount: CONTACTS.length,
        complete: false,
        truncated: false,
      },
    })],
  });
  const [envelope] = sourceCollectionsFromScopes(truncated);
  assert.equal(envelope.incompleteReason, 'BUDGET_MAXIMUM_PAGES');
  assert.equal(envelope.page.complete, false);

  // And a partial scope that says nothing about why still says SOMETHING, rather than reading as
  // terminal by omission.
  const silent = publicEvidence({
    scopes: [scope('contacts.search', CONTACTS, {
      status: 'complete_partial',
      incompleteReason: null,
      page: {
        cursor: null, nextCursor: 'more', reportedCount: 99,
        collectedCount: CONTACTS.length, complete: false, truncated: false,
      },
    })],
  });
  assert.equal(sourceCollectionsFromScopes(silent)[0].incompleteReason, 'PUBLIC_SCOPE_INCOMPLETE');
});

// ---------------------------------------------------------------------------
// The internal rail, reachable from the CLI at last.
// ---------------------------------------------------------------------------

const [INSTALLED_AUDIT_SERVER] = discoverAuditServerPaths();

/**
 * A hermetic stand-in for the audit server, answering in the envelope shape
 * `tests/internal-audit-contract.test.mjs` proves against the real one. Nothing here launches a
 * process, so the test needs no credential and makes no request.
 */
function internalDouble({ credentialSeconds = 3600, workflowIds = ['wf-1', 'wf-2'] } = {}) {
  const calls = [];
  return {
    calls,
    connect: async () => ({
      async listTools() { return { tools: [] }; },
      async callTool({ name, arguments: args }) {
        calls.push({ name, args });
        if (name === 'auth_status') {
          return {
            structuredContent: {
              ok: true,
              data: {
                jwtClaims: { present: true, secondsRemaining: credentialSeconds },
                tokenIdClaims: { present: true, secondsRemaining: credentialSeconds },
              },
            },
          };
        }
        if (name === 'list_workflows_complete') {
          // A roster row identifies itself with `_id`. Observed live; `id`/`workflowId` are absent.
          return {
            structuredContent: {
              ok: true,
              data: {
                boundLocationId: LOCATION,
                complete: true,
                reportedTotal: workflowIds.length,
                uniqueCount: workflowIds.length,
                warnings: [],
                workflows: workflowIds.map((id) => ({ _id: id, status: 'published', name: `Nurture ${id}` })),
              },
            },
          };
        }
        if (name === 'export_workflow') {
          return {
            structuredContent: {
              ok: true,
              data: {
                boundLocationId: LOCATION,
                workflow: {
                  _id: args.workflowId,
                  name: `Nurture ${args.workflowId}`,
                  status: 'published',
                  allowMultiple: true,
                  workflowData: { templates: [{ id: 's1', type: 'email', next: [] }] },
                },
                triggers: [{ id: 't1', type: 'facebook_lead_gen' }],
                stickyNotes: [],
                // A contact-shaped row, to prove the scrub runs at the boundary rather than being
                // remembered by a later caller -- and to prove it can tell a CONTACT's name from a
                // WORKFLOW's, which a flat deny list on the key `name` could not.
                enrollmentSample: [{ contactId: 'k1', name: 'A Person', email: 'owner@example.test' }],
              },
            },
          };
        }
        if (name === 'get_ai_configuration_bundle') {
          return {
            structuredContent: {
              ok: true,
              data: { contractVersion: '1.0.0', boundLocationId: LOCATION, complete: true, warnings: [], components: {} },
            },
          };
        }
        throw new Error(`UNSTUBBED ${name}`);
      },
      async close() { calls.push({ name: '__close', args: null }); },
    }),
  };
}

function internalAuditBlock(projectRootForToken) {
  const tokenFilePath = join(projectRootForToken, 'tok.txt');
  writeFileSync(tokenFilePath, 'not-a-real-token\n');
  return {
    transport: {
      kind: 'ghl-internal-audit-stdio',
      serverPath: INSTALLED_AUDIT_SERVER,
      tokenFilePath,
    },
  };
}

test('a config with no internal rail is the byte-identical public-only path', async () => {
  const { result, internal, internalAuth } = await runPublicCli({
    'contacts.search': CONTACTS,
    'opportunities.list': OPPORTUNITIES,
  });
  assert.equal(result.status, 'complete_partial');
  // Absence of the block must not merely be tolerated, it must change nothing: no internal phase
  // is entered at all, so every configuration that exists today is unaffected.
  assert.equal(internal, null);
  assert.equal(internalAuth, null);
});

test('audit run reads workflows when the config asks, and stays honestly partial', {
  skip: INSTALLED_AUDIT_SERVER === undefined ? 'uxie-ghl-factory plugin not installed' : false,
}, async () => {
  const tokenHome = realpathSync(mkdtempSync(join(tmpdir(), 'measurement-token-')));
  const double = internalDouble();
  try {
    const { result, internal } = await runPublicCli(
      { 'contacts.search': CONTACTS, 'opportunities.list': OPPORTUNITIES },
      {
        configOverrides: { internalAudit: internalAuditBlock(tokenHome) },
        extraRuntime: { internalAuditConnect: double.connect },
      },
    );

    // The rail RAN. This is the assertion whose absence meant the internal half was built, tested
    // and reachable from nothing for the whole life of the project.
    assert.ok(internal, 'the collecting_internal phase was never checkpointed');
    assert.equal(internal.internalEvidence.source, 'internal_ghl');
    assert.equal(internal.internalEvidence.boundLocationId, LOCATION);
    assert.deepEqual(
      internal.internalEvidence.workflows.map(({ workflowId }) => workflowId),
      ['wf-1', 'wf-2'],
    );

    // Definitions for every workflow, no runtime window (none was asked for), and the session was
    // closed even though the kernel has no notion of closing a transport.
    assert.equal(double.calls.filter(({ name }) => name === 'export_workflow').length, 2);
    assert.equal(double.calls.some(({ name }) => name === 'get_workflow_runtime_window'), false);
    assert.equal(double.calls.at(-1).name, '__close', JSON.stringify(double.calls.map(({name}) => name)));

    // `auth_status` came FIRST, before a single evidence call. On the real server an expired
    // credential latches the shared circuit on its first read, so this ordering is what stops a
    // stale token from burning the run and then blaming the transport.
    assert.equal(double.calls[0].name, 'auth_status');

    /*
     * The scrub tells a CONTACT's name from a WORKFLOW's, which is the correction the first live
     * read forced. A flat deny list on the key `name` redacted all 27 real workflow names, and
     * "this nurture never asks a human to step in" is not a sentence anyone can write about
     * `[redacted]`.
     */
    const serialised = JSON.stringify(internal.internalEvidence);
    assert.equal(serialised.includes('owner@example.test'), false, 'an email survived');
    assert.equal(serialised.includes('A Person'), false, 'a contact name survived');
    assert.ok(serialised.includes('Nurture wf-1'), 'the workflow name was redacted, so no detector can read it');

    /*
     * STILL `complete_partial`, and that is the correct answer rather than a shortfall. The
     * plugin's own documentation says the audit composites have never been run live and no
     * capability receipt exists; the kernel machine-enforces "no receipt, no Full audit". For an
     * internal tool the Full designation is compliance ceremony and the findings come out either
     * way, so nothing here forges a coverage row to pass that gate.
     */
    assert.equal(result.status, 'complete_partial');
    assert.deepEqual(internal.internalEvidence.capabilityCoverage, []);
  } finally {
    rmSync(tokenHome, { recursive: true, force: true });
  }
});

test('an expired credential suspends the run instead of burning it', {
  skip: INSTALLED_AUDIT_SERVER === undefined ? 'uxie-ghl-factory plugin not installed' : false,
}, async () => {
  const tokenHome = realpathSync(mkdtempSync(join(tmpdir(), 'measurement-token-')));
  const double = internalDouble({ credentialSeconds: -259_083 });
  try {
    const { result, internalAuth, internal } = await runPublicCli(
      { 'contacts.search': CONTACTS, 'opportunities.list': OPPORTUNITIES },
      {
        configOverrides: { internalAudit: internalAuditBlock(tokenHome) },
        extraRuntime: { internalAuditConnect: double.connect },
      },
    );
    assert.equal(result.status, 'awaiting_internal_auth');
    assert.ok(internalAuth, 'the auth boundary was never checkpointed');
    assert.equal(internal, null);
    // Exactly one call, and it was the one that makes no request.
    assert.deepEqual(
      double.calls.map(({ name }) => name).filter((name) => name !== '__close'),
      ['auth_status'],
    );
  } finally {
    rmSync(tokenHome, { recursive: true, force: true });
  }
});
