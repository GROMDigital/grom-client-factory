/**
 * THE JOINING.
 *
 * Every box in `PRODUCT-SPEC.md` was built and tested before `lib/cycle.mjs` existed, and nothing
 * called them in sequence. These tests hold the seam that joins them: the run writes the briefs, the
 * skill dispatches the analysts, and the answers come back through a validator that REFUSES rather
 * than down-ranks.
 *
 * The properties worth defending here are not the file names. They are:
 *
 *  - all three lanes are written, every run, with no way to ask for one;
 *  - a malformed FINDING is discarded and REPORTED, while a missing LANE is fatal;
 *  - the same answers always produce the same causes, because the only non-deterministic step in the
 *    product sits between two deterministic commands;
 *  - a brief never reaches the publication area, because it quotes real message copy.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  briefsDirectory,
  ingestAccountMap,
  ingestLaneFindings,
  ingestObjectReviews,
  prepareAnalysisArtifacts,
  readAnalysisArtifacts,
  readLaneAnswers,
  renderBacklog,
  renderInvestigation,
  renderSolutionPackage,
  runInvestigation,
} from '../lib/cycle.mjs';
import { parseAuditCliArgs, runAuditCli } from '../cli/audit.mjs';
import { auditPaths } from '../lib/paths.mjs';
import { LANES, investigateRootCause } from '../lib/root-cause.mjs';

const LOCATION = 'yoQVVJFp6wyjxcxilA2H';
const RUN = 'run_cycle_fixture';

function project() {
  const root = mkdtempSync(join(tmpdir(), 'audit-cycle-'));
  const paths = auditPaths(root, LOCATION);
  mkdirSync(paths.root, { recursive: true });
  mkdirSync(paths.weekly, { recursive: true });
  return { root, paths };
}

/** The sealed measurement bundle, in the shape `measurePublicEvidence` really returns. */
const measurement = Object.freeze({
  schemaVersion: '1.0.0',
  profileId: 'grom_internal',
  locationId: LOCATION,
  collectionWindow: { from: '2026-04-27T23:00:00.000Z', to: '2026-07-26T23:00:00.000Z' },
  collectionMode: 'first',
  collection: [{ operationId: 'contacts.search', collectedCount: 186 }],
  projection: [{ operationId: 'contacts.search', emittedCount: 372 }],
  unmeasurableEdges: [],
  surfaceObservations: [],
  graph: { nodes: [1], edges: [1], conflicts: [], unresolvedJoins: [] },
  windows: { timezone: 'Europe/London' },
  metrics: {
    metrics: {
      trailing90Days: {
        enquiry_to_contacted: { state: 'OBSERVED', numerator: 166, denominator: 178, rate: 0.93 },
      },
    },
  },
});

const internal = Object.freeze({
  source: 'internal_ghl',
  complete: true,
  limitations: [],
  roster: { complete: true, reportedCount: 1, readCount: 1 },
  workflows: [{
    workflowId: 'wf-1',
    definition: {
      data: {
        workflow: {
          _id: 'wf-1',
          name: '08 Long Term Nurture',
          status: 'published',
          stopOnResponse: false,
          workflowData: {
            templates: [{
              order: 0,
              type: 'sms',
              name: 'Opener',
              // The quoted copy that must NEVER reach the publication area. Asserted below.
              attributes: { message: 'Hey, saw your enquiry about patient acquisition.' },
            }],
          },
        },
        triggers: [{ id: 't0', type: 'facebook_lead_gen' }],
        stickyNotes: [],
      },
    },
    definitionCode: null,
    runtimeWindow: null,
    runtimeCode: 'RUNTIME_NOT_REQUESTED',
  }],
});

