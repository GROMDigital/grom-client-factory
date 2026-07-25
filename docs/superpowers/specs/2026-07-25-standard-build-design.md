# The Standard Build

Design doc. 2026-07-25. Revision 2, after two adversarial expert reviews.
Findings and evidence: `2026-07-25-standard-build-review-findings.md`.

## Why

Every client build is currently designed from scratch. The factory baseline
exists, but almost all of it is Tier-2 ("defaults, adapt freely"): stage names,
workflow sets, and field choices are re-decided per client. Three consequences:

1. Nothing is comparable. "Check workflow 07 at every account" is meaningless
   because 07 is a different workflow at each one.
2. Tracking is hand-wired. The portal's per-client config is a hand-written SQL
   migration of stage UUIDs, which is the stated obstacle to onboarding a new
   clinic as a config action.
3. Design cost is paid repeatedly for decisions that never actually varied.

The convergence point already exists and is already written down. Every clinic
runs the same journey: ad, form, engage, book, attend, treat. The canonical
funnel steps in `baseline/canonical-model.md` encode exactly that. What was
missing is the promotion: those steps are a *mapping target* today, and this
design makes them the stages themselves.

**Revision 2 also makes this document the place where the estate's known
failures get fixed once instead of per client.** Every contract below that looks
fussy has a live incident behind it, cited in the findings doc.

## Scope

In scope: the pipeline, the base workflow set, where data lives, the AI-agent
config contract, the reporting contract, and the enforcement changes.

Out of scope, each its own later spec:

- Folding `reference/lp-library/` into the factory as a build step.
- The factory process revamp: strategy-analysis front door, ingesting
  onboarding-form answers, human gate placement, and agent-output quality.

**Existing clients do not migrate.** Francesca, SK Skin and Alevere stay as
built. Francesca in particular is live with payments. This governs new builds.

## 1. Pipelines

### One pipeline per campaign/offer

A pipeline exists for each distinct ad funnel: its own lead form, its own
landing page, its own booking calendar. Not per product, not per treatment.

A fifteen-treatment menu sold through one consultation funnel is ONE pipeline.
Treatment interest is a field on the card.

Two ad funnels selling genuinely different things (a course and a treatment) are
two pipelines with identical stages. Identical stage names across pipelines in
one location is verified to work live, despite an API note claiming names must
be unique.

### Eight stages, fixed

Identical at every client. Clients may APPEND stages after Done (see §6 for the
sort-space constraint). They may never rename, reorder, or remove these.

| # | Stage | Set by | Canonical step |
|---|---|---|---|
| 1 | New Lead | 01 - Lead Intake + Chase; or 03 - Booking Started + Chase on landing-page name+email capture | `lead` (10) |
| 2 | Engaged | 02 - Reply to Engaged, on first reply | `engaged` (20) |
| 3 | Booking Started | 03 - Booking Started + Chase | `qualified` (30) |
| 4 | Booked | 04 - Booked + Reminders, stage-guarded | `booked` (40) |
| 5 | No Show | 08 - Outcome Chaser | `no_show` (45) |
| 6 | Showed | 08 - Outcome Chaser | `showed` (50) |
| 7 | Continuing Treatment | 13 - Treatment Progress + Completion, from payment or next-appointment | `treatment` (55) |
| 8 | Done | 13 - Treatment Progress + Completion; sets status Won | `done`, NEW, see §7 |

The stage is named **Booking Started**, not Qualified, and maps to the existing
`qualified` canonical step at sort 30, so nothing downstream needs relabelling.

### Booking Started is an event, not a judgement

One definition: **this person saw real availability.** Two entries.

**Entry 1: the booking agent's flow tagged `booking:availability-shown`.**

"The booking AI presented dates" is not an observable GHL event. The trigger
registry has 57 triggers with no outbound-message, no "AI sent a message", and no
availability event. The Conversation AI action-type enum is closed:
`triggerWorkflow`, `updateContactField`, `appointmentBooking`, `stopBot`,
`humanHandOver`, `advancedFollowup`, `transferBot`. None emits "I offered times".

**Therefore the booking agent MUST be a flow-builder bot, not a prompt bot.**
This is a hard requirement of the standard build. A flow bot's logic IS a
workflow, so an `add_contact_tag` step placed immediately BEFORE the booking
node is deterministic by graph position rather than by LLM judgement. The tag
goes before the node because `conversationai_book_appointment` branches only
`onBooked` and `onNotBooked`; "slots presented" is not one of its branches.

The ConvAI `triggerWorkflow` action would also work and is live on AUS Booking
Finn, but it is LLM-judged against a prose condition, which §8 rejects on
evidence.

**Entry 2: the landing-page widget captured name and email.** The booking worker
writes the signal to GHL.

