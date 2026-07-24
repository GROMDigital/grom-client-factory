# Task 10 implementation report

## Approved base and floor

- Approved Task 9 HEAD: `09fab7c8b027b85d27cc7ff7c4c8ee07882bf3e7`
- Independently approved Task 9 floor: 231 tests passed, 0 failed
- Independently approved Task 9 build, bundle, direct-process CLI, replay,
  syntax, and diff gates: passed
- Local pre-Task-10 legacy floor: 11 tests passed, 0 failed
- Node: `v24.13.0`
- Python: `3.13.7`

No live GHL, browser, MCP, model, credential, keychain, portal database,
mutation, scheduler, deployment, release, push, or Task 11 work is authorized.

## Frozen pre-Task-10 hashes

```text
56d76b59d1b84dcb549df096699fbb02bb531300b5dffcef43586cf89b74cf99  skills/ghl-account-audit/SKILL.md
e9c1a049144c1aa5cd2a98edafdc7e8442869d39ea85aaee01e98aae2220d6db  skills/ghl-account-audit/capture/capture-runbook.md
0946806959753cb2ec54762df53e38e371332683c872134b29cdb20ed3d39c57  skills/ghl-account-audit/capture/throttle.py
1a8a41adff7bdd289ff0000ac03ef3d33ffa94530aec4d14aae853fb086a13f3  skills/ghl-account-audit/capture/validate_workflow_capture.py
cd0d79182afa95653d979b5eca0bd17adc7e345d4113e983c2db9484e608405d  skills/ghl-account-audit/capture/workflow-json-shape.md
dbac854d3db585173372906e8a8c8caa7193559197122fef8e10f66da8ec1e66  skills/ghl-account-audit/capture/PROVENANCE.md
61bfbfde65fd96b4267d78540d9f75c4168ea96ee82092be97726536d7fda589  skills/ghl-account-audit/scripts/sanitize_capture.mjs
0e6cb8912fdc0915a6c33ff9d8b1305b1e4d7d3a324bb8c3baaef9801ae6e37f  skills/ghl-account-audit/scripts/golive_check.mjs
3247a06fc1ebc95bdf392369cce14b8152fefec3fd941d433b7c793b73c7f02b  baseline/validate.mjs
e660dedeeb960ee22ce4166752c586e7bf0b8b115c275806f63e0f38d9c5a4eb  baseline/client-manifest.schema.json
8aac90dc74b2b20ece14e56705bb9a911b2ebcbf53c9f362b4c6f03a1a25feba  baseline/tests/validate.test.mjs
9037f3bc358297ec8fe0647b89ab1f3abd22fa04e8e6b4685033c2e7d3d92455  skills/ghl-account-audit/tests/sanitize.test.mjs
f15a2592296b56cba07feee125c31731a7a7af780d603a966f54440e53b6eeaa  skills/ghl-account-audit/tests/golive.test.mjs
```

## RED evidence

The complete 15-test compatibility module and local workflow fixture were
written before any wrapper implementation.

Command:

```text
node --test skills/ghl-account-audit/tests/legacy-compatibility.test.mjs
```

Result:

- Node: `v24.13.0`
- Python: `3.13.7`
- Exit code: `1`
- Tests: 1 module-level test
- Passed: 0
- Failed: 1
- Expected first failure: `ERR_MODULE_NOT_FOUND` for
  `skills/ghl-account-audit/lib/adapters/legacy-capture.mjs`

The test file passed `node --check` first. Imports reached the missing required
product module, so the RED failure was not caused by test syntax, a missing
fixture, or the Python executable.

## GREEN evidence

### Focused compatibility

Command:

```text
node --test skills/ghl-account-audit/tests/legacy-compatibility.test.mjs
```

Result: 20 tests passed, 0 failed. The required 15 named compatibility tests
pass, plus five RED-first hardening cases for nested browser-location drift,
stable throttle-stop errors, invalid workflow capture, pre-mutation harvest
input validation, stale-ID clearing, and same-byte manifest inode replacement.

### Legacy floor

Command:

```text
node --test \
  skills/ghl-account-audit/tests/sanitize.test.mjs \
  skills/ghl-account-audit/tests/golive.test.mjs \
  baseline/tests/validate.test.mjs
```

Result: exactly 11 tests passed, 0 failed: sanitizer 5, go-live 2, baseline 4.

### Full runtime and baseline

