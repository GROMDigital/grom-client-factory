import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

export const SCHEMA_VERSION = '1.0.0';

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const PseudonymousSubjectRefSchema = z.string().regex(/^psn_[a-f0-9]{16,64}$/);
const OpaqueObjectRefSchema = z.string().regex(/^obj_[a-f0-9]{16,64}$/);
const EvidenceRefSchema = z.string().regex(/^ev_[a-f0-9]{16,64}$/);
const ActorRefSchema = z.string().regex(/^actor_[a-f0-9]{16,64}$/);
const JourneyInstanceIdSchema = z.string().regex(/^journey_[a-z][a-z0-9_]{2,127}$/);
const NonEmptyRecordSchema = z.record(z.string(), z.unknown())
  .refine((value) => Object.keys(value).length > 0, 'must not be empty');
const JsonRecordSchema = z.record(z.string(), z.unknown());

export const TargetSchema = z.object({
  targetKind: z.literal('location'),
  operatingProfile: z.enum(['client', 'grom_internal']),
  locationId: z.string().min(1),
  companyId: z.string().min(1).optional(),
}).strict();

const JourneySchema = z.object({
  journeyId: z.string().min(1),
  journeyInstanceId: JourneyInstanceIdSchema,
  entryRule: z.string().min(1),
  denominator: z.string().min(1),
  outcomes: z.array(z.string().min(1)).min(1),
}).strict();

export const CoverageProfileSchema = z.object({
  profileId: z.enum(['client', 'grom_internal']),
  version: z.literal(SCHEMA_VERSION),
  targetKind: z.literal('location'),
  excludedCapabilities: z.array(z.string().min(1)),
  journeys: z.array(JourneySchema).min(1),
}).strict().superRefine((profile, ctx) => {
  const ids = profile.journeys.map(({ journeyId }) => journeyId);
  if (new Set(ids).size !== ids.length) {
    ctx.addIssue({ code: 'custom', message: 'journey IDs must be unique' });
  }
  const instanceIds = profile.journeys.map(({ journeyInstanceId }) => journeyInstanceId);
  if (new Set(instanceIds).size !== instanceIds.length) {
    ctx.addIssue({ code: 'custom', message: 'journey instance IDs must be unique' });
  }
});

export const RunManifestSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  runId: z.string().min(1),
  target: TargetSchema,
  profileId: z.enum(['client', 'grom_internal']),
  startedAt: z.string().min(1),
  status: z.enum(['running', 'checkpointed', 'complete_partial', 'complete_full', 'quarantined']),
  coverageProfileHash: Sha256Schema,
  metricContractsHash: Sha256Schema,
  publicCatalogSnapshotHash: Sha256Schema,
}).strict();

export const EvidenceRecordSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  evidenceRef: EvidenceRefSchema,
  source: z.enum(['context', 'public_ghl', 'internal_ghl', 'onboarding_portal']),
  capturedAt: z.string().min(1),
  payloadHash: Sha256Schema,
  classification: z.enum(['OBSERVED', 'UNKNOWN', 'NOT_APPLICABLE']),
  objectRefs: z.array(z.object({
    objectType: z.string().min(1),
    objectId: OpaqueObjectRefSchema,
  }).strict()),
}).strict();

export const FindingSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  findingId: z.string().min(1),
  state: z.enum(['OBSERVED', 'UNKNOWN', 'NOT_APPLICABLE']),
  severity: z.enum(['critical', 'high', 'medium', 'low']),
  journeyId: z.string().min(1),
  edgeId: z.string().min(1),
  summary: z.string().min(1),
  evidenceRefs: z.array(EvidenceRefSchema).min(1),
}).strict();

