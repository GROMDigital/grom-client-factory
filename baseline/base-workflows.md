# Base Workflows (Tier-1 contract)

Fourteen always-on workflows, plus reserved numbers for conditional modules.
Same number always means the same job, which is what makes "check 07 at every
account" a meaningful instruction and a cross-client build diff readable.

**Changed 2026-07-26 (the Standard Build).** This file replaces
`baseline/core-workflows.md`, which was a Tier-2 "core six, adapt freely" spine.
The workflow set, its numbering, the removal matrix, the touch ceiling and the
hygiene flags are now hard contracts. The architect starts FROM this set and must
justify additions; it may not redesign it. Applies to NEW builds; existing
clients (Francesca, SK Skin, Alevere) do not migrate.

Naming stays flat chronological: `01 Name` .. `NN Name`, no folders. Every
internal and client notification is a step INSIDE its triggering workflow, never
a standalone notification workflow. Read with `baseline/canonical-model.md`,
which owns the stages, the data placement rule, and the standard tag/field/value
sets this file writes to.

## 1. The set

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

## 2. Numbering: reserved, gaps allowed

Each workflow owns its number for life. A client without deposits has no
20-series at all, and that gap is information rather than a mistake. Clients add
new workflows at unused numbers and never renumber the base set, never reuse a
reserved number for a different job, and never close a gap to make the list
tidy.

## 3. Shared build rules

These are not properties of one workflow. Every workflow that touches an
opportunity obeys them, and the validator checks them against exported workflow
JSON.

### 3.1 The one-card-per-cycle guard

A cycle is one decision to buy. A reschedule, a cancellation and a no-show all
happen INSIDE an unfinished cycle, so they reuse the same card. A new card is
minted only when the previous one reached a terminal state and the person comes
back later as a new decision.

🔴 **BOTH `01 - Lead Intake + Chase` and `03 - Booking Started + Chase` run this
guard.** Putting it in 03 alone is a defect: 01 is the highest-volume entry
point, and without the guard a patient who books via the landing page and then
clicks a retargeting ad gets a second card at New Lead plus a chase ladder aimed
at someone with an appointment tomorrow.

| Card's current state | What is happening | Do |
|---|---|---|
| New Lead | genuine progression | move to Booking Started |
| Engaged | genuine progression | move to Booking Started |
| Booking Started | already there | nothing; do not restart the chase |
| Booked | reschedule | leave it; `05 - Reschedule Handler` owns it |
| No Show | rebooking after missing | move back to Booking Started, same card |
| Continuing Treatment | next appointment in the same course | leave the stage; `04 - Booked + Reminders` handles the appointment |
| Done | finished, now back again | NEW card at Booking Started, `cycle_index` incremented |
| Lost | written off, now back again | NEW card at Booking Started, `cycle_index` incremented |
| no card at all | walked in cold | create at New Lead, advance to Booking Started |

Only Done and Lost mint a second card, so a cancel-then-rebook cannot
double-count.

### 3.2 The five rules the guard depends on

Each has a live failure behind it. All five are validator-checkable.

1. **Find on pipeline only, then `if_else` on the stage.** `find_opportunity`
   has one filter field, and every observed sample across the estate filters on
   `pipeline_id` with `sorting: "latest"`. A stage-filtered finder returns Not
   Found for a card that exists at a different stage, and rule 2 then creates a
   duplicate, which is the exact card explosion this guard exists to prevent.
   Branching on stage is runtime-proven, with the trap that `conditionType:
   opportunity` singular, or `pipeline_stage_id` in snake_case, fails silently.
2. **Every not-found branch creates the card and then jumps back to the found
   path's first step.** Otherwise the rest of the workflow runs against nothing.
   Francesca had 14 of 14 dead-ended.
3. **Every backward stage move carries `allowBackward: true`.** The default is
   false in 100% of the corpus, and without it the move silently no-ops. This
   design has at least four backward moves: No Show to Booking Started, 07's
   regression, Booked entered from No Show, and the terminal re-entry paths.
