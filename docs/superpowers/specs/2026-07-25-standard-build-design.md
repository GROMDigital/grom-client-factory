# The Standard Build

Design doc. 2026-07-25.

## Why

Today every client build is designed from scratch against its own strategy. The
factory's baseline exists, but almost all of it is Tier-2 ("defaults, adapt
freely"): stage names, workflow sets, and field choices are re-decided per
client. Three consequences:

1. Nothing is comparable. "Check workflow 07 at every account" is meaningless
   because 07 is a different workflow at each one.
2. Tracking is hand-wired. The portal and dashboard have to be taught each
   client's stage names and tag spellings.
3. Design cost is paid repeatedly for decisions that never actually varied.

The convergence point already exists and is already written down. Every clinic
runs the same journey: ad, form, engage, book, attend, treat. The canonical
funnel steps in `baseline/canonical-model.md` encode exactly that. What is
missing is the promotion: those steps are a *mapping target* today, and this
design makes them the stages themselves.

## Scope

In scope: the pipeline, the base workflow set, and the rule for where data
lives. This is a contract document plus the baseline and validator changes that
enforce it.

Out of scope, each its own later spec:

- Folding `reference/lp-library/` into the factory as a build step. Landing
  pages are currently excluded on purpose (`baseline/doc-set-template.md`);
  reversing that is a separate design.
- The factory process revamp: strategy-analysis front door, ingesting
  onboarding-form answers, human gate placement, and the agent-output quality
  problem.

Both consume this document, which is why it goes first.

## 1. Pipelines

### One pipeline per campaign/offer

A pipeline exists for each distinct ad funnel: its own lead form, its own
landing page, its own booking calendar. Not per product, and not per treatment.

A fifteen-treatment menu sold through one consultation funnel is ONE pipeline.
Treatment interest is a field on the card, not a pipeline.

Two ad funnels selling genuinely different things (a course and a treatment)
are two pipelines, with the same stages in each.

Rationale: per-product would multiply the whole workflow set per pipeline and
give the portal fifteen funnels to render. Per campaign/offer matches the unit
the ads and the reporting already use.

### Eight stages, fixed

Identical at every client. Clients may APPEND stages after Done. They may never
rename, reorder, or remove these.

| # | Stage | Set by | Canonical step |
|---|---|---|---|
| 1 | New Lead | 01 - Lead Intake + Chase on form submit; 03 - Booking Started + Chase on landing-page name+email capture | `lead` (10) |
| 2 | Engaged | 02 - Reply to Engaged on first reply | `engaged` (20) |
| 3 | Booking Started | 03 - Booking Started + Chase | `qualified` (30) |
| 4 | Booked | 04 - Booked + Reminders on appointment confirmed | `booked` (40) |
| 5 | No Show | 06 - No-Show Recovery on appointment status No Show | `no_show` (45) |
| 6 | Showed | 08 - Outcome Chaser on appointment status Showed | `showed` (50) |
| 7 | Continuing Treatment | human, chased by 08 - Outcome Chaser | `treatment` (55) |
| 8 | Done | human, chased by 08 - Outcome Chaser; sets status Won | `done`, NEW, see §5 |

The stage is named **Booking Started**, not Qualified, and maps to the existing
`qualified` canonical step at sort 30. Nothing downstream needs relabelling.

### Booking Started is an event, not a judgement

"Qualified" was undetectable because it was a judgement call. Booking Started
has one definition: **this person saw real availability.** Reached two ways:

- The booking AI presented dates.
- Someone started the booking widget on the landing page and gave name +
  email.

`booking_started` is already one of the five canonical LP event names, so the
stage and the tracking event agree by construction.

The landing-page path creates the card at New Lead and advances it to Booking
Started in the same run. Handing over name and email IS the lead moment, so
this is not a fabricated step, and it keeps the funnel monotonic. Cards
appearing straight at Booking Started would give the portal fewer leads than
bookings-started, which reads as a broken chart.

Side effect worth naming: people who gave name and email on the landing page
and never picked a slot are currently invisible. Under this they sit in Booking
Started and 03's chase picks them up.

### Death is a status, not a stage

There is no Lost stage. A dead lead gets opportunity status **Lost** plus
GHL's **native lost reason**, and the card stays in the stage where it died.
So "60% die at Booking Started" is directly readable, instead of one
undifferentiated Lost column.

`Done` sets status **Won**.

Do not create a custom lost-reason field. GHL's is native, is a merge tag, and
is already a filter on the stale-opportunity trigger.

