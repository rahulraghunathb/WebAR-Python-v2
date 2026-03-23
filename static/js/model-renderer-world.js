ModelRenderer.prototype.setWorldPlacementFromMatrix = function(matrixInput, debugMeta = {}) {
    if (!this.trackingRoot) {
      return
    }

    const matrix = new THREE.Matrix4()
    if (Array.isArray(matrixInput)) {
      matrix.fromArray(matrixInput)
    } else if (matrixInput && matrixInput.elements) {
      matrix.copy(matrixInput)
    } else {
      return
    }

    const position = new THREE.Vector3()
    const quaternion = new THREE.Quaternion()
    const scale = new THREE.Vector3()
    matrix.decompose(position, quaternion, scale)

    const movementMm = this.worldPlacementActive
      ? this.trackingRoot.position.distanceTo(position) * 1000
      : 0

    this.trackingRoot.position.copy(position)
    this.trackingRoot.quaternion.copy(quaternion)
    this.trackingRoot.scale.set(1, 1, 1)
    this.worldPlacementActive = true
    this.worldTrackingState = 'TRACKING'
    this.renderStats.lastPoseSource = debugMeta.poseSource || 'WEBXR_WORLD'
    this.renderStats.lastRejectedReason = 'NONE'
    this.renderStats.poseAgeMs = 0
    this.renderStats.lastConfidence = Number((debugMeta.confidence || this.renderStats.lastConfidence || 0).toFixed(3))
    this.renderStats.translationJumpM = Number((debugMeta.translationResidualM || movementMm / 1000 || 0).toFixed(3))
    this.renderStats.rotationJumpDeg = Number((debugMeta.rotationResidualDeg || 0).toFixed(2))
    this.renderStats.renderJitterMm = Number(
      THREE.MathUtils.lerp(this.renderStats.renderJitterMm, movementMm, this.worldPlacementActive ? 0.25 : 1).toFixed(2)
    )
    this.show()
};

ModelRenderer.prototype.clearWorldPlacement = function() {
    if (!this.trackingRoot) {
      return
    }

    this.trackingRoot.position.set(0, 0, 0)
    this.trackingRoot.quaternion.identity()
    this.trackingRoot.scale.set(1, 1, 1)
    this.worldPlacementActive = false
    if (this.xrSessionActive) {
      this.worldTrackingState = 'PLACEMENT'
      this.trackingRoot.visible = false
      if (this.modelRoot) {
        this.modelRoot.visible = false
      }
    } else {
      this.worldTrackingState = 'IDLE'
      this.renderStats.renderJitterMm = 0
      this.hide()
    }
};

ModelRenderer.prototype.markWorldFrame = function(deltaMs) {
    this.renderStats.lastFrameMs = Number(deltaMs.toFixed(2))
    this.renderStats.poseAgeMs = 0
    this.renderStats.predictionActive = false
    this.renderStats.lastPoseSource = this.worldPlacementActive ? 'WEBXR_WORLD' : 'WEBXR_SURFACE'
};

ModelRenderer.prototype.setIntrinsics = function(intrinsics) {
    if (!intrinsics) {
      return
    }

    const nextFingerprint = intrinsics.fingerprint || null
    const canUpdateFov =
      !this.fovLocked ||
      (nextFingerprint && nextFingerprint !== this.intrinsicsFingerprint)

    if (
      canUpdateFov &&
      intrinsics.fovVertical &&
      intrinsics.fovVertical > 20 &&
      intrinsics.fovVertical < 120
    ) {
      this.fov = intrinsics.fovVertical
      this.camera.fov = this.fov
      this.fovLocked = true
      this.intrinsicsFingerprint = nextFingerprint
    }

    this.camera.updateProjectionMatrix()
};

