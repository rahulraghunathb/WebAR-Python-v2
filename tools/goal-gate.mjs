// WORLD-CLASS GOAL GATE — the loop's finish line. Unlike perf-gate.mjs
// (which HARD-FAILS a round on regression), this gate REPORTS progress
// toward the fixed targets in goals.json and declares the loop done when
// every goal is achieved. Run it at the end of each round, after perf-gate,
// on a QUIET machine (never concurrently with research batteries).
//
//   node tools/goal-gate.mjs           score all goals, print the board
//
// Exit codes: 0 = ALL GOALS ACHIEVED (the loop may stop), 2 = goals remain.
//
// Semantics:
//  - Targets are FIXED. Do not lower a target to pass it; raise one only
//    with a documented rationale in GOALS.md.
//  - Goal metrics run on the fixed deterministic cases (seed 1) so the
//    board is comparable round to round. A goal FLIP (remaining->achieved)
//    still needs the round's paired battery as shipping evidence — the
//    board is the finish line, batteries are the proof.
//  - kind "needs-metric" rows count as REMAINING until the metric exists:
//    instrumentation debt is debt.

import { launchChrome, connect } from './lib/cdp.mjs'
import { startStaticServer } from './lib/static-server.mjs'
import { readFileSync, statSync, existsSync } from 'node:fs'

const SPEC = JSON.parse(readFileSync('goals.json', 'utf8'))

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

async function runPage(browser, url, doneExpr, timeoutMs) {
  const tab = await browser.createTab(url)
  const t0 = Date.now()
  let out = null
  while (Date.now() - t0 < (timeoutMs || 300000)) {
    await new Promise(r => setTimeout(r, 1500))
    try {
      const v = await tab.evaluate(doneExpr)
      if (v) { out = JSON.parse(v); break }
    } catch { /* navigating */ }
  }
  await tab.close()
  return out
}

const server = await probeServer()
const chrome = await launchChrome({})
const browser = await connect(chrome.wsUrl)

// One sim run per named case (serialized: the board must be load-honest)
const caseMetrics = {}
for (const [name, q] of Object.entries(SPEC.cases)) {
  const m = await runPage(browser, `${server.url}/static/sim.html?run=1&${q}`,
    'window.__TEST_DONE__ ? JSON.stringify(window.__TEST_DONE__.metrics) : ""')
  if (!m) { console.error(`goal case ${name}: TIMEOUT`); process.exit(2) }
  caseMetrics[name] = m
}

// Suite goals (test-slam pass count)
const suites = {}
for (const g of SPEC.goals.filter(g => g.kind === 'suite')) {
  const r = await runPage(browser, `${server.url}/static/${g.page}`,
    'window.__TEST_DONE__ ? JSON.stringify({passed: window.__TEST_DONE__.passed, failed: window.__TEST_DONE__.failed}) : ""')
  suites[g.page] = r || { passed: 0, failed: 99 }
}

await browser.close(); chrome.kill(); server.close()

const rows = []
let achieved = 0, remaining = 0

for (const g of SPEC.goals) {
  let current = null, ok = false, note = ''
  if (g.kind === 'metric') {
    current = caseMetrics[g.case] ? caseMetrics[g.case][g.metric] : null
    ok = current != null && current <= g.target + 1e-9
    note = `${g.case}.${g.metric}`
  } else if (g.kind === 'sweep') {
    // worst value across every case; direction "min" = metric must be >= target
    const vals = Object.entries(caseMetrics)
      .map(([n, m]) => [n, m[g.metric]]).filter(([, v]) => v != null)
    if (g.direction === 'min') {
      const worst = vals.reduce((a, b) => (b[1] < a[1] ? b : a))
      current = worst[1]; ok = current >= g.target - 1e-9
      note = `worst: ${worst[0]}`
    } else {
      const worst = vals.reduce((a, b) => (b[1] > a[1] ? b : a))
      current = worst[1]; ok = current <= g.target + 1e-9
      note = `worst: ${worst[0]}`
    }
  } else if (g.kind === 'suite') {
    const s = suites[g.page]
    current = s.passed; ok = s.passed >= g.target && s.failed === 0
    note = g.page
  } else if (g.kind === 'file') {
    current = existsSync(g.file) ? statSync(g.file).size : null
    ok = current != null && current <= g.target
    note = g.file.split('/').pop()
  } else if (g.kind === 'needs-metric') {
    current = null; ok = false
    note = 'METRIC NOT EXPORTED YET'
  }
  if (ok) achieved++; else remaining++
  const gap = (!ok && current != null && g.target > 0 && g.kind !== 'suite')
    ? (g.direction === 'min' ? '' : ` (${(current / g.target).toFixed(2)}x from goal)`)
    : ''
  rows.push(`  ${ok ? 'ACHIEVED ' : 'remaining'}  ${g.id.padEnd(4)} ${g.name.padEnd(38)} ` +
    `${String(current == null ? '-' : Math.round(current * 100) / 100).padStart(9)} / ${String(g.target).padStart(7)}${gap}` +
    (note ? `   [${note}]` : ''))
}

console.log(`GOAL GATE — world-class targets (goals.json, created ${SPEC.created})`)
for (const r of rows) console.log(r)
console.log(`\n${achieved}/${achieved + remaining} goals achieved.`)
if (remaining === 0) {
  console.log('ALL GOALS ACHIEVED — the loop has reached its finish line.')
  process.exit(0)
}
console.log('Goals remain — the loop continues.')
process.exit(2)
