function normalizeReferenceFeature(feature, width, height, physicalWidthM, physicalHeightM) {
  const safeWidth = Math.max(1, width - 1)
  const safeHeight = Math.max(1, height - 1)
  return {
    x: feature.x,
    y: feature.y,
    score: feature.score,
    descriptor: feature.descriptor.slice(0, 4),
    planeX: (feature.x / safeWidth - 0.5) * physicalWidthM,
    planeY: (0.5 - feature.y / safeHeight) * physicalHeightM,
  }
}


function estimateHomography(matches) {
  if (!matches || matches.length < 4) {
    return null
  }
  const rows = []
  const values = []
  for (const match of matches) {
    const X = match.reference.planeX
    const Y = match.reference.planeY
    const u = match.current.x
    const v = match.current.y
    rows.push(X, Y, 1, 0, 0, 0, -u * X, -u * Y)
    values.push(u)
    rows.push(0, 0, 0, X, Y, 1, -v * X, -v * Y)
    values.push(v)
  }
  const cols = 8
  const matrix = rows
  const normal = transposeTimesMatrix(values.length, cols, matrix)
  const rhs = transposeTimesVector(values.length, cols, matrix, values)
  const solution = solveLinearSystem(normal, rhs)
  if (!solution) {
    return null
  }
  return [
    solution[0], solution[1], solution[2],
    solution[3], solution[4], solution[5],
    solution[6], solution[7], 1,
  ]
}


function projectHomographyPoint(h, X, Y) {
  const w = h[6] * X + h[7] * Y + h[8]
  if (Math.abs(w) < 1e-8) {
    return null
  }
  return {
    x: (h[0] * X + h[1] * Y + h[2]) / w,
    y: (h[3] * X + h[4] * Y + h[5]) / w,
  }
}


function setTargetPoseReject(reason, bestInliers = 0, refinedInliers = 0) {
  state.reference.rejectReason = String(reason || 'NONE')
  state.reference.bestInliers = Number(bestInliers || 0)
  state.reference.refinedInliers = Number(refinedInliers || 0)
}


function polygonArea(points) {
  if (!Array.isArray(points) || points.length < 3) {
    return 0
  }
  let area = 0
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index]
    const next = points[(index + 1) % points.length]
    area += current.x * next.y - next.x * current.y
  }
  return area * 0.5
}


function distance2(a, b) {
  const dx = a.x - b.x
  const dy = a.y - b.y
  return Math.sqrt(dx * dx + dy * dy)
}


function projectTargetCorners(homography) {
  const halfWidth = Number(state.reference.physicalWidthM || 0) * 0.5
  const halfHeight = Number(state.reference.physicalHeightM || 0) * 0.5
  return [
    projectHomographyPoint(homography, -halfWidth, halfHeight),
    projectHomographyPoint(homography, halfWidth, halfHeight),
    projectHomographyPoint(homography, halfWidth, -halfHeight),
    projectHomographyPoint(homography, -halfWidth, -halfHeight),
  ]
}


function isPlausibleTargetQuadrilateral(corners, width, height) {
  if (!Array.isArray(corners) || corners.some((corner) => !corner)) {
    return false
  }

  const area = Math.abs(polygonArea(corners))
  const frameArea = Math.max(1, width * height)
  const coverage = area / frameArea
  const minCoverage = Math.max(0.001, Number(state.config.targetMinCoverage || 0.012))
  if (coverage < minCoverage) {
    return false
  }

  const edgeLengths = [
    distance2(corners[0], corners[1]),
    distance2(corners[1], corners[2]),
    distance2(corners[2], corners[3]),
    distance2(corners[3], corners[0]),
  ]
  const minEdge = Math.max(1e-4, Math.min.apply(null, edgeLengths))
  const maxEdge = Math.max.apply(null, edgeLengths)
  const maxAspectSkew = Math.max(1.5, Number(state.config.targetMaxAspectSkew || 5.2))
  if (maxEdge / minEdge > maxAspectSkew) {
    return false
  }

  const visibleCorners = corners.filter((corner) => (
    corner.x >= -width * 0.15 &&
    corner.x <= width * 1.15 &&
    corner.y >= -height * 0.15 &&
    corner.y <= height * 1.15
  ))
  return visibleCorners.length >= 3
}


