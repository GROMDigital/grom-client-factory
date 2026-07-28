export const meta = {
  name: 'client-design-phase2',
  description: 'Grom client design, phase 2: the binding registry, written FROM the proposal a human agreed at GATE 1',
  phases: [
    { title: 'Architecture', detail: 'registry + one independent review' },
  ],
}

// Split out of the old phase12 workflow on 2026-07-28 so GATE 1 can sit in
// front of it. The architect no longer writes from a machine's proposal: it
// writes from the version a human corrected, which is the whole point of the
// gate.
const A = typeof args === 'string' ? JSON.parse(args) : args

// What the human decided at GATE 1. Free text, in his words, passed straight
// through. It OVERRIDES the proposal document wherever the two differ, because
// the document is what he was reacting to.
const gate1 = (A.gate1Decisions ?? '').trim()

const boot = (roleId, extra) => `You are the "${roleId}" agent in the Grom client-design factory.
READ FIRST, in this order:
1. ${A.pluginRoot}/baseline/guardrails.md (binding, verbatim rules)
2. ${A.promptsDir}/${roleId}.md (your full role prompt; follow it exactly)
3. The inputs your role prompt lists, under client folder ${A.clientFolder}
Client folder (absolute): ${A.clientFolder}
Run date: ${A.runDate}
Strategy doc: ${A.strategyPath}
Pre-build capture: ${A.capturePath ?? 'none (greenfield account)'}
Materials inventory: ${A.materialsInventory}
${gate1 ? `
🔴 GATE 1 DECISIONS. A human read the build proposal at ${A.clientFolder}/design/build-proposal.md and said this. It is binding, and where it differs from the proposal document, HE WINS. Do not re-litigate a decision he has made, do not restore a workflow he cut, and do not treat a question he answered as still open:
${gate1}
` : ''}${extra ?? ''}
Analyze before you write: every choice states its reason grounded in this client's inputs, and any section that could apply to any clinic unchanged is a failure, so adapt it or token it as a question.
Write your deliverable and claims sidecar exactly where your role prompt says.
CONFORMANCE IS CHECKED FOR YOU. After you return, ${A.pluginRoot}/baseline/validate.mjs runs over your output and enforces: no em dashes in customer-facing copy and in AI agent instruction text (internal analysis prose is exempt, see guardrail 2), no malformed fill tokens, your sidecar parses, and every {{FILL_*}} in your doc is declared in your sidecar and nothing is declared that is not in the doc. Do NOT spend turns grepping your own output for em dashes, counting tokens, or hand-validating your own JSON. That is measured waste: it costs model calls at your largest context and it is unreliable because it depends on you remembering. Write it correctly, write the sidecar completely, and return.
Your final message is data for the orchestrator, not prose for a human.`

const STATUS = {
  type: 'object',
  required: ['doc', 'status', 'summary'],
  properties: {
    doc: { type: 'string' },
    status: { enum: ['done', 'blocked'] },
    summary: { type: 'string' },
    fill_tokens_introduced: { type: 'array', items: { type: 'string' } },
  },
}

const VIOLATIONS = {
  type: 'object',
  required: ['violations'],
  properties: {
    violations: {
      type: 'array',
      items: {
        type: 'object',
        required: ['rule', 'file', 'detail'],
        properties: { rule: { type: 'string' }, file: { type: 'string' }, detail: { type: 'string' } },
      },
    },
  },
}

// One cheap call: repair everything mechanical in CODE, then report what is
// left. conformance_fix.mjs renames, creates and reconciles sidecars
// deterministically and never deletes a file. Agents doing that by hand on
// 2026-07-28 deleted five sidecars carrying 25 fill tokens.
const conformance = async (label, expectDocs = []) => {
  const docsFlag = expectDocs.length ? ` "--docs=${expectDocs.join(',')}"` : ''
  const r = await agent(
    `Run these two commands in order, and do not stop if the first prints actions:
cd "${A.clientFolder}" && node "${A.pluginRoot}/baseline/conformance_fix.mjs" "${A.clientFolder}"
cd "${A.clientFolder}" && node "${A.pluginRoot}/baseline/validate.mjs" "${A.clientFolder}" --conformance${docsFlag}
The first repairs what is mechanically repairable and prints one action per line. The second re-checks: its stdout is either the single line "validate: PASS" or one violation per line, TAB separated as rule, file, detail.
Return the SECOND command's violations in the schema, an empty array when it passes. Parse only; fix nothing yourself, read nothing else, add no commentary.`,
    { model: 'sonnet', label, effort: 'low', schema: VIOLATIONS }
  )
  return r?.violations ?? []
}

