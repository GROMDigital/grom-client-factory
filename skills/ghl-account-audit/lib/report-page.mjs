/**
 * THE REPORT PAGE — the whole audit as one document somebody will actually read.
 *
 * The run already produces `BACKLOG.md`, `INVESTIGATION.md`, `PLAN.md`, 19 reviews and one package per
 * problem. That is the right set of artefacts and the wrong reading experience: understanding a run
 * meant opening six folders and reading raw markdown, so the findings were good and nobody looked at
 * them.
 *
 * This is generated, never hand-written, and that is the owner's call: every run produces one
 * automatically and it cannot drift from the findings, because it is rendered from the same sealed
 * artefacts the markdown is rendered from. The prose in it is the EXPERTS' OWN WORDS -- their titles,
 * their fixes, their plan paragraph -- rather than a summary of them, so nothing here is a fourth
 * opinion about the account.
 *
 * ---------------------------------------------------------------------------------------------
 * IT IS EVIDENCE, NOT PUBLICATION. It quotes real message copy and names real workflows, so it is
 * written into the investigation directory alongside the rest of the private material and it must
 * never be published to a hosted URL or shared outside the operator. `lib/publication-safety.mjs`
 * governs what may leave; this file is not in that set.
 *
 * WRITTEN AT THE END OF THE CHAIN, in `runWorkOrder`, because that is the first moment every input
 * exists: the plan is stage 5's answer and the artefacts here are write-once, so a page written at
 * stage 4 could never be updated to include it. A run that stops before stage 5 still has all the
 * markdown.
 *
 * SELF-CONTAINED, no external anything. It is opened as a local file, where a CDN request fails and a
 * link to a `.md` file dumps raw text into a browser tab. Diagrams are HTML and CSS for the same
 * reason: a diagramming library would need a network fetch to render.
 * ---------------------------------------------------------------------------------------------
 */
import { sha256 } from './canonical.mjs';

export const REPORT_PAGE_SCHEMA = '1.0.0';

/** Everything account-derived goes through this. A workflow name can contain anything at all. */
function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

const BANDS = Object.freeze({ NONE: 0, LOW: 1, MEDIUM: 2, HIGH: 3, CRITICAL: 4 });

function worstBand(cause, key) {
  return cause.findings.reduce((held, finding) => (
    (BANDS[finding.scoring?.[key]] ?? 0) > (BANDS[held] ?? 0) ? finding.scoring[key] : held
  ), 'NONE');
}

function percent(rate) {
  return typeof rate === 'number' ? `${Math.round(rate * 100)}%` : null;
}

/**
 * The journey, as the money path derived by stage 1.
 *
 * A chain of chips rather than a graph. The money path IS a sequence, so the simplest true picture is
 * a sequence, and it stays readable at nine workflows where a node-and-edge drawing would not.
 */
function moneyPathDiagram(map) {
  const path = map?.moneyPath ?? [];
  if (path.length === 0) return '';
  const jobOf = new Map((map.workflows ?? []).map((entry) => [entry.name, entry.job]));
  return `
  <div class="band">
    <ol class="chain">
      ${path.map((name, index) => `
      <li class="chain-step">
        <span class="chain-n">${index + 1}</span>
        <span class="chain-name">${escapeHtml(name)}</span>
        <span class="chain-job">${escapeHtml(jobOf.get(name) ?? '')}</span>
      </li>`).join('')}
    </ol>
  </div>`;
}

/** What each workflow is for, by the role stage 1 derived. Counts first, because that is the shape. */
function rolesDiagram(map) {
  const workflows = map?.workflows ?? [];
  if (workflows.length === 0) return '';
  const order = ['money_path', 'delivery', 'internal_ops', 'data_hygiene', 'abandoned', 'unclear'];
  const label = {
    money_path: 'Moves a lead toward paying',
    delivery: 'Serves someone who already committed',
    internal_ops: 'Notifies or assigns staff',
    data_hygiene: 'Maintains records',
    abandoned: 'Nobody uses it',
    unclear: 'Could not be determined',
  };
  const grouped = order
    .map((role) => [role, workflows.filter((entry) => entry.role === role)])
    .filter(([, entries]) => entries.length > 0);
  return `
  <div class="roles">
    ${grouped.map(([role, entries]) => `
    <section class="role">
      <h4>${escapeHtml(label[role])} <span class="count">${entries.length}</span></h4>
      <ul class="plain">
        ${entries.map((entry) => `<li>${escapeHtml(entry.name)}${entry.nameMatchesBehaviour === false ? ' <em class="warn">name disagrees with behaviour</em>' : ''}</li>`).join('')}
      </ul>
    </section>`).join('')}
  </div>`;
}

