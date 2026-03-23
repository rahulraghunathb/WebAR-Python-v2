WebXRWorldTracker.prototype.setupPoseWorker = async function() {
    if (this.poseWorker && this.poseWorkerReady) {
      return
    }

    if (this.poseWorkerInitPromise) {
      return this.poseWorkerInitPromise
    }

    const previousWorkerState = this.metrics.workerState
    const previousWasmState = this.metrics.wasmState
    this.metrics.workerState = 'STARTING'
    this.metrics.wasmState = 'BOOTING'
    if (
      previousWorkerState !== this.metrics.workerState ||
      previousWasmState !== this.metrics.wasmState
    ) {
      this.emitState()
    }

    const buildSignature =
      document.querySelector('meta[name="webar-build"]')?.getAttribute('content') || ''
    const workerUrl =
      '/static/js/tracking-pose-worker.js' +
      (buildSignature ? '?v=' + encodeURIComponent(buildSignature) : '')

    this.poseWorker = new Worker(workerUrl)
    this.poseWorkerReady = false

    this.poseWorkerInitPromise = new Promise((resolve, reject) => {
      this.poseWorkerInitResolve = resolve
      this.poseWorkerInitReject = reject
    })

    this.poseWorkerInitTimeoutId = window.setTimeout(() => {
      this.handlePoseWorkerFailure('Pose worker initialization timed out.')
    }, 12000)

    this.poseWorker.onmessage = (event) => {
      const data = event.data || {}
      if (data.type === 'ready') {
        window.clearTimeout(this.poseWorkerInitTimeoutId)
        this.poseWorkerInitTimeoutId = 0
        this.poseWorkerReady = true
        this.metrics.workerState = data.payload?.workerState || 'READY'
        this.metrics.wasmState = data.payload?.wasmState || 'READY'
        const resolve = this.poseWorkerInitResolve
        this.poseWorkerInitPromise = null
        this.poseWorkerInitResolve = null
        this.poseWorkerInitReject = null
        if (resolve) {
          resolve()
        }
        this.emitState()
        this.log('Pose worker ready', data.payload || {})
        return
      }
      this.handlePoseWorkerMessage(event)
    }

    this.poseWorker.onerror = (event) => {
      const message =
        (event && event.message) || 'Pose worker crashed before producing telemetry.'
      this.handlePoseWorkerFailure(message)
    }

    this.poseWorker.postMessage({
      type: 'init',
      config: {
        featureCellSize: 18,
        featuresPerCell: 2,
        referenceFeatureLimit: 128,
        referenceMaxDimension: 384,
        targetSearchFeatures: 128,
        targetDescriptorThreshold: 0.48,
        targetRatioThreshold: 0.82,
        minTargetMatches: 6,
        minTargetInliers: 5,
        targetInlierPx: 7,
        targetRansacIterations: 160,
        targetStableFrames: 2,
        targetStableWindowMs: 420,
        targetStableMinConfidence: 0.24,
        targetStableMinInliers: 5,
        targetStableMaxReprojectionPx: 7.5,
        targetFreshPoseMs: 520,
        targetMaxStableTranslationDeltaM: 0.28,
        targetMaxStableRotationDeltaDeg: 36,
        targetPrelockAllowedMisses: 1,
        targetSingleFrameBootstrapMinMatches: 24,
        targetSingleFrameBootstrapMinInliers: 5,
        targetSingleFrameBootstrapMaxReprojectionPx: 1.2,
        targetSingleFrameBootstrapMinConfidence: 0.58,
        targetSingleFrameBootstrapMinVisualQuality: 0.62,
      },
    })

    return this.poseWorkerInitPromise
};

WebXRWorldTracker.prototype.handlePoseWorkerFailure = function(message) {
    if (this.cameraPipeline && typeof this.cameraPipeline.markFrameComplete === 'function') {
      this.cameraPipeline.markFrameComplete()
    }

    this.poseWorkerReady = false
    this.metrics.workerState = 'ERROR'
    this.metrics.wasmState = 'ERROR'
    this.metrics.cameraAccessState = 'ERROR'
    this.metrics.sessionState = 'ERROR'
    this.log('Pose worker failure', { message })

    const reject = this.poseWorkerInitReject
    this.poseWorkerInitPromise = null
    this.poseWorkerInitResolve = null
    this.poseWorkerInitReject = null
    if (reject) {
      reject(new Error(message))
    }

    this.setState('ERROR')
};

