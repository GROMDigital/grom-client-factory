import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TargetSchema,
  ProposalSchema,
  ConversationSampleSchema,
  EvidenceRecordSchema,
  ReceiptSchema,
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
    selections: [{
      subjectRef: 'psn_0123456789abcdef',
      stratum: 'showed',
      inclusionProbability: 1,
      evidenceRefs: ['ev_0123456789abcdef'],
      transcript: 'private',
    }],
  }));
});

test('conversation sample subject references are opaque pseudonyms, not PII', () => {
  const sample = {
    schemaVersion: '1.0.0',
    seed: 'seed',
    universeCount: 1,
    selections: [{
      subjectRef: 'psn_0123456789abcdef',
      stratum: 'showed',
      inclusionProbability: 1,
      evidenceRefs: ['ev_0123456789abcdef'],
    }],
  };
  assert.equal(ConversationSampleSchema.parse(sample).selections[0].subjectRef, 'psn_0123456789abcdef');
  for (const subjectRef of ['alice@example.com', '+14155552671', 'Alice Smith']) {
    assert.throws(() => ConversationSampleSchema.parse({
      ...sample,
      selections: [{ ...sample.selections[0], subjectRef }],
    }));
  }
});

test('publishable evidence and approval references reject direct PII', () => {
  const evidence = {
    schemaVersion: '1.0.0',
    evidenceRef: 'ev_0123456789abcdef',
    source: 'public_ghl',
    capturedAt: '2026-07-24T00:00:00.000Z',
    payloadHash: 'a'.repeat(64),
    classification: 'OBSERVED',
    objectRefs: [{ objectType: 'contact', objectId: 'obj_0123456789abcdef' }],
  };
  assert.equal(EvidenceRecordSchema.parse(evidence).evidenceRef, evidence.evidenceRef);
  assert.throws(() => EvidenceRecordSchema.parse({ ...evidence, evidenceRef: 'alice@example.com' }));
  assert.throws(() => EvidenceRecordSchema.parse({
    ...evidence,
    objectRefs: [{ objectType: 'contact', objectId: '+14155552671' }],
  }));

  const receipt = {
    schemaVersion: '1.0.0',
    receiptId: 'receipt-1',
    proposalHash: 'a'.repeat(64),
    approvedAt: '2026-07-24T00:00:00.000Z',
    approvedBy: 'actor_0123456789abcdef',
    approvalScope: ['proposal'],
    executable: false,
  };
  assert.equal(ReceiptSchema.parse(receipt).approvedBy, receipt.approvedBy);
  assert.throws(() => ReceiptSchema.parse({ ...receipt, approvedBy: 'Alice Smith' }));
});