The card is created at New Lead and advanced to Booking Started in the same run.
Handing over name and email IS the lead moment.

### Booking Started is NOT the LP `booking_started` event

These are different populations and must never be reported under one label. The
LP event fires on the first click inside the widget selector: anonymous,
explicitly not on auto-load, and strictly BEFORE slot selection. The stage
requires name and email, which arrive after. The LP counts distinct sessions; the
stage counts cards. They run roughly 3x apart.

The tracking doc renames the client-facing label for one of them. See §6.

### Death is a status, and the write must restate the stage

There is no Lost stage. A dead lead gets status **Lost** plus GHL's **native
lost reason**, and the card stays in the stage where it died, so "60% die at
Booking Started" is directly readable.

Verified live: AUS pipeline `fxiSbIBOA9hopUwj9LJF` holds 28 lost cards, each
still at its own stage, with `lostReasonId` set and `lastStatusChangeAt` distinct
from `lastStageChangeAt`. The property this design rests on is real.

**Build rule:** the only picker-visible opportunity action requires BOTH
`pipeline_id` and `pipeline_stage_id`, and `lostReasonId` exists only on that
interface. So a naive "set Lost" step would relocate every dying card to one
hardcoded stage and destroy the entire reporting premise. **Every Lost write
restates the card's CURRENT stage, which means every Lost-setting workflow is
per-stage branched.**

`Done` sets status **Won**.

Do not create a custom lost-reason field. GHL's is native, is a merge tag, and is
a filter on the stale-opportunity trigger.

### Standard lost reasons

Lost reasons are location-level preconfigured options, not free text. AUS
currently has exactly one ("not interested"), and the dashboard found only 1 of 9
lost opportunities carries a reason at all. Without a fixed vocabulary, "why they
die" is not comparable across clients, which is the point of standardising.

Seeded at every location, and `lost_reason_ids` joins the manifest:

`price`, `location`, `timing`, `not suitable`, `went elsewhere`,
`no response`, `not interested`, `duplicate / test`.

Every automated Lost write sets one. Human-set Lost will stay blank, which is
accepted; 07 and 10 always write one.

### One card per cycle

A cycle is one decision to buy. A reschedule, a cancellation and a no-show all
happen INSIDE an unfinished cycle, so they reuse the same card. A new card is
minted only when the previous one reached a terminal state and the person comes
back later as a new decision.

**This guard is a shared contract, not a property of one workflow. BOTH
01 - Lead Intake + Chase and 03 - Booking Started + Chase run it.** Stating it
inside 03 alone was a defect: 01 is the highest-volume entry point, and without
the guard a patient who books via the landing page and then clicks a retargeting
ad gets a second card at New Lead plus a chase ladder aimed at someone with an
appointment tomorrow.

| Card's current state | What's happening | Do |
|---|---|---|
| New Lead | genuine progression | move to Booking Started |
| Engaged | genuine progression | move to Booking Started |
| Booking Started | already there | nothing; do not restart the chase |
| Booked | reschedule | leave it; 05 - Reschedule Handler owns it |
| No Show | rebooking after missing | move back to Booking Started, same card |
| Continuing Treatment | next appointment in the same course | leave the stage; 04 - Booked + Reminders handles the appointment |
| Done | finished, now back again | NEW card at Booking Started, `cycle_index` incremented |
| Lost | written off, now back again | NEW card at Booking Started, `cycle_index` incremented |
| no card at all | walked in cold | create at New Lead, advance to Booking Started |

Only Done and Lost mint a second card, so a cancel-then-rebook cannot
double-count.

### The five build rules the guard depends on

Each has a live failure behind it. All five are validator-checkable.

1. **Find on pipeline only, then `if_else` on the stage.** `find_opportunity`
   has one filter field; every observed sample across 40 steps in 5 locations
   filters on `pipeline_id`, and `sorting: "latest"` is the only observed sort.
   A stage-filtered finder would return Not Found for a card that exists at a
   different stage, and rule 2 would then create a duplicate. That is the exact
   card explosion this section exists to prevent. Branching on stage is
   runtime-proven, with the trap that `conditionType: opportunity` singular or
   `pipeline_stage_id` snake_case fails silently.
2. **Every not-found branch creates the card and then jumps back to the found
   path's first step.** Otherwise the rest of the workflow runs against nothing.
   Francisca had 14 of 14 dead-ended.
3. **Every backward stage move carries `allowBackward: true`.** Default is false
   in 100% of the corpus, and without it the move silently no-ops. This design
   has at least four backward moves: No Show to Booking Started, 07's regression,
   Booked entered from No Show, and the terminal re-entry paths.
