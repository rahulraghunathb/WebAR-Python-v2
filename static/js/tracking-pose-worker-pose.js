function normalizeQuaternion(quaternion) {
  const q = quaternion.slice(0, 4)
  const length = Math.hypot(q[0], q[1], q[2], q[3]) || 1
  return [q[0] / length, q[1] / length, q[2] / length, q[3] / length]
}


function quaternionFromMatrix(matrix) {
  const m11 = matrix[0]
  const m12 = matrix[4]
  const m13 = matrix[8]
  const m21 = matrix[1]
  const m22 = matrix[5]
  const m23 = matrix[9]
  const m31 = matrix[2]
  const m32 = matrix[6]
  const m33 = matrix[10]
  const trace = m11 + m22 + m33
  let x = 0
  let y = 0
  let z = 0
  let w = 1

  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1)
    w = 0.25 / s
    x = (m32 - m23) * s
    y = (m13 - m31) * s
    z = (m21 - m12) * s
  } else if (m11 > m22 && m11 > m33) {
    const s = 2 * Math.sqrt(1 + m11 - m22 - m33)
    w = (m32 - m23) / s
    x = 0.25 * s
    y = (m12 + m21) / s
    z = (m13 + m31) / s
  } else if (m22 > m33) {
    const s = 2 * Math.sqrt(1 + m22 - m11 - m33)
    w = (m13 - m31) / s
    x = (m12 + m21) / s
    y = 0.25 * s
    z = (m23 + m32) / s
  } else {
    const s = 2 * Math.sqrt(1 + m33 - m11 - m22)
    w = (m21 - m12) / s
    x = (m13 + m31) / s
    y = (m23 + m32) / s
    z = 0.25 * s
  }

  return normalizeQuaternion([x, y, z, w])
}


function composeMatrix(position, quaternion) {
  const q = normalizeQuaternion(quaternion)
  const x = q[0]
  const y = q[1]
  const z = q[2]
  const w = q[3]
  const x2 = x + x
  const y2 = y + y
  const z2 = z + z
  const xx = x * x2
  const xy = x * y2
  const xz = x * z2
  const yy = y * y2
  const yz = y * z2
  const zz = z * z2
  const wx = w * x2
  const wy = w * y2
  const wz = w * z2

  return [
    1 - (yy + zz), xy + wz, xz - wy, 0,
    xy - wz, 1 - (xx + zz), yz + wx, 0,
    xz + wy, yz - wx, 1 - (xx + yy), 0,
    position[0], position[1], position[2], 1,
  ]
}


function slerpQuaternion(source, target, t) {
  let from = normalizeQuaternion(source)
  let to = normalizeQuaternion(target)
  let dot = from[0] * to[0] + from[1] * to[1] + from[2] * to[2] + from[3] * to[3]
  if (dot < 0) {
    dot = -dot
    to = [-to[0], -to[1], -to[2], -to[3]]
  }
  if (dot > 0.9995) {
    return normalizeQuaternion([mix(from[0], to[0], t), mix(from[1], to[1], t), mix(from[2], to[2], t), mix(from[3], to[3], t)])
  }
  const theta0 = Math.acos(Math.min(1, Math.max(-1, dot)))
  const sinTheta0 = Math.sin(theta0) || 1
  const theta = theta0 * t
  const sinTheta = Math.sin(theta)
  const s0 = Math.cos(theta) - dot * sinTheta / sinTheta0
  const s1 = sinTheta / sinTheta0
  return normalizeQuaternion([s0 * from[0] + s1 * to[0], s0 * from[1] + s1 * to[1], s0 * from[2] + s1 * to[2], s0 * from[3] + s1 * to[3]])
}


function rotationResidualDeg(source, target) {
  const dot = quatDotAbs(normalizeQuaternion(source), normalizeQuaternion(target))
  return 2 * Math.acos(Math.min(1, Math.max(0, dot))) * 180 / Math.PI
}


function decomposePoseMatrix(matrix) {
  return { position: [matrix[12], matrix[13], matrix[14]], quaternion: quaternionFromMatrix(matrix) }
}


function quaternionDot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]
}


