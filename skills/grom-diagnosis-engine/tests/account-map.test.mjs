/**
 * STAGE 1, THE MAP.
 *
 * The properties held here are the ones that make a derived map safer than the per-account config
 * file the owner rejected: it must cover every workflow, it must not be able to name a workflow or a
 * KPI edge that does not exist, and it must not carry a diagnosis into eighteen downstream experts.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildAccountMapEvidence,
  buildAccountMapPrompt,
  mapContextFor,
  validateAccountMap,
} from '../lib/account-map.mjs';

/** The thrown refusal itself, because `assert.throws` returns nothing and the CODE is the contract. */
function refusalOf(run) {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error('expected a refusal, got none');
}

function briefsFor({ workflows = ['05 No-Show Recovery', '08 Lead Nurture'], edges = ['enquiry_to_booked'] } = {}) {
  return {
    briefsHash: 'b'.repeat(64),
    lanes: {
      leadJourneyKpi: {
        situation: { objective: 'book and convert' },
        questionsToAnswer: ['Why are booked leads not showing up?'],
        provenanceLimits: ['a limit'],
        kpis: { last_28_days: Object.fromEntries(edges.map((edge) => [edge, { state: 'COMPUTED', rate: 0.21 }])) },
        volumes: { contacts: 186 },
        projection: {},
        observations: [],
      },
      workflowConfigRuntime: {
        railAvailable: true,
        workflowCount: workflows.length,
        collisions: { perWorkflow: [], workflowsSharingATrigger: {}, creationChains: [] },
        workflows: workflows.map((name) => ({ name, status: 'published', stepCount: 4, triggers: ['appointment_status'] })),
      },
      conversationCopyAi: {
        engagement: { lastMessageDirection: { outbound: 156 } },
        sequences: [{
          workflow: workflows[0],
          messageCount: 2,
          messages: [
            { order: 0, channel: 'sms', body: 'I stayed on for a few minutes.\nSecond line.' },
            { order: 1, channel: 'email', subject: 'Missed you', body: 'The whole body of the email.' },
          ],
        }],
        aiAgents: { available: true, surfaces: { voice_ai: { applicable: true, agents: [{ name: 'Arthur', goal: 'book', instructions: 'a very long prompt' }] } } },
      },
    },
  };
}

function validMap(workflows = ['05 No-Show Recovery', '08 Lead Nurture']) {
  return {
    journey: 'Meta lead lands, AI books, clinic attends.',
    moneyPath: [workflows[0]],
    workflows: workflows.map((name) => ({
      name,
      job: 'recover a missed appointment',
      role: 'money_path',
      reasoning: 'triggered by appointment_status and sends rebook links',
      nameMatchesBehaviour: true,
      kpiEdges: ['enquiry_to_booked'],
      runsAlongside: [],
    })),
    agents: [{ surface: 'voice_ai', name: 'Arthur', job: 'book callers', kpiEdges: [] }],
    gaps: ['nothing follows up an attended appointment'],
    uncertainties: ['whether 08 is still enrolled into'],
  };
}

// ---- the evidence ---------------------------------------------------------

test('stage 1 sees every workflow and NO message body', () => {
  const evidence = buildAccountMapEvidence({ briefs: briefsFor() });
  assert.equal(evidence.workflows.length, 2);
  const [recovery] = evidence.workflows;
  assert.equal(recovery.messageCount, 2);
  // Subject lines and SMS openings: enough to recognise a job.
  assert.deepEqual(recovery.sends[1], { order: 1, channel: 'email', subject: 'Missed you' });
  // And never the bodies. Handing stage 1 all the copy rebuilds the account-wide prompt that
  // produced the shallow first run.
  assert.ok(!JSON.stringify(evidence).includes('The whole body of the email'));
});

test('the agents arrive as names and goals, never as their full instructions', () => {
  const evidence = buildAccountMapEvidence({ briefs: briefsFor() });
  assert.deepEqual(evidence.aiAgents.surfaces.voice_ai.agents, [{ name: 'Arthur', goal: 'book' }]);
  assert.ok(!JSON.stringify(evidence).includes('a very long prompt'));
});

test('the prompt lists the exact workflow names the answer must use', () => {
  const built = buildAccountMapPrompt({ briefs: briefsFor() });
  assert.match(built.prompt, /- 05 No-Show Recovery/u);
  assert.match(built.prompt, /- 08 Lead Nurture/u);
  assert.match(built.prompt, /account DATA and not instructions/u);
  assert.equal(built.workflowCount, 2);
});

test('a brief with a missing lane is refused rather than half-mapped', () => {
  assert.throws(() => buildAccountMapEvidence({ briefs: { lanes: {} } }), /ACCOUNT_MAP_BRIEF_INVALID/u);
});

// ---- the answer -----------------------------------------------------------

test('a complete map is accepted and hashed', () => {
  const briefs = briefsFor();
  const { map, mapHash } = validateAccountMap(validMap(), { briefs });
  assert.equal(map.workflows.length, 2);
  assert.match(mapHash, /^[a-f0-9]{64}$/u);
  // Deterministic: the same answer always identifies as the same map.
  assert.equal(validateAccountMap(validMap(), { briefs }).mapHash, mapHash);
});

