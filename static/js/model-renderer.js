/**
 * Three.js 6DoF Model Renderer for WebAR
 *
 * SIMPLE ANCHORING APPROACH:
 * - Model is placed at the center of the detected target image
 * - Model sits ON TOP of the target (positive Z direction)
 * - Camera moves around the static model based on 6DoF pose
 *
 * SMOOTHING (single stage, owned here):
 * - The backend sends RAW poses at ~12Hz. This renderer interpolates toward
 *   the latest pose every render frame using a TIME-BASED alpha
 *   (alpha = 1 - exp(-dt/tau)), which is frame-rate independent.
 * - VISION-ONLY since 2026-07-04: motion sensors were removed entirely
 *   (measured cost: rotation error 2-3x higher during fast motion, position
 *   identical - see results/imu-value-rot). Translational dead-reckoning
 *   was removed even earlier: double-integrated phone accelerometer data in
 *   a mismatched reference frame added noise, not accuracy.
 *
 * COORDINATE SYSTEM:
 * - World origin: Center of target image
 * - X-axis: Right (positive)
 * - Y-axis: Up (positive)
 * - Z-axis: Out of target toward viewer (positive)
 * - Units: Meters
 */

class ModelRenderer {
    constructor(canvasId) {
        this.canvasId = canvasId || 'threeCanvas'
        this.canvas = null
        this.scene = null
        this.camera = null
        this.renderer = null

        // Model
        this.model = null
        this.modelLoaded = false

        // Model configuration - SIMPLE, no alignment tool needed
        this.modelConfig = {
            scale: 0.5,           // Model size in meters (50cm)
            standUpright: true    // Rotate model to stand on target plane
        }

        // Camera projection
        this.baseFov = 60          // Full-frame vertical FOV from intrinsics
        this.videoAspect = null    // Camera frame aspect (w/h), for cover-crop FOV
        this.fovLocked = false
        this.displayWidth = 0
        this.displayHeight = 0

        // Pose state - latest vision pose (target) and smoothed pose (last)
        this.targetPosition = null
        this.targetQuaternion = null
        this.lastPosition = null
        this.lastQuaternion = null
        this.lastDistance = null
        this.isTracking = false

        // Time-based smoothing constants (seconds). Smaller = more responsive.
        this.positionTau = 0.12
        this.rotationTau = 0.10

        // Dead reckoning: how long to coast after the last vision pose
        // (motion sensors removed 2026-07-04: vision-only smoothing)
        this.lastVisionTime = 0
        this.deadReckonLimit = 500 // ms

        // Dev map visualization (created only by enableMapViz)
        this.mapViz = null

        // Phase 2 fusion engine (set externally). When present it OWNS
        // smoothing, IMU prediction, latency compensation and loss handling;
        // the legacy paths below remain as the no-fusion fallback.
        this.fusion = null

        // Render clock
        this._lastRenderTime = 0

        // Debug
        this.debugMode = true
        this.debugObjects = {}

        this.init()
    }

    init() {
        this.canvas = document.getElementById(this.canvasId)
        if (!this.canvas) {
            console.error('[Renderer] Canvas not found:', this.canvasId)
            return
        }

        // Scene
        this.scene = new THREE.Scene()

        // Camera - will be positioned by pose updates
        this.camera = new THREE.PerspectiveCamera(this.baseFov, 1, 0.01, 100)
        this.camera.position.set(0, 0, 1)
        this.camera.lookAt(0, 0, 0)

        // Renderer
        this.renderer = new THREE.WebGLRenderer({
            canvas: this.canvas,
            alpha: true,
            antialias: true
        })
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
        this.renderer.setClearColor(0x000000, 0)
        this.renderer.outputEncoding = THREE.sRGBEncoding

        // Lighting - good for viewing from all angles
        this.setupLighting()

        // Debug visualization
        this.createDebugObjects()

        // Load the 3D model
        this.loadModel('/static/assets/ranger-3d-model.glb')

        // Initial resize
        this.resize()

        console.log('[Renderer] Initialized')
    }

