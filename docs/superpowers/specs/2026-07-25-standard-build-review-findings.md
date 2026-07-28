# Standard Build: review findings and required fixes

2026-07-25. Two adversarial expert reviews of
`2026-07-25-standard-build-design.md`: one GHL feasibility (verified against the
internal trigger/action catalog plus live read-only MCP on AUS
`wdzEoUZnXO9tB3PPzcot` and UK `yoQVVJFp6wyjxcxilA2H`), one operations and
reporting (verified against `Conversion-Audit-2026-07-19` and
`Systems-Audit-2026-07-15`).

Both reviewers independently found the same load-bearing error, item A1.

## A. Blockers: the design changes shape

**A1. Appointment status is NOT a reliable signal. The spec asserts the
opposite and must be rewritten.**

Spec claim: "Booked, No Show, and Showed are driven off GHL appointment status,
which clinic staff do touch even when they never open the opportunities tab."

Evidence against, from live accounts and prior audits:
- AUS calendar `ZI3orrwqgNebxtzoUgyA`, June to July: 7 events, 1 `showed`,
  2 `noshow`, 4 still `confirmed` with past start dates.
- UK calendar `BjIZd4VxAwirtP3Dmc7X`: ~20 of 60 past-dated events still
  `confirmed`.
- `Conversion-Audit-2026-07-19` F8: AU 1 `showed` of 29 appointments, 22 still
  `confirmed`. SK records no `showed` or `noshow` at all.
- `Systems-Audit-2026-07-15`: "show-rate structurally BLIND all 3".
- The reporting mart ALREADY works around this: it reads showed and no-show
  from the pipeline STAGE, not from appointment status.

So the design inverts the dependency: it sets the stage FROM the signal the
mart was built to avoid trusting. Stages 5 through 8 would fire for roughly 3%
of patients, and 06, 08 and 09 would never run for the rest.

Required rewrite, in priority order:
1. **Payment is the primary Continuing Treatment and Done signal.** The clinic
   cannot skip taking money. `payment_received` filtered on product id already
   works and is live on Francesca. This also fixes C2 below, because the card's
   value becomes the amount actually paid.
2. **Continuing Treatment can also be inferred from the existence of a next
   booked appointment**, which is a by-product of booking rather than admin.
3. **Time-anchored disposition, not status-triggered.** Put an
   appointment-relative wait inside `04 - Booked + Reminders` (waits support
   hours; `if_else` on dates is day-granular), then branch on appointment status
   at that moment and chase the clinic only when it is still `confirmed`.
   Anchoring `08 - Outcome Chaser` to status Showed means it cannot fire for
   exactly the cards that rot.
4. **A disposition workflow joins the always-on set**: appointment more than 2h
   past and still `confirmed`, tag `needs_disposition`, one daily digest to a
   NAMED owner.
5. The staff chaser survives only as a backstop. Note SK's clinic notification
   address opted itself out of its own internal alert stream on 2026-06-23, and
   SK's 3 staff notification threads carry 1,222 of 3,531 messages, so a chaser
   aimed at that channel is aimed at nothing.

**A2. "The booking AI presented dates" is not an observable GHL event.**

The OG trigger registry is 57 triggers. There is no outbound-message trigger, no
"AI sent a message" trigger, and no availability or slot event. The Conversation
AI action type enum is closed: `triggerWorkflow`, `updateContactField`,
`appointmentBooking`, `stopBot`, `humanHandOver`, `advancedFollowup`,
`transferBot`. Nothing emits "I offered times".

Required change: **the booking agent must be a FLOW-BUILDER bot, not a prompt
bot**, and that becomes a requirement of the standard build. A flow bot's logic
IS a workflow, so an `add_contact_tag` step placed immediately BEFORE the
booking node is deterministic by graph position rather than LLM judgement. The
tag goes before the node because `conversationai_book_appointment` branches only
`onBooked` / `onNotBooked`; "slots presented" is not one of its branches.

`03 - Booking Started + Chase` entry one becomes: the booking agent's flow
tagged `booking:availability-shown`.

