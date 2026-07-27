/**
 * THE THREE ANALYSIS LANES' INPUT.
 *
 * `PRODUCT-SPEC.md`: the auditor decides what to analyse and is never told, and all three lanes run
 * every time. These tests hold that line. The fixture shapes are the ones the real audit server
 * sends, proven by `tests/internal-audit-contract.test.mjs`.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { THE_QUESTIONS, buildAnalysisBriefs, plainText } from '../lib/analysis-brief.mjs';
import { loadProfile } from '../schemas/v1.mjs';

const profile = loadProfile('grom_internal');

const measurement = Object.freeze({
  profileId: 'grom_internal',
  collectionWindow: { from: '2026-04-27T23:00:00.000Z', to: '2026-07-26T23:00:00.000Z' },
  collectionMode: 'first',
  collection: [{ operationId: 'contacts.search', collectedCount: 186 }],
  projection: [{ operationId: 'contacts.search', emittedCount: 372 }],
  unmeasurableEdges: ['contacted_to_qualified', 'qualified_to_strategy_call'],
  surfaceObservations: [
    {
      capability: 'conversations',
      rows: 175,
      observations: [
        { observationId: 'last_message_direction', kind: 'distribution', values: { outbound: 156, inbound: 17 } },
        { observationId: 'has_manual_message', kind: 'presence', rows: 175, present: 99, absent: 76 },
      ],
    },
  ],
  graph: { nodes: [1], edges: [1, 2], conflicts: [], unresolvedJoins: [] },
  windows: { timezone: 'Europe/London' },
  metrics: {
    metrics: {
      trailing90Days: {
        enquiry_to_contacted: { state: 'OBSERVED', numerator: 166, denominator: 178, eligible: 186, rate: 0.93 },
        contacted_to_qualified: { state: 'UNKNOWN', reasonCode: 'MISSING_REQUIRED_EVIDENCE' },
      },
    },
  },
});

/** A workflow in the shape `export_workflow` really returns. */
function workflow(name, { steps = [], triggers = [], stopOnResponse = false, snapshot = false, runtime = null, runtimeCode = 'RUNTIME_NOT_REQUESTED' } = {}) {
  return {
    workflowId: `wf-${name}`,
    definition: {
      data: {
        workflow: {
          _id: `wf-${name}`,
          name,
          status: 'published',
          allowMultiple: true,
          timezone: 'contact',
          stopOnResponse,
          workflowData: { templates: steps.map((step, index) => ({ order: index, ...step })) },
          ...(snapshot ? { workflowNote: { createdBy: 'snapshot' } } : {}),
        },
        triggers: triggers.map((type, index) => ({ id: `t${index}`, type })),
        stickyNotes: [],
      },
    },
    definitionCode: null,
    runtimeWindow: runtime === null ? null : { data: runtime },
    runtimeCode,
  };
}

const internal = Object.freeze({
  source: 'internal_ghl',
  complete: true,
  limitations: [],
  roster: { complete: true, reportedCount: 2, readCount: 2 },
  workflows: [
    workflow('001 - FB Lead Form', {
      triggers: ['facebook_lead_gen'],
      stopOnResponse: true,
      snapshot: true,
      steps: [
        { type: 'sms', name: 'Opener', attributes: { message: 'Hey {{contact.first_name}}, saw your enquiry.' } },
        { type: 'wait', name: 'Wait 25 minutes', attributes: { startAfter: { type: 'minutes', value: 25, when: 'after' } } },
        { type: 'if_else', name: 'Bristol' },
        { type: 'email', name: 'Nudge', attributes: { subject: 'One question', preHeader: 'Quick one', from_name: 'GROM', from_email: 'team@example.test', html: '<p>Hi there</p><br/><p>Worth a look?</p>' } },
        { type: 'internal_create_opportunity', name: 'Create opp' },
      ],
    }),
    workflow('08 Long Term Nurture', {
      triggers: ['opportunity_created'],
      stopOnResponse: false,
      steps: [
        { type: 'wait', name: 'Wait 2 hours', attributes: { startAfter: { type: 'hour', value: 2, when: 'after' } } },
        // A send step pointing at a LIBRARY TEMPLATE: subject present, body absent.
        { type: 'email', name: 'Content 1', attributes: { subject: 'The 5-minute rule', preHeader: 'Why leads go cold', from_name: 'GROM', from_email: 'team@example.test' } },
      ],
      runtimeCode: null,
      runtime: {
        complete: false,
        truncated: true,
        warnings: [{ code: 'LOG_PAGE_BUDGET_EXHAUSTED', component: 'runtime_events', detail: 'echoes request context' }],
        runtimeEvents: [{ id: 'e1' }, { id: 'e2' }],
        observedEventTypes: { byType: { email: 2 }, byStatus: { success: 1, skipped: 1 } },
        perStepCounts: [{ total: 12, currentStepId: 's1' }],
        configurationBinding: { definitionGovernedRuntimeEvents: 'unproven' },
      },
    }),
  ],
  aiConfiguration: {
    data: {
      components: {
        conversation_ai: { applicable: true, complete: true, items: [{ detail: { name: 'Arthur', channels: ['SMS'], goal: 'book the call' } }] },
      },
    },
  },
});