/** A finding that passes `validateLaneFinding`. Everything the validator demands, nothing more. */
function finding(lane, findingId, overrides = {}) {
  return {
    findingId,
    lane,
    title: 'Leads are never called after the second unanswered email',
    mechanism: 'workflow_configuration_or_execution',
    confidence: 'C2',
    anchors: { kpiEdgeIds: ['enquiry_to_contacted'], workflowNames: [], journeyStages: [] },
    analysis: 'The sequence sends four emails and no SMS at all.',
    benchmark: 'A competent Meta lead-form operation contacts on SMS inside five minutes.',
    competingExplanations: [
      { explanation: 'The email addresses are dormant Facebook profile addresses.', materiality: 'MATERIAL', addressed: true },
      { explanation: 'The window is too short to see replies.', materiality: 'IMMATERIAL', addressed: true },
    ],
    evidenceAgainst: 'Outbound volume is high, so the account is not silent.',
    discriminatingTest: {
      check: 'Compare reply rate on the SMS opener against the email opener.',
      supportsIf: 'SMS replies materially outperform email.',
      refutesIf: 'Both channels reply at the same rate.',
    },
    sizing: '20 bookings a quarter, currency value unknown.',
    scoring: {
      commercialImpact: 'HIGH',
      leadsAffected: 'HIGH',
      urgency: 'MEDIUM',
      implementationEffort: 'LOW',
      risk: 'LOW',
      testability: 'HIGH',
    },
    fix: 'Add an SMS opener at minute two, before the first email.',
    ...overrides,
  };
}

