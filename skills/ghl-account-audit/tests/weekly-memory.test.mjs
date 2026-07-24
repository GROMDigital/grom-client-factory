import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { canonicalJson, sha256 } from '../lib/canonical.mjs';
import {
  compileProposal,
  findingFingerprint,
  proposalApprovalIsCurrent,
} from '../lib/proposals.mjs';
import {
  appendMemoryEvent,
  projectBacklog,
} from '../lib/memory.mjs';
import {
  compilePublicationArtifacts,
} from '../lib/report.mjs';
import { verifyPublication } from '../lib/verifier.mjs';
import { ProposalSchema } from '../schemas/v1.mjs';
import { auditPaths } from '../lib/paths.mjs';

const H = 'a'.repeat(64);
const H2 = 'b'.repeat(64);
const E1 = 'ev_1111111111111111';
const E2 = 'ev_2222222222222222';
const O1 = 'obj_1111111111111111';
const O2 = 'obj_2222222222222222';
const ACTOR = 'actor_1111111111111111';

function deepFreeze(value) {
  for (const child of Object.values(value ?? {})) {
    if (child && typeof child === 'object' && !Object.isFrozen(child)) deepFreeze(child);
  }
  return Object.freeze(value);
}

function currentObjects() {
  return deepFreeze([
    {
      objectRef: O1,
      objectType: 'workflow',
      capturedVersion: 'v7',
      capturedHash: H,
      mergeFields: ['{{contact.first_name}}', '{{calendar.booking_link}}'],
      referencedObjectRefs: [O2],
      exits: ['reply', 'booked', 'opt_out'],
    },
    {
      objectRef: O2,
      objectType: 'calendar',
      capturedVersion: 'v2',
      capturedHash: H2,
      mergeFields: [],
      referencedObjectRefs: [],
      exits: [],
    },
  ]);
}

function commonChangeSet(solutionType) {
  const base = {
    solutionType,
    current: { state: 'captured' },
    proposed: { state: 'proposed' },
  };
  if (solutionType === 'workflow_logic') {
    return {
      ...base,
      workflowId: O1,
      capturedVersion: 'v7',
      capturedHash: H,
      currentGraph: { nodes: ['trigger', 'wait', 'exit'], edges: ['trigger>wait', 'wait>exit'] },
      proposedGraph: { nodes: ['trigger', 'wait', 'reply_exit'], edges: ['trigger>wait', 'wait>reply_exit'] },
      triggers: ['lead_created'],
      reentry: 'one_active_enrollment',
      branches: [{ condition: 'replied', destination: 'reply_exit', default: false }],
      defaultBranch: 'wait',
      exits: ['reply', 'booked', 'opt_out'],
      waits: [{ anchor: 'lead_created', duration: 5, unit: 'minute' }],
      errorBehavior: 'route_to_owner_queue',
      references: {
        fields: [],
        tags: [],
        calendars: [O2],
        assignments: [],
        agents: [],
      },
      existingEnrollmentHandling: 'leave_existing_enrollments_unchanged',
    };
  }
  if (solutionType === 'copy') {
    return {
      ...base,
      channel: 'sms',
      audience: 'new_lead',
      locale: 'en-AU',
      finalText: 'Hi {{contact.first_name}}, choose a time at {{calendar.booking_link}}.',
      mergeFields: ['{{calendar.booking_link}}', '{{contact.first_name}}'],
      fallbacks: {
        '{{calendar.booking_link}}': 'reply BOOK',
        '{{contact.first_name}}': 'there',
      },
      timing: 'five_minutes_after_entry',
      stopConditions: ['reply', 'booked', 'opt_out'],
      consentCompliance: 'send_only_to_recorded_sms_consent',
      ownership: 'fixed_copy',
    };
  }
  if (solutionType === 'wait_timing') {
    return {
      ...base,
      anchor: 'lead_created',
      duration: 5,
      unit: 'minute',
      timezone: 'Australia/Sydney',
      businessCalendar: O2,
      exits: {
        response: 'reply',
        booking: 'booked',
        optOut: 'opt_out',
        stage: 'qualified',
      },
      collisionRisk: 'low',
      burstSendRisk: 'bounded_by_business_hours',
    };
  }
  if (solutionType === 'conversation_ai' || solutionType === 'voice_ai') {
    return {
      ...base,
      agentId: O1,
      capturedVersion: 'v7',
      capturedHash: H,
      promptChanges: 'Ask one qualifying question, then offer the verified booking field.',
      configurationChanges: { responseMode: 'concise' },
      actionChanges: ['offer_booking_after_qualification'],
      knowledgeChanges: ['approved_service_summary'],
      routingChanges: ['handoff_when_requested'],
      handoffChanges: ['owner_queue'],
      allowedTools: ['calendar_availability_read'],
      agentGuardrails: ['do_not_claim_clinical_outcomes'],
      prohibitedBehavior: ['inventing_availability'],
      escalation: ['human_requested'],
      evaluationCases: [{ caseId: 'case-v1', version: '1', expected: 'handoff' }],
      canaryScope: 'ten_new_leads',
    };
  }
  return {
    ...base,
    processOwner: ACTOR,
    raci: { responsible: ACTOR, accountable: ACTOR },
    action: 'review_unanswered_leads',
    sla: 'within_15_minutes',
    trigger: 'owner_queue_entry',
    completionEvidence: ['stage_updated'],
    staffFields: ['assigned_user'],
    staffStages: ['contacted'],
    escalation: ['notify_accountable_owner'],
    training: ['queue_handling_runbook'],
    auditTrail: ['weekly_queue_review'],
    complianceMeasurement: ['sla_met_rate'],
  };
}