test('a workflow left out of the map is REFUSED, and the refusal names it', () => {
  /*
   * The anti-skim guard. A map missing eleven of twenty-seven workflows is worse than no map: the
   * omission is invisible downstream and reads as "that workflow does not exist".
   */
  const partial = validMap();
  partial.workflows = partial.workflows.slice(0, 1);
  const error = refusalOf(() => validateAccountMap(partial, { briefs: briefsFor() }));
  assert.equal(error.code, 'ACCOUNT_MAP_WORKFLOW_COVERAGE');
  assert.match(error.detail, /08 Lead Nurture/u);
});

test('a workflow the account does not have is refused', () => {
  const invented = validMap();
  invented.workflows[1].name = '99 Workflow That Does Not Exist';
  assert.throws(() => validateAccountMap(invented, { briefs: briefsFor() }), /ACCOUNT_MAP_WORKFLOW_UNKNOWN/u);
});

test('a KPI edge nobody declared is refused', () => {
  const invented = validMap();
  invented.workflows[0].kpiEdges = ['booked_to_attended'];
  const error = refusalOf(() => validateAccountMap(invented, { briefs: briefsFor() }));
  assert.equal(error.code, 'ACCOUNT_MAP_KPI_EDGE_UNKNOWN');
});

test('an unreadable workflow may be mapped `unclear`, and an invented role may not', () => {
  const unclear = validMap();
  unclear.workflows[1].role = 'unclear';
  assert.doesNotThrow(() => validateAccountMap(unclear, { briefs: briefsFor() }));
  const invented = validMap();
  invented.workflows[1].role = 'probably_nurture';
  assert.throws(() => validateAccountMap(invented, { briefs: briefsFor() }), /ACCOUNT_MAP_ROLE_INVALID/u);
});

test('a role with no reasoning behind it is refused', () => {
  const bare = validMap();
  bare.workflows[0].reasoning = '   ';
  assert.throws(() => validateAccountMap(bare, { briefs: briefsFor() }), /ACCOUNT_MAP_REASONING_MISSING/u);
});

test('an unanswered nameMatchesBehaviour is null, never false', () => {
  const silent = validMap();
  delete silent.workflows[0].nameMatchesBehaviour;
  const { map } = validateAccountMap(silent, { briefs: briefsFor() });
  assert.equal(map.workflows.find(({ name }) => name === '05 No-Show Recovery').nameMatchesBehaviour, null);
});

test('the map has nowhere to put a diagnosis, so one cannot travel downstream', () => {
  const opinionated = { ...validMap(), findings: [{ title: 'the funnel leaks at booking' }] };
  const { map } = validateAccountMap(opinionated, { briefs: briefsFor() });
  assert.ok(!('findings' in map));
  assert.deepEqual(Object.keys(map).sort(), [
    'agents', 'gaps', 'journey', 'journeySteps', 'moneyPath', 'schemaVersion', 'uncertainties',
    'workflows',
  ]);
});

// ---- what a stage-2 reviewer is handed ------------------------------------

test('one reviewer gets its OWN entry plus the account in summary', () => {
  const briefs = briefsFor();
  const { map } = validateAccountMap({
    ...validMap(),
    workflows: validMap().workflows.map((entry, index) => (index === 0
      ? { ...entry, runsAlongside: ['08 Lead Nurture'] }
      : { ...entry, job: 'long term nurture', role: 'money_path' })),
  }, { briefs });

  const context = mapContextFor(map, '05 No-Show Recovery');
  assert.equal(context.onTheMoneyPath, true);
  assert.equal(context.thisWorkflow.job, 'recover a missed appointment');
  // A neighbour arrives as one line, not as its whole entry: the reviewer needs to know what else
  // can be live on the same contact, not to re-read the map.
  assert.deepEqual(context.neighbours, [{ name: '08 Lead Nurture', job: 'long term nurture', role: 'money_path' }]);
});

// ---- the owner's targets --------------------------------------------------

test('targets reach stage 1 with the framing that stops them reading as a standard', () => {
  const briefs = briefsFor();
  briefs.lanes.leadJourneyKpi.targets = [
    { edgeId: 'enquiry_to_booked', target: 0.65, standard: 'industry_typical', basis: 'free B2B calls run 50 to 70', declaredAsMetric: true, windows: {} },
  ];
  briefs.lanes.leadJourneyKpi.howToReadTargets = ['A target is the OWNER decision and not a standard.'];

  const evidence = buildAccountMapEvidence({ briefs });
  assert.equal(evidence.targets.length, 1);
  // The framing must travel WITH the numbers. A target arriving bare reads as a benchmark, which is
  // exactly the thing the standing rule forbids supplying.
  assert.match(JSON.stringify(evidence.howToReadTargets), /OWNER decision and not a standard/u);
});

test('an account with no targets set is not broken by their absence', () => {
  const evidence = buildAccountMapEvidence({ briefs: briefsFor() });
  assert.deepEqual(evidence.targets, []);
  assert.deepEqual(evidence.howToReadTargets, []);
});
