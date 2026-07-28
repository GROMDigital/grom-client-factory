---
name: grom-diagnosis-engine
description: The Grom weekly diagnosis engine. Reads ONE GoHighLevel sub-account read-only and works out what is losing it money, then writes a ranked backlog and a running order for fixing it. Five stages of expert analysis: one derives the account map, one reviews every workflow and every AI agent whole, three read the account as a journey, as one system, and as one message stream, then root-cause grouping, ranking and sequencing. Use for a weekly or on-demand commercial diagnostic of a live account, for "audit my sub-account", "why is this account not converting", "what should we fix first", or "run the weekly audit". The auditor decides what to analyse and is NEVER told; there are no hardcoded best-practice detectors. Never mutates the account and never applies a fix. For pre-build capture, post-build verification, or harvesting live IDs into a manifest, use the ghl-account-audit skill instead, which shares this codebase.
---

# grom-diagnosis-engine

READ-ONLY. This skill never creates, updates, or deletes anything in GHL. Every fix it produces is a
document for a human to approve and apply.

**Two standing rules, neither negotiable.** `PRODUCT-SPEC.md` is the authority for both.

1. **The auditor decides what to analyse. It is NEVER told.** All lanes run every time. Never
   dispatch one lane, never tell an expert which metric to look at, never supply a benchmark: the
   expert IS the benchmark authority. Being asked which number to look at is the work this product
   exists to remove.
2. **No hardcoded best-practice detectors.** Experts reason over the evidence, constrained by the
   finding contract. No rule checker decides what is wrong with an account.

**There is no per-account configuration of the analysis.** Nothing tells this engine what a workflow
is for; stage 1 derives it. That is what lets it run against any location whether or not it was built
to the Standard Build, and it is what catches a workflow whose real job is not the job its name
claims.

An account MAY declare its own situation facts in `profiles/accounts/<locationId>.v1.json`: what to
call it, and the caveats that stop an expert reading a recording gap as a business failure. That is
not configuration of the analysis and may never say what a workflow is for. **Those facts must be
written BEFORE the run**, because the briefs are sealed and a caveat added afterwards cannot reach an
expert. The shared profile is a template and must never name one account.
## Preflight (every run)

1. Doctor floor: confirm `~/.grom-factory.json` exists and the target GHL MCP
   server responds to one cheap read (list pipelines). On failure, stop and
   point at `grom-client-factory:doctor`.
2. Resolve the client folder (argument, else cwd) and target location ID
   (argument, else `client-manifest.json`.ghl_location_id, else ask). Confirm
   both with the user before fetching anything.
3. Ask which mode: `capture` (default), `verify`, `harvest`, or explicit
   `weekly`. An omitted mode always means `capture`; never select `weekly`
   implicitly.

## Output convention (all modes)

`<client-folder>/captures/<YYYY-MM-DD>/`
- `raw/` untouched responses. ALWAYS gitignored: ensure the client repo's
  .gitignore contains `captures/**/raw/` before saving anything, and create it
  if missing.
- sanitized JSON copies (same filenames as raw/) via
  `node <skill-dir>/scripts/sanitize_capture.mjs raw/<f>.json <f>.json`
- snapshot markdown per area (shape mirrors the Sub-Account reference/ghl/
  convention): `pipelines.md`, `custom-fields.md`, `custom-values.md`,
  `tags.md`, `calendars.md`, `users.md`, `phone-numbers.md`, `ai-agents.md`,
  `workflows.md` (name, status, trigger, step count per workflow)
- `audit-report.md` the human report for the mode that ran
- `manifest.json` capture metadata: location ID, time, endpoint list, skips

COMMIT GATE: before any git add of a capture, run
`node <skill-dir>/scripts/sanitize_capture.mjs --check <file>` on every JSON
file staged from captures/. Any exit 1 = stop, sanitize, re-check. Raw files
are never staged.


## The credential, before anything else

The internal rail needs a GoHighLevel JWT that **expires every hour** and can only be captured from a
real logged-in browser session. Do NOT reimplement that here.

**Run `uxie-ghl-factory:connect`.** That skill owns the capture, and the same plugin owns the
read-only internal MCP server this engine drives, so the token, the server registration and the
re-authorize path all live in one place. It writes `<project>/.ghl/uxie-ghl-internal-mcp-tok.txt`,
which is the path to hand to `--token-file` below.

Check it BEFORE a run, not during: the adapter preflights `auth_status` and refuses to start, and an
expired credential LATCHES the shared circuit, so the next call on a different tool returns
`CIRCUIT_OPEN`. On `TOKEN_EXPIRED` or `TOKEN_MISSING`, re-run `uxie-ghl-factory:connect` and retry;
the server re-reads the file every call, so nothing needs restarting.