Rejected alternative: the ConvAI `triggerWorkflow` action works today (live on
AUS Booking Finn, action `81WzgjG1SFc5p6NxeSHX`, with a prose
`triggerCondition`) but it is LLM-judged, which §6 of the spec already rejects
on evidence.

**A3. The AI cannot write an opportunity field, so `treatment_interest` needs a
declared exception.**

The AI's only field-write capability is `updateContactField`, keyed to a
`contactFieldId`. There is no opportunity-field writer in the action enum. Live
AUS Booking Finn's four capture actions are all `updateContactField`. Francesca
defect #3 was literally "Booking AI does NOT set `service_interest`", fixed by
adding an `updateContactField` action.

Required addition to the placement rule: an AI-captured per-cycle fact lands on
a CONTACT field declared as a **write-only staging slot**, and the workflow that
attaches the card (01 or 03) copies it one-way onto the card. The contact field
is explicitly not a source of truth. Without this sentence the build either
loses AI-captured data or silently violates the no-mirror rule.

**A4. "Every finder sets its pipeline and stage filters explicitly" is
unbuildable and actively dangerous.**

`find_opportunity` has one filter field. Every observed sample across 40 steps /
33 workflows / 5 locations filters on `pipeline_id`, and `sorting: "latest"` is
the only observed sort. Worse, the rule combines with "every not-found branch
must create the card" to manufacture duplicates: a stage-filtered finder returns
Not Found for a card that exists at a different stage, so the workflow creates a
second one. That is the exact card explosion the one-card-per-cycle rule exists
to prevent.

Required replacement: **filter on pipeline only, then `if_else` on the card's
current stage.** Runtime-proven, with the trap that `conditionType: opportunity`
singular or `pipeline_stage_id` snake_case fails silently.

**A5. The manifest schema cannot express one pipeline per campaign.**

`client-manifest.schema.json:17` is a single nullable `pipeline_id`;
`stage_map` is a flat name-to-step object with no pipeline scoping. Because the
standard build gives every pipeline the SAME eight stage names, two pipelines
collapse into one indistinguishable map. Francesca's live manifest already shows
this: one `pipeline_id` and one flat stage map covering both her course and
treatment funnels, plus a singular `treatment_field_id`.

Required: `pipelines: [{ key, ghl_pipeline_id, funnel_slug, stage_ids{} }]`,
deprecating scalar `pipeline_id` and flat `stage_map`. Also note the portal's
per-client config is a hand-seeded SQL migration of stage UUIDs, so three
campaigns means 24 UUIDs per client unless stage-UUID discovery is automated.

## B. Landmines: buildable, will silently misbehave

**B1. Backward stage moves silently no-op without `allowBackward: true`.**
Default is false in 100% of the corpus. The design has at least four backward
moves: No Show to Booking Started, `07 - Cancellation Recovery` regressing to
Booking Started, Booked entered from No Show, and the Done/Lost re-entry paths.
Add to §1 and to the validator.

**B2. `04 - Booked + Reminders` drags course patients out of the tail.** 04
writes Booked (position 4) but the guard table sends a next-appointment-in-a-
course card to 04 while it sits at Continuing Treatment (position 7). Either it
no-ops or it erases the tail state 08 worked to get. 04's stage write needs an
`if_else` guard: write Booked only from New Lead, Engaged, Booking Started or
No Show.

**B3. `08 - Outcome Chaser` moves the card to Showed unconditionally**, so a
six-session course oscillates 55 to 50 six times, generating six staff tasks and
six stage regressions. `09 - Review Request` fires on the same trigger, so the
patient gets six Google review asks. Gate 08 on current stage; gate 09 on
`review:requested`.

**B4. Re-entry into `03 - Booking Started + Chase` while still enrolled is
silently skipped.** No error, no alert, live-proven on Francesca. 03 carries a
wait ladder, so a card parked in it that sees availability again produces
nothing, which breaks the No Show to Booking Started row that
`06 - No-Show Recovery` depends on. Fix: 03's first step removes the contact
from itself (`includeCurrent`), or the guard is split into a wait-free workflow
that then adds the contact to the chase.

