// Auto research platform - experiment orchestrator.
//
// Expands an experiment spec into a run matrix (grid x seeds x configs),
// drives each run headlessly through static/sim.html?run=1 in parallel tabs
// of ONE Chrome, and appends structured results to results/<name>/results.jsonl.
// Fully resumable: re-running the same spec skips completed runs.
//
//   node tools/research.mjs experiments/cliff-sweep.json
//     [--concurrency 2] [--out results/<name>] [--fresh] [--dry-run]
//     [--filter noise=4,config=baseline] [--server-url http://...] [--chrome <path>]
//
// Zero npm deps (Node >= 22). See tools/report.mjs for analysis.

import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, rmSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'
import { loadSpec, expandRuns, specHash, runUrl } from './lib/spec.mjs'
import { launchChrome, connect } from './lib/cdp.mjs'
import { startStaticServer } from './lib/static-server.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// ---------------- CLI ----------------
const argv = process.argv.slice(2)
const flags = {}
const positional = []
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith('--')) {
    const k = argv[i].slice(2)
    if (['fresh', 'dry-run'].includes(k)) flags[k] = true
    else flags[k] = argv[++i]
  } else positional.push(argv[i])
}
if (!positional[0]) {
  console.error('usage: node tools/research.mjs <spec.json> [--concurrency 2] [--out dir] [--fresh] [--dry-run] [--filter k=v,..] [--server-url u] [--chrome path]')
  process.exit(2)
}

const spec = loadSpec(resolve(positional[0]))
const CONCURRENCY = Math.max(1, parseInt(flags.concurrency || '2', 10))
const OUT_DIR = resolve(flags.out || join(ROOT, 'results', spec.name))
const RESULTS_PATH = join(OUT_DIR, 'results.jsonl')
const META_PATH = join(OUT_DIR, 'meta.json')
const RECYCLE_EVERY = 12   // navigations per tab before it is recreated

// ---------------- expand + filter ----------------
let runs = expandRuns(spec)
if (flags.filter) {
  for (const kv of flags.filter.split(',')) {
    const [k, v] = kv.split('=')
    runs = runs.filter(r =>
      k === 'config' ? r.configName === v :
      k === 'seed' ? String(r.seed) === v :
      String(r.params[k]) === v)
  }
}
const TOTAL = runs.length

if (flags['dry-run']) {
  console.log(`spec "${spec.name}" -> ${TOTAL} runs (specHash ${specHash(spec)})`)
  for (const r of runs.slice(0, 30)) {
    console.log(` ${r.runId}  seed=${r.seed} ${r.configName}  ${JSON.stringify(r.params)}`)
  }
  if (TOTAL > 30) console.log(` ... and ${TOTAL - 30} more`)
  process.exit(0)
}

// ---------------- resume ----------------
mkdirSync(OUT_DIR, { recursive: true })
if (flags.fresh) {
  try { rmSync(RESULTS_PATH, { force: true }) } catch {}
  try { rmSync(META_PATH, { force: true }) } catch {}
}

const attempts = new Map()   // runId -> highest attempt seen
const terminal = new Set()   // runId -> done (ok, or failed twice)
if (existsSync(RESULTS_PATH)) {
  for (const line of readFileSync(RESULTS_PATH, 'utf8').split('\n')) {
    if (!line.trim()) continue
    let row
    try { row = JSON.parse(line) } catch { continue }  // tolerate truncated tail
    attempts.set(row.runId, Math.max(attempts.get(row.runId) || 0, row.attempt))
    if (row.status === 'ok' || row.attempt >= 2) terminal.add(row.runId)
  }
}

if (existsSync(META_PATH)) {
  const meta = JSON.parse(readFileSync(META_PATH, 'utf8'))
  if (meta.specHash !== specHash(spec)) {
    console.error(`REFUSING to resume: ${META_PATH} was written by a different spec ` +
      `(hash ${meta.specHash} != ${specHash(spec)}). Use --fresh or a new --out.`)
    process.exit(2)
  }
}

const todo = runs.filter(r => !terminal.has(r.runId))
console.log(`spec "${spec.name}": ${TOTAL} runs total, ${TOTAL - todo.length} already done, ${todo.length} to run, concurrency ${CONCURRENCY}`)
if (!todo.length) { console.log('nothing to do'); process.exit(0) }

// ---------------- server ----------------
async function ensureServer() {
  const probe = async (url) => {
    try {
      const ctl = new AbortController()
      const t = setTimeout(() => ctl.abort(), 1500)
      const r = await fetch(url + '/static/sim.html', { signal: ctl.signal })
      clearTimeout(t)
      return r.ok
    } catch { return false }
  }
  if (flags['server-url']) {
    if (!(await probe(flags['server-url']))) throw new Error('--server-url not reachable')
    return { url: flags['server-url'], close: () => {} }
  }
  if (await probe('http://127.0.0.1:5000')) return { url: 'http://127.0.0.1:5000', close: () => {} }
  const srv = await startStaticServer(ROOT, 0)
  console.log(`no dev server found - spawned static server on :${srv.port}`)
  return { url: `http://127.0.0.1:${srv.port}`, close: srv.close }
}

