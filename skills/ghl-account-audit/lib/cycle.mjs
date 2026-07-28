/**
 * THE CYCLE — the joining. Every box in `PRODUCT-SPEC.md` was built and tested before this file
 * existed, and nothing called them in sequence, so `audit run` collected 588 real records, measured
 * them, and published an empty report.
 *
 * The chain, end to end. FIVE stages of expert, and a deterministic command on both sides of every
 * one of them:
 *
 *   collect -> measure -> buildAnalysisBriefs -> buildAccountMapPrompt
 *           -> [STAGE 1: one expert derives the account map]                    audit map
 *           -> validateAccountMap -> buildWorkflowReviewPrompts + agents
 *           -> [STAGE 2: one expert per workflow and per AI agent]              audit reviews
 *           -> buildAllAnalystPrompts, now carrying the map and every review
 *           -> [STAGE 3: three account-wide experts]                            audit investigate
 *           -> validateLaneFinding -> investigateRootCause
 *           -> [STAGE 4] investigation + solution packages + ranked backlog
 *
 * The expert COUNT comes from the account, never from a constant here: as many stage-2 experts as
 * the account has workflows worth reviewing, which the derived map decides.
 *
 * ---------------------------------------------------------------------------------------------
 * WHY THE EXPERTS ARE NOT CALLED FROM IN HERE, AND WHY THAT IS NOT A COMPROMISE.
 *
 * The audit kernel is deterministic. It checkpoints every phase, canonical-JSON round-trips the
 * output, and byte-compares it on resume; a phase that answers differently the second time
 * quarantines the run. A model call is not deterministic. So a kernel that called three analysts
 * mid-run would quarantine itself on the first resume, every time.
 *
 * The split that works, and the one this module implements, is a SEAM rather than a workaround, and
 * it repeats once per stage:
 *
 *   1. `prepareAnalysisArtifacts` runs inside the run. It is pure and deterministic — briefs are a
 *      function of the sealed measurement, the internal evidence and the profile — so the kernel can
 *      checkpoint around it, and the briefs land on disk with the hash that identifies them.
 *   2. The SKILL dispatches the experts, exactly as `/uxie-ghl-factory:audit` already dispatches its
 *      surface auditors. Their answers are files.
 *   3. `ingestAccountMap` and `ingestObjectReviews` take each stage's answers back and build the next
 *      stage's prompts from them. Both are deterministic and write-once byte-compared.
 *   4. `runInvestigation` ingests the lane findings. Deterministic too: the same answers always
 *      produce the same ranked causes, because `investigateRootCause` groups on anchors and orders on
 *      weights, with no clock and no randomness anywhere in it.
 *
 * So every non-deterministic step sits outside, and both sides of each are reproducible. Hand the
 * same answers back and you get byte-identical causes.
 * ---------------------------------------------------------------------------------------------
 *
 * WHAT THIS MODULE REFUSES TO DO. It does not judge a finding, soften one, or invent one. An analyst
 * answer arrives as a CLAIM: `ingestLaneFindings` puts every one through `validateLaneFinding`, which
 * REFUSES rather than down-ranks, and the refusals are reported rather than swallowed — a lane whose
 * answer was malformed and a lane that found nothing are different facts.
 */
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { buildAccountMapPrompt, validateAccountMap } from './account-map.mjs';
import { buildAnalysisBriefs } from './analysis-brief.mjs';
import { canonicalJson, sha256 } from './canonical.mjs';
import { ANALYSTS, buildAllAnalystPrompts } from './lane-analysts.mjs';
import { buildAgentReviewPrompts, buildWorkflowReviewPrompts } from './object-review.mjs';
import { compareToHistory, readObservations, recordRun } from './recurrence.mjs';
import { LANES, investigateRootCause, validateLaneFinding } from './root-cause.mjs';
import { renderReportPage } from './report-page.mjs';
import { buildWorkOrderPrompt, renderWorkOrder, validateWorkOrder } from './work-order.mjs';
import { loadProfile } from '../schemas/v1.mjs';

export const CYCLE_SCHEMA = '1.0.0';

/** A run id, as narrow as the CLI's own pattern. It becomes a directory name. */
const RUN_ID = /^[A-Za-z0-9][-A-Za-z0-9_.:]{0,127}$/u;

