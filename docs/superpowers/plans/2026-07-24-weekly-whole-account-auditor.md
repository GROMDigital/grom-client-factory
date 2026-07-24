# Weekly Whole-Account GHL Auditor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Evolve `skills/ghl-account-audit` into a read-only weekly commercial diagnostic that reconstructs one location's journeys, verifies evidence coverage, identifies zero to three defensible commercial mechanisms, and publishes local proposal-only solution packs.

**Architecture:** Keep `SKILL.md` thin and put deterministic work in one bundled Node process. The process uses versioned profiles, a location-bound MCP transport, an immutable evidence/publication layer, `node:sqlite` materialized state, deterministic KPI and sampling engines, bounded model review, and a separate verifier. Public-only runs publish `complete_partial`; `complete_full` remains disabled until the separate internal MCP audit contract passes its own plan.

**Tech Stack:** Node.js 24.13.0, ESM, `node:test`, `node:sqlite`, `node:crypto`, `@modelcontextprotocol/sdk` 1.29.0, Zod 4.4.3, `@js-temporal/polyfill` 0.5.1, esbuild 0.28.1.

## Global Constraints

- Work only in `/Volumes/Xander SSD/Work/Clients/Grom Digital/grom-client-factory` for this plan.
- Before every commit, keep the repository-local identity `Thomas Tuley <gromdigital001@gmail.com>`.
- Never push from this plan.
- Never make a live GHL call from unit or replay tests.
- A manual public or internal smoke requires a separate explicit user instruction.
- The diagnostic profile exposes no mutation tools, `raw_request`, API mutation envelope, or `confirm:true`.
- Run one project and one `locationId` per logical run.
- Preserve the existing `capture`, `verify`, and `harvest` contracts and their current 11-test floor.
- Keep `capture` as the default mode during migration.
- Grom acquisition and onboarding use separate `journey_instance_id` values and denominators.
- The onboarding portal is a separate conditional adapter, not a GHL Courses surface.
- Courses, lessons, course offers and progress, Memberships, Communities, Assessments, Certificates, and course credentials are `NOT_APPLICABLE`.
- Missing evidence is `UNKNOWN`, never zero or healthy.
- Partial evidence cannot produce an account-wide top-leak ranking, clear an internal-dependent finding, or estimate whole-account loss.
- Proposal files remain non-executable and local until a separate approval and execution workflow.
- Auth values, cookies, headers, magic links, raw transcripts, names, emails, and phone numbers never enter publishable artifacts.
- No em dashes in authored reports.

## Repository File Map

Create or modify the following units. Do not add microservices, an event bus, a graph database, a web UI, vector storage, or autonomous surface agents.

```text
skills/ghl-account-audit/
├── SKILL.md
├── package.json
├── package-lock.json
├── cli/audit.mjs
├── dist/audit-cli.mjs
├── profiles/
│   ├── client.v1.json
│   ├── grom-internal.v1.json
│   ├── public-catalog-snapshot.v1.json
│   ├── public-read-allowlist.v1.json
│   ├── collection-budgets.v1.json
│   ├── client-metrics.v1.json
│   └── grom-internal-metrics.v1.json
├── rubrics/
│   ├── conversation-quality-v1.md
│   └── mechanism-review-v1.md
├── schemas/
│   ├── v1.mjs
│   └── generated/*.schema.json
├── scripts/
│   ├── build.mjs
│   ├── generate-public-allowlist.mjs
│   ├── generate-schemas.mjs
│   ├── validate_audit_artifact.mjs
│   ├── sanitize_capture.mjs
│   └── golive_check.mjs
├── lib/
│   ├── contracts.mjs
│   ├── canonical.mjs
│   ├── paths.mjs
│   ├── state.mjs
│   ├── kernel.mjs
│   ├── vault.mjs
│   ├── artifacts.mjs
│   ├── memory.mjs
│   ├── normalize.mjs
│   ├── evidence-graph.mjs
│   ├── metrics.mjs
│   ├── sampling.mjs
│   ├── review-bridge.mjs
│   ├── mechanisms.mjs
│   ├── proposals.mjs
│   ├── verifier.mjs
│   ├── schedule.mjs
│   ├── adapters/
│   │   ├── mcp-transport.mjs
│   │   ├── context.mjs
│   │   ├── portal-export.mjs
│   │   ├── public-ghl.mjs
│   │   ├── internal-ghl.mjs
│   │   └── legacy-capture.mjs
│   └── modes/
│       ├── weekly.mjs
│       ├── capture.mjs
│       ├── verify.mjs
│       └── harvest.mjs
├── workflows/
│   ├── review-conversations.mjs
│   └── review-mechanisms.mjs
└── tests/
    ├── *.test.mjs
    └── fixtures/weekly/<fixture-family>/
```

Also modify:

- `skills/doctor/checks.sh`
- `skills/doctor/SKILL.md`
- `.claude-plugin/plugin.json`
- `README.md`

The implementation depends on the separate plan:

`docs/superpowers/plans/2026-07-24-internal-mcp-audit-read-profile.md`

---

### Task 1: Add the scoped runtime, executable contracts, and profiles

**Files:**

- Create: `skills/ghl-account-audit/package.json`
- Create: `skills/ghl-account-audit/package-lock.json`
- Create: `skills/ghl-account-audit/schemas/v1.mjs`
- Create: `skills/ghl-account-audit/scripts/generate-schemas.mjs`
- Create: `skills/ghl-account-audit/scripts/build.mjs`
- Create: `skills/ghl-account-audit/profiles/client.v1.json`
- Create: `skills/ghl-account-audit/profiles/grom-internal.v1.json`
- Create: `skills/ghl-account-audit/profiles/public-catalog-snapshot.v1.json`
- Create: `skills/ghl-account-audit/profiles/public-read-allowlist.v1.json`
- Create: `skills/ghl-account-audit/profiles/collection-budgets.v1.json`
- Create: `skills/ghl-account-audit/profiles/client-metrics.v1.json`
- Create: `skills/ghl-account-audit/profiles/grom-internal-metrics.v1.json`
- Create: `skills/ghl-account-audit/scripts/generate-public-allowlist.mjs`
- Create: `skills/ghl-account-audit/tests/contracts.test.mjs`
- Create: `skills/ghl-account-audit/tests/profiles.test.mjs`
- Modify: `skills/doctor/checks.sh`

**Interfaces:**

- Produces `SCHEMA_VERSION = "1.0.0"`.
- Produces Zod schemas `TargetSchema`, `CoverageProfileSchema`, `RunManifestSchema`, `EvidenceRecordSchema`, `FindingSchema`, `ConversationSampleSchema`, `ProposalSchema`, and `ReceiptSchema`.
- Produces `loadProfile(profileId)`, `loadMetricContracts(profileId)`, `loadCollectionBudgets()`, and `assertAllowedPublicAction(profile, action)`.
- Later tasks consume only parsed values from these schemas.

- [ ] **Step 1: Create the package and write failing contract tests**