## Setting up an account that has never been audited

ONE command. It reads the account's own `companyId`, `timezone` and name from the location record,
derives everything else from shipped artefacts, and writes the provider config, the vault key, and a
stub for the account's facts.

```
node scripts/init-account.mjs \
  --project ~/.grom-audit-runs/<label> --location <locationId> --label <label> \
  --credential-env <ENV_VAR_HOLDING_THE_PIT_TOKEN> \
  --token-file <path to the internal-rail token file>
```

**Read the timezone from the ACCOUNT, never from the city.** SK Skin is a Melbourne clinic whose
account timezone is Australia/Sydney. Typing the city would move every weekly window boundary and
nothing would complain. That is why this reads it rather than asking.

The cutoff defaults to the most recent Monday 00:00 in that timezone, and the script refuses a cutoff
that has not passed: a week has to close before it can be read.

🔴 **Then fill in `profiles/accounts/<locationId>.v1.json` BEFORE the first run.** The stub is written
with an empty `knownDataCaveats` on purpose. Ask the owner what would make a number mean something
other than what it looks like: who marks appointment outcomes, which calendars are deliberately
two-phase, what is switched off on purpose, whether deposits are taken, where test data lives. The
briefs are sealed, so a caveat added afterwards can never reach an expert, and a missing one becomes
a confident wrong finding. Never invent one.

The shared profile is a TEMPLATE and must never name one account. Caveats in an account file are
added to the shared ones, not substituted for them.

## Mode: weekly (explicit commercial diagnostic)

Invoke the checked-in Task 9 audit CLI explicitly for the governed weekly
path. A public-only or otherwise incomplete evidence run reports
`complete_partial`. Proposed fixes remain local proposal artifacts for approval
and are never executed by this skill.

### The analysis cycle (five stages of expert)

`PRODUCT-SPEC.md` is the authority for what this stage is for. Two rules it
encodes are not negotiable: **the auditor decides what to analyse and is never
told**, and **there are no hardcoded best-practice detectors**. Never dispatch
one lane, never tell an expert which metric to look at, and never supply a
benchmark: the expert IS the benchmark authority.

**There is no per-account configuration anywhere in this cycle.** Nothing tells
the auditor what a workflow is for. Stage 1 derives it, which is what lets this
run against any location whether or not it was built to the Standard Build.

A model call is the only non-deterministic step in the product, so each one sits
between two deterministic commands (see `lib/cycle.mjs` for why the kernel
cannot make them itself). Run `audit briefs` at any point to be told which stage
a run is at and what to dispatch next; the answer is derived from what is on
disk, not from a status somebody wrote down.

1. **`audit run --mode weekly ...`** collects, measures, and writes the three
   lane briefs and the ONE stage-1 prompt under
   `audits/ghl/<location>/private/briefs/<runId>/`.
   Set `internalAudit.emailCopy: true` in the provider config to also read the
   email library, so the per-workflow experts judge the real body of a send step
   that points at a library template instead of only its subject line. It is
   opt-in because it opens a second session and fetches a storage host.
2. **STAGE 1, one expert.** Dispatch a single subagent whose whole instruction is
   `prompt-account-map.md`. It reads the whole account and derives THE MAP: what
   journey this account runs, what each workflow's job actually appears to be,
   which sit on the money path, which are delivery, which look abandoned. Save
   its JSON answer to a file.
3. **`audit map --project <p> --location <l> --run-id <r> --map <file>`**
   validates the map (every workflow covered exactly once, no invented workflow
   or KPI edge) and writes one prompt per object under `reviews/`. EVERY workflow
   and EVERY AI agent, with no gate: an auditor that skips a workflow is not
   auditing the account, and the workflows a gate would skip are the cheapest
   ones in the run. The COUNT comes from the account.
4. **STAGE 2, one expert per object, dispatched in parallel.** Each subagent's
   whole instruction is its `reviews/prompt-*.md`. Add nothing to it. Each sees
   its object WHOLE: configuration, runtime, every message in full, where it sits
   in the account, the KPI edges it should move, and the stage-1 map. Write each
   answer's markdown to the `answerFile` the command named for it.
5. **`audit reviews --project <p> --location <l> --run-id <r>`** collects them,
   records any that never arrived, and writes the three stage-3 lane prompts.
6. **STAGE 3, three account-wide experts, in parallel.** One per
   `prompt-<lane>.md`: the lead journey and its KPIs, the account as one system,
   and every message as ONE STREAM. Each reads the map and all the per-object
   reviews and is told not to repeat them. Write each answer's JSON array to
   `<answers>/<lane>.json`.
