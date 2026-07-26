---
name: doctor
description: Environment and prerequisite checks for the Grom client factory. Run this first on any new machine, before any other factory skill, or when another factory skill fails its preflight. Creates ~/.grom-factory.json, verifies gh auth + repo access + dependency clones + freshness + the offline integrity of the internal audit bundle/manifest/proof index, and walks the agent-level checks (GHL MCP reachability, PIT scopes, logged-in GHL browser session). Every failure names the human who can grant the fix.
---

# doctor

## Step 1: mechanical checks

Run `bash <plugin>/skills/doctor/checks.sh` and read the CHECK/PASS/FAIL table.
A line may also read WARN. WARN is not a soft failure and does not affect the
exit code: it means a thing that is legitimately absent on this machine is
absent, and it names what stays unavailable until someone supplies it.

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
SECRETS RULE: this file holds paths, booleans, expected hashes, and references
to secrets. Never write a token, key, or secret into it.

The `audit-bundle`, `audit-manifest`, `audit-tool-profile`, `audit-proof-index`
and `audit-credentials` lines cover the internal GHL audit MCP that the weekly
auditor drives. They are LOCAL AND STRUCTURAL ONLY. They hash files on disk and
parse JSON; they never start the audit server, open a socket, call GHL, or read
a credential. Passing all five proves CONTRACT AND BUNDLE INTEGRITY ONLY — that
the bundle, manifest, and six-tool read-only profile on this machine are the
exact artefacts the offline gate approved. It is never evidence that any
capability was exercised against a live account. That evidence comes only from
the live canary, which is separately human-gated (`--live`, a named `--approver`,
and `GHL_AUDIT_CANARY_APPROVED=1`, all three) and short-lived (a receipt expires
within 30 days and cannot be renewed by re-running doctor). A green doctor plus
an empty or expired proof index still means every capability is unproven and the
weekly run publishes `complete_partial`.

They are configured under an `audit` block, all values optional:

    "audit": {
      "bundle_path": "<abs path to the internal MCP's dist/audit-server.mjs>",
      "expected_bundle_hash": "sha256:...",
      "manifest_path": "<abs path to audit-capability-manifest.json>",
      "expected_manifest_hash": "sha256:...",
      "expected_tool_profile_hash": "sha256:...",
      "proof_index_path": "<abs path to the capability proof index>",
      "credential_reference": { "type": "protected-file", "path": "<abs path>" }
    }

The three expected hashes are the values the internal MCP's audit canary prints
as `bundleHash`, `capabilityManifestHash` and `toolProfileHash` in its DRY RUN
report (`node scripts/audit-canary.mjs`, which makes no network call). Grantor
for all three, and for the proof index: Xander, who owns the internal MCP repo.

Remediation by line:

- `audit-*` WARN `not configured` — nothing is broken; this machine simply has
  no internal audit rail yet. The weekly auditor still runs public-only and
  publishes `complete_partial`. Ask Xander for the paths and canary hashes.
- `audit-bundle` / `audit-manifest` FAIL on a hash — the artefact on disk is not
  the one the offline gate approved. Rebuild it from the internal MCP
  (`npm run build`, `npm run manifest`) and re-pin, or restore the approved
  copy. Do not re-pin a hash to make a red line green without knowing why it
  moved; every existing receipt is bound to the old hashes and is now void.
- `audit-manifest` FAIL `not internally self-hashing` — someone hand-edited the
  manifest. Regenerate it; never patch `manifestHash` by hand.
- `audit-tool-profile` FAIL — the audit profile is no longer exactly the six
  read-only tools. Treat as a security regression in the internal MCP and stop;
  grantor: Xander.
- `audit-bundle` FAIL `symlink` — the configured path must be the regular file
  itself, so that what is hashed is what is loaded.
- `audit-proof-index` WARN — expected today. Full eligibility needs an unexpired
  `live_runtime` receipt for every capability the run touches; minting them is
  the human-gated canary, not a doctor fix.
- `audit-proof-index` FAIL — the index is corrupt or not schema 1.0. Treat the
  receipts as void and re-run the canary; grantor: Xander.
- `audit-credentials` FAIL `raw credential material` — a token or key was
  written into `~/.grom-factory.json`. Remove it, rotate it, and replace it with
  a `credential_reference`. Only the reference belongs in this file; doctor
  validates its shape and deliberately never opens it.

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

Output one table: every check, PASS/FAIL/WARN, and for each FAIL the exact fix
command or the named grantor. For each WARN, say what stays unavailable while
it stands. Exit advice: which factory skills are runnable right now with the
current state, and — when any `audit-*` line is WARN or FAIL — state plainly
that a weekly audit run can only publish `complete_partial`.
