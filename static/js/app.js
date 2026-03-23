const CAMERA_ACCESS_ACTIVE_STATES = new Set([
  'READY',
  'CAPTURING',
  'THROTTLED',
  'BACKPRESSURE',
  'IN_FLIGHT',
])

const WORLD_METRIC_FIELDS = [
  'sessionState',
  'visibilityState',
  'worldState',
  'targetState',
  'targetName',
  'targetVisible',
  'targetUpdates',
  'targetMeasuredWidthM',
  'targetIndex',
  'targetMatchCount',
  'targetInlierCount',
  'targetInlierRatio',
  'targetConfidence',
  'targetReprojectionPx',
  'targetStableFrames',
  'targetPrelockMisses',
  'targetRejectReason',
  'targetBestInliers',
  'targetRefinedInliers',
  'targetRawMatchCount',
  'targetReciprocalMatchCount',
  'targetMatchStrategy',
  'targetReferenceReady',
  'targetReferenceFeatures',
  'hitTestState',
  'anchorState',
  'workerState',
  'wasmState',
  'cameraAccessState',
  'xrFps',
  'viewport',
  'localLatencyMs',
  'surfaceHits',
  'selectCount',
  'placementCount',
  'lastHitDistanceM',
  'hasPlacement',
  'filterSource',
  'filterConfidence',
  'measurementConfidence',
  'baseMeasurementConfidence',
  'workerProcMs',
  'workerLatencyMs',
  'residualTranslationM',
  'residualRotationDeg',
  'measurementDeltaTranslationM',
  'measurementDeltaRotationDeg',
  'posAlpha',
  'rotAlpha',
  'snapCount',
  'filterFrames',
  'speedMps',
  'visualState',
  'visualFrames',
  'visualFrameSize',
  'visualSourceSize',
  'visualFeatureCount',
  'visualFeatureDensity',
  'visualBrightness',
  'visualContrast',
  'visualMotion',
  'visualQuality',
  'visualCaptureMs',
  'visualProcMs',
  'trackCount',
  'matchCount',
  'matchRatio',
  'trackConfidence',
  'averageTrackAge',
  'maxTrackAge',
  'longTrackRatio',
  'keyframeCount',
  'landmarkCount',
  'stableLandmarkCount',
  'staleLandmarkCount',
  'staleLandmarkRatio',
  'keyframeGrowthPerSec',
  'landmarkGrowthPerSec',
  'motionObservability',
  'mapState',
  'relocalizationScore',
  'relocalizationKeyframeId',
  'relocalizationAttemptCount',
  'relocalizationRecoveryCount',
  'lastRelocalizationDurationMs',
  'currentRelocalizationDurationMs',
  'motionVectorX',
  'motionVectorY',
  'motionScale',
  'motionRotationDeg',
  'visualOdometryConfidence',
  'cameraCaptures',
  'cameraSkippedThrottle',
  'cameraSkippedBusy',
  'cameraLastCaptureMs',
  'cameraAverageCaptureMs',
  'cameraCaptureIntervalMs',
  'cameraCaptureMaxDimension',
  'cameraFramePending',
  'framebufferScale',
]

function copySelectedFields(target, source, fields) {
  fields.forEach((field) => {
    target[field] = source[field]
  })
}

function roundedNumber(value, digits) {
  return Number(Number(value || 0).toFixed(digits))
}

class CustomTrackerApp {
  constructor() {
    this.modelRenderer = new ModelRenderer('threeCanvas')
    if (typeof this.modelRenderer.setLogger === 'function') {
      this.modelRenderer.setLogger((message, data) => this.log(message, data, 'Renderer'))
    }

    this.imuManager = new DeviceMotionManager()
    this.cameraPipeline = new XRCameraFramePipeline({
      maxDimension: 160,
      minFrameIntervalMs: 220,
      onLog: (message, data) => this.log(message, data, 'Camera'),
    })
    this.worldTracker = new WebXRWorldTracker({
      modelRenderer: this.modelRenderer,
      cameraPipeline: this.cameraPipeline,
      overlayRoot: document.body,
      onLog: (message, data) => this.log(message, data, 'WebXR'),
      onStateChange: (state, diagnostics) => this.handleWorldStateChange(state, diagnostics),
    })

    this.statusDot = document.getElementById('statusDot')
    this.badge = document.getElementById('detectionBadge')
    this.panel = document.getElementById('infoPanel')
    this.trackerHud = document.getElementById('trackerHud')
    this.toggleBtn = document.getElementById('toggleBtn')
    this.resetBtn = document.getElementById('resetBtn')
    this.startOverlay = document.getElementById('startOverlay')
    this.targetPicker = document.getElementById('targetPicker')
    this.targetPickerTitle = document.getElementById('targetPickerTitle')
    this.targetGrid = document.getElementById('targetGrid')
    this.targetPreviewImage = document.getElementById('targetPreviewImage')
    this.targetPreviewName = document.getElementById('targetPreviewName')
    this.targetPreviewMeta = document.getElementById('targetPreviewMeta')
    this.targetPreviewHint = document.getElementById('targetPreviewHint')
    this.alignmentToolLink = document.getElementById('alignmentToolLink')
    this.startBtn = document.getElementById('startBtn')
    this.startStatus = document.getElementById('startStatus')
    this.runtimeLog = document.getElementById('runtimeLog')
    this.logCount = document.getElementById('logCount')
    this.copyLogsBtn = document.getElementById('copyLogsBtn')
    this.clearLogsBtn = document.getElementById('clearLogsBtn')

    this.running = false
    this.cleanedUp = false
    this.showInfo = false
    this.loopHandle = 0
    this.transitionCache = new Map()
    this.lastSummaryLog = 0
    this.lastProfileTuneAt = 0
    this.lastDebugUiUpdateAt = 0
    this.debugUiIntervalMs = 250
    this.runtimeStartAt = performance.now()
    this.logEntries = []
    this.logSequence = 0
    this.logLimit = 240
    this.backendSessionId = 'frontend-' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 1000000).toString(36)
    this.telemetrySequence = 0
    this.targetProfiles = []
    this.activeTargetId = ''
    this.experimentContext = {
      experimentId: '-',
      programVersion: '-',
      hypothesis: '',
      presetId: '-',
      deviceLabel: 'mobile-phone',
      runTag: '-',
      operatorNote: '',
      successCriteria: '',
      targetId: '-',
    }
    this.runMilestones = {
      started: false,
      firstDetection: false,
      firstLock: false,
      firstLoss: false,
    }