// ---------------- run one attempt in a tab ----------------
async function runAttempt(tab, run, server) {
  const url = runUrl(server.url, run)
  const t0 = Date.now()
  await tab.navigate(url)

  let lastFrame = -1
  let lastProgressAt = Date.now()
  // navigation grace: engine init (WASM compile) produces no frame progress
  const graceUntil = Date.now() + 45000

  while (true) {
    if (tab.crashed) return { status: 'crash', wallMs: Date.now() - t0, error: 'renderer crashed' }
    if (Date.now() - t0 > spec.timeoutMs) return { status: 'timeout', wallMs: Date.now() - t0 }

    let v
    try {
      v = await tab.evaluate(
        `window.__TEST_DONE__ ? JSON.stringify(window.__TEST_DONE__) : ` +
        `(window.__SIM_PROGRESS__ ? 'P:' + window.__SIM_PROGRESS__.frame : '')`)
    } catch (e) {
      // evaluate failing right after navigate is normal; later it means death
      if (Date.now() > graceUntil) {
        return { status: 'crash', wallMs: Date.now() - t0, error: 'evaluate failed: ' + e.message }
      }
      v = ''
    }

    if (v && v[0] === '{') {
      const done = JSON.parse(v)
      return {
        status: done.error ? 'error' : 'ok',
        wallMs: Date.now() - t0,
        passed: done.passed, failed: done.failed,
        metrics: done.metrics || null,
        error: done.error
      }
    }
    if (v && v.startsWith('P:')) {
      const f = parseInt(v.slice(2), 10)
      if (f !== lastFrame) { lastFrame = f; lastProgressAt = Date.now() }
    }
    const stallRef = Math.max(lastProgressAt, lastFrame < 0 ? graceUntil : 0)
    if (Date.now() - stallRef > spec.stallMs) {
      return { status: 'stall', wallMs: Date.now() - t0, error: `no progress past frame ${lastFrame} for ${spec.stallMs}ms` }
    }
    await new Promise(r => setTimeout(r, 1000))
  }
}

// ---------------- orchestrate ----------------
const queue = [...todo]
let completedCount = TOTAL - todo.length
let failedTerminal = 0
const wallTimes = []

function eta() {
  if (!wallTimes.length || !queue.length) return ''
  const s = wallTimes.slice().sort((a, b) => a - b)
  const medianMs = s[s.length >> 1]
  const mins = Math.round((queue.length * medianMs) / CONCURRENCY / 60000)
  return `, ETA ~${mins}m`
}

function writeRow(run, attempt, r) {
  const row = {
    v: 1, runId: run.runId, specName: spec.name,
    params: run.params, seed: run.seed, config: run.configName, cfg: run.cfg,
    attempt, status: r.status,
    passed: r.passed ?? null, failed: r.failed ?? null,
    metrics: r.metrics ?? null,
    ...(r.error ? { error: String(r.error).slice(0, 2000) } : {}),
    wallMs: r.wallMs, ts: new Date().toISOString()
  }
  appendFileSync(RESULTS_PATH, JSON.stringify(row) + '\n')
  return row
}

const server = await ensureServer()
const chrome = await launchChrome({ chromePath: flags.chrome })
const browser = await connect(chrome.wsUrl)

// meta.json (first write only)
if (!existsSync(META_PATH)) {
  let gitRev = 'unknown'
  try { gitRev = execSync('git rev-parse HEAD', { cwd: ROOT }).toString().trim() } catch {}
  writeFileSync(META_PATH, JSON.stringify({
    spec, specHash: specHash(spec), gitRev,
    chrome: await browser.version(), node: process.version,
    platform: process.platform, startedAt: new Date().toISOString()
  }, null, 2))
}

let shuttingDown = false
async function shutdown(code) {
  if (shuttingDown) return
  shuttingDown = true
  try { await browser.close() } catch {}
  chrome.kill()
  server.close()
  process.exit(code)
}
process.on('SIGINT', () => { console.log('\ninterrupted - results.jsonl is resumable'); shutdown(130) })

async function slotWorker(slotId) {
  let tab = null
  let navCount = 0
  const freshTab = async () => {
    if (tab) await tab.close()
    tab = await browser.createTab('about:blank')
    navCount = 0
  }
  await freshTab()

  while (queue.length && !shuttingDown) {
    const run = queue.shift()
    const attempt = (attempts.get(run.runId) || 0) + 1
    attempts.set(run.runId, attempt)

    if (navCount >= RECYCLE_EVERY || tab.crashed) await freshTab()
    navCount++

    let r
    try {
      r = await runAttempt(tab, run, server)
    } catch (e) {
      r = { status: 'error', wallMs: 0, error: e.message }
    }
    writeRow(run, attempt, r)

    if (r.status === 'ok') {
      completedCount++
      wallTimes.push(r.wallMs)
      const m = r.metrics || {}
      console.log(`[${completedCount}/${TOTAL}] ok    ${run.params.traj} ` +
        Object.entries(run.params).filter(([k]) => k !== 'traj').map(([k, v]) => `${k}=${v}`).join(' ') +
        ` seed=${run.seed} ${run.configName}  held=${m.heldPct ?? '-'}% raw-med=${m.rawMedianCm ?? '-'}cm ` +
        `${Math.round(r.wallMs / 1000)}s (slot ${slotId}${eta()})`)
    } else {
      await freshTab()   // never reuse a tab after any failure
      if (attempt >= 2) {
        completedCount++
        failedTerminal++
        console.log(`[${completedCount}/${TOTAL}] FAIL  ${run.runId} ${r.status} (2 attempts) ${r.error || ''}`)
      } else {
        queue.push(run)  // retry later, at the back (dodges transient load)
        console.log(`[retry] ${run.runId} ${r.status} after ${Math.round(r.wallMs / 1000)}s - re-queued`)
      }
    }
  }
}

const t0 = Date.now()
await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, (_, i) => slotWorker(i + 1)))

console.log(`\ndone: ${TOTAL - failedTerminal}/${TOTAL} ok, ${failedTerminal} failed, ` +
  `${Math.round((Date.now() - t0) / 60000)}m wall. Results: ${RESULTS_PATH}`)
console.log(`report: node tools/report.mjs ${OUT_DIR}`)
await shutdown(failedTerminal ? 1 : 0)