4. **`monetaryValue` needs three parts, not one:** `value` as a NUMBER,
   `valueFieldType: "numerical"`, AND `dataType: "NUMERICAL"`. Written as a
   string the value is stored and does apply at runtime; what breaks is the
   builder render, and the real hazard is that editing and saving such a node
   blanks it.
5. **Name the "allow multiple opportunities" setting explicitly, per workflow.**
   Off, and a second card's opportunity-triggered enrolment is silently dropped,
   so a stale card is never chased by 10. On, and every opportunity-triggered
   workflow doubles for anyone holding two cards. Also note `{{opportunity.*}}`
   resolves against the run's associated card, so a team alert built on
   `{{opportunity.lead_value}}` can quote the dead card's value.

### 3.3 Opportunity merge tags

`{{opportunity.<field_key>}}` resolves when the workflow has an opportunity
trigger **OR** contains a find/create-opportunity action. Both halves matter.
Every workflow spec states which half it relies on. `10 - Stale Opportunity
Recovery` triggers on `opportunity_decay` and therefore already resolves, so
adding a finder there would be gratuitous, and it is the one workflow where a
second card makes finders a coin flip.

### 3.4 Appointment-anchored waits

**Every appointment-anchored wait carries an `if_else` on whether the anchor is
already past.** A wait whose moment has passed fires immediately and everything
downstream runs at once. The setting is not in the workflow JSON, so it cannot
be configured away. Live-proven on Francesca 2026-07-20. Relative waits are the
default. This binds 04, 05, 08 and 09.

### 3.5 Re-entry

Re-entry into a workflow a contact is still inside is silently skipped: no
error, no alert. Live-proven on Francesca. Any workflow carrying a wait ladder
that a contact can legitimately re-enter must remove the contact from ITSELF as
its first step (`includeCurrent`). This binds 03 explicitly, and any client
extension with the same shape.

### 3.6 Writing Lost

The only picker-visible opportunity action requires BOTH `pipeline_id` and
`pipeline_stage_id`, and `lostReasonId` exists only on that interface. So a
naive "set Lost" step relocates every dying card to one hardcoded stage and
destroys the drop-off reporting the whole model rests on.

🔴 **Every Lost write restates the card's CURRENT stage, which means every
Lost-setting workflow is per-stage branched.** Every automated Lost write also
sets one of the standard lost reasons from `canonical-model.md` §8. 07 and 10
are the only workflows that write Lost.

## 4. What each workflow owns

### 01 - Lead Intake + Chase

Trigger: lead form submitted, one trigger per form. Runs the §3.1 card guard,
stamps `funnel:<slug>`, copies the AI staging fields one-way onto the card, sets
the initial opportunity value, fires the internal new-lead alert, sends the
instant first message inside the send window, then runs the chase ladder. The
ladder lives INSIDE this workflow. Ends with `nurture:exhausted`. Goals end it
on reply or on booking.

### 02 - Reply to Engaged

Trigger: customer replied, any channel. Guarded to once per contact. Moves New
Lead to Engaged, removes the contact from 01's ladder, wakes the primary AI,
fires the internal engaged alert. Silent to the lead.

### 03 - Booking Started + Chase

Two entries: the `booking:availability-shown` tag written by the booking agent's
flow, or the landing-page widget capturing name and email. Runs the §3.1 card
guard, then chases anyone who saw availability and did not book. The chase is
short and friction-focused, not a re-sell; they already saw dates.

**First step removes the contact from itself** (`includeCurrent`, §3.5). Without
it, a card parked mid-ladder that sees availability again produces nothing,
which breaks the No Show to Booking Started row that 06 depends on.

### 04 - Booked + Reminders