const ExactStateSchema = z.object({
  current: z.record(z.string(), z.unknown()),
  proposed: z.record(z.string(), z.unknown()),
}).strict();
const CapturedObjectSchema = z.object({
  objectType: z.string().min(1),
  objectId: OpaqueObjectRefSchema,
  capturedVersion: z.union([z.string().min(1), z.number()]),
  capturedHash: Sha256Schema,
}).strict();
const EvaluationCaseSchema = z.object({
  caseId: z.string().min(1),
  version: z.string().min(1),
  expected: z.string().min(1),
}).strict();
const ChangeSetSchema = z.discriminatedUnion('solutionType', [
  ExactStateSchema.extend({
    solutionType: z.literal('workflow_logic'),
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
      agents: z.array(OpaqueObjectRefSchema),
    }).strict(),
    existingEnrollmentHandling: z.string().min(1),
  }).strict(),
  ExactStateSchema.extend({
    solutionType: z.literal('copy'),
    channel: z.string().min(1),
    audience: z.string().min(1),
    locale: z.string().min(1),
    finalText: z.string().min(1),
    mergeFields: z.array(z.string()),
    fallbacks: z.record(z.string(), z.string()),
    timing: z.string().min(1),
    stopConditions: z.array(z.string()).min(1),
    consentCompliance: z.string().min(1),
    ownership: z.enum(['fixed_copy', 'ai_generated']),
  }).strict(),
  ExactStateSchema.extend({
    solutionType: z.literal('wait_timing'),
    anchor: z.string().min(1),
    duration: z.number().nonnegative(),
    unit: z.string().min(1),
    timezone: z.string().min(1),
    businessCalendar: OpaqueObjectRefSchema,
    exits: z.object({
      response: z.string().min(1),
      booking: z.string().min(1),
      optOut: z.string().min(1),
      stage: z.string().min(1),
    }).strict(),
    collisionRisk: z.string().min(1),
    burstSendRisk: z.string().min(1),
  }).strict(),
  ExactStateSchema.extend({
    solutionType: z.enum(['conversation_ai', 'voice_ai']),
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
    canaryScope: z.string().min(1),
  }).strict(),
  ExactStateSchema.extend({
    solutionType: z.literal('operating_process'),
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
    complianceMeasurement: z.array(z.string().min(1)).min(1),
  }).strict(),
]);

export const ProposalSchema = z.object({
  mode: z.literal('PROPOSAL_ONLY'),
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
    basis: z.enum(['MEASURED', 'BOUNDED', 'INFERRED', 'UNMEASURED']),
  }).strict(),
  evidenceRefs: z.array(EvidenceRefSchema).min(1),
  evidenceCutoff: z.string().datetime(),
}).strict();

export const ConversationSampleSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  seed: z.string().min(1),
  universeCount: z.number().int().nonnegative(),
  selections: z.array(z.object({
    subjectRef: PseudonymousSubjectRefSchema,
    stratum: z.string().min(1),
    inclusionProbability: z.number().positive().max(1),
    evidenceRefs: z.array(EvidenceRefSchema),
    scores: z.record(z.string(), z.number()).optional(),
  }).strict()),
}).strict();

export const ReceiptSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  receiptId: z.string().min(1),
  proposalHash: Sha256Schema,
  approvedAt: z.string().min(1),
  approvedBy: ActorRefSchema,
  approvalScope: z.array(z.string().min(1)).min(1),
  executable: z.literal(false),
}).strict();

/**
 * THE COVERAGE FLOOR, declared as DATA beside `minimumSample`.
 *
 * `minimumSample` bounds how SMALL a measured denominator may be; `minimumCoverage` bounds what
 * SHARE of the eligible population that denominator has to represent, so an edge measured over a
 * rump of the account reads UNKNOWN instead of confident. Both are per-edge because the tolerable
 * loss differs by edge: a revenue edge joined through one native id can demand near-total
 * coverage, an engagement edge stitched across sources cannot.
 *
 * Omitting `minimumCoverage` does NOT disable the guard — `metrics.mjs` falls back to the
 * profile-level `coverageFloor` and then to `DEFAULT_COVERAGE_FLOOR`. A present-but-invalid value
 * throws rather than degrading quietly.
 *
 * A declared `0` is the one value that DOES disable the guard, and it stays legal because an edge
 * may legitimately prefer any measurement to none. It is never silent: `metrics.mjs` stamps
 * `coverageFloorDisabled: true` on the metric and `mechanisms.mjs` raises
 * `COVERAGE_FLOOR_DISABLED` into the sealed packet.
 *
 * `minimumSample` is validated here AND in `metrics.mjs`, which throws `METRICS_CONTRACT_INVALID`
 * on the same values rather than degrading a broken declaration to a threshold of zero.
 */
const EligibilityRuleSchema = JsonRecordSchema.check((ctx) => {
  const rule = ctx.value;
  if (Object.hasOwn(rule, 'minimumSample')) {
    const sample = rule.minimumSample;
    if (!Number.isInteger(sample) || sample < 0) {
      ctx.issues.push({ code: 'custom', message: 'minimumSample must be a non-negative integer', input: sample });
    }
  }
  if (Object.hasOwn(rule, 'minimumCoverage')) {
    const floor = rule.minimumCoverage;
    if (typeof floor !== 'number' || !Number.isFinite(floor) || floor < 0 || floor > 1) {
      ctx.issues.push({ code: 'custom', message: 'minimumCoverage must be a number in [0, 1]', input: floor });
    }
  }
});

export const MetricEdgeSchema = z.object({
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
    unit: z.string().min(1),
  }).strict(),
  maturityRule: JsonRecordSchema,
  dispositions: z.array(z.string().min(1)).min(1),
  reentryRule: z.enum(['new_journey_instance', 'same_journey_instance']),
  outcomeRule: JsonRecordSchema,
  required: z.boolean(),
  nativeMapping: z.enum(['MAPPED', 'UNKNOWN']),
}).strict();

