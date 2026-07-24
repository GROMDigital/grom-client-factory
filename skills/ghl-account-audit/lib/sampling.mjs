import { sha256 } from './canonical.mjs';

const REF = /^(?:obj|psn|ev|actor)_[a-f0-9]{16,64}$/u;
const SAFE_TOKEN = /^[a-z0-9][a-z0-9_.:-]{0,127}$/u;
const MANDATORY = new Set([
  'complaint',
  'opt_out',
  'failure',
  'abandoned_call',
  'high_value_loss',
]);

function codedError(code, ErrorType = Error) {
  return Object.assign(new ErrorType(code), { code });
}

function deepFreeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function safeRef(value, prefix) {
  return typeof value === 'string' && REF.test(value) && value.startsWith(`${prefix}_`);
}

function token(value) {
  return typeof value === 'string' && SAFE_TOKEN.test(value);
}

function normalize(interaction) {
  if (
    !interaction
    || typeof interaction !== 'object'
    || !safeRef(interaction.interactionRef, 'obj')
    || !safeRef(interaction.subjectRef, 'psn')
    || !Array.isArray(interaction.evidenceRefs)
    || interaction.evidenceRefs.length === 0
    || !interaction.evidenceRefs.every((value) => safeRef(value, 'ev'))
    || !Array.isArray(interaction.flags)
    || !interaction.flags.every((value) => MANDATORY.has(value))
  ) throw codedError('SAMPLE_INTERACTION_INVALID', TypeError);
  const fields = [
    interaction.occurredAtBand,
    interaction.source,
    interaction.stage,
    interaction.outcome,
    interaction.responseTimeBand,
    interaction.callDurationBand,
    interaction.handoffState,
  ];
  if (!fields.every(token) || !safeRef(interaction.ownerRef, 'actor')) {
    throw codedError('SAMPLE_INTERACTION_INVALID', TypeError);
  }
  const stratum = fields.join('|');
  return {
    interactionRef: interaction.interactionRef,
    subjectRef: interaction.subjectRef,
    evidenceRefs: [...new Set(interaction.evidenceRefs)].sort(),
    stratum,
    flags: [...new Set(interaction.flags)].sort(),
  };
}

function score(seed, interactionRef) {
  return sha256({ seed, interactionRef });
}

export function selectConversationSample({
  interactions,
  seed,
  censusThreshold = 50,
  maxSample = 50,
}) {
  if (
    !Array.isArray(interactions)
    || typeof seed !== 'string'
    || seed.length === 0
    || !Number.isInteger(censusThreshold)
    || censusThreshold < 0
    || !Number.isInteger(maxSample)
    || maxSample < 1
  ) throw codedError('SAMPLE_CONTRACT_INVALID', TypeError);
  const universe = interactions.map(normalize)
    .sort((left, right) => left.interactionRef.localeCompare(right.interactionRef));
  if (new Set(universe.map(({ interactionRef }) => interactionRef)).size !== universe.length) {
    throw codedError('SAMPLE_INTERACTION_DUPLICATE');
  }

  let chosen;
  let mode;
  if (universe.length <= censusThreshold) {
    mode = 'CENSUS';
    chosen = universe.map((item) => ({ item, probability: 1, reasons: ['census'] }));
  } else {
    mode = 'STRATIFIED_SAMPLE';
    const mandatory = universe.filter(({ flags }) => flags.length > 0);
    const mandatoryIds = new Set(mandatory.map(({ interactionRef }) => interactionRef));
    const selected = mandatory.map((item) => ({
      item,
      probability: 1,
      reasons: item.flags.map((flag) => `mandatory:${flag}`),
    }));
    const slots = Math.max(0, maxSample - selected.length);
    const strata = new Map();
    for (const item of universe.filter(({ interactionRef }) => !mandatoryIds.has(interactionRef))) {
      strata.set(item.stratum, [...(strata.get(item.stratum) ?? []), item]);
    }
    for (const values of strata.values()) {
      values.sort((left, right) => (
        score(seed, left.interactionRef).localeCompare(score(seed, right.interactionRef))
          || left.interactionRef.localeCompare(right.interactionRef)
      ));
    }
    const stratumNames = [...strata.keys()].sort((left, right) => (
      sha256({ seed, stratum: left }).localeCompare(sha256({ seed, stratum: right }))
        || left.localeCompare(right)
    ));
    const picked = new Map();
    let remaining = slots;
    let round = 0;
    while (remaining > 0) {
      let progressed = false;
      for (const stratum of stratumNames) {
        const candidate = strata.get(stratum)[round];
        if (!candidate || remaining === 0) continue;
        picked.set(candidate.interactionRef, candidate);
        remaining -= 1;
        progressed = true;
      }
      if (!progressed) break;
      round += 1;
    }
    const pickedCountByStratum = new Map();
    for (const item of picked.values()) {
      pickedCountByStratum.set(item.stratum, (pickedCountByStratum.get(item.stratum) ?? 0) + 1);
    }
    for (const item of picked.values()) {
      selected.push({
        item,
        probability: pickedCountByStratum.get(item.stratum) / strata.get(item.stratum).length,
        reasons: ['deterministic_stratified_draw'],
      });
    }
    chosen = selected;
  }

  const selections = chosen.map(({ item, probability, reasons }) => ({
    interactionRef: item.interactionRef,
    subjectRef: item.subjectRef,
    evidenceRefs: item.evidenceRefs,
    stratum: item.stratum,
    inclusionProbability: probability,
    selectionReasons: reasons,
  })).sort((left, right) => left.interactionRef.localeCompare(right.interactionRef));
  const mandatoryCount = universe.filter(({ flags }) => flags.length > 0).length;
  const manifest = {
    schemaVersion: '1.0.0',
    seed,
    mode,
    universeCount: universe.length,
    requestedMaxSample: maxSample,
    actualSampleCount: selections.length,
    mandatoryCount,
    mandatoryOverflowCount: Math.max(0, mandatoryCount - maxSample),
    selections,
    populationPrevalence: mode === 'CENSUS' ? 'CENSUS_ONLY' : null,
    prevalenceScope: {
      kind: mode === 'CENSUS' ? 'CENSUS' : 'SAMPLE_BOUNDED',
      weightingRequiredForPopulationEstimate: mode !== 'CENSUS',
      uncertaintyRequiredForPopulationEstimate: mode !== 'CENSUS',
    },
  };
  return deepFreeze({ ...manifest, sampleHash: sha256(manifest) });
}