function proposalFinding(solutionType = 'workflow_logic', overrides = {}) {
  const proposedSolution = {
    solutionType,
    objectRefs: [{
      objectType: 'workflow',
      objectId: O1,
      capturedVersion: 'v7',
      capturedHash: H,
    }],
    prerequisites: ['sanitized_evidence_complete'],
    dependencies: [O2],
    blastRadius: 'new_entries_only',
    owner: ACTOR,
    acceptanceTests: ['reply_exit_stops_follow_up'],
    monitoring: ['reply_rate'],
    rollout: { scope: 'ten_new_leads' },
    rollback: { condition: 'reply_rate_declines' },
    guardrails: ['proposal_only'],
    expectedResult: {
      lower: 0,
      upper: 5,
      unit: 'additional_bookings_per_week',
      basis: 'BOUNDED',
    },
    changeSet: commonChangeSet(solutionType),
  };
  return deepFreeze({
    findingId: 'finding_1111111111111111',
    target: 'client',
    journeyId: 'lead_to_booking',
    mechanismClass: 'workflow_configuration_or_execution',
    affectedObjectRefs: [O1],
    title: 'Initial title',
    state: 'PROMOTED',
    critical: false,
    promotionEligible: true,
    mechanismConfidence: 'C2',
    evidenceEligible: true,
    evidenceRefs: [E1],
    evidenceCutoff: '2026-07-20T00:00:00Z',
    proposedSolution,
    ...overrides,
  });
}

function evidenceManifest() {
  return deepFreeze([
    {
      evidenceRef: E1,
      classification: 'OBSERVED',
      provenance: { source: 'public_ghl', completeness: 'COMPLETE' },
      sanitizedPayloadHash: H,
    },
    {
      evidenceRef: E2,
      classification: 'OBSERVED',
      provenance: { source: 'internal_ghl', completeness: 'COMPLETE' },
      sanitizedPayloadHash: H2,
    },
  ]);
}

