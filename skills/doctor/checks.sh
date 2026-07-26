#!/usr/bin/env bash
# Mechanical half of doctor. Prints CHECK\tPASS/FAIL/WARN\tdetail lines; exit 0 only if
# nothing FAILED.
set -u
CONFIG="$HOME/.grom-factory.json"
fail=0
# WARN is a third state, not a soft FAIL: it prints in the same tab-separated shape and
# deliberately does NOT set `fail`. It exists for the internal-audit checks below, where an
# unconfigured or expired proof is an honest statement about Full eligibility rather than a
# broken machine. Only FAIL sets the exit code, exactly as before.
say() {
  printf '%s\t%s\t%s\n' "$1" "$2" "$3"
  if [ "$2" = FAIL ]; then fail=1; fi
  return 0
}

check_exact_keychain_reference() {
  local keychain_reference="$1"
  if ! command -v swift >/dev/null 2>&1; then return 1; fi
  # The reference travels through inherited descriptor 9, never argv or env.
  # SecItemCopyMatching requests attributes only and never secret data.
  exec 9<<<"$keychain_reference"
  swift - 9<&9 >/dev/null 2>&1 <<'SWIFT'
import Foundation
import Security

let input = FileHandle(fileDescriptor: 9).readDataToEndOfFile()
guard let raw = String(data: input, encoding: .utf8) else { exit(2) }
let service = raw.trimmingCharacters(in: .newlines)
let query = [
  kSecClass: kSecClassGenericPassword,
  kSecAttrService: service,
  kSecMatchLimit: kSecMatchLimitOne,
  kSecReturnAttributes: true,
] as CFDictionary
var result: CFTypeRef?
exit(SecItemCopyMatching(query, &result) == errSecSuccess ? 0 : 1)
SWIFT
  local result=$?
  exec 9<&-
  return "$result"
}

check_protected_key_file_reference() {
  local key_file_reference="$1"
  if ! command -v node >/dev/null 2>&1; then return 1; fi
  # The reference travels through inherited descriptor 9, never argv or env.
  # One descriptor-relative open/fstat sequence validates the same object.
  exec 9<<<"$key_file_reference"
  node 9<&9 >/dev/null 2>&1 <<'NODE'
const fs = require('node:fs');

let descriptor;
try {
  const path = fs.readFileSync(9, 'utf8').replace(/\n$/u, '');
  descriptor = fs.openSync(
    path,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
  );
  const metadata = fs.fstatSync(descriptor);
  const ownedByCurrentUser = typeof process.getuid !== 'function'
    || metadata.uid === process.getuid();
  process.exitCode = metadata.isFile()
    && ownedByCurrentUser
    && (metadata.mode & 0o7777) === 0o600
    ? 0
    : 1;
} catch {
  process.exitCode = 1;
} finally {
  if (descriptor !== undefined) fs.closeSync(descriptor);
}
NODE
  local result=$?
  exec 9<&-
  return "$result"
}

# hash_regular_file <path_reference> — prints "sha256:<hex>" for a REGULAR, non-symlink
# file. The reference travels through inherited descriptor 9, never argv or env. lstat,
# not stat, is what makes a symlink a failure instead of a silent follow to some other
# file. Hashing is local: no socket, no child beyond node, no credential.
# Exit 2 = not a regular file (symlink, directory, device); 1 = missing or unreadable.
hash_regular_file() {
  local file_reference="$1"
  if ! command -v node >/dev/null 2>&1; then return 1; fi
  exec 9<<<"$file_reference"
  node 9<&9 2>/dev/null <<'NODE'
const fs = require('node:fs');
const crypto = require('node:crypto');

try {
  const path = fs.readFileSync(9, 'utf8').replace(/\n$/u, '');
  if (!fs.lstatSync(path).isFile()) {
    process.exitCode = 2;
  } else {
    const bytes = fs.readFileSync(path, 'utf8');
    process.stdout.write(
      `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`,
    );
  }
} catch {
  process.exitCode = 1;
}
NODE
  local result=$?
  exec 9<&-
  return "$result"
}