### One card per cycle

A cycle is one decision to buy. A reschedule, a cancellation, and a no-show all
happen INSIDE an unfinished cycle, so they reuse the same card. A new card is
minted only when the previous one reached a terminal state and the person comes
back later as a new decision.

This is the guard 03 - Booking Started + Chase runs on entry:

| Card's current state | What's happening | 03 does |
|---|---|---|
| New Lead | genuine progression | move to Booking Started |
| Engaged | genuine progression | move to Booking Started |
| Booking Started | already there | nothing; do not restart the chase |
| Booked | reschedule | leave it; 05 - Reschedule Handler owns it |
| No Show | rebooking after missing | move back to Booking Started, same card |
| Continuing Treatment | next appointment in the same course | leave it; 04 - Booked + Reminders handles it |
| Done | finished, now back again | NEW card at Booking Started |
| Lost | written off, now back again | NEW card at Booking Started |
| no card at all | walked in cold | create at New Lead, advance to Booking Started |

Only Done and Lost mint a second card. Everything else reuses, so a
cancel-then-rebook cannot double-count in the funnel.

Two build rules that follow, both of which have caused live bugs before:

- Every not-found branch must create the card and then jump back to the found
  path's first step. Otherwise the rest of the workflow runs against nothing.
- Once a person can hold two cards, no find-opportunity step may rely on
  latest-wins. Every finder sets its pipeline and stage filters explicitly.

### The pipeline tail is chased, not assumed

Booked, No Show, and Showed are driven off GHL appointment status, which clinic
staff do touch even when they never open the opportunities tab.

Continuing Treatment and Done have no equivalent signal. Nothing in GHL fires
when a patient finishes a course. So the template ships **08 - Outcome
Chaser**, which asks the clinic for the outcome after the appointment (staff
task plus reminder) rather than leaving cards to rot in Showed. Shipping the
stages without the chaser would give every client a growing silent pile and a
portal funnel that flatlines after the appointment.

## 2. Where data lives

One rule, applied everywhere. The failure mode being prevented is the same fact
stored twice and then drifting.

| Holder | Holds | Test |
|---|---|---|
| **Stage** | where they are | one source of truth; never mirrored into a tag or field |
| **Opportunity (card) field** | facts about THIS cycle | treatment wanted, budget accepted, cycle-specific references |
| **Contact (person) field** | facts about the human that do not change per cycle | suburb, date of birth |
| **Tag** | a flag, or something a workflow must trigger on | binary; carries no value |
| **Custom value** | one constant for the whole account | never hardcode these in copy |

Per-cycle data belongs on the card, because a rebook mints a new card and so
keeps its own answer. A contact field would be overwritten by the second cycle.

**Opportunity custom fields DO merge into copy** as
`{{opportunity.<field_key>}}`. Verified live on AUS `wdzEoUZnXO9tB3PPzcot` and
already in production use in Grom's own onboarding emails
(`{{opportunity.strategy_approve_url}}`, `{{opportunity.package}}`,
`{{opportunity.service_line}}`, and others).

**Build rule:** a workflow can only resolve `{{opportunity.*}}` if it contains
a find-opportunity or create-opportunity step, which attaches the card to the
run. Without it the placeholders render blank. Most base workflows carry one
anyway to move the stage, so this is nearly free, but it silently ships broken
copy when missed. Every workflow spec states whether it attaches a card.

### Standard custom values

Referenced by merge tag, never hardcoded. Swapping a client's AI name or sender
identity is then a one-field edit.

`ai_primary_name`, `ai_booking_name`, `business_name`, `business_phone`,
`business_address`, `from_name`, `from_email`, `booking_url`, `review_link`.

### Standard tags

Namespaced, lowercase, colon-separated. Extend per client with the same
`namespace:value` shape; never respell an existing one.

Always present: `funnel:<slug>`, `nurture:exhausted`, `ai:off`,
`ai:escalated`, `appt:confirmed-yes`, `missed-call:cooldown`,
`review:requested`.

Conditional: `deposit:link-sent`, `speed:retry-done`.

No tag mirrors a stage. No tag holds a value.

### Standard opportunity fields

`treatment_interest`. Anything else per-cycle a client's strategy needs goes
here rather than on the contact.

Lost reason is GHL-native; do not add a field for it.

### Card naming

Cards are named `<Treatment> - <Full Name>`, for example `Botox - Jane Smith`.
This is for board readability, independent of merging: the default leaves a
board of identically named cards.

