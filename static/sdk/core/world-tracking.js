/**
 * WebAR SDK - World Tracking (Phase 4)
 *
 * Unified capability detection + backend selection for world tracking:
 *
 *   WebXRBackend      - Android Chrome etc.: immersive-ar sessions backed by
 *                       ARCore VIO. True markerless 6DoF world tracking,
 *                       plane hit-testing, and (behind chrome://flags/
 *                       #webxr-incubations) native image tracking that
 *                       anchors content to OUR compiled target inside the
 *                       ARCore world.
 *   ImageTargetBackend- everywhere else (notably iOS Safari): the SDK's own
 *                       vision pipeline + fusion. World = the image target.
 *
 * ARCHITECTURE NOTE: the two backends are inverse. The SDK moves the CAMERA
 * around a fixed target; WebXR drives the camera from ARCore and CONTENT is
 * placed in world space. Consumers should branch on `backend.kind`.
 *
 * Rendering-agnostic: this module owns capabilities, session lifecycle and
 * per-frame data extraction. The demo (examples/webxr.html) wires Three.js.
 */

const WorldTracking = {
    /**
     * Probe what this browser/device can do. Safe everywhere.
     * @returns {Promise<{webxr, immersiveAr, hitTest, domOverlay, imageTracking, reason}>}
     */
    async detectCapabilities() {
        const caps = {
            webxr: false,
            immersiveAr: false,
            hitTest: false,
            domOverlay: false,
            imageTracking: false,
            reason: ''
        }

        if (typeof navigator === 'undefined' || !navigator.xr) {
            caps.reason = 'navigator.xr not available (browser has no WebXR)'
            return caps
        }
        caps.webxr = true

        try {
            caps.immersiveAr = await navigator.xr.isSessionSupported('immersive-ar')
        } catch (e) {
            caps.reason = 'isSessionSupported failed: ' + e.message
            return caps
        }
        if (!caps.immersiveAr) {
            caps.reason = 'immersive-ar not supported (no ARCore/ARKit bridge)'
            return caps
        }

        // Feature support is only truly knowable at requestSession time;
        // these reflect API surface presence.
        caps.hitTest = typeof XRSession !== 'undefined' &&
            'requestHitTestSource' in XRSession.prototype
        caps.domOverlay = typeof XRSession !== 'undefined' &&
            ('domOverlayState' in XRSession.prototype)
        caps.imageTracking = typeof XRSession !== 'undefined' &&
            'getTrackedImageScores' in XRSession.prototype

        return caps
    },

    /**
     * Pick the best backend. 'webxr' | 'image-target' | explicit preference.
     */
    async selectBackend(preference) {
        const caps = await this.detectCapabilities()
        if (preference === 'image-target') return { kind: 'image-target', caps }
        if (preference === 'webxr' && !caps.immersiveAr) {
            return { kind: 'unavailable', caps }
        }
        return { kind: caps.immersiveAr ? 'webxr' : 'image-target', caps }
    }
}

/**
 * WebXR immersive-ar session wrapper.
 *
 * Usage:
 *   const xr = new WebXRBackend({
 *       trackedImage: { bitmap, widthInMeters },   // optional
 *       domOverlayRoot: document.getElementById('hud')  // optional
 *   })
 *   const session = await xr.start(renderer)  // three.js WebGLRenderer
 *   // per frame (three setAnimationLoop): xr.processFrame(frame)
 */
class WebXRBackend {
    constructor(options) {
        options = options || {}
        this.kind = 'webxr'
        this.session = null
        this.refSpace = null
        this.viewerSpace = null
        this.hitTestSource = null
        this.trackedImage = options.trackedImage || null
        this.domOverlayRoot = options.domOverlayRoot || null

        this.imageTrackingActive = false
        this.lastImagePose = null      // {matrix: Float32Array(16), emulated, measuredWidthInMeters}
        this.lastHit = null            // Float32Array(16) | null

        this._listeners = {}
    }

    on(event, fn) {
        (this._listeners[event] = this._listeners[event] || []).push(fn)
        return this
    }
    _emit(event, data) {
        const l = this._listeners[event]
        if (l) for (const fn of l) fn(data)
    }

