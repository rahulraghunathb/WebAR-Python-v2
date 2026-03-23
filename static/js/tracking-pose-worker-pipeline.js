function buildConfidence(measurementConfidence, translationResidualM, rotationResidualDegValue, visualQuality, trackConfidence, relocalizationScore) {
  const translationScore = 1 - Math.min(1, translationResidualM / Math.max(0.001, state.config.snapTranslationM))
  const rotationScore = 1 - Math.min(1, rotationResidualDegValue / Math.max(0.001, state.config.snapRotationDeg))
  return clamp01(
    measurementConfidence * 0.4 +
    translationScore * 0.16 +
    rotationScore * 0.14 +
    clamp01(visualQuality) * 0.12 +
    clamp01(trackConfidence) * 0.1 +
    clamp01(relocalizationScore) * 0.08
  )
}


function getVisualQualityForSource(source, timestampMs) {
  const visualAgeMs = state.visual.lastTimestampMs ? Math.max(0, timestampMs - state.visual.lastTimestampMs) : 9999
  const freshness = visualAgeMs < 200 ? 1 : visualAgeMs < 420 ? 0.72 : 0.45
  const baseQuality = state.visual.frames > 0 ? state.visual.quality : 0.45
  const trackSupport = mix(0.6, 1, state.visual.trackConfidence || 0)
  const mapSupport = mix(0.7, 1, state.visual.relocalizationScore || 0)
  const freshnessAdjusted = clamp01(baseQuality * freshness * trackSupport * mapSupport)

  if (source === 'anchor' || source === 'image-target') {
    return clamp01(0.72 + freshnessAdjusted * 0.28)
  }
  if (source === 'placement-lock') {
    return clamp01(0.74 + freshnessAdjusted * 0.26)
  }
  return clamp01(0.38 + freshnessAdjusted * 0.62)
}