    setupLighting() {
        // Ambient light for base illumination
        const ambient = new THREE.AmbientLight(0xffffff, 0.6)
        this.scene.add(ambient)

        // Main directional light (from above-front)
        const mainLight = new THREE.DirectionalLight(0xffffff, 0.8)
        mainLight.position.set(0, 2, 2)
        this.scene.add(mainLight)

        // Fill light (from below-back) to see underside
        const fillLight = new THREE.DirectionalLight(0xffffff, 0.4)
        fillLight.position.set(0, -1, -1)
        this.scene.add(fillLight)

        // Side lights for depth
        const leftLight = new THREE.DirectionalLight(0xffffff, 0.3)
        leftLight.position.set(-2, 1, 0)
        this.scene.add(leftLight)

        const rightLight = new THREE.DirectionalLight(0xffffff, 0.3)
        rightLight.position.set(2, 1, 0)
        this.scene.add(rightLight)
    }

    createDebugObjects() {
        // Target plane visualization (green wireframe at Z=0)
        const planeGeo = new THREE.PlaneGeometry(1, 1)
        const planeMat = new THREE.MeshBasicMaterial({
            color: 0x00ff00,
            wireframe: true,
            side: THREE.DoubleSide,
            transparent: true,
            opacity: 0.5
        })
        this.debugObjects.targetPlane = new THREE.Mesh(planeGeo, planeMat)
        this.debugObjects.targetPlane.visible = false
        this.scene.add(this.debugObjects.targetPlane)

        // Axes helper at world origin
        // Red = X (right), Green = Y (up), Blue = Z (toward camera)
        this.debugObjects.axes = new THREE.AxesHelper(0.2)
        this.debugObjects.axes.visible = false
        this.scene.add(this.debugObjects.axes)

        // Small sphere at origin to mark exact center
        const sphereGeo = new THREE.SphereGeometry(0.02, 16, 16)
        const sphereMat = new THREE.MeshBasicMaterial({ color: 0xff0000 })
        this.debugObjects.originMarker = new THREE.Mesh(sphereGeo, sphereMat)
        this.debugObjects.originMarker.visible = false
        this.scene.add(this.debugObjects.originMarker)
    }

    loadModel(url) {
        const loader = new THREE.GLTFLoader()

        loader.load(
            url,
            (gltf) => {
                this.model = gltf.scene

                // Calculate bounding box of original model
                const box = new THREE.Box3().setFromObject(this.model)
                const size = box.getSize(new THREE.Vector3())
                const center = box.getCenter(new THREE.Vector3())
                const minY = box.min.y  // Bottom of model

                // Find the largest dimension for scaling
                const maxDim = Math.max(size.x, size.y, size.z)
                const scaleFactor = this.modelConfig.scale / maxDim

                // STEP 1: Center model horizontally, but put feet at origin
                // Move so bottom of model (minY) is at Y=0
                this.model.position.set(-center.x, -minY, -center.z)

                // STEP 2: Create container for scaling
                this.modelContainer = new THREE.Group()
                this.modelContainer.add(this.model)

                // Apply scale
                this.modelContainer.scale.setScalar(scaleFactor)

                // STEP 3: Position model
                // In Three.js: target is in XY plane at Z=0
                // We want the model to stand ON the target (feet at Z=0, head at +Z)
                // So we rotate its Y-axis height to align with Three.js Z-axis
                this.modelContainer.rotation.x = Math.PI / 2

                // Move container to origin (center of target)
                this.modelContainer.position.set(0, 0, 0)

                // Initially hidden until tracking starts
                this.modelContainer.visible = false
                this.scene.add(this.modelContainer)

                this.modelLoaded = true

                console.log('[Renderer] Model loaded:',
                    'size:', size.x.toFixed(3), size.y.toFixed(3), size.z.toFixed(3),
                    '| scale:', scaleFactor.toFixed(4),
                    '| final height:', (size.y * scaleFactor).toFixed(3) + 'm'
                )
            },
            (progress) => {
                if (progress.total > 0) {
                    const pct = Math.round(progress.loaded / progress.total * 100)
                    if (pct % 25 === 0) console.log('[Renderer] Loading:', pct + '%')
                }
            },
            (error) => {
                console.error('[Renderer] Model load error:', error)
            }
        )
    }

    /**
     * Set camera FOV (and camera aspect) from intrinsics.
     * Called once at initialization.
     *
     * @param {Object} intrinsics - { fovVertical, videoWidth, videoHeight }
     */
    setIntrinsics(intrinsics) {
        if (!intrinsics || this.fovLocked) return

        if (intrinsics.fovVertical && intrinsics.fovVertical > 20 && intrinsics.fovVertical < 120) {
            this.baseFov = intrinsics.fovVertical
            this.fovLocked = true
        }

        if (intrinsics.videoWidth && intrinsics.videoHeight) {
            this.videoAspect = intrinsics.videoWidth / intrinsics.videoHeight
        }

        this._updateProjection()
        console.log('[Renderer] FOV set:', this.baseFov.toFixed(1) + '°',
            'videoAspect:', this.videoAspect ? this.videoAspect.toFixed(3) : 'n/a')
    }

