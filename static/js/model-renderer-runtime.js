ModelRenderer.prototype.setIMUManager = function(imuManager) {
    this.imuManager = imuManager
};

ModelRenderer.prototype.saveIMUBaseline = function(id, quat) {
    if (!id || !quat) {
      return
    }

    this.imuHistory.set(id, { ...quat })
    while (this.imuHistory.size > 120) {
      const firstKey = this.imuHistory.keys().next().value
      this.imuHistory.delete(firstKey)
    }
};

ModelRenderer.prototype.consumeIMUBaseline = function(id) {
    if (!id || !this.imuHistory.has(id)) {
      return null
    }

    const history = this.imuHistory.get(id)
    for (const key of this.imuHistory.keys()) {
      if (key <= id) {
        this.imuHistory.delete(key)
      }
    }

    return new THREE.Quaternion(history.x, history.y, history.z, history.w)
};

ModelRenderer.prototype.getCurrentIMUQuaternion = function() {
    if (!this.imuManager || !this.imuManager.isActive) {
      return null
    }

    const quat = this.imuManager.getTrackingQuaternion()
    return new THREE.Quaternion(quat.x, quat.y, quat.z, quat.w)
};

ModelRenderer.prototype.predictPose = function(elapsedMs) {
    const predictedPosition = this.currentVisionPosition.clone()
    const predictedQuaternion = this.currentVisionQuaternion.clone()

    if (this.visionIMUQuaternion) {
      const currentIMU = this.getCurrentIMUQuaternion()
      if (currentIMU) {
        const delta = this.visionIMUQuaternion.clone().invert().multiply(currentIMU)
        predictedQuaternion.multiply(delta)
      }
    }

    if (elapsedMs < this.translationPredictionWindowMs && this.visionVelocity.lengthSq() > 0.000001) {
      const dt = elapsedMs / 1000
      const translationDelta = this.visionVelocity.clone().multiplyScalar(dt * 0.55)
      if (translationDelta.length() > 0.06) {
        translationDelta.setLength(0.06)
      }
      predictedPosition.add(translationDelta)
    }

    return {
      position: predictedPosition,
      quaternion: predictedQuaternion,
    }
};

ModelRenderer.prototype.computeDampingAlpha = function(deltaSeconds, frequencyHz) {
    return 1 - Math.exp(-frequencyHz * deltaSeconds)
};

ModelRenderer.prototype.hasTracking = function() {
    return (this.isTracking && this.hasVisionPose) || this.worldPlacementActive
};

ModelRenderer.prototype.getRenderState = function() {
    if (this.xrSessionActive) {
      return this.worldPlacementActive ? 'WORLD_TRACKING' : 'WORLD_SEARCHING'
    }

    if (!this.hasVisionPose) {
      return 'SEARCHING'
    }

    const sinceVision = performance.now() - this.lastVisionTime
    if (sinceVision < 90) {
      return 'TRACKING'
    }
    if (sinceVision < this.predictionMaxMs) {
      return 'PREDICTING'
    }
    return 'SEARCHING'
};

ModelRenderer.prototype.getPoseSnapshot = function() {
    if (!this.hasTracking()) {
      return null
    }

    const sourcePosition = this.worldPlacementActive && this.trackingRoot
      ? this.trackingRoot.position
      : this.renderedPosition

    return {
      position: {
        x: sourcePosition.x,
        y: sourcePosition.y,
        z: sourcePosition.z,
      },
      poseAgeMs: this.renderStats.poseAgeMs,
    }
};

ModelRenderer.prototype.getDiagnostics = function() {
    return {
      ...this.renderStats,
      renderState: this.getRenderState(),
      fov: Number(this.fov.toFixed(2)),
      xrSessionActive: this.xrSessionActive,
      worldTrackingState: this.worldTrackingState,
      worldPlacementActive: this.worldPlacementActive,
    }
};

ModelRenderer.prototype.clearCanvas = function() {
    if (!this.renderer || !this.scene || !this.camera) {
      return
    }

    this.renderer.clear()
    this.renderer.render(this.scene, this.camera)
};

ModelRenderer.prototype.expireTracking = function() {
    this.isTracking = false
    this.hasVisionPose = false
    this.visionIMUQuaternion = null
    this.visionVelocity.set(0, 0, 0)
    this.hide()
};

