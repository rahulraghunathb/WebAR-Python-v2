CustomTrackerApp.prototype.maybeTuneCaptureProfile = function(force) {
    if (!this.running) {
      return
    }

    const now = performance.now()
    if (!force && now - this.lastProfileTuneAt < 1500) {
      return
    }

    const camera = typeof this.cameraPipeline.getDiagnostics === 'function'
      ? this.cameraPipeline.getDiagnostics()
      : null
    if (!camera) {
      return
    }

    let maxDimension = 224
    let minFrameIntervalMs = 160
    let reason = 'target-search-acquire'
    const hasFpsSample = this.metrics.xrFps > 0
    const averageCaptureMs = Number(camera.averageCaptureMs || 0)
    const captureBackedUp = Boolean(camera.inFlight && averageCaptureMs > 12)

    if (this.metrics.hasPlacement || this.metrics.targetState === 'TRACKING') {
      maxDimension = 160
      minFrameIntervalMs = 280
      reason = 'target-locked-accuracy'
    }

    if (
      !this.metrics.hasPlacement &&
      this.metrics.targetState === 'SEARCHING' &&
      (!hasFpsSample || (this.metrics.xrFps >= 22 && averageCaptureMs < 10))
    ) {
      maxDimension = 320
      minFrameIntervalMs = 110
      reason = 'first-lock-feature-boost'
    }

    if (
      !this.metrics.hasPlacement &&
      (this.metrics.targetState === 'DETECTED' || this.metrics.targetState === 'REACQUIRING')
    ) {
      maxDimension = 352
      minFrameIntervalMs = 100
      reason = 'target-confirm-feature-boost'
    }

    if (
      !this.metrics.hasPlacement &&
      this.metrics.xrFps > 24 &&
      this.metrics.visualQuality < 0.4 &&
      this.metrics.visualFeatureCount < 14 &&
      averageCaptureMs < 10
    ) {
      maxDimension = 352
      minFrameIntervalMs = 110
      reason = 'diagnostic-feature-boost'
    }

    if (
      hasFpsSample && (
      this.metrics.xrFps < 18 ||
      this.metrics.frameTimeMs > 58 ||
      averageCaptureMs > 14 ||
      captureBackedUp
    )) {
      maxDimension = this.metrics.hasPlacement ? 128 : 192
      minFrameIntervalMs = 300
      reason = 'fps-protect'
    }

    if (
      hasFpsSample && (
      this.metrics.xrFps < 14 ||
      this.metrics.frameTimeMs > 72 ||
      averageCaptureMs > 22
    )) {
      maxDimension = this.metrics.hasPlacement ? 112 : 128
      minFrameIntervalMs = 480
      reason = 'hard-fps-protect'
    }

    if (
      camera.maxDimension === maxDimension &&
      camera.minFrameIntervalMs === minFrameIntervalMs
    ) {
      return
    }

    this.lastProfileTuneAt = now
    this.cameraPipeline.setConfig({ maxDimension, minFrameIntervalMs })
    this.metrics.cameraCaptureMaxDimension = maxDimension
    this.metrics.cameraCaptureIntervalMs = minFrameIntervalMs
    this.log('Capture profile tuned', {
      reason: reason,
      maxDimension: maxDimension,
      minFrameIntervalMs: minFrameIntervalMs,
      xrFps: this.metrics.xrFps,
      frameTimeMs: Number(this.metrics.frameTimeMs.toFixed(2)),
      avgCaptureMs: Number(((camera.averageCaptureMs || 0)).toFixed(3)),
      pending: Boolean(camera.inFlight),
      targetState: this.metrics.targetState,
      targetVisible: this.metrics.targetVisible,
    }, 'Perf')
};

