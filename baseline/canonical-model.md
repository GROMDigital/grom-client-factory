# Canonical Model (Tier-1 contracts)

Small on purpose. These exist so every client build plugs into Grom's systems
(dashboard mart, portal, LP tracking) without hand-wiring, and so that every
account is comparable to every other. Everything not on this page is Tier-2
default or Tier-3 freedom.

**Changed 2026-07-26 (the Standard Build).** Sections 5 to 9 were previously
Tier-2 "adapt freely" defaults. They are now hard contracts. The architect starts
FROM them and must justify additions; it may not redesign them. Applies to NEW
builds; existing clients (Francesca, SK Skin, Alevere) do not migrate.

## 1. Canonical funnel steps (the connection point)

Every pipeline design declares a stage -> canonical-step map in the registry and
the client manifest. Steps and sort scale, verbatim:

| canonical_step | sort | note |
|---|---|---|
| lead | 10 | |
| engaged | 20 | off-spine (counted, not drawn) |
| qualified | 30 | the Booking Started stage maps here |
| booked | 40 | |
| no_show | 45 | off-spine branch of booked |
| showed | 50 | |
| treatment | 55 | clinic terminal |
| terms_sent | 60 | agency funnel |
| terms_signed | 70 | agency funnel |
| onboarding | 80 | agency funnel |
| live | 90 | agency funnel |

🔴 **`done` is MISSING and must be added.** The Standard Build's eighth stage has
no canonical step. Only sorts 56 to 59 are free between `treatment` and
`terms_sent`, so reserve deliberately. This is a code change in
`grom-dashboard/apps/web/lib/funnel-canonical.ts` (`CANONICAL_SORT`), not a docs
change, and it is a prerequisite for the Standard Build reporting correctly.

**Owner:** `grom-dashboard/apps/web/lib/funnel-canonical.ts` (`CANONICAL_SORT`).
Verified against grom-dashboard@main on 2026-07-10.

## 2. LP event names (exact strings)

`lp_view`, `booking_started`, `booking_cta_clicked`, `booking_submitted`,
`offer_viewed`. Ordered funnel = first four; `offer_viewed` is an independent
engagement signal. Counts are distinct sessions.

⚠️ **The LP event `booking_started` is NOT the Booking Started stage.** The event
fires on first click inside the booking widget: anonymous, before slot selection.
The stage requires name and email, which arrive after. The event counts distinct
sessions; the stage counts cards. They run roughly 3x apart. Never report both
under one label.

**Owner:** `client-lp-tracking/worker/src/ingest.ts` (`EVENT_NAMES`).
Verified against client-lp-tracking@main on 2026-07-10.

## 3. Non-lead contact sources (speed-to-lead exclusion)

Contacts whose source (case-insensitive) is one of: `manual`, `manual entry`,
`manual_entry`, `import`, `bulk import`, `bulk_import`, `bulk actions`,
`bulk_actions` are NOT leads for speed-to-lead. Design consequence: workflows
and integrations must not invent new source spellings for real leads, and
manual/test contacts should use one of these so they stay excluded.

**Owner:** `grom-dashboard/supabase/functions/sync-ghl/transform.ts`
(`NON_LEAD_SOURCES`). Verified against grom-dashboard@main on 2026-07-10.

## 4. Registry-declared canonical names

Payment product names (workflows filter on the EXACT name), product PRICES,
calendar names, and tag strings used as workflow triggers are declared once in
the client registry (`build/<date>/architecture-final.md`); every doc references
the registry spelling. The reconciler cross-checks all docs against the registry
set. Prices reconcile against the manifest's `avg_treatment_value` so there is
one source, not two.

## 5. Pipelines: one per campaign/offer

A pipeline exists for each distinct ad funnel: its own lead form, its own landing
page, its own booking calendar. **Not per product, and not per treatment.** A
fifteen-treatment menu sold through one consultation funnel is ONE pipeline, with
treatment interest held on the card.

Two ad funnels selling genuinely different things are two pipelines with
identical stages. Identical stage names across pipelines in one location is
verified to work live, despite an API note claiming names must be unique.

## 6. The eight stages (fixed)

Identical at every client. Clients may APPEND stages after Done (subject to the
sort-space constraint in §1). They may never rename, reorder, or remove these.