export const MetricContractsSchema = z.object({
  profileId: z.enum(['client', 'grom_internal']),
  version: z.literal(SCHEMA_VERSION),
  /** Profile-wide coverage floor, used by every edge that declares no `minimumCoverage`. */
  coverageFloor: z.number().min(0).max(1).optional(),
  edges: z.array(MetricEdgeSchema).min(1),
}).strict().superRefine((contracts, ctx) => {
  const ids = contracts.edges.map(({ edgeId }) => edgeId);
  if (new Set(ids).size !== ids.length) {
    ctx.addIssue({ code: 'custom', message: 'edge IDs must be unique' });
  }
});

/**
 * THE JOURNEY PROJECTION CONTRACT.
 *
 * Everything account-specific about turning raw GHL records into canonical journey records lives
 * HERE, as data. `lib/journey-projection.mjs` carries no stage name, no status string and no field
 * path, so a third account is added by writing one more JSON file and nothing else.
 *
 * `revenueBasis` is deliberately a profile field rather than a constant in code. The standing
 * decision for both shipped profiles is `opportunity_monetary_value`, but the REASON is structural:
 * what a GHL account's payments surface captures varies per account and over time, so an account
 * that genuinely reconciles revenue through payments may legitimately declare `payments`.
 */
const ProjectionFieldPathSchema = z.string()
  .regex(/^[A-Za-z_$][A-Za-z0-9_$]*(\.[A-Za-z_$][A-Za-z0-9_$]*)*$/);
const ProjectionFieldPathListSchema = z.array(ProjectionFieldPathSchema).min(1);
/** Matches `normalize.mjs`'s identifier pattern for `stage`, so a bad stage cannot reach evidence. */
const ProjectionStageSchema = z.string().regex(/^[a-z][a-z0-9_]{0,127}$/);
/**
 * A LITERAL-OR-WILDCARD pattern, never a regular expression: `*` matches any run of characters and
 * every other character is literal. A profile is data supplied to a long-running deterministic
 * process, so it must not be able to smuggle in a catastrophically backtracking regex.
 */
const ProjectionOperationPatternSchema = z.string().min(1).regex(/^[A-Za-z0-9_.:*-]+$/);
const ProjectionScalarSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

const ProjectionIdentitySchema = z.object({
  nativeId: ProjectionFieldPathListSchema.optional(),
  subjectNativeId: ProjectionFieldPathListSchema.optional(),
  organizationNativeId: ProjectionFieldPathListSchema.optional(),
  opportunityNativeId: ProjectionFieldPathListSchema.optional(),
  projectNativeId: ProjectionFieldPathListSchema.optional(),
  normalizedEmail: ProjectionFieldPathListSchema.optional(),
  normalizedPhone: ProjectionFieldPathListSchema.optional(),
}).strict().superRefine((identity, ctx) => {
  // `normalize.mjs:178-194` accepts exactly these identity forms. A source that cannot possibly
  // produce one of them can only ever emit records that are suppressed, which is a contract bug.
  const usable = Boolean(identity.subjectNativeId)
    || Boolean(identity.normalizedEmail)
    || Boolean(identity.normalizedPhone)
    || (
      Boolean(identity.organizationNativeId)
      && (Boolean(identity.opportunityNativeId) || Boolean(identity.projectNativeId))
    );
  if (!usable) {
    ctx.addIssue({ code: 'custom', message: 'identity must be able to supply an accepted identity form' });
  }
});

const ProjectionPredicateSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('always') }).strict(),
  z.object({
    kind: z.literal('field_equals'),
    field: ProjectionFieldPathSchema,
    value: ProjectionScalarSchema,
  }).strict(),
  z.object({
    kind: z.literal('field_in'),
    field: ProjectionFieldPathSchema,
    values: z.array(ProjectionScalarSchema).min(1),
  }).strict(),
  z.object({ kind: z.literal('first_of_kind') }).strict(),
]);

const ProjectionEventSchema = z.object({
  eventId: z.string().min(1),
  stage: ProjectionStageSchema,
  journeyId: z.string().min(1),
  /** Ordered candidates. The first that resolves to a parseable instant wins. */
  eventTimeField: ProjectionFieldPathListSchema,
  when: ProjectionPredicateSchema,
  /** Ordered candidates, like every other path field here. The first that holds a value decides. */
  revenueFrom: ProjectionFieldPathListSchema.optional(),
  cohortFrom: ProjectionFieldPathListSchema.optional(),
}).strict();