function sampleUniqueIndices(total, count) {
  const selected = new Set()
  while (selected.size < count) {
    selected.add(Math.floor(Math.random() * total))
  }
  return Array.from(selected)
}


function buildSpatialCellKey(x, y, width, height, cols, rows) {
  const safeWidth = Math.max(1, Number(width || 1))
  const safeHeight = Math.max(1, Number(height || 1))
  const safeCols = Math.max(1, Number(cols || 1))
  const safeRows = Math.max(1, Number(rows || 1))
  const col = clampIndex(Math.floor((Number(x || 0) / safeWidth) * safeCols), safeCols - 1)
  const row = clampIndex(Math.floor((Number(y || 0) / safeHeight) * safeRows), safeRows - 1)
  return col + ':' + row
}


function buildSpatiallyDistributedMatches(matches, options = {}) {
  if (!Array.isArray(matches) || !matches.length) {
    return []
  }
  const cols = Math.max(1, Number(options.cols || 6))
  const rows = Math.max(1, Number(options.rows || 8))
  const maxPerCurrentCell = Math.max(1, Number(options.maxPerCurrentCell || 3))
  const maxPerReferenceCell = Math.max(1, Number(options.maxPerReferenceCell || 3))
  const currentWidth = Math.max(1, Number(options.currentWidth || state.visual.width || 1))
  const currentHeight = Math.max(1, Number(options.currentHeight || state.visual.height || 1))
  const referenceWidth = Math.max(1, Number(options.referenceWidth || state.reference.width || 1))
  const referenceHeight = Math.max(1, Number(options.referenceHeight || state.reference.height || 1))
  const currentCellCounts = new Map()
  const referenceCellCounts = new Map()
  const selected = []

  for (const match of matches) {
    const currentCellKey = buildSpatialCellKey(
      match.current.x,
      match.current.y,
      currentWidth,
      currentHeight,
      cols,
      rows
    )
    const referenceCellKey = buildSpatialCellKey(
      match.reference.x,
      match.reference.y,
      referenceWidth,
      referenceHeight,
      cols,
      rows
    )
    if ((currentCellCounts.get(currentCellKey) || 0) >= maxPerCurrentCell) {
      continue
    }
    if ((referenceCellCounts.get(referenceCellKey) || 0) >= maxPerReferenceCell) {
      continue
    }
    currentCellCounts.set(currentCellKey, (currentCellCounts.get(currentCellKey) || 0) + 1)
    referenceCellCounts.set(referenceCellKey, (referenceCellCounts.get(referenceCellKey) || 0) + 1)
    selected.push(match)
  }

  return selected
}


