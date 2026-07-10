# ARCHITECTURE REGISTRY (binding), <CLIENT NAME>, <RUN DATE>

Binding on every name, number, trigger, and contract. Module docs expand it;
where they conflict, this file wins until amended. Amendments append to
section 12 and bump the run-manifest registry hash.

## 1. Client and strategy anchor
Client, location ID (or "not provisioned"), strategy doc path, one-paragraph
strategy digest, funnel count, offer mechanics, booking model.

## 2. Pipelines and stages
Every pipeline, every stage in order, entry/exit criteria, and the BINDING
stage -> canonical-step map (Tier-1; steps from baseline/canonical-model.md).
Brownfield: the disposition table (keep / rename / retire / archive) for every
existing object, from captures/<date>/audit-report.md.

## 3. Workflow list
Numbered, flat chronological. Number, exact name, trigger(s), one-line job,
kill-switch relationships. This list IS the workflow roster; module docs may
not invent workflows absent here.

## 4. AI agent lineup
Which agents exist (chat primary/booking, voice inbound/outbound), persona
name and one-line character, handoff contract bullets. Set no_voice/no_chat_ai
flags accordingly.

## 5. Fields, tags, custom values
Every custom field (name, type, key), every tag (namespace:value), every
custom value. Tier-1: tags used as workflow triggers listed separately.

## 6. Calendars, payment products, external systems
Exact calendar names, exact payment product names (Tier-1 canonical), external
booking/CRM systems and their integration points.

## 7. Landing pages
Per LP: slug, purpose, offer, form/booking mechanism. Sets no_lps flag.

## 8. Phone, compliance, domains
Tracked-number plan, compliance/bundle path for the market, sending domain,
LP domain, allowed_origins values these produce.

## 9. Notifications map
Which workflows embed which alerts (N-ids assigned here, copy in the alert
catalog doc). Tier-1: notifications are steps inside their triggering
workflows, never standalone.

## 10. Manifest skeleton
The design-time client-manifest.json values this build commits to, with
field_lifecycle tags (design-time / harvest / execution-discovered).

## 11. Doc index (binding)
Every design doc: NN filename, owner role, one-line contents. Assigned BEFORE
any module agent writes; cross-references use these names only.

## 12. Divergence log + amendments
Every departure from a baseline default with a one-line reason (Tier-2 rule).
Registry amendments append here dated, and invalidate dependent docs via the
run manifest.

## 13. Version stamps
Plugin commit SHA, dependency clone SHAs + dirty flags, run date. Provided by
the PM in the architect's bootstrap prompt; copied here verbatim.