function answers(overrides = {}) {
  return {
    lead_journey_kpi: [finding('lead_journey_kpi', 'no_sms_on_lead_form_traffic')],
    workflow_config_runtime: [finding('workflow_config_runtime', 'nurture_never_escalates')],
    conversation_copy_ai: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------

/** The stage-1 answer for this fixture's single workflow. */
function accountMap(overrides = {}) {
  return {
    journey: 'A Meta lead lands, gets nurtured, and books.',
    moneyPath: ['08 Long Term Nurture'],
    workflows: [{
      name: '08 Long Term Nurture',
      job: 'keep a cold enquiry warm until it books',
      role: 'money_path',
      reasoning: 'triggered by facebook_lead_gen and sends an opener about patient acquisition',
      nameMatchesBehaviour: true,
      kpiEdges: ['enquiry_to_contacted'],
      runsAlongside: [],
    }],
    agents: [],
    gaps: ['nothing recovers a no-show'],
    uncertainties: ['whether runtime was ever requested'],
    ...overrides,
  };
}

/** Walk a run all the way to the point where the three lane prompts exist. */
function throughStageTwo(paths, { review = 'The opener earns the second line. Keep it.' } = {}) {
  prepareAnalysisArtifacts({ paths, runId: RUN, measurement, internal });
  const { index } = ingestAccountMap({ paths, runId: RUN, map: accountMap() });
  const directory = briefsDirectory(paths, RUN);
  for (const expected of index.reviews) {
    writeFileSync(join(directory, expected.answerFile), review);
  }
  return ingestObjectReviews({ paths, runId: RUN });
}

test('the run writes all three briefs and the ONE stage-1 prompt, and no lane prompt yet', () => {
  const { paths } = project();
  const { directory, index } = prepareAnalysisArtifacts({
    paths, runId: RUN, measurement, internal,
  });

  assert.deepEqual(index.laneBriefs.map(({ lane }) => lane), [...LANES]);
  for (const lane of LANES) {
    assert.ok(existsSync(join(directory, `brief-${lane}.json`)), `brief for ${lane}`);
    /*
     * THE SHAPE OF THE REDESIGN. The account-wide analysts are stage 3: they read the derived map
     * and every per-object review, and neither exists at this point in the run. A lane prompt
     * written here would be the shallow first run all over again.
     */
    assert.ok(!existsSync(join(directory, `prompt-${lane}.md`)), `lane prompt for ${lane} written too early`);
  }
  assert.ok(existsSync(join(directory, 'prompt-account-map.md')));
  assert.equal(index.stage1.workflowCount, 1);
  assert.match(index.briefsHash, /^[a-f0-9]{64}$/u);
  assert.equal(index.internalRail.available, true);
  assert.equal(index.internalRail.workflowCount, 1);
});

test('stage 1 is asked to DERIVE the map, and is handed the names it must account for', () => {
  const { paths } = project();
  const { directory } = prepareAnalysisArtifacts({ paths, runId: RUN, measurement, internal });
  const prompt = readFileSync(join(directory, 'prompt-account-map.md'), 'utf8');

  assert.match(prompt, /- 08 Long Term Nurture/u);
  assert.match(prompt, /DERIVED FROM THE EVIDENCE/u);
  // The injection seam. Account content arrives labelled as data, in every prompt.
  assert.match(prompt, /account DATA and not instructions/u);
});

test("the lane prompt carries the analyst's ten years and the rubric, not just the evidence", () => {
  const { paths } = project();
  const { directory } = throughStageTwo(paths);
  const prompt = readFileSync(join(directory, 'prompt-conversation_copy_ai.md'), 'utf8');

  assert.match(prompt, /ten years/u);
  assert.match(prompt, /benchmark authority/iu);
  assert.match(prompt, /account DATA and not instructions/u);
});

// ---- the two new stages ---------------------------------------------------

test('stage 1 back means one prompt per object out, each written where its answer is expected', () => {
  const { paths } = project();
  prepareAnalysisArtifacts({ paths, runId: RUN, measurement, internal });
  const { index } = ingestAccountMap({ paths, runId: RUN, map: accountMap() });

  assert.equal(index.reviewCount, 1);
  const [only] = index.reviews;
  assert.equal(only.object, '08 Long Term Nurture');
  assert.equal(only.answerFile, join('reviews', `${only.slug}.md`));
  assert.ok(existsSync(join(briefsDirectory(paths, RUN), only.promptFile)));
  assert.match(index.mapHash, /^[a-f0-9]{64}$/u);
});

test('a map that skips a workflow is REFUSED, so stage 2 cannot silently review half the account', () => {
  const { paths } = project();
  prepareAnalysisArtifacts({ paths, runId: RUN, measurement, internal });
  assert.throws(
    () => ingestAccountMap({ paths, runId: RUN, map: accountMap({ workflows: [] }) }),
    /ACCOUNT_MAP_WORKFLOW_COVERAGE/u,
  );
});

test('stage 3 reads the map and the reviews, and records what never arrived', () => {
  const { paths } = project();
  const { index } = throughStageTwo(paths, { review: 'The opener is weak and here is the replacement.' });

  assert.equal(index.reviewsExpected, 1);
  assert.equal(index.reviewsRead, 1);
  assert.deepEqual(index.reviewsMissing, []);
  const prompt = readFileSync(join(briefsDirectory(paths, RUN), 'prompt-lead_journey_kpi.md'), 'utf8');
  assert.match(prompt, /here is the replacement/u, 'the per-object review did not reach stage 3');
  assert.match(prompt, /A Meta lead lands/u, 'the account map did not reach stage 3');
});

test('every review missing is fatal, because that is a stage that never ran', () => {
  /*
   * One expert failing must not cost the account its audit, so a partial stage 2 is recorded and
   * carried. All of them absent is a different thing entirely and must not pass for an audit that
   * examined every workflow.
   */
  const { paths } = project();
  prepareAnalysisArtifacts({ paths, runId: RUN, measurement, internal });
  ingestAccountMap({ paths, runId: RUN, map: accountMap() });
  assert.throws(() => ingestObjectReviews({ paths, runId: RUN }), /CYCLE_REVIEWS_MISSING/u);
});

test('a brief is written under private/, never into the publication area', () => {
  const { paths } = project();
  const { directory } = prepareAnalysisArtifacts({ paths, runId: RUN, measurement, internal });

  assert.ok(directory.startsWith(join(paths.root, 'private')), directory);
  const brief = readFileSync(join(directory, 'brief-conversation_copy_ai.json'), 'utf8');
  // The quoted copy is IN the brief, which is exactly why the brief may not live under weekly/.
  assert.match(brief, /saw your enquiry about patient acquisition/u);
});

test('writing the same run twice is fine; writing different bytes for it is fatal', () => {
  const { paths } = project();
  prepareAnalysisArtifacts({ paths, runId: RUN, measurement, internal });
  // Deterministic, so a second pass over the same evidence is a no-op rather than an overwrite.
  prepareAnalysisArtifacts({ paths, runId: RUN, measurement, internal });

  assert.throws(
    // Different evidence under the same run id means something upstream is not what it claims.
    () => prepareAnalysisArtifacts({ paths, runId: RUN, measurement, internal: null }),
    /CYCLE_ARTIFACT_CONFLICT/u,
  );
});

test('with the rail off the briefs say lanes 2 and 3 are unanswerable, rather than reporting nothing wrong', () => {
  const { paths } = project();
  const { directory, index } = prepareAnalysisArtifacts({
    paths, runId: RUN, measurement, internal: null,
  });

  assert.equal(index.internalRail.available, false);
  const brief = JSON.parse(readFileSync(join(directory, 'brief-workflow_config_runtime.json'), 'utf8'));
  assert.ok(brief.provenanceLimits.some((limit) => /internal rail was OFF/u.test(limit)));
});

test('reading the briefs back gives the hash that binds an answer to the question asked', () => {
  const { paths } = project();
  const written = prepareAnalysisArtifacts({ paths, runId: RUN, measurement, internal });
  const read = readAnalysisArtifacts({ paths, runId: RUN });

  assert.equal(read.index.briefsHash, written.index.briefsHash);
  assert.equal(read.index.stage1.promptHash, written.index.stage1.promptHash);
});

test('a run with no briefs cannot be investigated', () => {
  const { paths } = project();
  assert.throws(() => readAnalysisArtifacts({ paths, runId: RUN }), /CYCLE_BRIEFS_MISSING/u);
});

// ---- ingestion ------------------------------------------------------------

test('a malformed finding is discarded and reported, and the good ones in its lane survive', () => {
  const supplied = answers({
    lead_journey_kpi: [
      finding('lead_journey_kpi', 'good_one'),
      // One competing explanation where the validator requires two.
      finding('lead_journey_kpi', 'unfalsifiable', {
        competingExplanations: [{ explanation: 'Only one.', materiality: 'MATERIAL', addressed: false }],
      }),
    ],
  });
  const { accepted, rejected } = ingestLaneFindings({ answers: supplied });

  assert.deepEqual(accepted.lead_journey_kpi.map(({ findingId }) => findingId), ['good_one']);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].findingId, 'unfalsifiable');
  assert.equal(rejected[0].code, 'LANE_FINDING_INVALID');
});

