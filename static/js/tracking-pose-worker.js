importScripts('/static/js/wasm-pose-kernel.js')

const DEFAULT_CONFIG = {
  basePosAlpha: 0.18,
  baseRotAlpha: 0.22,
  anchorPosBoost: 0.24,
  anchorRotBoost: 0.26,
  surfacePosBoost: 0.08,
  surfaceRotBoost: 0.1,
  lockPosBoost: 0.16,
  lockRotBoost: 0.18,
  snapTranslationM: 0.14,
  snapRotationDeg: 18,
  minDtMs: 4,
  maxDtMs: 80,
  velocityBlend: 0.22,
  featureCellSize: 18,
  featuresPerCell: 2,
  descriptorMatchThreshold: 0.72,
  keyframeIntervalFrames: 12,
  maxKeyframes: 24,
  maxLandmarks: 120,
  searchRadiusPx: 20,
  minRelocalizationFeatures: 10,
  minMappedKeyframes: 3,
  minMappedLandmarks: 24,
  minMappedMatchRatio: 0.38,
  minMappedTrackConfidence: 0.42,
  referenceMaxDimension: 192,
  targetDescriptorThreshold: 0.48,
  targetRatioThreshold: 0.84,
  targetSearchFeatures: 40,
  minTargetMatches: 8,
  minTargetInliers: 6,
  targetInlierPx: 7,
  targetRansacIterations: 56,
}

const state = {
  workerState: 'BOOTING',
  wasmState: 'BOOTING',
  wasm: null,
  config: { ...DEFAULT_CONFIG },
  ready: false,
  initialized: false,
  filteredPosition: [0, 0, 0],
  filteredQuaternion: [0, 0, 0, 1],
  velocity: [0, 0, 0],
  lastTimestampMs: 0,
  frames: 0,
  snapCount: 0,
  lastSource: 'NONE',
  reference: {
    ready: false,
    state: 'UNINITIALIZED',
    name: '-',
    width: 0,
    height: 0,
    physicalWidthM: 0,
    physicalHeightM: 0,
    features: [],
    featureCount: 0,
    matchCount: 0,
    inlierCount: 0,
    reprojectionPx: 0,
    confidence: 0,
    lastSeenTimestampMs: 0,
    updates: 0,
  },
  visual: {
    state: 'IDLE',
    quality: 0,
    brightness: 0,
    contrast: 0,
    motion: 0,
    featureCount: 0,
    featureDensity: 0,
    frames: 0,
    width: 0,
    height: 0,
    sourceWidth: 0,
    sourceHeight: 0,
    procMs: 0,
    captureMs: 0,
    lastTimestampMs: 0,
    prevGray: null,
    prevFeatures: [],
    nextTrackId: 1,
    nextKeyframeId: 1,
    matchCount: 0,
    matchRatio: 0,
    trackConfidence: 0,
    trackCount: 0,
    keyframeCount: 0,
    landmarkCount: 0,
    mapState: 'BOOTSTRAP',
    relocalizationScore: 0,
    relocalizationKeyframeId: -1,
    motionX: 0,
    motionY: 0,
    motionScale: 1,
    motionRotationDeg: 0,
    visualOdometryConfidence: 0,
    lastKeyframeFrame: 0,
    keyframes: [],
    landmarks: new Map(),
  },
}

function nowMs() {
  return typeof performance !== 'undefined' ? performance.now() : Date.now()
}

function post(type, payload) {
  self.postMessage({ type, payload })
}

function clamp01(value) {
  if (state.wasm && typeof state.wasm.clamp01 === 'function') {
    return state.wasm.clamp01(value)
  }
  return Math.max(0, Math.min(1, Number(value) || 0))
}

function mix(a, b, t) {
  if (state.wasm && typeof state.wasm.mix === 'function') {
    return state.wasm.mix(a, b, t)
  }
  return a + (b - a) * t
}

function distance3(a, b) {
  if (state.wasm && typeof state.wasm.distance3 === 'function') {
    return state.wasm.distance3(a[0], a[1], a[2], b[0], b[1], b[2])
  }
  const dx = a[0] - b[0]
  const dy = a[1] - b[1]
  const dz = a[2] - b[2]
  return Math.sqrt(dx * dx + dy * dy + dz * dz)
}

