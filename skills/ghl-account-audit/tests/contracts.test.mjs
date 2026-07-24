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
