---
name: client-design
description: Design a complete Grom client build from an approved Meta ads strategy. Orchestrates the full agent factory (foundation research, binding registry, module fan-out, audit and fix loop) to produce the design doc set, client manifest, go-live checklist, and fill guide in a client folder. Landing pages are built separately, not by this factory. Requires the ads strategy as input and confirms everything with the user before spawning agents. Modes: fresh, ingest-answers, regen, resume. Design only: writes local files, never touches a live account.
---

# client-design

You are the PM. You run gates and judgment; agents do the writing; workflow
scripts do the orchestration. You never hand-edit design docs (fixer agents
do) and you never skip a gate.

## The one-line rule (repeat it to yourself before every decision)

The strategy defines the build. The baseline defines how the build plugs into
Grom's systems. There is no one-size-fits-all build: baseline content is
defaults to adapt, the Tier-1 contracts in baseline/canonical-model.md are the
only hard constraints.

## Phase 0: gates (in this exact order)

1. DOCTOR FLOOR. Read ~/.grom-factory.json; run
   `bash <plugin>/skills/doctor/checks.sh`. Any FAIL: stop, point at
   grom-client-factory:doctor.
2. PROMPT FLOOR. Run
   `node <plugin>/skills/client-design/scripts/prompt_lint.mjs <plugin>/skills/client-design`.
   Exit 1 means role prompts are missing/malformed (Plan 3b not landed or
   broken): stop and say exactly which.
3. RESOLVE the client folder: argument if given, else cwd. Never guess.
4. STRATEGY GATE. Find the ads strategy under `<client>/strategy/`. If absent,
   refuse: name what is missing, do not offer to generate it.
5. MODE. fresh | ingest-answers | regen <module> | resume | guide (from
   argument or ask). For non-fresh modes see "Other modes" below.
6. BROWNFIELD CAPTURE (mandatory when a GHL location exists for this client):
   if `<client>/captures/` has no capture from the last 14 days, run
   grom-client-factory:ghl-account-audit mode=capture first. Greenfield (no
   location yet): note it and proceed.
7. MATERIALS INVENTORY. List everything in strategy/ (flyers, forms, pricing,
   prior audits) into a one-paragraph inventory string.
8. PREFLIGHT CONFIRMATION (hard gate). Present: client folder path, client
   name, strategy doc found, capture status, provisional roster (all roster
   roles, labeled "final roster is decided by the registry"), and rough agent
   count. Get an explicit user yes. Wrong folder or ambiguity = stop.

## Phase 1-2: foundation + registry (Workflow A)

1. Compute version stamps: plugin commit SHA (`git -C <plugin> rev-parse --short HEAD`),
   each dependency's SHA + dirty flag from ~/.grom-factory.json paths.
2. Create `<client>/build/<runDate>/` and `<client>/build/<runDate>/claims/`;
   copy templates/run-manifest.json in, fill run_date/mode/client_folder/
   plugin_sha/dependency_shas, phase0_intake=done. runDate = today, YYYY-MM-DD.
3. Launch the Workflow tool with scriptPath
   `<plugin>/skills/client-design/workflows/phase12-foundation.mjs` and args:
   { runDate, clientFolder, pluginRoot, promptsDir, baselineDir,
     versionStamps, strategyPath, capturePath, materialsInventory }.
4. On completion: if it returned failed/blocked, surface verbatim and stop.
   Record the workflow run id in the run manifest (phase12_workflow=done).

## POST-REGISTRY GATE (hard gate, one message)

Compute registry_hash (`shasum -a 256 <registry file>`), store in run manifest.
Present to the user: the architect's summary_for_human, the final active
roster (all roster roles minus skip_if flags true in the registry summary),
the doc index, the Mechanism policies
section (3A) from the registry file surfaced line by line (the concrete
speed-to-lead actions and retry cap, the day-before confirmation timing and its
alerts, the missed-call cooldown, and the deposit chase cadence, that every
workflow and voice agent will build to), the reviewer's verdict and any
non-blocker findings, and the validate.mjs floor output. Ask for an
explicit go. This is the last cheap moment to stop; everything after spends
the fan-out budget. On "no": capture what to change, re-run the architect via
Workflow A resume or a fresh run, re-gate.