Trigger: appointment confirmed. Removes 01, 03, 06 and 10. **Never removes the
deposit workflow.** Sends the confirmation, then the reminder ladder anchored to
the appointment, including the day-before yes/no ask, which alerts on a wobble
or on silence.

**Its stage write is `if_else`-guarded: write Booked only from New Lead,
Engaged, Booking Started or No Show.** Unguarded it drags a Continuing Treatment
card (position 7) back to Booked (position 4), erasing the tail state 13 worked
to obtain. Entering from No Show is a backward move and needs `allowBackward`
(§3.2 rule 3).

Every wait obeys §3.4.

Not built when the client's diary lives elsewhere (`booking.model = external`).
Alevere runs Cliniko, which already sends 29 of 29 confirmations plus a
day-before reminder from its own sender, and the GHL ladder was explicitly
removed there to stop duplicates.

### 05 - Reschedule Handler

Trigger: appointment confirmed AND rescheduled. Removes 04's instance, resets
the appointment tags, confirms the new time, and restarts the identical ladder
against it, subject to §3.4. A patient moving from next month to tomorrow must
not receive the 3-day, day-before and morning-of messages within seconds.

Not built when `booking.model = external`.

### 06 - No-Show Recovery

Enrolled by 08 on a confirmed no-show. Moves the card to No Show (`allowBackward`
not needed; sort 45 is forward of 40), runs the recovery ladder, and hands a
rebook to 03.

**Both 04 and 08 remove the contact from 06**, so a staff correction from No Show
to Showed does not leave a "you missed your appointment" ladder running against
someone who attended.

### 07 - Cancellation Recovery

Enrolled deliberately on an insisted cancel, not off raw calendar status.
Removes 04 and 05, regresses the card to Booking Started on the SAME card with
`allowBackward: true`, fires a team ACTION alert (a human must cancel in the
calendar), then runs a guarded win-back. On exhaustion it writes status Lost
with a reason, restating Booking Started as the stage per §3.6.

### 08 - Outcome Chaser

🔴 **Time-anchored, not status-triggered.** An appointment-relative wait fires
after the appointment, then branches on the status at that moment: `showed`
moves the card to Showed; `noshow` moves it to No Show and enrols 06; still
`confirmed` means nobody dispositioned it, so it tags `needs_disposition` and
adds the appointment to the daily digest.

Anchoring to status Showed would mean it cannot fire for exactly the cards that
rot. Attendance status is unreliable on every account measured: AUS calendar
`ZI3orrwqgNebxtzoUgyA` had 7 events, 1 `showed`, 2 `noshow` and 4 still
`confirmed` with past start dates; roughly 20 of 60 past-dated UK events are
still `confirmed`. Waits support hours; `if_else` on dates is day-granular, so
the wait does the anchoring.

**Gated on the current stage: skip the stage write if the card is already at
Continuing Treatment or beyond.** Unguarded, a six-session course oscillates
55 to 50 six times, generating six staff tasks and six stage regressions.

Also runs the sweep for any appointment more than 2 hours past and still
`confirmed`, and chases the manual tail (§4, 13). Both go out as ONE daily
digest to a NAMED owner, never one alert per appointment. SK's clinic
notification address opted itself out of its own internal alert stream on
2026-06-23, and SK's 3 staff notification threads carry 1,222 of 3,531 messages,
so a per-event chaser aimed at that channel is aimed at nothing.

### 09 - Review Request

Fires after a confirmed Showed. It shares the attendance signal with 08 but is
not a duplicate and **must not be merged into it**: 08 talks to the CLINIC about
the outcome, 09 talks to the PATIENT about their experience.

**Guarded on `review:requested`**, so a six-session course does not produce six
review asks. Happy goes to the review link; unhappy raises an internal alert and
never gets a public ask.

No Google Business Profile requirement. `review_request` carries
`overrideReviewLink`, and `review_link` is a standard custom value. GBP is an
upgrade, not a gate.

### 10 - Stale Opportunity Recovery

