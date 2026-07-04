// Auto research platform - report generator.
//
//   node tools/report.mjs results/<experiment-name>
//
// Reads results.jsonl + meta.json and writes a SELF-CONTAINED report.html
// (inline SVG + inline JSON + vanilla JS, no CDN): heatmaps, robustness
// curves, paired A/B comparison, per-run drill-down with state timelines.

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

const dir = resolve(process.argv[2] || '')
const resultsPath = join(dir, 'results.jsonl')
if (!process.argv[2] || !existsSync(resultsPath)) {
  console.error('usage: node tools/report.mjs <results-dir>   (dir must contain results.jsonl)')
  process.exit(2)
}
const meta = existsSync(join(dir, 'meta.json')) ? JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')) : {}

// ---------------- load: latest attempt per runId wins ----------------
const byRun = new Map()
let attemptRows = 0
for (const line of readFileSync(resultsPath, 'utf8').split('\n')) {
  if (!line.trim()) continue
  let row
  try { row = JSON.parse(line) } catch { continue }
  attemptRows++
  const prev = byRun.get(row.runId)
  if (!prev || row.attempt > prev.attempt || (row.status === 'ok' && prev.status !== 'ok')) {
    byRun.set(row.runId, row)
  }
}
const rows = [...byRun.values()]
const ok = rows.filter(r => r.status === 'ok' && r.metrics)
const failed = rows.filter(r => r.status !== 'ok')
const retried = attemptRows - rows.length
if (!rows.length) { console.error('no rows in results.jsonl'); process.exit(2) }

// ---------------- shape discovery ----------------
const gridKeys = meta.spec && meta.spec.grid ? Object.keys(meta.spec.grid) : []
const axisVals = k => [...new Set(ok.map(r => r.params[k]))].sort((a, b) => a - b)
// two widest axes get the heatmap; primary axis gets the curves
const axesByWidth = gridKeys.map(k => [k, axisVals(k).length]).sort((a, b) => b[1] - a[1])
const xKey = axesByWidth[0] ? axesByWidth[0][0] : null
const yKey = axesByWidth[1] && axesByWidth[1][1] > 1 ? axesByWidth[1][0] : null
const configs = [...new Set(rows.map(r => r.config))]
const METRICS = [
  ['heldPct', 'held %', v => v, true],
  ['detectionRate', 'detection rate', v => v == null ? null : Math.round(v * 100), true],
  ['mapPeak', 'map peak (pts)', v => v, true],
  ['rawMedianCm', 'raw median (cm)', v => v, false],
  ['fusedMedianCm', 'fused median (cm)', v => v, false]
]

const mean = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : null
const fmt = v => v == null ? '–' : (Math.round(v * 10) / 10)

function cellsFor(config, metricKey, transform) {
  // group ok-rows by (x, y) -> seed values
  const cells = new Map()
  for (const r of ok.filter(r => r.config === config)) {
    const key = `${r.params[xKey]}|${yKey ? r.params[yKey] : 0}`
    if (!cells.has(key)) cells.set(key, [])
    const v = transform(r.metrics[metricKey])
    if (v != null && isFinite(v)) cells.get(key).push(v)
  }
  return cells
}

