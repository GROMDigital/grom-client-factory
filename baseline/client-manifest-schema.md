# Client Manifest, field notes

One JSON file per client (`client-manifest.json` at the client-folder root).
Machine-readable deliverable of `client-design`; ID-completed by
`ghl-account-audit` harvest mode; execution-discovered fields filled during
build. NEVER put a token or secret value in it; secrets travel as vault-secret
NAMES only (`secrets_pointers`).

Lifecycle meaning (record per field in `field_lifecycle`):
- `design-time`: knowable from strategy + Grom decisions (market, currency,
  booking model, product names, allowed_origins once the domains doc exists)
- `harvest`: read from the live account by audit harvest (location, pipeline,
  stage IDs, calendar IDs, agent IDs, PIT vault name)
- `execution-discovered`: only exists after execution work (tracked number,
  clarity/pixel IDs, widget selectors). Post-build verify FAILS LOUDLY if any of
  these are still null at go-live.

Consumers: portal `clients`/`client_mapping` rows (identity + money groups);
dashboard mart admin API (funnel group); `client-lp-tracking` config
(`tracking` group); audit verify (everything).

## Version 2 (the Standard Build), added 2026-07-27

**New builds are `manifest_version: 2`. Version 1 stays valid and readable.**
Francesca, SK Skin and Alevere do not migrate, and the schema keeps their shape
working rather than deleting it.

### Why the shape changed

v1 holds ONE `pipeline_id` (a scalar) and ONE flat `stage_map` keyed by stage
NAME. That is unambiguous only by accident: it works when a client has one
pipeline whose stage names happen to be unique.

Under the Standard Build every pipeline carries the **same eight stage names**.
A client running two campaigns has two pipelines, both with a stage called
"Booked", and one flat name-keyed map cannot tell them apart. The two pipelines
collapse into one indistinguishable map and the reporting silently merges two
campaigns. Francesca's live manifest already shows the shape that breaks.

### `pipelines[]`

One entry per campaign/offer: its own lead form, landing page and booking
calendar. NOT one per product. A fifteen-treatment menu sold through one
consultation funnel is ONE entry, with treatment interest held on the card.

Each entry carries `key`, `ghl_pipeline_id`, `funnel_slug`, `offer_price`,
`calendar_ids` and its own `stage_ids`.

`stage_ids` maps stage NAME to the GHL stage UUID. The eight keys are required;
values may be null until harvest. Extra keys are allowed ONLY for stages appended
after Done.

**This is a direction change, and it is the point of the file.** v1 recorded
stage name to canonical STEP, because the names were arbitrary per client. With
the names fixed, that mapping is known in advance, so it is no longer recorded
per client. It lives once, in the schema, as `x-standard-stage-canonical`.

What the manifest carries instead is the thing nobody currently has in a
machine-readable place: the stage UUIDs. Today those get hand-written into a
per-client SQL migration, which is the stated obstacle to onboarding a clinic as
a config action rather than a code change. The mart seeder now derives its
`ghl_stage_map` rows by joining `pipelines[].stage_ids` to
`x-standard-stage-canonical`.

⚠️ `done` is in the schema's canonical vocabulary but is **not yet in
`grom-dashboard`'s `CANONICAL_SORT`** (`treatment` is 55 and `terms_sent` is 60,
so only 56 to 59 are free). Until that lands, the eighth stage is invisible to
reporting. Tracked in `Standard-Build-Revamp/README.md`.

### `base_workflows`

Number to `{name, ghl_workflow_id, published}`. Only the reserved base numbers
are accepted (`01`-`14`, `20`-`22`, `25`, `30`, `40`), which mechanically prevents
renumbering the base set.

**An ABSENT key means that workflow is not built for this client**, and that gap
is information: no 20-series means no deposits, no 04/05 means the diary lives
elsewhere. Client-specific extensions are NOT recorded here; they live in the
design docs at unused numbers.

`published` is half of the deployment gate. The other half, trigger file
non-empty, is asserted against exported workflow JSON, because a build whose
workflows are all 2-byte-trigger drafts would otherwise pass.

### `lost_reason_ids`

The eight standard reasons mapped to their GHL ids, seeded as location-level
options. Every automated Lost write sets one. Do NOT create a custom
lost-reason field; GHL's is native, is a merge tag, and is a filter on the
stale-opportunity trigger.

