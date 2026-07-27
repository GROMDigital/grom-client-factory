# Baseline Changelog

Newest first. One line per change: date, what changed, which client's
divergence log motivated it.

- 2026-07-28: **guardrail 2 rescoped to what it is actually for.** It read "no em
  dashes anywhere, in any file, internal or client-visible" and `validate.mjs`
  enforced it on every scanned file. Xander's correction: the rule exists so
  customer-facing writing does not read as machine-written, and so the live AI
  agents never emit one. It was never a house style for internal notes. It now
  covers anything a lead, caller or client can see, plus the instruction text
  written for Conversation AI and Voice AI agents. Internal analysis prose is
  exempt.
  `validate.mjs` gains `isCustomerFacing()`: everything under `lp/`, plus design
  docs whose basename matches brand-voice, nurture, longform, conversation-ai,
  voice-ai, journey-and-workflows, landing-page or system-guide. `build/` and
  `claims/` are exempt. Copy sits inline with the designer's own reasoning in
  the copy-bearing docs with no marker separating the two, so those files are
  checked whole; over-policing inside a copy doc is the safe side to be wrong
  on. Coverage report now names how many customer-facing files were checked.
  Evidence this mattered: on the 2026-07-27 measurement run the new conformance
  pass flagged two em dashes in `business-and-offer-brief.md`, an internal
  research brief, and a fixer agent was spent rewriting prose no client will
  ever read. The runtime half of the rule was already sound and is untouched:
  Francesca's live `11-conversation-ai-primary.md` carries "no em dashes" inside
  the agent's own personality rules, and the conversation-ai, voice-ai,
  nurture-copywriter and ica-brand-voice prompts all still require it.
  Also rescoped the two prompt lines that told agents to self-police internally
  (`voice-ai.md`, `systems-architect.md`) and the conformance sentence in both
  workflow bootstraps. Baseline suite 12 tests to 13: the new one asserts an em
  dash in a research brief is NOT a violation while the same fixture's nurture
  copy doc still fails.