/**
 * The funnel, with the owner's target marked on each bar.
 *
 * A step that could not be measured shows the REASON rather than a zero bar, because a zero-length bar
 * reads as "nobody converted" when the truth is "nobody can tell", and those need different action.
 */
function funnelDiagram({ kpis, targets }) {
  const windows = Object.keys(kpis ?? {});
  if (windows.length === 0) return '';
  // The widest window with any computed rate, so the picture is the most populated one available.
  const chosen = windows
    .map((name) => [name, Object.values(kpis[name]).filter((cell) => typeof cell.rate === 'number').length])
    .sort((left, right) => right[1] - left[1])[0];
  if (!chosen || chosen[1] === 0) return '';
  const [windowName] = chosen;
  const targetFor = new Map((targets ?? []).map((entry) => [entry.edgeId, entry]));
  const rows = Object.entries(kpis[windowName]).map(([edgeId, cell]) => {
    const target = targetFor.get(edgeId);
    const rate = typeof cell.rate === 'number' ? cell.rate : null;
    return `
    <tr>
      <th>${escapeHtml(edgeId)}</th>
      <td class="bar-cell">
        ${rate === null
    ? `<span class="unmeasured">not measurable${cell.reasonCode ? `: ${escapeHtml(cell.reasonCode)}` : ''}</span>`
    : `<span class="bar" style="--w:${Math.round(rate * 100)}%"${target ? ` data-target="${Math.round(target.target * 100)}"` : ''}>
             ${target ? `<i class="target" style="--t:${Math.round(target.target * 100)}%"></i>` : ''}
           </span>`}
      </td>
      <td class="num">${percent(rate) ?? '&mdash;'}</td>
      <td class="num target-col">${target ? percent(target.target) : '&mdash;'}</td>
      <td class="num">${cell.numerator ?? '&mdash;'} / ${cell.denominator ?? '&mdash;'}</td>
    </tr>`;
  });
  return `
  <p class="caption">Window: <code>${escapeHtml(windowName)}</code>. The line on each bar is the target.</p>
  <div class="tablewrap">
    <table class="funnel">
      <thead><tr><th>Step</th><th>Rate</th><th class="num">Actual</th><th class="num">Target</th><th class="num">Of</th></tr></thead>
      <tbody>${rows.join('')}</tbody>
    </table>
  </div>`;
}

/**
 * THE ENROLMENT PICTURE, and it is the clearest single thing in the document.
 *
 * Rendered as producers, the event, then consumers, rather than as a node graph. Five independent
 * experts on the live run traced the account's central defect to one shared event, and what makes that
 * legible is seeing how many things fire it against how many things listen, side by side. A drawn graph
 * of fourteen chains is a hairball.
 */
function collisionDiagram(collisions) {
  const chains = collisions?.creationChains ?? [];
  if (chains.length === 0) return '';
  const byEvent = new Map();
  for (const chain of chains) {
    if (!byEvent.has(chain.via)) byEvent.set(chain.via, { producers: new Set(), consumers: new Map() });
    const entry = byEvent.get(chain.via);
    entry.producers.add(chain.producer);
    entry.consumers.set(chain.consumer, chain);
  }
  return [...byEvent.entries()]
    .sort((left, right) => right[1].consumers.size - left[1].consumers.size)
    .map(([via, { producers, consumers }]) => `
    <div class="chain-map">
      <div class="side">
        <h4>${producers.size} fire this</h4>
        <ul class="plain">${[...producers].sort().map((name) => `<li>${escapeHtml(name)}</li>`).join('')}</ul>
      </div>
      <div class="via"><code>${escapeHtml(via)}</code></div>
      <div class="side">
        <h4>${consumers.size} listen for it</h4>
        <ul class="plain">${[...consumers.entries()].sort().map(([name, chain]) => `
          <li>${escapeHtml(name)}
            ${chain.consumerStopsOnResponse === false ? '<em class="warn">does not stop on reply</em>' : ''}
            ${typeof chain.consumerMessageSteps === 'number' ? `<span class="muted">${chain.consumerMessageSteps} messages</span>` : ''}
          </li>`).join('')}</ul>
      </div>
    </div>`).join('');
}