function matchReferenceFeatures(referenceFeatures, currentFeatures) {
  if (!referenceFeatures.length || !currentFeatures.length) {
    state.reference.rawMatchCount = 0
    state.reference.reciprocalMatchCount = 0
    state.reference.matchStrategy = 'NONE'
    return []
  }
  const maxCurrent = Math.max(12, Math.min(Number(state.config.targetSearchFeatures || 40), currentFeatures.length))
  const sortedCurrent = currentFeatures.slice().sort((a, b) => b.score - a.score).slice(0, maxCurrent)
  const threshold = Number(state.config.targetDescriptorThreshold || 0.48)
  const ratioThreshold = Number(state.config.targetRatioThreshold || 0.84)
  const reverseBestByRef = new Map()
  const candidates = []

  for (const reference of referenceFeatures) {
    let bestDistance = Number.POSITIVE_INFINITY
    let secondDistance = Number.POSITIVE_INFINITY
    let bestCurrentIndex = -1
    for (let currentIndex = 0; currentIndex < sortedCurrent.length; currentIndex += 1) {
      const current = sortedCurrent[currentIndex]
      const distance = descriptorDistance4(current.descriptor, reference.descriptor)
      if (distance < bestDistance) {
        secondDistance = bestDistance
        bestDistance = distance
        bestCurrentIndex = currentIndex
      } else if (distance < secondDistance) {
        secondDistance = distance
      }
    }
    reverseBestByRef.set(reference.x + ':' + reference.y, {
      currentIndex: bestCurrentIndex,
      bestDistance: bestDistance,
      secondDistance: secondDistance,
    })
  }

  for (let currentIndex = 0; currentIndex < sortedCurrent.length; currentIndex += 1) {
    const current = sortedCurrent[currentIndex]
    let bestDistance = Number.POSITIVE_INFINITY
    let secondDistance = Number.POSITIVE_INFINITY
    let bestReference = null

    for (const reference of referenceFeatures) {
      const distance = descriptorDistance4(current.descriptor, reference.descriptor)
      if (distance < bestDistance) {
        secondDistance = bestDistance
        bestDistance = distance
        bestReference = reference
      } else if (distance < secondDistance) {
        secondDistance = distance
      }
    }

    if (!bestReference || bestDistance > threshold) {
      continue
    }
    if (isFinite(secondDistance) && secondDistance > 1e-5 && bestDistance / secondDistance > ratioThreshold) {
      continue
    }
    candidates.push({ currentIndex, current, reference: bestReference, score: bestDistance })
  }

  candidates.sort((a, b) => a.score - b.score)
  state.reference.rawMatchCount = candidates.length
  const usedRefs = new Set()
  const forwardMatches = []
  for (const candidate of candidates) {
    const refKey = candidate.reference.x + ':' + candidate.reference.y
    if (usedRefs.has(refKey)) {
      continue
    }
    usedRefs.add(refKey)
    forwardMatches.push(candidate)
  }

  const reciprocalMatches = []
  const reciprocalUsedRefs = new Set()
  for (const candidate of forwardMatches) {
    const reverseEntry = reverseBestByRef.get(candidate.reference.x + ':' + candidate.reference.y)
    if (!reverseEntry || reverseEntry.currentIndex !== candidate.currentIndex || reverseEntry.bestDistance > threshold) {
      continue
    }
    if (
      isFinite(reverseEntry.secondDistance) &&
      reverseEntry.secondDistance > 1e-5 &&
      reverseEntry.bestDistance / reverseEntry.secondDistance > ratioThreshold
    ) {
      continue
    }
    const refKey = candidate.reference.x + ':' + candidate.reference.y
    if (reciprocalUsedRefs.has(refKey)) {
      continue
    }
    reciprocalUsedRefs.add(refKey)
    reciprocalMatches.push(candidate)
  }
  state.reference.reciprocalMatchCount = reciprocalMatches.length
  const reciprocalMinMatches = Math.max(4, Number(state.config.targetReciprocalMinMatches || 6))
  if (reciprocalMatches.length >= reciprocalMinMatches) {
    state.reference.matchStrategy = 'RECIPROCAL'
    return reciprocalMatches
  }
  state.reference.matchStrategy = reciprocalMatches.length > 0 ? 'FORWARD_FALLBACK' : 'FORWARD_ONLY'
  return forwardMatches
}


function evaluateHomography(h, matches, thresholdPx) {
  const inliers = []
  let errorSum = 0
  for (const match of matches) {
    const projected = projectHomographyPoint(h, match.reference.planeX, match.reference.planeY)
    if (!projected) {
      continue
    }
    const error = Math.hypot(projected.x - match.current.x, projected.y - match.current.y)
    if (error <= thresholdPx) {
      inliers.push(match)
      errorSum += error
    }
  }
  return {
    inliers,
    meanError: inliers.length ? errorSum / inliers.length : Number.POSITIVE_INFINITY,
  }
}


function deriveCameraIntrinsics(projectionMatrix, width, height) {
  if (!Array.isArray(projectionMatrix) || projectionMatrix.length < 16 || !width || !height) {
    return null
  }
  const fx = Math.abs(Number(projectionMatrix[0] || 0)) * width * 0.5
  const fy = Math.abs(Number(projectionMatrix[5] || 0)) * height * 0.5
  const cx = width * 0.5
  const cy = height * 0.5
  if (!fx || !fy) {
    return null
  }
  return { fx, fy, cx, cy }
}


function dot3(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}


function cross3(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ]
}


function normalize3(vector) {
  const length = Math.hypot(vector[0], vector[1], vector[2])
  if (length < 1e-8) {
    return null
  }
  return [vector[0] / length, vector[1] / length, vector[2] / length]
}


