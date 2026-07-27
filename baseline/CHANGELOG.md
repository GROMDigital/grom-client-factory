# Baseline Changelog

Newest first. One line per change: date, what changed, which client's
divergence log motivated it.

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
