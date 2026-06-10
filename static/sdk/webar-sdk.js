/**
 * WebAR SDK - Main-thread engine and public API
 *
 * Client-side image tracking: all per-frame vision runs in a Web Worker
 * (WASM), no server round-trips. The main thread only:
 *   1. captures downscaled video frames (GPU path via createImageBitmap
 *      where available, canvas fallback otherwise)
 *   2. applies backpressure (single in-flight frame, newest wins)
 *   3. emits pose results to the app / renderer
 *
 * Usage:
 *   const sdk = new WebARSDK({
 *       video: videoElement,
 *       targetUrl: '/static/assets/ranger-base-image.jpg',
 *       intrinsicsProvider: cameraIntrinsicsManager   // optional
 *   })
 *   sdk.on('result', (r) => { ... })       // same shape as the old server results
 *   sdk.on('framesent', ({id}) => { ... }) // hook for IMU snapshot sync
 *   await sdk.start()
 */

class WebARSDK {
    constructor(options) {
        options = options || {}
        this.video = options.video
        this.targetUrl = options.targetUrl
        this.workerUrl = options.workerUrl || '/static/sdk/vision/vision-worker.js'
        this.maxDimension = options.maxDimension || 480
        this.intrinsicsProvider = options.intrinsicsProvider || null
        this.pipelineConfig = options.pipelineConfig || null

        this.worker = null
        this.ready = false
        this.running = false
        this._busy = false          // one frame in flight at a time
        this._frameId = 0
        this._captureMode = null    // 'bitmap' | 'canvas'
        this._captureCanvas = null
        this._captureCtx = null
        this._vfcHandle = null
        this._rafHandle = null

        // Stats
        this.stats = {
            fps: 0, procMs: 0, captureMs: 0,
            _results: 0, _procSum: 0, _lastTick: performance.now()
        }

        this._listeners = {}
    }

    // ---------------- events ----------------
    on(event, fn) {
        (this._listeners[event] = this._listeners[event] || []).push(fn)
        return this
    }
    off(event, fn) {
        const l = this._listeners[event]
        if (l) this._listeners[event] = l.filter(f => f !== fn)
        return this
    }
    _emit(event, data) {
        const l = this._listeners[event]
        if (l) for (const fn of l) fn(data)
    }

    // ---------------- lifecycle ----------------

    async start() {
        if (this.running) return
        if (!this.video) throw new Error('WebARSDK: video element required')
        if (!this.targetUrl) throw new Error('WebARSDK: targetUrl required')

        // 1. Load and rasterize the target image
        const targetData = await this._loadTargetImageData(this.targetUrl)

        // 2. Boot the worker (loads ~11MB WASM once; cached by the browser)
        this.worker = new Worker(this.workerUrl)
        this.worker.onmessage = (e) => this._onWorkerMessage(e.data)
        this.worker.onerror = (e) => this._emit('error', new Error('Worker error: ' + e.message))

        const ready = new Promise((resolve, reject) => {
            this._readyResolve = resolve
            this._readyReject = reject
        })

        this.worker.postMessage(
            { type: 'init', target: targetData, config: this.pipelineConfig },
            [targetData.data.buffer]
        )

        const info = await ready
        this.ready = true
        this.running = true
        this._emit('ready', info)

        // 3. Start the frame pump
        this._pump()
        return info
    }

    stop() {
        this.running = false
        if (this._vfcHandle && this.video.cancelVideoFrameCallback) {
            this.video.cancelVideoFrameCallback(this._vfcHandle)
        }
        if (this._rafHandle) cancelAnimationFrame(this._rafHandle)
        if (this.worker) {
            this.worker.terminate()
            this.worker = null
        }
        this.ready = false
    }

    resetTracking() {
        if (this.worker && this.ready) this.worker.postMessage({ type: 'reset' })
    }

    // ---------------- internals ----------------

