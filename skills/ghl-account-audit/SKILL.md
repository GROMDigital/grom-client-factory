---
name: ghl-account-audit
description: Read-only live-state capture and audit of one GoHighLevel sub-account for the Grom client factory. Use for pre-build capture of a new or brownfield client sub-account, post-build verification of a built account against its design docs, or harvesting live IDs into client-manifest.json. Combines the vendored workflow-JSON capture engine (browser JWT, throttled, GET-only) with a full MCP sweep (pipelines, fields, values, tags, calendars, users, phone numbers, AI agents). Never mutates the account. Sanitizes every capture before it can be committed.
---

# ghl-account-audit

READ-ONLY. This skill never creates, updates, or deletes anything in GHL. If a
finding needs fixing, it goes in the report for a human or a mutating skill.

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

## The sweep (modes capture + harvest)

MCP half (GET-equivalent MCP actions only), per area: pipelines + stages,
custom fields, custom values, tags, calendars, users, phone numbers,
conversation AI agents (and voice config where exposed). Save each raw
response under raw/, sanitized copy beside it, and write the area's snapshot
markdown with IDs in backticks so they are greppable.

Workflow-JSON half: follow `capture/capture-runbook.md` verbatim (browser JWT
from the builder iframe, `Authorization: Bearer`, GET only,
`python3 capture/throttle.py wait` before EVERY internal fetch, stop on
429/403). Default scope: workflow list + per-workflow config and trigger JSON
for workflows the user names, or all ACTIVE workflows if asked for a full
sweep. Validate each capture directory with
`python3 capture/validate_workflow_capture.py <dir>` before reporting.

## Mode: capture (pre-build; MANDATORY before client-design on any existing location)

Run the sweep, then write `audit-report.md`:
- Inventory: counts per area, active vs draft workflows, snapshot-stock vs
  custom-looking objects (name heuristics: stock snapshot names, unnumbered
  workflows, duplicate-looking fields)
- Collision surface: existing custom-field keys, tag spellings, calendar
  names, pipeline names a new design must not collide with
- A DISPOSITION INPUT table for the Systems Architect: every existing
  workflow/pipeline/field with a suggested keep / rename / retire / archive
  and a one-line reason. The architect decides; this table is input, not
  verdict.

## Mode: verify (post-build)

Inputs: the design doc set + registry + `client-manifest.json` + a fresh sweep.
Checks, in order:
1. `node <plugin-root>/baseline/validate.mjs <client-folder>` passes (mechanical floor)
2. Every workflow in the registry's workflow list exists live, is PUBLISHED,
   and its trigger type matches the spec; embedded notification steps exist in
   the workflows the specs say (spot-check via captured workflow JSON)
3. Every stage in the registry's stage map exists live; IDs in the manifest
   match live IDs
4. Calendars, payment product names, AI agents present and named exactly as
   the registry declares
5. `node <skill-dir>/scripts/golive_check.mjs <client-folder>/client-manifest.json`
   passes (all execution-discovered fields filled, ids_harvested true)
Report: `audit-report.md` with PASS/FAIL per check, every failure naming the
doc section it contradicts. Any FAIL = the account is not go-live ready.

## Mode: harvest (manifest completion)

From the fresh sweep, fill `client-manifest.json`:
- `ghl_location_id`, `pipeline_id`, stage UUIDs for `stage_map` (replace
  design-time stage-name keys with live IDs, preserving the canonical-step
  values), `calendar_ids`, AI agent IDs, phone number if present, PIT vault
  secret NAME if the operator provides it (never the token)
- Set `ids_harvested: true` only when every `harvest`-lifecycle field is
  filled; report what remains otherwise
- Never invent an ID: anything not found live stays null and is listed in the
  report
Then run `golive_check.mjs` and include its output in the report.

## Mode: weekly (explicit commercial diagnostic)

Invoke the checked-in Task 9 audit CLI explicitly for the governed weekly
path. A public-only or otherwise incomplete evidence run reports
`complete_partial`. Proposed fixes remain local proposal artifacts for approval
and are never executed by this skill.

### The analysis cycle (four stages of expert)

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
   or KPI edge) and writes one prompt per object under `reviews/`. The COUNT
   comes from the account: roughly fourteen workflows plus every AI agent on a
   Grom-sized location, fewer on a smaller one.
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

The briefs and reviews live under `private/` and quote real message copy, so they
are evidence and never publication material. Solution packages are for human
implementation and approval; nothing in this cycle applies a change.

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