ModelRenderer.prototype.resetPose = function() {
    this.currentVisionPosition.set(0, 0, 0)
    this.currentVisionQuaternion.identity()
    this.renderedPosition.set(0, 0, 0)
    this.renderedQuaternion.identity()
    this.previousRenderedPosition.set(0, 0, 0)
    this.visionVelocity.set(0, 0, 0)
    this.imuHistory.clear()
    this.visionIMUQuaternion = null
    this.hasVisionPose = false
    this.isTracking = false
    this.worldPlacementActive = false
    this.worldTrackingState = this.xrSessionActive ? 'PLACEMENT' : 'IDLE'
    this.renderStats.poseQuality = 0
    this.renderStats.poseAgeMs = 0
    this.renderStats.predictionActive = false
    this.renderStats.renderJitterMm = 0
    this.renderStats.lastRejectedReason = 'NONE'
    this.hide()
};

ModelRenderer.prototype.updateDebugVisibility = function() {
    const debugVisible = this.debugMode && this.hasTracking()
    this.debugObjects.targetPlane.visible = debugVisible
    this.debugObjects.axes.visible = debugVisible
    this.debugObjects.originMarker.visible = debugVisible
};

ModelRenderer.prototype.show = function() {
    if (this.trackingRoot) {
      this.trackingRoot.visible = true
    }
    if (this.modelRoot) {
      this.modelRoot.visible = true
    }
    this.updateDebugVisibility()
};

ModelRenderer.prototype.hide = function() {
    if (this.modelRoot) {
      this.modelRoot.visible = false
    }
    if (this.trackingRoot) {
      this.trackingRoot.visible = false
    }
    this.debugObjects.targetPlane.visible = false
    this.debugObjects.axes.visible = false
    this.debugObjects.originMarker.visible = false
    if (!this.xrSessionActive) {
      this.clearCanvas()
    }
};

ModelRenderer.prototype.render = function() {
    if (!this.renderer || !this.scene || !this.camera) {
      return
    }

    const now = performance.now()
    const deltaSeconds = Math.min(0.05, Math.max(1 / 120, (now - this.lastRenderTime) / 1000))
    this.lastRenderTime = now
    this.renderStats.lastFrameMs = Number((deltaSeconds * 1000).toFixed(2))

    if (this.hasVisionPose) {
      const elapsedMs = now - this.lastVisionTime
      this.renderStats.poseAgeMs = Math.round(elapsedMs)
      if (elapsedMs > this.predictionMaxMs) {
        this.expireTracking()
      } else {
        const predicted = this.predictPose(elapsedMs)
        const positionHz = elapsedMs > 85 ? 10 : 16 + this.renderStats.poseQuality * 8
        const rotationHz = elapsedMs > 85 ? 12 : 18 + this.renderStats.poseQuality * 10
        const positionAlpha = this.computeDampingAlpha(deltaSeconds, positionHz)
        const rotationAlpha = this.computeDampingAlpha(deltaSeconds, rotationHz)

        this.renderedPosition.lerp(predicted.position, positionAlpha)
        this.renderedQuaternion.slerp(predicted.quaternion, rotationAlpha)
        this.camera.position.copy(this.renderedPosition)
        this.camera.quaternion.copy(this.renderedQuaternion)
        this.renderStats.predictionActive = elapsedMs >= 90

        const jitterMm = this.previousRenderedPosition.distanceTo(this.renderedPosition) * 1000
        this.renderStats.renderJitterMm = Number(
          THREE.MathUtils.lerp(this.renderStats.renderJitterMm, jitterMm, 0.2).toFixed(2)
        )
        this.previousRenderedPosition.copy(this.renderedPosition)
        this.updateDebugVisibility()
      }
    } else {
      this.renderStats.poseAgeMs = 0
      this.renderStats.predictionActive = false
    }

    this.renderer.render(this.scene, this.camera)
};

ModelRenderer.prototype.setDebug = function(enabled) {
    this.debugMode = enabled
    this.updateDebugVisibility()
};

ModelRenderer.prototype.getFOV = function() {
    return this.fov
};
