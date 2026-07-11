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

if [ -f "$CONFIG" ] && jq -e . "$CONFIG" >/dev/null 2>&1; then
  say config PASS "$CONFIG parses"
else
  say config FAIL "missing or invalid $CONFIG (doctor will offer to create it)"
fi

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

# check_clone <config_key> <check_id> <fail_hint>
# Applies the shared freshness/dirty/author_of rules for a single git-clone
# dependency and emits one `say` line under <check_id>. <fail_hint> is used
# only when the dep is unconfigured or not cloned.
check_clone() {
  dep_key="$1"
  check_id="$2"
  fail_hint="$3"
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
  for dep in client-lp-tracking ghl-workflow-api-docs; do
    check_clone "$dep" "dep:$dep" "not cloned; doctor will clone it"
  done
  check_clone "ghl-plugin" "peer:uxie-ghl-factory" "uxie-ghl-factory not configured; install /plugin marketplace add uxieee/uxie-ghl-factory or register the local clone (grantor: Xander)"
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