/**
 * ENTITY records. Review finding C1: `evidence-graph.mjs:217-218` builds `contact_entity` nodes —
 * and therefore every `identity_exact` edge — ONLY from records whose `recordType` is `contact`.
 * A projection that emits journey events alone can never produce a proving join, so
 * `metrics.mjs:220` returns UNKNOWN for every metric of every account, forever. A source must
 * therefore be able to declare that its payload also yields the SUBJECT, not only what happened
 * to the subject.
 *
 * `first_of_kind` is deliberately absent from an entity predicate: an entity carries no instant,
 * so there is no total order to take a first of.
 */
const ProjectionEntityPredicateSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('always') }).strict(),
  z.object({
    kind: z.literal('field_equals'),
    field: ProjectionFieldPathSchema,
    value: ProjectionScalarSchema,
  }).strict(),
  z.object({
    kind: z.literal('field_in'),
    field: ProjectionFieldPathSchema,
    values: z.array(ProjectionScalarSchema).min(1),
  }).strict(),
]);

const ProjectionEntitySchema = z.object({
  entityId: z.string().min(1),
  /** The canonical evidence vocabulary, not an account fact: see `normalize.mjs` record types. */
  recordType: z.enum(['contact']),
  when: ProjectionEntityPredicateSchema,
}).strict();

const ProjectionSourceSchema = z.object({
  sourceId: z.string().min(1),
  capability: z.string().min(1),
  evidenceSource: z.enum(['context', 'public_ghl', 'internal_ghl', 'onboarding_portal']),
  operationIdPattern: ProjectionOperationPatternSchema,
  identity: ProjectionIdentitySchema,
  entities: z.array(ProjectionEntitySchema).optional(),
  events: z.array(ProjectionEventSchema).optional(),
}).strict().superRefine((source, ctx) => {
  const eventIds = (source.events ?? []).map(({ eventId }) => eventId);
  if (new Set(eventIds).size !== eventIds.length) {
    ctx.addIssue({ code: 'custom', message: 'event IDs must be unique within a source' });
  }
  const entityIds = (source.entities ?? []).map(({ entityId }) => entityId);
  if (new Set(entityIds).size !== entityIds.length) {
    ctx.addIssue({ code: 'custom', message: 'entity IDs must be unique within a source' });
  }
  if (eventIds.length === 0 && entityIds.length === 0) {
    ctx.addIssue({ code: 'custom', message: 'a source must declare at least one event or entity' });
  }
  if (entityIds.length > 0 && !source.identity.subjectNativeId) {
    // `evidence-graph.mjs:217-218` keys a contact entity on `nativeId`, and `:328` joins events to
    // it by their `subjectNativeId`. An entity is therefore keyed on the SUBJECT's native id, so a
    // source that cannot resolve one can only ever emit inert entity nodes nothing joins to.
    ctx.addIssue({
      code: 'custom',
      message: 'a source emitting entities must declare identity.subjectNativeId',
    });
  }
  // The class behind the "no proving join" defect. `evidence-graph.mjs:327-361` can prove an event
  // exactly two ways: an entity keyed on the same native id, or a composite identity the event
  // carries itself. A source that declares events and neither of those leaves every event it emits
  // unprovable, and `metrics.mjs:220` blanks the edge for EVERY subject as soon as ONE is
  // unprovable. The projector re-checks this per run against the records actually emitted; this
  // refuses the contract that guarantees the failure before a single record is read.
  const provableByComposite = Boolean(
    source.identity.organizationNativeId
    && (source.identity.opportunityNativeId || source.identity.projectNativeId),
  );
  if (eventIds.length > 0 && entityIds.length === 0 && !provableByComposite) {
    ctx.addIssue({
      code: 'custom',
      message: 'a source emitting events must declare the entities its payload yields, '
        + 'or an identity a composite join can prove',
    });
  }
});

/**
 * The vocabulary of revenue bases. Deliberately a NAMED set rather than free text: an unrecognised
 * basis is a typo, and a typo here decides which surface an account's money is read from. It is
 * equally deliberately not two values, because a third account profile must be addable as JSON.
 */
const ProjectionRevenueBasisSchema = z.enum([
  'opportunity_monetary_value',
  'payments',
  'invoices',
  'orders',
  'transactions',
  'subscriptions',
  'external_ledger',
  'none',
]);