Trigger: `opportunity_decay` (GHL's "Stale Opportunities"). Verified to filter
pipeline, stage, inactivity duration, status and lead value simultaneously, with
status operators `==` and `!=` over `open|won|lost|abandoned`.

🔴 **Entry is stage-filtered to stages 1 through 3 only.** Pipeline-wide entry
would let a patient booked five weeks out go quiet for 14 days, match no branch,
and fall through to the terminal Lost write. Aesthetic consult waits are
routinely 3 to 6 weeks. **No unmatched branch may reach a status write.**

Also gated on `nurture:exhausted`. `decay_days > ladder_length` is a validated
constraint, so a 7-day decay cannot enrol a lead while 01 still has three
touches left.

Branches on the stage the card went stale in: never engaged, talked but never
booked, saw dates and did not take one. Exits on reply, on booking, or writes
Lost with a reason at the card's current stage (§3.6).

⚠️ **The reply exit must WRITE to the card.** `opportunity_decay` re-fires at
multiples of the duration until the card is updated, and a reply alone does not
touch the card. Without a write on the reply exit, 10 re-chases the same person
forever. See `canonical-model.md` and the spec's open items.

This replaces separate long-term nurture and reactivation workflows. Per-stage
decay makes them one mechanism, and two overlapping systems would both message
the same person. It is the design's single biggest win against the conversion
audit, which found a reactivation layer in all three accounts that functions in
none.

### 11 - Missed Call Text-Back

Trigger: missed inbound call on the tracked number. One message, at most once per
24 hours via `missed-call:cooldown`. A reply wakes the primary AI.

### 12 - AI Escalation + Human Takeover

Trigger: `ai:human-takeover` or `ai:cancel-requested`, the exact tags GHL's own
`humanHandOver` actions write.

**Removes the trigger tag as its first step.** `contact_tag` fires on the
`tagsAdded` state change, so re-adding a tag the contact already carries fires
nothing and the second escalation is silent.

🔴 **Silences the AI with `update_conversation_ai_status` (`status: inactive`),
not with a tag.** Francesca shipped the tag approach and it was DORMANT: `ai:off`
did not silence the bot, and the kill switch was inoperative. Native hand-back is
available via `shouldReactivateAfterTimeOut`.

**Removes the contact from 01, 03, 06, 07 and 10**, which otherwise keep sending
while a human negotiates.

### 13 - Treatment Progress + Completion

Owns the pipeline tail: Continuing Treatment and Done.

🔴 **The tail is primarily MANUAL, and the design must not pretend otherwise.**
Grom's data ends at booking. The clinic takes treatment payment on its own
system, so `payment_received` is not available as the tail's driver at a
standard client. Stages 7 and 8 are human stage-moves, chased by
`08 - Outcome Chaser`, and the portal reports coverage ("outcome recorded for 4
of 29") rather than a silent zero.

What 13 automates without payment data:

1. **A next booked appointment implies Continuing Treatment.** This is a
   by-product of booking, not admin, so it is reliable.
2. **Absence closes the tail.** No future appointment plus N days since the last
   attendance sets Done and status Won.

Both writes are stage-guarded the same way 08's are, so a course in progress is
never dragged backwards.

**Payment-driven advancement is a client-level knob, off by default.** Turn it on
only for a client who genuinely takes treatment payment inside the system. When
on, 13 additionally triggers on `payment_received` filtered on product id, writes
`amount_paid`, and owns the reprice: the card's `monetaryValue` becomes the amount
actually paid, per the three-part rule in §3.2. When off, the card keeps the
campaign's advertised offer price and the reporting layer must label it as an
advertised price, not realised revenue. A £99 advertised intro against a £2,400
course purchase is a 96% understatement, so this distinction is not cosmetic.

Removes the contact from 06 and 10.

### 14 - Buying Signal Escalation

Trigger: a lead leaning IN, not the AI giving up. A price question, an objection,
an explicit call request, or a booked lead going quiet. Routes a NAMED human with
context.

Conversion audit F5 and F6 found human attention allocated by chance: converters
received 18 human messages on average, non-converters 0.0, and three staff
notification threads carry 34.6% of all message volume. 12 fires when the AI
surrenders. Nothing today fires when a lead is ready. That is the gap this
closes.

### 20 - Deposit Link + Chase, 21 - Deposit Paid Handler, 22 - Unpaid Slot Guard

Built only when the client takes a booking deposit. 20 sends the payment link and
chases it via `deposit:link-sent`; 21 handles the paid state; 22 releases or
guards a held slot that was never paid for. No other workflow may remove a
contact from the 20-series (see §5).

⚠️ **20's trigger depends on which Booking Started path this client actually
uses**, and the two paths are not equivalent here. Off the flow-bot path, a slot
selection is a real event and 20 fires from it. Off the LP-widget path
(name + email capture), there is no slot selection at all, so a build whose ONLY
confirmed path is the widget has nothing to trigger 20. Name 20's trigger
explicitly per build; do not assume a slot event exists. If the client is also
external-booking, see §4A.

### 25 - External Booking Status Poll

For `booking.model = external` only. Polls the external diary's attendance state
(Cliniko exposes `did_not_arrive` and `patient_arrived`) into GHL appointment
status, so stages 5 through 8 can fire at all for that client class. Without it,
an external-booking client has no tail.

### 30 - Patient Recall / Win-Back

Reserved, not built. The number is held so that no client's recall workflow lands
somewhere else.

### 40 - Speed-to-Lead Outbound Call

Voice AI clients only. Outbound call attempt on a new lead, wrapped back into the
01 ladder on no-answer via `speed:retry-done`.

## 4A. When the diary lives elsewhere (`booking.model = external`)

Removing 04 and 05 removes more than a reminder ladder. 04 owns three jobs that
do not disappear with it, and this section names where they go. **Added
2026-07-27 after the first build on this path exposed all three as unstated.**

### 4A.1 Who writes the Booked stage

04 is the default writer. When it is not built, the substitute is **the workflow
that receives this client's only in-system signal that a booking is real.**

- Deposit-taking client: **`21 - Deposit Paid Handler`**. Deposit receipt is the
  signal, and 21 is already triggered by it.
- No deposit: there may be NO in-system signal at all, in which case Booked is a
  human stage-move and the build must say so out loud rather than leave the
  stage unreachable.

🔴 **The substitute inherits 04's build rules with the job. State them on the
substitute, do not leave them behind on the workflow that was not built:**

1. **The stage write is `if_else`-guarded**: write Booked only from New Lead,
   Engaged, Booking Started or No Show. Unguarded it drags a Continuing Treatment
   card back to Booked and erases the tail state 13 worked to obtain.
2. **The No-Show-origin branch carries `allowBackward: true`** (§3.2 rule 3), or
   that move silently no-ops.
3. **The substitute also inherits 04's removal-matrix row**: it removes 01, 03,
   06 and 10. Without this a contact whose booking is real keeps receiving the
   chase ladders forever, which is the single worst failure on this path.

### 4A.2 The day-before confirmation ask

04 owns it. With 04 absent it has NO owner, and it is a mechanism policy every
build is required to fix concretely, so it cannot simply be dropped in silence.

Resolve it explicitly per build, in this order of preference:

1. **The external system already sends one.** Confirm it, and record that it is
   theirs. Duplicating it is worse than not having one: Alevere's GHL ladder was
   removed for exactly this reason.
2. **It is not sent at all**, accepted deliberately, recorded as accepted.
3. **A client-specific workflow at an unused number.** Never a reserved one.

An unanswered day-before ask is a `{{FILL_*}}` token and an open question, never
an assumption in either direction.

### 4A.3 Tags 04 would have written

`appt:confirmed-yes` is written by 04's day-before ask. With 04 absent nothing
writes it, so it is NOT present at this client unless 4A.2 resolves to option 3
and that workflow writes it. A tag declared always-present that nothing writes is
a defect, the same as a tag with no consumer.

## 5. Removal matrix

"Kills nurture and chase workflows" is not machine-checkable. This table is, and
it is contract.

| Workflow | Removes |
|---|---|
| 02 - Reply to Engaged | 01 |
| 03 - Booking Started + Chase | 01, and itself (`includeCurrent`) |
| 04 - Booked + Reminders | 01, 03, 06, 10 |
| 05 - Reschedule Handler | 04 |
| 07 - Cancellation Recovery | 04, 05 |
| the 04 substitute under `booking.model = external` (§4A.1) | 01, 03, 06, 10 |
| 08 - Outcome Chaser | 06 (on a Showed correction) |
| 12 - AI Escalation + Human Takeover | 01, 03, 06, 07, 10 |
| 13 - Treatment Progress + Completion | 06, 10 |

🔴 **Nothing removes a contact from the 20-series.** A deposit chase must survive
every other workflow's cleanup, or the client stops getting paid.

## 6. Touch ceiling

A per-contact cap across ALL workflows, enforced by a shared counter field and
checked before every send.

Fixing the workflow COUNT while leaving every CADENCE free standardises what was
not the problem. The worst case across 01, 03, 04, 06, 07, 09 and 10 is about 26
touches. That is the conversion audit's UK figure verbatim ("24 messages each,
front-loaded, then nothing"), and at $1.66 per lead with SMS at 78% of cost it is
$1.30 to $2.20 per lead of pure waste. The blueprint's first design principle is
to reduce automated volume, not add to it.

The ceiling NUMBER is a client-level knob. Having one is not.

## 7. Estate-wide message hygiene

Both are one-field, mechanically checkable, and currently wrong nearly
everywhere.

- **`stopOnResponse: true` on every sending step.** Currently false on 66 of 70
  published workflows across the estate, and on 15 of 15 at SK.
- **Quiet hours on every ladder.** Live sends have been observed at 23:22, 23:47,
  02:55 and 03:20.

## 8. What stays a client-level knob

Fixed by this file: the workflow set, its numbering, the removal matrix, the
touch ceiling's existence, the hygiene flags, and every build rule in §3.

Set per build from strategy: all message copy, every wait duration and ladder
cadence, the send window and quiet hours, 10's decay threshold, 03's chase delay,
04's reminder anchor offsets, alert recipients, the touch-ceiling number, 13's
absence-close window and its payment knob, and 14's escalation criteria.

Relational constraints the validator enforces between knobs:
`decay_days > ladder_length`, and every appointment-anchored wait has a
past-anchor branch.

## 9. What the validator asserts against exported workflow JSON

Listed here so the architect designs to it. The checks themselves live in
`baseline/validate.mjs`.

| Check | Why |
|---|---|
| `stopOnResponse: true` on every send | false on 66 of 70 |
| `monetaryValue` three-part shape | silent blanking on the next UI save |
| `allowBackward: true` on every regressing write | silent no-op |
| finder filters on pipeline only | stage filters manufacture duplicates |
| every not-found branch creates then gotos | 14 of 14 dead-ended at Francesca |
| appointment-anchored waits have a past-anchor branch | ladder burst |
| `decay_days > ladder_length` | double-chasing |
| every Lost write restates the current stage | otherwise drop-off reporting dies |
| under `booking.model = external`, the 04 substitute carries the stage-origin guard, `allowBackward`, and 04's removal row | §4A.1; without the removal row a booked contact is chased forever |
| **published AND trigger file non-empty** | the authored-not-deployed gate |

The deployment gate matters most: without it the validator passes a build whose
workflows are all 2-byte-trigger drafts, which is exactly audit F7.
