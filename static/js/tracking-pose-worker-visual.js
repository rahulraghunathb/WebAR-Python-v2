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
  let maxTrackAge = 0

  for (const match of matches) {
    match.current.trackId = match.previous.trackId
    match.current.age = Number(match.previous.age || 1) + 1
    maxTrackAge = Math.max(maxTrackAge, match.current.age)
  }

  for (const feature of features) {
    if (feature.trackId > 0) {
      continue
    }
    feature.trackId = state.visual.nextTrackId
    feature.age = 1
    state.visual.nextTrackId += 1
  }

  let trackAgeAccumulator = 0
  let longTrackCount = 0
  for (const feature of features) {
    const featureAge = Number(feature.age || 1)
    trackAgeAccumulator += featureAge
    maxTrackAge = Math.max(maxTrackAge, featureAge)
    if (featureAge >= 4) {
      longTrackCount += 1
    }

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
    existing.age = Math.max(existing.age, featureAge)
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
  const landmarkValues = Array.from(state.visual.landmarks.values())
  const stableLandmarkCount = landmarkValues.filter((landmark) => landmark.observations >= 3).length
  const staleLandmarkCount = landmarkValues.filter((landmark) => state.visual.frames - Number(landmark.lastFrame || 0) >= 12).length
  const staleLandmarkRatio = landmarkValues.length ? staleLandmarkCount / landmarkValues.length : 0
  const matchRatio = features.length
    ? matches.length / Math.max(1, Math.min(features.length, state.visual.prevFeatures.length || features.length))
    : 0
  const averageTrackAge = features.length ? trackAgeAccumulator / features.length : 0
  const longTrackRatio = features.length ? longTrackCount / features.length : 0
  const landmarkScore = clamp01(stableLandmarkCount / 36)
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
  state.visual.averageTrackAge = averageTrackAge
  state.visual.maxTrackAge = maxTrackAge
  state.visual.longTrackRatio = longTrackRatio
  state.visual.trackCount = features.length
  state.visual.matchCount = matches.length
  state.visual.matchRatio = matchRatio
  state.visual.trackConfidence = trackConfidence
  state.visual.keyframeCount = state.visual.keyframes.length
  state.visual.landmarkCount = stableLandmarkCount
  state.visual.stableLandmarkCount = stableLandmarkCount
  state.visual.staleLandmarkCount = staleLandmarkCount
  state.visual.staleLandmarkRatio = staleLandmarkRatio
  state.visual.relocalizationScore = relocalizationScore
  state.visual.relocalizationKeyframeId = relocalizationScore > 0 ? relocalization.keyframeId : -1

  const growthDtSec = state.visual.lastGrowthTimestampMs
    ? Math.max(0.001, (timestampMs - state.visual.lastGrowthTimestampMs) / 1000)
    : 0
  state.visual.keyframeGrowthPerSec = growthDtSec
    ? (state.visual.keyframeCount - state.visual.lastGrowthKeyframeCount) / growthDtSec
    : 0
  state.visual.landmarkGrowthPerSec = growthDtSec
    ? (state.visual.landmarkCount - state.visual.lastGrowthLandmarkCount) / growthDtSec
    : 0
  state.visual.lastGrowthTimestampMs = timestampMs
  state.visual.lastGrowthKeyframeCount = state.visual.keyframeCount
  state.visual.lastGrowthLandmarkCount = state.visual.landmarkCount

  const mappedKeyframes = Number(state.config.minMappedKeyframes || 3)
  const mappedLandmarks = Number(state.config.minMappedLandmarks || 24)
  const mappedMatchRatio = Number(state.config.minMappedMatchRatio || 0.38)
  const mappedTrackConfidence = Number(state.config.minMappedTrackConfidence || 0.42)
  const previousMapState = state.visual.mapState || 'BOOTSTRAP'
  let nextMapState = 'BOOTSTRAP'

  if (
    state.visual.keyframeCount >= mappedKeyframes &&
    stableLandmarkCount >= mappedLandmarks &&
    features.length >= 14 &&
    matches.length >= 8 &&
    matchRatio >= mappedMatchRatio &&
    trackConfidence >= mappedTrackConfidence &&
    relocalizationScore >= 0.35
  ) {
    nextMapState = 'MAPPED'
  } else if (
    relocalizationScore >= 0.45 &&
    features.length >= 10 &&
    matches.length >= 5 &&
    trackConfidence >= 0.26
  ) {
    nextMapState = 'RELOCALIZING'
  } else if (
    features.length >= 8 &&
    matches.length >= 4 &&
    trackConfidence >= 0.18
  ) {
    nextMapState = 'TRACKING'
  }

   if (nextMapState === 'RELOCALIZING' && previousMapState !== 'RELOCALIZING') {
    state.visual.relocalizationAttemptCount += 1
    state.visual.relocalizationStartMs = timestampMs
  } else if (previousMapState === 'RELOCALIZING' && nextMapState !== 'RELOCALIZING') {
    if (['TRACKING', 'MAPPED'].includes(nextMapState)) {
      state.visual.relocalizationRecoveryCount += 1
      state.visual.lastRelocalizationDurationMs = state.visual.relocalizationStartMs
        ? Math.max(0, timestampMs - state.visual.relocalizationStartMs)
        : 0
    }
    state.visual.relocalizationStartMs = 0
  }

  state.visual.currentRelocalizationDurationMs =
    nextMapState === 'RELOCALIZING' && state.visual.relocalizationStartMs
      ? Math.max(0, timestampMs - state.visual.relocalizationStartMs)
      : 0
  state.visual.mapState = nextMapState
}