// What survives code repair needs judgement, and one agent takes all of it,
// across every file. It deliberately does NOT load the role prompt, the
// strategy, or the baseline: re-running an authoring agent to delete an em dash
// is what made this expensive.
const JUDGEMENT_RULES = new Set(['EM_DASH', 'MALFORMED_FILL_TOKEN'])
const fixConformance = async (violations, phaseLabel) => {
  if (!violations.length) return []
  const judgement = violations.filter((x) => JUDGEMENT_RULES.has(x.rule))
  const mechanical = violations.filter((x) => !JUDGEMENT_RULES.has(x.rule))
  if (mechanical.length) {
    log(`conformance: ${mechanical.length} violation(s) code repair could not clear; surfacing rather than guessing`)
  }
  if (!judgement.length) return violations
  log(`conformance: ${judgement.length} judgement violation(s); one fixer`)
  await agent(
    `Fix these conformance violations. Change nothing else, and change no meaning. Paths are relative to ${A.clientFolder}.
${JSON.stringify(judgement, null, 2)}

How to fix each rule:
- EM_DASH: replace the em dash with a comma, a colon, or the word "to", whichever reads correctly in that sentence. Never leave one.
- MALFORMED_FILL_TOKEN: a real token is exactly {{FILL_SNAKE_CASE}} in capitals, digits and underscores. Correct the token's spelling. If the text is prose ABOUT the token pattern rather than a token, leave it alone and say so: the validator already exempts {{FILL_*}} and {{FILL_...}}, so a third form has appeared and a human should name it.

🔴 You must NEVER delete a file, and never remove a claims sidecar or an entry
from one. A fixer agent deleting files it did not understand is the defect this
whole step was rebuilt to prevent. If a fix seems to require a deletion, do not
do it: leave the file untouched and report it in your summary.

Read only the named files. Your final message is data, not prose.`,
    { model: 'sonnet', label: 'fix-conformance', phase: phaseLabel, effort: 'low', schema: STATUS }
  )
  const remaining = await conformance(`conformance-recheck:${phaseLabel}`)
  if (remaining.length) log(`conformance: ${remaining.length} violation(s) survived the fixer`)
  return remaining
}

phase('Architecture')
const REGISTRY_SUMMARY = {
  type: 'object',
  required: ['client_key', 'no_lps', 'no_voice', 'no_chat_ai', 'lps', 'workflows', 'doc_index', 'summary_for_human'],
  properties: {
    client_key: { type: 'string' },
    no_lps: { type: 'boolean' },
    no_voice: { type: 'boolean' },
    no_chat_ai: { type: 'boolean' },
    lps: { type: 'array', items: { type: 'object', required: ['slug', 'purpose'], properties: { slug: { type: 'string' }, purpose: { type: 'string' } } } },
    workflows: { type: 'array', items: { type: 'object', required: ['number', 'name'], properties: { number: { type: 'string' }, name: { type: 'string' } } } },
    doc_index: { type: 'array', items: { type: 'object', required: ['file', 'owner_role'], properties: { file: { type: 'string' }, owner_role: { type: 'string' } } } },
    summary_for_human: { type: 'string' },
    // 🔴 Section 5 is the full fields and tags list. It was always written
    // before the fan-out and always sat behind this gate; the PM simply never
    // showed it, so nobody ever read it until the build was finished. The
    // proposal at GATE 1 deliberately gives only the unusual ones, so this is
    // where the complete list gets a human's eyes.
    fields_and_tags_for_human: {
      type: 'string',
      description: 'Registry section 5 restated in plain English: every custom field and tag, one line each on what it is for and who writes it. This is shown to a human at GATE 2.',
    },
  },
}
let registrySummary = await agent(
  boot('systems-architect', `Registry template: ${A.pluginRoot}/skills/client-design/templates/architecture-final.md
Version stamps to copy into section 13: ${JSON.stringify(A.versionStamps)}
Write the registry to ${A.clientFolder}/build/${A.runDate}/architecture-final.md
🔴 You are writing FROM an agreed proposal, not from scratch. ${A.clientFolder}/design/build-proposal.md was read and corrected by a human before you ran. Treat its workflow list as decided.`),
  { model: 'sonnet', label: 'systems-architect', schema: REGISTRY_SUMMARY }
)
if (!registrySummary) return { failed: 'architect-agent-died', note: 'the architect returned nothing, so no registry was written' }