/**
 * THE SIX QUESTIONS, ANSWERED ONE BY ONE.
 *
 * The product exists to answer six specific questions every week, and until now the report published a
 * ranked list and left a reader to work out for themselves which findings bore on "why are booked leads
 * not showing up". This section is the answer, per question.
 *
 * Findings attach BY ANCHOR, using the question-to-step mapping the profile declares. Nothing is
 * inferred from a title and no model decides the grouping: a finding appears under a question when it
 * anchors to one of that question's journey steps.
 *
 * FOUR HONEST OUTCOMES, and three of them are not "here is the answer":
 *
 *   answered      the step is measured and findings explain it
 *   unmeasured    findings exist, but the step cannot be read, so the size is unknown
 *   none          the step is measured and nobody found anything wrong with it
 *   unanswerable  this account has no step corresponding to the question at all
 *
 * "Nobody could measure this" is a real answer to a business question and a more useful one than an
 * empty heading, so it is stated.
 */
function questionsSection({ questions, questionEdges, kpis, targets, causes, rankOf }) {
  if ((questionEdges ?? []).length === 0) return '';
  const byQuestion = new Map(questionEdges.map((entry) => [entry.question, entry.edgeIds]));
  const targetFor = new Map((targets ?? []).map((entry) => [entry.edgeId, entry]));
  const windows = Object.keys(kpis ?? {});
  const chosen = windows
    .map((name) => [name, Object.values(kpis[name]).filter((cell) => typeof cell.rate === 'number').length])
    .sort((left, right) => right[1] - left[1])[0];
  const cells = chosen ? kpis[chosen[0]] : {};

  return questions.map((question, position) => {
    const number = position + 1;
    const edgeIds = byQuestion.get(number) ?? [];
    const related = causes.filter((cause) => edgeIds.some((edgeId) => cause.anchors.includes(`kpi:${edgeId}`)));
    const measured = edgeIds.filter((edgeId) => typeof cells[edgeId]?.rate === 'number');
    const state = edgeIds.length === 0
      ? 'unanswerable'
      : related.length === 0
        ? 'none'
        : measured.length === 0 ? 'unmeasured' : 'answered';
    const label = {
      answered: `${related.length} ${related.length === 1 ? 'finding' : 'findings'}`,
      unmeasured: 'not measurable',
      none: 'nothing found',
      unanswerable: 'no such step here',
    }[state];

    const numbers = edgeIds.map((edgeId) => {
      const cell = cells[edgeId];
      const target = targetFor.get(edgeId);
      const actual = typeof cell?.rate === 'number' ? percent(cell.rate) : null;
      return `<li><code>${escapeHtml(edgeId)}</code> ${actual === null
        ? `<span class="unmeasured">not measurable${cell?.reasonCode ? `: ${escapeHtml(cell.reasonCode)}` : ''}</span>`
        : `<strong>${actual}</strong>${target ? ` <span class="muted">against a ${percent(target.target)} target</span>` : ''}`}</li>`;
    });

    return `
    <article class="qa q-${state}">
      <h3><span class="qn">Q${number}</span>${escapeHtml(question)} <span class="qstate">${label}</span></h3>
      ${edgeIds.length === 0
    ? '<p class="muted">This account has no journey step corresponding to this question, so the run cannot answer it. That is a gap in what is measured, not a finding about the account.</p>'
    : `<ul class="plain nums">${numbers.join('')}</ul>`}
      ${related.length === 0
    ? (edgeIds.length === 0 ? '' : '<p class="muted">No analyst filed a finding against this step this week.</p>')
    : `<div class="qfindings">${related.map((cause) => `
        <div class="qf">
          <p class="qf-title">#${rankOf.get(cause.causeId)} ${escapeHtml(cause.findings[0]?.title ?? '')}</p>
          ${cause.findings.map((finding) => `<p class="qf-fix">${escapeHtml(finding.fix)}</p>`).join('')}
        </div>`).join('')}</div>`}
    </article>`;
  }).join('');
}