function basePublication(overrides = {}) {
  const finding = {
    findingId: 'finding_1111111111111111',
    fingerprint: 'fingerprint_1111111111111111',
    title: 'Observed delivery defect',
    summary: 'A verified local delivery defect affected the captured workflow.',
    journeyId: 'lead_to_booking',
    severity: 'high',
    evidenceRefs: [E1],
    claims: [{
      claimId: 'claim_1111111111111111',
      text: 'The captured workflow has a verified local delivery defect.',
      evidenceRefs: [E1],
      causalBasis: 'DETERMINISTIC',
    }],
    verdicts: {
      configuration: 'FAIL',
      execution: 'WATCH',
      experience: 'UNKNOWN',
      outcome: 'WATCH',
    },
    coverageScope: 'account_wide',
    priorityInputs: { lane: 'COMMERCIAL', score: 7 },
    promotionEligible: false,
    mechanismConfidence: 'C1',
  };
  return {
    run: deepFreeze({
      schemaVersion: '1.0.0',
      runId: 'run-2026-W30',
      publicationId: 'pub-2026-W30',
      week: '2026-W30',
      target: { operatingProfile: 'client', locationId: 'L1' },
      status: 'complete_full',
      cutoff: '2026-07-20T00:00:00Z',
    }),
    systemOverview: deepFreeze({ summary: 'Lead capture enters a nurture workflow.' }),
    coverage: deepFreeze({
      state: 'complete_full',
      limitations: [],
      comparableSubsets: [],
    }),
    freshness: deepFreeze({ cutoff: '2026-07-20T00:00:00Z', staleCapabilities: [] }),
    diff: deepFreeze({ changes: [] }),
    graph: deepFreeze({ nodes: [], edges: [], conflicts: [], unresolvedJoins: [] }),
    metricContracts: deepFreeze({ profileId: 'client', version: '1.0.0', edges: [] }),
    windows: deepFreeze({
      cutoff: '2026-07-20T00:00:00Z',
      matureAsOf: '2026-07-13T00:00:00Z',
      currentClosedWeek: { start: '2026-07-06T00:00:00Z', end: '2026-07-13T00:00:00Z' },
      previousClosedWeek: { start: '2026-06-29T00:00:00Z', end: '2026-07-06T00:00:00Z' },
      trailing28Days: { start: '2026-06-15T00:00:00Z', end: '2026-07-13T00:00:00Z' },
    }),
    metrics: deepFreeze({
      metrics: {
        currentClosedWeek: {},
        previousClosedWeek: {},
        trailing28Days: {},
      },
      cohorts: {
        currentClosedWeek: {},
        previousClosedWeek: {},
        trailing28Days: {},
      },
      currentStock: {},
    }),
    sample: deepFreeze({
      schemaVersion: '1.0.0',
      seed: 'seed_1111111111111111',
      mode: 'CENSUS',
      universeCount: 0,
      requestedMaxSample: 50,
      actualSampleCount: 0,
      mandatoryCount: 0,
      mandatoryOverflowCount: 0,
      selections: [],
      populationPrevalence: 'CENSUS_ONLY',
      prevalenceScope: {
        kind: 'CENSUS',
        weightingRequiredForPopulationEstimate: false,
        uncertaintyRequiredForPopulationEstimate: false,
      },
      sampleHash: sha256({
        schemaVersion: '1.0.0',
        seed: 'seed_1111111111111111',
        mode: 'CENSUS',
        universeCount: 0,
        requestedMaxSample: 50,
        actualSampleCount: 0,
        mandatoryCount: 0,
        mandatoryOverflowCount: 0,
        selections: [],
        populationPrevalence: 'CENSUS_ONLY',
        prevalenceScope: {
          kind: 'CENSUS',
          weightingRequiredForPopulationEstimate: false,
          uncertaintyRequiredForPopulationEstimate: false,
        },
      }),
    }),
    findings: deepFreeze({ criticalIssues: [], promoted: [], backlog: [finding] }),
    conversationReview: deepFreeze({ availability: 'NOT_REVIEWABLE', judgments: [] }),
    evidenceManifest: evidenceManifest(),
    solutionPacks: deepFreeze([]),
    memoryProjection: deepFreeze({ json: { entries: [] }, markdown: '# Backlog\n' }),
    ...overrides,
  };
}

function writeStaging(compiled, mutate) {
  const root = mkdtempSync(join(tmpdir(), 'ghl-audit-verify-'));
  for (const [name, value] of Object.entries(compiled.payloadArtifacts)) {
    const path = join(root, name);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, typeof value === 'string' ? value : `${canonicalJson(value)}\n`);
  }
  const hashes = Object.fromEntries(Object.keys(compiled.payloadArtifacts).sort().map((name) => [
    name,
    createHash('sha256').update(readFileSync(join(root, name))).digest('hex'),
  ]));
  const manifest = {
    ...compiled.manifestInput,
    payloadArtifacts: Object.entries(hashes).map(([path, hash]) => ({ path, sha256: hash })),
    publicationRoot: sha256(hashes),
  };
  writeFileSync(join(root, 'run-manifest.json'), `${canonicalJson(manifest)}\n`);
  mutate?.({ root, manifest });
  return root;
}

function rehashStaging(root) {
  const manifestPath = join(root, 'run-manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const payloadArtifacts = manifest.payloadArtifacts.map(({ path }) => ({
    path,
    sha256: createHash('sha256').update(readFileSync(join(root, path))).digest('hex'),
  }));
  const hashes = Object.fromEntries(payloadArtifacts.map(({ path, sha256: hash }) => [path, hash]));
  const next = { ...manifest, payloadArtifacts, publicationRoot: sha256(hashes) };
  writeFileSync(manifestPath, `${canonicalJson(next)}\n`);
  return next;
}