export const ProjectionContractSchema = z.object({
  /**
   * Open, unlike the inherited `CoverageProfileSchema.profileId` enum. Review finding I8: the
   * module is genuinely account-agnostic and only the schema layer was blocking a third profile.
   */
  profileId: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
  version: z.literal(SCHEMA_VERSION),
  revenueBasis: ProjectionRevenueBasisSchema,
  /**
   * Review finding C3: which canonical record type carries a collection-level signal downstream.
   * `normalize.mjs:271-283` only synthesises one for an EMPTY INCOMPLETE envelope, so the
   * projector has to raise its own for a COMPLETE envelope whose rows it suppressed.
   */
  suppressionSignal: z.object({
    recordType: z.enum(['collection_status']),
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
    reason: z.string().min(1),
  }).strict()),
  sources: z.array(ProjectionSourceSchema).min(1),
}).strict().superRefine((projection, ctx) => {
  const ids = projection.sources.map(({ sourceId }) => sourceId);
  if (new Set(ids).size !== ids.length) {
    ctx.addIssue({ code: 'custom', message: 'source IDs must be unique' });
  }
  const patterns = projection.sources.map(({ operationIdPattern }) => operationIdPattern);
  if (new Set(patterns).size !== patterns.length) {
    ctx.addIssue({ code: 'custom', message: 'source operationIdPatterns must be unique' });
  }
  const stages = projection.sources.flatMap((source) => (source.events ?? []).map((e) => e.stage));
  if (new Set(stages).size !== stages.length) {
    ctx.addIssue({ code: 'custom', message: 'two events must not emit the same stage' });
  }
  const edges = projection.unmeasurableEdges;
  if (new Set(edges).size !== edges.length) {
    ctx.addIssue({ code: 'custom', message: 'unmeasurableEdges must be unique' });
  }
  const actions = projection.unprojectedActions.map(({ actionId }) => actionId);
  if (new Set(actions).size !== actions.length) {
    ctx.addIssue({ code: 'custom', message: 'unprojectedActions must be unique' });
  }
});

const ActionTupleSchema = z.object({
  actionId: z.string().min(1),
  method: z.string().min(1),
  normalizedPath: z.string().min(1),
  category: z.string().min(1),
  risk: z.string().min(1),
}).strict();
const ReadActionTupleSchema = ActionTupleSchema.extend({
  risk: z.literal('read'),
}).strict();
const ApprovalSchema = z.object({
  provenance: z.string().min(1),
  reviewedAt: z.string().min(1),
  reviewedBy: z.string().min(1),
}).strict();
const CatalogCandidateSchema = ActionTupleSchema.extend({
  approvedSemanticRead: z.boolean(),
  approval: ApprovalSchema.optional(),
}).strict().superRefine((candidate, ctx) => {
  if (candidate.approvedSemanticRead && !candidate.approval) {
    ctx.addIssue({ code: 'custom', message: 'approved actions require approval provenance' });
  }
  if (candidate.approvedSemanticRead && candidate.risk !== 'read') {
    ctx.addIssue({ code: 'custom', message: 'approved semantic reads must have read risk' });
  }
});

export const PublicCatalogSnapshotSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  catalogRevision: z.string().min(1),
  capturedAt: z.string().min(1),
  sourceServer: z.object({
    name: z.string().min(1),
    identity: z.string().min(1),
    version: z.string().min(1),
  }).strict(),
  candidates: z.array(CatalogCandidateSchema),
  canonicalSha256: Sha256Schema,
}).strict().superRefine((snapshot, ctx) => {
  const ids = snapshot.candidates.map(({ actionId }) => actionId);
  if (new Set(ids).size !== ids.length) {
    ctx.addIssue({ code: 'custom', message: 'catalog action IDs must be unique' });
  }
});

export const PublicReadAllowlistSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  sourceCatalogRevision: z.string().min(1),
  sourceSnapshotHash: Sha256Schema,
  sourceServerIdentity: z.string().min(1),
  actions: z.array(ReadActionTupleSchema),
}).strict().superRefine((allowlist, ctx) => {
  const ids = allowlist.actions.map(({ actionId }) => actionId);
  if (new Set(ids).size !== ids.length) {
    ctx.addIssue({ code: 'custom', message: 'allowlist action IDs must be unique' });
  }
});

const BudgetSchema = z.object({
  maximumPages: z.number().int().positive(),
  maximumRecords: z.number().int().positive(),
  maximumResponseBytes: z.number().int().positive(),
  requestTimeoutMs: z.number().int().positive(),
  retryCount: z.number().int().nonnegative(),
  maximumTotalRetryDelayMs: z.number().int().nonnegative(),
  wallClockMs: z.number().int().positive(),
}).strict();
export const CollectionBudgetsSchema = z.object({
  version: z.literal(SCHEMA_VERSION),
  exhaustionPolicy: z.literal('checkpoint_scope_incomplete'),
  capabilities: z.record(z.string().min(1), BudgetSchema),
}).strict();

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

export function snapshotHash(snapshot) {
  const { canonicalSha256: _ignored, ...payload } = snapshot;
  return createHash('sha256').update(canonicalJson(payload)).digest('hex');
}

