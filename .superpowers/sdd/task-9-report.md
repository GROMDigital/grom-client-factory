# Task 9 implementation report

## Approved base and floor

- Approved Task 8 HEAD: `c0636a4b6cddea676ab119a50764095431b1f7b8`
- Independently approved Task 8 floor: 200 tests passed, 0 failed
- Scope: Task 9 public-only weekly orchestration and its minimal durable seams

No live GHL, internal MCP, model, credential, keychain, portal database,
mutation, scheduler, deployment, release, or push operation is authorized.

## RED evidence

The complete 12-test Task 9 suite and fixture were written before product
implementation.

Command:

```text
node --test skills/ghl-account-audit/tests/replay-resume.test.mjs
```

Result:

- Node: `v24.13.0`
- Exit code: `1`
- Tests: 1 module-level test
- Passed: 0
- Failed: 1
- Expected first failure: `ERR_MODULE_NOT_FOUND` for
  `skills/ghl-account-audit/lib/kernel.mjs`

The fixture and test module parsed far enough to resolve imports. Product
implementation had not started, and the required kernel export was absent.

## GREEN evidence

### Focused Task 9

Command:

```text
node --test skills/ghl-account-audit/tests/replay-resume.test.mjs
```

Result: 12 tests passed, 0 failed.

### Required regression set

Command:

```text
node --test \
  skills/ghl-account-audit/tests/state.test.mjs \
  skills/ghl-account-audit/tests/conversation-review.test.mjs \
  skills/ghl-account-audit/tests/mechanism-investigation.test.mjs \
  skills/ghl-account-audit/tests/publication.test.mjs \
  skills/ghl-account-audit/tests/weekly-memory.test.mjs
```

Result: 91 tests passed, 0 failed.

### Full package

Command:

```text
npm --prefix skills/ghl-account-audit test
```

Initial Task 9 result: 214 tests passed, 0 failed.

Final hardening result after independent review: 225 tests passed, 0 failed.

### Build, bundle, and static gates

- `npm --prefix skills/ghl-account-audit run build`: passed
- Kernel, weekly mode, CLI, state, conversation bridge, and mechanism module
  syntax checks: passed
- Checked-in `dist/audit-cli.mjs`: generated and current
- Bundle imports: Node built-ins only; the Temporal dependency is bundled
- Replay from outside the repository with dependency lookup absent: passed
- Replay stdout: one canonical safe `complete_partial` status record
- Replay stderr: empty
- Kernel/weekly/CLI model, network, raw-request, mutation, and confirmation
  static scan: clean
- `git diff --check`: passed

## Independent review hardening

The first independent Task 9 review found three critical and two important
gaps. A separate RED-first hardening module was added before the fixes.

Initial command:

```text
node --test skills/ghl-account-audit/tests/task9-hardening.test.mjs
```

Initial result: 0 passed, 5 failed.

The failures proved that:

- nested Task 8 shaped account-wide and impact overclaims were accepted;
- provider invocation identity and configuration were not durable;
- a fresh process reran completed adapters;
- completed checkpoints had no restorable output artifact; and
- the bundled CLI required injected host bindings.

Final focused command:

```text
node --test skills/ghl-account-audit/tests/task9-hardening.test.mjs
```

Final result: 11 passed, 0 failed.

Final package commands:

```text
npm --prefix skills/ghl-account-audit run build
npm --prefix skills/ghl-account-audit test
```

Final result: build passed; 225 tests passed, 0 failed.

## Implemented behavior

- First governed runs request at least 90 days and two declared mature sales
  cycles. Short provider history remains an explicit limitation.
- Later governed runs start at the compatible watermark minus at least 72
  hours and merge only exact native or approved stable event identities.
- Discovery, nomination, and falsification complete before prior finding
  memory is loaded.
- Public-only output is fail-closed to `complete_partial`, preserves missing
  internal workflow-definition/runtime limits, and cannot replace latest-full.
- The monotonic kernel checkpoints every phase, renews one location lease, and
  quarantines write/raw traces or verifier/publication integrity failures.
- Vault-key resolution and validation happens before state opening or audit
  path creation, and both key buffers are zeroed on every exit.
- Resume retains the run for exact frozen inputs. A mismatch creates a distinct
  logical run and copies no old checkpoint, request, nonce, result, page, or
  publication intent.
- Conversation and mechanism review modules now export strict serializable
  validator snapshots, pure response validators, and restoration seams without
  weakening their existing same-process contracts.