4. **`monetaryValue` needs three parts, not one:** `value` as a number,
   `valueFieldType: "numerical"`, AND `dataType: "NUMERICAL"`. The value is
   stored and does apply at runtime even when written as a string; what breaks is
   the builder render, and the real hazard is that editing and saving such a node
   blanks it.
5. **A second card degrades every finder in the account.** Name the "allow
   multiple opportunities" setting explicitly per workflow: off, and the second
   card's opportunity-triggered enrolment is silently dropped, so a stale card is
   never chased by 10; on, and every opportunity-triggered workflow doubles for
   anyone holding two cards. Also note `{{opportunity.*}}` resolves against the
   run's associated card, so a team alert built on `{{opportunity.lead_value}}`
   can quote the dead card's value.

### The pipeline tail runs on money and time, not on data entry

**This replaces revision 1, which was wrong.** Revision 1 asserted that clinic
staff maintain appointment status. They do not, on any account measured:

- AUS calendar `ZI3orrwqgNebxtzoUgyA`: 7 events, 1 `showed`, 2 `noshow`, 4 still
  `confirmed` with past start dates.
- UK calendar `BjIZd4VxAwirtP3Dmc7X`: roughly 20 of 60 past-dated events still
  `confirmed`.
- Conversion audit F8: AU 1 `showed` of 29 appointments. SK records none at all.
- The reporting mart already reads showed and no-show from the STAGE, not from
  appointment status, precisely because the status is unreliable.

Revision 1 therefore inverted the dependency: it set the stage from the signal
the mart was built to avoid. Stages 5 through 8 would have fired for roughly 3%
of patients.

The corrected mechanism, in descending reliability:

1. **Money sets Continuing Treatment and Done.** The clinic cannot skip taking
   payment. `payment_received` filtered on product id already works and is live
   on Francesca. Paid a course or a first session goes to Continuing Treatment;
   paid in full or paid the final session goes to Done and status Won. This also
   fixes the value problem in §2, because the card's value becomes the amount
   actually paid.
2. **A next booked appointment implies Continuing Treatment.** A by-product of
   booking, not admin.
3. **Attendance is chased on a timer, not on a status.**
   08 - Outcome Chaser is anchored to appointment time, not to status Showed.
   Anchoring to status means it cannot fire for exactly the cards that rot. Waits
   support hours; `if_else` on dates is day-granular, so the wait does the
   anchoring.
4. **Absence closes the tail.** No future appointment plus N days since the last
   attendance sets Done.
5. **A staff ask is the backstop only**, as one daily digest to a NAMED owner.
   SK's clinic notification address opted itself out of its own internal alert
   stream on 2026-06-23, and SK's 3 staff notification threads carry 1,222 of
   3,531 messages, so a per-event chaser aimed at that channel is aimed at
   nothing.

## 2. Where data lives

One rule. The failure mode prevented is the same fact stored twice and drifting.

| Holder | Holds | Test |
|---|---|---|
| **Stage** | where they are | one source of truth; never mirrored |
| **Opportunity (card) field** | facts about THIS cycle | treatment wanted, amount paid, `cycle_index` |
| **Contact (person) field** | facts about the human that do not change per cycle | suburb, date of birth |
| **Tag** | a flag, or something a workflow must trigger on | binary; carries no value |
| **Custom value** | one constant for the whole account | never hardcode in copy |

Per-cycle data belongs on the card, because a rebook mints a new card and keeps
its own answer. A contact field would be overwritten by the second cycle.

`{{opportunity.<field_key>}}` merges into copy. Verified live: 8 fields on AUS
whose `fieldKey` is literally `opportunity.strategy_approve_url` and similar,
already in production in Grom's own onboarding emails.

**Build rule:** `{{opportunity.*}}` resolves when the workflow has an
opportunity trigger **OR** contains a find/create-opportunity action. Both
halves matter. 10 - Stale Opportunity Recovery triggers on `opportunity_decay`
and therefore already resolves the tags, so adding a finder there would be
gratuitous, and it is the one workflow where a second card makes finders a coin
flip. Every workflow spec states which half it relies on.

### The AI staging-slot exception

**The AI cannot write an opportunity field.** Its only field-write capability is
`updateContactField`, keyed to a `contactFieldId`; there is no opportunity-field
writer in the action enum. Live AUS Booking Finn's four capture actions are all
`updateContactField`, and Francesca defect #3 was literally "Booking AI does NOT
set `service_interest`", fixed by adding one.

So: an AI-captured per-cycle fact lands on a **contact field declared as a
write-only staging slot**, and the workflow that attaches the card (01 or 03)
copies it one-way onto the card. The staging field is explicitly NOT a source of
truth, is named `stg_<field>`, and nothing reads it except the copying step.
Without this exception the build either loses AI-captured data or silently
violates the no-mirror rule.