## 3. Base workflow set

Twelve always-on, plus reserved numbers for conditional modules.

| # | Workflow | Present |
|---|---|---|
| 01 | Lead Intake + Chase | always |
| 02 | Reply to Engaged | always |
| 03 | Booking Started + Chase | always |
| 04 | Booked + Reminders | always |
| 05 | Reschedule Handler | always |
| 06 | No-Show Recovery | always |
| 07 | Cancellation Recovery | always |
| 08 | Outcome Chaser | always |
| 09 | Review Request | always |
| 10 | Stale Opportunity Recovery | always |
| 11 | Missed Call Text-Back | always |
| 12 | AI Escalation + Human Takeover | always |
| 20 | Deposit Link + Chase | deposits only |
| 21 | Deposit Paid Handler | deposits only |
| 22 | Unpaid Slot Guard | deposits only |
| 30 | Patient Recall / Win-Back | reserved, not built |
| 40 | Speed-to-Lead Outbound Call | voice AI only |

### Numbering: reserved, gaps allowed

Each workflow owns its number for life. A client without deposits simply has no
20-series, and that gap is information. Same number always means the same job,
so cross-client checks and build diffs work. Strict sequential renumbering was
rejected: it makes "07" mean a different workflow at each account, which
destroys the reason for templating.

Clients add workflows at unused numbers. They never renumber the base set.

### What each one owns

**01 - Lead Intake + Chase.** Trigger: lead form submitted, one trigger per
form. Creates the card at New Lead, stamps `funnel:<slug>` and cycle fields,
internal new-lead alert, instant first message inside the send window, then the
chase ladder. The chase ladder lives INSIDE this workflow, not in a separate
one. Ends `nurture:exhausted`. Goals end it on reply or booking.

**02 - Reply to Engaged.** Trigger: customer replied, any channel. Guarded once
per contact. Moves New Lead to Engaged, removes them from 01's ladder, wakes
the primary AI, internal engaged alert. Silent to the lead.

**03 - Booking Started + Chase.** Two entries: the booking AI presented dates,
or the landing-page widget captured name and email. Runs the card guard in §1,
then chases anyone who saw availability and did not book. This chase is
deliberately short and specific; they already saw dates, so the job is removing
friction, not re-selling.

**04 - Booked + Reminders.** Trigger: appointment confirmed. Kills nurture and
chase workflows, never the deposit workflow. Confirmation message, then the
reminder ladder anchored to the appointment, including the day-before yes/no
confirmation ask, which alerts on a wobble or on silence. Embedded clinic
alerts.

**05 - Reschedule Handler.** Trigger: appointment confirmed AND rescheduled.
Removes 04's instance, resets appointment tags, confirms the new time, restarts
the identical ladder against it. Same card throughout.

**06 - No-Show Recovery.** Trigger: appointment status No Show. Moves the card
to No Show, runs recovery, hands a rebook back to 03.

**07 - Cancellation Recovery.** Enrolled deliberately on an insisted cancel,
not off raw calendar status. Removes 04 and 05, regresses the card to Booking
Started on the SAME card (they still wanted the thing; the cycle has not
ended), team ACTION alert because a human has to cancel in the calendar,
guarded win-back. If the win-back is exhausted, ends status Lost with a reason,
and the card stays at Booking Started so the drop-off point is preserved.

**08 - Outcome Chaser.** Trigger: appointment status Showed. Moves the card to
Showed, then asks the clinic for the outcome so Continuing Treatment and Done
get set. This is what keeps the tail of the pipeline honest.

**09 - Review Request.** Also fires on appointment status Showed. 08 and 09
share a trigger but are not duplicates and must not be merged: 08 talks to the
CLINIC about the outcome, 09 talks to the PATIENT about their experience.
Different audiences, different cadences. 09 asks how it went; happy goes to the
Google review link, unhappy raises an internal alert and never gets a public
ask. Requires the client to have connected their Google Business Profile, which
becomes an onboarding instruction.

**10 - Stale Opportunity Recovery.** Trigger: `opportunity_decay`, GHL's
"Stale Opportunities", filtered to this pipeline, inactive at least N days, and
status not Lost. Branches on the stage the card went stale in, because the right
message differs: never engaged, talked but never booked, or saw dates and did
not take one. Exits on reply, on booking, or ends status Lost.

This single workflow replaces both a separate long-term nurture and a separate
reactivation campaign. Per-stage decay makes them the same mechanism, and two
overlapping systems would both message the same person.

