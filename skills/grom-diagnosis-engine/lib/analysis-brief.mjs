/**
 * THE THREE ANALYSIS LANES' INPUT, BUILT BY THE TOOL AND NOT BY A PERSON.
 *
 * `PRODUCT-SPEC.md`: the auditor decides what to analyse and is never told. All three lanes run
 * every time. This module is what makes that possible: it turns the sealed evidence into the three
 * briefs, deterministically, with no human choosing a lane or a metric.
 *
 *   1. lead_journey_kpi        where leads drop out, and which stage is the largest commercial leak
 *   2. workflow_config_runtime how the automation is designed AND what happened when contacts hit it
 *   3. conversation_copy_ai    the actual copy, cadence, channels and AI behaviour
 *
 * ---------------------------------------------------------------------------------------------
 * WHY A BRIEF AT ALL, RATHER THAN HANDING OVER THE RAW EVIDENCE.
 *
 * Two reasons, and the second one is the important one.
 *
 * The evidence set is large and mostly structural. An analyst handed 27 workflow exports spends its
 * effort re-deriving the step graph instead of judging it.
 *
 * And a number cannot be judged without the situation. 21% show is one thing for cold Meta
 * lead-form traffic into a founder call and another for warm referrals. Worse, Grom's own pipeline
 * reserves `won` for PAYING clients and leaves trialing clients as `open`, so an analyst reading
 * that account cold concludes it closes nothing. Every brief therefore carries `situation` from the
 * coverage profile, including its `knownDataCaveats`, and those caveats are not decoration: they are
 * the difference between a diagnosis and a confidently wrong one.
 * ---------------------------------------------------------------------------------------------
 *
 * NOTHING HERE JUDGES ANYTHING. It selects, shapes and states limits. Every count comes from the
 * measurement bundle or the internal evidence unchanged, and the module is pure and deterministic
 * because the kernel checkpoints and byte-compares whatever it is folded into.
 */
import { canonicalJson, sha256 } from './canonical.mjs';

const BRIEF_SCHEMA = '1.0.0';

/** The six questions the product exists to answer. Every lane carries them; none may drop one. */
export const THE_QUESTIONS = Object.freeze([
  'Why are leads not responding to nurture messages?',
  'Why are leads not engaging with the AI agent?',
  'Why are leads not booking appointments?',
  'Why are booked leads not showing up?',
  'Why are cancelled and no-show leads not rebooking?',
  'Why are leads not progressing through the sales journey?',
]);