**B5. `01 - Lead Intake + Chase` has no card guard**, so the highest-volume
entry point mints duplicates. A patient who books via the landing page and then
clicks a retargeting ad gets a second card at New Lead plus a chase ladder aimed
at someone with an appointment tomorrow. The guard must be stated ONCE as a
shared contract that 01 and 03 both run, not inside 03's description.

**B6. `01` and `03` chase concurrently.** 01 exits on reply or booking; Booking
Started is neither, and 03 never removes 01. Also `10 - Stale Opportunity
Recovery`'s decay threshold and 01's ladder length are both free knobs with no
relational constraint, so a 7-day decay under a 14-day ladder enrols the lead in
10 while 01 still has three touches left. Required: a numbered removal matrix
stated once as contract, 10 gated on `nurture:exhausted`, and
`decay_days > ladder_length` as a validated constraint.

**B7. `10 - Stale Opportunity Recovery` can mark a booked patient Lost.** It
enrols pipeline-wide but branches on only three stages, and its terminal action
writes Lost. Aesthetic consult waits are routinely 3 to 6 weeks. Fix:
stage-filter 10's ENTRY to stages 1 through 3, and never let an unmatched branch
reach a status write.

**B8. Setting Lost with a native reason forces a stage write.** The only
picker-visible opportunity action requires BOTH `pipeline_id` and
`pipeline_stage_id`, and `lostReasonId` exists only on that interface. So a
naive "set Lost" step relocates every dying card to one hardcoded stage,
destroying the reporting premise. Required: the Lost write always restates the
card's CURRENT stage, so any Lost-setting workflow must be per-stage branched.
(Open item: whether `internal_update_opportunity` accepts `lostReasonId`, which
would collapse this.)

**B9. Lost reasons are location-level preconfigured options and the spec
declares none.** AUS currently has exactly one: "not interested". Both 07 and 10
write a reason, and `opportunity_decay` can filter on `lostReasonId`. Required: a
standard lost-reason list in §2 and a `lost_reason_ids` map in the manifest.
Without a fixed vocabulary, "why they die" is not comparable across clients,
which is the point of standardising. Note the dashboard already found only 1 of
9 lost opps carries a reason.

**B10. `ai:escalated` is a one-shot trigger.** `contact_tag` fires on the
`tagsAdded` state change, so re-adding a tag the contact already carries fires
nothing, and the spec's reverse path clears `ai:off` but never `ai:escalated`.
Fix: `12 - AI Escalation + Human Takeover` removes the tag as its first step.

**B11. `ai:off` is a flag that silences nothing.** The mechanism is
`update_conversation_ai_status` (`status: active|inactive`, plus native
auto-hand-back via `shouldReactivateAfterTimeOut`). Francesca shipped the tag
approach and it was DORMANT: "WF15 Human-Takeover DORMANT, `ai:off` does NOT
silence Pearl". Separately GHL's own `humanHandOver` actions write their own
tags: live AUS Booking Finn writes `ai:cancel-requested` and
`ai:human-takeover`, neither of which is `ai:escalated`. Required: 12 names the
step, and the standard tag set adopts the exact tags the handover actions write.
Also 12 must remove the contact from 01, 03, 06, 07 and 10, which otherwise keep
sending while a human negotiates.

**B12. Nothing removes a contact from `06 - No-Show Recovery` when staff correct
No Show to Showed.** The "you missed your appointment" ladder keeps running
against someone who attended. Both 04 and 08 must remove 06.

**B13. Rescheduling bursts the ladder.** A wait anchored to a moment that has
passed fires immediately and everything downstream runs at once; the setting is
not in the workflow JSON so it cannot be configured away. Live-proven on
Francesca 2026-07-20. `05 - Reschedule Handler` restarts the ladder against the
new time, so moving from next month to tomorrow sends the 3-day, day-before and
morning-of messages within seconds. Required: every appointment-anchored wait
carries an `if_else` on whether the anchor is already past, and relative waits
are the spec's default.