test('healthy full publication has traceable claims and zero proposals', () => {
  const input = basePublication({
    findings: deepFreeze({ criticalIssues: [], promoted: [], backlog: [] }),
  });
  const compiled = compilePublicationArtifacts(input);
  assert.deepEqual(Object.keys(compiled.payloadArtifacts).filter((path) => path.startsWith('solution-packs/')), []);
  const report = compiled.payloadArtifacts['REPORT.md'];
  const headings = [
    'Run status, scope, cutoff, and material limitations',
    'System overview and current operation',
    'Critical issues',
    'Commercial movement',
    'What is working',
    'Commercial findings',
    'Conversation and Voice AI conclusions',
    'Configuration/execution/experience/outcome matrix',
    'Recommended action order',
    'Week-over-week finding movement',
    'Backlog changes and next evidence required',
  ];
  let position = -1;
  for (const heading of headings) {
    const next = report.indexOf(`## ${heading}`);
    assert.ok(next > position, heading);
    position = next;
  }
  const machine = compiled.payloadArtifacts['metrics-and-findings.json'];
  for (const claim of machine.claims) {
    assert.ok(machine.findings.some(({ findingId }) => findingId === claim.findingId));
    assert.ok(claim.evidenceRefs.every((ref) => input.evidenceManifest.some((item) => item.evidenceRef === ref)));
  }
});

test('grom acquisition and onboarding render independent scorecards', () => {
  const input = basePublication();
  input.run = deepFreeze({
    ...input.run,
    target: { operatingProfile: 'grom_internal', locationId: 'L1' },
  });
  input.metrics = deepFreeze({
    metrics: {
      currentClosedWeek: {
        acquisition_rate: { journeyInstanceId: 'journey_grom_acquisition_v1', denominator: 10, numerator: 4 },
        onboarding_rate: { journeyInstanceId: 'journey_grom_onboarding_v1', denominator: 3, numerator: 2 },
      },
    },
    cohorts: { currentClosedWeek: { journey_grom_acquisition_v1: 10, journey_grom_onboarding_v1: 3 } },
    currentStock: {},
  });
  const report = compilePublicationArtifacts(input).payloadArtifacts['REPORT.md'];
  assert.match(report, /Acquisition scorecard[\s\S]*Denominator: 10/u);
  assert.match(report, /Onboarding scorecard[\s\S]*Denominator: 3/u);
  assert.doesNotMatch(report, /Combined funnel/u);
});

test('partial publication stays inside a complete comparable subset', () => {
  const input = basePublication();
  input.run = deepFreeze({ ...input.run, status: 'complete_partial' });
  input.coverage = deepFreeze({
    state: 'complete_partial',
    limitations: ['workflow_logs_missing'],
    comparableSubsets: [{ subsetId: 'subset_1', journeyInstanceIds: ['journey_client_lead_v1'], metricIds: ['reply_rate'] }],
  });
  input.findings = deepFreeze({
    criticalIssues: [],
    promoted: [],
    backlog: [{
      ...input.findings.backlog[0],
      coverageScope: 'comparable_subset',
      summary: 'A verified local defect exists inside subset_1.',
    }],
  });
  const report = compilePublicationArtifacts(input).payloadArtifacts['REPORT.md'];
  assert.match(report, /complete comparable subset/u);
  assert.doesNotMatch(report, /account-wide top leak|total account impact|all systems passed/iu);
});

test('finding identity ignores title changes and missing evidence is not reassessed', () => {
  const first = proposalFinding('workflow_logic');
  const renamed = deepFreeze({ ...first, title: 'Renamed finding' });
  assert.equal(findingFingerprint(first), findingFingerprint(renamed));
  const projected = projectBacklog({
    events: deepFreeze([
      {
        eventId: 'event_1',
        type: 'finding_observed',
        occurredAt: '2026-07-10T00:00:00Z',
        findingId: first.findingId,
        findingFingerprint: findingFingerprint(first),
        evidenceRefs: [E1],
        proposalHash: null,
      },
      {
        eventId: 'event_2',
        type: 'finding_transition',
        occurredAt: '2026-07-17T00:00:00Z',
        findingId: first.findingId,
        findingFingerprint: findingFingerprint(first),
        transition: 'NOT_REASSESSED',
        evidenceRefs: [],
        reasonCode: 'CURRENT_EVIDENCE_MISSING',
      },
    ]),
  });
  assert.equal(projected.json.entries[0].status, 'NOT_REASSESSED');
  assert.notEqual(projected.json.entries[0].status, 'RESOLVED');
});