/** The plan, which is the part a reader acts on, so it comes before the detail. */
function planSection(plan, titleOf, rankOf) {
  if (plan === null) {
    return `<p class="note">No running order was produced for this run, so the problems below are in
      ranked order with nothing said about sequencing, prerequisites or conflicts.</p>`;
  }
  return `
  <div class="thisweek">${escapeHtml(plan.thisWeek)}</div>
  ${plan.prerequisites.length === 0 ? '' : `
  <h3>Do these first, or you cannot tell whether the rest worked</h3>
  ${plan.prerequisites.map(({ causeId, blocks, why }) => `
  <div class="prereq">
    <strong>${escapeHtml(titleOf.get(causeId) ?? causeId)}</strong>
    <p>${escapeHtml(why)}</p>
    ${blocks.length === 0 ? '' : `<p class="muted">Blocks ${blocks.map((id) => `#${rankOf.get(id)}`).join(', ')}</p>`}
  </div>`).join('')}`}

  <h3>The batches, in order</h3>
  <ol class="batches">
    ${plan.batches.map((batch) => `
    <li>
      <h4>${escapeHtml(batch.title)}</h4>
      <p class="meta">${escapeHtml(batch.size)}${batch.sameChange ? ', one repeated change' : ''}${batch.blockedBy.length > 0 ? `, after ${batch.blockedBy.map((n) => `batch ${n}`).join(' and ')}` : ''}</p>
      <p>${escapeHtml(batch.rationale)}</p>
      <ul class="plain">${batch.causeIds.map((id) => `<li>#${rankOf.get(id)} ${escapeHtml(titleOf.get(id) ?? id)}</li>`).join('')}</ul>
    </li>`).join('')}
  </ol>
  ${plan.conflicts.length === 0 ? '' : `
  <h3>These pull against each other</h3>
  ${plan.conflicts.map(({ causeIds, why, resolution }) => `
  <div class="conflict">
    <p><strong>${causeIds.map((id) => `#${rankOf.get(id)}`).join(' and ')}</strong>: ${escapeHtml(why)}</p>
    <p class="muted">Resolution: ${escapeHtml(resolution)}</p>
  </div>`).join('')}`}`;
}

/**
 * Build the page.
 *
 * Every input is a sealed artefact of this run. Nothing is fetched, nothing is recomputed, and nothing
 * is summarised by a model: the words are the experts' own.
 */
export function renderReportPage({
  index,
  investigation,
  plan = null,
  recurrence = null,
  map = null,
  journeyBrief = null,
  automationBrief = null,
  reviews = [],
  questionEdges = [],
  accountName: suppliedName = null,
} = {}) {
  const situation = journeyBrief?.situation ?? null;
  /*
   * The account's NAME, taken from the CURRENT profile rather than the sealed brief.
   *
   * Deliberate, and the one place this page prefers live configuration to the run's own artefacts: a
   * display name is not evidence. A run collected before the name was recorded should still render with
   * it, and an account renamed later should render under its new name rather than the id it had in
   * March. Falling back to the location id is honest and ugly; guessing a name would be neither.
   */
  const accountName = suppliedName ?? situation?.accountName ?? index.locationId;
  const questions = journeyBrief?.questionsToAnswer ?? [];
  const titleOf = new Map(investigation.causes.map((cause) => [cause.causeId, cause.findings[0]?.title ?? cause.causeId]));
  const rankOf = new Map(investigation.causes.map((cause, position) => [cause.causeId, position + 1]));
  const ageOf = new Map((recurrence?.causes ?? []).map((entry) => [entry.causeId, entry]));

  const problemRows = investigation.causes.map((cause, position) => {
    const age = ageOf.get(cause.causeId);
    const ageText = age === undefined
      ? '&mdash;'
      : age.status === 'RECURRING'
        ? `seen in ${age.priorRuns} earlier ${age.priorRuns === 1 ? 'run' : 'runs'}`
        : 'new';
    return `
    <tr>
      <td class="num">${position + 1}</td>
      <td>${escapeHtml(cause.findings[0]?.title ?? cause.causeId)}
        <div class="fixes">${cause.findings.map((finding) => `<span>${escapeHtml(finding.fix)}</span>`).join('')}</div>
      </td>
      <td>${ageText}</td>
      <td><span class="pill b-${escapeHtml(worstBand(cause, 'commercialImpact'))}">${escapeHtml(worstBand(cause, 'commercialImpact'))}</span></td>
      <td>${escapeHtml(worstBand(cause, 'implementationEffort'))}</td>
      <td>${cause.corroboratingLanes.length}/3</td>
      <td class="mono">${escapeHtml(cause.mechanisms.join(', '))}</td>
    </tr>`;
  });

  const workflowReviews = reviews.filter(({ kind }) => kind === 'workflow');
  const agentReviews = reviews.filter(({ kind }) => kind === 'agent');

  const body = `
<header class="masthead">
  <p class="eyebrow">Weekly account audit</p>
  <h1>${escapeHtml(accountName)}</h1>
  <p class="standfirst">${situation?.whoThisIs ? escapeHtml(situation.whoThisIs) : ''}</p>
  <p class="metaline">
    Week ending ${escapeHtml((index.collectionWindow?.to ?? '').slice(0, 10) || 'unknown')}
    &middot; account <code>${escapeHtml(index.locationId)}</code>
    ${situation?.theFunnel ? '' : ''}
  </p>
  <div class="scores">
    <div><span class="s-n">${investigation.causeCount}</span><span class="s-l">problems found</span></div>
    <div><span class="s-n">${investigation.corroboratedCauseCount}</span><span class="s-l">reached by more than one analyst</span></div>
    <div><span class="s-n">${reviews.length}</span><span class="s-l">workflows and agents reviewed one by one</span></div>
    <div><span class="s-n">${plan === null ? '&mdash;' : plan.batches.length}</span><span class="s-l">batches of work in the plan</span></div>
  </div>
  <p class="warnbar">Internal. Quotes real customer messages and account data, so keep it inside Grom.</p>
</header>

<section>
  <h2><span class="num">01</span>What was done</h2>
  <p>Five stages of expert read this account. Nothing was told what to look for and no rule in the
  code decides what good looks like: the account's own evidence is read, and every finding must name
  a mechanism, state a benchmark, carry two competing explanations and a test that would refute it, or
  it is thrown away.</p>
  <div class="stagegrid">
    <div><span class="big">1</span>expert derived what this account is and what each workflow is for</div>
    <div><span class="big">${reviews.length || '&mdash;'}</span>experts each read ONE workflow or agent whole: settings, runtime, and every message</div>
    <div><span class="big">3</span>experts read the account as a whole: the journey, the system, the messages as one stream</div>
    <div><span class="big">${investigation.causeCount}</span>problems after grouping, ranked, each with a fix and a way to check it</div>
  </div>
  ${index.internalRail?.available === false ? '<p class="note">The internal connection was OFF for this run, so no workflow settings or runtime were read. Nothing here should be taken as "the automation is fine".</p>' : ''}
</section>

<section>
  <h2><span class="num">02</span>The account as we found it</h2>
  ${map?.journey ? `<p class="lead">${escapeHtml(map.journey)}</p>` : ''}
  <h3>The money path</h3>
  ${moneyPathDiagram(map)}
  <h3>What every workflow is for</h3>
  ${rolesDiagram(map)}
  ${(map?.gaps ?? []).length === 0 ? '' : `
  <h3>Stages with no automation pointed at them</h3>
  <ul>${map.gaps.map((gap) => `<li>${escapeHtml(gap)}</li>`).join('')}</ul>`}
</section>

<section>
  <h2><span class="num">03</span>The six questions, answered</h2>
  <p>This is what the audit exists to answer. Each question is tied to the step of the journey it is
  about, and a finding appears under it when the finding points at that step.</p>
  ${questionsSection({
    questions,
    questionEdges,
    kpis: journeyBrief?.kpis,
    targets: journeyBrief?.targets,
    causes: investigation.causes,
    rankOf,
  })}
</section>

<section>
  <h2><span class="num">04</span>Where people fall out</h2>
  ${funnelDiagram({ kpis: journeyBrief?.kpis, targets: journeyBrief?.targets })}
</section>

${collisionDiagram(automationBrief?.collisions) === '' ? '' : `
<section>
  <h2><span class="num">05</span>What starts what</h2>
  <p>One workflow finishing can start another. Where many things fire one shared event and many things
  listen for it, the wrong person receives the wrong sequence.</p>
  ${collisionDiagram(automationBrief?.collisions)}
</section>`}

<section>
  <h2><span class="num">06</span>The plan</h2>
  ${planSection(plan, titleOf, rankOf)}
</section>

<section>
  <h2><span class="num">07</span>Every problem, ranked</h2>
  <p class="caption">The grey line under each problem is the fix its analyst proposed, in their words.</p>
  <div class="tablewrap">
    <table class="problems">
      <thead><tr><th class="num">#</th><th>Problem and fix</th><th>Age</th><th>Impact</th><th>Effort</th><th>Analysts</th><th>Mechanism</th></tr></thead>
      <tbody>${problemRows.join('')}</tbody>
    </table>
  </div>
</section>

<section>
  <h2><span class="num">08</span>Where the detail is</h2>
  <p>This page is the overview. The working material is on disk beside it.</p>
  <div class="tablewrap">
    <table>
      <thead><tr><th>What</th><th>Where</th></tr></thead>
      <tbody>
        <tr><td>The rewritten copy, message by message</td><td class="mono">private/briefs/${escapeHtml(index.runId)}/reviews/</td></tr>
        <tr><td>One file per problem: what to change, how to check it</td><td class="mono">investigations/${escapeHtml(index.runId)}/packages/</td></tr>
        <tr><td>The full argument behind every problem</td><td class="mono">investigations/${escapeHtml(index.runId)}/INVESTIGATION.md</td></tr>
        <tr><td>The plan</td><td class="mono">investigations/${escapeHtml(index.runId)}/PLAN.md</td></tr>
      </tbody>
    </table>
  </div>
  ${workflowReviews.length === 0 ? '' : `
  <h3>Workflows reviewed on their own</h3>
  <ul class="cols">${workflowReviews.map((review) => `<li>${escapeHtml(review.object)} <span class="muted">${review.messageCount ?? 0} messages</span></li>`).join('')}</ul>`}
  ${agentReviews.length === 0 ? '' : `
  <h3>AI agents reviewed on their own</h3>
  <ul class="cols">${agentReviews.map((review) => `<li>${escapeHtml(review.object)}</li>`).join('')}</ul>`}
</section>

<footer>
  <p>Run <code>${escapeHtml(index.runId)}</code>. Briefs <code>${escapeHtml((index.briefsHash ?? '').slice(0, 12))}</code>,
  investigation <code>${escapeHtml((investigation.investigationHash ?? '').slice(0, 12))}</code>.</p>
  <p>Nothing here proves the configuration read today was the configuration in force during the window.
  A setting may be called consistent with an outcome, or said to produce one going forward. It may not
  be said to have caused a past outcome.</p>
  <p>Nothing in this cycle changes the account. Every fix is for a person to approve and apply.</p>
</footer>`;

  return { html: `${PAGE_STYLE}\n${body}\n`, pageHash: sha256(body) };
}

/** Inline, because the page is opened as a local file where an external stylesheet cannot load. */
const PAGE_STYLE = `<title>Account audit</title>
<style>
:root{color-scheme:light dark;
--paper:#F2F5F6;--card:#FFF;--ink:#121A1E;--soft:#4A5B62;--faint:#7C8D94;--rule:#D7E0E2;--rule-soft:#E9EFF0;
--accent:#0B5F66;--wash:#E2EFF0;--warn:#8A5410;--warn-wash:#F6EBDA;--bad:#9C2F2F;--bad-wash:#F6E3E3;--good:#276B47;
--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;--sans:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;--serif:ui-serif,Georgia,"Times New Roman",serif;}
@media(prefers-color-scheme:dark){:root{--paper:#0D1417;--card:#141E22;--ink:#E6EDEF;--soft:#A3B4BA;--faint:#71858C;--rule:#24343A;--rule-soft:#1B292E;--accent:#5FCBD3;--wash:#123336;--warn:#D8A05A;--warn-wash:#33260F;--bad:#E08585;--bad-wash:#331A1A;--good:#6FC694;}}
:root[data-theme=light]{--paper:#F2F5F6;--card:#FFF;--ink:#121A1E;--soft:#4A5B62;--faint:#7C8D94;--rule:#D7E0E2;--rule-soft:#E9EFF0;--accent:#0B5F66;--wash:#E2EFF0;--warn:#8A5410;--warn-wash:#F6EBDA;--bad:#9C2F2F;--bad-wash:#F6E3E3;--good:#276B47;}
:root[data-theme=dark]{--paper:#0D1417;--card:#141E22;--ink:#E6EDEF;--soft:#A3B4BA;--faint:#71858C;--rule:#24343A;--rule-soft:#1B292E;--accent:#5FCBD3;--wash:#123336;--warn:#D8A05A;--warn-wash:#33260F;--bad:#E08585;--bad-wash:#331A1A;--good:#6FC694;}
body{background:var(--paper);color:var(--ink);font-family:var(--sans);font-size:16px;line-height:1.6;margin:0;padding:0 clamp(1rem,4vw,3rem) 5rem;max-width:82rem;margin-inline:auto;-webkit-font-smoothing:antialiased}
.masthead{padding:clamp(2.5rem,7vw,4.5rem) 0 2rem;border-bottom:1px solid var(--rule);display:flex;flex-direction:column;gap:1rem}
.eyebrow{font-family:var(--mono);font-size:.7rem;letter-spacing:.13em;text-transform:uppercase;color:var(--accent);margin:0}
h1{font-family:var(--mono);font-size:clamp(1.4rem,3.5vw,2.1rem);margin:0;letter-spacing:-.01em;word-break:break-all}
.standfirst{font-size:1.08rem;color:var(--soft);max-width:62ch;margin:0}
.warnbar{font-size:.82rem;background:var(--warn-wash);color:var(--warn);padding:.5rem .8rem;border-radius:3px;margin:.5rem 0 0;max-width:70ch}
section{padding-top:3rem}
h2{font-family:var(--serif);font-weight:500;font-size:clamp(1.35rem,2.6vw,1.8rem);line-height:1.15;margin:0 0 .8rem;text-wrap:balance}
h2 .num{font-family:var(--mono);font-size:.68rem;color:var(--accent);letter-spacing:.12em;display:block;margin-bottom:.55rem;font-weight:400}
h3{font-size:.92rem;font-weight:650;margin:2rem 0 .6rem}
h4{font-size:.85rem;font-weight:640;margin:0 0 .4rem}
p{max-width:68ch}.lead{font-size:1.02rem;color:var(--soft)}
.caption{font-size:.82rem;color:var(--faint)}
.note{font-size:.88rem;background:var(--wash);padding:.7rem .9rem;border-left:2px solid var(--accent);max-width:68ch}
code{font-family:var(--mono);font-size:.85em;background:var(--rule-soft);padding:.08em .3em;border-radius:3px}
.mono{font-family:var(--mono);font-size:.8rem}
.muted{color:var(--faint);font-size:.82em}
em.warn{color:var(--warn);font-style:normal;font-size:.78em;font-family:var(--mono)}
ul.plain{list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:.25rem;font-size:.86rem}
ul.cols{list-style:none;padding:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(19rem,1fr));gap:.3rem .8rem;font-size:.86rem}
.stagegrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(13rem,1fr));gap:1px;background:var(--rule);border:1px solid var(--rule);margin-top:1.5rem}
.stagegrid>div{background:var(--card);padding:1rem 1.1rem;font-size:.85rem;color:var(--soft)}
.big{display:block;font-family:var(--serif);font-size:2rem;line-height:1;color:var(--accent);margin-bottom:.35rem}
.band{overflow-x:auto;padding-bottom:.4rem}
.chain{list-style:none;display:flex;gap:0;margin:0;padding:0;min-width:min-content}
.chain-step{background:var(--card);border:1px solid var(--rule);border-left:none;padding:.7rem .85rem;min-width:11rem;flex:1 1 0;display:flex;flex-direction:column;gap:.2rem}
.chain-step:first-child{border-left:1px solid var(--rule)}
.chain-n{font-family:var(--mono);font-size:.62rem;color:var(--accent)}
.chain-name{font-family:var(--mono);font-size:.78rem;font-weight:600}
.chain-job{font-size:.76rem;color:var(--faint);line-height:1.35}
.roles{display:grid;grid-template-columns:repeat(auto-fit,minmax(17rem,1fr));gap:1px;background:var(--rule);border:1px solid var(--rule)}
.role{background:var(--card);padding:.9rem 1rem}
.role .count{font-family:var(--mono);font-size:.72rem;color:var(--accent)}
.tablewrap{overflow-x:auto;border:1px solid var(--rule);background:var(--card);margin-top:1rem}
table{border-collapse:collapse;width:100%;min-width:32rem;font-size:.86rem}
th,td{text-align:left;padding:.55rem .8rem;border-bottom:1px solid var(--rule-soft);vertical-align:top}
thead th{font-family:var(--mono);font-size:.64rem;letter-spacing:.1em;text-transform:uppercase;color:var(--faint);font-weight:500;background:var(--paper);border-bottom:1px solid var(--rule)}
tbody tr:last-child td{border-bottom:none}
.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
th.num,td.num{text-align:right}
.funnel th{font-family:var(--mono);font-size:.76rem;font-weight:500}
.bar-cell{width:40%;min-width:9rem}
.bar{display:block;position:relative;height:1.05rem;background:var(--rule-soft);border-radius:2px;overflow:visible}
.bar::before{content:"";position:absolute;inset:0 auto 0 0;width:var(--w);background:var(--accent);border-radius:2px}
.target{position:absolute;top:-2px;bottom:-2px;left:var(--t);width:2px;background:var(--warn)}
.target-col{color:var(--warn)}
.unmeasured{font-family:var(--mono);font-size:.72rem;color:var(--warn)}
.pill{display:inline-block;font-family:var(--mono);font-size:.64rem;letter-spacing:.06em;padding:.15rem .4rem;border-radius:2px;white-space:nowrap}
.b-CRITICAL,.b-HIGH{background:var(--bad-wash);color:var(--bad)}
.b-MEDIUM{background:var(--warn-wash);color:var(--warn)}
.b-LOW,.b-NONE{background:var(--rule-soft);color:var(--faint)}
.fixes{display:flex;flex-direction:column;gap:.2rem;margin-top:.35rem;font-size:.82rem;color:var(--faint)}
.chain-map{display:grid;gap:1px;background:var(--rule);border:1px solid var(--rule);margin-top:1rem}
@media(min-width:52rem){.chain-map{grid-template-columns:1fr auto 1fr}}
.chain-map .side{background:var(--card);padding:.9rem 1rem}
.chain-map .via{background:var(--wash);padding:.9rem 1rem;display:flex;align-items:center;justify-content:center}
.chain-map .via code{background:none;color:var(--accent);font-size:.74rem}
.metaline{font-size:.82rem;color:var(--faint);margin:0}
.scores{display:grid;grid-template-columns:repeat(auto-fit,minmax(11rem,1fr));gap:1px;background:var(--rule);border:1px solid var(--rule);margin-top:.5rem}
.scores>div{background:var(--card);padding:.85rem 1rem;display:flex;flex-direction:column;gap:.15rem}
.s-n{font-family:var(--serif);font-size:1.9rem;line-height:1;color:var(--accent)}
.s-l{font-size:.76rem;color:var(--faint);line-height:1.3}
.qa{background:var(--card);border:1px solid var(--rule);border-left:3px solid var(--rule);padding:1rem 1.2rem;margin-top:.75rem}
.qa.q-answered{border-left-color:var(--bad)}
.qa.q-unmeasured{border-left-color:var(--warn)}
.qa.q-none{border-left-color:var(--good)}
.qa.q-unanswerable{border-left-color:var(--faint)}
.qa h3{margin:0 0 .5rem;font-size:1rem;font-weight:600;display:flex;flex-wrap:wrap;align-items:baseline;gap:.5rem;line-height:1.35}
.qn{font-family:var(--mono);font-size:.68rem;color:var(--accent);letter-spacing:.08em}
.qstate{font-family:var(--mono);font-size:.64rem;letter-spacing:.07em;text-transform:uppercase;color:var(--faint);margin-left:auto;white-space:nowrap}
.q-answered .qstate{color:var(--bad)}.q-unmeasured .qstate{color:var(--warn)}.q-none .qstate{color:var(--good)}
ul.nums{font-size:.84rem;gap:.2rem;margin-bottom:.6rem}
ul.nums code{font-size:.78rem}
.qfindings{display:flex;flex-direction:column;gap:.55rem;margin-top:.6rem;border-top:1px solid var(--rule-soft);padding-top:.6rem}
.qf-title{font-size:.88rem;font-weight:600;margin:0;max-width:none}
.qf-fix{font-size:.84rem;color:var(--soft);margin:.15rem 0 0;max-width:none}
.thisweek{background:var(--card);border:1px solid var(--rule);border-left:3px solid var(--accent);padding:1rem 1.2rem;font-size:.98rem;max-width:72ch}
.prereq,.conflict{background:var(--card);border:1px solid var(--rule);padding:.8rem 1rem;margin-bottom:.5rem;max-width:72ch}
.prereq p,.conflict p{margin:.3rem 0 0;font-size:.88rem}
.batches{padding-left:0;list-style:none;counter-reset:b;display:flex;flex-direction:column;gap:1px;background:var(--rule);border:1px solid var(--rule)}
.batches>li{background:var(--card);padding:1rem 1.1rem;counter-increment:b}
.batches>li h4::before{content:counter(b) ". ";color:var(--accent);font-family:var(--mono)}
.batches .meta{font-family:var(--mono);font-size:.7rem;color:var(--faint);margin:0 0 .5rem;text-transform:uppercase;letter-spacing:.06em}
.batches p{font-size:.88rem;margin:.3rem 0 .5rem}
footer{margin-top:4rem;padding-top:1.2rem;border-top:1px solid var(--rule);font-size:.8rem;color:var(--faint)}
footer p{max-width:68ch}
</style>`;
