# Baseline Changelog

Newest first. One line per change: date, what changed, which client's
divergence log motivated it.

- 2026-07-28: **cross-document name reconciliation moves into code, ALONGSIDE the
  agent.** `validate.mjs --reconcile` (new `baseline/lib/reconcile.mjs`) does the
  set-comparison half of the `registry-reconciler` role: a name some document
  references that no document defines, one structural name owned by two
  documents, and names differing only in case, punctuation or plural. It reports
  file, LINE and anchor for each, which is the thing the agent could never do
  cheaply: on 2026-07-28 a fix pass spent 56 shell commands to make 23 edits
  purely on locating things.

  🔴 **Report-only, and the agent stays.** Candidates print below a marker and do
  NOT affect the exit code, because whether "Deposit Paid" and "deposit-paid" are
  one tag misspelled or two real tags is a judgement no script can make, and
  failing a build on a guess is worse than not checking. The reconciler prompt
  now runs the command first and spends its turns on exactly the residue: is a
  collision one concept or two, is an undefined reference dangling or a document
  legitimately discussing something deliberately not built, is one fill token
  standing in for two different unknowns, and is a concept defined twice under
  names that are not textually similar. Whether the agent can then be dropped is
  a question for ONE real build to answer by comparison, not for a guess: this
  estate has now twice been wrong about what an agent was contributing.

  Scoped by measurement on the real Better By Ati build. Applying
  duplicate-definition to fill tokens produced 15 findings of one shape (several
  documents each writing {{FILL_OPENING_HOURS}} and each calling it a
  definition), which is ordinary and which the fill guide dedupes, so that rule
  is structural names only. After scoping, a whole real build yields 3
  candidates. Baseline suite 22 tests to 25.

- 2026-07-28: **one meaning for a sidecar's token lists.** `conformance_fix.mjs`
  trimmed both `defines.fill_tokens` and `references.fill_tokens` against tokens
  literally present in that document, while `fill-guide-compiler.md` told the
  compiler that `references` was "EVERY token you aggregated" across the build.
  The code won, silently, by deleting entries. It never bit, because the fill
  guide prints every token in its registry table, so they were all literally
  present, but two meanings for one word is what produced the sidecar deletions
  earlier the same day. Xander's call: the CODE's meaning is right, and the
  prompts move to it. Guardrail 3 now states it once, binding on every role:
  both lists describe THIS DOCUMENT, `defines` for tokens it introduced,
  `references` for tokens another document introduced, and a token that does not
  literally appear in the text belongs in neither list. `fill-guide-compiler.md`
  and `ica-brand-voice.md` were the two prompts that implied otherwise.