- 2026-07-27: project 3 part 3A, cost and wall clock, FIRST PASS. Measured before
  changing anything, and the measurement contradicted the spec, so the spec's
  ranked fixes were not the ones implemented. Real baseline, phases 1-2 of the
  Better By Ati dry run: **64 model calls, 5,772,782 cache-read, 655,630
  cache-write, 83,852 output tokens, $3.68 at Sonnet intro rates, 15m 33s**,
  now recorded in that run's manifest under `cost`.
  🔴 **The spec's numbers were transcript BYTES and they were roughly 2.4x too
  high.** The transcript writes one record per content block and repeats the
  call's usage on each, so counting records counted 151 "turns" where there were
  64 calls. `run_cost.mjs` deduplicates by `requestId`, keeping the record with
  the largest `output_tokens` because usage accumulates as a response streams.
  Any future cost claim about this factory is made in measured tokens from that
  script or it is not made.
  What the measurement actually showed, versus what the spec predicted:
  1. **Per-role Tier-1 scoping, the spec's fix #1, measures under 4%.** Agents
     already self-scope. `client-researcher` read only `guardrails.md` (741
     tokens); only the journey and systems architects read the full contract set.
     The premise of "1,600 lines times 23 agents" is not what happens.
  2. **~39,500 tokens per agent of fixed startup**, proven on the interrupted
     `registry-reviewer`: one call, zero tool uses, 39,567 cache-write. It is the
     harness prompt plus a 29,992-byte listing of ~200 installed skills plus a
     13,660-byte deferred MCP tool-name list. Re-read every call, that is ~40% of
     all cache-read and ~26% of run cost, but only about a quarter of it is ours
     to cut, and MCP servers are the *wrong* target: all five disabled on
     2026-07-27 were worth 2,354 bytes between them, because deferred tools load
     names only, not schemas. Skills are the lever, not MCP.
  3. **The real waste was agents checking their own homework.** Every agent runs
     load, then write-in-one-shot, then a long tail of mechanical self-checks at
     its LARGEST context: 10 of the architect's 20 calls, 7 of 15 for
     `ica-brand-voice`, **25 of 64 across phases 1-2**, spent grepping for em
     dashes, counting fill tokens, and hand-validating sidecar JSON. The
     write step was already efficient and was left alone.
  Changes, none of which touch a Tier-1 contract:
  - `skills/client-design/scripts/run_cost.mjs` NEW. Reads the harness `usage`
    blocks, dedups by `requestId`, reports per-agent calls/read/write/output/peak
    plus wall clock and cost at both Sonnet rate cards, and writes a `cost` block
    into the run manifest. Wired into SKILL.md's PM assembly checks.
  - `validate.mjs` gains `--conformance` (text and claims passes only, so it can
    run mid-build before a manifest exists) and a **claims sidecar pass**:
    `CLAIMS_INVALID_JSON`, `CLAIMS_TOKEN_UNDECLARED`, `CLAIMS_TOKEN_PHANTOM`,
    `CLAIMS_SIDECAR_MISSING`, `CLAIMS_ORPHAN_SIDECAR`. Sidecars are written both
    braced and bare depending on the agent, so both normalise before comparison.
    Coverage now also says when 0 sidecars were inspected.
  - Both workflow scripts run conformance once per wave and route failures to a
    small fixer that loads the file and the violation list and nothing else,
    rather than re-running the authoring agent at 195k context to delete a dash.
    Bootstraps now tell agents explicitly NOT to self-grep, and say what runs
    for them instead, so the instruction is a trade and not just a prohibition.
  - 🔴 **Centralising made the rule STRONGER, not weaker.** First run of the new
    pass over the dry run found 2 real em dashes in
    `design/business-and-offer-brief.md`. `ica-brand-voice` grepped and caught
    its own; `client-researcher` never grepped and shipped them. Self-checking is
    a coin flip by construction. Guardrail 2 is unchanged; only the enforcement
    point moved.
  - `roster.json` v2 adds `registry_sections` per role, with a mandatory naming
    spine (3, 5, 6, 9, 11, 12) always added because guardrail 6 makes spellings
    load-bearing. Measured saving 41% to 66% of the ~10,600-token registry per
    module role. It is a starting point and never a wall: roles are told they may
    read any section, so a wrong entry costs a saving, not a blind agent.
    Auditors, the reconciler, the fill-guide compiler, the assembler and the
    system guide stay unscoped on purpose, since they cross-check everything.
  - `client-researcher` gains a search cap. It spent 8 of its 16 calls on web
    searches for a clinic with no discoverable footprint. Absence is now a
    finding to record, not a reason to keep looking.
  Still open, deliberately: the strategy document is NOT scoped per role. It is
  the most load-bearing input in the run and a bad extract would reproduce the
  Treatwell failure invisibly. Xander's call, 2026-07-27.
  Not yet proven: these numbers are phases 1-2 only. Phases 3-4 are extrapolated
  until a full run is measured with `run_cost.mjs`.
- 2026-07-27: `done` = sort **58**, SHIPPED to grom-dashboard production
  (commit `82600ca`) and verified on prod by remapping a live clinic stage inside
  a transaction and rolling back. The Standard Build's eighth stage now reports.
  56, 57 and 59 remain free between `treatment` (55) and `terms_sent` (60), and
  no existing step was renumbered. `done` is deliberately absent from
  `SALES_CANONICALS` (a terminal must not detect "is this a sales pipeline") and
  from `OFF_SPINE` (it is a real forward rung and gets drawn). Closed out in
  `canonical-model.md`, `client-manifest.schema.json` and
  `client-manifest-schema.md`. Landmine for whoever adds the NEXT step: the list
  is mirrored across EIGHT surfaces in grom-dashboard, not the three the handoff
  named.
