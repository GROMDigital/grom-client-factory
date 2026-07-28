export const meta = {
  name: 'client-design-phase1',
  description: 'Grom client design, phase 1: foundation research and the build proposal that GATE 1 reads',
  phases: [
    { title: 'Foundation', detail: '3 parallel researchers' },
  ],
}

// Split out of the old phase12 workflow on 2026-07-28. GATE 1 is a human
// reading the build proposal BEFORE the registry is written, and a workflow
// cannot pause for a human, so the run stops here and the PM restarts it at
// phase 2 with the agreed version. Nothing has been built when he reads it, so
// changing his mind is free; the old shape put the only gate after 53 agents.
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

// The proposal returns more than a status because GATE 1 is built from it. The
// design questions travel structured so the PM can put them in front of a human
// one per line instead of asking him to find them in prose.
const PROPOSAL = {
  type: 'object',
  required: ['doc', 'status', 'summary', 'design_questions'],
  properties: {
    doc: { type: 'string' },
    status: { enum: ['done', 'blocked'] },
    summary: { type: 'string' },
    design_questions: {
      type: 'array',
      items: {
        type: 'object',
        required: ['question', 'what_changes'],
        properties: {
          question: { type: 'string' },
          what_changes: { type: 'string', description: 'what is built differently depending on the answer' },
          options: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    value_gap_count: { type: 'integer' },
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

const FOUNDATION_DOCS = [
  'design/business-and-offer-brief.md',
  'design/ica-brand-voice.md',
  'design/build-proposal.md',
]

phase('Foundation')
const FOUNDATION_ROLES = ['client-researcher', 'ica-brand-voice', 'journey-architect']
const foundation = await parallel([
  () => agent(boot('client-researcher'), { model: 'sonnet', label: 'client-researcher', schema: STATUS }),
  () => agent(boot('ica-brand-voice'), { model: 'sonnet', label: 'ica-brand-voice', schema: STATUS }),
  () => agent(boot('journey-architect'), { model: 'sonnet', label: 'journey-architect', schema: PROPOSAL }),
])

// A null result is a dead agent, not an absent one. Filtering it out is how
// 2026-07-28 lost a document and carried on regardless.
const deadFoundation = FOUNDATION_ROLES.filter((_, i) => !foundation[i])
if (deadFoundation.length) {
  return { failed: 'foundation-agent-died', dead: deadFoundation, note: 'these agents returned nothing, so their documents were never written' }
}
const blocked = foundation.filter((r) => r.status === 'blocked')
if (blocked.length) return { failed: 'foundation', blocked }

// Prove the documents exist before a human is asked to read one of them. No
// conformance pass runs here: guardrail 2 exempts internal analysis prose, and
// a claims defect in a research brief changes nothing a human decides at GATE 1.
// Conformance runs once, in phase 2, after the registry.
const docsCheck = await agent(
  `Run these two commands in order, and do not stop if the first prints actions:
cd "${A.clientFolder}" && node "${A.pluginRoot}/baseline/conformance_fix.mjs" "${A.clientFolder}"
cd "${A.clientFolder}" && node "${A.pluginRoot}/baseline/validate.mjs" "${A.clientFolder}" --conformance "--docs=${FOUNDATION_DOCS.join(',')}"
The second command's stdout is either the single line "validate: PASS" or one violation per line, TAB separated as rule, file, detail.
Return the SECOND command's violations in the schema, an empty array when it passes. Parse only; fix nothing yourself, read nothing else, add no commentary.`,
  { model: 'sonnet', label: 'foundation-docs-exist', effort: 'low', schema: VIOLATIONS }
)
const missingDocs = (docsCheck?.violations ?? []).filter((x) => x.rule === 'DOC_MISSING' || x.rule === 'DOC_STUB')
if (missingDocs.length) {
  return {
    failed: 'foundation-documents-missing',
    missingDocs,
    note: 'an agent reported success and its document is absent or unfinished; GATE 1 is not run against a hole',
  }
}

const [research, voice, proposal] = foundation
log(`proposal written with ${proposal.design_questions?.length ?? 0} design question(s) for GATE 1`)

return {
  research,
  voice,
  proposal,
  proposalPath: `${A.clientFolder}/design/build-proposal.md`,
  // 🔴 The PM stops here. GATE 1 is a human reading the proposal. Phase 2 is a
  // separate workflow, launched with his amendments, not a continuation.
  nextStep: 'GATE 1: present the proposal and its design questions, get decisions, then launch phase2-registry.mjs with gate1Decisions',
}
