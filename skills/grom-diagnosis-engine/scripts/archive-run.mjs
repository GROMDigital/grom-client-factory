#!/usr/bin/env node
/**
 * FILE A FINISHED RUN INTO THE CLIENT'S OWN FOLDER, IN A SHAPE SOMETHING CAN BE POINTED AT.
 *
 * A run is produced in `~/.grom-audit-runs/<label>/`, which is a working directory outside every
 * repo. That is the right place to PRODUCE it and the wrong place to keep it: the client work lives
 * in the client's folder, and a diagnosis nobody can find is a diagnosis nobody acts on.
 *
 * The layout is FIXED, every account, every week, so an agent can be pointed at the folder and rely
 * on the shape without being told it:
 *
 *   <client>/Grom Diagnosis Engine (Weekly Audit)/<account>/<date>/
 *     START-HERE.md        read order, what each thing is, and what NOT to trust
 *     PLAN.md              the running order. what to do first
 *     BACKLOG.md           the ranked problems, one table
 *     packages/            one file per problem: what to change, how you will know it worked
 *     reviews/             one per workflow and per AI agent. THE REPLACEMENT COPY LIVES HERE
 *     INVESTIGATION.md     the full argument behind every problem
 *     REPORT.html          the same content as a page, for a person
 *     map.json             what the engine worked out the account IS
 *     findings/            raw expert output before grouping, plus their closing notes
 *     evidence/            the sealed briefs and prompts the experts actually read
 *     config/              enough to reproduce the run
 *
 * WHAT IT WILL NOT COPY: the vault key, and the encrypted publication store. The key is the only
 * thing standing between the raw evidence and anyone who finds the disk, and copying it into a repo
 * alongside the data it protects would defeat it entirely.
 *
 * Usage:
 *   node scripts/archive-run.mjs \
 *     --project ~/.grom-audit-runs/<label> --location <locationId> --run-id <runId> \
 *     --into "/path/to/<client folder>" [--account "SK Skin"] [--date YYYY-MM-DD]
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SKILL = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FOLDER = 'Grom Diagnosis Engine (Weekly Audit)';

function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (typeof key !== 'string' || !key.startsWith('--') || typeof value !== 'string') {
      throw new Error(`ARCHIVE_BAD_ARGUMENTS near ${JSON.stringify(key)}`);
    }
    flags[key.slice(2)] = value;
  }
  for (const required of ['project', 'location', 'run-id', 'into']) {
    if (!flags[required]) throw new Error(`ARCHIVE_MISSING_FLAG --${required}`);
  }
  return flags;
}

const flags = parseArgs(process.argv.slice(2));
const home = process.env.HOME ?? '~';
const projectRoot = resolve(flags.project.replace(/^~/u, home));
const into = resolve(flags.into.replace(/^~/u, home));
const runId = flags['run-id'];

const auditRoot = join(projectRoot, 'audits', 'ghl', flags.location);
const investigation = join(auditRoot, 'investigations', runId);
const briefs = join(auditRoot, 'private', 'briefs', runId);
if (!existsSync(investigation)) throw new Error(`ARCHIVE_NO_INVESTIGATION ${investigation}`);
if (!existsSync(briefs)) throw new Error(`ARCHIVE_NO_BRIEFS ${briefs}`);
if (!existsSync(into)) throw new Error(`ARCHIVE_NO_CLIENT_FOLDER ${into}`);

/*
 * The date is the WEEK THE RUN READ, taken from the run's own collection window, not the wall clock.
 * Filing a Monday run under the Tuesday you got round to archiving it would make the folder names
 * disagree with the evidence inside them, and the whole point of the date is to line runs up.
 */
const briefIndex = JSON.parse(readFileSync(join(briefs, 'briefs.json'), 'utf8'));
const window = briefIndex.collectionWindow ?? {};
const cutoff = window.to ?? window.cutoff ?? null;