**B14. `04 - Booked + Reminders` cannot be always-on.** Alevere runs Cliniko as
the diary and already sends 29/29 confirmations plus a day-before reminder from
sender "AlevereClin"; amendment A2 explicitly REMOVED the GHL ladder to stop
duplicates. Shipping 04 unconditionally reintroduces that bug, with two
confirmations, two reminders and two sender identities. The manifest already
supports `booking.model: "external"`. Required: 04 conditional on
`booking.model !== "external"`, plus a named external-booking variant that polls
status into GHL.

**B15. `monetaryValue` needs three parts, not one.** The value IS stored and
DOES apply at runtime; what breaks is the builder render, and the real hazard is
that editing and saving such a node blanks it. The complete fix is `value` as
number, `valueFieldType: "numerical"`, AND `dataType: "NUMERICAL"`. The spec
names only the first.

**B16. `09 - Review Request` does not need a Google Business Profile.**
`review_request` carries `overrideReviewLink`, and §2 already declares a
`review_link` custom value. GBP is an upgrade, not a gate. Drop the hard
requirement.

**B17. Two validator rules in §4 are not mechanically decidable.**
`validate.mjs` is a text and JSON scanner; "mirrors a stage into a tag" and
"places a per-cycle value on the contact" are semantic judgements over prose.
Meanwhile the highest-blast-radius defect in the estate IS checkable and absent:
`stopOnResponse: false` on 66 of 70 published workflows, SK 15 of 15. Required:
point the validator at exported workflow JSON and assert `stopOnResponse`,
numeric `monetaryValue`, non-empty `knowledgeBaseIds`, non-empty `calendarIds`,
`autoPilotMaxMessages`, appointment-anchored waits, `allowBackward` on
regressions, and finders lacking a status filter. Add a declared
`per_cycle_fields` list to the manifest so that rule has something to compare
against, or demote it to a checklist item.

**B18. The `{{opportunity.*}}` build rule is incomplete and creates the bug it
warns about.** The real gate is trigger-present OR action-attached.
`10 - Stale Opportunity Recovery` triggers on `opportunity_decay` and therefore
already resolves the tags, so the rule as written tells a builder to add an
unnecessary finder to the one workflow where a second card makes finders a coin
flip. State both halves.

## C. Reporting will lie

**C1. The pipeline-value promise is wrong as written.** With Lost as a status
and the card left in place, "currently in Booking Started" includes the dead
cards. 100 reach Booking Started, 60 go Lost and stay, 40 book: a reached query
correctly returns 100, a current-stage query returns 60, all written off. So
"£14k sitting in Booking Started" is £14k that is not at risk. Two filters are
needed on one table: `status = open` for pipeline value, status-agnostic for
reached counts. Neither is named.

**C2. Value is a card count in a money costume.** No workflow in the base set
owns the reprice and none reads the registry price list, so value stays at the
advertised offer price until a human edits it. Clinic advertises £99, patient
buys a £2,400 course, portal reports £99, a 96% understatement. This reproduces
audit F2 ("`monetaryValue: 0` on all 60 AU opportunities") as a standard rather
than fixing it. Fixed by A1's payment-driven approach. Also note
`avg_treatment_value` already exists in the manifest, so a registry price list
is a second source of truth for the same fact.

**C3. The Engaged rung stops meaning "replied".** Engaged is only ever set by
02 (a reply); the landing-page path skips it. The mart counts cumulatively on
`furthest_sort >= step`. 100 LP leads and 100 form leads, of which 12 form leads
reply: reported Lead-to-Engaged is 56%, true reply rate is 6%. A 9x
overstatement that moves purely with traffic mix. The never-replied segment
becomes unidentifiable, and that segment is the whole of audit F5.

**C4. The artificial New Lead hop buys nothing.** Its justification was
avoiding a chart where leads are fewer than bookings-started, but the mart's
cumulative `furthest_sort >= step` contract already makes that impossible.
Ingestion is an hourly poll with webhooks pending, so two stage changes in one
hour collapse and the New Lead event is likely never observed. PLAUSIBLE, not
confirmed: grom-dashboard is not on this drive.

**C5. The same poll gap un-books people.** 07 regresses Booked to Booking
Started and 06 regresses No Show to Booking Started, both on the same card. With
poll-only ingestion the reconcile sees only the current stage, so `furthest_sort`
recomputes DOWNWARD and booked counts decrease between polls. A cancel-and-rebook
inside one hour means the Booked event is never observed at all.