function homographyToCameraMatrix(h, intrinsics) {
  if (!h || !intrinsics) {
    return null
  }
  const fx = intrinsics.fx
  const fy = intrinsics.fy
  const cx = intrinsics.cx
  const cy = intrinsics.cy

  const kInvH = [
    (h[0] - cx * h[6]) / fx, (h[1] - cx * h[7]) / fx, (h[2] - cx * h[8]) / fx,
    (h[3] - cy * h[6]) / fy, (h[4] - cy * h[7]) / fy, (h[5] - cy * h[8]) / fy,
    h[6], h[7], h[8],
  ]
  const c1 = [kInvH[0], kInvH[3], kInvH[6]]
  const c2 = [kInvH[1], kInvH[4], kInvH[7]]
  const c3 = [kInvH[2], kInvH[5], kInvH[8]]
  const norm1 = Math.hypot(c1[0], c1[1], c1[2])
  const norm2 = Math.hypot(c2[0], c2[1], c2[2])
  if (norm1 < 1e-6 || norm2 < 1e-6) {
    return null
  }

  const scale = 2 / (norm1 + norm2)
  let r1 = normalize3([c1[0] * scale, c1[1] * scale, c1[2] * scale])
  if (!r1) {
    return null
  }
  let r2 = [c2[0] * scale, c2[1] * scale, c2[2] * scale]
  const r1DotR2 = dot3(r1, r2)
  r2 = normalize3([
    r2[0] - r1[0] * r1DotR2,
    r2[1] - r1[1] * r1DotR2,
    r2[2] - r1[2] * r1DotR2,
  ])
  if (!r2) {
    return null
  }
  const r3 = normalize3(cross3(r1, r2))
  if (!r3) {
    return null
  }
  const translation = [c3[0] * scale, c3[1] * scale, c3[2] * scale]
  if (!isFinite(translation[2]) || translation[2] <= 0.001) {
    return null
  }

  return [
    r1[0], r1[1], r1[2], 0,
    r2[0], r2[1], r2[2], 0,
    r3[0], r3[1], r3[2], 0,
    translation[0], translation[1], translation[2], 1,
  ]
}


function estimateTargetPose(referenceMatches, projectionMatrix, cameraWorldMatrix, width, height, visualQuality) {
  if (!Array.isArray(cameraWorldMatrix) || cameraWorldMatrix.length !== 16) {
    setTargetPoseReject('NO_CAMERA_WORLD')
    return null
  }
  const minTargetMatches = Math.max(4, Number(state.config.minTargetMatches || 8))
  const minTargetInliers = Math.max(4, Number(state.config.minTargetInliers || 6))
  if (!referenceMatches || referenceMatches.length < minTargetMatches) {
    setTargetPoseReject('INSUFFICIENT_MATCHES', referenceMatches ? referenceMatches.length : 0, 0)
    return null
  }
  const ransacPool = buildSpatiallyDistributedMatches(referenceMatches, {
    currentWidth: width,
    currentHeight: height,
    referenceWidth: state.reference.width,
    referenceHeight: state.reference.height,
    cols: 6,
    rows: 8,
    maxPerCurrentCell: 3,
    maxPerReferenceCell: 3,
  })
  const sampledMatches = ransacPool.length >= minTargetMatches
    ? ransacPool
    : referenceMatches

  const thresholdPx = Math.max(3, Number(state.config.targetInlierPx || 7))
  const iterations = Math.max(16, Number(state.config.targetRansacIterations || 56))
  let best = null

  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const sample = sampleUniqueIndices(sampledMatches.length, 4).map((index) => sampledMatches[index])
    const homography = estimateHomography(sample)
    if (!homography) {
      continue
    }
    const evaluated = evaluateHomography(homography, referenceMatches, thresholdPx)
    if (!best || evaluated.inliers.length > best.inliers.length || (evaluated.inliers.length === best.inliers.length && evaluated.meanError < best.meanError)) {
      best = { homography, inliers: evaluated.inliers, meanError: evaluated.meanError }
    }
  }

  if (!best) {
    setTargetPoseReject('NO_HOMOGRAPHY')
    return null
  }
  if (best.inliers.length < minTargetInliers) {
    setTargetPoseReject('BEST_INLIERS', best.inliers.length, 0)
    return null
  }

  const refinedHomography = estimateHomography(best.inliers) || best.homography
  const refined = evaluateHomography(refinedHomography, referenceMatches, thresholdPx)
  const resolved = refined.inliers.length >= best.inliers.length
    ? { homography: refinedHomography, inliers: refined.inliers, meanError: refined.meanError }
    : { homography: best.homography, inliers: best.inliers, meanError: best.meanError }
  if (resolved.inliers.length < minTargetInliers) {
    setTargetPoseReject('REFINED_INLIERS', best.inliers.length, resolved.inliers.length)
    return null
  }
  const projectedCorners = projectTargetCorners(resolved.homography)
  if (!isPlausibleTargetQuadrilateral(projectedCorners, width, height)) {
    setTargetPoseReject('QUADRILATERAL', best.inliers.length, resolved.inliers.length)
    return null
  }

  const intrinsics = deriveCameraIntrinsics(projectionMatrix, width, height)
  if (!intrinsics) {
    setTargetPoseReject('NO_INTRINSICS', best.inliers.length, resolved.inliers.length)
    return null
  }
  const targetCameraCv = homographyToCameraMatrix(resolved.homography, intrinsics)
  if (!targetCameraCv) {
    setTargetPoseReject('CAMERA_MATRIX', best.inliers.length, resolved.inliers.length)
    return null
  }

  const cvToXr = [
    1, 0, 0, 0,
    0, -1, 0, 0,
    0, 0, -1, 0,
    0, 0, 0, 1,
  ]
  const targetCameraXr = multiplyMatrix4(cvToXr, targetCameraCv)
  const targetWorldMatrix = multiplyMatrix4(cameraWorldMatrix, targetCameraXr)
  const matchScore = clamp01(referenceMatches.length / 24)
  const inlierScore = clamp01(resolved.inliers.length / 18)
  const reprojectionScore = clamp01(1 - resolved.meanError / Math.max(1, thresholdPx * 2))
  const confidence = clamp01(inlierScore * 0.44 + matchScore * 0.22 + reprojectionScore * 0.2 + clamp01(visualQuality) * 0.14)
  setTargetPoseReject('ACCEPTED', best.inliers.length, resolved.inliers.length)

  return {
    worldMatrix: targetWorldMatrix,
    confidence,
    matchCount: referenceMatches.length,
    inlierCount: resolved.inliers.length,
    reprojectionPx: resolved.meanError,
  }
}