- Review requests, grant state, results, and single-use nonces persist in
  SQLite. Validation completes before one `BEGIN IMMEDIATE` compare-and-swap
  commits the consumed result and review-result checkpoint.
- Sealed request artifacts use deterministic location-bound private paths,
  restrictive permissions, atomic writes, exact-byte orphan adoption, and no
  prompt, rubric, transcript, key, or credential content.
- Empty review sets are persisted as explicit `not_required` records.
- Publication intents bind the complete revision. Identical retries reuse the
  publication ID; superseding revisions receive distinct immutable IDs.
- Task 8 shaped publications can only use the trusted verifier callback inside
  `publishAtomically`; a caller attestation cannot bypass that gate.
- The CLI strictly parses the five required commands, rejects unknown or
  duplicate flags, reads response/config files without following symlinks,
  and emits safe status fields or stable error codes only.
- Run invocation identity, provider descriptor, configuration hash, and frozen
  inputs persist in SQLite. Resume reloads the exact project-relative provider
  configuration and creates a distinct run on a hash or frozen-input mismatch.
- Completed phase outputs are canonical, AES-256-GCM encrypted, hash-bound to
  run, phase, and input, and restored from private checkpoint artifacts after a
  process restart. Tampering quarantines before adapter replay.
- Downstream review-sensitive phases use immutable input-addressed checkpoint
  revisions. Validated additional evidence produces a distinct publication
  while preserving every earlier checkpoint and publication intent.
- The bundled CLI contains a hermetic `local_fixture` runtime for offline
  execution and direct process testing. It accepts only the explicit
  `test-only:key` reference and never provides a live-provider binding.
- Recursive Task 8 shaped publication checks require both exact internal
  workflow limitations and reject nested account-wide scope, PASS verdicts,
  measured commercial impact, revenue promises, and broad report language.

## Crash and recovery seams exercised

- Every persisted phase is idempotent and conflicts on changed canonical bytes.
- Exact resume reuses the same run and revision intent.
- Frozen-input mismatch leaves old checkpoints and intents unchanged.
- Prepared and published intents survive state reopen and recover exactly once.
- Review requests and consumed results survive state reopen and replay is
  rejected.
- Invalid review validation leaves the request, nonce, grants, checkpoint, and
  result set unchanged.
- Existing replay publications recover only when every expected byte matches.
- Seeded crashes after all 13 non-review phase checkpoints resume in a fresh
  kernel without repeating any counted computation or publication effect.
- A crash after the review-request checkpoint restores one durable request and
  does not create another.
- A crash after the first item in a multi-review plan restores the encrypted
  plan and persists the complete request set without regenerating nonces.
- Publication retries after final rename or projection writes may re-enter the
  idempotent publisher, but each filesystem side effect occurs exactly once.
- Direct bundled child processes exercise `run`, `review-request`,
  conversation and mechanism `ingest-review`, `resume`, and `replay`; response
  replay is rejected.
- GET-shaped read traces pass; POST-shaped write traces quarantine before
  publication.

## Changed files

- `skills/ghl-account-audit/lib/kernel.mjs`
- `skills/ghl-account-audit/lib/local-runtime.mjs`
- `skills/ghl-account-audit/lib/modes/weekly.mjs`
- `skills/ghl-account-audit/cli/audit.mjs`
- `skills/ghl-account-audit/dist/audit-cli.mjs`
- `skills/ghl-account-audit/lib/state.mjs`
- `skills/ghl-account-audit/lib/review-bridge.mjs`
- `skills/ghl-account-audit/lib/mechanisms.mjs`
- `skills/ghl-account-audit/scripts/build.mjs`
- `skills/ghl-account-audit/tests/replay-resume.test.mjs`
- `skills/ghl-account-audit/tests/task9-hardening.test.mjs`
- `skills/ghl-account-audit/tests/conversation-review.test.mjs`
- `skills/ghl-account-audit/tests/mechanism-investigation.test.mjs`
- `skills/ghl-account-audit/tests/fixtures/weekly/client-partial-pagination/fixture.json`
- `.superpowers/sdd/task-9-report.md`

## Identity and boundaries

- Repository: `GROMDigital/grom-client-factory`
- Commit identity: `Thomas Tuley <gromdigital001@gmail.com>`
- No live GHL, internal MCP, model, keychain, credential, portal database,
  mutation, scheduler, deployment, release, or push operation ran.

## Remaining concern

`node:sqlite` remains experimental in Node 24 and emits its standard warning
when state is opened by library tests. The executable bundled CLI suppresses
only that exact known SQLite warning so successful machine-readable commands
retain empty stderr; other warnings still use Node's normal emitter.
