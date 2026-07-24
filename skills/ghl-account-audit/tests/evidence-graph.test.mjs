import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { sha256 } from '../lib/canonical.mjs';
import { buildEvidenceGraph } from '../lib/evidence-graph.mjs';
import { normalizeEvidence } from '../lib/normalize.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const profileById = {
  client: JSON.parse(readFileSync(join(here, '../profiles/client.v1.json'), 'utf8')),
  grom_internal: JSON.parse(readFileSync(join(here, '../profiles/grom-internal.v1.json'), 'utf8')),
};

function fixture(name) {
  return JSON.parse(readFileSync(join(here, 'fixtures/weekly', name, 'input.json'), 'utf8'));
}

function build(name, transform = (value) => value) {
  const value = transform(fixture(name));
  const records = normalizeEvidence(value.collections, value.context);
  return {
    records,
    graph: buildEvidenceGraph({
      records,
      context: value.context,
      profile: profileById[value.profileId],
    }),
  };
}

test('normalization preserves complete and incomplete provenance and rejects mixed locations', () => {
  const complete = fixture('grom-dual-journey-portal-complete');
  const records = normalizeEvidence(complete.collections, complete.context);
  const portal = records.find(({ source }) => source === 'onboarding_portal');
  assert.deepEqual(portal.provenance, {
    source: 'onboarding_portal',
    operationId: 'portal-weekly',
    boundLocationId: 'GROM',
    requestedWindow: complete.collections[1].requestedWindow,
    appliedWindow: complete.collections[1].appliedWindow,
    capturedAt: '2026-07-20T01:05:00.000Z',
    completeness: 'COMPLETE',
    incompleteReason: null,
  });

  const unavailable = fixture('grom-portal-unavailable');
  const unknown = normalizeEvidence(unavailable.collections, unavailable.context);
  assert.equal(unknown.length, 1);
  assert.equal(unknown[0].classification, 'UNKNOWN');
  assert.equal(unknown[0].provenance.completeness, 'INCOMPLETE');
  assert.equal(unknown[0].provenance.incompleteReason, 'PORTAL_UNAVAILABLE');

  const wrong = structuredClone(complete);
  wrong.collections[1].boundLocationId = 'OTHER';
  assert.throws(
    () => normalizeEvidence(wrong.collections, wrong.context),
    /EVIDENCE_LOCATION_MISMATCH/,
  );
});

test('normalization preserves source UNKNOWN and never opens private envelope or checkpoint payloads', () => {
  const value = fixture('grom-dual-journey-portal-complete');
  value.collections[0].items[0].classification = 'UNKNOWN';
  Object.defineProperty(value.collections[0], 'privateSourceEnvelope', {
    enumerable: true,
    get() {
      throw new Error('private source envelope was opened');
    },
  });
  Object.defineProperty(value.collections[0], 'rawCheckpointPayload', {
    enumerable: true,
    get() {
      throw new Error('raw checkpoint payload was opened');
    },
  });
  const records = normalizeEvidence(value.collections, value.context);
  const contact = records.find(({ evidenceRef }) => evidenceRef === 'ev_4444444444444444');
  assert.equal(contact.classification, 'UNKNOWN');
  const graph = buildEvidenceGraph({
    records,
    context: value.context,
    profile: profileById.grom_internal,
  });
  assert.equal(graph.edges.some(({ evidenceRefs }) => (
    evidenceRefs.includes('ev_4444444444444444')
  )), false);
  assert.ok(graph.unresolvedJoins.some(({ reason, evidenceRefs }) => (
    reason === 'SOURCE_CLASSIFICATION_UNKNOWN'
      && evidenceRefs.includes('ev_4444444444444444')
  )));
});

test('normalization rejects journey records without canonical event identity and time', () => {
  const missingTime = fixture('grom-dual-journey-portal-complete');
  delete missingTime.collections[0].items
    .find(({ recordType }) => recordType === 'journey_event').eventTime;
  assert.throws(
    () => normalizeEvidence(missingTime.collections, missingTime.context),
    /EVIDENCE_RECORD_INVALID/,
  );

  const wrongInstance = fixture('grom-dual-journey-portal-complete');
  delete wrongInstance.collections[0].items
    .find(({ recordType }) => recordType === 'journey_event').journeyInstanceId;
  assert.throws(
    () => normalizeEvidence(wrongInstance.collections, wrongInstance.context),
    /EVIDENCE_RECORD_INVALID/,
  );
});

