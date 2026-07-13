# grom-client-factory

Grom Digital's client-setup plugin for Claude Code. One invocation in a client
folder designs the whole build (docs, landing pages, manifest, go-live checklist);
sibling skills audit the live account and create workflows from the specs.

**The rule every skill carries:** the strategy defines the build; the baseline
defines how the build plugs into Grom's systems. There is no one-size-fits-all
build. Baseline = defaults to adapt, never law. Contracts (Tier 1) are the small
set that must hold so dashboards, portal, and tracking work without hand-wiring.

## Install (team)

Prerequisite: your GitHub account needs read access to the GROMDigital private
repos (`grom-client-factory`, `client-lp-tracking`). Grantor: Xander. Then
authenticate git locally: `gh auth login` (and `gh auth setup-git`).

**Standard install (straight from GitHub, recommended):**

1. In Claude Code: `/plugin marketplace add GROMDigital/grom-client-factory`
2. `/plugin install grom-client-factory@grom-client-factory`
3. Run the `grom-client-factory:doctor` skill first. It creates
   `~/.grom-factory.json`, checks every prerequisite (including cloning the
   dependency repos), and names the human who can grant anything missing.

**Developer install (working clone, Xander's setup):**

Clone this repo anywhere, then `/plugin marketplace add <path-to-clone>` and
install as above, or run Claude with `--plugin-dir <path-to-clone>` for a
session-only load. A clone install picks up local edits immediately; register
the clone as `plugin_path` in `~/.grom-factory.json` so doctor freshness-checks
it.

## Updating

All plugin updates land on `main` of this repo; installing is never a fork.

- Marketplace install: `/plugin marketplace update grom-client-factory`, then
  reinstall/restart if prompted.
- Clone install: `git pull` in the clone (doctor's `plugin-fresh` check tells
  you when you are behind).
- Dependency repos (`client-lp-tracking`, the workflow engine): doctor fetches
  and reports behind/dirty state every run; pull when it says so.

## Skills

| Skill | Does | Mutates |
|---|---|---|
| `doctor` | Environment + per-client prerequisite checks | Local config only |
| `client-design` (Plans 3, 5) | Full design factory: foundation research, binding registry, module fan-out, audit and fix loop, then a self-contained `system-guide.html` full-system review page. Role prompts shipped (Plan 3b); system-guide render shipped (Plan 5). Modes: fresh, ingest-answers, regen, resume, guide | Local files only |
| `ghl-account-audit` | Live-state capture, post-build verify, manifest harvest | Read-only vs GHL |
| `create-ghl-workflows` (Plan 4) | Drives the uxie-ghl-factory engine to create a client's designed workflows as DRAFTS from the registry and journey doc; hard mutation gate, one location per session, canonical names from the registry; the human reviews and publishes each draft in the UI (this skill never publishes) | LIVE sub-account writes (drafts only), gated |

## Layout

`baseline/` is the shared content library (contracts, defaults, templates,
validator). `skills/` are the entry points. Living dependencies
(`GROMDigital/client-lp-tracking` and `uxieee/ghl-workflow-api-docs`) are
cloned locally and read fresh each run; see `doctor`.

The workflow-creation engine lives at
https://github.com/uxieee/uxie-ghl-factory and resolves two ways, in this
order: (1) as an installed Claude Code plugin
(`/plugin marketplace add uxieee/uxie-ghl-factory`, preferred; its skills,
e.g. `uxie-ghl-factory:create-ghl-workflow`, are then visible in-session), or
(2) as a local clone registered in `~/.grom-factory.json` under
`deps["ghl-plugin"].path`. If neither resolves, `create-ghl-workflows` and
`doctor` fail with the marketplace install command. Either way the engine's
docs are read fresh each run.

## Tests

The baseline validator has a `node:test` suite. Run it with a glob, not a bare
directory (a bare directory arg fails on some Node builds):

    node --test 'baseline/tests/*.test.mjs'

`node baseline/validate.mjs <client-folder>` runs the validator directly:
exit 0 clean, exit 1 with one `RULE<TAB>file<TAB>detail` line per violation,
exit 2 on a usage error.

`validate.mjs` is the mechanical Tier-1 floor, not a full schema check: it
verifies top-level required fields are present and that stage_map values are
canonical steps, plus the text scans (em dashes, platform names, LP events,
fill tokens). It does not enforce nested requirements, enums, or patterns from
`client-manifest.schema.json`. A `validate: PASS` means the floor held, not that
the manifest is fully schema-valid; run a real draft-07 validator against the
schema when you need full conformance.
