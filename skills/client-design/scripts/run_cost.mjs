#!/usr/bin/env node
// run_cost.mjs: real per-agent token accounting for a client-design run.
//
// The factory's cost complaint was argued from transcript BYTES, which is a
// proxy. This reads the actual `usage` blocks the harness records per model
// call and reports real input, output, cache-write and cache-read tokens, so
// an optimisation can be proved rather than asserted.
//
// Usage:
//   node run_cost.mjs <clientFolder> <runDate>          # reads run manifest, finds every workflow
//   node run_cost.mjs --run <workflowRunId>             # one workflow, no manifest write
//   node run_cost.mjs <clientFolder> <runDate> --json   # machine-readable only
//
// Writes a `cost` block into the run manifest unless --run or --json is used.
//
// 🔴 One record per CONTENT BLOCK is written to the transcript, and every
// record of a single model call repeats that call's usage. Counting records
// overcounts calls (measured 2.4x on the 2026-07-27 baseline). Calls are
// therefore deduplicated by requestId, keeping the record with the largest
// output_tokens because usage accumulates as the response streams.

import { readFileSync, writeFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { join, basename } from 'node:path'
import { homedir } from 'node:os'

// Rate cards, dollars per million tokens. Cache write is 1.25x input, cache
// read is 0.1x input. Update `intro.until` when the promotional rate lapses.
const RATES = {
  'sonnet-intro': { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2, until: '2026-08-31' },
  'sonnet': { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  'opus': { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
}

const PROJECTS = join(homedir(), '.claude', 'projects')

function findWorkflowDir(runId) {
  if (!existsSync(PROJECTS)) return null
  for (const proj of readdirSync(PROJECTS)) {
    const sessions = join(PROJECTS, proj)
    let entries
    try { entries = readdirSync(sessions) } catch { continue }
    for (const s of entries) {
      const candidate = join(sessions, s, 'subagents', 'workflows', runId)
      if (existsSync(candidate)) return candidate
    }
  }
  return null
}

// Recover the role id from our own bootstrap, which always opens with
// `You are the "<roleId>" agent in the Grom client-design factory.`
function labelOf(firstUserText) {
  const m = /^You are the "([a-z0-9-]+)" agent/.exec(firstUserText || '')
  if (m) return m[1]
  if (/validate\.mjs/.test(firstUserText || '')) return 'validate-floor'
  return 'unlabeled'
}

function readAgent(file) {
  const calls = new Map()
  let firstUser = ''
  let started = null
  let ended = null
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue
    let o
    try { o = JSON.parse(line) } catch { continue }
    if (o.timestamp) {
      if (!started) started = o.timestamp
      ended = o.timestamp
    }
    if (o.type === 'user' && !firstUser) {
      const c = o.message?.content
      firstUser = typeof c === 'string' ? c : (Array.isArray(c) ? (c.find((b) => b?.type === 'text')?.text ?? '') : '')
    }
    if (o.type !== 'assistant') continue
    const u = o.message?.usage
    if (!u) continue
    const rid = o.requestId || o.message?.id
    const prev = calls.get(rid)
    // Usage accumulates across the streamed records of one call; keep the last.
    if (!prev || (u.output_tokens ?? 0) >= (prev.output_tokens ?? 0)) calls.set(rid, u)
  }
  let read = 0, write = 0, output = 0, input = 0, peak = 0
  for (const u of calls.values()) {
    read += u.cache_read_input_tokens ?? 0
    write += u.cache_creation_input_tokens ?? 0
    output += u.output_tokens ?? 0
    input += u.input_tokens ?? 0
    peak = Math.max(peak, (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0))
  }
  return {
    agent_id: basename(file).replace(/^agent-|\.jsonl$/g, ''),
    role: labelOf(firstUser),
    calls: calls.size,
    input_tokens: input,
    output_tokens: output,
    cache_write_tokens: write,
    cache_read_tokens: read,
    peak_context_tokens: peak,
    started_at: started,
    ended_at: ended,
  }
}

function cost(t, card) {
  const r = RATES[card]
  return (t.input_tokens * r.input + t.output_tokens * r.output +
    t.cache_write_tokens * r.cacheWrite + t.cache_read_tokens * r.cacheRead) / 1e6
}

function scanWorkflow(dir) {
  const agents = readdirSync(dir)
    .filter((f) => f.startsWith('agent-') && f.endsWith('.jsonl'))
    .map((f) => readAgent(join(dir, f)))
    .sort((a, b) => b.cache_read_tokens - a.cache_read_tokens)
  const totals = agents.reduce((a, x) => ({
    calls: a.calls + x.calls,
    input_tokens: a.input_tokens + x.input_tokens,
    output_tokens: a.output_tokens + x.output_tokens,
    cache_write_tokens: a.cache_write_tokens + x.cache_write_tokens,
    cache_read_tokens: a.cache_read_tokens + x.cache_read_tokens,
  }), { calls: 0, input_tokens: 0, output_tokens: 0, cache_write_tokens: 0, cache_read_tokens: 0 })
  const stamps = agents.flatMap((a) => [a.started_at, a.ended_at]).filter(Boolean).sort()
  const wall = stamps.length >= 2
    ? Math.round((Date.parse(stamps[stamps.length - 1]) - Date.parse(stamps[0])) / 1000)
    : null
  return { agents, totals, wall_clock_seconds: wall }
}

function render(label, scan) {
  const pad = (s, n) => String(s).padEnd(n)
  const num = (s, n) => String(s).replace(/\B(?=(\d{3})+(?!\d))/g, ',').padStart(n)
  const out = []
  out.push(`\n=== ${label}`)
  out.push(`${pad('role', 24)} ${num('calls', 6)} ${num('cacheRead', 12)} ${num('cacheWrite', 11)} ${num('output', 9)} ${num('peakCtx', 9)}`)
  for (const a of scan.agents) {
    out.push(`${pad(a.role, 24)} ${num(a.calls, 6)} ${num(a.cache_read_tokens, 12)} ${num(a.cache_write_tokens, 11)} ${num(a.output_tokens, 9)} ${num(a.peak_context_tokens, 9)}`)
  }
  const t = scan.totals
  out.push(`${pad('TOTAL', 24)} ${num(t.calls, 6)} ${num(t.cache_read_tokens, 12)} ${num(t.cache_write_tokens, 11)} ${num(t.output_tokens, 9)}`)
  if (scan.wall_clock_seconds != null) {
    out.push(`wall clock: ${Math.floor(scan.wall_clock_seconds / 60)}m ${scan.wall_clock_seconds % 60}s`)
  }
  for (const card of ['sonnet-intro', 'sonnet']) {
    out.push(`cost @ ${pad(card, 14)} $${cost(t, card).toFixed(2)}`)
  }
  return out.join('\n')
}

// --- entry ---------------------------------------------------------------

const argv = process.argv.slice(2)
const jsonOnly = argv.includes('--json')
const args = argv.filter((a) => a !== '--json')

if (args[0] === '--run') {
  const dir = findWorkflowDir(args[1])
  if (!dir) { console.error(`no transcript directory found for ${args[1]}`); process.exit(1) }
  const scan = scanWorkflow(dir)
  if (jsonOnly) console.log(JSON.stringify(scan, null, 2))
  else console.error(render(args[1], scan))
  process.exit(0)
}

const [clientFolder, runDate] = args
if (!clientFolder || !runDate) {
  console.error('usage: run_cost.mjs <clientFolder> <runDate> [--json] | --run <workflowRunId>')
  process.exit(2)
}

const manifestPath = join(clientFolder, 'build', runDate, 'run-manifest.json')
if (!existsSync(manifestPath)) { console.error(`no run manifest at ${manifestPath}`); process.exit(1) }
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))

