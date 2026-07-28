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

const caveats = existsSync(facts)
  ? (JSON.parse(readFileSync(facts, 'utf8')).situation?.knownDataCaveats ?? [])
  : [];
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

console.log(`archived to ${destination}`);
console.log(`  ${packageCount} packages, ${reviewCount} reviews, ${caveats.length} recorded caveats`);
console.log('  START-HERE.md written: point an agent at the FOLDER, it reads that first');
