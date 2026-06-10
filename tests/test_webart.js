/**
 * .webart format round-trip test (Node).
 *
 * Parses the artifact produced by the Python compiler
 * (preprocess_target.py) with the same JS parser the vision worker uses,
 * and validates structure, bounds and content.
 *
 * Run: node tests/test_webart.js
 */

const fs = require('fs')
const path = require('path')
const { parseWebART } = require('../static/sdk/vision/webart-format.js')

const file = path.join(__dirname, '..', 'static', 'assets', 'ranger-base-image.webart')

const checks = []
function check(name, cond, detail) {
    checks.push(cond)
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  (' + detail + ')' : ''}`)
}

const buf = fs.readFileSync(file)
// Node Buffer -> ArrayBuffer slice (respect byteOffset)
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)

let t = null
try {
    t = parseWebART(ab)
} catch (e) {
    check('parses without error', false, String(e))
    process.exit(1)
}
check('parses without error', true)
check('image dims match source (960x1440)', t.imgW === 960 && t.imgH === 1440,
    `${t.imgW}x${t.imgH}`)
check('physical size plausible', Math.abs(t.physW - 0.6667) < 0.01 && Math.abs(t.physH - 1.0) < 0.01,
    `${t.physW.toFixed(3)}m x ${t.physH.toFixed(3)}m`)
check('3 pyramid levels', t.levels.length === 3,
    `scales: ${t.levels.map(l => l.scale).join(', ')}`)
check('expected scales [1, 0.5, 0.3]',
    Math.abs(t.levels[0].scale - 1.0) < 1e-6 &&
    Math.abs(t.levels[1].scale - 0.5) < 1e-6 &&
    Math.abs(t.levels[2].scale - 0.3) < 1e-6)

const totalKp = t.levels.reduce((s, l) => s + l.count, 0)
check('keypoint counts sane (>= 1000/level, total ~5851)',
    t.levels.every(l => l.count >= 1000) && totalKp === 5851, `total=${totalKp}`)

// All keypoints inside full-res image bounds
const inBounds = t.levels.every(l => {
    for (let i = 0; i < l.count; i++) {
        const x = l.pts[i * 2], y = l.pts[i * 2 + 1]
        if (!(x >= 0 && x <= t.imgW && y >= 0 && y <= t.imgH)) return false
    }
    return true
})
check('all keypoints within image bounds', inBounds)

// Descriptors are real data, not zeros
const descSum = t.levels[0].desc.slice(0, 32 * 10).reduce((s, v) => s + v, 0)
check('descriptors non-trivial', descSum > 100, `first-10 byte sum=${descSum}`)

// Truncation must throw, not mis-parse
let threw = false
try { parseWebART(ab.slice(0, 100)) } catch (e) { threw = true }
check('truncated input rejected', threw)

// Corrupt magic must throw
const bad = ab.slice(0)
new DataView(bad).setUint32(0, 0xDEADBEEF, true)
threw = false
try { parseWebART(bad) } catch (e) { threw = true }
check('bad magic rejected', threw)

const passed = checks.filter(Boolean).length
console.log(`========== ${passed}/${checks.length} checks passed ==========`)
process.exit(passed === checks.length ? 0 : 1)
