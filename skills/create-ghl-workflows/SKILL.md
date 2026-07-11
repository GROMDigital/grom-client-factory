---
name: create-ghl-workflows
description: Create a client's GHL workflows as DRAFTS from its already-designed build (the binding registry's workflow list plus the journey-and-workflows doc), by conducting the uxie-ghl-factory peer plugin's create-ghl-workflow engine one workflow at a time. This skill creates GHL workflows as DRAFTS ONLY and NEVER publishes: every build runs without --publish, and a human reviews each draft in the GHL builder UI and publishes it there. Requires a completed registry, journey-and-workflows doc, and client-manifest.json for the client; requires an explicit mutation-gate yes naming the target location and the exact numbered workflow list before any write happens. Verifies each draft read-only immediately after creation, logs a per-workflow outcome table, and closes by pointing at grom-client-factory:ghl-account-audit verify mode to confirm the published state once the human has published in the UI.
---

# create-ghl-workflows

You are the conductor. You resolve which client, which workflows, and in
what order; you run the gates and the verify loop; the uxie-ghl-factory
engine does the actual compiling and posting. You never hand-assemble a
GHL API call yourself, and you never pass `--publish`.

## The one-line rule (repeat it to yourself before every decision)

This skill creates GHL workflows as DRAFTS ONLY and NEVER publishes. Every
build runs `node scripts/build.mjs <ir.json> <LOC>` with no `--publish`
flag, ever. A human reviews each draft in the GHL builder UI and publishes
it there; that publish click IS the mutation-approval gate for this whole
system. Nothing this skill does sends a message to a real lead or goes
live.

## Phase 0: gates (in this exact order)

1. DOCTOR FLOOR. Read `~/.grom-factory.json`; run
   `bash <plugin>/skills/doctor/checks.sh`. This includes the
   `peer:uxie-ghl-factory` check (the engine's clone must be configured,
   cloned, and current). Any FAIL: stop, point at `grom-client-factory:doctor`.
2. RESOLVE the client folder: argument if given, else cwd. Never guess.
3. REGISTRY GATE. Find the most recent `<client>/build/<YYYY-MM-DD>/`
   directory whose `run-manifest.json` shows a completed client-design run
   (`phase_status.pm_assembly` done). Its `architecture-final.md` is the
   binding registry for this build. If no completed run exists, refuse and
   name what is missing; do not offer to design it (that is
   `grom-client-factory:client-design`'s job, not this skill's).
   - From the registry's section 11 (doc index), find the row with owner
     role `workflow-designer` and use its exact filename(s) under
     `design/` as the journey-and-workflows doc. It may be one document or
     several companion files per the doc index; read all of them.
   - Require `<client>/client-manifest.json` at the client-folder root.
   - Missing registry, journey-and-workflows doc, or client-manifest.json:
     stop and name exactly which is absent.
4. IDS-READY GATE. Read `client-manifest.json`. The workflow specs
   reference pipelines, stages, calendars, and custom fields by name, and
   the engine resolves those names against the LIVE account at build time.
   If `ids_harvested` is not `true` in the manifest, the live account has
   not had its IDs harvested yet, which usually means the account itself
   (pipeline, stages, fields, calendars) has not been built out to match
   the design. Recommend running `grom-client-factory:ghl-account-audit`
   in `harvest` mode first, and STOP. Do not attempt to build workflows
   against an account whose IDs were never confirmed live; the engine will
   abort per-workflow anyway, but catching it here saves the run.
5. WRITE-RAILS + AUTH. This skill issues writes against GHL's internal
   builder API. Before the first write in this workspace, both gates in
   `${ghl-plugin}/plugins/uxie-ghl-factory/docs/write-rails.md` apply in
   full (Gate 1: owned-account check, every session; Gate 2: TOS
   disclosure, once per workspace, recorded at `.ghl/tos-acknowledged`).
   Auth capture (JWT, header format, token lifetime) is
   `${ghl-plugin}/plugins/uxie-ghl-factory/docs/auth-jwt-capture.md`. Read
   both fresh; do not paraphrase from memory or from an earlier session's
   notes. `${ghl-plugin}` is the path in `~/.grom-factory.json`'s
   `deps["ghl-plugin"].path`.
6. LOCATION + IDENTITY. Resolve the target `locationId` from
   `client-manifest.json`'s `ghl_location_id`. Confirm the client's name.
   Both feed the mutation gate in Phase 1; if either is missing, stop.

## Phase 1: build the worklist and gate the mutation

1. Take the registry's section 3 workflow list (the LAW numbering and
   exact names) in number order. Ask the user if any workflow numbers
   should be excluded from this run (default: none excluded, full list).
2. Compute the worklist: full registry list minus exclusions, still in
   number order.

## MUTATION GATE (hard stop, explicit yes required)

Present, in one message, before any write:

- Target location ID (from client-manifest.json).
- Client name.
- The exact numbered worklist about to be created, e.g.:
  1. 01 New Lead Response
  2. 02 Appointment Confirmation
  3. 03 No-Show Follow-Up
  ... (every workflow in the worklist, in order, spelled exactly as the
  registry spells it)
- This sentence, unchanged: "This skill creates GHL workflows as DRAFTS
  ONLY and NEVER publishes. Every build runs without --publish. You will
  review each draft in the GHL workflow builder and publish it yourself
  when you're ready; nothing goes live from this run."
- An explicit ask for a yes. A bare continuation of the conversation does
  not count as consent; the user must affirmatively say yes to this
  specific list.