**C6. Recovered no-shows vanish, treatment no-shows never appear.**
`n_no_show = count(furthest_sort = 45)` is terminal, so a no-show who rebooks
and attends leaves the no-show count entirely: gross no-show rate is not
computable and 06's recovery rate cannot be derived. Audit F8 insists both
denominators belong in any report. Separately a consult-then-treat patient at
Continuing Treatment who no-shows the treatment has current stage 45 but
furthest 55, so they count as Showed. The most expensive no-show is the one the
funnel cannot see.

**C7. Repeat business inflates ad performance.** Attribution is first-touch on
the CONTACT, so a returning patient's new card inherits the original ad. Ad X at
£500 for 10 leads and 4 booked is £125 per booking; three returning patients
later it reads 13 leads and 7 booked, £71 per booking, with zero new spend.
Required: a `cycle_index` on the card, with the mart excluding cycle > 1 from
acquisition maths.

**C8. Two offers, one person, two leads.** A contact enquiring about a course
and a treatment holds two cards in two pipelines, producing two leads and two of
every downstream count from one human, both credited to the same first-touch ad.

**C9. LP `booking_started` and the Booking Started stage are not the same
thing.** The spec claims they "agree by construction". The LP event fires on the
first click inside the widget selector, anonymous, explicitly not on auto-load,
and strictly BEFORE slot selection; the stage requires name and email, which
arrive after. So the LP counts distinct sessions and the stage counts cards,
roughly 3x apart, both in one client report under one name. This also shrinks
the claimed side benefit: the recoverable population is form-abandon-after-
typing-email, not calendar-engagement.

**C10. When the tail rots the portal reports £0 revenue forever**, which is
exactly SK's current state ("never marked an opportunity won despite 10 patients
reaching Treatment Completed"). Required: coverage reporting on the tail using
the speed-to-lead pattern, "outcome recorded for 4 of 29 appointments" rather
than a silent zero. The precedent and its three ordered gates are already live.

## D. Confirmed sound

Verified, not assumed:

- `opportunity_decay` really can filter pipeline, stage, inactivity duration,
  status and lead value simultaneously. Status operators are `==` and `!=` over
  `open|won|lost|abandoned`. Per-stage decay via multiple triggers on one
  workflow is corpus-attested. So the value-based prioritisation claim holds.
- **Lost-as-status preserves the death stage, empirically.** AUS pipeline
  `fxiSbIBOA9hopUwj9LJF` holds 28 lost cards, each still at its own stage
  (New Inquiry, Qualified, Showed, No Show) with `lostReasonId` set and
  `lastStatusChangeAt` distinct from `lastStageChangeAt`. The property the whole
  design rests on is real.
- Opportunity custom fields merge as `{{opportunity.<field_key>}}`.
- The attach rule is correct: a find or create action attaches the card and makes
  the tags resolve under any trigger.
- `if_else` can branch on the card's current stage, so the guard table is
  buildable via A4's corrected mechanism.
- Two pipelines may carry identical stage names in one location (live AUS proof),
  despite the v3 API note claiming otherwise.
- 08 and 09 on the same Showed event: no race, no lost update. Both are
  appointment-triggered, so the latest-start-time targeting hazard does not
  apply to them.
- The `appointment` trigger does deliver `showed` vs `noshow`, and carries a
  Created/Modified By filter so an API-set status is distinguishable from a
  staff-set one.
- Reserved numbering with gaps, fixed stage names (which make `ghl_stage_map`
  seeding templatable, today a hand-written SQL migration per client), rejecting
  AI self-classification of handoff intent, merging nurture and reactivation into
  one decay-driven workflow, Booking Started as an event rather than a judgement,
  per-cycle data on the card, create-then-goto on every not-found branch.
- §4's characterisation of the files it modifies is accurate, and §5's open items
  are honest.
- Per-campaign pipelines aggregate correctly in the ADS dashboard (grain is
  ad-level, pipelines classified by mapped canonical steps not hardcoded ids).
  The PORTAL side is the unverified half: it has no pipeline dimension named
  anywhere.