const runIds = Object.entries(manifest.workflow_run_ids ?? {})
if (!runIds.length) { console.error('run manifest carries no workflow_run_ids; nothing to measure'); process.exit(1) }

const phases = {}
const grand = { calls: 0, input_tokens: 0, output_tokens: 0, cache_write_tokens: 0, cache_read_tokens: 0 }
const missing = []
for (const [phase, runId] of runIds) {
  const dir = findWorkflowDir(runId)
  if (!dir) { missing.push(`${phase}=${runId}`); continue }
  const scan = scanWorkflow(dir)
  phases[phase] = { run_id: runId, ...scan }
  for (const k of Object.keys(grand)) grand[k] += scan.totals[k]
  if (!jsonOnly) console.error(render(`${phase}  (${runId})`, scan))
}

const block = {
  measured_at: new Date().toISOString(),
  note: 'calls deduplicated by requestId; transcript writes one record per content block',
  phases,
  totals: grand,
  estimated_cost_usd: Object.fromEntries(
    Object.keys(RATES).filter((k) => k.startsWith('sonnet')).map((k) => [k, Number(cost(grand, k).toFixed(4))])
  ),
  transcripts_not_found: missing,
}

if (jsonOnly) {
  console.log(JSON.stringify(block, null, 2))
} else {
  manifest.cost = block
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
  console.error(`\n=== RUN TOTAL`)
  console.error(`  model calls        ${grand.calls}`)
  console.error(`  cache read         ${grand.cache_read_tokens.toLocaleString()}`)
  console.error(`  cache write        ${grand.cache_write_tokens.toLocaleString()}`)
  console.error(`  output             ${grand.output_tokens.toLocaleString()}`)
  for (const [k, v] of Object.entries(block.estimated_cost_usd)) console.error(`  cost @ ${k.padEnd(14)} $${v.toFixed(2)}`)
  if (missing.length) console.error(`  🔴 transcripts not found for: ${missing.join(', ')}`)
  console.error(`\nwritten to ${manifestPath} under "cost"`)
}
