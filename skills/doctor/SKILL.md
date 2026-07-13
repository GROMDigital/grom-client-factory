---
name: doctor
description: Environment and prerequisite checks for the Grom client factory. Run this first on any new machine, before any other factory skill, or when another factory skill fails its preflight. Creates ~/.grom-factory.json, verifies gh auth + repo access + dependency clones + freshness, and walks the agent-level checks (GHL MCP reachability, PIT scopes, logged-in GHL browser session). Every failure names the human who can grant the fix.
---

# doctor

## Step 1: mechanical checks

Run `bash <plugin>/skills/doctor/checks.sh` and read the CHECK/PASS/FAIL table.

If `config` FAILED, create `~/.grom-factory.json` by asking the user for each
value (never guess paths):

    {
      "client_root": "<where client folders/clones live on this machine>",
      "plugin_path": "<this plugin's clone path>",
      "deps": {
        "client-lp-tracking": { "path": "<clone path>", "remote": "https://github.com/GROMDigital/client-lp-tracking.git", "author_of": false },
        "ghl-workflow-api-docs": { "path": "<clone path>", "remote": "https://github.com/uxieee/ghl-workflow-api-docs.git", "author_of": false },
        "ghl-plugin": { "path": "<clone path>", "remote": "https://github.com/uxieee/uxie-ghl-factory.git", "author_of": false }
      }
    }

The `ghl-plugin` entry is the local-clone FALLBACK for the workflow engine
(https://github.com/uxieee/uxie-ghl-factory). It is optional when the
uxie-ghl-factory plugin is installed via the plugin marketplace
(`/plugin marketplace add uxieee/uxie-ghl-factory`), which is the preferred
setup; skip creating it in that case.

`author_of: true` belongs ONLY on the machine of the person actively developing
that dependency (Xander today). It permits reading a dirty working tree as
truth; everywhere else a dirty clone is an error.

If a dep is `not cloned`, clone it from its `remote` into the configured path.
SECRETS RULE: this file holds paths and booleans only. Never write a token,
key, or secret into it.

## Step 2: agent-level checks (cannot be shelled)

1. GHL MCP server: confirm an MCP server for the TARGET sub-account is
   configured and responds (search for its tools, make one cheap read call,
   e.g. list pipelines). If missing: the user needs their own MCP config with
   their own token; grantor: Xander (documents the per-user setup).
2. PIT scopes (only when a target client/location is known): confirm a Private
   Integration Token exists for that location including `businesses.*`,
   `objects/schema.*`, `objects/record.*` (Business writes 401 without the
   objects scopes). Grantor: whoever has agency admin, Xander or Tom.
3. Browser session for JWT capture (only if the user is about to run
   ghl-account-audit): confirm a browser is available AND logged into
   app.gohighlevel.com with the target location visible. Grantor: the user, or
   Xander/Tom to add their seat to the location.
4. Open-PR warnings: run `gh pr list` on each dependency repo and surface open
   PRs as "process may be mid-change" warnings.
5. Workflow-creation engine (only when the user intends to create, build, or
   publish a GHL workflow programmatically). This agent-level check is
   AUTHORITATIVE over the mechanical `peer:uxie-ghl-factory` line from step 1
   (checks.sh only best-effort scans `~/.claude/plugins` for an installed
   copy). PASS if either resolves:
   - the uxie-ghl-factory plugin is installed and this session can see its
     skills (`uxie-ghl-factory:create-ghl-workflow`,
     `uxie-ghl-factory:build-workflow`,
     `uxie-ghl-factory:ghl-workflow-specialist`); this is the preferred
     source, or
   - the `create-ghl-workflow` skill is reachable inside the configured clone
     at `deps["ghl-plugin"].path`
     (`plugins/uxie-ghl-factory/skills/create-ghl-workflow/SKILL.md`) and the
     clone is fresh.
   If neither resolves, the remedy is: `/plugin marketplace add
   uxieee/uxie-ghl-factory` (repo: https://github.com/uxieee/uxie-ghl-factory),
   then install the plugin it offers; or register a local clone (grantor:
   Xander, author of the peer plugin). When running from a clone, include
   `deps["ghl-plugin"].remote` in the open-PR sweep from item 4 above, since
   it's the engine about to be driven.

## Step 3: report

Output one table: every check, PASS/FAIL, and for each FAIL the exact fix
command or the named grantor. Exit advice: which factory skills are runnable
right now with the current state.