- `npm --prefix skills/ghl-account-audit test`: 251 passed, 0 failed
- runtime plus baseline globs: 255 passed, 0 failed
- `npm --prefix skills/ghl-account-audit run build`: passed
- unchanged Python workflow validator: `VALID`, exit 0
- Task 9 offline replay: exit 0, `complete_partial`, safe canonical status
- adapter and all three mode syntax checks: passed
- `git diff --check`: passed

### Frozen compatibility files

Every frozen capture-engine, sanitizer, go-live, baseline, and 11-test-floor
hash still matches the pre-Task-10 hash above. `SKILL.md` changed only after
compatibility passed, adding explicit `weekly` selection and local
proposal-only language while retaining capture as the default.

## Implemented behavior

- Capture preserves the legacy date tree, raw ignore, raw and sanitized JSON
  names, browser workflow fallback files, snapshot Markdown, manifest, and
  disposition-input report.
- Browser workflow collection waits before every default and optional GET,
  validates nested location provenance, and stops once on 401, 403, or 429
  without retry or public-list substitution.
- Exact same-date retries do not rewrite files. Any unexpected or
  byte-different existing artifact fails with `LEGACY_CAPTURE_CONFLICT`.
- Invalid full workflow evidence is reported as incomplete and cannot produce
  a capture PASS or workflow verify PASS.
- Verify executes baseline, workflow, stage, named-object, and go-live checks
  in order with stable evidence references and never changes the client
  manifest.
- Scheduled harvest fails before every effect. Interactive harvest changes
  only `harvest` lifecycle paths from exact unique same-location live matches.
- Stale unverified IDs are cleared when exact proof is missing.
  `ids_harvested` depends only on complete lifecycle proof, not go-live output.
- Manifest updates use a same-directory temporary file, fsync, original-byte
  hash and inode checks, atomic rename, and directory fsync.
- Capture, verify, and harvest create no weekly state, review request, memory
  event, proposal, or publication path.

## Identity and boundaries

- Repository: `GROMDigital/grom-client-factory`
- Commit identity: `Thomas Tuley <gromdigital001@gmail.com>`
- No live GHL, browser, MCP, model, keychain, credential, portal database,
  mutation, scheduler, deployment, release, push, or Task 11 operation ran.

## Remaining concern

The wrappers intentionally require their collectors and workflow validator as
injected host seams. This keeps Task 10 free of a new network client, browser
driver, credential path, or unrestricted subprocess surface while retaining
the checked-in legacy runbook, throttle, validator, sanitizer, baseline, and
go-live tools as the authorities used by the host.

## Independent-review hardening

An independent review found two critical and two important compatibility
gaps. Four adversarial tests were added before the fixes.

Initial focused hardening result:

- command:
  `node --test skills/ghl-account-audit/tests/legacy-compatibility.test.mjs`
- exit code: 1
- tests: 24
- passed: 20
- failed: 4

The failures proved that a collector with a forged public-policy envelope
could dispatch, private values in live names could enter Markdown, cross-
workflow browser evidence could pass, and verify could run with a missing or
empty design registry.

Final focused hardening result: 24 tests passed, 0 failed.

Final review-hardening gates:

- legacy floor: 11 passed, 0 failed;
- full package: 255 passed, 0 failed;
- full package plus baseline: 259 passed, 0 failed;
- build: passed;
- Task 9 offline replay: `complete_partial`, exit 0;
- unchanged Python validator: `VALID`, exit 0;
- frozen compatibility hashes, syntax, static network scan, authored
  no-em-dash scan, and diff checks: passed.

The hardening now:

- validates the exact Task 4 trusted action tuple through
  `loadTrustedPublicReadPolicy` and `assertTrustedAction`;
- binds tool, operation, provider, location, capability-manifest,
  allowlist, catalog revision, source hash, and source/provider versions before
  the collector can dispatch;
- rejects write-like operation and action semantics independently of a
  claimed GET/read classification while retaining an explicitly approved
  semantic-read POST;
- projects every interpolated Markdown value through the approved legacy
  sanitizer plus narrow credential and PII shape redaction;
- binds every browser response to its exact GET endpoint, file, location, and
  workflow request, and requires every exposed workflow identity to match;
- combines injected workflow conformance with authoritative full-evidence
  validity so an injected PASS cannot bypass a binding failure; and
- validates non-empty workflow, stage, calendar, payment-product, and AI-agent
  registry declarations before manifest reads, collection, or filesystem
  effects.
