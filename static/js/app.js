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

  loadTargetCatalog() {
    if (
      !window.ModelTransformHelpers ||
      typeof window.ModelTransformHelpers.getProfiles !== 'function'
    ) {
      this.targetProfiles = []
      return null
    }

    this.targetProfiles = window.ModelTransformHelpers.getProfiles()
    const activeProfile = window.ModelTransformHelpers.getProfile()
    this.activeTargetId = activeProfile.id
    return activeProfile
  }

  renderTargetPicker() {
    if (!this.targetGrid || !this.targetPicker) {
      return
    }

    const activeProfile = this.loadTargetCatalog()
    this.targetGrid.innerHTML = ''

    if (!this.targetProfiles.length || !activeProfile) {
      return
    }

    const hasMultipleTargets = this.targetProfiles.length > 1
    this.targetPicker.classList.toggle('single-target', !hasMultipleTargets)
    this.targetGrid.classList.toggle('hidden', !hasMultipleTargets)
    if (this.targetPickerTitle) {
      this.targetPickerTitle.textContent = hasMultipleTargets ? 'Choose Image Target' : 'Target Image'
    }

    if (hasMultipleTargets) {
      this.targetProfiles.forEach((profile) => {
        const card = document.createElement('button')
        card.type = 'button'
        card.className = 'target-card' + (profile.id === this.activeTargetId ? ' active' : '')
        card.dataset.targetId = profile.id
        card.innerHTML =
          '<img class="target-card-thumb" alt="" src="' + profile.thumbnailUrl + '">' +
          '<div class="target-card-name">' + profile.name + '</div>' +
          '<div class="target-card-copy">' + profile.description + '</div>' +
          '<div class="target-card-meta">' + Math.round(profile.targetPhysicalWidthMeters * 100) + ' cm target</div>'
        card.addEventListener('click', () => {
          this.selectTargetProfile(profile.id)
        })
        this.targetGrid.appendChild(card)
      })
    }

    this.updateTargetPreview(activeProfile)
  }

  updateAlignmentToolLink(profile) {
    if (!this.alignmentToolLink || !profile) {
      return
    }
    this.alignmentToolLink.href =
      '/static/alignment-tool/index.html?target=' + encodeURIComponent(profile.id)
  }

  updateTargetPreview(profile) {
    if (!profile) {
      return
    }
    if (this.targetPreviewImage) {
      this.targetPreviewImage.src = profile.thumbnailUrl || profile.targetImageUrl || ''
    }
    if (this.targetPreviewName) {
      this.targetPreviewName.textContent = profile.name
    }
    if (this.targetPreviewMeta) {
      this.targetPreviewMeta.textContent =
        'Use this printed image target. Width: ' +
        Math.round(profile.targetPhysicalWidthMeters * 100) +
        ' cm. ' +
        (profile.description || '')
    }
    if (this.targetPreviewHint) {
      this.targetPreviewHint.innerHTML =
        '<strong>Scan hint:</strong> ' + (profile.scanHint || 'Hold the full target in frame.')
    }
    this.updateAlignmentToolLink(profile)
  }

  selectTargetProfile(targetId, options = {}) {
    if (
      !window.ModelTransformHelpers ||
      typeof window.ModelTransformHelpers.setActiveTarget !== 'function'
    ) {
      return null
    }
    const profile = window.ModelTransformHelpers.setActiveTarget(targetId, {
      persist: options.persist !== false,
      updateUrl: options.updateUrl !== false,
    })
    this.activeTargetId = profile.id
    this.metrics.targetName = profile.name
    this.renderTargetPicker()
    this.updateTrackerHud()
    this.updateInfoPanel()
    this.log('Selected target profile', {
      id: profile.id,
      name: profile.name,
      widthM: Number(profile.targetPhysicalWidthMeters.toFixed(3)),
    }, 'Target')
    return profile
  }

  describeGuidance(world) {
    const profile = (
      window.ModelTransformHelpers &&
      typeof window.ModelTransformHelpers.getProfile === 'function'
    )
      ? window.ModelTransformHelpers.getProfile()
      : null

    if (!this.running) {
      return profile && profile.scanHint
        ? profile.scanHint
        : 'Hold the full target in frame with even lighting.'
    }

    if (world.worldState === 'TRACKING' && world.targetVisible) {
      return 'Target locked. Keep the image in view for the most stable overlay.'
    }

    if (world.targetState === 'DETECTED') {
      return 'Target detected. Hold steady for a fresh pose solve.'
    }

    if (world.targetState === 'REACQUIRING' || world.worldState === 'RELOCALIZING') {
      return 'Reacquiring target. Move slightly closer and bring the full image back into frame.'
    }

    if (world.visualQuality < 0.35 || world.visualFeatureCount < 10) {
      return 'Improve lighting or move closer so the tracker can see stronger image features.'
    }

    return profile && profile.scanHint
      ? profile.scanHint
      : 'Scan the target image until the tracker confirms a lock.'
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

  syncWorldMetrics(diagnostics) {
    copySelectedFields(this.metrics, diagnostics, WORLD_METRIC_FIELDS)
  }

  buildBackendTelemetryPayload(kind, extra = {}) {
    const world = this.worldTracker.getDiagnostics()
    const render = this.modelRenderer.getDiagnostics()

    return {
      kind: kind,
      seq: ++this.telemetrySequence,
      sessionId: this.backendSessionId,
      sentAtIso: new Date().toISOString(),
      elapsedMs: roundedNumber(performance.now() - this.runtimeStartAt, 2),
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
      targetMeasuredWidthM: roundedNumber(world.targetMeasuredWidthM, 3),
      targetIndex: typeof world.targetIndex === 'number' ? world.targetIndex : -1,
      targetMatchCount: Number(world.targetMatchCount || 0),
      targetInlierCount: Number(world.targetInlierCount || 0),
      targetInlierRatio: roundedNumber(
        world.targetInlierRatio || (world.targetMatchCount ? world.targetInlierCount / world.targetMatchCount : 0),
        3
      ),
      targetConfidence: roundedNumber(world.targetConfidence, 3),
      targetReprojectionPx: roundedNumber(world.targetReprojectionPx, 3),
      targetReferenceReady: Boolean(world.targetReferenceReady),
      targetReferenceFeatures: Number(world.targetReferenceFeatures || 0),
      hitTestState: world.hitTestState,
      anchorState: world.anchorState,
      workerState: world.workerState,
      wasmState: world.wasmState,
      cameraAccessState: world.cameraAccessState,
      visualState: world.visualState,
      visualFeatureCount: world.visualFeatureCount,
      visualQuality: roundedNumber(world.visualQuality, 3),
      visualProcMs: roundedNumber(world.visualProcMs, 3),
      visualCaptureMs: roundedNumber(world.visualCaptureMs, 3),
      trackCount: world.trackCount,
      averageTrackAge: roundedNumber(world.averageTrackAge, 3),
      maxTrackAge: roundedNumber(world.maxTrackAge, 3),
      longTrackRatio: roundedNumber(world.longTrackRatio, 3),
      matchCount: world.matchCount,
      keyframeCount: world.keyframeCount,
      landmarkCount: world.landmarkCount,
      stableLandmarkCount: Number(world.stableLandmarkCount || 0),
      staleLandmarkCount: Number(world.staleLandmarkCount || 0),
      staleLandmarkRatio: roundedNumber(world.staleLandmarkRatio, 3),
      keyframeGrowthPerSec: roundedNumber(world.keyframeGrowthPerSec, 3),
      landmarkGrowthPerSec: roundedNumber(world.landmarkGrowthPerSec, 3),
      motionObservability: roundedNumber(world.motionObservability, 3),
      mapState: world.mapState,
      relocalizationScore: roundedNumber(world.relocalizationScore, 3),
      relocalizationAttemptCount: Number(world.relocalizationAttemptCount || 0),
      relocalizationRecoveryCount: Number(world.relocalizationRecoveryCount || 0),
      lastRelocalizationDurationMs: roundedNumber(world.lastRelocalizationDurationMs, 2),
      currentRelocalizationDurationMs: roundedNumber(world.currentRelocalizationDurationMs, 2),
      filterConfidence: roundedNumber(world.filterConfidence, 3),
      surfaceHits: Number(world.surfaceHits || 0),
      hasPlacement: Boolean(world.hasPlacement),
      xrFps: Number(world.xrFps || 0),
      frameTimeMs: roundedNumber(render.lastFrameMs, 2),
      workerProcMs: roundedNumber(world.workerProcMs, 3),
      workerLatencyMs: roundedNumber(world.workerLatencyMs, 3),
      measurementDeltaTranslationM: roundedNumber(world.measurementDeltaTranslationM || world.residualTranslationM, 4),
      measurementDeltaRotationDeg: roundedNumber(world.measurementDeltaRotationDeg || world.residualRotationDeg, 3),
      cameraAverageCaptureMs: roundedNumber(world.cameraAverageCaptureMs, 3),
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
      this.renderTargetPicker()
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
    this.renderTargetPicker()
    this.handleResize()
    this.updateTrackerHud()

    const support = await this.worldTracker.checkSupport()
    this.metrics.supportState = this.worldTracker.getDiagnostics().supportState
    if (support.supported) {
      const activeProfile = this.loadTargetCatalog()
      this.startStatus.textContent =
        'Ready to scan ' +
        (activeProfile ? activeProfile.name : 'the target image') +
        '. Point the camera at the printed image to place the 3D model.'
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

    const activeProfile = this.loadTargetCatalog()
    this.cleanedUp = false
    this.startBtn.disabled = true
    this.badge.classList.remove('visible')
      this.startStatus.textContent =
        'Loading ' + (activeProfile ? activeProfile.name : 'target image') + '...'
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

      this.startStatus.textContent =
        'Starting AR for ' + (activeProfile ? activeProfile.name : 'the target image') + '...'
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
    this.syncWorldMetrics(diagnostics)

    this.logTransition('session', diagnostics.sessionState)
    this.logTransition('world', state)
    this.logTransition('target', diagnostics.targetState)
    this.logTransition('hit-test', diagnostics.hitTestState)
    this.logTransition('anchor', diagnostics.anchorState)
    this.logTransition('worker', diagnostics.workerState)
    this.logTransition('wasm', diagnostics.wasmState)
    this.logTransition('camera-access', diagnostics.cameraAccessState)
    this.logTransition('visual', diagnostics.visualState)

    if (CAMERA_ACCESS_ACTIVE_STATES.has(diagnostics.cameraAccessState)) {
      this.setPermissionState('permCamera', 'granted', 'Raw Camera Frames Active')
    }

    if (state === 'ENDED') {
      this.running = false
      this.setScreenMode('start')
      this.startOverlay.classList.remove('hidden')
      this.renderTargetPicker()
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
      this.renderTargetPicker()
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

    if (
      world.targetState === 'DETECTED' ||
      world.targetState === 'REACQUIRING' ||
      world.worldState === 'RELOCALIZING' ||
      (world.hasPlacement && !world.targetVisible)
    ) {
      this.badge.textContent = this.describeGuidance(world)
      this.badge.classList.add('visible')
      return
    }

    this.badge.textContent = this.describeGuidance(world)
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

    this.syncWorldMetrics(world)
    this.metrics.frameTimeMs = render.lastFrameMs
    this.metrics.renderState = render.renderState
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

    let maxDimension = 192
    let minFrameIntervalMs = 180
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
      (this.metrics.targetState === 'DETECTED' || this.metrics.targetState === 'REACQUIRING')
    ) {
      maxDimension = 256
      minFrameIntervalMs = 140
      reason = 'target-confirm-accuracy'
    }

    if (
      !this.metrics.hasPlacement &&
      this.metrics.xrFps > 24 &&
      this.metrics.visualQuality < 0.4 &&
      this.metrics.visualFeatureCount < 14 &&
      averageCaptureMs < 10
    ) {
      maxDimension = 256
      minFrameIntervalMs = 150
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




