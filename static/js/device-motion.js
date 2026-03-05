/**
 * Device Motion Manager
 *
 * High-rate device orientation is used for immediate visual response between
 * lower-rate vision updates from the backend.
 */

class DeviceMotionManager {
  constructor() {
    this.permissionGranted = false
    this.permissionDenied = false
    this.isActive = false

    this.orientation = {
      alpha: 0,
      beta: 0,
      gamma: 0,
    }

    this.quaternion = { x: 0, y: 0, z: 0, w: 1 }
    this.rawQuaternion = { x: 0, y: 0, z: 0, w: 1 }

    this.referenceOrientation = null
    this.hasReference = false
    this.deltaRotation = { x: 0, y: 0, z: 0, w: 1 }

    this.smoothingFactor = 0.3
    this.acceleration = { x: 0, y: 0, z: 0 }
    this.velocity = { x: 0, y: 0, z: 0 }
    this.lastMotionUpdate = 0
    this.lastUpdate = 0
    this.isMoving = false

    this.linAccel = new THREE.Vector3()
    this.linVel = new THREE.Vector3()

    this.boundOrientationHandler = this.handleOrientation.bind(this)
    this.boundMotionHandler = this.handleMotion.bind(this)
  }

  async requestPermission() {
    if (typeof DeviceOrientationEvent === 'undefined') {
      return false
    }

    try {
      if (typeof DeviceOrientationEvent.requestPermission === 'function') {
        const orientationPermission = await DeviceOrientationEvent.requestPermission()
        if (orientationPermission !== 'granted') {
          this.permissionDenied = true
          return false
        }
      }

      if (
        typeof DeviceMotionEvent !== 'undefined' &&
        typeof DeviceMotionEvent.requestPermission === 'function'
      ) {
        const motionPermission = await DeviceMotionEvent.requestPermission()
        if (motionPermission !== 'granted') {
          this.permissionDenied = true
          return false
        }
      }

      this.permissionGranted = true
      this.permissionDenied = false
      this.startListening()
      return true
    } catch (error) {
      console.error('[IMU] Permission request failed:', error)
      this.permissionDenied = true
      return false
    }
  }

  startListening() {
    if (this.isActive) {
      return
    }

    window.addEventListener('deviceorientation', this.boundOrientationHandler, true)
    window.addEventListener('devicemotion', this.boundMotionHandler, true)
    this.isActive = true
  }

  stopListening() {
    if (!this.isActive) {
      return
    }

    window.removeEventListener('deviceorientation', this.boundOrientationHandler, true)
    window.removeEventListener('devicemotion', this.boundMotionHandler, true)
    this.isActive = false
    this.clearReference()
    this.resetInertialState()
  }

  handleOrientation(event) {
    const alpha = event.alpha || 0
    const beta = event.beta || 0
    const gamma = event.gamma || 0

    this.rawQuaternion = this.eulerToQuaternion(alpha, beta, gamma)

    this.orientation.alpha = this.lerp(this.orientation.alpha, alpha, this.smoothingFactor)
    this.orientation.beta = this.lerp(this.orientation.beta, beta, this.smoothingFactor)
    this.orientation.gamma = this.lerp(this.orientation.gamma, gamma, this.smoothingFactor)

    this.quaternion = this.eulerToQuaternion(
      this.orientation.alpha,
      this.orientation.beta,
      this.orientation.gamma
    )

    if (this.hasReference) {
      this.deltaRotation = this.computeDeltaRotation()
    }

    this.lastUpdate = performance.now()
  }