function processMeasurement(payload) {
  if (!state.ready || !state.wasm) {
    return
  }

  const processingStartedAt = nowMs()
  const matrix = Array.isArray(payload.matrix) ? payload.matrix.slice(0, 16) : []
  if (matrix.length !== 16 || matrix.some((value) => !isFinite(value))) {
    post('error', { message: 'Invalid measurement matrix.' })
    return
  }

  const measurement = decomposePoseMatrix(matrix)
  const baseMeasurementConfidence = clamp01(typeof payload.confidence === 'number' ? payload.confidence : 0.7)
  const timestampMs = Number(payload.timestampMs || processingStartedAt)
  const dtMs = state.initialized
    ? Math.max(state.config.minDtMs, Math.min(state.config.maxDtMs, timestampMs - state.lastTimestampMs || 16.7))
    : 16.7

  const source = payload.source || 'surface'
  const visualQuality = getVisualQualityForSource(source, timestampMs)
  const visualSupport = clamp01(state.visual.trackConfidence * 0.65 + state.visual.relocalizationScore * 0.35)
  const measurementConfidence = clamp01(baseMeasurementConfidence * visualQuality * mix(0.58, 1, visualSupport))
  const translationResidualM = state.initialized ? distance3(state.filteredPosition, measurement.position) : 0
  const rotationResidual = state.initialized ? rotationResidualDeg(state.filteredQuaternion, measurement.quaternion) : 0

  const sourcePosBoost = source === 'anchor' || source === 'image-target'
    ? state.config.anchorPosBoost
    : source === 'placement-lock'
      ? state.config.lockPosBoost
      : state.config.surfacePosBoost
  const sourceRotBoost = source === 'anchor' || source === 'image-target'
    ? state.config.anchorRotBoost
    : source === 'placement-lock'
      ? state.config.lockRotBoost
      : state.config.surfaceRotBoost
  const odometryBlend = mix(0.62, 1, state.visual.visualOdometryConfidence)
  const visualBlend = mix(0.55, 1, visualQuality) * odometryBlend
  const posAlpha = clamp01((state.config.basePosAlpha + sourcePosBoost + measurementConfidence * 0.28) * visualBlend)
  const rotAlpha = clamp01((state.config.baseRotAlpha + sourceRotBoost + measurementConfidence * 0.3) * visualBlend)
  const snap = !state.initialized || Boolean(payload.forceSnap) || translationResidualM > state.config.snapTranslationM || rotationResidual > state.config.snapRotationDeg
  const previousPosition = state.filteredPosition.slice()

  if (snap) {
    state.filteredPosition = measurement.position.slice()
    state.filteredQuaternion = measurement.quaternion.slice()
    state.velocity = [0, 0, 0]
    state.snapCount += 1
  } else {
    state.filteredPosition = [
      mix(state.filteredPosition[0], measurement.position[0], posAlpha),
      mix(state.filteredPosition[1], measurement.position[1], posAlpha),
      mix(state.filteredPosition[2], measurement.position[2], posAlpha),
    ]
    state.filteredQuaternion = slerpQuaternion(state.filteredQuaternion, measurement.quaternion, rotAlpha)
    const nextVelocity = [
      (state.filteredPosition[0] - previousPosition[0]) / (dtMs / 1000),
      (state.filteredPosition[1] - previousPosition[1]) / (dtMs / 1000),
      (state.filteredPosition[2] - previousPosition[2]) / (dtMs / 1000),
    ]
    state.velocity = [
      mix(state.velocity[0], nextVelocity[0], state.config.velocityBlend),
      mix(state.velocity[1], nextVelocity[1], state.config.velocityBlend),
      mix(state.velocity[2], nextVelocity[2], state.config.velocityBlend),
    ]
  }

  state.initialized = true
  state.frames += 1
  state.lastTimestampMs = timestampMs
  state.lastSource = source

  const filterConfidence = buildConfidence(measurementConfidence, translationResidualM, rotationResidual, state.visual.quality, state.visual.trackConfidence, state.visual.relocalizationScore)
  const outputMatrix = composeMatrix(state.filteredPosition, state.filteredQuaternion)
  const workerProcMs = nowMs() - processingStartedAt
  const workerLatencyMs = Math.max(0, nowMs() - Number(payload.sentAtMs || processingStartedAt))
  const speedMps = Math.hypot(state.velocity[0], state.velocity[1], state.velocity[2])

  post('pose-update', {
    id: payload.id,
    source,
    matrix: outputMatrix,
    confidence: filterConfidence,
    measurementConfidence,
    baseMeasurementConfidence,
    visualQuality: state.visual.quality,
    trackConfidence: Number(state.visual.trackConfidence.toFixed(3)),
    keyframeCount: state.visual.keyframeCount,
    landmarkCount: state.visual.landmarkCount,
    mapState: state.visual.mapState,
    relocalizationScore: Number(state.visual.relocalizationScore.toFixed(3)),
    translationResidualM: Number(translationResidualM.toFixed(4)),
    rotationResidualDeg: Number(rotationResidual.toFixed(2)),
    posAlpha: Number(posAlpha.toFixed(3)),
    rotAlpha: Number(rotAlpha.toFixed(3)),
    workerProcMs: Number(workerProcMs.toFixed(3)),
    workerLatencyMs: Number(workerLatencyMs.toFixed(3)),
    speedMps: Number(speedMps.toFixed(3)),
    snap,
    snapCount: state.snapCount,
    frames: state.frames,
    workerState: state.workerState,
    wasmState: state.wasmState,
    hasPlacement: Boolean(payload.hasPlacement),
  })
}