    this.metrics = {
      supportState: 'PENDING',
      sessionState: 'IDLE',
      visibilityState: 'hidden',
      worldState: 'IDLE',
      targetState: 'IDLE',
      targetName: '-',
      targetVisible: false,
      targetUpdates: 0,
      targetMeasuredWidthM: 0,
      targetIndex: -1,
      targetMatchCount: 0,
      targetInlierCount: 0,
      targetInlierRatio: 0,
      targetConfidence: 0,
      targetReprojectionPx: 0,
      targetStableFrames: 0,
      targetPrelockMisses: 0,
      targetRejectReason: 'NONE',
      targetBestInliers: 0,
      targetRefinedInliers: 0,
      targetRawMatchCount: 0,
      targetReciprocalMatchCount: 0,
      targetMatchStrategy: 'NONE',
      targetReferenceReady: false,
      targetReferenceFeatures: 0,
      hitTestState: 'DISABLED',
      anchorState: 'UNAVAILABLE',
      workerState: 'IDLE',
      wasmState: 'IDLE',
      cameraAccessState: 'IDLE',
      xrFps: 0,
      viewport: '-',
      frameTimeMs: 0,
      localLatencyMs: 0,
      surfaceHits: 0,
      selectCount: 0,
      placementCount: 0,
      lastHitDistanceM: 0,
      imuState: 'IDLE',
      renderState: 'IDLE',
      hasPlacement: false,
      filterSource: 'NONE',
      filterConfidence: 0,
      measurementConfidence: 0,
      baseMeasurementConfidence: 0,
      workerProcMs: 0,
      workerLatencyMs: 0,
      residualTranslationM: 0,
      residualRotationDeg: 0,
      measurementDeltaTranslationM: 0,
      measurementDeltaRotationDeg: 0,
      posAlpha: 0,
      rotAlpha: 0,
      snapCount: 0,
      filterFrames: 0,
      speedMps: 0,
      visualState: 'IDLE',
      visualFrames: 0,
      visualFrameSize: '-',
      visualSourceSize: '-',
      visualFeatureCount: 0,
      visualFeatureDensity: 0,
      visualBrightness: 0,
      visualContrast: 0,
      visualMotion: 0,
      visualQuality: 0,
      visualCaptureMs: 0,
      visualProcMs: 0,
      trackCount: 0,
      matchCount: 0,
      matchRatio: 0,
      trackConfidence: 0,
      averageTrackAge: 0,
      maxTrackAge: 0,
      longTrackRatio: 0,
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
      lastRelocalizationDurationMs: 0,
      currentRelocalizationDurationMs: 0,
      motionVectorX: 0,
      motionVectorY: 0,
      motionScale: 1,
      motionRotationDeg: 0,
      visualOdometryConfidence: 0,
      cameraCaptures: 0,
      cameraSkippedThrottle: 0,
      cameraSkippedBusy: 0,
      cameraLastCaptureMs: 0,
      cameraAverageCaptureMs: 0,
      cameraCaptureIntervalMs: 300,
      cameraCaptureMaxDimension: 128,
      cameraFramePending: false,
      framebufferScale: 1,
      buildSignature: '-',
      trackingMode: '-',
      researchTrack: '-',
      featureCount: 0,
      requiredCapabilityCount: 0,
      requiredCapabilities: [],
      smokeReportEndpoint: '-',
      noFallbacks: true,
      assetMode: '-',
      frontendTelemetryEndpoint: '/frontend-telemetry',
      backendLoggingMode: '-',
    }
    this.setScreenMode('start')
    this.modelRenderer.resetPose()
    this.setupEvents()
    this.init()
  }
}

window.CustomTrackerApp = CustomTrackerApp