- 2026-07-27: the Standard Build, part 7. Three holes on the
  `booking.model = external` path, found by the FIRST build ever run against
  these contracts (Better By Ati, Treatwell diary, dry run) and confirmed
  independently by the registry reviewer. All three were the same class:
  removing 04 removes more than a reminder ladder, and nothing said where its
  other jobs went. New `base-workflows.md` §4A names them: §4A.1 the Booked
  stage-write substitute (the workflow receiving the client's only in-system
  booking signal, so 21 for a deposit-taking client) which INHERITS 04's
  stage-origin guard, its `allowBackward` on the No-Show-origin branch, and its
  removal row (01, 03, 06, 10), and without that last one a contact whose booking
  is real is chased forever; §4A.2 the day-before confirmation ask, resolved to
  one of three stated outcomes rather than dropped silently; §4A.3 the tags 04
  would have written. 20's entry now warns that the LP-widget Booking Started
  path has no slot-selection event to trigger it. `canonical-model.md` moves
  `appt:confirmed-yes` from always-present to conditional (nothing writes it
  without 04) and its stage table names the substitute. The removal matrix and
  the validator check table gain the substitute's row, and `registry-reviewer`
  check 8 gains an explicit external-booking sub-check. Motivated by the dry
  run: the external path was written but never exercised, and every gap was in
  it.
- 2026-07-27: the Standard Build, part 6 (the last). The `client-design` skill
  now starts FROM the Standard Build instead of designing a build shape.
  `SKILL.md`'s one-line rule rewritten; `guardrails.md` rule 4 gains the Tier-1
  carve-out (Tier-1 is not divergeable, even by strategy; you ADD on top with a
  reason, or you raise a blocking objection). `systems-architect` gains a
  "you start FROM the Standard Build" section and its sections 2, 3, 3A, 4, 5,
  10 and 12 are rewritten to instantiate rather than choose, with a Standard
  Build conformance block in the self-check; section 12 now separates ADDITIONS
  (each naming the mechanic that forced it) from DIVERGENCES.
  `journey-architect`'s "divergence from defaults" becomes "what this build adds,
  and what it strains", and it now defines only the ADDITIONS, with the base set
  under `references`. `pipeline-fields` narrows to the client-specific layer:
  meaning, ownership and extensions on a known skeleton, plus a new cycle-and-death
  section and holder justification against the placement rule.
  `registry-reviewer` goes from seven checks to eight, the new one being Standard
  Build conformance with a prompt-based booking agent as a blocking breach.
  The registry template's sections 2, 3, 10 and 12 follow. Nothing in the factory
  reads `core-workflows.md` any more; it is kept only as the record of what the
  three non-migrating clients were built against. Prompt lint passes.
- 2026-07-27: the Standard Build, part 5. `validate.mjs` gains the version-aware
  manifest pass and the workflow-JSON pass. Manifest: the v1/v2 required-key
  split (the schema expresses it as `if`/`then`, which this validator cannot
  evaluate, so it is applied explicitly), plus stage-name, duplicate-slug,
  zero-offer-price, reserved-workflow-number, always-on presence,
  booking-model conflict, lost-reason, per-cycle-field and
  `decay_days > ladder_length_days` checks. Workflow JSON: the deployment gate
  (published AND trigger file non-empty), `stopOnResponse`, the three-part
  `monetaryValue` shape, stage-without-pipeline, `allowBackward` on the
  regression-capable workflows, pipeline-only finders, not-found branches that
  create then goto, unresolved gotos, and appointment-anchored waits with no
  guard above them. It reads the latest capture per workflow from
  `workflow-json/{loc}/{wid}/{stamp}/`.
  **A COVERAGE report now prints to stderr on every run**, naming what each
  check inspected and what is deliberately not implemented, because the estate's
  recurring failure is a checker returning "pass, issues: []" on a build the
  builder shows seven errors for. Fixtures `valid-v2` and `invalid-v2` added;
  suite goes 4 tests to 7. First real run caught a live defect: Francesca's
  `07f Course Opportunity Sync` writes `monetaryValue` as the string "2000".
