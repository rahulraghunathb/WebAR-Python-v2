/**
 * Device Motion Manager
 *
 * Uses phone IMU (gyroscope/accelerometer) to:
 * 1. Track device orientation in real-time
 * 2. Fuse with vision-based pose for stability
 * 3. Smooth out jitter from vision-only tracking
 *
 * The IMU provides high-frequency, smooth rotation data that complements
 * the vision system's position tracking.
 */

class DeviceMotionManager {
    constructor() {
        // Permission state
        this.permissionGranted = false
        this.permissionDenied = false

        // Current device orientation (quaternion)
        this.orientation = {
            alpha: 0,  // Z-axis rotation (compass heading)
            beta: 0,   // X-axis rotation (front-back tilt)
            gamma: 0   // Y-axis rotation (left-right tilt)
        }

        // Quaternion representation
        this.quaternion = { x: 0, y: 0, z: 0, w: 1 }
        this.rawQuaternion = { x: 0, y: 0, z: 0, w: 1 }

        // Reference orientation (set when tracking starts)
        this.referenceOrientation = null
        this.hasReference = false

        // Delta rotation from reference
        this.deltaRotation = { x: 0, y: 0, z: 0, w: 1 }

        // Smoothing
        this.smoothingFactor = 0.3  // Lower = smoother

        // 6DoF - Translation
        this.acceleration = { x: 0, y: 0, z: 0 }
        this.velocity = { x: 0, y: 0, z: 0 }
        this.lastMotionUpdate = 0
        this.isMoving = false

        // Gravity-compensated acceleration (linear)
        this.linAccel = new THREE.Vector3()
        this.linVel = new THREE.Vector3()

        console.log('[IMU] DeviceMotionManager created')
    }

    /**
     * Request permission for device motion (required on iOS 13+)
     * MUST be called from a user gesture (click/tap) on iOS
     */
    async requestPermission() {
        console.log('[IMU] Requesting permission...')

        // Check if DeviceOrientationEvent is available
        if (typeof DeviceOrientationEvent === 'undefined') {
            console.warn('[IMU] DeviceOrientationEvent not supported')
            return false
        }

        // iOS 13+ requires permission request from user gesture
        if (typeof DeviceOrientationEvent.requestPermission === 'function') {
            try {
                console.log('[IMU] iOS detected, requesting DeviceOrientationEvent permission...')
                const permission = await DeviceOrientationEvent.requestPermission()
                console.log('[IMU] Permission response:', permission)

                if (permission === 'granted') {
                    this.permissionGranted = true
                    console.log('[IMU] Permission GRANTED')
                    this.startListening()
                    return true
                } else {
                    this.permissionDenied = true
                    console.warn('[IMU] Permission DENIED')
                    return false
                }
            } catch (error) {
                console.error('[IMU] Permission request error:', error)
                this.permissionDenied = true
                return false
            }
        } else {
            // Non-iOS or older iOS - no permission needed
            this.permissionGranted = true
            console.log('[IMU] No permission needed (non-iOS), starting')
            this.startListening()
            return true
        }
    }

    /**
     * Start listening to device orientation events
     */
    startListening() {
        if (this.isActive) return

        window.addEventListener('deviceorientation', this.handleOrientation.bind(this), true)
        window.addEventListener('devicemotion', this.handleMotion.bind(this), true)

        this.isActive = true
        console.log('[IMU] Listening for device orientation and motion')
    }

    /**
     * Stop listening
     */
    stopListening() {
        window.removeEventListener('deviceorientation', this.handleOrientation.bind(this), true)
        window.removeEventListener('devicemotion', this.handleMotion.bind(this), true)

        this.isActive = false
        this.hasReference = false
        console.log('[IMU] Stopped listening')
    }

    /**
     * Handle device orientation event
     * FOLLOWS W3C SPEC: Intrinsic ZXY order (Alpha, Beta, Gamma)
     */
    handleOrientation(event) {
        // Get orientation angles (in degrees)
        const alpha = event.alpha || 0  // 0-360 (Z)
        const beta = event.beta || 0    // -180 to 180 (X)
        const gamma = event.gamma || 0  // -90 to 90 (Y)

        // Raw values for prediction (zero-lag)
        this.rawQuaternion = this.eulerToQuaternion(alpha, beta, gamma)

        // Smoothed values for general status (lagged)
        this.orientation.alpha = this.lerp(this.orientation.alpha, alpha, this.smoothingFactor)
        this.orientation.beta = this.lerp(this.orientation.beta, beta, this.smoothingFactor)
        this.orientation.gamma = this.lerp(this.orientation.gamma, gamma, this.smoothingFactor)

        this.quaternion = this.eulerToQuaternion(
            this.orientation.alpha,
            this.orientation.beta,
            this.orientation.gamma
        )

        // Compute delta from reference if we have one
        if (this.hasReference) {
            this.deltaRotation = this.computeDeltaRotation()
        }

        this.lastUpdate = performance.now()
    }