function setReferenceImage(payload) {
  const width = Number(payload.width || 0)
  const height = Number(payload.height || 0)
  const physicalWidthM = Number(payload.physicalWidthM || 0)
  const physicalHeightM = Number(payload.physicalHeightM || 0)
  if (!width || !height || !physicalWidthM || !physicalHeightM || !payload.pixels) {
    post('error', { message: 'Invalid reference image payload.' })
    return
  }

  const rgba = new Uint8Array(payload.pixels)
  if (rgba.length < width * height * 4) {
    post('error', { message: 'Reference image buffer is too small.' })
    return
  }

  const referenceGray = rgbaToGray(rgba, width, height).gray
  const features = detectFeatures(referenceGray, width, height)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(96, Number(state.config.referenceFeatureLimit || 128)))
    .map((feature) => normalizeReferenceFeature(feature, width, height, physicalWidthM, physicalHeightM))

  state.reference.ready = features.length >= Math.max(8, Number(state.config.minTargetMatches || 8))
  state.reference.state = state.reference.ready ? 'READY' : 'REFERENCE_WEAK'
  state.reference.name = payload.name || 'reference-image'
  state.reference.width = width
  state.reference.height = height
  state.reference.physicalWidthM = physicalWidthM
  state.reference.physicalHeightM = physicalHeightM
  state.reference.features = features
  state.reference.featureCount = features.length
  state.reference.matchCount = 0
  state.reference.inlierCount = 0
  state.reference.reprojectionPx = 0
  state.reference.confidence = 0
  state.reference.lastSeenTimestampMs = 0
  state.reference.lastSolvedPoseTimestampMs = 0
  state.reference.updates = 0
  clearReferenceLockTracking()

  if (!state.initialized) {
    state.visual.state = state.reference.ready ? 'READY' : 'BOOTSTRAP'
  }

  post('reference-ready', {
    referenceState: state.reference.state,
    targetName: state.reference.name,
    featureCount: state.reference.featureCount,
    physicalWidthM: Number(state.reference.physicalWidthM.toFixed(3)),
    physicalHeightM: Number(state.reference.physicalHeightM.toFixed(3)),
    workerState: state.workerState,
    wasmState: state.wasmState,
  })
}

