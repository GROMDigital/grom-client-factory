#!/usr/bin/env bash
# Mechanical half of doctor. Prints CHECK\tPASS/FAIL\tdetail lines; exit 0 only if all pass.
set -u
CONFIG="$HOME/.grom-factory.json"
fail=0
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

if [ -f "$CONFIG" ] && jq -e . "$CONFIG" >/dev/null 2>&1; then
  say config PASS "$CONFIG parses"
else
  say config FAIL "missing or invalid $CONFIG (doctor will offer to create it)"
fi

# Validate only the vault-key REFERENCE and its storage policy. This check
# intentionally never reads a protected key file, requests a keychain password,
# or includes the configured reference in output or a child-process argument.
check_audit_vault_reference() {
  local key_ref_json key_ref_type key_file key_mode key_name
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
      if [ ! -f "$key_file" ] || [ -L "$key_file" ]; then
        say audit-vault-key FAIL "protected vault key file is missing or invalid"
        return
      fi
      if [ ! -O "$key_file" ]; then
        say audit-vault-key FAIL "protected vault key file is not owned by the current user"
        return
      fi
      if ! exec 9<"$key_file"; then
        say audit-vault-key FAIL "protected vault key file is unavailable"
        return
      fi
      key_mode=$(node -e 'process.stdout.write((require("node:fs").fstatSync(9).mode & 0o7777).toString(8))' 2>/dev/null || echo invalid)
      exec 9<&-
      if [ "$key_mode" = "600" ]; then
        say audit-vault-key PASS "protected vault key file reference and permissions are valid"
      else
        say audit-vault-key FAIL "protected vault key file must use mode 0600"
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
fi

exit $fail