function analyzeVisualFrame(payload) {
  if (!state.ready || !state.wasm) {
    return
  }

  const width = Number(payload.width || 0)
  const height = Number(payload.height || 0)
  const sourceWidth = Number(payload.sourceWidth || width)
  const sourceHeight = Number(payload.sourceHeight || height)
  if (!width || !height || !payload.pixels) {
    post('error', { message: 'Invalid visual frame payload.' })
    return
  }

  const startedAt = nowMs()
  const rgba = new Uint8Array(payload.pixels)
  const pixelCount = width * height
  if (rgba.length < pixelCount * 4) {
    post('error', { message: 'Visual frame buffer is too small.' })
    return
  }

  const grayStats = rgbaToGray(rgba, width, height)
  const gray = grayStats.gray
  const meanBrightness = grayStats.brightnessSum / pixelCount
  const variance = Math.max(0, grayStats.brightnessSqSum / pixelCount - meanBrightness * meanBrightness)
  const contrastStd = Math.sqrt(variance)
  let photometricMotionAccumulator = 0
  let photometricMotionSamples = 0
  if (state.visual.prevGray && state.visual.prevGray.length === gray.length) {
    for (let index = 0; index < gray.length; index += 4) {
      photometricMotionAccumulator += Math.abs(gray[index] - state.visual.prevGray[index])
      photometricMotionSamples += 1
    }
  }

  const features = detectFeatures(gray, width, height)
  const matches = matchFeatures(state.visual.prevFeatures, features, width, height)
  const motionEstimate = estimateRelativeMotion(matches)
  const photometricMotion = photometricMotionSamples > 0 ? photometricMotionAccumulator / photometricMotionSamples / 255 : 0
  const geometricMotion = clamp01(motionEstimate.magnitudePx / Math.max(8, Math.min(width, height) * 0.14))
  const motion = clamp01(photometricMotion * 0.45 + geometricMotion * 0.55)

  state.visual.frames += 1
  state.visual.motionX = Number(motionEstimate.dx.toFixed(3))
  state.visual.motionY = Number(motionEstimate.dy.toFixed(3))
  state.visual.motionScale = Number(motionEstimate.scale.toFixed(4))
  state.visual.motionRotationDeg = Number(motionEstimate.rotationDeg.toFixed(3))
  state.visual.motion = Number(motion.toFixed(4))

  updateMapState(features, matches, motionEstimate, Number(payload.timestampMs || nowMs()))

  const brightnessScore = 1 - Math.min(1, Math.abs(meanBrightness - 128) / 128)
  const contrastScore = clamp01(contrastStd / 56)
  const featureDensity = features.length / Math.max(1, Math.floor(pixelCount / 512))
  const featureScore = clamp01(featureDensity / 0.85)
  const stabilityScore = clamp01(1 - motion / 0.36)
  const lowFeaturePenalty = features.length < 8 ? mix(0.28, 1, clamp01(features.length / 8)) : 1
  const quality = clamp01((
    featureScore * 0.28 +
    contrastScore * 0.2 +
    brightnessScore * 0.12 +
    stabilityScore * 0.12 +
    state.visual.trackConfidence * 0.18 +
    state.visual.relocalizationScore * 0.1
  ) * lowFeaturePenalty)

  const motionExcitation = clamp01(state.visual.motion / 0.12) * clamp01(1 - Math.max(0, state.visual.motion - 0.38) / 0.42)
  const motionObservability = clamp01(
    featureScore * 0.32 +
    contrastScore * 0.2 +
    state.visual.matchRatio * 0.16 +
    state.visual.trackConfidence * 0.16 +
    motionExcitation * 0.16
  )

  state.visual.state = state.visual.mapState
  state.visual.quality = quality
  state.visual.motionObservability = motionObservability
  state.visual.brightness = meanBrightness / 255
  state.visual.contrast = contrastScore
  state.visual.featureCount = features.length
  state.visual.featureDensity = featureDensity
  state.visual.width = width
  state.visual.height = height
  state.visual.sourceWidth = sourceWidth
  state.visual.sourceHeight = sourceHeight
  state.visual.captureMs = Number(payload.captureMs || 0)
  state.visual.procMs = Number((nowMs() - startedAt).toFixed(3))
  state.visual.lastTimestampMs = Number(payload.timestampMs || nowMs())
  state.visual.prevGray = gray

  const referenceMatches = state.reference.ready
    ? matchReferenceFeatures(state.reference.features, features)
    : []
  const targetEstimate = state.reference.ready
    ? estimateTargetPose(
        referenceMatches,
        Array.isArray(payload.projectionMatrix) ? payload.projectionMatrix.slice(0, 16) : null,
        Array.isArray(payload.cameraMatrix) ? payload.cameraMatrix.slice(0, 16) : null,
        width,
        height,
        quality
      )
    : null

  state.reference.matchCount = referenceMatches.length
  state.reference.inlierCount = targetEstimate ? targetEstimate.inlierCount : 0
  state.reference.reprojectionPx = targetEstimate ? Number(targetEstimate.reprojectionPx.toFixed(3)) : 0
  state.reference.confidence = targetEstimate ? Number(targetEstimate.confidence.toFixed(3)) : 0
  const frameTimestampMs = Number(payload.timestampMs || nowMs())
  const {
    freshPoseMs,
    trackHoldMs,
    lostHoldMs,
    stableWindowMs,
    stableFramesRequired,
    stableMinConfidence,
    stableMinInliers,
    stableMaxReprojectionPx,
    detectedMatchFloor,
    minTargetMatches,
    singleFrameBootstrapMinMatches,
    singleFrameBootstrapMinInliers,
    singleFrameBootstrapMaxReprojectionPx,
    singleFrameBootstrapMinConfidence,
    singleFrameBootstrapMinVisualQuality,
  } = readTargetTrackingConfig()
  trimReferenceLockSamples(frameTimestampMs, stableWindowMs)

  if (targetEstimate) {
    const estimatePose = decomposePoseMatrix(targetEstimate.worldMatrix)
    const stableEligible =
      targetEstimate.confidence >= stableMinConfidence &&
      targetEstimate.inlierCount >= stableMinInliers &&
      targetEstimate.reprojectionPx <= stableMaxReprojectionPx
    const stableSampleConsistent = isTargetSampleConsistent(
      state.reference.lockSamples,
      estimatePose
    )

    if (stableEligible && stableSampleConsistent) {
      pushReferenceLockSample(frameTimestampMs, targetEstimate, estimatePose, stableWindowMs)
    } else {
      clearInitialReferenceLockIfNeeded(false)
    }

    state.reference.stableFrames = state.reference.lockSamples.length
    const averagedTargetEstimate = averageTargetLockSamples(state.reference.lockSamples)
    const canSingleFrameBootstrap =
      !state.initialized &&
      stableEligible &&
      targetEstimate.matchCount >= singleFrameBootstrapMinMatches &&
      targetEstimate.inlierCount >= singleFrameBootstrapMinInliers &&
      targetEstimate.reprojectionPx <= singleFrameBootstrapMaxReprojectionPx &&
      targetEstimate.confidence >= singleFrameBootstrapMinConfidence &&
      quality >= singleFrameBootstrapMinVisualQuality
    const canCommitInitialLock =
      canSingleFrameBootstrap ||
      (!state.initialized && Boolean(averagedTargetEstimate) && state.reference.stableFrames >= stableFramesRequired)
    const canRefreshTrackedPose =
      state.initialized && Boolean(averagedTargetEstimate) && (
        stableEligible || state.reference.stableFrames >= Math.max(2, stableFramesRequired - 1)
      )

    if (canCommitInitialLock || canRefreshTrackedPose) {
      const resolvedEstimate = canSingleFrameBootstrap
        ? {
            matrix: targetEstimate.worldMatrix,
            confidence: targetEstimate.confidence,
          }
        : averagedTargetEstimate || {
        matrix: targetEstimate.worldMatrix,
        confidence: targetEstimate.confidence,
      }
      state.reference.state = 'TRACKING'
      state.reference.lastSeenTimestampMs = frameTimestampMs
      state.reference.lastSolvedPoseTimestampMs = frameTimestampMs
      state.reference.confidence = Number(Math.max(targetEstimate.confidence, resolvedEstimate.confidence || 0).toFixed(3))
      state.reference.updates += 1
      processMeasurement({
        id: 'target-' + state.visual.frames,
        source: 'image-target',
        matrix: resolvedEstimate.matrix,
        confidence: state.reference.confidence,
        forceSnap: canCommitInitialLock || !state.initialized,
        hasPlacement: true,
        timestampMs: frameTimestampMs,
        sentAtMs: Number(payload.sentAtMs || startedAt),
      })
    } else {
      state.reference.state = 'DETECTED'
      state.reference.confidence = Number(Math.max(targetEstimate.confidence, 0).toFixed(3))
    }
  } else if (!state.reference.ready) {
    state.reference.state = 'UNINITIALIZED'
    clearReferenceLockTracking()
  } else if (referenceMatches.length >= Math.max(4, minTargetMatches - 2)) {
    const freshPoseAgeMs = state.reference.lastSolvedPoseTimestampMs
      ? frameTimestampMs - state.reference.lastSolvedPoseTimestampMs
      : Number.POSITIVE_INFINITY
    const poseFreshness = clamp01(1 - freshPoseAgeMs / Math.max(1, freshPoseMs))
    state.reference.state = poseFreshness > 0.15 ? 'REACQUIRING' : 'DETECTED'
    state.reference.confidence = Number(clamp01(
      0.18 +
      clamp01(referenceMatches.length / Math.max(1, minTargetMatches)) * 0.28 +
      clamp01(quality) * 0.2 +
      clamp01(state.visual.trackConfidence) * 0.18 +
      poseFreshness * 0.16
    ).toFixed(3))
    clearInitialReferenceLockIfNeeded(false)
  } else if (
    state.reference.lastSeenTimestampMs &&
    frameTimestampMs - state.reference.lastSeenTimestampMs < trackHoldMs &&
    referenceMatches.length >= detectedMatchFloor
  ) {
    const freshPoseAgeMs = state.reference.lastSolvedPoseTimestampMs
      ? frameTimestampMs - state.reference.lastSolvedPoseTimestampMs
      : Number.POSITIVE_INFINITY
    const poseFreshness = clamp01(1 - freshPoseAgeMs / Math.max(1, freshPoseMs))
    state.reference.state = poseFreshness > 0.15 ? 'REACQUIRING' : 'LOST'
    state.reference.confidence = Number(clamp01(
      0.12 +
      clamp01(referenceMatches.length / Math.max(1, minTargetMatches)) * 0.22 +
      clamp01(quality) * 0.16 +
      poseFreshness * 0.14
    ).toFixed(3))
  } else if (state.reference.lastSeenTimestampMs && frameTimestampMs - state.reference.lastSeenTimestampMs < lostHoldMs) {
    state.reference.state = state.reference.updates > 0 ? 'REACQUIRING' : 'LOST'
    const lostAgeMs = frameTimestampMs - state.reference.lastSeenTimestampMs
    state.reference.confidence = Number(clamp01(
      Math.max(0, 0.28 - lostAgeMs / Math.max(1, lostHoldMs * 1.6))
    ).toFixed(3))
    clearInitialReferenceLockIfNeeded(false)
  } else {
    state.reference.state = 'SEARCHING'
    state.reference.confidence = 0
    clearInitialReferenceLockIfNeeded(false)
  }
  post('visual-update', {
    state: state.visual.state,
    quality: Number(state.visual.quality.toFixed(3)),
    brightness: Number(state.visual.brightness.toFixed(3)),
    contrast: Number(state.visual.contrast.toFixed(3)),
    motion: Number(state.visual.motion.toFixed(4)),
    featureCount: state.visual.featureCount,
    featureDensity: Number(state.visual.featureDensity.toFixed(4)),
    trackCount: state.visual.trackCount,
    averageTrackAge: Number(state.visual.averageTrackAge.toFixed(3)),
    maxTrackAge: Number(state.visual.maxTrackAge.toFixed(3)),
    longTrackRatio: Number(state.visual.longTrackRatio.toFixed(3)),
    matchCount: state.visual.matchCount,
    matchRatio: Number(state.visual.matchRatio.toFixed(3)),
    trackConfidence: Number(state.visual.trackConfidence.toFixed(3)),
    keyframeCount: state.visual.keyframeCount,
    landmarkCount: state.visual.landmarkCount,
    stableLandmarkCount: state.visual.stableLandmarkCount,
    staleLandmarkCount: state.visual.staleLandmarkCount,
    staleLandmarkRatio: Number(state.visual.staleLandmarkRatio.toFixed(3)),
    keyframeGrowthPerSec: Number(state.visual.keyframeGrowthPerSec.toFixed(3)),
    landmarkGrowthPerSec: Number(state.visual.landmarkGrowthPerSec.toFixed(3)),
    motionObservability: Number(state.visual.motionObservability.toFixed(3)),
    mapState: state.visual.mapState,
    relocalizationScore: Number(state.visual.relocalizationScore.toFixed(3)),
    relocalizationKeyframeId: state.visual.relocalizationKeyframeId,
    relocalizationAttemptCount: state.visual.relocalizationAttemptCount,
    relocalizationRecoveryCount: state.visual.relocalizationRecoveryCount,
    lastRelocalizationDurationMs: Number(state.visual.lastRelocalizationDurationMs.toFixed(2)),
    currentRelocalizationDurationMs: Number(state.visual.currentRelocalizationDurationMs.toFixed(2)),
    motionX: Number(state.visual.motionX.toFixed(3)),
    motionY: Number(state.visual.motionY.toFixed(3)),
    motionScale: Number(state.visual.motionScale.toFixed(4)),
    motionRotationDeg: Number(state.visual.motionRotationDeg.toFixed(3)),
    visualOdometryConfidence: Number(state.visual.visualOdometryConfidence.toFixed(3)),
    targetState: state.reference.state,
    targetVisible: state.reference.state === 'TRACKING',
    targetMatchCount: state.reference.matchCount,
    targetInlierCount: state.reference.inlierCount,
    targetInlierRatio: Number((state.reference.matchCount ? state.reference.inlierCount / state.reference.matchCount : 0).toFixed(3)),
    targetConfidence: Number(state.reference.confidence.toFixed(3)),
    targetReprojectionPx: Number(state.reference.reprojectionPx.toFixed(3)),
    targetUpdates: state.reference.updates,
    targetStableFrames: state.reference.stableFrames,
    targetPrelockMisses: state.reference.prelockMisses,
    targetRejectReason: state.reference.rejectReason,
    targetBestInliers: state.reference.bestInliers,
    targetRefinedInliers: state.reference.refinedInliers,
    targetRawMatchCount: state.reference.rawMatchCount,
    targetReciprocalMatchCount: state.reference.reciprocalMatchCount,
    targetMatchStrategy: state.reference.matchStrategy,
    targetReferenceReady: state.reference.ready,
    targetReferenceFeatures: state.reference.featureCount,
    frames: state.visual.frames,
    width: state.visual.width,
    height: state.visual.height,
    sourceWidth: state.visual.sourceWidth,
    sourceHeight: state.visual.sourceHeight,
    captureMs: Number(state.visual.captureMs.toFixed(3)),
    procMs: Number(state.visual.procMs.toFixed(3)),
    workerState: state.workerState,
    wasmState: state.wasmState,
  })
}