/*
 * 🔴 RENDER THE DATE IN THE ACCOUNT'S TIMEZONE, NOT UTC.
 *
 * The cutoff is an instant. For SK Skin it is Monday 27 July 00:00 in Australia/Sydney, which is
 * Sunday 26 July 14:00 UTC, so `toISOString().slice(0,10)` files a Monday boundary under Sunday's
 * date. The folder name is how a person and an agent line runs up week to week, so it has to agree
 * with the week the account itself experienced. The timezone is not in briefs.json; it is in the
 * provider config, which is the same value the run was sealed with.
 */
const providerConfigFile = readdirSync(projectRoot).find((f) => f.startsWith('provider-') && f.endsWith('.json'));
const runTimezone = providerConfigFile
  ? JSON.parse(readFileSync(join(projectRoot, providerConfigFile), 'utf8')).timezone
  : null;
const inZone = (instant, timezone) => new Intl.DateTimeFormat('en-CA', {
  timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date(instant));
const date = flags.date
  ?? (cutoff && runTimezone ? inZone(cutoff, runTimezone) : null)
  ?? (cutoff ? new Date(cutoff).toISOString().slice(0, 10) : null);
if (!date) throw new Error('ARCHIVE_NO_DATE could not read the collection window; pass --date');
if (cutoff && !runTimezone) {
  console.warn('WARNING: no provider config found, so the date is UTC and may name the wrong day.');
}

const accountName = flags.account ?? flags.location;
const destination = join(into, FOLDER, accountName, date);
mkdirSync(destination, { recursive: true });

const copied = [];
const copy = (from, to, { optional = false } = {}) => {
  if (!existsSync(from)) {
    if (optional) return;
    throw new Error(`ARCHIVE_MISSING ${from}`);
  }
  mkdirSync(dirname(to), { recursive: true });
  cpSync(from, to, { recursive: true });
  copied.push(basename(to));
};

// The deliverables.
for (const name of ['PLAN.md', 'BACKLOG.md', 'INVESTIGATION.md', 'REPORT.html', 'plan.json', 'investigation.json']) {
  copy(join(investigation, name), join(destination, name), { optional: name.endsWith('.json') });
}
copy(join(investigation, 'packages'), join(destination, 'packages'));

// The reviews: the answers only. A prompt is evidence and goes to evidence/ below.
const reviewsOut = join(destination, 'reviews');
mkdirSync(reviewsOut, { recursive: true });
for (const file of readdirSync(join(briefs, 'reviews'))) {
  if (file.endsWith('.md') && !file.startsWith('prompt-')) {
    copy(join(briefs, 'reviews', file), join(reviewsOut, file));
  }
}
copy(join(briefs, 'map.json'), join(destination, 'map.json'), { optional: true });

// Raw expert output, before grouping. Provenance for every claim in the packages.
const findingsIn = join(projectRoot, 'findings');
if (existsSync(findingsIn)) copy(findingsIn, join(destination, 'findings'));
copy(join(projectRoot, 'work-order.json'), join(destination, 'work-order.json'), { optional: true });

/*
 * EVIDENCE. The sealed briefs and every prompt the experts were given, so a claim can be traced back
 * to exactly what its author could see. Large and full of real message copy, which is why it sits in
 * its own directory rather than beside the deliverables.
 */
const evidence = join(destination, 'evidence');
mkdirSync(evidence, { recursive: true });
for (const file of readdirSync(briefs)) {
  if (file === 'reviews') continue;
  copy(join(briefs, file), join(evidence, file));
}
const promptsOut = join(evidence, 'reviews-prompts');
mkdirSync(promptsOut, { recursive: true });
for (const file of readdirSync(join(briefs, 'reviews'))) {
  if (file.startsWith('prompt-')) copy(join(briefs, 'reviews', file), join(promptsOut, file));
}

// Reproducibility. The vault key is deliberately NOT here.
const configOut = join(destination, 'config');
mkdirSync(configOut, { recursive: true });
for (const file of readdirSync(projectRoot)) {
  if (file.startsWith('provider-') || file === 'build-config.mjs') {
    copy(join(projectRoot, file), join(configOut, file));
  }
}
const facts = join(SKILL, 'profiles', 'accounts', `${flags.location}.v1.json`);
copy(facts, join(configOut, `account-facts-${flags.location}.v1.json`), { optional: true });

/*
 * Caveats come from the MERGED profile, not from the account overlay alone.
 *
 * Reading only the overlay reported "0 recorded caveats" for Grom UK, which was flatly wrong: that
 * account runs the `grom_internal` profile, whose caveats live in the profile itself and include
 * things like appointment outcomes being un-automatable. Stating that a run had no caveats when it
 * had six is the same class of error as having no caveats at all, because the reader trusts it.
 */
const { loadProfile } = await import(join(SKILL, 'schemas/v1.mjs'));
let caveats = [];
try {
  caveats = loadProfile(briefIndex.profileId, flags.location).situation?.knownDataCaveats ?? [];
} catch {
  caveats = existsSync(facts)
    ? (JSON.parse(readFileSync(facts, 'utf8')).situation?.knownDataCaveats ?? [])
    : [];
}
const packageCount = readdirSync(join(destination, 'packages')).length;
const reviewCount = readdirSync(reviewsOut).length;
const internal = briefIndex.internalRail ?? {};

writeFileSync(join(destination, 'START-HERE.md'), `# ${accountName} — diagnosis of ${date}

Account \`${flags.location}\`. Run \`${runId}\`.

**Read-only. Nothing in here has been applied to the account.** Every fix is a proposal for a human
to approve. ${packageCount} problems, ${reviewCount} objects reviewed.

## If you are an agent being pointed at this folder

Work in this order. Do not start from the evidence.

1. **\`PLAN.md\`** — the running order. It says which problems are one job, what has to land first,
   and which fixes pull against each other. Do not reorder it without saying why: the sequencing
   expert had reasons, and some fixes cannot be judged until an earlier one lands.
2. **\`BACKLOG.md\`** — the ranked problems in one table, with confidence and how many independent
   lanes reached each one. Use it as the index.
3. **\`packages/\`** — one file per problem. Each says what is wrong, what to change, where it
   applies, and how you will know it worked. **This is the action list.**
4. **\`reviews/\`** — one per workflow and per AI agent. Each ends with a rewrite section carrying the
   replacement copy message by message. **When a package says "rewrite this message", the words are
   here, not in the package.**

\`INVESTIGATION.md\` holds the full argument behind every problem and is where to go when you
disagree with one. \`REPORT.html\` is the same material as a page for a person to read.

## Before you act on anything in here

**A finding is an argument, not a verdict.** Nothing downstream of the analysis re-checks a claim, so
a wrong finding travels intact into the plan. Every package carries a test that would settle it. Run
the test before doing expensive work on the strength of the claim.

**Check the confidence and the lane count.** A problem reached independently by more than one lane
survived more scrutiny than one reached by a single lane at low confidence.

**Nothing here may be applied automatically.** These touch live messaging to real patients.

## What was true about this account when it was read

${caveats.length === 0 ? '_No account-specific caveats were recorded for this run._' : caveats.map((c) => `- ${c}`).join('\n')}

${internal.available === false ? '**The internal rail was OFF for this run**, so no workflow configuration was read.\n' : ''}
## What this run could NOT see

- **Runtime.** ${internal.workflowCount ? `${internal.workflowCount} workflow definitions were read` : 'Workflow definitions were read'}, but a runtime window is requested per workflow and any workflow without one records \`RUNTIME_NOT_REQUESTED\`. Where that is so, a claim about how a workflow BEHAVES is inferred from how it is BUILT.
- **Causation.** Nothing on this rail proves the configuration read here was the configuration in force during the window. A config may be called consistent with an outcome, never the cause of a past one.

## Where the raw evidence and the key live

\`evidence/\` holds the sealed briefs and every prompt an expert was given, so any claim can be traced
to exactly what its author could see.

The encrypted collection and its key stay OUTSIDE this folder, in \`${projectRoot}\`. **The key is not
copied here on purpose**: it is the only thing protecting the raw record of real people, and filing
it beside the data it protects would defeat it. Lose it and the sealed evidence is unreadable.
`);

/*
 * CHANGES-MADE.md — THE TEMPLATE, EMITTED EMPTY, FOR WHOEVER DOES THE WORK.
 *
 * Week over week can already tell NEW from RECURRING from ABSENT. What it cannot tell, and says so
 * in its own header, is whether something ABSENT was FIXED or merely stopped being detected: an
 * expert may have framed it differently, the evidence may have moved, or the finding may have been
 * refused for a formatting slip. Only a record of what was actually changed settles that, and
 * nothing was producing one.
 *
 * So the engine emits the record as a TEMPLATE rather than expecting someone to invent it. It is
 * scaffolded from THIS run's own causes in the plan's batch order, so an agent works down it in the
 * order the sequencing expert intended and cannot invent a cause id: they are all pre-listed.
 *
 * It is deliberately NOT written into the hash-chained ledger. That path demands a `solutionId` and
 * a `proposalHash` matching a compiled proposal, and compiled proposals were deliberately never
 * built because these packages are human-implementation documents. Minting a hash to satisfy the
 * check would put forged provenance in the one record that exists to be trustworthy.
 */
const planRecord = existsSync(join(destination, 'plan.json'))
  ? JSON.parse(readFileSync(join(destination, 'plan.json'), 'utf8'))
  : null;
const plan = planRecord?.plan ?? planRecord;
const investigationRecord = JSON.parse(readFileSync(join(destination, 'investigation.json'), 'utf8'));
const causes = investigationRecord.investigation?.causes ?? [];
const titleOf = new Map(causes.map((c) => [c.causeId, c.findings?.[0]?.title ?? '']));

const batches = plan?.batches ?? [];
const placed = new Set(batches.flatMap((b) => b.causeIds ?? []));
const unplaced = causes.map((c) => c.causeId).filter((id) => !placed.has(id));

const section = (causeId) => `### ${causeId}

${titleOf.get(causeId) ?? '(title unavailable)'}

- **Status:** NOT STARTED
- **What was actually done:**
- **Date done:**
- **Deviated from the package?** no

`;

writeFileSync(join(destination, 'CHANGES-MADE.md'), `# Changes made after the ${date} diagnosis

**${accountName}** · account \`${flags.location}\` · run \`${runId}\`

FILL THIS IN AS YOU DO THE WORK. It is the ONLY thing that lets next week's run tell a problem you
FIXED from a problem that merely stopped being detected. Without it, anything that disappears is
reported as "absent this week", which is not the same as solved and is never claimed to be.

## How to fill it in

Set **Status** on each problem below to one of:

| Status | Means |
|---|---|
| \`NOT STARTED\` | untouched. leave it |
| \`DONE\` | changed in the account, as the package describes |
| \`DONE (DIFFERENT)\` | changed, but not the way the package said. Say what you did instead |
| \`SKIPPED\` | deliberately not doing it. Say why |
| \`BLOCKED\` | cannot be done yet. Say what is in the way |

Be honest about \`DONE (DIFFERENT)\` and \`SKIPPED\`. A wrong record here is worse than no record: next
week's comparison will report a fix that never happened, and the problem will look solved while it
carries on costing money.

**Do not edit the cause ids or add new ones.** They are the join key to the diagnosis, and an id that
does not match is silently ignored.

${batches.length === 0 ? '' : batches.map((batch, index) => `## Batch ${index + 1}${batch.title ? `: ${batch.title}` : ''}

${(batch.causeIds ?? []).map(section).join('')}`).join('')}${unplaced.length === 0 ? '' : `## Not placed in a batch

${unplaced.map(section).join('')}`}
## Anything else you changed

Changes you made that were not on this list. The diagnosis cannot see these coming, and they are the
most likely explanation for a problem that moves next week for no visible reason.

-
`);

/*
 * LAST-WEEK.md — what you said you changed, against what the account still shows.
 *
 * The ledger already answers NEW / RECURRING / ABSENT. It cannot answer "did the fix work", because
 * ABSENT is not FIXED. Crossing last week's CHANGES-MADE.md with this week's causes answers it, and
 * the crossing happens HERE rather than inside the run because the run is sealed and byte-compared:
 * folding a hand-edited markdown file into a sealed artefact would make the run unreproducible.
 *
 * Read the PREVIOUS archived week, not the ledger, because the claim is a human statement about what
 * was done and belongs beside the diagnosis it answers.
 */
const accountFolder = join(into, FOLDER, accountName);
const priorWeeks = existsSync(accountFolder)
  ? readdirSync(accountFolder).filter((d) => /^\d{4}-\d{2}-\d{2}$/u.test(d) && d < date).sort()
  : [];
const previous = priorWeeks.at(-1) ?? null;
let lastWeekWritten = false;

if (previous) {
  const priorChanges = join(accountFolder, previous, 'CHANGES-MADE.md');
  const thisWeeksIds = new Set(causes.map((c) => c.causeId));
  const claimed = new Map();
  if (existsSync(priorChanges)) {
    const text = readFileSync(priorChanges, 'utf8');
    // Each block is "### <causeId>" followed by its fields, up to the next heading.
    // `(?![\s\S])` is end-of-input. `\z` is Ruby and throws under the `u` flag.
    for (const match of text.matchAll(/^### (cause_[a-f0-9]+)\n([\s\S]*?)(?=^#{2,3} |(?![\s\S]))/gmu)) {
      const status = (match[2].match(/\*\*Status:\*\*\s*(.+)/u)?.[1] ?? '').trim();
      const did = (match[2].match(/\*\*What was actually done:\*\*\s*(.*)/u)?.[1] ?? '').trim();
      claimed.set(match[1], { status: status || 'NOT STARTED', did });
    }
  }
  const acted = [...claimed.entries()].filter(([, v]) => /^DONE/u.test(v.status));
  const stillHere = acted.filter(([id]) => thisWeeksIds.has(id));
  const gone = acted.filter(([id]) => !thisWeeksIds.has(id));
  const untouchedGone = [...claimed.entries()]
    .filter(([id, v]) => !/^DONE/u.test(v.status) && !thisWeeksIds.has(id));

  writeFileSync(join(destination, 'LAST-WEEK.md'), `# Against last week (${previous})

${claimed.size === 0
  ? `Last week's \`CHANGES-MADE.md\` was never filled in, so nothing can be said about whether anything
was fixed. Every problem below is simply what this run found. **Fill in this week's
\`CHANGES-MADE.md\` as you work** and next week this page will be worth reading.`
  : `Last week recorded **${acted.length} of ${claimed.size}** problems as actioned.`}

${acted.length === 0 ? '' : `## Changed, and the problem is GONE this week — ${gone.length}

Treat as fixed. This is the only combination that earns that word.

${gone.length === 0 ? '_none_' : gone.map(([id, v]) => `- \`${id}\`${v.did ? ` — ${v.did}` : ''}`).join('\n')}

## Changed, and the problem is STILL HERE — ${stillHere.length}

🔴 **The fix did not work, or did not address the cause.** Read the package again before doing more.

${stillHere.length === 0 ? '_none_' : stillHere.map(([id, v]) => `- \`${id}\`${v.did ? ` — ${v.did}` : ''}`).join('\n')}
`}
## Gone, but nobody changed anything — ${untouchedGone.length}

Do NOT read these as fixed. A problem vanishes when an expert frames it differently, when the
evidence moves, or when its finding was refused this week for a formatting slip. Unexplained
disappearance is a reason to look, not to celebrate.

${untouchedGone.length === 0 ? '_none_' : untouchedGone.map(([id]) => `- \`${id}\``).join('\n')}
`);
  lastWeekWritten = true;
}

/*
 * The week-over-week ledger itself. Small, and it is the ONLY record of what this account looked
 * like in previous weeks. Leaving it solely in the working directory means losing that directory
 * silently restarts every account at week one.
 */
const memoryDir = join(auditRoot, 'memory');
if (existsSync(memoryDir)) copy(memoryDir, join(destination, 'history'));

console.log(`archived to ${destination}`);
console.log(`  ${packageCount} packages, ${reviewCount} reviews, ${caveats.length} recorded caveats`);
console.log(`  CHANGES-MADE.md written as a TEMPLATE: fill it in as the work is done`);
if (lastWeekWritten) console.log(`  LAST-WEEK.md compares against ${previous}`);
console.log('  START-HERE.md written: point an agent at the FOLDER, it reads that first');