# audit_manifest_facts <path_reference> — prints ONE tab-separated row for the checked-in
# audit capability manifest:
#
#   declaredHash selfHash chainHash schemaVersion profile proofModel toolProfileHash tools
#
# Canonicalization copies the generator exactly: object keys sorted recursively, the
# self-hash taken with `manifestHash` OMITTED (a hash covering its own placeholder could
# never be recomputed), and the chain hash taken over the WHOLE parsed manifest — the value
# the audit canary reports as capabilityManifestHash. toolProfileHash is the digest of the
# tool-name array, the same value the proof chain binds. Descriptor-9 discipline and exit
# codes match hash_regular_file; nothing here opens a socket or a credential.
audit_manifest_facts() {
  local manifest_reference="$1"
  if ! command -v node >/dev/null 2>&1; then return 1; fi
  exec 9<<<"$manifest_reference"
  node 9<&9 2>/dev/null <<'NODE'
const fs = require('node:fs');
const crypto = require('node:crypto');

const canonical = (value) => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonical(value[key])]),
    );
  }
  return value;
};
const digest = (value) => `sha256:${crypto.createHash('sha256').update(
  typeof value === 'string' ? value : JSON.stringify(canonical(value)),
).digest('hex')}`;

try {
  const path = fs.readFileSync(9, 'utf8').replace(/\n$/u, '');
  if (!fs.lstatSync(path).isFile()) {
    process.exitCode = 2;
  } else {
    const manifest = JSON.parse(fs.readFileSync(path, 'utf8'));
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
      process.exitCode = 3;
    } else {
      const { manifestHash: declared, ...rest } = manifest;
      const tools = Array.isArray(manifest.tools) ? manifest.tools : [];
      process.stdout.write([
        typeof declared === 'string' ? declared : '',
        digest(rest),
        digest(manifest),
        String(manifest.schemaVersion ?? ''),
        String(manifest.profile ?? ''),
        String(manifest.proofModel ?? ''),
        digest(tools),
        tools.filter((name) => typeof name === 'string').join(','),
      ].join('\t'));
    }
  }
} catch {
  process.exitCode = 1;
}
NODE
  local result=$?
  exec 9<&-
  return "$result"
}

# audit_proof_index_facts <path_reference> — strict parse of the external capability proof
# index; prints ONE tab-separated row of COUNTS ONLY:
#
#   total liveUnexpired expired nonLive nextExpiryDate
#
# Strictness mirrors the internal server's own validateProofIndex: schemaVersion 1.0, a
# receipts array, an exact per-receipt field set, sha256 digests, ISO timestamps, a known
# proof class, and no duplicate capability. No capabilityId, hash, timestamp beyond a date,
# receipt body, or path is ever emitted — expiry state is reported without echoing the
# untrusted contents it was derived from. Exit 3 = parses as JSON but is not a canonical
# proof index; 2 = not a regular file; 1 = missing or unreadable.
audit_proof_index_facts() {
  local index_reference="$1"
  if ! command -v node >/dev/null 2>&1; then return 1; fi
  exec 9<<<"$index_reference"
  node 9<&9 2>/dev/null <<'NODE'
const fs = require('node:fs');

const HASH = /^sha256:[0-9a-f]{64}$/u;
const FIELDS = [
  'attestationHash', 'capabilityDescriptorHash', 'capabilityId',
  'expiresAt', 'proofClass', 'provenAt',
].join(',');
const CLASSES = ['live_runtime', 'offline_contract'];
const isIso = (value) => typeof value === 'string'
  && /^\d{4}-\d{2}-\d{2}T/u.test(value)
  && !Number.isNaN(Date.parse(value));

try {
  const path = fs.readFileSync(9, 'utf8').replace(/\n$/u, '');
  if (!fs.lstatSync(path).isFile()) {
    process.exitCode = 2;
  } else {
    const index = JSON.parse(fs.readFileSync(path, 'utf8'));
    const receipts = index?.receipts;
    const strict = index && typeof index === 'object' && !Array.isArray(index)
      && index.schemaVersion === '1.0' && Array.isArray(receipts);
    const seen = new Set();
    const valid = strict && receipts.every((receipt) => {
      if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) return false;
      if (Object.keys(receipt).sort().join(',') !== FIELDS) return false;
      if (typeof receipt.capabilityId !== 'string' || receipt.capabilityId === '') return false;
      if (seen.has(receipt.capabilityId)) return false;
      seen.add(receipt.capabilityId);
      if (!HASH.test(receipt.attestationHash)) return false;
      if (!HASH.test(receipt.capabilityDescriptorHash)) return false;
      if (!isIso(receipt.provenAt) || !isIso(receipt.expiresAt)) return false;
      return CLASSES.includes(receipt.proofClass);
    });
    if (!valid) {
      process.exitCode = 3;
    } else {
      const now = Date.now();
      const live = receipts.filter((receipt) => receipt.proofClass === 'live_runtime');
      const unexpired = live.filter((receipt) => Date.parse(receipt.expiresAt) > now);
      const expired = live.length - unexpired.length;
      const next = unexpired
        .map((receipt) => receipt.expiresAt)
        .sort((left, right) => Date.parse(left) - Date.parse(right))[0];
      process.stdout.write([
        receipts.length,
        unexpired.length,
        expired,
        receipts.length - live.length,
        next ? next.slice(0, 10) : '-',
      ].join('\t'));
    }
  }
} catch {
  process.exitCode = 1;
}
NODE
  local result=$?
  exec 9<&-
  return "$result"
}

