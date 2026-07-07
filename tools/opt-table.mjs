// The optimization ladder scoreboard: one row per opt-* experiment, showing
// the paired off->on movement of every headline metric plus the improvement
// multiple. Reads results/opt-*/results.jsonl (paired configs "off"/"on").
//   node tools/opt-table.mjs [resultsRoot=results]

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const root = process.argv[2] || 'results'
const med = a => { const s = a.filter(v => v != null && isFinite(v)).sort((x, y) => x - y); return s.length ? s[s.length >> 1] : null }
const fmt = v => v == null ? '-' : (Math.round(v * 100) / 100)

// improvement multiple: how many TIMES better did this metric get
// (direction-aware; guards the divide-by-zero and sign)
function mult(off, on, dir) {
  if (off == null || on == null) return null
  const a = dir > 0 ? on : off, b = dir > 0 ? off : on   // a/b > 1 = better
  if (b === 0) return a === 0 ? 1 : Infinity
  return a / b
}

const METRICS = [
  ['heldPct', +1], ['lostFrames', -1], ['detectionRate', +1],
  ['rawMedianCm', -1], ['rawP90Cm', -1], ['fusedMedianCm', -1],
  ['fusedP90Cm', -1], ['procP50Ms', -1], ['procP95Ms', -1],
  ['poseAgeP50Ms', -1], ['poseAgeP90Ms', -1]
]

const dirs = readdirSync(root).filter(d => /^opt-/.test(d) &&
  existsSync(join(root, d, 'results.jsonl'))).sort()

for (const d of dirs) {
  const rows = readFileSync(join(root, d, 'results.jsonl'), 'utf8')
    .split('\n').filter(Boolean).map(l => { try { return JSON.parse(l) } catch { return null } })
    .filter(r => r && r.status === 'ok' && r.metrics)
  const off = rows.filter(r => r.config === 'off').map(r => r.metrics)
  const on = rows.filter(r => r.config === 'on').map(r => r.metrics)
  if (!off.length || !on.length) { console.log(`\n== ${d}: incomplete (${off.length} off / ${on.length} on)`); continue }
  const hz = rows[0].params.hz
  console.log(`\n== ${d}  (${off.length} off / ${on.length} on runs @${hz}Hz) ==`)
  console.log('  metric           off ->      on    x-better')
  for (const [m, dir] of METRICS) {
    const o = med(off.map(x => x[m])), n = med(on.map(x => x[m]))
    if (o == null && n == null) continue
    const x = mult(o, n, dir)
    console.log(`  ${m.padEnd(14)}${String(fmt(o)).padStart(6)} -> ${String(fmt(n)).padStart(7)}` +
      `    ${x == null ? '-' : x === Infinity ? 'inf' : (Math.round(x * 100) / 100 + 'x')}`)
  }
}