function codedError(code, ErrorType = Error) {
  return Object.assign(new ErrorType(code), { code });
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function byteOrder(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** HTML to readable text. The copy is what lane 3 judges, so it has to arrive readable. */
export function plainText(html) {
  return String(html ?? '')
    /*
     * STYLE AND SCRIPT BLOCKS GO FIRST, contents and all.
     *
     * Stripping tags alone leaves the CSS TEXT behind, so the first library template read from the
     * live account handed the copywriter
     * "A quick thought body, table, td, p, a, h1, h2, h3, span, div { font-family: 'Montserrat'..."
     * as if it were the email. A marketing template is mostly `<style>`, so this is not a corner
     * case: it is what every fetched body looks like without this line.
     */
    .replaceAll(/<(style|script)\b[^>]*>[\s\S]*?<\/\1>/giu, ' ')
    .replaceAll(/<!--[\s\S]*?-->/gu, ' ')
    .replaceAll(/<br\s*\/?>/giu, '\n')
    .replaceAll(/<\/(?:p|div|tr|h[1-6])>/giu, '\n')
    .replaceAll(/<[^>]+>/gu, '')
    .replaceAll('&nbsp;', ' ')
    .replaceAll('&amp;', '&')
    .replaceAll('&#39;', "'")
    .replaceAll('&quot;', '"')
    .replaceAll('&gt;', '>')
    .replaceAll('&lt;', '<')
    .replaceAll(/[ \t]{2,}/gu, ' ')
    /*
     * BLANK LINES OUT, and this is not cosmetics.
     *
     * A real template is a nest of layout tables, so every `</td>` and `</tr>` became a newline and
     * one live email arrived as "No problem |  |  |  |  | at all." with the sentence split across
     * dozens of empty lines. An analyst asked to judge an opening angle cannot read that, and a
     * model asked to QUOTE it will quote the layout.
     */
    .split('\n')
    .map((line) => line.trim())
    // A run of blank lines becomes ONE, not none. Dropping them all was the first attempt and it
    // destroyed the paragraph breaks too, which are real structure a copywriter judges.
    .filter((line, index, lines) => line.length > 0 || (index > 0 && lines[index - 1].trim().length > 0))
    .join('\n')
    .trim();
}

function observation(surfaces, capability, observationId) {
  const surface = (surfaces ?? []).find((entry) => entry.capability === capability);
  const found = surface?.observations.find((entry) => entry.observationId === observationId);
  return found ?? null;
}

/** Every declared KPI with its state and the reason it has one, not only the ones that computed. */
function kpiTable(metrics) {
  return Object.fromEntries(Object.entries(metrics?.metrics ?? {}).map(([window, edges]) => [
    window,
    Object.fromEntries(Object.entries(edges).map(([edgeId, cell]) => [edgeId, {
      state: cell.state,
      reasonCode: cell.reasonCode ?? null,
      numerator: cell.numerator ?? null,
      denominator: cell.denominator ?? null,
      eligible: cell.eligible ?? null,
      excluded: cell.excluded ?? null,
      immature: cell.immature ?? null,
      rate: cell.rate ?? null,
      value: cell.value ?? null,
    }])),
  ]));
}

/**
 * THE OWNER'S TARGETS, PAIRED WITH WHAT THE ACCOUNT ACTUALLY READS.
 *
 * The line this walks is the whole reason the feature is safe. Nothing here JUDGES: it does not
 * decide a gap is bad, it does not rank one, and no code anywhere fires a finding because a rate sits
 * under a target. It subtracts two numbers the expert can already see and states which is which.
 *
 * Why targets exist at all, when the standing rule is that the expert IS the benchmark authority: a
 * benchmark and a target are different things. A benchmark is what a competent operation in this
 * situation achieves, and an expert must keep supplying that independently. A target is what this
 * business has decided to aim at, which is a commercial choice no evidence reveals. Grom's own show
 * rate should be measured against 65% while it gives strategy calls away free and 85% if it ever
 * charges a deposit, and nothing in the account says which of those it has chosen.
 *
 * A target on an edge that has NO METRIC is reported, not dropped. "We are trying to hit this and
 * cannot currently tell whether we do" is one of the more useful things this product can say.
 */
function targetTable({ situation, metrics }) {
  const table = metrics?.metrics ?? {};
  return (situation?.targets ?? []).map((target) => {
    const perWindow = {};
    let measuredAnywhere = false;
    for (const [window, edges] of Object.entries(table)) {
      const cell = isPlainObject(edges) ? edges[target.edgeId] : undefined;
      if (cell === undefined) continue;
      measuredAnywhere = true;
      perWindow[window] = {
        state: cell.state,
        reasonCode: cell.reasonCode ?? null,
        rate: cell.rate ?? null,
        numerator: cell.numerator ?? null,
        denominator: cell.denominator ?? null,
        // Positive is above target. Null when the rate did not compute, which is NOT zero.
        gapToTarget: typeof cell.rate === 'number' ? Number((cell.rate - target.target).toFixed(4)) : null,
      };
    }
    return {
      ...target,
      declaredAsMetric: measuredAnywhere,
      windows: perWindow,
      ...(measuredAnywhere ? {} : {
        note: 'This target names a journey step that this account does not currently measure, so whether it is being hit is unknown rather than missed.',
      }),
    };
  });
}

/** How the targets must be READ, carried next to them so no prompt can drop the framing. */
export const TARGET_FRAMING = Object.freeze([
  'The `targets` block is what the OWNER of this business has decided to aim at. It is NOT an industry standard and it is NOT a benchmark, and nothing has judged the account against it.',
  'You are still the benchmark authority. State what a competent operation in this exact situation achieves, in numbers, from your own knowledge and BEFORE you look at the target. Then say where reality sits against both.',
  'If a target is unrealistic or too soft for this situation, say so plainly and say why. Disagreeing with it is part of the job, and `basis` on every target tells you where the number came from so you can argue with it.',
  'A target on a step with `declaredAsMetric: false` is not being missed. It is not being measured, which is a different problem with a different fix.',
]);

/**
 * The step graph, from where `export_workflow` really keeps it.
 *
 * OBSERVED: `data.workflow.workflowData.templates[]`, each with `type`, `next`, `order`, `name` and
 * `attributes`. NOT `get_workflow`, which returns a seven-field summary with no steps at all.
 */
function stepsOf(workflow) {
  const templates = workflow?.definition?.data?.workflow?.workflowData?.templates;
  return Array.isArray(templates)
    ? [...templates].sort((left, right) => (left.order ?? 0) - (right.order ?? 0))
    : [];
}

function definitionOf(workflow) {
  return workflow?.definition?.data?.workflow ?? null;
}

function tally(values) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return Object.fromEntries([...counts.entries()].sort(
    (left, right) => right[1] - left[1] || byteOrder(left[0], right[0]),
  ));
}

/**
 * WHICH WORKFLOWS CAN BE LIVE ON THE SAME CONTACT AT ONCE.
 *
 * The spec names "duplicate or conflicting automation" and "differences between the intended journey
 * and the actual customer experience" as things lane 2 must examine. Neither is visible one workflow
 * at a time, and both are computable: two workflows collide when they can be enrolled from the same
 * trigger, or when one creates the entity the other triggers on, and nothing removes the contact
 * from the first.
 *
 * This states the FACTS of the overlap and does not judge it. A deliberate parallel pair and an
 * accidental one look identical here, which is the analyst's job to tell apart. What it does supply
 * is the thing that decides which it is: whether a `remove_from_workflow` covers the pair, and
 * whether the sequence stops when the lead replies.
 */
function collisionMap(workflows) {
  const rows = workflows.map((workflow) => {
    const definition = definitionOf(workflow);
    const steps = stepsOf(workflow);
    const removes = steps
      .filter((step) => step.type === 'remove_from_workflow')
      .map((step) => step.name ?? '')
      .filter((name) => name.length > 0);
    return {
      name: definition?.name ?? workflow.workflowId,
      triggerTypes: (workflow?.definition?.data?.triggers ?? [])
        .map((trigger) => trigger.type)
        .filter((type) => typeof type === 'string')
        .sort(byteOrder),
      /*
       * THE WHOLE TRIGGER, filters included, and the reason is a false finding this produced.
       *
       * The collector used to keep `trigger.type` alone. `07 Send Contract` and `07.5 Contract Signed`
       * both have type `proposal_estimate_update`, so the evidence said they listen to the same event
       * and an expert correctly concluded from it that a signed client could be chased for a signature.
       * The owner's answer: their FILTERS differ, one fires on sent and the other on signed. The
       * expert reasoned properly from evidence I had truncated.
       *
       * Passed through whole rather than projected onto a guessed field name, so whatever this platform
       * calls a trigger's conditions, the expert sees them.
       */
      triggers: workflow?.definition?.data?.triggers ?? [],
      // What this workflow CREATES that another might trigger on. `internal_create_opportunity`
      // firing while another workflow triggers on `opportunity_created` is a real chain, and it is
      // the one that put two email sequences on the same Grom UK lead at once.
      creates: [...new Set(steps
        .map((step) => step.type)
        .filter((type) => /^internal_create_|^add_contact_tag$/u.test(String(type))))].sort(byteOrder),
      removesFromWorkflows: removes,
      stopOnResponse: definition?.stopOnResponse ?? null,
      allowMultiple: definition?.allowMultiple ?? null,
      messageSteps: steps.filter((step) => ['email', 'sms'].includes(step.type)).length,
    };
  });

  const sharedTrigger = new Map();
  for (const row of rows) {
    for (const trigger of row.triggerTypes) {
      if (!sharedTrigger.has(trigger)) sharedTrigger.set(trigger, []);
      sharedTrigger.get(trigger).push(row.name);
    }
  }
  const creationChains = [];
  for (const producer of rows) {
    for (const consumer of rows) {
      if (producer.name === consumer.name) continue;
      const chained = producer.creates.includes('internal_create_opportunity')
        && consumer.triggerTypes.includes('opportunity_created');
      const tagged = producer.creates.includes('add_contact_tag')
        && consumer.triggerTypes.includes('contact_tag');
      if (chained || tagged) {
        creationChains.push({
          producer: producer.name,
          consumer: consumer.name,
          via: chained ? 'internal_create_opportunity -> opportunity_created' : 'add_contact_tag -> contact_tag',
          consumerStopsOnResponse: consumer.stopOnResponse,
          consumerMessageSteps: consumer.messageSteps,
        });
      }
    }
  }
  return {
    perWorkflow: rows.sort((left, right) => byteOrder(left.name, right.name)),
    /*
     * SHARING A TRIGGER TYPE IS NOT SHARING A TRIGGER. Two workflows on `proposal_estimate_update` may
     * fire on completely different document states. This lists what can be computed from the type and
     * says so; the per-workflow `triggers` carry the filters that decide it.
     */
    sharedTriggerTypeCaveat: 'These workflows share a trigger TYPE. They may still fire on different events, because a trigger can carry filters. Read the `triggers` on each workflow before calling this a collision.',
    workflowsSharingATrigger: Object.fromEntries(
      [...sharedTrigger.entries()]
        .filter(([, names]) => names.length > 1)
        .map(([trigger, names]) => [trigger, names.sort(byteOrder)])
        .sort((left, right) => byteOrder(left[0], right[0])),
    ),
    // One workflow creating what another triggers on. Ordered so the same account always reads the
    // same way.
    creationChains: creationChains.sort(
      (left, right) => byteOrder(left.producer, right.producer) || byteOrder(left.consumer, right.consumer),
    ),
  };
}

/**
 * WHAT SHARE OF THE CUSTOMER-FACING COPY THIS LANE CAN READ.
 *
 * The single most useful number about a copy analysis, and the one whose absence let the copywriter
 * lane judge 63 of 126 messages on their subject line alone without ever saying so.
 */
function copyCoverageOf(sequences, internal) {
  const messages = sequences.flatMap((sequence) => sequence.messages);
  const emails = messages.filter((message) => message.channel === 'email');
  const bySource = (source) => emails.filter((message) => message.bodySource === source).length;
  const collection = internal?.emailCopy ?? null;
  return {
    messagesTotal: messages.length,
    smsReadable: messages.filter((message) => message.channel === 'sms' && message.body.length > 0).length,
    emailsTotal: emails.length,
    emailsInline: bySource('inline'),
    emailsFromLibrary: bySource('library_template'),
    emailsUnreadable: bySource('unavailable'),
    // Why any are unreadable, taken from the collection rather than inferred from the absence.
    libraryCollection: collection === null
      ? { ran: false, reason: 'The email library was not read for this run, so no library template body is available.' }
      : {
          ran: true,
          complete: collection.complete === true,
          requestedCount: collection.requestedCount ?? null,
          libraryTotal: collection.libraryTotal ?? null,
          limitations: [...(collection.limitations ?? [])],
        },
  };
}

/**
 * THE OTHER HALF OF THE CONVERSATION — what the leads themselves wrote.
 *
 * Everything else on this lane is copy the ACCOUNT produced. These are real threads, both
 * directions, drawn by `lib/sampling.mjs` with every complaint and opt-out included by
 * construction. They are the only evidence in the system that can answer "what did people actually
 * say, and what did we never answer".
 *
 * The coverage block is not decoration. A sample is a claim about a population, and a lane that
 * does not know whether it read the whole week or fifty threads out of four hundred will write
 * "leads never ask about price" when what happened is that it read fifty threads.
 */
function conversationsOf(internal) {
  const collection = internal?.conversationTranscripts ?? null;
  if (collection === null) {
    return {
      ran: false,
      reason: 'Conversation transcripts were not collected for this run. You can see the copy this account SENDS, and nothing a lead replied.',
      threads: [],
    };
  }
  const mode = collection.sample?.mode ?? 'UNKNOWN';
  return {
    ran: true,
    complete: collection.complete === true,
    // CENSUS means every thread in the window is below; SAMPLE means it is not.
    mode,
    universeCount: collection.universeCount ?? null,
    messageCount: collection.messageCount ?? null,
    sampledCount: collection.sampledCount ?? (collection.transcripts ?? []).length,
    droppedForSizeCount: collection.droppedForSizeCount ?? 0,
    unparsedMessageCount: collection.unparsedMessageCount ?? 0,
    limitations: [...(collection.limitations ?? [])],
    /*
     * Stated as a sentence and not only as fields, because this is the one place a lane most
     * reliably overclaims, and the sentence is what ends up quoted back in a finding.
     */
    howToReadThis: mode === 'CENSUS'
      ? 'Every conversation in the window is below. A count you take from these threads is the real count for the week.'
      : `These are ${collection.sampledCount ?? 0} threads drawn from ${collection.universeCount ?? 0}. Every complaint and opt-out the flagging caught is included, so complaints are OVER-represented on purpose. Never turn a count of these threads into a rate for the account: say "in the sampled threads".`,
    threads: [...(collection.transcripts ?? [])],
  };
}

/**
 * Every message a lead can receive, in send order, with the accumulated wait in front of it.
 *
 * BRANCH LEGS ARE FLATTENED, and that limitation is stated on the brief rather than hidden: a
 * sequence listing 16 messages may send 8 down either leg. Counts are therefore CEILINGS. Getting
 * this wrong in the other direction would be worse, because a lane that under-counted would clear a
 * sequence that is in fact double-messaging.
 */
function messagesOf(workflow, emailCopy = null) {
  const messages = [];
  let waiting = [];
  for (const step of stepsOf(workflow)) {
    const attributes = step.attributes ?? {};
    if (step.type === 'wait') {
      const after = attributes.startAfter;
      waiting.push(isPlainObject(after) && after.value !== undefined
        ? `${after.value} ${after.type}${after.when ? ` ${after.when}` : ''}`
        : String(step.name ?? 'wait'));
      continue;
    }
    if (step.type === 'email') {
      const inline = plainText(attributes.html);
      /*
       * A send step with no inline HTML points at a LIBRARY TEMPLATE, and the template's copy is
       * collected separately (`lib/adapters/email-copy.mjs`). Resolved here so the analyst reads one
       * sequence with the bodies in it rather than being handed a second list to join by hand.
       *
       * `bodySource` is the honest part. `inline`, `library` and `unavailable` are three different
       * facts, and an analyst that cannot tell them apart will read an unreadable email as an empty
       * one and call the sequence thin when it is not.
       */
      const templateId = typeof attributes.template_id === 'string' && attributes.template_id.length > 0
        ? attributes.template_id
        : null;
      const fromLibrary = inline.length === 0 && templateId !== null
        ? emailCopy?.get(templateId) ?? null
        : null;
      const libraryBody = typeof fromLibrary?.body === 'string' ? plainText(fromLibrary.body) : '';
      messages.push({
        order: step.order ?? null,
        channel: 'email',
        waitBefore: [...waiting],
        from: `${attributes.from_name ?? ''} <${attributes.from_email ?? ''}>`.trim(),
        subject: attributes.subject ?? null,
        preHeader: attributes.preHeader ?? null,
        body: inline.length > 0 ? inline : libraryBody,
        bodyIsInline: inline.length > 0,
        bodySource: inline.length > 0
          ? 'inline'
          : libraryBody.length > 0 ? 'library_template' : 'unavailable',
        ...(inline.length > 0 ? {} : {
          templateName: fromLibrary?.name ?? null,
          // Why it cannot be read, when it cannot. Never a bare absence.
          bodyUnavailable: libraryBody.length > 0
            ? null
            : fromLibrary?.bodyUnavailable ?? (templateId === null ? 'NO_TEMPLATE_REFERENCE' : 'TEMPLATE_NOT_COLLECTED'),
        }),
      });
      waiting = [];
    } else if (step.type === 'sms') {
      messages.push({
        order: step.order ?? null,
        channel: 'sms',
        waitBefore: [...waiting],
        body: String(attributes.message ?? attributes.body ?? attributes.text ?? '').trim(),
        bodyIsInline: Boolean(attributes.message ?? attributes.body ?? attributes.text),
      });
      waiting = [];
    } else if (['if_else', 'goto', 'remove_from_workflow', 'workflow_goal', 'workflow_ai_intent_detection', 'workflow_split'].includes(step.type)) {
      // A branch marker, not a delay. It tells the analyst where the flattening happened.
      waiting.push(`[${step.type}: ${step.name ?? ''}]`);
    }
  }
  return messages;
}

/**
 * The runtime half of lane 2. Only what the composite actually reported, and it says which
 * workflows were never asked about at all -- "we did not look" and "we looked and it was quiet" are
 * different facts, and an analyst told the second when the first is true will clear a broken step.
 */
function runtimeOf(workflow) {
  const window = workflow?.runtimeWindow?.data;
  if (!isPlainObject(window)) {
    return { requested: workflow?.runtimeCode !== 'RUNTIME_NOT_REQUESTED', code: workflow?.runtimeCode ?? null };
  }
  return {
    requested: true,
    code: null,
    complete: window.complete ?? null,
    truncated: window.truncated ?? null,
    warnings: (window.warnings ?? []).map(({ code, component }) => ({ code, component })),
    observedEventTypes: window.observedEventTypes ?? null,
    retainedEvents: Array.isArray(window.runtimeEvents) ? window.runtimeEvents.length : null,
    // Where contacts are parked right now. The spec's "contacts becoming stuck at particular steps".
    perStepCounts: Array.isArray(window.perStepCounts) ? window.perStepCounts : null,
    // The rail's own refusal to let anyone claim this config governed these events.
    configurationBinding: window.configurationBinding ?? null,
  };
}

function aiAgentsOf(internal) {
  const components = internal?.aiConfiguration?.data?.components ?? internal?.aiConfiguration?.components;
  if (!isPlainObject(components)) return { available: false, reason: 'AI_BUNDLE_UNAVAILABLE' };
  return {
    available: true,
    surfaces: Object.fromEntries(Object.entries(components).map(([surface, component]) => [surface, {
      applicable: component?.applicable ?? null,
      complete: component?.complete ?? null,
      // The prompts are the COPY of the conversational half and lane 3 judges them as copy.
      agents: (Array.isArray(component?.items) ? component.items : []).map((item) => item.detail ?? item.row ?? item),
    }])),
  };
}

/**
 * Build all three lane briefs plus the shared header.
 *
 * `measurement` is the bundle `analyzer.normalize` produces. `internal` is the internal evidence
 * record, or `null` when the rail is off -- in which case lanes 2 and 3 say so explicitly rather
 * than arriving empty and being read as "nothing wrong with the automation".
 */
export function buildAnalysisBriefs({ measurement, internal = null, profile } = {}) {
  if (!isPlainObject(measurement)) throw codedError('ANALYSIS_BRIEF_MEASUREMENT_INVALID', TypeError);
  if (!isPlainObject(profile)) throw codedError('ANALYSIS_BRIEF_PROFILE_INVALID', TypeError);

  const situation = profile.situation ?? null;
  const surfaces = measurement.surfaceObservations ?? [];
  const workflows = Array.isArray(internal?.workflows) ? internal.workflows : [];
  const railOff = internal === null;

  const header = {
    schemaVersion: BRIEF_SCHEMA,
    profileId: measurement.profileId,
    window: measurement.collectionWindow,
    collectionMode: measurement.collectionMode,
    situation,
    questionsToAnswer: [...THE_QUESTIONS],
    provenanceLimits: [
      ...(situation?.knownDataCaveats ?? []),
      'Nothing on the internal rail proves the workflow configuration read here was the configuration in force during the window. A configuration may be called CONSISTENT WITH an outcome, or said to produce one going forward. It may not be said to have caused a past outcome.',
      ...((measurement.unmeasurableEdges ?? []).length > 0
        ? [`Journey steps with no signal at all in this evidence: ${(measurement.unmeasurableEdges ?? []).join(', ')}.`]
        : []),
      ...((railOff) ? ['The internal rail was OFF for this run, so no workflow configuration or runtime evidence exists. Lanes 2 and 3 cannot be answered and must say so rather than reporting nothing wrong.'] : []),
      ...((internal !== null && internal.complete !== true)
        ? [`The internal collection was incomplete: ${(internal.limitations ?? []).join(', ') || 'reason not stated'}.`]
        : []),
    ],
  };

  const targets = targetTable({ situation, metrics: measurement.metrics });

  const leadJourneyKpi = {
    lane: 'lead_journey_kpi',
    ...header,
    remit: 'Reconstruct the journey, find where leads drop out, and name which stage is the largest commercial leak. Judge every rate against standard practice for the situation above.',
    kpis: kpiTable(measurement.metrics),
    targets,
    howToReadTargets: [...TARGET_FRAMING],
    kpiCoverage: {
      declared: Object.values(kpiTable(measurement.metrics))[0]
        ? Object.keys(Object.values(kpiTable(measurement.metrics))[0]).length
        : 0,
      withNoSignalAtAll: (measurement.unmeasurableEdges ?? []).length,
    },
    volumes: measurement.collection,
    projection: measurement.projection,
    observations: surfaces,
    graph: {
      nodes: measurement.graph?.nodes?.length ?? null,
      edges: measurement.graph?.edges?.length ?? null,
      conflicts: measurement.graph?.conflicts?.length ?? null,
      unresolvedJoins: measurement.graph?.unresolvedJoins?.length ?? null,
    },
    windows: measurement.windows,
  };

  const workflowConfigRuntime = {
    lane: 'workflow_config_runtime',
    ...header,
    remit: 'Examine how the automation is DESIGNED and what HAPPENED when contacts entered it. Triggers and enrollment, message order and timing, wait steps and gaps, branches and handoffs, duplicate or conflicting automation, contacts stuck at a step, steps that did not execute, and any difference between the intended journey and the actual customer experience.',
    railAvailable: !railOff,
    workflowCount: workflows.length,
    roster: internal?.roster ?? null,
    // Facts about overlap, computed rather than eyeballed. See `collisionMap`.
    collisions: collisionMap(workflows),
    workflows: workflows.map((workflow) => {
      const definition = definitionOf(workflow);
      const steps = stepsOf(workflow);
      return {
        name: definition?.name ?? workflow.workflowId,
        status: definition?.status ?? null,
        definitionReadable: definition !== null,
        definitionCode: workflow.definitionCode ?? null,
        stepCount: steps.length,
        stepTypes: tally(steps.map((step) => step.type)),
        triggers: workflow?.definition?.data?.triggers ?? [],
        allowMultiple: definition?.allowMultiple ?? null,
        timezone: definition?.timezone ?? null,
        stopOnResponse: definition?.stopOnResponse ?? null,
        removeContactFromLastStep: definition?.removeContactFromLastStep ?? null,
        // A snapshot import has never been re-verified against this account's actual journey.
        snapshotImported: definition?.workflowNote?.createdBy === 'snapshot',
        // Configured cadence, so timing can be judged without re-reading the step graph.
        waits: steps.filter((step) => step.type === 'wait').map((step) => step.name ?? null),
        runtime: runtimeOf(workflow),
      };
    }).sort((left, right) => byteOrder(left.name, right.name)),
  };

  /*
   * The library copy, indexed by template id, so `messagesOf` can resolve a send step's
   * `template_id` into the words the lead actually receives. Empty when the collection did not run,
   * in which case every library email degrades to `bodySource: 'unavailable'` with a reason.
   */
  const emailCopyIndex = new Map(
    (Array.isArray(internal?.emailCopy?.templates) ? internal.emailCopy.templates : [])
      .filter((entry) => isPlainObject(entry) && typeof entry.templateId === 'string')
      .map((entry) => [entry.templateId, entry]),
  );

  const sequences = workflows
    .map((workflow) => {
      const definition = definitionOf(workflow);
      const messages = messagesOf(workflow, emailCopyIndex);
      if (messages.length === 0) return null;
      return {
        workflow: definition?.name ?? workflow.workflowId,
        triggers: workflow?.definition?.data?.triggers ?? [],
        stopOnResponse: definition?.stopOnResponse ?? null,
        timezone: definition?.timezone ?? null,
        messageCount: messages.length,
        emails: messages.filter((message) => message.channel === 'email').length,
        smss: messages.filter((message) => message.channel === 'sms').length,
        /*
         * TWO different counts, and keeping both is the point. Before the library copy was
         * collected these were the same number, so "not inline" was a synonym for "cannot be read".
         * It is not any more: a library template we successfully fetched is not inline AND is fully
         * readable, and collapsing the two would hide the entire gain.
         */
        messagesWithNoInlineBody: messages.filter((message) => message.bodyIsInline === false).length,
        messagesWithUnreadableBody: messages.filter((message) => message.bodySource === 'unavailable').length,
        messages,
      };
    })
    .filter((sequence) => sequence !== null)
    .sort((left, right) => right.messageCount - left.messageCount || byteOrder(left.workflow, right.workflow));

  const conversationCopyAi = {
    lane: 'conversation_copy_ai',
    ...header,
    remit: 'Judge the actual customer-facing communications: copy, opening angles, calls to action, offer clarity, timing and frequency, channel choice, conversation friction, and the AI agents\' instructions as COPY and not only as configuration. Quote what you judge.',
    railAvailable: !railOff,
    // What the account observably does on each channel, so copy is judged against behaviour.
    engagement: {
      lastMessageDirection: observation(surfaces, 'conversations', 'last_message_direction')?.values ?? null,
      lastOutboundWasAutomatedOrManual: observation(surfaces, 'conversations', 'last_outbound_action')?.values ?? null,
      channelOfLastMessage: observation(surfaces, 'conversations', 'last_message_channel')?.values ?? null,
      conversationsWithAnyManualMessage: observation(surfaces, 'conversations', 'has_manual_message'),
      appointmentsBookedVia: observation(surfaces, 'appointments', 'booked_via')?.values ?? null,
    },
    // How much of the copy this lane can actually read. Stated as a number at the TOP of the brief
    // because a copywriter that does not know its own coverage will call a sequence thin when what
    // happened is that we could not fetch half of it.
    copyCoverage: copyCoverageOf(sequences, internal),
    sequences,
    aiAgents: aiAgentsOf(internal),
    // Real threads, both directions. See `conversationsOf`.
    conversations: conversationsOf(internal),
    limits: [
      'MESSAGE COUNTS PER SEQUENCE ARE CEILINGS. Branch legs are flattened, so a sequence listing 16 messages may send 8 down either leg. `waitBefore` entries in square brackets mark a branch point, not a delay.',
      'Read `bodySource` on every email. `inline` means the copy is written into the workflow. `library_template` means the step points at a library template and its copy WAS fetched, so it is complete and you judge it exactly as you would an inline one. `unavailable` means the body could not be read at all and `bodyUnavailable` says why: judge those on subject, preheader, sender and placement only, and say so explicitly.',
      'No open, click or bounce statistics exist in this evidence. REPLIES do: `conversations.threads` carries real inbound messages. Read `conversations.howToReadThis` before you count anything in them, and never state a rate from a sample.',
      '`sequences` is what this account SENDS. `conversations.threads` is what actually happened. When the two disagree, the threads win: a sequence that looks well written and produces silence is a finding, not a well-written sequence.',
    ],
  };

  const lanes = { conversationCopyAi, leadJourneyKpi, workflowConfigRuntime };
  return {
    schemaVersion: BRIEF_SCHEMA,
    // The identity of what the lanes were asked. A finding is only reproducible against the exact
    // brief that produced it, and `lib/report.mjs` re-derives the mechanism pipeline from sealed
    // inputs, so the briefs need a stable name.
    briefsHash: sha256(lanes),
    lanes,
  };
}