test('proposal schema renders every exact solution type', () => {
  for (const type of ['workflow_logic', 'copy', 'wait_timing', 'conversation_ai', 'voice_ai', 'operating_process']) {
    const compiled = compileProposal({
      finding: proposalFinding(type),
      currentObjects: currentObjects(),
      evidenceCutoff: '2026-07-20T00:00:00Z',
    });
    assert.equal(ProposalSchema.safeParse(compiled.proposal).success, true, type);
    assert.deepEqual(Object.keys(compiled.payloadArtifacts).sort(), [
      `solution-packs/${compiled.proposal.solutionId}/README.md`,
      `solution-packs/${compiled.proposal.solutionId}/acceptance-tests.md`,
      `solution-packs/${compiled.proposal.solutionId}/proposal.json`,
    ].sort());
    assert.match(compiled.readme, new RegExp(type, 'u'));
    assert.match(compiled.acceptanceTests, /reply_exit_stops_follow_up/u);
  }
});

test('proposal compiler fails closed on unresolved or stale dependencies', () => {
  const cases = [
    ['PROPOSAL_UNRESOLVED_REFERENCE_MERGE_FIELD', proposalFinding('copy', {
      proposedSolution: {
        ...proposalFinding('copy').proposedSolution,
        changeSet: {
          ...commonChangeSet('copy'),
          mergeFields: ['{{unknown.field}}'],
          fallbacks: { '{{unknown.field}}': 'fallback' },
        },
      },
    }), currentObjects()],
    ['PROPOSAL_UNRESOLVED_REFERENCE_FALLBACK', proposalFinding('copy', {
      proposedSolution: {
        ...proposalFinding('copy').proposedSolution,
        changeSet: { ...commonChangeSet('copy'), fallbacks: {} },
      },
    }), currentObjects()],
    ['PROPOSAL_STALE_OBJECT_HASH', proposalFinding(), [{
      ...currentObjects()[0],
      capturedHash: H2,
    }, currentObjects()[1]]],
    ['PROPOSAL_UNRESOLVED_REFERENCE_DEPENDENCY', proposalFinding(), [currentObjects()[0]]],
  ];
  for (const [code, finding, objects] of cases) {
    assert.throws(
      () => compileProposal({ finding, currentObjects: deepFreeze(objects), evidenceCutoff: '2026-07-20T00:00:00Z' }),
      (error) => error.code === code,
      code,
    );
  }
});

test('proposal artifacts are recursively non executable', () => {
  const mutations = [
    ['url', 'https://example.invalid'],
    ['method', 'POST'],
    ['tool', 'raw_request'],
    ['credential', 'credential_value'],
    ['header', 'Authorization'],
    ['cookie', 'session_cookie'],
    ['confirm', true],
    ['requestBody', { mutate: true }],
    ['shell', 'curl example.invalid'],
    ['mcp', 'tools/call'],
    ['envelope', { action: 'execute' }],
  ];
  for (const [key, value] of mutations) {
    const finding = proposalFinding();
    const unsafe = deepFreeze({
      ...finding,
      proposedSolution: {
        ...finding.proposedSolution,
        rollout: { ...finding.proposedSolution.rollout, [key]: value },
      },
    });
    assert.throws(
      () => compileProposal({ finding: unsafe, currentObjects: currentObjects(), evidenceCutoff: '2026-07-20T00:00:00Z' }),
      (error) => error.code?.startsWith('PROPOSAL_EXECUTION_MATERIAL_FORBIDDEN'),
      key,
    );
  }
});

test('proposal hash changes invalidate approval and receipts never change proposal', () => {
  const first = compileProposal({ finding: proposalFinding('copy'), currentObjects: currentObjects(), evidenceCutoff: '2026-07-20T00:00:00Z' });
  const original = proposalFinding('copy');
  const changedFinding = deepFreeze({
    ...original,
    proposedSolution: {
      ...original.proposedSolution,
      changeSet: {
        ...original.proposedSolution.changeSet,
        finalText: `${original.proposedSolution.changeSet.finalText}!`,
      },
    },
  });
  const changed = compileProposal({ finding: changedFinding, currentObjects: currentObjects(), evidenceCutoff: '2026-07-20T00:00:00Z' });
  const proposalBytes = canonicalJson(first.proposal);
  const receipt = deepFreeze({
    type: 'approval_receipt',
    proposalHash: first.proposalHash,
    solutionId: first.proposal.solutionId,
  });
  assert.notEqual(first.proposalHash, changed.proposalHash);
  assert.equal(proposalApprovalIsCurrent({ proposal: changed.proposal, receipt }), false);
  assert.equal(canonicalJson(first.proposal), proposalBytes);
});

