// schemas/v1.mjs
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
var SCHEMA_VERSION = "1.0.0";
var Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
var NonEmptyRecordSchema = z.record(z.string(), z.unknown()).refine((value) => Object.keys(value).length > 0, "must not be empty");
var JsonRecordSchema = z.record(z.string(), z.unknown());
var TargetSchema = z.object({
  targetKind: z.literal("location"),
  operatingProfile: z.enum(["client", "grom_internal"]),
  locationId: z.string().min(1),
  companyId: z.string().min(1).optional()
}).strict();
var JourneySchema = z.object({
  journeyId: z.string().min(1),
  entryRule: z.string().min(1),
  denominator: z.string().min(1),
  outcomes: z.array(z.string().min(1)).min(1)
}).strict();
var CoverageProfileSchema = z.object({
  profileId: z.enum(["client", "grom_internal"]),
  version: z.literal(SCHEMA_VERSION),
  targetKind: z.literal("location"),
  excludedCapabilities: z.array(z.string().min(1)),
  journeys: z.array(JourneySchema).min(1)
}).strict().superRefine((profile, ctx) => {
  const ids = profile.journeys.map(({ journeyId }) => journeyId);
  if (new Set(ids).size !== ids.length) {
    ctx.addIssue({ code: "custom", message: "journey IDs must be unique" });
  }
});
var RunManifestSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  runId: z.string().min(1),
  target: TargetSchema,
  profileId: z.enum(["client", "grom_internal"]),
  startedAt: z.string().min(1),
  status: z.enum(["running", "checkpointed", "complete_partial", "complete_full", "quarantined"]),
  coverageProfileHash: Sha256Schema,
  metricContractsHash: Sha256Schema,
  publicCatalogSnapshotHash: Sha256Schema
}).strict();
var EvidenceRecordSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  evidenceRef: z.string().min(1),
  source: z.enum(["context", "public_ghl", "internal_ghl", "onboarding_portal"]),
  capturedAt: z.string().min(1),
  payloadHash: Sha256Schema,
  classification: z.enum(["OBSERVED", "UNKNOWN", "NOT_APPLICABLE"]),
  objectRefs: z.array(z.object({
    objectType: z.string().min(1),
    objectId: z.string().min(1)
  }).strict())
}).strict();
var FindingSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  findingId: z.string().min(1),
  state: z.enum(["OBSERVED", "UNKNOWN", "NOT_APPLICABLE"]),
  severity: z.enum(["critical", "high", "medium", "low"]),
  journeyId: z.string().min(1),
  edgeId: z.string().min(1),
  summary: z.string().min(1),
  evidenceRefs: z.array(z.string().min(1)).min(1)
}).strict();
var ExactStateSchema = z.object({
  current: z.record(z.string(), z.unknown()),
  proposed: z.record(z.string(), z.unknown())
}).strict();
var ChangeSetSchema = z.discriminatedUnion("solutionType", [
  ExactStateSchema.extend({
    solutionType: z.literal("workflow_logic"),
    workflowId: z.string().min(1),
    triggers: z.array(z.string()),
    branches: z.array(z.string()),
    exits: z.array(z.string()).min(1),
    existingEnrollmentPlan: z.string().min(1)
  }).strict(),
  ExactStateSchema.extend({
    solutionType: z.literal("copy"),
    channel: z.string().min(1),
    audience: z.string().min(1),
    locale: z.string().min(1),
    finalText: z.string().min(1),
    mergeFields: z.array(z.string()),
    fallbacks: z.record(z.string(), z.string()),
    stopConditions: z.array(z.string()).min(1)
  }).strict(),
  ExactStateSchema.extend({
    solutionType: z.literal("wait_timing"),
    anchorEvent: z.string().min(1),
    duration: z.number().nonnegative(),
    unit: z.string().min(1),
    timezone: z.string().min(1),
    exitConditions: z.array(z.string()).min(1)
  }).strict(),
  ExactStateSchema.extend({
    solutionType: z.enum(["conversation_ai", "voice_ai"]),
    agentId: z.string().min(1),
    prompt: z.string().min(1),
    allowedTools: z.array(z.string()),
    guardrails: z.array(z.string()),
    escalationRules: z.array(z.string()).min(1),
    evaluationCases: z.array(z.string()).min(1)
  }).strict(),
  ExactStateSchema.extend({
    solutionType: z.literal("operating_process"),
    owner: z.string().min(1),
    raci: z.record(z.string(), z.string()),
    sla: z.string().min(1),
    trigger: z.string().min(1),
    completionEvidence: z.array(z.string()).min(1),
    escalation: z.array(z.string()).min(1)
  }).strict()
]);
var ProposalSchema = z.object({
  mode: z.literal("PROPOSAL_ONLY"),
  executable: z.literal(false),
  approvalRequired: z.literal(true),
  solutionId: z.string().min(1),
  packHash: Sha256Schema,
  objectRefs: z.array(z.object({
    objectType: z.string().min(1),
    objectId: z.string().min(1),
    capturedVersion: z.union([z.string(), z.number()]).nullable(),
    capturedHash: Sha256Schema
  }).strict()),
  changeSet: ChangeSetSchema,
  preconditions: z.array(z.string()),
  dependencies: z.array(z.string()),
  blastRadius: z.string().min(1),
  owner: z.string().min(1),
  monitoring: z.array(z.string()).min(1),
  rollout: NonEmptyRecordSchema,
  rollback: NonEmptyRecordSchema,
  guardrails: z.array(z.string()),
  tests: z.array(z.string()),
  evidenceRefs: z.array(z.string().min(1))
}).strict();
var ConversationSampleSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  seed: z.string().min(1),
  universeCount: z.number().int().nonnegative(),
  selections: z.array(z.object({
    subjectRef: z.string().min(1),
    stratum: z.string().min(1),
    inclusionProbability: z.number().positive().max(1),
    evidenceRefs: z.array(z.string()),
    scores: z.record(z.string(), z.number()).optional()
  }).strict())
}).strict();
var ReceiptSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  receiptId: z.string().min(1),
  proposalHash: Sha256Schema,
  approvedAt: z.string().min(1),
  approvedBy: z.string().min(1),
  approvalScope: z.array(z.string().min(1)).min(1),
  executable: z.literal(false)
}).strict();
var MetricEdgeSchema = z.object({
  edgeId: z.string().min(1),
  journeyId: z.string().min(1),
  fromStage: z.string().min(1),
  toStage: z.string().min(1),
  eligibilityRule: JsonRecordSchema,
  fromEventFields: z.array(z.string()),
  toEventFields: z.array(z.string()),
  allowedLag: z.object({
    amount: z.number().nonnegative(),
    unit: z.string().min(1)
  }).strict(),
  maturityRule: JsonRecordSchema,
  dispositions: z.array(z.string().min(1)).min(1),
  reentryRule: z.enum(["new_journey_instance", "same_journey_instance"]),
  outcomeRule: JsonRecordSchema,
  required: z.boolean(),
  nativeMapping: z.enum(["MAPPED", "UNKNOWN"])
}).strict().superRefine((edge, ctx) => {
  if (edge.required && edge.nativeMapping !== "MAPPED" && edge.nativeMapping !== "UNKNOWN") {
    ctx.addIssue({ code: "custom", message: "unmapped required edges must be UNKNOWN" });
  }
});
var MetricContractsSchema = z.object({
  profileId: z.enum(["client", "grom_internal"]),
  version: z.literal(SCHEMA_VERSION),
  edges: z.array(MetricEdgeSchema).min(1)
}).strict().superRefine((contracts, ctx) => {
  const ids = contracts.edges.map(({ edgeId }) => edgeId);
  if (new Set(ids).size !== ids.length) {
    ctx.addIssue({ code: "custom", message: "edge IDs must be unique" });
  }
});
var ActionTupleSchema = z.object({
  actionId: z.string().min(1),
  method: z.string().min(1),
  normalizedPath: z.string().min(1),
  category: z.string().min(1),
  risk: z.string().min(1)
}).strict();
var ApprovalSchema = z.object({
  provenance: z.string().min(1),
  reviewedAt: z.string().min(1),
  reviewedBy: z.string().min(1)
}).strict();
var CatalogCandidateSchema = ActionTupleSchema.extend({
  approvedSemanticRead: z.boolean(),
  approval: ApprovalSchema.optional()
}).strict().superRefine((candidate, ctx) => {
  if (candidate.approvedSemanticRead && !candidate.approval) {
    ctx.addIssue({ code: "custom", message: "approved actions require approval provenance" });
  }
});
var PublicCatalogSnapshotSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  catalogRevision: z.string().min(1),
  capturedAt: z.string().min(1),
  sourceServer: z.object({
    name: z.string().min(1),
    identity: z.string().min(1),
    version: z.string().min(1)
  }).strict(),
  candidates: z.array(CatalogCandidateSchema),
  canonicalSha256: Sha256Schema
}).strict().superRefine((snapshot, ctx) => {
  const ids = snapshot.candidates.map(({ actionId }) => actionId);
  if (new Set(ids).size !== ids.length) {
    ctx.addIssue({ code: "custom", message: "catalog action IDs must be unique" });
  }
});
var PublicReadAllowlistSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  sourceCatalogRevision: z.string().min(1),
  sourceSnapshotHash: Sha256Schema,
  sourceServerIdentity: z.string().min(1),
  actions: z.array(ActionTupleSchema)
}).strict().superRefine((allowlist, ctx) => {
  const ids = allowlist.actions.map(({ actionId }) => actionId);
  if (new Set(ids).size !== ids.length) {
    ctx.addIssue({ code: "custom", message: "allowlist action IDs must be unique" });
  }
});
var BudgetSchema = z.object({
  maximumPages: z.number().int().positive(),
  maximumRecords: z.number().int().positive(),
  maximumResponseBytes: z.number().int().positive(),
  requestTimeoutMs: z.number().int().positive(),
  retryCount: z.number().int().nonnegative(),
  maximumTotalRetryDelayMs: z.number().int().nonnegative(),
  wallClockMs: z.number().int().positive()
}).strict();
var CollectionBudgetsSchema = z.object({
  version: z.literal(SCHEMA_VERSION),
  exhaustionPolicy: z.literal("checkpoint_scope_incomplete"),
  capabilities: z.record(z.string().min(1), BudgetSchema)
}).strict();
function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}
function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}
function snapshotHash(snapshot) {
  const { canonicalSha256: _ignored, ...payload } = snapshot;
  return createHash("sha256").update(canonicalJson(payload)).digest("hex");
}
var PROFILE_FILES = Object.freeze({
  client: "client.v1.json",
  grom_internal: "grom-internal.v1.json"
});
var METRIC_FILES = Object.freeze({
  client: "client-metrics.v1.json",
  grom_internal: "grom-internal-metrics.v1.json"
});
function readProfileFile(filename) {
  return JSON.parse(readFileSync(new URL(`../profiles/${filename}`, import.meta.url), "utf8"));
}
function normalizeProfileId(profileId) {
  if (profileId === "grom-internal") return "grom_internal";
  return profileId;
}
function loadProfile(profileId) {
  const normalized = normalizeProfileId(profileId);
  const filename = PROFILE_FILES[normalized];
  if (!filename) throw new Error(`UNKNOWN_PROFILE:${profileId}`);
  return CoverageProfileSchema.parse(readProfileFile(filename));
}
function loadMetricContracts(profileId) {
  const normalized = normalizeProfileId(profileId);
  const filename = METRIC_FILES[normalized];
  if (!filename) throw new Error(`UNKNOWN_METRIC_PROFILE:${profileId}`);
  return MetricContractsSchema.parse(readProfileFile(filename));
}
function loadCollectionBudgets() {
  return CollectionBudgetsSchema.parse(readProfileFile("collection-budgets.v1.json"));
}
function assertAllowedPublicAction(profile, action) {
  const allowlist = PublicReadAllowlistSchema.parse(profile);
  const requested = ActionTupleSchema.extend({ sourceSnapshotHash: Sha256Schema }).strict().parse(action);
  if (requested.sourceSnapshotHash !== allowlist.sourceSnapshotHash) {
    throw new Error("PUBLIC_ACTION_NOT_ALLOWED: source snapshot hash differs");
  }
  const allowed = allowlist.actions.some((entry) => entry.actionId === requested.actionId && entry.method === requested.method && entry.normalizedPath === requested.normalizedPath && entry.category === requested.category && entry.risk === requested.risk);
  if (!allowed) throw new Error("PUBLIC_ACTION_NOT_ALLOWED: action tuple differs");
  return true;
}
function loadPublicCatalogSnapshot() {
  const snapshot = PublicCatalogSnapshotSchema.parse(readProfileFile("public-catalog-snapshot.v1.json"));
  if (snapshotHash(snapshot) !== snapshot.canonicalSha256) {
    throw new Error("CATALOG_SNAPSHOT_HASH_MISMATCH");
  }
  return snapshot;
}
function loadPublicReadAllowlist() {
  return PublicReadAllowlistSchema.parse(readProfileFile("public-read-allowlist.v1.json"));
}
var schemaSourcePath = fileURLToPath(import.meta.url);
export {
  CollectionBudgetsSchema,
  ConversationSampleSchema,
  CoverageProfileSchema,
  EvidenceRecordSchema,
  FindingSchema,
  MetricContractsSchema,
  MetricEdgeSchema,
  ProposalSchema,
  PublicCatalogSnapshotSchema,
  PublicReadAllowlistSchema,
  ReceiptSchema,
  RunManifestSchema,
  SCHEMA_VERSION,
  TargetSchema,
  assertAllowedPublicAction,
  canonicalJson,
  loadCollectionBudgets,
  loadMetricContracts,
  loadProfile,
  loadPublicCatalogSnapshot,
  loadPublicReadAllowlist,
  schemaSourcePath,
  snapshotHash
};