Use this exact package floor:

```json
{
  "name": "@gromdigital/ghl-account-audit-runtime",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "node scripts/generate-public-allowlist.mjs --check && node scripts/generate-schemas.mjs && node scripts/build.mjs",
    "test": "node --test \"tests/**/*.test.mjs\""
  },
  "dependencies": {
    "@js-temporal/polyfill": "0.5.1",
    "@modelcontextprotocol/sdk": "1.29.0",
    "zod": "4.4.3"
  },
  "devDependencies": {
    "esbuild": "0.28.1"
  }
}
```

The first tests must contain these assertions:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TargetSchema,
  ProposalSchema,
  ConversationSampleSchema,
} from '../schemas/v1.mjs';

test('target requires one location and a known operating profile', () => {
  assert.equal(TargetSchema.parse({
    targetKind: 'location',
    operatingProfile: 'client',
    locationId: 'loc-1',
  }).locationId, 'loc-1');
  assert.throws(() => TargetSchema.parse({
    targetKind: 'agency',
    operatingProfile: 'client',
    locationId: 'loc-1',
  }));
});

test('proposal is declarative and cannot contain execution fields', () => {
  assert.throws(() => ProposalSchema.parse({
    mode: 'PROPOSAL_ONLY',
    executable: false,
    approvalRequired: true,
    solutionId: 'S-1',
    packHash: 'a'.repeat(64),
    objectRefs: [],
    changeSet: {},
    preconditions: [],
    dependencies: [],
    rollout: {},
    rollback: {},
    guardrails: [],
    tests: [],
    evidenceRefs: [],
    confirm: true,
  }));
});

test('conversation sample manifest rejects transcript or message text', () => {
  assert.throws(() => ConversationSampleSchema.parse({
    schemaVersion: '1.0.0',
    seed: 'seed',
    universeCount: 1,
    selections: [{ subjectRef: 'p-1', transcript: 'private' }],
  }));
});
```

`profiles.test.mjs` must also load exact golden client and Grom profiles, validate every edge contract, prove the Grom journeys have separate denominators, reject unmapped required edges as anything other than `UNKNOWN`, verify the catalog snapshot hash and generated allowlist, and reject an action whose action ID matches but method, path, category, risk, or snapshot hash differs.

- [ ] **Step 2: Run the tests and confirm the missing-module failure**

Run:

```bash
npm --prefix skills/ghl-account-audit install
node --test skills/ghl-account-audit/tests/contracts.test.mjs
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `schemas/v1.mjs`.

- [ ] **Step 3: Implement the contract source and profiles**

Define strict schemas with this exported surface:

```js
import { z } from 'zod';

export const SCHEMA_VERSION = '1.0.0';
export const TargetSchema = z.object({
  targetKind: z.literal('location'),
  operatingProfile: z.enum(['client', 'grom_internal']),
  locationId: z.string().min(1),
  companyId: z.string().min(1).optional(),
}).strict();

const ExactStateSchema = z.object({
  current: z.record(z.string(), z.unknown()),
  proposed: z.record(z.string(), z.unknown()),
}).strict();
const ChangeSetSchema = z.discriminatedUnion('solutionType', [
  ExactStateSchema.extend({
    solutionType: z.literal('workflow_logic'),
    workflowId: z.string().min(1),
    triggers: z.array(z.string()),
    branches: z.array(z.string()),
    exits: z.array(z.string()).min(1),
    existingEnrollmentPlan: z.string().min(1),
  }).strict(),
  ExactStateSchema.extend({
    solutionType: z.literal('copy'),
    channel: z.string().min(1),
    audience: z.string().min(1),
    locale: z.string().min(1),
    finalText: z.string().min(1),
    mergeFields: z.array(z.string()),
    fallbacks: z.record(z.string(), z.string()),
    stopConditions: z.array(z.string()).min(1),
  }).strict(),
  ExactStateSchema.extend({
    solutionType: z.literal('wait_timing'),
    anchorEvent: z.string().min(1),
    duration: z.number().nonnegative(),
    unit: z.string().min(1),
    timezone: z.string().min(1),
    exitConditions: z.array(z.string()).min(1),
  }).strict(),
  ExactStateSchema.extend({
    solutionType: z.enum(['conversation_ai', 'voice_ai']),
    agentId: z.string().min(1),
    prompt: z.string().min(1),
    allowedTools: z.array(z.string()),
    guardrails: z.array(z.string()),
    escalationRules: z.array(z.string()).min(1),
    evaluationCases: z.array(z.string()).min(1),
  }).strict(),
  ExactStateSchema.extend({
    solutionType: z.literal('operating_process'),
    owner: z.string().min(1),
    raci: z.record(z.string(), z.string()),
    sla: z.string().min(1),
    trigger: z.string().min(1),
    completionEvidence: z.array(z.string()).min(1),
    escalation: z.array(z.string()).min(1),
  }).strict(),
]);

export const ProposalSchema = z.object({
  mode: z.literal('PROPOSAL_ONLY'),
  executable: z.literal(false),
  approvalRequired: z.literal(true),
  solutionId: z.string().min(1),
  packHash: z.string().regex(/^[a-f0-9]{64}$/),
  objectRefs: z.array(z.object({
    objectType: z.string().min(1),
    objectId: z.string().min(1),
    capturedVersion: z.union([z.string(), z.number()]).nullable(),
    capturedHash: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict()),
  changeSet: ChangeSetSchema,
  preconditions: z.array(z.string()),
  dependencies: z.array(z.string()),
  blastRadius: z.string().min(1),
  owner: z.string().min(1),
  monitoring: z.array(z.string()).min(1),
  rollout: z.record(z.string(), z.unknown()).refine((value) => Object.keys(value).length > 0),
  rollback: z.record(z.string(), z.unknown()).refine((value) => Object.keys(value).length > 0),
  guardrails: z.array(z.string()),
  tests: z.array(z.string()),
  evidenceRefs: z.array(z.string().min(1)),
}).strict();

export const ConversationSampleSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  seed: z.string().min(1),
  universeCount: z.number().int().nonnegative(),
  selections: z.array(z.object({
    subjectRef: z.string().min(1),
    stratum: z.string().min(1),
    inclusionProbability: z.number().positive().max(1),
    evidenceRefs: z.array(z.string()),
    scores: z.record(z.string(), z.number()).optional(),
  }).strict()),
}).strict();
```

Add the remaining exported schemas named in **Interfaces** with `.strict()` on every publishable object. Generate JSON Schema using Zod 4's `z.toJSONSchema`, sorted by filename.

Profiles must encode:

```json
{
  "profileId": "client",
  "version": "1.0.0",
  "targetKind": "location",
  "excludedCapabilities": [
    "courses",
    "lessons",
    "course_offers",
    "course_progress",
    "memberships",
    "communities",
    "assessments",
    "certificates",
    "course_credentials"
  ]
}
```

The Grom profile must declare distinct `agency_new_business` and `client_onboarding` journeys.

