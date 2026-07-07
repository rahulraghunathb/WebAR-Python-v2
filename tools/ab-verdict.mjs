// Paired A/B verdict straight from a results.jsonl: joins the two configs
// on (params, seed) and prints per-metric paired deltas + win/loss counts.
//   node tools/ab-verdict.mjs results/map-res-gates [groupKey]
// groupKey (default "px"): rows are additionally bucketed by this param.

import { readFileSync } from 'node:fs'

const dir = process.argv[2]
const groupKey = process.argv[3] || 'px'
if (!dir) { console.error('usage: node tools/ab-verdict.mjs <resultsDir> [groupKey]'); process.exit(2) }

const rows = readFileSync(dir + '/results.jsonl', 'utf8')
  .split('\n').filter(Boolean).map(l => { try { return JSON.parse(l) } catch { return null } })
  .filter(r => r && r.status === 'ok' && r.metrics)

const configs = [...new Set(rows.map(r => r.config))]
if (configs.length !== 2) { console.error('need exactly 2 configs, got: ' + configs.join(', ')); process.exit(2) }
const [A, B] = configs   // A = first seen (baseline), B = treatment

const keyOf = r => JSON.stringify({ ...r.params, seed: r.seed })
const byKey = new Map()
for (const r of rows) {
  const k = keyOf(r)
  if (!byKey.has(k)) byKey.set(k, {})
  byKey.get(k)[r.config] = r
}

const METRICS = [
  ['heldPct',        +1],  // higher better
  ['lostFrames',     -1],  // lower better
  ['detectionRate',  +1],
  ['rawMedianCm',    -1],
  ['rawP90Cm',       -1],
  ['fusedMedianCm',  -1],
  ['fusedP90Cm',     -1],
  ['mapPeak',        +1],
  ['procP50Ms',      -1]
]

const groups = new Map()
for (const [k, pair] of byKey) {
  if (!pair[A] || !pair[B]) continue
  const g = String(pair[A].params[groupKey])
  if (!groups.has(g)) groups.set(g, [])
  groups.get(g).push(pair)
}

const fmt = v => v == null ? '-' : (Math.round(v * 100) / 100)
for (const [g, pairs] of [...groups.entries()].sort()) {
  console.log(`\n=== ${groupKey}=${g}  (${pairs.length} paired runs)  ${A} -> ${B} ===`)
  for (const [m, dir_] of METRICS) {
    const deltas = [], av = [], bv = []
    for (const p of pairs) {
      const a = p[A].metrics[m], b = p[B].metrics[m]
      if (a == null || b == null) continue
      av.push(a); bv.push(b); deltas.push(b - a)
    }
    if (!deltas.length) continue
    const med = a => { const s = a.slice().sort((x, y) => x - y); return s[s.length >> 1] }
    const wins = deltas.filter(d => d * dir_ > 0).length
    const losses = deltas.filter(d => d * dir_ < 0).length
    const ties = deltas.length - wins - losses
    console.log(
      `  ${m.padEnd(14)} ${String(fmt(med(av))).padStart(8)} -> ${String(fmt(med(bv))).padStart(8)}` +
      `   W/L/T ${wins}/${losses}/${ties}   medDelta ${fmt(med(deltas))}`)
  }
}