### `per_cycle_fields`

Facts about THIS cycle, held on the OPPORTUNITY. Always includes
`treatment_interest`, `cycle_index` and `amount_paid`.

This declaration replaces a rule revision 1 promised but could not deliver:
"places a per-cycle value on the contact" is not decidable over prose. Declared
fields ARE checkable against the account's real opportunity fields.

`staging_contact_field_id` is the AI staging-slot exception. An AI agent cannot
write an opportunity field; its only field-write capability is
`updateContactField`. So an AI-captured per-cycle fact lands on a contact field
named `stg_<key>`, and 01 or 03 copies it one-way onto the card. Write-only, not
a source of truth, read by nothing else. Null when no AI captures that field.

### `knobs`

The client-level settings that are machine-checkable. Copy, ladder wording,
alert recipients and cadences are NOT here; they live in the design docs. The
workflow set, its numbering, the removal matrix and the hygiene flags are fixed
and are not knobs at all.

`touch_ceiling`, `decay_days`, `ladder_length_days`, `absence_close_days`,
`treatment_payment_in_system`, `send_window`.

The validator's relational constraint `decay_days > ladder_length_days` needs
both of the first two, which is why they are here rather than in prose.

🔴 **`treatment_payment_in_system` is OFF by default.** The pipeline tail is
primarily MANUAL, because Grom's data ends at booking and the clinic takes
treatment payment on its own system. Turn it on only for a client who genuinely
takes treatment payment inside the system; then 13 also triggers on
`payment_received`, writes `amount_paid`, and owns the reprice. When off, the
card keeps the advertised offer price and reporting must label it as advertised,
not realised.

### `ai_agents.chat_booking_flow_workflow_id`

The booking agent must be a flow-builder bot, so its logic IS a workflow. This id
is what makes "an `add_contact_tag` writing `booking:availability-shown` sits
immediately before the booking node" checkable rather than a promise.

## Worked example (v2, abridged)

```json
{
  "manifest_version": 2,
  "client_key": "example-clinic",
  "label": "Example Clinic",
  "status": "design",
  "ghl_location_id": null,
  "market": "AU",
  "currency": "AUD",
  "timezone": "Australia/Melbourne",
  "pipelines": [
    {
      "key": "consult",
      "label": "Consultation funnel",
      "ghl_pipeline_id": null,
      "funnel_slug": "consult",
      "offer_price": 99,
      "calendar_ids": [],
      "stage_ids": {
        "New Lead": null, "Engaged": null, "Booking Started": null, "Booked": null,
        "No Show": null, "Showed": null, "Continuing Treatment": null, "Done": null
      }
    }
  ],
  "base_workflows": {
    "01": { "name": "01 Lead Intake + Chase", "ghl_workflow_id": null, "published": null },
    "02": { "name": "02 Reply to Engaged", "ghl_workflow_id": null, "published": null }
  },
  "lost_reason_ids": {
    "price": null, "location": null, "timing": null, "not suitable": null,
    "went elsewhere": null, "no response": null, "not interested": null,
    "duplicate / test": null
  },
  "per_cycle_fields": [
    { "key": "treatment_interest", "opportunity_field_id": null,
      "staging_contact_field_id": null, "enumerated": true },
    { "key": "cycle_index", "opportunity_field_id": null, "staging_contact_field_id": null },
    { "key": "amount_paid", "opportunity_field_id": null, "staging_contact_field_id": null }
  ],
  "knobs": {
    "touch_ceiling": 12,
    "decay_days": 14,
    "ladder_length_days": 7,
    "absence_close_days": 45,
    "treatment_payment_in_system": false,
    "send_window": { "start_hour": 8, "end_hour": 20 }
  },
  "booking": { "model": "in_page_widget", "calendar_ids": [], "payment_product_names": [], "external_system": null },
  "tracking": { "client_key_snippet": "example-clinic", "worker_url": "https://grom-lp-events.gromdigital001.workers.dev" },
  "ids_harvested": false
}
```

## Owed to `validate.mjs` (next step)

The schema now expresses v1-vs-v2 required keys as JSON Schema `if`/`then`.
`validate.mjs` does NOT evaluate JSON Schema; it loops `schema.required`. So
until it is taught the version split, a v1 manifest missing `stage_map` and a v2
manifest missing `pipelines` are both unflagged. That is the first thing the
validator step must fix.