- 2026-07-27: the Standard Build, part 4. `client-manifest.schema.json` gains
  `manifest_version: 2`: `pipelines[]` (per campaign, each with its own
  `stage_ids` map of the eight fixed stage NAMES to GHL stage UUIDs) replacing
  the scalar `pipeline_id` and the flat `stage_map`, plus `base_workflows`
  (reserved numbers only, absent key = not built), `lost_reason_ids`,
  `per_cycle_fields` (with the AI staging-slot pointer), `knobs`
  (touch_ceiling, decay_days, ladder_length_days, absence_close_days,
  treatment_payment_in_system, send_window), and
  `ai_agents.chat_booking_flow_workflow_id`. v1 stays valid via `if`/`then` on
  the version; existing clients do not migrate. The name-to-canonical-step
  mapping moves OUT of the per-client manifest into the schema itself
  (`x-standard-stage-canonical`), because fixed stage names make it knowable in
  advance; the mart seeder derives `ghl_stage_map` by joining, which removes the
  hand-written per-client SQL migration. Motivated by two Standard Build
  pipelines sharing all eight stage names and collapsing into one
  indistinguishable flat map.
- 2026-07-27: the Standard Build, part 3. `baseline/ai-agent-contract.md` added
  (Tier-1): the two-chat-agent set, the flow-builder booking-bot requirement and
  the four conditions that make it run at all, the hard requirement table, the
  AI staging-slot rule, capability flags living on the ACTION not the agent,
  personas from custom values, the per-node required-field map, the voice-AI
  write surface, the live-test contract, and the validator checks. Motivated by
  03's trigger BEING the booking agent and 12 triggering on platform-emitted
  handover tags: agent config is inside the build contract, not adjacent to it.
- 2026-07-26: the Standard Build, part 2. `baseline/base-workflows.md` added
  (Tier-1): fourteen always-on workflows with reserved numbering and gaps, the
  shared one-card-per-cycle guard and the five build rules under it, per-workflow
  ownership, the removal matrix, the touch ceiling, the estate-wide hygiene
  flags, and the fixed/knob split. `baseline/core-workflows.md` marked SUPERSEDED
  and kept only until the `client-design` prompts are repointed. The pipeline
  tail (13) is written as primarily manual with payment-driven advancement as an
  off-by-default knob, per the 2026-07-26 decision that Grom's data ends at
  booking; this overrides the design spec's payment-driven tail. Motivated by
  every client's workflow set being re-decided from scratch, so "check 07" meant
  a different workflow at every account.
- 2026-07-26: the Standard Build, part 1. `baseline/canonical-model.md` sections
  5 to 9 promoted from Tier-2 "adapt freely" to Tier-1 contracts: eight fixed
  stages, one pipeline per campaign, Lost as a status with the stage restated,
  one card per cycle, the data placement rule with the AI staging-slot
  exception, and the standard tag/value/field/lost-reason sets.
- 2026-07-14: landing-page build machinery removed from the factory and the new
  `reconcile-lp-tracking` skill added. Landing pages are built outside the
  factory, directly with the user; the factory records each LP as context only
  (slug, purpose, booking mechanism) for the tracking and workflow modules, and
  the built page is reconciled to the tracking design (five events, selectors,
  snippet, CSP) by `grom-client-factory:reconcile-lp-tracking`. Dropped the
  system-guide LP builder-handoff contract and the `lp/` coded-page reads across
  system-guide, compliance-brand-auditor, fill-guide-compiler, and the
  client-design ingest-answers/guide modes. Motivated by the factory's generated
  LP content being low value: LP authoring moves to a direct chat with the user.
- 2026-07-12: added the `system-guide` role (Plan 5): after the assembler, one
  agent renders the whole designed system into a self-contained
  `system-guide.html` review page (plain-English orientation, follow-one-lead
  walkthrough, inline-SVG/CSS diagrams, glossary, verbatim-vs-explanation two-layer
  split); also a standalone `guide` mode. Motivated by the acceptance dry run
  needing a single human-readable review surface.
- 2026-07-10: baseline v1 seeded from the spec, the pilot client build's doc
  set, the go-live checklist, and the live client-lp-tracking rollout process.