test('implementation receipt remains an assertion until a live reread', () => {
  const events = [
    {
      eventId: 'event_1',
      type: 'finding_observed',
      occurredAt: '2026-07-10T00:00:00Z',
      findingId: 'finding_1',
      findingFingerprint: 'fingerprint_1',
      evidenceRefs: [E1],
      proposalHash: H,
    },
    {
      eventId: 'event_2',
      type: 'implementation_receipt',
      occurredAt: '2026-07-11T00:00:00Z',
      findingId: 'finding_1',
      solutionId: 'solution_1',
      proposalHash: H,
      deviations: [],
    },
  ];
  assert.equal(projectBacklog({ events: deepFreeze(events) }).json.entries[0].status, 'IMPLEMENTED_UNVERIFIED');
  const verified = [...events, {
    eventId: 'event_3',
    type: 'verification_result',
    occurredAt: '2026-07-12T00:00:00Z',
    findingId: 'finding_1',
    solutionId: 'solution_1',
    proposalHash: H,
    liveReread: true,
    result: 'PASS',
    evidenceRefs: [E2],
  }];
  assert.equal(projectBacklog({ events: deepFreeze(verified) }).json.entries[0].status, 'VERIFIED');
  const partial = deepFreeze([
    events[0],
    events[1],
    { ...verified[2], result: 'PARTIAL', deviations: ['different_wait'] },
  ]);
  assert.equal(projectBacklog({ events: partial }).json.entries[0].status, 'IMPLEMENTED_UNVERIFIED');
});

test('memory events are immutable idempotent and projections reconstruct', () => {
  const project = mkdtempSync(join(tmpdir(), 'ghl-audit-memory-'));
  const paths = auditPaths(project, 'L1');
  const event = deepFreeze({
    eventId: 'event_1',
    type: 'finding_observed',
    occurredAt: '2026-07-10T00:00:00Z',
    findingId: 'finding_1',
    findingFingerprint: 'fingerprint_1',
    evidenceRefs: [E1],
    proposalHash: null,
  });
  try {
    const first = appendMemoryEvent({ paths, event });
    const replay = appendMemoryEvent({ paths, event });
    assert.equal(first.path, replay.path);
    assert.equal(replay.recovered, true);
    assert.equal(statSync(first.path).mode & 0o222, 0);
    assert.throws(
      () => appendMemoryEvent({ paths, event: deepFreeze({ ...event, evidenceRefs: [E2] }) }),
      (error) => error.code === 'MEMORY_EVENT_CONFLICT',
    );
    const a = projectBacklog({ events: deepFreeze([event, {
      ...event,
      eventId: 'event_2',
      type: 'finding_transition',
      occurredAt: '2026-07-11T00:00:00Z',
      transition: 'WATCH',
      reasonCode: 'MONITOR',
    }]) });
    const b = projectBacklog({ events: deepFreeze([...[
      {
        ...event,
        eventId: 'event_2',
        type: 'finding_transition',
        occurredAt: '2026-07-11T00:00:00Z',
        transition: 'WATCH',
        reasonCode: 'MONITOR',
      },
      event,
    ]]) });
    assert.equal(canonicalJson(a.json), canonicalJson(b.json));
    assert.equal(a.markdown, b.markdown);
    const withLegacyExpiry = projectBacklog({
      events: deepFreeze([
        event,
        {
          schemaVersion: '1.0.0',
          format: 'ghl-audit-vault',
          algorithm: 'aes-256-gcm',
          eventId: 'evt_1111111111111111',
          type: 'raw_evidence_expired',
          operationId: 'purge_1111111111111111',
          phase: 'completed',
          pendingEventId: 'evt_2222222222222222',
          opaqueRef: 'opaque_1111111111111111',
          rawHash: H,
          source: 'public_ghl',
          expiresAt: '2026-07-09T00:00:00.000Z',
          expiredAt: '2026-07-12T00:00:00.000Z',
          deletionState: 'deleted',
          purgeResult: 'deleted',
        },
      ]),
    });
    assert.equal(withLegacyExpiry.json.entries.length, 1);
    assert.equal(withLegacyExpiry.json.eventCount, 2);
    assert.equal(readdirSync(paths.memoryEvents).some((name) => name.endsWith('.tmp')), false);
  } finally {
    if (existsSync(project)) {
      const writable = (path) => {
        chmodSync(path, 0o700);
        for (const name of readdirSync(path)) {
          const child = join(path, name);
          if (statSync(child).isDirectory()) writable(child);
          else chmodSync(child, 0o600);
        }
      };
      writable(project);
      rmSync(project, { recursive: true, force: true });
    }
  }
});