    /**
     * Update display size
     */
    resize(width, height) {
        if (!this.renderer || !this.canvas) return

        if (!width || !height) {
            const rect = this.canvas.parentElement?.getBoundingClientRect()
            width = rect?.width || window.innerWidth
            height = rect?.height || window.innerHeight
        }

        this.renderer.setSize(width, height, false)
        this.canvas.style.width = width + 'px'
        this.canvas.style.height = height + 'px'

        this.displayWidth = width
        this.displayHeight = height
        this._updateProjection()
    }

    /**
     * Recompute the projection for the current display size.
     *
     * The video is displayed with object-fit: cover, which CROPS the camera
     * frame to the screen aspect. The pose was solved against the FULL frame,
     * so we must render with the FOV of the visible crop, not the full frame:
     * - display wider than video  -> vertical crop  -> effective vFOV shrinks
     * - display narrower than video -> horizontal crop -> vFOV unchanged
     *   (the aspect handles the horizontal trim)
     */
    _updateProjection() {
        if (!this.camera || !this.displayWidth || !this.displayHeight) return

        const displayAspect = this.displayWidth / this.displayHeight
        let fov = this.baseFov

        if (this.videoAspect && displayAspect > this.videoAspect) {
            const t = Math.tan(this.baseFov * Math.PI / 360) * (this.videoAspect / displayAspect)
            fov = Math.atan(t) * 360 / Math.PI
        }

        this.camera.fov = fov
        this.camera.aspect = displayAspect
        this.camera.updateProjectionMatrix()
    }

    /**
     * Receive a new vision pose from the backend (~12Hz).
     *
     * Only RECORDS the pose; the actual camera motion happens in render()
     * where it is smoothed at display rate. Loss-of-tracking is also handled
     * in render() (dead-reckon window), NOT here - the old code hid the model
     * on every missed frame which caused flicker and fought the dead-reckoner.
     */
    updatePose(pose) {
        if (this.fusion) {
            this.fusion.pushVisionPose(pose)
            return
        }
        if (!pose || !pose.matrix) return

        const m = pose.matrix

        // Validate matrix
        if (!Array.isArray(m) || m.length !== 16 || m.some(v => !isFinite(v))) {
            console.warn('[Renderer] Invalid pose matrix')
            return
        }

        // Create matrix from column-major array
        const matrix = new THREE.Matrix4()
        matrix.fromArray(m)

        // Decompose to get position and rotation
        const position = new THREE.Vector3()
        const quaternion = new THREE.Quaternion()
        const scale = new THREE.Vector3()
        matrix.decompose(position, quaternion, scale)

        // Sanity check
        const distance = position.length()
        if (distance > 10 || distance < 0.1) {
            return  // Ignore invalid poses, keep last state
        }

        // Initialize smoothed pose on (re)acquisition - snap, don't glide in
        if (!this.lastPosition) {
            this.lastPosition = position.clone()
            this.lastQuaternion = quaternion.clone()
            this.targetPosition = position.clone()
            this.targetQuaternion = quaternion.clone()
            console.log('[Renderer] Initial pose set at distance:', distance.toFixed(2) + 'm')
        }

        // Store target pose from vision
        this.targetPosition.copy(position)
        this.targetQuaternion.copy(quaternion)
        this.lastDistance = distance

        this.lastVisionTime = performance.now()
        this.isTracking = true
        this.show()
    }

    /**
     * Notify that a frame produced no detection.
     * Intentionally light: the dead-reckon window in render() decides when
     * the model actually disappears, so brief misses don't flicker.
     */
    notifyLost() {
        if (this.fusion) {
            this.fusion.notifyMiss()
            return
        }
        if (!this.isTracking) this.hide()
    }

    /**
     * Connect the Phase 2 fusion engine (takes over pose filtering)
     */
    setFusionEngine(fusion) {
        this.fusion = fusion
        console.log('[Renderer] Fusion engine connected')
    }