function quatDotAbs(a, b) {
  if (state.wasm && typeof state.wasm.quatDotAbs4 === 'function') {
    return Math.min(1, Math.abs(state.wasm.quatDotAbs4(a[0], a[1], a[2], a[3], b[0], b[1], b[2], b[3])))
  }
  return Math.min(1, Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]))
}

function rgbToLuma(r, g, b) {
  if (state.wasm && typeof state.wasm.rgbToLuma3 === 'function') {
    return state.wasm.rgbToLuma3(r, g, b)
  }
  return r * 0.299 + g * 0.587 + b * 0.114
}

function gradientEnergy(left, right, up, down) {
  if (state.wasm && typeof state.wasm.gradientEnergy4 === 'function') {
    return state.wasm.gradientEnergy4(left, right, up, down)
  }
  return Math.abs(right - left) + Math.abs(down - up)
}

function cornerScore(left, right, up, down, d1, d2, d3, d4) {
  if (state.wasm && typeof state.wasm.cornerScore8 === 'function') {
    return state.wasm.cornerScore8(left, right, up, down, d1, d2, d3, d4)
  }
  return Math.abs(right - left) + Math.abs(down - up) + 0.7 * Math.abs(d2 - d1) + 0.7 * Math.abs(d4 - d3)
}

function descriptorDistance4(a, b) {
  if (state.wasm && typeof state.wasm.descriptorDistance4 === 'function') {
    return state.wasm.descriptorDistance4(a[0], a[1], a[2], a[3], b[0], b[1], b[2], b[3])
  }
  return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) + Math.abs(a[3] - b[3])
}

function multiplyMatrix4(a, b) {
  const out = new Array(16).fill(0)
  for (let column = 0; column < 4; column += 1) {
    for (let row = 0; row < 4; row += 1) {
      let sum = 0
      for (let k = 0; k < 4; k += 1) {
        sum += a[row + k * 4] * b[k + column * 4]
      }
      out[row + column * 4] = sum
    }
  }
  return out
}

function transposeTimesMatrix(rows, cols, matrix) {
  const out = Array.from({ length: cols }, () => new Array(cols).fill(0))
  for (let row = 0; row < rows; row += 1) {
    const rowOffset = row * cols
    for (let i = 0; i < cols; i += 1) {
      const a = matrix[rowOffset + i]
      for (let j = 0; j < cols; j += 1) {
        out[i][j] += a * matrix[rowOffset + j]
      }
    }
  }
  return out
}

function transposeTimesVector(rows, cols, matrix, vector) {
  const out = new Array(cols).fill(0)
  for (let row = 0; row < rows; row += 1) {
    const rowOffset = row * cols
    const value = vector[row]
    for (let col = 0; col < cols; col += 1) {
      out[col] += matrix[rowOffset + col] * value
    }
  }
  return out
}

function solveLinearSystem(matrix, vector) {
  const n = vector.length
  const a = matrix.map((row, index) => row.slice(0, n).concat(vector[index]))
  for (let pivot = 0; pivot < n; pivot += 1) {
    let bestRow = pivot
    let bestValue = Math.abs(a[pivot][pivot])
    for (let row = pivot + 1; row < n; row += 1) {
      const value = Math.abs(a[row][pivot])
      if (value > bestValue) {
        bestValue = value
        bestRow = row
      }
    }
    if (bestValue < 1e-8) {
      return null
    }
    if (bestRow !== pivot) {
      const temp = a[pivot]
      a[pivot] = a[bestRow]
      a[bestRow] = temp
    }
    const pivotValue = a[pivot][pivot]
    for (let col = pivot; col <= n; col += 1) {
      a[pivot][col] /= pivotValue
    }
    for (let row = 0; row < n; row += 1) {
      if (row === pivot) {
        continue
      }
      const factor = a[row][pivot]
      if (!factor) {
        continue
      }
      for (let col = pivot; col <= n; col += 1) {
        a[row][col] -= factor * a[pivot][col]
      }
    }
  }
  return a.map((row) => row[n])
}

