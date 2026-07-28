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
// than by every agent grepping its own output. See phase2-registry.mjs for
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

// Documents the registry PROMISED, so their absence is detectable. Filtered to
// the roles that have actually run by the time the check fires, or a doc the
// Close phase has not written yet reads as a document that went missing.
const promisedDocs = (phases) => {
  const owners = new Set((A.roster?.roles ?? []).filter((r) => phases.includes(r.phase)).map((r) => r.id))
  return (R.doc_index ?? [])
    .filter((d) => owners.has(d.owner_role) && /\.(md|html)$/i.test(d.file ?? ''))
    .map((d) => d.file)
}

// One cheap call: repair everything mechanical in CODE, then report what is
// left. conformance_fix.mjs replaces the 24 fixer agents the 2026-07-28 run
// spawned, three of which improvised on a rule their prompt did not cover and
// deleted five claims sidecars carrying 25 fill tokens. Code renames
// deterministically and never deletes.
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

// What survives code repair needs judgement, and there is exactly one such rule
// left: an em dash inside customer-facing copy, where the replacement depends on
// what the sentence is doing. ONE agent takes all of them, across all files.
// One agent per file is the mistake that made this phase 24 agents wide.
const JUDGEMENT_RULES = new Set(['EM_DASH', 'MALFORMED_FILL_TOKEN'])
const fixConformance = async (violations, phaseLabel) => {
  if (!violations.length) return []
  const judgement = violations.filter((x) => JUDGEMENT_RULES.has(x.rule))
  const mechanical = violations.filter((x) => !JUDGEMENT_RULES.has(x.rule))
  if (mechanical.length) {
    log(`conformance: ${mechanical.length} violation(s) code repair could not clear; surfacing rather than guessing`)
  }
  if (!judgement.length) return violations
  log(`conformance: ${judgement.length} judgement violation(s) across ${new Set(judgement.map((x) => x.file)).size} file(s); one fixer`)
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

The registry's exact spellings are law: never respell a workflow name, tag, field, calendar, product or alert id while fixing.
Read only the named files. Your final message is data, not prose.`,
    { model: 'sonnet', label: 'fix-conformance', phase: phaseLabel, effort: 'low', schema: STATUS }
  )
  const remaining = await conformance(`conformance-recheck:${phaseLabel}`)
  if (remaining.length) log(`conformance: ${remaining.length} violation(s) survived the fixer`)
  return remaining
}

// A wave whose agent returned null lost that agent: it died, or the user
// skipped it. Both used to be swallowed by .filter(Boolean). On 2026-07-28
// workflow-designer died mid-write, its corpse was filtered out, and the
// copywriter that reads its document ran anyway and found nothing. Nothing in
// the run noticed. A dead agent now stops the phase.
const deadIn = (results, roleIds) => roleIds.filter((_, i) => !results[i])

phase('Wave 3a')
const roles3a = rolesIn('3a')
const wave3a = await parallel(roles3a.map((r) => () => agent(boot(r.id), { model: 'sonnet', label: r.id, phase: 'Wave 3a', schema: STATUS })))
const dead3a = deadIn(wave3a, roles3a.map((r) => r.id))
if (dead3a.length) return { failed: 'wave3a-agent-died', dead: dead3a, note: 'these agents returned nothing, so their documents were never written' }

// Landing pages are NOT built by this factory. The funnel's LP(s) are designed and built
// separately (Grom design), so there is no LP role and no LP chain here. The tracking-pixel
// and workflow modules still account for the LP as a funnel step.

phase('Wave 3b')
const wave3bRoles = rolesIn('3b')
// nurture-copywriter's voice-consistency pass reads the workflow-designer doc, so it runs AFTER the rest of 3b, not alongside it.
const main3bRoles = wave3bRoles.filter((r) => r.id !== 'nurture-copywriter')
const wave3bMain = await parallel(main3bRoles.map((r) => () => agent(boot(r.id), { model: 'sonnet', label: r.id, phase: 'Wave 3b', schema: STATUS })))
const dead3b = deadIn(wave3bMain, main3bRoles.map((r) => r.id))
// Checked BEFORE the copywriter runs, because the copywriter reads the workflow
// designer's document and 2026-07-28 proved it will happily read nothing.
if (dead3b.length) return { failed: 'wave3b-agent-died', dead: dead3b, note: 'these agents returned nothing, so their documents were never written' }

const nurtureActive = wave3bRoles.some((r) => r.id === 'nurture-copywriter')
const nurtureResult = nurtureActive ? await agent(boot('nurture-copywriter'), { model: 'sonnet', label: 'nurture-copywriter', phase: 'Wave 3b', schema: STATUS }) : null
if (nurtureActive && !nurtureResult) return { failed: 'wave3b-agent-died', dead: ['nurture-copywriter'], note: 'the agent returned nothing, so its document was never written' }
const wave3b = [...wave3bMain, ...(nurtureResult ? [nurtureResult] : [])]

const moduleStatuses = [...wave3a, ...wave3b].filter(Boolean)
const blockedModules = moduleStatuses.filter((m) => m.status === 'blocked')

// Sweep the whole doc set for mechanical conformance BEFORE the auditors run,
// so their rounds are spent on judgement (leaks, precedence, brand) rather than
// on em dashes a script can find for a fraction of the cost. The same call
// asserts that every document the registry promised for these waves is on disk
// and is not a stub.
const moduleViolations = await conformance('conformance:modules', promisedDocs(['3a', '3b']))
const missingDocs = moduleViolations.filter((x) => x.rule === 'DOC_MISSING' || x.rule === 'DOC_STUB')
if (missingDocs.length) {
  return {
    failed: 'promised-documents-missing',
    missingDocs,
    note: 'the registry doc index promised these and they are absent or unfinished; the run stops here rather than auditing a doc set with a hole in it',
  }
}
const conformanceResidual = await fixConformance(moduleViolations, 'Audit')

phase('Audit')
// 🔴 `line` and `anchor` are REQUIRED, and they are the single cheapest change
// in this factory. Measured on 2026-07-28: fixing the workflows doc cost 18.9%
// of the entire run across two rounds, and the fixer spent more effort LOCATING
// than changing, 56 shell commands to make 23 edits, because a finding said
// only which document it was in. Every one of those greps ran a 73KB file at
// full context.
// `anchor` exists because `line` drifts: a fix round applies several edits to
// one document, and every edit above a later finding moves it. The anchor is
// the exact text to match; the line is where to start looking.
const FINDINGS = {
  type: 'object',
  required: ['findings'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['doc', 'line', 'anchor', 'issue', 'fix', 'severity'],
        properties: {
          doc: { type: 'string' },
          line: { type: 'integer', description: '1-indexed line the finding sits on. 0 only when it concerns the whole document, such as a section that is absent.' },
          anchor: { type: 'string', description: 'Exact text copied from that line, short enough to be unique. Empty only when line is 0.' },
          issue: { type: 'string' },
          fix: { type: 'string' },
          severity: { enum: ['blocker', 'important', 'minor'] },
        },
      },
    },
  },
}
const auditorIds = ['registry-reconciler', 'journey-leak-auditor', 'compliance-brand-auditor']
const auditResults = await parallel(auditorIds.map((id) => () => agent(boot(id), { model: 'sonnet', label: id, phase: 'Audit', schema: FINDINGS })))
const deadAuditors = auditorIds.filter((_, i) => !auditResults[i])
if (deadAuditors.length) log(`audit: ${deadAuditors.join(', ')} returned nothing, so those lenses did NOT run on this build`)
let findings = auditResults.filter(Boolean).flatMap((r) => r.findings)

// 🔴 ONE fix round, and no recheck round. Measured on 2026-07-28: round 2 spent
// 5.2% of the entire run to make four edits, and the recheck that justified it
// cost a full registry-reconciler pass each time. Findings that survive one
// pass are reported to the human instead of being chased by a third model.
let residualConflicts = []
const unroutable = []
{
  const byDoc = new Map()
  for (const f of findings) { if (!byDoc.has(f.doc)) byDoc.set(f.doc, []); byDoc.get(f.doc).push(f) }
  const ownerOf = (docFile) => (R.doc_index.find((d) => d.file === docFile) || {}).owner_role
  await parallel([...byDoc.entries()].map(([docFile, fs]) => () => {
    const owner = ownerOf(docFile)
    // 🔴 No owner means ownerOf() found no doc_index entry, and the fix is
    // silently dropped. That is a real failure mode: every document the factory
    // writes needs a doc_index entry or its findings go nowhere. Collect them
    // so they reach the human instead of vanishing.
    if (!owner) { unroutable.push(...fs); return Promise.resolve(null) }
    return agent(boot(owner, `FIX. Your doc ${docFile} received these audit fix-notes. Apply them in place, update your claims sidecar, change nothing else:
${JSON.stringify(fs)}

🔴 Every finding carries "line" and "anchor". USE THEM. Read the document around
that line and match the anchor text; do not grep the whole file for each target
and do not re-read the document end to end. The last time this step ran without
line numbers it took 56 shell commands to make 23 edits, at full context, and it
was the single most expensive thing in the run.
Work from the HIGHEST line number down to the lowest, so that applying one edit
does not move the line every later finding refers to. If an anchor is not on its
stated line, it has drifted: search for the anchor text, not for the issue.
A finding with line 0 concerns the whole document and has no anchor.`), { model: 'sonnet', label: `fix:${docFile}`, phase: 'Audit', schema: STATUS })
  }))
  log(`audit: ${findings.length} finding(s) across ${byDoc.size} doc(s), one fix round, no recheck`)
  if (unroutable.length) {
    log(`audit: ${unroutable.length} finding(s) had no doc_index owner and could NOT be applied`)
  }
}
// Unroutable findings are the only ones known to survive: nothing was dispatched
// for them. They become precedence notes in the fill guide and are reported to
// the human, rather than being quietly dropped as they were before.
residualConflicts = unroutable

phase('Close')
const fillGuide = await agent(boot('fill-guide-compiler', `Residual conflicts to record as precedence notes: ${JSON.stringify(residualConflicts)}`), { model: 'sonnet', label: 'fill-guide', phase: 'Close', schema: STATUS })
const overview = await agent(boot('assembler', `Module statuses: ${JSON.stringify(moduleStatuses.map((m) => ({ doc: m.doc, status: m.status })))}. Blocked modules: ${JSON.stringify(blockedModules)}.`), { model: 'sonnet', label: 'assembler', phase: 'Close', schema: STATUS })
const guide = await agent(boot('system-guide'), { model: 'sonnet', label: 'system-guide', phase: 'Close', schema: STATUS })

const deadClose = [['fill-guide-compiler', fillGuide], ['assembler', overview], ['system-guide', guide]]
  .filter(([, r]) => !r).map(([id]) => id)

// The closing check covers the WHOLE promised set, including the documents the
// Close phase itself just wrote. This is the last chance to notice a hole
// before the PM reports a finished build.
const closingViolations = await conformance('conformance:closing', promisedDocs(['1', '2', '3a', '3b', '4']))
const closingMissing = closingViolations.filter((x) => x.rule === 'DOC_MISSING' || x.rule === 'DOC_STUB')

if (deadClose.length || closingMissing.length) {
  return {
    failed: 'closing-check-failed',
    dead: deadClose,
    missingDocs: closingMissing,
    moduleStatuses,
    blockedModules,
    residualConflicts,
    note: 'the build produced documents but the promised set is incomplete; do not report this run as finished',
  }
}

return {
  moduleStatuses,
  blockedModules,
  // One round now, so this reports what was found and what could not be routed,
  // not a per-round count.
  fixLoopReport: { findingsFound: findings.length, unroutable: unroutable.length, deadAuditors },
  residualConflicts,
  conformanceResidual,
  closingViolations,
  deliverables: [fillGuide, overview, guide].filter(Boolean),
}
