export const meta = {
  name: 'client-design-phase34',
  description: 'Grom client design, phases 3-4: module fan-out in waves + audit and bounded fix loop',
  phases: [
    { title: 'Wave 3a', detail: 'registry-only modules' },
    { title: 'Wave 3b', detail: 'modules consuming 3a' },
    { title: 'LP build', detail: 'brief -> prompt -> code per LP' },
    { title: 'Audit', detail: '3 auditors + fix loop' },
    { title: 'Close', detail: 'fill guide + assembler' },
  ],
}

const A = typeof args === 'string' ? JSON.parse(args) : args
const R = A.registrySummary
const activeIds = new Set(A.activeRoleIds)
const rolesIn = (phase) => A.roster.roles.filter((r) => r.phase === phase && activeIds.has(r.id) && r.per_item === null)

const boot = (roleId, extra) => `You are the "${roleId}" agent in the Grom client-design factory.
READ FIRST, in this order:
1. ${A.pluginRoot}/baseline/guardrails.md
2. ${A.promptsDir}/${roleId}.md (your role prompt; follow it exactly)
3. THE BINDING REGISTRY: ${A.registryPath} (its spellings and doc index are law)
4. The other inputs your role prompt lists
Client folder (absolute): ${A.clientFolder}
Run date: ${A.runDate}
Analyze before you write: every choice states its reason grounded in this client's inputs, and any section that could apply to any clinic unchanged is a failure, so adapt it or token it as a question.
Write your deliverable per the registry doc index, and your claims sidecar to
${A.clientFolder}/build/${A.runDate}/claims/. Your final message is data, not prose.
${extra ?? ''}`

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

phase('Wave 3a')
const wave3a = await parallel(rolesIn('3a').map((r) => () => agent(boot(r.id), { model: 'sonnet', label: r.id, phase: 'Wave 3a', schema: STATUS })))

// LP chain runs as its own pipeline, overlapping wave 3b: brief -> prompt -> coded page per LP.
// Per LP: a research/design team appends to that LP's section, ending in ONE comprehensive
// build prompt (the deliverable). Headless coding is NOT in the default flow; a design
// session runs the prompt (lp-design-engineer stays available for optional manual builds).
const lpChain = R.no_lps ? Promise.resolve([]) : pipeline(
  R.lps,
  (lp) => agent(boot('lp-brand-researcher', `THIS RUN COVERS ONE LANDING PAGE ONLY: ${JSON.stringify(lp)}. Research this brand's real visual identity and append the Brand identity block for this LP.`), { model: 'sonnet', label: `lp-brand:${lp.slug}`, phase: 'LP build', schema: STATUS }),
  (brand, lp) => agent(boot('lp-strategist', `LP: ${JSON.stringify(lp)}. Brand research status: ${JSON.stringify(brand)}. Write the CRO strategy and structure brief section for this LP.`), { model: 'sonnet', label: `lp-strategy:${lp.slug}`, phase: 'LP build', schema: STATUS }),
  (strat, lp) => agent(boot('lp-copywriter', `LP: ${JSON.stringify(lp)}. Strategy status: ${JSON.stringify(strat)}. Read this LP's section (brand + strategy) and write the finished page copy.`), { model: 'sonnet', label: `lp-copy:${lp.slug}`, phase: 'LP build', schema: STATUS }),
  (copy, lp) => agent(boot('lp-designer', `LP: ${JSON.stringify(lp)}. Copy status: ${JSON.stringify(copy)}. Read this LP's brand, strategy, and copy, then write the design brief, applying the frontend-design, ui-ux-pro-max, and responsive-design methodology.`), { model: 'sonnet', label: `lp-design:${lp.slug}`, phase: 'LP build', schema: STATUS }),
  (design, lp) => agent(boot('lp-prompt-engineer', `LP: ${JSON.stringify(lp)}. Design brief status: ${JSON.stringify(design)}. Read this LP's full section (brand, strategy, copy, design brief) and the tracking doc, then assemble the one comprehensive build prompt a design session will execute.`), { model: 'sonnet', label: `lp-prompt:${lp.slug}`, phase: 'LP build', schema: STATUS })
)

