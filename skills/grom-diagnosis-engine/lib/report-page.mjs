/**
 * THE REPORT PAGE — the whole audit as one document the team reads.
 *
 * Generated, never hand-written. Every run produces one and it cannot drift from the findings, because
 * it renders from the same sealed artefacts the markdown renders from. The prose is the EXPERTS' OWN
 * WORDS: their titles, their fixes, their plan, the line each reviewer ended on. The page arranges, it
 * never summarises, so it can never become a fourth opinion about the account.
 *
 * ---------------------------------------------------------------------------------------------
 * WRITTEN FOR THE TEAM, and that decided most of what follows. It is sent to people who did not run
 * the audit and do not know the vocabulary. Four consequences:
 *
 * LIGHT ONLY. A deliberate single look rather than an omission. This gets read, printed and forwarded,
 * and a report that changes appearance with the reader's OS setting is a report two people describe
 * differently on a call.
 *
 * REPLACEMENT COPY LOOKS LIKE THE MESSAGE IT REPLACES. The experts write real email and SMS: a subject,
 * a preheader, a body. An earlier version split every fix on sentence boundaries and bulleted it, which
 * turned finished copy into a list of fragments and was the first thing the owner objected to. Quoted
 * copy is now lifted out and shown as the message.
 *
 * DIAGRAMS ARE MERMAID. This document is opened as a local file in a real browser, not inside a
 * sandbox, so it CAN fetch a script. If that fails the diagram source stays on the page as text, and
 * every fact a diagram draws is also in a table on the same page.
 *
 * IT IS STILL EVIDENCE. It quotes real customer messages and names real workflows, so it lives in the
 * investigation directory with the rest of the private material. Sending it to the team is the owner's
 * call; publishing it is not.
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

/** Mermaid reads its source as text, so a label must not contain the characters that end one. */
function mermaidLabel(value, limit = 46) {
  const text = String(value ?? '').replaceAll(/["[\]{}()<>|]/gu, ' ').replaceAll(/\s+/gu, ' ').trim();
  return escapeHtml(text.length > limit ? `${text.slice(0, limit - 1)}...` : text);
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

/** The line every per-object review is required to end on. Often the most useful sentence in it. */
function oneChangeOf(text) {
  const match = String(text ?? '').match(/\*\*THE ONE CHANGE\*\*\s*[-]?\s*([\s\S]*?)(?:\n\s*\n|$)/u);
  if (!match) return null;
  return match[1].replace(/\s+/gu, ' ').replaceAll('**', '').trim() || null;
}

/** Long prose into readable pieces, splitting only on a full stop followed by a capital. */
function intoParagraphs(text) {
  const pieces = String(text ?? '').split(/(?<=\.)\s+(?=[A-Z])/u).map((p) => p.trim()).filter(Boolean);
  const merged = [];
  for (const piece of pieces) {
    if (merged.length > 0 && (piece.length < 60 || merged[merged.length - 1].length < 90)) {
      merged[merged.length - 1] += ` ${piece}`;
    } else merged.push(piece);
  }
  return merged;
}

/**
 * A piece of replacement copy, shown as the message a customer would receive.
 *
 * Subject and preheader are pulled out when the writer labelled them, because that is how the rubric
 * asks for an email and how a reader expects to see one. Unlabelled copy is an SMS or a bare body and
 * renders as the message with no chrome invented around it.
 */
function renderCopyBlock(quote) {
  /*
   * THE LABELS MUST BE LABELS, NOT THE WORDS.
   *
   * These once matched `Subject`/`Body` ANYWHERE in the quote. This account is called "SK Skin and
   * Body Health", so the word Body inside the client's own name hijacked the parser: five pieces of
   * finished SMS copy rendered as "replacement email" bodies beginning mid-sentence at "Health...".
   * Measured on this run, not reasoned about: 5 of 35 quotes were hijacked and NONE carried a real
   * label. A label is written at the start of a line and followed by a colon or dash, so that is
   * what is required now. Copy that is not labelled is a message, and renders as one.
   */
  const subject = quote.match(/^[ \t]*Subject[ \t]*[:\-][ \t]*['"]?(.+?)['"]?[ \t]*$/imu);
  const preheader = quote.match(/^[ \t]*Pre-?header[ \t]*[:\-][ \t]*['"]?(.+?)['"]?[ \t]*$/imu);
  const labelledBody = quote.match(/^[ \t]*Body[ \t]*[:\-][ \t]*([\s\S]+)$/imu);
  /*
   * A writer who labels the subject and then just writes the message underneath is not doing
   * anything wrong, so when there is a subject but no Body label, everything after the last labelled
   * line IS the body. Without this the subject renders alone and the message silently vanishes.
   */
  const trailing = subject
    ? quote.slice((preheader ?? subject).index + (preheader ?? subject)[0].length).trim()
    : '';
  const body = labelledBody ?? (trailing.length > 0 ? [null, trailing] : null);
  if (subject || labelledBody) {
    return `
    <div class="copyblock email">
      <span class="copytag">replacement email</span>
      ${subject ? `<p class="csubject">${escapeHtml(subject[1].trim())}</p>` : ''}
      ${preheader ? `<p class="cpre">${escapeHtml(preheader[1].trim())}</p>` : ''}
      ${body ? `<div class="cbody">${escapeHtml(body[1].trim())}</div>` : ''}
    </div>`;
  }
  return `
  <div class="copyblock">
    <span class="copytag">replacement copy</span>
    <div class="cbody">${escapeHtml(quote.trim())}</div>
  </div>`;
}

/**
 * A FIX, RENDERED AS WHAT IT ACTUALLY IS.
 *
 * The experts are told to write replacement copy in full, so a fix is usually instructions with real
 * subject lines and bodies inside them. Bulleting that shreds finished copy into fragments.
 *
 * So paragraphs stay paragraphs, and a quoted run long enough to be a message is lifted out and shown
 * as the message. The detection is deliberately conservative: a quote that is not really copy renders
 * as a quotation, which is harmless, whereas parsing prose hard enough to be certain would fail
 * silently on the first fix written in a different shape.
 */
function renderFix(fix) {
  const text = String(fix ?? '').trim();
  if (text.length === 0) return '';
  /*
   * AN APOSTROPHE IS NOT A CLOSING QUOTE.
   *
   * This once read /'([^']{60,})'/, which pairs every apostrophe in the prose as a delimiter. One
   * "it's" puts the whole document out of phase, and the visible damage was severe: finished copy
   * cut off at "you are speaking with Sky, the clinic" (losing "'s AI assistant"), copy beginning
   * mid-word at "s Sky. I am sorry", and a run of pure narrative — "only if 03 Long Term Lead
   * Nurture is built. If it is not, cut" — lifted into a box as though a customer would receive it.
   *
   * So a delimiter is a quote that is not word-internal: an opening quote is not preceded by a word
   * character, a closing quote is not followed by one, and an apostrophe with letters on both sides
   * is kept as part of the copy where it belongs. Measured against this run's 25 fixes: 42 matches
   * become 35, and the ones that go are the fragments.
   */
  const quotes = [...text.matchAll(/(?<![\w'])'((?:[^']|(?<=\w)'(?=\w)){60,}?)'(?!\w)/gu)]
    .map((match) => match[1]);
  if (quotes.length === 0) {
    return intoParagraphs(text).map((p) => `<p>${escapeHtml(p)}</p>`).join('');
  }
  const blocks = [];
  let rest = text;
  for (const quote of quotes) {
    const at = rest.indexOf(`'${quote}'`);
    if (at === -1) continue;
    const before = rest.slice(0, at).trim();
    if (before.length > 0) blocks.push(...intoParagraphs(before).map((p) => `<p>${escapeHtml(p)}</p>`));
    blocks.push(renderCopyBlock(quote));
    rest = rest.slice(at + quote.length + 2);
  }
  if (rest.trim().length > 0) blocks.push(...intoParagraphs(rest).map((p) => `<p>${escapeHtml(p)}</p>`));
  return blocks.join('');
}

/** One finding: the title always visible, everything else a click away. */
function findingBlock(cause, rank) {
  return `
  <details class="finding" id="f${rank}">
    <summary>
      <span class="frank">${rank}</span>
      <span class="ftitle">${escapeHtml(cause.findings[0]?.title ?? '')}</span>
      <span class="fmeta">${escapeHtml(worstBand(cause, 'commercialImpact').toLowerCase())}</span>
    </summary>
    <div class="fbody">
      <p class="flabel">What to change</p>
      ${cause.findings.map((finding) => renderFix(finding.fix)).join('')}
      <p class="flabel">How you will know it worked</p>
      <ul class="checks">${cause.findings.map((finding) => `
        <li>${escapeHtml(finding.discriminatingTest?.check ?? '')}</li>`).join('')}</ul>
    </div>
  </details>`;
}

/**
 * THE JOURNEY, AS A DIAGRAM.
 *
 * Built from the money path stage 1 derived, so it is the account's real order and not a drawing of
 * how it ought to work. Top to bottom rather than left to right: a fourteen-step funnel read sideways
 * needs a scrollbar, and this document gets printed.
 */
function journeyDiagram(map) {
  const path = (map?.moneyPath ?? []).slice(0, 14);
  if (path.length < 2) return '';
  const jobOf = new Map((map.workflows ?? []).map((entry) => [entry.name, entry.job]));
  return `
  <figure>
    <pre class="mermaid">flowchart TD
${path.map((name, index) => `  W${index}["${mermaidLabel(name, 34)}"]`).join('\n')}
${path.slice(1).map((unused, index) => `  W${index} --> W${index + 1}`).join('\n')}</pre>
    <figcaption>The order a lead meets your workflows, derived from the account itself.</figcaption>
  </figure>
  <div class="tablewrap">
    <table>
      <thead><tr><th class="num">Step</th><th>Workflow</th><th>What it is for</th></tr></thead>
      <tbody>${path.map((name, index) => `
        <tr><td class="num">${index + 1}</td><td class="wf">${escapeHtml(name)}</td>
        <td>${escapeHtml(jobOf.get(name) ?? '')}</td></tr>`).join('')}</tbody>
    </table>
  </div>`;
}

/**
 * WHAT STARTS WHAT, AS A DIAGRAM, and it is the clearest picture of the account's central problem.
 *
 * Producers on the left, the shared event in the middle, consumers on the right. It reads as a count
 * rather than a graph, which is the point: many things firing one event and many things listening for
 * it is the whole finding.
 */
function chainDiagram(collisions) {
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
    .map(([via, { producers, consumers }], index) => {
      const p = [...producers].sort().slice(0, 8);
      const c = [...consumers.entries()].sort().slice(0, 8);
      const noStop = c.some(([, chain]) => chain.consumerStopsOnResponse === false);
      return `
    <figure>
      <pre class="mermaid">flowchart LR
  E${index}{{"${mermaidLabel(via, 40)}"}}
${p.map((name, i) => `  P${index}_${i}["${mermaidLabel(name, 28)}"] --> E${index}`).join('\n')}
${c.map(([name], i) => `  E${index} --> C${index}_${i}["${mermaidLabel(name, 28)}"]`).join('\n')}</pre>
      <figcaption>${producers.size} ${producers.size === 1 ? 'workflow fires' : 'workflows fire'} this
      event and ${consumers.size} ${consumers.size === 1 ? 'listens' : 'listen'} for it.
      ${noStop ? 'At least one listener does not stop when the person replies.' : ''}</figcaption>
    </figure>`;
    }).join('');
}

/** Every workflow by the job stage 1 gave it. A table, because the team will look things up in it. */
function rolesTable(map) {
  const workflows = map?.workflows ?? [];
  if (workflows.length === 0) return '';
  const label = {
    money_path: 'Wins business',
    delivery: 'Serves a signed client',
    internal_ops: 'Tells staff something',
    data_hygiene: 'Maintains records',
    abandoned: 'Appears unused',
    unclear: 'Could not tell',
  };
  const order = ['money_path', 'delivery', 'internal_ops', 'data_hygiene', 'abandoned', 'unclear'];
  const sorted = [...workflows].sort((left, right) => order.indexOf(left.role) - order.indexOf(right.role)
    || (left.name < right.name ? -1 : 1));
  return `
  <div class="tablewrap">
    <table>
      <thead><tr><th>Workflow</th><th>Job</th><th>What it is for</th></tr></thead>
      <tbody>${sorted.map((entry) => `
        <tr>
          <td class="wf">${escapeHtml(entry.name)}
            ${entry.nameMatchesBehaviour === false ? '<em class="flag">name does not match what it does</em>' : ''}</td>
          <td><span class="role r-${escapeHtml(entry.role)}">${escapeHtml(label[entry.role] ?? entry.role)}</span></td>
          <td>${escapeHtml(entry.job)}</td>
        </tr>`).join('')}</tbody>
    </table>
  </div>`;
}

/** The most populated window, so every number is judged on the widest evidence available. */
function widestWindow(kpis) {
  const windows = Object.keys(kpis ?? {});
  if (windows.length === 0) return null;
  const chosen = windows
    .map((name) => [name, Object.values(kpis[name]).filter((cell) => typeof cell.rate === 'number').length])
    .sort((left, right) => right[1] - left[1])[0];
  return chosen && chosen[1] > 0 ? kpis[chosen[0]] : null;
}

/** The funnel. An unmeasurable step shows its reason, never an empty bar. */
function funnelTable({ kpis, targets }) {
  const cells = widestWindow(kpis);
  if (cells === null) return '';
  const targetFor = new Map((targets ?? []).map((entry) => [entry.edgeId, entry]));
  return `
  <div class="tablewrap">
    <table>
      <thead><tr><th>Step of the journey</th><th>How it is doing</th><th class="num">Actual</th>
      <th class="num">Target</th><th class="num">Out of</th></tr></thead>
      <tbody>${Object.entries(cells).map(([edgeId, cell]) => {
    const target = targetFor.get(edgeId);
    const rate = typeof cell.rate === 'number' ? cell.rate : null;
    const short = rate !== null && target && rate < target.target;
    return `
        <tr class="${short ? 'below' : ''}">
          <td class="wf">${escapeHtml(edgeId.replaceAll('_', ' '))}</td>
          <td class="barcell">${rate === null
    ? `<span class="nomeasure">cannot be measured${cell.reasonCode ? `: ${escapeHtml(cell.reasonCode.toLowerCase().replaceAll('_', ' '))}` : ''}</span>`
    : `<span class="bar"><i style="width:${Math.round(rate * 100)}%"></i>${target ? `<b style="left:${Math.round(target.target * 100)}%"></b>` : ''}</span>`}</td>
          <td class="num">${percent(rate) ?? 'n/a'}</td>
          <td class="num tgt">${target ? percent(target.target) : 'n/a'}</td>
          <td class="num">${cell.numerator ?? 'n/a'} of ${cell.denominator ?? 'n/a'}</td>
        </tr>`;
  }).join('')}</tbody>
    </table>
  </div>`;
}

/**
 * THE SIX QUESTIONS, one at a time, each with a verdict a reader can act on.
 *
 * A finding is written out under the FIRST question it bears on and cross-referenced elsewhere. A
 * broadly-anchored finding genuinely touches three questions, and printing it three times made the
 * second read as a copy of the first.
 */
function questionsSection({ questions, questionEdges, kpis, targets, causes, rankOf }) {
  if ((questionEdges ?? []).length === 0) return '';
  const byQuestion = new Map(questionEdges.map((entry) => [entry.question, entry.edgeIds]));
  const targetFor = new Map((targets ?? []).map((entry) => [entry.edgeId, entry]));
  const cells = widestWindow(kpis) ?? {};

  const primary = new Map();
  for (const [number, edgeIds] of [...byQuestion.entries()].sort((left, right) => left[0] - right[0])) {
    for (const cause of causes) {
      if (primary.has(cause.causeId)) continue;
      if (edgeIds.some((edgeId) => cause.anchors.includes(`kpi:${edgeId}`))) primary.set(cause.causeId, number);
    }
  }

  return questions.map((question, position) => {
    const number = position + 1;
    const edgeIds = byQuestion.get(number) ?? [];
    const matching = causes.filter((cause) => edgeIds.some((edgeId) => cause.anchors.includes(`kpi:${edgeId}`)));
    const mine = matching.filter((cause) => primary.get(cause.causeId) === number);
    const elsewhere = matching.filter((cause) => primary.get(cause.causeId) !== number);
    const measured = edgeIds.filter((edgeId) => typeof cells[edgeId]?.rate === 'number');
    const state = edgeIds.length === 0 ? 'nostep'
      : matching.length === 0 ? 'clear'
        : measured.length === 0 ? 'blind' : 'answered';
    const verdict = {
      answered: `${matching.length} ${matching.length === 1 ? 'reason' : 'reasons'} found`,
      blind: 'reasons found, but this step is not measured',
      clear: 'nothing found here',
      nostep: 'this account does not measure this',
    }[state];

    return `
    <section class="qa q-${state}">
      <h3><span class="qn">Question ${number}</span>${escapeHtml(question)}</h3>
      <p class="verdict">${verdict}</p>
      ${edgeIds.length === 0
    ? '<p class="plain-note">There is no step in this account that measures this, so the audit cannot answer it. That is a gap in what gets tracked, not a judgement about the account.</p>'
    : `<ul class="qnums">${edgeIds.map((edgeId) => {
      const cell = cells[edgeId];
      const target = targetFor.get(edgeId);
      const actual = typeof cell?.rate === 'number' ? percent(cell.rate) : null;
      return `<li><span class="wf">${escapeHtml(edgeId.replaceAll('_', ' '))}</span> ${actual === null
        ? '<span class="nomeasure">cannot be measured</span>'
        : `<strong>${actual}</strong>${target ? ` <span class="muted">target ${percent(target.target)}</span>` : ''}`}</li>`;
    }).join('')}</ul>`}
      ${mine.length === 0 ? '' : `<div class="findings">${mine.map((cause) => findingBlock(cause, rankOf.get(cause.causeId))).join('')}</div>`}
      ${elsewhere.length === 0 ? '' : `<p class="xref">Also caused by
        ${elsewhere.map((cause) => `<a href="#f${rankOf.get(cause.causeId)}">finding ${rankOf.get(cause.causeId)}</a>`).join(', ')},
        written out under an earlier question.</p>`}
    </section>`;
  }).join('');
}

/** Onboarding and delivery, which none of the six questions reaches. */
function deliverySection({ map, causes, rankOf, reviews }) {
  const delivery = (map?.workflows ?? []).filter((entry) => entry.role === 'delivery');
  if (delivery.length === 0) return '';
  const names = new Set(delivery.map((entry) => entry.name));
  const related = causes.filter((cause) => cause.anchors
    .some((anchor) => anchor.startsWith('workflow:') && names.has(anchor.slice('workflow:'.length))));
  const said = delivery
    .map((entry) => ({ entry, one: oneChangeOf(reviews.find((review) => review.object === entry.name)?.text) }))
    .filter(({ one }) => one);
  return `
  <p>All six questions above are about winning a client. ${delivery.length} of this account's workflows
  run AFTER somebody signs, and the money is only marked at the end of that track, so it gets its own
  section.</p>
  ${said.length === 0 ? '' : `
  <h3>What each reviewer said to change</h3>
  <p class="plain-note">One line per workflow, from the expert who read that workflow on its own. These
  come from the per-workflow reviews and have not been through the ranking, so treat them as advice
  rather than as findings.</p>
  <div class="onechanges">${said.map(({ entry, one }) => `
    <div class="onechange">
      <p class="ocname">${escapeHtml(entry.name)}</p>
      <p class="octext">${escapeHtml(one)}</p>
    </div>`).join('')}</div>`}
  ${related.length === 0 ? '' : `
  <h3>Findings that touch this track</h3>
  ${related.map((cause) => `
    <p class="xref-line"><a href="#f${rankOf.get(cause.causeId)}">Finding ${rankOf.get(cause.causeId)}</a>
    ${escapeHtml(cause.findings[0]?.title ?? '')}</p>`).join('')}`}`;
}

/** The plan: what to do, in order. */
function planSection(plan, titleOf, rankOf) {
  if (plan === null) {
    return `<p class="plain-note">No running order was produced for this run, so the findings are listed
      by rank with nothing said about sequencing or prerequisites.</p>`;
  }
  const week = intoParagraphs(plan.thisWeek);
  return `
  <div class="summarybox">
    <h3>This week</h3>
    ${week.length > 1
    ? `<ol class="weeksteps">${week.map((step) => `<li>${escapeHtml(step)}</li>`).join('')}</ol>`
    : `<p>${escapeHtml(plan.thisWeek)}</p>`}
  </div>
  ${plan.prerequisites.length === 0 ? '' : `
  <h3>Do these first, or you will not be able to tell whether the rest worked</h3>
  ${plan.prerequisites.map(({ causeId, blocks, why }) => `
  <div class="prereq">
    <p class="pname">${escapeHtml(titleOf.get(causeId) ?? causeId)}</p>
    <p>${escapeHtml(why)}</p>
    ${blocks.length === 0 ? '' : `<p class="muted">Blocks ${blocks.map((id) => `finding ${rankOf.get(id)}`).join(', ')}</p>`}
  </div>`).join('')}`}
  <h3>The work, in order</h3>
  <div class="tablewrap">
    <table>
      <thead><tr><th class="num">#</th><th>What gets done</th><th>Size</th><th class="num">Closes</th></tr></thead>
      <tbody>${plan.batches.map((batch) => `
      <tr>
        <td class="num">${batch.order}</td>
        <td><strong>${escapeHtml(batch.title)}</strong>
          <p class="brat">${escapeHtml(batch.rationale)}</p>
          ${batch.blockedBy.length > 0 ? `<p class="muted">After ${batch.blockedBy.map((n) => `step ${n}`).join(' and ')}</p>` : ''}</td>
        <td><span class="size s-${escapeHtml(batch.size)}">${escapeHtml(batch.size.toLowerCase())}</span>
          ${batch.sameChange ? '<em class="flag">one repeated change</em>' : ''}</td>
        <td class="num">${batch.causeIds.map((id) => `<a href="#f${rankOf.get(id)}">${rankOf.get(id)}</a>`).join(', ')}</td>
      </tr>`).join('')}</tbody>
    </table>
  </div>
  ${plan.conflicts.length === 0 ? '' : `
  <h3>These pull against each other</h3>
  ${plan.conflicts.map(({ causeIds, why, resolution }) => `
  <div class="prereq">
    <p class="pname">Findings ${causeIds.map((id) => rankOf.get(id)).join(' and ')}</p>
    <p>${escapeHtml(why)}</p>
    <p class="muted">What to do: ${escapeHtml(resolution)}</p>
  </div>`).join('')}`}`;
}

/** Build the page. Every input is a sealed artefact of this run. */
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
   * The account's NAME, from the CURRENT profile rather than the sealed brief, and the one place this
   * page prefers live configuration to the run's own artefacts: a display name is not evidence.
   */
  const accountName = suppliedName ?? situation?.accountName ?? index.locationId;
  const questions = journeyBrief?.questionsToAnswer ?? [];
  const titleOf = new Map(investigation.causes.map((c) => [c.causeId, c.findings[0]?.title ?? c.causeId]));
  const rankOf = new Map(investigation.causes.map((c, i) => [c.causeId, i + 1]));
  const ageOf = new Map((recurrence?.causes ?? []).map((entry) => [entry.causeId, entry]));
  const week = (index.collectionWindow?.to ?? '').slice(0, 10);
  const delivery = deliverySection({ map, causes: investigation.causes, rankOf, reviews });
  const chains = chainDiagram(automationBrief?.collisions);

  const contents = [
    ['method', 'How this audit was done'],
    ['account', 'How the account works today'],
    ['questions', 'The six questions, answered'],
    ['funnel', 'Where people fall out'],
    ...(chains === '' ? [] : [['chains', 'What starts what']]),
    ...(delivery === '' ? [] : [['delivery', 'Onboarding and delivery']]),
    ['plan', 'What to do, in order'],
    ['findings', 'Every finding'],
    ...((situation?.knownDataCaveats ?? []).length === 0 ? [] : [['told', 'What we were told']]),
    ['files', 'Where the detail is'],
  ];

  const body = `
<header class="cover">
  <p class="kicker">Account audit &middot; week ending ${escapeHtml(week)}</p>
  <h1>${escapeHtml(accountName)}</h1>
  ${situation?.whoThisIs ? `<p class="blurb">${escapeHtml(situation.whoThisIs)}</p>` : ''}
  <div class="figures">
    <div><b>${investigation.causeCount}</b><span>problems found</span></div>
    <div><b>${investigation.corroboratedCauseCount}</b><span>found by more than one expert</span></div>
    <div><b>${reviews.length}</b><span>workflows and agents reviewed</span></div>
    <div><b>${plan === null ? 'n/a' : plan.batches.length}</b><span>steps in the plan</span></div>
  </div>
  <p class="internal">Internal document. It quotes real customer messages and account data.</p>
  <nav class="contents">
    <p class="cotitle">Contents</p>
    <ol>${contents.map(([id, label]) => `<li><a href="#${id}">${escapeHtml(label)}</a></li>`).join('')}</ol>
  </nav>
</header>

<section id="method">
  <h2>How this audit was done</h2>
  <p>Five rounds of expert review read this account. Nobody told them what to look for, and no rule in
  the software decides what good looks like. They read the account's own evidence, and any problem they
  raise must name a mechanism, state what a competent operation achieves instead, offer two other
  explanations for the same evidence, and give a test that would prove it wrong. Anything missing one of
  those is thrown away rather than reported.</p>
  <div class="stages">
    <div><b>1</b><span>expert worked out what this account is, and what each workflow is for</span></div>
    <div><b>${reviews.length}</b><span>experts each read ONE workflow or AI agent in full: its settings, what happened to real contacts, and every message it sends</span></div>
    <div><b>3</b><span>experts read the whole account: the journey, the system, and every message as one stream</span></div>
    <div><b>1</b><span>expert put the problems into the order they should be worked on</span></div>
  </div>
  ${index.internalRail?.available === false ? '<p class="plain-note">The deeper connection was off for this run, so no workflow settings or history were read. Nothing here should be taken as "the automation is fine".</p>' : ''}
</section>

<section id="account">
  <h2>How the account works today</h2>
  ${map?.journey ? `<p class="lede">${escapeHtml(map.journey)}</p>` : ''}
  ${(map?.journeySteps ?? []).length === 0 ? '' : `
  <ol class="steps">${map.journeySteps.map((step) => `<li>${escapeHtml(step)}</li>`).join('')}</ol>`}
  <h3>The path a lead takes</h3>
  ${journeyDiagram(map)}
  <h3>Every workflow, and what it is for</h3>
  ${rolesTable(map)}
  ${(map?.gaps ?? []).length === 0 ? '' : `
  <h3>Parts of the journey with no automation pointed at them</h3>
  <ul class="bullets">${map.gaps.map((gap) => `<li>${escapeHtml(gap)}</li>`).join('')}</ul>`}
</section>

<section id="questions">
  <h2>The six questions, answered</h2>
  <p>These are the questions this audit exists to answer. Each is tied to the step of the journey it is
  about, and a problem appears under a question when it points at that step.</p>
  ${questionsSection({ questions, questionEdges, kpis: journeyBrief?.kpis, targets: journeyBrief?.targets, causes: investigation.causes, rankOf })}
</section>

<section id="funnel">
  <h2>Where people fall out</h2>
  <p>Each row is one step of the journey. The bar is what the account did and the line on it is the
  target. A shaded row is below target.</p>
  ${funnelTable({ kpis: journeyBrief?.kpis, targets: journeyBrief?.targets })}
</section>

${chains === '' ? '' : `
<section id="chains">
  <h2>What starts what</h2>
  <p>Finishing one workflow can start another. Where several workflows fire the same event and several
  listen for it, the wrong person can receive the wrong sequence.</p>
  ${chains}
  ${automationBrief?.collisions?.sharedTriggerTypeCaveat
    ? `<p class="plain-note">${escapeHtml(automationBrief.collisions.sharedTriggerTypeCaveat)}</p>` : ''}
</section>`}

${delivery === '' ? '' : `
<section id="delivery">
  <h2>Onboarding and delivery</h2>
  ${delivery}
</section>`}

<section id="plan">
  <h2>What to do, in order</h2>
  ${planSection(plan, titleOf, rankOf)}
</section>

<section id="findings">
  <h2>Every finding</h2>
  <p>Ranked by what they cost, with how hard they are to fix counting against. Open one to see what to
  change and how you will know it worked.</p>
  <div class="tablewrap">
    <table>
      <thead><tr><th class="num">#</th><th>Problem</th><th>Cost</th><th>Effort</th><th class="num">Experts</th><th>Age</th></tr></thead>
      <tbody>${investigation.causes.map((cause, i) => {
    const age = ageOf.get(cause.causeId);
    return `
      <tr>
        <td class="num"><a href="#f${i + 1}">${i + 1}</a></td>
        <td>${escapeHtml(cause.findings[0]?.title ?? '')}</td>
        <td><span class="band b-${escapeHtml(worstBand(cause, 'commercialImpact'))}">${escapeHtml(worstBand(cause, 'commercialImpact').toLowerCase())}</span></td>
        <td>${escapeHtml(worstBand(cause, 'implementationEffort').toLowerCase())}</td>
        <td class="num">${cause.corroboratingLanes.length} of 3</td>
        <td>${age === undefined ? 'n/a' : age.status === 'RECURRING' ? `seen ${age.priorRuns} times before` : 'new'}</td>
      </tr>`;
  }).join('')}</tbody>
    </table>
  </div>
  <div class="findings">${investigation.causes.map((cause, i) => findingBlock(cause, i + 1)).join('')}</div>
</section>

${(situation?.knownDataCaveats ?? []).length === 0 ? '' : `
<section id="told">
  <h2>What we were told</h2>
  <p>Facts about this account that no amount of data reveals. Every expert reads these before judging
  anything, and they are the difference between a real diagnosis and a confident wrong one. A run only
  carries the ones written down before it collected its evidence.</p>
  <ul class="bullets">${situation.knownDataCaveats.map((caveat) => `<li>${escapeHtml(caveat)}</li>`).join('')}</ul>
</section>`}

<section id="files">
  <h2>Where the detail is</h2>
  <p>This document is the overview. The working material sits beside it on disk.</p>
  <div class="tablewrap">
    <table>
      <thead><tr><th>What</th><th>Where</th></tr></thead>
      <tbody>
        <tr><td>Every message rewritten, workflow by workflow</td><td class="path">private/briefs/${escapeHtml(index.runId)}/reviews/</td></tr>
        <tr><td>One file per problem: what to change, how to check it</td><td class="path">investigations/${escapeHtml(index.runId)}/packages/</td></tr>
        <tr><td>The full argument behind every problem</td><td class="path">investigations/${escapeHtml(index.runId)}/INVESTIGATION.md</td></tr>
        <tr><td>The plan</td><td class="path">investigations/${escapeHtml(index.runId)}/PLAN.md</td></tr>
      </tbody>
    </table>
  </div>
</section>

<footer>
  <p><strong>What this report cannot tell you.</strong> Nothing here proves the settings we read today
  were the settings in force during the period measured. A setting can be called consistent with a
  result, or expected to produce one from now on. It cannot be said to have caused a past result.</p>
  <p>Nothing in this process changes the account. Every fix is for a person to approve and apply.</p>
  <p class="prov">Run ${escapeHtml(index.runId)} &middot; evidence ${escapeHtml((index.briefsHash ?? '').slice(0, 12))}
  &middot; findings ${escapeHtml((investigation.investigationHash ?? '').slice(0, 12))}</p>
</footer>
<script type="module">
  /*
   * Mermaid from a CDN, which works because this document is opened as a local file in a real browser
   * rather than inside a sandbox. If the fetch fails the diagram source stays visible as text, and
   * every fact a diagram draws is also in a table on the same page.
   */
  try {
    const { default: mermaid } = await import('https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs');
    mermaid.initialize({
      /*
       * NOT startOnLoad. This script is a module and resolves an import from a CDN, so by the time
       * mermaid exists the load event has already fired and startOnLoad silently does nothing. Calling
       * run explicitly is what makes the diagrams appear.
       */
      startOnLoad: false,
      theme: 'base',
      themeVariables: {
        background: '#ffffff', primaryColor: '#EEF4F5', primaryTextColor: '#12242B',
        primaryBorderColor: '#9DB6BC', lineColor: '#7A969D', secondaryColor: '#F5F8F9',
        fontFamily: 'ui-sans-serif, system-ui, sans-serif', fontSize: '14px',
      },
    });
    await mermaid.run({ querySelector: 'pre.mermaid' });
  } catch {
    // Offline, blocked, or a malformed diagram: leave the source visible rather than an empty box.
    for (const pre of document.querySelectorAll('pre.mermaid')) pre.classList.add('raw');
  }
</script>`;

  return { html: `${PAGE_STYLE}\n${body}\n`, pageHash: sha256(body) };
}

/** Light only, and deliberately: a report two people describe differently on a call is a bad report. */
const PAGE_STYLE = `<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Account audit</title>
<style>
:root{color-scheme:light;
--paper:#FFFFFF;--wash:#F6F9FA;--ink:#0F2027;--body:#2B3D43;--soft:#465A61;--faint:#5E7379;
--rule:#D3DEE1;--hair:#E9EFF1;--accent:#08525A;--accent-soft:#E4EFF0;
--bad:#A32A2A;--bad-soft:#FBEBEB;--warn:#8A5210;--warn-soft:#FBF0E2;--good:#1F6B45;--good-soft:#E8F3EC;
--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
--sans:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
--serif:ui-serif,Georgia,"Iowan Old Style","Times New Roman",serif}
*{box-sizing:border-box}
html{background:var(--wash)}
body{margin:0 auto;max-width:60rem;padding:0 clamp(1rem,4vw,3.5rem) 5rem;background:var(--paper);
color:var(--body);font-family:var(--sans);font-size:18px;line-height:1.72;-webkit-font-smoothing:antialiased}
p{max-width:56ch}
a{color:var(--accent)}
strong{color:var(--ink)}
.muted{color:var(--soft);font-size:.92em}
.wf,.path{font-family:var(--mono);font-size:.9em;color:var(--ink)}
em.flag{display:block;font-style:normal;font-size:.82rem;font-weight:600;color:var(--warn);margin-top:.25rem}

.cover{padding:clamp(2.5rem,7vw,5rem) 0 2rem;border-bottom:2px solid var(--ink)}
.kicker{font-family:var(--sans);font-size:.86rem;font-weight:700;letter-spacing:.02em;color:var(--accent);margin:0 0 1.3rem}
h1{font-family:var(--serif);font-weight:600;font-size:clamp(2.1rem,5.5vw,3.2rem);line-height:1.05;margin:0;color:var(--ink);letter-spacing:-.02em}
.blurb{font-size:1.1rem;color:var(--soft);margin:1rem 0 0;max-width:60ch}
.figures{display:grid;grid-template-columns:repeat(auto-fit,minmax(10rem,1fr));gap:1px;background:var(--rule);border:1px solid var(--rule);margin:2rem 0 1rem}
.figures>div{background:var(--paper);padding:1rem 1.1rem}
.figures b{display:block;font-family:var(--serif);font-size:2.2rem;line-height:1;color:var(--accent)}
.figures span{display:block;font-size:.88rem;color:var(--soft);margin-top:.35rem;line-height:1.4}
.internal{font-size:.82rem;color:var(--warn);background:var(--warn-soft);padding:.5rem .8rem;border-radius:3px;display:inline-block;margin:0}
.contents{margin-top:2.2rem;border-top:1px solid var(--rule);padding-top:1.2rem}
.cotitle{font-family:var(--sans);font-size:.8rem;letter-spacing:.01em;font-weight:700;color:var(--soft);margin:0 0 .7rem}
.contents ol{margin:0;padding-left:1.5rem;columns:2;column-gap:2.5rem;font-size:1rem;line-height:1.9}
.contents li{margin-bottom:.3rem;break-inside:avoid}
.contents a{text-decoration:none}
.contents a:hover{text-decoration:underline}

section{padding-top:4rem;scroll-margin-top:1rem}
h2{font-family:var(--serif);font-weight:600;font-size:clamp(1.5rem,3vw,2.05rem);line-height:1.15;color:var(--ink);margin:0 0 .7rem;letter-spacing:-.015em}
h3{font-size:1.1rem;font-weight:650;color:var(--ink);margin:2.4rem 0 .7rem;letter-spacing:-.005em}
.lede{font-size:1.12rem;color:var(--ink);max-width:58ch;line-height:1.65}
.plain-note{font-size:.94rem;background:var(--wash);border-left:3px solid var(--rule);padding:.85rem 1.05rem;max-width:62ch;line-height:1.65}
ul.bullets{max-width:70ch;padding-left:0;list-style:none;display:flex;flex-direction:column;gap:.55rem;margin:1rem 0 0}
ul.bullets>li{position:relative;padding-left:1.2rem;font-size:.97rem;line-height:1.68}
ul.bullets>li::before{content:"";position:absolute;left:0;top:.68em;width:5px;height:5px;border-radius:50%;background:var(--accent)}
.stages{display:grid;grid-template-columns:repeat(auto-fit,minmax(12rem,1fr));gap:1px;background:var(--rule);border:1px solid var(--rule);margin-top:1.4rem}
.stages>div{background:var(--paper);padding:1.05rem 1.15rem;font-size:.92rem;color:var(--soft);line-height:1.6}
.stages b{display:block;font-family:var(--serif);font-size:1.7rem;color:var(--accent);line-height:1;margin-bottom:.3rem}
ol.steps{counter-reset:s;list-style:none;padding:0;margin:1.3rem 0 0;max-width:74ch;border-top:1px solid var(--hair)}
ol.steps>li{counter-increment:s;position:relative;padding:.7rem .5rem .7rem 2.6rem;border-bottom:1px solid var(--hair);font-size:.97rem;line-height:1.6}
ol.steps>li::before{content:counter(s);position:absolute;left:.7rem;top:.78rem;font-family:var(--mono);font-size:.76rem;color:var(--accent)}

.tablewrap{overflow-x:auto;border:1px solid var(--rule);margin-top:1.1rem}
table{border-collapse:collapse;width:100%;min-width:30rem;font-size:.94rem}
th,td{text-align:left;padding:.75rem .95rem;border-bottom:1px solid var(--hair);vertical-align:top;line-height:1.6}
thead th{font-family:var(--sans);font-size:.78rem;letter-spacing:.02em;color:var(--soft);font-weight:650;background:var(--wash);border-bottom:1px solid var(--rule);white-space:nowrap}
tbody tr:last-child td{border-bottom:none}
td.num,th.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
tr.below td{background:var(--bad-soft)}
.barcell{min-width:9rem;width:30%}
.bar{position:relative;display:block;height:1.1rem;background:var(--hair);border-radius:2px}
.bar i{position:absolute;top:0;bottom:0;left:0;background:var(--accent);border-radius:2px}
.bar b{position:absolute;top:-3px;bottom:-3px;width:2px;background:var(--warn)}
.tgt{color:var(--warn)}
.nomeasure{font-family:var(--sans);font-size:.88rem;font-weight:600;color:var(--warn)}
.role,.band,.size{display:inline-block;font-size:.8rem;padding:.2rem .5rem;border-radius:3px;white-space:nowrap;font-weight:600}
.r-money_path{background:var(--good-soft);color:var(--good)}
.r-delivery{background:var(--accent-soft);color:var(--accent)}
.r-internal_ops,.r-data_hygiene{background:var(--hair);color:var(--soft)}
.r-abandoned,.r-unclear{background:var(--warn-soft);color:var(--warn)}
.b-CRITICAL,.b-HIGH{background:var(--bad-soft);color:var(--bad)}
.b-MEDIUM{background:var(--warn-soft);color:var(--warn)}
.b-LOW,.b-NONE{background:var(--hair);color:var(--soft)}
.s-SMALL{background:var(--good-soft);color:var(--good)}
.s-MEDIUM{background:var(--warn-soft);color:var(--warn)}
.s-LARGE{background:var(--bad-soft);color:var(--bad)}
.brat{font-size:.92rem;color:var(--soft);margin:.4rem 0 0;max-width:52ch;line-height:1.62}

.qa{padding:1.2rem 1.3rem;border:1px solid var(--rule);border-left-width:4px;margin-top:1.1rem;background:var(--paper)}
.qa.q-answered{border-left-color:var(--bad)}
.qa.q-blind{border-left-color:var(--warn)}
.qa.q-clear{border-left-color:var(--good)}
.qa.q-nostep{border-left-color:var(--rule)}
.qa h3{margin:0;font-size:1.12rem;font-family:var(--serif);font-weight:600;line-height:1.3}
.qn{display:block;font-family:var(--sans);font-size:.78rem;letter-spacing:.02em;color:var(--accent);margin-bottom:.4rem;font-weight:700}
.verdict{font-family:var(--sans);font-size:.86rem;font-weight:650;margin:.55rem 0 1rem;color:var(--soft)}
.q-answered .verdict{color:var(--bad)}
.q-blind .verdict{color:var(--warn)}
.q-clear .verdict{color:var(--good)}
ul.qnums{list-style:none;padding:0;margin:0 0 1rem;display:flex;flex-direction:column;gap:.4rem;font-size:.95rem}
.xref,.xref-line{font-size:.92rem;color:var(--soft);margin:.8rem 0 0}
.xref-line{margin:.35rem 0;max-width:74ch}

.findings{margin-top:.6rem;border-top:1px solid var(--hair)}
details.finding{border-bottom:1px solid var(--hair);scroll-margin-top:1rem}
details.finding>summary{cursor:pointer;list-style:none;display:grid;grid-template-columns:2.1rem minmax(0,1fr) auto;gap:.8rem;align-items:baseline;padding:.85rem 0;font-size:1rem;line-height:1.55}
details.finding>summary::-webkit-details-marker{display:none}
details.finding>summary:hover .ftitle{color:var(--accent)}
.frank{font-family:var(--mono);font-size:.84rem;color:var(--soft)}
.ftitle{color:var(--ink);font-weight:600}
.fmeta{font-family:var(--sans);font-size:.76rem;color:var(--soft)}
.fbody{padding:.3rem 0 1.4rem 2.7rem}
.flabel{font-family:var(--sans);font-size:.8rem;letter-spacing:.01em;font-weight:700;color:var(--accent);margin:1.2rem 0 .45rem}
.fbody p{font-size:.96rem;max-width:60ch;margin:.65rem 0;line-height:1.7}
ul.checks{list-style:none;padding:0;margin:.35rem 0 0;display:flex;flex-direction:column;gap:.45rem;font-size:.94rem;max-width:60ch;line-height:1.6}
ul.checks>li{padding-left:1.35rem;position:relative}
ul.checks>li::before{content:"\\2713";position:absolute;left:0;color:var(--good)}

.copyblock{border:1px solid var(--rule);background:var(--wash);border-radius:4px;padding:.9rem 1.05rem;margin:.9rem 0;max-width:64ch}
.copyblock.email{border-left:3px solid var(--accent)}
.copytag{display:block;font-family:var(--sans);font-size:.8rem;letter-spacing:.01em;font-weight:650;color:var(--soft);margin-bottom:.65rem}
.csubject{font-weight:650;color:var(--ink);margin:0;font-size:.96rem;max-width:none}
.cpre{color:var(--faint);margin:.2rem 0 .7rem;font-size:.86rem;max-width:none}
.cbody{font-size:.96rem;color:var(--body);white-space:pre-wrap;line-height:1.72;max-width:58ch}

.summarybox{border:1px solid var(--rule);border-left:4px solid var(--accent);padding:1.1rem 1.3rem;margin-top:1rem}
.summarybox h3{margin:0 0 .7rem}
ol.weeksteps{counter-reset:w;list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:.6rem}
ol.weeksteps>li{counter-increment:w;position:relative;padding-left:1.9rem;font-size:1rem;line-height:1.7;max-width:62ch}
ol.weeksteps>li::before{content:counter(w);position:absolute;left:0;top:.05rem;font-family:var(--mono);font-size:.72rem;color:var(--accent)}
.prereq{border:1px solid var(--rule);padding:.9rem 1.05rem;margin-top:.6rem;max-width:74ch}
.pname{font-weight:650;color:var(--ink);margin:0 0 .35rem;font-size:.95rem}
.prereq p{font-size:.95rem;margin:.4rem 0 0;line-height:1.65}
.onechanges{display:flex;flex-direction:column;gap:1px;background:var(--rule);border:1px solid var(--rule);margin-top:.9rem}
.onechange{background:var(--paper);padding:.9rem 1.05rem}
.ocname{font-family:var(--mono);font-size:.88rem;color:var(--ink);margin:0 0 .35rem;font-weight:600;max-width:none}
.octext{font-size:.96rem;margin:0;max-width:64ch;line-height:1.68}

figure{margin:1.2rem 0 0;padding:1.2rem;border:1px solid var(--rule);background:var(--wash);overflow-x:auto}
figure .mermaid{display:flex;justify-content:center;background:none;margin:0}
pre.mermaid{font-family:var(--mono);font-size:.75rem;color:var(--faint);white-space:pre;margin:0}
pre.mermaid.raw{white-space:pre-wrap}
figcaption{font-size:.92rem;color:var(--soft);margin-top:1.1rem;text-align:center;max-width:62ch;margin-inline:auto;line-height:1.6}

footer{margin-top:4rem;padding-top:1.4rem;border-top:2px solid var(--ink);font-size:.86rem;color:var(--soft)}
footer p{max-width:62ch}
.prov{font-family:var(--mono);font-size:.78rem;color:var(--soft);margin-top:1.3rem;word-break:break-all}

@media print{
  html,body{background:#fff}
  body{max-width:none;font-size:11pt}
  section{break-inside:avoid}
  details.finding{break-inside:avoid}
  details:not([open])>*:not(summary){display:revert}
  .contents{break-after:page}
}
</style>`;
