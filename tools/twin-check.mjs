// Headless verification for static/twin.html: loads the page, waits for the
// engine + tracking, asserts the live state surface, saves a screenshot.
//   node tools/twin-check.mjs [url] [screenshot.png]

import { writeFileSync } from 'node:fs'
import { launchChrome, connect } from './lib/cdp.mjs'

const URL_ = process.argv[2] || 'http://127.0.0.1:5000/static/twin.html'
const SHOT = process.argv[3] || 'twin-shot.png'

const chrome = await launchChrome({})
const browser = await connect(chrome.wsUrl)
const tab = await browser.createTab('about:blank')
await browser.send('Emulation.setDeviceMetricsOverride',
  { width: 1400, height: 760, deviceScaleFactor: 1, mobile: false }, tab.sessionId)
await tab.navigate(URL_)

let ok = false, last = null, err = null
const t0 = Date.now()
while (Date.now() - t0 < 90000) {
  await new Promise(r => setTimeout(r, 2000))
  try {
    err = await tab.evaluate('window.__TWIN_ERR__')
    if (err) break
    last = await tab.evaluate('window.__TWIN_STATE__ ? JSON.stringify(window.__TWIN_STATE__) : ""')
    if (last) {
      const s = JSON.parse(last)
      console.log(`t+${Math.round((Date.now() - t0) / 1000)}s  state=${s.state} tracking=${s.tracking} map=${s.mapPts} fusedErr=${s.fusedErrCm}cm frame=${s.frame} vfps=${s.vfps}`)
      if (s.tracking && s.state !== 'SEARCHING' && s.fusedErrCm != null && s.frame > 20) { ok = true; break }
    }
  } catch (e) { /* still booting */ }
}

// screenshot regardless (evidence either way)
try {
  const r = await browser.send('Page.captureScreenshot', { format: 'png' }, tab.sessionId)
  if (r.result && r.result.data) {
    writeFileSync(SHOT, Buffer.from(r.result.data, 'base64'))
    console.log('screenshot: ' + SHOT)
  }
} catch (e) { console.log('screenshot failed: ' + e.message) }

if (err) console.log('PAGE ERROR: ' + err)
console.log(ok ? 'TWIN OK — tracking with live fused error' : 'TWIN NOT VERIFIED')
await browser.close()
chrome.kill()
process.exit(ok && !err ? 0 : 1)
