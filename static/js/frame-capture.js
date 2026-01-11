/**
 * Frame Capture Module
 * 
 * Captures raw video frames as grayscale pixels for local processing.
 * Eliminates JPEG encoding and Base64 conversion overhead.
 * 
 * Performance: ~1-2ms per frame capture (vs 5-10ms for JPEG encoding)
 */

class FrameCapture {
    constructor(video, targetWidth = 640) {
        this.video = video
        this.targetWidth = targetWidth

        // Use OffscreenCanvas if available for better performance
        if (typeof OffscreenCanvas !== 'undefined') {
            this.canvas = new OffscreenCanvas(targetWidth, targetWidth)
            console.log('[FrameCapture] Using OffscreenCanvas')
        } else {
            this.canvas = document.createElement('canvas')
            console.log('[FrameCapture] Using regular Canvas')
        }

        this.ctx = this.canvas.getContext('2d', {
            willReadFrequently: true,
            alpha: false
        })

        // Reusable buffers
        this.grayBuffer = null
        this.lastWidth = 0
        this.lastHeight = 0

        // Performance tracking
        this.captureTimeMs = 0
    }

    /**
     * Capture current video frame as grayscale Uint8Array
     * @returns {Object} { gray: Uint8Array, width: number, height: number, captureTimeMs: number }
     */
    captureGrayscale() {
        const startTime = performance.now()

        const { videoWidth, videoHeight } = this.video
        if (!videoWidth || !videoHeight) {
            return null
        }

        // Calculate scaled dimensions
        const scale = this.targetWidth / Math.max(videoWidth, videoHeight)
        const w = Math.floor(videoWidth * scale)
        const h = Math.floor(videoHeight * scale)

        // Resize canvas if needed
        if (this.canvas.width !== w || this.canvas.height !== h) {
            this.canvas.width = w
            this.canvas.height = h
            this.grayBuffer = new Uint8Array(w * h)
            this.lastWidth = w
            this.lastHeight = h
        }

        // Draw video frame to canvas
        this.ctx.drawImage(this.video, 0, 0, w, h)

        // Get RGBA pixels
        const imageData = this.ctx.getImageData(0, 0, w, h)
        const rgba = imageData.data

        // Convert to grayscale using luminance formula
        // Y = 0.299*R + 0.587*G + 0.114*B
        const gray = this.grayBuffer
        for (let i = 0, j = 0; i < gray.length; i++, j += 4) {
            gray[i] = Math.round(
                0.299 * rgba[j] +
                0.587 * rgba[j + 1] +
                0.114 * rgba[j + 2]
            )
        }

        this.captureTimeMs = performance.now() - startTime

        return {
            gray,
            width: w,
            height: h,
            captureTimeMs: this.captureTimeMs
        }
    }

    /**
     * Capture current video frame as RGBA ImageData
     * @returns {Object} { imageData: ImageData, width: number, height: number }
     */
    captureRGBA() {
        const startTime = performance.now()

        const { videoWidth, videoHeight } = this.video
        if (!videoWidth || !videoHeight) {
            return null
        }

        const scale = this.targetWidth / Math.max(videoWidth, videoHeight)
        const w = Math.floor(videoWidth * scale)
        const h = Math.floor(videoHeight * scale)

        if (this.canvas.width !== w || this.canvas.height !== h) {
            this.canvas.width = w
            this.canvas.height = h
        }

        this.ctx.drawImage(this.video, 0, 0, w, h)
        const imageData = this.ctx.getImageData(0, 0, w, h)

        this.captureTimeMs = performance.now() - startTime

        return {
            imageData,
            width: w,
            height: h,
            captureTimeMs: this.captureTimeMs
        }
    }

    /**
     * Get last capture time in milliseconds
     */
    getLastCaptureTime() {
        return this.captureTimeMs
    }

    /**
     * Get current target dimensions
     */
    getDimensions() {
        return {
            width: this.lastWidth,
            height: this.lastHeight,
            targetWidth: this.targetWidth
        }
    }

    /**
     * Set target width for capture
     */
    setTargetWidth(width) {
        this.targetWidth = width
    }
}

// Export for use
window.FrameCapture = FrameCapture