- 2026-07-28: **adversarial review of the lean redesign, and the eight defects it
  found.** An independent reviewer traced the rebuilt orchestration end to end.
  Every finding below was verified in the code before it was fixed.

  🔴 **The sensor read silence as PASS.** The dead-agent stop, the
  promised-document stop and the closing check are all enforced by one small
  agent that runs a command and reports what it saw, and its result handler said
  `?? []`: if the CHECKER died, zero violations, run continues. The cure for
  "the factory has no notion of something that should exist does not" had been
  installed with a silent bypass on its only sensor. A null is now a hard
  `failed: 'conformance-checker-died'` / `'docs-checker-died'`.

  🔴 **`design_questions_found` could never arrive.** The fill-guide compiler is
  told to report tokens that are really design decisions, and SKILL.md makes the
  PM treat a non-empty list as a defect in the run, but the agent was handed the
  generic STATUS schema, which does not contain the field. The guard against
  another 60-day placeholder had no way to fire at either end. Same bug on
  `files_written` from `workflow-designer`. Both now have their own schemas.

  **The opt-in docs would have halted runs on their DEFAULT setting.**
  `promisedDocs()` filtered the roster by phase but not by `activeRoleIds`, so
  skipping `phone-compliance` promised a document whose owning agent was
  deliberately never run, and the missing-document stop fired on it. Item 7
  breaking item 1. The architect prompt now also states, at the point of use,
  that a skipped role gets no filename in the doc index and why.

  **Audit findings could fail to route at all.** The architect writes doc-index
  rows as PATHS; the auditor prompts ask for the doc-index "filename"; they were
  compared with `===`. Pre-existing, but splitting one workflows doc into
  eighteen turned one possible mismatch into eighteen. `ownerOf()` now falls back
  to a basename match.

  **Nothing verified the audit fixes landed.** Dropping the recheck round was
  agreed; also discarding the fixers' results was not. A fixer that died or
  ignored a blocker was indistinguishable from one that worked. Fix agents now
  return `applied` and `skipped`, code diffs that against what was dispatched,
  and `fixLoopReport` carries `dispatched`/`applied`/`skipped`/`unroutable`/
  `deadFixerDocs`. No extra agents, no extra round.

  **The closing pass detected and never repaired.** It called `conformance()`
  without `fixConformance()`, so an em dash introduced by the audit fix round was
  found at the end and left there, and the PM's closing `validate.mjs` failed:
  the same closing-validate defect this rebuild was written about, reintroduced
  from the other end.

  **One pattern literal masked every real malformed token on its line.**
  `malformedTokenOn` matched non-globally, so `{{FILL_*}}` early in a line hid a
  genuinely malformed token after it, in the one file the exemption exists for.

  **`workflow-designer` still had permission to keep everything in one file**, a
  line left from before the split, which would have written 1 file where the doc
  index promised 18 and halted the run after the expensive part.

  Also: `compliance-brand-auditor` and `assembler` were never told about
  `design/workflows/`, and the compliance auditor is the one that owns medical
  claims and opt-out lines, which now live entirely in there; `voice-ai` and
  `golive-checklist` were not scoped to registry section 8, the fallback the
  opt-in change makes them depend on; and the spec's conditional roles
  (`calendars-booking`, `tracking-pixel`) were never implemented, so no client
  was ever the "7 agents on a simple client" the spec describes.

  Baseline suite 21 tests to 22, with a mutation check on the masking fix.
  Lesson worth keeping: the redesign was sound and the seams were not. Every one
  of these was in wiring added the same day, none in the agreed design.

