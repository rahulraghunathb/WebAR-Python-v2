WebXRWorldTracker.prototype.resetPlacement = function() {
    this.filteredPlacementMatrix = null
    this.metrics.hasPlacement = false
    this.metrics.targetVisible = false
    this.metrics.targetState = this.metrics.targetReferenceReady
      ? this.session
        ? 'SEARCHING'
        : 'READY'
      : 'UNINITIALIZED'
    this.metrics.filterSource = 'NONE'
    this.metrics.filterConfidence = 0
    this.metrics.measurementConfidence = 0
    this.metrics.baseMeasurementConfidence = 0
    this.metrics.workerProcMs = 0
    this.metrics.workerLatencyMs = 0
    this.metrics.residualTranslationM = 0
    this.metrics.residualRotationDeg = 0
    this.metrics.posAlpha = 0
    this.metrics.rotAlpha = 0
    this.metrics.snapCount = 0
    this.metrics.filterFrames = 0
    this.metrics.speedMps = 0
    this.modelRenderer.clearWorldPlacement()

    if (this.poseWorker && this.poseWorkerReady) {
      this.poseWorker.postMessage({ type: 'reset' })
    }

    if (this.session) {
      this.setState('SCANNING')
    } else {
      this.setState('IDLE')
    }
    this.emitState()
    this.log('Target lock reset')
};

WebXRWorldTracker.prototype.handleVisibilityChange = function() {
    this.metrics.visibilityState = document.visibilityState || 'hidden'
    this.emitState()
};

WebXRWorldTracker.prototype.onXRFrame = function(time, frame) {
    if (!frame) {
      return
    }

    if (!this.referenceSpace) {
      const rendererReferenceSpace =
        this.renderer &&
        this.renderer.xr &&
        typeof this.renderer.xr.getReferenceSpace === 'function'
          ? this.renderer.xr.getReferenceSpace()
          : null
      if (rendererReferenceSpace) {
        this.referenceSpace = rendererReferenceSpace
        this.metrics.referenceSpace = 'renderer-default'
        this.log('Using renderer-managed XR reference space')
        this.emitState()
      }
    }

    const frameStartedAt = performance.now()
    if (!this.referenceSpace) {
      this.metrics.hitTestState = 'NO_REF_SPACE'
      this.modelRenderer.render()
      this.metrics.localLatencyMs = Number((performance.now() - frameStartedAt).toFixed(3))
      return
    }
    const deltaMs = this.lastFrameTime ? Math.max(1, time - this.lastFrameTime) : 16.7
    this.lastFrameTime = time
    this.metrics.frameTimeMs = Number(deltaMs.toFixed(2))
    this.frameCount += 1

    const now = performance.now()
    if (!this.lastFpsSampleTime) {
      this.lastFpsSampleTime = now
    } else if (now - this.lastFpsSampleTime >= 1000) {
      this.metrics.xrFps = Math.round((this.frameCount * 1000) / (now - this.lastFpsSampleTime))
      this.frameCount = 0
      this.lastFpsSampleTime = now
    }

    this.modelRenderer.markWorldFrame(deltaMs)

    const viewerPose = frame.getViewerPose(this.referenceSpace)
    if (!viewerPose || !viewerPose.views || !viewerPose.views.length) {
      this.metrics.hitTestState = 'NO_POSE'
      if (!this.metrics.hasPlacement) {
        this.setState('SCANNING')
      }
      this.modelRenderer.render()
      this.metrics.localLatencyMs = Number((performance.now() - frameStartedAt).toFixed(3))
      return
    }

    this.metrics.hitTestState = 'DISABLED'
    this.updateViewport(viewerPose.views[0])
    this.captureVisualFrame(frame, viewerPose)
    this.modelRenderer.render()
    this.metrics.localLatencyMs = Number((performance.now() - frameStartedAt).toFixed(3))
};

WebXRWorldTracker.prototype.captureVisualFrame = function(frame, viewerPose) {
    if (!this.cameraPipeline || !this.poseWorkerReady) {
      return
    }

    const capture = this.cameraPipeline.captureFrame(frame, viewerPose)
    this.syncCameraDiagnostics()
    if (!capture) {
      return
    }

    const posted = this.postVisualFrame(capture, viewerPose)
    if (posted) {
      this.cameraPipeline.markFrameSubmitted()
    } else {
      this.cameraPipeline.markFrameComplete()
    }
    this.syncCameraDiagnostics()
};