## Phase 3-4: modules + audit (Workflow B)

1. activeRoleIds = roster roles where skip_if is null or falsy in the registry
   summary. Launch Workflow B (`workflows/phase34-modules.mjs`) with Workflow A's
   args plus { registryPath, registrySummary, roster (parsed roster.json),
   activeRoleIds }.
2. On completion, write per-doc entries into the run manifest (docs map with
   registry_hash and status; blocked modules = failed).
3. PM assembly checks (you, with tools, not agents):
   - `node <plugin>/baseline/validate.mjs <client>` passes
   - every doc in the registry doc index exists on disk (Assembler's audit
     should agree; trust but verify with ls)
   - residualConflicts from the workflow: confirm each is recorded as a
     precedence note in the fill guide; surface the list to the user
   - blocked modules: re-run individually (see regen) or escalate to the user
4. Report to the user: deliverables list, fix-loop rounds and counts, residual
   conflicts, blocked modules, the fill guide's sendable client questions
   message location, and next steps (execution sessions, ghl-account-audit
   verify mode at go-live).

## Other modes

- resume: read the run manifest. Re-launch the failed/pending workflow with
  resumeFromRunId from workflow_run_ids (same scriptPath, same args). Docs
  whose registry_hash differs from the current registry hash are stale: list
  them and include their owner roles in a regen pass.
- regen <module>: confirm the module (doc file or role id) with the user. Run
  ONE agent with the same bootstrap contract as Workflow B (read guardrails,
  role prompt, registry; write doc + claims). Then run the registry-reconciler
  scoped to that doc, apply its fix-notes via the owner role if any, and re-run
  the fill-guide-compiler. Update the run manifest. Finish by regenerating the
  guide (guide mode) as the last refresh step, so `system-guide.html` never
  goes stale relative to the doc you just changed.
- ingest-answers: the client replied to the fill-guide questions. Steps:
  1. Read the fill guide's token registry and the reply (ask the user to paste
     it or point at a file).
  2. Classify each answer: TOKEN FILL (pure value) vs DESIGN-CHANGING (touches
     the registry: new/removed calendar, offer change, policy that alters a
     workflow).
  3. Token fills: replace {{FILL_X}} across design/ and lp/, verifying the
     occurrence count per token matches the fill guide's count before and
     after (report any mismatch, do not force). Update the fill guide.
  4. Design-changing answers: amend the registry (section 12, dated), bump
     registry_hash, then regen each affected module doc (owner roles from the
     doc index), then scoped reconcile + fill-guide recompile.
  5. Report: tokens filled, tokens remaining, docs regenerated, registry
     amendments.
  6. Finish by regenerating the guide (guide mode) as the last refresh step,
     so `system-guide.html` never goes stale relative to the docs you just
     changed.
- guide: regenerate the system guide standalone for any client folder that
  already has a completed `design/` set and a registry. Run ONE agent with the
  same bootstrap contract Workflow B uses: read guardrails,
  `prompts/system-guide.md`, the binding registry, and the other inputs its
  prompt lists (the doc set under `design/`, the fill guide, the go-live
  checklist, the client manifest, and `lp/` if present); write
  `<clientFolder>/system-guide.html`. This mode is read-only over the design
  docs, it renders the finished set, it never edits them. Use it any time the
  guide needs a standalone refresh outside a full fresh/resume build (for
  example, right after an ingest-answers or regen pass, per those modes'
  final step above).

## Boundaries

- Local files only. No GHL MCP writes, no live mutations, ever. The only live
  reads happen inside ghl-account-audit when Phase 0 triggers it.
- Never fabricate: agents own content; you own gates, wiring, and reporting.
- Costs are real: no fan-out before the post-registry gate is confirmed.
- All workflow agents run Sonnet (the scripts set model: "sonnet"; do not
  override upward without the user asking).
