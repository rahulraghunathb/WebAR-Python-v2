class CustomTrackerApp {
  constructor() {
    this.modelRenderer = new ModelRenderer('threeCanvas')
    if (typeof this.modelRenderer.setLogger === 'function') {
      this.modelRenderer.setLogger((message, data) => this.log(message, data, 'Renderer'))
    }

    this.imuManager = new DeviceMotionManager()
    this.cameraPipeline = new XRCameraFramePipeline({
      maxDimension: 128,
      minFrameIntervalMs: 300,
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

  serializeLogData(data) {
    if (typeof data === 'undefined') {
      return ''
    }

    try {
      const serialized = JSON.stringify(data)
      if (serialized.length > 220) {
        return serialized.slice(0, 217) + '...'
      }
      return serialized
    } catch (error) {
      return '[unserializable]'
    }
  }

  formatLogEntry(entry) {
    const seq = String(entry.seq).padStart(4, '0')
    const time = (entry.elapsedMs / 1000).toFixed(3).padStart(8, ' ')
    const payload = entry.serializedData ? ' ' + entry.serializedData : ''
    return '#' + seq + ' ' + time + 's [' + entry.source + '] ' + entry.message + payload
  }

  renderLogStream() {
    if (!this.runtimeLog) {
      return
    }

    const stickToBottom =
      this.runtimeLog.scrollHeight - this.runtimeLog.scrollTop - this.runtimeLog.clientHeight < 24
    const lines = this.logEntries.map((entry) => this.formatLogEntry(entry))
    this.runtimeLog.textContent = lines.join('\n')
    if (stickToBottom) {
      this.runtimeLog.scrollTop = this.runtimeLog.scrollHeight
    }
    if (this.logCount) {
      this.logCount.textContent = String(this.logEntries.length)
    }
  }

  log(message, data, source = 'App') {
    if (typeof data === 'undefined') {
      console.info('[' + source + ']', message)
    } else {
      console.info('[' + source + ']', message, data)
    }

    this.logSequence += 1
    this.logEntries.push({
      seq: this.logSequence,
      elapsedMs: performance.now() - this.runtimeStartAt,
      source: source,
      message: message,
      serializedData: this.serializeLogData(data),
    })

    if (this.logEntries.length > this.logLimit) {
      this.logEntries.splice(0, this.logEntries.length - this.logLimit)
    }
    this.renderLogStream()
  }

  logTransition(key, value, data) {
    if (this.transitionCache.get(key) === value) {
      return
    }
    this.transitionCache.set(key, value)
    this.log(key + ' -> ' + value, data, 'State')
    if (this.shouldForwardTransition(key, value)) {
      this.sendBackendTelemetry('transition', {
        source: key,
        message: key + ' -> ' + value,
        value: value,
      })
    }
  }

  async copyLogs() {
    if (!navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') {
      this.log('Clipboard API unavailable for log copy', undefined, 'Logs')
      return
    }

    const payload = this.logEntries.map((entry) => this.formatLogEntry(entry)).join('\n')
    try {
      await navigator.clipboard.writeText(payload)
      this.log('Copied ordered runtime logs', { lines: this.logEntries.length }, 'Logs')
    } catch (error) {
      this.log('Failed to copy logs', { message: error.message }, 'Logs')
    }
  }

  clearLogs() {
    this.logEntries = []
    this.renderLogStream()
    this.log('Log buffer cleared', undefined, 'Logs')
  }

  async loadArchitectureContract() {
    try {
      const response = await fetch('/status', { cache: 'no-store' })
      if (!response.ok) {
        throw new Error('Status request failed with ' + response.status)
      }
      const status = await response.json()
      this.metrics.buildSignature = status.build_signature || '-'
      this.metrics.trackingMode = status.tracking_mode || '-'
      this.metrics.researchTrack = status.research_track || '-'
      this.metrics.featureCount = Number(status.feature_count || 0)
      this.metrics.requiredCapabilityCount = Number(status.required_capability_count || 0)
      this.metrics.requiredCapabilities = Array.isArray(status.required_runtime_capabilities) ? status.required_runtime_capabilities.slice() : []
      this.metrics.smokeReportEndpoint = status.smoke_report_endpoint || '-'
      this.metrics.frontendTelemetryEndpoint = status.frontend_telemetry_endpoint || '/frontend-telemetry'
      this.metrics.noFallbacks = Boolean(status.no_fallbacks)
      this.metrics.assetMode = status.asset_mode || '-'
      this.metrics.backendLoggingMode = status.backend_logging_mode || '-'
      this.log('Loaded architecture contract', {
        build: this.metrics.buildSignature,
        trackingMode: this.metrics.trackingMode,
        featureCount: this.metrics.featureCount,
        requiredCapabilityCount: this.metrics.requiredCapabilityCount,
        noFallbacks: this.metrics.noFallbacks,
        backendLoggingMode: this.metrics.backendLoggingMode,
      }, 'Contract')
    } catch (error) {
      this.log('Failed to load architecture contract', { message: error.message }, 'Contract')
    }
  }

  shouldForwardTransition(key, value) {
    if (key === 'camera-access') {
      return ['ERROR', 'NO_CAMERA_ACCESS', 'NO_CAMERA_IMAGE', 'NO_CAMERA_SIZE'].includes(value)
    }
    return [
      'support',
      'session',
      'world',
      'target',
      'hit-test',
      'anchor',
      'worker',
      'wasm',
      'visual',
      'imu',
    ].includes(key)
  }

  buildBackendTelemetryPayload(kind, extra = {}) {
    const world = this.worldTracker.getDiagnostics()
    const render = this.modelRenderer.getDiagnostics()

    return {
      kind: kind,
      seq: ++this.telemetrySequence,
      sessionId: this.backendSessionId,
      sentAtIso: new Date().toISOString(),
      elapsedMs: Number((performance.now() - this.runtimeStartAt).toFixed(2)),
      buildSignature: this.metrics.buildSignature,
      trackingMode: this.metrics.trackingMode,
      researchTrack: this.metrics.researchTrack,
      sessionState: world.sessionState,
      referenceSpace: world.referenceSpace,
      worldState: world.worldState,
      targetState: world.targetState,
      targetName: world.targetName,
      targetVisible: Boolean(world.targetVisible),
      targetUpdates: Number(world.targetUpdates || 0),
      targetMeasuredWidthM: Number((world.targetMeasuredWidthM || 0).toFixed(3)),
      targetIndex: typeof world.targetIndex === 'number' ? world.targetIndex : -1,
      targetMatchCount: Number(world.targetMatchCount || 0),
      targetInlierCount: Number(world.targetInlierCount || 0),
      targetInlierRatio: Number(((world.targetInlierRatio || (world.targetMatchCount ? world.targetInlierCount / world.targetMatchCount : 0)) || 0).toFixed(3)),
      targetConfidence: Number((world.targetConfidence || 0).toFixed(3)),
      targetReprojectionPx: Number((world.targetReprojectionPx || 0).toFixed(3)),
      targetReferenceReady: Boolean(world.targetReferenceReady),
      targetReferenceFeatures: Number(world.targetReferenceFeatures || 0),
      hitTestState: world.hitTestState,
      anchorState: world.anchorState,
      workerState: world.workerState,
      wasmState: world.wasmState,
      cameraAccessState: world.cameraAccessState,
      visualState: world.visualState,
      visualFeatureCount: world.visualFeatureCount,
      visualQuality: Number(world.visualQuality.toFixed(3)),
      visualProcMs: Number(world.visualProcMs.toFixed(3)),
      visualCaptureMs: Number(world.visualCaptureMs.toFixed(3)),
      trackCount: world.trackCount,
      averageTrackAge: Number((world.averageTrackAge || 0).toFixed(3)),
      maxTrackAge: Number((world.maxTrackAge || 0).toFixed(3)),
      longTrackRatio: Number((world.longTrackRatio || 0).toFixed(3)),
      matchCount: world.matchCount,
      keyframeCount: world.keyframeCount,
      landmarkCount: world.landmarkCount,
      stableLandmarkCount: Number(world.stableLandmarkCount || 0),
      staleLandmarkCount: Number(world.staleLandmarkCount || 0),
      staleLandmarkRatio: Number((world.staleLandmarkRatio || 0).toFixed(3)),
      keyframeGrowthPerSec: Number((world.keyframeGrowthPerSec || 0).toFixed(3)),
      landmarkGrowthPerSec: Number((world.landmarkGrowthPerSec || 0).toFixed(3)),
      motionObservability: Number((world.motionObservability || 0).toFixed(3)),
      mapState: world.mapState,
      relocalizationScore: Number(world.relocalizationScore.toFixed(3)),
      relocalizationAttemptCount: Number(world.relocalizationAttemptCount || 0),
      relocalizationRecoveryCount: Number(world.relocalizationRecoveryCount || 0),
      lastRelocalizationDurationMs: Number((world.lastRelocalizationDurationMs || 0).toFixed(2)),
      currentRelocalizationDurationMs: Number((world.currentRelocalizationDurationMs || 0).toFixed(2)),
      filterConfidence: Number(world.filterConfidence.toFixed(3)),
      surfaceHits: Number(world.surfaceHits || 0),
      hasPlacement: Boolean(world.hasPlacement),
      xrFps: Number(world.xrFps || 0),
      frameTimeMs: Number(render.lastFrameMs.toFixed(2)),
      workerProcMs: Number(world.workerProcMs.toFixed(3)),
      workerLatencyMs: Number(world.workerLatencyMs.toFixed(3)),
      measurementDeltaTranslationM: Number(((world.measurementDeltaTranslationM || world.residualTranslationM || 0)).toFixed(4)),
      measurementDeltaRotationDeg: Number(((world.measurementDeltaRotationDeg || world.residualRotationDeg || 0)).toFixed(3)),
      cameraAverageCaptureMs: Number(world.cameraAverageCaptureMs.toFixed(3)),
      cameraCaptureIntervalMs: Number(world.cameraCaptureIntervalMs || 0),
      cameraCaptureMaxDimension: Number(world.cameraCaptureMaxDimension || 0),
      cameraSkippedThrottle: Number(world.cameraSkippedThrottle || 0),
      cameraSkippedBusy: Number(world.cameraSkippedBusy || 0),
      cameraFramePending: Boolean(world.cameraFramePending),
      source: extra.source || 'runtime',
      message: extra.message,
      value: typeof extra.value === 'undefined' ? undefined : extra.value,
    }
  }

  sendBackendTelemetry(kind, extra = {}) {
    const endpoint = this.metrics.frontendTelemetryEndpoint || '/frontend-telemetry'
    if (!endpoint || endpoint === '-') {
      return
    }

    const payload = this.buildBackendTelemetryPayload(kind, extra)
    fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      keepalive: true,
    }).catch((error) => {
      console.warn('[BackendTelemetry] send failed', error)
    })
  }

  setText(id, value) {
    const element = document.getElementById(id)
    if (element) {
      element.textContent = value
    }
  }

  setTrackerCard(baseId, state, label, meta) {
    const card = document.getElementById(baseId)
    const stateEl = document.getElementById(baseId + 'State')
    const metaEl = document.getElementById(baseId + 'Meta')
    if (card) {
      card.dataset.state = state
    }
    if (stateEl) {
      stateEl.textContent = label
    }
    if (metaEl) {
      metaEl.textContent = meta
    }
  }

  setPermissionState(elementId, state, label) {
    const element = document.getElementById(elementId)
    if (!element) {
      return
    }

    element.classList.remove('granted', 'denied', 'optional')
    if (state && state !== 'pending') {
      element.classList.add(state)
    }
    element.textContent = label
  }

  setDebugOverlayVisible(visible) {
    this.showInfo = visible
    this.panel.classList.toggle('visible', visible)
    this.trackerHud.classList.toggle('visible', visible)
    this.toggleBtn.classList.toggle('active', visible)
    this.toggleBtn.textContent = visible ? 'Hide Debug' : 'Show Debug'
    this.toggleBtn.setAttribute('aria-pressed', visible ? 'true' : 'false')
    if (visible) {
      this.lastDebugUiUpdateAt = 0
      this.updateLocalInfo()
      this.updateInfoPanel()
      this.updateTrackerHud()
    }
  }

  setScreenMode(mode) {
    const nextMode = mode === 'tracking' ? 'screen-tracking' : 'screen-start'
    document.body.classList.remove('screen-start', 'screen-tracking')
    document.body.classList.add(nextMode)
  }

  setupEvents() {
    this.startBtn.addEventListener('click', () => this.start())
    this.toggleBtn.addEventListener('click', () => {
      this.setDebugOverlayVisible(!this.showInfo)
      this.log('Debug overlays toggled', { open: this.showInfo })
    })
    this.resetBtn.addEventListener('click', () => {
      this.worldTracker.resetPlacement()
      this.updateBadge()
      this.updateTrackerHud()
      this.updateInfoPanel()
    })
    if (this.copyLogsBtn) {
      this.copyLogsBtn.addEventListener('click', () => this.copyLogs())
    }
    if (this.clearLogsBtn) {
      this.clearLogsBtn.addEventListener('click', () => this.clearLogs())
    }
    window.addEventListener('resize', () => this.handleResize())
    window.addEventListener('beforeunload', () => this.cleanup())
    window.addEventListener('pagehide', () => this.cleanup())
    window.addEventListener('pageshow', (event) => {
      if (!event.persisted) {
        return
      }
      this.log('Page restored from cache, resetting runtime state')
      this.modelRenderer.resetPose()
      this.running = false
      this.setScreenMode('start')
      this.startOverlay.classList.remove('hidden')
      this.badge.classList.remove('visible')
      this.startBtn.disabled = this.metrics.supportState !== 'SUPPORTED'
    })
  }

  async init() {
    this.log('Booting worker + WASM + owned target-tracking runtime')
    await this.loadArchitectureContract()
    this.log('Initial capture profile', {
      maxDimension: this.metrics.cameraCaptureMaxDimension,
      minFrameIntervalMs: this.metrics.cameraCaptureIntervalMs,
    }, 'Perf')
    this.setPermissionState('permXR', 'pending', 'Checking WebXR Support')
    this.setPermissionState('permCamera', 'pending', 'Checking Raw Camera Access')
    this.setPermissionState('permMotion', 'optional', 'Optional Motion Sensors')
    this.setPermissionState('permSession', 'pending', 'Target Tracking Pipeline Not Started')
    this.setDebugOverlayVisible(false)
    this.handleResize()
    this.updateTrackerHud()

    const support = await this.worldTracker.checkSupport()
    this.metrics.supportState = this.worldTracker.getDiagnostics().supportState
    if (support.supported) {
      this.startStatus.textContent = 'Worker + WASM target tracking is ready. This build uses camera-access plus a repo-owned image-target tracker, with no browser image-tracking dependency and no fallback path.'
      this.setPermissionState('permXR', 'granted', 'WebXR Ready')
      this.setPermissionState('permCamera', 'granted', 'Raw Camera Access Available')
      this.startBtn.disabled = false
      this.setStatusDot('ready')
      this.logTransition('support', 'SUPPORTED')
    } else {
      this.startStatus.textContent = support.reason
      this.setPermissionState('permXR', 'denied', support.reason)
      this.setPermissionState('permCamera', 'denied', 'Raw Camera Access Unavailable')
      this.startBtn.disabled = true
      this.setStatusDot('error')
      this.logTransition('support', 'UNAVAILABLE', { reason: support.reason })
    }

    this.updateTrackerHud()
    this.updateInfoPanel()
  }

  async start() {
    if (this.running) {
      return
    }

    this.cleanedUp = false
    this.startBtn.disabled = true
    this.badge.classList.remove('visible')
    this.startStatus.textContent = 'Loading model...'
    this.setPermissionState('permSession', 'pending', 'Preparing Target Tracking Pipeline')

    try {
      await this.modelRenderer.waitForModel()

      this.startStatus.textContent = 'Requesting optional motion sensor access...'
      const imuGranted = await this.imuManager.requestPermission()
      if (imuGranted) {
        this.metrics.imuState = 'ACTIVE'
        this.setPermissionState('permMotion', 'granted', 'Motion Sensors Ready')
        this.modelRenderer.setIMUManager(this.imuManager)
        this.logTransition('imu', 'ACTIVE')
      } else {
        this.metrics.imuState = 'UNAVAILABLE'
        this.setPermissionState('permMotion', 'optional', 'Motion Sensors Unavailable')
        this.logTransition('imu', 'UNAVAILABLE')
      }

      this.startStatus.textContent = 'Starting worker + WASM owned target-tracking session...'
      await this.worldTracker.start()
      this.running = true
      this.setScreenMode('tracking')
      this.startOverlay.classList.add('hidden')
      this.setPermissionState('permSession', 'granted', 'Target Tracking Pipeline Active')
      this.setPermissionState('permCamera', 'granted', 'Raw Camera Frames Active')
      this.setStatusDot('active')
      this.handleResize()
      this.lastProfileTuneAt = 0
      this.loop()
      this.updateBadge()
      this.updateTrackerHud()
      this.updateInfoPanel()
      this.maybeTuneCaptureProfile(true)
    } catch (error) {
      console.error('[CustomTracker] Start failed', error)
      this.log('Start failed', { message: error.message }, 'App')
      this.sendBackendTelemetry('error', { source: 'start', message: error.message })
      this.running = false
      this.setScreenMode('start')
      this.setStatusDot('error')
      this.setPermissionState('permSession', 'denied', 'Target Tracking Pipeline Failed')
      this.setPermissionState('permCamera', 'denied', 'Raw Camera Access Failed')
      this.setPermissionState('permXR', 'denied', 'XR Session Failed')
      this.startStatus.textContent = error.message
      this.startBtn.disabled = this.metrics.supportState !== 'SUPPORTED'
      this.updateTrackerHud()
      this.updateInfoPanel()
    }
  }

  handleWorldStateChange(state, diagnostics) {
    this.metrics.sessionState = diagnostics.sessionState
    this.metrics.visibilityState = diagnostics.visibilityState
    this.metrics.worldState = diagnostics.worldState
    this.metrics.targetState = diagnostics.targetState
    this.metrics.targetName = diagnostics.targetName
    this.metrics.targetVisible = diagnostics.targetVisible
    this.metrics.targetUpdates = diagnostics.targetUpdates
    this.metrics.targetMeasuredWidthM = diagnostics.targetMeasuredWidthM
    this.metrics.targetIndex = diagnostics.targetIndex
    this.metrics.targetMatchCount = diagnostics.targetMatchCount
    this.metrics.targetInlierCount = diagnostics.targetInlierCount
    this.metrics.targetInlierRatio = diagnostics.targetInlierRatio
    this.metrics.targetConfidence = diagnostics.targetConfidence
    this.metrics.targetReprojectionPx = diagnostics.targetReprojectionPx
    this.metrics.targetReferenceReady = diagnostics.targetReferenceReady
    this.metrics.targetReferenceFeatures = diagnostics.targetReferenceFeatures
    this.metrics.hitTestState = diagnostics.hitTestState
    this.metrics.anchorState = diagnostics.anchorState
    this.metrics.workerState = diagnostics.workerState
    this.metrics.wasmState = diagnostics.wasmState
    this.metrics.cameraAccessState = diagnostics.cameraAccessState
    this.metrics.surfaceHits = diagnostics.surfaceHits
    this.metrics.selectCount = diagnostics.selectCount
    this.metrics.placementCount = diagnostics.placementCount
    this.metrics.lastHitDistanceM = diagnostics.lastHitDistanceM
    this.metrics.xrFps = diagnostics.xrFps
    this.metrics.viewport = diagnostics.viewport
    this.metrics.localLatencyMs = diagnostics.localLatencyMs
    this.metrics.hasPlacement = diagnostics.hasPlacement
    this.metrics.filterSource = diagnostics.filterSource
    this.metrics.filterConfidence = diagnostics.filterConfidence
    this.metrics.measurementConfidence = diagnostics.measurementConfidence
    this.metrics.baseMeasurementConfidence = diagnostics.baseMeasurementConfidence
    this.metrics.workerProcMs = diagnostics.workerProcMs
    this.metrics.workerLatencyMs = diagnostics.workerLatencyMs
    this.metrics.residualTranslationM = diagnostics.residualTranslationM
    this.metrics.residualRotationDeg = diagnostics.residualRotationDeg
    this.metrics.measurementDeltaTranslationM = diagnostics.measurementDeltaTranslationM
    this.metrics.measurementDeltaRotationDeg = diagnostics.measurementDeltaRotationDeg
    this.metrics.posAlpha = diagnostics.posAlpha
    this.metrics.rotAlpha = diagnostics.rotAlpha
    this.metrics.snapCount = diagnostics.snapCount
    this.metrics.filterFrames = diagnostics.filterFrames
    this.metrics.speedMps = diagnostics.speedMps
    this.metrics.visualState = diagnostics.visualState
    this.metrics.visualFrames = diagnostics.visualFrames
    this.metrics.visualFrameSize = diagnostics.visualFrameSize
    this.metrics.visualSourceSize = diagnostics.visualSourceSize
    this.metrics.visualFeatureCount = diagnostics.visualFeatureCount
    this.metrics.visualFeatureDensity = diagnostics.visualFeatureDensity
    this.metrics.visualBrightness = diagnostics.visualBrightness
    this.metrics.visualContrast = diagnostics.visualContrast
    this.metrics.visualMotion = diagnostics.visualMotion
    this.metrics.visualQuality = diagnostics.visualQuality
    this.metrics.visualCaptureMs = diagnostics.visualCaptureMs
    this.metrics.visualProcMs = diagnostics.visualProcMs
    this.metrics.trackCount = diagnostics.trackCount
    this.metrics.averageTrackAge = diagnostics.averageTrackAge
    this.metrics.maxTrackAge = diagnostics.maxTrackAge
    this.metrics.longTrackRatio = diagnostics.longTrackRatio
    this.metrics.matchCount = diagnostics.matchCount
    this.metrics.matchRatio = diagnostics.matchRatio
    this.metrics.trackConfidence = diagnostics.trackConfidence
    this.metrics.keyframeCount = diagnostics.keyframeCount
    this.metrics.landmarkCount = diagnostics.landmarkCount
    this.metrics.stableLandmarkCount = diagnostics.stableLandmarkCount
    this.metrics.staleLandmarkCount = diagnostics.staleLandmarkCount
    this.metrics.staleLandmarkRatio = diagnostics.staleLandmarkRatio
    this.metrics.keyframeGrowthPerSec = diagnostics.keyframeGrowthPerSec
    this.metrics.landmarkGrowthPerSec = diagnostics.landmarkGrowthPerSec
    this.metrics.motionObservability = diagnostics.motionObservability
    this.metrics.mapState = diagnostics.mapState
    this.metrics.relocalizationScore = diagnostics.relocalizationScore
    this.metrics.relocalizationKeyframeId = diagnostics.relocalizationKeyframeId
    this.metrics.relocalizationAttemptCount = diagnostics.relocalizationAttemptCount
    this.metrics.relocalizationRecoveryCount = diagnostics.relocalizationRecoveryCount
    this.metrics.lastRelocalizationDurationMs = diagnostics.lastRelocalizationDurationMs
    this.metrics.currentRelocalizationDurationMs = diagnostics.currentRelocalizationDurationMs
    this.metrics.motionVectorX = diagnostics.motionVectorX
    this.metrics.motionVectorY = diagnostics.motionVectorY
    this.metrics.motionScale = diagnostics.motionScale
    this.metrics.motionRotationDeg = diagnostics.motionRotationDeg
    this.metrics.visualOdometryConfidence = diagnostics.visualOdometryConfidence
    this.metrics.cameraCaptures = diagnostics.cameraCaptures
    this.metrics.cameraSkippedThrottle = diagnostics.cameraSkippedThrottle
    this.metrics.cameraSkippedBusy = diagnostics.cameraSkippedBusy
    this.metrics.cameraLastCaptureMs = diagnostics.cameraLastCaptureMs
    this.metrics.cameraAverageCaptureMs = diagnostics.cameraAverageCaptureMs
    this.metrics.cameraCaptureIntervalMs = diagnostics.cameraCaptureIntervalMs
    this.metrics.cameraCaptureMaxDimension = diagnostics.cameraCaptureMaxDimension
    this.metrics.cameraFramePending = diagnostics.cameraFramePending
    this.metrics.framebufferScale = diagnostics.framebufferScale

    this.logTransition('session', diagnostics.sessionState)
    this.logTransition('world', state)
    this.logTransition('target', diagnostics.targetState)
    this.logTransition('hit-test', diagnostics.hitTestState)
    this.logTransition('anchor', diagnostics.anchorState)
    this.logTransition('worker', diagnostics.workerState)
    this.logTransition('wasm', diagnostics.wasmState)
    this.logTransition('camera-access', diagnostics.cameraAccessState)
    this.logTransition('visual', diagnostics.visualState)

    if (
      diagnostics.cameraAccessState === 'READY' ||
      diagnostics.cameraAccessState === 'CAPTURING' ||
      diagnostics.cameraAccessState === 'THROTTLED' ||
      diagnostics.cameraAccessState === 'BACKPRESSURE' ||
      diagnostics.cameraAccessState === 'IN_FLIGHT'
    ) {
      this.setPermissionState('permCamera', 'granted', 'Raw Camera Frames Active')
    }

    if (state === 'ENDED') {
      this.running = false
      this.setScreenMode('start')
      this.startOverlay.classList.remove('hidden')
      this.startStatus.textContent = 'AR session ended. Tap start to re-enter worker + WASM owned target tracking.'
      this.startBtn.disabled = this.metrics.supportState !== 'SUPPORTED'
      this.setPermissionState('permSession', 'pending', 'Target Tracking Pipeline Not Started')
      this.setPermissionState('permCamera', 'pending', 'Raw Camera Access Available')
      this.badge.classList.remove('visible')
      this.setStatusDot(this.metrics.supportState === 'SUPPORTED' ? 'ready' : 'error')
    } else if (state === 'ERROR') {
      this.running = false
      this.setScreenMode('start')
      this.startOverlay.classList.remove('hidden')
      this.startStatus.textContent = 'Target tracking encountered an error. Tap start to try again.'
      this.startBtn.disabled = this.metrics.supportState !== 'SUPPORTED'
      this.badge.classList.remove('visible')
      this.setStatusDot('error')
    } else if (state === 'TRACKING') {
      this.setStatusDot('active')
    } else if (state === 'RELOCALIZING' || state === 'SCANNING') {
      this.setStatusDot('ready')
    }

    this.updateBadge()
    this.updateTrackerHud()
    this.updateInfoPanel()
  }

  setStatusDot(state) {
    this.statusDot.classList.remove('ready', 'active', 'error')
    if (state) {
      this.statusDot.classList.add(state)
    }
  }

  updateBadge() {
    const world = this.worldTracker.getDiagnostics()
    if (!this.running) {
      this.badge.classList.remove('visible')
      return
    }

    if (world.worldState === 'TRACKING' && world.targetVisible) {
      this.badge.textContent = 'Target Locked ' + Math.round(world.filterConfidence * 100) + '% / visual ' + Math.round(world.visualQuality * 100) + '%'
      this.badge.classList.add('visible')
      return
    }

    if (world.worldState === 'RELOCALIZING' || (world.hasPlacement && !world.targetVisible)) {
      this.badge.textContent = 'Reacquire Target ' + Math.round(world.visualQuality * 100) + '% visual'
      this.badge.classList.add('visible')
      return
    }

    this.badge.textContent = 'Scan Target Image'
    this.badge.classList.add('visible')
  }

  handleResize() {
    this.modelRenderer.resize(window.innerWidth, window.innerHeight)
  }

  cleanup() {
    if (this.cleanedUp) {
      return
    }

    this.cleanedUp = true
    this.running = false
    if (this.loopHandle) {
      cancelAnimationFrame(this.loopHandle)
      this.loopHandle = 0
    }
    this.badge.classList.remove('visible')
    this.setScreenMode('start')
    this.imuManager.stopListening()
    this.worldTracker.stop().catch(() => {})
  }

  loop() {
    if (!this.running) {
      return
    }

    this.loopHandle = requestAnimationFrame(() => this.loop())
    const now = performance.now()
    this.syncMetrics()
    this.maybeTuneCaptureProfile(false)
    if (this.showInfo && now - this.lastDebugUiUpdateAt >= this.debugUiIntervalMs) {
      this.lastDebugUiUpdateAt = now
      this.updateLocalInfo()
      this.updateInfoPanel()
      this.updateTrackerHud()
    }
    this.reportRuntimeSummary(now)
  }

  syncMetrics() {
    const world = this.worldTracker.getDiagnostics()
    const render = this.modelRenderer.getDiagnostics()

    this.metrics.sessionState = world.sessionState
    this.metrics.visibilityState = world.visibilityState
    this.metrics.worldState = world.worldState
    this.metrics.targetState = world.targetState
    this.metrics.targetName = world.targetName
    this.metrics.targetVisible = world.targetVisible
    this.metrics.targetUpdates = world.targetUpdates
    this.metrics.targetMeasuredWidthM = world.targetMeasuredWidthM
    this.metrics.targetIndex = world.targetIndex
    this.metrics.targetMatchCount = world.targetMatchCount
    this.metrics.targetInlierCount = world.targetInlierCount
    this.metrics.targetConfidence = world.targetConfidence
    this.metrics.targetReprojectionPx = world.targetReprojectionPx
    this.metrics.targetReferenceReady = world.targetReferenceReady
    this.metrics.targetReferenceFeatures = world.targetReferenceFeatures
    this.metrics.hitTestState = world.hitTestState
    this.metrics.anchorState = world.anchorState
    this.metrics.workerState = world.workerState
    this.metrics.wasmState = world.wasmState
    this.metrics.cameraAccessState = world.cameraAccessState
    this.metrics.xrFps = world.xrFps
    this.metrics.viewport = world.viewport
    this.metrics.frameTimeMs = render.lastFrameMs
    this.metrics.localLatencyMs = world.localLatencyMs
    this.metrics.surfaceHits = world.surfaceHits
    this.metrics.selectCount = world.selectCount
    this.metrics.placementCount = world.placementCount
    this.metrics.lastHitDistanceM = world.lastHitDistanceM
    this.metrics.hasPlacement = world.hasPlacement
    this.metrics.renderState = render.renderState
    this.metrics.filterSource = world.filterSource
    this.metrics.filterConfidence = world.filterConfidence
    this.metrics.measurementConfidence = world.measurementConfidence
    this.metrics.baseMeasurementConfidence = world.baseMeasurementConfidence
    this.metrics.workerProcMs = world.workerProcMs
    this.metrics.workerLatencyMs = world.workerLatencyMs
    this.metrics.residualTranslationM = world.residualTranslationM
    this.metrics.residualRotationDeg = world.residualRotationDeg
    this.metrics.posAlpha = world.posAlpha
    this.metrics.rotAlpha = world.rotAlpha
    this.metrics.snapCount = world.snapCount
    this.metrics.filterFrames = world.filterFrames
    this.metrics.speedMps = world.speedMps
    this.metrics.visualState = world.visualState
    this.metrics.visualFrames = world.visualFrames
    this.metrics.visualFrameSize = world.visualFrameSize
    this.metrics.visualSourceSize = world.visualSourceSize
    this.metrics.visualFeatureCount = world.visualFeatureCount
    this.metrics.visualFeatureDensity = world.visualFeatureDensity
    this.metrics.visualBrightness = world.visualBrightness
    this.metrics.visualContrast = world.visualContrast
    this.metrics.visualMotion = world.visualMotion
    this.metrics.visualQuality = world.visualQuality
    this.metrics.visualCaptureMs = world.visualCaptureMs
    this.metrics.visualProcMs = world.visualProcMs
    this.metrics.trackCount = world.trackCount
    this.metrics.matchCount = world.matchCount
    this.metrics.matchRatio = world.matchRatio
    this.metrics.trackConfidence = world.trackConfidence
    this.metrics.keyframeCount = world.keyframeCount
    this.metrics.landmarkCount = world.landmarkCount
    this.metrics.mapState = world.mapState
    this.metrics.relocalizationScore = world.relocalizationScore
    this.metrics.relocalizationKeyframeId = world.relocalizationKeyframeId
    this.metrics.motionVectorX = world.motionVectorX
    this.metrics.motionVectorY = world.motionVectorY
    this.metrics.motionScale = world.motionScale
    this.metrics.motionRotationDeg = world.motionRotationDeg
    this.metrics.visualOdometryConfidence = world.visualOdometryConfidence
    this.metrics.cameraCaptures = world.cameraCaptures
    this.metrics.cameraSkippedThrottle = world.cameraSkippedThrottle
    this.metrics.cameraSkippedBusy = world.cameraSkippedBusy
    this.metrics.cameraLastCaptureMs = world.cameraLastCaptureMs
    this.metrics.cameraAverageCaptureMs = world.cameraAverageCaptureMs
    this.metrics.cameraCaptureIntervalMs = world.cameraCaptureIntervalMs
    this.metrics.cameraCaptureMaxDimension = world.cameraCaptureMaxDimension
    this.metrics.cameraFramePending = world.cameraFramePending
    this.metrics.framebufferScale = world.framebufferScale
  }

  updateLocalInfo() {
    this.setText('infoFps', this.metrics.xrFps || 0)
    const imuActive = this.imuManager.isActive
    this.metrics.imuState = imuActive
      ? 'ACTIVE'
      : this.metrics.imuState === 'UNAVAILABLE'
        ? 'UNAVAILABLE'
        : 'IDLE'

    this.setText('infoImuStatus', imuActive ? 'Active' : 'Inactive')

    if (imuActive) {
      const orient = this.imuManager.orientation
      this.setText('infoImuAlpha', orient.alpha.toFixed(1))
      this.setText('infoImuBeta', orient.beta.toFixed(1))
      this.setText('infoImuGamma', orient.gamma.toFixed(1))
      this.setText('infoImuVel', this.imuManager.linVel.length().toFixed(3) + ' m/s')
      this.setText('infoImuDelta', this.imuManager.getRotationMagnitude().toFixed(1) + ' deg')
    } else {
      this.setText('infoImuAlpha', '-')
      this.setText('infoImuBeta', '-')
      this.setText('infoImuGamma', '-')
      this.setText('infoImuVel', '-')
      this.setText('infoImuDelta', '-')
    }
  }

  maybeTuneCaptureProfile(force) {
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

    let maxDimension = 160
    let minFrameIntervalMs = 220
    let reason = 'target-search-accuracy'
    const hasFpsSample = this.metrics.xrFps > 0
    const averageCaptureMs = Number(camera.averageCaptureMs || 0)
    const captureBackedUp = Boolean(camera.inFlight && averageCaptureMs > 12)

    if (this.metrics.hasPlacement || this.metrics.targetState === 'TRACKING') {
      maxDimension = 160
      minFrameIntervalMs = 280
      reason = 'target-locked-accuracy'
    }

    if (!this.metrics.hasPlacement && this.metrics.targetState === 'DETECTED') {
      maxDimension = 224
      minFrameIntervalMs = 180
      reason = 'target-confirm-accuracy'
    }

    if (
      !this.metrics.hasPlacement &&
      this.metrics.xrFps > 24 &&
      this.metrics.visualQuality < 0.4 &&
      this.metrics.visualFeatureCount < 14 &&
      averageCaptureMs < 10
    ) {
      maxDimension = 224
      minFrameIntervalMs = 180
      reason = 'diagnostic-boost-accuracy'
    }

    if (
      hasFpsSample && (
      this.metrics.xrFps < 18 ||
      this.metrics.frameTimeMs > 58 ||
      averageCaptureMs > 14 ||
      captureBackedUp
    )) {
      maxDimension = this.metrics.hasPlacement ? 128 : 160
      minFrameIntervalMs = 360
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
  }

  updateInfoPanel() {
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
      'upd ' + world.targetUpdates + ' | mt ' + world.targetMatchCount + ' | in ' + world.targetInlierCount + ' | conf ' + Math.round(world.targetConfidence * 100) + '% | err ' + world.targetReprojectionPx.toFixed(2) + ' px | ref ' + (world.targetReferenceReady ? world.targetReferenceFeatures : 0)
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
  }

  updateTrackerHud() {
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
        : world.targetState === 'DETECTED' || world.targetState === 'SEARCHING' || world.targetState === 'READY' || world.targetState === 'LOADED'
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
  }

  reportRuntimeSummary(now) {
    if (now - this.lastSummaryLog < 5000) {
      return
    }

    this.lastSummaryLog = now
    const world = this.worldTracker.getDiagnostics()
    const render = this.modelRenderer.getDiagnostics()
    const snapshot = {
      sessionState: world.sessionState,
      referenceSpace: world.referenceSpace,
      worldState: world.worldState,
      targetState: world.targetState,
      targetVisible: world.targetVisible,
      targetUpdates: world.targetUpdates,
      targetWidthM: world.targetMeasuredWidthM,
      targetMatches: world.targetMatchCount,
      targetInliers: world.targetInlierCount,
      targetConfidence: world.targetConfidence,
      targetReprojectionPx: world.targetReprojectionPx,
      targetReferenceReady: world.targetReferenceReady,
      targetReferenceFeatures: world.targetReferenceFeatures,
      hitTest: world.hitTestState,
      placement: world.hasPlacement,
      anchorState: world.anchorState,
      workerState: world.workerState,
      wasmState: world.wasmState,
      cameraAccessState: world.cameraAccessState,
      visualQuality: world.visualQuality,
      visualFeatures: world.visualFeatureCount,
      trackCount: world.trackCount,
      matchCount: world.matchCount,
      mapState: world.mapState,
      keyframeCount: world.keyframeCount,
      landmarkCount: world.landmarkCount,
      relocalizationScore: world.relocalizationScore,
      filterConfidence: world.filterConfidence,
      workerProcMs: world.workerProcMs,
      residualTranslationM: world.residualTranslationM,
      residualRotationDeg: world.residualRotationDeg,
      xrFps: world.xrFps,
      frameTimeMs: render.lastFrameMs,
      renderState: render.renderState,
      jitterMm: render.renderJitterMm,
      captureProfile: world.cameraCaptureMaxDimension + 'px/' + world.cameraCaptureIntervalMs + 'ms',
      captureAvgMs: world.cameraAverageCaptureMs,
      capturePending: world.cameraFramePending,
      skippedThrottle: world.cameraSkippedThrottle,
      skippedBusy: world.cameraSkippedBusy,
    }
    this.log('Runtime snapshot', snapshot, 'Perf')
    this.sendBackendTelemetry('runtime-snapshot', { source: 'periodic-summary', message: 'Runtime snapshot' })
  }
}

document.addEventListener('DOMContentLoaded', () => {
  window.app = new CustomTrackerApp()
})