// ---------------- SVG builders (plain strings) ----------------
function heatmapSVG(config, metricKey, label, transform, higherBetter) {
  const xs = axisVals(xKey), ys = yKey ? axisVals(yKey) : [0]
  const cw = 64, ch = 40, mx = 70, my = 44
  const w = mx + xs.length * cw + 16, h = my + ys.length * ch + 30
  const cells = cellsFor(config, metricKey, transform)
  const all = [...cells.values()].flat()
  const lo = Math.min(...all), hi = Math.max(...all)
  const colorOf = v => {
    if (v == null) return '#222'
    let t = hi === lo ? 1 : (v - lo) / (hi - lo)
    if (!higherBetter) t = 1 - t
    const r = Math.round(220 * (1 - t) + 30 * t)
    const g = Math.round(60 * (1 - t) + 190 * t)
    return `rgb(${r},${g},60)`
  }
  let s = `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg" style="background:#111">`
  s += `<text x="8" y="18" fill="#ccc" font-size="13" font-family="monospace">${config} — ${label} (mean over seeds, corner = min–max)</text>`
  ys.forEach((y, yi) => {
    s += `<text x="${mx - 8}" y="${my + yi * ch + ch / 2 + 4}" fill="#999" font-size="11" text-anchor="end" font-family="monospace">${yKey ? yKey + '=' + y : ''}</text>`
    xs.forEach((x, xi) => {
      const vals = cells.get(`${x}|${y}`) || []
      const m = mean(vals)
      const X = mx + xi * cw, Y = my + yi * ch
      s += `<rect x="${X}" y="${Y}" width="${cw - 3}" height="${ch - 3}" fill="${colorOf(m)}" rx="3"/>`
      if (vals.length) {
        s += `<text x="${X + (cw - 3) / 2}" y="${Y + ch / 2 + 1}" fill="#000" font-size="13" font-weight="bold" text-anchor="middle" font-family="monospace">${fmt(m)}</text>`
        if (vals.length > 1) {
          s += `<text x="${X + (cw - 3) / 2}" y="${Y + ch - 8}" fill="#000" font-size="8" text-anchor="middle" font-family="monospace">${fmt(Math.min(...vals))}–${fmt(Math.max(...vals))}</text>`
        }
      }
    })
  })
  xs.forEach((x, xi) => {
    s += `<text x="${mx + xi * cw + (cw - 3) / 2}" y="${my + ys.length * ch + 14}" fill="#999" font-size="11" text-anchor="middle" font-family="monospace">${x}</text>`
  })
  s += `<text x="${mx + xs.length * cw / 2}" y="${h - 4}" fill="#777" font-size="11" text-anchor="middle" font-family="monospace">${xKey}</text>`
  return s + '</svg>'
}

function curvesSVG(metricKey, label, transform) {
  const xs = axisVals(xKey)
  if (xs.length < 2) return ''
  const W = 640, H = 260, mx = 54, my = 24
  const pw = W - mx - 16, ph = H - my - 40
  // collect per-config series: x -> seed values (pooled over yKey too)
  const series = configs.map(cfg => {
    const cells = cellsFor(cfg, metricKey, transform)
    return {
      cfg,
      pts: xs.map(x => {
        const vals = (yKey ? axisVals(yKey) : [0]).flatMap(y => cells.get(`${x}|${y}`) || [])
        return { x, mean: mean(vals), min: vals.length ? Math.min(...vals) : null, max: vals.length ? Math.max(...vals) : null }
      })
    }
  })
  const all = series.flatMap(s => s.pts.flatMap(p => [p.min, p.max])).filter(v => v != null)
  if (!all.length) return ''
  const lo = Math.min(...all, 0), hi = Math.max(...all) * 1.05 || 1
  const PX = x => mx + (xs.indexOf(x) / (xs.length - 1)) * pw
  const PY = v => my + ph - ((v - lo) / (hi - lo)) * ph
  const COLORS = ['#0cf', '#f6a', '#8f6', '#fc4']
  let s = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg" style="background:#111">`
  s += `<text x="8" y="16" fill="#ccc" font-size="13" font-family="monospace">${label} vs ${xKey} (band = min–max over seeds)</text>`
  for (let g = 0; g <= 4; g++) {
    const v = lo + (hi - lo) * g / 4
    s += `<line x1="${mx}" y1="${PY(v)}" x2="${mx + pw}" y2="${PY(v)}" stroke="#2a2a2a"/>` +
         `<text x="${mx - 6}" y="${PY(v) + 4}" fill="#888" font-size="10" text-anchor="end" font-family="monospace">${fmt(v)}</text>`
  }
  series.forEach((ser, i) => {
    const col = COLORS[i % COLORS.length]
    const good = ser.pts.filter(p => p.mean != null)
    if (!good.length) return
    const band = good.map(p => `${PX(p.x)},${PY(p.max)}`).concat(good.slice().reverse().map(p => `${PX(p.x)},${PY(p.min)}`)).join(' ')
    s += `<polygon points="${band}" fill="${col}" opacity="0.12"/>`
    s += `<polyline points="${good.map(p => `${PX(p.x)},${PY(p.mean)}`).join(' ')}" fill="none" stroke="${col}" stroke-width="2"/>`
    good.forEach(p => { s += `<circle cx="${PX(p.x)}" cy="${PY(p.mean)}" r="3" fill="${col}"/>` })
    s += `<text x="${mx + pw - 4}" y="${my + 14 + i * 14}" fill="${col}" font-size="11" text-anchor="end" font-family="monospace">${ser.cfg}</text>`
  })
  xs.forEach(x => {
    s += `<text x="${PX(x)}" y="${H - 8}" fill="#999" font-size="10" text-anchor="middle" font-family="monospace">${x}</text>`
  })
  return s + '</svg>'
}

