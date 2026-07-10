# Post-Launch Onboarding Runbook (template)

Instantiated per client. EVERY step carries one label:
- DATA-ONLY: a row insert / config screen, any team member with access
- MANUAL-CODE-TODAY (owner, credentials): requires a code edit or privileged
  deploy today; automation planned but not built
- BLOCKED-ON-REFACTOR (link): cannot work for this client until the linked
  consuming-system refactor lands

## 1. Portal registration [DATA-ONLY]
clients row + client_mapping row (ad account, currency, timezone, market,
reporting location, ATV) via admin console; KPI targets + module visibility as
agreed.

## 2. Mart configuration [DATA-ONLY]
Admin console sequence: upsert GHL account -> set treatment field -> save PIT
(vault name in manifest) -> save stage map (from manifest stage_map) -> trigger
first sync.

## 3. Tracking registration [MANUAL-CODE-TODAY (owner: Xander, credentials:
gromdigital001 Cloudflare + repo write)]
Per client-lp-tracking README rollout checklist: tenant map edit + wrangler
deploy + DB rows + snippet paste + verify. Becomes DATA-ONLY when the DB-backed
tenant config lands.

## 4. Dashboard instance [MANUAL-CODE-TODAY (owner: Xander, credentials:
Vercel + Supabase + repo)]
Duplicate dashboard template, new Supabase + Vercel + domain + env set, per the
multi-client template plan.

## 5. LP analytics in dashboard [BLOCKED-ON-REFACTOR
(grom-dashboard per-client lp_events ingest, half-migrated)]
Legacy path hardcodes PostHog project 211395 + au/uk filter; new clients will
not appear until the ingest refactor lands.

## 6. End-to-end verification [DATA-ONLY once 1-4 done]
Spend visible; funnel stages populate from stage_map; speed-to-lead numbers
sane; AI performance rows appear; LP funnel populates (unless step 5 blocked);
portal client login works.