### Standard custom values

`ai_primary_name`, `ai_booking_name`, `business_name`, `business_phone`,
`business_address`, `from_name`, `from_email`, `booking_url`, `review_link`.

### Standard tags

Namespaced, lowercase, colon-separated. Extend with the same `namespace:value`
shape; never respell an existing one. No tag mirrors a stage. No tag holds a
value.

Always present: `funnel:<slug>`, `nurture:exhausted`, `ai:off`,
`ai:human-takeover`, `ai:cancel-requested`, `booking:availability-shown`,
`appt:confirmed-yes`, `needs_disposition`, `missed-call:cooldown`,
`review:requested`.

Conditional: `deposit:link-sent`, `speed:retry-done`.

**`ai:human-takeover` and `ai:cancel-requested` are the exact spellings GHL's own
`humanHandOver` actions write** (verified on live AUS Booking Finn). Revision 1
invented `ai:escalated`, which nothing writes. The tag IS the trigger, so it must
match what the platform emits.

### Standard opportunity fields

`treatment_interest`, `cycle_index`, `amount_paid`.

`treatment_interest` is an **enumerated picklist keyed to registry product
names**, not free text. Card naming, the price join, and all per-treatment
reporting depend on it, and an AI-written free-text field produces "botox",
"Botox" and "anti-wrinkle" within a week. Its staging slot is
`stg_treatment_interest` on the contact.

`cycle_index` is 1 on the first card and increments on each new cycle. The mart
excludes `cycle_index > 1` from acquisition maths (see §6).

Lost reason is GHL-native; do not add a field.

### Opportunity value

Every card carries the price of what that person is in for. Per-cycle by nature.

- Prices come from the client's declared price list in the build registry, where
  product names already live because payment workflows filter on exact name.
  Reconcile against the manifest's existing `avg_treatment_value` so there is one
  source, not two.
- At creation the value is the campaign's advertised offer price. Creating at
  zero is wrong: it makes the pipeline look empty and early drop-off look
  costless. This reproduces audit F2 otherwise, where all 60 AU opportunities
  carry `monetaryValue: 0`.
- **13 - Treatment Progress + Completion owns the reprice**, writing the amount
  actually paid. Revision 1 said the value would be "corrected once treatment
  interest is known" but assigned that to nobody, which left value as a card
  count in a money costume: a £99 advertised intro against a £2,400 course
  purchase is a 96% understatement.
- The three-part `monetaryValue` rule in §1 applies to every write.

What it unlocks: `{{opportunity.lead_value}}` in team alerts, value-based
prioritisation in 10 (verified buildable), and revenue-at-risk per stage in the
portal, subject to the status filter in §6.

### Card naming

`<Treatment> - <Full Name>`, for example `Botox - Jane Smith`. For board
readability; the default leaves a board of identical cards.

## 3. Base workflow set

Fourteen always-on, plus reserved numbers for conditional modules.

| # | Workflow | Present |
|---|---|---|
| 01 | Lead Intake + Chase | always |
| 02 | Reply to Engaged | always |
| 03 | Booking Started + Chase | always |
| 04 | Booked + Reminders | unless `booking.model = external` |
| 05 | Reschedule Handler | unless `booking.model = external` |
| 06 | No-Show Recovery | always |
| 07 | Cancellation Recovery | always |
| 08 | Outcome Chaser | always |
| 09 | Review Request | always |
| 10 | Stale Opportunity Recovery | always |
| 11 | Missed Call Text-Back | always |
| 12 | AI Escalation + Human Takeover | always |
| 13 | Treatment Progress + Completion | always |
| 14 | Buying Signal Escalation | always |
| 20 | Deposit Link + Chase | deposits only |
| 21 | Deposit Paid Handler | deposits only |
| 22 | Unpaid Slot Guard | deposits only |
| 25 | External Booking Status Poll | `booking.model = external` only |
| 30 | Patient Recall / Win-Back | reserved, not built |
| 40 | Speed-to-Lead Outbound Call | voice AI only |

### Numbering: reserved, gaps allowed

Each workflow owns its number for life. A client without deposits has no
20-series, and that gap is information. Same number always means the same job,
so cross-client checks and build diffs work. Clients add at unused numbers and
never renumber the base set.

### What each one owns

**01 - Lead Intake + Chase.** Trigger: lead form submitted, one per form. Runs
the §1 card guard, stamps `funnel:<slug>`, copies staging fields onto the card,
sets the initial value, internal new-lead alert, instant first message inside the
send window, then the chase ladder. The ladder lives INSIDE this workflow. Ends
`nurture:exhausted`. Goals end it on reply or booking.