test('a lane that is absent is fatal, while a lane that found nothing is not', () => {
  const clean = ingestLaneFindings({ answers: answers() });
  assert.deepEqual(clean.accepted.conversation_copy_ai, []);

  const missing = { ...answers() };
  delete missing.conversation_copy_ai;
  assert.throws(
    () => ingestLaneFindings({ answers: missing }),
    /CYCLE_LANE_ANSWER_MISSING/u,
  );
});

test('the same findingId twice in one lane is refused rather than counted twice', () => {
  const { accepted, rejected } = ingestLaneFindings({
    answers: answers({
      lead_journey_kpi: [
        finding('lead_journey_kpi', 'same_id'),
        finding('lead_journey_kpi', 'same_id'),
      ],
    }),
  });
  assert.equal(accepted.lead_journey_kpi.length, 1);
  assert.equal(rejected[0].code, 'LANE_FINDING_DUPLICATE');
});

test('an answer written for the wrong lane is refused, so a misfiled file cannot borrow another lane authority', () => {
  const { rejected } = ingestLaneFindings({
    answers: answers({
      conversation_copy_ai: [finding('workflow_config_runtime', 'wrong_lane')],
    }),
  });
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].detail, 'lane mismatch');
});

// ---- reading the answers off disk ----------------------------------------

