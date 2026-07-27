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

const conformance = async (label) => {
  const r = await agent(
    `Run this exact command:
cd "${A.clientFolder}" && node "${A.pluginRoot}/baseline/validate.mjs" "${A.clientFolder}" --conformance
Its stdout is either the single line "validate: PASS" or one violation per line, TAB separated as rule, file, detail.
Return the violations in the schema, an empty array when it passes. Parse only; fix nothing, read nothing else, add no commentary.`,
    { model: 'sonnet', label, effort: 'low', schema: VIOLATIONS }
  )
  return r?.violations ?? []
}

// Every rule the conformance pass raises is mechanically fixable, so the fixer
// gets the file and the violation list and nothing else. It deliberately does
// NOT load the role prompt, the strategy, or the baseline: re-running the
// authoring agent to delete an em dash is what made this expensive.
const fixConformance = async (violations, phaseLabel) => {
  if (!violations.length) return []
  const byFile = new Map()
  for (const x of violations) {
    if (!byFile.has(x.file)) byFile.set(x.file, [])
    byFile.get(x.file).push(x)
  }
  log(`conformance: ${violations.length} violation(s) across ${byFile.size} file(s); dispatching fixers`)
  await parallel([...byFile.entries()].map(([file, list]) => () => agent(
    `Fix these conformance violations in ${A.clientFolder}/${file}. Change nothing else, and change no meaning.
${JSON.stringify(list, null, 2)}

How to fix each rule:
- EM_DASH: replace the em dash with a comma, a colon, or the word "to", whichever reads correctly. Never leave one.
- MALFORMED_FILL_TOKEN: a token must be exactly {{FILL_SNAKE_CASE}} in capitals, digits and underscores. If the text is prose ABOUT tokens rather than a real token, rewrite the prose so it does not contain a literal brace pair.
- CLAIMS_TOKEN_UNDECLARED: add the token to the claims sidecar for that doc, under defines.fill_tokens if this doc introduced it, references.fill_tokens if it only cites it.
- CLAIMS_TOKEN_PHANTOM: the sidecar claims a token the doc does not contain. Remove it from the sidecar, unless the doc should have used it, in which case leave the sidecar and say so in your summary.
- CLAIMS_INVALID_JSON: repair the JSON without inventing entries.
- CLAIMS_SIDECAR_MISSING: create the sidecar with the shape {"defines":{...},"references":{...}} and list the doc's tokens under defines.fill_tokens.

Read only the named file (and its sidecar where the rule concerns one). Your final message is data, not prose.`,
    { model: 'sonnet', label: `fix-conformance:${file.split('/').pop()}`, phase: phaseLabel, effort: 'low', schema: STATUS }
  )))
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
const foundation = await parallel([
  () => agent(boot('client-researcher'), { model: 'sonnet', label: 'research', schema: STATUS }),
  () => agent(boot('ica-brand-voice'), { model: 'sonnet', label: 'ica-voice', schema: STATUS }),
  () => agent(boot('journey-architect'), { model: 'sonnet', label: 'journey', schema: STATUS }),
])
const blocked = foundation.filter(Boolean).filter((r) => r.status === 'blocked')
if (blocked.length) return { failed: 'foundation', blocked }

// Clean the foundation docs before the architect reads them, so it does not
// inherit and propagate a defect.
const foundationResidual = await fixConformance(await conformance('conformance:foundation'), 'Foundation')

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
// Revise until the reviewer finds no blocker (bounded to 3 rounds). All findings
// (blockers and importants) go to the reviser; only a surviving blocker loops.
for (let round = 1; round <= 3 && reviewVerdict && reviewVerdict.verdict === 'revise' && reviewVerdict.findings.some((f) => f.severity === 'blocker'); round++) {
  log(`registry blocked by reviewer; revision round ${round}`)
  const revised = await agent(
    boot('systems-architect', `REVISION ROUND ${round}. Your registry at ${A.clientFolder}/build/${A.runDate}/architecture-final.md was reviewed with these findings, fix every one of them in place (blockers and importants) and append the changes to section 12:
${JSON.stringify(reviewVerdict.findings)}`),
    { model: 'sonnet', label: `architect-revise-${round}`, schema: REGISTRY_SUMMARY }
  )
  if (revised) registrySummary = revised
  reviewVerdict = await agent(
    boot('registry-reviewer', `Re-review after revision round ${round}: ${A.clientFolder}/build/${A.runDate}/architecture-final.md. Prior findings: ${JSON.stringify(reviewVerdict.findings)}`),
    { model: 'sonnet', label: `registry-rereview-${round}`, schema: REVIEW }
  )
}

// The registry is the most consequential artefact in the run, so it gets its
// own conformance pass before the human gate rather than waiting for assembly.
const registryResidual = await fixConformance(await conformance('conformance:registry'), 'Architecture')

const validateOutput = await agent(
  `Run this exact command and return its full output verbatim as your final message:
cd "${A.clientFolder}" && node "${A.pluginRoot}/baseline/validate.mjs" "${A.clientFolder}" ; echo "exit=$?"
No other commentary.`,
  { model: 'sonnet', label: 'validate-floor', effort: 'low' }
)

return {
  registrySummary,
  reviewVerdict,
  validateOutput,
  conformanceResidual: [...foundationResidual, ...registryResidual],
}