Each metric profile must define versioned adjacent-edge contracts. Every edge declares:

```json
{
  "edgeId": "booked_to_showed",
  "journeyId": "client_sales",
  "fromStage": "booked",
  "toStage": "showed",
  "eligibilityRule": {},
  "fromEventFields": [],
  "toEventFields": [],
  "allowedLag": { "amount": 14, "unit": "days" },
  "maturityRule": {},
  "dispositions": ["showed", "no_show", "cancelled", "unknown"],
  "reentryRule": "new_journey_instance",
  "outcomeRule": {}
}
```

The client contracts must cover lead creation to first engagement, engagement to qualification, booking, show, no-show, cancellation, rebooking, opportunity outcomes, collected revenue, and reactivation when the account context declares those stages. The Grom contracts must additionally cover the separate agency acquisition edges and onboarding milestones through launch and first value. If context cannot map a required semantic edge to native fields and events, that edge is `UNKNOWN`, not absent.

Create `public-catalog-snapshot.v1.json` as the reviewed source of truth captured from `search_actions`. It records catalog revision, capture time, source server identity, every candidate action's action ID, method, normalized path, category, risk, and a canonical SHA-256. `generate-public-allowlist.mjs` selects only entries carrying an explicit `approvedSemanticRead: true`; it never infers safety from `GET` or `POST`. The generated allowlist binds the same exact tuple and stores the source snapshot hash. Tests must fail on catalog hash drift, duplicate action IDs, tuple changes, an approval without provenance, or a generated diff not committed with the snapshot. Every unlisted `execute_action` request is rejected before dispatch.

`collection-budgets.v1.json` defines per-capability maximum pages, records, response bytes, request timeout, retry count, total retry delay, and wall-clock time. Budget exhaustion checkpoints the run and marks that scope incomplete.

- [ ] **Step 4: Generate schemas, bundle, and run the contract floor**

Run:

```bash
npm --prefix skills/ghl-account-audit run build
npm --prefix skills/ghl-account-audit test
node --test 'skills/ghl-account-audit/tests/*.test.mjs' 'baseline/tests/*.test.mjs'
```

Expected: all new tests PASS and the existing 11 tests remain PASS.

- [ ] **Step 5: Commit**

```bash
git config user.name "Thomas Tuley"
git config user.email "gromdigital001@gmail.com"
git add skills/ghl-account-audit skills/doctor/checks.sh
git commit -m "build(audit): add bundled runtime and versioned contracts"
```

---

### Task 2: Add canonical hashing, location-isolated paths, and durable run state

**Files:**

- Create: `skills/ghl-account-audit/lib/canonical.mjs`
- Create: `skills/ghl-account-audit/lib/paths.mjs`
- Create: `skills/ghl-account-audit/lib/state.mjs`
- Create: `skills/ghl-account-audit/tests/state.test.mjs`

**Interfaces:**

```js
canonicalJson(value) -> string
sha256(value) -> lowercase hex
auditPaths(projectRoot, locationId) -> frozen path map
openState({ projectRoot, locationId }) -> AuditState
AuditState.acquireLease({ runId, now, ttlMs })
AuditState.saveCheckpoint({ runId, phase, inputHash, outputHash, payload })
AuditState.assertResumeInputs(runId, frozenInputs)
```

- [ ] **Step 1: Write failing lease, resume, and idempotency tests**

```js
test('one active lease is allowed per location', () => {
  const state = openFixtureState();
  state.acquireLease({ runId: 'r1', now: 1000, ttlMs: 60000 });
  assert.throws(
    () => state.acquireLease({ runId: 'r2', now: 1001, ttlMs: 60000 }),
    /LEASE_HELD/,
  );
});

test('resume rejects changed frozen inputs', () => {
  const state = openFixtureState();
  state.createRun({ runId: 'r1', frozenInputs: {
    locationId: 'L1',
    cutoff: 1000,
    timezone: 'Australia/Sydney',
    contextHash: 'a',
    coverageProfileHash: 'b',
    rulesetHash: 'c',
    codeHash: 'code-1',
    auditProfileHash: 'profile-1',
    providerToolProfileHash: 'provider-1',
    windowDefinitionsHash: 'windows-1',
    capabilityProofIndexHash: 'proof-index-1',
    capabilityReceiptHashes: ['receipt-1'],
    capabilityAttestationHashes: ['attestation-1'],
    capabilityProofExpiries: [2000],
    capabilityManifestHashes: ['d'],
  }});
  assert.throws(() => state.assertResumeInputs('r1', {
    locationId: 'L1',
    cutoff: 2000,
    timezone: 'Australia/Sydney',
    contextHash: 'a',
    coverageProfileHash: 'b',
    rulesetHash: 'c',
    codeHash: 'code-1',
    auditProfileHash: 'profile-1',
    providerToolProfileHash: 'provider-1',
    windowDefinitionsHash: 'windows-1',
    capabilityProofIndexHash: 'proof-index-1',
    capabilityReceiptHashes: ['receipt-1'],
    capabilityAttestationHashes: ['attestation-1'],
    capabilityProofExpiries: [2000],
    capabilityManifestHashes: ['d'],
  }), /RESUME_INPUT_MISMATCH/);
});
```

Add a table-driven resume test that independently changes the proof-index hash, one applicable receipt hash, one attestation hash, and one expiry. Every mutation must return `RESUME_INPUT_MISMATCH` and create no checkpoint under the old run.

- [ ] **Step 2: Run and confirm failure**

Run:

```bash
node --test skills/ghl-account-audit/tests/state.test.mjs
```

Expected: FAIL because `openState` is not defined.

- [ ] **Step 3: Implement canonicalization, paths, and SQLite state**

Use a recursive canonicalizer that sorts object keys and preserves array order. `sha256` hashes the UTF-8 canonical JSON.

`auditPaths(projectRoot, locationId)` must resolve:

```text
<project>/audits/ghl/<locationId>/
  weekly/
  memory/events/
  private/raw/
  private/logs/
  private/checkpoints/
  .state/auditor.sqlite
```

Reject empty IDs, `..`, slashes, backslashes, or a resolved path outside `<project>/audits/ghl`.

Create SQLite tables:

```sql
CREATE TABLE runs (
  run_id TEXT PRIMARY KEY,
  location_id TEXT NOT NULL,
  status TEXT NOT NULL,
  frozen_inputs_json TEXT NOT NULL,
  frozen_inputs_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE leases (
  location_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE checkpoints (
  run_id TEXT NOT NULL,
  phase TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  output_hash TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  PRIMARY KEY (run_id, phase)
);
CREATE TABLE pages (
  run_id TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  page_key TEXT NOT NULL,
  artifact_hash TEXT NOT NULL,
  PRIMARY KEY (run_id, scope_id, page_key)
);
```

Transactions must make lease acquisition and checkpoint writes atomic.