ModelRenderer.prototype.resize = function(width, height, viewport) {
    if (!this.renderer || !this.canvas) {
      return
    }

    if (!width || !height) {
      const rect = this.canvas.parentElement && this.canvas.parentElement.getBoundingClientRect()
      width = (rect && rect.width) || window.innerWidth
      height = (rect && rect.height) || window.innerHeight
    }

    this.renderer.setSize(width, height, false)
    this.canvas.style.width = width + 'px'
    this.canvas.style.height = height + 'px'

    const sourceWidth = viewport && viewport.sourceWidth
    const sourceHeight = viewport && viewport.sourceHeight
    const fitMode = (viewport && viewport.fitMode) || 'cover'

    if (sourceWidth && sourceHeight && fitMode === 'cover') {
      const scale = Math.max(width / sourceWidth, height / sourceHeight)
      const visibleWidth = width / scale
      const visibleHeight = height / scale
      const offsetX = (sourceWidth - visibleWidth) / 2
      const offsetY = (sourceHeight - visibleHeight) / 2

      this.camera.aspect = sourceWidth / sourceHeight
      this.camera.setViewOffset(
        sourceWidth,
        sourceHeight,
        offsetX,
        offsetY,
        visibleWidth,
        visibleHeight
      )
    } else {
      this.camera.clearViewOffset()
      this.camera.aspect = width / height
    }

    this.camera.updateProjectionMatrix()
};

ModelRenderer.prototype.updatePose = function(result) {
    const pose = result && result.pose
    if (!pose || !pose.matrix) {
      return false
    }

    const matrixValues = pose.matrix
    if (
      !Array.isArray(matrixValues) ||
      matrixValues.length !== 16 ||
      matrixValues.some((value) => !isFinite(value))
    ) {
      return false
    }

    const matrix = new THREE.Matrix4()
    matrix.fromArray(matrixValues)

    const position = new THREE.Vector3()
    const quaternion = new THREE.Quaternion()
    const scale = new THREE.Vector3()
    matrix.decompose(position, quaternion, scale)

    const distance = position.length()
    if (distance > 12 || distance < 0.05) {
      this.renderStats.lastRejectedReason = 'distance-out-of-range'
      this.renderStats.rejectedVisionUpdates += 1
      return false
    }

    const confidence =
      typeof pose.confidence === 'number'
        ? pose.confidence
        : typeof result.debug?.tracking_confidence === 'number'
          ? result.debug.tracking_confidence
          : typeof result.debug?.confidence === 'number'
            ? result.debug.confidence
            : 0.5
    const inliers = Number(result.debug?.inliers || pose.inlier_count || 0)
    const reproj = Number(result.debug?.last_reproj_error || pose.reproj_error || 0)
    const poseSource = result.debug?.pose_source || 'VISION'
    const poseQuality = this.computePoseQuality(confidence, inliers, reproj)
    const now = performance.now()
    const poseAge = this.hasVisionPose ? now - this.lastVisionTime : Number.POSITIVE_INFINITY
    const requiresSnap =
      !this.hasVisionPose ||
      poseAge > this.reacquireSnapMs ||
      result.debug?.relocalized ||
      poseSource === 'TARGET_BOOTSTRAP' ||
      poseSource === 'RELOCALIZATION'

    if (!requiresSnap && !this.isPoseAcceptable(position, quaternion, poseQuality, poseSource)) {
      return false
    }

    if (this.hasVisionPose) {
      const dtSeconds = Math.max(1 / 120, Math.min(0.25, (now - this.lastVisionTime) / 1000))
      const measuredVelocity = position.clone().sub(this.currentVisionPosition).multiplyScalar(1 / dtSeconds)
      if (measuredVelocity.length() > 2.5) {
        measuredVelocity.setLength(2.5)
      }
      this.visionVelocity.lerp(measuredVelocity, requiresSnap ? 0.18 : 0.35)
    } else {
      this.visionVelocity.set(0, 0, 0)
    }

    if (requiresSnap) {
      this.currentVisionPosition.copy(position)
      this.currentVisionQuaternion.copy(quaternion)
      this.renderedPosition.copy(position)
      this.renderedQuaternion.copy(quaternion)
      this.previousRenderedPosition.copy(position)
      this.visionVelocity.multiplyScalar(0.3)
    } else {
      const positionBlend = THREE.MathUtils.clamp(0.42 + poseQuality * 0.35, 0.42, 0.82)
      const rotationBlend = THREE.MathUtils.clamp(0.5 + poseQuality * 0.35, 0.5, 0.88)
      this.currentVisionPosition.lerp(position, positionBlend)
      this.currentVisionQuaternion.slerp(quaternion, rotationBlend)
    }

    const frameId = result.id || pose.id
    this.visionIMUQuaternion = this.consumeIMUBaseline(frameId) || this.getCurrentIMUQuaternion()

    this.camera.position.copy(this.renderedPosition)
    this.camera.quaternion.copy(this.renderedQuaternion)

    this.renderStats.poseQuality = Number(poseQuality.toFixed(3))
    this.renderStats.translationJumpM = Number(this.currentVisionPosition.distanceTo(position).toFixed(3))
    this.renderStats.rotationJumpDeg = Number(
      THREE.MathUtils.radToDeg(this.currentVisionQuaternion.angleTo(quaternion)).toFixed(1)
    )
    this.renderStats.lastConfidence = Number(confidence.toFixed(3))
    this.renderStats.lastPoseSource = poseSource
    this.renderStats.lastRejectedReason = 'NONE'
    this.renderStats.acceptedVisionUpdates += 1
    this.renderStats.visionVelocity = Number(this.visionVelocity.length().toFixed(3))

    this.hasVisionPose = true
    this.isTracking = true
    this.lastVisionTime = now
    this.lastGapTime = 0
    this.show()

    if (this.imuManager) {
      this.imuManager.resetInertialState()
    }

    return true
};