// ---------------- A/B pairing ----------------
function abSection() {
  if (configs.length < 2) return ''
  const [A, B] = configs
  const key = r => `${JSON.stringify(r.params)}|${r.seed}`
  const mapA = new Map(ok.filter(r => r.config === A).map(r => [key(r), r]))
  const pairs = []
  for (const rb of ok.filter(r => r.config === B)) {
    const ra = mapA.get(key(rb))
    if (ra) pairs.push({ ra, rb })
  }
  if (!pairs.length) return `<h2>A/B</h2><p class="dim">no complete same-seed pairs yet</p>`
  let wins = 0, losses = 0, ties = 0
  const rowsHtml = pairs.map(({ ra, rb }) => {
    const a = ra.metrics.heldPct, b = rb.metrics.heldPct
    const d = (a != null && b != null) ? Math.round((b - a) * 10) / 10 : null
    if (d != null) { if (d > 1) wins++; else if (d < -1) losses++; else ties++ }
    return `<tr><td>${Object.entries(ra.params).map(([k, v]) => `${k}=${v}`).join(' ')}</td>` +
      `<td>${ra.seed}</td><td>${a ?? '–'}</td><td>${b ?? '–'}</td>` +
      `<td class="${d > 0 ? 'good' : d < 0 ? 'bad' : ''}">${d == null ? '–' : (d > 0 ? '+' : '') + d}</td>` +
      `<td>${ra.metrics.mapPeak} → ${rb.metrics.mapPeak}</td>` +
      `<td>${ra.metrics.rawMedianCm} → ${rb.metrics.rawMedianCm}</td></tr>`
  }).join('')
  return `<h2>A/B paired (same params + seed): ${A} → ${B}</h2>
    <p><b>${B}</b> wins ${wins}, loses ${losses}, ties ${ties} on held% (|Δ| > 1)</p>
    <table><thead><tr><th>params</th><th>seed</th><th>held ${A}</th><th>held ${B}</th><th>Δ held</th><th>map peak</th><th>raw med cm</th></tr></thead>
    <tbody>${rowsHtml}</tbody></table>`
}

// ---------------- drill-down ----------------
const drillRows = rows.map(r => {
  const m = r.metrics || {}
  const tl = (m.timeline || '').split('').map(c =>
    c === 'T' ? '<i class="tT"></i>' : c === 'M' ? '<i class="tM"></i>' :
    c === 'L' ? '<i class="tL"></i>' : '<i class="ts"></i>').join('')
  return `<tr class="${r.status !== 'ok' ? 'failrow' : ''}">` +
    `<td>${r.runId}</td><td>${r.config}</td>` +
    `<td>${Object.entries(r.params).map(([k, v]) => `${k}=${v}`).join(' ')}</td>` +
    `<td>${r.seed}</td><td>${r.status}</td>` +
    `<td>${m.heldPct ?? '–'}</td><td>${m.mapPeak ?? '–'}</td>` +
    `<td>${m.detectionRate != null ? Math.round(m.detectionRate * 100) : '–'}</td>` +
    `<td>${m.rawMedianCm ?? '–'}</td><td>${m.fusedMedianCm ?? '–'}</td>` +
    `<td>${Math.round((r.wallMs || 0) / 1000)}s</td>` +
    `<td class="tl">${tl}</td></tr>`
}).join('')

// ---------------- assemble ----------------
const heatmaps = xKey ? configs.map(cfg =>
  METRICS.map(([k, label, tr, hb], i) =>
    `<div class="hm" data-metric="${k}" style="${i ? 'display:none' : ''}">${heatmapSVG(cfg, k, label, tr, hb)}</div>`
  ).join('')).join('<br/>') : '<p class="dim">single grid point — no heatmap</p>'

const curves = xKey ? METRICS.map(([k, label, tr], i) =>
  `<div class="cv" data-metric="${k}" style="${i ? 'display:none' : ''}">${curvesSVG(k, label, tr)}</div>`).join('') : ''

