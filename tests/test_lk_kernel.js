// Unit test for the standalone SIMD LK kernel (build/lk.wasm).
// Synthetic smooth-texture images with KNOWN sub-pixel shifts; the kernel
// must recover them. No OpenCV involved - this validates the kernel's own
// math (pyramid, gradients, fixed-point bilinear, iteration) end to end.
//   node tests/test_lk_kernel.js

const fs = require('fs')
const path = require('path')

const checks = []
function check(name, cond, detail) {
    checks.push(!!cond)
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  (' + detail + ')' : ''}`)
}

// deterministic value-noise texture: coarse LCG noise, bilinearly upsampled
// (smooth blobs with real gradients - per-pixel white noise is untrackable)
function makeTexture(w, h, seed) {
    const cw = w >> 3, ch = h >> 3
    let s = seed >>> 0 || 1
    const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296 }
    const coarse = new Float64Array((cw + 2) * (ch + 2))
    for (let i = 0; i < coarse.length; i++) coarse[i] = 40 + 175 * rnd()
    const img = new Float64Array(w * h)
    for (let y = 0; y < h; y++) {
        const gy = y / 8, iy = Math.floor(gy), fy = gy - iy
        for (let x = 0; x < w; x++) {
            const gx = x / 8, ix = Math.floor(gx), fx = gx - ix
            const o = iy * (cw + 2) + ix
            img[y * w + x] =
                coarse[o] * (1 - fx) * (1 - fy) + coarse[o + 1] * fx * (1 - fy) +
                coarse[o + cw + 2] * (1 - fx) * fy + coarse[o + cw + 3] * fx * fy
        }
    }
    return img
}

// bilinear shift with border clamp (image content moves by +dx,+dy)
function shiftImage(img, w, h, dx, dy) {
    const out = new Float64Array(w * h)
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const sx = Math.min(w - 1.001, Math.max(0, x - dx))
            const sy = Math.min(h - 1.001, Math.max(0, y - dy))
            const ix = Math.floor(sx), iy = Math.floor(sy)
            const fx = sx - ix, fy = sy - iy
            const o = iy * w + ix
            out[y * w + x] =
                img[o] * (1 - fx) * (1 - fy) + img[o + 1] * fx * (1 - fy) +
                img[o + w] * (1 - fx) * fy + img[o + w + 1] * fx * fy
        }
    }
    return out
}

function toU8(img) {
    const u = new Uint8Array(img.length)
    for (let i = 0; i < img.length; i++) u[i] = Math.max(0, Math.min(255, Math.round(img[i])))
    return u
}

