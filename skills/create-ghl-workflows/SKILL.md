---
name: create-ghl-workflows
description: Create a client's GHL workflows as DRAFTS from its already-designed build (binding registry workflow list plus journey-and-workflows doc), delegating to the uxie-ghl-factory create-ghl-workflow engine one workflow at a time. Creates DRAFTS ONLY and never publishes. Requires an explicit mutation-gate yes naming the target location and the exact numbered workflow list before any write. Resolves prerequisites, orders by dependency, and verifies each draft read-only.
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

## Engine resolution (which uxie-ghl-factory you drive)

The engine lives at https://github.com/uxieee/uxie-ghl-factory and is
installable as a Claude Code plugin. Resolve it in this order; the first
source that resolves wins:

1. THE INSTALLED PLUGIN. If the uxie-ghl-factory plugin is installed and
   its skills are visible in this session, use them. Prefer
   `uxie-ghl-factory:create-ghl-workflow` (or
   `uxie-ghl-factory:build-workflow`) as the build engine. Before
   constructing any spec or IR, also read
   `uxie-ghl-factory:ghl-workflow-specialist` and
   `uxie-ghl-factory:ghl-orientation` for the current trigger and action
   knowledge (the supported node types and known anti-patterns).
2. THE CONFIGURED LOCAL CLONE. Otherwise, the clone at
   `~/.grom-factory.json`'s `deps["ghl-plugin"].path`; the engine's docs
   and skills live under `plugins/uxie-ghl-factory/` inside that clone.
3. FAIL. If neither resolves, stop and give the install instructions:
   `/plugin marketplace add uxieee/uxie-ghl-factory`, then install the
   plugin it offers (repo: https://github.com/uxieee/uxie-ghl-factory),
   or register a local clone in `~/.grom-factory.json`.

Whichever source wins, the read-the-engine-docs-fresh rule holds in
full: read the engine's own current SKILL.md and reference docs from the
winning source every run, never from memory. Below, "the resolved
engine" means that winning source.

## Phase 0: gates (in this exact order)

1. DOCTOR FLOOR. Read `~/.grom-factory.json`; run
   `bash <plugin>/skills/doctor/checks.sh`. This includes the
   `peer:uxie-ghl-factory` check, which passes when the engine plugin is
   installed OR its clone is configured, cloned, and current; the
   agent-level truth is whether this session can see the
   uxie-ghl-factory skills (see "Engine resolution" above). Any FAIL:
   stop, point at `grom-client-factory:doctor`.
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
   the resolved engine's `docs/write-rails.md` apply in full (Gate 1:
   owned-account check, every session; Gate 2: TOS disclosure, once per
   workspace, recorded at `.ghl/tos-acknowledged`). Auth capture (JWT,
   header format, token lifetime) is the resolved engine's
   `docs/auth-jwt-capture.md`. In the installed plugin these docs sit at
   the plugin's install root; in a clone they sit under
   `<clone>/plugins/uxie-ghl-factory/docs/`. Read both fresh; do not
   paraphrase from memory or from an earlier session's notes.
6. LOCATION + IDENTITY. Resolve the target `locationId` from
   `client-manifest.json`'s `ghl_location_id`. Confirm the client's name.
   Both feed the mutation gate in Phase 1; if either is missing, stop.

## Phase 1: build the worklist, resolve prerequisites, order it

1. Take the registry's section 3 workflow list (the LAW numbering and
   exact names) in number order. Ask the user if any workflow numbers
   should be excluded from this run (default: none excluded, full list).
2. Compute the candidate worklist: full registry list minus exclusions.
3. PREREQUISITE RESOLUTION (before the mutation gate, always). Parse
   every workflow spec in the candidate worklist (the journey doc's
   per-workflow card plus its registry row) and extract every object it
   references:
   - custom fields (by exact key), custom values, tags, calendars, and
     payment products;
   - AI agents (Conversation AI or Voice AI) referenced by any step;
   - OTHER WORKFLOWS: every triggerWorkflow action, every Remove From
     Workflow step, and every goal reference that names another
     workflow.
   Build a dependency table: one row per worklist workflow listing its
   non-workflow prerequisites and the other workflows it references.
