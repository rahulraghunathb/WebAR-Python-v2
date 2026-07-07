// Diagnostic: run sim.html once with &dump=1 and print the per-frame trace.
//   node tools/dump-run.mjs "http://127.0.0.1:5000/static/sim.html?run=1&dump=1&noise=5&blur=0.1&seed=1"

import { launchChrome, connect } from './lib/cdp.mjs'

const URL_ = process.argv[2]
if (!URL_) { console.error('usage: node tools/dump-run.mjs <sim url with run=1&dump=1>'); process.exit(2) }

const chrome = await launchChrome({})
const browser = await connect(chrome.wsUrl)
const tab = await browser.createTab(URL_)

let done = null
const t0 = Date.now()
while (Date.now() - t0 < 240000) {
  await new Promise(r => setTimeout(r, 1500))
  try {
    const v = await tab.evaluate('window.__TEST_DONE__ ? JSON.stringify(window.__TEST_DONE__) : ""')
    if (v) { done = JSON.parse(v); break }
  } catch {}
}
await browser.close(); chrome.kill()
if (!done) { console.error('TIMEOUT'); process.exit(2) }

const m = done.metrics || {}
console.log('METRICS ' + JSON.stringify(m, (k, v) => k === 'timeline' ? undefined : v))
if (!done.rows) { console.error('no rows (missing &dump=1?)'); process.exit(2) }
if (process.argv.includes('--sums')) {
  // map point-flow ledger totals + state occupancy: the one-line answer to
  // "where do candidates/points die differently between two runs"
  const s = { lk: 0, cu: 0, pu: 0, tr: 0, hv: 0, detectFrames: 0, states: {} }
  for (const r of done.rows) {
    s.lk += r.lk || 0; s.cu += r.cu || 0; s.pu += r.pu || 0
    s.tr += r.tr || 0; s.hv += r.hv || 0
    if (r.md === 'detect') s.detectFrames++
    s.states[r.st] = (s.states[r.st] || 0) + 1
  }
  console.log('SUMS ' + JSON.stringify(s))
  process.exit(0)
}
console.log('  i st md         inl map cnd drm S  reproj noise   posErr vis  -lk -cu -pu +tr +hv dbg')
const dash = v => v ? String(v) : '.'
for (const r of done.rows) {
  console.log(
    String(r.i).padStart(3) + ' ' + r.st + '  ' + String(r.md || '').padEnd(10) +
    String(r.inl).padStart(4) + String(r.map).padStart(4) + String(r.cnd).padStart(4) +
    String(r.drm).padStart(4) + String(r.strong).padStart(2) +
    String(r.rj != null ? r.rj.toFixed(2) : '-').padStart(8) +
    String(r.nz != null ? r.nz.toFixed(2) : '-').padStart(6) +
    String(r.pe != null ? r.pe + 'cm' : '-').padStart(9) +
    String(r.vis).padStart(4) +
    dash(r.lk).padStart(5) + dash(r.cu).padStart(4) + dash(r.pu).padStart(4) +
    dash(r.tr).padStart(4) + dash(r.hv).padStart(4) +
    (r.dbg ? '  ' + r.dbg : ''))
}