Frozen inputs include the bundled code hash, audit and metric profile hashes, provider/tool-profile hash, exact window definitions, collection-budget hash, context hash, cutoff, timezone, target, capability-manifest hashes, canonical capability-proof-index hash, applicable receipt hashes, referenced attestation hashes, and proof expiries. Replacing or extending proof after a run starts creates a new logical run. A resume under different code, policies, provider tools, windows, budgets, or proof creates a new run rather than silently continuing the old one.

- [ ] **Step 4: Run targeted and full tests**

```bash
node --test skills/ghl-account-audit/tests/state.test.mjs
npm --prefix skills/ghl-account-audit test
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add skills/ghl-account-audit/lib skills/ghl-account-audit/tests/state.test.mjs
git commit -m "feat(audit): add durable run state and resumable leases"
```

---

### Task 3: Add the private vault, sanitization policy, and atomic publications

**Files:**

- Create: `skills/ghl-account-audit/lib/vault.mjs`
- Create: `skills/ghl-account-audit/lib/artifacts.mjs`
- Create: `skills/ghl-account-audit/tests/privacy-integrity.test.mjs`
- Create: `skills/ghl-account-audit/tests/publication.test.mjs`
- Modify: `skills/ghl-account-audit/scripts/sanitize_capture.mjs`
- Modify: `skills/doctor/checks.sh`

**Interfaces:**

```js
openVault({ paths, encryptionKey, pseudonymKey })
resolveVaultKeys({ keyReference, keyProvider }) -> { encryptionKey, pseudonymKey }
vault.sealRaw({ source, bytes, expiresAt }) -> { rawHash, opaqueRef }
sanitizeForPublication(value, { pseudonymKey }) -> sanitized value
publishAtomically({ paths, runManifest, payloadArtifacts, verifierAttestation })
```

- [ ] **Step 1: Write failing canary and publication tests**

Seed nested authorization values, JWTs, emails, phone numbers, names, transcripts, message bodies, and magic links. Assert:

```js
test('publishable artifacts contain no seeded private canaries', async () => {
  const result = sanitizeForPublication(privateFixture, {
    pseudonymKey: Buffer.alloc(32, 7),
  });
  const text = JSON.stringify(result);
  for (const canary of PRIVATE_CANARIES) assert.equal(text.includes(canary), false);
});

test('manifest root excludes the manifest and verifier to avoid circular hashing', async () => {
  const publication = await publishFixture();
  assert.deepEqual(
    publication.rootMembers.sort(),
    ['REPORT.md', 'coverage.json', 'metrics-and-findings.json'].sort(),
  );
  assert.equal(publication.attestation.manifestHash, sha256(publication.manifest));
  assert.equal(publication.attestation.publicationRoot, publication.manifest.publicationRoot);
});
```

Also test OS-keychain and protected-key-file reference adapters, missing keys, group/world-readable key-file rejection, redacted error paths, and process snapshots. Key bytes and key references must not appear in CLI output, logs, SQLite, checkpoints, manifests, crash messages, or publishable artifacts.

- [ ] **Step 2: Verify failure**

```bash
node --test \
  skills/ghl-account-audit/tests/privacy-integrity.test.mjs \
  skills/ghl-account-audit/tests/publication.test.mjs
```

Expected: FAIL because the vault and publisher modules do not exist.

- [ ] **Step 3: Implement the private/publishable boundary**

Required behavior:

- Raw directories are created with mode `0700`.
- Raw artifacts are encrypted with AES-256-GCM using key bytes passed into the process.
- Provider configuration stores only a named OS-keychain reference or an absolute protected-key-file reference. The protected file must be owned by the current user and mode `0600`; environment variables may name a reference but may not contain key bytes.
- `resolveVaultKeys` returns short-lived buffers to the vault, zeroes them after use, and never serializes them.
- Encryption and pseudonymization keys never enter files, SQLite, environment snapshots, or logs.
- Each raw record carries `expiresAt`, deletion state, and purge result.
- Purge writes an immutable `raw_evidence_expired` event.
- Published sample manifests contain pseudonymous references and evidence IDs only.
- Minimal claim-bearing excerpts may exist only under `evidence/sanitized/`.
- Existing `sanitize_capture.mjs` remains byte-compatible as a CLI wrapper over its current sanitizer behavior.
- Publication uses staging plus atomic directory rename.
- Weekly directories and event files are immutable.
- `CURRENT.md`, `index.json`, and backlog projections update atomically.
- A partial publication never overwrites the latest-full pointer.
- Doctor checks validate that the configured key reference exists and satisfies its permission policy without reading or printing the key value.

- [ ] **Step 4: Run privacy, publication, and compatibility tests**

```bash
node --test \
  skills/ghl-account-audit/tests/privacy-integrity.test.mjs \
  skills/ghl-account-audit/tests/publication.test.mjs \
  skills/ghl-account-audit/tests/sanitize.test.mjs
```

Expected: PASS with zero detected canaries.

- [ ] **Step 5: Commit**

```bash
git add skills/ghl-account-audit skills/doctor/checks.sh
git commit -m "feat(audit): add private evidence vault and atomic publications"
```

---

### Task 4: Add the MCP transport and read-only context, portal, and public adapters

**Files:**

- Create: `skills/ghl-account-audit/lib/adapters/mcp-transport.mjs`
- Create: `skills/ghl-account-audit/lib/adapters/context.mjs`
- Create: `skills/ghl-account-audit/lib/adapters/portal-export.mjs`
- Create: `skills/ghl-account-audit/lib/adapters/public-ghl.mjs`
- Create: `skills/ghl-account-audit/tests/adapters.test.mjs`

**Interfaces:**

```js
connectMcp({ transport, providerConfig, credentialResolver })
createContextAdapter({ projectRoot, profile })
createPortalExportAdapter({ exportPath, expectedLocationId })
createPublicGhlAdapter({ client, allowlist, expectedLocationId })
adapter.collect({ capability, window, cursor, signal })
```

Every `collect` result must have:

```js
{
  source,
  operationId,
  boundLocationId,
  requestedWindow,
  appliedWindow,
  capturedAt,
  items,
  page: {
    cursor,
    nextCursor,
    reportedCount,
    collectedCount,
    complete,
    truncated
  }
}
```

- [ ] **Step 1: Write failing policy and location-binding tests**

```js
test('public adapter rejects an unlisted action before MCP dispatch', async () => {
  let calls = 0;
  const adapter = createPublicGhlAdapter({
    client: { callTool: async () => { calls += 1; } },
    allowlist: approvedFixture,
    expectedLocationId: 'L1',
  });
  await assert.rejects(
    adapter.collect({ capability: { actionId: 'contacts-v3__create-contact' } }),
    /ACTION_NOT_ALLOWED/,
  );
  assert.equal(calls, 0);
});

test('wrong-location response quarantines collection', async () => {
  const adapter = fixtureAdapter({ responseLocationId: 'L2' });
  await assert.rejects(adapter.collect(readRequest), /LOCATION_MISMATCH/);
});
```

- [ ] **Step 2: Run and confirm failure**

```bash
node --test skills/ghl-account-audit/tests/adapters.test.mjs
```

