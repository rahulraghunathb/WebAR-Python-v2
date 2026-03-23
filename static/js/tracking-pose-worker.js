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
  referenceFeatureLimit: 128,
  referenceMaxDimension: 224,
  targetDescriptorThreshold: 0.48,
  targetRatioThreshold: 0.82,
  targetSearchFeatures: 56,
  minTargetMatches: 6,
  minTargetInliers: 5,
  targetInlierPx: 7,
  targetRansacIterations: 96,
  targetStableFrames: 3,
  targetStableWindowMs: 320,
  targetStableMinConfidence: 0.34,
  targetStableMinInliers: 6,
  targetStableMaxReprojectionPx: 6.2,
  targetFreshPoseMs: 380,
  targetTrackHoldMs: 900,
  targetLostHoldMs: 1800,
  targetMinCoverage: 0.012,
  targetMaxAspectSkew: 5.2,
  targetMaxStableTranslationDeltaM: 0.24,
  targetMaxStableRotationDeltaDeg: 32,
  targetPrelockAllowedMisses: 1,
  targetSingleFrameBootstrapMinMatches: 24,
  targetSingleFrameBootstrapMinInliers: 5,
  targetSingleFrameBootstrapMaxReprojectionPx: 1.2,
  targetSingleFrameBootstrapMinConfidence: 0.58,
  targetSingleFrameBootstrapMinVisualQuality: 0.62,
  targetReciprocalMinMatches: 6,
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
    lastSolvedPoseTimestampMs: 0,
    updates: 0,
    stableFrames: 0,
    lockSamples: [],
    prelockMisses: 0,
    rejectReason: 'NONE',
    bestInliers: 0,
    refinedInliers: 0,
    rawMatchCount: 0,
    reciprocalMatchCount: 0,
    matchStrategy: 'NONE',
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
    averageTrackAge: 0,
    maxTrackAge: 0,
    longTrackRatio: 0,
    trackCount: 0,
    keyframeCount: 0,
    landmarkCount: 0,
    stableLandmarkCount: 0,
    staleLandmarkCount: 0,
    staleLandmarkRatio: 0,
    keyframeGrowthPerSec: 0,
    landmarkGrowthPerSec: 0,
    motionObservability: 0,
    mapState: 'BOOTSTRAP',
    relocalizationScore: 0,
    relocalizationKeyframeId: -1,
    relocalizationAttemptCount: 0,
    relocalizationRecoveryCount: 0,
    relocalizationStartMs: 0,
    lastRelocalizationDurationMs: 0,
    currentRelocalizationDurationMs: 0,
    motionX: 0,
    motionY: 0,
    motionScale: 1,
    motionRotationDeg: 0,
    visualOdometryConfidence: 0,
    lastKeyframeFrame: 0,
    lastGrowthTimestampMs: 0,
    lastGrowthKeyframeCount: 0,
    lastGrowthLandmarkCount: 0,
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


importScripts('/static/js/tracking-pose-worker-math.js', '/static/js/tracking-pose-worker-target.js', '/static/js/tracking-pose-worker-pose.js', '/static/js/tracking-pose-worker-visual.js', '/static/js/tracking-pose-worker-pipeline.js')

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
  state.reference.lastSolvedPoseTimestampMs = 0
  state.reference.updates = 0
  state.reference.rejectReason = 'NONE'
  state.reference.bestInliers = 0
  state.reference.refinedInliers = 0
  state.reference.rawMatchCount = 0
  state.reference.reciprocalMatchCount = 0
  state.reference.matchStrategy = 'NONE'
  clearReferenceLockTracking()
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
  state.visual.averageTrackAge = 0
  state.visual.maxTrackAge = 0
  state.visual.longTrackRatio = 0
  state.visual.keyframeCount = 0
  state.visual.landmarkCount = 0
  state.visual.stableLandmarkCount = 0
  state.visual.staleLandmarkCount = 0
  state.visual.staleLandmarkRatio = 0
  state.visual.keyframeGrowthPerSec = 0
  state.visual.landmarkGrowthPerSec = 0
  state.visual.motionObservability = 0
  state.visual.mapState = 'BOOTSTRAP'
  state.visual.relocalizationScore = 0
  state.visual.relocalizationKeyframeId = -1
  state.visual.relocalizationAttemptCount = 0
  state.visual.relocalizationRecoveryCount = 0
  state.visual.relocalizationStartMs = 0
  state.visual.lastRelocalizationDurationMs = 0
  state.visual.currentRelocalizationDurationMs = 0
  state.visual.motionX = 0
  state.visual.motionY = 0
  state.visual.motionScale = 1
  state.visual.motionRotationDeg = 0
  state.visual.visualOdometryConfidence = 0
  state.visual.lastKeyframeFrame = 0
  state.visual.lastGrowthTimestampMs = 0
  state.visual.lastGrowthKeyframeCount = 0
  state.visual.lastGrowthLandmarkCount = 0
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