    async _loadTargetImageData(url) {
        const resp = await fetch(url)
        if (!resp.ok) throw new Error('WebARSDK: failed to fetch target: ' + resp.status)
        const blob = await resp.blob()
        const bitmap = await createImageBitmap(blob)
        const canvas = document.createElement('canvas')
        canvas.width = bitmap.width
        canvas.height = bitmap.height
        const ctx = canvas.getContext('2d')
        ctx.drawImage(bitmap, 0, 0)
        bitmap.close()
        return ctx.getImageData(0, 0, canvas.width, canvas.height)
    }

    _onWorkerMessage(msg) {
        if (msg.type === 'ready') {
            if (this._readyResolve) { this._readyResolve(msg.info); this._readyResolve = null }
            return
        }
        if (msg.type === 'error') {
            const err = new Error(msg.message)
            if (this._readyReject) { this._readyReject(err); this._readyReject = null }
            this._emit('error', err)
            this._busy = false
            return
        }
        if (msg.type === 'result') {
            this._busy = false

            // Stats
            const s = this.stats
            s._results++
            s._procSum += (msg.debug && msg.debug.proc_ms) || 0
            const now = performance.now()
            if (now - s._lastTick >= 1000) {
                s.fps = s._results
                s.procMs = s._results ? Math.round(s._procSum / s._results * 10) / 10 : 0
                s._results = 0
                s._procSum = 0
                s._lastTick = now
            }

            this._emit('result', msg)
        }
    }

    _pump() {
        const onFrame = () => {
            if (!this.running) return
            this._captureAndSend()
            schedule()
        }
        const schedule = () => {
            if (!this.running) return
            if (this.video.requestVideoFrameCallback) {
                this._vfcHandle = this.video.requestVideoFrameCallback(onFrame)
            } else {
                this._rafHandle = requestAnimationFrame(onFrame)
            }
        }
        schedule()
    }

    async _captureAndSend() {
        // Backpressure: if the worker is mid-frame, skip - the next video
        // frame is always fresher than a queued one (zero queue latency).
        if (this._busy || !this.ready) return
        if (!this.video.videoWidth) return

        const vw = this.video.videoWidth
        const vh = this.video.videoHeight
        const scale = Math.min(1, this.maxDimension / Math.max(vw, vh))
        const w = Math.round(vw * scale)
        const h = Math.round(vh * scale)

        const id = ++this._frameId
        const intrinsics = this.intrinsicsProvider
            ? this.intrinsicsProvider.getIntrinsicsForFrame(w, h)
            : null

        const t0 = performance.now()
        this._busy = true

        try {
            if (this._captureMode !== 'canvas') {
                // GPU-accelerated capture + zero-copy transfer
                try {
                    const bitmap = await createImageBitmap(this.video, {
                        resizeWidth: w, resizeHeight: h, resizeQuality: 'low'
                    })
                    this.stats.captureMs = Math.round((performance.now() - t0) * 10) / 10
                    this._emit('framesent', { id, timestamp: t0 })
                    this.worker.postMessage({ type: 'frame', bitmap, id, intrinsics }, [bitmap])
                    this._captureMode = 'bitmap'
                    return
                } catch (e) {
                    // Safari/older browsers: fall through to canvas path
                    this._captureMode = 'canvas'
                }
            }

            if (!this._captureCanvas || this._captureCanvas.width !== w || this._captureCanvas.height !== h) {
                this._captureCanvas = document.createElement('canvas')
                this._captureCanvas.width = w
                this._captureCanvas.height = h
                this._captureCtx = this._captureCanvas.getContext('2d', { willReadFrequently: true })
            }
            this._captureCtx.drawImage(this.video, 0, 0, w, h)
            const imageData = this._captureCtx.getImageData(0, 0, w, h)
            this.stats.captureMs = Math.round((performance.now() - t0) * 10) / 10
            this._emit('framesent', { id, timestamp: t0 })
            this.worker.postMessage({ type: 'frame', imageData, id, intrinsics }, [imageData.data.buffer])
        } catch (e) {
            this._busy = false
            this._emit('error', e)
        }
    }
}

// Export
window.WebARSDK = WebARSDK
