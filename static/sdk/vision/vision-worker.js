/**
 * WebAR SDK - Vision Worker
 *
 * Owns the OpenCV.js (WASM) runtime and the detect-then-track pipeline.
 * Runs entirely off the main thread: the page only captures frames and
 * renders poses.
 *
 * Protocol (postMessage):
 *   in : { type:'init', target: ImageData, config? }
 *   out: { type:'ready', info } | { type:'error', message }
 *   in : { type:'frame', bitmap?|imageData?, id, intrinsics?{fx,fy,cx,cy} }
 *   out: { type:'result', id, detected, corners?, pose?, debug }
 *   in : { type:'reset' }
 */

/* global cv, VisionPipeline, parseWebART */

/**
 * Runtime selection: prefer the slim SIMD build (~6x smaller, 2-4x faster
 * feature extraction), fall back to the full universal build when the slim
 * file is absent or the browser lacks WASM SIMD.
 */
let OPENCV_RUNTIME = 'full'
;(function loadOpenCV() {
    // Minimal wasm module using a SIMD instruction - validates only where
    // SIMD is supported (standard wasm-feature-detect probe).
    const SIMD_PROBE = new Uint8Array([
        0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0,
        10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11
    ])
    let simd = false
    try { simd = WebAssembly.validate(SIMD_PROBE) } catch (e) {}

    if (simd) {
        try {
            importScripts('../vendor/opencv-slim.js')
            OPENCV_RUNTIME = 'slim-simd'
            return
        } catch (e) {
            // slim build not deployed (or failed to parse) - use full
        }
    }
    importScripts('../vendor/opencv.js')
})()

importScripts('./webart-format.js', './geometry.js', './map.js', './matcher.js', './pipeline.js')

let pipeline = null
let canvas = null
let ctx = null
let grayMat = null
let rgbaMat = null

/**
 * Resolve whichever flavor of opencv.js init we got (thenable or callback).
 *
 * CAREFUL: the emscripten module is a thenable that resolves WITH ITSELF.
 * Resolving a Promise with it would make the Promise adopt the thenable
 * recursively and never settle - so we always resolve with `undefined`
 * and use the global `cv` afterwards.
 */
function cvReady() {
    return new Promise((resolve, reject) => {
        if (typeof cv === 'undefined') return reject(new Error('opencv.js failed to load'))
        if (cv.Mat) return resolve()
        if (typeof cv.then === 'function') {
            cv.then((mod) => { self.cv = mod; resolve() })
        } else {
            cv.onRuntimeInitialized = () => resolve()
        }
    })
}

/** Convert an incoming frame (ImageBitmap or ImageData) to a gray cv.Mat. */
function toGray(msg) {
    let imageData = msg.imageData
    if (msg.bitmap) {
        const w = msg.bitmap.width, h = msg.bitmap.height
        if (!canvas || canvas.width !== w || canvas.height !== h) {
            canvas = new OffscreenCanvas(w, h)
            ctx = canvas.getContext('2d', { willReadFrequently: true })
        }
        ctx.drawImage(msg.bitmap, 0, 0)
        msg.bitmap.close()
        imageData = ctx.getImageData(0, 0, w, h)
    }
    if (!imageData) return null

    // Reuse Mats across frames (allocation churn matters at 30-60fps)
    if (!rgbaMat || rgbaMat.cols !== imageData.width || rgbaMat.rows !== imageData.height) {
        if (rgbaMat) rgbaMat.delete()
        if (grayMat) grayMat.delete()
        rgbaMat = new cv.Mat(imageData.height, imageData.width, cv.CV_8UC4)
        grayMat = new cv.Mat()
    }
    rgbaMat.data.set(imageData.data)
    cv.cvtColor(rgbaMat, grayMat, cv.COLOR_RGBA2GRAY)
    return grayMat
}

self.onmessage = async (e) => {
    const msg = e.data

    try {
        if (msg.type === 'init') {
            await cvReady()
            // SIMD Hamming matcher (7x the cv BFMatcher); pipeline falls
            // back to the cv path when unavailable
            if (typeof SimdMatcher !== 'undefined') await SimdMatcher.init()
            pipeline = new VisionPipeline(msg.config)
            let info
            if (msg.targetBuffer) {
                // Precompiled .webart: parse + load, no in-browser extraction
                info = pipeline.loadCompiledTarget(parseWebART(msg.targetBuffer))
            } else {
                info = pipeline.compileTarget(msg.target)
            }
            if (!info.ready) {
                self.postMessage({ type: 'error', message: 'Target compilation produced no features' })
                return
            }
            // Warm up the hot paths (ORB + matcher JIT/wasm tiering): the
            // first real detect otherwise pays a ~130ms one-off spike. The
            // pattern must be corner-RICH (random 8x8 blocks) or ORB finds
            // nothing and the matcher never runs.
            try {
                const W = 480, H = 360
                const warm = new cv.Mat(H, W, cv.CV_8U)
                const buf = new Uint8Array(W * H)
                let seed = 123456789
                for (let by = 0; by < H; by += 8) {
                    for (let bx = 0; bx < W; bx += 8) {
                        seed = (seed * 1664525 + 1013904223) >>> 0
                        const g = seed & 255
                        for (let y = by; y < by + 8 && y < H; y++) {
                            buf.fill(g, y * W + bx, y * W + Math.min(bx + 8, W))
                        }
                    }
                }
                warm.data.set(buf)
                pipeline.processFrame(warm)
                pipeline.processFrame(warm)   // second pass settles wasm tiering
                warm.delete()
                pipeline.reset()
            } catch (e) { /* warmup is best-effort */ }
            info.runtime = OPENCV_RUNTIME
            info.simdMatcher = (typeof SimdMatcher !== 'undefined') && SimdMatcher.ready
            self.postMessage({ type: 'ready', info })
            return
        }

        if (!pipeline) return

        if (msg.type === 'frame') {
            const gray = toGray(msg)
            if (!gray) {
                self.postMessage({ type: 'result', id: msg.id, detected: false, debug: { error: 'bad frame' } })
                return
            }
            if (msg.intrinsics && msg.intrinsics.fx) {
                pipeline.setIntrinsics(
                    msg.intrinsics.fx, msg.intrinsics.fy,
                    msg.intrinsics.cx !== undefined ? msg.intrinsics.cx : gray.cols / 2,
                    msg.intrinsics.cy !== undefined ? msg.intrinsics.cy : gray.rows / 2
                )
            }
            const result = pipeline.processFrame(gray)
            result.type = 'result'
            result.id = msg.id
            if (result.pose) result.pose.id = msg.id
            self.postMessage(result)
            return
        }

        if (msg.type === 'reset') {
            pipeline.reset()
            return
        }
    } catch (err) {
        self.postMessage({ type: 'error', message: String(err && err.stack || err), id: msg && msg.id })
    }
}