// ---------------------------------------------------------------------------

test('all three lanes are built every time, and each carries the situation and the questions', () => {
  const { lanes } = buildAnalysisBriefs({ measurement, internal, profile });
  assert.deepEqual(Object.keys(lanes).sort(), ['conversationCopyAi', 'leadJourneyKpi', 'workflowConfigRuntime']);

  for (const [name, lane] of Object.entries(lanes)) {
    // The auditor is never told which lane to run, so no lane can be conditional on anything.
    assert.equal(typeof lane.lane, 'string', name);
    assert.equal(typeof lane.remit, 'string', name);
    assert.deepEqual(lane.questionsToAnswer, THE_QUESTIONS, name);
    // A number cannot be judged without the situation, and the caveats are the difference between a
    // diagnosis and a confidently wrong one.
    assert.ok(lane.situation, `${name} lost the situation`);
    for (const caveat of profile.situation.knownDataCaveats) {
      assert.ok(lane.provenanceLimits.includes(caveat), `${name} dropped a known data caveat`);
    }
    // The one nobody may claim: that this configuration caused a past outcome.
    assert.ok(
      lane.provenanceLimits.some((limit) => /may not be said to have caused a past outcome/u.test(limit)),
      `${name} dropped the provenance limit`,
    );
  }
});

test('the rail being off is stated, not left to look like healthy automation', () => {
  const { lanes } = buildAnalysisBriefs({ measurement, internal: null, profile });
  assert.equal(lanes.workflowConfigRuntime.railAvailable, false);
  assert.equal(lanes.workflowConfigRuntime.workflowCount, 0);
  assert.equal(lanes.conversationCopyAi.railAvailable, false);
  assert.deepEqual(lanes.conversationCopyAi.sequences, []);
  // Zero workflows and "we could not look at the workflows" are different facts. An analyst told
  // the first would clear an account whose automation was never read.
  assert.ok(
    lanes.workflowConfigRuntime.provenanceLimits.some((limit) => /internal rail was OFF/u.test(limit)),
  );
});

test('lane 1 carries EVERY declared KPI with its state, not only the ones that computed', () => {
  const { lanes } = buildAnalysisBriefs({ measurement, internal, profile });
  const kpis = lanes.leadJourneyKpi.kpis.trailing90Days;
  assert.equal(kpis.enquiry_to_contacted.state, 'OBSERVED');
  assert.equal(kpis.enquiry_to_contacted.numerator, 166);
  // "We cannot measure this and here is why" is a finding in its own right, so an UNKNOWN cell must
  // survive with its reason rather than being filtered out for having no number.
  assert.equal(kpis.contacted_to_qualified.state, 'UNKNOWN');
  assert.equal(kpis.contacted_to_qualified.reasonCode, 'MISSING_REQUIRED_EVIDENCE');
  assert.equal(lanes.leadJourneyKpi.kpiCoverage.declared, 2);
  assert.equal(lanes.leadJourneyKpi.kpiCoverage.withNoSignalAtAll, 2);
});

test('lane 2 computes which workflows can be live on the same contact at once', () => {
  const { lanes } = buildAnalysisBriefs({ measurement, internal, profile });
  const { collisions } = lanes.workflowConfigRuntime;

  /*
   * The spec names "duplicate or conflicting automation" as lane 2's work, and it is invisible one
   * workflow at a time. `001` contains `internal_create_opportunity`; `08` triggers on
   * `opportunity_created`. So finishing the lead-form sequence STARTS the nurture, and the nurture
   * does not stop when the lead replies.
   */
  assert.equal(collisions.creationChains.length, 1);
  const [chain] = collisions.creationChains;
  assert.equal(chain.producer, '001 - FB Lead Form');
  assert.equal(chain.consumer, '08 Long Term Nurture');
  assert.equal(chain.via, 'internal_create_opportunity -> opportunity_created');
  // The two facts that decide whether the overlap is deliberate or an accident.
  assert.equal(chain.consumerStopsOnResponse, false);
  assert.equal(chain.consumerMessageSteps, 1);

  const leadForm = collisions.perWorkflow.find((row) => row.name === '001 - FB Lead Form');
  assert.deepEqual(leadForm.creates, ['internal_create_opportunity']);
  assert.equal(leadForm.stopOnResponse, true);
});