test('verifier independently recomputes all deterministic publication values', () => {
  const compiled = compilePublicationArtifacts(basePublication());
  const clean = writeStaging(compiled);
  try {
    assert.equal(verifyPublication({ publicationDir: clean }).result, 'pass');
  } finally {
    rmSync(clean, { recursive: true, force: true });
  }
  for (const field of [
    'coverageClass',
    'sampleHash',
    'priorityOrder',
    'overlapDedupe',
    'proposalEligibility',
  ]) {
    const staging = writeStaging(compiled, ({ root, manifest }) => {
      const path = join(root, 'metrics-and-findings.json');
      const value = JSON.parse(readFileSync(path, 'utf8'));
      value.verification[field] = field === 'priorityOrder' ? ['tampered'] : 'tampered';
      writeFileSync(path, `${canonicalJson(value)}\n`);
      writeFileSync(join(root, 'run-manifest.json'), `${canonicalJson(manifest)}\n`);
      rehashStaging(root);
    });
    try {
      assert.throws(
        () => verifyPublication({ publicationDir: staging }),
        (error) => error.code?.startsWith('VERIFIER_'),
        field,
      );
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  }
  const metricTamper = writeStaging(compiled, ({ root }) => {
    const path = join(root, 'metrics-and-findings.json');
    const value = JSON.parse(readFileSync(path, 'utf8'));
    value.metrics.metrics.currentClosedWeek.fake_kpi = {
      state: 'OBSERVED',
      numerator: 1,
      denominator: 1,
      rate: 1,
    };
    value.metrics.cohorts.currentClosedWeek.fake_journey = 1;
    value.verification.metricHash = sha256(value.metrics);
    value.verification.cohortHash = sha256(value.metrics.cohorts);
    writeFileSync(path, `${canonicalJson(value)}\n`);
    rehashStaging(root);
  });
  try {
    assert.throws(
      () => verifyPublication({ publicationDir: metricTamper }),
      (error) => error.code === 'VERIFIER_DETERMINISTIC_MISMATCH_METRICS',
    );
  } finally {
    rmSync(metricTamper, { recursive: true, force: true });
  }
  const impactTamper = writeStaging(compiled, ({ root }) => {
    const path = join(root, 'metrics-and-findings.json');
    const value = JSON.parse(readFileSync(path, 'utf8'));
    value.findings[0].impactRange = { kind: 'BOUNDED', lower: 1, upper: 2 };
    value.findings[0].priorityInputs.commercialValue = { kind: 'BOUNDED', lower: 4, upper: 5 };
    value.findings[0].priorityInputs.promotionEligibility = 'ELIGIBLE';
    value.verification.priorityOrder = [value.findings[0].findingId];
    writeFileSync(path, `${canonicalJson(value)}\n`);
    rehashStaging(root);
  });
  try {
    assert.throws(
      () => verifyPublication({ publicationDir: impactTamper }),
      (error) => [
        'VERIFIER_DETERMINISTIC_MISMATCH_FINDING_ELIGIBILITY',
        'VERIFIER_DETERMINISTIC_MISMATCH_IMPACT_RANGE',
      ].includes(error.code),
    );
  } finally {
    rmSync(impactTamper, { recursive: true, force: true });
  }
  const manifestTamper = writeStaging(compiled, ({ root, manifest }) => {
    writeFileSync(join(root, 'run-manifest.json'), `${canonicalJson({
      ...manifest,
      runId: 'tampered-run',
    })}\n`);
  });
  try {
    assert.throws(
      () => verifyPublication({ publicationDir: manifestTamper }),
      (error) => error.code === 'VERIFIER_DETERMINISTIC_MISMATCH_MANIFEST',
    );
  } finally {
    rmSync(manifestTamper, { recursive: true, force: true });
  }
  const rootTamper = writeStaging(compiled, ({ root, manifest }) => {
    writeFileSync(join(root, 'run-manifest.json'), `${canonicalJson({
      ...manifest,
      publicationRoot: H2,
    })}\n`);
  });
  try {
    assert.throws(
      () => verifyPublication({ publicationDir: rootTamper }),
      (error) => error.code === 'VERIFIER_DETERMINISTIC_MISMATCH_ROOT',
    );
  } finally {
    rmSync(rootTamper, { recursive: true, force: true });
  }
  const proposalPack = compileProposal({
    finding: proposalFinding('workflow_logic'),
    currentObjects: currentObjects(),
    evidenceCutoff: '2026-07-20T00:00:00Z',
  });
  const promotedFinding = deepFreeze({
    findingId: proposalPack.proposal.findingId,
    fingerprint: proposalPack.proposal.findingFingerprint,
    title: 'Promoted workflow defect',
    summary: 'Exact runtime evidence supports the promoted workflow defect.',
    journeyId: 'lead_to_booking',
    severity: 'high',
    evidenceRefs: [E1],
    claims: [{
      claimId: 'claim_promoted',
      text: 'Exact runtime evidence supports the promoted workflow defect.',
      evidenceRefs: [E1],
      causalBasis: 'DETERMINISTIC',
    }],
    verdicts: {
      configuration: 'FAIL',
      execution: 'FAIL',
      experience: 'WATCH',
      outcome: 'WATCH',
    },
    coverageScope: 'account_wide',
    priorityInputs: {
      lane: 'COMMERCIAL',
      promotionEligibility: 'ELIGIBLE',
      coverageScope: 'account_wide',
    },
    promotionEligible: true,
    mechanismConfidence: 'C2',
    critical: false,
  });
  const proposalPublication = compilePublicationArtifacts(basePublication({
    findings: deepFreeze({
      criticalIssues: [],
      promoted: [promotedFinding],
      backlog: [],
    }),
    solutionPacks: deepFreeze([proposalPack]),
  }));
  const proposalStaging = writeStaging(proposalPublication);
  try {
    assert.equal(verifyPublication({ publicationDir: proposalStaging }).result, 'pass');
  } finally {
    rmSync(proposalStaging, { recursive: true, force: true });
  }
  const proposalHashTamper = writeStaging(proposalPublication, ({ root }) => {
    const path = join(root, 'metrics-and-findings.json');
    const value = JSON.parse(readFileSync(path, 'utf8'));
    value.verification.proposalEligibility[0].proposalHash = H2;
    writeFileSync(path, `${canonicalJson(value)}\n`);
    rehashStaging(root);
  });
  try {
    assert.throws(
      () => verifyPublication({ publicationDir: proposalHashTamper }),
      (error) => error.code === 'VERIFIER_DETERMINISTIC_MISMATCH_RECOMPUTE',
    );
  } finally {
    rmSync(proposalHashTamper, { recursive: true, force: true });
  }
});

test('verifier cannot fetch repair mutate or expose private evidence', () => {
  const source = readFileSync(new URL('../lib/verifier.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /adapter|@modelcontextprotocol|transport|vault|repair|fetch\s*\(/iu);
  const compiled = compilePublicationArtifacts(basePublication());
  for (const canary of ['private.person@example.invalid', 'raw_1111111111111111', 'POST /mutation']) {
    const staging = writeStaging(compiled, ({ root }) => {
      writeFileSync(join(root, 'REPORT.md'), `# ${canary}\n`);
    });
    try {
      assert.throws(
        () => verifyPublication({ publicationDir: staging }),
        (error) => ['VERIFIER_PRIVACY_FAILURE_CANARY', 'VERIFIER_DETERMINISTIC_MISMATCH_PAYLOAD_HASH'].includes(error.code),
      );
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  }
});

test('every report claim and solution field has eligible provenance', () => {
  const input = basePublication();
  input.findings = deepFreeze({
    ...input.findings,
    backlog: [{
      ...input.findings.backlog[0],
      evidenceRefs: ['ev_9999999999999999'],
      claims: [{
        claimId: 'claim_bad',
        text: 'This will guarantee $100000 in revenue.',
        evidenceRefs: ['ev_9999999999999999'],
        causalBasis: 'SUBJECTIVE_ONLY',
      }],
    }],
  });
  assert.throws(
    () => compilePublicationArtifacts(input),
    (error) => ['REPORT_CLAIM_UNRESOLVED_EVIDENCE', 'REPORT_CLAIM_UNRESOLVED_CAUSAL'].includes(error.code),
  );
});
