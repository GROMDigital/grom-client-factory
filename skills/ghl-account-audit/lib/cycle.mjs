/**
 * THE CYCLE — the joining. Every box in `PRODUCT-SPEC.md` was built and tested before this file
 * existed, and nothing called them in sequence, so `audit run` collected 588 real records, measured
 * them, and published an empty report.
 *
 * The chain, end to end:
 *
 *   collect -> measure -> buildAnalysisBriefs -> buildAllAnalystPrompts
 *           -> [three expert analysts, dispatched by the SKILL]
 *           -> validateLaneFinding -> investigateRootCause
 *           -> investigation + solution packages + ranked backlog
 *
 * ---------------------------------------------------------------------------------------------
 * WHY THE ANALYSTS ARE NOT CALLED FROM IN HERE, AND WHY THAT IS NOT A COMPROMISE.
 *
 * The audit kernel is deterministic. It checkpoints every phase, canonical-JSON round-trips the
 * output, and byte-compares it on resume; a phase that answers differently the second time
 * quarantines the run. A model call is not deterministic. So a kernel that called three analysts
 * mid-run would quarantine itself on the first resume, every time.
 *
 * The split that works, and the one this module implements, is a SEAM rather than a workaround:
 *
 *   1. `prepareAnalysisArtifacts` runs inside the run. It is pure and deterministic — briefs are a
 *      function of the sealed measurement, the internal evidence and the profile — so the kernel can
 *      checkpoint around it, and the briefs land on disk with the hash that identifies them.
 *   2. The SKILL dispatches the three analysts, exactly as `/uxie-ghl-factory:audit` already
 *      dispatches its surface auditors. Their answers are JSON files.
 *   3. `runInvestigation` ingests those answers. It is deterministic too: the same lane answers
 *      always produce the same ranked causes, because `investigateRootCause` groups on anchors and
 *      orders on weights, with no clock and no randomness anywhere in it.
 *
 * So the non-deterministic step is the only one outside, and both sides of it are reproducible. Hand
 * the same three answer files back and you get byte-identical causes.
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
import { buildAnalysisBriefs } from './analysis-brief.mjs';
import { canonicalJson } from './canonical.mjs';
import { ANALYSTS, buildAllAnalystPrompts } from './lane-analysts.mjs';
import { LANES, investigateRootCause, validateLaneFinding } from './root-cause.mjs';
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
 * STEP 1, inside the run. Build the three briefs and the three prompts, and put them on disk.
 *
 * Called from the public composition root's `normalize`, where the measurement and the internal
 * evidence are both in hand. Pure apart from the write, and the write is byte-compared, so a
 * restored `normalizing` checkpoint and a fresh one leave the same files.
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
  const prompts = buildAllAnalystPrompts({ briefs });
  const directory = briefsDirectory(paths, runId);

  const lanes = prompts.prompts.map((entry) => {
    const briefFile = `brief-${entry.lane}.json`;
    const promptFile = `prompt-${entry.lane}.md`;
    writeOnce(join(directory, briefFile), briefs.lanes[ANALYSTS[entry.lane].briefKey]);
    writeOnce(join(directory, promptFile), `${entry.prompt}\n`);
    return {
      lane: entry.lane,
      discipline: entry.discipline,
      briefFile,
      promptFile,
      promptHash: entry.promptHash,
      rubricHash: entry.rubricHash,
    };
  });

  const index = {
    schemaVersion: CYCLE_SCHEMA,
    runId,
    profileId: measurement.profileId,
    locationId: measurement.locationId,
    collectionWindow: { ...measurement.collectionWindow },
    // The internal rail's state is recorded here because lanes 2 and 3 are unanswerable without it,
    // and an investigation read next month must be able to tell "nothing wrong" from "not looked at".
    internalRail: internal === null
      ? { available: false, complete: false, workflowCount: 0 }
      : {
          available: true,
          complete: internal.complete === true,
          workflowCount: Array.isArray(internal.workflows) ? internal.workflows.length : 0,
        },
    briefsHash: briefs.briefsHash,
    analystSetHash: prompts.analystSetHash,
    lanes,
  };
  writeOnce(join(directory, 'briefs.json'), index);
  return { directory, index, briefs, prompts };
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
export function renderInvestigation({ index, investigation, findings, rejected }) {
  const byId = new Map(findings.map((finding) => [`${finding.lane}:${finding.findingId}`, finding]));
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
    `Briefs \`${index.briefsHash}\`, analyst set \`${index.analystSetHash}\`, `
      + `investigation \`${investigation.investigationHash}\`.`,
    '',
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
export function renderBacklog({ index, investigation }) {
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
      + `| ${cause.confidence} | ${cause.corroboratingLanes.length}/3 | ${worst('commercialImpact')} `
      + `| ${worst('implementationEffort')} | ${worst('risk')} | ${cause.rankScore} `
      + `| \`${cause.causeId}\` |`;
  });
  return [
    '# Ranked backlog',
    '',
    `Run \`${index.runId}\`, account ${index.locationId}. Ordered by the seven criteria in`,
    'PRODUCT-SPEC.md, with effort and risk counting against.',
    '',
    '| # | Cause | Confidence | Lanes | Impact | Effort | Risk | Score | Id |',
    '|---|---|---|---|---|---|---|---|---|',
    ...(rows.length === 0 ? ['| - | (no causes) | - | - | - | - | - | - | - |'] : rows),
    '',
  ].join('\n');
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
export function renderSolutionPackage({ index, cause, findings }) {
  const byId = new Map(findings.map((finding) => [`${finding.lane}:${finding.findingId}`, finding]));
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
  ];
  return lines.join('\n');
}

/**
 * STEP 3. The whole ingest side, in one call: read the briefs, validate the answers, investigate, and
 * write the three outputs the spec names.
 */
export function runInvestigation({ paths, runId, answers } = {}) {
  const { index } = readAnalysisArtifacts({ paths, runId });
  const { accepted, rejected } = ingestLaneFindings({ answers });
  const investigation = investigateRootCause({
    laneAnalyses: accepted,
    briefsHash: index.briefsHash,
  });
  const findings = LANES.flatMap((lane) => accepted[lane]);
  const directory = investigationDirectory(paths, runId);

  const record = {
    schemaVersion: CYCLE_SCHEMA,
    runId,
    briefsHash: index.briefsHash,
    analystSetHash: index.analystSetHash,
    internalRail: index.internalRail,
    rejected,
    investigation,
  };
  writeOnce(join(directory, 'investigation.json'), record);
  writeOnce(
    join(directory, 'INVESTIGATION.md'),
    renderInvestigation({ index, investigation, findings, rejected }),
  );
  writeOnce(join(directory, 'BACKLOG.md'), renderBacklog({ index, investigation }));
  const packages = ensureWithin(paths.auditRoot, join(directory, 'packages'));
  for (const cause of investigation.causes) {
    writeOnce(
      join(packages, `${cause.causeId}.md`),
      renderSolutionPackage({ index, cause, findings }),
    );
  }

  return {
    directory,
    briefsHash: index.briefsHash,
    investigationHash: investigation.investigationHash,
    causeCount: investigation.causeCount,
    corroboratedCauseCount: investigation.corroboratedCauseCount,
    rejectedCount: rejected.length,
    rejected,
  };
}