ModelRenderer.prototype.computePoseQuality = function(confidence, inliers, reproj) {
    const inlierScore = Math.min(1, inliers / 18)
    const reprojScore = reproj > 0 ? Math.max(0, 1 - reproj / 8) : 0.6
    return THREE.MathUtils.clamp(confidence * 0.5 + inlierScore * 0.3 + reprojScore * 0.2, 0, 1)
};

ModelRenderer.prototype.isPoseAcceptable = function(position, quaternion, poseQuality, poseSource) {
    if (!this.hasVisionPose) {
      return true
    }

    const translationJump = this.currentVisionPosition.distanceTo(position)
    const rotationJumpDeg = THREE.MathUtils.radToDeg(this.currentVisionQuaternion.angleTo(quaternion))
    const isRecovery = poseSource === 'RELOCALIZATION'

    let maxTranslation = 0.1
    let maxRotation = 10
    if (poseQuality >= 0.65) {
      maxTranslation = 0.18
      maxRotation = 18
    }
    if (poseQuality >= 0.85) {
      maxTranslation = 0.28
      maxRotation = 30
    }
    if (isRecovery) {
      maxTranslation = 0.45
      maxRotation = 55
    }

    this.renderStats.translationJumpM = Number(translationJump.toFixed(3))
    this.renderStats.rotationJumpDeg = Number(rotationJumpDeg.toFixed(1))

    if (translationJump > maxTranslation) {
      this.renderStats.lastRejectedReason = 'translation-jump'
      this.renderStats.rejectedVisionUpdates += 1
      return false
    }

    if (rotationJumpDeg > maxRotation) {
      this.renderStats.lastRejectedReason = 'rotation-jump'
      this.renderStats.rejectedVisionUpdates += 1
      return false
    }

    return true
};

ModelRenderer.prototype.handleVisionGap = function(debug = {}) {
    if (!this.hasVisionPose) {
      this.hide()
      return
    }
    this.lastGapTime = performance.now()
    this.renderStats.lastRejectedReason = debug.rejected_reason || 'vision-gap'
};