Expected: FAIL with missing adapter modules.

- [ ] **Step 3: Implement exact transport and allowlist enforcement**

Support:

- Streamable HTTP MCP with credentials resolved from a named environment variable or approved secret-store callback.
- Local stdio MCP with an explicit command and argument array.
- Provider config files contain credential references only, never secret values.
- One provider and capability-manifest hash stay pinned for the run.
- Public `execute_action` dispatch requires an exact checked-in action ID, method, path, category, and risk classification.
- Safe read-like `POST` searches are permitted only when explicitly listed; method alone does not decide safety.
- Cursor loops, changing totals, rate-limit flags, truncation, or missing terminal proof produce incomplete coverage.
- Every collection is bounded by the versioned capability budget. Tests cover maximum pages, records, response bytes, request timeout, retry count, total retry delay, and wall-clock time. Exhaustion saves a resumable checkpoint and returns `complete:false` with a stable budget reason code.
- Portal version one accepts a validated read-only export. Direct portal DB access is not part of this plan.
- Context authority conflicts are preserved as records; the adapter never silently overwrites one source with another.

- [ ] **Step 4: Run tests**

```bash
node --test skills/ghl-account-audit/tests/adapters.test.mjs
npm --prefix skills/ghl-account-audit test
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add skills/ghl-account-audit
git commit -m "feat(audit): add pinned public and context adapters"
```

---

### Task 5: Build the normalized evidence graph and separate journey instances

**Files:**

- Create: `skills/ghl-account-audit/lib/normalize.mjs`
- Create: `skills/ghl-account-audit/lib/evidence-graph.mjs`
- Create: `skills/ghl-account-audit/tests/evidence-graph.test.mjs`
- Create fixtures under: `skills/ghl-account-audit/tests/fixtures/weekly/`

**Interfaces:**

```js
normalizeEvidence(records, context) -> canonical records
buildEvidenceGraph({ records, context, profile }) -> {
  nodes,
  edges,
  conflicts,
  unresolvedJoins
}
```

- [ ] **Step 1: Add fixture families and failing graph tests**

Create at minimum:

- `client-duplicate-ambiguous-identity`
- `grom-dual-journey-portal-complete`
- `grom-portal-unavailable`
- `grom-portal-ambiguous-link`

Test direct native IDs before execution metadata, deterministic composite keys before fuzzy matching, and assert that fuzzy links use `inferred_match` and never prove progression.

- [ ] **Step 2: Verify failure**

```bash
node --test skills/ghl-account-audit/tests/evidence-graph.test.mjs
```

Expected: FAIL because graph exports are missing.

- [ ] **Step 3: Implement typed nodes, edges, and provenance**

Every edge must contain:

```js
{
  edgeId,
  type,
  fromNodeId,
  toNodeId,
  eventTime,
  capturedAt,
  evidenceRefs,
  joinMethod,
  joinConfidence,
  workflowDefinitionHash: null
}
```

Supported edge types are:

```js
[
  'identity_exact',
  'configured_to_trigger',
  'enrolled_in',
  'execution_emitted',
  'preceded',
  'attributed_by_source',
  'intended_by',
  'contradicts',
  'inferred_match'
]
```

Bind historical workflow events only when the effective definition hash is known. Assign Grom events to either `agency_new_business` or `client_onboarding`; reject an event that would enter both denominators without an explicit handoff edge.

- [ ] **Step 4: Run tests**

```bash
node --test skills/ghl-account-audit/tests/evidence-graph.test.mjs
```

Expected: PASS with stable graph hashes.

- [ ] **Step 5: Commit**

```bash
git add skills/ghl-account-audit
git commit -m "feat(audit): build typed evidence graph and journey instances"
```

---

### Task 6: Implement closed-week cohorts, adjacent-stage KPIs, and conversation sampling

**Files:**

- Create: `skills/ghl-account-audit/lib/metrics.mjs`
- Create: `skills/ghl-account-audit/lib/sampling.mjs`
- Create: `skills/ghl-account-audit/lib/review-bridge.mjs`
- Create: `skills/ghl-account-audit/workflows/review-conversations.mjs`
- Create: `skills/ghl-account-audit/tests/kpi-cohort.test.mjs`
- Create: `skills/ghl-account-audit/tests/conversation-sampling.test.mjs`
- Create: `skills/ghl-account-audit/tests/conversation-review.test.mjs`
- Create: `skills/ghl-account-audit/rubrics/conversation-quality-v1.md`

**Interfaces:**

```js
buildWindows({ cutoff, timezone, maturityDays })
computeJourneyMetrics({ graph, metricContracts, windows })
selectConversationSample({ interactions, seed, censusThreshold: 50, maxSample: 50 })
createConversationReviewRequest({ run, sample, vaultGrants, rubric, prompt, modelPolicy })
ingestConversationReview({ request, response })
```

- [ ] **Step 1: Write failing deterministic tests**

Tests must cover:

- Current closed week and previous closed week in account timezone
- Trailing 28 days
- DST transitions
- Flow cohort versus current stock
- Eligible adjacent-stage denominators
- Re-entry, cancellations, reopened opportunities, and late events
- Mature cohorts and right-censoring
- `UNKNOWN` rather than zero
- Census at 50 or fewer
- Reproducible stratified sample above 50
- Mandatory complaint, opt-out, failure, abandoned-call, and high-value-loss inclusion
- Inclusion probabilities and sample-bounded prevalence
- No transcript or message text in the sample manifest
- Exact golden client metrics for first engagement, booking, show, no-show, cancellation, rebooking, opportunity outcome, revenue, and reactivation
- Exact golden Grom acquisition and onboarding milestone metrics with separate denominators
- Review requests grant expiring, read-once access only to selected private evidence
- Missing or expired transcripts produce `NOT_REVIEWABLE`, never a zero quality score
- Responses bind run, sample, prompt, rubric, model policy, packet, and evidence hashes
- Stale, replayed, mismatched, over-budget, or unreferenced judgments are rejected
- Prompt-injection canaries and adversarial conversations cannot change tool access or deterministic measurements
- Subjective scores remain separate from deterministic metrics and carry reviewer/model provenance

- [ ] **Step 2: Run and confirm failure**

```bash
node --test \
  skills/ghl-account-audit/tests/kpi-cohort.test.mjs \
  skills/ghl-account-audit/tests/conversation-sampling.test.mjs \
  skills/ghl-account-audit/tests/conversation-review.test.mjs
```

Expected: FAIL with missing functions.

- [ ] **Step 3: Implement deterministic calculations**

Use `Temporal.ZonedDateTime` from `@js-temporal/polyfill` for boundaries. Represent undefined metric values as:

```js
{
  state: 'UNKNOWN',
  numerator: null,
  denominator: null,
  rate: null,
  reasonCode: 'MISSING_REQUIRED_EVIDENCE'
}
```

Do not rank rate-driven findings below the metric contract's sample threshold. Mandatory oversamples may support diagnosis but require weighting and uncertainty before any population estimate.