  handleMotion(event) {
    const rawAcceleration = event.acceleration || event.accelerationIncludingGravity
    if (!rawAcceleration) {
      return
    }

    const now = performance.now()
    const dt = this.lastMotionUpdate ? (now - this.lastMotionUpdate) / 1000 : 0
    this.lastMotionUpdate = now

    if (dt <= 0 || dt > 0.1) {
      return
    }

    const gain = event.acceleration ? 1 : 0.15
    this.acceleration.x = (rawAcceleration.x || 0) * gain
    this.acceleration.y = (rawAcceleration.y || 0) * gain
    this.acceleration.z = (rawAcceleration.z || 0) * gain

    const deadzone = 0.05
    const ax = Math.abs(this.acceleration.x) > deadzone ? this.acceleration.x : 0
    const ay = Math.abs(this.acceleration.y) > deadzone ? this.acceleration.y : 0
    const az = Math.abs(this.acceleration.z) > deadzone ? this.acceleration.z : 0

    const friction = 0.82
    this.velocity.x = (this.velocity.x + ax * dt) * friction
    this.velocity.y = (this.velocity.y + ay * dt) * friction
    this.velocity.z = (this.velocity.z + az * dt) * friction

    this.linAccel.set(ax, ay, az)
    this.linVel.set(this.velocity.x, this.velocity.y, this.velocity.z)
    this.isMoving = this.linVel.length() > 0.01
  }

  resetInertialState() {
    this.velocity = { x: 0, y: 0, z: 0 }
    this.linAccel.set(0, 0, 0)
    this.linVel.set(0, 0, 0)
  }

  setReference() {
    const trackingQuaternion = this.getTrackingQuaternion()
    this.referenceOrientation = {
      alpha: this.orientation.alpha,
      beta: this.orientation.beta,
      gamma: this.orientation.gamma,
      quaternion: { ...trackingQuaternion },
    }
    this.hasReference = true
    this.deltaRotation = { x: 0, y: 0, z: 0, w: 1 }
  }

  clearReference() {
    this.referenceOrientation = null
    this.hasReference = false
    this.deltaRotation = { x: 0, y: 0, z: 0, w: 1 }
  }

  getTrackingQuaternion() {
    return this.rawQuaternion || this.quaternion
  }

  computeDeltaRotation() {
    if (!this.referenceOrientation) {
      return { x: 0, y: 0, z: 0, w: 1 }
    }

    const current = this.getTrackingQuaternion()
    const refInv = this.quaternionInverse(this.referenceOrientation.quaternion)
    return this.quaternionMultiply(current, refInv)
  }

  getRotationCorrection() {
    if (!this.hasReference || !this.isActive) {
      return null
    }
    return this.deltaRotation
  }

  getRotationMagnitude() {
    if (!this.hasReference) {
      return 0
    }

    const w = Math.max(-1, Math.min(1, this.deltaRotation.w))
    const angle = 2 * Math.acos(Math.abs(w))
    return (angle * 180) / Math.PI
  }

  isStable(thresholdDegrees = 5) {
    return this.getRotationMagnitude() < thresholdDegrees
  }

  lerp(a, b, t) {
    if (Math.abs(b - a) > 180) {
      if (b > a) {
        a += 360
      } else {
        b += 360
      }
    }
    let result = a + (b - a) * t
    if (result >= 360) {
      result -= 360
    }
    if (result < 0) {
      result += 360
    }
    return result
  }

  eulerToQuaternion(alpha, beta, gamma) {
    const halfX = (beta * Math.PI) / 360
    const halfY = (gamma * Math.PI) / 360
    const halfZ = (alpha * Math.PI) / 360

    const cX = Math.cos(halfX)
    const sX = Math.sin(halfX)
    const cY = Math.cos(halfY)
    const sY = Math.sin(halfY)
    const cZ = Math.cos(halfZ)
    const sZ = Math.sin(halfZ)

    return {
      x: sX * cY * cZ - cX * sY * sZ,
      y: cX * sY * cZ + sX * cY * sZ,
      z: cX * cY * sZ + sX * sY * cZ,
      w: cX * cY * cZ - sX * sY * sZ,
    }
  }

  quaternionInverse(q) {
    return {
      x: -q.x,
      y: -q.y,
      z: -q.z,
      w: q.w,
    }
  }

  quaternionMultiply(a, b) {
    return {
      x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
      y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
      z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
      w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
    }
  }

  getStatus() {
    return {
      active: this.isActive,
      hasPermission: this.permissionGranted,
      hasReference: this.hasReference,
      orientation: { ...this.orientation },
      rotationMagnitude: this.getRotationMagnitude().toFixed(1) + ' deg',
      lastUpdate: this.lastUpdate,
    }
  }
}

window.DeviceMotionManager = DeviceMotionManager
