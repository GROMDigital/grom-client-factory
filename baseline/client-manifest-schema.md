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
