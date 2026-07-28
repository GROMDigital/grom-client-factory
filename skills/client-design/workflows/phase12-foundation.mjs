export const meta = {
  name: 'client-design-phase12',
  description: 'Grom client design, phases 1-2: foundation research + binding registry + registry review',
  phases: [
    { title: 'Foundation', detail: '3 parallel researchers' },
    { title: 'Architecture', detail: 'registry + independent review' },
  ],
}

const A = typeof args === 'string' ? JSON.parse(args) : args
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
${extra ?? ''}
Analyze before you write: every choice states its reason grounded in this client's inputs, and any section that could apply to any clinic unchanged is a failure, so adapt it or token it as a question.
Write your deliverable and claims sidecar exactly where your role prompt says.
CONFORMANCE IS CHECKED FOR YOU. After you return, ${A.pluginRoot}/baseline/validate.mjs runs over your output and enforces: no em dashes in customer-facing copy and in AI agent instruction text (internal analysis prose is exempt, see guardrail 2), no malformed fill tokens, your sidecar parses, and every {{FILL_*}} in your doc is declared in your sidecar and nothing is declared that is not in the doc. Do NOT spend turns grepping your own output for em dashes, counting tokens, or hand-validating your own JSON. That is measured waste: it costs model calls at your largest context and it is unreliable because it depends on you remembering. Write it correctly, write the sidecar completely, and return. Anything that fails comes back to you as a fix note with exact line numbers.
Your final message is data for the orchestrator, not prose for a human.`

// --- conformance, centralised -------------------------------------------
// Agents used to enforce guardrails 2 and 3 on themselves by grepping their own
// output. Measured on the 2026-07-27 baseline that was roughly a quarter of all
// model calls, made at each agent's LARGEST context, and unreliable: the one
// agent that skipped its self-check shipped two em dashes. It now runs once per
// wave, in one cheap call, and routes fixes to a small fixer rather than back
// through the authoring agent's full context.
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

phase('Foundation')
const FOUNDATION_ROLES = ['client-researcher', 'ica-brand-voice', 'journey-architect']
const FOUNDATION_DOCS = [
  'design/business-and-offer-brief.md',
  'design/ica-brand-voice.md',
  'design/journey-architecture-notes.md',
]
const foundation = await parallel(FOUNDATION_ROLES.map((id) => () => agent(boot(id), { model: 'sonnet', label: id, schema: STATUS })))
// A null result is a dead agent, not an absent one. Filtering it out is how
// 2026-07-28 lost a document and carried on regardless.
const deadFoundation = FOUNDATION_ROLES.filter((_, i) => !foundation[i])
if (deadFoundation.length) return { failed: 'foundation-agent-died', dead: deadFoundation, note: 'these agents returned nothing, so their documents were never written' }
const blocked = foundation.filter((r) => r.status === 'blocked')
if (blocked.length) return { failed: 'foundation', blocked }

// The foundation set is the architect's only input, so its documents are proved
// to exist before the architect is paid to read them. There is no separate
// conformance pass here any more: guardrail 2 exempts internal analysis prose,
// and a claims defect in a research brief does not change what the architect
// reads. Conformance now runs once, after the registry.
const foundationCheck = await conformance('foundation-docs-exist', FOUNDATION_DOCS)
const foundationMissing = foundationCheck.filter((x) => x.rule === 'DOC_MISSING' || x.rule === 'DOC_STUB')
if (foundationMissing.length) {
  return {
    failed: 'foundation-documents-missing',
    missingDocs: foundationMissing,
    note: 'an agent reported success and its document is absent or unfinished; the architect is not run against a hole',
  }
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
  },
}
let registrySummary = await agent(
  boot('systems-architect', `Registry template: ${A.pluginRoot}/skills/client-design/templates/architecture-final.md
Version stamps to copy into section 13: ${JSON.stringify(A.versionStamps)}
Write the registry to ${A.clientFolder}/build/${A.runDate}/architecture-final.md`),
  { model: 'sonnet', label: 'systems-architect', schema: REGISTRY_SUMMARY }
)
if (!registrySummary) return { failed: 'architect' }

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
// The old loop ran up to three rounds but only ever entered on a surviving
// BLOCKER, so on 2026-07-28 it exited cleanly leaving two `important` findings
// standing, one of them a Tier-1 data placement breach. It was only fixed
// because the PM happened to read the findings by hand. A rule the build treats
// as law is not a matter of severity: if the reviewer says the registry breaches
// it, the architect revises.
// The loop is gone as well. Rounds 2 and 3 almost never changed the verdict, and
// GATE 2 is a human reading this registry before anything is built, which is a
// better backstop than a third model round.
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
// Anything still standing is surfaced at GATE 2 rather than looped on. The PM
// must show it: see SKILL.md, the post-registry gate.
const survivingFindings = (reviewVerdict?.findings ?? [])
  .filter((f) => f.severity === 'blocker' || f.severity === 'important')

// The registry is the most consequential artefact in the run, so conformance
// runs here, before the human gate, over the foundation docs and the registry
// together. One pass, not one per wave.
const registryResidual = await fixConformance(
  await conformance('conformance:registry', [...FOUNDATION_DOCS, `build/${A.runDate}/architecture-final.md`]),
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
