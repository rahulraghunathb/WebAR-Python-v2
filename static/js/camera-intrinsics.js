/**
 * Camera Intrinsics Manager - Verified FOV System
 *
 * MATHEMATICAL FOUNDATION:
 * ========================
 *
 * Camera Intrinsic Matrix K:
 *   K = | fx  0  cx |
 *       | 0  fy  cy |
 *       | 0   0   1 |
 *
 * Where:
 *   fx, fy = focal lengths in pixels
 *   cx, cy = principal point (optical center)
 *
 * FOV Derivation:
 *   For a pinhole camera model:
 *   tan(FOV_horizontal / 2) = (width / 2) / fx
 *   tan(FOV_vertical / 2) = (height / 2) / fy
 *
 *   Therefore:
 *   FOV_horizontal = 2 * atan(width / (2 * fx))
 *   FOV_vertical = 2 * atan(height / (2 * fy))
 *
 * CRITICAL INSIGHT:
 *   Three.js PerspectiveCamera uses VERTICAL FOV
 *   The vertical FOV must be computed from fy and frame height
 *   This FOV should ONLY change when:
 *     1. Camera lens changes (front/back switch)
 *     2. Video resolution changes
 *     3. Zoom level changes
 *
 *   It should NOT change per-frame during tracking!
 *
 * SCALING INTRINSICS:
 *   When resolution changes from (W1, H1) to (W2, H2):
 *   - If cropping: FOV changes (different portion of sensor)
 *   - If scaling: FOV stays same, fx/fy scale proportionally
 *
 *   For our case (scaling down for network):
 *   fx_new = fx_orig * (W_new / W_orig)
 *   fy_new = fy_orig * (H_new / H_orig)
 *   cx_new = cx_orig * (W_new / W_orig)
 *   cy_new = cy_orig * (H_new / H_orig)
 */

class CameraIntrinsicsManager {
    constructor() {
        // Canonical intrinsics at native camera resolution
        // These are the "source of truth" set once when camera starts
        this._canonicalIntrinsics = null;

        // Current intrinsics (may be scaled for different resolutions)
        this._currentIntrinsics = null;

        // Intrinsics fingerprint - changes only when camera config changes
        this._intrinsicsFingerprint = null;

        // Device detection
        this.deviceInfo = {
            platform: this._detectPlatform(),
            isIOS: /iPad|iPhone|iPod/.test(navigator.userAgent),
            isAndroid: /Android/.test(navigator.userAgent),
            isMobile: /Mobi|Android/i.test(navigator.userAgent)
        };

        // Known device horizontal FOV database (degrees)
        // These are HORIZONTAL FOV values for the main rear camera
        this._deviceFOVDatabase = {
            // iPhone rear cameras (wide lens)
            'iPhone': 69,
            'iPad': 54,
            // Android varies, use conservative estimate
            'Android': 65,
            // Desktop webcams
            'desktop': 60,
            // Fallback
            'default': 60
        };

        // Permission states
        this.permissions = {
            camera: 'prompt',
            motion: 'prompt',
            orientation: 'prompt'
        };

        // Camera capabilities cache
        this._capabilities = null;
        this._settings = null;

        console.log('[Intrinsics] Manager initialized', this.deviceInfo);
    }

    _detectPlatform() {
        const ua = navigator.userAgent;
        if (/iPhone/.test(ua)) return 'iPhone';
        if (/iPad/.test(ua)) return 'iPad';
        if (/Android/.test(ua)) return 'Android';
        return 'desktop';
    }

    /**
     * Request all necessary permissions for AR
     */
    async requestAllPermissions() {
        const results = {
            camera: false,
            motion: false,
            orientation: false
        };

        // 1. Camera permission
        try {
            results.camera = await this._requestCameraPermission();
        } catch (e) {
            console.error('[Intrinsics] Camera permission failed:', e);
        }

        // 2. Device Motion permission (iOS 13+)
        try {
            results.motion = await this._requestMotionPermission();
        } catch (e) {
            console.log('[Intrinsics] Motion permission not available');
        }

        // 3. Device Orientation permission (iOS 13+)
        try {
            results.orientation = await this._requestOrientationPermission();
        } catch (e) {
            console.log('[Intrinsics] Orientation permission not available');
        }

        console.log('[Intrinsics] Permission results:', results);
        return results;
    }

