/**
 * Vision Manager
 * 
 * Abstraction layer for vision processing. Currently uses server-side processing
 * but designed to seamlessly switch to client-side WASM when available.
 * 
 * Future: Will use WebWorker + WASM for local processing
 */

class VisionManager {
    constructor() {
        // Processing mode: 'server' | 'wasm'
        this.mode = 'server'

        // Server-side components
        this.wsManager = null

        // Frame capture
        this.frameCapture = null

        // Callbacks
        this.onPose = null
        this.onStatus = null
        this.onError = null

        // State
        this.isReady = false
        this.isProcessing = false
        this.lastProcessTime = 0

        // Throttle settings
        this.minIntervalMs = 80  // ~12 FPS max to server

        // Metrics
        this.metrics = {
            framesProcessed: 0,
            avgProcessTime: 0,
            lastProcessTime: 0,
            dropCount: 0
        }
    }

    /**
     * Initialize vision processing
     * @param {Object} options - { video, wsManager, mode, targetUrl }
     */
    async init(options) {
        const { video, wsManager, mode = 'server' } = options

        this.mode = mode
        this.wsManager = wsManager

        // Initialize frame capture
        this.frameCapture = new FrameCapture(video, 640)

        if (this.mode === 'server') {
            await this._initServerMode()
        } else if (this.mode === 'wasm') {
            await this._initWasmMode(options)
        }

        this.isReady = true
        console.log(`[VisionManager] Initialized in ${this.mode} mode`)

        return true
    }

    /**
     * Initialize server-side processing mode
     */
    async _initServerMode() {
        // Server mode uses existing WebSocketManager
        // Just verify connection
        if (!this.wsManager) {
            throw new Error('WebSocketManager required for server mode')
        }

        console.log('[VisionManager] Server mode ready')
    }

    /**
     * Initialize WASM processing mode (future)
     */
    async _initWasmMode(options) {
        // TODO: Load WASM module
        // TODO: Initialize WebWorker
        // TODO: Load target image to WASM
        throw new Error('WASM mode not yet implemented')
    }

    /**
     * Process a video frame
     * @param {Object} intrinsics - Camera intrinsics { fx, fy, cx, cy, width, height }
     * @returns {Promise<Object|null>} - Pose result or null if skipped
     */
    async processFrame(intrinsics) {
        if (!this.isReady) return null

        const now = performance.now()

        // Throttle processing
        if (now - this.lastProcessTime < this.minIntervalMs) {
            this.metrics.dropCount++
            return null
        }

        // Skip if still processing previous frame
        if (this.isProcessing) {
            this.metrics.dropCount++
            return null
        }

        this.isProcessing = true
        this.lastProcessTime = now

        try {
            if (this.mode === 'server') {
                return await this._processServerMode(intrinsics)
            } else {
                return await this._processWasmMode(intrinsics)
            }
        } finally {
            this.isProcessing = false
        }
    }

    /**
     * Process frame via server (current implementation)
     */
    async _processServerMode(intrinsics) {
        // Capture frame as JPEG for server (current format)
        // TODO: In future, send raw pixels + have Python side decode
        const capture = this.frameCapture.captureRGBA()
        if (!capture) return null

        // Convert to data URL for server
        // Note: This still has JPEG overhead, but we've prepared for future optimization
        const canvas = document.createElement('canvas')
        canvas.width = capture.width
        canvas.height = capture.height
        const ctx = canvas.getContext('2d')
        ctx.putImageData(capture.imageData, 0, 0)
        const dataUrl = canvas.toDataURL('image/jpeg', 0.7)

        // Send to server (async - result comes via callback)
        this.wsManager.sendFrameWithIntrinsics(dataUrl, intrinsics, Date.now())

        this.metrics.framesProcessed++
        this.metrics.lastProcessTime = capture.captureTimeMs

        return null // Result comes via WebSocket callback
    }

    /**
     * Process frame via WASM (future implementation)
     */
    async _processWasmMode(intrinsics) {
        // Capture grayscale frame
        const capture = this.frameCapture.captureGrayscale()
        if (!capture) return null

        // TODO: Send to WebWorker for WASM processing
        // const pose = await this.worker.process(capture.gray, capture.width, capture.height, intrinsics);

        this.metrics.framesProcessed++
        this.metrics.lastProcessTime = capture.captureTimeMs

        throw new Error('WASM processing not yet implemented')
    }

    /**
     * Handle result from server (called by WebSocket callback)
     */
    handleServerResult(data) {
        if (data.detected && data.pose && this.onPose) {
            this.onPose({
                detected: true,
                pose: data.pose,
                corners: data.corners,
                debug: data.debug
            })
        } else if (!data.detected && this.onPose) {
            this.onPose({
                detected: false,
                debug: data.debug
            })
        }
    }

    /**
     * Get processing metrics
     */
    getMetrics() {
        return {
            ...this.metrics,
            mode: this.mode,
            isReady: this.isReady,
            isProcessing: this.isProcessing
        }
    }

    /**
     * Set processing throttle interval
     */
    setThrottle(intervalMs) {
        this.minIntervalMs = Math.max(16, intervalMs) // Min ~60fps
    }

    /**
     * Cleanup
     */
    destroy() {
        this.isReady = false
        this.frameCapture = null
        this.wsManager = null
    }
}

// Export
window.VisionManager = VisionManager