**11 - Missed Call Text-Back.** Missed inbound call on the tracked number. One
message, once per 24 hours via `missed-call:cooldown`. A reply wakes the AI.

**12 - AI Escalation + Human Takeover.** Trigger: the `ai:escalated` tag,
applied either by the AI handing off or by a human. Sets `ai:off` so staff can
take a conversation over, alerts the team with context, and provides the
reverse path that clears `ai:off` and hands back to the AI. Every account needs
an off switch.

### What stays a client-level knob

The workflow set and its numbering are fixed. The following are deliberately
NOT fixed, and each build sets them from strategy: all message copy, every wait
duration and ladder cadence, the send window, 10's decay threshold in days,
03's chase delay, the reminder ladder's anchor offsets, alert recipients, and
the escalation criteria. Where this document writes "N days" or "the send
window" it means a required per-client decision, not an unresolved question.

## 4. How this is enforced

Promotion from Tier-2 to Tier-1. Concretely, in `grom-client-factory`:

- `baseline/canonical-model.md`: the eight stages, the per-campaign pipeline
  rule, Lost-as-status, the data placement rule, and the standard
  tag/value/field sets become Tier-1 contracts. §6 "General pipeline stages
  (Tier-2 default, for reference)" is deleted; it currently says "diverge
  freely".
- `baseline/core-workflows.md` is replaced by `baseline/base-workflows.md`:
  twelve always-on workflows with reserved numbering, each with the ownership
  statement above. The "Adapt freely per strategy" framing goes.
- `baseline/validate.mjs`: fails a build whose pipeline design renames,
  reorders, or drops a base stage; whose base workflow numbers do not match;
  which mirrors a stage into a tag; or which places a per-cycle value on the
  contact.
- `baseline/client-manifest.schema.json`: the stage set and base workflow
  numbers become required and constrained rather than free strings.
- `skills/client-design`: the systems-architect prompt starts FROM the standard
  build and must justify additions, instead of designing a pipeline. The
  pipeline-fields role's job shrinks to client-specific extensions.

The architect keeps freedom over everything the standard build does not name:
copy, cadences, thresholds, calendars, offers, conditional modules, and any
stages appended after Done.

## 5. Open items, to verify not assume

1. **`Done` is not in the canonical step list.** `treatment` is currently last
   at sort 55. Adding Done is a code change in
   `grom-dashboard/apps/web/lib/funnel-canonical.ts` (`CANONICAL_SORT`), not
   just a docs change.
2. **Do the dashboard and portal read opportunity STATUS?** Lost-as-status and
   Done-as-Won only report correctly if they do. `grom-dashboard` was not
   present on this drive during this design session, so this is unverified.
3. **The booking AI's "presented availability" signal.** The exact mechanism
   the booking agent uses to tell 03 that dates were offered needs defining
   against GHL's Conversation AI action surface and verifying live.
4. **The booking worker needs to write the GHL signal** when the landing-page
   widget captures name and email, so 03 fires on the self-serve path.
5. **`internalCustomVarMappings` is empty in the recovered builder source**, so
   the exact set of actions that attach an opportunity is not enumerable from
   the sniff bundle. The mechanism is confirmed; the list should be checked in
   the builder UI.
6. **Migration of the three live accounts** (Francesca, SK Skin, Alevere) is
   NOT part of this spec. Francesca in particular is live with payments, so
   retrofitting is its own risk-assessed piece of work. This spec governs new
   builds first.

## 6. Rejected alternatives

- **One pipeline per sellable product.** Multiplies the workflow set per
  pipeline and gives the portal a funnel per treatment.
- **A Lost stage.** Loses the drop-off point, which is the most useful thing
  the funnel can tell a client.
- **Dropping the Booking Started rung entirely.** Simpler, but collapses
  "was offered dates and refused" together with "asked one question and went
  quiet". Those are a friction problem and an interest problem, and the client
  needs to know which lever to pull.
- **The AI classifying its own handoff intent** (qualify vs rebook vs
  reschedule). Correctness would depend on the LLM, which has already failed on
  this account; the Francesca team summary had to move server-side for exactly
  this reason. The workflow reads pipeline state instead.
- **Separate long-term nurture and reactivation workflows.** Per-stage decay
  makes them one mechanism.
- **Mirroring a value across a contact field and a tag.** Two sources of truth
  for one fact, which is the drift pattern behind the WF08 orphan-trigger bug.