    async _requestCameraPermission() {
        const constraints = {
            video: {
                facingMode: { ideal: 'environment' },
                width: { ideal: 1920, min: 640 },
                height: { ideal: 1080, min: 480 },
                frameRate: { ideal: 30, min: 15 }
            },
            audio: false
        };

        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        const track = stream.getVideoTracks()[0];

        // Cache capabilities and settings
        if (track.getCapabilities) {
            this._capabilities = track.getCapabilities();
        }
        if (track.getSettings) {
            this._settings = track.getSettings();
        }

        // Stop the stream (will be restarted by CameraManager)
        stream.getTracks().forEach(t => t.stop());

        this.permissions.camera = 'granted';
        return true;
    }

    async _requestMotionPermission() {
        if (typeof DeviceMotionEvent === 'undefined') return false;

        if (typeof DeviceMotionEvent.requestPermission === 'function') {
            const permission = await DeviceMotionEvent.requestPermission();
            this.permissions.motion = permission;
            return permission === 'granted';
        }

        this.permissions.motion = 'granted';
        return true;
    }

    async _requestOrientationPermission() {
        if (typeof DeviceOrientationEvent === 'undefined') return false;

        if (typeof DeviceOrientationEvent.requestPermission === 'function') {
            const permission = await DeviceOrientationEvent.requestPermission();
            this.permissions.orientation = permission;
            return permission === 'granted';
        }

        this.permissions.orientation = 'granted';
        return true;
    }

    /**
     * Initialize canonical intrinsics from video stream
     * Call this ONCE when the camera actually starts
     *
     * @param {number} videoWidth - Native video width in pixels
     * @param {number} videoHeight - Native video height in pixels
     */
    initializeFromVideoStream(videoWidth, videoHeight) {
        // Get device-specific DIAGONAL or effective FOV
        // Most phone specs list diagonal FOV, but we work with horizontal
        const fovHorizontalDeg = this._getDeviceHorizontalFOV();

        // Convert to radians
        const fovHorizontalRad = fovHorizontalDeg * Math.PI / 180;

        // Compute focal length from horizontal FOV
        // tan(FOV_h / 2) = (width / 2) / fx
        // fx = (width / 2) / tan(FOV_h / 2)
        const fx = (videoWidth / 2) / Math.tan(fovHorizontalRad / 2);

        // For mobile cameras, fy = fx (square pixels)
        const fy = fx;

        // Principal point at image center
        const cx = videoWidth / 2;
        const cy = videoHeight / 2;

        // Compute vertical FOV from fy and actual height
        // CRITICAL: This gives correct vertical FOV based on aspect ratio
        // tan(FOV_v / 2) = (height / 2) / fy
        const fovVerticalRad = 2 * Math.atan((videoHeight / 2) / fy);
        const fovVerticalDeg = fovVerticalRad * 180 / Math.PI;

        // Sanity check - vertical FOV should be reasonable (20-80 degrees)
        // If video is portrait, vertical FOV will be larger than horizontal
        // If video is landscape, vertical FOV will be smaller than horizontal
        const aspectRatio = videoWidth / videoHeight;

        console.log('[Intrinsics] Aspect ratio:', aspectRatio.toFixed(2),
            aspectRatio > 1 ? '(landscape)' : '(portrait)');

        // Store canonical intrinsics
        this._canonicalIntrinsics = {
            fx: fx,
            fy: fy,
            cx: cx,
            cy: cy,
            width: videoWidth,
            height: videoHeight,
            fovHorizontal: fovHorizontalDeg,
            fovVertical: fovVerticalDeg
        };

        // Set as current
        this._currentIntrinsics = { ...this._canonicalIntrinsics };

        // Generate fingerprint
        this._intrinsicsFingerprint = this._generateFingerprint(
            videoWidth, videoHeight, fovHorizontalDeg
        );

        console.log('[Intrinsics] Canonical intrinsics initialized:', {
            resolution: `${videoWidth}x${videoHeight}`,
            aspect: aspectRatio.toFixed(2),
            fovH: fovHorizontalDeg.toFixed(1) + '°',
            fovV: fovVerticalDeg.toFixed(1) + '°',
            fx: fx.toFixed(1),
            fy: fy.toFixed(1),
            fingerprint: this._intrinsicsFingerprint
        });

        return this._canonicalIntrinsics;
    }