test('one file per lane is read, and a lane that wrapped its own array in an object is not punished', () => {
  const root = mkdtempSync(join(tmpdir(), 'audit-answers-'));
  writeFileSync(join(root, 'lead_journey_kpi.json'), JSON.stringify([finding('lead_journey_kpi', 'a_bare_array')]));
  writeFileSync(join(root, 'workflow_config_runtime.json'), JSON.stringify({ findings: [finding('workflow_config_runtime', 'wrapped')] }));
  writeFileSync(join(root, 'conversation_copy_ai.json'), JSON.stringify([]));

  const read = readLaneAnswers(root);
  const { accepted, rejected } = ingestLaneFindings({ answers: read });
  assert.deepEqual(rejected, []);
  assert.equal(accepted.lead_journey_kpi[0].findingId, 'a_bare_array');
  assert.equal(accepted.workflow_config_runtime[0].findingId, 'wrapped');
});

test('a missing lane file reaches ingestion as absent, which is fatal rather than silently empty', () => {
  const root = mkdtempSync(join(tmpdir(), 'audit-answers-'));
  writeFileSync(join(root, 'lead_journey_kpi.json'), JSON.stringify([]));
  assert.throws(
    () => ingestLaneFindings({ answers: readLaneAnswers(root) }),
    /CYCLE_LANE_ANSWER_MISSING/u,
  );
});

// ---- the investigation ----------------------------------------------------

test('the whole ingest side writes the investigation, the backlog and one package per cause', () => {
  const { paths } = project();
  prepareAnalysisArtifacts({ paths, runId: RUN, measurement, internal });
  const summary = runInvestigation({ paths, runId: RUN, answers: answers() });

  assert.equal(summary.causeCount, 1);
  // Both lanes anchored to the same KPI edge, so this is ONE cause with two independent supports.
  assert.equal(summary.corroboratedCauseCount, 1);
  assert.equal(summary.rejectedCount, 0);
  assert.ok(existsSync(join(summary.directory, 'INVESTIGATION.md')));
  assert.ok(existsSync(join(summary.directory, 'BACKLOG.md')));
  assert.ok(existsSync(join(summary.directory, 'investigation.json')));

  const record = JSON.parse(readFileSync(join(summary.directory, 'investigation.json'), 'utf8'));
  const causeId = record.investigation.causes[0].causeId;
  assert.ok(existsSync(join(summary.directory, 'packages', `${causeId}.md`)));
});

test('the same answers always produce the same causes', () => {
  const first = project();
  prepareAnalysisArtifacts({ paths: first.paths, runId: RUN, measurement, internal });
  const a = runInvestigation({ paths: first.paths, runId: RUN, answers: answers() });

  const second = project();
  prepareAnalysisArtifacts({ paths: second.paths, runId: RUN, measurement, internal });
  const b = runInvestigation({ paths: second.paths, runId: RUN, answers: answers() });

  assert.equal(a.investigationHash, b.investigationHash);
  assert.equal(a.briefsHash, b.briefsHash);
});

test('an investigation cannot be produced against a brief that was never written', () => {
  const { paths } = project();
  assert.throws(
    () => runInvestigation({ paths, runId: RUN, answers: answers() }),
    /CYCLE_BRIEFS_MISSING/u,
  );
});

test('refused findings are named in the report and are not counted as findings', () => {
  const { paths } = project();
  prepareAnalysisArtifacts({ paths, runId: RUN, measurement, internal });
  const summary = runInvestigation({
    paths,
    runId: RUN,
    answers: answers({
      conversation_copy_ai: [finding('conversation_copy_ai', 'no_test', { discriminatingTest: {} })],
    }),
  });

  assert.equal(summary.rejectedCount, 1);
  const report = readFileSync(join(summary.directory, 'INVESTIGATION.md'), 'utf8');
  assert.match(report, /1 analyst finding was REFUSED/u);
  assert.match(report, /no_test/u);
  // And it is not in the counts.
  const record = JSON.parse(readFileSync(join(summary.directory, 'investigation.json'), 'utf8'));
  assert.equal(record.investigation.laneFindingCounts.conversation_copy_ai, 0);
});