test('native IDs outrank execution metadata and deterministic composites outrank fuzzy links', () => {
  const { graph } = build('grom-dual-journey-portal-complete', (value) => {
    const contact = value.collections[0].items.find(({ recordType }) => recordType === 'contact');
    const execution = value.collections[0].items
      .find(({ recordType }) => recordType === 'workflow_execution');
    contact.normalizedEmail = 'native-wins@example.test';
    execution.normalizedEmail = contact.normalizedEmail;
    execution.organizationNativeId = 'wrong-org';
    execution.opportunityNativeId = 'wrong-opp';
    return value;
  });
  const exact = graph.edges.filter(({ type }) => type === 'identity_exact');
  assert.ok(exact.some(({ joinMethod }) => joinMethod === 'native_id'));
  assert.ok(exact.some(({ joinMethod }) => joinMethod === 'deterministic_composite'));
  assert.equal(exact.some(({ joinMethod }) => joinMethod === 'execution_metadata'), false);
  assert.equal(graph.edges.some(({ type }) => type === 'inferred_match'), false);
  const executionEdge = exact.find(({ evidenceRefs }) => (
    evidenceRefs.includes('ev_aaaaaaaaaaaaaaaa')
      && evidenceRefs.includes('ev_4444444444444444')
  ));
  assert.equal(executionEdge.joinMethod, 'native_id');

  const portalEdge = exact.find(({ evidenceRefs }) => evidenceRefs.includes('ev_bbbbbbbbbbbbbbbb'));
  assert.equal(portalEdge.joinMethod, 'deterministic_composite');
  assert.equal(portalEdge.joinConfidence, 'exact');
});

test('duplicate and ambiguous identities stay conflicts and fuzzy candidates never prove progression', () => {
  const { graph } = build('client-duplicate-ambiguous-identity');
  const inferred = graph.edges.filter(({ type }) => type === 'inferred_match');
  assert.equal(inferred.length, 2);
  assert.ok(inferred.every(({ joinMethod, joinConfidence }) => (
    joinMethod === 'fuzzy_candidate' && joinConfidence === 'candidate'
  )));
  assert.ok(graph.unresolvedJoins.some(({ reason }) => reason === 'AMBIGUOUS_IDENTITY'));
  assert.ok(graph.conflicts.some(({ type }) => type === 'duplicate_identity_claim'));
  assert.equal(graph.edges.some(({ type }) => type === 'preceded'), false);
});

test('Grom acquisition and onboarding remain separate with an explicit evidence-backed handoff', () => {
  const { graph } = build('grom-dual-journey-portal-complete');
  const journeyNodes = graph.nodes.filter(({ type }) => type === 'journey_instance');
  assert.deepEqual(
    journeyNodes.map(({ journeyId }) => journeyId).sort(),
    ['agency_new_business', 'client_onboarding'],
  );
  assert.notEqual(journeyNodes[0].nodeId, journeyNodes[1].nodeId);
  assert.ok(graph.edges.some(({ type, joinMethod, evidenceRefs }) => (
    type === 'preceded'
      && joinMethod === 'explicit_handoff'
      && evidenceRefs.includes('ev_7777777777777777')
  )));

  assert.throws(
    () => build('grom-dual-journey-portal-complete', (value) => {
      value.collections[0].items = value.collections[0].items
        .filter(({ recordType }) => recordType !== 'handoff');
      value.collections[0].page.reportedCount -= 1;
      value.collections[0].page.collectedCount -= 1;
      return value;
    }),
    /JOURNEY_HANDOFF_REQUIRED/,
  );
});

test('portal unavailable is conditional UNKNOWN only and ambiguous portal links are candidates', () => {
  const unavailable = build('grom-portal-unavailable').graph;
  assert.equal(unavailable.edges.length, 0);
  assert.ok(unavailable.unresolvedJoins.some(({ reason, classification, source }) => (
    reason === 'PORTAL_UNAVAILABLE'
      && classification === 'UNKNOWN'
      && source === 'onboarding_portal'
  )));
  assert.ok(unavailable.unresolvedJoins.every(({ journeyId, journeyInstanceId }) => (
    journeyId === 'client_onboarding'
      && journeyInstanceId === 'journey_client_onboarding'
  )));
  assert.equal(unavailable.conflicts.length, 0);

  const ambiguous = build('grom-portal-ambiguous-link').graph;
  assert.ok(ambiguous.edges.some(({ type, joinMethod }) => (
    type === 'inferred_match' && joinMethod === 'fuzzy_candidate'
  )));
  assert.equal(ambiguous.edges.some(({ type }) => type === 'preceded'), false);
  assert.ok(ambiguous.unresolvedJoins.some(({ reason }) => reason === 'FUZZY_ONLY'));
});

