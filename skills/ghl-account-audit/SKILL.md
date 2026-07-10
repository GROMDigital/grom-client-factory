---
name: ghl-account-audit
description: Read-only live-state capture and audit of one GoHighLevel sub-account for the Grom client factory. Use for pre-build capture of a new or brownfield client sub-account, post-build verification of a built account against its design docs, or harvesting live IDs into client-manifest.json. Combines the vendored workflow-JSON capture engine (browser JWT, throttled, GET-only) with a full MCP sweep (pipelines, fields, values, tags, calendars, users, phone numbers, AI agents). Never mutates the account. Sanitizes every capture before it can be committed.
---

# ghl-account-audit

READ-ONLY. This skill never creates, updates, or deletes anything in GHL. If a
finding needs fixing, it goes in the report for a human or a mutating skill.

## Preflight (every run)

1. Doctor floor: confirm `~/.grom-factory.json` exists and the target GHL MCP
   server responds to one cheap read (list pipelines). On failure, stop and
   point at `grom-client-factory:doctor`.
2. Resolve the client folder (argument, else cwd) and target location ID
   (argument, else `client-manifest.json`.ghl_location_id, else ask). Confirm
   both with the user before fetching anything.
3. Ask which mode: `capture` (default), `verify`, or `harvest`.

## Output convention (all modes)

`<client-folder>/captures/<YYYY-MM-DD>/`
- `raw/` untouched responses. ALWAYS gitignored: ensure the client repo's
  .gitignore contains `captures/**/raw/` before saving anything, and create it
  if missing.
- sanitized JSON copies (same filenames as raw/) via
  `node <skill-dir>/scripts/sanitize_capture.mjs raw/<f>.json <f>.json`
- snapshot markdown per area (shape mirrors the Sub-Account reference/ghl/
  convention): `pipelines.md`, `custom-fields.md`, `custom-values.md`,
  `tags.md`, `calendars.md`, `users.md`, `phone-numbers.md`, `ai-agents.md`,
  `workflows.md` (name, status, trigger, step count per workflow)
- `audit-report.md` the human report for the mode that ran
- `manifest.json` capture metadata: location ID, time, endpoint list, skips

COMMIT GATE: before any git add of a capture, run
`node <skill-dir>/scripts/sanitize_capture.mjs --check <file>` on every JSON
file staged from captures/. Any exit 1 = stop, sanitize, re-check. Raw files
are never staged.

## The sweep (modes capture + harvest)

MCP half (GET-equivalent MCP actions only), per area: pipelines + stages,
custom fields, custom values, tags, calendars, users, phone numbers,
conversation AI agents (and voice config where exposed). Save each raw
response under raw/, sanitized copy beside it, and write the area's snapshot
markdown with IDs in backticks so they are greppable.

Workflow-JSON half: follow `capture/capture-runbook.md` verbatim (browser JWT
from the builder iframe, `Authorization: Bearer`, GET only,
`python3 capture/throttle.py wait` before EVERY internal fetch, stop on
429/403). Default scope: workflow list + per-workflow config and trigger JSON
for workflows the user names, or all ACTIVE workflows if asked for a full
sweep. Validate each capture directory with
`python3 capture/validate_workflow_capture.py <dir>` before reporting.

## Mode: capture (pre-build; MANDATORY before client-design on any existing location)

Run the sweep, then write `audit-report.md`:
- Inventory: counts per area, active vs draft workflows, snapshot-stock vs
  custom-looking objects (name heuristics: stock snapshot names, unnumbered
  workflows, duplicate-looking fields)
- Collision surface: existing custom-field keys, tag spellings, calendar
  names, pipeline names a new design must not collide with
- A DISPOSITION INPUT table for the Systems Architect: every existing
  workflow/pipeline/field with a suggested keep / rename / retire / archive
  and a one-line reason. The architect decides; this table is input, not
  verdict.

## Mode: verify (post-build)

Inputs: the design doc set + registry + `client-manifest.json` + a fresh sweep.
Checks, in order:
1. `node <plugin-root>/baseline/validate.mjs <client-folder>` passes (mechanical floor)
2. Every workflow in the registry's workflow list exists live, is PUBLISHED,
   and its trigger type matches the spec; embedded notification steps exist in
   the workflows the specs say (spot-check via captured workflow JSON)
3. Every stage in the registry's stage map exists live; IDs in the manifest
   match live IDs
4. Calendars, payment product names, AI agents present and named exactly as
   the registry declares
5. `node <skill-dir>/scripts/golive_check.mjs <client-folder>/client-manifest.json`
   passes (all execution-discovered fields filled, ids_harvested true)
Report: `audit-report.md` with PASS/FAIL per check, every failure naming the
doc section it contradicts. Any FAIL = the account is not go-live ready.

## Mode: harvest (manifest completion)

From the fresh sweep, fill `client-manifest.json`:
- `ghl_location_id`, `pipeline_id`, stage UUIDs for `stage_map` (replace
  design-time stage-name keys with live IDs, preserving the canonical-step
  values), `calendar_ids`, AI agent IDs, phone number if present, PIT vault
  secret NAME if the operator provides it (never the token)
- Set `ids_harvested: true` only when every `harvest`-lifecycle field is
  filled; report what remains otherwise
- Never invent an ID: anything not found live stays null and is listed in the
  report
Then run `golive_check.mjs` and include its output in the report.

## Boundaries (inherited + plugin)

- GET only, scoped iframe JWT, one location per session, throttle before every
  fetch, stop on 429/403 (see capture/PROVENANCE.md)
- No auth headers, session tokens, cookies, or CAPI tokens in any committable
  file: the sanitizer is not optional
- Sanitizer coverage boundary: it redacts values under secret-named keys, cookie
  values, and shaped tokens (Bearer, JWT, Meta CAPI) anywhere including inside
  arrays and embedded in longer strings. It does NOT recognize an opaque secret
  with no known shape sitting under a non-secret-named key (e.g. a raw provider
  key pasted into a free-text note or a custom header string). Eyeball each
  sanitized capture for stray secrets before committing; `--check` is a floor,
  not a guarantee
- No em dashes in authored reports; platform naming rules do not apply to
  these internal reports but DO apply if any text is destined for a client
