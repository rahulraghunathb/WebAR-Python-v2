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
console.log(`held=${m.heldPct}% mapPeak=${m.mapPeak} det=${m.detectionRate} profile=${JSON.stringify(m.profile)}`)
if (!done.rows) { console.error('no rows (missing &dump=1?)'); process.exit(2) }
console.log('  i st md         inl map cnd drm S  reproj noise   posErr vis dbg')
for (const r of done.rows) {
  console.log(
    String(r.i).padStart(3) + ' ' + r.st + '  ' + String(r.md || '').padEnd(10) +
    String(r.inl).padStart(4) + String(r.map).padStart(4) + String(r.cnd).padStart(4) +
    String(r.drm).padStart(4) + String(r.strong).padStart(2) +
    String(r.rj != null ? r.rj.toFixed(2) : '-').padStart(8) +
    String(r.nz != null ? r.nz.toFixed(2) : '-').padStart(6) +
    String(r.pe != null ? r.pe + 'cm' : '-').padStart(9) +
    String(r.vis).padStart(4) +
    (r.dbg ? '  ' + r.dbg : ''))
}