if [ -f "$CONFIG" ] && jq -e . "$CONFIG" >/dev/null 2>&1; then
  say config PASS "$CONFIG parses"
else
  say config FAIL "missing or invalid $CONFIG (doctor will offer to create it)"
fi

# Validate only the vault-key REFERENCE and its storage policy. This check
# intentionally never reads a protected key file, requests a keychain password,
# or includes the configured reference in output or a child-process argument.
check_audit_vault_reference() {
  local key_ref_json key_ref_type key_file key_name
  if ! jq -e '
    ([.. | objects | keys[]?]
      | any(test("^(encryption_?key|pseudonym_?key|key_?bytes|material)$"; "i")))
    | not
  ' "$CONFIG" >/dev/null 2>&1; then
    say audit-vault-key FAIL "raw vault key material is forbidden in config"
    return
  fi

  key_ref_json=$(jq -c '
    .audit.vault_key_reference
      // .audit.vaultKeyReference
      // .vault_key_reference
      // .vaultKeyReference
      // empty
  ' "$CONFIG" 2>/dev/null)
  if [ -z "$key_ref_json" ]; then
    say audit-vault-key FAIL "vault key reference missing from config"
    return
  fi
  key_ref_type=$(printf '%s' "$key_ref_json" | jq -r '.type // .provider // empty' 2>/dev/null)
  if ! printf '%s' "$key_ref_json" | jq -e '
    ((has("type") and (has("provider") | not))
      or (has("provider") and (has("type") | not)))
    and if ((.type // .provider) == "protected-file" or (.type // .provider) == "file")
      then has("path")
        and ((keys - ["type", "provider", "path"]) | length == 0)
      elif ((.type // .provider) == "os-keychain" or (.type // .provider) == "keychain")
      then ((has("name") and (has("reference") | not))
          or (has("reference") and (has("name") | not)))
        and ((keys - ["type", "provider", "name", "reference"]) | length == 0)
      else false
    end
  ' >/dev/null 2>&1; then
    say audit-vault-key FAIL "vault key reference fields are invalid"
    return
  fi
  case "$key_ref_type" in
    protected-file|file)
      key_file=$(printf '%s' "$key_ref_json" | jq -r '.path // empty' 2>/dev/null)
      case "$key_file" in
        /*) ;;
        *)
          say audit-vault-key FAIL "protected vault key file reference must be absolute"
          return
          ;;
      esac
      if check_protected_key_file_reference "$key_file"; then
        say audit-vault-key PASS "protected vault key file reference and permissions are valid"
      else
        say audit-vault-key FAIL "protected vault key file is missing, invalid, or insecure"
      fi
      ;;
    os-keychain|keychain)
      key_name=$(printf '%s' "$key_ref_json" | jq -r '.name // .reference // empty' 2>/dev/null)
      if [ -z "$key_name" ]; then
        say audit-vault-key FAIL "OS keychain reference is missing or unavailable"
        return
      fi
      if check_exact_keychain_reference "$key_name"; then
        say audit-vault-key PASS "OS keychain reference exists"
      else
        say audit-vault-key FAIL "OS keychain reference is unavailable"
      fi
      ;;
    *)
      say audit-vault-key FAIL "vault key reference provider is invalid"
      ;;
  esac
}

# --- internal audit MCP: LOCAL STRUCTURAL CHECKS ONLY ------------------------------------
# These four checks answer one question: are the audit bundle, capability manifest, tool
# profile, and proof index on this machine the exact artefacts the offline gate approved?
# That is contract and bundle integrity, nothing more. They never start the audit server,
# open a socket, contact GHL, or read a credential — so a clean run here is NOT evidence
# that any capability was ever exercised live. Full evidence still requires an unexpired
# live_runtime receipt per applicable capability, minted by the separately human-gated,
# short-lived canary. Unconfigured is WARN, not FAIL: a machine legitimately has no proof
# index yet, and a fabricated PASS here would be a fabricated canary.
AUDIT_TOOL_PROFILE='auth_status,list_workflows_complete,get_workflow,export_workflow,get_workflow_runtime_window,get_ai_configuration_bundle'

# audit_config <jq expression> — one string out of the config, or empty. Same jq-based
# config idiom as check_clone; the "no raw key material in config" rule still applies, so
# every value read here is a PATH or an expected HASH, never key or token material.
audit_config() {
  jq -r "($1) // empty" "$CONFIG" 2>/dev/null
}

check_audit_bundle() {
  local bundle_path expected_hash actual_hash probe
  bundle_path=$(audit_config '.audit.bundle_path // .audit.bundlePath')
  expected_hash=$(audit_config '.audit.expected_bundle_hash // .audit.expectedBundleHash')
  if [ -z "$bundle_path" ]; then
    say audit-bundle WARN "audit.bundle_path not configured; internal audit evidence stays complete_partial"
    return
  fi
  case "$bundle_path" in
    /*) ;;
    *)
      say audit-bundle FAIL "audit.bundle_path must be absolute"
      return
      ;;
  esac
  actual_hash=$(hash_regular_file "$bundle_path")
  probe=$?
  if [ "$probe" = 2 ]; then
    say audit-bundle FAIL "audit bundle is a symlink or not a regular file"
    return
  elif [ "$probe" != 0 ]; then
    say audit-bundle FAIL "audit bundle is missing or unreadable at the configured path"
    return
  fi
  if [ -z "$expected_hash" ]; then
    say audit-bundle WARN "audit bundle is a regular file but no expected_bundle_hash is pinned in config"
  elif [ "$actual_hash" = "$expected_hash" ]; then
    say audit-bundle PASS "audit bundle is a regular file and matches the configured expected hash"
  else
    say audit-bundle FAIL "audit bundle hash differs from the configured expected hash; rebuild the bundle or re-pin the hash"
  fi
}

# Emits BOTH audit-manifest and audit-tool-profile: the tool profile IS a field of the
# manifest, and reading the file twice could straddle a rewrite and report two different
# files as one.
check_audit_manifest_and_tool_profile() {
  local manifest_path expected_hash expected_profile_hash facts probe
  local declared self_hash chain_hash schema profile proof_model profile_hash tools
  manifest_path=$(audit_config '.audit.manifest_path // .audit.manifestPath')
  expected_hash=$(audit_config '.audit.expected_manifest_hash // .audit.expectedManifestHash')
  expected_profile_hash=$(audit_config '.audit.expected_tool_profile_hash // .audit.expectedToolProfileHash')
  if [ -z "$manifest_path" ]; then
    say audit-manifest WARN "audit.manifest_path not configured; internal audit evidence stays complete_partial"
    say audit-tool-profile WARN "audit.manifest_path not configured; the six-tool audit profile cannot be verified"
    return
  fi
  case "$manifest_path" in
    /*) ;;
    *)
      say audit-manifest FAIL "audit.manifest_path must be absolute"
      say audit-tool-profile FAIL "audit.manifest_path must be absolute"
      return
      ;;
  esac
  facts=$(audit_manifest_facts "$manifest_path")
  probe=$?
  if [ "$probe" = 2 ]; then
    say audit-manifest FAIL "capability manifest is a symlink or not a regular file"
    say audit-tool-profile FAIL "capability manifest is a symlink or not a regular file"
    return
  elif [ "$probe" != 0 ]; then
    say audit-manifest FAIL "capability manifest is missing, unreadable, or not a JSON object"
    say audit-tool-profile FAIL "capability manifest is missing, unreadable, or not a JSON object"
    return
  fi
  IFS=$'\t' read -r declared self_hash chain_hash schema profile proof_model profile_hash tools <<<"$facts"

  if [ "$declared" != "$self_hash" ]; then
    say audit-manifest FAIL "capability manifest is not internally self-hashing; manifestHash does not cover its own contents"
  elif [ "$schema" != "1.0" ] || [ "$profile" != "audit" ] || [ "$proof_model" != "external_capability_receipts_v1" ]; then
    say audit-manifest FAIL "capability manifest schemaVersion/profile/proofModel drifted from the offline gate"
  elif [ -z "$expected_hash" ]; then
    say audit-manifest WARN "capability manifest is canonical and self-hashing but no expected_manifest_hash is pinned in config"
  elif [ "$chain_hash" = "$expected_hash" ]; then
    say audit-manifest PASS "capability manifest is canonical, self-hashing, and matches the configured expected hash"
  else
    say audit-manifest FAIL "canonical capability manifest hash differs from the configured expected hash; regenerate the manifest or re-pin the hash"
  fi

  if [ "$tools" != "$AUDIT_TOOL_PROFILE" ]; then
    say audit-tool-profile FAIL "audit tool profile is not exactly the six read-only tools ($AUDIT_TOOL_PROFILE)"
  elif [ -z "$expected_profile_hash" ]; then
    say audit-tool-profile WARN "exactly the six read-only audit tools, but no expected_tool_profile_hash is pinned in config"
  elif [ "$profile_hash" = "$expected_profile_hash" ]; then
    say audit-tool-profile PASS "exactly the six read-only audit tools; profile hash matches the configured expected hash"
  else
    say audit-tool-profile FAIL "audit tool profile hash differs from the configured expected hash"
  fi
}

check_audit_proof_index() {
  local index_path facts probe total live expired non_live next_expiry
  index_path=$(audit_config '.audit.proof_index_path // .audit.proofIndexPath')
  if [ -z "$index_path" ]; then
    say audit-proof-index WARN "no capability proof index configured; every capability is unproven and the weekly run stays complete_partial until a human-gated live canary mints receipts"
    return
  fi
  case "$index_path" in
    /*) ;;
    *)
      say audit-proof-index FAIL "audit.proof_index_path must be absolute"
      return
      ;;
  esac
  facts=$(audit_proof_index_facts "$index_path")
  probe=$?
  if [ "$probe" = 2 ]; then
    say audit-proof-index FAIL "proof index is a symlink or not a regular file"
    return
  elif [ "$probe" = 3 ]; then
    say audit-proof-index FAIL "proof index is not a canonical schema-1.0 receipt index"
    return
  elif [ "$probe" != 0 ]; then
    say audit-proof-index FAIL "proof index is missing or unreadable at the configured path"
    return
  fi
  IFS=$'\t' read -r total live expired non_live next_expiry <<<"$facts"
  if [ "$total" = 0 ]; then
    say audit-proof-index WARN "proof index parses strictly but holds no receipts; Full eligibility needs a human-gated live canary"
  elif [ "$live" = 0 ]; then
    say audit-proof-index WARN "proof index parses strictly; 0 unexpired live_runtime receipts ($expired expired, $non_live not live_runtime); Full eligibility needs a human-gated live canary"
  elif [ "$expired" != 0 ] || [ "$non_live" != 0 ]; then
    say audit-proof-index WARN "proof index parses strictly; $live unexpired live_runtime receipts (next expiry $next_expiry), $expired expired, $non_live not live_runtime; any applicable capability without one keeps the run complete_partial"
  else
    say audit-proof-index PASS "proof index parses strictly; all $total receipts are unexpired live_runtime (next expiry $next_expiry); run-time applicability still decides Full eligibility"
  fi
}

# The internal audit rail's credential is REFERENCED here and nowhere else. This check
# validates the shape of the reference only: it never opens the file, never queries the
# keychain, never echoes the reference into output or a child-process argument, and never
# makes a network call to see whether the credential still works. An expired credential is
# discovered by the weekly run checkpointing at awaiting_internal_auth, not by doctor.
check_audit_credential_reference() {
  local credential_ref
  if ! jq -e '
    ([.. | objects | keys[]?]
      | any(test("^(token|access_?token|refresh_?token|bearer|password|secret|api_?key)$"; "i")))
    | not
  ' "$CONFIG" >/dev/null 2>&1; then
    say audit-credentials FAIL "raw credential material is forbidden in config"
    return
  fi
  credential_ref=$(jq -c '
    .audit.credential_reference
      // .audit.credentialReference
      // empty
  ' "$CONFIG" 2>/dev/null)
  if [ -z "$credential_ref" ]; then
    say audit-credentials WARN "no internal audit credential reference configured; the weekly run checkpoints at awaiting_internal_auth after preserving public evidence"
    return
  fi
  if printf '%s' "$credential_ref" | jq -e '
    ((has("type") and (has("provider") | not))
      or (has("provider") and (has("type") | not)))
    and if ((.type // .provider) == "protected-file" or (.type // .provider) == "file")
      then has("path")
        and ((keys - ["type", "provider", "path"]) | length == 0)
      elif ((.type // .provider) == "os-keychain" or (.type // .provider) == "keychain")
      then ((has("name") and (has("reference") | not))
          or (has("reference") and (has("name") | not)))
        and ((keys - ["type", "provider", "name", "reference"]) | length == 0)
      else false
    end
  ' >/dev/null 2>&1; then
    say audit-credentials PASS "internal audit credential reference is structurally valid (never opened, printed, or network-tested)"
  else
    say audit-credentials FAIL "internal audit credential reference fields are invalid"
  fi
}

if gh auth status >/dev/null 2>&1; then
  say gh-auth PASS "$(gh api user -q .login 2>/dev/null || echo authenticated)"
else
  say gh-auth FAIL "run: gh auth login (grantor: the team member themselves)"
fi

for repo in GROMDigital/grom-client-factory GROMDigital/client-lp-tracking uxieee/ghl-workflow-api-docs; do
  if gh repo view "$repo" --json name >/dev/null 2>&1; then
    say "repo-access:$repo" PASS readable
  else
    say "repo-access:$repo" FAIL "no access (grantor: Xander invites your GitHub user)"
  fi
done

# The weekly GHL auditor is a scoped Node 24 runtime. This only validates the
# local prerequisite; it does not start a diagnostic or contact GHL.
audit_node_major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
if [ "$audit_node_major" -ge 24 ]; then
  say audit-runtime PASS "Node $(node --version) supports the GHL audit runtime"
else
  say audit-runtime FAIL "Node 24+ required for the GHL audit runtime"
fi

# check_clone <config_key> <check_id> <fail_hint>
# Applies the shared freshness/dirty/author_of rules for a single git-clone
# dependency and emits one `say` line under <check_id>. <fail_hint> is used
# only when the dep is unconfigured or not cloned.
check_clone() {
  local dep_key="$1"
  local check_id="$2"
  local fail_hint="$3"
  local p behind dirty author
  p=$(jq -r ".deps[\"$dep_key\"].path // empty" "$CONFIG")
  if [ -n "$p" ] && [ -d "$p/.git" ]; then
    git -C "$p" fetch -q 2>/dev/null
    behind=$(git -C "$p" rev-list --count HEAD..@{u} 2>/dev/null || echo "?")
    dirty=$(git -C "$p" status --porcelain | head -1)
    author=$(jq -r ".deps[\"$dep_key\"].author_of // false" "$CONFIG")
    if [ -n "$dirty" ] && [ "$author" != "true" ]; then
      say "$check_id" FAIL "clone dirty on non-author machine ($p); reset or reclone"
    elif [ "$behind" = "?" ]; then
      if [ "$author" = "true" ]; then
        say "$check_id" PASS "$p on a local branch with no upstream (author-owned)"
      else
        say "$check_id" FAIL "no upstream tracking branch; switch to a tracked branch ($p)"
      fi
    elif [ "$behind" != "0" ]; then
      say "$check_id" FAIL "behind remote by $behind commits; pull ($p)"
    elif [ -n "$dirty" ]; then
      say "$check_id" PASS "$p current (dirty, author-owned)"
    else
      say "$check_id" PASS "$p clean and current"
    fi
  else
    say "$check_id" FAIL "$fail_hint"
  fi
}

if [ -f "$CONFIG" ]; then
  check_audit_vault_reference
  for dep in client-lp-tracking ghl-workflow-api-docs; do
    check_clone "$dep" "dep:$dep" "not cloned; doctor will clone it"
  done
  # peer:uxie-ghl-factory passes when the engine plugin is INSTALLED
  # (best-effort: a plugin cache dir under ~/.claude/plugins whose name
  # contains uxie-ghl-factory; the authoritative check is agent-level,
  # SKILL.md step 2: can the session see the uxie-ghl-factory skills)
  # OR when the configured clone is present and fresh.
  plugin_hit=$(find "$HOME/.claude/plugins" -maxdepth 4 -type d -name '*uxie-ghl-factory*' 2>/dev/null | head -1)
  ghl_clone=$(jq -r '.deps["ghl-plugin"].path // empty' "$CONFIG")
  if [ -n "$plugin_hit" ]; then
    say "peer:uxie-ghl-factory" PASS "installed plugin detected ($plugin_hit)"
  elif [ -n "$ghl_clone" ] && [ -d "$ghl_clone/.git" ]; then
    check_clone "ghl-plugin" "peer:uxie-ghl-factory" "unreachable"
  else
    say "peer:uxie-ghl-factory" FAIL "engine not found; install the plugin: /plugin marketplace add uxieee/uxie-ghl-factory (https://github.com/uxieee/uxie-ghl-factory), or register a local clone as deps[\"ghl-plugin\"].path (grantor: Xander)"
  fi
  root=$(jq -r '.client_root // empty' "$CONFIG")
  if [ -n "$root" ] && [ -d "$root" ]; then say client-root PASS "$root"; else say client-root FAIL "client_root missing in config"; fi
  pp=$(jq -r '.plugin_path // empty' "$CONFIG")
  if [ -n "$pp" ] && [ -d "$pp/.git" ]; then
    git -C "$pp" fetch -q 2>/dev/null
    pbehind=$(git -C "$pp" rev-list --count HEAD..@{u} 2>/dev/null || echo "?")
    [ "$pbehind" = "0" ] && say plugin-fresh PASS current || say plugin-fresh FAIL "plugin clone behind by $pbehind; pull"
  else
    say plugin-fresh FAIL "plugin_path missing/invalid in config"
  fi
  check_audit_bundle
  check_audit_manifest_and_tool_profile
  check_audit_proof_index
  check_audit_credential_reference
fi

exit $fail
