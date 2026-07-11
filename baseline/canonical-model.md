# Canonical Model (Tier-1 contracts)

Small on purpose. These exist so every client build plugs into Grom's systems
(dashboard mart, portal, LP tracking) without hand-wiring. Everything not on
this page is Tier-2 default or Tier-3 freedom.

## 1. Canonical funnel steps (the connection point)

Every pipeline design declares a stage -> canonical-step map in the registry and
the client manifest. Steps and sort scale, verbatim:

| canonical_step | sort | note |
|---|---|---|
| lead | 10 | |
| engaged | 20 | off-spine (counted, not drawn) |
| qualified | 30 | |
| booked | 40 | |
| no_show | 45 | off-spine branch of booked |
| showed | 50 | |
| treatment | 55 | clinic terminal |
| terms_sent | 60 | agency funnel |
| terms_signed | 70 | agency funnel |
| onboarding | 80 | agency funnel |
| live | 90 | agency funnel |

A clinic build typically maps stages onto lead/engaged/qualified/booked/no_show/
showed/treatment; the agency steps exist for Grom's own funnel. Multiple stages
may map to one canonical step; every SALES pipeline stage should map to
something or be deliberately excluded (mapped NULL = kept, excluded from funnel).

**Owner:** `grom-dashboard/apps/web/lib/funnel-canonical.ts` (`CANONICAL_SORT`).
Verified against grom-dashboard@main on 2026-07-10.

## 2. LP event names (exact strings)

`lp_view`, `booking_started`, `booking_cta_clicked`, `booking_submitted`,
`offer_viewed`. Ordered funnel = first four; `offer_viewed` is an independent
engagement signal. Counts are distinct sessions.

**Owner:** `client-lp-tracking/worker/src/ingest.ts` (`EVENT_NAMES`).
Verified against client-lp-tracking@main on 2026-07-10.

These events presuppose a landing page. Every Grom funnel routes the Meta lead
form to a booking/deposit landing page where the lead books and pays the deposit,
and where these events fire. A build sets `no_lps: true` only when it genuinely
has no booking page anywhere, which is rare and must be justified in the registry.

## 3. Non-lead contact sources (speed-to-lead exclusion)

Contacts whose source (case-insensitive) is one of: `manual`, `manual entry`,
`manual_entry`, `import`, `bulk import`, `bulk_import`, `bulk actions`,
`bulk_actions` are NOT leads for speed-to-lead. Design consequence: workflows
and integrations must not invent new source spellings for real leads, and
manual/test contacts should use one of these so they stay excluded.

**Owner:** `grom-dashboard/supabase/functions/sync-ghl/transform.ts`
(`NON_LEAD_SOURCES`). Verified against grom-dashboard@main on 2026-07-10.

## 4. Registry-declared canonical names

Payment product names (workflows filter on the EXACT name), calendar names, and
tag strings used as workflow triggers are declared once in the client registry
(`build/<date>/architecture-final.md`); every doc references the registry
spelling. The reconciler cross-checks all docs against the registry set.

## 5. Standard tag taxonomy (journey states)

Namespaced, lowercase, colon-separated. Core set (extend per client, never
respell): `funnel:<slug>`, `nurture:exhausted`, `ai:off`, `ai:escalated`,
`ai:cancel-requested`, `appt:confirmed-yes`, `deposit:link-sent`,
`missed-call:cooldown`, `speed:retry-done`. Client-specific tags follow the same
`namespace:value` shape and are catalogued in the fields/tags doc.

## 6. General pipeline stages (Tier-2 default, for reference)

New Lead -> Conversation Started -> Appointment Booked -> Appointment Showed /
Appointment No Show. Diverge freely; the canonical-step map is what must hold.