**02 - Reply to Engaged.** Trigger: customer replied, any channel. Guarded once
per contact. Moves New Lead to Engaged, removes from 01's ladder, wakes the
primary AI, internal engaged alert. Silent to the lead.

**03 - Booking Started + Chase.** Two entries: the `booking:availability-shown`
tag from the booking agent's flow, or the landing-page widget's name+email
capture. Runs the §1 card guard, then chases anyone who saw availability and did
not book. The chase is short and friction-focused, not a re-sell; they already
saw dates.

**First step removes the contact from itself** (`includeCurrent`). Re-entry into
a workflow a contact is still inside is silently skipped, no error and no alert,
live-proven on Francesca. 03 carries a wait ladder, so without this a card parked
mid-ladder that sees availability again produces nothing, which breaks the No
Show to Booking Started row that 06 depends on.

**04 - Booked + Reminders.** Trigger: appointment confirmed. Removes 01, 03, 06
and 10. Never removes the deposit workflow. Confirmation message, then the
reminder ladder anchored to the appointment, including the day-before yes/no ask
which alerts on a wobble or on silence.

**Its stage write is `if_else`-guarded:** write Booked only from New Lead,
Engaged, Booking Started or No Show. Unguarded it drags a Continuing Treatment
card (position 7) back to Booked (position 4), erasing the tail state 13 worked
to obtain.

**Every appointment-anchored wait carries an `if_else` on whether the anchor is
already past.** A wait whose moment has passed fires immediately and everything
downstream runs at once; the setting is not in the workflow JSON so it cannot be
configured away. Live-proven on Francesca 2026-07-20. Relative waits are the
default.

Not built when the client's diary lives elsewhere. Alevere runs Cliniko, which
already sends 29 of 29 confirmations plus a day-before reminder from its own
sender, and the GHL ladder was explicitly removed there to stop duplicates.

**05 - Reschedule Handler.** Trigger: appointment confirmed AND rescheduled.
Removes 04's instance, resets appointment tags, confirms the new time, restarts
the identical ladder against it, subject to 04's past-anchor rule. A patient
moving from next month to tomorrow must not receive the 3-day, day-before and
morning-of messages within seconds.

**06 - No-Show Recovery.** Enrolled by 08 on a confirmed no-show. Moves the card
to No Show (`allowBackward` not needed; 45 is forward of 40), runs recovery, and
hands a rebook to 03. **Both 04 and 08 remove the contact from 06**, so a staff
correction from No Show to Showed does not leave a "you missed your appointment"
ladder running against someone who attended.

**07 - Cancellation Recovery.** Enrolled deliberately on an insisted cancel, not
off raw calendar status. Removes 04 and 05, regresses the card to Booking Started
on the SAME card with `allowBackward: true`, team ACTION alert because a human
must cancel in the calendar, guarded win-back. On exhaustion writes status Lost
with a reason, restating Booking Started as the stage per §1.

**08 - Outcome Chaser.** **Time-anchored, not status-triggered.** An
appointment-relative wait fires after the appointment, then branches on the
status at that moment: `showed` moves the card to Showed; `noshow` moves it to No
Show and enrols 06; still `confirmed` means nobody dispositioned it, so tag
`needs_disposition` and add to the daily digest to a named owner.

**Gated on current stage:** skip the stage write if the card is already at
Continuing Treatment or beyond. Unguarded, a six-session course oscillates 55 to
50 six times, generating six staff tasks and six stage regressions.

Also runs the sweep: any appointment more than 2 hours past and still
`confirmed`. One daily digest, not one alert per appointment.

**09 - Review Request.** Fires after a confirmed Showed. Shares the attendance
signal with 08 but is not a duplicate and must not be merged: 08 talks to the
CLINIC about the outcome, 09 talks to the PATIENT about their experience.
**Guarded on `review:requested`** so a six-session course does not produce six
review asks. Happy goes to the review link, unhappy raises an internal alert and
never gets a public ask.

No Google Business Profile requirement. `review_request` carries
`overrideReviewLink` and §2 already declares a `review_link` custom value. GBP is
an upgrade, not a gate.

**10 - Stale Opportunity Recovery.** Trigger: `opportunity_decay`, GHL's "Stale
Opportunities". Verified to filter pipeline, stage, inactivity duration, status
and lead value simultaneously, with status operators `==` and `!=` over
`open|won|lost|abandoned`.

**Entry is stage-filtered to stages 1 through 3 only.** Pipeline-wide entry
would let a patient booked five weeks out go quiet for 14 days, match no branch,
and reach the terminal Lost write. Aesthetic consult waits are routinely 3 to 6
weeks. **No unmatched branch may reach a status write.**

Also gated on `nurture:exhausted`, and `decay_days > ladder_length` is a
validated constraint, so a 7-day decay cannot enrol a lead while 01 still has
three touches left.

