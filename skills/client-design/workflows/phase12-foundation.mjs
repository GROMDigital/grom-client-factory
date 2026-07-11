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

phase('Foundation')
const foundation = await parallel([
  () => agent(boot('client-researcher'), { model: 'sonnet', label: 'research', schema: STATUS }),
  () => agent(boot('ica-brand-voice'), { model: 'sonnet', label: 'ica-voice', schema: STATUS }),
  () => agent(boot('journey-architect'), { model: 'sonnet', label: 'journey', schema: STATUS }),
])
const blocked = foundation.filter(Boolean).filter((r) => r.status === 'blocked')
if (blocked.length) return { failed: 'foundation', blocked }

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

const validateOutput = await agent(
  `Run this exact command and return its full output verbatim as your final message:
cd "${A.clientFolder}" && node "${A.pluginRoot}/baseline/validate.mjs" "${A.clientFolder}" ; echo "exit=$?"
No other commentary.`,
  { model: 'sonnet', label: 'validate-floor', effort: 'low' }
)

return { registrySummary, reviewVerdict, validateOutput }
