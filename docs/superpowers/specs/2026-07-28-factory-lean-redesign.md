# Factory lean redesign, agreed with Xander 2026-07-28

Supersedes the agent-shape and gate-placement parts of
`2026-07-27-factory-process-revamp-design.md`. That spec's part 3 recommended
adding no gates. Xander overruled it, with cause: see the evidence below.

Status: AGREED, NOT BUILT.

## Why

Measured on the 2026-07-28 standard-path run of Better By Ati:

- **53 agents** in phases 3-4 against an estimate of 18. Final measured cost of
  phases 3-4 was **$33.40** (752 calls, 62.1M cache-read) against an estimate of
  $15-20. Full standard-path build: **$39.31**.
- Every agent pays a fixed **~39.5k token floor** before it reads anything, so
  one agent per file pays that entry fee 24 times.

🔴 **CORRECTION, read this before acting on the cost priorities.** During the
session it was claimed that the 24 `fix-conformance` agents were 46% of the
Audit phase. That was their share of the token counts SHOWN IN THE PROGRESS
DISPLAY, which is context size, not spend. Measured against real cumulative
cache-read they are **7.3%**. Never reason about cost from the progress display.

Actual share of phases 3-4, by role:

| role | share | calls |
|---|---|---|
| `workflow-designer` | **25.7%** | 134 |
| `conversation-ai` | 11.0% | 83 |
| `registry-reconciler` | 10.2% | 68 |
| `fix-conformance` (all 24) | 7.3% | 129 |
| `fill-guide-compiler` | 6.1% | 26 |
| `postlaunch-onboarding` | 6.0% | 40 |
| `golive-checklist` | 5.3% | 37 |
| `phone-compliance` + `domains-deliverability` | 10.1% | 76 |

🔴 **The single biggest cost in the factory is one agent, `workflow-designer`,
at over a quarter of the run, and it is also the one that died mid-write.**
Nothing in the agreed redesign below addresses it. The redesign's cuts (phone,
domains, reconciler, fixers) total about 27%, which is worth doing, but the
largest item is untouched. Treat `workflow-designer` as the next investigation,
not the fixers.
- Nine files were fixed twice, because `MALFORMED_FILL_TOKEN` fires on prose
  that describes the token pattern (`{{FILL_...}}`, `{{FILL_*}}`) rather than
  being a token. The fixer cannot win.
- The registry-reviewer loop revises only while a **blocker** exists, so it
  exited leaving two `important` findings, one of them a Tier-1 data placement
  breach. It only got fixed because the PM read the findings by hand.
- `workflow-designer` died mid-run with a zero-token synthetic termination,
  right after "Now I have everything needed", and the copywriter that depends
  on its output started anyway. Nothing in the workflow noticed.

Xander's framing, verbatim in intent: the process must be a conversation. The
AI proposes what to build and what each piece is for, the human shapes it, and
only then does the build run. One approval gate at the end of a 53-agent run is
not that.

## The agreed process

Tier-1 is untouched: eight fixed stages, the base workflow set and numbering,
the flow-builder booking bot.

### Step 1. Foundation. 3 agents.

- `client-researcher`, unchanged.
- `ica-brand-voice`, unchanged.
- `journey-architect`, **repurposed**. It no longer designs a journey, because
  the journey is standardised. It writes THE PROPOSAL: the workflow list with
  one line on what each is for, the fields and tags with what each is for and
  who writes it, the pipeline, and the open questions. Plain English, for a
  human, roughly two pages.

### GATE 1 (new). Human.

Xander reads the proposal, cuts workflows he will never action, corrects
misreadings, and answers what it could not work out. Nothing is built yet, so
changing his mind is free.

### Step 2. Blueprint. 2 or 3 agents.

- `systems-architect` writes the binding registry FROM the agreed proposal.
- `registry-reviewer`, **one round only**.
- At most **one** architect fix pass. The loop is removed.
- 🔴 The loop condition must revise on `blocker` AND `important`, not blockers
  alone. That defect is what let a Tier-1 breach through on 2026-07-28.