The conversation workflow consumes only the selected encrypted records through expiring vault grants. Its sealed request records prompt, rubric, model-policy, sample, evidence, and code hashes. The strict response schema returns evidence-linked rubric judgments, counterevidence, transcript availability, uncertainty, and safety flags. It cannot return revised KPIs or change eligibility. Deterministic tests prove selection, contracts, boundaries, and hash checks; they do not require subjective scores to be byte-identical. Shadow acceptance uses blinded senior-human adjudication against the pinned rubric.

- [ ] **Step 4: Run tests**

```bash
npm --prefix skills/ghl-account-audit test
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add skills/ghl-account-audit
git commit -m "feat(audit): add cohort metrics and deterministic interaction sampling"
```

---

### Task 7: Build falsifiable mechanism packets and deterministic prioritization

**Files:**

- Create: `skills/ghl-account-audit/lib/mechanisms.mjs`
- Create: `skills/ghl-account-audit/workflows/review-mechanisms.mjs`
- Create: `skills/ghl-account-audit/rubrics/mechanism-review-v1.md`
- Create: `skills/ghl-account-audit/tests/mechanism-investigation.test.mjs`

**Interfaces:**

```js
nominateMechanisms({ graph, metrics, coverage, maxCandidates: 5 })
buildMechanismPacket(candidate)
reconcileExpertReviews({ packets, reviews, maxPromoted: 3 })
createMechanismReviewRequest({ run, packets, rubric, prompt, modelPolicy })
ingestMechanismReview({ request, response })
```

- [ ] **Step 1: Write failing confidence, falsification, and bound tests**

Fixture assertions:

- Direct configuration/runtime chain gives `C3`.
- Repeated segmented evidence with alternatives addressed gives `C2`.
- Unjoined correlation remains `C1`.
- Missing evidence gives `C0`.
- Source mix, capacity, data quality, delivery, ownership, offer, duplicates, and historical configuration drift are tested before promotion.
- Successful journeys are available as comparators.
- One root mechanism occupies at most one commercial slot.
- Critical issues bypass the zero-to-three commercial limit.
- No more than five candidates deepen, three packets reach review, and ten supplemental reads are accepted per packet.
- Kernel enters `awaiting_model_review` after sealing requests and performs no hidden model call.
- Review responses are single-use and bind run, packet, rubric, prompt, model-policy, evidence, code, and request hashes.
- Stale, replayed, mismatched, over-budget, or evidence-ineligible responses are rejected without changing the run.

- [ ] **Step 2: Run and verify failure**

```bash
node --test skills/ghl-account-audit/tests/mechanism-investigation.test.mjs
```

Expected: FAIL with missing mechanism exports.

- [ ] **Step 3: Implement the mechanism packet contract**

Each packet must include:

```js
{
  packetId,
  symptom,
  denominator,
  journeyInstanceIds,
  localizedEdgeIds,
  comparatorIds,
  candidateMechanism,
  prediction,
  supportingEvidenceRefs,
  counterEvidenceRefs,
  competingExplanations,
  falsificationResults,
  discriminatingTest,
  coverage,
  mechanismConfidence
}
```

The model-review workflow receives sealed packet paths and rubric versions only. Supplemental requests return to the kernel's read-only allowlists. Subjective reviews cannot alter deterministic measurements or eligibility.

The host bridge is explicit:

```text
audit.mjs review-request --project <dir> --location <id> --run-id <id>
audit.mjs ingest-review --project <dir> --location <id> --run-id <id> --response <path>
audit.mjs resume --project <dir> --location <id> --run-id <id>
```

`review-request` prints sealed request paths only. `ingest-review` validates the strict response schema and every bound hash before atomically consuming its nonce. It never accepts raw replacement evidence, deterministic metric changes, new tool instructions, or packet IDs outside the request.

- [ ] **Step 4: Run tests**

```bash
node --test skills/ghl-account-audit/tests/mechanism-investigation.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add skills/ghl-account-audit
git commit -m "feat(audit): add bounded mechanism investigation and prioritization"
```

---

### Task 8: Generate verified reports, non-executable proposals, and the backlog

**Files:**

- Create: `skills/ghl-account-audit/lib/proposals.mjs`
- Create: `skills/ghl-account-audit/lib/verifier.mjs`
- Create: `skills/ghl-account-audit/lib/memory.mjs`
- Create: `skills/ghl-account-audit/tests/weekly-memory.test.mjs`
- Extend: `skills/ghl-account-audit/tests/publication.test.mjs`

**Interfaces:**

```js
compileProposal({ finding, currentObjects, evidenceCutoff })
verifyPublication({ publicationDir }) -> attestation
appendMemoryEvent({ paths, event })
projectBacklog({ events }) -> { json, markdown }
```

- [ ] **Step 1: Write failing publication and intervention-memory tests**

Test:

- Healthy full fixture produces zero proposals.
- Partial fixture labels local ranking and forbids account-wide impact.
- Grom report contains separate acquisition and onboarding scorecards.
- Every report claim resolves to a finding ID and evidence ID.
- Four verdicts remain independent.
- Proposal JSON contains no URL, method, mutation tool, credential, `confirm`, or executable envelope.
- Title changes preserve finding identity.
- Missing evidence creates `NOT_REASSESSED`.
- Proposal hash changes invalidate approval.
- Implementation receipt remains an assertion until a live reread.
- Workflow-logic fixture renders exact current and proposed graphs, IDs, triggers, re-entry, branches, exits, waits, references, and existing-enrollment handling.
- Copy fixture renders exact final channel text, audience, locale, verified merge fields and fallbacks, timing, stop conditions, consent, and ownership.
- Wait-timing fixture renders anchor, duration, timezone/business-calendar semantics, exits, and collision risk.
- Conversation or Voice AI fixture renders agent ID/version, exact prompt and configuration changes, actions, knowledge, routing, guardrails, escalation, evaluation cases, and canary.
- Operating-process fixture renders owner/RACI, action, SLA, trigger, completion evidence, escalation, training, audit trail, and compliance measurement.
- Every solution type includes dependencies, blast radius, acceptance tests, monitoring, rollout, and rollback.
- The verifier independently recomputes cohorts, KPIs, sample membership, priority scores, impact formulas, payload hashes, coverage class, and proposal eligibility from sealed evidence.
- The verifier has no MCP client, network transport, repair path, or permission to fetch missing evidence.
- Any write/raw tool trace, Partial-boundary violation, PII canary, or deterministic mismatch fails attestation.

- [ ] **Step 2: Verify failure**

```bash
node --test \
  skills/ghl-account-audit/tests/publication.test.mjs \
  skills/ghl-account-audit/tests/weekly-memory.test.mjs
```

Expected: FAIL with missing proposal/verifier/memory exports.

- [ ] **Step 3: Implement publication and memory projections**

Publish:

```text
REPORT.md
run-manifest.json
coverage.json
freshness.json
diff.json
metrics-and-findings.json
conversation-sample.json
evidence-manifest.jsonl
verifier-attestation.json
solution-packs/<solution-id>/README.md
solution-packs/<solution-id>/proposal.json
solution-packs/<solution-id>/acceptance-tests.md
```

The root hash covers canonical payload artifacts only. The manifest records payload hashes and the root. The attestation binds manifest hash and root.

Memory event types must include finding observations and transitions, approval receipts, implementation receipts, verification results, waivers, and raw expiry. Generated `BACKLOG.md` and `backlog.json` are reconstructible projections.

Define `ProposalSchema` as a discriminated union on:

```text
workflow_logic | copy | wait_timing | conversation_ai | voice_ai | operating_process
```

Each variant requires the exact type-specific current state, proposed state, affected IDs and captured hashes, prerequisites, dependencies, blast radius, owner, acceptance tests, monitoring, rollout, and rollback listed in the approved design. Renderers must fail on an unknown merge field, unresolved referenced object, missing exit condition, stale captured hash, or unsupported solution type. Generated prose is a projection of validated proposal data, not a second source of truth.

- [ ] **Step 4: Run tests**

```bash
npm --prefix skills/ghl-account-audit test
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add skills/ghl-account-audit
git commit -m "feat(audit): publish verified findings proposals and durable backlog"
```

---

### Task 9: Orchestrate first-run and later public-only weekly publications

**Files:**

- Create: `skills/ghl-account-audit/lib/kernel.mjs`
- Create: `skills/ghl-account-audit/lib/modes/weekly.mjs`
- Create: `skills/ghl-account-audit/cli/audit.mjs`
- Create: `skills/ghl-account-audit/tests/replay-resume.test.mjs`
- Modify: `skills/ghl-account-audit/scripts/build.mjs`

**Interfaces:**

```js
createAuditKernel({ clock, idFactory, stateStore, adapters, analyzer, verifier, publisher })
kernel.start({ mode, target, projectRoot, cutoff, providerId })
kernel.resume({ projectRoot, locationId, runId })
kernel.replay({ fixtureRoot, outputRoot })
```

- [ ] **Step 1: Write failing first-run, weekly, and resume tests**

Assert:

- Baseline history requests at least 90 days and two mature sales cycles when available.
- First run never emits `IMPROVING`, `REGRESSED`, or `RESOLVED`.
- Later runs refetch a 72-hour overlap and deduplicate late events.
- Current-week discovery runs before prior finding labels are loaded.
- Public-only is always `complete_partial`.
- A partial publication cannot replace latest-full baseline.
- Identical resumed and uninterrupted deterministic artifacts are byte-equivalent.
- Resume keeps `runId`, creates a new `publicationId`, and refuses changed frozen inputs.
- Integrity failure quarantines and publishes no finding or solution.
- Runs checkpoint as `awaiting_model_review` with sealed request artifacts and single-use nonces.
- Stale, replayed, mismatched, or over-budget conversation and mechanism responses leave the checkpoint unchanged.
- Missing or invalid vault-key references fail before collection and never enter run state.

- [ ] **Step 2: Verify failure**

```bash
node --test skills/ghl-account-audit/tests/replay-resume.test.mjs
```

Expected: FAIL with missing kernel.

- [ ] **Step 3: Implement the state machine and CLI**

Support commands:

```text
audit.mjs replay --fixture <dir> --output <dir>
audit.mjs run --mode weekly --project <dir> --location <id> --profile <id> --provider-config <path> --vault-key-ref <reference>
audit.mjs review-request --project <dir> --location <id> --run-id <id>
audit.mjs ingest-review --project <dir> --location <id> --run-id <id> --response <path>
audit.mjs resume --project <dir> --location <id> --run-id <id>
```

The CLI prints status and artifact paths only. It never prints credentials, key references, raw evidence, prompts, or review content. The provider config and CLI contain key references only. Build a checked-in `dist/audit-cli.mjs`; bundle-spawn tests must prove marketplace execution without local `node_modules`.

- [ ] **Step 4: Run the offline gate**

```bash
npm --prefix skills/ghl-account-audit run build
npm --prefix skills/ghl-account-audit test
node skills/ghl-account-audit/dist/audit-cli.mjs replay \
  --fixture skills/ghl-account-audit/tests/fixtures/weekly/client-partial-pagination \
  --output "$(mktemp -d)"
```

Expected: PASS and an honestly partial publication.

- [ ] **Step 5: Commit**

```bash
git add skills/ghl-account-audit
git commit -m "feat(audit): orchestrate resumable public-only weekly audits"
```

---

### Task 10: Route legacy capture, verify, and harvest through compatibility mode wrappers

**Files:**

- Create: `skills/ghl-account-audit/lib/adapters/legacy-capture.mjs`
- Create: `skills/ghl-account-audit/lib/modes/capture.mjs`
- Create: `skills/ghl-account-audit/lib/modes/verify.mjs`
- Create: `skills/ghl-account-audit/lib/modes/harvest.mjs`
- Create: `skills/ghl-account-audit/tests/legacy-compatibility.test.mjs`
- Modify only after parity: `skills/ghl-account-audit/SKILL.md`

**Interfaces:**

```js
runCaptureMode(args)
runVerifyMode(args)
runHarvestMode(args)
```

- [ ] **Step 1: Write exact legacy-tree and authorization tests**

Assert:

- Capture remains default.
- `captures/<YYYY-MM-DD>/` layout is unchanged.
- Raw capture files remain ignored.
- Existing sanitizer CLI output remains unchanged.
- Verify remains design-to-live conformance.
- Harvest never invents an ID.
- `ids_harvested` becomes true only after every required lifecycle field resolves.
- Harvest is rejected with `scheduled:true`.
- Weekly, capture, and verify never modify `client-manifest.json`.

- [ ] **Step 2: Verify failure**

```bash
node --test skills/ghl-account-audit/tests/legacy-compatibility.test.mjs
```

Expected: FAIL with missing wrappers.

- [ ] **Step 3: Implement wrappers without replacing the browser fallback**

Use shared collectors and artifact safety modules, but preserve the current capture runbook, Python throttler, workflow validation, and output names. Update `SKILL.md` to add `weekly` only after all compatibility assertions pass.

- [ ] **Step 4: Run the complete backward-compatibility floor**