test('ambiguous composite identity remains unresolved and cannot prove progression', () => {
  const { graph } = build('grom-dual-journey-portal-complete', (value) => {
    const onboarding = value.collections[0].items
      .find(({ nativeId }) => nativeId === 'event-onboarding');
    delete onboarding.subjectNativeId;
    value.collections[1].items.push({
      recordType: 'portal_milestone',
      nativeId: 'portal-event-conflict',
      subjectNativeId: 'contact-other',
      organizationNativeId: 'org-1',
      opportunityNativeId: 'opp-1',
      milestone: 'strategy_approved',
      journeyId: 'client_onboarding',
      journeyInstanceId: 'journey_client_onboarding',
      eventTime: '2026-07-16T02:00:00.000Z',
      evidenceRef: 'ev_eeeeeeeeeeeeeeee',
    });
    value.collections[1].page.reportedCount += 1;
    value.collections[1].page.collectedCount += 1;
    return value;
  });
  assert.ok(graph.conflicts.some(({ type }) => type === 'ambiguous_composite_identity'));
  assert.ok(graph.unresolvedJoins.some(({ reason }) => reason === 'AMBIGUOUS_COMPOSITE_IDENTITY'));
  assert.equal(graph.edges.some(({ type, joinMethod }) => (
    type === 'preceded' && joinMethod === 'deterministic_composite'
  )), false);
});

test('historical workflow binding requires the effective definition hash', () => {
  const bound = build('grom-dual-journey-portal-complete').graph;
  const emitted = bound.edges.find(({ type }) => type === 'execution_emitted');
  assert.equal(
    emitted.workflowDefinitionHash,
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  );

  const unknown = build('grom-dual-journey-portal-complete', (value) => {
    const execution = value.collections[0].items
      .find(({ recordType }) => recordType === 'workflow_execution');
    delete execution.effectiveDefinitionHash;
    return value;
  }).graph;
  assert.equal(unknown.edges.some(({ type }) => type === 'execution_emitted'), false);
  assert.ok(unknown.unresolvedJoins.some(({ reason, workflowDefinitionHash }) => (
    reason === 'WORKFLOW_DEFINITION_HASH_UNKNOWN' && workflowDefinitionHash === null
  )));
});

test('partial or incomplete records cannot prove progression and all graph output is deterministic', () => {
  const value = fixture('grom-dual-journey-portal-complete');
  value.collections[0].page.complete = false;
  value.collections[0].incompleteReason = 'PARTIAL_RUNTIME';
  const records = normalizeEvidence(value.collections, value.context);
  const graph = buildEvidenceGraph({
    records,
    context: value.context,
    profile: profileById[value.profileId],
  });
  assert.equal(graph.edges.some(({ type }) => (
    ['preceded', 'enrolled_in', 'execution_emitted', 'attributed_by_source'].includes(type)
  )), false);
  assert.ok(graph.unresolvedJoins.some(({ reason }) => reason === 'INCOMPLETE_EVIDENCE'));

  const first = build('grom-dual-journey-portal-complete');
  const reversedRecords = [...first.records].reverse();
  const reversed = buildEvidenceGraph({
    records: reversedRecords,
    context: { locationId: 'GROM' },
    profile: profileById.grom_internal,
  });
  assert.equal(sha256(first.graph), sha256(reversed));
  assert.equal(
    sha256(first.graph),
    '76f1e4de438e3a9df54bfac2c5b1d31ebe77ed1402b38618f2b2b4eebfaf5369',
  );
  assert.ok(first.graph.edges.every((edge) => (
    Object.keys(edge).sort().join(',') === [
      'capturedAt',
      'edgeId',
      'eventTime',
      'evidenceRefs',
      'fromNodeId',
      'joinConfidence',
      'joinMethod',
      'toNodeId',
      'type',
      'workflowDefinitionHash',
    ].sort().join(',')
      && first.graph.nodes.some(({ nodeId }) => nodeId === edge.fromNodeId)
      && first.graph.nodes.some(({ nodeId }) => nodeId === edge.toNodeId)
  )));
});