/** The scoring bands in severity order. `lib/root-cause.mjs` scores them; this only displays them. */
const BAND_ORDER = Object.freeze(['NONE', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);

function codedError(code, ErrorType = Error) {
  return Object.assign(new ErrorType(code), { code });
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertRunId(runId) {
  if (typeof runId !== 'string' || !RUN_ID.test(runId)) throw codedError('CYCLE_RUN_ID_INVALID');
  return runId;
}

/**
 * Directories are created here rather than in `ensureAuditPaths` for one reason: a run that never
 * reaches the analysis stage should not leave empty evidence directories behind that a later reader
 * mistakes for "we looked and found nothing".
 *
 * The containment check is the same one `lib/paths.mjs` applies to every other audit directory. It is
 * repeated rather than assumed because these two are the only paths in the layout derived from a
 * value (`runId`) that arrives on the command line.
 */
function ensureWithin(auditRoot, pathname) {
  if (!existsSync(pathname)) mkdirSync(pathname, { recursive: true, mode: 0o700 });
  const entry = lstatSync(pathname);
  if (entry.isSymbolicLink() || !entry.isDirectory()) throw codedError('CYCLE_PATH_INVALID');
  const fromRoot = relative(realpathSync(auditRoot), realpathSync(pathname));
  if (fromRoot === '' || fromRoot === '..' || fromRoot.startsWith(`..${sep}`)) {
    throw codedError('CYCLE_PATH_ESCAPE');
  }
  return pathname;
}

/**
 * WHERE THE BRIEFS LIVE: under `private/`, with the raw evidence, not under `weekly/`.
 *
 * `weekly/` is the publication area. A brief carries quoted message copy and AI instructions read
 * straight off the account, which is exactly the material the publication boundary exists to keep
 * from leaving by accident.
 */
export function briefsDirectory(paths, runId) {
  return ensureWithin(
    paths.auditRoot,
    join(paths.root, 'private', 'briefs', assertRunId(runId)),
  );
}

/** Where an investigation lands. Derived from the run, so two runs never overwrite each other. */
export function investigationDirectory(paths, runId) {
  return ensureWithin(
    paths.auditRoot,
    join(paths.root, 'investigations', assertRunId(runId)),
  );
}

/**
 * Write-once, byte-compared.
 *
 * The same guard `local-runtime.mjs` uses on a publication, and for the same reason here: briefs and
 * causes are DETERMINISTIC, so a re-run producing different bytes for the same run id means
 * something upstream is not what it claims to be, and that is worth stopping on rather than
 * overwriting quietly.
 */
function writeOnce(pathname, value) {
  const bytes = Buffer.from(typeof value === 'string' ? value : `${canonicalJson(value)}\n`, 'utf8');
  if (existsSync(pathname)) {
    const entry = lstatSync(pathname);
    if (entry.isSymbolicLink() || !entry.isFile()) throw codedError('CYCLE_ARTIFACT_CONFLICT');
    if (!readFileSync(pathname).equals(bytes)) throw codedError('CYCLE_ARTIFACT_CONFLICT');
    return pathname;
  }
  const temporary = `${pathname}.tmp`;
  writeFileSync(temporary, bytes, { mode: 0o600 });
  renameSync(temporary, pathname);
  chmodSync(pathname, 0o400);
  return pathname;
}

function readJsonFile(pathname, code) {
  try {
    const value = JSON.parse(readFileSync(pathname, 'utf8'));
    if (!isPlainObject(value)) throw new Error();
    return value;
  } catch {
    throw codedError(code);
  }
}

/**
 * STEP 1, inside the run. Build the three lane briefs, and the prompt for the ONE expert that reads
 * the whole account and derives its map.
 *
 * Called from the public composition root's `normalize`, where the measurement and the internal
 * evidence are both in hand. Pure apart from the write, and the write is byte-compared, so a
 * restored `normalizing` checkpoint and a fresh one leave the same files.
 *
 * The three LANE prompts are NOT written here any more, and that is the whole shape of the redesign:
 * the account-wide experts are stage 3, they read the map and every per-object review, and neither
 * exists yet at this point in the run.
 */
export function prepareAnalysisArtifacts({
  paths,
  runId,
  measurement,
  internal = null,
} = {}) {
  if (!isPlainObject(measurement)) throw codedError('CYCLE_MEASUREMENT_INVALID', TypeError);
  const profile = loadProfile(measurement.profileId);
  const briefs = buildAnalysisBriefs({ measurement, internal, profile });
  const directory = briefsDirectory(paths, runId);

  const laneBriefs = LANES.map((lane) => {
    const briefFile = `brief-${lane}.json`;
    writeOnce(join(directory, briefFile), briefs.lanes[ANALYSTS[lane].briefKey]);
    return { lane, briefKey: ANALYSTS[lane].briefKey, briefFile };
  });

  const accountMap = buildAccountMapPrompt({ briefs });
  writeOnce(join(directory, 'prompt-account-map.md'), `${accountMap.prompt}\n`);

  const index = {
    schemaVersion: CYCLE_SCHEMA,
    runId,
    profileId: measurement.profileId,
    locationId: measurement.locationId,
    collectionWindow: { ...measurement.collectionWindow },
    // The internal rail's state is recorded here because stages 1 to 3 are unanswerable without it,
    // and an investigation read next month must be able to tell "nothing wrong" from "not looked at".
    internalRail: internal === null
      ? { available: false, complete: false, workflowCount: 0 }
      : {
          available: true,
          complete: internal.complete === true,
          workflowCount: Array.isArray(internal.workflows) ? internal.workflows.length : 0,
        },
    briefsHash: briefs.briefsHash,
    stage1: {
      promptFile: 'prompt-account-map.md',
      promptHash: accountMap.promptHash,
      rubricHash: accountMap.rubricHash,
      workflowCount: accountMap.workflowCount,
    },
    laneBriefs,
  };
  writeOnce(join(directory, 'briefs.json'), index);
  return { directory, index, briefs, accountMap };
}

/** Read back what step 1 wrote. The `briefsHash` is what binds an answer to the question asked. */
export function readAnalysisArtifacts({ paths, runId } = {}) {
  const directory = briefsDirectory(paths, runId);
  const pathname = join(directory, 'briefs.json');
  if (!existsSync(pathname)) throw codedError('CYCLE_BRIEFS_MISSING');
  const index = readJsonFile(pathname, 'CYCLE_BRIEFS_UNREADABLE');
  if (index.runId !== runId || typeof index.briefsHash !== 'string') {
    throw codedError('CYCLE_BRIEFS_UNREADABLE');
  }
  return { directory, index };
}

/**
 * The briefs themselves, reassembled from disk into the shape the prompt builders expect.
 *
 * Read back rather than rebuilt. Rebuilding would mean re-reading the sealed measurement in a
 * command that runs hours later and possibly after a resume, which is a second source for a question
 * that already has one. `briefsHash` comes from the index and is not recomputed here, so a brief file
 * edited by hand cannot quietly pass as the brief an expert was actually given.
 */
export function readBriefs({ paths, runId } = {}) {
  const { directory, index } = readAnalysisArtifacts({ paths, runId });
  const lanes = {};
  for (const { briefKey, briefFile } of index.laneBriefs ?? []) {
    lanes[briefKey] = readJsonFile(join(directory, briefFile), 'CYCLE_BRIEFS_UNREADABLE');
  }
  if (Object.keys(lanes).length !== LANES.length) throw codedError('CYCLE_BRIEFS_UNREADABLE');
  return { directory, index, briefs: { briefsHash: index.briefsHash, lanes } };
}

/**
 * STEP 2. Take stage 1's map back, and build one prompt per object from it.
 *
 * The map is VALIDATED against the briefs before anything is written: it must cover every workflow
 * exactly once and may not name a workflow or a KPI edge the account does not have. See
 * `lib/account-map.mjs` for why that check is the load-bearing one.
 */
export function ingestAccountMap({ paths, runId, map: answer } = {}) {
  const { directory, index, briefs } = readBriefs({ paths, runId });
  const { map, mapHash } = validateAccountMap(answer, { briefs });

  const workflows = buildWorkflowReviewPrompts({ briefs, map });
  const agents = buildAgentReviewPrompts({ briefs, map });
  const reviewsDirectory = ensureWithin(paths.auditRoot, join(directory, 'reviews'));

  const written = [];
  for (const review of workflows.reviews) {
    const promptFile = join('reviews', `prompt-workflow-${review.slug}.md`);
    writeOnce(join(directory, promptFile), `${review.prompt}\n`);
    written.push({
      kind: 'workflow',
      object: review.workflow,
      slug: review.slug,
      role: review.role,
      onTheMoneyPath: review.onTheMoneyPath,
      messageCount: review.messageCount,
      promptFile,
      // Where the expert's answer must land, so the ingest side never has to guess a filename.
      answerFile: join('reviews', `${review.slug}.md`),
      promptHash: review.promptHash,
    });
  }
  for (const review of agents.reviews) {
    const promptFile = join('reviews', `prompt-agent-${review.slug}.md`);
    writeOnce(join(directory, promptFile), `${review.prompt}\n`);
    written.push({
      kind: 'agent',
      object: `${review.surface} ${review.agent}`,
      slug: review.slug,
      role: 'ai_agent',
      onTheMoneyPath: null,
      messageCount: null,
      promptFile,
      answerFile: join('reviews', `${review.slug}.md`),
      promptHash: review.promptHash,
    });
  }

  writeOnce(join(directory, 'map.json'), { schemaVersion: CYCLE_SCHEMA, runId, mapHash, map });
  const record = {
    schemaVersion: CYCLE_SCHEMA,
    runId,
    briefsHash: index.briefsHash,
    mapHash,
    reviewCount: written.length,
    // Workflows deliberately NOT reviewed, with the reason. "We chose not to look" and "this does
    // not exist" are different facts and only one of them is true.
    skipped: workflows.skipped,
    rubricHashes: { workflow: workflows.rubricHash, agent: agents.rubricHash },
    setHash: sha256(written.map(({ promptHash }) => promptHash)),
    reviews: written,
  };
  writeOnce(join(directory, 'reviews.json'), record);
  return { directory: reviewsDirectory, index: record };
}

/** Read a stage-1 answer off disk, tolerating a model that wrapped its map in `{ "map": ... }`. */
export function readAccountMapAnswer(pathname) {
  const target = resolve(pathname);
  if (!existsSync(target) || lstatSync(target).isSymbolicLink()) throw codedError('CYCLE_MAP_MISSING');
  const value = readJsonFile(target, 'CYCLE_MAP_UNREADABLE');
  return isPlainObject(value.map) ? value.map : value;
}

/** What step 2 wrote, so step 3 knows which reviews it is waiting on. */
export function readReviewIndex({ paths, runId } = {}) {
  const directory = briefsDirectory(paths, runId);
  const pathname = join(directory, 'reviews.json');
  if (!existsSync(pathname)) throw codedError('CYCLE_REVIEW_INDEX_MISSING');
  return { directory, index: readJsonFile(pathname, 'CYCLE_REVIEW_INDEX_UNREADABLE') };
}

/**
 * STEP 3. Take the per-object reviews back, and build the three account-wide prompts from them.
 *
 * A MISSING REVIEW IS RECORDED, NOT FATAL. One expert failing should not cost the account its audit,
 * and the honest handling is the same as everywhere else here: the count of what was expected and
 * what arrived travels with the run, and the stage-3 rubrics tell an analyst to say where a gap
 * limits it. All of them missing IS fatal, because that is not a gap, it is a stage that never ran.
 */
export function ingestObjectReviews({ paths, runId } = {}) {
  const { directory, briefs } = readBriefs({ paths, runId });
  const { index: reviewIndex } = readReviewIndex({ paths, runId });
  const mapRecord = readJsonFile(join(directory, 'map.json'), 'CYCLE_MAP_UNREADABLE');

  const collected = [];
  const missing = [];
  for (const expected of reviewIndex.reviews) {
    const pathname = join(directory, expected.answerFile);
    if (!existsSync(pathname) || !lstatSync(pathname).isFile()) {
      missing.push({ kind: expected.kind, object: expected.object, answerFile: expected.answerFile });
      continue;
    }
    const body = readFileSync(pathname, 'utf8').trim();
    if (body.length === 0) {
      missing.push({ kind: expected.kind, object: expected.object, answerFile: expected.answerFile });
      continue;
    }
    collected.push({ kind: expected.kind, object: expected.object, slug: expected.slug, text: body });
  }
  if (reviewIndex.reviews.length > 0 && collected.length === 0) {
    throw codedError('CYCLE_REVIEWS_MISSING');
  }

  const prompts = buildAllAnalystPrompts({ briefs, map: mapRecord.map, reviews: collected });
  const lanes = prompts.prompts.map((entry) => {
    const promptFile = `prompt-${entry.lane}.md`;
    writeOnce(join(directory, promptFile), `${entry.prompt}\n`);
    return {
      lane: entry.lane,
      discipline: entry.discipline,
      briefFile: `brief-${entry.lane}.json`,
      promptFile,
      promptHash: entry.promptHash,
      rubricHash: entry.rubricHash,
    };
  });

  const record = {
    schemaVersion: CYCLE_SCHEMA,
    runId,
    briefsHash: briefs.briefsHash,
    mapHash: mapRecord.mapHash,
    analystSetHash: prompts.analystSetHash,
    reviewsExpected: reviewIndex.reviews.length,
    reviewsRead: collected.length,
    reviewsMissing: missing,
    lanes,
  };
  writeOnce(join(directory, 'analysts.json'), record);
  return { directory, index: record };
}

/** What step 3 wrote, when it has run. Absent means the lane prompts were never built. */
function readAnalystRecord(directory) {
  const pathname = join(directory, 'analysts.json');
  return existsSync(pathname) ? readJsonFile(pathname, 'CYCLE_ANALYSTS_UNREADABLE') : null;
}

/** The same, by run. `null` rather than a throw: "stage 3 has not run yet" is a normal state. */
export function readAnalystIndex({ paths, runId } = {}) {
  return readAnalystRecord(briefsDirectory(paths, runId));
}

/**
 * The per-object reviews that EXIST ON DISK, so a package can point at real files.
 *
 * Ground truth is the file, not the index. The index records what was asked for, and a review that
 * was asked for and never written would otherwise be advertised in a solution package as copy
 * somebody could go and paste. Returns empty for a run that never reached stage 2, which is a
 * legitimate state and not an error.
 */
function availableReviews(directory) {
  const pathname = join(directory, 'reviews.json');
  if (!existsSync(pathname)) return [];
  let record;
  try {
    record = readJsonFile(pathname, 'CYCLE_REVIEW_INDEX_UNREADABLE');
  } catch {
    return [];
  }
  return (record.reviews ?? []).filter((review) => {
    const answer = join(directory, review.answerFile ?? '');
    return typeof review.answerFile === 'string'
      && existsSync(answer)
      && lstatSync(answer).isFile()
      && readFileSync(answer, 'utf8').trim().length > 0;
  });
}

/**
 * STEP 3a. Turn three model answers into evidence, or refuse them.
 *
 * `answers` is `{ <lane>: [findings] }`. A lane that found nothing must say so with an empty array:
 * an absent lane is refused, because a missing lane published as a whole investigation is the one
 * error here that cannot be spotted by reading the output.
 *
 * A malformed FINDING is discarded and recorded; a malformed LANE is fatal. The asymmetry is
 * deliberate — one analyst fumbling one finding out of six should not throw away the other five,
 * while a lane that returned something other than a list of findings did not do the job at all.
 */
export function ingestLaneFindings({ answers } = {}) {
  if (!isPlainObject(answers)) throw codedError('CYCLE_ANSWERS_INVALID', TypeError);
  const accepted = {};
  const rejected = [];
  for (const lane of LANES) {
    const supplied = answers[lane];
    if (!Array.isArray(supplied)) {
      throw Object.assign(codedError('CYCLE_LANE_ANSWER_MISSING'), { detail: lane });
    }
    const kept = [];
    const seen = new Set();
    supplied.forEach((finding, index) => {
      try {
        validateLaneFinding(finding, { lane });
        if (seen.has(finding.findingId)) {
          throw Object.assign(codedError('LANE_FINDING_DUPLICATE'), { detail: finding.findingId });
        }
        seen.add(finding.findingId);
        kept.push(finding);
      } catch (error) {
        rejected.push({
          lane,
          index,
          findingId: typeof finding?.findingId === 'string' ? finding.findingId : null,
          code: error?.code ?? 'LANE_FINDING_INVALID',
          detail: typeof error?.detail === 'string' ? error.detail : null,
        });
      }
    });
    accepted[lane] = kept;
  }
  return { accepted, rejected };
}

/**
 * Read the three answers off disk. Accepts either one file holding all three lanes, or a directory
 * holding one file per lane (`<lane>.json`), which is the shape three dispatched subagents naturally
 * produce.
 *
 * A per-lane file may be the bare array the rubric asks for, or an object with a `findings` array —
 * a model that wraps its own output should not cost a lane its analysis.
 */
export function readLaneAnswers(pathname) {
  const target = resolve(pathname);
  if (!existsSync(target)) throw codedError('CYCLE_ANSWERS_MISSING');
  const entry = lstatSync(target);
  if (entry.isSymbolicLink()) throw codedError('CYCLE_ANSWERS_MISSING');
  if (entry.isFile()) {
    const value = readJsonFile(target, 'CYCLE_ANSWERS_UNREADABLE');
    return Object.fromEntries(LANES.map((lane) => [lane, laneArray(value[lane])]));
  }
  if (!entry.isDirectory()) throw codedError('CYCLE_ANSWERS_MISSING');
  const files = new Set(readdirSync(target));
  return Object.fromEntries(LANES.map((lane) => {
    const filename = `${lane}.json`;
    if (!files.has(filename)) return [lane, undefined];
    const raw = readFileSync(join(target, filename), 'utf8');
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw Object.assign(codedError('CYCLE_ANSWERS_UNREADABLE'), { detail: filename });
    }
    return [lane, laneArray(parsed)];
  }));
}

function laneArray(value) {
  if (Array.isArray(value)) return value;
  if (isPlainObject(value) && Array.isArray(value.findings)) return value.findings;
  return value;
}

function bulleted(items) {
  return items.length === 0 ? ['(none)'] : items.map((item) => `- ${item}`);
}

function plural(count, one, many) {
  return `${count} ${count === 1 ? one : many}`;
}

/** An analyst writes its own full stops. Appending a second one is how a report starts looking sloppy. */
function sentence(text) {
  return String(text ?? '').trim().replace(/\.+$/u, '');
}

/**
 * THE INVESTIGATION, as a person reads it.
 *
 * Ordered by rank, because the first question anybody asks of this document is what to fix first, and
 * a document that answers that in its first paragraph is the only kind that gets used twice.
 *
 * Every cause carries the things that let a reader DISAGREE with it: which lanes supported it, the
 * competing explanations nobody ruled out, the strongest evidence against it, and the test that would
 * settle it. That is the difference between a report and a list of assertions.
 */
export function renderInvestigation({ index, investigation, findings, rejected, recurrence = null }) {
  const byId = new Map(findings.map((finding) => [`${finding.lane}:${finding.findingId}`, finding]));
  const history = new Map((recurrence?.causes ?? []).map((entry) => [entry.causeId, entry]));
  const lines = [
    '# Weekly audit: root-cause investigation',
    '',
    `Account ${index.locationId}, profile \`${index.profileId}\`, run \`${index.runId}\`.`,
    `Window ${index.collectionWindow?.from ?? 'unknown'} to ${index.collectionWindow?.to ?? 'unknown'}.`,
    '',
    `**${plural(investigation.causeCount, 'cause', 'causes')}**, of which `
      + `${investigation.corroboratedCauseCount} `
      + `${investigation.corroboratedCauseCount === 1 ? 'was' : 'were'} reached independently by more `
      + 'than one lane.',
    '',
    'Findings per lane: '
      + LANES.map((lane) => `${lane} ${investigation.laneFindingCounts[lane]}`).join(', ')
      + '.',
    '',
  ];

  if (index.internalRail.available !== true) {
    lines.push(
      '> The internal rail was OFF for this run. No workflow configuration or runtime evidence',
      '> exists, so lanes 2 and 3 could not be answered. Nothing below should be read as "the',
      '> automation is fine".',
      '',
    );
  } else if (index.internalRail.complete !== true) {
    lines.push(
      `> The internal collection was incomplete (${index.internalRail.workflowCount} workflows read).`,
      '',
    );
  }

  if (rejected.length > 0) {
    lines.push(
      `## ${plural(rejected.length, 'analyst finding was', 'analyst findings were')} REFUSED`,
      '',
      'A refused finding is not a finding. It is recorded so the rubric can be corrected, and it is',
      'not ranked, not published, and not counted above.',
      '',
      ...rejected.map(({ lane, index: position, findingId, code, detail }) => (
        `- ${lane} #${position}${findingId ? ` (\`${findingId}\`)` : ''}: ${code}`
          + `${detail ? ` (${detail})` : ''}`
      )),
      '',
    );
  }

  investigation.causes.forEach((cause, position) => {
    lines.push(
      `## ${position + 1}. ${cause.findings[0].title}`,
      '',
      `\`${cause.causeId}\` · confidence **${cause.confidence}** · rank score ${cause.rankScore}`,
      `· supported by ${cause.corroboratingLanes.length} of 3 lanes `
        + `(${cause.corroboratingLanes.join(', ')})`,
      '',
      ...causeHistory(history.get(cause.causeId)),
      `**Mechanism:** ${cause.mechanisms.join(', ')}`
        + `${cause.mechanismContested ? ' (the lanes DISAGREE on the family, which is itself information)' : ''}`,
      '',
      `**Anchored to:** ${cause.anchors.join(', ')}`,
      '',
    );
    if (cause.unresolvedMaterialAlternatives > 0) {
      lines.push(
        `**${plural(cause.unresolvedMaterialAlternatives, 'material alternative is', 'material alternatives are')}`
          + ' unresolved.** This cause is ranked lower for it, and resolving them is cheaper than'
          + ' acting on it.',
        '',
      );
    }
    for (const summary of cause.findings) {
      const full = byId.get(`${summary.lane}:${summary.findingId}`);
      lines.push(
        `### ${summary.lane}: ${summary.title}`,
        '',
        full?.analysis ?? '(analysis not carried)',
        '',
        `**Benchmark:** ${full?.benchmark ?? 'not stated'}`,
        '',
        `**Size:** ${full?.sizing ?? 'not stated'}`,
        '',
        '**Competing explanations:**',
        ...bulleted(summary.competingExplanations.map(({ explanation, materiality, addressed }) => (
          `${materiality}${addressed === true ? ', ruled out' : ', NOT ruled out'}: ${explanation}`
        ))),
        '',
        `**Evidence against:** ${summary.evidenceAgainst}`,
        '',
        `**Test that would settle it:** ${sentence(summary.discriminatingTest.check)}. `
          + `Supports if ${sentence(summary.discriminatingTest.supportsIf)}. `
          + `Refutes if ${sentence(summary.discriminatingTest.refutesIf)}.`,
        '',
      );
    }
  });

  lines.push(
    '## Provenance',
    '',
    `Briefs \`${index.briefsHash}\`, analyst set \`${index.analystSetHash ?? 'not built'}\`, `
      + `investigation \`${investigation.investigationHash}\`.`,
    '',
    ...(index.mapHash
      ? [
          `Account map \`${index.mapHash}\`. Per-object reviews: `
            + `${index.reviewsRead ?? 0} of ${index.reviewsExpected ?? 0} read`
            + `${(index.reviewsMissing ?? []).length > 0
              ? `, missing ${index.reviewsMissing.map(({ object }) => object).join(', ')}`
              : ''}.`,
          '',
        ]
      : [
          'NO ACCOUNT MAP AND NO PER-OBJECT REVIEWS were part of this run, so no workflow was',
          'examined on its own before the account-wide analysis. Read the findings below with that',
          'in mind.',
          '',
        ]),
    'Nothing on the internal rail proves the workflow configuration read here was the configuration',
    'in force during the window. A configuration may be called consistent with an outcome, or said to',
    'produce one going forward. It may not be said to have caused a past outcome.',
    '',
  );
  return lines.join('\n');
}

/**
 * THE RANKED BACKLOG. One table, because its entire job is to be looked at for ten seconds on a
 * Monday and answer "what are we doing this week".
 *
 * Effort and risk are shown next to impact rather than folded away into the score, so the person
 * choosing can override the order for a reason the weights cannot know.
 */
export function renderBacklog({ index, investigation, recurrence = null }) {
  /*
   * AGE IS THE COLUMN A READER LOOKS AT SECOND. "Critical, and it was critical three weeks ago" is a
   * different conversation from "critical, and new this week", and until now the backlog could not
   * tell them apart.
   */
  const byCauseId = new Map((recurrence?.causes ?? []).map((entry) => [entry.causeId, entry]));
  const age = (causeId) => {
    const entry = byCauseId.get(causeId);
    if (!entry) return recurrence?.unavailable ? '?' : 'new';
    if (entry.status === 'RECURRING') {
      return `${plural(entry.priorRuns, 'run', 'runs')} before this`;
    }
    return entry.nearMatches.length > 0 ? 'new (similar seen before)' : 'new';
  };
  const rows = investigation.causes.map((cause, position) => {
    /*
     * Highest band across the cause's findings, ordered by SEVERITY and not alphabetically. Sorting
     * the labels as strings put CRITICAL before HIGH before LOW and would have printed the mildest
     * band in the column a reader scans first.
     */
    const worst = (key) => cause.findings.reduce((held, finding) => (
      BAND_ORDER.indexOf(finding.scoring[key]) > BAND_ORDER.indexOf(held)
        ? finding.scoring[key]
        : held
    ), 'NONE');
    return `| ${position + 1} | ${cause.findings[0].title.replaceAll('|', '\\|')} `
      + `| ${age(cause.causeId)} | ${cause.confidence} | ${cause.corroboratingLanes.length}/3 `
      + `| ${worst('commercialImpact')} `
      + `| ${worst('implementationEffort')} | ${worst('risk')} | ${cause.rankScore} `
      + `| \`${cause.causeId}\` |`;
  });
  return [
    '# Ranked backlog',
    '',
    `Run \`${index.runId}\`, account ${index.locationId}. Ordered by the seven criteria in`,
    'PRODUCT-SPEC.md, with effort and risk counting against.',
    '',
    ...historyLine(recurrence),
    '| # | Cause | Age | Confidence | Lanes | Impact | Effort | Risk | Score | Id |',
    '|---|---|---|---|---|---|---|---|---|---|',
    ...(rows.length === 0 ? ['| - | (no causes) | - | - | - | - | - | - | - | - |'] : rows),
    '',
    ...absentSection(recurrence),
  ].join('\n');
}

/**
 * How long this exact problem has been on the report.
 *
 * A near match is SHOWN rather than treated as a match. Identity is the mechanism plus the
 * discriminating anchors, so renaming a workflow changes it, and quietly matching across that gap
 * would let the report claim a problem is recurring when it might be a different one. Stating the
 * overlap lets a reader make the call the arithmetic cannot.
 */
function causeHistory(entry) {
  if (entry === undefined) return [];
  if (entry.status === 'RECURRING') {
    return [
      `**Seen before.** First recorded ${entry.firstSeenAt}, and it has appeared in `
        + `${plural(entry.priorRuns, 'earlier run', 'earlier runs')}. It has survived every week since.`,
      '',
    ];
  }
  if (entry.nearMatches.length === 0) return ['**New this week.**', ''];
  const [closest] = entry.nearMatches;
  return [
    '**New this week, but possibly not.** An earlier run recorded a problem with the same mechanism '
      + `and ${Math.round(closest.anchorOverlap * 100)}% of the same anchors, first seen `
      + `${closest.firstSeenAt}. Identity here is the mechanism plus the exact anchors, so a renamed `
      + 'workflow or a shifted KPI reads as a new problem. Worth checking whether this is that one.',
    '',
  ];
}

/** One line saying what this run could compare itself against. Never silent about having no history. */
function historyLine(recurrence) {
  if (recurrence === null) return [];
  if (recurrence.unavailable) {
    return [
      `> The week-over-week comparison could not be made (${recurrence.unavailable}), so every Age`,
      '> below reads `?`. That is a missing comparison, not a backlog of new problems.',
      '',
    ];
  }
  if (recurrence.priorRunCount === 0) {
    return [
      '> This is the FIRST recorded run for this account, so every problem below is new by',
      '> definition and Age carries no information yet. From the next run it will.',
      '',
    ];
  }
  return [
    `> Compared against ${plural(recurrence.priorRunCount, 'earlier run', 'earlier runs')}: `
      + `${recurrence.newCount} new, ${recurrence.recurringCount} seen before.`,
    '',
  ];
}

/**
 * What was here before and is not now. ABSENT, never "fixed".
 *
 * A cause can vanish because somebody fixed it, because an expert framed it differently this week,
 * because its finding was refused, or because the evidence moved. Only a verification would settle it,
 * and nothing writes one yet. Calling this "resolved" would be the report claiming credit it has not
 * earned.
 */
function absentSection(recurrence) {
  if (recurrence === null || recurrence.unavailable || (recurrence.absent ?? []).length === 0) return [];
  return [
    '## Recorded before, absent this week',
    '',
    'This is NOT a list of fixed problems. A cause drops off this report when it is solved, when an',
    'expert framed it differently, when its finding was refused, or when the evidence moved. Nothing',
    'here has been verified as fixed.',
    '',
    '| Fingerprint | First seen | Last seen | Runs it appeared in |',
    '|---|---|---|---|',
    ...recurrence.absent.map(({ fingerprint, firstSeenAt, lastSeenAt, priorRuns }) => (
      `| \`${fingerprint.slice(0, 12)}\` | ${firstSeenAt} | ${lastSeenAt} | ${priorRuns} |`
    )),
    '',
  ];
}

/**
 * ONE SOLUTION PACKAGE PER CAUSE.
 *
 * Implementation-ready in the sense the spec asks for: what to change, stated by the analyst who
 * found the problem, with the acceptance test that decides whether it worked already written down.
 *
 * It is NOT an executable change set. `lib/proposals.mjs` compiles those, and it requires every
 * touched object bound by id and version, which is a contract a lane analyst is not yet asked to
 * emit. Until it is, this package is for a human to implement and the file says so rather than
 * implying a machine could apply it.
 */
/**
 * THE REWRITES THIS PROBLEM ALREADY HAS, WHICH NOBODY WAS BEING TOLD ABOUT.
 *
 * A package says "the text at the highest-intent moment leaves out the rebooking link". The stage-2
 * review of that same workflow, written earlier in the same run, already contains all ten messages
 * rewritten in full and ready to paste. They lived in two directories with nothing connecting them,
 * so whoever picked up the package was told to rewrite copy that was already written.
 *
 * Matched on the workflow names the cause is anchored to, which is the same key `groupByAnchor` uses,
 * so a package can never claim a rewrite for a workflow the problem does not actually touch.
 *
 * LINKED, NOT PASTED. One review of a twelve-message sequence runs several pages; inlining three of
 * them turns a one-page plan into something nobody reads to the end.
 */
function rewritesFor({ cause, reviews }) {
  const named = (cause.anchors ?? [])
    .filter((anchor) => anchor.startsWith('workflow:'))
    .map((anchor) => anchor.slice('workflow:'.length));
  const byWorkflow = new Map(
    reviews.filter(({ kind }) => kind === 'workflow').map((review) => [review.object, review]),
  );
  return {
    named,
    available: named.map((name) => byWorkflow.get(name)).filter((review) => review !== undefined),
    // Named by the finding but never reviewed. Silence here would read as "there is no rewrite for
    // this", when the truth is "no expert looked at this workflow", and those need different action.
    unreviewed: named.filter((name) => !byWorkflow.has(name)).sort(),
  };
}

export function renderSolutionPackage({ index, cause, findings, reviews = [] }) {
  const byId = new Map(findings.map((finding) => [`${finding.lane}:${finding.findingId}`, finding]));
  const rewrites = rewritesFor({ cause, reviews });
  const lines = [
    `# Solution package: ${cause.findings[0].title}`,
    '',
    `\`${cause.causeId}\` · run \`${index.runId}\` · account ${index.locationId}`,
    `· confidence ${cause.confidence} · ${cause.corroboratingLanes.length} of 3 lanes`,
    '',
    'FOR HUMAN IMPLEMENTATION AND APPROVAL. Nothing here is applied by this tool.',
    '',
    '## What is wrong',
    '',
    ...cause.findings.flatMap((summary) => [
      `**${summary.lane}:** ${summary.title}`,
      '',
      byId.get(`${summary.lane}:${summary.findingId}`)?.analysis ?? '(analysis not carried)',
      '',
    ]),
    '## What to change',
    '',
    ...cause.findings.flatMap((summary) => [`**${summary.lane}:**`, '', summary.fix, '']),
    '## Where it applies',
    '',
    ...bulleted(cause.anchors),
    '',
    '## How we will know it worked',
    '',
    ...cause.findings.flatMap((summary) => [
      `- ${summary.discriminatingTest.check}`,
      `  - worked: ${summary.discriminatingTest.supportsIf}`,
      `  - did not: ${summary.discriminatingTest.refutesIf}`,
    ]),
    '',
    '## Before doing this, check',
    '',
    ...bulleted(cause.findings.flatMap((summary) => summary.competingExplanations
      .filter((alternative) => alternative.materiality === 'MATERIAL' && alternative.addressed !== true)
      .map(({ explanation }) => `Unresolved: ${explanation}`))),
    '',
    ...(rewrites.named.length === 0 ? [] : [
      '## The rewritten copy is already written',
      '',
      ...(rewrites.available.length === 0 ? [] : [
        'Each of these was reviewed on its own by an expert who read every message in it and wrote',
        'the replacements in full. Do not rewrite this copy from scratch: open these and start there.',
        '',
        ...rewrites.available.map(({ object, answerFile, messageCount }) => (
          `- **${object}** — ${typeof messageCount === 'number' ? `${plural(messageCount, 'message', 'messages')} reviewed` : 'reviewed'}`
            + `, replacements in \`private/briefs/${index.runId}/${answerFile}\``
        )),
        '',
      ]),
      ...(rewrites.unreviewed.length === 0 ? [] : [
        `NOT reviewed, so no replacement copy exists for ${rewrites.unreviewed.length === 1 ? 'this one' : 'these'}:`,
        ...rewrites.unreviewed.map((name) => `- ${name}`),
        '',
      ]),
    ]),
  ];
  return lines.join('\n');
}

/**
 * STEP 3. The whole ingest side, in one call: read the briefs, validate the answers, investigate, and
 * write the three outputs the spec names.
 */
export function runInvestigation({ paths, runId, answers } = {}) {
  const { directory: briefsDir, index: briefsIndex } = readAnalysisArtifacts({ paths, runId });
  /*
   * The provenance of an investigation is the WHOLE chain that produced it, not only the briefs. A
   * run whose stage-2 reviews half failed and a run where they all landed produce different findings
   * from the same evidence, so the counts travel into the report rather than being inferable only by
   * reading the run directory afterwards.
   */
  const analysts = readAnalystRecord(briefsDir);
  const index = analysts === null ? briefsIndex : { ...briefsIndex, ...analysts, runId };
  /*
   * Which per-object reviews actually LANDED, checked against the disk rather than trusted from the
   * index. A review that was asked for and never written must not be advertised in a package as
   * copy somebody can go and paste.
   */
  const reviews = availableReviews(briefsDir);
  const { accepted, rejected } = ingestLaneFindings({ answers });
  const investigation = investigateRootCause({
    laneAnalyses: accepted,
    briefsHash: index.briefsHash,
  });
  const findings = LANES.flatMap((lane) => accepted[lane]);
  const directory = investigationDirectory(paths, runId);

  /*
   * WEEK OVER WEEK. Read the history BEFORE recording this run, so this run's own observations cannot
   * make its own causes look recurring.
   *
   * Best-effort by design: a ledger that cannot be read or written must not cost the account its
   * report. `recurrence` becomes null and every renderer says the comparison was unavailable, which is
   * a different statement from "nothing has changed".
   */
  let recurrence = null;
  try {
    const observations = readObservations({ paths });
    recurrence = compareToHistory({ investigation, observations, runId });
    recordRun({
      paths,
      runId,
      investigation,
      // The end of the window this evidence covers, never the clock. See `recordRun`.
      occurredAt: index.collectionWindow?.to ?? briefsIndex.collectionWindow?.to,
    });
  } catch (error) {
    recurrence = { unavailable: error?.code ?? 'RECURRENCE_FAILED' };
  }

  const record = {
    schemaVersion: CYCLE_SCHEMA,
    runId,
    briefsHash: index.briefsHash,
    // Null, not absent, when stage 3 never built the lane prompts. An investigation run straight off
    // the briefs is a legitimate thing to do and a distinguishable one.
    analystSetHash: index.analystSetHash ?? null,
    mapHash: index.mapHash ?? null,
    reviewsRead: index.reviewsRead ?? 0,
    reviewsExpected: index.reviewsExpected ?? 0,
    internalRail: index.internalRail,
    rejected,
    recurrence,
    investigation,
  };
  writeOnce(join(directory, 'investigation.json'), record);
  writeOnce(
    join(directory, 'INVESTIGATION.md'),
    renderInvestigation({ index, investigation, findings, rejected, recurrence }),
  );
  writeOnce(join(directory, 'BACKLOG.md'), renderBacklog({ index, investigation, recurrence }));
  const packages = ensureWithin(paths.auditRoot, join(directory, 'packages'));
  for (const cause of investigation.causes) {
    writeOnce(
      join(packages, `${cause.causeId}.md`),
      renderSolutionPackage({ index, cause, findings, reviews }),
    );
  }

  /*
   * STAGE 5's QUESTION, written here because it is a pure function of the ranked causes and so belongs
   * on the deterministic side of the seam. The answer comes back through `runWorkOrder`.
   *
   * Skipped when there is nothing to plan: a run with no causes needs no running order, and writing a
   * prompt asking an expert to sequence an empty list wastes an agent and invites it to invent work.
   */
  const workOrder = investigation.causes.length > 0
    ? buildWorkOrderPrompt({ investigation, recurrence })
    : null;
  if (workOrder !== null) {
    writeOnce(join(directory, 'prompt-work-order.md'), `${workOrder.prompt}\n`);
  }

  return {
    directory,
    workOrderPrompt: workOrder === null ? null : 'prompt-work-order.md',
    briefsHash: index.briefsHash,
    investigationHash: investigation.investigationHash,
    causeCount: investigation.causeCount,
    corroboratedCauseCount: investigation.corroboratedCauseCount,
    rejectedCount: rejected.length,
    rejected,
  };
}

/**
 * STAGE 5's INGEST. Take the planner's answer back and write the plan a person works from.
 *
 * Reads the investigation off disk rather than being handed it, for the same reason every other stage
 * here reads back rather than recomputing: the plan must be validated against the exact causes that
 * were ranked, not against a set rebuilt hours later from findings that may have been re-ingested.
 */
export function runWorkOrder({ paths, runId, plan: answer } = {}) {
  const directory = investigationDirectory(paths, runId);
  const pathname = join(directory, 'investigation.json');
  if (!existsSync(pathname)) throw codedError('CYCLE_INVESTIGATION_MISSING');
  const record = readJsonFile(pathname, 'CYCLE_INVESTIGATION_UNREADABLE');
  const { investigation } = record;
  if (!isPlainObject(investigation) || !Array.isArray(investigation.causes)) {
    throw codedError('CYCLE_INVESTIGATION_UNREADABLE');
  }

  const { plan, planHash } = validateWorkOrder(answer, { investigation });
  const { index } = readAnalysisArtifacts({ paths, runId });
  writeOnce(join(directory, 'plan.json'), { schemaVersion: CYCLE_SCHEMA, runId, planHash, plan });
  writeOnce(join(directory, 'PLAN.md'), renderWorkOrder({ index, plan, investigation }));

  /*
   * THE REPORT PAGE, written here because this is the first moment every input exists: the plan is
   * stage 5's answer, and these artefacts are write-once, so a page written at stage 4 could never be
   * updated to include it.
   *
   * Best-effort. The markdown above IS the deliverable and a rendering problem must not cost a run its
   * outputs, so a failure to build the page is reported and swallowed rather than thrown.
   */
  let reportPage = null;
  try {
    const briefs = readBriefs({ paths, runId });
    const mapRecord = readJsonFile(join(briefs.directory, 'map.json'), 'CYCLE_MAP_UNREADABLE');
    const { html } = renderReportPage({
      index,
      investigation,
      plan,
      recurrence: record.recurrence ?? null,
      map: mapRecord.map,
      journeyBrief: briefs.briefs.lanes.leadJourneyKpi,
      automationBrief: briefs.briefs.lanes.workflowConfigRuntime,
      reviews: availableReviews(briefs.directory),
      // Which journey step each of the six questions is about. Profile data, so the report can answer
      // them one by one without any code deciding what a question means.
      questionEdges: loadProfile(index.profileId).questionEdges ?? [],
      accountName: loadProfile(index.profileId).situation?.accountName ?? null,
    });
    writeOnce(join(directory, 'REPORT.html'), html);
    reportPage = 'REPORT.html';
  } catch (error) {
    reportPage = `unavailable:${error?.code ?? 'REPORT_PAGE_FAILED'}`;
  }

  return {
    directory,
    planHash,
    reportPage,
    batchCount: plan.batches.length,
    prerequisiteCount: plan.prerequisites.length,
    conflictCount: plan.conflicts.length,
  };
}

/** Read a stage-5 answer off disk, tolerating a model that wrapped its plan in `{ "plan": ... }`. */
export function readWorkOrderAnswer(pathname) {
  const target = resolve(pathname);
  if (!existsSync(target) || lstatSync(target).isSymbolicLink()) throw codedError('CYCLE_PLAN_MISSING');
  const value = readJsonFile(target, 'CYCLE_PLAN_UNREADABLE');
  return isPlainObject(value.plan) ? value.plan : value;
}