```bash
npm --prefix skills/ghl-account-audit test
node --test 'skills/ghl-account-audit/tests/*.test.mjs' 'baseline/tests/*.test.mjs'
python3 skills/ghl-account-audit/capture/validate_workflow_capture.py \
  skills/ghl-account-audit/tests/fixtures/legacy/workflow-capture
```

Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add skills/ghl-account-audit
git commit -m "refactor(audit): preserve capture verify and harvest modes"
```

---

### Task 11: Integrate the typed internal audit contract and enable full evidence

**Dependency:** Do not start until Task 10 has preserved legacy parity and the separate internal MCP plan has passed its offline gate. Offline proof permits adapter development only. Do not perform its live canary without explicit user approval, and never publish `complete_full` without machine-verifiable `live_runtime` proof.

**Files:**

- Create: `skills/ghl-account-audit/lib/adapters/internal-ghl.mjs`
- Create: `skills/ghl-account-audit/tests/internal-adapter.test.mjs`
- Modify: `skills/ghl-account-audit/lib/modes/weekly.mjs`
- Modify: `skills/doctor/SKILL.md`
- Modify: `skills/doctor/checks.sh`

**Interfaces:**

```js
createInternalGhlAdapter({
  client,
  expectedContractVersion: '1.0.0',
  expectedLocationId,
  expectedToolProfileHash,
  capabilityProofIndex
})
```

- [ ] **Step 1: Write failing contract-handshake and completeness tests**

Assert:

- Exact audit `tools/list` contains no `raw_request`, `set_token_file`, confirmation field, or write tool.
- Contract versions below `1.0.0` are rejected.
- Missing, expired, wrong-manifest, wrong-profile, or wrong-capability proof forces Partial.
- Every applicable capability requires a dated `live_runtime` receipt whose attestation, descriptor, profile, manifest, and bundle hashes match.
- The canary target hash is provenance only and is never required to equal the current run target.
- Current-run location binding is independently enforced against the requested location and every live response.
- Workflow roster traversal reconciles offset pages, unique IDs, reported totals, stable totals, and terminal zero progress.
- Every discovered applicable workflow receives definition and runtime-window coverage; one missing workflow forces the workflow scope Partial.
- Every applicable Conversation AI, Voice AI, and Agent Studio surface has terminal discovery and detail coverage; unknown applicability or one incomplete component forces the AI scope Partial.
- Requested/applied windows, terminal proof, totals, step rosters, source routes, capability version, and location binding are required.
- `complete:false`, rate limiting, truncation, or unresolved location produces partial or quarantine as appropriate.
- Credential expiry checkpoints after preserving public evidence.
- Public/internal snapshot skew above policy forces public refresh.

- [ ] **Step 2: Verify failure**

```bash
node --test skills/ghl-account-audit/tests/internal-adapter.test.mjs
```

Expected: FAIL because the internal adapter is absent.

- [ ] **Step 3: Implement exact runtime-window ingestion**

Accept only internal results conforming to the separate plan. Traverse the complete workflow roster before requesting each applicable workflow's definition and runtime window. Bind a historical event to a workflow-definition hash only when the internal evidence proves that definition was effective at the event time. Otherwise retain the event with `workflowDefinitionHash: null` and cap configuration-to-execution conclusions at correlation. Add fixtures where a definition changes inside the audited window and after the window.

A full run requires a matching unexpired per-capability `live_runtime` receipt for every capability applicable to this run, every applicable mandatory scope complete, privacy and verifier pass, zero write/raw attempts, valid manifests, and no stale evidence used by a claim. A canary account identifies proof provenance only; it does not authorize or bind another location. Offline-only or unexercised capabilities always force Partial even when fixture and contract checks pass.

- [ ] **Step 4: Run all offline tests**

```bash
npm --prefix skills/ghl-account-audit test
npm --prefix skills/ghl-account-audit run build
```

Expected: PASS. No live calls occur.

- [ ] **Step 5: Commit**

```bash
git add skills/ghl-account-audit skills/doctor
git commit -m "feat(audit): integrate typed internal workflow evidence"
```

---

### Task 12: Add shadow evaluation, idempotent scheduling, and operating documentation

**Files:**

- Create: `skills/ghl-account-audit/lib/schedule.mjs`
- Create: `skills/ghl-account-audit/tests/schedule.test.mjs`
- Create: `skills/ghl-account-audit/tests/shadow-evaluation.test.mjs`
- Modify: `skills/ghl-account-audit/cli/audit.mjs`
- Modify: `skills/ghl-account-audit/SKILL.md`
- Modify: `skills/doctor/SKILL.md`
- Modify: `README.md`
- Modify: `.claude-plugin/plugin.json`

**Interfaces:**

```js
cycleId(locationId, isoWeek) -> `${locationId}:${isoWeek}:weekly`
startScheduledRun({ project, locationId, profile, cycle, authDeadline })
evaluateCanary(registry) -> gate result
```

- [ ] **Step 1: Write failing scheduler and canary tests**

Assert:

- Duplicate cycle starts return the existing run.
- Version one never overlaps location runs.
- Expired auth creates one request and no retry storm.
- Auth deadline publishes partial.
- Valid refresh resumes the same frozen run into a new publication.
- `429` checkpoints and opens cooldown.
- `403` requires auth review.
- Wrong-location auth quarantines.
- Suppressed shadow runs never update `CURRENT.md`.
- Initial canary requires Grom, one representative client, two full runs, and one partial/resume exercise.
- Wider rollout requires four weekly windows across at least three representative locations, or every eligible location when fewer than three exist.
- Critical seeded defects have 100 percent detection, zero unsupported critical findings, zero evidence-ineligible proposals, at least 90 percent material-defect detection, and under 10 percent unsupported promotion.
- Blinded senior-auditor ratings average at least 4 out of 5 for accuracy, commercial relevance, reasoning depth, traceability, actionability, and restraint.

- [ ] **Step 2: Verify failure**

```bash
node --test \
  skills/ghl-account-audit/tests/schedule.test.mjs \
  skills/ghl-account-audit/tests/shadow-evaluation.test.mjs
```

Expected: FAIL with missing scheduling exports.

- [ ] **Step 3: Implement idempotent commands and documentation**

Add:

```text
audit.mjs scheduled --project <dir> --location <id> --profile <id> --cycle <location>:<ISO-week>:weekly
audit.mjs canary-status --registry <private-registry-path>
```

Do not commit a machine-specific cron, `launchd`, or Codex automation. The CLI is the idempotent boundary external schedulers call. Full scheduled publication requires a host capable of the bounded model-review workflow; deterministic collection alone may checkpoint and wait.

Document that official connector OAuth cannot be exported to this CLI. Scheduled public access requires an approved external credential source. Full unattended operation remains unavailable while internal credentials require attended refresh.

- [ ] **Step 4: Run the final local gate**

```bash
npm --prefix skills/ghl-account-audit run build
npm --prefix skills/ghl-account-audit test
node --test 'baseline/tests/*.test.mjs'
node --test 'skills/client-design/tests/*.test.mjs'
git diff --check
```

Expected: all tests PASS and the bundle is current.

- [ ] **Step 5: Commit**

```bash
git add skills/ghl-account-audit skills/doctor README.md .claude-plugin/plugin.json
git commit -m "docs(audit): ship weekly diagnostic operating model"
```

## Manual Stop Lines

The following are not authorized by this plan alone:

1. Any live public or internal GHL call.
2. Any portal database connection.
3. Any client-facing distribution.
4. Any proposal approval or execution.
5. Any scheduler installation.
6. Any push, release, version bump, or marketplace publication.

At those points, stop with the exact target, read-only operation, expected evidence, credential requirement, and rollback or cleanup implications.