    /**
     * Handle device motion event (Acceleration/RotationRate)
     */
    handleMotion(event) {
        if (!event.acceleration) return

        const acc = event.acceleration
        const now = performance.now()
        const dt = this.lastMotionUpdate ? (now - this.lastMotionUpdate) / 1000 : 0
        this.lastMotionUpdate = now

        if (dt <= 0 || dt > 0.1) return // Skip if gap is too large

        // 1. Capture Raw Linear Acceleration
        this.acceleration.x = acc.x || 0
        this.acceleration.y = acc.y || 0
        this.acceleration.z = acc.z || 0

        // 2. Filter out sensor noise (deadzone)
        const deadzone = 0.05
        const ax = Math.abs(this.acceleration.x) > deadzone ? this.acceleration.x : 0
        const ay = Math.abs(this.acceleration.y) > deadzone ? this.acceleration.y : 0
        const az = Math.abs(this.acceleration.z) > deadzone ? this.acceleration.z : 0

        // 3. Integrate Velocity: V = Vo + a*dt
        // We use a "Leaky Integrator" to prevent runaway drift
        const friction = 0.95
        this.velocity.x = (this.velocity.x + ax * dt) * friction
        this.velocity.y = (this.velocity.y + ay * dt) * friction
        this.velocity.z = (this.velocity.z + az * dt) * friction

        // 4. Update Three.js vectors for renderer
        this.linAccel.set(ax, ay, az)
        this.linVel.set(this.velocity.x, this.velocity.y, this.velocity.z)

        this.isMoving = this.linVel.length() > 0.01
    }

    /**
     * Reset inertial state (call when vision locks)
     */
    resetInertialState() {
        this.velocity = { x: 0, y: 0, z: 0 }
        this.linVel.set(0, 0, 0)
    }
    setReference() {
        this.referenceOrientation = {
            alpha: this.orientation.alpha,
            beta: this.orientation.beta,
            gamma: this.orientation.gamma,
            quaternion: { ...this.quaternion }
        }
        this.hasReference = true
        console.log('[IMU] Reference orientation set:',
            'alpha=' + this.orientation.alpha.toFixed(1),
            'beta=' + this.orientation.beta.toFixed(1),
            'gamma=' + this.orientation.gamma.toFixed(1)
        )
    }

    /**
     * Clear the reference (call when tracking is lost)
     */
    clearReference() {
        this.hasReference = false
        this.referenceOrientation = null
    }

    /**
     * Compute delta rotation from reference orientation
     */
    computeDeltaRotation() {
        if (!this.referenceOrientation) {
            return { x: 0, y: 0, z: 0, w: 1 }
        }

        // Compute relative rotation: delta = current * inverse(reference)
        const refInv = this.quaternionInverse(this.referenceOrientation.quaternion)
        return this.quaternionMultiply(this.quaternion, refInv)
    }

    /**
     * Get the IMU-based rotation correction to apply to vision pose
     * Returns a quaternion that can be used to adjust camera rotation
     */
    getRotationCorrection() {
        if (!this.hasReference || !this.isActive) {
            return null
        }

        return this.deltaRotation
    }

    /**
     * Get device tilt for stability check
     * Returns how much the device has rotated since reference
     */
    getRotationMagnitude() {
        if (!this.hasReference) return 0

        // Angle from quaternion: angle = 2 * acos(w)
        const w = Math.max(-1, Math.min(1, this.deltaRotation.w))
        const angle = 2 * Math.acos(Math.abs(w))
        return angle * 180 / Math.PI  // Convert to degrees
    }

    /**
     * Check if device is relatively stable (not moving much)
     */
    isStable(thresholdDegrees = 5) {
        return this.getRotationMagnitude() < thresholdDegrees
    }

    // ========== Math Utilities ==========

    lerp(a, b, t) {
        // Handle angle wrapping for alpha (0-360)
        if (Math.abs(b - a) > 180) {
            if (b > a) a += 360
            else b += 360
        }
        let result = a + (b - a) * t
        if (result >= 360) result -= 360
        if (result < 0) result += 360
        return result
    }

    /**
     * Convert device orientation angles to quaternion
     * W3C SPEC: Intrinsic Z-X'-Y'' (Alpha, Beta, Gamma)
     * This follows the mathematical definition of R = Rz(a)Rx(b)Ry(g)
     */
    eulerToQuaternion(alpha, beta, gamma) {
        const _x = beta * Math.PI / 180 / 2
        const _y = gamma * Math.PI / 180 / 2
        const _z = alpha * Math.PI / 180 / 2

        const cX = Math.cos(_x)
        const sX = Math.sin(_x)
        const cY = Math.cos(_y)
        const sY = Math.sin(_y)
        const cZ = Math.cos(_z)
        const sZ = Math.sin(_z)

        // Intrinsic ZXY order (Alpha, Beta, Gamma)
        return {
            x: sX * cY * cZ - cX * sY * sZ,
            y: cX * sY * cZ + sX * cY * sZ,
            z: cX * cY * sZ + sX * sY * cZ,
            w: cX * cY * cZ - sX * sY * sZ
        }
    }

    quaternionInverse(q) {
        // For unit quaternion, inverse is conjugate
        return {
            x: -q.x,
            y: -q.y,
            z: -q.z,
            w: q.w
        }
    }

    quaternionMultiply(a, b) {
        return {
            x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
            y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
            z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
            w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z
        }
    }

    /**
     * Get status for debugging
     */
    getStatus() {
        return {
            active: this.isActive,
            hasPermission: this.permissionGranted,
            hasReference: this.hasReference,
            orientation: { ...this.orientation },
            rotationMagnitude: this.getRotationMagnitude().toFixed(1) + '°',
            lastUpdate: this.lastUpdate
        }
    }
}

// Export
window.DeviceMotionManager = DeviceMotionManager