    /**
     * DEV-ONLY map visualization: SLAM point cloud + camera trail, in the
     * same world frame as the model (so dots stick to the real surfaces
     * they were triangulated on). Nothing is allocated unless enabled.
     */
    enableMapViz() {
        if (this.mapViz) return
        const MAX = 400
        const geo = new THREE.BufferGeometry()
        geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAX * 3), 3))
        geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(MAX * 3), 3))
        geo.setDrawRange(0, 0)
        const pts = new THREE.Points(geo, new THREE.PointsMaterial({
            size: 0.03, vertexColors: true, sizeAttenuation: true,
            depthTest: false, transparent: true, opacity: 0.95
        }))
        pts.frustumCulled = false
        this.scene.add(pts)

        // Trail as SEGMENTS, not a continuous line: tracking loss, reacquire
        // snaps and drift corrections teleport the camera, and a continuous
        // polyline draws a bogus straight connector across every one of them.
        const TRAIL = 600
        const tgeo = new THREE.BufferGeometry()
        tgeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(TRAIL * 6), 3))
        tgeo.setDrawRange(0, 0)
        const trail = new THREE.LineSegments(tgeo, new THREE.LineBasicMaterial({
            color: 0x00ccff, transparent: true, opacity: 0.7, depthTest: false
        }))
        trail.frustumCulled = false
        this.scene.add(trail)

        this.mapViz = {
            pts, geo, trail, tgeo, trailN: 0, trailMax: TRAIL, tick: 0,
            lastTrail: null,
            trailMinMove: 0.012,  // below this = pose jitter, don't scribble
            trailMaxJump: 0.35    // above this = discontinuity, pen up
        }
        console.log('[Renderer] Map visualization enabled (dev)')
    }

    /**
     * Feed worker mapViz payload (CV world coords).
     * Stride 8: [x,y,z, kind, residualPx, sigmaZ, obs, baseline] - quality-
     * coded coloring. Legacy stride 4 ([x,y,z,kind]) still accepted.
     */
    updateMapViz(viz) {
        if (!this.mapViz || !viz || !viz.pts) return
        const s = viz.stride || 4
        const pos = this.mapViz.geo.attributes.position.array
        const col = this.mapViz.geo.attributes.color.array
        const n = Math.min(viz.pts.length / s, pos.length / 3)
        for (let i = 0; i < n; i++) {
            // CV world (Y down, Z away) -> GL world (Y up, Z toward viewer)
            pos[i * 3] = viz.pts[i * s]
            pos[i * 3 + 1] = -viz.pts[i * s + 1]
            pos[i * 3 + 2] = -viz.pts[i * s + 2]
            const tracked = viz.pts[i * s + 3] > 0.5
            if (!tracked) {                         // dormant: amber
                col[i * 3] = 1.0; col[i * 3 + 1] = 0.65; col[i * 3 + 2] = 0.1
            } else if (s >= 8 && viz.pts[i * s + 4] >= 0) {
                // tracked: green (residual ~0) -> yellow -> red (>= 4px)
                const t = Math.min(1, viz.pts[i * s + 4] / 4)
                col[i * 3] = 0.1 + 0.9 * t
                col[i * 3 + 1] = 1.0 - 0.7 * t
                col[i * 3 + 2] = 0.15
            } else {                                // tracked, no residual info
                col[i * 3] = 0.1; col[i * 3 + 1] = 1.0; col[i * 3 + 2] = 0.35
            }
        }
        this.mapViz.geo.attributes.position.needsUpdate = true
        this.mapViz.geo.attributes.color.needsUpdate = true
        this.mapViz.geo.setDrawRange(0, n)
    }

    _updateTrail() {
        const v = this.mapViz
        if (!v || (++v.tick % 6) !== 0) return
        const p = this.camera.position
        if (!v.lastTrail) { v.lastTrail = p.clone(); return }

        const d = p.distanceTo(v.lastTrail)
        // Stationary: the pose noise floor produces cm-scale jitter at 10Hz.
        // Keep the anchor where it is so slow real motion still accumulates
        // past the threshold, but draw nothing.
        if (d < v.trailMinMove) return

        if (d < v.trailMaxJump) {
            const arr = v.tgeo.attributes.position.array
            if (v.trailN >= v.trailMax) {
                arr.copyWithin(0, 6)
                v.trailN = v.trailMax - 1
            }
            const o = v.trailN * 6
            arr[o] = v.lastTrail.x; arr[o + 1] = v.lastTrail.y; arr[o + 2] = v.lastTrail.z
            arr[o + 3] = p.x; arr[o + 4] = p.y; arr[o + 5] = p.z
            v.trailN++
            v.tgeo.attributes.position.needsUpdate = true
            v.tgeo.setDrawRange(0, v.trailN * 2)
        }
        // d >= trailMaxJump: teleport (loss/reacquire/drift snap) - pen up,
        // no segment; just move the anchor to the new position.
        v.lastTrail.copy(p)
    }

    /**
     * Match the debug plane to the target's physical size (meters).
     * The plane is a unit square; without this it misrepresents any
     * non-square target as "misaligned".
     */
    setTargetSize(widthM, heightM) {
        if (this.debugObjects.targetPlane && widthM > 0 && heightM > 0) {
            this.debugObjects.targetPlane.scale.set(widthM, heightM, 1)
            console.log('[Renderer] Target plane sized:', widthM.toFixed(3) + 'x' + heightM.toFixed(3) + 'm')
        }
    }

    /**
     * Full pose/smoothing reset (also used when the dead-reckon window expires)
     */
    resetPose() {
        if (this.fusion) this.fusion.reset()
        this.targetPosition = null
        this.targetQuaternion = null
        this.lastPosition = null
        this.lastQuaternion = null
        this.lastDistance = null
        this.isTracking = false
        console.log('[Renderer] Pose reset')
    }

    show() {
        if (this.modelContainer) this.modelContainer.visible = true
        if (this.debugMode) {
            this.debugObjects.targetPlane.visible = true
            this.debugObjects.axes.visible = true
            this.debugObjects.originMarker.visible = true
        }
    }

    hide() {
        if (this.modelContainer) this.modelContainer.visible = false
        this.debugObjects.targetPlane.visible = false
        this.debugObjects.axes.visible = false
        this.debugObjects.originMarker.visible = false
    }

    render() {
        if (!this.renderer || !this.scene || !this.camera) return

        // Fusion path: the engine propagates IMU + velocity and absorbs
        // vision corrections internally; we just apply its state.
        if (this.fusion) {
            const st = this.fusion.getRenderPose(performance.now())
            if (st.tracking) {
                this.camera.position.set(st.position.x, st.position.y, st.position.z)
                this.camera.quaternion.set(st.quaternion.x, st.quaternion.y, st.quaternion.z, st.quaternion.w)
                this.lastDistance = this.camera.position.length()
                if (this.mapViz) this._updateTrail()
                this.show()
            } else {
                this.hide()
            }
            this.renderer.render(this.scene, this.camera)
            return
        }

        const now = performance.now()
        const dt = this._lastRenderTime ? Math.min((now - this._lastRenderTime) / 1000, 0.1) : 0
        this._lastRenderTime = now

        if (this.isTracking) {
            const sinceVision = now - this.lastVisionTime

            if (sinceVision > this.deadReckonLimit) {
                // Vision has been gone too long - actually lose tracking
                this.hide()
                this.resetPose()
            } else if (this.lastPosition && this.targetPosition) {
                // Time-based smoothing toward the latest vision pose
                // (frame-rate independent: alpha = 1 - exp(-dt/tau))
                const aPos = 1 - Math.exp(-dt / this.positionTau)
                const aRot = 1 - Math.exp(-dt / this.rotationTau)
                this.lastPosition.lerp(this.targetPosition, aPos)
                this.lastQuaternion.slerp(this.targetQuaternion, aRot)

                this.camera.position.copy(this.lastPosition)
                this.camera.quaternion.copy(this.lastQuaternion)
                this.lastDistance = this.lastPosition.length()
            }
        }

        this.renderer.render(this.scene, this.camera)
    }

    setDebug(enabled) {
        this.debugMode = enabled
        if (!enabled) {
            this.debugObjects.targetPlane.visible = false
            this.debugObjects.axes.visible = false
            this.debugObjects.originMarker.visible = false
        }
    }

    /**
     * Adjust model size (in meters)
     */
    setModelScale(sizeInMeters) {
        this.modelConfig.scale = sizeInMeters
        // Would need to reload model to apply - or recalculate on existing
        console.log('[Renderer] Model scale set to:', sizeInMeters + 'm')
    }

    getFOV() {
        return this.camera ? this.camera.fov : this.baseFov
    }
}

// Export
window.ModelRenderer = ModelRenderer