function averageTargetLockSamples(samples) {
  if (!samples || !samples.length) {
    return null
  }

  let totalWeight = 0
  const position = [0, 0, 0]
  let quaternionAccumulator = null
  let weightedConfidence = 0
  let weightedReprojection = 0
  let maxInliers = 0

  for (const sample of samples) {
    const confidence = clamp01(sample.confidence || 0)
    const inlierCount = Number(sample.inlierCount || 0)
    const reprojectionPx = Number(sample.reprojectionPx || 0)
    const weight = Math.max(0.5, 1 + confidence * 0.8 + inlierCount * 0.14)
    totalWeight += weight
    position[0] += sample.position[0] * weight
    position[1] += sample.position[1] * weight
    position[2] += sample.position[2] * weight

    let quaternion = sample.quaternion.slice(0, 4)
    if (!quaternionAccumulator) {
      quaternionAccumulator = [0, 0, 0, 0]
    } else if (quaternionDot(quaternionAccumulator, quaternion) < 0) {
      quaternion = [-quaternion[0], -quaternion[1], -quaternion[2], -quaternion[3]]
    }

    quaternionAccumulator[0] += quaternion[0] * weight
    quaternionAccumulator[1] += quaternion[1] * weight
    quaternionAccumulator[2] += quaternion[2] * weight
    quaternionAccumulator[3] += quaternion[3] * weight
    weightedConfidence += confidence * weight
    weightedReprojection += reprojectionPx * weight
    maxInliers = Math.max(maxInliers, inlierCount)
  }

  if (!totalWeight || !quaternionAccumulator) {
    return null
  }

  const averagedPosition = [
    position[0] / totalWeight,
    position[1] / totalWeight,
    position[2] / totalWeight,
  ]
  const averagedQuaternion = normalizeQuaternion(quaternionAccumulator)

  return {
    matrix: composeMatrix(averagedPosition, averagedQuaternion),
    position: averagedPosition,
    quaternion: averagedQuaternion,
    confidence: weightedConfidence / totalWeight,
    inlierCount: maxInliers,
    reprojectionPx: weightedReprojection / totalWeight,
  }
}


function isTargetSampleConsistent(samples, estimatePose) {
  if (!samples || !samples.length || !estimatePose) {
    return true
  }
  const translationLimit = Math.max(
    0.03,
    Number(state.config.targetMaxStableTranslationDeltaM || 0.18)
  )
  const rotationLimitDeg = Math.max(
    4,
    Number(state.config.targetMaxStableRotationDeltaDeg || 26)
  )
  const latestSample = samples[samples.length - 1]
  const translationDelta = distance3(latestSample.position, estimatePose.position)
  if (translationDelta > translationLimit) {
    return false
  }
  const rotationDelta = rotationResidualDeg(latestSample.quaternion, estimatePose.quaternion)
  return rotationDelta <= rotationLimitDeg
}


function clearReferenceLockTracking() {
  state.reference.stableFrames = 0
  state.reference.lockSamples = []
  state.reference.prelockMisses = 0
}


function clearInitialReferenceLockIfNeeded(force = false) {
  if (!state.initialized) {
    if (force) {
      clearReferenceLockTracking()
      return
    }
    state.reference.prelockMisses = Number(state.reference.prelockMisses || 0) + 1
    const allowedMisses = Math.max(0, Number(state.config.targetPrelockAllowedMisses || 1))
    if (state.reference.prelockMisses > allowedMisses) {
      clearReferenceLockTracking()
    }
  }
}


function trimReferenceLockSamples(timestampMs, stableWindowMs) {
  state.reference.lockSamples = state.reference.lockSamples.filter((sample) => timestampMs - sample.timestampMs <= stableWindowMs)
}


function pushReferenceLockSample(timestampMs, targetEstimate, estimatePose, stableWindowMs) {
  state.reference.lockSamples.push({
    timestampMs: timestampMs,
    position: estimatePose.position,
    quaternion: estimatePose.quaternion,
    confidence: targetEstimate.confidence,
    inlierCount: targetEstimate.inlierCount,
    reprojectionPx: targetEstimate.reprojectionPx,
  })
  state.reference.prelockMisses = 0
  trimReferenceLockSamples(timestampMs, stableWindowMs)
}


function readTargetTrackingConfig() {
  const minTargetMatches = Math.max(1, Number(state.config.minTargetMatches || 8))
  const trackHoldMs = Math.max(0, Number(state.config.targetTrackHoldMs || 420))
  return {
    freshPoseMs: Math.max(100, Number(state.config.targetFreshPoseMs || 380)),
    trackHoldMs: trackHoldMs,
    lostHoldMs: Math.max(trackHoldMs, Number(state.config.targetLostHoldMs || 1200)),
    stableWindowMs: Math.max(120, Number(state.config.targetStableWindowMs || 260)),
    stableFramesRequired: Math.max(2, Number(state.config.targetStableFrames || 4)),
    stableMinConfidence: clamp01(Number(state.config.targetStableMinConfidence || 0.42)),
    stableMinInliers: Math.max(4, Number(state.config.targetStableMinInliers || state.config.minTargetInliers || 6)),
    stableMaxReprojectionPx: Math.max(1.5, Number(state.config.targetStableMaxReprojectionPx || 4.5)),
    detectedMatchFloor: Math.max(3, minTargetMatches - 3),
    minTargetMatches: minTargetMatches,
    singleFrameBootstrapMinMatches: Math.max(8, Number(state.config.targetSingleFrameBootstrapMinMatches || 24)),
    singleFrameBootstrapMinInliers: Math.max(4, Number(state.config.targetSingleFrameBootstrapMinInliers || 5)),
    singleFrameBootstrapMaxReprojectionPx: Math.max(0.2, Number(state.config.targetSingleFrameBootstrapMaxReprojectionPx || 1.2)),
    singleFrameBootstrapMinConfidence: clamp01(Number(state.config.targetSingleFrameBootstrapMinConfidence || 0.58)),
    singleFrameBootstrapMinVisualQuality: clamp01(Number(state.config.targetSingleFrameBootstrapMinVisualQuality || 0.62)),
  }
}

