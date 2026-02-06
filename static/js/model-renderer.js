/**
 * Three.js 6DoF Model Renderer for WebAR
 *
 * SIMPLE ANCHORING APPROACH:
 * - Model is placed at the center of the detected target image
 * - Model sits ON TOP of the target (positive Z direction)
 * - Model is normalized to fit within 0.3 meters (30cm)
 * - Camera moves around the static model based on 6DoF pose
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

        // Camera
        this.fov = 60
        this.fovLocked = false

        // Pose state - for smoothing
        this.lastPosition = null
        this.lastQuaternion = null
        this.lastDistance = null
        this.isTracking = false

        // IMU Baseline - for inter-frame prediction
        this.imuOrientationBase = null
        this.imuPredictionEnabled = false
        this.imuHistory = new Map() // ID -> Quaternion

        // Dead Reckoning state
        this.lastVisionTime = 0
        this.deadReckonLimit = 500 // ms to continue rotation without vision

        // World-lock behavior (no IMU-driven camera prediction)
        this.worldLockEnabled = true

        // IMU manager reference (set externally)
        this.imuManager = null

        // Anchor + snap settings for faster repositioning
        this.anchorEnabled = true
        this.anchorPosition = null
        this.anchorQuaternion = null
        this.anchorConfidenceMin = 0.6
        this.anchorSnapDistance = 0.15 // meters
        this.anchorSnapAngle = THREE.MathUtils.degToRad(8)

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
        this.camera = new THREE.PerspectiveCamera(this.fov, 1, 0.01, 100)
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
     * Set camera FOV from intrinsics
     * Called once at initialization
     */
    setIntrinsics(intrinsics) {
        if (!intrinsics || this.fovLocked) return

        if (intrinsics.fovVertical && intrinsics.fovVertical > 20 && intrinsics.fovVertical < 120) {
            this.fov = intrinsics.fovVertical
            this.camera.fov = this.fov
            this.camera.updateProjectionMatrix()
            this.fovLocked = true
            console.log('[Renderer] FOV set:', this.fov.toFixed(1) + '°')
        }
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

        this.camera.aspect = width / height
        this.camera.updateProjectionMatrix()
    }

    /**
     * Update camera pose from backend
     *
     * WORLD-ANCHORED APPROACH:
     * - Model is fixed at world origin (on target image)
     * - Camera moves according to 6DoF pose from vision
     * - IMU data is used to enhance rotation smoothing
     * - Heavy smoothing prevents jitter while maintaining responsiveness
     */
    updatePose(pose) {
        if (!pose || !pose.matrix) {
            this.hide()
            this.isTracking = false
            return
        }

        const m = pose.matrix

        // Validate matrix
        if (!Array.isArray(m) || m.length !== 16 || m.some(v => !isFinite(v))) {
            console.warn('[Renderer] Invalid pose matrix')
            this.hide()
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

        // Get distance from origin
        const distance = position.length()

        // Sanity check
        if (distance > 10 || distance < 0.1) {
            return  // Ignore invalid poses, keep last state
        }

        // Initialize smoothed values on first detection
        if (!this.lastPosition) {
            this.lastPosition = position.clone()
            this.lastQuaternion = quaternion.clone()
            this.lastDistance = distance
            this.targetPosition = position.clone()
            this.targetQuaternion = quaternion.clone()
            console.log('[Renderer] Initial pose set at distance:', distance.toFixed(2) + 'm')
        }

        // Store target pose from vision
        this.targetPosition.copy(position)
        this.targetQuaternion.copy(quaternion)

        // SYNC: Retrieve the exact IMU state when this frame was captured
        if (pose.id && this.imuHistory.has(pose.id)) {
            const histIMU = this.imuHistory.get(pose.id)
            this.imuOrientationBase = new THREE.Quaternion(
                histIMU.x, histIMU.y, histIMU.z, histIMU.w
            )
            // Cleanup history up to this ID
            for (let key of this.imuHistory.keys()) {
                if (key <= pose.id) this.imuHistory.delete(key)
                else break
            }
        } else if (this.imuManager && this.imuManager.isActive) {
            // Fallback: use current IMU if ID sync fails
            const quat = this.imuManager.rawQuaternion || this.imuManager.quaternion
            this.imuOrientationBase = new THREE.Quaternion(
                quat.x, quat.y, quat.z, quat.w
            )
        }

        // ADAPTIVE SMOOTHING - increased for Frame-IMU Sync
        // We rely on 60 FPS IMU prediction for smoothness, so we can
        // apply vision corrections almost instantly (0.8 alpha).
        let positionAlpha = 0.8
        let rotationAlpha = 0.8

        // Anchor: snap quickly when pose jumps significantly with good confidence.
        if (this.anchorEnabled) {
            if (!this.anchorPosition) {
                this.anchorPosition = position.clone()
                this.anchorQuaternion = quaternion.clone()
            } else {
                const positionDelta = this.anchorPosition.distanceTo(position)
                const angleDelta = this.anchorQuaternion.angleTo(quaternion)
                const hasConfidence = typeof pose.confidence === 'number'
                    ? pose.confidence >= this.anchorConfidenceMin
                    : true

                if (hasConfidence && (positionDelta > this.anchorSnapDistance || angleDelta > this.anchorSnapAngle)) {
                    this.anchorPosition.copy(position)
                    this.anchorQuaternion.copy(quaternion)
                    positionAlpha = 0.95
                    rotationAlpha = 0.9
                }
            }
        }

        // If IMU is active and tracking, adjust smoothing based on device stability
        if (this.imuManager && this.imuManager.isActive && this.imuManager.hasReference) {
            const rotationMagnitude = this.imuManager.getRotationMagnitude()

            // If device is moving a lot (IMU shows rotation), be more responsive
            // If device is stable, apply heavier smoothing
            if (rotationMagnitude > 10) {
                // Device is rotating significantly - be more responsive
                positionAlpha = 0.25
                rotationAlpha = 0.20
            } else if (rotationMagnitude < 3) {
                // Device is very stable - heavy smoothing for stability
                positionAlpha = 0.08
                rotationAlpha = 0.06
            }
        }

        // Increase responsiveness when position drift is large.
        if (this.lastPosition) {
            const positionError = this.lastPosition.distanceTo(this.targetPosition)
            if (positionError > 0.05) {
                positionAlpha = Math.min(0.9, Math.max(positionAlpha, positionError * 2))
            }
        }

        // Increase responsiveness when rotation drift is large.
        if (this.lastQuaternion) {
            const rotationError = this.lastQuaternion.angleTo(this.targetQuaternion)
            if (rotationError > 0.08) {
                rotationAlpha = Math.min(0.9, Math.max(rotationAlpha, rotationError * 1.5))
            }
        }

        // Smooth position
        this.lastPosition.lerp(this.targetPosition, positionAlpha)

        // Smooth rotation using slerp
        this.lastQuaternion.slerp(this.targetQuaternion, rotationAlpha)

        // Apply smoothed pose to camera
        this.camera.position.copy(this.lastPosition)
        this.camera.quaternion.copy(this.lastQuaternion)

        // Update distance for display
        this.lastDistance = this.lastPosition.length()

        // Sync last vision time
        this.lastVisionTime = performance.now()

        // Mark as tracking
        this.isTracking = true

        // Show model and debug objects
        this.show()

        // RESET INERTIAL STATE
        if (this.imuManager) {
            this.imuManager.resetInertialState()
        }
    }

    /**
     * Set IMU manager reference for sensor fusion
     */
    setIMUManager(imuManager) {
        this.imuManager = imuManager
        console.log('[Renderer] IMU manager connected')
    }

    /**
     * Store IMU state for a frame being sent (synchronization)
     */
    saveIMUBaseline(id, quat) {
        if (!this.imuHistory) this.imuHistory = new Map()

        // Use raw quaternion if available for zero-lag prediction baseline
        this.imuHistory.set(id, { ...quat })

        // Safety cap on history size
        if (this.imuHistory.size > 100) {
            const firstKey = this.imuHistory.keys().next().value
            this.imuHistory.delete(firstKey)
        }
    }

    /**
     * Reset pose smoothing (call when tracking is lost/regained)
     */
    resetPose() {
        this.lastPosition = null
        this.lastQuaternion = null
        this.lastDistance = null
        this.targetPosition = null
        this.targetQuaternion = null
        this.anchorPosition = null
        this.anchorQuaternion = null
        this.imuHistory.clear()
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

        const now = performance.now()
        const sinceVision = now - this.lastVisionTime

        // Apply IMU prediction / Dead Reckoning (6DoF)
        const canPredict = !this.worldLockEnabled
            && this.imuPredictionEnabled
            && this.imuManager
            && this.imuManager.isActive
            && this.imuOrientationBase
        const shouldShow = this.isTracking && (sinceVision < this.deadReckonLimit)

        if (canPredict && shouldShow) {
            const dt = sinceVision / 1000 // seconds

            // --- 1. ROTATIONAL PREDICTION (Physics Correct) ---
            const q = this.imuManager.rawQuaternion || this.imuManager.quaternion
            const currentIMU = new THREE.Quaternion(q.x, q.y, q.z, q.w)

            // LOCAL Delta = inv(Base) * Current
            const localDelta = this.imuOrientationBase.clone().invert().multiply(currentIMU)

            // Pose = lastVision * localDelta
            const projectedQuaternion = this.lastQuaternion.clone().multiply(localDelta)
            this.camera.quaternion.copy(projectedQuaternion)

            // --- 2. TRANSLATIONAL PREDICTION (Inertial) ---
            // x = xo + v*dt
            if (this.imuManager.linVel && this.imuManager.linVel.length() > 0.01) {
                const velocityWorld = this.imuManager.linVel.clone()

                // Accelerometers measure in local phone frame. 
                // We must project that velocity into the world frame using the device orientation.
                // Note: currentIMU is the phone's orientation relative to Earth.
                velocityWorld.applyQuaternion(projectedQuaternion)

                const translationDelta = velocityWorld.multiplyScalar(dt)
                this.camera.position.addVectors(this.lastPosition, translationDelta)
            } else {
                this.camera.position.copy(this.lastPosition)
            }

            // Ensure model is visible during dead reckoning
            if (this.modelContainer) this.modelContainer.visible = true
        } else if (!shouldShow) {
            this.hide()
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
        return this.fov
    }
}

// Export
window.ModelRenderer = ModelRenderer