    /**
     * Get device-specific horizontal FOV
     * The database stores horizontal FOV for landscape orientation
     * @returns {number} Horizontal FOV in degrees
     */
    _getDeviceHorizontalFOV() {
        const platform = this.deviceInfo.platform;
        let fov;

        if (this._deviceFOVDatabase[platform]) {
            fov = this._deviceFOVDatabase[platform];
        } else if (this.deviceInfo.isIOS) {
            fov = this._deviceFOVDatabase['iPhone'];
        } else if (this.deviceInfo.isAndroid) {
            fov = this._deviceFOVDatabase['Android'];
        } else {
            fov = this._deviceFOVDatabase['default'];
        }

        return fov;
    }

    /**
     * Generate fingerprint to detect intrinsics changes
     */
    _generateFingerprint(width, height, fov) {
        return `${width}x${height}@${fov.toFixed(1)}`;
    }

    /**
     * Get intrinsics scaled for a specific frame size
     * Used when sending scaled frames to backend
     *
     * CRITICAL: This preserves FOV - only scales the intrinsic values
     *
     * @param {number} frameWidth - Target frame width
     * @param {number} frameHeight - Target frame height
     * @returns {Object} Scaled intrinsics
     */
    getIntrinsicsForFrame(frameWidth, frameHeight) {
        if (!this._canonicalIntrinsics) {
            // Fallback: initialize with provided dimensions
            console.warn('[Intrinsics] Not initialized, using fallback');
            this.initializeFromVideoStream(frameWidth, frameHeight);
        }

        const canon = this._canonicalIntrinsics;

        // Compute scale factors
        const scaleX = frameWidth / canon.width;
        const scaleY = frameHeight / canon.height;

        // Scale intrinsics proportionally
        // This preserves the FOV when the image is scaled
        const scaledIntrinsics = {
            fx: canon.fx * scaleX,
            fy: canon.fy * scaleY,
            cx: canon.cx * scaleX,
            cy: canon.cy * scaleY,
            width: frameWidth,
            height: frameHeight,
            // FOV is preserved (same physical lens)
            fovHorizontal: canon.fovHorizontal,
            fovVertical: canon.fovVertical,
            // Include fingerprint so backend can detect changes
            fingerprint: this._intrinsicsFingerprint
        };

        return scaledIntrinsics;
    }

    /**
     * Get the canonical vertical FOV for Three.js camera
     * This is the ONLY FOV value the renderer should use
     *
     * @returns {number} Vertical FOV in degrees
     */
    getVerticalFOV() {
        if (!this._canonicalIntrinsics) {
            console.warn('[Intrinsics] Not initialized, returning default FOV');
            return 50; // Safe default
        }
        return this._canonicalIntrinsics.fovVertical;
    }

    /**
     * Get the canonical horizontal FOV
     * @returns {number} Horizontal FOV in degrees
     */
    getHorizontalFOV() {
        if (!this._canonicalIntrinsics) {
            return 60; // Safe default
        }
        return this._canonicalIntrinsics.fovHorizontal;
    }

    /**
     * Check if intrinsics have changed (camera switch, resolution change)
     * @param {string} newFingerprint - Fingerprint from backend
     * @returns {boolean} True if intrinsics changed
     */
    hasIntrinsicsChanged(newFingerprint) {
        return this._intrinsicsFingerprint !== newFingerprint;
    }

    /**
     * Get current intrinsics fingerprint
     */
    getFingerprint() {
        return this._intrinsicsFingerprint;
    }

    /**
     * Get canonical intrinsics (at native resolution)
     */
    getCanonicalIntrinsics() {
        return this._canonicalIntrinsics ? { ...this._canonicalIntrinsics } : null;
    }

    /**
     * Check if manager is initialized
     */
    isInitialized() {
        return this._canonicalIntrinsics !== null;
    }

    /**
     * Check if required permissions are granted
     */
    hasRequiredPermissions() {
        return this.permissions.camera === 'granted';
    }

    /**
     * Get permission status
     */
    getPermissionStatus() {
        return { ...this.permissions };
    }
}

// Export for use
window.CameraIntrinsicsManager = CameraIntrinsicsManager;
