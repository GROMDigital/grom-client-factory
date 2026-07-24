import { canonicalJson, sha256 } from './canonical.mjs';

const EDGE_TYPES = new Set([
  'identity_exact',
  'configured_to_trigger',
  'enrolled_in',
  'execution_emitted',
  'preceded',
  'attributed_by_source',
  'intended_by',
  'contradicts',
  'inferred_match',
]);

function codedError(code, ErrorType = Error) {
  return Object.assign(new ErrorType(code), { code });
}

function stableId(prefix, value) {
  return `${prefix}_${sha256(value).slice(0, 32)}`;
}

function deepFreeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const nested of Object.values(value)) deepFreeze(nested, seen);
  return Object.freeze(value);
}

function evidenceRefs(...records) {
  return [...new Set(records.flatMap((record) => (
    typeof record?.evidenceRef === 'string' ? [record.evidenceRef] : []
  )))].sort();
}

function makeEdge({
  type,
  fromNodeId,
  toNodeId,
  eventTime = null,
  capturedAt,
  refs,
  joinMethod,
  joinConfidence,
  workflowDefinitionHash = null,
}) {
  if (!EDGE_TYPES.has(type)) throw codedError('EVIDENCE_EDGE_TYPE_INVALID');
  const body = {
    type,
    fromNodeId,
    toNodeId,
    eventTime,
    capturedAt,
    evidenceRefs: [...refs].sort(),
    joinMethod,
    joinConfidence,
    workflowDefinitionHash,
  };
  return { edgeId: stableId('edge', body), ...body };
}

function compositeKey(record) {
  if (record.organizationNativeId && record.opportunityNativeId) {
    return `organization:${record.organizationNativeId}|opportunity:${record.opportunityNativeId}`;
  }
  if (record.organizationNativeId && record.projectNativeId) {
    return `organization:${record.organizationNativeId}|project:${record.projectNativeId}`;
  }
  return null;
}

function fuzzyKey(record) {
  if (typeof record.normalizedEmail === 'string' && record.normalizedEmail.length > 0) {
    return `email:${record.normalizedEmail.trim().toLowerCase()}`;
  }
  if (typeof record.normalizedPhone === 'string' && record.normalizedPhone.length > 0) {
    return `phone:${record.normalizedPhone.replace(/\D/gu, '')}`;
  }
  return null;
}

function recordNode(record) {
  const node = {
    nodeId: `node_${record.recordId}`,
    type: record.recordType,
    source: record.provenance.source,
    classification: record.classification,
    journeyId: record.journeyId ?? null,
    journeyInstanceId: record.journeyInstanceId ?? null,
    eventTime: record.eventTime ?? null,
    capturedAt: record.provenance.capturedAt,
    provenance: record.provenance,
    evidenceRefs: evidenceRefs(record),
  };
  for (const field of [
    'nativeId',
    'subjectNativeId',
    'organizationNativeId',
    'opportunityNativeId',
    'projectNativeId',
    'workflowNativeId',
    'stage',
    'milestone',
    'definitionHash',
    'effectiveDefinitionHash',
  ]) {
    if (typeof record[field] === 'string') node[field] = record[field];
  }
  return node;
}

function addUnresolved(collection, value) {
  collection.push({
    unresolvedId: stableId('unresolved', value),
    ...value,
  });
}

function assertGraphInput(records, context, profile) {
  if (
    !Array.isArray(records)
    || !context
    || typeof context.locationId !== 'string'
    || !profile
    || !Array.isArray(profile.journeys)
  ) throw codedError('EVIDENCE_GRAPH_INPUT_INVALID', TypeError);
  for (const record of records) {
    if (
      record?.provenance?.boundLocationId !== context.locationId
      || !record.recordId
      || !record.evidenceRef
    ) throw codedError('EVIDENCE_LOCATION_MISMATCH');
  }
}

function sortGraphPart(values, id) {
  return values.sort((left, right) => (
    left[id].localeCompare(right[id])
      || canonicalJson(left).localeCompare(canonicalJson(right))
  ));
}