WebXRWorldTracker.prototype.updateViewport = function(view) {
    const rect = this.viewportStage
      ? this.viewportStage.getBoundingClientRect()
      : { width: window.innerWidth, height: window.innerHeight }
    const width = Math.max(1, Math.round(rect.width || window.innerWidth))
    const height = Math.max(1, Math.round(rect.height || window.innerHeight))
    const sourceWidth = Number((view && view.camera && view.camera.width) || 0)
    const sourceHeight = Number((view && view.camera && view.camera.height) || 0)

    this.metrics.viewport = width + 'x' + height
    this.modelRenderer.resize(width, height, {
      sourceWidth,
      sourceHeight,
      fitMode: 'cover',
    })
};

WebXRWorldTracker.prototype.handleSessionEnd = function() {
    if (this.session) {
      this.session.removeEventListener('end', this.boundSessionEnd)
    }
    document.removeEventListener('visibilitychange', this.boundVisibilityChange)

    if (this.renderer) {
      this.renderer.setAnimationLoop(null)
      this.renderer.xr.enabled = false
    }

    if (this.cameraPipeline) {
      this.cameraPipeline.stop()
      this.syncCameraDiagnostics()
    }

    this.referenceSpace = null
    this.session = null
    this.lastFrameTime = 0
    this.lastFpsSampleTime = 0
    this.frameCount = 0
    this.filteredPlacementMatrix = null
    this.clearLatestHit()

    if (this.targetImageBitmap && typeof this.targetImageBitmap.close === 'function') {
      this.targetImageBitmap.close()
    }
    this.targetImageBitmap = null

    this.modelRenderer.setXRSessionActive(false)
    this.modelRenderer.resetPose()
    this.destroyPoseWorker()

    this.metrics.sessionState = 'ENDED'
    this.metrics.visibilityState = 'hidden'
    this.metrics.targetState = 'IDLE'
    this.metrics.targetVisible = false
    this.metrics.targetUpdates = 0
    this.metrics.targetMatchCount = 0
    this.metrics.targetInlierCount = 0
    this.metrics.targetConfidence = 0
    this.metrics.targetReprojectionPx = 0
    this.metrics.targetStableFrames = 0
    this.metrics.targetPrelockMisses = 0
    this.metrics.targetRejectReason = 'NONE'
    this.metrics.targetBestInliers = 0
    this.metrics.targetRefinedInliers = 0
    this.metrics.targetRawMatchCount = 0
    this.metrics.targetReciprocalMatchCount = 0
    this.metrics.targetMatchStrategy = 'NONE'
    this.metrics.targetReferenceReady = false
    this.metrics.targetReferenceFeatures = 0
    this.metrics.targetIndex = -1
    this.metrics.hasPlacement = false
    this.metrics.anchorState = 'UNAVAILABLE'
    this.metrics.cameraAccessState = 'IDLE'
    this.metrics.visualState = 'IDLE'
    this.metrics.visualFrames = 0
    this.metrics.visualQuality = 0
    this.metrics.visualFeatureCount = 0
    this.metrics.trackCount = 0
    this.metrics.matchCount = 0
    this.metrics.keyframeCount = 0
    this.metrics.landmarkCount = 0
    this.metrics.mapState = 'BOOTSTRAP'
    this.metrics.relocalizationScore = 0
    this.metrics.filterSource = 'NONE'
    this.metrics.filterConfidence = 0
    this.metrics.measurementConfidence = 0
    this.metrics.baseMeasurementConfidence = 0
    this.metrics.workerProcMs = 0
    this.metrics.workerLatencyMs = 0
    this.metrics.residualTranslationM = 0
    this.metrics.residualRotationDeg = 0
    this.metrics.posAlpha = 0
    this.metrics.rotAlpha = 0
    this.metrics.snapCount = 0
    this.metrics.filterFrames = 0
    this.metrics.speedMps = 0
    this.metrics.framebufferScale = 1
    this.metrics.xrFps = 0
    this.metrics.viewport = '-'
    this.metrics.referenceSpace = '-'
    this.metrics.localLatencyMs = 0

    this.setState('ENDED')
    this.log('XR session ended')
};
