# grom-client-factory

Grom Digital's client-setup plugin for Claude Code. One invocation in a client
folder designs the whole build (docs, landing pages, manifest, go-live checklist);
sibling skills audit the live account and create workflows from the specs.

**The rule every skill carries:** the strategy defines the build; the baseline
defines how the build plugs into Grom's systems. There is no one-size-fits-all
build. Baseline = defaults to adapt, never law. Contracts (Tier 1) are the small
set that must hold so dashboards, portal, and tracking work without hand-wiring.

## Install (team)

1. `gh auth login` with an account that can read the GROMDigital private repos.
2. Clone this repo anywhere, e.g. `~/grom/grom-client-factory`.
3. In Claude Code: `/plugin marketplace add <path-to-clone>` then
   `/plugin install grom-client-factory@grom-client-factory`, or run Claude
   with `--plugin-dir <path-to-clone>` for a session-only load.
4. Run the `grom-client-factory:doctor` skill first. It creates `~/.grom-factory.json`, checks every
   prerequisite, and names the human who can grant anything missing.

## Skills

| Skill | Does | Mutates |
|---|---|---|
| `doctor` | Environment + per-client prerequisite checks | Local config only |
| `client-design` (Plan 3) | Full design run: strategy gate, registry, module fan-out, reconcile | Local files only |
| `ghl-account-audit` (Plan 2) | Live-state capture, post-build verify, manifest harvest | Read-only vs GHL |
| `create-ghl-workflows` (Plan 4) | Launches the ghl-workflow-api-docs process against design specs | LIVE sub-account writes, gated |

## Layout

`baseline/` is the shared content library (contracts, defaults, templates,
validator). `skills/` are the entry points. Living dependencies
(`GROMDigital/client-lp-tracking`, `uxieee/ghl-workflow-api-docs`) are cloned
locally and read fresh each run; see `doctor`.

## Tests

The baseline validator has a `node:test` suite. Run it with a glob, not a bare
directory (a bare directory arg fails on some Node builds):

    node --test 'baseline/tests/*.test.mjs'

`node baseline/validate.mjs <client-folder>` runs the validator directly:
exit 0 clean, exit 1 with one `RULE<TAB>file<TAB>detail` line per violation,
exit 2 on a usage error.
