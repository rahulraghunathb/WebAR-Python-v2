// PERFORMANCE REGRESSION GATE — the end-of-loop check that performance
// never degrades. Runs the fixed gate cases headless, compares against the
// same-machine baseline (perf-baseline.json), and fails on CONFIRMED
// regression (suspects are re-run once: load transients don't repeat,
// real regressions do). Quality guards ride along: the gate cases are
// deterministic, so lost frames / held% / raw error must not move either.
//
//   node tools/perf-gate.mjs             gate against the baseline
//   node tools/perf-gate.mjs --accept    rewrite the baseline (ONLY after an
//                                        intentional, A/B-justified change)
//
// Run on a QUIET machine - never concurrently with research batteries.

import { launchChrome, connect } from './lib/cdp.mjs'
import { startStaticServer } from './lib/static-server.mjs'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'

const ACCEPT = process.argv.includes('--accept')
const BASE_PATH = 'perf-baseline.json'

const CASES = [
  { name: 'slam720', q: 'traj=slam&px=720&seed=1' },
  { name: 'fastpan720', q: 'traj=fastpan&px=720&seed=1' },
  { name: 'tilt720', q: 'traj=tilt&px=720&seed=1' }
]

// tolerances: proc is machine-noisy (gate + confirm run), quality is
// deterministic (tight)
const PROC_P50_TOL = 1.15
const PROC_P95_TOL = 1.30
const RAW_TOL = 1.10

async function probeServer() {
  try {
    const ctl = new AbortController()
    const t = setTimeout(() => ctl.abort(), 1500)
    const r = await fetch('http://127.0.0.1:5000/static/sim.html', { method: 'HEAD', signal: ctl.signal })
    clearTimeout(t)
    if (r.ok) return { url: 'http://127.0.0.1:5000', close: () => {} }
  } catch { /* not running */ }
  const srv = await startStaticServer(process.cwd())
  return { url: 'http://127.0.0.1:' + srv.port, close: () => srv.close() }
}

async function runCase(browser, serverUrl, c) {
  const tab = await browser.createTab(
    `${serverUrl}/static/sim.html?run=1&${c.q}`)
  const t0 = Date.now()
  let metrics = null
  while (Date.now() - t0 < 240000) {
    await new Promise(r => setTimeout(r, 1500))
    try {
      const v = await tab.evaluate('window.__TEST_DONE__ ? JSON.stringify(window.__TEST_DONE__.metrics) : ""')
      if (v) { metrics = JSON.parse(v); break }
    } catch { /* navigating */ }
  }
  await tab.close()
  if (!metrics) throw new Error(`gate case ${c.name}: timeout`)
  return {
    procP50Ms: metrics.procP50Ms, procP95Ms: metrics.procP95Ms,
    lostFrames: metrics.lostFrames,
    heldPct: metrics.heldPct == null ? null : metrics.heldPct,
    rawMedianCm: metrics.rawMedianCm
  }
}

const server = await probeServer()
const chrome = await launchChrome({})
const browser = await connect(chrome.wsUrl)

const current = {}
for (const c of CASES) current[c.name] = await runCase(browser, server.url, c)

if (ACCEPT || !existsSync(BASE_PATH)) {
  writeFileSync(BASE_PATH, JSON.stringify({
    note: 'same-machine perf baseline - rewrite ONLY via perf-gate --accept after an A/B-justified change',
    updated: new Date().toISOString(),
    cases: current
  }, null, 2))
  console.log((existsSync(BASE_PATH) && ACCEPT ? 'BASELINE ACCEPTED' : 'BASELINE CREATED') + ' -> ' + BASE_PATH)
  for (const [k, v] of Object.entries(current)) console.log(' ', k, JSON.stringify(v))
  await browser.close(); chrome.kill(); server.close()
  process.exit(0)
}

const base = JSON.parse(readFileSync(BASE_PATH, 'utf8')).cases
const failures = []
const lines = []

async function judge(name, cur, confirmable) {
  const b = base[name]
  if (!b) return
  const checks = [
    ['procP50Ms', cur.procP50Ms, b.procP50Ms * PROC_P50_TOL, true],
    ['procP95Ms', cur.procP95Ms, b.procP95Ms * PROC_P95_TOL, true],
    ['lostFrames', cur.lostFrames, b.lostFrames, false],
    ['rawMedianCm', cur.rawMedianCm, b.rawMedianCm * RAW_TOL, false]
  ]
  if (b.heldPct != null && cur.heldPct != null) {
    checks.push(['heldPct(min)', -cur.heldPct, -b.heldPct, false])
  }
  let suspect = false
  for (const [m, got, limit, isProc] of checks) {
    const ok = got <= limit + 1e-9
    lines.push(`  ${name.padEnd(11)} ${m.padEnd(12)} ${String(Math.abs(got)).padStart(7)}  limit ${String(Math.round(Math.abs(limit) * 100) / 100).padStart(7)}  ${ok ? 'ok' : 'REGRESSION?'}`)
    if (!ok) {
      if (isProc && confirmable) suspect = true
      else failures.push(`${name}.${m}: ${Math.abs(got)} > ${Math.round(Math.abs(limit) * 100) / 100}`)
    }
  }
  if (suspect) {
    // proc suspects get ONE confirmation run: load transients don't repeat
    lines.push(`  ${name.padEnd(11)} proc suspect -> confirmation run`)
    const again = await runCase(browser, server.url, CASES.find(c => c.name === name))
    await judge(name, again, false)
  }
}

for (const c of CASES) await judge(c.name, current[c.name], true)

await browser.close(); chrome.kill(); server.close()

console.log('PERF GATE — current vs baseline (' + BASE_PATH + ')')
for (const l of lines) console.log(l)
if (failures.length) {
  console.log('\nGATE FAILED — confirmed regressions:')
  for (const f of failures) console.log('  ' + f)
  console.log('Fix or revert before closing the round. If the change is an')
  console.log('A/B-justified intentional move, rerun with --accept.')
  process.exit(1)
}
console.log('\nGATE PASSED — no confirmed regression.')
process.exit(0)