## E. Still open, needs a live test not an opinion

1. **Does `opportunity_decay` fire once or repeatedly, and can it loop
   forever?** `lastActionDate` is not projected by the v3 read API so it is
   unclear what even resets it. PLAUSIBLE: the condition is permanently true
   once crossed, so with re-entry on, a card whose `lastActionDate` never
   advances re-enrols indefinitely, and the only guaranteed loop-breaker is 10's
   Lost exit. Test: one draft decay workflow on a throwaway pipeline, threshold
   1 day, one untouched card, read workflow logs daily for a week.
2. **What does `find_opportunity`'s `sorting: "latest"` sort on**, `createdAt` or
   `updatedAt`? Decides whether a returning Done-then-new-card contact resolves
   to the right card.
3. **When does `appointmentBooking.triggerWorkflow` fire**, on slot presentation
   or only on a completed booking? If presentation, it closes A2 without
   requiring a flow-builder bot. Requires a write, so out of review scope.
4. **Does `internal_update_opportunity` accept `lostReasonId`?** If yes, B8
   collapses.
5. **Do the dashboard and portal read opportunity STATUS?** Still unresolved;
   `grom-dashboard` is not on this drive and neither reviewer could close it.
6. **Would a `pipeline_stage_id` filterField on `find_opportunity` be honoured at
   runtime?** The engine passes any `filterField` through unvalidated, so it
   builds and publishes clean either way.

## F. Additions both reviewers want that widen the spec

Real and cheap, but past "pipeline, workflows, data placement". Decide whether
these join this spec or a second one:

1. A touch ceiling per contact across all workflows. Worst-case sum across
   01/03/04/06/07/09/10 is ~26 touches, which is audit F12's UK figure
   ("24 messages each, front-loaded, then nothing") and at $1.66/lead with SMS
   at 78% is $1.30 to $2.20 per lead of pure waste.
2. `stopOnResponse: true` and quiet hours estate-wide. False on 66 of 70; live
   sends observed at 23:22, 23:47, 02:55, 03:20.
3. `treatment_interest` as an ENUMERATED picklist keyed to registry product
   names. An AI-written free-text field produces "botox", "Botox",
   "anti-wrinkle" within a week, and card naming, the price join and all
   per-treatment reporting depend on it. Highest-value missing standardisation.
4. A standard AI-agent config contract, each flag with a live failure behind it:
   non-empty `knowledgeBaseIds` (Booking Arthur auto-piloted the money moment
   with none), non-empty `calendarIds` (all four SK voice actions empty, so
   reschedule never worked), action-level cancel/reschedule enabled,
   `sleepEnabled: true` (Francesca's Treatment agent talks over staff),
   `autoPilotMaxMessages` 12 not 100.
5. A buying-signal escalation path (price question, objection, call request,
   booked lead goes quiet). 12 fires on the AI giving up, not on a lead leaning
   in. Audit F5 and F6 are about human attention being allocated by chance and
   the spec does not address them.
6. A deployment gate in the validator: published AND trigger file non-empty.
   Audit F7 is the authored-not-deployed pattern; today the validator would pass
   a build whose workflows are all 2-byte-trigger drafts.
7. Reserve canonical sort space after `done`. `treatment` is 55 and `terms_sent`
   is 60, leaving 56 to 59. Appended stages map to NULL, which means "kept,
   excluded from funnel", so the one extension point the spec permits is
   invisible to reporting.

## G. Verdict against the conversion audit

- F12, nothing catches a quiet lead: **fixed** by 10. The spec's best single
  contribution.
- F2, revenue not joinable: **not fixed, standardised.** Fixed by A1.
- F8, attendance never recorded: **made worse.** The spec asserts the opposite
  of the evidence. Fix first.
- F9, nothing past booked: addressed in intent, not in mechanism.
- F5 and F6, human attention allocated by chance: **not addressed.**
- F7, authored-not-deployed: **not addressed**, cheap to close in §4.
- F14 `stopOnResponse` and F20 the SMS cap: **not addressed**, both cheap and
  checkable.