| # | Stage | Set by | Canonical step |
|---|---|---|---|
| 1 | New Lead | `01 - Lead Intake + Chase`; or `03` on LP name+email capture | `lead` |
| 2 | Engaged | `02 - Reply to Engaged`, on first reply | `engaged` |
| 3 | Booking Started | `03 - Booking Started + Chase` | `qualified` |
| 4 | Booked | `04 - Booked + Reminders`, stage-guarded | `booked` |
| 5 | No Show | `08 - Outcome Chaser` | `no_show` |
| 6 | Showed | `08 - Outcome Chaser` | `showed` |
| 7 | Continuing Treatment | human, chased by `08` | `treatment` |
| 8 | Done | human, chased by `08`; sets status Won | `done` (see §1) |

**Booking Started is an EVENT, not a judgement:** this person saw real
availability. Reached either by the booking agent's flow tagging
`booking:availability-shown` immediately before its booking node, or by the
landing-page widget capturing name and email.

**Death is a status, not a stage.** No Lost stage. A dead lead gets opportunity
status Lost plus GHL's native lost reason, and the card stays in the stage where
it died, so drop-off point is preserved. Done sets status Won. Verified live: 28
lost cards on AUS each sat at their own stage with `lostReasonId` set.

**One card per CYCLE.** A reschedule, cancellation or no-show all happen inside an
unfinished cycle and reuse the card. Only Done or Lost mint a new card, with
`cycle_index` incremented.

## 7. Where data lives

One rule. The failure mode prevented is the same fact stored twice and drifting.

| Holder | Holds | Test |
|---|---|---|
| **Stage** | where they are | one source of truth; never mirrored |
| **Opportunity (card) field** | facts about THIS cycle | treatment wanted, amount paid, `cycle_index` |
| **Contact (person) field** | facts that do not change per cycle | suburb, date of birth |
| **Tag** | a flag, or something a workflow must trigger on | binary; carries no value |
| **Custom value** | one constant for the whole account | never hardcode in copy |

`{{opportunity.<field_key>}}` merges into copy. It resolves when the workflow has
an opportunity trigger OR contains a find/create-opportunity action.

**The AI staging-slot exception.** A Conversation AI agent CANNOT write an
opportunity field; its only field-write capability is `updateContactField`. So an
AI-captured per-cycle fact lands on a CONTACT field named `stg_<field>`, declared
write-only, and the workflow that attaches the card (01 or 03) copies it one-way
onto the card. Nothing else reads the staging field. This is the single sanctioned
exception to the no-mirror rule.

## 8. Standard custom values, tags, fields, lost reasons

**Custom values:** `ai_primary_name`, `ai_booking_name`, `business_name`,
`business_phone`, `business_address`, `from_name`, `from_email`, `booking_url`,
`review_link`.

**Tags** (namespaced, lowercase, colon-separated; extend with the same shape,
never respell). Always present: `funnel:<slug>`, `nurture:exhausted`, `ai:off`,
`ai:human-takeover`, `ai:cancel-requested`, `booking:availability-shown`,
`appt:confirmed-yes`, `needs_disposition`, `missed-call:cooldown`,
`review:requested`. Conditional: `deposit:link-sent`, `speed:retry-done`.

⚠️ `ai:human-takeover` and `ai:cancel-requested` are the exact spellings GHL's own
`humanHandOver` actions write. Do not invent alternatives; the tag IS the trigger.

**Opportunity fields:** `treatment_interest`, `cycle_index`, `amount_paid`.
`treatment_interest` is an ENUMERATED picklist keyed to registry product names,
never free text. Its staging slot is `stg_treatment_interest` on the contact.

**Lost reasons** (location-level preconfigured options, seeded at every location;
`lost_reason_ids` joins the manifest): `price`, `location`, `timing`,
`not suitable`, `went elsewhere`, `no response`, `not interested`,
`duplicate / test`. Every automated Lost write sets one.

**Card naming:** `<Treatment> - <Full Name>`, so the board is readable.

## 9. Opportunity value

Every card carries the price of what that person is in for, from the registry
price list (which comes from the ad strategy). At creation it is the campaign's
advertised offer price; creating at zero is wrong, it makes the pipeline look
empty and early drop-off look costless.

🔴 **`monetaryValue` needs three parts, not one:** `value` as a NUMBER,
`valueFieldType: "numerical"`, and `dataType: "NUMERICAL"`. Written as a string
GHL accepts it, the builder renders Opportunity Value empty, and the next UI save
blanks it.