const failures = failed.length ? `<h2>Failures (${failed.length})</h2><table>
  <thead><tr><th>runId</th><th>params</th><th>seed</th><th>status</th><th>error</th></tr></thead><tbody>
  ${failed.map(r => `<tr><td>${r.runId}</td><td>${Object.entries(r.params).map(([k, v]) => `${k}=${v}`).join(' ')}</td>
   <td>${r.seed}</td><td>${r.status}</td><td class="dim">${(r.error || '').slice(0, 200)}</td></tr>`).join('')}
  </tbody></table>` : ''

const html = `<!DOCTYPE html><html><head><meta charset="utf-8"/>
<title>${meta.spec ? meta.spec.name : 'experiment'} — research report</title>
<style>
 body { font-family: monospace; background: #0d0d0d; color: #ddd; padding: 20px; max-width: 1200px; margin: auto; }
 h1 { font-size: 18px; } h2 { font-size: 14px; margin-top: 28px; border-top: 1px solid #333; padding-top: 12px; }
 table { border-collapse: collapse; font-size: 11px; width: 100%; }
 th, td { padding: 3px 8px; border-bottom: 1px solid #222; text-align: left; white-space: nowrap; }
 th { color: #8ab; cursor: pointer; position: sticky; top: 0; background: #0d0d0d; }
 .dim { color: #777; } .good { color: #0f0; } .bad { color: #f55; }
 .failrow td { color: #f88; }
 .tl i { display: inline-block; width: 3px; height: 12px; margin: 0; padding: 0; }
 .tT { background: #0a5; } .tM { background: #f80; } .tL { background: #e33; } .ts { background: #444; }
 select, input { background: #222; color: #ddd; border: 1px solid #444; font-family: monospace; padding: 4px; }
 .meta { color: #888; font-size: 11px; line-height: 1.6; }
 svg { margin: 6px 0; border-radius: 6px; }
</style></head><body>
<h1>🔬 ${meta.spec ? meta.spec.name : 'experiment'} — auto research report</h1>
<div class="meta">
 ${meta.spec && meta.spec.description ? meta.spec.description + '<br/>' : ''}
 runs: <b>${rows.length}</b> (${ok.length} ok, ${failed.length} failed, ${retried} retried attempts)
 &nbsp;|&nbsp; git ${String(meta.gitRev || '').slice(0, 10)} &nbsp;|&nbsp; ${meta.chrome || ''} &nbsp;|&nbsp; node ${meta.node || ''}
 &nbsp;|&nbsp; started ${meta.startedAt || '?'}
</div>

<h2>Heatmaps <select id="metricSel">${METRICS.map(([k, label]) => `<option value="${k}">${label}</option>`).join('')}</select></h2>
${heatmaps}
<h2>Robustness curves</h2>
${curves}
${abSection()}
<h2>All runs <input id="filter" placeholder="filter…"/></h2>
<table id="drill"><thead><tr>
 <th>runId</th><th>config</th><th>params</th><th>seed</th><th>status</th><th>held%</th><th>map</th><th>det%</th><th>raw cm</th><th>fused cm</th><th>wall</th><th>timeline</th>
</tr></thead><tbody>${drillRows}</tbody></table>
${failures}
<script>
 document.getElementById('metricSel').onchange = (e) => {
   for (const el of document.querySelectorAll('.hm,.cv')) {
     el.style.display = el.dataset.metric === e.target.value ? '' : 'none'
   }
 }
 document.getElementById('filter').oninput = (e) => {
   const q = e.target.value.toLowerCase()
   for (const tr of document.querySelectorAll('#drill tbody tr')) {
     tr.style.display = tr.textContent.toLowerCase().includes(q) ? '' : 'none'
   }
 }
 // column sort (numeric-aware)
 document.querySelectorAll('#drill th').forEach((th, ci) => {
   th.onclick = () => {
     const tb = document.querySelector('#drill tbody')
     const trs = [...tb.querySelectorAll('tr')]
     const dir = th.dataset.dir === '1' ? -1 : 1
     th.dataset.dir = dir === 1 ? '1' : '-1'
     trs.sort((a, b) => {
       const av = a.cells[ci].textContent, bv = b.cells[ci].textContent
       const an = parseFloat(av), bn = parseFloat(bv)
       return (isFinite(an) && isFinite(bn) ? an - bn : av.localeCompare(bv)) * dir
     })
     trs.forEach(tr => tb.appendChild(tr))
   }
 })
</script>
</body></html>`

const outPath = join(dir, 'report.html')
writeFileSync(outPath, html)
console.log(`report written: ${outPath}  (${rows.length} runs, ${ok.length} ok, ${failed.length} failed)`)