phase('Wave 3b')
const wave3bRoles = rolesIn('3b')
// nurture-copywriter's voice-consistency pass reads the workflow-designer doc, so it runs AFTER the rest of 3b, not alongside it.
const wave3bMain = await parallel(wave3bRoles.filter((r) => r.id !== 'nurture-copywriter').map((r) => () => agent(boot(r.id), { model: 'sonnet', label: r.id, phase: 'Wave 3b', schema: STATUS })))
const nurtureActive = wave3bRoles.some((r) => r.id === 'nurture-copywriter')
const nurtureResult = nurtureActive ? await agent(boot('nurture-copywriter'), { model: 'sonnet', label: 'nurture-copywriter', phase: 'Wave 3b', schema: STATUS }) : null
const wave3b = [...wave3bMain, ...(nurtureResult ? [nurtureResult] : [])]
const lpResults = (await lpChain).flat().filter(Boolean)

const moduleStatuses = [...wave3a, ...wave3b, ...lpResults].filter(Boolean)
const blockedModules = moduleStatuses.filter((m) => m.status === 'blocked')

phase('Audit')
const FINDINGS = {
  type: 'object',
  required: ['findings'],
  properties: {
    findings: { type: 'array', items: { type: 'object', required: ['doc', 'issue', 'fix', 'severity'], properties: { doc: { type: 'string' }, issue: { type: 'string' }, fix: { type: 'string' }, severity: { enum: ['blocker', 'important', 'minor'] } } } },
  },
}
const auditorIds = ['registry-reconciler', 'journey-leak-auditor', 'compliance-brand-auditor']
let auditRounds = []
let findings = (await parallel(auditorIds.map((id) => () => agent(boot(id), { model: 'sonnet', label: id, phase: 'Audit', schema: FINDINGS }))))
  .filter(Boolean).flatMap((r) => r.findings)
auditRounds.push(findings.length)

let residualConflicts = []
for (let round = 1; round <= 2 && findings.length > 0; round++) {
  const byDoc = new Map()
  for (const f of findings) { if (!byDoc.has(f.doc)) byDoc.set(f.doc, []); byDoc.get(f.doc).push(f) }
  const ownerOf = (docFile) => (R.doc_index.find((d) => d.file === docFile) || {}).owner_role
  await parallel([...byDoc.entries()].map(([docFile, fs]) => () => {
    const owner = ownerOf(docFile)
    if (!owner) return Promise.resolve(null)
    return agent(boot(owner, `FIX ROUND ${round}. Your doc ${docFile} received these audit fix-notes. Apply them in place, update your claims sidecar, change nothing else:
${JSON.stringify(fs)}`), { model: 'sonnet', label: `fix:${docFile}`, phase: 'Audit', schema: STATUS })
  }))
  const recheck = await agent(boot('registry-reconciler', `RE-CHECK ROUND ${round}. Only re-verify the docs that just changed: ${[...byDoc.keys()].join(', ')}. Report remaining or newly introduced findings only.`), { model: 'sonnet', label: `recheck-${round}`, phase: 'Audit', schema: FINDINGS })
  findings = recheck ? recheck.findings : []
  auditRounds.push(findings.length)
}
residualConflicts = findings

phase('Close')
const fillGuide = await agent(boot('fill-guide-compiler', `Residual conflicts to record as precedence notes: ${JSON.stringify(residualConflicts)}`), { model: 'sonnet', label: 'fill-guide', phase: 'Close', schema: STATUS })
const overview = await agent(boot('assembler', `Module statuses: ${JSON.stringify(moduleStatuses.map((m) => ({ doc: m.doc, status: m.status })))}. Blocked modules: ${JSON.stringify(blockedModules)}.`), { model: 'sonnet', label: 'assembler', phase: 'Close', schema: STATUS })

return {
  moduleStatuses,
  blockedModules,
  fixLoopReport: { roundsFindingCounts: auditRounds },
  residualConflicts,
  deliverables: [fillGuide, overview].filter(Boolean),
}