Branches on the stage the card went stale in: never engaged, talked but never
booked, saw dates and did not take one. Exits on reply, on booking, or writes
Lost with a reason at the card's current stage.

This replaces separate long-term nurture and reactivation. Per-stage decay makes
them one mechanism, and two overlapping systems would both message the same
person. This is the design's single biggest win against the conversion audit,
which found a reactivation layer in all three accounts that functions in none.

**11 - Missed Call Text-Back.** Missed inbound call on the tracked number. One
message, once per 24 hours via `missed-call:cooldown`. A reply wakes the AI.

**12 - AI Escalation + Human Takeover.** Trigger: `ai:human-takeover` or
`ai:cancel-requested`, the tags GHL's own handover actions write.

**Removes the trigger tag as its first step.** `contact_tag` fires on the
`tagsAdded` state change, so re-adding a tag the contact already carries fires
nothing and the second escalation is silent.

**Silences the AI with `update_conversation_ai_status` (`status: inactive`), not
with a tag.** Francesca shipped the tag approach and it was DORMANT: `ai:off`
did not silence the bot and the kill switch was inoperative. Native
auto-hand-back is available via `shouldReactivateAfterTimeOut`.

**Removes the contact from 01, 03, 06, 07 and 10**, which otherwise keep sending
while a human negotiates. `ai:off` alone stops nothing.

**13 - Treatment Progress + Completion.** Triggers: `payment_received` filtered
on product id, and the existence of a next booked appointment. Sets Continuing
Treatment or Done per §1, writes `amount_paid`, repriced `monetaryValue`, and
status Won at Done. Owns the reprice. Also closes on absence: no future
appointment plus N days since last attendance sets Done.

**14 - Buying Signal Escalation.** Trigger: a lead leaning IN, not the AI giving
up. Price question, objection, explicit call request, or a booked lead going
quiet. Routes a named human with context.

Conversion audit F5 and F6 found human attention allocated by chance: converters
received 18 human messages on average, non-converters 0.0, and three staff
notification threads carry 34.6% of all message volume. 12 fires when the AI
surrenders. Nothing today fires when a lead is ready. This is the gap.

**25 - External Booking Status Poll.** For `booking.model = external` only.
Polls the external diary's attendance state (Cliniko exposes
`did_not_arrive` / `patient_arrived`) into GHL appointment status, so stages 5
through 8 can fire at all for that client class. Without it an external-booking
client has no tail.

### Removal matrix

"Kills nurture and chase workflows" is not machine-checkable. This table is, and
it is contract:

| Workflow | Removes |
|---|---|
| 02 - Reply to Engaged | 01 |
| 03 - Booking Started + Chase | 01, and itself (`includeCurrent`) |
| 04 - Booked + Reminders | 01, 03, 06, 10 |
| 05 - Reschedule Handler | 04 |
| 07 - Cancellation Recovery | 04, 05 |
| 08 - Outcome Chaser | 06 (on a Showed correction) |
| 12 - AI Escalation + Human Takeover | 01, 03, 06, 07, 10 |
| 13 - Treatment Progress + Completion | 06, 10 |

### Touch ceiling

A per-contact cap across ALL workflows, enforced by a shared counter field and
checked before every send.

Revision 1 fixed the workflow COUNT and freed every CADENCE, which standardised
what was not the problem. Worst case across 01, 03, 04, 06, 07, 09 and 10 is
about 26 touches. That is the conversion audit's UK figure verbatim ("24 messages
each, front-loaded, then nothing"), and at $1.66 per lead with SMS at 78% it is
$1.30 to $2.20 per lead of pure waste. The blueprint's first design principle is
"reduce automated volume, do not add to it".

### Estate-wide message hygiene

Both are one-field, mechanically checkable, and currently wrong nearly
everywhere:

- **`stopOnResponse: true` on every sending step.** Currently false on 66 of 70
  published workflows, and 15 of 15 at SK.
- **Quiet hours.** Live sends have been observed at 23:22, 23:47, 02:55 and
  03:20.

### What stays a client-level knob

The workflow set, its numbering, the removal matrix, the touch ceiling and the
hygiene flags are fixed. These are set per build from strategy: all message copy,
every wait duration and ladder cadence, the send window, 10's decay threshold,
03's chase delay, the reminder ladder's anchor offsets, alert recipients, the
touch-ceiling number, and 14's escalation criteria.

Relational constraints the validator enforces between knobs:
`decay_days > ladder_length`, and every appointment-anchored wait has a
past-anchor branch.

## 4. AI agent contract

The spec is nominally about pipelines and workflows, but 03's trigger IS the
booking agent and 12 IS an AI workflow, so the agent config is inside the
contract. Each flag has a live failure behind it.