### GATE 2 (exists, expanded). Human.

Must now surface **registry section 5, the full fields and tags list, in plain
English**, alongside the roster, the doc index and section 3A. Section 5 was
already written before the fan-out and already sat behind this gate; the PM
simply never showed it. That is why no third gate is needed inside phase 3.

### Step 3. Build. 9 agents, 7 on a simple client.

Wave A, parallel: `pipeline-fields`, `alert-catalog`, plus `calendars-booking`
only when there is a calendar or a deposit, plus `tracking-pixel` only when
there is a landing page.

Wave B, parallel: `workflow-designer`, `conversation-ai`,
`postlaunch-onboarding`, `golive-checklist`.

Then alone, because it reads the workflow doc: `nurture-copywriter`. Kept
SEPARATE from `workflow-designer` on Xander's explicit call.

**Dropped by default:** `phone-compliance`, `domains-deliverability`. Xander
executes both himself. They become a per-client opt-in flag.
🔴 `golive-checklist` reads BOTH by name for its day-1 critical path and its
GATED-BY gate list, and `voice-ai` reads the phone doc, so skipping them needs
a registry-section-8 fallback in those prompts or the checklist loses its gates.

**`alert-catalog` STAYS.** Xander's correction: the build is a complete system.
Notification steps go inside their owning workflows whether or not they are
switched on at launch, so the copy has to exist or the workflow designer writes
holes. "Disabled at launch" is a setting, not a reason to skip the design.

### Step 4. Conformance. 0 or 1 agents, down from 24.

- The check stays. It is a script and it is free.
- Everything mechanical is **fixed by code, no agent**: missing claims-sidecar
  entries, phantom entries, malformed JSON, missing sidecars.
- Only an em dash inside customer-facing copy needs judgement, so **one** agent
  handles those, and only when there are any.
- Runs **once**, at the end of the build, not once per wave.
- 🔴 Fix `MALFORMED_FILL_TOKEN` so `{{FILL_...}}` and `{{FILL_*}}` used as
  descriptions of the pattern are not violations. That false positive burned a
  fixer on both runs.

### Step 5. Audit. 1 round.

- Three auditors in parallel, unchanged in kind: reconciler, journey-leak,
  compliance-brand.
- **One** fix round, one agent per document with findings.
- No recheck round.
- Open, not decided: fold the reconciler into the validator, since matching
  names and numbers across docs is code work, not judgement. Would take three
  auditors to two.

### Step 6. Close. 3 agents.

`fill-guide-compiler`, `assembler`, `system-guide`.

## The two kinds of unknown

Agreed 2026-07-28. Today's fill guide conflates them.

- **Values** do not change the design: address, price, alert phone number,
  sender domain. The workflow is identical whichever value it is. These belong
  in the fill guide, collected at the end, sent to the client.
- **Design questions** change what gets built: does the clinic take a deposit,
  do they book internally or externally, how far apart are treatment sessions.
  🔴 These must NEVER reach the fill guide. They surface at GATE 1 and must be
  answered before the build runs.

Evidence: the 2026-07-28 run did not know Hair PRP's course spacing, so it put
a 60-day placeholder into workflow 13's timer and carried on. That is a real
number driving real behaviour, shipped as a labelled guess.

Splitting them also makes the fill guide short enough that a client will
actually reply to it.

## Expected effect

| | 2026-07-28 run | After |
|---|---|---|
| Agents, phases 3-4 | 53 | about 20 to 24 |
| Human gates | 1 | 2 |
| Conformance fixer agents | 24 | 0 or 1 |
| Registry revision rounds | up to 3 | 1 |
| Audit rounds | up to 2 | 1 |

## The workflow-designer investigation, 2026-07-28

Ran because `workflow-designer` was 25.7% of phases 3-4. **It is not an
expensive writer. Its document is an expensive thing to FIX.** The four
instances the cost table groups together are one death, one write, and two
audit fix rounds:

| instance | calls | share of run | tool pattern |
|---|---|---|---|
| died mid-write | 15 | 2.1% | produced nothing |
| wrote the doc | 22 | 4.6% | 2 Write, 1 Edit. 73KB in one shot |
| audit fix round 1 | 59 | **13.7%** | 19 Edit, **31 Bash** |
| audit fix round 2 | 38 | 5.2% | 4 Edit, **25 Bash** |

Writing is 18% of the document's lifetime cost. Fixing is 74%.

🔴 **The fixer spends more effort locating than changing.** 56 shell commands
across the two rounds to make 23 edits. Auditor findings carry `doc`, `issue`,
`fix` and `severity` but **no line number**, so every fix pass greps a 73KB file
to find each target, at full context. Peak context on the write instance was
255k.

### Agreed fixes, in order of measured impact

1. **Auditor findings must carry exact line numbers.** Add the field to the
   `FINDINGS` schema and require it in the three auditor prompts. Cheapest
   change, largest effect, no structural churn. Most of those 56 shell commands
   disappear.
2. **One audit round, not two.** Already agreed above. Round 2 spent 5.2% of the
   entire run to make four edits.
3. **Split `07-journey-and-workflows.md` into one document per workflow.**
   Xander's call, 2026-07-28. A finding against workflow 08 then loads a small
   file instead of reloading 73KB on every one of 59 calls.

🔴 **Landmine on item 3.** ONE `workflow-designer` agent still writes all of the
files. Do NOT turn this into one agent per workflow: 17 agents each paying the
~39.5k floor is exactly the mistake the 24 conformance fixers made. The win here
comes from keeping the FIXER's context small, not from parallelising the writer.
The audit fix loop already dispatches one agent per document with findings, so
after the split it naturally targets small files. Every new file needs a
`doc_index` entry owned by `workflow-designer`, or `ownerOf()` returns nothing
and the fix is silently skipped.

## Three more defects, proven on the closing validate of 2026-07-28

The final `validate.mjs` run FAILED, and the cause was the conformance system
built that same morning.

1. 🔴 **A fixer took DESTRUCTIVE action on a rule it had no instruction for.**
   The fixer prompt covers six rules. `CLAIMS_ORPHAN_SIDECAR` is not one of
   them. Mid-run the sidecars were unnumbered (`phone-and-compliance.json`)
   while the docs were numbered (`04-phone-and-compliance.md`), so the validator
   correctly flagged orphans. Most fixers renamed the file. Three **deleted**
   it: `04-phone-and-compliance`, `06-tracking-and-pixel`,
   `08-nurture-and-longform-copy`, carrying 25 fill tokens between them, plus
   the go-live-checklist and post-launch-onboarding sidecars.
   **The system built to guarantee every token reaches the fill guide destroyed
   that guarantee for five documents.** Two required changes: the fixer must
   never delete anything, and mechanical repair must move to code, which renames
   deterministically instead of improvising.
2. **The validator only walks `design/`, `lp/` and `build/`.** `go-live-checklist.md`
   and `post-launch-onboarding.md` live at the client-folder root, so they are
   never scanned, so their sidecars look orphaned by construction. Either scan
   the root docs or exempt their sidecars.
3. **`{{FILL_*}}` in the fill guide's own explanatory text still flags as
   `MALFORMED_FILL_TOKEN`.** Third run in a row. Already listed above; this is
   the confirmation.

Pattern worth naming: this is the SECOND time in one day that a piece of the
factory silently destroyed or lost work with nothing noticing. The first was
`workflow-designer` dying mid-write while the dependent agent carried on. **The
factory has no notion of "something that should exist does not."**

## Still open

- Cap the audit fix step, which is still one agent per affected document.
- Whether the reconciler becomes code.
- A spend checkpoint: a phase about to spawn more than N agents stops and shows
  the count and estimated cost before spending anything. Raised, not decided.
- Why `workflow-designer` was killed mid-write. Unexplained. A run that loses
  its most important document and continues is a worse defect than any of the
  cost work above.