WebXRWorldTracker.prototype.destroyPoseWorker = function() {
    if (this.poseWorkerInitTimeoutId) {
      window.clearTimeout(this.poseWorkerInitTimeoutId)
      this.poseWorkerInitTimeoutId = 0
    }

    if (this.poseWorker) {
      this.poseWorker.terminate()
      this.poseWorker = null
    }

    if (this.poseWorkerInitReject) {
      this.poseWorkerInitReject(new Error('Pose worker destroyed.'))
    }

    this.poseWorkerInitPromise = null
    this.poseWorkerInitResolve = null
    this.poseWorkerInitReject = null
    this.poseWorkerReady = false
    this.metrics.workerState = 'IDLE'
    this.metrics.wasmState = 'IDLE'
};

WebXRWorldTracker.prototype.applyReferenceReady = function(payload) {
    const previousTargetState = this.metrics.targetState
    const previousReferenceReady = this.metrics.targetReferenceReady
    this.metrics.workerState = payload.workerState || this.metrics.workerState
    this.metrics.wasmState = payload.wasmState || this.metrics.wasmState
    this.metrics.targetReferenceReady = payload.referenceState === 'READY'
    this.metrics.targetReferenceFeatures = Number(payload.featureCount || 0)
    this.metrics.targetMeasuredWidthM = Number(
      payload.physicalWidthM || this.metrics.targetMeasuredWidthM || 0
    )
    this.metrics.targetName = payload.targetName || this.metrics.targetName
    if (payload.referenceState === 'READY') {
      this.metrics.targetState = this.session ? 'SEARCHING' : 'READY'
    } else {
      this.metrics.targetState = payload.referenceState || 'REFERENCE_WEAK'
    }
    this.metrics.anchorState = 'IMAGE_TARGET'
    this.log('Target reference prepared', payload)
    if (
      previousTargetState !== this.metrics.targetState ||
      previousReferenceReady !== this.metrics.targetReferenceReady
    ) {
      this.emitState()
    }
};

WebXRWorldTracker.prototype.applyPoseUpdate = function(payload) {
    const previousWorldState = this.state
    const previousTargetVisible = this.metrics.targetVisible
    const previousPlacement = this.metrics.hasPlacement

    this.metrics.workerState = payload.workerState || this.metrics.workerState
    this.metrics.wasmState = payload.wasmState || this.metrics.wasmState
    this.metrics.filterSource = payload.source || 'NONE'
    this.metrics.filterConfidence = Number(payload.confidence || 0)
    this.metrics.measurementConfidence = Number(payload.measurementConfidence || 0)
    this.metrics.baseMeasurementConfidence = Number(payload.baseMeasurementConfidence || 0)
    this.metrics.visualQuality = Number(payload.visualQuality || this.metrics.visualQuality || 0)
    this.metrics.workerProcMs = Number(payload.workerProcMs || 0)
    this.metrics.workerLatencyMs = Number(payload.workerLatencyMs || 0)
    this.metrics.residualTranslationM = Number(payload.translationResidualM || 0)
    this.metrics.residualRotationDeg = Number(payload.rotationResidualDeg || 0)
    this.metrics.measurementDeltaTranslationM = this.metrics.residualTranslationM
    this.metrics.measurementDeltaRotationDeg = this.metrics.residualRotationDeg
    this.metrics.posAlpha = Number(payload.posAlpha || 0)
    this.metrics.rotAlpha = Number(payload.rotAlpha || 0)
    this.metrics.snapCount = Number(payload.snapCount || 0)
    this.metrics.filterFrames = Number(payload.frames || 0)
    this.metrics.speedMps = Number(payload.speedMps || 0)

    if (Array.isArray(payload.matrix) && payload.matrix.length === 16) {
      this.filteredPlacementMatrix = payload.matrix.slice(0, 16)
    }

    if (payload.hasPlacement && this.filteredPlacementMatrix) {
      if (!this.metrics.hasPlacement) {
        this.metrics.placementCount += 1
      }
      this.metrics.hasPlacement = true
      this.metrics.targetVisible =
        payload.source === 'image-target' ? true : this.metrics.targetVisible
      this.metrics.targetState =
        payload.source === 'image-target' ? 'TRACKING' : this.metrics.targetState || 'TRACKING'
      this.metrics.anchorState = 'IMAGE_TARGET'
      this.modelRenderer.setWorldPlacementFromMatrix(this.filteredPlacementMatrix, {
        poseSource: String(payload.source || 'image-target').toUpperCase(),
        confidence: this.metrics.filterConfidence,
        translationResidualM: this.metrics.residualTranslationM,
        rotationResidualDeg: this.metrics.residualRotationDeg,
      })
      this.setState('TRACKING')
    }

    if (
      previousWorldState !== this.state ||
      previousTargetVisible !== this.metrics.targetVisible ||
      previousPlacement !== this.metrics.hasPlacement
    ) {
      this.emitState()
    }
};

