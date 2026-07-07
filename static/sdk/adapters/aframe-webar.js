/**
 * WebAR SDK - A-Frame adapter
 *
 * Declarative AR image tracking for A-Frame scenes:
 *
 *   <a-scene webar="targets: /static/assets/poster.webart, /static/assets/poster.jpg"
 *            renderer="alpha: true" vr-mode-ui="enabled: false">
 *     <a-entity webar-target>
 *       <a-box position="0 0 0.1" scale="0.2 0.2 0.2" color="#4CC3D9"></a-box>
 *     </a-entity>
 *     <a-entity camera look-controls="enabled: false"></a-entity>
 *   </a-scene>
 *
 * The system boots the vision engine immediately (WASM + target load) and
 * starts the camera on `sceneEl.systems.webar.startCamera()` - call it from
 * a user gesture (required for getUserMedia/IMU permissions on mobile).
 *
 * Coordinate convention matches the SDK: world origin at the target center,
 * X right, Y up, Z out of the target toward the viewer, meters.
 *
 * Load order: aframe.js, fusion.js, webar-sdk.js, then this file.
 * Optional: camera-intrinsics.js (FOV).
 */

/* global AFRAME, WebARSDK, FusionEngine, THREE */

if (typeof AFRAME === 'undefined') {
    throw new Error('aframe-webar: AFRAME must be loaded first')
}

AFRAME.registerSystem('webar', {
    schema: {
        targets: { type: 'array', default: [] },     // candidate URLs (.webart first)
        maxDimension: { type: 'number', default: 480 },
        videoElementId: { type: 'string', default: '' } // use an existing <video> if given
    },

    init: function () {
        this.targetEntities = []
        this.tracking = false
        this.engineReady = false
        this.cameraStarted = false

        this._setupVideo()

        // Optional managers (graceful if their scripts are not loaded)
        this.intrinsics = (typeof CameraIntrinsicsManager !== 'undefined')
            ? new CameraIntrinsicsManager() : null

        // Vision-only fusion (motion sensors removed 2026-07-04)
        this.fusion = new FusionEngine()

        this.sdk = new WebARSDK({
            video: this.video,
            targetUrl: this.data.targets.length ? this.data.targets : null,
            intrinsicsProvider: this.intrinsics,
            maxDimension: this.data.maxDimension
        })

        this.sdk.on('framesent', ({ id, timestamp }) => {
            // capture-time snapshot drives the fusion latency compensation
            this.fusion.saveSnapshot(id, null, timestamp || performance.now())
        })
        this.sdk.on('result', (data) => {
            if (data.detected && data.pose) this.fusion.pushVisionPose(data.pose)
        })
        this.sdk.on('error', (e) => this.el.emit('webar-error', { error: e }))

        // Boot the engine now (no camera needed yet - pump no-ops until video runs)
        this.sdk.start().then((info) => {
            this.engineReady = true
            this.el.emit('webar-ready', info)
        }).catch((e) => this.el.emit('webar-error', { error: e }))

        // Make the scene canvas transparent over the video
        this.el.addEventListener('loaded', () => {
            this.el.renderer.setClearColor(0x000000, 0)
        })
    },

    _setupVideo: function () {
        if (this.data.videoElementId) {
            this.video = document.getElementById(this.data.videoElementId)
            return
        }
        const v = document.createElement('video')
        v.setAttribute('autoplay', '')
        v.setAttribute('playsinline', '')
        v.setAttribute('muted', '')
        v.muted = true
        Object.assign(v.style, {
            position: 'absolute', top: '0', left: '0',
            width: '100%', height: '100%',
            objectFit: 'cover', zIndex: '-1'
        })
        document.body.insertBefore(v, document.body.firstChild)
        this.video = v
    },

    /** Start the camera. MUST be called from a user gesture on mobile. */
    startCamera: async function () {
        if (this.cameraStarted) return

        const stream = await navigator.mediaDevices.getUserMedia({
            video: {
                facingMode: { ideal: 'environment' },
                width: { ideal: 1280 }, height: { ideal: 720 }
            },
            audio: false
        })
        this.video.srcObject = stream
        await new Promise((res) => {
            if (this.video.videoWidth > 0) res()
            else this.video.addEventListener('loadedmetadata', res, { once: true })
        })
        await this.video.play()

        // Lock FOV from intrinsics (orientation-correct long-side anchoring)
        if (this.intrinsics) {
            this.intrinsics.initializeFromVideoStream(this.video.videoWidth, this.video.videoHeight)
            this._baseFov = this.intrinsics.getVerticalFOV()
        } else {
            this._baseFov = 60
        }
        this._videoAspect = this.video.videoWidth / this.video.videoHeight
        this._applyProjection()
        window.addEventListener('resize', () => this._applyProjection())

        this.cameraStarted = true
        this.el.emit('webar-camera-started', {
            width: this.video.videoWidth, height: this.video.videoHeight
        })
    },

    /** Effective FOV for the object-fit: cover crop (same math as ModelRenderer). */
    _applyProjection: function () {
        const cam = this.el.camera
        if (!cam) return
        const displayAspect = window.innerWidth / window.innerHeight
        let fov = this._baseFov
        if (this._videoAspect && displayAspect > this._videoAspect) {
            const t = Math.tan(this._baseFov * Math.PI / 360) * (this._videoAspect / displayAspect)
            fov = Math.atan(t) * 360 / Math.PI
        }
        cam.fov = fov
        cam.aspect = displayAspect
        cam.updateProjectionMatrix()
    },

    registerTarget: function (component) {
        this.targetEntities.push(component)
    },
    unregisterTarget: function (component) {
        this.targetEntities = this.targetEntities.filter(c => c !== component)
    },

    tick: function () {
        if (!this.engineReady) return
        const st = this.fusion.getRenderPose(performance.now())

        const cam = this.el.camera
        if (st.tracking && cam) {
            const o = cam.el ? cam.el.object3D : cam
            o.position.set(st.position.x, st.position.y, st.position.z)
            o.quaternion.set(st.quaternion.x, st.quaternion.y, st.quaternion.z, st.quaternion.w)
        }

        if (st.tracking !== this.tracking) {
            this.tracking = st.tracking
            for (const t of this.targetEntities) t.setTracking(st.tracking)
            this.el.emit(st.tracking ? 'webar-target-found' : 'webar-target-lost')
        }
    }
})

AFRAME.registerComponent('webar-target', {
    init: function () {
        this.el.object3D.visible = false
        this.system = this.el.sceneEl.systems.webar
        if (this.system) this.system.registerTarget(this)
    },
    remove: function () {
        if (this.system) this.system.unregisterTarget(this)
    },
    setTracking: function (tracking) {
        this.el.object3D.visible = tracking
        this.el.emit(tracking ? 'targetFound' : 'targetLost')
    }
})