| Requirement | Live failure it prevents |
|---|---|
| Booking agent is a FLOW-BUILDER bot | "showed availability" is otherwise undetectable (§1) |
| `add_contact_tag` immediately before the booking node | the only deterministic Booking Started signal |
| `knowledgeBaseIds` non-empty | Booking Arthur auto-piloted the money moment with none |
| `calendarIds` non-empty on every booking action | all four SK voice actions were empty, so reschedule never worked |
| cancel and reschedule enabled at ACTION level | agent-level is vestigial |
| `sleepEnabled: true` | Francesca's Treatment agent talks over staff who join a thread |
| `autoPilotMaxMessages: 12` | default 100 |
| `updateContactField` action per captured fact | Booking AI otherwise captures nothing (§2) |

## 5. Enforcement

Promotion from Tier-2 to Tier-1, in `grom-client-factory`:

- **`baseline/canonical-model.md`**: the eight stages, the per-campaign pipeline
  rule, Lost-as-status with the stage-restate rule, the standard lost reasons,
  the placement rule with the AI staging exception, and the standard
  tag/value/field sets become Tier-1. §6 "General pipeline stages (Tier-2
  default)... Diverge freely" is deleted.
- **`baseline/core-workflows.md`** is replaced by `baseline/base-workflows.md`:
  fourteen always-on workflows, reserved numbering, per-workflow ownership, the
  removal matrix, and the touch ceiling. "Adapt freely per strategy" goes.
- **`baseline/ai-agent-contract.md`**: new, §4.
- **`baseline/client-manifest.schema.json`**:
  - `pipelines: [{ key, ghl_pipeline_id, funnel_slug, stage_ids{} }]`,
    deprecating the scalar `pipeline_id` and the flat `stage_map`. Today
    `pipeline_id` is a single nullable string and `stage_map` is unscoped, so
    because every pipeline shares the same eight stage names, two pipelines
    collapse into one indistinguishable map. Francesca's live manifest already
    shows this.
  - `lost_reason_ids`, `per_cycle_fields`, `booking.model`, `touch_ceiling`.
  - stage names and base workflow numbers required and constrained.
- **`baseline/validate.mjs`** gains a workflow-JSON pass. `validate.mjs` today is
  a text and JSON scanner, so the two semantic rules revision 1 promised
  ("mirrors a stage into a tag", "places a per-cycle value on the contact") are
  not decidable over prose. Point it at exported workflow JSON, which the factory
  already captures, and assert:

  | Check | Why |
  |---|---|
  | `stopOnResponse: true` on every send | false on 66 of 70 |
  | `monetaryValue` three-part shape | silent blanking |
  | `allowBackward: true` on every regressing write | silent no-op |
  | finder filters on pipeline only | stage filters manufacture duplicates |
  | every not-found branch creates then gotos | 14 of 14 dead-ended at Francesca |
  | appointment-anchored waits have a past-anchor branch | ladder burst |
  | `knowledgeBaseIds` and `calendarIds` non-empty | money moment with no KB |
  | `autoPilotMaxMessages` set | default 100 |
  | `decay_days > ladder_length` | double-chasing |
  | **published AND trigger file non-empty** | the authored-not-deployed gate |
  | `per_cycle_fields` all declared on the opportunity | replaces the undecidable rule |

  The deployment gate matters most: today the validator would pass a build whose
  workflows are all 2-byte-trigger drafts, which is exactly audit F7.

- **`skills/client-design`**: the systems-architect prompt starts FROM the
  standard build and must justify additions rather than designing a pipeline. The
  pipeline-fields role shrinks to client-specific extensions.

The architect keeps freedom over everything the standard build does not name:
copy, cadences, thresholds, calendars, offers, conditional modules, and stages
appended after Done.

## 6. Reporting contract

The template only pays off if the numbers it feeds are true. These are
requirements ON the mart and portal, not on GHL.

1. **Two filters on one table.** Pipeline value and revenue-at-risk filter
   `status = 'open'`; reached counts are status-agnostic. Without this, "£14k
   sitting in Booking Started" includes the dead cards: 100 reach the stage, 60
   go Lost and stay, and a current-stage query returns 60 cards that are all
   written off.
2. **`cycle_index > 1` is excluded from acquisition maths.** Attribution is
   first-touch on the CONTACT, so a returning patient's new card inherits the
   original ad. Ad X at £500 for 10 leads and 4 booked is £125 per booking; three
   returning patients later it reads £71 per booking with zero new spend.