WebXRWorldTracker.prototype.applyVisualUpdate = function(payload) {
    const previousVisualState = this.metrics.visualState
    const previousTargetState = this.metrics.targetState
    const previousTargetVisible = this.metrics.targetVisible
    const previousWorldState = this.state

    if (this.cameraPipeline && typeof this.cameraPipeline.markFrameComplete === 'function') {
      this.cameraPipeline.markFrameComplete()
    }

    this.metrics.workerState = payload.workerState || this.metrics.workerState
    this.metrics.wasmState = payload.wasmState || this.metrics.wasmState
    this.metrics.visualState = payload.state || this.metrics.visualState
    this.metrics.visualQuality = Number(payload.quality || 0)
    this.metrics.visualBrightness = Number(payload.brightness || 0)
    this.metrics.visualContrast = Number(payload.contrast || 0)
    this.metrics.visualMotion = Number(payload.motion || 0)
    this.metrics.visualFeatureCount = Number(payload.featureCount || 0)
    this.metrics.visualFeatureDensity = Number(payload.featureDensity || 0)
    this.metrics.trackCount = Number(payload.trackCount || 0)
    this.metrics.averageTrackAge = Number(payload.averageTrackAge || 0)
    this.metrics.maxTrackAge = Number(payload.maxTrackAge || 0)
    this.metrics.longTrackRatio = Number(payload.longTrackRatio || 0)
    this.metrics.matchCount = Number(payload.matchCount || 0)
    this.metrics.matchRatio = Number(payload.matchRatio || 0)
    this.metrics.trackConfidence = Number(payload.trackConfidence || 0)
    this.metrics.keyframeCount = Number(payload.keyframeCount || 0)
    this.metrics.landmarkCount = Number(payload.landmarkCount || 0)
    this.metrics.stableLandmarkCount = Number(payload.stableLandmarkCount || 0)
    this.metrics.staleLandmarkCount = Number(payload.staleLandmarkCount || 0)
    this.metrics.staleLandmarkRatio = Number(payload.staleLandmarkRatio || 0)
    this.metrics.keyframeGrowthPerSec = Number(payload.keyframeGrowthPerSec || 0)
    this.metrics.landmarkGrowthPerSec = Number(payload.landmarkGrowthPerSec || 0)
    this.metrics.motionObservability = Number(payload.motionObservability || 0)
    this.metrics.mapState = payload.mapState || this.metrics.mapState
    this.metrics.relocalizationScore = Number(payload.relocalizationScore || 0)
    this.metrics.relocalizationKeyframeId = Number(payload.relocalizationKeyframeId || -1)
    this.metrics.relocalizationAttemptCount = Number(payload.relocalizationAttemptCount || 0)
    this.metrics.relocalizationRecoveryCount = Number(payload.relocalizationRecoveryCount || 0)
    this.metrics.lastRelocalizationDurationMs = Number(payload.lastRelocalizationDurationMs || 0)
    this.metrics.currentRelocalizationDurationMs = Number(payload.currentRelocalizationDurationMs || 0)
    this.metrics.motionVectorX = Number(payload.motionX || 0)
    this.metrics.motionVectorY = Number(payload.motionY || 0)
    this.metrics.motionScale = Number(payload.motionScale || 1)
    this.metrics.motionRotationDeg = Number(payload.motionRotationDeg || 0)
    this.metrics.visualOdometryConfidence = Number(payload.visualOdometryConfidence || 0)
    this.metrics.visualFrames = Number(payload.frames || 0)
    this.metrics.visualCaptureMs = Number(payload.captureMs || 0)
    this.metrics.visualProcMs = Number(payload.procMs || 0)
    this.metrics.targetMatchCount = Number(payload.targetMatchCount || 0)
    this.metrics.targetInlierCount = Number(payload.targetInlierCount || 0)
    this.metrics.targetInlierRatio = Number(payload.targetInlierRatio || 0)
    this.metrics.targetConfidence = Number(payload.targetConfidence || 0)
    this.metrics.targetReprojectionPx = Number(payload.targetReprojectionPx || 0)
    this.metrics.targetUpdates = Number(payload.targetUpdates || 0)
    this.metrics.targetStableFrames = Number(payload.targetStableFrames || 0)
    this.metrics.targetPrelockMisses = Number(payload.targetPrelockMisses || 0)
    this.metrics.targetRejectReason = String(payload.targetRejectReason || 'NONE')
    this.metrics.targetBestInliers = Number(payload.targetBestInliers || 0)
    this.metrics.targetRefinedInliers = Number(payload.targetRefinedInliers || 0)
    this.metrics.targetRawMatchCount = Number(payload.targetRawMatchCount || 0)
    this.metrics.targetReciprocalMatchCount = Number(payload.targetReciprocalMatchCount || 0)
    this.metrics.targetMatchStrategy = String(payload.targetMatchStrategy || 'NONE')
    this.metrics.targetReferenceReady = Boolean(payload.targetReferenceReady)
    this.metrics.targetReferenceFeatures = Number(payload.targetReferenceFeatures || 0)
    this.metrics.targetState = payload.targetState || this.metrics.targetState
    this.metrics.targetVisible = Boolean(payload.targetVisible)
    this.metrics.visualFrameSize =
      payload.width && payload.height
        ? payload.width + 'x' + payload.height
        : this.metrics.visualFrameSize
    this.metrics.visualSourceSize =
      payload.sourceWidth && payload.sourceHeight
        ? payload.sourceWidth + 'x' + payload.sourceHeight
        : this.metrics.visualSourceSize

    if (this.metrics.hasPlacement) {
      this.setState(this.metrics.targetVisible ? 'TRACKING' : 'RELOCALIZING')
    } else {
      this.setState('SCANNING')
    }

    if (
      previousVisualState !== this.metrics.visualState ||
      previousTargetState !== this.metrics.targetState ||
      previousTargetVisible !== this.metrics.targetVisible ||
      previousWorldState !== this.state
    ) {
      this.emitState()
    }
};