const REVIEW = {
  type: 'object',
  required: ['verdict', 'findings'],
  properties: {
    verdict: { enum: ['approve', 'revise'] },
    findings: { type: 'array', items: { type: 'object', required: ['severity', 'issue', 'fix'], properties: { severity: { enum: ['blocker', 'important', 'minor'] }, issue: { type: 'string' }, fix: { type: 'string' } } } },
  },
}
let reviewVerdict = await agent(
  boot('registry-reviewer', `Registry to review: ${A.clientFolder}/build/${A.runDate}/architecture-final.md`),
  { model: 'sonnet', label: 'registry-review', schema: REVIEW }
)

// 🔴 ONE revision pass, and it triggers on `important` as well as `blocker`.
// The old loop ran up to three rounds but only ever ENTERED on a surviving
// blocker, so on 2026-07-28 it exited cleanly leaving two `important` findings
// standing, one of them a Tier-1 data placement breach. It was fixed only
// because the PM happened to read the findings by hand. A rule the build treats
// as law is not a matter of severity.
// The loop is gone too: rounds 2 and 3 almost never changed the verdict, and
// GATE 2 is a human reading this registry, which is a better backstop than a
// third model round.
const needsRevision = (rv) => rv && rv.verdict === 'revise'
  && rv.findings.some((f) => f.severity === 'blocker' || f.severity === 'important')

if (needsRevision(reviewVerdict)) {
  const blockers = reviewVerdict.findings.filter((f) => f.severity === 'blocker').length
  const importants = reviewVerdict.findings.filter((f) => f.severity === 'important').length
  log(`registry sent back: ${blockers} blocker(s), ${importants} important(s); one revision pass`)
  const revised = await agent(
    boot('systems-architect', `REVISION. Your registry at ${A.clientFolder}/build/${A.runDate}/architecture-final.md was reviewed with these findings. Fix every one of them in place, blockers and importants alike, and append the changes to section 12:
${JSON.stringify(reviewVerdict.findings)}

This is the ONLY revision pass. There is no second round: whatever you leave
unfixed goes in front of a human at the gate with your name on it.`),
    { model: 'sonnet', label: 'architect-revise', schema: REGISTRY_SUMMARY }
  )
  if (revised) registrySummary = revised
  reviewVerdict = await agent(
    boot('registry-reviewer', `Re-review after the revision: ${A.clientFolder}/build/${A.runDate}/architecture-final.md. Prior findings: ${JSON.stringify(reviewVerdict.findings)}. This verdict is final and goes straight to a human, so report exactly what still stands.`),
    { model: 'sonnet', label: 'registry-rereview', schema: REVIEW }
  )
}
const survivingFindings = (reviewVerdict?.findings ?? [])
  .filter((f) => f.severity === 'blocker' || f.severity === 'important')

// The registry is the most consequential artefact in the run, so conformance
// runs here, before the human gate, over the foundation docs and the registry
// together. One pass, not one per wave.
const registryResidual = await fixConformance(
  await conformance('conformance:registry', [
    'design/business-and-offer-brief.md',
    'design/ica-brand-voice.md',
    'design/build-proposal.md',
    `build/${A.runDate}/architecture-final.md`,
  ]),
  'Architecture'
)

const validateOutput = await agent(
  `Run this exact command and return its full output verbatim as your final message:
cd "${A.clientFolder}" && node "${A.pluginRoot}/baseline/validate.mjs" "${A.clientFolder}" ; echo "exit=$?"
No other commentary.`,
  { model: 'sonnet', label: 'validate-floor', effort: 'low' }
)

return {
  registrySummary,
  reviewVerdict,
  // 🔴 The PM must surface these at GATE 2. They are what the old loop used to
  // swallow, and one of them was a Tier-1 breach.
  survivingFindings,
  validateOutput,
  conformanceResidual: registryResidual,
}