3. **Gross and net no-show both reported.** `furthest_sort = 45` is terminal, so
   a no-show who rebooks and attends leaves the count entirely and 06's recovery
   rate becomes uncomputable. Audit F8 requires both denominators. Also note a
   Continuing Treatment patient who no-shows a later appointment has current
   stage 45 but furthest 55, so they count as Showed: the most expensive no-show
   is currently invisible.
4. **Coverage pairing on the tail**, using the speed-to-lead pattern already
   live. "Outcome recorded for 4 of 29 appointments", never a silent zero.
   Otherwise a rotted tail reports £0 revenue forever, which is SK's current
   state.
5. **The Engaged rung needs a stated definition.** It is set only by a reply, and
   the landing-page path skips it. With cumulative `furthest_sort >= step`
   counting, 100 LP leads and 100 form leads of which 12 reply reports 56%
   Lead-to-Engaged against a true 6% reply rate, and the overstatement moves with
   traffic mix. Either report Engaged as "replied at least once" computed from
   conversations, or label it explicitly as reply-or-self-serve.
6. **Stage regressions need event history.** 07 regresses Booked to Booking
   Started and 06 regresses No Show to Booking Started. Under hourly polling the
   reconcile sees only the current stage, so `furthest_sort` recomputes DOWNWARD
   and booked counts fall between polls; a cancel-and-rebook inside one hour is
   never observed. This needs the pending stage-change webhooks, or `furthest_sort`
   must be monotonic by construction.
7. **Rename one of the two `booking_started` labels.** The LP event and the stage
   are different populations roughly 3x apart (§1). Reporting both under one name
   in one client report is indefensible.
8. **Stage UUID discovery, not hand-seeded SQL.** Fixed stage names make this
   templatable; three campaigns per client otherwise means 24 UUIDs to seed by
   hand, which is the manual step the config layer exists to remove.

## 7. Open items, needing a live test not an opinion

1. **Does `opportunity_decay` fire once or repeatedly, and can it loop?**
   `lastActionDate` is not projected by the v3 read API, so it is unclear what
   resets it. PLAUSIBLE: the condition is permanently true once crossed, so with
   re-entry on, a card whose `lastActionDate` never advances re-enrols
   indefinitely and the only guaranteed loop-breaker is 10's Lost exit. Test: one
   draft decay workflow on a throwaway pipeline, threshold 1 day, one untouched
   card, read workflow logs daily for a week. **This gates 10.**
2. **What does `find_opportunity`'s `sorting: "latest"` sort on**, `createdAt` or
   `updatedAt`? Decides whether a returning Done-then-new-card contact resolves
   to the right card. **This gates the two-card design.**
3. **When does `appointmentBooking.triggerWorkflow` fire**, on slot presentation
   or only on a completed booking? The field pair exists live on AUS action
   `8SonAXmPh6IOyBQOgdxp` but is off. If it fires on presentation it closes §1's
   flow-bot requirement with something simpler.
4. **Does `internal_update_opportunity` accept `lostReasonId`?** If yes, the
   per-stage-branched Lost write collapses to a single step.
5. **Do the dashboard and portal read opportunity STATUS?** Unresolved; §6 items
   1 and 2 depend on it, and `grom-dashboard` is not on this drive.
6. **Is `Done` addable to `CANONICAL_SORT`, and what sort value?** `treatment` is
   55 and `terms_sent` is 60, leaving only 56 to 59. Appended client stages map
   to NULL, which means "kept, excluded from funnel", so the one extension point
   this spec permits is invisible to reporting. Reserve sort space deliberately.

## 8. Rejected alternatives

- **One pipeline per sellable product.** Multiplies the workflow set per pipeline
  and gives the portal a funnel per treatment.
- **A Lost stage.** Loses the drop-off point, which is the most useful thing the
  funnel can tell a client.
- **Dropping the Booking Started rung.** Collapses "was offered dates and
  refused" together with "asked one question and went quiet", which are a
  friction problem and an interest problem.
- **The AI classifying its own handoff intent.** Correctness would depend on the
  LLM, which has already failed here: every Francesca fix that landed was a
  config flag or a workflow step, and every fix attempted through prompt wording
  failed. Both bots were observed violating their own explicit prompt rules
  verbatim.
- **A prompt-based booking agent.** Cannot emit a deterministic
  "showed availability" signal (§1).
- **Driving the pipeline tail off appointment status.** This was revision 1's
  design. Measured at roughly 3% coverage across three accounts.
- **Separate long-term nurture and reactivation workflows.** Per-stage decay
  makes them one mechanism.
- **Mirroring a value across a contact field and a tag.** Two sources of truth
  for one fact. The AI staging slot in §2 is the single sanctioned exception, and
  it is one-way and write-only.
- **Semantic validator rules over prose docs.** Not decidable; replaced with
  declared `per_cycle_fields` plus workflow-JSON assertions.