async function main() {
    const wasmPath = path.join(__dirname, '..', 'build', 'lk.wasm')
    const bytes = fs.readFileSync(wasmPath)
    const { instance } = await WebAssembly.instantiate(bytes, {
        wasi_snapshot_preview1: new Proxy({}, { get: () => () => 0 })
    })
    const ex = instance.exports
    if (ex._initialize) ex._initialize()
    const mem = () => ex.memory.buffer

    const W = 320, H = 240
    const base = makeTexture(W, H, 12345)

    function upload(u8, w, h, slot, maxLevel) {
        new Uint8Array(mem(), ex.imgbuf(), w * h).set(u8)
        ex.prep(slot, w, h, maxLevel)
    }

    function runTrack(pts, seeds, win, maxLevel, iters) {
        const n = pts.length / 2
        new Float32Array(mem(), ex.ptsbuf(), n * 2).set(pts)
        new Float32Array(mem(), ex.seedbuf(), n * 2).set(seeds)
        ex.track(0, 1, n, win, maxLevel, iters)
        return {
            next: new Float32Array(mem(), ex.outbuf(), n * 2).slice(),
            st: new Uint8Array(mem(), ex.stbuf(), n).slice(),
            err: new Float32Array(mem(), ex.errbuf(), n).slice()
        }
    }

    function gridPts(margin, step) {
        const pts = []
        for (let y = margin; y <= H - margin; y += step)
            for (let x = margin; x <= W - margin; x += step) pts.push(x, y)
        return new Float32Array(pts)
    }

    function evalCase(name, dx, dy, seeded, win, maxLevel, tolMed) {
        const shifted = shiftImage(base, W, H, dx, dy)
        upload(toU8(base), W, H, 0, maxLevel)
        upload(toU8(shifted), W, H, 1, maxLevel)
        const pts = gridPts(40, 24)
        const n = pts.length / 2
        const seeds = seeded
            ? pts.map((v, i) => v + (i % 2 === 0 ? dx : dy))
            : pts.slice()
        const r = runTrack(pts, seeds, win, maxLevel, 30)
        const errs = []
        let stOk = 0
        for (let i = 0; i < n; i++) {
            if (!r.st[i]) continue
            stOk++
            const ex_ = pts[i * 2] + dx, ey = pts[i * 2 + 1] + dy
            errs.push(Math.hypot(r.next[i * 2] - ex_, r.next[i * 2 + 1] - ey))
        }
        errs.sort((a, b) => a - b)
        const med = errs.length ? errs[errs.length >> 1] : Infinity
        const p90 = errs.length ? errs[Math.floor(errs.length * 0.9)] : Infinity
        check(`${name}: survivors`, stOk >= n * 0.9, `${stOk}/${n}`)
        check(`${name}: median err < ${tolMed}px`, med < tolMed,
            `med ${med.toFixed(3)} p90 ${p90.toFixed(3)}`)
        return { med, p90, r }
    }

    // sub-pixel small shift, unseeded
    evalCase('shift(1.3,-0.7) unseeded', 1.3, -0.7, false, 21, 3, 0.1)
    // moderate shift, unseeded (pyramid does the work)
    evalCase('shift(6.4,4.9) unseeded', 6.4, 4.9, false, 21, 3, 0.12)
    // large shift, unseeded - needs the full pyramid chain
    evalCase('shift(-19.5,14.2) unseeded', -19.5, 14.2, false, 21, 3, 0.25)
    // large shift, seeded - the production path (lkPredictSeed)
    evalCase('shift(-19.5,14.2) seeded', -19.5, 14.2, true, 21, 3, 0.12)
    // big window (the @720 production win)
    evalCase('shift(3.2,2.1) win31', 3.2, 2.1, false, 31, 4, 0.12)

    // err surface: identical images -> err ~ 0; decorrelated -> err large
    {
        upload(toU8(base), W, H, 0, 3)
        upload(toU8(base), W, H, 1, 3)
        const pts = gridPts(40, 24)
        const r = runTrack(pts, pts.slice(), 21, 3, 30)
        let maxErr = 0, maxMove = 0
        for (let i = 0; i < pts.length / 2; i++) {
            if (!r.st[i]) continue
            maxErr = Math.max(maxErr, r.err[i])
            maxMove = Math.max(maxMove,
                Math.hypot(r.next[i * 2] - pts[i * 2], r.next[i * 2 + 1] - pts[i * 2 + 1]))
        }
        check('identity: zero motion', maxMove < 0.05, `maxMove ${maxMove.toFixed(4)}`)
        check('identity: err ~ 0', maxErr < 1.0, `maxErr ${maxErr.toFixed(3)}`)

        const other = makeTexture(W, H, 999)
        upload(toU8(other), W, H, 1, 3)
        const r2 = runTrack(pts, pts.slice(), 21, 3, 30)
        let minErr = Infinity
        for (let i = 0; i < pts.length / 2; i++) {
            if (!r2.st[i]) continue
            minErr = Math.min(minErr, r2.err[i])
        }
        // smooth value-noise keeps some low-frequency correlation even when
        // decorrelated, so the floor is ~13, not ~30 - what matters is that
        // it sits far above genuine-track errs (0-5); the production drift
        // protection is geometric validation, err is a coarse pre-filter
        check('decorrelated: err well above track errs', minErr > 8, `minErr ${minErr.toFixed(1)}`)
    }

    // ---- FAST-9 corner detector ----
    {
        // flat background + bright 6x6 squares at known spots: each square
        // contributes 4 strong corners; NMS must keep them isolated
        const img = new Float64Array(W * H).fill(90)
        const squares = [[60, 60], [160, 80], [240, 140], [80, 180]]
        for (const [sx, sy] of squares) {
            for (let y = sy; y < sy + 6; y++)
                for (let x = sx; x < sx + 6; x++) img[y * W + x] = 220
        }
        upload(toU8(img), W, H, 0, 3)
        const ex2 = ex
        const n = ex2.fast9(0, 20, 2048)
        const tri = new Float32Array(mem(), ex2.fastbuf(), n * 3)
        // multi-level: a strong corner may be reported once per pyramid
        // level it fires at (the pipeline grid-dedups) - bound accordingly
        check('fast9: finds corners', n >= squares.length && n <= squares.length * 4 * 3, `n=${n}`)
        // every detection within coarse tolerance (L2 coords quantize at
        // 4px + <=1 level-px subpix offset), and the STRONGEST detections
        // (level-0) must be sub-pixel tight - that is what the Foerstner
        // refinement buys
        const nearest = (x, y) => {
            let d = Infinity
            for (const [sx, sy] of squares) {
                for (const [cx, cy] of [[sx, sy], [sx + 5, sy], [sx, sy + 5], [sx + 5, sy + 5]]) {
                    d = Math.min(d, Math.hypot(x - cx, y - cy))
                }
            }
            return d
        }
        let allNear = true, minScore = Infinity
        for (let i = 0; i < n; i++) {
            minScore = Math.min(minScore, tri[i * 3 + 2])
            if (nearest(tri[i * 3], tri[i * 3 + 1]) > 6) allNear = false
        }
        check('fast9: detections at true corners (coarse bound)', allNear)
        const byScore = Array.from({ length: n }, (_, i) => i)
            .sort((a, b) => tri[b * 3 + 2] - tri[a * 3 + 2]).slice(0, 4)
        let maxTop = 0
        for (const i of byScore) maxTop = Math.max(maxTop, nearest(tri[i * 3], tri[i * 3 + 1]))
        check('fast9: strongest corners sub-pixel tight', maxTop <= 1.2,
            `top4 max ${maxTop.toFixed(2)}px`)
        check('fast9: scores populated', minScore > 0, `min ${minScore}`)
        // NMS holds within each level; cross-level re-reports of the same
        // corner are the contract (pipeline grid-dedups). Assert instead
        // that a 4px grid dedup leaves an isolated, plausible set.
        const seen = new Set()
        let uniq = 0
        for (let i = 0; i < n; i++) {
            const key = ((tri[i * 3] >> 2) << 12) | (tri[i * 3 + 1] >> 2)
            if (!seen.has(key)) { seen.add(key); uniq++ }
        }
        check('fast9: grid-deduped count plausible',
            uniq >= squares.length && uniq <= squares.length * 8, `uniq=${uniq}`)
        // flat image -> zero corners
        upload(toU8(new Float64Array(W * H).fill(120)), W, H, 0, 3)
        check('fast9: flat image yields none', ex2.fast9(0, 20, 2048) === 0)
    }

    const passed = checks.filter(Boolean).length
    console.log(`========== ${passed}/${checks.length} checks passed ==========`)
    process.exit(passed === checks.length ? 0 : 1)
}

main().catch(e => { console.error(e); process.exit(2) })