    /** Build the requestSession init dict based on what we were given. */
    buildSessionInit() {
        const init = {
            requiredFeatures: ['local', 'hit-test'],
            optionalFeatures: []
        }
        if (this.domOverlayRoot) {
            init.optionalFeatures.push('dom-overlay')
            init.domOverlay = { root: this.domOverlayRoot }
        }
        if (this.trackedImage && this.trackedImage.bitmap) {
            // Chrome incubation: anchors content to our image target inside
            // the ARCore world. Optional so sessions still start without it.
            init.optionalFeatures.push('image-tracking')
            init.trackedImages = [{
                image: this.trackedImage.bitmap,
                widthInMeters: this.trackedImage.widthInMeters || 0.3
            }]
        }
        return init
    }

    /**
     * Request the session and (if given) attach it to a three.js renderer.
     */
    async start(renderer) {
        if (!navigator.xr) throw new Error('WebXR not available')

        this.session = await navigator.xr.requestSession('immersive-ar', this.buildSessionInit())

        if (renderer) {
            renderer.xr.enabled = true
            // ARCore renders the camera feed beneath the WebGL layer
            await renderer.xr.setReferenceSpaceType('local')
            await renderer.xr.setSession(this.session)
        }

        this.refSpace = renderer
            ? renderer.xr.getReferenceSpace()
            : await this.session.requestReferenceSpace('local')
        this.viewerSpace = await this.session.requestReferenceSpace('viewer')

        // Hit-test from the viewer ray (center of screen reticle pattern)
        if (this.session.requestHitTestSource) {
            try {
                this.hitTestSource = await this.session.requestHitTestSource({ space: this.viewerSpace })
            } catch (e) {
                this.hitTestSource = null
            }
        }

        // Image tracking actually granted?
        this.imageTrackingActive = typeof this.session.getTrackedImageScores === 'function' &&
            this.trackedImage != null
        if (this.imageTrackingActive) {
            try {
                const scores = await this.session.getTrackedImageScores()
                this._emit('imagescores', scores)
                if (scores && scores[0] === 'untrackable') {
                    this._emit('warning', 'Target image scored untrackable by ARCore')
                }
            } catch (e) {
                this.imageTrackingActive = false
            }
        }

        this.session.addEventListener('end', () => {
            this.session = null
            this._emit('end')
        })

        this._emit('started', {
            imageTracking: this.imageTrackingActive,
            domOverlay: !!(this.session.domOverlayState)
        })
        return this.session
    }

    /**
     * Extract per-frame data. Call inside the XR animation loop with the
     * XRFrame. Returns {hitMatrix, imagePose} (either may be null).
     */
    processFrame(frame) {
        if (!frame || !this.refSpace) return { hitMatrix: null, imagePose: null }

        // 1. Hit test (plane placement)
        this.lastHit = null
        if (this.hitTestSource) {
            const hits = frame.getHitTestResults(this.hitTestSource)
            if (hits.length) {
                const pose = hits[0].getPose(this.refSpace)
                if (pose) this.lastHit = pose.transform.matrix
            }
        }

        // 2. Native image tracking (incubation)
        this.lastImagePose = null
        if (this.imageTrackingActive && typeof frame.getImageTrackingResults === 'function') {
            const results = frame.getImageTrackingResults()
            for (const r of results) {
                if (r.trackingState === 'tracked' || r.trackingState === 'emulated') {
                    const pose = frame.getPose(r.imageSpace, this.refSpace)
                    if (pose) {
                        this.lastImagePose = {
                            matrix: pose.transform.matrix,
                            emulated: r.trackingState === 'emulated',
                            measuredWidthInMeters: r.measuredWidthInMeters
                        }
                        this._emit('imagepose', this.lastImagePose)
                    }
                    break
                }
            }
        }

        return { hitMatrix: this.lastHit, imagePose: this.lastImagePose }
    }

    async stop() {
        if (this.hitTestSource) {
            this.hitTestSource.cancel && this.hitTestSource.cancel()
            this.hitTestSource = null
        }
        if (this.session) {
            await this.session.end()
            this.session = null
        }
    }
}

// Exports: browser global + Node (test harness)
if (typeof window !== 'undefined') {
    window.WorldTracking = WorldTracking
    window.WebXRBackend = WebXRBackend
}
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { WorldTracking, WebXRBackend }
}
