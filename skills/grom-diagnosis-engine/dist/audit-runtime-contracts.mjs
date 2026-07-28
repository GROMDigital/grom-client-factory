// schemas/v1.mjs
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";

// lib/window-names.mjs
var WINDOW_NAMES = Object.freeze([
  "currentClosedWeek",
  "previousClosedWeek",
  "trailing28Days",
  "trailing60Days",
  "trailing90Days",
  "trailing180Days"
]);
var DEFAULT_REPORTING_WINDOWS = Object.freeze([
  "currentClosedWeek",
  "previousClosedWeek",
  "trailing28Days",
  "trailing90Days"
]);

// schemas/v1.mjs
var SCHEMA_VERSION = "1.0.0";
var Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
var PseudonymousSubjectRefSchema = z.string().regex(/^psn_[a-f0-9]{16,64}$/);
var OpaqueObjectRefSchema = z.string().regex(/^obj_[a-f0-9]{16,64}$/);
var EvidenceRefSchema = z.string().regex(/^ev_[a-f0-9]{16,64}$/);
var ActorRefSchema = z.string().regex(/^actor_[a-f0-9]{16,64}$/);
var JourneyInstanceIdSchema = z.string().regex(/^journey_[a-z][a-z0-9_]{2,127}$/);
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
  journeyInstanceId: JourneyInstanceIdSchema,
  entryRule: z.string().min(1),
  denominator: z.string().min(1),
  outcomes: z.array(z.string().min(1)).min(1)
}).strict();
var KpiTargetSchema = z.object({
  edgeId: z.string().min(1),
  // A rate, so 0.65 is 65%. Every declared journey edge is a conversion between two steps.
  target: z.number().gt(0).lte(1),
  standard: z.enum(["industry_typical", "industry_good", "owner_decision"]),
  basis: z.string().min(1)
}).strict();
var SituationSchema = z.object({
  /*
   * WHAT TO CALL THIS ACCOUNT IN A DOCUMENT SOMEBODY READS.
   *
   * Optional, because it is per-account identity and the `client` profile is a template shared by
   * every clinic. Where it is absent the report falls back to the location id, which is honest and
   * ugly rather than a guessed name.
   *
   * It lives here rather than being collected because the sub-account record is not on the governed
   * read allowlist, and widening that boundary to fetch a display name would be a poor trade. The
   * durable fix, if this ever matters for many accounts at once, is to collect it.
   */
  accountName: z.string().min(1).optional(),
  whoThisIs: z.string().min(1),
  howLeadsArrive: z.string().min(1),
  whatIsSold: z.string().min(1),
  theFunnel: z.string().min(1),
  objective: z.string().min(1),
  knownDataCaveats: z.array(z.string().min(1)),
  /*
   * Optional, and DELIBERATELY PARTIAL where it exists. A target is only set on an edge whose
   * denominator is unambiguous. The published bands for "lead to booked" are measured on all leads,
   * while `qualified_to_booked` is measured on qualified ones, and a target quietly carrying the
   * wrong denominator is worse than no target at all.
   */
  targets: z.array(KpiTargetSchema).optional()
}).strict().superRefine((situation, ctx) => {
  const ids = (situation.targets ?? []).map(({ edgeId }) => edgeId);
  if (new Set(ids).size !== ids.length) {
    ctx.addIssue({ code: "custom", message: "one target per KPI edge" });
  }
});
var QuestionEdgesSchema = z.object({
  question: z.number().int().min(1).max(6),
  edgeIds: z.array(z.string().min(1))
}).strict();
var CoverageProfileSchema = z.object({
  profileId: z.enum(["client", "grom_internal"]),
  version: z.literal(SCHEMA_VERSION),
  targetKind: z.literal("location"),
  excludedCapabilities: z.array(z.string().min(1)),
  journeys: z.array(JourneySchema).min(1),
  situation: SituationSchema.optional(),
  questionEdges: z.array(QuestionEdgesSchema).max(6).optional()
}).strict().superRefine((profile, ctx) => {
  const ids = profile.journeys.map(({ journeyId }) => journeyId);
  if (new Set(ids).size !== ids.length) {
    ctx.addIssue({ code: "custom", message: "journey IDs must be unique" });
  }
  const instanceIds = profile.journeys.map(({ journeyInstanceId }) => journeyInstanceId);
  if (new Set(instanceIds).size !== instanceIds.length) {
    ctx.addIssue({ code: "custom", message: "journey instance IDs must be unique" });
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
  evidenceRef: EvidenceRefSchema,
  source: z.enum(["context", "public_ghl", "internal_ghl", "onboarding_portal"]),
  capturedAt: z.string().min(1),
  payloadHash: Sha256Schema,
  classification: z.enum(["OBSERVED", "UNKNOWN", "NOT_APPLICABLE"]),
  objectRefs: z.array(z.object({
    objectType: z.string().min(1),
    objectId: OpaqueObjectRefSchema
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
  evidenceRefs: z.array(EvidenceRefSchema).min(1)
}).strict();
var ExactStateSchema = z.object({
  current: z.record(z.string(), z.unknown()),
  proposed: z.record(z.string(), z.unknown())
}).strict();
var CapturedObjectSchema = z.object({
  objectType: z.string().min(1),
  objectId: OpaqueObjectRefSchema,
  capturedVersion: z.union([z.string().min(1), z.number()]),
  capturedHash: Sha256Schema
}).strict();
var EvaluationCaseSchema = z.object({
  caseId: z.string().min(1),
  version: z.string().min(1),
  expected: z.string().min(1)
}).strict();
var ChangeSetSchema = z.discriminatedUnion("solutionType", [
  ExactStateSchema.extend({
    solutionType: z.literal("workflow_logic"),
    workflowId: OpaqueObjectRefSchema,
    capturedVersion: z.union([z.string().min(1), z.number()]),
    capturedHash: Sha256Schema,
    currentGraph: NonEmptyRecordSchema,
    proposedGraph: NonEmptyRecordSchema,
    triggers: z.array(z.string().min(1)).min(1),
    reentry: z.string().min(1),
    branches: z.array(NonEmptyRecordSchema),
    defaultBranch: z.string().min(1),
    exits: z.array(z.string()).min(1),
    waits: z.array(NonEmptyRecordSchema),
    errorBehavior: z.string().min(1),
    references: z.object({
      fields: z.array(z.string().min(1)),
      tags: z.array(z.string().min(1)),
      calendars: z.array(OpaqueObjectRefSchema),
      assignments: z.array(z.string().min(1)),
      agents: z.array(OpaqueObjectRefSchema)
    }).strict(),
    existingEnrollmentHandling: z.string().min(1)
  }).strict(),
  ExactStateSchema.extend({
    solutionType: z.literal("copy"),
    channel: z.string().min(1),
    audience: z.string().min(1),
    locale: z.string().min(1),
    finalText: z.string().min(1),
    mergeFields: z.array(z.string()),
    fallbacks: z.record(z.string(), z.string()),
    timing: z.string().min(1),
    stopConditions: z.array(z.string()).min(1),
    consentCompliance: z.string().min(1),
    ownership: z.enum(["fixed_copy", "ai_generated"])
  }).strict(),
  ExactStateSchema.extend({
    solutionType: z.literal("wait_timing"),
    anchor: z.string().min(1),
    duration: z.number().nonnegative(),
    unit: z.string().min(1),
    timezone: z.string().min(1),
    businessCalendar: OpaqueObjectRefSchema,
    exits: z.object({
      response: z.string().min(1),
      booking: z.string().min(1),
      optOut: z.string().min(1),
      stage: z.string().min(1)
    }).strict(),
    collisionRisk: z.string().min(1),
    burstSendRisk: z.string().min(1)
  }).strict(),
  ExactStateSchema.extend({
    solutionType: z.enum(["conversation_ai", "voice_ai"]),
    agentId: OpaqueObjectRefSchema,
    capturedVersion: z.union([z.string().min(1), z.number()]),
    capturedHash: Sha256Schema,
    promptChanges: z.string().min(1),
    configurationChanges: NonEmptyRecordSchema,
    actionChanges: z.array(z.string().min(1)),
    knowledgeChanges: z.array(z.string().min(1)),
    routingChanges: z.array(z.string().min(1)),
    handoffChanges: z.array(z.string().min(1)),
    allowedTools: z.array(z.string().min(1)),
    agentGuardrails: z.array(z.string().min(1)).min(1),
    prohibitedBehavior: z.array(z.string().min(1)).min(1),
    escalation: z.array(z.string().min(1)).min(1),
    evaluationCases: z.array(EvaluationCaseSchema).min(1),
    canaryScope: z.string().min(1)
  }).strict(),
  ExactStateSchema.extend({
    solutionType: z.literal("operating_process"),
    processOwner: ActorRefSchema,
    raci: z.record(z.string(), z.string()),
    action: z.string().min(1),
    sla: z.string().min(1),
    trigger: z.string().min(1),
    completionEvidence: z.array(z.string()).min(1),
    staffFields: z.array(z.string().min(1)),
    staffStages: z.array(z.string().min(1)),
    escalation: z.array(z.string()).min(1),
    training: z.array(z.string().min(1)).min(1),
    auditTrail: z.array(z.string().min(1)).min(1),
    complianceMeasurement: z.array(z.string().min(1)).min(1)
  }).strict()
]);
var ProposalSchema = z.object({
  mode: z.literal("PROPOSAL_ONLY"),
  executable: z.literal(false),
  approvalRequired: z.literal(true),
  solutionId: z.string().min(1),
  findingId: z.string().min(1),
  findingFingerprint: z.string().min(1),
  packHash: Sha256Schema,
  objectRefs: z.array(CapturedObjectSchema).min(1),
  changeSet: ChangeSetSchema,
  prerequisites: z.array(z.string().min(1)),
  dependencies: z.array(OpaqueObjectRefSchema),
  blastRadius: z.string().min(1),
  owner: ActorRefSchema,
  acceptanceTests: z.array(z.string().min(1)).min(1),
  monitoring: z.array(z.string()).min(1),
  rollout: NonEmptyRecordSchema,
  rollback: NonEmptyRecordSchema,
  guardrails: z.array(z.string().min(1)).min(1),
  expectedResult: z.object({
    lower: z.number().nullable(),
    upper: z.number().nullable(),
    unit: z.string().min(1),
    basis: z.enum(["MEASURED", "BOUNDED", "INFERRED", "UNMEASURED"])
  }).strict(),
  evidenceRefs: z.array(EvidenceRefSchema).min(1),
  evidenceCutoff: z.string().datetime()
}).strict();
var ConversationSampleSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  seed: z.string().min(1),
  universeCount: z.number().int().nonnegative(),
  selections: z.array(z.object({
    subjectRef: PseudonymousSubjectRefSchema,
    stratum: z.string().min(1),
    inclusionProbability: z.number().positive().max(1),
    evidenceRefs: z.array(EvidenceRefSchema),
    scores: z.record(z.string(), z.number()).optional()
  }).strict())
}).strict();
var ReceiptSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  receiptId: z.string().min(1),
  proposalHash: Sha256Schema,
  approvedAt: z.string().min(1),
  approvedBy: ActorRefSchema,
  approvalScope: z.array(z.string().min(1)).min(1),
  executable: z.literal(false)
}).strict();
var EligibilityRuleSchema = JsonRecordSchema.check((ctx) => {
  const rule = ctx.value;
  if (Object.hasOwn(rule, "minimumSample")) {
    const sample = rule.minimumSample;
    if (!Number.isInteger(sample) || sample < 0) {
      ctx.issues.push({ code: "custom", message: "minimumSample must be a non-negative integer", input: sample });
    }
  }
  if (Object.hasOwn(rule, "minimumCoverage")) {
    const floor = rule.minimumCoverage;
    if (typeof floor !== "number" || !Number.isFinite(floor) || floor < 0 || floor > 1) {
      ctx.issues.push({ code: "custom", message: "minimumCoverage must be a number in [0, 1]", input: floor });
    }
  }
});
var MetricEdgeSchema = z.object({
  edgeId: z.string().min(1),
  journeyId: z.string().min(1),
  journeyInstanceId: JourneyInstanceIdSchema,
  fromStage: z.string().min(1),
  toStage: z.string().min(1),
  eligibilityRule: EligibilityRuleSchema,
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
  nativeMapping: z.enum(["MAPPED", "UNKNOWN"]),
  /**
   * WHAT THIS EDGE MEASURES. `RATE` (the default, and the only reading before task A2 round 2) is a
   * conversion: how many entrants reached the far stage. `VALUE` is an AMOUNT accumulated at the far
   * stage, with NO rate published at all.
   *
   * `VALUE` exists because a declared transition is not always an observable conversion. When both
   * stages are projected from the SAME record under the SAME predicate off the SAME event-time
   * field — which is exactly how `won_to_collected_revenue` is projected out of a GHL opportunity —
   * the conversion exists at the entrant's own instant for every entrant that exists at all, so
   * `numerator === denominator` in every possible account and the "rate" is the constant 1. A
   * collection RATE is not derivable from opportunity data alone; the collected VALUE is.
   * `assertMetricStageCoverage` refuses to let such an edge be MAPPED as a `RATE`.
   */
  measure: z.enum(["RATE", "VALUE"]).optional(),
  /**
   * WHICH WINDOWS THIS EDGE IS REPORTED IN, declared as DATA rather than assumed by the engine.
   *
   * A window no LONGER than the edge's `allowedLag` can mature almost nobody — only a subject
   * entering on the window's first instant has had the whole lag elapse by the cutoff — so an edge
   * published over such a window reports either nothing or a rate computed over one or two
   * subjects out of dozens. The rule of thumb the shipped profiles follow is a lookback of roughly
   * DOUBLE the lag, which lets about half of each window mature.
   *
   * That is also why the same measurement may be declared several times at different maturities
   * (30 days over a trailing 60, 60 over a trailing 90, 90 over a trailing 180): the fast variant
   * moves in weeks and shows whether a recent change is working, the slow one is the true settled
   * number but is far too late to attribute anything to. Each maturity is its own edge with its own
   * `edgeId`, because `edgeId` is the result key under `metrics.metrics[window]`.
   *
   * OMITTING it does not mean "no windows" and does not mean "all windows": it means
   * `DEFAULT_REPORTING_WINDOWS`, the window set that existed before the maturity ladder was added,
   * so an edge written before this field keeps exactly the behaviour it had. `metrics.mjs`
   * validates the same values again and throws `METRICS_CONTRACT_INVALID` on a declaration that
   * bypassed this schema.
   */
  reportingWindows: z.array(z.enum(WINDOW_NAMES)).min(1).refine(
    (names) => new Set(names).size === names.length,
    "reportingWindows must not repeat a window"
  ).optional()
}).strict();
var MetricContractsSchema = z.object({
  profileId: z.enum(["client", "grom_internal"]),
  version: z.literal(SCHEMA_VERSION),
  /** Profile-wide coverage floor, used by every edge that declares no `minimumCoverage`. */
  coverageFloor: z.number().min(0).max(1).optional(),
  edges: z.array(MetricEdgeSchema).min(1)
}).strict().superRefine((contracts, ctx) => {
  const ids = contracts.edges.map(({ edgeId }) => edgeId);
  if (new Set(ids).size !== ids.length) {
    ctx.addIssue({ code: "custom", message: "edge IDs must be unique" });
  }
});
var ProjectionFieldPathSchema = z.string().regex(/^[A-Za-z_$][A-Za-z0-9_$]*(\.[A-Za-z_$][A-Za-z0-9_$]*)*$/);
var ProjectionFieldPathListSchema = z.array(ProjectionFieldPathSchema).min(1);
var ProjectionStageSchema = z.string().regex(/^[a-z][a-z0-9_]{0,127}$/);
var ProjectionOperationPatternSchema = z.string().min(1).regex(/^[A-Za-z0-9_.:*-]+$/);
var ProjectionScalarSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
var ProjectionIdentitySchema = z.object({
  nativeId: ProjectionFieldPathListSchema.optional(),
  subjectNativeId: ProjectionFieldPathListSchema.optional(),
  organizationNativeId: ProjectionFieldPathListSchema.optional(),
  opportunityNativeId: ProjectionFieldPathListSchema.optional(),
  projectNativeId: ProjectionFieldPathListSchema.optional(),
  normalizedEmail: ProjectionFieldPathListSchema.optional(),
  normalizedPhone: ProjectionFieldPathListSchema.optional()
}).strict().superRefine((identity, ctx) => {
  const usable = Boolean(identity.subjectNativeId) || Boolean(identity.normalizedEmail) || Boolean(identity.normalizedPhone) || Boolean(identity.organizationNativeId) && (Boolean(identity.opportunityNativeId) || Boolean(identity.projectNativeId));
  if (!usable) {
    ctx.addIssue({ code: "custom", message: "identity must be able to supply an accepted identity form" });
  }
});
var ProjectionPredicateSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("always") }).strict(),
  z.object({
    kind: z.literal("field_equals"),
    field: ProjectionFieldPathSchema,
    value: ProjectionScalarSchema
  }).strict(),
  z.object({
    kind: z.literal("field_in"),
    field: ProjectionFieldPathSchema,
    values: z.array(ProjectionScalarSchema).min(1)
  }).strict(),
  z.object({ kind: z.literal("first_of_kind") }).strict()
]);
var ProjectionEventSchema = z.object({
  eventId: z.string().min(1),
  stage: ProjectionStageSchema,
  journeyId: z.string().min(1),
  /** Ordered candidates. The first that resolves to a parseable instant wins. */
  eventTimeField: ProjectionFieldPathListSchema,
  when: ProjectionPredicateSchema,
  /** Ordered candidates, like every other path field here. The first that holds a value decides. */
  revenueFrom: ProjectionFieldPathListSchema.optional(),
  cohortFrom: ProjectionFieldPathListSchema.optional()
}).strict();
var ProjectionEntityPredicateSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("always") }).strict(),
  z.object({
    kind: z.literal("field_equals"),
    field: ProjectionFieldPathSchema,
    value: ProjectionScalarSchema
  }).strict(),
  z.object({
    kind: z.literal("field_in"),
    field: ProjectionFieldPathSchema,
    values: z.array(ProjectionScalarSchema).min(1)
  }).strict()
]);
var ProjectionEntitySchema = z.object({
  entityId: z.string().min(1),
  /** The canonical evidence vocabulary, not an account fact: see `normalize.mjs` record types. */
  recordType: z.enum(["contact"]),
  when: ProjectionEntityPredicateSchema
}).strict();
var ProjectionObservationSchema = z.discriminatedUnion("kind", [
  z.object({
    observationId: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
    kind: z.literal("distribution"),
    path: z.string().min(1),
    /** Overflow past this many distinct values is bucketed, never dropped. */
    maxDistinct: z.number().int().min(1).max(100).optional()
  }).strict(),
  z.object({
    observationId: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
    kind: z.literal("presence"),
    /** ORDERED candidates, like every other path list on this contract: first hit decides. */
    paths: z.array(z.string().min(1)).min(1),
    /** A number must be strictly positive to count as present. Default false: any value counts. */
    requirePositiveNumber: z.boolean().optional()
  }).strict(),
  z.object({
    observationId: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
    kind: z.literal("stale_status"),
    statusPath: z.string().min(1),
    statusValues: z.array(z.string().min(1)).min(1),
    /** Compared against the run's SEALED cutoff, never the wall clock. */
    timePath: z.string().min(1)
  }).strict()
]);
var ProjectionSourceSchema = z.object({
  sourceId: z.string().min(1),
  capability: z.string().min(1),
  evidenceSource: z.enum(["context", "public_ghl", "internal_ghl", "onboarding_portal"]),
  operationIdPattern: ProjectionOperationPatternSchema,
  identity: ProjectionIdentitySchema,
  entities: z.array(ProjectionEntitySchema).optional(),
  events: z.array(ProjectionEventSchema).optional(),
  observations: z.array(ProjectionObservationSchema).max(20).optional()
}).strict().superRefine((source, ctx) => {
  const eventIds = (source.events ?? []).map(({ eventId }) => eventId);
  if (new Set(eventIds).size !== eventIds.length) {
    ctx.addIssue({ code: "custom", message: "event IDs must be unique within a source" });
  }
  const entityIds = (source.entities ?? []).map(({ entityId }) => entityId);
  if (new Set(entityIds).size !== entityIds.length) {
    ctx.addIssue({ code: "custom", message: "entity IDs must be unique within a source" });
  }
  const observationIds = (source.observations ?? []).map(({ observationId }) => observationId);
  if (new Set(observationIds).size !== observationIds.length) {
    ctx.addIssue({ code: "custom", message: "observation IDs must be unique within a source" });
  }
  if (eventIds.length === 0 && entityIds.length === 0) {
    ctx.addIssue({ code: "custom", message: "a source must declare at least one event or entity" });
  }
  if (entityIds.length > 0 && !source.identity.subjectNativeId) {
    ctx.addIssue({
      code: "custom",
      message: "a source emitting entities must declare identity.subjectNativeId"
    });
  }
  const provableByComposite = Boolean(
    source.identity.organizationNativeId && (source.identity.opportunityNativeId || source.identity.projectNativeId)
  );
  if (eventIds.length > 0 && entityIds.length === 0 && !provableByComposite) {
    ctx.addIssue({
      code: "custom",
      message: "a source emitting events must declare the entities its payload yields, or an identity a composite join can prove"
    });
  }
});
var ProjectionRevenueBasisSchema = z.enum([
  "opportunity_monetary_value",
  "payments",
  "invoices",
  "orders",
  "transactions",
  "subscriptions",
  "external_ledger",
  "none"
]);
var ProjectionContractSchema = z.object({
  /**
   * Open, unlike the inherited `CoverageProfileSchema.profileId` enum. Review finding I8: the
   * module is genuinely account-agnostic and only the schema layer was blocking a third profile.
   */
  profileId: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
  version: z.literal(SCHEMA_VERSION),
  revenueBasis: ProjectionRevenueBasisSchema,
  /**
   * HOW AN AMOUNT OF EXACTLY ZERO ON AN OUTCOME STAGE IS READ. Declared, never assumed, because the
   * honest answer differs per account and cannot be decided in code.
   *
   * `UNUSABLE` (the default) treats a zero as an amount the account never supplied: the event is
   * still emitted, as UNKNOWN with `REVENUE_ZERO_ON_OUTCOME_STAGE`, and the subject is disclosed as
   * excluded. On a GHL pipeline an unpriced won opportunity is the NORMAL state — the field is
   * simply never filled in — so reading it as "£0 collected" silently understates the account's
   * money and is indistinguishable from a genuine zero collection.
   *
   * `OBSERVED` is for an account where the amount field is genuinely always maintained and a zero
   * therefore is a real answer. It is a deliberate declaration and never a default.
   */
  zeroAmountPolicy: z.enum(["UNUSABLE", "OBSERVED"]).optional(),
  /**
   * Review finding C3: which canonical record type carries a collection-level signal downstream.
   * `normalize.mjs:271-283` only synthesises one for an EMPTY INCOMPLETE envelope, so the
   * projector has to raise its own for a COMPLETE envelope whose rows it suppressed.
   */
  suppressionSignal: z.object({
    recordType: z.enum(["collection_status"])
  }).strict(),
  /**
   * Review finding I7: metric edges whose `fromStage`/`toStage` this projection cannot emit. They
   * are UNMEASURABLE, not zero, and `validateProjectionForProfile` refuses both a silent omission
   * and any attempt to flip one to MAPPED.
   */
  unmeasurableEdges: z.array(z.string().min(1)),
  /**
   * Review finding C2: allowlisted reads this projection deliberately does NOT project, each with
   * its reason. Every allowlisted read must be either routed to exactly one source or named here,
   * so a payload can neither be silently misrouted nor silently forgotten.
   */
  unprojectedActions: z.array(z.object({
    actionId: z.string().min(1),
    reason: z.string().min(1)
  }).strict()),
  sources: z.array(ProjectionSourceSchema).min(1)
}).strict().superRefine((projection, ctx) => {
  const ids = projection.sources.map(({ sourceId }) => sourceId);
  if (new Set(ids).size !== ids.length) {
    ctx.addIssue({ code: "custom", message: "source IDs must be unique" });
  }
  const patterns = projection.sources.map(({ operationIdPattern }) => operationIdPattern);
  if (new Set(patterns).size !== patterns.length) {
    ctx.addIssue({ code: "custom", message: "source operationIdPatterns must be unique" });
  }
  const stages = projection.sources.flatMap((source) => (source.events ?? []).map((e) => e.stage));
  if (new Set(stages).size !== stages.length) {
    ctx.addIssue({ code: "custom", message: "two events must not emit the same stage" });
  }
  const edges = projection.unmeasurableEdges;
  if (new Set(edges).size !== edges.length) {
    ctx.addIssue({ code: "custom", message: "unmeasurableEdges must be unique" });
  }
  const actions = projection.unprojectedActions.map(({ actionId }) => actionId);
  if (new Set(actions).size !== actions.length) {
    ctx.addIssue({ code: "custom", message: "unprojectedActions must be unique" });
  }
});
var ActionTupleSchema = z.object({
  actionId: z.string().min(1),
  method: z.string().min(1),
  normalizedPath: z.string().min(1),
  category: z.string().min(1),
  risk: z.string().min(1)
}).strict();
var ReadActionTupleSchema = ActionTupleSchema.extend({
  risk: z.literal("read")
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
  if (candidate.approvedSemanticRead && candidate.risk !== "read") {
    ctx.addIssue({ code: "custom", message: "approved semantic reads must have read risk" });
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
  actions: z.array(ReadActionTupleSchema)
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
function projectionFilename(profileId) {
  return `${profileId.replace(/_/gu, "-")}-projection.v1.json`;
}
function readProfileFile(filename) {
  return JSON.parse(readFileSync(new URL(`../profiles/${filename}`, import.meta.url), "utf8"));
}
function readProfileFileIfPresent(filename) {
  try {
    return readProfileFile(filename);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}
function normalizeProfileId(profileId) {
  if (profileId === "grom-internal") return "grom_internal";
  return profileId;
}
function readAccountFacts(locationId) {
  if (typeof locationId !== "string" || locationId.length === 0) return null;
  if (!/^[A-Za-z0-9][-A-Za-z0-9_.]{0,127}$/u.test(locationId)) return null;
  return readProfileFileIfPresent(`accounts/${locationId}.v1.json`);
}
function loadProfile(profileId, locationId = null) {
  const normalized = normalizeProfileId(profileId);
  const filename = PROFILE_FILES[normalized];
  if (!filename) throw new Error(`UNKNOWN_PROFILE:${profileId}`);
  const raw = readProfileFile(filename);
  const facts = readAccountFacts(locationId);
  if (facts === null) return CoverageProfileSchema.parse(raw);
  if (facts.profileId !== void 0 && facts.profileId !== normalized) {
    throw new Error(`ACCOUNT_FACTS_PROFILE_MISMATCH:${locationId}`);
  }
  const merged = {
    ...raw,
    situation: {
      ...raw.situation,
      ...facts.situation?.accountName === void 0 ? {} : { accountName: facts.situation.accountName },
      knownDataCaveats: [
        ...raw.situation?.knownDataCaveats ?? [],
        ...facts.situation?.knownDataCaveats ?? []
      ]
    }
  };
  return CoverageProfileSchema.parse(merged);
}
function loadMetricContracts(profileId) {
  const normalized = normalizeProfileId(profileId);
  const filename = METRIC_FILES[normalized];
  if (!filename) throw new Error(`UNKNOWN_METRIC_PROFILE:${profileId}`);
  const profile = loadProfile(normalized);
  const contracts = validateMetricContractsForProfile(profile, readProfileFile(filename));
  const rawProjection = readProfileFileIfPresent(projectionFilename(normalized));
  if (rawProjection === null) {
    if (contracts.edges.some(({ nativeMapping }) => nativeMapping === "MAPPED")) {
      throw new Error(`METRIC_CONTRACTS_UNGATED:${profileId}`);
    }
    return contracts;
  }
  assertMetricStageCoverage(profile, ProjectionContractSchema.parse(rawProjection), contracts);
  return contracts;
}
function validateMetricContractsForProfile(profile, contracts) {
  const parsedProfile = CoverageProfileSchema.parse(profile);
  const parsedContracts = MetricContractsSchema.parse(contracts);
  if (parsedProfile.profileId !== parsedContracts.profileId) {
    throw new Error("PROFILE_METRIC_MISMATCH");
  }
  const journeyInstances = new Map(parsedProfile.journeys.map((journey) => [
    journey.journeyId,
    journey.journeyInstanceId
  ]));
  for (const edge of parsedContracts.edges) {
    if (journeyInstances.get(edge.journeyId) !== edge.journeyInstanceId) {
      throw new Error(`JOURNEY_INSTANCE_MISMATCH:${edge.edgeId}`);
    }
  }
  return parsedContracts;
}
function loadProjection(profileId) {
  const normalized = normalizeProfileId(profileId);
  const raw = readProfileFileIfPresent(projectionFilename(normalized));
  if (raw === null) throw new Error(`UNKNOWN_PROJECTION_PROFILE:${profileId}`);
  return validateProjectionForProfile(
    loadProfile(normalized),
    raw,
    loadMetricContracts(normalized)
  );
}
function matchesOperationIdPattern(pattern, text) {
  if (typeof text !== "string") return false;
  const literal = pattern.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")).join(".*");
  return new RegExp(`^${literal}$`, "u").test(text);
}
var ProjectionTargetProfileSchema = z.object({
  profileId: z.string().min(1),
  journeys: z.array(JourneySchema).min(1)
}).loose();
var cachedAllowlist = null;
function publicReadAllowlist() {
  cachedAllowlist ??= loadPublicReadAllowlist();
  return cachedAllowlist;
}
function isCatchAllPattern(pattern) {
  return pattern.split("*").every((part) => part.length === 0);
}
function patternsCanOverlap(left, right) {
  const memo = /* @__PURE__ */ new Map();
  const decide = (leftIndex, rightIndex) => {
    const key = `${leftIndex}:${rightIndex}`;
    if (memo.has(key)) return memo.get(key);
    let result;
    if (leftIndex === left.length && rightIndex === right.length) {
      result = true;
    } else if (leftIndex < left.length && left[leftIndex] === "*") {
      result = decide(leftIndex + 1, rightIndex) || rightIndex < right.length && decide(leftIndex, rightIndex + 1);
    } else if (rightIndex < right.length && right[rightIndex] === "*") {
      result = decide(leftIndex, rightIndex + 1) || leftIndex < left.length && decide(leftIndex + 1, rightIndex);
    } else {
      result = leftIndex < left.length && rightIndex < right.length && left[leftIndex] === right[rightIndex] && decide(leftIndex + 1, rightIndex + 1);
    }
    memo.set(key, result);
    return result;
  };
  return decide(0, 0);
}
function assertActionRouting(projection) {
  const allowlist = publicReadAllowlist();
  const publicSources = projection.sources.filter(
    ({ evidenceSource }) => evidenceSource === "public_ghl"
  );
  const routed = /* @__PURE__ */ new Map();
  for (const source of publicSources) {
    const matched = allowlist.actions.filter(
      ({ actionId }) => matchesOperationIdPattern(source.operationIdPattern, actionId)
    );
    if (matched.length === 0) {
      throw new Error(
        `PROJECTION_SOURCE_MATCHES_NO_ACTION:${source.sourceId}:${source.operationIdPattern}`
      );
    }
    const categories = [...new Set(matched.map(({ category }) => category))].sort();
    if (categories.length > 1) {
      throw new Error(
        `PROJECTION_SOURCE_SPANS_CATEGORIES:${source.sourceId}:${categories.join(",")}`
      );
    }
    for (const { actionId } of matched) {
      if (routed.has(actionId)) {
        throw new Error(
          `PROJECTION_ACTION_MULTIPLY_MATCHED:${actionId}:${routed.get(actionId)}:${source.sourceId}`
        );
      }
      routed.set(actionId, source.sourceId);
    }
  }
  const known = new Set(allowlist.actions.map(({ actionId }) => actionId));
  for (const { actionId } of projection.unprojectedActions) {
    if (!known.has(actionId)) throw new Error(`PROJECTION_UNPROJECTED_ACTION_UNKNOWN:${actionId}`);
    if (routed.has(actionId)) throw new Error(`PROJECTION_UNPROJECTED_ACTION_MATCHED:${actionId}`);
  }
  const excluded = new Set(projection.unprojectedActions.map(({ actionId }) => actionId));
  for (const { actionId } of allowlist.actions) {
    if (!routed.has(actionId) && !excluded.has(actionId)) {
      throw new Error(`PROJECTION_ACTION_UNCLASSIFIED:${actionId}`);
    }
  }
  for (const source of projection.sources) {
    if (isCatchAllPattern(source.operationIdPattern)) {
      throw new Error(`PROJECTION_SOURCE_PATTERN_CATCH_ALL:${source.sourceId}`);
    }
  }
  for (let index = 0; index < projection.sources.length; index += 1) {
    for (let other = index + 1; other < projection.sources.length; other += 1) {
      const left = projection.sources[index];
      const right = projection.sources[other];
      if (left.evidenceSource !== right.evidenceSource) continue;
      if (patternsCanOverlap(left.operationIdPattern, right.operationIdPattern)) {
        throw new Error(
          `PROJECTION_SOURCE_PATTERNS_OVERLAP:${left.sourceId}:${right.sourceId}`
        );
      }
    }
  }
}
function comparableScalar(value) {
  if (typeof value === "string") return `t:${value.trim().toLowerCase()}`;
  if (typeof value === "number") return Number.isFinite(value) ? `n:${value === 0 ? 0 : value}` : "x";
  if (typeof value === "boolean") return `b:${value}`;
  if (value === null) return "empty";
  return "x";
}
function canonicalPredicate(when) {
  if (when.kind === "field_equals") {
    return canonicalJson({ kind: "field_in", field: when.field, values: [comparableScalar(when.value)] });
  }
  if (when.kind === "field_in") {
    return canonicalJson({
      kind: "field_in",
      field: when.field,
      values: [...new Set(when.values.map(comparableScalar))].sort()
    });
  }
  return canonicalJson(when);
}
function sameTimeReading(left, right) {
  const shorter = left.length <= right.length ? left : right;
  const longer = left.length <= right.length ? right : left;
  return shorter.every((path, index) => path === longer[index]);
}
function tautologicalStagePairs(projection) {
  const byRecordFamily = /* @__PURE__ */ new Map();
  for (const source of projection.sources) {
    const family = canonicalJson([source.evidenceSource, source.capability]);
    const events = byRecordFamily.get(family) ?? [];
    events.push(...source.events ?? []);
    byRecordFamily.set(family, events);
  }
  const pairs = /* @__PURE__ */ new Set();
  for (const events of byRecordFamily.values()) {
    for (let index = 0; index < events.length; index += 1) {
      for (let other = index + 1; other < events.length; other += 1) {
        const left = events[index];
        const right = events[other];
        if (left.stage === right.stage) continue;
        if (canonicalPredicate(left.when) !== canonicalPredicate(right.when)) continue;
        if (!sameTimeReading(left.eventTimeField, right.eventTimeField)) continue;
        pairs.add(`${left.stage}>${right.stage}`);
        pairs.add(`${right.stage}>${left.stage}`);
      }
    }
  }
  return pairs;
}
function assertMetricStageCoverage(profile, projection, metricContracts) {
  const emitted = new Set(projection.sources.flatMap(
    (source) => (source.events ?? []).map(({ stage }) => stage)
  ));
  const tautological = tautologicalStagePairs(projection);
  const declaredUnmeasurable = new Set(projection.unmeasurableEdges);
  const edgeIds = new Set(metricContracts.edges.map(({ edgeId }) => edgeId));
  for (const edgeId of declaredUnmeasurable) {
    if (!edgeIds.has(edgeId)) throw new Error(`PROJECTION_UNMEASURABLE_EDGE_UNKNOWN:${edgeId}`);
  }
  for (const edge of metricContracts.edges) {
    const measurable = emitted.has(edge.fromStage) && emitted.has(edge.toStage);
    if (!measurable && !declaredUnmeasurable.has(edge.edgeId)) {
      throw new Error(`PROJECTION_EDGE_UNMEASURABLE_UNDECLARED:${edge.edgeId}`);
    }
    if (measurable && declaredUnmeasurable.has(edge.edgeId)) {
      throw new Error(`PROJECTION_EDGE_MEASURABLE_DECLARED_UNMEASURABLE:${edge.edgeId}`);
    }
    if (declaredUnmeasurable.has(edge.edgeId) && edge.nativeMapping === "MAPPED") {
      throw new Error(`PROJECTION_UNMEASURABLE_EDGE_MAPPED:${edge.edgeId}`);
    }
    if (edge.nativeMapping === "MAPPED" && tautological.has(`${edge.fromStage}>${edge.toStage}`) && edge.measure !== "VALUE") {
      throw new Error(`PROJECTION_EDGE_TAUTOLOGICAL:${edge.edgeId}`);
    }
  }
  void profile;
}
function validateProjectionForProfile(profile, projection, metricContracts) {
  const parsedProfile = ProjectionTargetProfileSchema.parse(profile);
  const parsedProjection = ProjectionContractSchema.parse(projection);
  if (parsedProfile.profileId !== parsedProjection.profileId) {
    throw new Error("PROFILE_PROJECTION_MISMATCH");
  }
  const declared = new Set(parsedProfile.journeys.map(({ journeyId }) => journeyId));
  const outcomesByJourney = new Map(parsedProfile.journeys.map(
    ({ journeyId, outcomes }) => [journeyId, new Set(outcomes)]
  ));
  for (const source of parsedProjection.sources) {
    for (const event of source.events ?? []) {
      if (!declared.has(event.journeyId)) {
        throw new Error(`PROJECTION_JOURNEY_UNDECLARED:${source.sourceId}:${event.eventId}`);
      }
      if (Array.isArray(event.revenueFrom) && !outcomesByJourney.get(event.journeyId)?.has(event.stage)) {
        throw new Error(
          `PROJECTION_REVENUE_STAGE_NOT_AN_OUTCOME:${source.sourceId}:${event.eventId}`
        );
      }
    }
  }
  assertActionRouting(parsedProjection);
  if (metricContracts === void 0 || metricContracts === null) {
    throw new Error("PROJECTION_METRIC_CONTRACTS_REQUIRED");
  }
  if (!Array.isArray(metricContracts.edges)) {
    throw new Error("PROJECTION_METRIC_CONTRACTS_INVALID");
  }
  assertMetricStageCoverage(parsedProfile, parsedProjection, metricContracts);
  return parsedProjection;
}
function loadCollectionBudgets() {
  return CollectionBudgetsSchema.parse(readProfileFile("collection-budgets.v1.json"));
}
function assertAllowedPublicAction(profile, action) {
  const allowlist = PublicReadAllowlistSchema.parse(profile);
  const requested = ActionTupleSchema.extend({ sourceSnapshotHash: Sha256Schema }).strict().parse(action);
  if (requested.risk !== "read") {
    throw new Error("PUBLIC_ACTION_NOT_ALLOWED: risk must be read");
  }
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
  DEFAULT_REPORTING_WINDOWS,
  EvidenceRecordSchema,
  FindingSchema,
  MetricContractsSchema,
  MetricEdgeSchema,
  ProjectionContractSchema,
  ProposalSchema,
  PublicCatalogSnapshotSchema,
  PublicReadAllowlistSchema,
  ReceiptSchema,
  RunManifestSchema,
  SCHEMA_VERSION,
  TargetSchema,
  WINDOW_NAMES,
  assertAllowedPublicAction,
  assertMetricStageCoverage,
  canonicalJson,
  loadCollectionBudgets,
  loadMetricContracts,
  loadProfile,
  loadProjection,
  loadPublicCatalogSnapshot,
  loadPublicReadAllowlist,
  matchesOperationIdPattern,
  schemaSourcePath,
  snapshotHash,
  validateMetricContractsForProfile,
  validateProjectionForProfile
};
