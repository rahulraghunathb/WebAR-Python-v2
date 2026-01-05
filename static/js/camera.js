/**
 * Camera Module
 * Single Responsibility: Handle camera stream acquisition and management
 */

class CameraManager {
    constructor() {
        this.stream = null;
        this.videoElement = null;
        this.facingMode = 'environment'; // Use back camera by default on mobile
        this.constraints = {
            video: {
                facingMode: this.facingMode,
                width: { ideal: 1280 },
                height: { ideal: 720 }
            },
            audio: false
        };
    }

    /**
     * Initialize camera with video element
     * @param {HTMLVideoElement} videoElement - Video element to attach stream to
     */
    setVideoElement(videoElement) {
        this.videoElement = videoElement;
    }

    /**
     * Start camera stream
     * @returns {Promise<MediaStream>} - The camera stream
     */
    async start() {
        if (!this.videoElement) {
            throw new Error('Video element not set');
        }

        try {
            // Stop existing stream if any
            this.stop();

            // Request camera access
            this.stream = await navigator.mediaDevices.getUserMedia(this.constraints);

            // Attach to video element
            this.videoElement.srcObject = this.stream;

            // Wait for video to be ready
            await new Promise((resolve) => {
                this.videoElement.onloadedmetadata = () => {
                    this.videoElement.play().then(resolve);
                };
            });

            return this.stream;
        } catch (error) {
            console.error('Camera access error:', error);
            throw error;
        }
    }

    /**
     * Stop camera stream
     */
    stop() {
        if (this.stream) {
            this.stream.getTracks().forEach(track => track.stop());
            this.stream = null;
        }
        if (this.videoElement) {
            this.videoElement.srcObject = null;
        }
    }

    /**
     * Switch between front and back camera
     * @returns {Promise<MediaStream>} - New camera stream
     */
    async switchCamera() {
        this.facingMode = this.facingMode === 'environment' ? 'user' : 'environment';
        this.constraints.video.facingMode = this.facingMode;
        return this.start();
    }

    /**
     * Check if device has multiple cameras
     * @returns {Promise<boolean>}
     */
    async hasMultipleCameras() {
        try {
            const devices = await navigator.mediaDevices.enumerateDevices();
            const videoDevices = devices.filter(d => d.kind === 'videoinput');
            return videoDevices.length > 1;
        } catch {
            return false;
        }
    }

    /**
     * Get video dimensions
     * @returns {{width: number, height: number}}
     */
    getDimensions() {
        if (!this.videoElement) {
            return { width: 0, height: 0 };
        }
        return {
            width: this.videoElement.videoWidth,
            height: this.videoElement.videoHeight
        };
    }

    /**
     * Capture current frame as canvas
     * @param {HTMLCanvasElement} canvas - Canvas to draw frame on
     * @returns {HTMLCanvasElement}
     */
    captureFrame(canvas) {
        if (!this.videoElement || !this.stream) {
            return null;
        }

        const { width, height } = this.getDimensions();
        canvas.width = width;
        canvas.height = height;

        const ctx = canvas.getContext('2d');
        ctx.drawImage(this.videoElement, 0, 0, width, height);

        return canvas;
    }

    /**
     * Get current frame as base64 JPEG
     * @param {number} quality - JPEG quality (0-1)
     * @returns {string} - Base64 encoded JPEG
     */
    getFrameAsBase64(quality = 0.7) {
        if (!this.videoElement || !this.stream) {
            return null;
        }

        const canvas = document.createElement('canvas');
        this.captureFrame(canvas);
        return canvas.toDataURL('image/jpeg', quality);
    }

    /**
     * Check if camera is currently active
     * @returns {boolean}
     */
    isActive() {
        return this.stream !== null && this.stream.active;
    }
}

// Export singleton instance
window.CameraManager = CameraManager;
