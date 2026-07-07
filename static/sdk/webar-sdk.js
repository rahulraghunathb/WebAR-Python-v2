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
    static get version() { return '0.3.0' }

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
        // Production self-healing: the vision worker must never take the
        // session down. Frame errors surface as empty results (worker
        // side); persistent error streaks, a wedged in-flight frame, or a
        // hard worker death trigger an automatic worker RESTART from a
        // retained copy of the target (the original is transferred away).
        this._targetSnapshot = null
        this._errStreak = 0
        this._restarts = 0
        this._restarting = false
        this._sentAt = 0
        this._watchdog = null
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

        // 1. Load the target: precompiled .webart (instant) or image
        // (compiled in the worker, ~1.2s). targetUrl may be a list of
        // candidates tried in order - e.g. ['x.webart', 'x.jpg'].
        const init = await this._loadTarget(this.targetUrl)

        // 2. Boot the worker (loads ~11MB WASM once; cached by the browser)
        this.worker = new Worker(this.workerUrl)
        this.worker.onmessage = (e) => this._onWorkerMessage(e.data)
        this.worker.onerror = (e) => {
            this._emit('error', new Error('Worker error: ' + e.message))
            this._busy = false
            if (this.ready) this._restartWorker('worker-error')
        }

        const ready = new Promise((resolve, reject) => {
            this._readyResolve = resolve
            this._readyReject = reject
        })

        init.message.config = this.pipelineConfig
        this.worker.postMessage(init.message, init.transfer)

        const info = await ready
        info.targetSource = init.source
        this.ready = true
        this.running = true
        this._emit('ready', info)

        // Watchdog: an in-flight frame with no reply for 4s means the
        // worker is wedged (infinite loop / dead WASM) - restart it.
        this._watchdog = setInterval(() => {
            if (this.running && this._busy && !this._restarting &&
                performance.now() - this._sentAt > 4000) {
                this._busy = false
                this._restartWorker('stall')
            }
        }, 1000)

        // 3. Start the frame pump
        this._pump()
        return info
    }

    /**
     * Terminate and relaunch the vision worker from the retained target
     * snapshot. Bounded (3 attempts per session): a worker that cannot
     * survive re-init is reported as a fatal error instead of looping.
     */
    async _restartWorker(reason) {
        if (this._restarting || !this.running || !this._targetSnapshot) return
        if (++this._restarts > 3) {
            this._emit('error', new Error('WebARSDK: worker unrecoverable (' + reason + ')'))
            this.stop()
            return
        }
        this._restarting = true
        this._emit('workerrestart', { reason, attempt: this._restarts })
        try { if (this.worker) this.worker.terminate() } catch (e) { /* already dead */ }

        this.worker = new Worker(this.workerUrl)
        this.worker.onmessage = (e) => this._onWorkerMessage(e.data)
        this.worker.onerror = () => {
            this._busy = false
            this._restarting = false
            this._restartWorker('worker-error')
        }
        const ready = new Promise((resolve, reject) => {
            this._readyResolve = resolve
            this._readyReject = reject
        })
        const snap = this._targetSnapshot
        let message, transfer
        if (snap.kind === 'webart') {
            const b = snap.buf.slice(0)
            message = { type: 'init', targetBuffer: b, config: this.pipelineConfig }
            transfer = [b]
        } else {
            const d = new ImageData(new Uint8ClampedArray(snap.data), snap.w, snap.h)
            message = { type: 'init', target: d, config: this.pipelineConfig }
            transfer = [d.data.buffer]
        }
        this.worker.postMessage(message, transfer)
        try {
            await ready
            this._errStreak = 0
            this._busy = false
        } catch (e) {
            this._emit('error', e)
        }
        this._restarting = false
    }

    /** Resolve the first loadable target among the candidates. */
    async _loadTarget(urls) {
        const candidates = Array.isArray(urls) ? urls : [urls]
        let lastErr = null
        for (const url of candidates) {
            try {
                if (/\.webart(\?|$)/i.test(url)) {
                    const resp = await fetch(url)
                    if (!resp.ok) throw new Error('HTTP ' + resp.status)
                    const buffer = await resp.arrayBuffer()
                    // retained copy: worker restarts re-init from this
                    // without touching the network
                    this._targetSnapshot = { kind: 'webart', buf: buffer.slice(0) }
                    return {
                        source: url,
                        message: { type: 'init', targetBuffer: buffer },
                        transfer: [buffer]
                    }
                }
                const targetData = await this._loadTargetImageData(url)
                this._targetSnapshot = {
                    kind: 'image',
                    data: new Uint8ClampedArray(targetData.data),
                    w: targetData.width, h: targetData.height
                }
                return {
                    source: url,
                    message: { type: 'init', target: targetData },
                    transfer: [targetData.data.buffer]
                }
            } catch (e) {
                lastErr = e
                console.warn('[WebARSDK] target candidate failed:', url, e.message)
            }
        }
        throw new Error('WebARSDK: no target candidate loaded: ' + (lastErr && lastErr.message))
    }

    stop() {
        this.running = false
        if (this._watchdog) { clearInterval(this._watchdog); this._watchdog = null }
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
            // persistent error streak = corrupted worker state: escalate
            // reset -> restart instead of erroring forever
            this._errStreak++
            if (this._errStreak >= 8 && this.ready) {
                this._errStreak = 0
                this._restartWorker('error-streak')
            } else if (this._errStreak === 3) {
                this.resetTracking()
            }
            return
        }
        if (msg.type === 'result') {
            this._busy = false
            this._errStreak = 0

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
        if (this._busy || !this.ready || this._restarting) return
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
        this._sentAt = t0

        try {
            // The canvas fallback must NOT be sticky for the whole session:
            // a single early createImageBitmap failure (video not fully
            // ready in the first frames) would otherwise pin every frame to
            // the ~35ms main-thread path (seen dragging render fps to 29).
            // Retry the GPU path every 5s.
            if (this._captureMode === 'canvas' &&
                this._captureRetryAt && t0 >= this._captureRetryAt) {
                this._captureMode = null
            }

            if (this._captureMode !== 'canvas') {
                // GPU-accelerated capture + zero-copy transfer
                try {
                    const bitmap = await createImageBitmap(this.video, {
                        resizeWidth: w, resizeHeight: h, resizeQuality: 'low'
                    })
                    this.stats.captureMs = Math.round((performance.now() - t0) * 10) / 10
                    this._emit('framesent', { id, timestamp: t0 })
                    this.worker.postMessage({ type: 'frame', bitmap, id, intrinsics, ts: t0 }, [bitmap])
                    this._captureMode = 'bitmap'
                    return
                } catch (e) {
                    // Safari/older browsers (or a not-yet-ready video):
                    // fall through to the canvas path, retry GPU later
                    this._captureMode = 'canvas'
                    this._captureRetryAt = t0 + 5000
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
            this.worker.postMessage({ type: 'frame', imageData, id, intrinsics, ts: t0 }, [imageData.data.buffer])
        } catch (e) {
            this._busy = false
            this._emit('error', e)
        }
    }
}

// Export
window.WebARSDK = WebARSDK