export function buildEvidenceGraph({ records, context, profile }) {
  assertGraphInput(records, context, profile);
  const nodes = [];
  const nodeIds = new Set();
  const edges = [];
  const conflicts = [];
  const unresolvedJoins = [];
  const recordNodes = new Map();

  function addNode(node) {
    if (!nodeIds.has(node.nodeId)) {
      nodes.push(node);
      nodeIds.add(node.nodeId);
    }
    return node;
  }

  for (const journey of profile.journeys) {
    addNode({
      nodeId: stableId('journey', {
        locationId: context.locationId,
        journeyInstanceId: journey.journeyInstanceId,
      }),
      type: 'journey_instance',
      journeyId: journey.journeyId,
      journeyInstanceId: journey.journeyInstanceId,
      denominator: journey.denominator,
      evidenceRefs: [],
    });
  }

  for (const record of records) {
    const node = addNode(recordNode(record));
    recordNodes.set(record.recordId, node);
    if (record.recordType === 'collection_status') {
      addUnresolved(unresolvedJoins, {
        reason: record.reason,
        classification: 'UNKNOWN',
        source: record.provenance.source,
        recordNodeId: node.nodeId,
        evidenceRefs: evidenceRefs(record),
      });
    }
    if (record.provenance.completeness === 'INCOMPLETE' && record.recordType !== 'collection_status') {
      addUnresolved(unresolvedJoins, {
        reason: 'INCOMPLETE_EVIDENCE',
        classification: 'UNKNOWN',
        source: record.provenance.source,
        recordNodeId: node.nodeId,
        evidenceRefs: evidenceRefs(record),
      });
    }
    if (
      record.provenance.completeness === 'COMPLETE'
      && record.classification === 'UNKNOWN'
    ) {
      addUnresolved(unresolvedJoins, {
        reason: 'SOURCE_CLASSIFICATION_UNKNOWN',
        classification: 'UNKNOWN',
        source: record.provenance.source,
        recordNodeId: node.nodeId,
        evidenceRefs: evidenceRefs(record),
      });
    }
  }

  const observed = records.filter((record) => (
    record.provenance.completeness === 'COMPLETE'
      && record.classification === 'OBSERVED'
  ));
  const contacts = observed.filter(({ recordType, nativeId }) => (
    recordType === 'contact' && typeof nativeId === 'string'
  ));
  const contactsByNativeId = new Map();
  const contactsByFuzzyKey = new Map();
  for (const contact of contacts) {
    contactsByNativeId.set(
      contact.nativeId,
      [...(contactsByNativeId.get(contact.nativeId) ?? []), contact],
    );
  }
  for (const [nativeId, claimsValue] of contactsByNativeId) {
    const claims = [...claimsValue].sort((left, right) => left.recordId.localeCompare(right.recordId));
    const entity = addNode({
      nodeId: stableId('contact', {
        locationId: context.locationId,
        nativeId,
      }),
      type: 'contact_entity',
      nativeId,
      evidenceRefs: evidenceRefs(...claims),
    });
    contactsByNativeId.set(nativeId, { claims, entity });

    const contradictoryFields = {};
    for (const field of [
      'normalizedEmail',
      'normalizedPhone',
      'organizationNativeId',
      'opportunityNativeId',
      'projectNativeId',
    ]) {
      const values = [...new Set(claims.map((claim) => claim[field]).filter(Boolean))].sort();
      if (values.length > 1) {
        contradictoryFields[field] = values.map((value) => sha256({ field, value }));
      }
    }
    if (Object.keys(contradictoryFields).length > 0) {
      const conflict = {
        type: 'contradictory_native_identity_claim',
        nativeIdHash: sha256(nativeId),
        contradictoryFields,
        nodeIds: [entity.nodeId],
        evidenceRefs: evidenceRefs(...claims),
      };
      conflicts.push({ conflictId: stableId('conflict', conflict), ...conflict });
    }

    for (const contact of claims) {
      const key = fuzzyKey(contact);
      if (key) {
        const byEntity = contactsByFuzzyKey.get(key) ?? new Map();
        const prior = byEntity.get(entity.nodeId) ?? { claims: [], entity };
        byEntity.set(entity.nodeId, { claims: [...prior.claims, contact], entity });
        contactsByFuzzyKey.set(key, byEntity);
      }
      edges.push(makeEdge({
        type: 'identity_exact',
        fromNodeId: entity.nodeId,
        toNodeId: recordNodes.get(contact.recordId).nodeId,
        eventTime: contact.eventTime ?? null,
        capturedAt: contact.provenance.capturedAt,
        refs: evidenceRefs(...claims),
        joinMethod: 'native_id',
        joinConfidence: 'exact',
      }));
    }
  }

  for (const [key, claimsByEntity] of contactsByFuzzyKey) {
    const claims = [...claimsByEntity.values()]
      .sort((left, right) => left.entity.nodeId.localeCompare(right.entity.nodeId));
    if (claims.length > 1) {
      const conflict = {
        type: 'duplicate_identity_claim',
        identityKeyHash: sha256(key),
        nodeIds: claims.map(({ entity }) => entity.nodeId).sort(),
        evidenceRefs: evidenceRefs(...claims.flatMap((claim) => claim.claims)),
      };
      conflicts.push({ conflictId: stableId('conflict', conflict), ...conflict });
    }
  }

  const compositeRecords = new Map();
  for (const record of observed) {
    const key = compositeKey(record);
    if (key) compositeRecords.set(key, [...(compositeRecords.get(key) ?? []), record]);
  }
  const compositeIdentities = new Map();
  for (const [key, claims] of compositeRecords) {
    const subjectIds = new Set(claims.map(({ subjectNativeId }) => subjectNativeId).filter(Boolean));
    if (subjectIds.size > 1) {
      const conflict = {
        type: 'ambiguous_composite_identity',
        identityKeyHash: sha256(key),
        nodeIds: claims.map((record) => recordNodes.get(record.recordId).nodeId).sort(),
        evidenceRefs: evidenceRefs(...claims),
      };
      conflicts.push({ conflictId: stableId('conflict', conflict), ...conflict });
      continue;
    }
    compositeIdentities.set(key, addNode({
      nodeId: stableId('composite', {
        locationId: context.locationId,
        key,
      }),
      type: 'composite_identity',
      identityKeyHash: sha256(key),
      evidenceRefs: evidenceRefs(...claims),
    }));
  }

  for (const record of observed) {
    if (record.recordType === 'contact') continue;
    const recordId = recordNodes.get(record.recordId).nodeId;
    const nativeContact = contactsByNativeId.get(record.subjectNativeId);
    if (nativeContact) {
      edges.push(makeEdge({
        type: 'identity_exact',
        fromNodeId: nativeContact.entity.nodeId,
        toNodeId: recordId,
        eventTime: record.eventTime ?? null,
        capturedAt: record.provenance.capturedAt,
        refs: evidenceRefs(...nativeContact.claims, record),
        joinMethod: 'native_id',
        joinConfidence: 'exact',
      }));
      continue;
    }

    const composite = compositeKey(record);
    if (composite) {
      const identity = compositeIdentities.get(composite);
      if (identity) {
        edges.push(makeEdge({
          type: 'identity_exact',
          fromNodeId: identity.nodeId,
          toNodeId: recordId,
          eventTime: record.eventTime ?? null,
          capturedAt: record.provenance.capturedAt,
          refs: evidenceRefs(...(compositeRecords.get(composite) ?? [])),
          joinMethod: 'deterministic_composite',
          joinConfidence: 'exact',
        }));
        continue;
      }
      addUnresolved(unresolvedJoins, {
        reason: 'AMBIGUOUS_COMPOSITE_IDENTITY',
        classification: 'UNKNOWN',
        source: record.provenance.source,
        recordNodeId: recordId,
        evidenceRefs: evidenceRefs(record),
      });
      continue;
    }

    const fuzzy = fuzzyKey(record);
    const fuzzyCandidates = fuzzy
      ? [...(contactsByFuzzyKey.get(fuzzy)?.values() ?? [])]
        .sort((left, right) => left.entity.nodeId.localeCompare(right.entity.nodeId))
      : [];
    if (fuzzyCandidates.length > 0) {
      for (const candidate of fuzzyCandidates) {
        edges.push(makeEdge({
          type: 'inferred_match',
          fromNodeId: candidate.entity.nodeId,
          toNodeId: recordId,
          eventTime: record.eventTime ?? null,
          capturedAt: record.provenance.capturedAt,
          refs: evidenceRefs(...candidate.claims, record),
          joinMethod: 'fuzzy_candidate',
          joinConfidence: 'candidate',
        }));
      }
      addUnresolved(unresolvedJoins, {
        reason: fuzzyCandidates.length > 1 ? 'AMBIGUOUS_IDENTITY' : 'FUZZY_ONLY',
        classification: 'UNKNOWN',
        source: record.provenance.source,
        recordNodeId: recordId,
        candidateNodeIds: fuzzyCandidates.map(({ entity }) => entity.nodeId).sort(),
        evidenceRefs: evidenceRefs(record, ...fuzzyCandidates.flatMap(({ claims }) => claims)),
      });
    }
  }

  const definitions = new Map(observed
    .filter(({ recordType, nativeId, definitionHash }) => (
      recordType === 'workflow_definition' && nativeId && definitionHash
    ))
    .map((record) => [`${record.nativeId}:${record.definitionHash}`, record]));
  for (const execution of observed.filter(({ recordType }) => recordType === 'workflow_execution')) {
    if (!execution.effectiveDefinitionHash) {
      addUnresolved(unresolvedJoins, {
        reason: 'WORKFLOW_DEFINITION_HASH_UNKNOWN',
        classification: 'UNKNOWN',
        source: execution.provenance.source,
        recordNodeId: recordNodes.get(execution.recordId).nodeId,
        workflowDefinitionHash: null,
        evidenceRefs: evidenceRefs(execution),
      });
      continue;
    }
    const definition = definitions.get(
      `${execution.workflowNativeId}:${execution.effectiveDefinitionHash}`,
    );
    if (!definition) {
      addUnresolved(unresolvedJoins, {
        reason: 'WORKFLOW_EFFECTIVE_DEFINITION_NOT_CAPTURED',
        classification: 'UNKNOWN',
        source: execution.provenance.source,
        recordNodeId: recordNodes.get(execution.recordId).nodeId,
        workflowDefinitionHash: execution.effectiveDefinitionHash,
        evidenceRefs: evidenceRefs(execution),
      });
      continue;
    }
    edges.push(makeEdge({
      type: 'execution_emitted',
      fromNodeId: recordNodes.get(definition.recordId).nodeId,
      toNodeId: recordNodes.get(execution.recordId).nodeId,
      eventTime: execution.eventTime ?? null,
      capturedAt: execution.provenance.capturedAt,
      refs: evidenceRefs(definition, execution),
      joinMethod: 'workflow_definition_hash',
      joinConfidence: 'exact',
      workflowDefinitionHash: execution.effectiveDefinitionHash,
    }));
  }

  const journeyEvents = observed.filter((record) => (
    ['journey_event', 'portal_milestone'].includes(record.recordType)
      && typeof record.journeyId === 'string'
      && typeof record.journeyInstanceId === 'string'
  ));
  const profileJourneys = new Map(profile.journeys.map((journey) => [journey.journeyId, journey]));
  for (const event of journeyEvents) {
    const declared = profileJourneys.get(event.journeyId);
    if (!declared || declared.journeyInstanceId !== event.journeyInstanceId) {
      throw codedError('JOURNEY_INSTANCE_INVALID');
    }
  }

  const bySubject = new Map();
  for (const event of journeyEvents) {
    const identity = event.subjectNativeId
      ? `native:${event.subjectNativeId}`
      : compositeKey(event);
    if (!identity) continue;
    bySubject.set(
      identity,
      [...(bySubject.get(identity) ?? []), event],
    );
  }
  const handoffs = observed.filter(({ recordType }) => recordType === 'handoff');
  for (const [identity, subjectEvents] of bySubject) {
    const journeyIds = new Set(subjectEvents.map(({ journeyId }) => journeyId));
    if (journeyIds.size > 1) {
      const handoff = handoffs.find((candidate) => (
        (
          candidate.subjectNativeId
            ? `native:${candidate.subjectNativeId}`
            : compositeKey(candidate)
        ) === identity
          && journeyIds.has(candidate.fromJourneyId)
          && journeyIds.has(candidate.toJourneyId)
      ));
      if (!handoff) throw codedError('JOURNEY_HANDOFF_REQUIRED');
    }
  }

  for (const handoff of handoffs) {
    const from = profile.journeys.find(({ journeyId }) => journeyId === handoff.fromJourneyId);
    const to = profile.journeys.find(({ journeyId }) => journeyId === handoff.toJourneyId);
    if (!from || !to || from.journeyInstanceId === to.journeyInstanceId) continue;
    const fromNode = nodes.find(({ journeyInstanceId, type }) => (
      journeyInstanceId === from.journeyInstanceId && type === 'journey_instance'
    ));
    const toNode = nodes.find(({ journeyInstanceId, type }) => (
      journeyInstanceId === to.journeyInstanceId && type === 'journey_instance'
    ));
    edges.push(makeEdge({
      type: 'preceded',
      fromNodeId: fromNode.nodeId,
      toNodeId: toNode.nodeId,
      eventTime: handoff.eventTime ?? null,
      capturedAt: handoff.provenance.capturedAt,
      refs: evidenceRefs(handoff),
      joinMethod: 'explicit_handoff',
      joinConfidence: 'exact',
    }));
  }

  if (records.some(({ provenance }) => (
    provenance.source === 'onboarding_portal'
      && provenance.completeness === 'INCOMPLETE'
  ))) {
    const onboarding = profile.journeys.find(({ journeyId }) => journeyId === 'client_onboarding');
    for (const unresolved of unresolvedJoins.filter(({ source }) => source === 'onboarding_portal')) {
      if (onboarding) {
        unresolved.journeyId = onboarding.journeyId;
        unresolved.journeyInstanceId = onboarding.journeyInstanceId;
        const { unresolvedId: _oldId, ...body } = unresolved;
        unresolved.unresolvedId = stableId('unresolved', body);
      }
    }
  }

  const progressionGroups = new Map();
  for (const event of journeyEvents) {
    const composite = compositeKey(event);
    const subject = event.subjectNativeId ?? (
      composite && compositeIdentities.has(composite) ? composite : null
    );
    if (!subject) continue;
    const key = `${event.journeyInstanceId}:${subject}`;
    progressionGroups.set(key, [...(progressionGroups.get(key) ?? []), event]);
  }
  for (const events of progressionGroups.values()) {
    events.sort((left, right) => (
      Date.parse(left.eventTime) - Date.parse(right.eventTime)
        || left.recordId.localeCompare(right.recordId)
    ));
    for (let index = 1; index < events.length; index += 1) {
      const prior = events[index - 1];
      const current = events[index];
      edges.push(makeEdge({
        type: 'preceded',
        fromNodeId: recordNodes.get(prior.recordId).nodeId,
        toNodeId: recordNodes.get(current.recordId).nodeId,
        eventTime: current.eventTime ?? null,
        capturedAt: current.provenance.capturedAt,
        refs: evidenceRefs(prior, current),
        joinMethod: current.subjectNativeId ? 'native_id' : 'deterministic_composite',
        joinConfidence: 'exact',
      }));
    }
  }

  for (const edge of edges) {
    if (!nodeIds.has(edge.fromNodeId) || !nodeIds.has(edge.toNodeId)) {
      throw codedError('EVIDENCE_EDGE_DANGLING');
    }
  }

  return deepFreeze({
    nodes: sortGraphPart(nodes, 'nodeId'),
    edges: sortGraphPart(edges, 'edgeId'),
    conflicts: sortGraphPart(conflicts, 'conflictId'),
    unresolvedJoins: sortGraphPart(unresolvedJoins, 'unresolvedId'),
  });
}
