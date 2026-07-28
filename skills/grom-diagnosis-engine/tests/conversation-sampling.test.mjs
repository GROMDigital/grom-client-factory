import assert from 'node:assert/strict';
import { test } from 'node:test';
import { selectConversationSample } from '../lib/sampling.mjs';

const SEED = 'seed_1111111111111111';

function interaction(index, extra = {}) {
  const hex = index.toString(16).padStart(16, '0');
  return {
    interactionRef: `obj_${hex}`,
    subjectRef: `psn_${hex}`,
    evidenceRefs: [`ev_${hex}`],
    occurredAtBand: index % 2 ? 'late_week' : 'early_week',
    source: index % 3 ? 'src_1111111111111111' : 'src_2222222222222222',
    stage: index % 4 ? 'stage_1111111111111111' : 'stage_2222222222222222',
    ownerRef: `actor_${(index % 5).toString(16).padStart(16, '0')}`,
    outcome: index % 4 ? 'open' : 'lost',
    responseTimeBand: index % 2 ? 'fast' : 'slow',
    callDurationBand: index % 3 ? 'short' : 'long',
    handoffState: index % 5 ? 'not_required' : 'failed',
    flags: [],
    transcript: `private transcript ${index}`,
    messageBody: `private message ${index}`,
    contactName: `Private Person ${index}`,
    ...extra,
  };
}

test('eligible universes of 50 or fewer are a deterministic census without private content', () => {
  const interactions = Array.from({ length: 50 }, (_, index) => interaction(index + 1));
  const sample = selectConversationSample({
    interactions,
    seed: SEED,
    censusThreshold: 50,
    maxSample: 50,
  });
  assert.equal(sample.mode, 'CENSUS');
  assert.equal(sample.universeCount, 50);
  assert.equal(sample.selections.length, 50);
  assert.ok(sample.selections.every(({ inclusionProbability }) => inclusionProbability === 1));
  const serialized = JSON.stringify(sample);
  for (const forbidden of ['private transcript', 'private message', 'Private Person', 'transcript', 'messageBody', 'contactName']) {
    assert.equal(serialized.includes(forbidden), false);
  }
  assert.ok(Object.isFrozen(sample));
  assert.ok(Object.isFrozen(sample.selections));
});

test('above 50 sampling is input-order independent, reproducibly stratified, and includes mandatory losses', () => {
  const flags = ['complaint', 'opt_out', 'failure', 'abandoned_call', 'high_value_loss'];
  const interactions = Array.from({ length: 80 }, (_, index) => interaction(index + 1,
    index < flags.length ? { flags: [flags[index]] } : {}));
  const forward = selectConversationSample({
    interactions,
    seed: SEED,
    censusThreshold: 50,
    maxSample: 30,
  });
  const reversed = selectConversationSample({
    interactions: structuredClone(interactions).reverse(),
    seed: SEED,
    censusThreshold: 50,
    maxSample: 30,
  });
  assert.deepEqual(forward, reversed);
  assert.equal(forward.mode, 'STRATIFIED_SAMPLE');
  assert.equal(forward.selections.length, 30);
  for (let index = 1; index <= flags.length; index += 1) {
    assert.ok(forward.selections.some(({ interactionRef }) => (
      interactionRef === `obj_${index.toString(16).padStart(16, '0')}`
    )));
  }
  assert.ok(forward.selections.every(({ inclusionProbability }) => (
    inclusionProbability > 0 && inclusionProbability <= 1
  )));
  assert.ok(new Set(forward.selections.map(({ stratum }) => stratum)).size > 1);
  assert.equal(forward.populationPrevalence, null);
  assert.deepEqual(forward.prevalenceScope, {
    kind: 'SAMPLE_BOUNDED',
    weightingRequiredForPopulationEstimate: true,
    uncertaintyRequiredForPopulationEstimate: true,
  });
  assert.match(forward.sampleHash, /^[a-f0-9]{64}$/);
});

test('sampling rejects unsafe refs, duplicate interactions, and impossible contracts', () => {
  assert.throws(() => selectConversationSample({
    interactions: [interaction(1, { interactionRef: 'raw_secret' })],
    seed: SEED,
  }), /SAMPLE_INTERACTION_INVALID/);
  assert.throws(() => selectConversationSample({
    interactions: [interaction(1), interaction(1)],
    seed: SEED,
  }), /SAMPLE_INTERACTION_DUPLICATE/);
  assert.throws(() => selectConversationSample({
    interactions: [interaction(1)],
    seed: SEED,
    censusThreshold: 50,
    maxSample: 0,
  }), /SAMPLE_CONTRACT_INVALID/);
});

test('mandatory cases exceeding maxSample remain included and are disclosed as diagnostic oversampling', () => {
  const interactions = Array.from({ length: 60 }, (_, index) => interaction(index + 1, {
    flags: ['complaint'],
  }));
  const sample = selectConversationSample({
    interactions,
    seed: SEED,
    censusThreshold: 50,
    maxSample: 50,
  });
  assert.equal(sample.selections.length, 60);
  assert.equal(sample.requestedMaxSample, 50);
  assert.equal(sample.mandatoryOverflowCount, 10);
  assert.equal(sample.populationPrevalence, null);
  assert.equal(sample.prevalenceScope.kind, 'SAMPLE_BOUNDED');
  assert.ok(sample.selections.every(({ inclusionProbability, selectionReasons }) => (
    inclusionProbability === 1 && selectionReasons.includes('mandatory:complaint')
  )));
});

test('seed and categorical strata reject safe-looking PII, credentials, and key references', () => {
  for (const leaked of ['john.smith', '15551234567', 'credential_supersecret']) {
    assert.throws(() => selectConversationSample({
      interactions: [interaction(1, { source: leaked })],
      seed: SEED,
    }), /SAMPLE_INTERACTION_INVALID/);
  }
  assert.throws(() => selectConversationSample({
    interactions: [interaction(1)],
    seed: 'credential_supersecret',
  }), /SAMPLE_CONTRACT_INVALID/);
  const sample = selectConversationSample({
    interactions: [interaction(1)],
    seed: SEED,
  });
  const published = JSON.stringify(sample);
  for (const leaked of ['john.smith', '15551234567', 'credential_supersecret']) {
    assert.equal(published.includes(leaked), false);
  }
});