function rgbaToGray(rgba, width, height) {
  const pixelCount = width * height
  const gray = new Uint8Array(pixelCount)
  let brightnessSum = 0
  let brightnessSqSum = 0
  for (let srcIndex = 0, pixelIndex = 0; pixelIndex < pixelCount; pixelIndex += 1, srcIndex += 4) {
    const luminance = Math.round(rgbToLuma(rgba[srcIndex], rgba[srcIndex + 1], rgba[srcIndex + 2]))
    gray[pixelIndex] = luminance
    brightnessSum += luminance
    brightnessSqSum += luminance * luminance
  }
  return { gray, brightnessSum, brightnessSqSum, pixelCount }
}

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

function sampleUniqueIndices(total, count) {
  const selected = new Set()
  while (selected.size < count) {
    selected.add(Math.floor(Math.random() * total))
  }
  return Array.from(selected)
}

function matchReferenceFeatures(referenceFeatures, currentFeatures) {
  if (!referenceFeatures.length || !currentFeatures.length) {
    return []
  }
  const maxCurrent = Math.max(12, Math.min(Number(state.config.targetSearchFeatures || 40), currentFeatures.length))
  const sortedCurrent = currentFeatures.slice().sort((a, b) => b.score - a.score).slice(0, maxCurrent)
  const threshold = Number(state.config.targetDescriptorThreshold || 0.48)
  const ratioThreshold = Number(state.config.targetRatioThreshold || 0.84)
  const candidates = []

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
    candidates.push({ current, reference: bestReference, score: bestDistance })
  }

  candidates.sort((a, b) => a.score - b.score)
  const usedRefs = new Set()
  const matches = []
  for (const candidate of candidates) {
    const refKey = candidate.reference.x + ':' + candidate.reference.y
    if (usedRefs.has(refKey)) {
      continue
    }
    usedRefs.add(refKey)
    matches.push(candidate)
  }
  return matches
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
    return null
  }
  const minTargetMatches = Math.max(4, Number(state.config.minTargetMatches || 8))
  const minTargetInliers = Math.max(4, Number(state.config.minTargetInliers || 6))
  if (!referenceMatches || referenceMatches.length < minTargetMatches) {
    return null
  }

  const thresholdPx = Math.max(3, Number(state.config.targetInlierPx || 7))
  const iterations = Math.max(16, Number(state.config.targetRansacIterations || 56))
  let best = null

  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const sample = sampleUniqueIndices(referenceMatches.length, 4).map((index) => referenceMatches[index])
    const homography = estimateHomography(sample)
    if (!homography) {
      continue
    }
    const evaluated = evaluateHomography(homography, referenceMatches, thresholdPx)
    if (!best || evaluated.inliers.length > best.inliers.length || (evaluated.inliers.length === best.inliers.length && evaluated.meanError < best.meanError)) {
      best = { homography, inliers: evaluated.inliers, meanError: evaluated.meanError }
    }
  }

  if (!best || best.inliers.length < minTargetInliers) {
    return null
  }

  const refinedHomography = estimateHomography(best.inliers) || best.homography
  const refined = evaluateHomography(refinedHomography, referenceMatches, thresholdPx)
  if (refined.inliers.length < minTargetInliers) {
    return null
  }

  const intrinsics = deriveCameraIntrinsics(projectionMatrix, width, height)
  const targetCameraCv = homographyToCameraMatrix(refinedHomography, intrinsics)
  if (!targetCameraCv) {
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
  const inlierScore = clamp01(refined.inliers.length / 18)
  const reprojectionScore = clamp01(1 - refined.meanError / Math.max(1, thresholdPx * 2))
  const confidence = clamp01(inlierScore * 0.44 + matchScore * 0.22 + reprojectionScore * 0.2 + clamp01(visualQuality) * 0.14)

  return {
    worldMatrix: targetWorldMatrix,
    confidence,
    matchCount: referenceMatches.length,
    inlierCount: refined.inliers.length,
    reprojectionPx: refined.meanError,
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
    .slice(0, 96)
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
  state.reference.updates = 0

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

function median(values) {
  if (!values.length) {
    return 0
  }
  const sorted = values.slice().sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) * 0.5
}

function clampIndex(value, max) {
  return Math.max(0, Math.min(max, value))
}

function patchAverage(gray, width, height, cx, cy, radius) {
  let sum = 0
  let count = 0
  for (let y = cy - radius; y <= cy + radius; y += 1) {
    if (y < 0 || y >= height) {
      continue
    }
    for (let x = cx - radius; x <= cx + radius; x += 1) {
      if (x < 0 || x >= width) {
        continue
      }
      sum += gray[y * width + x]
      count += 1
    }
  }
  return count ? sum / count / 255 : 0
}

function buildDescriptor(gray, width, height, x, y) {
  const radius = 2
  return [
    patchAverage(gray, width, height, x - 3, y - 3, radius),
    patchAverage(gray, width, height, x + 3, y - 3, radius),
    patchAverage(gray, width, height, x - 3, y + 3, radius),
    patchAverage(gray, width, height, x + 3, y + 3, radius),
  ]
}

function detectFeatures(gray, width, height) {
  const cellSize = Math.max(12, Math.min(24, Number(state.config.featureCellSize || 18)))
  const featuresPerCell = Math.max(1, Math.min(3, Number(state.config.featuresPerCell || 2)))
  const features = []

  for (let cellTop = 4; cellTop < height - 4; cellTop += cellSize) {
    for (let cellLeft = 4; cellLeft < width - 4; cellLeft += cellSize) {
      const cellRight = Math.min(width - 4, cellLeft + cellSize)
      const cellBottom = Math.min(height - 4, cellTop + cellSize)
      const candidates = []
      for (let y = cellTop; y < cellBottom; y += 2) {
        for (let x = cellLeft; x < cellRight; x += 2) {
          const index = y * width + x
          const left = gray[index - 1]
          const right = gray[index + 1]
          const up = gray[index - width]
          const down = gray[index + width]
          const d1 = gray[index - width - 1]
          const d2 = gray[index - width + 1]
          const d3 = gray[index + width - 1]
          const d4 = gray[index + width + 1]
          const center = gray[index]
          const score = cornerScore(left, right, up, down, d1, d2, d3, d4)
          const gradient = gradientEnergy(left, right, up, down)
          const contrast = Math.max(Math.abs(center - left), Math.abs(center - right), Math.abs(center - up), Math.abs(center - down))
          const finalScore = score * 0.75 + gradient * 0.15 + contrast * 0.1
          if (finalScore < 42) {
            continue
          }
          candidates.push({ x, y, score: finalScore, descriptor: buildDescriptor(gray, width, height, x, y), trackId: -1, age: 1 })
        }
      }
      candidates.sort((a, b) => b.score - a.score)
      const selected = []
      for (const candidate of candidates) {
        if (selected.some((feature) => Math.hypot(feature.x - candidate.x, feature.y - candidate.y) < 5)) {
          continue
        }
        selected.push(candidate)
        if (selected.length >= featuresPerCell) {
          break
        }
      }
      features.push(...selected)
    }
  }

  return features
}

function matchFeatures(previousFeatures, currentFeatures, width, height) {
  if (!previousFeatures.length || !currentFeatures.length) {
    return []
  }

  const searchRadius = Math.max(8, Math.min(Number(state.config.searchRadiusPx || 20), Math.min(width, height) * 0.25))
  const predictedX = Number(state.visual.motionX || 0)
  const predictedY = Number(state.visual.motionY || 0)
  const candidates = []

  for (let currentIndex = 0; currentIndex < currentFeatures.length; currentIndex += 1) {
    const current = currentFeatures[currentIndex]
    for (let previousIndex = 0; previousIndex < previousFeatures.length; previousIndex += 1) {
      const previous = previousFeatures[previousIndex]
      const dx = current.x - (previous.x + predictedX)
      const dy = current.y - (previous.y + predictedY)
      const spatialDistance = Math.hypot(dx, dy)
      if (spatialDistance > searchRadius) {
        continue
      }
      const descriptorScore = descriptorDistance4(current.descriptor, previous.descriptor)
      const combinedScore = descriptorScore + spatialDistance / searchRadius * 0.22
      if (combinedScore > Number(state.config.descriptorMatchThreshold || 0.72)) {
        continue
      }
      candidates.push({ currentIndex, previousIndex, score: combinedScore })
    }
  }

  candidates.sort((a, b) => a.score - b.score)
  const usedCurrent = new Set()
  const usedPrevious = new Set()
  const matches = []

  for (const candidate of candidates) {
    if (usedCurrent.has(candidate.currentIndex) || usedPrevious.has(candidate.previousIndex)) {
      continue
    }
    usedCurrent.add(candidate.currentIndex)
    usedPrevious.add(candidate.previousIndex)
    matches.push({ current: currentFeatures[candidate.currentIndex], previous: previousFeatures[candidate.previousIndex], score: candidate.score })
  }

  return matches
}

function estimateRelativeMotion(matches) {
  if (!matches.length) {
    return { dx: 0, dy: 0, scale: 1, rotationDeg: 0, magnitudePx: 0 }
  }

  const dxs = []
  const dys = []
  const previousCentroid = { x: 0, y: 0 }
  const currentCentroid = { x: 0, y: 0 }
  for (const match of matches) {
    dxs.push(match.current.x - match.previous.x)
    dys.push(match.current.y - match.previous.y)
    previousCentroid.x += match.previous.x
    previousCentroid.y += match.previous.y
    currentCentroid.x += match.current.x
    currentCentroid.y += match.current.y
  }
  previousCentroid.x /= matches.length
  previousCentroid.y /= matches.length
  currentCentroid.x /= matches.length
  currentCentroid.y /= matches.length

  const scales = []
  const rotations = []
  for (const match of matches) {
    const prevX = match.previous.x - previousCentroid.x
    const prevY = match.previous.y - previousCentroid.y
    const currX = match.current.x - currentCentroid.x
    const currY = match.current.y - currentCentroid.y
    const prevRadius = Math.hypot(prevX, prevY)
    const currRadius = Math.hypot(currX, currY)
    if (prevRadius > 1 && currRadius > 1) {
      scales.push(currRadius / prevRadius)
      let delta = Math.atan2(currY, currX) - Math.atan2(prevY, prevX)
      while (delta > Math.PI) {
        delta -= Math.PI * 2
      }
      while (delta < -Math.PI) {
        delta += Math.PI * 2
      }
      rotations.push(delta)
    }
  }

  return {
    dx: median(dxs),
    dy: median(dys),
    scale: scales.length ? median(scales) : 1,
    rotationDeg: rotations.length ? median(rotations) * 180 / Math.PI : 0,
    magnitudePx: Math.hypot(median(dxs), median(dys)),
  }
}

function blendDescriptor(existingDescriptor, nextDescriptor, alpha) {
  return [
    mix(existingDescriptor[0], nextDescriptor[0], alpha),
    mix(existingDescriptor[1], nextDescriptor[1], alpha),
    mix(existingDescriptor[2], nextDescriptor[2], alpha),
    mix(existingDescriptor[3], nextDescriptor[3], alpha),
  ]
}

function addKeyframe(features, timestampMs) {
  const keyframe = {
    id: state.visual.nextKeyframeId,
    frame: state.visual.frames,
    timestampMs,
    features: features
      .slice()
      .sort((a, b) => b.score - a.score)
      .slice(0, 28)
      .map((feature) => ({ x: feature.x, y: feature.y, score: Number(feature.score.toFixed(3)), descriptor: feature.descriptor.slice(0, 4) })),
    pose: {
      position: state.filteredPosition.slice(0, 3),
      quaternion: state.filteredQuaternion.slice(0, 4),
      source: state.lastSource,
    },
  }
  state.visual.nextKeyframeId += 1
  state.visual.keyframes.push(keyframe)
  if (state.visual.keyframes.length > Number(state.config.maxKeyframes || 24)) {
    state.visual.keyframes.shift()
  }
  state.visual.lastKeyframeFrame = state.visual.frames
  state.visual.keyframeCount = state.visual.keyframes.length
}

function relocalizeAgainstKeyframes(features) {
  let bestScore = 0
  let bestKeyframeId = -1
  const minRelocalizationFeatures = Math.max(8, Number(state.config.minRelocalizationFeatures || 10))
  if (features.length < minRelocalizationFeatures || !state.visual.keyframes.length) {
    return { score: 0, keyframeId: -1 }
  }

  const currentFeatures = features.slice(0, 24)
  for (const keyframe of state.visual.keyframes) {
    if (!keyframe.features || keyframe.features.length < minRelocalizationFeatures) {
      continue
    }
    let hits = 0
    for (const feature of currentFeatures) {
      let bestDistance = Number.POSITIVE_INFINITY
      for (const referenceFeature of keyframe.features) {
        const distance = descriptorDistance4(feature.descriptor, referenceFeature.descriptor)
        if (distance < bestDistance) {
          bestDistance = distance
        }
      }
      if (bestDistance < 0.52) {
        hits += 1
      }
    }
    const support = Math.max(1, Math.min(currentFeatures.length, keyframe.features.length))
    const hitRatio = hits / support
    const densityGate = clamp01(support / 18)
    const score = clamp01(hitRatio * densityGate)
    if (score > bestScore) {
      bestScore = score
      bestKeyframeId = keyframe.id
    }
  }

  return { score: clamp01(bestScore), keyframeId: bestKeyframeId }
}

function updateMapState(features, matches, motionEstimate, timestampMs) {
  const previousFeatures = state.visual.prevFeatures
  let trackAgeAccumulator = 0

  for (const match of matches) {
    match.current.trackId = match.previous.trackId
    match.current.age = Number(match.previous.age || 1) + 1
    trackAgeAccumulator += match.current.age
  }

  for (const feature of features) {
    if (feature.trackId > 0) {
      continue
    }
    feature.trackId = state.visual.nextTrackId
    feature.age = 1
    state.visual.nextTrackId += 1
  }

  for (const feature of features) {
    const existing = state.visual.landmarks.get(feature.trackId) || {
      id: feature.trackId,
      observations: 0,
      descriptor: feature.descriptor.slice(0, 4),
      lastFrame: 0,
      x: feature.x,
      y: feature.y,
      age: 0,
    }
    existing.observations += 1
    existing.descriptor = blendDescriptor(existing.descriptor, feature.descriptor, existing.observations > 1 ? 0.28 : 1)
    existing.lastFrame = state.visual.frames
    existing.x = feature.x
    existing.y = feature.y
    existing.age = Math.max(existing.age, feature.age)
    state.visual.landmarks.set(feature.trackId, existing)
  }

  for (const [trackId, landmark] of Array.from(state.visual.landmarks.entries())) {
    const staleFrames = state.visual.frames - Number(landmark.lastFrame || 0)
    if (staleFrames > 24 && landmark.observations < 3) {
      state.visual.landmarks.delete(trackId)
    }
  }

  if (state.visual.landmarks.size > Number(state.config.maxLandmarks || 120)) {
    const sortedLandmarks = Array.from(state.visual.landmarks.values()).sort((a, b) => {
      const aScore = a.observations * 2 + a.age - (state.visual.frames - a.lastFrame)
      const bScore = b.observations * 2 + b.age - (state.visual.frames - b.lastFrame)
      return bScore - aScore
    })
    const retained = new Map()
    for (const landmark of sortedLandmarks.slice(0, Number(state.config.maxLandmarks || 120))) {
      retained.set(landmark.id, landmark)
    }
    state.visual.landmarks = retained
  }

  const relocalization = relocalizeAgainstKeyframes(features)
  const landmarkCount = Array.from(state.visual.landmarks.values()).filter((landmark) => landmark.observations >= 3).length
  const matchRatio = features.length
    ? matches.length / Math.max(1, Math.min(features.length, previousFeatures.length || features.length))
    : 0
  const averageTrackAge = matches.length ? trackAgeAccumulator / matches.length : 0
  const landmarkScore = clamp01(landmarkCount / 36)
  const featureGate = clamp01(features.length / 18)
  const matchGate = clamp01(matches.length / 12)
  const trackConfidence = clamp01(matchRatio * 0.42 + landmarkScore * 0.18 + clamp01(averageTrackAge / 8) * 0.14 + featureGate * 0.14 + matchGate * 0.12)
  const relocalizationScore = clamp01(
    relocalization.score *
    clamp01(features.length / 16) *
    clamp01(matches.length / 8) *
    clamp01(trackConfidence / 0.42)
  )

  const shouldAddKeyframe =
    features.length >= 12 && matches.length >= 6 && (
      state.visual.keyframes.length === 0 ||
      state.visual.frames - state.visual.lastKeyframeFrame >= Number(state.config.keyframeIntervalFrames || 12) ||
      matchRatio < 0.32 ||
      motionEstimate.magnitudePx > 12
    )

  if (shouldAddKeyframe) {
    addKeyframe(features, timestampMs)
  }

  state.visual.prevFeatures = features.map((feature) => ({
    x: feature.x,
    y: feature.y,
    score: feature.score,
    descriptor: feature.descriptor.slice(0, 4),
    trackId: feature.trackId,
    age: feature.age,
  }))
  state.visual.trackCount = features.length
  state.visual.matchCount = matches.length
  state.visual.matchRatio = matchRatio
  state.visual.trackConfidence = trackConfidence
  state.visual.keyframeCount = state.visual.keyframes.length
  state.visual.landmarkCount = landmarkCount
  state.visual.relocalizationScore = relocalizationScore
  state.visual.relocalizationKeyframeId = relocalizationScore > 0 ? relocalization.keyframeId : -1

  const mappedKeyframes = Number(state.config.minMappedKeyframes || 3)
  const mappedLandmarks = Number(state.config.minMappedLandmarks || 24)
  const mappedMatchRatio = Number(state.config.minMappedMatchRatio || 0.38)
  const mappedTrackConfidence = Number(state.config.minMappedTrackConfidence || 0.42)

  if (
    state.visual.keyframeCount >= mappedKeyframes &&
    landmarkCount >= mappedLandmarks &&
    features.length >= 14 &&
    matches.length >= 8 &&
    matchRatio >= mappedMatchRatio &&
    trackConfidence >= mappedTrackConfidence &&
    relocalizationScore >= 0.35
  ) {
    state.visual.mapState = 'MAPPED'
  } else if (
    relocalizationScore >= 0.45 &&
    features.length >= 10 &&
    matches.length >= 5 &&
    trackConfidence >= 0.26
  ) {
    state.visual.mapState = 'RELOCALIZING'
  } else if (
    features.length >= 8 &&
    matches.length >= 4 &&
    trackConfidence >= 0.18
  ) {
    state.visual.mapState = 'TRACKING'
  } else {
    state.visual.mapState = 'BOOTSTRAP'
  }

  state.visual.visualOdometryConfidence = clamp01(
    trackConfidence * 0.52 +
    relocalizationScore * 0.18 +
    featureGate * 0.14 +
    clamp01(1 - state.visual.motion / 0.42) * 0.16
  )
}

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

function resetState() {
  state.initialized = false
  state.filteredPosition = [0, 0, 0]
  state.filteredQuaternion = [0, 0, 0, 1]
  state.velocity = [0, 0, 0]
  state.lastTimestampMs = 0
  state.frames = 0
  state.snapCount = 0
  state.lastSource = 'NONE'
  state.reference.state = state.reference.ready ? 'READY' : 'UNINITIALIZED'
  state.reference.matchCount = 0
  state.reference.inlierCount = 0
  state.reference.reprojectionPx = 0
  state.reference.confidence = 0
  state.reference.lastSeenTimestampMs = 0
  state.reference.updates = 0
  state.visual.state = state.reference.ready ? 'READY' : 'BOOTSTRAP'
  state.visual.quality = 0
  state.visual.brightness = 0
  state.visual.contrast = 0
  state.visual.motion = 0
  state.visual.featureCount = 0
  state.visual.featureDensity = 0
  state.visual.frames = 0
  state.visual.width = 0
  state.visual.height = 0
  state.visual.sourceWidth = 0
  state.visual.sourceHeight = 0
  state.visual.procMs = 0
  state.visual.captureMs = 0
  state.visual.lastTimestampMs = 0
  state.visual.prevGray = null
  state.visual.prevFeatures = []
  state.visual.nextTrackId = 1
  state.visual.nextKeyframeId = 1
  state.visual.matchCount = 0
  state.visual.matchRatio = 0
  state.visual.trackConfidence = 0
  state.visual.trackCount = 0
  state.visual.keyframeCount = 0
  state.visual.landmarkCount = 0
  state.visual.mapState = 'BOOTSTRAP'
  state.visual.relocalizationScore = 0
  state.visual.relocalizationKeyframeId = -1
  state.visual.motionX = 0
  state.visual.motionY = 0
  state.visual.motionScale = 1
  state.visual.motionRotationDeg = 0
  state.visual.visualOdometryConfidence = 0
  state.visual.lastKeyframeFrame = 0
  state.visual.keyframes = []
  state.visual.landmarks = new Map()
}

async function initKernel(config) {
  state.config = { ...DEFAULT_CONFIG, ...(config || {}) }
  const bytes = buildPoseKernelModuleBytes()
  const result = await WebAssembly.instantiate(bytes)
  state.wasm = result.instance.exports
  state.workerState = 'READY'
  state.wasmState = 'READY'
  state.ready = true
  resetState()
  post('ready', {
    workerState: state.workerState,
    wasmState: state.wasmState,
    config: state.config,
    kernels: ['mix', 'clamp01', 'distance3', 'quatDotAbs4', 'rgbToLuma3', 'gradientEnergy4', 'cornerScore8', 'descriptorDistance4'],
  })
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

  state.visual.state = state.visual.mapState
  state.visual.quality = quality
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
  if (targetEstimate) {
    state.reference.state = 'TRACKING'
    state.reference.lastSeenTimestampMs = Number(payload.timestampMs || nowMs())
    state.reference.updates += 1
    processMeasurement({
      id: 'target-' + state.visual.frames,
      source: 'image-target',
      matrix: targetEstimate.worldMatrix,
      confidence: targetEstimate.confidence,
      forceSnap: !state.initialized,
      hasPlacement: true,
      timestampMs: Number(payload.timestampMs || nowMs()),
      sentAtMs: Number(payload.sentAtMs || startedAt),
    })
  } else if (!state.reference.ready) {
    state.reference.state = 'UNINITIALIZED'
  } else if (referenceMatches.length >= Math.max(4, Number(state.config.minTargetMatches || 8) - 2)) {
    state.reference.state = 'DETECTED'
  } else if (state.reference.lastSeenTimestampMs && Number(payload.timestampMs || nowMs()) - state.reference.lastSeenTimestampMs < 1200) {
    state.reference.state = 'LOST'
  } else {
    state.reference.state = 'SEARCHING'
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
    matchCount: state.visual.matchCount,
    matchRatio: Number(state.visual.matchRatio.toFixed(3)),
    trackConfidence: Number(state.visual.trackConfidence.toFixed(3)),
    keyframeCount: state.visual.keyframeCount,
    landmarkCount: state.visual.landmarkCount,
    mapState: state.visual.mapState,
    relocalizationScore: Number(state.visual.relocalizationScore.toFixed(3)),
    relocalizationKeyframeId: state.visual.relocalizationKeyframeId,
    motionX: Number(state.visual.motionX.toFixed(3)),
    motionY: Number(state.visual.motionY.toFixed(3)),
    motionScale: Number(state.visual.motionScale.toFixed(4)),
    motionRotationDeg: Number(state.visual.motionRotationDeg.toFixed(3)),
    visualOdometryConfidence: Number(state.visual.visualOdometryConfidence.toFixed(3)),
    targetState: state.reference.state,
    targetVisible: state.reference.state === 'TRACKING',
    targetMatchCount: state.reference.matchCount,
    targetInlierCount: state.reference.inlierCount,
    targetConfidence: Number(state.reference.confidence.toFixed(3)),
    targetReprojectionPx: Number(state.reference.reprojectionPx.toFixed(3)),
    targetUpdates: state.reference.updates,
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

self.onmessage = async (event) => {
  const data = event.data || {}
  try {
    if (data.type === 'init') {
      await initKernel(data.config)
      return
    }
    if (data.type === 'reset') {
      resetState()
      post('reset-complete', { workerState: state.workerState, wasmState: state.wasmState })
      return
    }
    if (data.type === 'config') {
      state.config = { ...state.config, ...(data.config || {}) }
      post('config-updated', { config: state.config })
      return
    }
    if (data.type === 'reference-image') {
      setReferenceImage(data.payload || {})
      return
    }
    if (data.type === 'measurement') {
      processMeasurement(data.payload || {})
      return
    }
    if (data.type === 'visual-frame') {
      analyzeVisualFrame(data.payload || {})
      return
    }
  } catch (error) {
    state.workerState = 'ERROR'
    post('error', {
      message: error.message || 'Worker processing failed.',
      workerState: state.workerState,
      wasmState: state.wasmState,
    })
  }
}