7. **STAGE 4, `audit investigate --project <p> --location <l> --run-id <r>
   --findings <answers>`** validates every finding, refuses the malformed ones by
   name, groups the rest into causes on their anchors, ranks them, and writes
   `INVESTIGATION.md`, `BACKLOG.md`, `investigation.json` and one solution
   package per cause under `audits/ghl/<location>/investigations/<runId>/`.

8. **STAGE 5, one expert.** `audit investigate` also wrote
   `prompt-work-order.md` into the investigation folder. Dispatch a single
   subagent with it. It reads every ranked problem and its fix and returns the
   running order: which problems are one job, what has to land first, and which
   fixes pull against each other. It may not re-diagnose anything and the contract
   gives it nowhere to put a new finding.
9. **`audit plan --project <p> --location <l> --run-id <r> --plan <file>`**
   validates it (every problem placed exactly once, no invented ids) and writes
   `PLAN.md`.

The briefs and reviews live under `private/` and quote real message copy, so they
are evidence and never publication material. Solution packages are for human
implementation and approval; nothing in this cycle applies a change.

### Week over week

`audit investigate` records every cause in the account's own ledger and compares
this run against every run before it, so the backlog carries an **Age** column and
each problem in the report says whether it is new or has survived since a named
date. Nothing extra to run: it happens inside step 7.

Identity is derived from the problem, not from what an expert called it: the
mechanism families plus the discriminating anchors. Experts invent fresh ids every
week and `causeId` moves with them, so neither can be the join key.

Two rules it will not break:

- **ABSENT IS NOT FIXED.** A cause that stops appearing is listed under "recorded
  before, absent this week", with the reasons it might have vanished. Nothing in
  this product verifies a fix yet, so nothing claims one.
- **A NEAR MISS IS SHOWN, NEVER MATCHED.** Rename a workflow and the fingerprint
  changes. Rather than loosen identity and risk calling two different problems the
  same, the report states the overlap and lets the reader judge.

A ledger that cannot be read or written never costs the account its report: the
comparison is reported as unavailable, which is a different statement from
"nothing has changed".


## Filing a finished run where the client work lives

A run is PRODUCED in `~/.grom-audit-runs/<label>/`, outside every repo. It is not finished until it
is filed, because a diagnosis nobody can find is a diagnosis nobody acts on.

```
node scripts/archive-run.mjs \
  --project ~/.grom-audit-runs/<label> --location <locationId> --run-id <runId> \
  --into "/path/to/<client folder>" --account "<Client Name>"
```

The layout is FIXED for every account and every week, so an agent can be pointed at the folder and
rely on the shape without being told it. It writes `START-HERE.md` carrying the read order, the
account's caveats, and what that run could not see.

**The order the deliverables are meant to be used**, and the one to state to anything you point at
the folder:

| | |
|---|---|
| `PLAN.md` | the running order. what to do first, what blocks what. START HERE |
| `BACKLOG.md` | the ranked problems in one table. the index |
| `packages/` | one per problem: what to change, how you will know it worked. THE ACTION LIST |
| `reviews/` | one per workflow and per AI agent. **THE REPLACEMENT COPY LIVES HERE**, message by message |
| `INVESTIGATION.md` | the full argument, for when you disagree with a finding |
| `evidence/` | the sealed briefs and every prompt an expert read, so a claim can be traced |

When a package says "rewrite this message", the words are in `reviews/`, not in the package.

**The vault key is deliberately NOT copied.** It is the only thing protecting the raw record of real
people, and filing it beside the data it protects would defeat it.

The folder is dated by the week the run READ, rendered in the ACCOUNT's timezone. A Sydney account's
Monday boundary is the previous day in UTC, so using UTC files a Monday run under Sunday and the
folder names stop agreeing with the evidence inside them.

## Boundaries (inherited + plugin)

- GET only, scoped iframe JWT, one location per session, throttle before every
  fetch, stop on 429/403 (see capture/PROVENANCE.md)
- No auth headers, session tokens, cookies, or CAPI tokens in any committable
  file: the sanitizer is not optional
- Sanitizer coverage boundary: it redacts values under secret-named keys, cookie
  values, and shaped tokens (Bearer, JWT, Meta CAPI) anywhere including inside
  arrays and embedded in longer strings. It does NOT recognize an opaque secret
  with no known shape sitting under a non-secret-named key (e.g. a raw provider
  key pasted into a free-text note or a custom header string). Eyeball each
  sanitized capture for stray secrets before committing; `--check` is a floor,
  not a guarantee
- No em dashes in authored reports; platform naming rules do not apply to
  these internal reports but DO apply if any text is destined for a client