If the worklist changes for ANY reason after this point (a user exclusion
added mid-run, a workflow the engine could not resolve and had to be
dropped, a doc-index correction), stop and re-present this gate in full
before continuing. A stale gate does not cover a changed list.

## Phase 2: per-workflow build loop (one at a time, registry number order)

For each workflow in the gated worklist, in order:

1. READ THE ENGINE'S OWN DOCS FRESH. Every run, not from memory (the
   engine is actively developed and its input format changes): read
   `${ghl-plugin}/plugins/uxie-ghl-factory/skills/create-ghl-workflow/SKILL.md`
   in full, plus `references/build-recipe.md`, `references/step-shapes.md`,
   and `engine/COVERAGE.md` for current step/trigger coverage. Trust what
   these say over any summary of them, including this one.
2. TRANSLATE the spec into the engine's IR. Source material: the
   journey-and-workflows doc's per-workflow card for this workflow (Name,
   Trigger(s), Enrollment guards, Steps, Exit conditions, Tags/fields
   written, Alerts embedded by N-id), cross-referenced against the
   pipeline-and-stages doc (stage names and the one-owner-per-transition
   map), the alert-catalog doc (N-id copy, severity, recipients), and the
   calendars-booking-payments doc (calendar and payment-product names) as
   the spec calls for them.
   - Registry canonical names are LAW: workflow name, tags, custom field
     keys, calendar names, payment product names, and N-ids get copied
     exactly as spelled in the registry and the journey doc. Never
     respell, never synonymize, never invent a name the docs do not use.
   - Author the IR with human names (the engine's resolver turns them into
     account IDs); do not hand-write UUIDs.
   - Write the IR file to
     `<client>/build/<runDate>/workflow-ir/<NN-slug>.json` (runDate =
     today, the date of this creation session; create the directory if
     absent) so each IR is inspectable and reusable on retry.
3. INVOKE the engine from its own skill directory:
   ```
   node scripts/build.mjs <ir.json> <LOC>
   ```
   NEVER add `--publish`. Never add `--ignore-unresolved` unless the user
   has explicitly asked to force a build past an unresolved dependency
   (rare, and it means the resulting draft references something that does
   not exist yet: say so plainly if this happens).
4. READ THE BUILD REPORT before doing anything else.
   - `ABORTED: Missing account dependencies …`: stop this workflow, do
     not retry with guesses. Name the missing dependency to the user (a
     pipeline, stage, calendar, or user that does not exist live yet).
     Log it as `failed` and move on only if the user says to skip it.
   - `round-trip: N clean` with `ISSUES: …`: a shape problem the server
     silently dropped fields on. Do not call this workflow done; log it as
     `failed` with the issue text and surface it.
   - `UNRESOLVED (built anyway): …`: only appears if
     `--ignore-unresolved` was used; treat as `failed` unless the user
     explicitly accepted the unresolved reference.
   - A 401 mid-run: the JWT expired (~1 hour lifetime). Stop immediately,
     do not retry-loop. Re-capture per `auth-jwt-capture.md`, then resume
     from the next unlogged workflow in the worklist (the log from step 5
     below is the checkpoint; do not rebuild anything already logged
     `created-draft`).

## Phase 3: verify each draft before moving on

Immediately after a clean build report, confirm the draft independently
and read-only, BEFORE starting the next workflow in the worklist:

- Use the engine's own `get-ghl-workflow-json` skill (or the equivalent
  audit-capture technique) to GET the just-created workflow's config and
  trigger JSON.
- Confirm: the workflow exists at the reported id, its name matches the
  registry's exact spelling, its status is `draft` (never `published`),
  and its trigger type matches the spec.
- This is a read-only confirmation call, not a second write. It uses the
  same Bearer JWT, GET only.

Log the outcome (created-draft / failed / skipped, with a one-line reason
for failed/skipped) to
`<client>/build/<runDate>/workflow-creation-log.md`, appending one row per
workflow as you go so the file is a live checkpoint, not a final summary
written at the end.

## Phase 4: close

Once every workflow in the worklist has been attempted:

1. Report the outcome table (from the log): workflow number, name, status,
   GHL builder URL for each created-draft (the build report prints one per
   workflow), and the reason for any failed/skipped.
2. Tell the human explicitly: review each draft in the GHL workflow
   builder, publish there when satisfied. This skill will not do it for
   you and cannot be asked to.
3. Once published, run `grom-client-factory:ghl-account-audit` in
   `verify` mode. That mode already checks live PUBLISHED status against
   the registry and journey doc, so the loop closes without this skill
   ever touching the publish endpoint.

## Boundaries

- This skill creates GHL workflows as DRAFTS ONLY and NEVER publishes.
  Every build runs without `--publish`. A human reviews each draft in the
  GHL builder UI and publishes it there; that publish click is the
  mutation-approval gate.
- One location (one client) per session. Do not switch clients mid-run
  without a fresh Phase 0.
- Stop on ANY engine error (abort, round-trip issue, 401, unresolved
  dependency) rather than improvising a raw API call to work around it.
  If the engine cannot build it, the fix is in the design docs or the
  engine, not a hand-rolled POST.
- Never write Grom client data (registry contents, journey specs, client
  names, IR files, logs) into the peer plugin's repo (`ghl-plugin`). The
  dependency is one-way: this skill reads the engine's code and docs, it
  never writes into that clone. All client artifacts stay under
  `<client>/build/<runDate>/`.
- No em dashes anywhere.
- This skill file is internal tooling documentation; the platform-naming
  rule ("the Grom system," never "GoHighLevel") applies to client-visible
  copy this skill's engine calls might generate (e.g. inline email
  templates), not to this document itself.