CustomTrackerApp.prototype.updateInfoPanel = function() {
    const world = this.worldTracker.getDiagnostics()
    const render = this.modelRenderer.getDiagnostics()
    const snapshot = this.modelRenderer.getPoseSnapshot()

    this.setText('infoStatus', render.renderState)
    this.setText('infoSessionState', world.sessionState)
    this.setText('infoVisibility', world.visibilityState)
    this.setText('infoRefSpace', world.referenceSpace)
    this.setText('infoViewport', world.viewport)
    this.setText('infoLatency', world.workerLatencyMs.toFixed(2) + ' ms')

    this.setText('infoWorldState', world.worldState)
    this.setText('infoTargetState', world.targetState + (world.targetVisible ? ' / visible' : ' / hidden'))
    this.setText('infoTargetImage', world.targetName)
    this.setText(
      'infoTargetStats',
      'upd ' + world.targetUpdates + ' | sf ' + world.targetStableFrames + ' | miss ' + world.targetPrelockMisses + ' | mt ' + world.targetMatchCount + ' | raw ' + world.targetRawMatchCount + ' | rx ' + world.targetReciprocalMatchCount + ' | mode ' + world.targetMatchStrategy + ' | in ' + world.targetInlierCount + ' | best ' + world.targetBestInliers + ' | refn ' + world.targetRefinedInliers + ' | rej ' + world.targetRejectReason + ' | conf ' + Math.round(world.targetConfidence * 100) + '% | err ' + world.targetReprojectionPx.toFixed(2) + ' px | ref ' + (world.targetReferenceReady ? world.targetReferenceFeatures : 0)
    )
    this.setText('infoPlacement', world.hasPlacement ? 'Placed #' + world.placementCount : 'Unplaced')
    this.setText('infoHitTest', world.hitTestState)
    this.setText('infoSurfaceHits', world.surfaceHits)
    this.setText('infoLastHit', world.lastHitDistanceM ? world.lastHitDistanceM.toFixed(2) + ' m' : '-')
    this.setText(
      'infoAnchor',
      world.anchorState + (world.anchorSupported ? ' / api' : ' / image-target-space')
    )
    this.setText('infoTapCount', world.selectCount)

    this.setText('infoBuildSig', this.metrics.buildSignature)
    this.setText(
      'infoRuntimeContract',
      this.metrics.trackingMode + ' | no fallback ' + (this.metrics.noFallbacks ? 'yes' : 'no') + ' | ' + this.metrics.assetMode
    )
    this.setText(
      'infoCapabilities',
      this.metrics.requiredCapabilityCount + ' req | ' + this.metrics.featureCount + ' features | ' + this.metrics.requiredCapabilities.join(', ')
    )
    this.setText('infoSmokeReport', this.metrics.smokeReportEndpoint)

    this.setText('infoWorkerState', world.workerState)
    this.setText('infoWasmState', world.wasmState)
    this.setText('infoFilterSource', world.filterSource)
    this.setText('infoFilterConfidence', Math.round(world.filterConfidence * 100) + '%')
    this.setText(
      'infoWorkerProc',
      world.workerProcMs.toFixed(3) + ' ms / lag ' + world.workerLatencyMs.toFixed(3) + ' ms'
    )
    this.setText(
      'infoResidual',
      world.residualTranslationM.toFixed(4) + ' m / ' + world.residualRotationDeg.toFixed(2) + ' deg'
    )
    this.setText(
      'infoAlpha',
      'pos ' + world.posAlpha.toFixed(3) + ' / rot ' + world.rotAlpha.toFixed(3)
    )
    this.setText('infoSnapCount', world.snapCount)
    this.setText('infoFilterFrames', world.filterFrames)
    this.setText('infoSpeed', world.speedMps.toFixed(3) + ' m/s')

    this.setText('infoCameraAccess', world.cameraAccessState)
    this.setText('infoVisualState', world.visualState)
    this.setText('infoVisualFrame', world.visualFrameSize + ' / src ' + world.visualSourceSize)
    this.setText('infoVisualQuality', Math.round(world.visualQuality * 100) + '%')
    this.setText(
      'infoVisualMetrics',
      'feat ' + world.visualFeatureCount + ' (' + world.visualFeatureDensity.toFixed(4) + ') | mot ' + world.visualMotion.toFixed(4)
    )
    this.setText(
      'infoVisualTone',
      'bright ' + world.visualBrightness.toFixed(3) + ' / contrast ' + world.visualContrast.toFixed(3)
    )
    this.setText(
      'infoVisualProc',
      world.visualCaptureMs.toFixed(3) + ' ms cap / ' + world.visualProcMs.toFixed(3) + ' ms worker'
    )
    this.setText(
      'infoTrackStats',
      'tr ' + world.trackCount + ' | mt ' + world.matchCount + ' (' + Math.round(world.matchRatio * 100) + '%) | conf ' + Math.round(world.trackConfidence * 100) + '%'
    )
    this.setText(
      'infoMapState',
      world.mapState + ' | kf ' + world.keyframeCount + ' | lm ' + world.landmarkCount + ' | reloc ' + Math.round(world.relocalizationScore * 100) + '%'
    )
    this.setText(
      'infoMotionField',
      'dx ' + world.motionVectorX.toFixed(2) + ' px | dy ' + world.motionVectorY.toFixed(2) + ' px | rot ' + world.motionRotationDeg.toFixed(2) + ' deg | vo ' + Math.round(world.visualOdometryConfidence * 100) + '%'
    )
    this.setText(
      'infoCaptureProfile',
      world.cameraCaptureMaxDimension + ' px / ' + world.cameraCaptureIntervalMs + ' ms / ' + world.framebufferScale.toFixed(1) + 'x'
    )
    this.setText(
      'infoCaptureStats',
      'cap ' + world.cameraCaptures + ' | avg ' + world.cameraAverageCaptureMs.toFixed(3) + ' ms | last ' + world.cameraLastCaptureMs.toFixed(3) + ' ms'
    )
    this.setText(
      'infoCapturePending',
      (world.cameraFramePending ? 'pending' : 'idle') + ' | throttle ' + world.cameraSkippedThrottle + ' | busy ' + world.cameraSkippedBusy
    )

    this.setText('infoPoseSource', render.lastPoseSource)
    this.setText('infoPoseAge', render.poseAgeMs + ' ms')
    this.setText('infoFrameTime', render.lastFrameMs.toFixed(2) + ' ms')
    this.setText('infoJitter', render.renderJitterMm.toFixed(2) + ' mm')

    if (snapshot) {
      const pos = snapshot.position
      this.setText('infoPosePos', pos.x.toFixed(2) + ', ' + pos.y.toFixed(2) + ', ' + pos.z.toFixed(2))
      this.setText(
        'infoPoseDist',
        Math.sqrt(pos.x * pos.x + pos.y * pos.y + pos.z * pos.z).toFixed(2) + ' m'
      )
    } else {
      this.setText('infoPosePos', '-')
      this.setText('infoPoseDist', '-')
    }
};

