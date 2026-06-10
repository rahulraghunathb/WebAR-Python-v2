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

/* global cv, VisionPipeline */

importScripts('../vendor/opencv.js', './pipeline.js')

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
            pipeline = new VisionPipeline(msg.config)
            const info = pipeline.compileTarget(msg.target)
            if (!info.ready) {
                self.postMessage({ type: 'error', message: 'Target compilation produced no features' })
                return
            }
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
