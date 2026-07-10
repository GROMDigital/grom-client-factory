# Provenance

Vendored 2026-07-11 from the personal skill `~/.claude/skills/get-ghl-workflow-json`
(runbook, JSON-shape reference, throttle, capture validator), byte-identical at
vendor time. That skill remains for ad-hoc personal use; THIS copy is the
plugin's engine and the one the team runs.

Divergence policy: improvements land here first from now on. If the personal
skill changes independently, re-vendor deliberately (diff, then copy) rather
than assuming sync. The engine is stable/proven, which is why it is absorbed
rather than referenced fresh (spec section 9 rule).

Hard boundaries inherited unchanged: GET-only with the scoped iframe JWT
(Authorization: Bearer), never mutating verbs, one location per session,
`throttle.py wait` before every internal fetch, stop on 429/403.