test('lane 2 tells "we did not look" apart from "we looked and it was quiet"', () => {
  const { lanes } = buildAnalysisBriefs({ measurement, internal, profile });
  const byName = Object.fromEntries(lanes.workflowConfigRuntime.workflows.map((w) => [w.name, w]));

  // Never asked. An analyst told this workflow had no runtime would clear a broken step.
  assert.equal(byName['001 - FB Lead Form'].runtime.requested, false);
  assert.equal(byName['001 - FB Lead Form'].runtime.code, 'RUNTIME_NOT_REQUESTED');

  // Asked and answered, partially, and it says which part and why.
  const nurture = byName['08 Long Term Nurture'].runtime;
  assert.equal(nurture.requested, true);
  assert.equal(nurture.complete, false);
  assert.deepEqual(nurture.warnings, [{ code: 'LOG_PAGE_BUDGET_EXHAUSTED', component: 'runtime_events' }]);
  // `detail` echoes request context and this value reaches the publication boundary.
  assert.equal(Object.hasOwn(nurture.warnings[0], 'detail'), false);
  // The spec's "contacts becoming stuck at a step" and "steps that did not execute".
  assert.deepEqual(nurture.perStepCounts, [{ total: 12, currentStepId: 's1' }]);
  assert.equal(nurture.observedEventTypes.byStatus.skipped, 1);
  assert.equal(nurture.configurationBinding.definitionGovernedRuntimeEvents, 'unproven');
});

test('lane 3 carries the copy in send order with its cadence, and says what it cannot see', () => {
  const { lanes } = buildAnalysisBriefs({ measurement, internal, profile });
  const leadForm = lanes.conversationCopyAi.sequences.find((s) => s.workflow === '001 - FB Lead Form');

  assert.equal(leadForm.messageCount, 2);
  const [opener, nudge] = leadForm.messages;
  assert.equal(opener.channel, 'sms');
  assert.equal(opener.waitBefore.length, 0, 'the first message goes out immediately');
  assert.match(opener.body, /saw your enquiry/u);

  // The wait accumulates, and a branch marker is recorded as a branch and not as a delay.
  assert.deepEqual(nudge.waitBefore, ['25 minutes after', '[if_else: Bristol]']);
  assert.equal(nudge.subject, 'One question');
  assert.equal(nudge.body, 'Hi there\n\nWorth a look?');
  assert.equal(nudge.bodyIsInline, true);

  // A library-template send is DISCLOSED, because an analyst must not judge copy it cannot see.
  const nurture = lanes.conversationCopyAi.sequences.find((s) => s.workflow === '08 Long Term Nurture');
  assert.equal(nurture.messagesWithNoInlineBody, 1);
  assert.equal(nurture.messages[0].bodyIsInline, false);
  assert.equal(nurture.messages[0].subject, 'The 5-minute rule');
  assert.ok(lanes.conversationCopyAi.limits.some((limit) => /library template/u.test(limit)));
  // And the ceiling caveat, because branch legs are flattened.
  assert.ok(lanes.conversationCopyAi.limits.some((limit) => /CEILINGS/u.test(limit)));
});