- 2026-07-28: **the factory lean redesign, built.** Agreed with Xander line by
  line after measuring the Better By Ati standard-path run: 53 agents against an
  estimate of 18, $43.40 against $15-20, and a closing `validate.mjs` that
  FAILED. Spec: `docs/superpowers/specs/2026-07-28-factory-lean-redesign.md`.
  Correctness first, economy second, in that order deliberately.

  **Nothing may delete work.** Three of the 24 conformance fixer agents met
  `CLAIMS_ORPHAN_SIDECAR`, a rule their prompt did not cover, improvised, and
  deleted five claims sidecars carrying 25 fill tokens. The system built to
  guarantee every token reaches the client destroyed that guarantee for five
  documents. Mechanical repair is now `baseline/conformance_fix.mjs`, code, which
  renames deterministically, creates what is missing, reconciles declared tokens
  against real ones, and NEVER deletes a file: its worst accepted outcome is
  leaving one for a human. Only em dashes in customer-facing copy still need
  judgement, so ONE agent takes those, and only when there are any. 24 agents to
  0 or 1, run once per workflow rather than once per wave.

  **The validator was the liar.** All nine violations in that failing closing run
  were its own fault. Sidecars are written to `design/claims/` AND
  `build/<run>/claims/` and it only read the second, which is what told those
  fixers the files were orphans. It never scanned the client-root documents
  (`go-live-checklist.md`, `post-launch-onboarding.md`), so their sidecars looked
  orphaned by construction. And `{{FILL_*}}` in the fill guide's own explanatory
  prose flagged as `MALFORMED_FILL_TOKEN` on three consecutive runs, a violation
  no fixer could ever clear. All three fixed; `baseline/lib/docscan.mjs` is now
  shared by the reporter and the repairer so they cannot disagree about what
  exists again. The build that failed now passes conformance with zero agents.

  **The factory can now notice that something is missing.** It could not before,
  which is how `workflow-designer` died mid-write, `.filter(Boolean)` discarded
  the corpse, and the copywriter that reads its document ran against nothing with
  the run completing healthy. A null agent result now stops its phase by name,
  and `validate.mjs --docs=a.md,b.md` asserts the registry's promised documents
  exist and are not stubs. Both stop the run: a restart is cheaper than a build
  with a hole in it. Xander's call.

  **Findings carry a line number and an anchor.** The cheapest change and the
  largest measured saving: fixing the workflows doc was 18.9% of the whole run
  across two rounds, and the fixer spent more effort LOCATING than changing, 56
  shell commands for 23 edits, because a finding named only its document. The
  anchor exists because line numbers drift as earlier edits land, so the fixer
  works highest-line-first and trusts the anchor over the number.

  **One revision round, one audit round.** The registry loop ran up to three
  rounds but only ENTERED on a surviving `blocker`, so it exited leaving two
  `important` findings standing, one a Tier-1 data placement breach, caught only
  because the PM read the findings by hand. It now enters on blocker OR
  important, runs once, and whatever survives is surfaced at GATE 2. Audit round
  2 had spent 5.2% of the run to make four edits; it is gone.

  **Two human gates instead of one at the end.** `journey-architect` stops
  designing a journey, because the journey is standardised, and becomes the
  proposal writer: `design/build-proposal.md`, about two pages of plain English,
  the workflows and what each is FOR, the pipeline and which stage-moves are a
  human's hands, and the open questions. That is GATE 1, and it required
  splitting `phase12-foundation.mjs` into `phase1-foundation.mjs` and
  `phase2-registry.mjs`, because a workflow cannot pause for a human. Phase 2
  carries his decisions verbatim and both the bootstrap and the architect prompt
  say that where they differ from the document, he wins. Fields and tags are a
  COUNT plus the surprising few at GATE 1 (Xander's call, option B): the full
  list would bury the questions. GATE 2 shows the full list instead, from a new
  `fields_and_tags_for_human`. Registry section 5 was ALWAYS written before the
  fan-out and always sat behind that gate; the PM simply never displayed it.

  **The two kinds of unknown are separated at both ends.** A VALUE GAP (address,
  price, alert number) does not change the design and becomes a `{{FILL_*}}`
  token for the fill guide. A DESIGN QUESTION (deposit? whose diary? course
  spacing?) changes what gets BUILT and may never be a token: it goes to GATE 1.
  The proposal classifies them at the source and the fill-guide compiler reports
  any that reached it as a defect in the run, not a question for the client. On
  2026-07-28 a build did not know a treatment's course spacing, put a 60-day
  placeholder in a live timer, and carried on.

  **`phone-compliance` and `domains-deliverability` are opt-in**, both defaulting
  to skipped, because Xander executes both by hand. 🔴 `golive-checklist` read
  both by name for its day-1 critical path and its GATED-BY gates, and `voice-ai`
  read the phone doc for its go-live gating, so both now fall back to registry
  section 8, which always exists, rather than losing a gate.

  **`07-journey-and-workflows.md` is split into one document per workflow** under
  `design/workflows/`, so an audit finding loads a small file instead of
  reloading 73KB on every pass. 🔴 ONE agent still writes them all: 17 agents
  each paying the ~39.5k floor is exactly the mistake the 24 fixers made. Every
  file needs a `doc_index` row owned by `workflow-designer` or `ownerOf()`
  silently drops its fixes, which the architect prompt now says in those words.
  `isCustomerFacing()` matches the directory, since the basenames are per-client
  slugs no pattern can catch.

  Also: the compliance auditor stopped hunting em dashes and malformed tokens
  (both mechanical now, and its em-dash instruction still carried the pre-1.2.1
  scope, so it manufactured findings against prose the rule no longer covers),
  and `nurture-copywriter` stopped describing the workflow designer as running in
  parallel with it, which it has not since the 3b ordering change.

  Baseline suite 13 tests to 21, including a mutation check that the never-delete
  guarantee actually fails when violated. NOT re-run end to end: a full build is
  $43, and the spec says test with fixtures and single agents until there is a
  reason to spend.

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
