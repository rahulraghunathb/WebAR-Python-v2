// Headless runner for /static/test-pipeline.html.
//
// Drives Chrome via the DevTools protocol with zero npm deps (Node >= 22
// for the built-in WebSocket client). Exits 0 only when every check on the
// page passes.
//
//   node tools/run-pipeline-test.mjs [url]
//
// Env: CHROME_PATH overrides the browser binary.

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const URL_ = process.argv[2] || 'http://127.0.0.1:5000/static/test-pipeline.html'
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const TIMEOUT_MS = 180000

const userDataDir = mkdtempSync(join(tmpdir(), 'cdp-profile-'))
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-port=0', `--user-data-dir=${userDataDir}`, 'about:blank',
])

function cleanup() {
  try { chrome.kill() } catch {}
  try { rmSync(userDataDir, { recursive: true, force: true }) } catch {}
}
process.on('exit', cleanup)

const wsUrl = await new Promise((resolve, reject) => {
  let buf = ''
  const scan = (d) => {
    buf += d
    const m = buf.match(/DevTools listening on (ws:\/\/\S+)/)
    if (m) resolve(m[1])
  }
  chrome.stderr.on('data', scan)
  chrome.stdout.on('data', scan)
  chrome.on('exit', () => reject(new Error('chrome exited before DevTools endpoint\n' + buf)))
  setTimeout(() => reject(new Error('no DevTools endpoint after 15s\n' + buf)), 15000).unref()
})

const ws = new WebSocket(wsUrl)
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws connect failed')) })

let msgId = 0
const pending = new Map()
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data)
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id) }
}
function send(method, params = {}, sessionId) {
  const id = ++msgId
  return new Promise((resolve) => {
    pending.set(id, resolve)
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
  })
}

const { result: { targetId } } = await send('Target.createTarget', { url: URL_ })
const { result: { sessionId } } = await send('Target.attachToTarget', { targetId, flatten: true })

async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true }, sessionId)
  return r.result && r.result.result ? r.result.result.value : undefined
}

const deadline = Date.now() + TIMEOUT_MS
let done = null
while (Date.now() < deadline) {
  const v = await evaluate('window.__TEST_DONE__ ? JSON.stringify(window.__TEST_DONE__) : ""')
  if (v) { done = JSON.parse(v); break }
  await new Promise(r => setTimeout(r, 1000))
}

const logText = await evaluate(`(document.getElementById('log') || {}).innerText || ''`)
console.log(logText)
console.log('----------------------------------------')

if (!done) {
  console.log(`TIMEOUT after ${TIMEOUT_MS / 1000}s: window.__TEST_DONE__ never set`)
  process.exitCode = 2
} else {
  console.log(`RESULT: passed=${done.passed} failed=${done.failed} runtime=${done.runtime}`)
  process.exitCode = done.failed === 0 ? 0 : 1
}
ws.close()
cleanup()
