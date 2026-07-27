# ARCHITECTURE REGISTRY (binding), <CLIENT NAME>, <RUN DATE>

Binding on every name, number, trigger, and contract. Module docs expand it;
where they conflict, this file wins until amended. Amendments append to
section 12 and bump the run-manifest registry hash.

## 1. Client and strategy anchor
Client, location ID (or "not provisioned"), strategy doc path, one-paragraph
strategy digest, funnel count, offer mechanics, booking model.

## 2. Pipelines and stages
ONE pipeline per campaign/offer (not per product). Every pipeline carries the
SAME eight fixed stages from baseline/canonical-model.md section 6, in order,
nothing renamed or removed; stages may be APPENDED after Done, mapping to an
explicit NULL. Entry/exit criteria per stage, plus the BINDING
stage -> canonical-step map (Tier-1) and the one-owner-per-transition move map.
State Lost-as-status with a native reason (card stays where it died), Done sets
status Won, and one card per CYCLE (only Done or Lost mint a new one).
Brownfield: the disposition table (keep / rename / retire / archive) for every
existing object, from captures/<date>/audit-report.md.

## 3. Workflow list
STARTS FROM the base set in baseline/base-workflows.md: the fourteen always-on
workflows on their reserved numbers, plus the conditional ones whose condition
this client meets. Numbered, flat chronological. Number, exact name, trigger(s),
one-line job, kill-switch relationships reproducing the removal matrix (nothing
removes the 20-series). Additions go at UNUSED numbers and are justified in
section 12; nothing is renumbered and gaps are information. This list IS the
workflow roster; module docs may not invent workflows absent here.

## 3A. Mechanism policies (binding)
Concrete policy, with numbers, for each key journey moment, decided HERE and never
deferred to a module agent. Every unknown is a {{FILL_*}} token, never vague prose
("promptly", "a few", "as needed").
- Speed to lead: the in-hours action, the out-of-hours action, the fallback when
  no AI conversation exists, and the retry cap.
- Day-before confirmation ask: when it fires; the YES branch (who replies, which
  team alert); the silence branch (after how many hours, which alert).
- Missed-call cooldown: the window and the once-per rule.
- Deposit chase cadence (only if the offer takes a deposit): each touch and its wait.
Module agents (workflows, voice) build to these numbers exactly, as binding as names.

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
manifest_version 2. The design-time client-manifest.json values this build
commits to, with field_lifecycle tags (design-time / harvest /
execution-discovered): pipelines[] with per-pipeline stage_ids keyed by the
eight fixed stage NAMES, base_workflows (absent key = not built),
lost_reason_ids, per_cycle_fields with their staging-slot pointers, and knobs.
No per-client stage -> canonical map: at version 2 that lives in the schema.

## 11. Doc index (binding)
Every design doc: NN filename, owner role, one-line contents. Assigned BEFORE
any module agent writes; cross-references use these names only.

## 12. Divergence log, additions + amendments
ADDITIONS: every workflow, stage, field or tag added on top of the Standard
Build, each naming the strategy mechanic that forced it.
DIVERGENCES: every departure from a Tier-2 baseline default with a one-line
reason. Tier-1 (canonical-model.md, base-workflows.md, ai-agent-contract.md) is
not divergeable; a strategy that cannot be served inside it is a blocking
objection recorded here, not a quiet redesign.
Registry amendments append here dated, and invalidate dependent docs via the
run manifest.

## 13. Version stamps
Plugin commit SHA, dependency clone SHAs + dirty flags, run date. Provided by
the PM in the architect's bootstrap prompt; copied here verbatim.