// ---- what a person reads -------------------------------------------------

test('the report carries what a reader needs to disagree, not only the conclusion', () => {
  const { paths } = project();
  const { index } = prepareAnalysisArtifacts({ paths, runId: RUN, measurement, internal });
  const supplied = answers();
  const findings = LANES.flatMap((lane) => supplied[lane]);
  const investigation = investigateRootCause({
    laneAnalyses: supplied,
    briefsHash: index.briefsHash,
  });
  const report = renderInvestigation({ index, investigation, findings, rejected: [] });

  assert.match(report, /Benchmark:/u);
  assert.match(report, /Competing explanations:/u);
  assert.match(report, /Evidence against:/u);
  assert.match(report, /Test that would settle it:/u);
  // The one claim this product may never make.
  assert.match(report, /may not be said to have caused a past outcome/u);
  assert.ok(!report.includes('—'), 'no em dashes in Grom output');
});

test('the backlog shows the WORST band by severity, not the alphabetically last one', () => {
  const { paths } = project();
  const { index } = prepareAnalysisArtifacts({ paths, runId: RUN, measurement, internal });
  const supplied = answers({
    lead_journey_kpi: [finding('lead_journey_kpi', 'critical_impact', {
      scoring: {
        commercialImpact: 'CRITICAL',
        leadsAffected: 'HIGH',
        urgency: 'HIGH',
        implementationEffort: 'LOW',
        risk: 'LOW',
        testability: 'HIGH',
      },
    })],
  });
  const investigation = investigateRootCause({
    laneAnalyses: supplied,
    briefsHash: index.briefsHash,
  });
  const backlog = renderBacklog({ index, investigation });

  // 'CRITICAL' sorts BEFORE 'HIGH' as a string, so a string sort would have printed HIGH here.
  assert.match(backlog, /\| CRITICAL \|/u);
});

