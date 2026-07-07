/**
 * WebAR SDK - Detection sub-worker (splitDetect mode)
 *
 * The DETECTION SERVICE: owns its own WASM runtime + pipeline instance and
 * serves full-density detection requests from the tracking worker, so the
 * tracking loop never blocks on ORB/match/RANSAC (the 100-500ms on-device
 * spike class). Stateless per request except the compiled target: the
 * tracker ships its learned gate state (fastThresh/lastScale/noisePx) with
 * every request.
 *
 * Protocol:
 *   in : { type:'init', targetBuffer? | target?, config? }
 *   out: { type:'ready' } | { type:'error', message }
 *   in : { type:'detect', gray:ArrayBuffer, w, h, frameId, kind, opts, state }
 *   out: { type:'detect-result', frameId, kind, res:{det,harvest,scene,fastThresh}|null }
 */

/* global cv, VisionPipeline, parseWebART, SimdMatcher */

let OPENCV_RUNTIME = 'full'
;(function loadOpenCV() {
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
        } catch (e) { /* fall through to full build */ }
    }
    importScripts('../vendor/opencv.js')
})()

importScripts('./webart-format.js', './geometry.js', './map.js', './matcher.js', './pipeline.js')

let pipeline = null
let grayMat = null

function cvReady() {
    return new Promise((resolve, reject) => {
        if (typeof cv === 'undefined') return reject(new Error('opencv.js failed to load'))
        if (cv.Mat) return resolve()
        if (typeof cv.then === 'function') {
            // modern builds export a thenable module
            cv.then((mod) => { self.cv = mod; resolve() })
        } else {
            cv.onRuntimeInitialized = () => resolve()
        }
    })
}

self.onmessage = async (e) => {
    const msg = e.data
    try {
        if (msg.type === 'init') {
            await cvReady()
            if (typeof SimdMatcher !== 'undefined') await SimdMatcher.init()
            pipeline = new VisionPipeline(msg.config)
            const info = msg.targetBuffer
                ? pipeline.loadCompiledTarget(parseWebART(msg.targetBuffer))
                : pipeline.compileTarget(msg.target)
            if (!info.ready) {
                self.postMessage({ type: 'error', message: 'detect-worker: target has no features' })
                return
            }
            self.postMessage({ type: 'ready' })
            return
        }

        if (!pipeline) return

        if (msg.type === 'detect') {
            if (!grayMat || grayMat.cols !== msg.w || grayMat.rows !== msg.h) {
                if (grayMat) grayMat.delete()
                grayMat = new cv.Mat(msg.h, msg.w, cv.CV_8U)
            }
            grayMat.data.set(new Uint8Array(msg.gray))
            const res = pipeline.serveDetect(grayMat, msg.opts, msg.state)
            self.postMessage({ type: 'detect-result', frameId: msg.frameId, kind: msg.kind, res })
            return
        }
    } catch (err) {
        // a failed detect must never wedge the tracker: reply empty so the
        // pending slot clears and the next cadence tick re-requests
        if (msg && msg.type === 'detect') {
            self.postMessage({ type: 'detect-result', frameId: msg.frameId, kind: msg.kind, res: null })
        } else {
            self.postMessage({ type: 'error', message: String(err && err.stack || err) })
        }
    }
}