const PROFILE_FILES = Object.freeze({
  client: 'client.v1.json',
  grom_internal: 'grom-internal.v1.json',
});
const METRIC_FILES = Object.freeze({
  client: 'client-metrics.v1.json',
  grom_internal: 'grom-internal-metrics.v1.json',
});
/**
 * Review finding I8: no hardcoded map. A projection file is found BY CONVENTION, so a third
 * account profile is a JSON file and nothing else. (`PROFILE_FILES` above stays as inherited debt:
 * see the note on `loadProjection`.)
 */
function projectionFilename(profileId) {
  return `${profileId.replace(/_/gu, '-')}-projection.v1.json`;
}

function readProfileFile(filename) {
  return JSON.parse(readFileSync(new URL(`../profiles/${filename}`, import.meta.url), 'utf8'));
}

function readProfileFileIfPresent(filename) {
  try {
    return readProfileFile(filename);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function normalizeProfileId(profileId) {
  if (profileId === 'grom-internal') return 'grom_internal';
  return profileId;
}

export function loadProfile(profileId) {
  const normalized = normalizeProfileId(profileId);
  const filename = PROFILE_FILES[normalized];
  if (!filename) throw new Error(`UNKNOWN_PROFILE:${profileId}`);
  return CoverageProfileSchema.parse(readProfileFile(filename));
}

export function loadMetricContracts(profileId) {
  const normalized = normalizeProfileId(profileId);
  const filename = METRIC_FILES[normalized];
  if (!filename) throw new Error(`UNKNOWN_METRIC_PROFILE:${profileId}`);
  return validateMetricContractsForProfile(loadProfile(normalized), readProfileFile(filename));
}

export function validateMetricContractsForProfile(profile, contracts) {
  const parsedProfile = CoverageProfileSchema.parse(profile);
  const parsedContracts = MetricContractsSchema.parse(contracts);
  if (parsedProfile.profileId !== parsedContracts.profileId) {
    throw new Error('PROFILE_METRIC_MISMATCH');
  }
  const journeyInstances = new Map(parsedProfile.journeys.map((journey) => [
    journey.journeyId,
    journey.journeyInstanceId,
  ]));
  for (const edge of parsedContracts.edges) {
    if (journeyInstances.get(edge.journeyId) !== edge.journeyInstanceId) {
      throw new Error(`JOURNEY_INSTANCE_MISMATCH:${edge.edgeId}`);
    }
  }
  return parsedContracts;
}

/**
 * INHERITED DEBT, reported rather than silently patched: `loadProjection` still routes the COVERAGE
 * profile through `loadProfile`, whose `CoverageProfileSchema.profileId` enum predates this task and
 * is out of scope. A third account can therefore be validated today
 * (`validateProjectionForProfile(profile, projection)` accepts any profileId) but not yet LOADED by
 * id. Opening `CoverageProfileSchema` is the one remaining change.
 */
export function loadProjection(profileId) {
  const normalized = normalizeProfileId(profileId);
  const raw = readProfileFileIfPresent(projectionFilename(normalized));
  if (raw === null) throw new Error(`UNKNOWN_PROJECTION_PROFILE:${profileId}`);
  return validateProjectionForProfile(
    loadProfile(normalized),
    raw,
    loadMetricContracts(normalized),
  );
}

/**
 * A LITERAL-OR-WILDCARD match. Intentionally not a regular expression, and intentionally the same
 * rule `lib/journey-projection.mjs` applies at projection time — a pattern that routes differently
 * here than there would validate one thing and project another.
 */
export function matchesOperationIdPattern(pattern, text) {
  if (typeof text !== 'string') return false;
  const literal = pattern
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'))
    .join('.*');
  return new RegExp(`^${literal}$`, 'u').test(text);
}

/**
 * The coverage profile as the PROJECTION layer needs it. Deliberately not `CoverageProfileSchema`:
 * that schema's closed `profileId` enum is inherited debt and must not leak into the one place a
 * third account profile has to pass through.
 */
const ProjectionTargetProfileSchema = z.object({
  profileId: z.string().min(1),
  journeys: z.array(JourneySchema).min(1),
}).loose();

let cachedAllowlist = null;
function publicReadAllowlist() {
  cachedAllowlist ??= loadPublicReadAllowlist();
  return cachedAllowlist;
}

/**
 * A pattern that matches EVERY possible operation id. `*`, `**` and friends: nothing but wildcards.
 * A source claiming one of those has not been routed, it has been given first refusal on the whole
 * rail, and whether that is caught depends entirely on what else happens to be declared.
 */
function isCatchAllPattern(pattern) {
  return pattern.split('*').every((part) => part.length === 0);
}

/**
 * Whether two literal-or-wildcard patterns can BOTH match some string — that is, whether their
 * languages intersect. Decided directly rather than by sampling ids out of an allowlist, because a
 * source whose evidence never appears in an allowlist still must not be ambiguous:
 * `journey-projection.mjs` throws `PROJECTION_SOURCE_AMBIGUOUS` at run time for exactly this, and a
 * run-time throw on real client data is a poor substitute for refusing the profile at load.
 */
function patternsCanOverlap(left, right) {
  const memo = new Map();
  const decide = (leftIndex, rightIndex) => {
    const key = `${leftIndex}:${rightIndex}`;
    if (memo.has(key)) return memo.get(key);
    let result;
    if (leftIndex === left.length && rightIndex === right.length) {
      result = true;
    } else if (leftIndex < left.length && left[leftIndex] === '*') {
      result = decide(leftIndex + 1, rightIndex)
        || (rightIndex < right.length && decide(leftIndex, rightIndex + 1));
    } else if (rightIndex < right.length && right[rightIndex] === '*') {
      result = decide(leftIndex, rightIndex + 1)
        || (leftIndex < left.length && decide(leftIndex + 1, rightIndex));
    } else {
      result = leftIndex < left.length
        && rightIndex < right.length
        && left[leftIndex] === right[rightIndex]
        && decide(leftIndex + 1, rightIndex + 1);
    }
    memo.set(key, result);
    return result;
  };
  return decide(0, 0);
}

/**
 * Review finding C2. The shipped patterns used to match the wrong endpoints entirely: `contacts-*`
 * caught an APPOINTMENTS payload and read it as a lead, `opportunities-*` caught pipeline
 * DEFINITIONS and read them as opportunities, `appointments-*` caught nothing at all, and the three
 * endpoints that actually carry the payloads matched no source. A silently misrouted payload is
 * worse than a missing one, so every allowlisted read must now be classified exactly once.
 *
 * ROUTING RULES APPLY TO EVERY `evidenceSource`, NOT ONLY `public_ghl`. The first cut returned early
 * when no public source was declared and only ever inspected public ones, so an internal-only
 * projection with a `"*"` catch-all and an empty exclusion list was ACCEPTED, and a mixed profile
 * routed an internal envelope through an internal catch-all. Skipping the check for the sources it
 * has no allowlist to compare against is deny-list-shaped reasoning: the sources that most need a
 * rule are the ones with nothing to check them. A source with no allowlist behind it is therefore
 * held to the rules that need no allowlist — no catch-all, and no ambiguity with a sibling.
 */
function assertActionRouting(projection) {
  const allowlist = publicReadAllowlist();
  const publicSources = projection.sources.filter(
    ({ evidenceSource }) => evidenceSource === 'public_ghl',
  );

  const routed = new Map();
  for (const source of publicSources) {
    const matched = allowlist.actions.filter(
      ({ actionId }) => matchesOperationIdPattern(source.operationIdPattern, actionId),
    );
    if (matched.length === 0) {
      throw new Error(
        `PROJECTION_SOURCE_MATCHES_NO_ACTION:${source.sourceId}:${source.operationIdPattern}`,
      );
    }
    const categories = [...new Set(matched.map(({ category }) => category))].sort();
    if (categories.length > 1) {
      throw new Error(
        `PROJECTION_SOURCE_SPANS_CATEGORIES:${source.sourceId}:${categories.join(',')}`,
      );
    }
    for (const { actionId } of matched) {
      if (routed.has(actionId)) {
        throw new Error(
          `PROJECTION_ACTION_MULTIPLY_MATCHED:${actionId}:${routed.get(actionId)}:${source.sourceId}`,
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
  // Unconditional. A projection that declares no public source has not opted out of classifying
  // the public read surface, it has simply declined to read it, and declining is what
  // `unprojectedActions` is for — with a reason attached, per action.
  const excluded = new Set(projection.unprojectedActions.map(({ actionId }) => actionId));
  for (const { actionId } of allowlist.actions) {
    if (!routed.has(actionId) && !excluded.has(actionId)) {
      throw new Error(`PROJECTION_ACTION_UNCLASSIFIED:${actionId}`);
    }
  }

  // The allowlist-free rules, applied to EVERY source of every evidence source. They run after the
  // allowlist rules above only so that a public source keeps its more specific diagnosis: for a
  // public catch-all, "this pattern spans four categories" says more than "this pattern is a
  // catch-all". Neither set is skipped for anybody.
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
          `PROJECTION_SOURCE_PATTERNS_OVERLAP:${left.sourceId}:${right.sourceId}`,
        );
      }
    }
  }
}

/**
 * Review finding I7. A metric edge whose `fromStage` or `toStage` nothing ever emits does not read
 * UNKNOWN — `metrics.mjs` publishes it as a confident zero over a real denominator. The honest
 * outcome is that the edge is declared UNMEASURABLE, and an unmeasurable edge may never be flipped
 * to MAPPED, because there is nothing for it to be mapped to.
 */
function assertStageCoverage(profile, projection, metricContracts) {
  const emitted = new Set(projection.sources.flatMap(
    (source) => (source.events ?? []).map(({ stage }) => stage),
  ));
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
    if (declaredUnmeasurable.has(edge.edgeId) && edge.nativeMapping === 'MAPPED') {
      throw new Error(`PROJECTION_UNMEASURABLE_EDGE_MAPPED:${edge.edgeId}`);
    }
  }
  void profile;
}

/**
 * `metricContracts` is REQUIRED and has no default. It used to default to `null`, which made
 * `assertStageCoverage` and the unmeasurable-edge gate OPT-IN: the two-argument call accepted a
 * projection whose flipped contract the three-argument call refused, and every caller was one
 * forgotten argument away from validating nothing that matters. An optional gate is not a gate.
 * The check sits at the END of this function so that a projection which is malformed in a more
 * specific way still reports the more specific fault.
 */
export function validateProjectionForProfile(profile, projection, metricContracts) {
  const parsedProfile = ProjectionTargetProfileSchema.parse(profile);
  const parsedProjection = ProjectionContractSchema.parse(projection);
  if (parsedProfile.profileId !== parsedProjection.profileId) {
    throw new Error('PROFILE_PROJECTION_MISMATCH');
  }
  const declared = new Set(parsedProfile.journeys.map(({ journeyId }) => journeyId));
  const outcomesByJourney = new Map(parsedProfile.journeys.map(
    ({ journeyId, outcomes }) => [journeyId, new Set(outcomes)],
  ));
  for (const source of parsedProjection.sources) {
    for (const event of source.events ?? []) {
      // The instance id is derived from the coverage profile at projection time
      // (`evidence-graph.mjs:451-457` throws otherwise), so a journey the profile does not declare
      // has no instance to derive and must be refused here rather than at evidence time.
      if (!declared.has(event.journeyId)) {
        throw new Error(`PROJECTION_JOURNEY_UNDECLARED:${source.sourceId}:${event.eventId}`);
      }
      // An amount read onto a stage the journey does not treat as an outcome is dead weight at
      // best and a misattributed amount at worst.
      if (
        Array.isArray(event.revenueFrom)
        && !outcomesByJourney.get(event.journeyId)?.has(event.stage)
      ) {
        throw new Error(
          `PROJECTION_REVENUE_STAGE_NOT_AN_OUTCOME:${source.sourceId}:${event.eventId}`,
        );
      }
    }
  }
  assertActionRouting(parsedProjection);
  if (metricContracts === undefined || metricContracts === null) {
    throw new Error('PROJECTION_METRIC_CONTRACTS_REQUIRED');
  }
  // Deliberately NOT `MetricContractsSchema.parse`: that schema's `profileId` enum is the same
  // inherited debt as `CoverageProfileSchema`'s, and it must not block a third account here.
  if (!Array.isArray(metricContracts.edges)) {
    throw new Error('PROJECTION_METRIC_CONTRACTS_INVALID');
  }
  assertStageCoverage(parsedProfile, parsedProjection, metricContracts);
  return parsedProjection;
}

export function loadCollectionBudgets() {
  return CollectionBudgetsSchema.parse(readProfileFile('collection-budgets.v1.json'));
}

export function assertAllowedPublicAction(profile, action) {
  const allowlist = PublicReadAllowlistSchema.parse(profile);
  const requested = ActionTupleSchema.extend({ sourceSnapshotHash: Sha256Schema }).strict().parse(action);
  if (requested.risk !== 'read') {
    throw new Error('PUBLIC_ACTION_NOT_ALLOWED: risk must be read');
  }
  if (requested.sourceSnapshotHash !== allowlist.sourceSnapshotHash) {
    throw new Error('PUBLIC_ACTION_NOT_ALLOWED: source snapshot hash differs');
  }
  const allowed = allowlist.actions.some((entry) => (
    entry.actionId === requested.actionId
    && entry.method === requested.method
    && entry.normalizedPath === requested.normalizedPath
    && entry.category === requested.category
    && entry.risk === requested.risk
  ));
  if (!allowed) throw new Error('PUBLIC_ACTION_NOT_ALLOWED: action tuple differs');
  return true;
}

export function loadPublicCatalogSnapshot() {
  const snapshot = PublicCatalogSnapshotSchema.parse(readProfileFile('public-catalog-snapshot.v1.json'));
  if (snapshotHash(snapshot) !== snapshot.canonicalSha256) {
    throw new Error('CATALOG_SNAPSHOT_HASH_MISMATCH');
  }
  return snapshot;
}

export function loadPublicReadAllowlist() {
  return PublicReadAllowlistSchema.parse(readProfileFile('public-read-allowlist.v1.json'));
}

export const schemaSourcePath = fileURLToPath(import.meta.url);