WebXRWorldTracker.prototype.applyResetComplete = function(payload) {
    const previousState = this.state
    this.metrics.workerState = payload.workerState || this.metrics.workerState
    this.metrics.wasmState = payload.wasmState || this.metrics.wasmState
    this.metrics.hasPlacement = false
    this.metrics.targetVisible = false
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
    this.metrics.targetState = this.metrics.targetReferenceReady
      ? this.session
        ? 'SEARCHING'
        : 'READY'
      : 'UNINITIALIZED'
    this.metrics.anchorState = this.session ? 'IMAGE_TARGET' : 'UNAVAILABLE'
    this.filteredPlacementMatrix = null
    if (this.session) {
      this.setState('SCANNING')
    } else {
      this.setState('IDLE')
    }
    if (previousState !== this.state) {
      this.emitState()
    }
};

WebXRWorldTracker.prototype.handlePoseWorkerMessage = function(event) {
    const data = event.data || {}
    const payload = data.payload || {}

    if (data.type === 'reference-ready') {
      this.applyReferenceReady(payload)
      return
    }

    if (data.type === 'pose-update') {
      this.applyPoseUpdate(payload)
      return
    }

    if (data.type === 'visual-update') {
      this.applyVisualUpdate(payload)
      return
    }

    if (data.type === 'reset-complete') {
      this.applyResetComplete(payload)
      return
    }

    if (data.type === 'config-updated') {
      this.log('Pose worker config updated', payload.config || {})
      return
    }

    if (data.type === 'error') {
      const message = payload.message || 'Worker processing failed.'
      this.handlePoseWorkerFailure(message)
    }
};

WebXRWorldTracker.prototype.postVisualFrame = function(capture, viewerPose) {
    if (!this.poseWorker || !this.poseWorkerReady || !capture || !viewerPose) {
      return false
    }

    const view = viewerPose.views && viewerPose.views[0]
    if (!view || !view.transform || !view.projectionMatrix) {
      return false
    }

    const payload = {
      width: Number(capture.width || 0),
      height: Number(capture.height || 0),
      sourceWidth: Number(capture.sourceWidth || 0),
      sourceHeight: Number(capture.sourceHeight || 0),
      captureMs: Number(capture.captureMs || 0),
      timestampMs: Number(capture.timestampMs || performance.now()),
      sentAtMs: performance.now(),
      cameraMatrix: Array.from(view.transform.matrix || []),
      projectionMatrix: Array.from(view.projectionMatrix || []),
      pixels: capture.pixels,
    }

    this.poseWorker.postMessage({ type: 'visual-frame', payload }, [capture.pixels])
    return true
};