4. VERIFY every non-workflow prerequisite EXISTS LIVE. Check the
   harvested `client-manifest.json` first; for anything the manifest
   lacks, make a read-only MCP call against the target location. Any
   missing prerequisite marks every workflow that needs it BLOCKED, with
   the exact missing object named (for example "BLOCKED: calendar
   'Consult Calendar' not found live"). Say it explicitly and treat it as
   hard: an AI agent referenced by any workflow step MUST exist in the
   account before that workflow is drafted; a missing agent BLOCKs the
   workflow exactly like a missing calendar or field. BLOCKED workflows
   are excluded from the buildable worklist and presented as excluded at
   the mutation gate; the user can approve building the rest.
5. CREATION ORDER. Topologically order the buildable worklist so that a
   workflow is drafted before any workflow that references it. Where the
   registry's numbering already satisfies the dependencies, keep number
   order; break ties by number. Cycles (A references B and B references
   A) are expected and legal in GHL: they cannot be ordered away, so
   order the members of a cycle by number and resolve their mutual
   references in pass 2 (Phase 4).
6. OPEN THE CREATION LOG. Start
   `<client>/build/<runDate>/workflow-creation-log.md` with a dependency
   section: the dependency table from step 3, every BLOCKED workflow with
   its exact missing prerequisite, and the chosen creation order with a
   one-line why (number order kept, or which dependency forced a
   deviation). Pass-2 wiring actions are appended to this section in
   Phase 4.

## MUTATION GATE (hard stop, explicit yes required)

Present, in one message, before any write:

- Target location ID (from client-manifest.json).
- Client name.
- The exact numbered worklist about to be created, in creation order,
  e.g.:
  1. 01 New Lead Response
  2. 02 Appointment Confirmation
  3. 03 No-Show Follow-Up
  ... (every buildable workflow, in the Phase 1 creation order, spelled
  exactly as the registry spells it; note where and why the order
  deviates from registry number order)
- Every BLOCKED workflow, presented as EXCLUDED from this run, each with
  its exact missing prerequisite named. A yes to this gate approves
  building the non-blocked list only; a BLOCKED workflow enters a later
  run only after its prerequisite exists live and this gate is
  re-presented.
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

## Phase 2: pass 1 build loop (one at a time, in creation order)

For each workflow in the gated worklist, in the Phase 1 creation order:

1. READ THE ENGINE'S OWN DOCS FRESH. Every run, not from memory (the
   engine is actively developed and its input format changes): read the
   resolved engine's `create-ghl-workflow` SKILL.md in full (the
   installed plugin's `uxie-ghl-factory:create-ghl-workflow` skill, or
   `<clone>/plugins/uxie-ghl-factory/skills/create-ghl-workflow/SKILL.md`),
   plus every reference doc it points to (its `references/` set,
   currently build-recipe.md, step-shapes.md, and discovery.md) and whatever
   source it names for the current step and trigger coverage (the supported
   node types). Do not assume a fixed filename for that coverage source, the
   engine moves it; follow the SKILL.md's own current pointer. Trust what
   these say over any summary of them, including this one. When the
   installed plugin won resolution, also lean on its
   `ghl-workflow-specialist` and `ghl-orientation` skills for trigger and
   action knowledge before translating specs.
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
   - PASS-1 CROSS-WIRING RULE. A step that references another workflow
     (a triggerWorkflow action, a Remove From Workflow step, or a goal
     naming another workflow) is wired in pass 1 ONLY if the engine
     supports referencing an already-created workflow by ID at creation
     time AND the target's live ID is already in the build map. Otherwise
     leave that step out of the pass-1 IR as a documented placeholder
     (the engine cannot point at a workflow ID that does not exist yet):
     record in the IR file and in the creation log exactly which step is
     deferred and which workflow it must point at. Genuinely circular
     pairs always defer at least one side to pass 2.
3. INVOKE the engine from the resolved engine's `create-ghl-workflow`
   skill directory (installed plugin or clone):
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
written at the end. Each created-draft row also records the draft's LIVE
WORKFLOW ID and any deferred cross-workflow steps: these rows are the
BUILD MAP (registry number, exact name, live workflow ID) that pass 2
wires from, so an unrecorded ID means pass 2 cannot wire it.

## Phase 4: pass 2, cross-wire the workflow references

Runs once, after every workflow in the gated worklist has been attempted
in pass 1 and the build map holds a live ID for every created draft.

1. For each draft with deferred cross-workflow steps (per the pass-1
   placeholder records in the creation log), revisit it via the engine
   and wire each deferred step to the live workflow ID the build map
   holds for its target. If the engine supports referencing by ID at
   creation time, most references were already wired in pass 1 and this
   pass touches only the genuinely circular ones.
2. If a deferred step's target has no live ID in the build map (it
   failed or was skipped in pass 1), do NOT guess or improvise an ID:
   leave the step unwired, log it as `unwired` with the missing target
   named, and surface it plainly in the close report.
3. READBACK-VERIFY. After wiring, GET each touched draft's config
   read-only (same technique as Phase 3) and confirm every
   cross-workflow step now points at the intended live ID and the draft
   is still `draft`. A missing or wrong reference is logged as failed
   wiring and surfaced, never silently accepted.
4. Append every pass-2 wiring action (workflow, step, target live ID,
   readback verified yes/no) to the creation log's dependency section.

## Phase 5: close

Once pass 1 and pass 2 are both complete:

1. Report the outcome table (from the log): workflow number, name, status,
   GHL builder URL for each created-draft (the build report prints one per
   workflow), the reason for any failed/skipped, and any unwired
   cross-references or BLOCKED workflows with their missing
   prerequisites.
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
- Prerequisites are verified, never assumed. A workflow whose spec
  references a field, tag, custom value, calendar, payment product, AI
  agent, or workflow that does not exist live (and is not created by this
  run) is BLOCKED and excluded at the gate, not built on faith.
- Cross-workflow references are wired only from the build map's recorded
  live IDs and readback-verified; never point a step at a guessed or
  hand-typed workflow ID.
- Stop on ANY engine error (abort, round-trip issue, 401, unresolved
  dependency) rather than improvising a raw API call to work around it.
  If the engine cannot build it, the fix is in the design docs or the
  engine, not a hand-rolled POST.
- Never write Grom client data (registry contents, journey specs, client
  names, IR files, logs) into the peer plugin, whether it resolved as an
  installed plugin or as the `ghl-plugin` clone. The dependency is
  one-way: this skill reads the engine's code and docs, it never writes
  into that install or clone. All client artifacts stay under
  `<client>/build/<runDate>/`.
- No em dashes anywhere.
- This skill file is internal tooling documentation; the platform-naming
  rule ("the Grom system," never "GoHighLevel") applies to client-visible
  copy this skill's engine calls might generate (e.g. inline email
  templates), not to this document itself.