test('with the rail off the report says so at the top, so nobody reads silence as health', () => {
  const { paths } = project();
  const { index } = prepareAnalysisArtifacts({ paths, runId: RUN, measurement, internal: null });
  const investigation = investigateRootCause({
    laneAnalyses: { lead_journey_kpi: [], workflow_config_runtime: [], conversation_copy_ai: [] },
    briefsHash: index.briefsHash,
  });
  const report = renderInvestigation({ index, investigation, findings: [], rejected: [] });

  assert.match(report, /internal rail was OFF/u);
  assert.match(report, /should be read as "the/u);
});

// ---- the two commands ----------------------------------------------------

test('the commands walk the whole chain, and print hashes rather than account content', async () => {
  const { root, paths } = project();
  prepareAnalysisArtifacts({ paths, runId: RUN, measurement, internal });

  const written = [];
  const stdout = { write: (line) => written.push(line) };
  const cli = (argv) => runAuditCli({ argv: [...argv, '--project', root, '--location', LOCATION, '--run-id', RUN], stdout });

  // The stage is derived from what is on disk, so a run resumed in a new session reports the truth
  // rather than what somebody last wrote down.
  const stage1 = await cli(['briefs']);
  assert.equal(stage1.status, 'awaiting_account_map');
  assert.match(stage1.briefsHash, /^[a-f0-9]{64}$/u);
  assert.deepEqual(stage1.prompts, [{ stage: 'account_map', promptFile: 'prompt-account-map.md' }]);

  const mapFile = join(root, 'map.json');
  writeFileSync(mapFile, JSON.stringify(accountMap()));
  const stage2 = await cli(['map', '--map', mapFile]);
  assert.equal(stage2.status, 'awaiting_object_reviews');
  assert.equal(stage2.reviewCount, 1);
  assert.match(stage2.mapHash, /^[a-f0-9]{64}$/u);

  const directory = briefsDirectory(paths, RUN);
  for (const { answerFile } of stage2.prompts) {
    writeFileSync(join(directory, answerFile), 'The opener earns the second line.');
  }
  const stage3 = await cli(['reviews']);
  assert.equal(stage3.status, 'awaiting_lane_analysis');
  assert.equal(stage3.reviewCount, 1);
  assert.equal(stage3.missingCount, 0);
  assert.deepEqual(stage3.lanes.map(({ lane }) => lane), [...LANES]);

  // And `briefs` now reports the stage the run has actually reached.
  assert.equal((await cli(['briefs'])).status, 'awaiting_lane_analysis');
  // The quoted copy is in the brief FILE and must never be in the line an operator pastes.
  assert.ok(!written.join('').includes('saw your enquiry'));

  const answersFile = join(root, 'answers.json');
  writeFileSync(answersFile, JSON.stringify(answers()));
  const done = await runAuditCli({
    argv: [
      'investigate', '--project', root, '--location', LOCATION,
      '--run-id', RUN, '--findings', answersFile,
    ],
    stdout,
  });
  assert.equal(done.status, 'investigated');
  assert.equal(done.causeCount, 1);
  assert.equal(done.rejectedCount, 0);
  assert.match(done.investigationHash, /^[a-f0-9]{64}$/u);
});

test('no command accepts a flag another one owns', () => {
  assert.throws(
    () => parseAuditCliArgs(['briefs', '--project', 'p', '--location', 'L1', '--run-id', 'r', '--findings', 'f']),
    /AUDIT_COMMAND_INVALID_FLAG/u,
  );
  assert.throws(
    () => parseAuditCliArgs(['investigate', '--project', 'p', '--location', 'L1', '--run-id', 'r']),
    /AUDIT_COMMAND_INVALID_MISSING/u,
  );
  assert.throws(
    () => parseAuditCliArgs(['map', '--project', 'p', '--location', 'L1', '--run-id', 'r']),
    /AUDIT_COMMAND_INVALID_MISSING/u,
  );
  assert.throws(
    () => parseAuditCliArgs(['reviews', '--project', 'p', '--location', 'L1', '--run-id', 'r', '--map', 'm']),
    /AUDIT_COMMAND_INVALID_FLAG/u,
  );
});

test('a run id that could climb out of the audit root is refused', () => {
  const { paths } = project();
  for (const runId of ['../escape', 'a/b', '', '.']) {
    assert.throws(() => briefsDirectory(paths, runId), /CYCLE_RUN_ID_INVALID/u, runId);
  }
});

// ---- the package points at the rewrite that already exists -----------------

/**
 * THE GAP THIS CLOSES.
 *
 * A package said "the text at the highest-intent moment leaves out the rebooking link" while the
 * stage-2 review of that same workflow, written earlier in the SAME run, already held all ten
 * messages rewritten in full. They sat in two directories with nothing connecting them, so whoever
 * picked up the package was told to rewrite copy that was already written.
 */
function causeAnchoredTo(anchors) {
  return {
    causeId: 'c_1',
    confidence: 'C2',
    corroboratingLanes: ['lead_journey_kpi'],
    anchors,
    findings: [{
      lane: 'lead_journey_kpi',
      findingId: 'f1',
      title: 'The recovery sequence keeps messaging people who rebooked',
      fix: 'Stop the sequence on reply.',
      competingExplanations: [],
      discriminatingTest: { check: 'c', supportsIf: 's', refutesIf: 'r' },
    }],
  };
}

const REVIEW_INDEX = [
  { kind: 'workflow', object: '05 No-Show Recovery', slug: '05-no-show-recovery', answerFile: 'reviews/05-no-show-recovery.md', messageCount: 10 },
  { kind: 'workflow', object: '08 Long Term Nurture', slug: '08-long-term-nurture', answerFile: 'reviews/08-long-term-nurture.md', messageCount: 12 },
  { kind: 'agent', object: 'voice_ai Arthur', slug: 'voice-ai-arthur', answerFile: 'reviews/voice-ai-arthur.md', messageCount: null },
];

test('a package names the review holding the rewritten copy for its own workflows', () => {
  const page = renderSolutionPackage({
    index: { runId: RUN, locationId: LOCATION },
    cause: causeAnchoredTo(['workflow:05 No-Show Recovery', 'kpi:enquiry_to_contacted', 'stage:conversation']),
    findings: [],
    reviews: REVIEW_INDEX,
  });

  assert.match(page, /The rewritten copy is already written/u);
  assert.match(page, /10 messages reviewed/u);
  assert.match(page, /reviews\/05-no-show-recovery\.md/u);
  assert.match(page, /Do not rewrite this copy from scratch/u);
  // Only ITS OWN workflows. A package must never advertise a rewrite for something it does not touch.
  assert.ok(!page.includes('08 Long Term Nurture'), 'an unrelated workflow leaked into the package');
});

test('a workflow nobody reviewed is named as unreviewed, never left silent', () => {
  /*
   * Silence would read as "there is no rewrite for this". The truth is "no expert looked at this
   * workflow", and those two need completely different action.
   */
  const page = renderSolutionPackage({
    index: { runId: RUN, locationId: LOCATION },
    cause: causeAnchoredTo(['workflow:05 No-Show Recovery', 'workflow:12 Tagger']),
    findings: [],
    reviews: REVIEW_INDEX,
  });
  assert.match(page, /NOT reviewed, so no replacement copy exists/u);
  assert.match(page, /- 12 Tagger/u);
});

test('a problem about no workflow at all gets no rewrite section', () => {
  const page = renderSolutionPackage({
    index: { runId: RUN, locationId: LOCATION },
    cause: causeAnchoredTo(['kpi:enquiry_to_contacted']),
    findings: [],
    reviews: REVIEW_INDEX,
  });
  assert.ok(!page.includes('The rewritten copy'), 'an empty section was written for a problem with no workflows');
});

test('the whole chain wires the reviews into the packages, end to end', () => {
  const { paths } = project();
  throughStageTwo(paths, { review: 'Message 1 rewritten in full: here is the replacement.' });
  const summary = runInvestigation({
    paths,
    runId: RUN,
    answers: answers({
      lead_journey_kpi: [finding('lead_journey_kpi', 'nurture_never_stops', {
        anchors: { kpiEdgeIds: ['enquiry_to_contacted'], workflowNames: ['08 Long Term Nurture'], journeyStages: [] },
      })],
      workflow_config_runtime: [],
    }),
  });

  const record = JSON.parse(readFileSync(join(summary.directory, 'investigation.json'), 'utf8'));
  const page = readFileSync(
    join(summary.directory, 'packages', `${record.investigation.causes[0].causeId}.md`),
    'utf8',
  );
  assert.match(page, /The rewritten copy is already written/u);
  assert.match(page, /08 Long Term Nurture/u);
});

test('a review that was asked for but never written is not advertised as copy to paste', () => {
  const { paths } = project();
  prepareAnalysisArtifacts({ paths, runId: RUN, measurement, internal });
  // Stage 2 was prepared, so the index lists a review, but no expert ever answered it.
  ingestAccountMap({ paths, runId: RUN, map: accountMap() });
  const summary = runInvestigation({
    paths,
    runId: RUN,
    answers: answers({
      lead_journey_kpi: [finding('lead_journey_kpi', 'unwritten', {
        anchors: { kpiEdgeIds: ['enquiry_to_contacted'], workflowNames: ['08 Long Term Nurture'], journeyStages: [] },
      })],
      workflow_config_runtime: [],
    }),
  });
  const record = JSON.parse(readFileSync(join(summary.directory, 'investigation.json'), 'utf8'));
  const page = readFileSync(
    join(summary.directory, 'packages', `${record.investigation.causes[0].causeId}.md`),
    'utf8',
  );
  assert.match(page, /NOT reviewed/u);
  assert.ok(!page.includes('Do not rewrite this copy from scratch'));
});
