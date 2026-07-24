# Task 7 implementation report

## Base and scope

- Approved base: `c09ba484fc0d548460bc222dee4837c4df54b022`
- Scope: pure mechanism nomination, packet construction, sealed review
  contracts, hermetic fixture ingestion, deterministic reconciliation, tests,
  and the versioned mechanism-review rubric
- No CLI, orchestration, persistence, model call, live GHL call, supplemental
  read, credential access, portal database access, proposal execution,
  publication, push, release, or Task 8 behavior was added.

The Task 7 coverage seam is strict and explicit. It supplies deterministic
edge-scope and falsification facts to the pure nomination function. It does not
supply prior finding labels, recommendations, titles, or ranks. Unknown shapes
are rejected, missing facts remain inconclusive, and only Task 5 graph evidence
that is complete and observed can enter proof-bearing evidence lists.

## RED evidence

Command:

```text
node --test skills/ghl-account-audit/tests/mechanism-investigation.test.mjs
```

Environment and result:

- Node: `v24.13.0`
- Exit code: `1`
- Tests: `1`
- Pass: `0`
- Fail: `1`
- Expected failure: `ERR_MODULE_NOT_FOUND` for
  `skills/ghl-account-audit/lib/mechanisms.mjs`
- The import path and fixture setup were valid. The failure was caused by the
  required Task 7 implementation being absent.

## GREEN evidence

Focused command:

```text
node --test skills/ghl-account-audit/tests/mechanism-investigation.test.mjs
```

Result:

- Exit code: `0`
- Tests: `12`
- Pass: `12`
- Fail: `0`
- Cancelled, skipped, and todo: `0`

Full command:

```text
npm --prefix skills/ghl-account-audit test
```

Result:

- Exit code: `0`
- Tests: `160`
- Pass: `160`
- Fail: `0`
- Cancelled, skipped, and todo: `0`

Additional gates:

- `npm --prefix skills/ghl-account-audit run build`: pass
- `node --check skills/ghl-account-audit/lib/mechanisms.mjs`: pass
- `node --check skills/ghl-account-audit/workflows/review-mechanisms.mjs`: pass
- Rubric non-empty check: pass
- Required rubric vocabulary search: pass
- `git diff --check`: pass

## Contract evidence

- Confidence remains deterministic from C0 through C3. Current configuration
  without an event-time definition hash cannot become C3.
- All nine falsification families are canonical and mandatory. Missing or
  ineligible evidence becomes inconclusive.
- Nomination is order-independent and capped at five.
- Grom acquisition and onboarding denominators and comparators remain separate.
- Partial coverage permits only comparable-subset ranking and cannot create
  account-wide value claims or broad passes.
- One root fingerprint consumes one commercial slot. Commercial promotion is
  capped at three, while every positively evidenced critical issue remains in
  the separate critical lane.
- Packets are canonical, deeply immutable, non-executable, and SHA-256 bound.
- Review requests accept at most three packets. Each packet permits at most ten
  allowlisted supplemental descriptor IDs.
- Requests contain sealed paths and hashes only. Packet prose, prompt content,
  rubric content, raw evidence, credentials, and tool access are excluded.
- Response shape, hashes, timestamps, provenance, token use, evidence refs,
  packet IDs, supplemental descriptors, and safety fields validate before
  nonce consumption.
- Invalid responses preserve the nonce. Valid responses consume it once, and a
  repeated nonce cannot create a new same-process request.
- Reconciliation accepts only reviews issued by the validated Task 7 bridge.
  Expert output cannot replace metrics, confidence, coverage, eligibility,
  priority, packet identity, or evidence.
- The workflow never invokes the supplied `callModel` function.

## Changed files

- `skills/ghl-account-audit/lib/mechanisms.mjs`
- `skills/ghl-account-audit/workflows/review-mechanisms.mjs`
- `skills/ghl-account-audit/rubrics/mechanism-review-v1.md`
- `skills/ghl-account-audit/tests/mechanism-investigation.test.mjs`
- `.superpowers/sdd/task-7-report.md`

## Self-review

The implementation uses no arbitrary numeric priority score. It records and
sorts a versioned lexicographic tuple with stable root and candidate
tie-breakers. Null commercial inputs remain unknown rather than zero.
Overlapping roots are selected once and no impact values are summed.

Same-process nonce and validated-review state are intentionally narrow Task 7
primitives. Task 9 still owns durable checkpoint transitions and atomic
persisted nonce consumption.

## Independent-review hardening

Independent review identified five proof and promotion gaps. Five adversarial
tests were added before the fixes.

Hardening RED:

- Command:
  `node --test skills/ghl-account-audit/tests/mechanism-investigation.test.mjs`
- Exit code: `1`
- Tests: `17`
- Pass: `12`
- Fail: `5`
- Each new test failed against exactly one review finding:
  disconnected or asserted proof, promotion without review, self-rehashed
  inconsistent packets, caller-only comparator discovery, and contradictory
  full coverage.

Hardening GREEN:

- Focused tests: `17` passed, `0` failed
- Full tests: `165` passed, `0` failed
- Build: pass
- Mechanism library syntax: pass
- Review workflow syntax: pass
- Rubric content and vocabulary gates: pass
- `git diff --check`: pass

The hardened confidence contract now requires a connected exact
configuration-to-enrollment-to-execution chain for C3. Supporting evidence
must bind every chain edge, the metric and runtime evidence must observe the
predicted loss, effective definition hashes must match, and relevant conflicts
or unresolved joins cap confidence. C2 now requires repeated exact runtime
patterns across at least two graph-observed complete segments. Caller-provided
segment IDs cannot create proof.

Commercial promotion now requires a validated SUPPORTS review. Missing,
challenging, or inconclusive reviews route the packet to backlog. Packet
validation reconstructs its strict canonical body and recomputes confidence,
review eligibility, and promotion eligibility from sealed packet facts. A
self-rehashed packet with inconsistent deterministic fields is rejected.

Successful comparators are now discovered from complete observed journeys in
the graph, with caller hints used only for deterministic tie-breaking.
Contradictory `complete_full` coverage with a missing or partial capability is
capped to partial scope, cannot claim account-wide value, cannot retain C3,
and cannot be promoted.
