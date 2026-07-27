export const meta = {
  name: 'client-design-phase34',
  description: 'Grom client design, phases 3-4: module fan-out in waves + audit and bounded fix loop',
  phases: [
    { title: 'Wave 3a', detail: 'registry-only modules' },
    { title: 'Wave 3b', detail: 'modules consuming 3a' },
    { title: 'LP build', detail: 'brief -> prompt -> code per LP' },
    { title: 'Audit', detail: '3 auditors + fix loop' },
    { title: 'Close', detail: 'fill guide + assembler + system guide' },
  ],
}

const A = typeof args === 'string' ? JSON.parse(args) : args
const R = A.registrySummary
const activeIds = new Set(A.activeRoleIds)
const rolesIn = (phase) => A.roster.roles.filter((r) => r.phase === phase && activeIds.has(r.id) && r.per_item === null)

// Per-role registry scoping. The registry runs to roughly 700 lines and is read
// by every module role, which made it the largest single repeated input after
// the harness itself. roster.json says which sections each role is pointed at
// first; the naming spine is always added, and reading more is always allowed,
// so a wrong entry costs a saving rather than blinding an agent.
const roleById = new Map((A.roster?.roles ?? []).map((r) => [r.id, r]))
const SPINE = A.roster?.registry_scoping?.always_included ?? ['3', '5', '6', '9', '11', '12']
const secOrder = (s) => parseInt(s, 10) * 10 + (/[A-Z]$/.test(s) ? s.charCodeAt(s.length - 1) - 64 : 0)

const registryLine = (roleId) => {
  const scoped = roleById.get(roleId)?.registry_sections
  if (!scoped) return `3. THE BINDING REGISTRY, IN FULL: ${A.registryPath} (its spellings and doc index are law)`
  const secs = [...new Set([...scoped, ...SPINE])].sort((a, b) => secOrder(a) - secOrder(b))
  return `3. THE BINDING REGISTRY: ${A.registryPath}. Its exact spellings and its doc index are LAW.
   START with sections ${secs.join(', ')}: the ones your role owns, plus the naming spine (3 workflow names and numbers, 5 fields and tags and custom values, 6 calendars and payment products, 9 alert ids, 11 the doc index that tells you where to write, 12 the amendment log which overrides anything above it). This one command pulls exactly those:
     sed -n ${secs.map((n) => `-e '/^## ${n}\\./,/^## /p'`).join(' ')} "${A.registryPath}"
   You MAY read any other section the moment you need it, and you should. What you must NOT do is infer a name you have not read: guardrail 6 makes spellings load-bearing, so read the section rather than guess at it. Reading the whole file when you genuinely need the whole file is correct; reading it out of habit is what this scoping exists to stop.`
}

const boot = (roleId, extra) => `You are the "${roleId}" agent in the Grom client-design factory.
READ FIRST, in this order:
1. ${A.pluginRoot}/baseline/guardrails.md
2. ${A.promptsDir}/${roleId}.md (your role prompt; follow it exactly)
${registryLine(roleId)}
4. The other inputs your role prompt lists
Client folder (absolute): ${A.clientFolder}
Run date: ${A.runDate}
Analyze before you write: every choice states its reason grounded in this client's inputs, and any section that could apply to any clinic unchanged is a failure, so adapt it or token it as a question.
Write your deliverable per the registry doc index, and your claims sidecar to
${A.clientFolder}/build/${A.runDate}/claims/.
CONFORMANCE IS CHECKED FOR YOU. After you return, ${A.pluginRoot}/baseline/validate.mjs runs over your output and enforces: no em dashes in customer-facing copy and in AI agent instruction text (internal analysis prose is exempt, see guardrail 2), no malformed fill tokens, your sidecar parses, and every {{FILL_*}} in your doc is declared in your sidecar and nothing is declared that is not in the doc. Do NOT spend turns grepping your own output for em dashes, counting tokens, or hand-validating your own JSON. That is measured waste: it costs model calls at your largest context and it is unreliable because it depends on you remembering. Write it correctly, write the sidecar completely, and return. Anything that fails comes back to you as a fix note with exact line numbers.
Your final message is data, not prose.
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

// --- conformance, centralised -------------------------------------------
// Guardrails 2 and 3 are enforced once per wave by baseline/validate.mjs rather
// than by every agent grepping its own output. See phase12-foundation.mjs for
// the measurement that motivated moving it.
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

The registry's exact spellings are law: never respell a workflow name, tag, field, calendar, product or alert id while fixing.
Read only the named file (and its sidecar where the rule concerns one). Your final message is data, not prose.`,
    { model: 'sonnet', label: `fix-conformance:${file.split('/').pop()}`, phase: phaseLabel, effort: 'low', schema: STATUS }
  )))
  const remaining = await conformance(`conformance-recheck:${phaseLabel}`)
  if (remaining.length) log(`conformance: ${remaining.length} violation(s) survived the fixer`)
  return remaining
}

phase('Wave 3a')
const wave3a = await parallel(rolesIn('3a').map((r) => () => agent(boot(r.id), { model: 'sonnet', label: r.id, phase: 'Wave 3a', schema: STATUS })))

// Landing pages are NOT built by this factory. The funnel's LP(s) are designed and built
// separately (Grom design), so there is no LP role and no LP chain here. The tracking-pixel
// and workflow modules still account for the LP as a funnel step.

phase('Wave 3b')
const wave3bRoles = rolesIn('3b')
// nurture-copywriter's voice-consistency pass reads the workflow-designer doc, so it runs AFTER the rest of 3b, not alongside it.
const wave3bMain = await parallel(wave3bRoles.filter((r) => r.id !== 'nurture-copywriter').map((r) => () => agent(boot(r.id), { model: 'sonnet', label: r.id, phase: 'Wave 3b', schema: STATUS })))
const nurtureActive = wave3bRoles.some((r) => r.id === 'nurture-copywriter')
const nurtureResult = nurtureActive ? await agent(boot('nurture-copywriter'), { model: 'sonnet', label: 'nurture-copywriter', phase: 'Wave 3b', schema: STATUS }) : null
const wave3b = [...wave3bMain, ...(nurtureResult ? [nurtureResult] : [])]

const moduleStatuses = [...wave3a, ...wave3b].filter(Boolean)
const blockedModules = moduleStatuses.filter((m) => m.status === 'blocked')

// Sweep the whole doc set for mechanical conformance BEFORE the auditors run,
// so their rounds are spent on judgement (leaks, precedence, brand) rather than
// on em dashes a script can find for a fraction of the cost.
const conformanceResidual = await fixConformance(await conformance('conformance:modules'), 'Audit')

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
const guide = await agent(boot('system-guide'), { model: 'sonnet', label: 'system-guide', phase: 'Close', schema: STATUS })

return {
  moduleStatuses,
  blockedModules,
  fixLoopReport: { roundsFindingCounts: auditRounds },
  residualConflicts,
  conformanceResidual,
  deliverables: [fillGuide, overview, guide].filter(Boolean),
}