test('a library template body is resolved into the sequence, so lane 3 judges the real copy', () => {
  /*
   * The gap this closes: 63 of 126 message steps on the UK account are library templates, and lane 3
   * was judging them on their subject line without the body. `lib/adapters/email-copy.mjs` collects
   * the copy; this asserts it arrives IN the sequence rather than as a second list to join by hand.
   */
  const withCopy = {
    ...internal,
    workflows: internal.workflows.map((wf) => (
      wf.definition.data.workflow.name !== '08 Long Term Nurture' ? wf : {
        ...wf,
        definition: {
          ...wf.definition,
          data: {
            ...wf.definition.data,
            workflow: {
              ...wf.definition.data.workflow,
              workflowData: {
                templates: wf.definition.data.workflow.workflowData.templates.map((step) => (
                  step.type !== 'email' ? step : {
                    ...step,
                    attributes: { ...step.attributes, template_id: '6a2c675152ce94e124f9f0f1', templatesource: 'email-builder' },
                  }
                )),
              },
            },
          },
        },
      }
    )),
    emailCopy: {
      complete: true,
      limitations: [],
      requestedCount: 1,
      libraryTotal: 59,
      templates: [{
        templateId: '6a2c675152ce94e124f9f0f1',
        name: 'Lead Seq B T2 - What Made You Reach Out',
        body: '<p>Hi {{contact.first_name}},</p><p>You saw something, clicked through, and filled in the form.</p>',
        bodyUnavailable: null,
      }],
    },
  };
  const { lanes } = buildAnalysisBriefs({ measurement, internal: withCopy, profile });
  const nurture = lanes.conversationCopyAi.sequences.find((s) => s.workflow === '08 Long Term Nurture');
  const email = nurture.messages.find((m) => m.channel === 'email');

  assert.equal(email.bodySource, 'library_template');
  assert.match(email.body, /You saw something, clicked through/u);
  assert.equal(email.templateName, 'Lead Seq B T2 - What Made You Reach Out');
  assert.equal(email.bodyUnavailable, null);
  // Not inline, and yet fully readable. Collapsing those two facts would hide the entire gain.
  assert.equal(email.bodyIsInline, false);
  assert.equal(nurture.messagesWithNoInlineBody, 1);
  assert.equal(nurture.messagesWithUnreadableBody, 0);

  const { copyCoverage } = lanes.conversationCopyAi;
  assert.equal(copyCoverage.emailsFromLibrary, 1);
  assert.equal(copyCoverage.emailsUnreadable, 0);
  assert.equal(copyCoverage.libraryCollection.ran, true);
  assert.equal(copyCoverage.libraryCollection.libraryTotal, 59);
});

test('without the copy collection lane 3 is told how much it cannot read, and why', () => {
  const { lanes } = buildAnalysisBriefs({ measurement, internal, profile });
  const { copyCoverage } = lanes.conversationCopyAi;

  // The fixture's nurture email points at no template at all, so it is honestly unreadable.
  assert.equal(copyCoverage.emailsUnreadable, 1);
  assert.equal(copyCoverage.libraryCollection.ran, false);
  assert.match(copyCoverage.libraryCollection.reason, /not read for this run/u);
  const nurture = lanes.conversationCopyAi.sequences.find((s) => s.workflow === '08 Long Term Nurture');
  const email = nurture.messages.find((m) => m.channel === 'email');
  assert.equal(email.bodySource, 'unavailable');
  // A REASON, never a bare absence: an unreadable email must not read as an empty one.
  assert.equal(email.bodyUnavailable, 'NO_TEMPLATE_REFERENCE');
});

test('lane 3 hands over the AI prompts as copy, and the channel behaviour to judge them against', () => {
  const { lanes } = buildAnalysisBriefs({ measurement, internal, profile });
  const { aiAgents, engagement } = lanes.conversationCopyAi;
  assert.equal(aiAgents.available, true);
  assert.equal(aiAgents.surfaces.conversation_ai.agents[0].name, 'Arthur');
  assert.deepEqual(aiAgents.surfaces.conversation_ai.agents[0].channels, ['SMS']);
  // The AI's channels only mean something next to where conversations actually end.
  assert.deepEqual(engagement.lastMessageDirection, { outbound: 156, inbound: 17 });
  assert.equal(engagement.conversationsWithAnyManualMessage.absent, 76);
});

test('the briefs are deterministic and identify themselves', () => {
  const first = buildAnalysisBriefs({ measurement, internal, profile });
  const second = buildAnalysisBriefs({ measurement, internal, profile });
  assert.equal(first.briefsHash, second.briefsHash);
  assert.match(first.briefsHash, /^[a-f0-9]{64}$/u);
  // A finding is only reproducible against the exact brief that produced it.
  const withoutRail = buildAnalysisBriefs({ measurement, internal: null, profile });
  assert.notEqual(withoutRail.briefsHash, first.briefsHash);
});

test('plainText survives the entities a real GHL email body carries', () => {
  assert.equal(
    plainText('<p>Show Rate (&gt;85%)</p><br/><p>Tom &amp; Grant&#39;s &quot;system&quot;</p>'),
    'Show Rate (>85%)\n\nTom & Grant\'s "system"',
  );
  assert.equal(plainText(undefined), '');
});