CustomTrackerApp.prototype.updateTrackerHud = function() {
    const world = this.worldTracker.getDiagnostics()
    const render = this.modelRenderer.getDiagnostics()

    const sessionState =
      world.sessionState === 'ACTIVE'
        ? 'good'
        : world.sessionState === 'STARTING'
          ? 'warn'
          : world.sessionState === 'ENDED' || world.sessionState === 'ERROR'
            ? 'bad'
            : 'idle'
    this.setTrackerCard(
      'trackerSession',
      sessionState,
      world.sessionState,
      world.visibilityState + ' | support ' + world.supportState.toLowerCase()
    )

    const worldState =
      world.worldState === 'TRACKING'
        ? 'good'
        : world.worldState === 'RELOCALIZING' || world.worldState === 'SCANNING'
          ? 'warn'
          : 'idle'
    this.setTrackerCard(
      'trackerWorld',
      worldState,
      world.worldState,
      world.targetState + ' | target ' + world.targetUpdates + ' | ' + world.referenceSpace
    )

    const targetState =
      world.targetState === 'TRACKING'
        ? 'good'
        : world.targetState === 'DETECTED' || world.targetState === 'REACQUIRING' || world.targetState === 'SEARCHING' || world.targetState === 'READY' || world.targetState === 'LOADED'
          ? 'warn'
          : world.targetState === 'LOST' || world.targetState === 'ERROR' || world.targetState === 'UNAVAILABLE' || world.targetState === 'REFERENCE_WEAK'
            ? 'bad'
            : 'idle'
    this.setTrackerCard(
      'trackerTarget',
      targetState,
      world.targetState,
      world.targetName + ' | ' + (world.targetVisible ? 'visible' : 'hidden') + ' | mt ' + world.targetMatchCount + ' / in ' + world.targetInlierCount + ' | ' + Math.round(world.targetConfidence * 100) + '%'
    )

    const placementState = world.hasPlacement ? 'good' : world.targetVisible ? 'warn' : 'idle'
    this.setTrackerCard(
      'trackerPlacement',
      placementState,
      world.hasPlacement ? 'PLACED' : 'UNPLACED',
      'auto target lock | placed ' + world.placementCount + ' | updates ' + world.targetUpdates
    )

    const anchorState =
      world.anchorState === 'TRACKING' || world.anchorState === 'IMAGE_TARGET'
        ? 'good'
        : world.anchorState === 'LOST'
          ? 'bad'
          : 'warn'
    this.setTrackerCard(
      'trackerAnchor',
      anchorState,
      world.anchorState,
      (world.anchorSupported ? 'anchor api' : 'image target space') + ' | ' + world.filterSource.toLowerCase()
    )

    const workerState =
      world.workerState === 'READY'
        ? 'good'
        : world.workerState === 'STARTING'
          ? 'warn'
          : world.workerState === 'ERROR'
            ? 'bad'
            : 'idle'
    this.setTrackerCard(
      'trackerWorker',
      workerState,
      world.workerState,
      world.wasmState + ' | ' + world.workerProcMs.toFixed(2) + ' ms / ' + world.workerLatencyMs.toFixed(2) + ' ms'
    )

    const visualState =
      world.visualQuality >= 0.78
        ? 'good'
        : world.visualQuality >= 0.48
          ? 'warn'
          : world.cameraAccessState === 'ERROR'
            ? 'bad'
            : 'idle'
    this.setTrackerCard(
      'trackerVisual',
      visualState,
      world.visualState,
      world.visualFrameSize + ' | q ' + Math.round(world.visualQuality * 100) + '% | tr ' + world.trackCount + ' | kf ' + world.keyframeCount
    )

    const filterState =
      world.filterConfidence >= 0.82
        ? 'good'
        : world.filterConfidence >= 0.55
          ? 'warn'
          : 'idle'
    this.setTrackerCard(
      'trackerFilter',
      filterState,
      Math.round(world.filterConfidence * 100) + '%',
      world.residualTranslationM.toFixed(4) + ' m | ' + world.residualRotationDeg.toFixed(2) + ' deg | snaps ' + world.snapCount
    )

    const imuState =
      this.metrics.imuState === 'ACTIVE'
        ? 'good'
        : this.metrics.imuState === 'UNAVAILABLE'
          ? 'warn'
          : 'idle'
    this.setTrackerCard(
      'trackerImu',
      imuState,
      this.metrics.imuState,
      this.imuManager.isActive
        ? 'delta ' + this.imuManager.getRotationMagnitude().toFixed(1) + ' deg'
        : 'optional sensor stream'
    )

    const perfState =
      world.xrFps >= 24 && world.cameraAverageCaptureMs < 10
        ? 'good'
        : world.xrFps >= 16
          ? 'warn'
          : 'bad'
    this.setTrackerCard(
      'trackerPerf',
      perfState,
      (world.xrFps || 0) + ' FPS',
      world.cameraCaptureMaxDimension + ' px / ' + world.cameraCaptureIntervalMs + ' ms | cap ' + world.cameraAverageCaptureMs.toFixed(2) + ' ms | ' + (world.cameraFramePending ? 'pending' : 'idle')
    )

    const renderState = render.renderState === 'WORLD_TRACKING' ? 'good' : 'warn'
    this.setTrackerCard(
      'trackerRender',
      renderState,
      render.renderState,
      'frame ' + render.lastFrameMs.toFixed(1) + ' ms | jitter ' + render.renderJitterMm.toFixed(1) + ' mm | scale ' + world.framebufferScale.toFixed(1) + 'x'
    )
};
